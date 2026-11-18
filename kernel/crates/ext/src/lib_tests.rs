//! 组装：注册表、清单来源、MCP 启动（ext.md §1）。

use std::sync::Arc;

use nibi_kernel_base::TaskScope;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::mcp::McpTransportConfig;
use nibi_kernel_api::model::{ModelSelection, QuerySource};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::testing::{ListTools, MemoryEnvironment, SequentialIds};
use serde_json::json;

use super::*;
use crate::plugins::{PluginCandidate, PluginOrigin};
use crate::test_support::{CWD, EchoBash, FakeMcp, facts, server, workspace};

fn ext(env: MemoryEnvironment, fake: Arc<FakeMcp>, scope: &TaskScope, servers: McpServers) -> Ext {
    ext_with_config(
        env,
        fake,
        scope,
        ExtConfig {
            mcp: McpSettings {
                servers,
                ..McpSettings::default()
            },
            workspace: Some(workspace()),
            ..ExtConfig::default()
        },
    )
}

fn ext_with_config(
    env: MemoryEnvironment,
    fake: Arc<FakeMcp>,
    scope: &TaskScope,
    config: ExtConfig,
) -> Ext {
    let base: Arc<dyn ToolRegistry> = Arc::new(ListTools(vec![Arc::new(EchoBash::default())]));
    let env = Arc::new(env);
    let ports = ExtPorts {
        info: env.clone(),
        files: env,
        ids: Arc::new(SequentialIds::default()),
        gate: Arc::new(PolicyGate::default()),
        mcp: fake,
        machines: None,
        spawner: scope.spawner(),
        clock: crate::clock_tests::TokioClock::new(),
        mcp_telemetry: None,
        mcp_ui_events: None,
        sampling: None,
        mcp_oauth: None,
    };
    Ext::new(ports, base, config)
}

fn request() -> ContextRequest {
    ContextRequest {
        default_machine: None,
        capabilities: None,
        session: SessionId::new("sess_1"),
        workspace: workspace(),
        agent: None,
        source: QuerySource::MainThread,
        mode: PermissionMode::Default,
        tool_names: vec!["Skill".to_owned()],
        selection: ModelSelection {
            provider: "anthropic".to_owned(),
            model: "claude-opus-5-5".to_owned(),
            reasoning: None,
            connection: None,
        },
        plan_flags: Default::default(),
        mcp: None,
    }
}

#[tokio::test]
async fn the_registry_adds_skill_and_mcp_tools_after_the_base() {
    let fake = Arc::new(FakeMcp::default().with(
        "files",
        server(json!({"tools": {}}), Some("Read files."), |method, _| {
            (method == "tools/list").then(|| {
                Ok(json!({"tools": [{"name": "read", "inputSchema": {"type": "object"}}]}))
            })
        }),
    ));
    let scope = TaskScope::root("test", |_| {});
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{CWD}/.nibi/skills/greet/SKILL.md"),
        "---\ndescription: Greet\n---\n",
    );
    let servers = vec![McpServer {
        name: "files".to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::Stdio {
            command: "node".to_owned(),
            args: Vec::new(),
            env: Default::default(),
            cwd: None,
        },
        options: Default::default(),
        machine: None,
        oauth: None,
        protocol: Default::default(),
    }];
    let ext = ext(env, fake, &scope, servers);
    let registry = ext.registry();
    let names = |registry: &Arc<dyn ToolRegistry>| -> Vec<String> {
        registry
            .tools()
            .iter()
            .map(|tool| tool.name().to_owned())
            .collect()
    };
    assert_eq!(names(&registry), ["Bash", "Skill"]);
    ext.start().await;
    ext.mcp().wait_ready().await;
    assert_eq!(names(&registry), ["Bash", "Skill", "mcp__files__read"]);
    assert!(registry.find("mcp__files__read").is_some());
    let listings = ext.listings();
    let found = listings.listings_for(&request(), &[]).await.unwrap();
    let lines: Vec<&str> = found
        .skills
        .iter()
        .map(|entry| entry.line.as_str())
        .collect();
    // 文件 skill 在前，内置的 `loop` 在后（tools-more.md §17.1），再是内置提示词命令（修复线 L-A）。
    assert_eq!(lines[0], "- greet: Greet");
    assert!(lines[1].starts_with("- loop: "));
    assert!(lines[2].starts_with("- init: "));
    assert!(lines[3].starts_with("- security-review: "));
    assert_eq!(lines.len(), 4);
    let instructions = listings.mcp_instructions(&request()).await.unwrap();
    assert_eq!(instructions[0].line, "## files\nRead files.");
}

/// WaitForMcpServers 在有连接中的服务器时出现；主线程带过它的会话之后一直带着（ext.md §3.8，修复线 F36）。快照里的
/// instructions 与工具同一时点，清单来源按快照给（query.md §1.3）。
#[tokio::test(start_paused = true)]
async fn the_wait_tool_follows_pending_servers_and_the_declared_session() {
    let fake = Arc::new(FakeMcp::default().with("slow", crate::test_support::held(|_, _| None)));
    let scope = TaskScope::root("test", |_| {});
    let servers = vec![McpServer {
        name: "slow".to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::Stdio {
            command: "node".to_owned(),
            args: Vec::new(),
            env: Default::default(),
            cwd: None,
        },
        options: Default::default(),
        machine: None,
        oauth: None,
        protocol: Default::default(),
    }];
    let ext = ext(
        MemoryEnvironment::new(facts()),
        fake.clone(),
        &scope,
        servers,
    );
    let registry = ext.registry();
    ext.start().await;
    let names = |tools: Vec<Arc<dyn Tool>>| -> Vec<String> {
        tools.iter().map(|tool| tool.name().to_owned()).collect()
    };
    assert_eq!(
        names(registry.tools()),
        ["Bash", "Skill", "WaitForMcpServers"]
    );
    let main = SessionId::new("sess_1");
    let other = SessionId::new("sess_2");
    let snapshot = registry.snapshot(&main);
    assert_eq!(
        names(snapshot.tools),
        ["Bash", "Skill", "WaitForMcpServers"]
    );
    assert_eq!(snapshot.mcp.unwrap().pending(), ["slow"]);
    registry.mcp().unwrap().declare_wait_tool(&main);
    fake.release("slow", json!({}), Some("Slow."));
    ext.mcp().wait_ready().await;
    // 连上之后：现在的工具表没有它；带过它的会话的快照仍有，别的会话没有。
    assert_eq!(names(registry.tools()), ["Bash", "Skill"]);
    let declared = registry.snapshot(&main);
    assert_eq!(
        names(declared.tools),
        ["Bash", "Skill", "WaitForMcpServers"]
    );
    assert_eq!(names(registry.snapshot(&other).tools), ["Bash", "Skill"]);
    assert!(registry.find("WaitForMcpServers").is_some());
    // 清单来源：有快照时用快照里的 instructions，没有时取现在的。
    let listings = ext.listings();
    let mut stale = request();
    stale.mcp = Some(nibi_kernel_api::mcp_state::McpView::default());
    assert!(listings.mcp_instructions(&stale).await.unwrap().is_empty());
    let mut fresh = request();
    fresh.mcp = declared.mcp;
    let lines: Vec<String> = listings
        .mcp_instructions(&fresh)
        .await
        .unwrap()
        .into_iter()
        .map(|entry| entry.line)
        .collect();
    assert_eq!(lines, ["## slow\nSlow."]);
    assert_eq!(
        listings.mcp_instructions(&request()).await.unwrap()[0].line,
        "## slow\nSlow."
    );
}

/// Node `filterVisualizeSkillRoots`：TUI / `-p` 没有内联视图宿主，进程级与会话级的 skill 目录都不出现
/// `visualize:visualize`；Desktop app-server 置 `host_inline_view` 时两处都保留，其他插件不受影响。
#[tokio::test]
async fn visualize_skills_follow_the_inline_view_host() {
    let visualize = "/Users/dev/cache/nibi-official/visualize/0.1.0";
    let pdf = "/Users/dev/cache/nibi-official/pdf/0.1.0";
    let env = || {
        MemoryEnvironment::new(facts())
            .with_file(
                &format!("{visualize}/.nibi-plugin/plugin.json"),
                r#"{"name": "visualize"}"#,
            )
            .with_file(
                &format!("{visualize}/skills/visualize/SKILL.md"),
                "---\ndescription: Inline views\n---\n",
            )
            .with_file(
                &format!("{pdf}/.nibi-plugin/plugin.json"),
                r#"{"name": "pdf"}"#,
            )
            .with_file(
                &format!("{pdf}/skills/pdf/SKILL.md"),
                "---\ndescription: PDF\n---\n",
            )
    };
    let sources = || PluginSources {
        candidates: [visualize, pdf]
            .into_iter()
            .map(|dir| PluginCandidate {
                dir: EnvPath::new(dir),
                marketplace: nibi_kernel_base::names::OFFICIAL_MARKETPLACE.to_owned(),
                origin: PluginOrigin::Official,
                paid: false,
            })
            .collect(),
        ..PluginSources::default()
    };
    let plugin_names = |skills: Vec<Arc<Skill>>| -> Vec<String> {
        skills
            .into_iter()
            .map(|skill| skill.name.clone())
            .filter(|name| name.contains(':'))
            .collect()
    };
    let scope = TaskScope::root("test", |_| {});
    let ext_for = |host_inline_view: bool| {
        ext_with_config(
            env(),
            Arc::new(FakeMcp::default()),
            &scope,
            ExtConfig {
                plugins: sources(),
                workspace: Some(workspace()),
                host_inline_view,
                ..ExtConfig::default()
            },
        )
    };

    // TUI / `-p`：没有视图宿主，visualize 的 skill 根不投影。
    let without_host = ext_for(false);
    let loaded = without_host.start().await;
    let process = plugin_names(without_host.skills().skills(&workspace()).await);
    assert!(process.contains(&"pdf:pdf".to_owned()), "{process:?}");
    assert!(!process.contains(&"visualize:visualize".to_owned()), "{process:?}");
    let session = SessionId::new("sess_no_view_host");
    without_host.set_session_skill_roots(session.clone(), &loaded);
    let session_skills = plugin_names(
        without_host
            .skills()
            .skills_for(Some(&session), &workspace())
            .await,
    );
    assert!(session_skills.contains(&"pdf:pdf".to_owned()), "{session_skills:?}");
    assert!(
        !session_skills.contains(&"visualize:visualize".to_owned()),
        "{session_skills:?}"
    );

    // Desktop app-server：有内联视图宿主，进程级与会话级都保留 visualize。
    let with_host = ext_for(true);
    let loaded = with_host.start().await;
    let process = plugin_names(with_host.skills().skills(&workspace()).await);
    assert!(process.contains(&"visualize:visualize".to_owned()), "{process:?}");
    assert!(process.contains(&"pdf:pdf".to_owned()), "{process:?}");
    let session = SessionId::new("sess_view_host");
    with_host.set_session_skill_roots(session.clone(), &loaded);
    let session_skills = plugin_names(
        with_host
            .skills()
            .skills_for(Some(&session), &workspace())
            .await,
    );
    assert!(
        session_skills.contains(&"visualize:visualize".to_owned()),
        "{session_skills:?}"
    );
    assert!(session_skills.contains(&"pdf:pdf".to_owned()), "{session_skills:?}");

    // 空插件快照：不报错，也不产生插件 skill。
    let empty = SessionId::new("sess_empty_view_host");
    with_host.set_session_skill_roots(empty.clone(), &Plugins::default());
    assert!(
        plugin_names(
            with_host
                .skills()
                .skills_for(Some(&empty), &workspace())
                .await
        )
        .is_empty()
    );
}

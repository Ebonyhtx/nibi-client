//! 插件 agent（agents.md §3）。

use std::sync::Arc;

use nibi_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_api::testing::MemoryEnvironment;

use super::{PluginAgentFile, parse};
use crate::context::AgentCatalog;
use crate::definitions::AgentSource;

const ROOT: &str = "/Users/dev/plugins/kit";

fn file(path: &str, namespace: &[&str]) -> PluginAgentFile {
    PluginAgentFile {
        plugin: "kit".to_owned(),
        plugin_id: "kit@inline".to_owned(),
        root: ROOT.to_owned(),
        path: format!("{ROOT}/{path}"),
        namespace: namespace.iter().map(|part| (*part).to_owned()).collect(),
    }
}

#[test]
fn names_descriptions_and_variables_follow_the_plugin_rules() {
    let raw = "---\nname: lead\nwhen_to_use: Leads the team.\ntools: Read\npermissionMode: bypassPermissions\nmaxTurns: 3\n---\nRun ${CLAUDE_PLUGIN_ROOT}/bin/x in ${NIBI_PROJECT_DIR} (${NIBI_PROJECT_DIR}).\n";
    let agent = parse(
        raw,
        &file("agents/team/lead.md", &["team"]),
        "/Users/dev/repo",
    );
    assert_eq!(agent.agent_type, "kit:team:lead");
    assert_eq!(agent.when_to_use, "Leads the team.");
    assert_eq!(agent.source, AgentSource::Plugin);
    assert_eq!(agent.plugin.as_deref(), Some("kit"));
    assert_eq!(agent.tools, Some(vec!["Read".to_owned()]));
    // 插件声明的 permissionMode 原样解析，派生子会话时只收紧父会话（Node `permissionModeRestrictOnly`），
    // 不能越过安装时的授权把父模式放宽。
    assert_eq!(
        agent.permission_mode,
        Some(nibi_kernel_api::permission::PermissionMode::BypassPermissions)
    );
    assert_eq!(agent.max_turns, Some(3));
    assert_eq!(
        agent.prompt,
        "Run /Users/dev/plugins/kit/bin/x in /Users/dev/repo (/Users/dev/repo)."
    );
    // 没有 frontmatter：名字取文件名，描述用缺省句。
    let bare = parse(
        "Just do it.",
        &file("agents/helper.md", &[]),
        "/Users/dev/repo",
    );
    assert_eq!(bare.agent_type, "kit:helper");
    assert_eq!(bare.when_to_use, "Agent from kit plugin");
    assert_eq!(bare.prompt, "Just do it.");
    assert_eq!(bare.state_id.as_deref(), Some("plugin:kit@inline:helper"));
}

/// 插件 agent 的 `model` / `thoughtLevel` 是 Provider 限定的完整选择（Node
/// `parseSubagentMarkdownSelection`）；设置页的键是 `plugin:<pluginId>:<name 小写>`。
#[test]
fn model_and_thought_level_become_a_provider_qualified_selection() {
    let raw = "---\nname: Judge\ndescription: Judge it.\nmodel: custom:e2e-alt%3Ateam:deepseek-v4-pro\nthoughtLevel: high\n---\nJ.";
    let agent = parse(raw, &file("agents/judge.md", &[]), "/Users/dev/repo");
    let selection = agent.model_selection.as_ref().expect("显式模型");
    assert_eq!(selection.provider, "e2e-alt:team");
    assert_eq!(selection.model, "deepseek-v4-pro");
    assert_eq!(selection.reasoning.as_deref(), Some("high"));
    assert_eq!(agent.state_id.as_deref(), Some("plugin:kit@inline:judge"));

    // 继承名与没有 provider 的裸模型 id 都按“继承父会话”；`thoughtLevel` 不单独生效（Node 同一判据）。
    for model in ["inherit", "main", "deepseek-v4-pro"] {
        let raw = format!(
            "---\nname: judge\ndescription: Judge it.\nmodel: {model}\nthoughtLevel: high\n---\nJ."
        );
        let agent = parse(&raw, &file("agents/judge.md", &[]), "/Users/dev/repo");
        assert!(agent.model_selection.is_none(), "{model}");
    }
}

#[tokio::test]
async fn plugin_agents_sit_between_built_ins_and_user_agents() {
    let facts = EnvFacts {
        cwd: EnvPath::new("/Users/dev/repo"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        additional_directories: Vec::new(),
        home: Some(EnvPath::new("/Users/dev")),
    };
    let env = MemoryEnvironment::new(facts)
        .with_file(
            &format!("{ROOT}/agents/review.md"),
            "---\nname: review\ndescription: Plugin review.\n---\nP.",
        )
        .with_file(
            &format!("{ROOT}/agents/explore.md"),
            "---\ndescription: Plugin explore.\n---\nE.",
        )
        .with_file(
            "/Users/dev/.nibi/agents/kit-review.md",
            "---\nname: kit:review\ndescription: User override.\n---\nU.",
        );
    let env = Arc::new(env);
    let catalog = AgentCatalog::new(env.clone(), env);
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/Users/dev/repo"),
    };
    catalog.set_plugins(vec![
        file("agents/review.md", &[]),
        file("agents/explore.md", &[]),
        file("agents/missing.md", &[]),
    ]);
    let found: Vec<(String, String, AgentSource)> = catalog
        .definitions(&workspace)
        .await
        .into_iter()
        .map(|agent| (agent.agent_type, agent.when_to_use, agent.source))
        .collect();
    let tail = &found[3..];
    assert_eq!(
        tail,
        [
            (
                "kit:review".to_owned(),
                "User override.".to_owned(),
                AgentSource::User
            ),
            (
                "kit:explore".to_owned(),
                "Plugin explore.".to_owned(),
                AgentSource::Plugin
            ),
        ]
    );
}

/// 设置页状态（`agents-state.json`）在取定义时套用：内置/插件装覆盖、用户级被停用的 `helper`
/// 不出现在清单里。定义只由 `AgentCatalog` 组装，Agent 工具与清单看到的是同一份。
#[tokio::test]
async fn the_state_source_overrides_models_and_hides_disabled_user_agents() {
    let facts = EnvFacts {
        cwd: EnvPath::new("/Users/dev/repo"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        additional_directories: Vec::new(),
        home: Some(EnvPath::new("/Users/dev")),
    };
    let env = Arc::new(
        MemoryEnvironment::new(facts)
            .with_file(
                &format!("{ROOT}/agents/visual-judge.md"),
                "---\nname: visual-judge\ndescription: Judge it.\nthoughtLevel: max\n---\nJ.",
            )
            .with_file(
                "/Users/dev/.nibi/agents/helper.md",
                "---\nname: helper\ndescription: Helps.\n---\nH.",
            ),
    );
    let catalog = AgentCatalog::new(env.clone(), env);
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/Users/dev/repo"),
    };
    catalog.set_plugins(vec![file("agents/visual-judge.md", &[])]);
    let override_selection = crate::selection::AgentModelSelection::parse(
        "e2e-upstream-alt/deepseek-v4-pro",
        Some("high"),
    )
    .expect("override");
    let mut state = crate::state::AgentState::default();
    state
        .built_in
        .insert("Explore".to_owned(), override_selection.clone());
    state.plugin.insert(
        "plugin:kit@inline:visual-judge".to_owned(),
        override_selection.clone(),
    );
    state
        .disabled
        .insert("user:user:helper".to_owned());
    catalog.set_state_source(Arc::new(move || {
        let state = state.clone();
        let future: crate::StateFuture = Box::pin(async move { state });
        future
    }));

    let definitions = catalog.definitions(&workspace).await;
    let plugin = definitions
        .iter()
        .find(|definition| definition.agent_type == "kit:visual-judge")
        .expect("插件 agent");
    assert_eq!(plugin.model_override.as_ref(), Some(&override_selection));
    // 插件自己声明的 `thoughtLevel` 在继承模型时不单独生效（Node 同一判据），但覆盖替换档位。
    assert!(plugin.model_selection.is_none());
    let explore = definitions
        .iter()
        .find(|definition| definition.agent_type == "Explore")
        .expect("Explore");
    assert_eq!(explore.model_override.as_ref(), Some(&override_selection));
    assert!(
        definitions
            .iter()
            .all(|definition| definition.agent_type != "helper"),
        "被停用的用户 agent 不应出现在清单里"
    );
}

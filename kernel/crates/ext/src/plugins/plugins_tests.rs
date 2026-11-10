//! 插件目录与 manifest（ext.md §4）。

use nibi_kernel_api::mcp::McpTransportConfig;
use nibi_kernel_api::testing::MemoryEnvironment;

use super::*;
use crate::test_support::{facts, workspace};

#[tokio::test]
async fn manifest_components_and_mcp_servers() {
    let root = "/Users/dev/plugins/kit";
    let env = MemoryEnvironment::new(facts())
        .with_file(&format!("{root}/.claude-plugin/plugin.json"), r#"{"name": "toolkit", "skills": "./extra", "agents": ["./agents/reviewer.md", "./more.md"], "hooks": {"Stop": []}, "mcpServers": {"db": {"command": "${CLAUDE_PLUGIN_ROOT}/bin/db", "args": ["--root", "${NIBI_PLUGIN_ROOT}", "${ZCODE_PLUGIN_ROOT}"]}}}"#)
        .with_file(&format!("{root}/skills/deploy/SKILL.md"), "---\ndescription: Deploy\n---\n")
        .with_file(&format!("{root}/extra/lint/SKILL.md"), "---\ndescription: Lint\n---\n")
        .with_file(&format!("{root}/agents/reviewer.md"), "---\nname: reviewer\n---\n")
        .with_file(&format!("{root}/agents/team/lead.md"), "Lead\n")
        .with_file(&format!("{root}/more.md"), "More\n")
        .with_file(&format!("{root}/hooks/hooks.json"), r#"{"hooks": {"Stop": []}}"#)
        .with_file(&format!("{root}/.mcp.json"), r#"{"mcpServers": {"web": {"type": "http", "url": "https://mcp.example.com"}}}"#)
        .with_file("/Users/dev/plugins/bare/skills/x/SKILL.md", "B\n");
    let dirs = [
        EnvPath::new(root),
        EnvPath::new("/Users/dev/plugins/bare"),
        EnvPath::new("/Users/dev/plugins/missing"),
    ];
    let plugins = load_all(&env, &workspace(), &dirs, &PluginSources::default())
        .await
        .plugins;
    assert_eq!(plugins.0.len(), 2);
    let kit = &plugins.0[0];
    assert_eq!(kit.name, "toolkit");
    assert_eq!(
        kit.skill_dirs,
        [format!("{root}/skills"), format!("{root}/extra")]
    );
    // 子目录是命名空间；manifest 再次列出的同一文件只取一次。
    let agents: Vec<(String, Vec<String>)> = kit
        .agent_files
        .iter()
        .map(|file| (file.path.clone(), file.namespace.clone()))
        .collect();
    assert_eq!(
        agents,
        [
            (format!("{root}/agents/reviewer.md"), Vec::new()),
            (
                format!("{root}/agents/team/lead.md"),
                vec!["team".to_owned()]
            ),
            (format!("{root}/more.md"), Vec::new()),
        ]
    );
    // 内联的 manifest hooks 包成文件的 `{"hooks": …}` 形状。
    assert_eq!(
        kit.hooks,
        [
            serde_json::json!({"hooks": {"Stop": []}}),
            serde_json::json!({"hooks": {"Stop": []}})
        ]
    );
    let names: Vec<&str> = kit
        .mcp_servers
        .iter()
        .map(|server| server.name.as_str())
        .collect();
    assert_eq!(names, ["plugin:toolkit:web", "plugin:toolkit:db"]);
    let McpTransportConfig::Stdio { command, args, .. } = &kit.mcp_servers[1].transport else {
        panic!("db is stdio");
    };
    assert_eq!(command, &format!("{root}/bin/db"));
    assert_eq!(
        args,
        &[
            "--root".to_owned(),
            root.to_owned(),
            root.to_owned()
        ]
    );
    assert_eq!(plugins.0[1].name, "bare");
    plugin_stdio_servers_get_the_node_variables(kit, root).await;
    let roots: Vec<String> = plugins
        .skill_roots()
        .iter()
        .map(|root| format!("{}:{}", root.plugin, root.dir))
        .collect();
    assert_eq!(
        roots,
        [
            format!("toolkit:{root}/skills"),
            format!("toolkit:{root}/extra"),
            "bare:/Users/dev/plugins/bare/skills".to_owned()
        ]
    );
}

/// 插件的 stdio MCP 服务器的环境（修复线 F42，config.md §2.5.1）：按 Node（`adapters/src/plugins/mcp.ts`）给插件目录与
/// 项目目录，NIBI/CLAUDE/上游 ZCODE 三套名字；HTTP 服务器没有环境。
async fn plugin_stdio_servers_get_the_node_variables(kit: &Plugin, root: &str) {
    let McpTransportConfig::Stdio { env, .. } = &kit.mcp_servers[1].transport else {
        panic!("db is stdio");
    };
    let project = workspace().root.as_str().to_owned();
    for (name, value) in [
        ("CLAUDE_PLUGIN_ROOT", root),
        ("NIBI_PLUGIN_ROOT", root),
        ("ZCODE_PLUGIN_ROOT", root),
        ("CLAUDE_PROJECT_DIR", project.as_str()),
        ("NIBI_PROJECT_DIR", project.as_str()),
        ("ZCODE_PROJECT_DIR", project.as_str()),
    ] {
        assert_eq!(env.get(name).map(String::as_str), Some(value), "{name}");
    }
    // 插件身份由 resolver 权威写入（Node 同规则）：`<name>@<marketplace>`。
    assert_eq!(env.get("NIBI_PLUGIN_ID").map(String::as_str), Some("toolkit@inline"));
}

/// 插件清单模板的数据目录与 user_config（Node `adapters/src/plugins/mcp.ts`）：
/// `${NIBI_PLUGIN_DATA}` 落在 `<插件存储根>/data/<sanitize(id)>`，`${user_config.<key>}` 取默认值，
/// `cwd`/`env` 里的 `${NIBI_PROJECT_DIR}` 展开成会话工作区。
#[tokio::test]
async fn plugin_templates_expand_data_user_config_and_project() {
    let root = "/Users/dev/plugins/math-agent";
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{root}/.nibi-plugin/plugin.json"),
        r#"{"name": "math-agent", "userConfig": {"pythonMirror": {"type": "string", "default": "https://pypi.example/simple"}}, "mcpServers": {"math": {"command": "python", "args": ["${NIBI_PLUGIN_ROOT}/tools/mcp_server.py"], "cwd": "${NIBI_PROJECT_DIR}", "env": {"NIBI_MATH_ENV_DIR": "${NIBI_PLUGIN_DATA}/env", "NIBI_MATH_PYTHON_MIRROR": "${user_config.pythonMirror}", "NIBI_WORKSPACE_ROOT": "${NIBI_PROJECT_DIR}"}}}}"#,
    );
    let data_root = "/Users/dev/plugins/data";
    let sources = PluginSources {
        data_root: Some(data_root.to_owned()),
        ..PluginSources::default()
    };
    let plugins = load_all(&env, &workspace(), &[EnvPath::new(root)], &sources)
        .await
        .plugins;
    let server = &plugins.0[0].mcp_servers[0];
    let McpTransportConfig::Stdio {
        command,
        args,
        env,
        cwd,
    } = &server.transport
    else {
        panic!("math is stdio");
    };
    let project = workspace().root.as_str().to_owned();
    assert_eq!(server.name, "plugin:math-agent:math");
    assert_eq!(command, "python");
    assert_eq!(args, &[format!("{root}/tools/mcp_server.py")]);
    assert_eq!(cwd.as_deref(), Some(project.as_str()));
    assert_eq!(env["NIBI_MATH_ENV_DIR"], format!("{data_root}/math-agent@inline/env"));
    assert_eq!(env["NIBI_MATH_PYTHON_MIRROR"], "https://pypi.example/simple");
    assert_eq!(env["NIBI_WORKSPACE_ROOT"], project);
    for name in ["CLAUDE_PLUGIN_DATA", "NIBI_PLUGIN_DATA", "ZCODE_PLUGIN_DATA"] {
        assert_eq!(env[name], format!("{data_root}/math-agent@inline"), "{name}");
    }
    assert_eq!(env["NIBI_PLUGIN_ID"], "math-agent@inline");
}

/// 配置的 `plugins.options.<id>.<key>` 覆盖 manifest 默认值（Node `options[key] ?? defaults[key]`）。
#[tokio::test]
async fn configured_plugin_options_override_the_manifest_defaults() {
    let root = "/Users/dev/plugins/math-agent";
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{root}/.nibi-plugin/plugin.json"),
        r#"{"name": "math-agent", "userConfig": {"pythonMirror": {"type": "string", "default": "https://pypi.example/simple"}}, "mcpServers": {"math": {"command": "python", "env": {"MIRROR": "${user_config.pythonMirror}"}}}}"#,
    );
    let mut options = BTreeMap::new();
    options.insert(
        "math-agent@inline".to_owned(),
        BTreeMap::from([(
            "pythonMirror".to_owned(),
            Value::String("https://mirror.example/simple".to_owned()),
        )]),
    );
    let sources = PluginSources {
        options,
        ..PluginSources::default()
    };
    let plugins = load_all(&env, &workspace(), &[EnvPath::new(root)], &sources)
        .await
        .plugins;
    let McpTransportConfig::Stdio { env, .. } = &plugins.0[0].mcp_servers[0].transport else {
        panic!("math is stdio");
    };
    assert_eq!(env["MIRROR"], "https://mirror.example/simple");
}

/// 缺 `user_config` 值时整条服务器跳过（Node `plugin_variable_missing`，fail-closed：不留字面量）。
#[tokio::test]
async fn a_missing_user_config_value_skips_the_server() {
    let root = "/Users/dev/plugins/bare-config";
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{root}/.nibi-plugin/plugin.json"),
        r#"{"name": "bare-config", "mcpServers": {"math": {"command": "python", "env": {"MIRROR": "${user_config.pythonMirror}"}}}}"#,
    );
    let plugins = load_all(&env, &workspace(), &[EnvPath::new(root)], &PluginSources::default())
        .await
        .plugins;
    assert!(plugins.0[0].mcp_servers.is_empty());
}

/// 敏感 user_config 只能进敏感 sink（Node `Sensitive plugin user_config value cannot be used in this field`）。
#[tokio::test]
async fn a_sensitive_user_config_value_is_rejected_outside_sensitive_fields() {
    let root = "/Users/dev/plugins/secret";
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{root}/.nibi-plugin/plugin.json"),
        r#"{"name": "secret", "userConfig": {"token": {"type": "string", "sensitive": true, "default": "s3cr3t"}}, "mcpServers": {"bad": {"command": "tool", "args": ["${user_config.token}"]}, "good": {"command": "tool", "env": {"TOKEN": "${user_config.token}"}}}}"#,
    );
    let plugins = load_all(&env, &workspace(), &[EnvPath::new(root)], &PluginSources::default())
        .await
        .plugins;
    let names: Vec<&str> = plugins.0[0]
        .mcp_servers
        .iter()
        .map(|server| server.name.as_str())
        .collect();
    assert_eq!(names, ["plugin:secret:good"]);
    let McpTransportConfig::Stdio { env, .. } = &plugins.0[0].mcp_servers[0].transport else {
        panic!("good is stdio");
    };
    assert_eq!(env["TOKEN"], "s3cr3t");
}

/// 配置里的 `env` 优先（Node 先放缺省再展开配置的 `env`）。
#[tokio::test]
async fn configured_env_wins_over_the_provided_variables() {
    let root = "/Users/dev/plugins/own";
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{root}/.claude-plugin/plugin.json"),
        r#"{"name": "own", "mcpServers": {"db": {"command": "db", "env": {"CLAUDE_PROJECT_DIR": "/elsewhere", "TOKEN": "x"}}}}"#,
    );
    let plugins = load_all(
        &env,
        &workspace(),
        &[EnvPath::new(root)],
        &PluginSources::default(),
    )
    .await
    .plugins;
    let McpTransportConfig::Stdio { env, .. } = &plugins.0[0].mcp_servers[0].transport else {
        panic!("db is stdio");
    };
    assert_eq!(env["CLAUDE_PROJECT_DIR"], "/elsewhere");
    assert_eq!(env["TOKEN"], "x");
    assert_eq!(env["NIBI_PLUGIN_ROOT"], root);
    // 插件 ABI 兼容层：上游插件读的旧名也在，且同样可被 manifest env 覆盖。
    assert_eq!(env["ZCODE_PLUGIN_ROOT"], root);
}

/// 插件 `commands/` 与 manifest `commands` 路径都成为自定义命令根，身份随根走。
#[tokio::test]
async fn command_roots_follow_the_plugin_manifest() {
    let root = "/Users/dev/plugins/math";
    let env = MemoryEnvironment::new(facts())
        .with_file(
            &format!("{root}/.nibi-plugin/plugin.json"),
            r#"{"name": "math-modeling", "commands": "commands"}"#,
        )
        .with_file(
            &format!("{root}/commands/mathmodel.md"),
            "---\ndescription: 数模工作台\n---\n打开。",
        );
    let plugins = load_all(
        &env,
        &workspace(),
        &[EnvPath::new(root)],
        &PluginSources::default(),
    )
    .await
    .plugins;
    assert_eq!(plugins.0[0].command_dirs, [format!("{root}/commands")]);
    let roots = plugins.command_roots();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].plugin, "math-modeling");
    assert_eq!(roots[0].dir, format!("{root}/commands"));
    assert_eq!(roots[0].root, root);
    assert!(!roots[0].official);
}

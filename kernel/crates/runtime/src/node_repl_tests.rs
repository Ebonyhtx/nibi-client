//! 内置 `node_repl` MCP 服务器的装配规则。
//!
//! 判三件事：只有官方 `node-repl-host` 目录能被启动、CUA 凭据只按白名单复制、缺产物/缺可执行
//! 路径时 fail-closed。这条路径错了不会报错，只会让 Computer Use 静默消失。

use std::collections::BTreeMap;

use nibi_kernel_api::mcp::McpTransportConfig;
use nibi_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};
use nibi_kernel_ext::{Plugin, Plugins};
use serde_json::json;

use super::builtin_server;

fn plugin(name: &str, dir: &str) -> Plugin {
    Plugin {
        id: format!("{name}@inline"),
        name: name.to_owned(),
        marketplace: "inline".to_owned(),
        dir: dir.to_owned(),
        manifest: json!({}),
        paid: false,
        skill_dirs: Vec::new(),
        skill_names: Vec::new(),
        agent_names: Vec::new(),
        mcp_servers: Vec::new(),
        agent_files: Vec::new(),
        hooks: Vec::new(),
    }
}

/// 官方宿主的插件目录（真实 bundle 由打包产物提供；这里只判路径装配）。
fn host_dir() -> String {
    "/plugins/node-repl-host".to_owned()
}

fn env() -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "NIBI_NODE_EXEC_PATH".to_owned(),
            "/opt/nibi/electron".to_owned(),
        ),
        (
            "NIBI_CUA_PERMISSION_BROKER_SOCKET".to_owned(),
            "\\\\.\\pipe\\nibi-cua".to_owned(),
        ),
        ("NIBI_CUA_PLUGIN_AUTHORITY".to_owned(), "authority".to_owned()),
        ("NIBI_CUA_WIN_HELPER_RECIPE".to_owned(), "{}".to_owned()),
        ("NIBI_API_KEY".to_owned(), "must-not-leak".to_owned()),
    ])
}

fn stdio(server: &SessionMcpServer) -> (&str, &[String], &BTreeMap<String, String>) {
    match &server.transport {
        McpTransportConfig::Stdio {
            command, args, env, ..
        } => (command, args, env),
        other => panic!("expected a stdio transport, got {other:?}"),
    }
}

#[test]
fn computer_use_starts_the_shared_host_with_only_the_cua_credentials() {
    let host = host_dir();
    let plugins = Plugins(vec![
        plugin("node-repl-host", &host),
        plugin("computer-use", "/plugins/computer-use"),
    ]);

    let server = builtin_server(&plugins, &env()).expect("the host plugin is present");

    assert_eq!(server.name, "node_repl");
    assert!(server.always_load);
    assert_eq!(server.timeout_ms, Some(600_000));
    assert_eq!(server.isolation, McpIsolation::Workspace);
    let (command, args, env) = stdio(&server);
    assert_eq!(command, "/opt/nibi/electron");
    assert_eq!(args.len(), 1);
    assert!(args[0].ends_with("server.js"));
    assert_eq!(env.get("ELECTRON_RUN_AS_NODE").map(String::as_str), Some("1"));
    assert_eq!(
        env.get("NIBI_CUA_PLUGIN_ROOT").map(String::as_str),
        Some("/plugins/computer-use")
    );
    assert_eq!(
        env.get("NIBI_CUA_NODE_REPL_HOST_ENV").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        env.get("NIBI_PLUGIN_ID").map(String::as_str),
        Some("computer-use@nibi-official")
    );
    assert_eq!(
        env.get("NIBI_CUA_PERMISSION_BROKER_SOCKET")
            .map(String::as_str),
        Some("\\\\.\\pipe\\nibi-cua")
    );
    // 账号凭据不能跟着 CUA 的复制白名单漏进 MCP 子进程。
    assert!(!env.contains_key("NIBI_API_KEY"));
}

#[test]
fn browser_use_gets_the_shared_host_without_cua_credentials() {
    let host = host_dir();
    let plugins = Plugins(vec![
        plugin("node-repl-host", &host),
        plugin("browser-use", "/plugins/browser-use"),
    ]);

    let server = builtin_server(&plugins, &env()).expect("the host plugin is present");
    let (_, _, env) = stdio(&server);

    assert_eq!(
        env.get("NIBI_PLUGIN_ROOT").map(String::as_str),
        Some("/plugins/browser-use")
    );
    assert!(!env.contains_key("NIBI_CUA_PLUGIN_ROOT"));
    assert!(!env.contains_key("NIBI_PLUGIN_ID"));
    assert!(!env.contains_key("NIBI_CUA_PERMISSION_BROKER_SOCKET"));
}

#[test]
fn without_the_official_host_plugin_there_is_no_server() {
    let plugins = Plugins(vec![plugin("computer-use", "/plugins/computer-use")]);
    assert!(builtin_server(&plugins, &env()).is_none());
}

#[test]
fn without_a_node_runtime_path_there_is_no_server() {
    let host = host_dir();
    let plugins = Plugins(vec![
        plugin("node-repl-host", &host),
        plugin("computer-use", "/plugins/computer-use"),
    ]);
    let mut env = env();
    env.remove("NIBI_NODE_EXEC_PATH");
    assert!(builtin_server(&plugins, &env).is_none());
}

#[test]
fn browser_use_gets_the_broker_credentials() {
    let host = host_dir();
    let plugins = Plugins(vec![
        plugin("node-repl-host", &host),
        plugin("browser-use", "/plugins/browser-use"),
    ]);
    let mut env = env();
    env.insert(
        "NIBI_NODE_REPL_BROWSER_BROKER_SOCKET".to_owned(),
        "nibi-browser-test-pipe".to_owned(),
    );
    let token = "t".repeat(64);
    env.insert(
        "NIBI_NODE_REPL_BROWSER_BROKER_TOKEN".to_owned(),
        token.clone(),
    );

    let server = builtin_server(&plugins, &env).expect("the host plugin is present");
    let (_, _, env) = stdio(&server);

    assert_eq!(
        env.get("NIBI_NODE_REPL_BROWSER_BROKER_SOCKET")
            .map(String::as_str),
        Some("nibi-browser-test-pipe")
    );
    assert_eq!(
        env.get("NIBI_NODE_REPL_BROWSER_BROKER_TOKEN")
            .map(String::as_str),
        Some(token.as_str())
    );
    assert!(!env.contains_key("NIBI_CUA_PLUGIN_ROOT"));
}

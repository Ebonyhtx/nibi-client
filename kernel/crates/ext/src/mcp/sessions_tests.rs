//! 会话级 MCP（NIBI `createSession.mcpServers`）：每会话一套连接、按会话可见、关闭即释放。

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};
use serde_json::json;

use super::*;
use crate::test_support::{FakeMcp, server, workspace};

fn stdio(name: &str) -> SessionMcpServer {
    SessionMcpServer {
        name: name.to_owned(),
        transport: McpTransportConfig::Stdio {
            command: "node".to_owned(),
            args: Vec::new(),
            env: Default::default(),
            cwd: None,
        },
        always_load: false,
        timeout_ms: None,
        isolation: McpIsolation::Session,
    }
}

/// 列出一个工具 `echo` 的服务器。
fn echo_server() -> Arc<crate::test_support::Handler> {
    server(json!({"tools": {}}), None, |method, _| match method {
        "tools/list" => Some(Ok(json!({"tools": [
            {"name": "echo", "description": "Echo", "inputSchema": {"type": "object"}}
        ]}))),
        _ => None,
    })
}

fn pools(fake: Arc<FakeMcp>, scope: &TaskScope) -> SessionMcp {
    SessionMcp::new(
        fake,
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::TokioClock::new(),
    )
}

#[tokio::test]
async fn each_session_gets_its_own_connections_and_tools() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("files", echo_server())
            .with("other", echo_server()),
    );
    let scope = TaskScope::root("test", |_| {});
    let pools = pools(fake, &scope);
    let first = SessionId::new("sess_a");
    let second = SessionId::new("sess_b");
    // 两个会话各带一个同名服务器（Node 的 isolation=session 缺省：连接不共享）。
    pools.start(&first, &workspace(), vec![stdio("files")]);
    pools.start(&second, &workspace(), vec![stdio("files")]);
    let (first_manager, second_manager) = (
        pools.manager(&first).expect("first"),
        pools.manager(&second).expect("second"),
    );
    assert!(!Arc::ptr_eq(&first_manager, &second_manager));
    first_manager.wait_ready().await;
    second_manager.wait_ready().await;
    let names = |manager: &Arc<McpManager>| -> Vec<String> {
        manager
            .tools()
            .into_iter()
            .map(|tool| tool.name().to_owned())
            .collect()
    };
    assert!(names(&first_manager).iter().any(|name| name == "mcp__files__echo"));
    // 一个会话的停止不影响另一个。
    pools.stop(&first);
    assert!(pools.manager(&first).is_none());
    assert!(pools.manager(&second).is_some());
}

#[tokio::test]
async fn a_later_start_replaces_the_previous_set() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("files", echo_server())
            .with("web", echo_server()),
    );
    let scope = TaskScope::root("test", |_| {});
    let pools = pools(fake, &scope);
    let session = SessionId::new("sess_a");
    let first = pools.start(&session, &workspace(), vec![stdio("files")]);
    first.wait_ready().await;
    let second = pools.start(&session, &workspace(), vec![stdio("web")]);
    second.wait_ready().await;
    assert!(!Arc::ptr_eq(&first, &second));
    let tools: Vec<String> = second
        .tools()
        .into_iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert!(tools.iter().any(|name| name == "mcp__web__echo"), "{tools:?}");
    assert!(!tools.iter().any(|name| name == "mcp__files__echo"), "{tools:?}");
    assert!(pools.manager(&session).is_some());
    pools.stop(&session);
    assert!(pools.manager(&session).is_none());
}

#[test]
fn protocol_servers_become_dynamic_config_with_options() {
    let servers = to_servers(vec![
        SessionMcpServer {
            always_load: true,
            timeout_ms: Some(1200),
            ..stdio("files")
        },
        SessionMcpServer {
            name: "cloud".to_owned(),
            transport: McpTransportConfig::Http {
                url: "https://example.invalid/mcp".to_owned(),
                headers: Default::default(),
            },
            always_load: false,
            timeout_ms: None,
            isolation: McpIsolation::Workspace,
        },
    ]);
    assert_eq!(servers.len(), 2);
    assert_eq!(servers[0].scope, McpScope::Dynamic);
    assert!(servers[0].options.always_load);
    assert_eq!(servers[0].options.timeout_ms, Some(1200));
    assert_eq!(servers[1].options.timeout_ms, None);
    assert!(servers[1].machine.is_none());
}

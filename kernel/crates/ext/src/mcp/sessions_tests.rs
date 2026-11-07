//! 会话级 MCP（NIBI `createSession.mcpServers`）：每会话一套连接、按会话可见、关闭即释放。

use std::sync::Arc;

use nibi_kernel_base::TaskScope;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::mcp::McpTransportConfig;
use nibi_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};
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
        None,
        None,
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
        pools.manager_of(&first).expect("first"),
        pools.manager_of(&second).expect("second"),
    );
    // isolation=session（缺省）：两套连接没有交集。
    let (first_ids, second_ids) = (first_manager.identities(), second_manager.identities());
    assert!(first_ids.iter().all(|id| !second_ids.contains(id)));
    first_manager.wait_ready().await;
    second_manager.wait_ready().await;
    let names = |manager: &Arc<SessionConnections>| -> Vec<String> {
        manager
            .tools()
            .into_iter()
            .map(|tool| tool.name().to_owned())
            .collect()
    };
    assert!(names(&first_manager).iter().any(|name| name == "mcp__files__echo"));
    // 一个会话的停止不影响另一个。
    pools.stop(&first);
    assert!(pools.manager_of(&first).is_none());
    assert!(pools.manager_of(&second).is_some());
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
    let second = pools.replace(&session, &workspace(), vec![stdio("web")]);
    second.wait_ready().await;
    assert_ne!(first.identities(), second.identities());
    let tools: Vec<String> = second
        .tools()
        .into_iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert!(tools.iter().any(|name| name == "mcp__web__echo"), "{tools:?}");
    assert!(!tools.iter().any(|name| name == "mcp__files__echo"), "{tools:?}");
    assert!(pools.manager_of(&session).is_some());
    pools.stop(&session);
    assert!(pools.manager_of(&session).is_none());
}

#[tokio::test]
async fn a_later_start_merges_the_previous_set() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("files", echo_server())
            .with("web", echo_server()),
    );
    let scope = TaskScope::root("test", |_| {});
    let pools = pools(fake, &scope);
    let session = SessionId::new("sess_merge");
    let first = pools.start(&session, &workspace(), vec![stdio("files")]);
    first.wait_ready().await;
    let second = pools.start(&session, &workspace(), vec![stdio("web")]);
    second.wait_ready().await;
    let tools: Vec<String> = second
        .tools()
        .into_iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert!(tools.iter().any(|name| name == "mcp__files__echo"), "{tools:?}");
    assert!(tools.iter().any(|name| name == "mcp__web__echo"), "{tools:?}");
    pools.stop(&session);
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

#[tokio::test]
async fn a_child_session_borrows_its_parents_connections() {
    let fake = Arc::new(FakeMcp::default().with("files", echo_server()));
    let scope = TaskScope::root("test", |_| {});
    let pools = pools(fake, &scope);
    let parent = SessionId::new("sess_parent");
    let child = SessionId::new("sess_child");
    pools.start(&parent, &workspace(), vec![stdio("files")]);
    let parent_manager = pools.manager_of(&parent).expect("parent");
    parent_manager.wait_ready().await;

    // 没继承前子会话没有会话级 MCP（回落到进程级配置）。
    assert!(pools.manager_of(&child).is_none());
    pools.inherit(&parent, &child);
    let child_manager = pools.manager_of(&child).expect("child");
    assert_eq!(parent_manager.identities(), child_manager.identities());
    let names: Vec<String> = child_manager
        .tools()
        .into_iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert!(names.iter().any(|name| name == "mcp__files__echo"), "{names:?}");

    // 子会话关闭只移掉借用条目：父会话的连接还在。
    pools.stop(&child);
    assert!(pools.manager_of(&child).is_none());
    assert!(pools.manager_of(&parent).is_some());
    // 父会话没有会话级 MCP 时继承是空操作。
    pools.inherit(&child, &SessionId::new("sess_grandchild"));
    assert!(pools.manager_of(&SessionId::new("sess_grandchild")).is_none());
}

fn workspace_at(root: &str) -> nibi_kernel_api::env::WorkspaceRef {
    nibi_kernel_api::env::WorkspaceRef {
        environment: nibi_kernel_api::ids::EnvironmentId::new("local"),
        root: nibi_kernel_api::env::EnvPath::new(root),
    }
}

fn workspace_stdio(name: &str) -> SessionMcpServer {
    SessionMcpServer {
        isolation: McpIsolation::Workspace,
        ..stdio(name)
    }
}

/// `isolation: "workspace"`：同一工作区的两个会话共用一条连接（Node pool 的 workspace key）。
#[tokio::test]
async fn a_workspace_isolated_server_is_shared_between_sessions() {
    let fake = Arc::new(FakeMcp::default().with("cloud", echo_server()));
    let scope = TaskScope::root("test", |_| {});
    let pools = pools(fake, &scope);
    let (first_session, second_session) = (SessionId::new("sess_a"), SessionId::new("sess_b"));
    pools.start(&first_session, &workspace(), vec![workspace_stdio("cloud")]);
    let first = pools
        .start(&second_session, &workspace(), vec![workspace_stdio("cloud")])
        .clone();
    let second = pools.manager_of(&second_session).expect("second");
    first.wait_ready().await;

    // 共享的那一套是同一条连接；会话自己的（这里为空）各自独立。
    assert_eq!(first.shared_identities(), second.shared_identities());
    assert!(!first.shared_identities().is_empty());
    let tools: Vec<String> = second
        .tools()
        .into_iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert!(tools.iter().any(|name| name == "mcp__cloud__echo"), "{tools:?}");

    // 别的工作区不共享。
    let other = SessionId::new("sess_other");
    let elsewhere = pools.start(&other, &workspace_at("/w/other"), vec![workspace_stdio("cloud")]);
    assert_ne!(first.shared_identities(), elsewhere.shared_identities());

    // 引用计数：关掉一个会话，另一个还能用；两个都关掉之后连接释放（再开会是新的）。
    pools.stop(&first_session);
    assert!(pools.manager_of(&second_session).is_some());
    pools.stop(&second_session);
    pools.stop(&other);
    let reopened = pools.start(
        &SessionId::new("sess_again"),
        &workspace(),
        vec![workspace_stdio("cloud")],
    );
    assert_ne!(first.shared_identities(), reopened.shared_identities());
    pools.stop(&SessionId::new("sess_again"));
}

/// 混合集合：会话自己的服务器与工作区共享的服务器在同一个工具表里。
#[tokio::test]
async fn a_session_mixes_its_own_and_shared_servers() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("files", echo_server())
            .with("cloud", echo_server()),
    );
    let scope = TaskScope::root("test", |_| {});
    let pools = pools(fake, &scope);
    let session = SessionId::new("sess_mix");
    let connections = pools.start(
        &session,
        &workspace(),
        vec![stdio("files"), workspace_stdio("cloud")],
    );
    connections.wait_ready().await;
    let tools: Vec<String> = connections
        .tools()
        .into_iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert!(tools.iter().any(|name| name == "mcp__files__echo"), "{tools:?}");
    assert!(tools.iter().any(|name| name == "mcp__cloud__echo"), "{tools:?}");
    // 两个服务器在两套 manager 里：自己的一套 + 共享的一套。
    assert_eq!(connections.identities().len(), 2);
    assert_eq!(connections.shared_identities().len(), 1);
    // 状态视图合并后按名字排序。
    let view = connections.view();
    assert_eq!(
        view.servers.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
        ["cloud", "files"]
    );
    pools.stop(&session);
}

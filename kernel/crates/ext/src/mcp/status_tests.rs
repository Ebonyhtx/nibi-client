//! 工作区 MCP 状态检查（`mcp/list`，141 审计 §9 第 6 项）：收敛、删除、换配置、失败分类、
//! 只读快照与插件服务器。

use std::sync::Arc;

use nibi_kernel_base::TaskScope;
use nibi_kernel_api::mcp::McpTransportConfig;
use nibi_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};
use nibi_kernel_api::mcp_status::{
    McpFailureKind, McpProtocolEra, McpServerStatusKind, McpTransportKind,
};
use serde_json::json;

use super::*;
use crate::test_support::{FakeMcp, server, workspace};

fn new_registry(fake: Arc<FakeMcp>, scope: &TaskScope) -> McpStatusRegistry {
    McpStatusRegistry::new(
        fake,
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::TokioClock::new(),
        None,
        None,
    )
}

fn stdio(name: &str, args: &[&str]) -> SessionMcpServer {
    SessionMcpServer {
        name: name.to_owned(),
        transport: McpTransportConfig::Stdio {
            command: "node".to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            env: Default::default(),
            cwd: None,
        },
        always_load: false,
        timeout_ms: None,
        isolation: McpIsolation::Session,
        oauth: None,
        protocol_version: Default::default(),
    }
}

fn http(name: &str) -> SessionMcpServer {
    SessionMcpServer {
        name: name.to_owned(),
        transport: McpTransportConfig::Http {
            url: "https://mcp.example.invalid/mcp".to_owned(),
            headers: Default::default(),
        },
        always_load: false,
        timeout_ms: None,
        isolation: McpIsolation::Session,
        oauth: None,
        protocol_version: Default::default(),
    }
}

fn request(servers: Option<Vec<SessionMcpServer>>, connect: bool) -> McpListRequest {
    McpListRequest {
        workspace: workspace(),
        servers,
        connect,
    }
}

/// 两个工具、什么都不做的服务器。
fn files() -> Arc<crate::test_support::Handler> {
    server(json!({"tools": {}}), None, |method, _| match method {
        "tools/list" => Some(Ok(json!({"tools": [
            {"name": "read", "inputSchema": {"type": "object"}},
            {"name": "write", "inputSchema": {"type": "object"}},
        ]}))),
        _ => None,
    })
}

fn names(statuses: &[McpServerStatus]) -> Vec<String> {
    let mut names: Vec<String> = statuses.iter().map(|status| status.name.clone()).collect();
    names.sort();
    names
}

/// 显式下发的集合被连上：状态、传输、工具数与时间戳都有。
#[tokio::test]
async fn explicit_servers_connect_and_report_their_tools() {
    let fake = Arc::new(FakeMcp::default().with("files", files()));
    let scope = TaskScope::root("status", |_| {});
    let manager = new_registry(fake, &scope);
    let statuses = manager
        .list(request(Some(vec![stdio("files", &[])]), true))
        .await;
    assert_eq!(names(&statuses), vec!["files"]);
    let status = &statuses[0];
    assert_eq!(status.status, McpServerStatusKind::Connected);
    assert_eq!(status.transport, McpTransportKind::Stdio);
    assert_eq!(status.tool_count, 2);
    assert_eq!(status.protocol_era, Some(McpProtocolEra::Legacy));
    assert!(status.updated_at_ms >= 1_000_000);
    assert!(status.error.is_none());
    assert!(status.failure_kind.is_none());
}

/// `connect` 是完整集合：缺席的断开并移出，留下的不重连。
#[tokio::test]
async fn a_connect_replaces_the_previous_set() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("files", files())
            .with("search", files()),
    );
    let scope = TaskScope::root("status", |_| {});
    let manager = new_registry(fake.clone(), &scope);
    let both = manager
        .list(request(
            Some(vec![stdio("files", &[]), stdio("search", &[])]),
            true,
        ))
        .await;
    assert_eq!(names(&both), vec!["files", "search"]);
    let connects_before = fake.roots().len();

    let only_files = manager
        .list(request(Some(vec![stdio("files", &[])]), true))
        .await;
    assert_eq!(names(&only_files), vec!["files"]);
    assert_eq!(only_files[0].status, McpServerStatusKind::Connected);
    // 只有新集合里留下的那一个不需要重连：连接次数没有再长。
    assert_eq!(fake.roots().len(), connects_before);
}

/// 同名换配置（这里的 `args` 变了）：换掉重连，状态先 pending 再连上。
#[tokio::test]
async fn a_changed_configuration_restarts_that_server() {
    let fake = Arc::new(FakeMcp::default().with("files", files()));
    let scope = TaskScope::root("status", |_| {});
    let manager = new_registry(fake.clone(), &scope);
    manager
        .list(request(Some(vec![stdio("files", &[])]), true))
        .await;
    let statuses = manager
        .list(request(Some(vec![stdio("files", &["--changed"])]), true))
        .await;
    assert_eq!(statuses[0].status, McpServerStatusKind::Connected);
    let files_connects = fake
        .roots()
        .iter()
        .filter(|(name, _)| name == "files")
        .count();
    assert_eq!(files_connects, 2);
}

/// 失败分类在失败发生的地方定：stdio 起不来是 `process_start_failed`，HTTP 连不上是
/// `connection_failed`。
#[tokio::test]
async fn failures_carry_the_kind_they_were_classified_with() {
    let fake = Arc::new(FakeMcp::default().refusing("bad").refusing("remote"));
    let scope = TaskScope::root("status", |_| {});
    let manager = new_registry(fake, &scope);
    let statuses = manager
        .list(request(Some(vec![stdio("bad", &[]), http("remote")]), true))
        .await;
    let by_name = |name: &str| {
        statuses
            .iter()
            .find(|status| status.name == name)
            .unwrap_or_else(|| panic!("{name}"))
    };
    let bad = by_name("bad");
    assert_eq!(bad.status, McpServerStatusKind::Failed);
    assert_eq!(bad.failure_kind, Some(McpFailureKind::ProcessStartFailed));
    assert!(bad.error.as_deref().unwrap_or_default().contains("spawn failed"));
    let remote = by_name("remote");
    assert_eq!(remote.failure_kind, Some(McpFailureKind::ConnectionFailed));
}

/// 握手超时是 `connection_timeout`。
#[tokio::test]
async fn a_handshake_timeout_is_its_own_kind() {
    let fake = Arc::new(
        FakeMcp::default().with("slow", crate::test_support::held(|_, _| None)),
    );
    let scope = TaskScope::root("status", |_| {});
    let manager = McpStatusRegistry::new(
        fake,
        scope.spawner(),
        McpSettings {
            connect_timeout_ms: 50,
            ..McpSettings::default()
        },
        crate::clock_tests::TokioClock::new(),
        None,
        None,
    );
    let statuses = manager
        .list(request(Some(vec![stdio("slow", &[])]), true))
        .await;
    assert_eq!(statuses[0].status, McpServerStatusKind::Failed);
    assert_eq!(
        statuses[0].failure_kind,
        Some(McpFailureKind::ConnectionTimeout)
    );
}

/// `status` 只读：没有连接管理时，显式下发的服务器是 `disconnected`，不去连。
#[tokio::test]
async fn a_status_request_never_connects_anything() {
    let fake = Arc::new(FakeMcp::default().with("files", files()));
    let scope = TaskScope::root("status", |_| {});
    let manager = new_registry(fake.clone(), &scope);
    let statuses = manager
        .list(request(Some(vec![stdio("files", &[])]), false))
        .await;
    assert_eq!(statuses[0].status, McpServerStatusKind::Disconnected);
    assert!(fake.roots().is_empty(), "status 不能建连接");
}

/// 连过之后再 status：已知的报真状态，新出现的名字补 `disconnected`。
#[tokio::test]
async fn a_status_request_merges_the_known_and_the_new_names() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("files", files())
            .with("search", files()),
    );
    let scope = TaskScope::root("status", |_| {});
    let manager = new_registry(fake.clone(), &scope);
    manager
        .list(request(Some(vec![stdio("files", &[])]), true))
        .await;
    let statuses = manager
        .list(request(
            Some(vec![stdio("files", &[]), stdio("search", &[])]),
            false,
        ))
        .await;
    let files_status = statuses
        .iter()
        .find(|status| status.name == "files")
        .expect("files");
    assert_eq!(files_status.status, McpServerStatusKind::Connected);
    let search = statuses
        .iter()
        .find(|status| status.name == "search")
        .expect("search");
    assert_eq!(search.status, McpServerStatusKind::Disconnected);
    // 只连过 files：status 没有为 search 新建连接。
    assert_eq!(fake.roots().len(), 1);
}

/// 同配置的失败在下一次 `connect` 再试一次：设置页的手动刷新要能恢复。
#[tokio::test]
async fn a_connect_retries_a_failed_server() {
    let fake = Arc::new(FakeMcp::default().refusing("files").with("files", files()));
    let scope = TaskScope::root("status", |_| {});
    let manager = new_registry(fake.clone(), &scope);
    let first = manager
        .list(request(Some(vec![stdio("files", &[])]), true))
        .await;
    assert_eq!(first[0].status, McpServerStatusKind::Failed);
    fake.accepting("files");
    let second = manager
        .list(request(Some(vec![stdio("files", &[])]), true))
        .await;
    assert_eq!(second[0].status, McpServerStatusKind::Connected);
    assert_eq!(second[0].tool_count, 2);
}

/// 缺席 `mcpServers` 时用 `Ext::start` 读到的那一份，插件服务器总是并入。
#[tokio::test]
async fn the_seeded_configuration_and_plugin_servers_are_the_default_set() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("configured", files())
            .with("plugin", files()),
    );
    let scope = TaskScope::root("status", |_| {});
    let manager = new_registry(fake.clone(), &scope);
    manager.seed(
        workspace().root.as_str(),
        vec![to_server(&stdio("configured", &[]))],
        vec![to_server(&stdio("plugin", &[]))],
    );
    let statuses = manager.list(request(None, true)).await;
    assert_eq!(names(&statuses), vec!["configured", "plugin"]);

    // 显式下发会换掉配置里的集合，但插件服务器仍在。
    let fake2 = Arc::new(
        FakeMcp::default()
            .with("configured", files())
            .with("plugin", files())
            .with("explicit", files()),
    );
    let scope2 = TaskScope::root("status", |_| {});
    let second = new_registry(fake2, &scope2);
    second.seed(
        workspace().root.as_str(),
        vec![to_server(&stdio("configured", &[]))],
        vec![to_server(&stdio("plugin", &[]))],
    );
    let statuses = second
        .list(request(Some(vec![stdio("explicit", &[])]), true))
        .await;
    assert_eq!(names(&statuses), vec!["explicit", "plugin"]);
}

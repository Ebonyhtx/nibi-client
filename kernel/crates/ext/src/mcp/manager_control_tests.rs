//! `/mcp reconnect|enable|disable`（tui-manage.md §6.1）：重连换新连接，停用停掉任务，启用重新连上。
use std::sync::Arc;

use nibi_kernel_api::manage::{McpAction, McpServerState};
use nibi_kernel_api::mcp::McpTransportConfig;
use nibi_kernel_base::TaskScope;
use serde_json::json;

use super::super::McpSettings;
use super::*;
use crate::mcp::McpScope;
use crate::test_support::{FakeMcp, held, server, workspace};

fn config(name: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
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
    }
}

fn fake() -> Arc<FakeMcp> {
    let tools = || {
        server(json!({"tools": {}}), None, |method, _| match method {
            "tools/list" => Some(Ok(json!({"tools": [
                {"name": "read", "inputSchema": {"type": "object"}}
            ]}))),
            _ => None,
        })
    };
    Arc::new(
        FakeMcp::default()
            .with("files", tools())
            .with("off", tools()),
    )
}

fn handshakes(fake: &FakeMcp, name: &str) -> usize {
    fake.received()
        .iter()
        .filter(|(server, message)| server == name && message["method"] == "initialize")
        .count()
}

fn names(manager: &McpManager) -> Vec<String> {
    manager
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect()
}

#[tokio::test]
async fn reconnect_disable_and_enable_drive_the_connection() {
    let fake = fake();
    let scope = TaskScope::root("test", |_| {});
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::TokioClock::new(),
    );
    manager.start(workspace(), vec![config("files")]);
    manager.register_disabled(vec![config("off"), config("files")]);
    manager.wait_ready().await;
    assert_eq!(handshakes(&fake, "files"), 1);
    let states = |infos: &[McpServerInfo]| {
        infos
            .iter()
            .map(|info| (info.name.clone(), info.state))
            .collect::<Vec<_>>()
    };
    // 启动时停用的登记为 disabled，不连接；已启动的不被它覆盖。
    assert_eq!(
        states(&manager.server_infos()),
        [
            ("files".to_owned(), McpServerState::Connected),
            ("off".to_owned(), McpServerState::Disabled)
        ]
    );
    assert_eq!(handshakes(&fake, "off"), 0);
    // 重连：新的握手，结果是已连接；停用的跳过。
    let infos = manager
        .control(
            McpAction::Reconnect,
            &["files".to_owned(), "off".to_owned()],
        )
        .await;
    assert_eq!(
        states(&infos),
        [
            ("files".to_owned(), McpServerState::Connected),
            ("off".to_owned(), McpServerState::Disabled)
        ]
    );
    assert_eq!(handshakes(&fake, "files"), 2);
    assert_eq!(names(&manager), ["mcp__files__read"]);
    // 停用：工具消失；旧连接再关闭也不改状态（代号不符）。
    let infos = manager
        .control(McpAction::Disable, &["files".to_owned()])
        .await;
    assert_eq!(
        states(&infos),
        [("files".to_owned(), McpServerState::Disabled)]
    );
    assert!(names(&manager).is_empty());
    fake.drop_server("files", false);
    tokio::task::yield_now().await;
    assert_eq!(manager.server_infos()[0].state, McpServerState::Disabled);
    // 启用：重新连上（包括启动时停用的）。
    let infos = manager
        .control(McpAction::Enable, &["files".to_owned(), "off".to_owned()])
        .await;
    assert_eq!(
        states(&infos),
        [
            ("files".to_owned(), McpServerState::Connected),
            ("off".to_owned(), McpServerState::Connected)
        ]
    );
    assert_eq!(names(&manager), ["mcp__files__read", "mcp__off__read"]);
    // 已启用的再启用：不动。
    manager
        .control(McpAction::Enable, &["files".to_owned()])
        .await;
    assert_eq!(handshakes(&fake, "files"), 3);
}

/// 会话在握手期间被关闭（归档/快速切走的高频路径）：`stop_all` 只能看到已经发布到
/// `server.client` 的连接，握手中的连接还没发布。它的释放必须由 `Client::drop` 的兜底
/// close 完成，否则 transport 条目与插件宿主子进程会永久留在内核里
/// （2026-11-26 资源占用事故：12 个孤儿插件宿主约 1.9 GB）。
#[tokio::test]
async fn stop_all_closes_a_connection_that_is_still_handshaking() {
    let fake = Arc::new(FakeMcp::default().with("slow", held(|_, _| None)));
    let scope = TaskScope::root("test", |_| {});
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::TokioClock::new(),
    );
    manager.start(workspace(), vec![config("slow")]);
    // 等 initialize 发出：连接已建立，但服务器不回，client 还没发布。
    for _ in 0..500 {
        if handshakes(&fake, "slow") == 1 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(handshakes(&fake, "slow"), 1);
    assert!(fake.closed_connections().is_empty());

    manager.stop_all().await;
    // Drop 里的关闭是后台任务：让出执行机会，等它跑到 transport.close。
    for _ in 0..500 {
        if !fake.closed_connections().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(
        fake.closed_connections().len(),
        1,
        "the in-flight connection must be closed when the session stops"
    );
}

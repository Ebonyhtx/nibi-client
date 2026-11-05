//! MCP 进程遥测（141 审计 §9 F3）：连接报到、第一次视图发 startup、进程自己退出报 crash。

use std::sync::Arc;
use std::time::Duration;

use nibi_kernel_base::TaskScope;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::mcp::McpTransportConfig;
use nibi_kernel_api::manage::McpServerState;
use nibi_kernel_api::mcp_state::McpConnections;
use nibi_kernel_api::mcp_telemetry::McpTelemetryEvent;
use serde_json::json;

use super::McpManager;
use crate::mcp::config::{McpServer, McpServerOptions, McpSettings};
use crate::mcp::{McpScope, McpTelemetry, McpTelemetrySlot};
use crate::test_support::{FakeMcp, server, workspace};

fn config(name: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::Plugin,
        transport: McpTransportConfig::Stdio {
            command: "node".to_owned(),
            args: Vec::new(),
            env: Default::default(),
            cwd: None,
        },
        options: McpServerOptions {
            timeout_ms: None,
            always_load: false,
        },
        machine: None,
    }
}

fn tools_server() -> Arc<crate::test_support::Handler> {
    server(json!({"tools": {}}), None, |method, _| {
        (method == "tools/list").then(|| Ok(json!({"tools": []})))
    })
}

/// 等到（或超时）下一条事件。
async fn next_event(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<McpTelemetryEvent>,
) -> McpTelemetryEvent {
    tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("an event within the timeout")
        .expect("the channel stays open")
}

#[tokio::test]
async fn a_session_scoped_server_reports_start_startup_and_crash() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("plugin:math:server", tools_server())
            .with_pid(4_242),
    );
    let scope = TaskScope::root("test", |_| {});
    let clock = crate::clock_tests::TokioClock::new();
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        clock.clone(),
    );
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    manager.attach_telemetry(McpTelemetrySlot {
        telemetry: McpTelemetry::new(sender, "device-1".to_owned()),
        isolation: "session",
        session: Some(SessionId::new("sess_1")),
    });
    manager.start(workspace(), vec![config("plugin:math:server")]);

    // 连上之后：一条 process_start，身份是加盐摘要（不是服务器名）。
    let view = manager
        .wait(
            5_000,
            &|view: &nibi_kernel_api::mcp_state::McpView| {
                view.servers
                    .iter()
                    .all(|server| server.state != McpServerState::Pending)
            },
        )
        .await;
    assert_eq!(view.servers[0].state, McpServerState::Connected);
    let start = next_event(&mut events).await;
    let McpTelemetryEvent::ProcessStart {
        mcp_id,
        mcp_instance_id,
        mcp_isolation,
        mcp_source,
        ..
    } = start
    else {
        panic!("expected process_start, got {start:?}");
    };
    assert!(mcp_id.starts_with("plugin:"), "{mcp_id}");
    assert_eq!(mcp_id.len(), "plugin:".len() + 12);
    assert!(!mcp_instance_id.is_empty());
    let started_instance = mcp_instance_id;
    assert_eq!(mcp_isolation, "session");
    assert_eq!(mcp_source, "plugin");

    // 第一次取视图发一条 session_startup：配置 1、连上 1、有进程 1。
    let _ = manager.view();
    let startup = next_event(&mut events).await;
    let McpTelemetryEvent::SessionStartup {
        configured_count,
        connected_count,
        failed_count,
        process_count,
        session_id,
        ..
    } = startup
    else {
        panic!("expected session_startup, got {startup:?}");
    };
    assert_eq!((configured_count, connected_count), (1, 1));
    assert_eq!((failed_count, process_count), (0, 1));
    assert_eq!(session_id, "sess_1");

    // 再取一次视图不重复发。
    let _ = manager.view();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), events.recv())
            .await
            .is_err()
    );

    // 进程自己退出：一条 process_crash，受影响会话数是 1。
    fake.exit_server("plugin:math:server");
    let crash = next_event(&mut events).await;
    let McpTelemetryEvent::ProcessCrash {
        affected_session_count,
        mcp_instance_id,
        exit_code,
        signal,
        ..
    } = crash
    else {
        panic!("expected process_crash, got {crash:?}");
    };
    assert_eq!(affected_session_count, 1);
    assert_eq!(mcp_instance_id, started_instance);
    assert!(exit_code.is_none());
    assert!(signal.is_none());
}

/// 主动关闭（`close`）不是 crash：不发 `process_crash`。
#[tokio::test]
async fn a_deliberate_close_is_not_a_crash() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("plugin:math:server", tools_server())
            .with_pid(4_243),
    );
    let scope = TaskScope::root("test", |_| {});
    let clock = crate::clock_tests::TokioClock::new();
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        clock,
    );
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    manager.attach_telemetry(McpTelemetrySlot {
        telemetry: McpTelemetry::new(sender, "device-1".to_owned()),
        isolation: "workspace",
        session: None,
    });
    manager.start(workspace(), vec![config("plugin:math:server")]);
    manager
        .wait(
            5_000,
            &|view: &nibi_kernel_api::mcp_state::McpView| {
                view.servers
                    .iter()
                    .all(|server| server.state != McpServerState::Pending)
            },
        )
        .await;
    // 丢掉 process_start。
    let _ = next_event(&mut events).await;
    fake.drop_server("plugin:math:server", false);
    assert!(
        tokio::time::timeout(Duration::from_millis(300), events.recv())
            .await
            .is_err(),
        "a deliberate close must not report a crash"
    );
    // 进程级 manager 不绑定会话：不发 session_startup。
    let _ = manager.view();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), events.recv())
            .await
            .is_err()
    );
}

/// 没有 pid 的传输（HTTP / SSE）不产生 process_start。
#[tokio::test]
async fn a_transport_without_a_process_reports_nothing() {
    let fake = Arc::new(FakeMcp::default().with("remote", tools_server()));
    let scope = TaskScope::root("test", |_| {});
    let clock = crate::clock_tests::TokioClock::new();
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        clock,
    );
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    manager.attach_telemetry(McpTelemetrySlot {
        telemetry: McpTelemetry::new(sender, "device-1".to_owned()),
        isolation: "workspace",
        session: None,
    });
    let mut remote = config("remote");
    remote.transport = McpTransportConfig::Http {
        url: "https://mcp.example.com/mcp".to_owned(),
        headers: Default::default(),
    };
    manager.start(workspace(), vec![remote]);
    manager
        .wait(
            5_000,
            &|view: &nibi_kernel_api::mcp_state::McpView| {
                view.servers
                    .iter()
                    .all(|server| server.state != McpServerState::Pending)
            },
        )
        .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), events.recv())
            .await
            .is_err()
    );
}

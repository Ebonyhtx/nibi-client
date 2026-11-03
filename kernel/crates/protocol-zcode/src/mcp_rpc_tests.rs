//! `mcp/list` 经 `Handler` 的真实分派（141 审计 §9 第 6 项 F7 的第一条）：参数契约（Host zod
//! 的 `.strict()`）、`connect` / `status` 两种模式、快照形状与 OAuth 的如实拒绝。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::mcp::{McpTransportConfig};
use rust_cli_kernel_api::mcp_session::McpIsolation;
use rust_cli_kernel_api::mcp_status::{
    McpFailureKind, McpListRequest, McpProtocolEra, McpServerStatus, McpServerStatusKind,
    McpTransportKind,
};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, Kernel, KernelError};
use rust_cli_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

fn selection() -> ModelSelection {
    ModelSelection {
        provider: "p".to_owned(),
        model: "m".to_owned(),
        reasoning: None,
        connection: None,
    }
}

/// 替身 Kernel：记下 `mcp/list` 的入参，回固定的快照。
#[derive(Default)]
struct FakeKernel {
    seen: Arc<Mutex<Vec<McpListRequest>>>,
    statuses: Vec<McpServerStatus>,
}

#[async_trait]
impl Kernel for FakeKernel {
    async fn create_session(&self, _request: CreateSession) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "session creation".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: rust_cli_kernel_api::store::SessionFilter,
    ) -> Result<Vec<rust_cli_kernel_api::store::SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn rust_cli_kernel_api::session_api::SessionHandle>, KernelError> {
        Err(KernelError::NotFound {
            session: SessionId::new("unused"),
        })
    }

    async fn mcp_list(
        &self,
        request: McpListRequest,
    ) -> Result<Vec<McpServerStatus>, KernelError> {
        self.seen.lock().unwrap().push(request);
        Ok(self.statuses.clone())
    }
}

fn server(kernel: Arc<FakeKernel>) -> Arc<Server> {
    let scope = TaskScope::root("mcp-list-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let clock: Arc<dyn rust_cli_kernel_api::clock::Clock> =
        Arc::new(rust_cli_kernel_api::testing::FixedClock(1_760_000_000_000));
    let context = Arc::new(Context::new(peer, clock));
    Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ))
}

fn fake(kernel: FakeKernel) -> (Arc<Server>, Arc<Mutex<Vec<McpListRequest>>>) {
    let seen = kernel.seen.clone();
    (server(Arc::new(kernel)), seen)
}

async fn call(server: Arc<Server>, params: Value) -> Value {
    Handler(server)
        .request("mcp/list", params)
        .await
        .expect("mcp/list")
        .result
}

async fn call_error(server: Arc<Server>, params: Value) -> rust_cli_protocol_core::rpc::RpcError {
    match Handler(server).request("mcp/list", params).await {
        Ok(_) => panic!("expected mcp/list to fail"),
        Err(error) => error,
    }
}

fn connected(name: &str, tools: usize) -> McpServerStatus {
    McpServerStatus {
        name: name.to_owned(),
        status: McpServerStatusKind::Connected,
        transport: McpTransportKind::Http,
        tool_count: tools,
        updated_at_ms: 1_760_000_000_000,
        error: None,
        failure_kind: None,
        server_request_id: None,
        protocol_era: Some(McpProtocolEra::Legacy),
        authorization: None,
    }
}

fn workspace() -> Value {
    json!({"workspacePath": "/w", "workspaceKey": "k"})
}

/// 缺省 `mode` 是 `connect`：显式下发的 stdio 服务器按 Host 的字段逐个落到协议类型上。
#[tokio::test]
async fn the_default_mode_connects_and_converts_stdio_servers() {
    let (server, seen) = fake(FakeKernel::default());
    let reply = call(
        server,
        json!({
            "workspace": workspace(),
            "mcpServers": [{
                "name": "files",
                "command": "node",
                "args": ["server.js"],
                "env": [{"name": "A", "value": "B"}],
                "isolation": "workspace",
                "protocolVersion": "auto",
                "alwaysLoad": true,
                "timeoutMs": 5000,
            }],
        }),
    )
    .await;
    assert_eq!(reply, json!({"statuses": {}}));

    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert!(request.connect);
    assert_eq!(request.workspace.environment.as_str(), "env");
    assert_eq!(request.workspace.root.as_str(), "/w");
    let servers = request.servers.as_ref().expect("explicit list");
    assert_eq!(servers.len(), 1);
    let files = &servers[0];
    assert_eq!(files.name, "files");
    assert_eq!(files.isolation, McpIsolation::Workspace);
    assert!(files.always_load);
    assert_eq!(files.timeout_ms, Some(5000));
    match &files.transport {
        McpTransportConfig::Stdio {
            command, args, env, ..
        } => {
            assert_eq!(command, "node");
            assert_eq!(args, &["server.js".to_owned()]);
            assert_eq!(env.get("A").map(String::as_str), Some("B"));
        }
        other => panic!("{other:?}"),
    }
}

/// `mode: "status"` 只读；`mcpServers` 缺席时内核看到的是 `None`（用配置里的集合）。
#[tokio::test]
async fn status_mode_is_read_only_and_an_absent_list_stays_absent() {
    let (server, seen) = fake(FakeKernel::default());
    let reply = call(
        server,
        json!({"workspace": workspace(), "mode": "status"}),
    )
    .await;
    assert_eq!(reply, json!({"statuses": {}}));
    let requests = seen.lock().unwrap();
    assert!(!requests[0].connect);
    assert!(requests[0].servers.is_none());
}

/// 快照的键形状与 Host 的 schema 一致：`updatedAt` 是 ISO，可选字段缺席不写。
#[tokio::test]
async fn the_snapshot_shape_matches_the_host_schema() {
    let statuses = vec![
        connected("cloud", 3),
        McpServerStatus {
            name: "bad".to_owned(),
            status: McpServerStatusKind::Failed,
            transport: McpTransportKind::Stdio,
            tool_count: 0,
            updated_at_ms: 1_760_000_000_123,
            error: Some("spawn failed".to_owned()),
            failure_kind: Some(McpFailureKind::ProcessStartFailed),
            server_request_id: Some("req-7".to_owned()),
            protocol_era: None,
            authorization: None,
        },
    ];
    let (server, _seen) = fake(FakeKernel {
        statuses,
        ..FakeKernel::default()
    });
    let reply = call(server, json!({"workspace": workspace(), "mode": "status"})).await;
    let statuses = reply["statuses"].as_object().expect("statuses");
    assert_eq!(
        statuses["cloud"],
        json!({
            "status": "connected",
            "transport": "http",
            "toolCount": 3,
            "updatedAt": "2025-10-09T08:53:20.000Z",
            "protocolEra": "legacy",
        })
    );
    assert_eq!(
        statuses["bad"],
        json!({
            "status": "failed",
            "transport": "stdio",
            "toolCount": 0,
            "updatedAt": "2025-10-09T08:53:20.123Z",
            "error": "spawn failed",
            "failureKind": "process_start_failed",
            "serverRequestId": "req-7",
        })
    );
}

/// 带 `oauth` 的服务器不进连接集合：直接给 `oauth_authorization_failed`，其余服务器照常连。
#[tokio::test]
async fn oauth_servers_do_not_reach_the_kernel() {
    let (server, seen) = fake(FakeKernel::default());
    let reply = call(
        server,
        json!({
            "workspace": workspace(),
            "mcpServers": [
                {"name": "plain", "type": "http", "url": "https://example.invalid/mcp"},
                {
                    "name": "oauth",
                    "type": "http",
                    "url": "https://example.invalid/oauth",
                    "oauth": {"type": "authorization_code", "scope": "read"},
                },
            ],
        }),
    )
    .await;
    let requests = seen.lock().unwrap();
    let servers = requests[0].servers.as_ref().expect("explicit list");
    assert_eq!(servers.len(), 1, "oauth 服务器不进连接集合");
    assert_eq!(servers[0].name, "plain");
    drop(requests);

    let statuses = reply["statuses"].as_object().expect("statuses");
    assert_eq!(statuses["oauth"]["status"], "failed");
    assert_eq!(
        statuses["oauth"]["failureKind"],
        "oauth_authorization_failed"
    );
    assert!(
        statuses["oauth"]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("OAuth")
    );
}

/// 参数按 Host 的 zod 拒绝：未知键、坏枚举、缺字段、非正数都是 `-32602`。
#[tokio::test]
async fn bad_parameters_are_rejected_like_zod() {
    let (server, _seen) = fake(FakeKernel::default());
    for params in [
        json!({"workspace": workspace(), "extra": 1}),
        json!({"workspace": workspace(), "mode": "replace"}),
        json!({"workspace": {"workspacePath": ""}}),
        json!({"workspace": workspace(), "mcpServers": [
            {"name": "files", "type": "grpc", "url": "x"}
        ]}),
        json!({"workspace": workspace(), "mcpServers": [{"name": "files"}]}),
        json!({"workspace": workspace(), "mcpServers": [
            {"name": "files", "command": "node", "env": [{"name": "", "value": "x"}]}
        ]}),
        json!({"workspace": workspace(), "mcpServers": [
            {"name": "files", "command": "node", "timeoutMs": 0}
        ]}),
        json!({"workspace": workspace(), "mcpServers": [
            {"name": "files", "command": "node", "protocolVersion": "2"}
        ]}),
        json!({"workspace": workspace(), "mcpServers": [
            {"name": "files", "command": "node", "oauth": {"type": "device"}}
        ]}),
    ] {
        let error = call_error(server.clone(), params.clone()).await;
        assert_eq!(error.code, -32602, "{params}: {error:?}");
    }
}

/// HTTP / SSE 的 `headers` 与 `type` 落到对应的传输上。
#[tokio::test]
async fn http_and_sse_servers_keep_their_headers() {
    let (server, seen) = fake(FakeKernel::default());
    call(
        server,
        json!({
            "workspace": workspace(),
            "mcpServers": [
                {
                    "name": "cloud",
                    "type": "http",
                    "url": "https://example.invalid/mcp",
                    "headers": [{"name": "Authorization", "value": "Bearer t"}],
                },
                {"name": "events", "type": "sse", "url": "https://example.invalid/sse"},
            ],
        }),
    )
    .await;
    let requests = seen.lock().unwrap();
    let servers = requests[0].servers.as_ref().expect("explicit list");
    match &servers[0].transport {
        McpTransportConfig::Http { url, headers } => {
            assert_eq!(url, "https://example.invalid/mcp");
            assert_eq!(headers.get("Authorization").map(String::as_str), Some("Bearer t"));
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(servers[1].transport, McpTransportConfig::Sse { .. }));
}

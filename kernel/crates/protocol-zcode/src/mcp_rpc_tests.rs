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
use rust_cli_kernel_api::mcp_ui::{
    McpAppInstance, McpResourceContent, McpResourceDescriptor, McpResourcePage,
    McpResourceTemplate, McpResourceTemplatePage, McpUiAppToolRegistration, McpUiCallToolRequest,
    McpUiCancelCallRequest, McpUiClaimAppToolCallRequest, McpUiInstanceRequest, McpUiListRequest,
    McpUiOpenRequest, McpUiReadRequest, McpUiRegisterAppToolsRequest, McpUiResolveAppToolCallRequest,
    McpUiSubscriptionRequest, McpUiUnregisterAppToolsRequest, tool_not_found_message,
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
    /// MCP Apps 的入参与固定回答。
    ui: Arc<Mutex<Vec<UiCall>>>,
    open: Option<McpAppInstance>,
    contents: Vec<McpResourceContent>,
    resources: McpResourcePage,
    templates: McpResourceTemplatePage,
    fail: Option<KernelError>,
    /// `mcp/uiCallTool` 的固定回答（原样的 `CallToolResult`）。
    call_result: Value,
    /// App-Provided Tools 的固定回答。
    registrations: Vec<McpUiAppToolRegistration>,
    removed: usize,
    accepted: bool,
}

/// 记录到的 MCP Apps 调用（断言协议层的参数映射）。
#[derive(Debug, Clone, PartialEq)]
enum UiCall {
    Open(McpUiOpenRequest),
    Close(McpUiInstanceRequest, bool),
    Validate(McpUiInstanceRequest),
    Read(McpUiReadRequest),
    ReadForUi(McpUiReadRequest),
    List(McpUiListRequest),
    Templates(McpUiListRequest),
    Subscribe(McpUiSubscriptionRequest),
    Unsubscribe(McpUiSubscriptionRequest),
    Call(McpUiCallToolRequest),
    CancelCall(McpUiCancelCallRequest),
    RegisterTools(McpUiRegisterAppToolsRequest),
    UnregisterTools(McpUiUnregisterAppToolsRequest),
    ClaimAppTool(McpUiClaimAppToolCallRequest),
    ResolveAppTool(McpUiResolveAppToolCallRequest),
}

impl FakeKernel {
    fn record(&self, call: UiCall) -> Result<(), KernelError> {
        self.ui.lock().unwrap().push(call);
        match &self.fail {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
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

    async fn mcp_ui_open(
        &self,
        request: McpUiOpenRequest,
    ) -> Result<McpAppInstance, KernelError> {
        self.record(UiCall::Open(request))?;
        Ok(self.open.clone().unwrap_or_else(default_instance))
    }

    async fn mcp_ui_close(
        &self,
        request: McpUiInstanceRequest,
        only_if_idle: bool,
    ) -> Result<bool, KernelError> {
        self.record(UiCall::Close(request, only_if_idle))?;
        Ok(true)
    }

    async fn mcp_ui_validate(
        &self,
        request: McpUiInstanceRequest,
    ) -> Result<(), KernelError> {
        self.record(UiCall::Validate(request))
    }

    async fn mcp_ui_read_resource(
        &self,
        request: McpUiReadRequest,
    ) -> Result<Vec<McpResourceContent>, KernelError> {
        self.record(UiCall::Read(request))?;
        Ok(self.contents.clone())
    }

    async fn mcp_ui_read_resource_for_ui(
        &self,
        request: McpUiReadRequest,
    ) -> Result<Vec<McpResourceContent>, KernelError> {
        self.record(UiCall::ReadForUi(request))?;
        Ok(self.contents.clone())
    }

    async fn mcp_ui_list_resources(
        &self,
        request: McpUiListRequest,
    ) -> Result<McpResourcePage, KernelError> {
        self.record(UiCall::List(request))?;
        Ok(self.resources.clone())
    }

    async fn mcp_ui_list_resource_templates(
        &self,
        request: McpUiListRequest,
    ) -> Result<McpResourceTemplatePage, KernelError> {
        self.record(UiCall::Templates(request))?;
        Ok(self.templates.clone())
    }

    async fn mcp_ui_subscribe(
        &self,
        request: McpUiSubscriptionRequest,
    ) -> Result<(), KernelError> {
        self.record(UiCall::Subscribe(request))
    }

    async fn mcp_ui_unsubscribe(
        &self,
        request: McpUiSubscriptionRequest,
    ) -> Result<(), KernelError> {
        self.record(UiCall::Unsubscribe(request))
    }

    async fn mcp_ui_call_tool(&self, request: McpUiCallToolRequest) -> Result<Value, KernelError> {
        self.record(UiCall::Call(request))?;
        Ok(self.call_result.clone())
    }

    async fn mcp_ui_cancel_call(
        &self,
        request: McpUiCancelCallRequest,
    ) -> Result<bool, KernelError> {
        self.record(UiCall::CancelCall(request))?;
        Ok(true)
    }

    async fn mcp_ui_register_app_tools(
        &self,
        request: McpUiRegisterAppToolsRequest,
    ) -> Result<Vec<McpUiAppToolRegistration>, KernelError> {
        self.record(UiCall::RegisterTools(request))?;
        Ok(self.registrations.clone())
    }

    async fn mcp_ui_unregister_app_tools(
        &self,
        request: McpUiUnregisterAppToolsRequest,
    ) -> Result<usize, KernelError> {
        self.record(UiCall::UnregisterTools(request))?;
        Ok(self.removed)
    }

    async fn mcp_ui_claim_app_tool_call(
        &self,
        request: McpUiClaimAppToolCallRequest,
    ) -> Result<bool, KernelError> {
        self.record(UiCall::ClaimAppTool(request))?;
        Ok(self.accepted)
    }

    async fn mcp_ui_resolve_app_tool_call(
        &self,
        request: McpUiResolveAppToolCallRequest,
    ) -> Result<bool, KernelError> {
        self.record(UiCall::ResolveAppTool(request))?;
        Ok(self.accepted)
    }
}

fn default_instance() -> McpAppInstance {
    McpAppInstance {
        runtime_id: "runtime-1".to_owned(),
        generation: 2,
        app_identity: "a".repeat(64),
        token: "token-1".to_owned(),
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

// ———— MCP Apps（141 审计 §9 第 6 项 F7）————

fn fake_ui(kernel: FakeKernel) -> (Arc<Server>, Arc<Mutex<Vec<UiCall>>>) {
    let ui = kernel.ui.clone();
    (server(Arc::new(kernel)), ui)
}

async fn call_method(server: Arc<Server>, method: &str, params: Value) -> Value {
    Handler(server)
        .request(method, params)
        .await
        .unwrap_or_else(|error| panic!("{method}: {error:?}"))
        .result
}

async fn call_error_named(
    server: Arc<Server>,
    method: &str,
    params: Value,
) -> rust_cli_protocol_core::rpc::RpcError {
    match Handler(server).request(method, params).await {
        Ok(_) => panic!("expected {method} to fail"),
        Err(error) => error,
    }
}

fn instance_json() -> Value {
    json!({
        "runtimeId": "runtime-1",
        "generation": 2,
        "appIdentity": "a".repeat(64),
        "token": "token-1",
    })
}

fn scope_json() -> Value {
    json!({
        "workspace": {"workspacePath": "/w", "workspaceKey": "k"},
        "sessionId": "s1",
        "pluginId": "toolkit",
        "serverName": "plugin:toolkit:panel",
    })
}

fn with_instance(mut params: Value) -> Value {
    params["instance"] = instance_json();
    params
}

/// `mcp/uiOpenInstance`：Host 的字段逐个落到内核请求上，返回实例凭证。
#[tokio::test]
async fn opening_an_instance_maps_the_host_scope() {
    let (server, ui) = fake_ui(FakeKernel::default());
    let reply = call_method(
        server,
        "mcp/uiOpenInstance",
        json!({
            "workspace": {"workspacePath": "/w", "workspaceIdentity": "ident-1", "workspaceKey": "k"},
            "sessionId": "s1",
            "pluginId": "toolkit",
            "serverName": "plugin:toolkit:panel",
            "scopeId": "scope-1",
            "resourceUri": "ui://panel.html",
            "ownerWebContentsId": 42,
            "accountContext": "acct",
        }),
    )
    .await;
    assert_eq!(reply, instance_json());
    let calls = ui.lock().unwrap();
    let UiCall::Open(request) = &calls[0] else {
        panic!("{calls:?}")
    };
    assert_eq!(request.scope.workspace_identity, "ident-1");
    assert_eq!(request.scope.workspace.root.as_str(), "/w");
    assert_eq!(request.scope.session.as_str(), "s1");
    assert_eq!(request.scope.plugin_id, "toolkit");
    assert_eq!(request.scope.server_name, "plugin:toolkit:panel");
    assert_eq!(request.scope_id, "scope-1");
    assert_eq!(request.resource_uri, "ui://panel.html");
    assert_eq!(request.owner_web_contents_id, 42);
    assert_eq!(request.account_context.as_deref(), Some("acct"));
}

/// 不带 `workspaceIdentity` 时实例绑定工作区路径。
#[tokio::test]
async fn the_workspace_identity_falls_back_to_the_path() {
    let (server, ui) = fake_ui(FakeKernel::default());
    call_method(
        server,
        "mcp/uiOpenInstance",
        json!({
            "workspace": {"workspacePath": "/w", "workspaceKey": "k"},
            "sessionId": "s1",
            "pluginId": "toolkit",
            "serverName": "plugin:toolkit:panel",
            "scopeId": "scope-1",
            "resourceUri": "ui://panel.html",
            "ownerWebContentsId": 1,
        }),
    )
    .await;
    let calls = ui.lock().unwrap();
    let UiCall::Open(request) = &calls[0] else {
        panic!("{calls:?}")
    };
    assert_eq!(request.scope.workspace_identity, "/w");
    assert!(request.account_context.is_none());
}

/// 关闭与校验：`onlyIfIdle` 透传，返回形状与 Host 的 schema 一致。
#[tokio::test]
async fn close_and_validate_round_trip() {
    let (server, ui) = fake_ui(FakeKernel::default());
    let mut params = with_instance(scope_json());
    params["onlyIfIdle"] = json!(true);
    let reply = call_method(server.clone(), "mcp/uiCloseInstance", params).await;
    assert_eq!(reply, json!({"closed": true}));
    let reply = call_method(server, "mcp/uiValidateInstance", with_instance(scope_json())).await;
    assert_eq!(reply, json!({}));
    let calls = ui.lock().unwrap();
    assert!(matches!(&calls[0], UiCall::Close(_, true)));
    assert!(matches!(&calls[1], UiCall::Validate(_)));
}

fn contents() -> Vec<McpResourceContent> {
    vec![McpResourceContent {
        uri: "ui://panel.html".to_owned(),
        mime_type: Some("text/html".to_owned()),
        text: Some("<html></html>".to_owned()),
        blob: None,
        meta: Some(serde_json::Map::from_iter([(
            "ui".to_owned(),
            json!({"prefersBorder": true}),
        )])),
    }]
}

/// `mcp/readResource` 给宿主 `_meta`（宿主据此拿 csp）；`mcp/uiReadResource` 去掉它。
#[tokio::test]
async fn host_reads_keep_meta_and_page_reads_drop_it() {
    let kernel = FakeKernel {
        contents: contents(),
        ..FakeKernel::default()
    };
    let (server, _ui) = fake_ui(kernel);
    let mut params = with_instance(scope_json());
    params["uri"] = json!("ui://panel.html");
    let reply = call_method(server.clone(), "mcp/readResource", params.clone()).await;
    assert_eq!(
        reply,
        json!({"contents": [{
            "uri": "ui://panel.html",
            "mimeType": "text/html",
            "text": "<html></html>",
            "_meta": {"ui": {"prefersBorder": true}},
        }]})
    );
    let reply = call_method(server, "mcp/uiReadResource", params).await;
    assert_eq!(
        reply,
        json!({"contents": [{
            "uri": "ui://panel.html",
            "mimeType": "text/html",
            "text": "<html></html>",
        }]})
    );
}

/// 页面的读取界：MIME 白名单、blob 必须带 MIME、总量 8 MiB；超限不截断。
#[tokio::test]
async fn page_reads_are_bounded() {
    let cases = [
        (
            McpResourceContent {
                uri: "ui://x".to_owned(),
                mime_type: Some("image/jxl".to_owned()),
                text: Some("x".to_owned()),
                blob: None,
                meta: None,
            },
            "not allowed",
        ),
        (
            McpResourceContent {
                uri: "ui://x".to_owned(),
                mime_type: None,
                text: None,
                blob: Some("AAAA".to_owned()),
                meta: None,
            },
            "without a mimeType",
        ),
    ];
    for (content, message) in cases {
        let kernel = FakeKernel {
            contents: vec![content],
            ..FakeKernel::default()
        };
        let (server, _ui) = fake_ui(kernel);
        let mut params = with_instance(scope_json());
        params["uri"] = json!("ui://x");
        let error = call_error_named(server, "mcp/uiReadResource", params).await;
        assert_eq!(error.code, -32001);
        assert!(error.message.contains(message), "{}", error.message);
    }

    let kernel = FakeKernel {
        contents: vec![McpResourceContent {
            uri: "ui://big".to_owned(),
            mime_type: Some("text/plain".to_owned()),
            text: Some("x".repeat(rust_cli_kernel_api::mcp_ui::UI_READ_MAX_BYTES + 1)),
            blob: None,
            meta: None,
        }],
        ..FakeKernel::default()
    };
    let (server, _ui) = fake_ui(kernel);
    let mut params = with_instance(scope_json());
    params["uri"] = json!("ui://big");
    let error = call_error_named(server, "mcp/uiReadResource", params).await;
    assert_eq!(error.code, -32001);
    assert!(error.message.contains("byte limit"), "{}", error.message);
}

/// 资源列表与模板：描述符带 `_meta`，`nextCursor` 只在有下一页时写。
#[tokio::test]
async fn resource_pages_keep_descriptors_and_cursors() {
    let kernel = FakeKernel {
        resources: McpResourcePage {
            resources: vec![McpResourceDescriptor {
                uri: "ui://panel.html".to_owned(),
                name: Some("panel".to_owned()),
                title: None,
                description: None,
                mime_type: Some("text/html".to_owned()),
                meta: Some(serde_json::Map::from_iter([(
                    "ui".to_owned(),
                    json!({"prefersBorder": true}),
                )])),
            }],
            next_cursor: Some("page-2".to_owned()),
        },
        templates: McpResourceTemplatePage {
            resource_templates: vec![McpResourceTemplate {
                uri_template: "file:///{path}".to_owned(),
                name: None,
                title: Some("file".to_owned()),
                description: None,
                mime_type: None,
            }],
            next_cursor: None,
        },
        ..FakeKernel::default()
    };
    let (server, ui) = fake_ui(kernel);
    let mut params = with_instance(scope_json());
    params["cursor"] = json!("page-1");
    let reply = call_method(server.clone(), "mcp/uiListResources", params).await;
    assert_eq!(
        reply,
        json!({
            "resources": [{
                "uri": "ui://panel.html",
                "name": "panel",
                "mimeType": "text/html",
                "_meta": {"ui": {"prefersBorder": true}},
            }],
            "nextCursor": "page-2",
        })
    );
    let reply = call_method(
        server,
        "mcp/uiListResourceTemplates",
        with_instance(scope_json()),
    )
    .await;
    assert_eq!(
        reply,
        json!({"resourceTemplates": [{"uriTemplate": "file:///{path}", "title": "file"}]})
    );
    let calls = ui.lock().unwrap();
    assert!(matches!(&calls[0], UiCall::List(request) if request.cursor.as_deref() == Some("page-1")));
    assert!(matches!(&calls[1], UiCall::Templates(_)));
}

/// 参数按 Host 的 zod 拒绝：坏凭证、坏作用域、未知键。
#[tokio::test]
async fn app_parameters_are_rejected_like_zod() {
    let (server, _ui) = fake_ui(FakeKernel::default());
    let mut bad_identity = with_instance(scope_json());
    bad_identity["instance"]["appIdentity"] = json!("A".repeat(64));
    let mut zero_generation = with_instance(scope_json());
    zero_generation["instance"]["generation"] = json!(0);
    let mut unknown = with_instance(scope_json());
    unknown["extra"] = json!(1);
    let mut missing_uri = with_instance(scope_json());
    missing_uri["uri"] = json!("");
    for (method, params) in [
        (
            "mcp/uiOpenInstance",
            json!({
                "workspace": {"workspacePath": "/w", "workspaceKey": "k"},
                "sessionId": "s1", "pluginId": "p", "serverName": "s",
                "scopeId": "scope", "resourceUri": "ui://x", "ownerWebContentsId": 0,
            }),
        ),
        (
            "mcp/uiOpenInstance",
            json!({
                "workspace": {"workspacePath": "/w", "workspaceKey": "k"},
                "sessionId": "s1", "pluginId": "p", "serverName": "s",
                "scopeId": "scope", "resourceUri": "ui://x", "ownerWebContentsId": 1,
                "extra": 1,
            }),
        ),
        ("mcp/uiCloseInstance", bad_identity),
        ("mcp/uiValidateInstance", zero_generation),
        ("mcp/readResource", unknown),
        ("mcp/uiReadResource", missing_uri),
        ("mcp/uiListResources", with_instance(json!({"sessionId": "s1"}))),
    ] {
        let error = call_error_named(server.clone(), method, params.clone()).await;
        assert_eq!(error.code, -32602, "{method} {params}: {error:?}");
    }
}

/// 订阅与退订：作用域、代际与 URI 原样到内核，回执是空对象。
#[tokio::test]
async fn subscriptions_map_the_subscriber_identity() {
    let (server, ui) = fake_ui(FakeKernel::default());
    let mut params = with_instance(scope_json());
    params["scopeId"] = json!("token-1");
    params["generation"] = json!(2);
    params["uri"] = json!("ui://panel.html");
    let reply = call_method(server.clone(), "mcp/uiSubscribeResource", params.clone()).await;
    assert_eq!(reply, json!({}));
    let reply = call_method(server, "mcp/uiUnsubscribeResource", params).await;
    assert_eq!(reply, json!({}));
    let calls = ui.lock().unwrap();
    let UiCall::Subscribe(request) = &calls[0] else {
        panic!("{calls:?}")
    };
    assert_eq!(request.scope_id, "token-1");
    assert_eq!(request.generation, 2);
    assert_eq!(request.uri, "ui://panel.html");
    assert_eq!(request.instance.instance.token, "token-1");
    assert!(matches!(&calls[1], UiCall::Unsubscribe(_)));
}

/// `mcp/uiCallTool`：参数逐项落到内核请求（`arguments` 缺省是 `{}`），结果只留 Host 的四个键。
#[tokio::test]
async fn calling_a_tool_maps_the_arguments_and_keeps_the_host_result_shape() {
    let kernel = FakeKernel {
        call_result: json!({
            "content": [{"type": "text", "text": "ok"}],
            "structuredContent": {"n": 1},
            "isError": false,
            "_meta": {"trace": "t"},
            "unexpected": true,
        }),
        ..FakeKernel::default()
    };
    let (server, ui) = fake_ui(kernel);
    let mut params = with_instance(scope_json());
    params["toolName"] = json!("echo");
    params["callId"] = json!("call-1");
    let reply = call_method(server.clone(), "mcp/uiCallTool", params.clone()).await;
    assert_eq!(
        reply,
        json!({
            "content": [{"type": "text", "text": "ok"}],
            "structuredContent": {"n": 1},
            "isError": false,
            "_meta": {"trace": "t"},
        })
    );
    {
        let calls = ui.lock().unwrap();
        let UiCall::Call(request) = &calls[0] else {
            panic!("{calls:?}")
        };
        assert_eq!(request.tool_name, "echo");
        assert_eq!(request.call_id, "call-1");
        assert!(request.arguments.is_empty());
        assert_eq!(request.instance.scope.session.as_str(), "s1");
    }

    // `arguments` 是对象时原样交给内核；不是对象按 -32602 拒绝。
    params["arguments"] = json!({"text": "hi"});
    call_method(server.clone(), "mcp/uiCallTool", params.clone()).await;
    {
        let calls = ui.lock().unwrap();
        let UiCall::Call(request) = &calls[1] else {
            panic!("{calls:?}")
        };
        assert_eq!(request.arguments.get("text"), Some(&json!("hi")));
    }
    params["arguments"] = json!("not-an-object");
    let error = call_error_named(server, "mcp/uiCallTool", params).await;
    assert_eq!(error.code, -32602, "{error:?}");
}

/// 工具不存在与只给模型用是 -32602 的两种结构化原因（Node `McpUiToolAccessError`）。
#[tokio::test]
async fn tool_access_failures_are_invalid_params_with_a_reason() {
    let server_name = "plugin:toolkit:panel";
    for (message, reason) in [
        (tool_not_found_message(server_name, "missing"), "tool_not_found"),
        (
            rust_cli_kernel_api::mcp_ui::tool_not_app_visible_message(server_name, "secret"),
            "tool_not_app_visible",
        ),
    ] {
        let kernel = FakeKernel {
            fail: Some(KernelError::Failed {
                message: message.clone(),
            }),
            ..FakeKernel::default()
        };
        let (server, _ui) = fake_ui(kernel);
        let mut params = with_instance(scope_json());
        params["toolName"] = json!(if reason == "tool_not_found" { "missing" } else { "secret" });
        params["callId"] = json!("call-1");
        let error = call_error_named(server, "mcp/uiCallTool", params).await;
        assert_eq!(error.code, -32602, "{error:?}");
        assert_eq!(error.message, message);
        let data = error.data.clone().expect("structured reason");
        assert_eq!(data["reason"], json!(reason));
        assert_eq!(data["serverName"], json!(server_name));
    }
}

/// `mcp/uiCancelCall`：作用域与 `callId` 原样到内核，回执是 `{cancelled}`。
#[tokio::test]
async fn cancelling_a_call_returns_the_host_shape() {
    let (server, ui) = fake_ui(FakeKernel::default());
    let mut params = with_instance(scope_json());
    params["callId"] = json!("call-1");
    let reply = call_method(server, "mcp/uiCancelCall", params).await;
    assert_eq!(reply, json!({"cancelled": true}));
    let calls = ui.lock().unwrap();
    let UiCall::CancelCall(request) = &calls[0] else {
        panic!("{calls:?}")
    };
    assert_eq!(request.call_id, "call-1");
    assert_eq!(request.instance.scope.session.as_str(), "s1");
}

// ———— App-Provided Tools（mcp/ui*AppTools*）————

fn app_tool_params() -> Value {
    let mut params = with_instance(scope_json());
    params["scopeId"] = json!("token-1");
    params["generation"] = json!(2);
    params
}

/// `mcp/uiRegisterAppTools`：工具描述符逐项落到内核请求，回执是 `{tools:[{name,modelName}]}`。
#[tokio::test]
async fn registering_app_tools_maps_descriptors_and_returns_model_names() {
    let kernel = FakeKernel {
        registrations: vec![McpUiAppToolRegistration {
            name: "echo".to_owned(),
            model_name: "app__plugin_toolkit_panel__echo".to_owned(),
        }],
        ..FakeKernel::default()
    };
    let (server, ui) = fake_ui(kernel);
    let mut params = app_tool_params();
    params["tools"] = json!([{
        "name": "echo",
        "title": "Echo",
        "description": "echoes",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
        "annotations": {"readOnlyHint": true, "openWorldHint": false},
    }]);
    let reply = call_method(server, "mcp/uiRegisterAppTools", params).await;
    assert_eq!(
        reply,
        json!({"tools": [{"name": "echo", "modelName": "app__plugin_toolkit_panel__echo"}]})
    );
    let calls = ui.lock().unwrap();
    let UiCall::RegisterTools(request) = &calls[0] else {
        panic!("{calls:?}")
    };
    assert_eq!(request.scope_id, "token-1");
    assert_eq!(request.generation, 2);
    assert_eq!(request.instance.scope.session.as_str(), "s1");
    assert_eq!(request.tools.len(), 1);
    assert_eq!(request.tools[0].name, "echo");
    assert_eq!(request.tools[0].title.as_deref(), Some("Echo"));
    let annotations = request.tools[0].annotations.as_ref().expect("annotations");
    assert_eq!(annotations.read_only_hint, Some(true));
    assert_eq!(annotations.open_world_hint, Some(false));
}

/// 描述符按 Node 的 strict schema 校验：未知键、非对象 schema、超限数量与错误类型都是 -32602。
#[tokio::test]
async fn app_tool_descriptors_are_validated_like_zod() {
    let (server, _ui) = fake_ui(FakeKernel::default());
    let too_long = "x".repeat(129);
    let too_many: Vec<Value> = (0..51)
        .map(|index| json!({"name": format!("t{index}"), "inputSchema": {"type": "object"}}))
        .collect();
    let cases = [
        json!([{"name": "a", "inputSchema": {"type": "object"}, "extra": 1}]),
        json!([{"name": "a", "inputSchema": {"type": "array"}}]),
        json!([{"name": too_long, "inputSchema": {"type": "object"}}]),
        json!(too_many),
        json!([{"name": "a", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": "yes"}}]),
        json!([{"name": "a", "inputSchema": {"type": "object"}, "annotations": {"extra": true}}]),
        json!("not-an-array"),
    ];
    for (index, tools) in cases.into_iter().enumerate() {
        let mut params = app_tool_params();
        params["tools"] = tools;
        let error = call_error_named(server.clone(), "mcp/uiRegisterAppTools", params).await;
        assert_eq!(error.code, -32602, "case {index}: {error:?}");
    }
    // 未知的顶层键。
    let mut params = app_tool_params();
    params["tools"] = json!([]);
    params["extra"] = json!(1);
    let error = call_error_named(server, "mcp/uiRegisterAppTools", params).await;
    assert_eq!(error.code, -32602, "{error:?}");
}

/// `mcp/uiUnregisterAppTools` / `mcp/uiClaimAppToolCall` / `mcp/uiResolveAppToolCall` 的形状。
#[tokio::test]
async fn app_tool_claim_and_resolve_round_trip() {
    let kernel = FakeKernel {
        removed: 2,
        accepted: true,
        ..FakeKernel::default()
    };
    let (server, ui) = fake_ui(kernel);
    let reply = call_method(
        server.clone(),
        "mcp/uiUnregisterAppTools",
        app_tool_params(),
    )
    .await;
    assert_eq!(reply, json!({"removed": 2}));

    let mut claim = app_tool_params();
    claim["callId"] = json!("call-1");
    let reply = call_method(server.clone(), "mcp/uiClaimAppToolCall", claim).await;
    assert_eq!(reply, json!({"accepted": true}));

    let mut resolve = app_tool_params();
    resolve["callId"] = json!("call-1");
    resolve["result"] = json!({"content": [{"type": "text", "text": "ok"}], "isError": false});
    let reply = call_method(server.clone(), "mcp/uiResolveAppToolCall", resolve).await;
    assert_eq!(reply, json!({"accepted": true}));

    let calls = ui.lock().unwrap();
    assert!(matches!(&calls[0], UiCall::UnregisterTools(_)));
    let UiCall::ClaimAppTool(claim) = &calls[1] else {
        panic!("{calls:?}")
    };
    assert_eq!(claim.call_id, "call-1");
    let UiCall::ResolveAppTool(resolve) = &calls[2] else {
        panic!("{calls:?}")
    };
    assert_eq!(resolve.call_id, "call-1");
    assert_eq!(
        resolve.result.as_ref().unwrap()["content"][0]["text"],
        json!("ok")
    );
    assert!(resolve.error.is_none());
}

/// `resolve` 必须恰好给 `result` 或 `error` 之一；`error` 是 `{message}`。
#[tokio::test]
async fn resolving_requires_exactly_one_outcome() {
    let (server, _ui) = fake_ui(FakeKernel::default());
    let mut both = app_tool_params();
    both["callId"] = json!("call-1");
    both["result"] = json!({"content": []});
    both["error"] = json!({"message": "nope"});
    let mut neither = app_tool_params();
    neither["callId"] = json!("call-1");
    let mut bad_error = app_tool_params();
    bad_error["callId"] = json!("call-1");
    bad_error["error"] = json!({"message": "x", "extra": 1});
    for params in [both, neither, bad_error] {
        let error = call_error_named(server.clone(), "mcp/uiResolveAppToolCall", params).await;
        assert_eq!(error.code, -32602, "{error:?}");
    }
}

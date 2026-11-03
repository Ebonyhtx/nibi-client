//! `mcp/list`（Host `zcodeMcpListParamsSchema`，141 审计 §9 第 6 项 F7 的第一条）。
//!
//! 参数是 `{workspace, mcpServers?, mode}`：`mode` 缺省是 `connect`（收敛连接集合并等连接落定），
//! `status` 只读快照。结果是 `{statuses: Record<服务器名, 快照>}`，快照的字段与 Host 的
//! `zcodeMcpServerStatusSnapshotSchema` 一一对应。
//!
//! 两条如实说明：
//!
//! - **OAuth**：内核不实现授权流。带 `oauth` 的服务器不进连接集合，直接给
//!   `failureKind: "oauth_authorization_failed"` 的失败快照（其余服务器照常连）。不假装在授权，
//!   也不让一条 OAuth 服务器拖垮整个设置页。
//! - **protocolVersion**：Host 的 `legacy` / `auto` / `2026-07-28` 被接受，但内核的客户端固定说
//!   `2025-06-18`（`ext::mcp::connection::PROTOCOL_VERSION`）：要 `2026-07-28` 的服务器会在握手时
//!   失败，按 `protocol_negotiation_failed` 报出来，而不是静默换成别的版本。

use rust_cli_base::js::iso_timestamp;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};
use rust_cli_kernel_api::mcp_status::{McpListRequest, McpServerStatus};
use rust_cli_kernel_api::mcp_ui::{
    McpAppInstance, McpResourceContent, McpResourceDescriptor, McpResourceTemplate,
    McpUiInstanceRequest, McpUiListRequest, McpUiOpenRequest, McpUiReadRequest, McpUiScope,
    UI_READ_MAX_BYTES, decoded_base64_len, mime_allowed_for_ui,
};
use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Map, Value, json};

use crate::server::{Server, kernel_error};

/// `mcp/list` 的处理器。
pub(crate) async fn list(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &["workspace", "mcpServers", "mode"],
        "mcp/list params",
    )?;
    let (workspace_path, _) = workspace_param(params.get("workspace"))?;
    let workspace = server.workspace(&workspace_path);
    let connect = match params.get("mode").and_then(Value::as_str) {
        None | Some("connect") => true,
        Some("status") => false,
        Some(other) => {
            return Err(invalid(format!(
                "`mode` must be \"connect\" or \"status\", got {other:?}"
            )));
        }
    };
    let mut servers = Vec::new();
    let mut oauth = Vec::new();
    if let Some(list) = params.get("mcpServers") {
        let list = list
            .as_array()
            .ok_or_else(|| invalid("`mcpServers` must be an array"))?;
        for entry in list {
            let (converted, needs_oauth) = server_param(entry)?;
            if needs_oauth {
                oauth.push(converted);
            } else {
                servers.push(converted);
            }
        }
    }
    let explicit = params.contains_key("mcpServers");
    let request = McpListRequest {
        workspace,
        servers: explicit.then_some(servers),
        connect,
    };
    let mut statuses = server
        .kernel
        .mcp_list(request)
        .await
        .map_err(|error| kernel_error(&error))?;
    // OAuth 的服务器不进连接集合：这里给失败快照（不是「没有事实」）。
    let now = server.context.clock.now_ms();
    for server in &oauth {
        let transport = server.transport.kind();
        statuses.push(McpServerStatus::oauth_unsupported(
            &server.name,
            transport,
            now,
        ));
    }
    let mut record = Map::new();
    for status in &statuses {
        record.insert(status.name.clone(), snapshot(status));
    }
    Ok(json!({"statuses": record}))
}

/// 内核侧的快照 → Host 的 JSON（`updatedAt` / `startedAt` 是 ISO；可选字段缺席不写）。
fn snapshot(status: &McpServerStatus) -> Value {
    let mut value = json!({
        "status": status.status,
        "transport": status.transport,
        "toolCount": status.tool_count,
        "updatedAt": iso_timestamp(status.updated_at_ms),
    });
    if let Some(error) = &status.error {
        value["error"] = json!(error);
    }
    if let Some(kind) = status.failure_kind
        && let Ok(text) = serde_json::to_value(kind)
    {
        value["failureKind"] = text;
    }
    if let Some(id) = &status.server_request_id {
        value["serverRequestId"] = json!(id);
    }
    if let Some(era) = status.protocol_era
        && let Ok(text) = serde_json::to_value(era)
    {
        value["protocolEra"] = text;
    }
    if let Some(authorization) = &status.authorization {
        value["authorization"] = json!({
            "type": "oauth_authorization_code",
            "authorizationUrl": authorization.authorization_url,
            "startedAt": iso_timestamp(authorization.started_at_ms),
        });
    }
    value
}

// ———— MCP Apps（mcp/ui*，141 审计 §9 第 6 项 F7）————

/// `mcp/uiOpenInstance`：为页面开一个实例凭证。
pub(crate) async fn open_instance(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "accountContext",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "scopeId",
            "resourceUri",
            "ownerWebContentsId",
        ],
        "mcp/uiOpenInstance params",
    )?;
    let scope = scope_param(params, server)?;
    let request = McpUiOpenRequest {
        scope,
        scope_id: bounded_string(params, "scopeId", 4096)?,
        resource_uri: bounded_string(params, "resourceUri", 2048)?,
        owner_web_contents_id: params
            .get("ownerWebContentsId")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0)
            .ok_or_else(|| invalid("`ownerWebContentsId` must be a positive integer"))?,
        account_context: optional_bounded_string(params, "accountContext", 256)?,
    };
    let instance = server
        .kernel
        .mcp_ui_open(request)
        .await
        .map_err(|error| ui_error(&error))?;
    serde_json::to_value(&instance).map_err(|error| RpcError::internal(error.to_string()))
}

/// `mcp/uiValidateInstance`：凭证、作用域与当前连接三者都对上才算有效。
pub(crate) async fn validate_instance(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    // Host 用 close 的 schema 校验这一条（`onlyIfIdle` 可带，这里不看）。
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "onlyIfIdle",
        ],
        "mcp/uiValidateInstance params",
    )?;
    let request = instance_request(params, server)?;
    server
        .kernel
        .mcp_ui_validate(request)
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({}))
}

/// `mcp/uiCloseInstance`：`onlyIfIdle` 时只关没有进行中调用的实例；未知凭证按幂等处理。
pub(crate) async fn close_instance(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "onlyIfIdle",
        ],
        "mcp/uiCloseInstance params",
    )?;
    let request = instance_request(params, server)?;
    let only_if_idle = optional_bool(params, "onlyIfIdle")?.unwrap_or(false);
    let closed = server
        .kernel
        .mcp_ui_close(request, only_if_idle)
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({"closed": closed}))
}

/// `mcp/readResource`：宿主取页面的 `ui://` HTML（`_meta` 原样给宿主，界面据此拿 csp）。
pub(crate) async fn read_resource(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "uri",
        ],
        "mcp/readResource params",
    )?;
    let request = read_request(params, server)?;
    let contents = server
        .kernel
        .mcp_ui_read_resource(request)
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({"contents": contents.iter().map(|content| content_json(content, true)).collect::<Vec<_>>()}))
}

/// `mcp/uiReadResource`：页面发起的资源读取。去掉 `_meta`，并按 8 MiB 与 MIME 白名单判界
/// （超限不截断——半个 GLB / 图片没有意义）。
pub(crate) async fn read_resource_for_ui(
    server: &Server,
    params: &Value,
) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "uri",
        ],
        "mcp/uiReadResource params",
    )?;
    let request = read_request(params, server)?;
    let uri = request.uri.clone();
    let contents = server
        .kernel
        .mcp_ui_read_resource_for_ui(request)
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({"contents": bound_ui_contents(&uri, &contents)?}))
}

/// `mcp/uiListResources`：页面发起的 `resources/list`（一页）。
pub(crate) async fn list_resources(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "cursor",
        ],
        "mcp/uiListResources params",
    )?;
    let request = list_request(params, server)?;
    let page = server
        .kernel
        .mcp_ui_list_resources(request)
        .await
        .map_err(|error| ui_error(&error))?;
    let mut value = json!({
        "resources": page
            .resources
            .iter()
            .map(resource_descriptor_json)
            .collect::<Vec<_>>(),
    });
    if let Some(cursor) = page.next_cursor {
        value["nextCursor"] = json!(cursor);
    }
    Ok(value)
}

/// `mcp/uiListResourceTemplates`：页面发起的 `resources/templates/list`（一页）。
pub(crate) async fn list_resource_templates(
    server: &Server,
    params: &Value,
) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "cursor",
        ],
        "mcp/uiListResourceTemplates params",
    )?;
    let request = list_request(params, server)?;
    let page = server
        .kernel
        .mcp_ui_list_resource_templates(request)
        .await
        .map_err(|error| ui_error(&error))?;
    let mut value = json!({
        "resourceTemplates": page
            .resource_templates
            .iter()
            .map(resource_template_json)
            .collect::<Vec<_>>(),
    });
    if let Some(cursor) = page.next_cursor {
        value["nextCursor"] = json!(cursor);
    }
    Ok(value)
}

/// 页面请求的作用域：会话 + 会话自己的 MCP server 表（`pluginId` 只做展示与日志）。
fn scope_param(params: &Map<String, Value>, server: &Server) -> Result<McpUiScope, RpcError> {
    let (workspace_path, identity) = workspace_param(params.get("workspace"))?;
    Ok(McpUiScope {
        workspace: server.workspace(&workspace_path),
        workspace_identity: identity.unwrap_or_else(|| workspace_path.clone()),
        session: SessionId::new(required_string(params, "sessionId")?),
        plugin_id: required_string(params, "pluginId")?,
        server_name: required_string(params, "serverName")?,
    })
}

fn instance_request(
    params: &Map<String, Value>,
    server: &Server,
) -> Result<McpUiInstanceRequest, RpcError> {
    Ok(McpUiInstanceRequest {
        scope: scope_param(params, server)?,
        instance: instance_param(params.get("instance"))?,
    })
}

fn read_request(
    params: &Map<String, Value>,
    server: &Server,
) -> Result<McpUiReadRequest, RpcError> {
    Ok(McpUiReadRequest {
        instance: instance_request(params, server)?,
        uri: bounded_string(params, "uri", 2048)?,
    })
}

fn list_request(
    params: &Map<String, Value>,
    server: &Server,
) -> Result<McpUiListRequest, RpcError> {
    Ok(McpUiListRequest {
        instance: instance_request(params, server)?,
        cursor: optional_bounded_string(params, "cursor", 2048)?,
    })
}

/// Host 的 `mcpAppInstanceSchema`：四个字段逐字回来；`appIdentity` 是 64 位小写十六进制。
fn instance_param(value: Option<&Value>) -> Result<McpAppInstance, RpcError> {
    let value = value
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("`instance` must be an object"))?;
    strict_keys(
        value,
        &["runtimeId", "generation", "appIdentity", "token"],
        "instance",
    )?;
    let app_identity = required_string(value, "appIdentity")?;
    if app_identity.len() != 64
        || !app_identity
            .chars()
            .all(|character| matches!(character, '0'..='9' | 'a'..='f'))
    {
        return Err(invalid("`appIdentity` must be 64 lowercase hex characters"));
    }
    Ok(McpAppInstance {
        runtime_id: required_string(value, "runtimeId")?,
        generation: value
            .get("generation")
            .and_then(Value::as_u64)
            .filter(|generation| *generation > 0)
            .ok_or_else(|| invalid("`generation` must be a positive integer"))?,
        app_identity,
        token: required_string(value, "token")?,
    })
}

fn bounded_string(
    params: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<String, RpcError> {
    let value = required_string(params, key)?;
    if value.chars().count() > max {
        return Err(invalid(format!("`{key}` must be at most {max} characters")));
    }
    Ok(value)
}

fn optional_bounded_string(
    params: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<Option<String>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => bounded_string(params, key, max).map(Some),
    }
}

/// 一项资源内容：Host 的 `_meta` 键名与内核的 `meta` 不同，单独写。
fn content_json(content: &McpResourceContent, include_meta: bool) -> Value {
    let mut value = json!({"uri": content.uri});
    if let Some(mime) = &content.mime_type {
        value["mimeType"] = json!(mime);
    }
    if let Some(text) = &content.text {
        value["text"] = json!(text);
    }
    if let Some(blob) = &content.blob {
        value["blob"] = json!(blob);
    }
    if include_meta && let Some(meta) = &content.meta {
        value["_meta"] = Value::Object(meta.clone());
    }
    value
}

fn resource_descriptor_json(descriptor: &McpResourceDescriptor) -> Value {
    let mut value = json!({"uri": descriptor.uri});
    for (key, field) in [
        ("name", &descriptor.name),
        ("title", &descriptor.title),
        ("description", &descriptor.description),
        ("mimeType", &descriptor.mime_type),
    ] {
        if let Some(text) = field {
            value[key] = json!(text);
        }
    }
    if let Some(meta) = &descriptor.meta {
        value["_meta"] = Value::Object(meta.clone());
    }
    value
}

fn resource_template_json(template: &McpResourceTemplate) -> Value {
    let mut value = json!({"uriTemplate": template.uri_template});
    for (key, field) in [
        ("name", &template.name),
        ("title", &template.title),
        ("description", &template.description),
        ("mimeType", &template.mime_type),
    ] {
        if let Some(text) = field {
            value[key] = json!(text);
        }
    }
    value
}

/// 页面的读取界：MIME 白名单、blob 必须带 MIME、总量 8 MiB；去掉 `_meta`。
fn bound_ui_contents(
    uri: &str,
    contents: &[McpResourceContent],
) -> Result<Vec<Value>, RpcError> {
    let mut bytes = 0usize;
    let mut bounded = Vec::new();
    for content in contents {
        let rejected = |reason: String| RpcError::new(-32001, reason);
        if let Some(mime) = &content.mime_type
            && !mime_allowed_for_ui(mime)
        {
            return Err(rejected(format!(
                "MCP resource \"{}\" has mimeType \"{mime}\" which is not allowed for plugin UI reads",
                content.uri
            )));
        }
        if content.blob.is_some() && content.mime_type.is_none() {
            return Err(rejected(format!(
                "MCP resource \"{}\" has binary content without a mimeType",
                content.uri
            )));
        }
        if let Some(text) = &content.text {
            bytes += text.len();
        }
        if let Some(blob) = &content.blob {
            bytes += decoded_base64_len(blob);
        }
        if bytes > UI_READ_MAX_BYTES {
            return Err(rejected(format!(
                "MCP resource \"{uri}\" is {bytes} bytes, exceeding the {UI_READ_MAX_BYTES} byte limit for plugin UI reads"
            )));
        }
        bounded.push(content_json(content, false));
    }
    Ok(bounded)
}

/// MCP Apps 的内核错误 → RPC 错误码：不可用 -32001、绑定不符 -32602、其余按内部错误（与 Node 的
/// `ProtocolRequestError` 同一组码；Host 只看消息）。
fn ui_error(error: &KernelError) -> RpcError {
    match error {
        KernelError::NotFound { session } => RpcError::new(
            crate::server::SESSION_UNAVAILABLE,
            format!("Session unavailable: {}", session.as_str()),
        ),
        KernelError::Unsupported { what } => {
            RpcError::new(-32001, format!("MCP App request is not supported: {what}"))
        }
        KernelError::Failed { message } if message == APP_UNAVAILABLE => {
            RpcError::new(-32001, message.clone())
        }
        KernelError::Failed { message } if message == BINDING_MISMATCH => {
            RpcError::new(-32602, message.clone())
        }
        KernelError::Failed { message } => RpcError::internal(message.clone()),
    }
}

const APP_UNAVAILABLE: &str = "MCP App connection is unavailable";
const BINDING_MISMATCH: &str = "MCP App resource binding mismatch";

// ———— 参数校验（Host zod 的 `.strict()` 语义）————

fn invalid(message: impl std::fmt::Display) -> RpcError {
    RpcError::invalid_params(format!("Invalid params — {message}"))
}

fn object(params: &Value) -> Result<&Map<String, Value>, RpcError> {
    params
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))
}

fn strict_keys(
    params: &Map<String, Value>,
    known: &[&str],
    what: &str,
) -> Result<(), RpcError> {
    for key in params.keys() {
        if !known.contains(&key.as_str()) {
            return Err(invalid(format!("Unrecognized key `{key}` in {what}")));
        }
    }
    Ok(())
}

fn required_string(params: &Map<String, Value>, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("`{key}` must be a non-empty string")))
}

fn optional_bool(params: &Map<String, Value>, key: &str) -> Result<Option<bool>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| invalid(format!("`{key}` must be a boolean"))),
    }
}

fn optional_positive(params: &Map<String, Value>, key: &str) -> Result<Option<u64>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|number| *number > 0)
            .map(Some)
            .ok_or_else(|| invalid(format!("`{key}` must be a positive integer"))),
    }
}

fn string_array(params: &Map<String, Value>, key: &str) -> Result<Vec<String>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => value
            .as_array()
            .ok_or_else(|| invalid(format!("`{key}` must be an array of strings")))?
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| invalid(format!("`{key}` must be an array of strings")))
            })
            .collect(),
    }
}

/// `env` / `headers`：`[{name, value}]`，名字非空。
fn entries(
    params: &Map<String, Value>,
    key: &str,
) -> Result<std::collections::BTreeMap<String, String>, RpcError> {
    let mut map = std::collections::BTreeMap::new();
    let Some(value) = params.get(key) else {
        return Ok(map);
    };
    let list = value
        .as_array()
        .ok_or_else(|| invalid(format!("`{key}` must be an array of entries")))?;
    for item in list {
        let item = item
            .as_object()
            .ok_or_else(|| invalid(format!("`{key}` entries must be objects")))?;
        strict_keys(item, &["name", "value"], key)?;
        let name = required_string(item, "name")?;
        let value = item
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(format!("`{key}` entry values must be strings")))?;
        map.insert(name, value.to_owned());
    }
    Ok(map)
}

fn isolation(params: &Map<String, Value>) -> Result<McpIsolation, RpcError> {
    match params.get("isolation").and_then(Value::as_str) {
        None | Some("session") => Ok(McpIsolation::Session),
        Some("workspace") => Ok(McpIsolation::Workspace),
        Some(other) => Err(invalid(format!(
            "`isolation` must be \"session\" or \"workspace\", got {other:?}"
        ))),
    }
}

fn workspace_param(value: Option<&Value>) -> Result<(String, Option<String>), RpcError> {
    let value = value
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("`workspace` must be an object"))?;
    strict_keys(
        value,
        &[
            "workspacePath",
            "workspaceIdentity",
            "remoteSessionId",
            "workspaceKey",
        ],
        "workspace",
    )?;
    let path = required_string(value, "workspacePath")?;
    let identity = value
        .get("workspaceIdentity")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|identity| !identity.is_empty())
        .map(str::to_owned);
    Ok((path, identity))
}

/// 一个服务器条目 → 协议类型；第二个值是这个服务器带 `oauth`（内核不实现授权流）。
fn server_param(value: &Value) -> Result<(SessionMcpServer, bool), RpcError> {
    let params = value
        .as_object()
        .ok_or_else(|| invalid("`mcpServers` entries must be objects"))?;
    let name = required_string(params, "name")?;
    let kind = params.get("type").and_then(Value::as_str);
    let (transport, known, needs_oauth) = match kind {
        Some("http" | "sse") => {
            let url = required_string(params, "url")?;
            let headers = entries(params, "headers")?;
            let transport = if kind == Some("http") {
                McpTransportConfig::Http { url, headers }
            } else {
                McpTransportConfig::Sse { url, headers }
            };
            let oauth = params.get("oauth").is_some_and(|value| !value.is_null());
            if oauth {
                authorization(params.get("oauth"))?;
            }
            (
                transport,
                [
                    "name",
                    "type",
                    "url",
                    "headers",
                    "oauth",
                    "isolation",
                    "protocolVersion",
                    "alwaysLoad",
                    "timeoutMs",
                ]
                .as_slice(),
                oauth,
            )
        }
        Some(other) => {
            return Err(invalid(format!(
                "`type` must be \"http\" or \"sse\", got {other:?}"
            )));
        }
        None => (
            McpTransportConfig::Stdio {
                command: required_string(params, "command")?,
                args: string_array(params, "args")?,
                env: entries(params, "env")?,
                cwd: None,
            },
            [
                "name",
                "command",
                "args",
                "env",
                "isolation",
                "protocolVersion",
                "alwaysLoad",
                "timeoutMs",
            ]
            .as_slice(),
            false,
        ),
    };
    strict_keys(params, known, "an `mcpServers` entry")?;
    if let Some(version) = params.get("protocolVersion").and_then(Value::as_str)
        && !matches!(version, "legacy" | "auto" | "2026-07-28")
    {
        return Err(invalid(format!(
            "`protocolVersion` must be \"legacy\", \"auto\" or \"2026-07-28\", got {version:?}"
        )));
    }
    Ok((
        SessionMcpServer {
            name,
            transport,
            always_load: optional_bool(params, "alwaysLoad")?.unwrap_or(false),
            timeout_ms: optional_positive(params, "timeoutMs")?,
            isolation: isolation(params)?,
        },
        needs_oauth,
    ))
}

/// `oauth` 的形状（Host `nibiProtocolMcpOAuthSchema` 的联合）：只为校验，内核不消费。
fn authorization(value: Option<&Value>) -> Result<(), RpcError> {
    let value = value
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("`oauth` must be an object"))?;
    match value.get("type").and_then(Value::as_str) {
        Some("client_credentials") => {
            required_string(value, "clientId")?;
            required_string(value, "clientSecret")?;
        }
        Some("authorization_code") => {}
        Some(other) => {
            return Err(invalid(format!(
                "`oauth.type` must be \"client_credentials\" or \"authorization_code\", got {other:?}"
            )));
        }
        None => return Err(invalid("`oauth.type` is required")),
    }
    Ok(())
}

#[cfg(test)]
#[path = "mcp_rpc_tests.rs"]
mod tests;

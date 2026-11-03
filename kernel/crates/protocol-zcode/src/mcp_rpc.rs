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
use rust_cli_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};
use rust_cli_kernel_api::mcp_status::{McpListRequest, McpServerStatus};
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
    let workspace = server.workspace(&workspace_path(params.get("workspace"))?);
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

fn workspace_path(value: Option<&Value>) -> Result<String, RpcError> {
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
    required_string(value, "workspacePath")
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

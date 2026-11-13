//! `mcp/list`（Host `nibiMcpListParamsSchema`，141 审计 §9 第 6 项 F7 的第一条）。
//!
//! 参数是 `{workspace, mcpServers?, mode}`：`mode` 缺省是 `connect`（收敛连接集合并等连接落定），
//! `status` 只读快照。结果是 `{statuses: Record<服务器名, 快照>}`，快照的字段与 Host 的
//! `nibiMcpServerStatusSnapshotSchema` 一一对应。
//!
//! `oauth` 与 `protocolVersion` 都按 Node 的语义接上：`oauth` 的令牌由入口给的令牌端口取（
//! `authorization_code` 读桌面端写进共享凭据的令牌、`client_credentials` 自己换），401 时刷新一次；
//! `auto` 先探 `server/discover`、没有现代证据时回退 2025 的 `initialize`。

use nibi_kernel_base::js::iso_timestamp;
use nibi_kernel_api::mcp::{McpOAuthConfig, McpProtocolVersion, McpTransportConfig};
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};
use nibi_kernel_api::mcp_status::{McpListRequest, McpServerStatus};
use nibi_kernel_api::mcp_ui::{
    APP_TOOL_DESCRIPTION_MAX_CHARS, APP_TOOL_ERROR_MESSAGE_MAX_CHARS, APP_TOOL_NAME_MAX_CHARS,
    APP_TOOL_SCHEMA_MAX_BYTES, APP_TOOL_TITLE_MAX_CHARS, APP_TOOLS_MAX_PER_INSTANCE,
    McpAppInstance, McpResourceContent, McpResourceDescriptor, McpResourceTemplate,
    McpUiAppToolAnnotations, McpUiAppToolDescriptor, McpUiCallToolRequest, McpUiCancelCallRequest,
    McpUiCancelSamplingRequest, McpUiClaimAppToolCallRequest, McpUiInstanceRequest, McpUiListRequest,
    McpUiOpenRequest, McpUiReadRequest, McpUiRegisterAppToolsRequest, McpUiResolveAppToolCallRequest,
    McpUiSamplingContent, McpUiSamplingMessage, McpUiSamplingRequest, McpUiScope,
    McpUiSubscriptionRequest, McpUiUnregisterAppToolsRequest, SAMPLING_BUSY, SAMPLING_CANCELLED,
    SAMPLING_DUPLICATE, SAMPLING_IMAGE_MAX_BYTES, SAMPLING_IMAGE_MIME_TYPES, SAMPLING_LIMIT,
    SAMPLING_MAX_BLOCKS, SAMPLING_MAX_BYTES, SAMPLING_TIMED_OUT, UI_READ_MAX_BYTES,
    decoded_base64_len, json_bytes, mime_allowed_for_ui, tool_not_app_visible_message,
    tool_not_found_message,
};
use nibi_kernel_api::session_api::KernelError;
use nibi_kernel_protocol_core::rpc::RpcError;
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
    if let Some(list) = params.get("mcpServers") {
        let list = list
            .as_array()
            .ok_or_else(|| invalid("`mcpServers` must be an array"))?;
        for entry in list {
            servers.push(server_param(entry)?);
        }
    }
    let explicit = params.contains_key("mcpServers");
    let request = McpListRequest {
        workspace,
        servers: explicit.then_some(servers),
        connect,
    };
    let statuses = server
        .kernel
        .mcp_list(request)
        .await
        .map_err(|error| kernel_error(&error))?;
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

/// `mcp/uiSubscribeResource`：页面订阅一个资源（引用计数与断线重放都在连接管理里）。
pub(crate) async fn subscribe_resource(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "scopeId",
            "generation",
            "uri",
        ],
        "mcp/uiSubscribeResource params",
    )?;
    let request = subscription_request(params, server)?;
    server
        .kernel
        .mcp_ui_subscribe(request)
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({}))
}

/// `mcp/uiUnsubscribeResource`：页面退订一个资源（最后一个订阅者退订时通知服务器）。
pub(crate) async fn unsubscribe_resource(
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
            "scopeId",
            "generation",
            "uri",
        ],
        "mcp/uiUnsubscribeResource params",
    )?;
    let request = subscription_request(params, server)?;
    server
        .kernel
        .mcp_ui_unsubscribe(request)
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({}))
}

/// `mcp/uiCallTool`：页面回调一个本服务器的工具。复用宿主审批链，不产生 transcript row；
/// 结果是 MCP 的原始 `CallToolResult`（只保留 Host schema 的四个键）。
pub(crate) async fn call_tool(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "toolName",
            "arguments",
            "callId",
        ],
        "mcp/uiCallTool params",
    )?;
    let arguments = match params.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err(invalid("`arguments` must be an object")),
    };
    let request = McpUiCallToolRequest {
        instance: instance_request(params, server)?,
        tool_name: required_string(params, "toolName")?,
        arguments,
        call_id: bounded_string(params, "callId", 128)?,
    };
    let value = server
        .kernel
        .mcp_ui_call_tool(request.clone())
        .await
        .map_err(|error| ui_call_error(&error, &request))?;
    call_tool_result(value)
}

/// `mcp/uiCancelCall`：取消 `mcp/uiCallTool` 带 `callId` 的进行中调用；归属校验同调用。
pub(crate) async fn cancel_call(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "callId",
        ],
        "mcp/uiCancelCall params",
    )?;
    let request = McpUiCancelCallRequest {
        instance: instance_request(params, server)?,
        call_id: bounded_string(params, "callId", 128)?,
    };
    let cancelled = server
        .kernel
        .mcp_ui_cancel_call(request)
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({"cancelled": cancelled}))
}

/// `tools/call` 的结果只留 Host `nibiMcpUiCallToolResultSchema` 的四个键；`content` 缺失是服务器的
/// 协议错误（MCP 要求它一定在）。
fn call_tool_result(value: Value) -> Result<Value, RpcError> {
    let Some(content) = value.get("content").and_then(Value::as_array).cloned() else {
        return Err(RpcError::internal(
            "MCP server returned an unexpected tools/call result",
        ));
    };
    let mut result = json!({"content": content});
    if let Some(structured) = value.get("structuredContent") {
        result["structuredContent"] = structured.clone();
    }
    if let Some(is_error) = value.get("isError").and_then(Value::as_bool) {
        result["isError"] = json!(is_error);
    }
    if let Some(meta) = value.get("_meta") {
        result["_meta"] = meta.clone();
    }
    Ok(result)
}

/// 页面调用的错误码（Node `translateScopeError`）：工具不存在与只给模型用都是 -32602，带结构化原因；
/// 其余沿用资源面的映射。
fn ui_call_error(error: &KernelError, request: &McpUiCallToolRequest) -> RpcError {
    let server = request.instance.scope.server_name.as_str();
    let tool = request.tool_name.as_str();
    let reason = match error {
        KernelError::Failed { message } if *message == tool_not_found_message(server, tool) => {
            "tool_not_found"
        }
        KernelError::Failed { message } if *message == tool_not_app_visible_message(server, tool) => {
            "tool_not_app_visible"
        }
        _ => return ui_error(error),
    };
    RpcError::new(
        -32602,
        match reason {
            "tool_not_found" => tool_not_found_message(server, tool),
            _ => tool_not_app_visible_message(server, tool),
        },
    )
    .with_data(json!({
        "reason": reason,
        "serverName": server,
        "toolName": tool,
    }))
}

/// `mcp/uiRegisterAppTools`：页面把它的工具登记给模型（这个实例的集合整体替换）。
pub(crate) async fn register_app_tools(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "scopeId",
            "generation",
            "tools",
        ],
        "mcp/uiRegisterAppTools params",
    )?;
    let (instance, scope_id, generation) = app_tool_instance(params, server)?;
    let tools = app_tool_descriptors(params.get("tools"))?;
    let registered = server
        .kernel
        .mcp_ui_register_app_tools(McpUiRegisterAppToolsRequest {
            instance,
            scope_id,
            generation,
            tools,
        })
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({"tools": registered}))
}

/// `mcp/uiUnregisterAppTools`：页面卸载时收回它的工具（会话已关闭时幂等回 0）。
pub(crate) async fn unregister_app_tools(
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
            "scopeId",
            "generation",
        ],
        "mcp/uiUnregisterAppTools params",
    )?;
    let (instance, scope_id, generation) = app_tool_instance(params, server)?;
    let removed = server
        .kernel
        .mcp_ui_unregister_app_tools(McpUiUnregisterAppToolsRequest {
            instance,
            scope_id,
            generation,
        })
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({"removed": removed}))
}

/// `mcp/uiClaimAppToolCall`：渲染端认领一次待执行的 AppTool 调用。
pub(crate) async fn claim_app_tool_call(
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
            "scopeId",
            "generation",
            "callId",
        ],
        "mcp/uiClaimAppToolCall params",
    )?;
    let (instance, scope_id, generation) = app_tool_instance(params, server)?;
    let call_id = bounded_string(params, "callId", 128)?;
    let accepted = server
        .kernel
        .mcp_ui_claim_app_tool_call(McpUiClaimAppToolCallRequest {
            instance,
            scope_id,
            generation,
            call_id,
        })
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({"accepted": accepted}))
}

/// `mcp/uiResolveAppToolCall`：页面执行完回传结果或错误（二者恰有一个）。
pub(crate) async fn resolve_app_tool_call(
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
            "scopeId",
            "generation",
            "callId",
            "result",
            "error",
        ],
        "mcp/uiResolveAppToolCall params",
    )?;
    let (instance, scope_id, generation) = app_tool_instance(params, server)?;
    let call_id = bounded_string(params, "callId", 128)?;
    let result = match params.get("result") {
        None | Some(Value::Null) => None,
        Some(value) => Some(call_tool_result(value.clone())?),
    };
    let error = match params.get("error") {
        None | Some(Value::Null) => None,
        Some(value) => Some(app_tool_error(value)?),
    };
    if result.is_some() == error.is_some() {
        return Err(invalid("exactly one of `result` or `error` is required"));
    }
    let accepted = server
        .kernel
        .mcp_ui_resolve_app_tool_call(McpUiResolveAppToolCallRequest {
            instance,
            scope_id,
            generation,
            call_id,
            result,
            error,
        })
        .await
        .map_err(|error| ui_error(&error))?;
    Ok(json!({"accepted": accepted}))
}

/// App 工具的实例身份：作用域与代际（Node `nibiMcpUiAppToolInstanceShape`）。
fn app_tool_instance(
    params: &Map<String, Value>,
    server: &Server,
) -> Result<(McpUiInstanceRequest, String, u64), RpcError> {
    let instance = instance_request(params, server)?;
    let scope_id = bounded_string(params, "scopeId", 256)?;
    let generation = params
        .get("generation")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("`generation` must be a non-negative integer"))?;
    Ok((instance, scope_id, generation))
}

/// 页面登记的工具清单（Node `mcpAppsAppToolDescriptorSchema`，最多 50 个）。
fn app_tool_descriptors(value: Option<&Value>) -> Result<Vec<McpUiAppToolDescriptor>, RpcError> {
    let list = value
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("`tools` must be an array"))?;
    if list.len() > APP_TOOLS_MAX_PER_INSTANCE {
        return Err(invalid(format!(
            "`tools` must contain at most {APP_TOOLS_MAX_PER_INSTANCE} items"
        )));
    }
    list.iter().map(app_tool_descriptor).collect()
}

fn app_tool_descriptor(value: &Value) -> Result<McpUiAppToolDescriptor, RpcError> {
    let value = value
        .as_object()
        .ok_or_else(|| invalid("each tool must be an object"))?;
    strict_keys(
        value,
        &[
            "name",
            "title",
            "description",
            "inputSchema",
            "outputSchema",
            "annotations",
        ],
        "app tool",
    )?;
    let name = required_string(value, "name")?;
    if name.chars().count() > APP_TOOL_NAME_MAX_CHARS {
        return Err(invalid(format!(
            "tool `name` must be at most {APP_TOOL_NAME_MAX_CHARS} characters"
        )));
    }
    Ok(McpUiAppToolDescriptor {
        name,
        title: optional_text(value, "title", APP_TOOL_TITLE_MAX_CHARS)?,
        description: optional_text(value, "description", APP_TOOL_DESCRIPTION_MAX_CHARS)?,
        input_schema: schema_param(value.get("inputSchema"), "inputSchema")?,
        output_schema: match value.get("outputSchema") {
            None | Some(Value::Null) => None,
            Some(schema) => Some(schema_param(Some(schema), "outputSchema")?),
        },
        annotations: match value.get("annotations") {
            None | Some(Value::Null) => None,
            Some(annotations) => Some(app_tool_annotations(annotations)?),
        },
    })
}

fn app_tool_annotations(value: &Value) -> Result<McpUiAppToolAnnotations, RpcError> {
    let value = value
        .as_object()
        .ok_or_else(|| invalid("`annotations` must be an object"))?;
    strict_keys(
        value,
        &[
            "title",
            "readOnlyHint",
            "destructiveHint",
            "idempotentHint",
            "openWorldHint",
        ],
        "app tool annotations",
    )?;
    let boolean = |key: &str| -> Result<Option<bool>, RpcError> {
        match value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(flag) => flag
                .as_bool()
                .map(Some)
                .ok_or_else(|| invalid(format!("`annotations.{key}` must be a boolean"))),
        }
    };
    Ok(McpUiAppToolAnnotations {
        title: optional_text(value, "title", APP_TOOL_TITLE_MAX_CHARS)?,
        read_only_hint: boolean("readOnlyHint")?,
        destructive_hint: boolean("destructiveHint")?,
        idempotent_hint: boolean("idempotentHint")?,
        open_world_hint: boolean("openWorldHint")?,
    })
}

/// 工具的 schema：必须是对象且 `type: "object"`，序列化后 ≤64 KiB（Node `objectSchemaSchema`）。
fn schema_param(value: Option<&Value>, key: &str) -> Result<Value, RpcError> {
    let value = value.ok_or_else(|| invalid(format!("`{key}` is required")))?;
    let Some(object) = value.as_object() else {
        return Err(invalid(format!("`{key}` must be an object")));
    };
    if object.get("type").and_then(Value::as_str) != Some("object") {
        return Err(invalid(format!("`{key}` schema type must be object")));
    }
    if json_bytes(value) > APP_TOOL_SCHEMA_MAX_BYTES {
        return Err(invalid(format!("`{key}` schema is too large")));
    }
    Ok(value.clone())
}

/// `resolve` 的错误分支：`{message}`，最长 4096（Node 的 strict error schema）。
fn app_tool_error(value: &Value) -> Result<String, RpcError> {
    let value = value
        .as_object()
        .ok_or_else(|| invalid("`error` must be an object"))?;
    strict_keys(value, &["message"], "app tool error")?;
    text(value.get("message"), "message", APP_TOOL_ERROR_MESSAGE_MAX_CHARS)
}

/// 可空的字符串字段：允许空串（Node 的 `.max()` 不限空），只限长度。
fn optional_text(
    params: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<Option<String>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => text(Some(value), key, max).map(Some),
    }
}

fn text(value: Option<&Value>, key: &str, max: usize) -> Result<String, RpcError> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("`{key}` must be a string")))?;
    if value.chars().count() > max {
        return Err(invalid(format!(
            "`{key}` must be at most {max} characters"
        )));
    }
    Ok(value.to_owned())
}

/// `mcp/uiSampling`：页面请求宿主模型采样一次（回合外的一次性模型请求）。
pub(crate) async fn sample(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "operationId",
            "request",
        ],
        "mcp/uiSampling params",
    )?;
    let instance = instance_request(params, server)?;
    let operation_id = bounded_string(params, "operationId", 128)?;
    let request = sampling_request(params.get("request"))?;
    let result = server
        .kernel
        .mcp_ui_sampling(McpUiSamplingRequest {
            instance,
            operation_id,
            messages: request.messages,
            system_prompt: request.system_prompt,
            max_tokens: request.max_tokens,
        })
        .await
        .map_err(|error| sampling_error(&error))?;
    Ok(json!({
        "role": "assistant",
        "model": result.model,
        "content": {"type": "text", "text": result.text},
        "stopReason": result.stop_reason,
    }))
}

/// `mcp/uiCancelSampling`：取消进行中的采样（没有时幂等回 `false`）。
pub(crate) async fn cancel_sampling(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "instance",
            "workspace",
            "sessionId",
            "pluginId",
            "serverName",
            "operationId",
        ],
        "mcp/uiCancelSampling params",
    )?;
    let request = McpUiCancelSamplingRequest {
        instance: instance_request(params, server)?,
        operation_id: bounded_string(params, "operationId", 128)?,
    };
    let cancelled = server
        .kernel
        .mcp_ui_cancel_sampling(request)
        .await
        .map_err(|error| sampling_error(&error))?;
    Ok(json!({"cancelled": cancelled}))
}

/// 采样请求的受理子集（Node 只开放宿主确实实现的官方子集；模型偏好与 metadata 只做校验与计费，
/// 不转发给 provider）。
struct SamplingRequest {
    messages: Vec<McpUiSamplingMessage>,
    system_prompt: Option<String>,
    max_tokens: u32,
}

fn sampling_request(value: Option<&Value>) -> Result<SamplingRequest, RpcError> {
    let value = value
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("`request` must be an object"))?;
    strict_keys(
        value,
        &[
            "messages",
            "systemPrompt",
            "maxTokens",
            "includeContext",
            "modelPreferences",
            "metadata",
            "_meta",
        ],
        "sampling request",
    )?;
    let Some(messages_value) = value.get("messages").and_then(Value::as_array) else {
        return Err(invalid("`request.messages` must be an array"));
    };
    if messages_value.is_empty() || messages_value.len() > SAMPLING_MAX_BLOCKS {
        return Err(invalid(format!(
            "`request.messages` must contain 1..={SAMPLING_MAX_BLOCKS} items"
        )));
    }
    let mut messages = Vec::with_capacity(messages_value.len());
    let mut blocks = 0usize;
    let mut bytes = 0usize;
    let mut block_metadata = 0usize;
    for message in messages_value {
        let message = message
            .as_object()
            .ok_or_else(|| invalid("each sampling message must be an object"))?;
        strict_keys(message, &["role", "content"], "sampling message")?;
        let role = required_string(message, "role")?;
        if role != "user" && role != "assistant" {
            return Err(invalid("`role` must be \"user\" or \"assistant\""));
        }
        let content = sampling_content(
            message.get("content"),
            &mut blocks,
            &mut bytes,
            &mut block_metadata,
        )?;
        messages.push(McpUiSamplingMessage { role, content });
    }
    if blocks > SAMPLING_MAX_BLOCKS {
        return Err(invalid("Sampling content exceeds host limits"));
    }
    let system_prompt = optional_text(value, "systemPrompt", SAMPLING_MAX_BYTES)?;
    bytes += system_prompt.as_ref().map_or(0, String::len);
    let max_tokens = value
        .get("maxTokens")
        .and_then(Value::as_u64)
        .filter(|tokens| *tokens > 0 && *tokens <= u64::from(u32::MAX))
        .ok_or_else(|| invalid("`maxTokens` must be a positive integer"))?;
    if let Some(context) = value.get("includeContext")
        && context.as_str() != Some("none")
    {
        return Err(invalid("`includeContext` must be \"none\""));
    }
    sampling_preferences(value.get("modelPreferences"))?;
    for key in ["metadata", "_meta"] {
        if let Some(metadata) = value.get(key)
            && !metadata.is_object()
        {
            return Err(invalid(format!("`{key}` must be an object")));
        }
    }
    let metadata = json_bytes(&json!({
        "metadata": value.get("metadata"),
        "_meta": value.get("_meta"),
    }));
    if bytes.saturating_add(block_metadata).saturating_add(metadata) > SAMPLING_MAX_BYTES {
        return Err(invalid("Sampling content exceeds host limits"));
    }
    Ok(SamplingRequest {
        messages,
        system_prompt,
        max_tokens: u32::try_from(max_tokens).unwrap_or(u32::MAX),
    })
}

fn sampling_content(
    value: Option<&Value>,
    blocks: &mut usize,
    bytes: &mut usize,
    metadata: &mut usize,
) -> Result<Vec<McpUiSamplingContent>, RpcError> {
    let Some(value) = value else {
        return Err(invalid("`content` is required"));
    };
    match value {
        Value::Array(items) => {
            if items.is_empty() || items.len() > SAMPLING_MAX_BLOCKS {
                return Err(invalid(format!(
                    "sampling content must contain 1..={SAMPLING_MAX_BLOCKS} blocks"
                )));
            }
            items
                .iter()
                .map(|block| sampling_block(block, blocks, bytes, metadata))
                .collect()
        }
        Value::Object(_) => Ok(vec![sampling_block(
            value, blocks, bytes, metadata,
        )?]),
        _ => Err(invalid("`content` must be a block or an array of blocks")),
    }
}

fn sampling_block(
    value: &Value,
    blocks: &mut usize,
    bytes: &mut usize,
    metadata: &mut usize,
) -> Result<McpUiSamplingContent, RpcError> {
    let block = value
        .as_object()
        .ok_or_else(|| invalid("each sampling block must be an object"))?;
    let kind = required_string(block, "type")?;
    match kind.as_str() {
        "text" => {
            strict_keys(block, &["type", "text", "annotations", "_meta"], "text block")?;
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("`text` must be a string"))?;
            if text.len() > SAMPLING_MAX_BYTES {
                return Err(invalid("Sampling content exceeds host limits"));
            }
            *bytes += text.len();
            sampling_annotations(block.get("annotations"))?;
            sampling_meta(block.get("_meta"))?;
            *metadata += json_bytes(&json!({
                "annotations": block.get("annotations"),
                "_meta": block.get("_meta"),
            }));
            *blocks += 1;
            Ok(McpUiSamplingContent::Text {
                text: text.to_owned(),
            })
        }
        "image" => {
            strict_keys(
                block,
                &["type", "mimeType", "data", "annotations", "_meta"],
                "image block",
            )?;
            let mime_type = required_string(block, "mimeType")?;
            if !SAMPLING_IMAGE_MIME_TYPES.contains(&mime_type.as_str()) {
                return Err(invalid("`mimeType` is not an allowed image type"));
            }
            let data = required_string(block, "data")?;
            if !valid_base64(&data) {
                return Err(invalid("`data` must be base64"));
            }
            let decoded = decoded_base64_len(&data);
            if decoded > SAMPLING_IMAGE_MAX_BYTES {
                return Err(invalid("Sampling content exceeds host limits"));
            }
            *bytes += decoded;
            sampling_annotations(block.get("annotations"))?;
            sampling_meta(block.get("_meta"))?;
            *metadata += json_bytes(&json!({
                "annotations": block.get("annotations"),
                "_meta": block.get("_meta"),
            }));
            *blocks += 1;
            Ok(McpUiSamplingContent::Image { mime_type, data })
        }
        other => Err(invalid(format!("unsupported sampling block type {other:?}"))),
    }
}

fn sampling_annotations(value: Option<&Value>) -> Result<(), RpcError> {
    let Some(value) = value else {
        return Ok(());
    };
    let annotations = value
        .as_object()
        .ok_or_else(|| invalid("`annotations` must be an object"))?;
    strict_keys(
        annotations,
        &["audience", "priority", "lastModified"],
        "sampling annotations",
    )?;
    if let Some(audience) = annotations.get("audience") {
        let list = audience
            .as_array()
            .ok_or_else(|| invalid("`audience` must be an array"))?;
        for item in list {
            if !matches!(item.as_str(), Some("user" | "assistant")) {
                return Err(invalid("`audience` items must be user or assistant"));
            }
        }
    }
    sampling_priority(annotations.get("priority"), "priority")?;
    if let Some(modified) = annotations.get("lastModified")
        && !modified.is_string()
    {
        return Err(invalid("`lastModified` must be a string"));
    }
    Ok(())
}

fn sampling_priority(value: Option<&Value>, key: &str) -> Result<(), RpcError> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(number) = value.as_f64() else {
        return Err(invalid(format!("`{key}` must be a number")));
    };
    if !(0.0..=1.0).contains(&number) {
        return Err(invalid(format!("`{key}` must be between 0 and 1")));
    }
    Ok(())
}

fn sampling_meta(value: Option<&Value>) -> Result<(), RpcError> {
    if let Some(meta) = value
        && !meta.is_object()
    {
        return Err(invalid("`_meta` must be an object"));
    }
    Ok(())
}

fn sampling_preferences(value: Option<&Value>) -> Result<(), RpcError> {
    let Some(value) = value else {
        return Ok(());
    };
    let preferences = value
        .as_object()
        .ok_or_else(|| invalid("`modelPreferences` must be an object"))?;
    strict_keys(
        preferences,
        &[
            "hints",
            "costPriority",
            "speedPriority",
            "intelligencePriority",
        ],
        "model preferences",
    )?;
    if let Some(hints) = preferences.get("hints") {
        let list = hints
            .as_array()
            .ok_or_else(|| invalid("`hints` must be an array"))?;
        if list.len() > 16 {
            return Err(invalid("`hints` must contain at most 16 items"));
        }
        for hint in list {
            let hint = hint
                .as_object()
                .ok_or_else(|| invalid("each hint must be an object"))?;
            strict_keys(hint, &["name"], "model hint")?;
            if hint.get("name").is_some() {
                text(hint.get("name"), "name", 256)?;
            }
        }
    }
    sampling_priority(preferences.get("costPriority"), "costPriority")?;
    sampling_priority(preferences.get("speedPriority"), "speedPriority")?;
    sampling_priority(
        preferences.get("intelligencePriority"),
        "intelligencePriority",
    )?;
    Ok(())
}

/// base64：长度是 4 的倍数、字符集合规、`=` 只在末尾（最多两个）。
fn valid_base64(data: &str) -> bool {
    if data.is_empty() || !data.len().is_multiple_of(4) {
        return false;
    }
    let trimmed = data.trim_end_matches('=');
    if data.len() - trimmed.len() > 2 {
        return false;
    }
    trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

/// 采样的错误码（Node `samplingCalls`）：取消 / 超时 / 并发 / 账本满都是 -32000，
/// `operationId` 重复是 -32602。
fn sampling_error(error: &KernelError) -> RpcError {
    let KernelError::Failed { message } = error else {
        return ui_error(error);
    };
    match message.as_str() {
        SAMPLING_CANCELLED | SAMPLING_TIMED_OUT | SAMPLING_BUSY | SAMPLING_LIMIT => {
            RpcError::new(-32000, message.clone())
        }
        SAMPLING_DUPLICATE => RpcError::new(-32602, message.clone()),
        _ => ui_error(error),
    }
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

fn subscription_request(
    params: &Map<String, Value>,
    server: &Server,
) -> Result<McpUiSubscriptionRequest, RpcError> {
    Ok(McpUiSubscriptionRequest {
        instance: instance_request(params, server)?,
        scope_id: bounded_string(params, "scopeId", 256)?,
        generation: params
            .get("generation")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("`generation` must be a non-negative integer"))?,
        uri: bounded_string(params, "uri", 2048)?,
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

pub(crate) fn invalid(message: impl std::fmt::Display) -> RpcError {
    RpcError::invalid_params(format!("Invalid params — {message}"))
}

pub(crate) fn object(params: &Value) -> Result<&Map<String, Value>, RpcError> {
    params
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))
}

pub(crate) fn strict_keys(
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

pub(crate) fn workspace_param(value: Option<&Value>) -> Result<(String, Option<String>), RpcError> {
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

/// 一个服务器条目 → 协议类型（`oauth` 与 `protocolVersion` 按 Node 的 schema 校验后带上）。
fn server_param(value: &Value) -> Result<SessionMcpServer, RpcError> {
    let params = value
        .as_object()
        .ok_or_else(|| invalid("`mcpServers` entries must be objects"))?;
    let name = required_string(params, "name")?;
    let kind = params.get("type").and_then(Value::as_str);
    let (transport, oauth, known) = match kind {
        Some("http" | "sse") => {
            let url = required_string(params, "url")?;
            let headers = entries(params, "headers")?;
            let transport = if kind == Some("http") {
                McpTransportConfig::Http { url, headers }
            } else {
                McpTransportConfig::Sse { url, headers }
            };
            let oauth = match params.get("oauth").filter(|value| !value.is_null()) {
                Some(value) => Some(
                    McpOAuthConfig::from_value(value)
                        .map_err(|reason| invalid(format!("`oauth`: {reason}")))?,
                ),
                None => None,
            };
            (
                transport,
                oauth,
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
            None,
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
        ),
    };
    strict_keys(params, known, "an `mcpServers` entry")?;
    let protocol_version = match params.get("protocolVersion").and_then(Value::as_str) {
        None | Some("auto") => McpProtocolVersion::Auto,
        Some("legacy") => McpProtocolVersion::Legacy,
        Some("2026-07-28") => McpProtocolVersion::Modern,
        Some(other) => {
            return Err(invalid(format!(
                "`protocolVersion` must be \"legacy\", \"auto\" or \"2026-07-28\", got {other:?}"
            )));
        }
    };
    Ok(SessionMcpServer {
        name,
        transport,
        always_load: optional_bool(params, "alwaysLoad")?.unwrap_or(false),
        timeout_ms: optional_positive(params, "timeoutMs")?,
        isolation: isolation(params)?,
        oauth,
        protocol_version,
    })
}

#[cfg(test)]
#[path = "mcp_rpc_tests.rs"]
mod tests;

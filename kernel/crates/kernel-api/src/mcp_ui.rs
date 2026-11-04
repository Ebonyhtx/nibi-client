//! MCP Apps（插件面板）的数据面：连接身份、资源读取与可见性（141 审计 §9 第 6 项 F7 的第二段）。
//!
//! Node 侧的实现是 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/`：
//!
//! - **连接身份**（`appConnectionSnapshot`）：每个已连接的服务器给出 `{identity, generation}`。
//!   `identity` 是配置与工作区的摘要，`generation` 每次换连接加一；实例凭证绑定这一对，
//!   换连接后旧实例立即失效。
//! - **资源**：`resources/read|list|templates/list|subscribe|unsubscribe` 按服务器名走会话自己的
//!   MCP 连接；面向页面的读取有 8 MiB 与 MIME 白名单的界（在协议层判）。
//! - **可见性**：工具 `_meta.ui.visibility` 决定它进不进模型工具表、页面能不能调；缺省两者都算。
//!
//! 这里只放跨层共享的类型；连接在 ext，实例注册表与协议在后续层。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::env::WorkspaceRef;
use crate::ids::SessionId;

/// `ui://` 资源的 URI 前缀（Node `MCP_APPS_UI_RESOURCE_SCHEME`）。
pub const UI_RESOURCE_SCHEME: &str = "ui://";

/// 页面发起的 `resources/read` 单次结果总大小上限（Node `MCP_APPS_UI_READ_RESOURCE_MAX_BYTES`）。
pub const UI_READ_MAX_BYTES: usize = 8 * 1024 * 1024;

/// App-Provided Tools 的限额与命名（Node `@zcode/shared/mcp-apps`）。
pub const APP_TOOLS_MAX_PER_INSTANCE: usize = 50;
pub const APP_TOOL_NAME_MAX_CHARS: usize = 128;
pub const APP_TOOL_TITLE_MAX_CHARS: usize = 256;
pub const APP_TOOL_DESCRIPTION_MAX_CHARS: usize = 4096;
/// `inputSchema` / `outputSchema` 序列化后的上限（UTF-8 字节）。
pub const APP_TOOL_SCHEMA_MAX_BYTES: usize = 64 * 1024;
/// 模型调用参数进信箱前的上限；超限直接以错误结束，不下发。
pub const APP_TOOL_ARGUMENTS_MAX_BYTES: usize = 1024 * 1024;
/// 渲染端认领待执行调用的期限；超时视为页面未运行。
pub const APP_TOOL_CLAIM_TIMEOUT_MS: u64 = 5_000;
/// 认领后页面执行 `tools/call` 的期限。
pub const APP_TOOL_CALL_TIMEOUT_MS: u64 = 30_000;
/// 单次结果序列化上限。
pub const APP_TOOL_RESULT_MAX_BYTES: usize = 10 * 1024 * 1024;
pub const APP_TOOL_ERROR_MESSAGE_MAX_CHARS: usize = 4096;
pub const APP_TOOL_CALL_ID_MAX_CHARS: usize = 128;
/// 模型侧名字前缀（与 MCP 工具的 `mcp__` 不冲突）。
pub const APP_TOOL_MODEL_NAME_PREFIX: &str = "app__";

/// 模型侧名字的一段：非 `[A-Za-z0-9_-]` 换成 `_` 并合并连续下划线（Node
/// `sanitizeMcpAppsModelNamePart`）。
pub fn sanitize_app_tool_model_part(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_underscore = false;
    for character in name.chars() {
        let keep = character.is_ascii_alphanumeric() || character == '_' || character == '-';
        if keep {
            out.push(character);
            last_underscore = false;
        } else if !last_underscore {
            out.push('_');
            last_underscore = true;
        }
    }
    if out.is_empty() {
        "unknown".to_owned()
    } else {
        out
    }
}

/// 模型侧名字 `app__<server>__<tool>`（Node `buildMcpAppsAppToolModelName`）。
pub fn app_tool_model_name(server: &str, tool: &str) -> String {
    format!(
        "{APP_TOOL_MODEL_NAME_PREFIX}{}__{}",
        sanitize_app_tool_model_part(server),
        sanitize_app_tool_model_part(tool)
    )
}

/// MCP Apps 采样（`mcp/uiSampling`）的限额与错误文字（Node `@zcode/shared/mcp-apps`）。
pub const SAMPLING_TIMEOUT_MS: u64 = 60_000;
pub const SAMPLING_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const SAMPLING_MAX_BLOCKS: usize = 64;
pub const SAMPLING_MAX_PER_SESSION: usize = 4;
pub const SAMPLING_MAX_PER_AGENT: usize = 8;
pub const SAMPLING_MAX_OPERATIONS: usize = 4096;
pub const SAMPLING_IMAGE_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const SAMPLING_IMAGE_MIME_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp"];

pub const SAMPLING_CANCELLED: &str = "Sampling cancelled";
pub const SAMPLING_TIMED_OUT: &str = "Sampling timed out";
pub const SAMPLING_BUSY: &str = "Sampling busy";
pub const SAMPLING_LIMIT: &str = "Sampling operation limit reached; reopen the App";
pub const SAMPLING_DUPLICATE: &str = "Duplicate sampling operationId";

/// JSON 序列化后的字节数（Node 的 `jsonBytes`；序列化失败按无穷大算）。
pub fn json_bytes(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

/// 页面读取的 MIME 白名单（`/` 结尾是前缀匹配，其余精确匹配；参数与大小写忽略）。
pub const UI_READ_MIME_ALLOWLIST: &[&str] = &[
    "text/",
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/pdf",
    "application/rtf",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/svg+xml",
    "image/gif",
    "image/avif",
    "image/bmp",
    "image/tiff",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/heic",
    "image/heif",
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/webm",
    "audio/aac",
    "audio/flac",
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "video/mpeg",
    "application/zip",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "font/woff",
    "font/woff2",
    "font/ttf",
    "font/otf",
    "model/gltf+json",
    "model/gltf-binary",
    "application/octet-stream",
];

/// 页面的 `resources/read` 是否接受这个 MIME（Node `isMcpAppsUiReadResourceMimeAllowed`）。
pub fn mime_allowed_for_ui(mime_type: &str) -> bool {
    let essence = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if essence.is_empty() {
        return false;
    }
    UI_READ_MIME_ALLOWLIST.iter().any(|entry| {
        if let Some(prefix) = entry.strip_suffix('/') {
            essence.starts_with(prefix)
        } else {
            essence == *entry
        }
    })
}

/// base64 文本解码后的字节数（Node `decodedBytes`：长度按 4 的倍数算，减掉填充）。
pub fn decoded_base64_len(blob: &str) -> usize {
    let padding = if blob.ends_with("==") {
        2
    } else if blob.ends_with('=') {
        1
    } else {
        0
    };
    blob.len() / 4 * 3 - padding
}

/// 一次页面会话的凭证（Host `mcpAppInstanceSchema`）。
///
/// 四个字段都是 Host 回传时逐字比对的内容：内核按 `token` 查记录，再比 `runtimeId` /
/// `generation` / `appIdentity`——任何一个对不上都当作「不再授权」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppInstance {
    /// 进程级实例标识（同一进程里所有页面共用）。
    pub runtime_id: String,
    /// 单调代际（每次开新实例加一）。
    pub generation: u64,
    /// 稳定应用身份（64 位十六进制；配置/工作区不变时同一个页面同值）。
    pub app_identity: String,
    /// 不可猜的凭证（Host 每次请求回传）。
    pub token: String,
}

/// 页面请求的作用域（Host `zcodeMcpUiPluginScopeShape` 的 `workspace/sessionId/pluginId/serverName`）。
///
/// 归属真相是**会话自己的 MCP server 表**：插件 server 与普通 MCP server 同一张表，任何已连接的
/// server 都能渲染 MCP App；`pluginId` 只用于展示与日志（Node `assertMcpUiServerScope` 同一条）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiScope {
    pub workspace: WorkspaceRef,
    /// 实例绑定的工作区身份：Host 的 `workspaceIdentity`（去空白）或 `workspacePath`。
    pub workspace_identity: String,
    pub session: SessionId,
    pub plugin_id: String,
    pub server_name: String,
}

/// 开一个页面实例（`mcp/uiOpenInstance`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiOpenRequest {
    pub scope: McpUiScope,
    pub scope_id: String,
    pub resource_uri: String,
    pub owner_web_contents_id: i64,
    pub account_context: Option<String>,
}

/// 已有实例的一次请求（`close` / `validate` / 资源与调用方法都以它为作用域）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiInstanceRequest {
    pub scope: McpUiScope,
    pub instance: McpAppInstance,
}

/// `mcp/readResource`：除了实例校验，还要求 `uri` 等于实例绑定的 `resourceUri`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiReadRequest {
    pub instance: McpUiInstanceRequest,
    pub uri: String,
}

/// `resources/list|templates/list`：游标原样透传。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiListRequest {
    pub instance: McpUiInstanceRequest,
    pub cursor: Option<String>,
}

/// `mcp/uiSubscribeResource` / `mcp/uiUnsubscribeResource`：订阅者身份 = 会话 + 沙箱作用域 + 代际。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiSubscriptionRequest {
    pub instance: McpUiInstanceRequest,
    /// 沙箱作用域（必须等于实例的 token，Node 的 `scopeId` 约定）。
    pub scope_id: String,
    /// 实例代际（必须等于凭证的代际）。
    pub generation: u64,
    pub uri: String,
}

/// `mcp/uiCallTool`：页面回调一个本服务器的工具（Node `callMcpToolForUi`）。
///
/// 调用复用宿主的工具审批链（schema → PreToolUse hooks → 权限判决），但不产生对话回合：
/// 结果原样回给页面，不落库。`call_id` 由宿主生成，`mcp/uiCancelCall` 用它取消进行中的调用。
#[derive(Debug, Clone, PartialEq)]
pub struct McpUiCallToolRequest {
    pub instance: McpUiInstanceRequest,
    /// 服务器给的原始工具名（不是模型工具表里的 `mcp__<server>__<tool>`）。
    pub tool_name: String,
    /// 调用参数（Node 的 `arguments`，缺省是 `{}`）。
    pub arguments: Map<String, Value>,
    /// 宿主生成的调用 id（Node `callId`，最长 128）。
    pub call_id: String,
}

/// `mcp/uiCancelCall`：取消一个进行中的页面工具调用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiCancelCallRequest {
    pub instance: McpUiInstanceRequest,
    pub call_id: String,
}

/// App 提供的工具声明里的 annotations（Node `mcpAppsAppToolAnnotationsSchema`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUiAppToolAnnotations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_world_hint: Option<bool>,
}

/// 页面登记的一个工具（Node `mcpAppsAppToolDescriptorSchema`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpUiAppToolDescriptor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 必须是 `type: "object"` 的 JSON Schema（协议层校验）。
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<McpUiAppToolAnnotations>,
}

/// `mcp/uiRegisterAppTools`：页面把它的工具登记给模型（整体替换这个实例的集合）。
#[derive(Debug, Clone, PartialEq)]
pub struct McpUiRegisterAppToolsRequest {
    pub instance: McpUiInstanceRequest,
    /// 沙箱作用域（必须等于实例 token）。
    pub scope_id: String,
    /// 实例代际。
    pub generation: u64,
    pub tools: Vec<McpUiAppToolDescriptor>,
}

/// `mcp/uiRegisterAppTools` 的一条回执：页面里的名字与模型侧名字。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUiAppToolRegistration {
    pub name: String,
    pub model_name: String,
}

/// `mcp/uiUnregisterAppTools`：页面卸载时收回它的工具。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiUnregisterAppToolsRequest {
    pub instance: McpUiInstanceRequest,
    pub scope_id: String,
    pub generation: u64,
}

/// `mcp/uiClaimAppToolCall`：渲染端认领一次待执行的 AppTool 调用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiClaimAppToolCallRequest {
    pub instance: McpUiInstanceRequest,
    pub scope_id: String,
    pub generation: u64,
    pub call_id: String,
}

/// `mcp/uiResolveAppToolCall`：页面执行完，回传结果或错误（二者恰有一个）。
#[derive(Debug, Clone, PartialEq)]
pub struct McpUiResolveAppToolCallRequest {
    pub instance: McpUiInstanceRequest,
    pub scope_id: String,
    pub generation: u64,
    pub call_id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

/// 采样消息里的一个内容块（宿主只实现 text 与 image，Node 同一条）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpUiSamplingContent {
    Text { text: String },
    Image { mime_type: String, data: String },
}

/// 一条采样消息：`user` 或 `assistant`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiSamplingMessage {
    pub role: String,
    pub content: Vec<McpUiSamplingContent>,
}

/// `mcp/uiSampling`：页面请求宿主模型采样一次。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiSamplingRequest {
    pub instance: McpUiInstanceRequest,
    pub operation_id: String,
    pub messages: Vec<McpUiSamplingMessage>,
    pub system_prompt: Option<String>,
    pub max_tokens: u32,
}

/// 模型端口要的输入（不含实例身份：模型侧不需要它）。
#[derive(Debug, Clone, PartialEq)]
pub struct McpUiSamplingInput {
    pub messages: Vec<McpUiSamplingMessage>,
    pub system_prompt: Option<String>,
    pub max_tokens: u32,
    /// 会话当前的模型选择（None 时用缺省选择）：采样是回合外请求，不改变会话的选择。
    pub selection: Option<crate::model::ModelSelection>,
    /// 发起采样的会话：用量行挂在它名下（Node 的 `sampleModel` 是会话运行时的方法，在 `finally`
    /// 里写 `model_usage`）。None 时只做请求、不记账（模型端的单元测试）。
    pub session: Option<crate::ids::SessionId>,
}

/// 一次采样的结果（协议层补 `role` / `content` 外壳）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiSamplingResult {
    pub model: String,
    pub text: String,
    pub stop_reason: String,
}

/// `mcp/uiCancelSampling`：取消一个进行中的采样操作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpUiCancelSamplingRequest {
    pub instance: McpUiInstanceRequest,
    pub operation_id: String,
}

/// 回合外的一次模型请求（MCP Apps 采样）：runtime 用会话当前的模型选择实现。
#[async_trait::async_trait]
pub trait McpUiSamplingPort: Send + Sync {
    async fn sample(
        &self,
        request: McpUiSamplingInput,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<McpUiSamplingResult, String>;
}

/// 一条已连接的 MCP 服务器的身份快照（Node `appConnectionSnapshot`）。
///
/// 实例凭证绑定这一对：连接换了代际，旧实例就不能再执行任何请求。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppConnection {
    /// 配置与工作区的摘要（64 位十六进制）。
    pub identity: String,
    /// 连接代际：每次换连接（重连、换配置）加一。
    pub generation: u64,
}

/// 工具的一行可见性（Node `readMcpToolVisibility`）：`model` / `app`，缺省两者都有。
pub fn tool_visibility(meta: Option<&Value>) -> Vec<String> {
    let default = || vec!["model".to_owned(), "app".to_owned()];
    let Some(items) = meta
        .and_then(|meta| meta.get("ui"))
        .and_then(|ui| ui.get("visibility"))
        .and_then(Value::as_array)
    else {
        return default();
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Some(value) = item.as_str() else {
            continue;
        };
        if matches!(value, "model" | "app") && !out.iter().any(|existing| existing == value) {
            out.push(value.to_owned());
        }
    }
    if out.is_empty() { default() } else { out }
}

/// 工具是否进模型工具表（Node：不含 `model` 的工具不得进入 provider contracts）。
pub fn visible_to_model(visibility: &[String]) -> bool {
    visibility.iter().any(|value| value == "model")
}

/// 工具是否允许页面调用。
pub fn visible_to_app(visibility: &[String]) -> bool {
    visibility.iter().any(|value| value == "app")
}

/// `resources/list` 的一条资源（Host `zcodeMcpUiResourceDescriptorSchema` 的字段集）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceDescriptor {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// 规范把资源级 csp / prefersBorder 放在列表条目的 `_meta` 上；宿主读 HTML 项缺 `_meta` 时回退用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
}

/// 一页资源。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourcePage {
    #[serde(default)]
    pub resources: Vec<McpResourceDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// `resources/templates/list` 的一条模板。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplate {
    pub uri_template: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// 一页资源模板。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplatePage {
    #[serde(default)]
    pub resource_templates: Vec<McpResourceTemplate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// `resources/read` 的一项内容（原样保留 `_meta`；面向页面的读取由协议层剥掉并判界）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceContent {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// base64（MCP 的 `blob`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
}

/// MCP Apps 资源面的错误。协议层把它映射成 RPC 错误码（-32602 / -32001 / -32000）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum McpUiError {
    /// 服务器不在本会话的连接表里，或者当前没连上。
    #[error("MCP server \"{server}\" is not connected")]
    NotConnected { server: String },
    /// 服务器没有声明这个能力（例如没有 `resources.subscribe`）。
    #[error("MCP server \"{server}\" does not support {operation}")]
    Unsupported { server: String, operation: String },
    /// 页面调用的工具不在服务器的清单里（Node `tool_not_found`，协议层映射到 -32602）。
    #[error("MCP tool \"{tool}\" is not available on server \"{server}\"")]
    ToolNotFound { server: String, tool: String },
    /// 工具存在但 `_meta.ui.visibility` 不含 `app`，只给模型用（Node `tool_not_app_visible`，-32602）。
    #[error("MCP tool \"{tool}\" on server \"{server}\" is not visible to plugin UI")]
    ToolNotAppVisible { server: String, tool: String },
    /// 同一个 `callId` 已经在进行或已经结束（Node `Duplicate MCP App callId`）。
    #[error("Duplicate MCP App callId")]
    DuplicateCall,
    /// 采样被取消 / 超时 / 并发满 / 操作账本满（Node 的 -32000 一族）。
    #[error("Sampling cancelled")]
    SamplingCancelled,
    #[error("Sampling timed out")]
    SamplingTimedOut,
    #[error("Sampling busy")]
    SamplingBusy,
    #[error("Sampling operation limit reached; reopen the App")]
    SamplingLimit,
    /// 同一个 `operationId` 已经用过（-32602）。
    #[error("Duplicate sampling operationId")]
    SamplingDuplicate,
    /// 服务器回了错误、超时或连接中途断开。
    #[error("{message}")]
    Failed { message: String },
}

impl McpUiError {
    pub fn not_connected(server: &str) -> Self {
        Self::NotConnected {
            server: server.to_owned(),
        }
    }

    pub fn unsupported(server: &str, operation: &str) -> Self {
        Self::Unsupported {
            server: server.to_owned(),
            operation: operation.to_owned(),
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
        }
    }

    /// 凭证、作用域或连接代际对不上（Node 的 "MCP App instance is no longer authorized"）。
    pub fn not_authorized() -> Self {
        Self::failed("MCP App instance is no longer authorized")
    }

    /// 页面调用的工具不存在（与 [`tool_not_found_message`] 同一段文字）。
    pub fn tool_not_found(server: &str, tool: &str) -> Self {
        Self::ToolNotFound {
            server: server.to_owned(),
            tool: tool.to_owned(),
        }
    }

    /// 页面调用的工具只给模型用（与 [`tool_not_app_visible_message`] 同一段文字）。
    pub fn tool_not_app_visible(server: &str, tool: &str) -> Self {
        Self::ToolNotAppVisible {
            server: server.to_owned(),
            tool: tool.to_owned(),
        }
    }

    pub fn duplicate_call() -> Self {
        Self::DuplicateCall
    }

    /// 服务器不在会话的连接表里，或当前没连上（Node 的 "MCP App connection is unavailable"）。
    pub fn app_unavailable() -> Self {
        Self::failed("MCP App connection is unavailable")
    }

    /// `mcp/readResource` 的 `uri` 不是实例绑定的那个资源。
    pub fn binding_mismatch() -> Self {
        Self::failed("MCP App resource binding mismatch")
    }
}

/// 页面调用的工具不存在时的文字：ext 的 `Display` 与协议层的错误分类共用这一段。
pub fn tool_not_found_message(server: &str, tool: &str) -> String {
    format!("MCP tool \"{tool}\" is not available on server \"{server}\"")
}

/// 页面调用的工具只给模型用时的文字（同一段共用）。
pub fn tool_not_app_visible_message(server: &str, tool: &str) -> String {
    format!("MCP tool \"{tool}\" on server \"{server}\" is not visible to plugin UI")
}

/// `resources/list|templates/list|subscribe` 的订阅者身份：沙箱作用域 + 代际 + 完整凭证。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUiSubscriber {
    /// 沙箱作用域（等于实例的 token，Node 的订阅键里用 scopeId）。
    pub scope_id: String,
    pub generation: u64,
    pub instance: McpAppInstance,
}

/// 从 MCP 连接流向协议层的一次 UI 事件（live-only，不落盘）。
///
/// 协议层把它变成 `v4/conversation/frame` 里的 `pluginUi.*` 增量；`session` 是它该投递的会话。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpUiEvent {
    /// 服务器说某个资源变了（`notifications/resources/updated`）。
    ResourceUpdated {
        session: SessionId,
        plugin_id: String,
        server: String,
        uri: String,
        subscribers: Vec<McpUiSubscriber>,
    },
    /// 服务器的资源清单变了（`notifications/resources/list_changed`）。
    ResourceListChanged {
        session: SessionId,
        plugin_id: String,
        server: String,
        subscribers: Vec<McpUiSubscriber>,
    },
    /// 实例被关闭（页面要卸载）。
    InstanceClosed {
        session: SessionId,
        plugin_id: String,
        server: String,
        subscribers: Vec<McpUiSubscriber>,
    },
    /// 实例信箱：一次待执行的 AppTool 调用（只投给 `subscribers` 里那一个实例）。
    /// `cancelled` 为真时是收尾通知（参数为空、页面只需清理）。
    AppToolCall {
        session: SessionId,
        plugin_id: String,
        server: String,
        subscribers: Vec<McpUiSubscriber>,
        call_id: String,
        tool_name: String,
        arguments: Map<String, Value>,
        cancelled: bool,
    },
}

/// 资源通知的一种（`resources/updated` 带 URI，`resources/list_changed` 不带）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpResourceSignal {
    Updated(String),
    ListChanged,
}

#[cfg(test)]
#[path = "mcp_ui_tests.rs"]
mod tests;

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

    /// 服务器不在会话的连接表里，或当前没连上（Node 的 "MCP App connection is unavailable"）。
    pub fn app_unavailable() -> Self {
        Self::failed("MCP App connection is unavailable")
    }

    /// `mcp/readResource` 的 `uri` 不是实例绑定的那个资源。
    pub fn binding_mismatch() -> Self {
        Self::failed("MCP App resource binding mismatch")
    }
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

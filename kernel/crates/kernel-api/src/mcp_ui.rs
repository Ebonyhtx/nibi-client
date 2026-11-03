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

/// `ui://` 资源的 URI 前缀（Node `MCP_APPS_UI_RESOURCE_SCHEME`）。
pub const UI_RESOURCE_SCHEME: &str = "ui://";

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
}

#[cfg(test)]
#[path = "mcp_ui_tests.rs"]
mod tests;

//! MCP 的传输端口与跨端口类型（docs/specs/rust-cli/ext.md §3.2、§3.4）。
//!
//! MCP 传输属于执行环境（README §6）：内核（ext）只发收 JSON-RPC 消息，协议语义（握手、工具清单、
//! 调用、通知）在内核里；本地实现在 env-local（stdio 经 proc，SSE / streamable HTTP 经 net），上云后
//! 换成远端执行环境的实现。

use std::collections::BTreeMap;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::env::WorkspaceRef;

/// 一个服务器的传输配置（stdio / sse / http 三种）。
/// 本机的服务器：`${VAR}` 已由入口层按来源的规则处理（`--mcp-config` 展开，配置文件原样）。绑定到远端机器的
/// 服务器：值是配置的原文，由那台机器的执行器用它自己的环境展开（[`crate::mcp_vars`]，remote-exec.md §22.7）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransportConfig {
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        /// 加在执行环境白名单变量之上的变量。
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
        /// 进程的工作目录（Node 配置的 `cwd`）：相对路径相对工作区根，绝对路径原样；None 是工作区根
        /// （docs/specs/rust-cli/ext.md §3.1、§3.2）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    Sse {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
}

impl McpTransportConfig {
    /// 配置的传输种类（`mcp/list` 的 `transport` 字段）。
    pub fn kind(&self) -> crate::mcp_status::McpTransportKind {
        match self {
            Self::Stdio { .. } => crate::mcp_status::McpTransportKind::Stdio,
            Self::Sse { .. } => crate::mcp_status::McpTransportKind::Sse,
            Self::Http { .. } => crate::mcp_status::McpTransportKind::Http,
        }
    }
}

/// 服务器配置的 `protocolVersion`（Node `auto` / `legacy` / 钉一个现代版本）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpProtocolVersion {
    /// 先探 `server/discover`；服务器没有现代证据时回退 2025 的 `initialize`（Node 的 `auto`）。
    #[default]
    Auto,
    /// 直接走 `initialize`（2025 的握手）。
    Legacy,
    /// 必须协商到 `2026-07-28` 起的现代协议；协商不到就失败（Node 的 pin）。
    Modern,
}

/// 一个 HTTP / SSE 服务器的 OAuth 配置（Node `McpServerConfig.oauth`）。
///
/// `client_credentials` 由内核自己换令牌（发现授权服务器 + `client_secret_basic`）；
/// `authorization_code` 的交互授权在桌面端做（浏览器 + 回调），令牌写进共享凭据文件，内核只读取与刷新。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpOAuthConfig {
    ClientCredentials {
        client_id: String,
        client_secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
    AuthorizationCode {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redirect_path: Option<String>,
    },
}

impl McpOAuthConfig {
    /// 从 Node 配置 / NIBI 协议同形的 JSON 读（`type` 加 camelCase 字段；字段类型不对按 strict schema 报错）。
    pub fn from_value(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "oauth: expected an object".to_owned())?;
        for key in ["clientId", "clientSecret", "clientName", "scope", "redirectPath"] {
            match object.get(key) {
                None | Some(Value::Null) => {}
                Some(Value::String(value)) if !value.trim().is_empty() => {}
                Some(_) => return Err(format!("oauth.{key}: expected a non-empty string")),
            }
        }
        let text = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        match object.get("type").and_then(Value::as_str) {
            Some("client_credentials") => Ok(Self::ClientCredentials {
                client_id: text("clientId")
                    .ok_or_else(|| "oauth.clientId: required for client_credentials".to_owned())?,
                client_secret: text("clientSecret")
                    .ok_or_else(|| "oauth.clientSecret: required for client_credentials".to_owned())?,
                client_name: text("clientName"),
                scope: text("scope"),
            }),
            Some("authorization_code") => Ok(Self::AuthorizationCode {
                client_id: text("clientId"),
                client_secret: text("clientSecret"),
                client_name: text("clientName"),
                scope: text("scope"),
                redirect_path: text("redirectPath"),
            }),
            Some(other) => Err(format!(
                "oauth.type: expected client_credentials or authorization_code, got {other:?}"
            )),
            None => Err("oauth.type: required".to_owned()),
        }
    }
}

/// 一次令牌请求的上下文：服务器名、服务器 URL 与配置（凭据键按 Node 的 `[名字, URL, clientId, scope,
/// redirectPath]` 派生，见 `nibi-platform::mcp_oauth`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpOAuthRequest {
    pub server: String,
    pub url: String,
    pub config: McpOAuthConfig,
}

/// MCP 的 OAuth 令牌端口（Node 的 `AuthProvider`）：入口/runtime 实现（发现授权服务器、读共享凭据、
/// 换令牌、跨进程刷新锁），ext 只做「取令牌 → 带 `Authorization: Bearer` 连 → 401 时刷新一次再试」。
#[async_trait]
pub trait McpOAuthPort: Send + Sync {
    /// 这个服务器当前可用的访问令牌；没有凭据时 None（请求照发，401 再走 [`Self::refresh`]）。
    async fn access_token(&self, request: &McpOAuthRequest) -> Option<String>;

    /// 服务器拒绝了上一次发出的令牌：刷新一次并返回新令牌（失败时是给用户看的原因）。
    /// `rejected` 是被拒的那一枚（并发下用来避免刷新一枚未被拒绝的令牌）。
    async fn refresh(
        &self,
        request: &McpOAuthRequest,
        rejected: Option<&str>,
    ) -> Result<String, String>;
}

/// 建立一条连接。`server` 只用于日志与错误文本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpConnect {
    pub server: String,
    pub transport: McpTransportConfig,
    /// stdio 服务器的进程环境在投影之后、配置的 `env` 之前加上（或去掉）的变量（远端执行 F96，remote-exec.md §23.5）；
    /// `${VAR}` 展开也先查它。只在执行器里由服务端按客户端实例填；不进序列化。
    #[serde(skip)]
    pub env: crate::env_command::EnvOverrides,
}

/// 执行侧给出的连接 ID。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct McpConnectionId(String);

impl McpConnectionId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 连接上的事件：收到的一条 JSON-RPC 消息，或连接已关闭（之后不再有事件）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransportEvent {
    Message {
        message: Value,
    },
    Closed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// HTTP 传输上服务器说会话已过期（404 且带会话 ID）：重连后可以重试。
        #[serde(default)]
        session_expired: bool,
        /// 服务器进程自己退出了（不是我们关的、也不是写失败）：`process/mcpTelemetry` 的
        /// `process_crash` 判据。远端执行器上的服务器报 `false`（那边自己做遥测）。
        #[serde(default)]
        exited: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpError {
    /// 进程起不来、连不上、HTTP 错误状态等。
    #[error("{message}")]
    Connect { message: String },
    /// 连接已关闭或不存在。
    #[error("connection closed: {message}")]
    Closed { message: String },
    #[error("{message}")]
    Io { message: String },
    #[error("not implemented: {what}")]
    Unsupported { what: String },
}

/// MCP 传输。实现方保证：一条连接的事件按到达顺序送出；`events` 只能取一次（取走缓冲的事件与之后的
/// 事件），再取得到空流；`close` 之后送出 `Closed` 并结束事件流。
#[async_trait]
pub trait McpTransport: Send + Sync {
    async fn connect(
        &self,
        workspace: &WorkspaceRef,
        request: McpConnect,
    ) -> Result<McpConnectionId, McpError>;

    /// 发一条 JSON-RPC 消息（请求、通知或对服务器请求的响应）。
    async fn send(&self, connection: &McpConnectionId, message: Value) -> Result<(), McpError>;

    fn events(&self, connection: &McpConnectionId) -> BoxStream<'static, McpTransportEvent>;

    async fn close(&self, connection: &McpConnectionId) -> Result<(), McpError>;

    /// stdio 服务器进程的 pid（`process/childProcesses` 的归属来源，141 审计 §9 F3）。HTTP / SSE
    /// 没有子进程，返回 `None`；缺省实现也返回 `None`。
    fn pid(&self, _connection: &McpConnectionId) -> Option<u32> {
        None
    }
}

/// 没有 MCP 传输时的空实现：连接一律失败。
pub struct NoMcpTransport;

fn unsupported() -> McpError {
    McpError::Unsupported {
        what: "MCP transport".to_owned(),
    }
}

#[async_trait]
impl McpTransport for NoMcpTransport {
    async fn connect(
        &self,
        _workspace: &WorkspaceRef,
        _request: McpConnect,
    ) -> Result<McpConnectionId, McpError> {
        Err(unsupported())
    }

    async fn send(&self, _connection: &McpConnectionId, _message: Value) -> Result<(), McpError> {
        Err(unsupported())
    }

    fn events(&self, _connection: &McpConnectionId) -> BoxStream<'static, McpTransportEvent> {
        futures_util::stream::empty().boxed()
    }

    async fn close(&self, _connection: &McpConnectionId) -> Result<(), McpError> {
        Ok(())
    }
}

/// MCP 服务器在工具执行期间反向提问（`elicitation/create`，MCP `form` 模式）的宿主端口。
///
/// 归属：Node 的 `activeCallTraces` 把 server 的提问挂到该 server **当前工具调用**的会话上；
/// 没有正在执行的调用（server 空闲时主动提问）就拒绝，不猜会话。实现方返回 MCP 的
/// `ElicitResult`（`{action:"accept", content}` / `{action:"decline"}` / `{action:"cancel"}`）。
#[async_trait]
pub trait McpElicitation: Send + Sync {
    /// `request` 是 `elicitation/create` 的 params（`message` + `requestedSchema`）。
    async fn elicit(&self, server: &str, request: Value) -> Value;
}

/// MCP 工具的来源（服务器信息与 `alwaysLoad`）：延迟加载与规则匹配用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpToolInfo {
    /// 配置里的服务器名（未规范化）。
    pub server: String,
    /// 服务器给出的工具原名。
    pub tool: String,
    /// 服务器配置的 `alwaysLoad` 或工具 `_meta` 里的不延迟标记为 true（docs/specs/rust-cli/ext.md §3.1）：不延迟加载。
    #[serde(default)]
    pub always_load: bool,
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;

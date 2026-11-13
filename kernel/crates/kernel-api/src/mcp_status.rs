//! MCP 服务器状态面（`mcp/list`，141 审计 §9 第 6 项 F7 的第一条）。
//!
//! Host 的 `mcp/list` 有两种模式（`nibiMcpListParamsSchema`）：
//!
//! - `mode: "connect"`（缺省）：把**这次给的完整集合**收敛到连接管理里（新增、换配置重启、缺席的断开），
//!   等连接落定后返回全部状态。设置页打开与手动刷新走这一条。
//! - `mode: "status"`：只读运行态快照，不动连接集合。OAuth 轮询走这一条（`mode: "status"` 的
//!   `mcpServers` 可能只是 pending 子集，不能进 replace 路径）。
//!
//! 返回值是 `Record<服务器名, 快照>`（Host `nibiMcpServerStatusSnapshotSchema`）。这里给的是
//! 内核侧的类型；`updatedAt` 的 ISO 文本与 `authorization.startedAt` 由协议层按 Host 的
//! `toISOString` 格式写出。
//!
//! 如实缺席：`serverRequestId`（内核的 RPC 客户端没有把失败请求的 id 带到连接状态里）与
//! `authorization`（OAuth 授权流不在内核实现——协议层对带 `oauth` 的服务器直接给
//! `oauth_authorization_failed` 的失败快照，不假装在授权）。

use serde::{Deserialize, Serialize};

use crate::env::WorkspaceRef;
use crate::mcp_session::SessionMcpServer;

/// Host `nibiMcpServerStatusKindSchema` 的六个值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpServerStatusKind {
    Connecting,
    Connected,
    Disabled,
    Disconnected,
    Failed,
    Untrusted,
}

/// Host `MCP_SERVER_FAILURE_KINDS`（`mcpServerFailureKindSchema`）。
///
/// 内核只产生能指认的那几种：连接超时、进程起不来、传输连不上、握手失败、协议错误、
/// 机器没连上（`runtime_unavailable`）、连上后断开（`unexpected_disconnect`）、工具清单拉取
/// 失败（`tool_list_failed`）与 OAuth 未实现（`oauth_authorization_failed`）。其余取值保留在
/// 枚举里，是因为 Host 的 schema 是封闭集合，协议层要能原样解析/回写，内核当前不产生它们。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpFailureKind {
    ConfigInvalid,
    RuntimeUnavailable,
    ProcessStartFailed,
    NetworkUnreachable,
    ConnectionTimeout,
    ProtocolNegotiationFailed,
    ToolListFailed,
    UnexpectedDisconnect,
    OauthAuthorizationFailed,
    OfficialOriginUntrusted,
    NotAuthenticated,
    CodingPlanRequired,
    ServerNotFound,
    ServerUnavailable,
    RateLimited,
    ServerInternalError,
    ProtocolError,
    StatusUnavailable,
    ConnectionFailed,
}

/// Host 的 `transport`：配置里的传输种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransportKind {
    Stdio,
    Http,
    Sse,
}

/// Host 的 `protocolEra`。内核的客户端固定说 MCP `2025-06-18`（[`PROTOCOL_VERSION`]），
/// 所以连上的服务器都是 `legacy`；`modern` 给将来的 `2026-07-28` 面保留。
///
/// [`PROTOCOL_VERSION`]: https://modelcontextprotocol.io
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpProtocolEra {
    Legacy,
    Modern,
}

/// 进行中的 OAuth 授权（Host 的 `authorization`；只有 `type: "oauth_authorization_code"` 一种）。
/// 内核不实现 OAuth，协议层不会写这个字段；类型留在这里是为了 Host 的封闭 schema 有落点。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthorizationSnapshot {
    pub authorization_url: String,
    /// 授权开始时刻（Unix 毫秒；协议层写成 ISO）。
    pub started_at_ms: u64,
}

/// 一个服务器的状态快照（Host `nibiMcpServerStatusSnapshotSchema` 的字段全集）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    /// 配置里的服务器名（未规范化）。
    pub name: String,
    pub status: McpServerStatusKind,
    pub transport: McpTransportKind,
    /// 已连接时服务器列出的工具数；其他状态是 0。
    pub tool_count: usize,
    /// 状态最后一次变化的时刻（Unix 毫秒）。连接中/已连接/失败/停用都算。
    pub updated_at_ms: u64,
    /// 失败原因（给用户看的文本）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<McpFailureKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_era: Option<McpProtocolEra>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization: Option<McpAuthorizationSnapshot>,
}

impl McpServerStatus {
    /// 配置里存在、但连接管理里还没有条目（从没连过）的快照：`disconnected`。
    /// 这是 `mode: "status"` 下对「状态进程还没连它」的如实回答。
    pub fn disconnected(
        name: &str,
        transport: McpTransportKind,
        updated_at_ms: u64,
    ) -> Self {
        Self {
            name: name.to_owned(),
            status: McpServerStatusKind::Disconnected,
            transport,
            tool_count: 0,
            updated_at_ms,
            error: None,
            failure_kind: None,
            server_request_id: None,
            protocol_era: None,
            authorization: None,
        }
    }

    /// 带 `oauth` 的服务器：内核不实现授权流，如实报失败（别的服务器照常连）。
    pub fn oauth_unsupported(name: &str, transport: McpTransportKind, updated_at_ms: u64) -> Self {
        Self {
            name: name.to_owned(),
            status: McpServerStatusKind::Failed,
            transport,
            tool_count: 0,
            updated_at_ms,
            error: Some(
                "OAuth authorization is not implemented by the Rust kernel; \
                 this server is not connected"
                    .to_owned(),
            ),
            failure_kind: Some(McpFailureKind::OauthAuthorizationFailed),
            server_request_id: None,
            protocol_era: None,
            authorization: None,
        }
    }
}

/// `mcp/list` 的一次请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpListRequest {
    pub workspace: WorkspaceRef,
    /// Host 显式下发的服务器集合（UI 解析出来的那一份）。
    ///
    /// - `None`：用进程自己从配置与插件读到的集合（Node 的 `createConfig` 路径）。
    /// - `Some(vec![])`：收敛到空集合（全部断开）——Host 明确下发空列表就是「没有启用的服务器」。
    pub servers: Option<Vec<SessionMcpServer>>,
    /// `true` 是 `connect`（收敛 + 等连接落定），`false` 是 `status`（只读快照）。
    pub connect: bool,
}

#[cfg(test)]
#[path = "mcp_status_tests.rs"]
mod tests;

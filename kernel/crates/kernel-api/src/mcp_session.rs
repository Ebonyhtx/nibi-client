//! 随会话创建的 MCP 服务器（NIBI 协议 `createSession.mcpServers`）。
//!
//! 与配置文件里的 MCP 不同：这批服务器属于**一个会话**，由 Host 在创建会话时给出（用户设置里启用的
//! MCP、插件的 MCP、动态解析出的产品服务器如 CUA broker / 云端项目），内核不能从本机配置推断。
//! Node 实现的语义是"创建期配置"：会话的工具表就是这批服务器；替代进程级配置（pool 的 lease 模型）。
//!
//! 类型放在 kernel-api：协议前端只依赖它，具体连接由 ext 的 `McpManager` 实现（每个会话一套连接）。

use serde::{Deserialize, Serialize};

use crate::mcp::McpTransportConfig;

/// 跨会话复用的规则（NIBI 协议的 `isolation`）。缺省是 `session`：每个会话自己一条连接。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpIsolation {
    /// 只属于这个会话（缺省；NIBI 协议与 Node pool 的缺省）。
    #[default]
    Session,
    /// 同一工作区共享（无状态服务器）：同一工作区里配置相同的服务器只有一条连接，按会话引用计数，
    /// 最后一个会话关闭时释放（Node `pool.ts` 的 `connectionKey()`）。
    Workspace,
}

/// 一个会话级的 MCP 服务器。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMcpServer {
    /// 服务器名（`mcp__<name>__<tool>` 里的 `<name>`）。
    pub name: String,
    pub transport: McpTransportConfig,
    /// 工具都不延迟（NIBI 协议的 `alwaysLoad`）。
    #[serde(default)]
    pub always_load: bool,
    /// 连接、调用与资源读取的期限（NIBI 协议的 `timeoutMs`）；None 用进程缺省。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// 跨会话复用（见 [`McpIsolation`]）。
    #[serde(default)]
    pub isolation: McpIsolation,
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn a_stdio_server_round_trips_with_defaults() {
        let server = SessionMcpServer {
            name: "files".into(),
            transport: McpTransportConfig::Stdio {
                command: "node".into(),
                args: vec!["server.js".into()],
                env: BTreeMap::from([("K".to_owned(), "V".to_owned())]),
                cwd: None,
            },
            always_load: false,
            timeout_ms: None,
            isolation: McpIsolation::Session,
        };
        let text = serde_json::to_value(&server).unwrap();
        // 缺省值不写进序列化：协议里 `isolation` 缺席就是 session。
        assert_eq!(text["isolation"], serde_json::json!("session"));
        assert!(text.get("timeout_ms").is_none());
        let back: SessionMcpServer = serde_json::from_value(text).unwrap();
        assert_eq!(back, server);
    }

    #[test]
    fn an_http_server_reads_headers_and_workspace_isolation() {
        let text = serde_json::json!({
            "name": "cloud",
            "transport": {"type": "http", "url": "https://example.invalid/mcp",
                          "headers": {"Authorization": "Bearer t"}},
            "isolation": "workspace",
            "timeoutMs": 5000
        });
        let server: SessionMcpServer = serde_json::from_value(text).unwrap();
        assert_eq!(server.isolation, McpIsolation::Workspace);
        assert_eq!(server.timeout_ms, Some(5000));
        assert!(!server.always_load);
    }
}

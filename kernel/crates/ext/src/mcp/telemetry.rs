//! MCP 进程遥测的出口（141 审计 §9 F3，`process/mcpTelemetry`）。
//!
//! 三类事件（`process_start` / `process_crash` / `session_startup`）在这里成形：身份（`mcpId`）用
//! [`nibi_kernel_api::mcp_telemetry`] 的编码，事件经通道交给协议层（另一头是
//! `process/mcpTelemetry` 通知）。没有通道时（TUI、测试）什么都不做。
//!
//! `memory` 那类事件不产生：五分钟资源采样（`process/mcpResourceSamples`）已经取代它，Node 的
//! bootstrap 也不再把它发上协议。
//!
//! 与 Node 的一处已知差异：Host schema 允许空 `exitCode` / `signal`，而 Rust 的传输层只知道「进程
//! 自己退出了」，拿不到退出码与信号，所以如实报 `null`。

use std::sync::Arc;

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::mcp_telemetry::{
    McpProcessIdentity, McpTelemetryEvent, mcp_id, resolve_source,
};
use nibi_kernel_api::process_table::{node_arch, node_platform};
use tokio::sync::mpsc::UnboundedSender;

/// 一个 manager 的遥测出口：通道 + 加盐用的设备标识（`NIBI_TELEMETRY_DEVICE_MID`）。
#[derive(Debug)]
pub struct McpTelemetry {
    sink: UnboundedSender<McpTelemetryEvent>,
    salt: String,
}

impl McpTelemetry {
    /// `salt` 为空时退回进程级随机串：同一进程内稳定，跨进程不可关联（Node 退回 `traceId` 的同一姿态）。
    pub fn new(sink: UnboundedSender<McpTelemetryEvent>, salt: String) -> Arc<Self> {
        let salt = if salt.trim().is_empty() {
            format!("{:016x}{:016x}", nibi_kernel_base::random::u64(), nibi_kernel_base::random::u64())
        } else {
            salt
        };
        Arc::new(Self { sink, salt })
    }

    /// 一次进程启动的身份（`mcpId` + 实例标识 + 启动时刻）。
    pub fn identity(
        &self,
        server_name: &str,
        plugin_scope: bool,
        started_at_ms: u64,
    ) -> McpProcessIdentity {
        let source = resolve_source(server_name, plugin_scope);
        McpProcessIdentity {
            mcp_id: mcp_id(server_name, source, &self.salt),
            instance_id: nibi_kernel_api::process_table::uuid_v4(),
            started_at_ms,
        }
    }

    pub fn process_started(
        &self,
        server_name: &str,
        plugin_scope: bool,
        isolation: &str,
        identity: &McpProcessIdentity,
        occurred_at: u64,
    ) {
        let source = resolve_source(server_name, plugin_scope);
        self.emit(McpTelemetryEvent::ProcessStart {
            arch: node_arch().to_owned(),
            occurred_at,
            platform: node_platform().to_owned(),
            mcp_id: identity.mcp_id.clone(),
            mcp_instance_id: identity.instance_id.clone(),
            mcp_isolation: isolation.to_owned(),
            mcp_source: source.as_str().to_owned(),
        });
    }

    pub fn process_crashed(
        &self,
        server_name: &str,
        plugin_scope: bool,
        isolation: &str,
        identity: &McpProcessIdentity,
        affected_session_count: u32,
        occurred_at: u64,
    ) {
        let source = resolve_source(server_name, plugin_scope);
        self.emit(McpTelemetryEvent::ProcessCrash {
            affected_session_count,
            arch: node_arch().to_owned(),
            // 传输层只知道「进程退出了」：退出码与信号如实缺席。
            exit_code: None,
            occurred_at,
            platform: node_platform().to_owned(),
            signal: None,
            uptime_ms: occurred_at.saturating_sub(identity.started_at_ms),
            mcp_id: identity.mcp_id.clone(),
            mcp_instance_id: identity.instance_id.clone(),
            mcp_isolation: isolation.to_owned(),
            mcp_source: source.as_str().to_owned(),
        });
    }

    pub fn session_startup(
        &self,
        session: &SessionId,
        configured_count: u32,
        connected_count: u32,
        process_count: u32,
        occurred_at: u64,
    ) {
        self.emit(McpTelemetryEvent::SessionStartup {
            arch: node_arch().to_owned(),
            configured_count,
            connected_count,
            failed_count: configured_count.saturating_sub(connected_count),
            occurred_at,
            platform: node_platform().to_owned(),
            process_count,
            session_id: session.as_str().to_owned(),
        });
    }

    /// 遥测是旁路：通道关了（进程在退出）只丢事件，不影响 MCP 生命周期。
    fn emit(&self, event: McpTelemetryEvent) {
        let _ = self.sink.send(event);
    }
}

/// 入口给 ext 的遥测设置：通道 + 加盐用的设备标识。
#[derive(Debug, Clone)]
pub struct McpTelemetrySetup {
    pub sink: UnboundedSender<McpTelemetryEvent>,
    pub id_salt: String,
}

/// 一个 manager 的遥测设置：出口 + 隔离口径 + 会话（只有会话级 manager 有）。
pub struct McpTelemetrySlot {
    pub telemetry: Arc<McpTelemetry>,
    /// `workspace`（进程级配置）或 `session`（NIBI `createSession.mcpServers`）。
    pub isolation: &'static str,
    pub session: Option<SessionId>,
}

//! App 协议的前端（docs/specs/rust-cli/app-protocol.md §3.4）：Host 经 stdio 驱动的 V4 方法、命令、三种主题与 Host
//! 还在调用的旧方法。与 tui、headless 同层：只经内核的会话 API 与平台层，协议的机制在 protocol-core。
//!
//! 入口（cli 的 `app-server --stdio`）的顺序：[`connection::start`](nibi_kernel_protocol_core::connection::start) 起写者，
//! [`Context::new`]；马上 [`Startup::checking`]（Host 要求 30 s 内有首帧）；用 [`HostHeaders`] 组装平台层与内核；
//! [`Startup::ready`] 或 [`Startup::failed`]；最后 [`serve`] 读到 Host 关掉输入。

mod commands;
mod conversation_intent;
mod conversation_telemetry;
pub mod context;
mod generate_text;
mod model_connectivity;
pub mod headers;
mod hook_review;
mod inbound;
mod inbox;
mod index;
mod legacy;
mod legacy_session;
mod legacy_snapshot;
mod live;
mod local_ttft;
mod mcp_rpc;
mod nibi_commands;
mod nibi_workflows;
mod plugin_ui;
mod skill_catalog;
mod projection;
mod row_target;
mod runtime_preferences;
mod server;
mod session_debug;
mod session_directory;
mod subscribe;
mod subagents_rpc;
pub mod telemetry;
pub mod topic;
mod attachment_rpc;
mod attachment_upload;
pub mod browser;
mod v4_queries;
mod wire;
mod workflow_settings_turn;

use std::sync::Arc;

use nibi_kernel_base::Spawner;
use nibi_kernel_api::session_api::Kernel;
use nibi_kernel_protocol_core::connection::{self, Options, Peer};
use serde_json::json;
use tokio::io::AsyncBufRead;

pub use context::Context;
pub use headers::HostHeaders;
pub use topic::HostTopic;
pub use server::Defaults;

/// 存储的启动状态（`startup/storageState`，`zcodeStorageStartupStateSchema`）：checking → ready / failed。迁移与备份只由
/// Node 的存储准备 Worker 做，这里只报本进程打开会话库的结果。
pub struct Startup {
    context: Arc<Context>,
    attempt: String,
    database: String,
    sequence: std::sync::atomic::AtomicU64,
    started: u64,
}

pub const STORAGE_STATE: &str = "startup/storageState";

impl Startup {
    /// `database` 是不带路径与凭据的不透明 ID（同一个进程里不变）。
    pub fn new(context: Arc<Context>, database: impl Into<String>) -> Self {
        Self {
            attempt: context.fresh("attempt"),
            started: context.now(),
            context,
            database: database.into(),
            sequence: std::sync::atomic::AtomicU64::new(0),
        }
    }

    async fn send(&self, phase: &str, error: Option<&str>) {
        let sequence = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        let mut state = json!({
            "schemaVersion": 1,
            "attemptId": self.attempt,
            "sequence": sequence,
            "databaseId": self.database,
            "databaseKind": "session",
            "phase": phase,
            "elapsedMs": self.context.now().saturating_sub(self.started),
        });
        if let Some(code) = error {
            state["errorCode"] = json!(code);
        }
        self.context.peer.notify(STORAGE_STATE, &state).await;
    }

    pub async fn checking(&self) {
        self.send("checking", None).await;
    }

    pub async fn ready(&self) {
        self.send("ready", None).await;
    }

    /// `code` 是 `databaseStartupErrorCodeSchema` 的值（例如 `open_failed`、`unsupported_runtime`）。
    pub async fn failed(&self, code: &str) {
        self.send("failed", Some(code)).await;
    }
}

/// 读循环：处理 Host 的请求直到它关掉输入。
pub async fn serve<R>(
    reader: R,
    context: Arc<Context>,
    kernel: Arc<dyn Kernel>,
    defaults: Defaults,
    spawner: Spawner,
    options: Options,
) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
{
    serve_with_capture(
        reader,
        context,
        kernel,
        defaults,
        spawner,
        options,
        telemetry::TelemetryPorts::default(),
    )
    .await
}

/// 同 [`serve`]，另给网络捕获的运行时（入口把观察者装到 `Egress` 之后传进来）与 Bash 资源事实的通道
/// （入口把它另一头的发送端交给了执行环境）。
pub async fn serve_with_capture<R>(
    reader: R,
    context: Arc<Context>,
    kernel: Arc<dyn Kernel>,
    defaults: Defaults,
    spawner: Spawner,
    options: Options,
    ports: telemetry::TelemetryPorts,
) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
{
    let peer: Peer = context.peer.clone();
    let telemetry::TelemetryPorts {
        capture,
        tool_exec,
        mcp_events,
        mcp_resource,
        mcp_ui_events,
    } = ports;
    let server = Arc::new(server::Server::new(
        context,
        kernel,
        spawner.clone(),
        defaults,
        capture.clone(),
    ));
    // Host 侧的 stdio 服务：冷打开会话时问一轮启动偏好（`session/requestRuntimePreferences`）。
    server.request_host_preferences();
    if let Some(capture) = capture {
        // 攒批任务与服务器同生共死（作用域关闭时结束）。
        // 任务跟着 spawner 的作用域走；句柄不用。
        std::mem::drop(capture.start());
    }
    if let Some(channel) = tool_exec {
        // 执行环境的 Bash 事实 → `process/toolExecResource`（141 审计 §9 F3）。
        std::mem::drop(channel.forward(server.context.clone(), &spawner));
    }
    if let Some(events) = mcp_events {
        // MCP 生命周期事实 → `process/mcpTelemetry`。
        telemetry::forward_mcp_events(server.context.clone(), &spawner, events);
    }
    if let Some(events) = mcp_ui_events {
        // MCP Apps 的资源通知与实例关闭 → 会话的 `pluginUi.*` 增量（141 审计 §9 第 6 项）。
        plugin_ui::forward(server.clone(), &spawner, events);
    }
    if let Some(resource) = mcp_resource {
        // 五分钟 MCP 资源采样 → `process/mcpResourceSamples`。
        std::mem::drop(telemetry::start_mcp_resource_sampler(
            server.context.clone(),
            server.kernel.clone(),
            resource,
            &spawner,
        ));
    }
    connection::serve(
        reader,
        peer,
        Arc::new(server::Handler(server)),
        spawner,
        options,
    )
    .await
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "subagents_debug_tests.rs"]
mod subagents_debug_tests;

#[cfg(test)]
#[path = "session_directory_tests.rs"]
mod session_directory_tests;

#[cfg(test)]
#[path = "auto_resolution_tests.rs"]
mod auto_resolution_tests;

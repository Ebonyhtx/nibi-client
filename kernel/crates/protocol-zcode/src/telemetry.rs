//! 进程遥测（141 审计 §9 F3）：`process/resourceSample` 与 `process/networkCapture|networkRequests`。
//!
//! **资源样本**：一个挂在 [`Server`](crate::server::Server) 上的定时任务，每
//! [`RESOURCE_SAMPLE_INTERVAL`] 采一拍本进程的 CPU/内存并发一条通知。Node 的
//! `startProtocolResourceSampler` 是同一件事：60 秒节拍、第一拍只建基线、采样失败只丢当前样本。
//! 为什么在内核而不是 Host：`process.memoryUsage()` / `getrusage` 量的是**CLI 进程自己**，切到
//! Rust 内核后那个进程就是内核，Host 采不到。桌面资源面板的 `cli_chat` 泳道读的就是这条。
//!
//! **网络捕获**：Host 用 `process/networkCapture` 开/关（`{captureId}`，`null` 是关），CLI 把攒下的
//! 请求批次经 `process/networkRequests` 送回去。攒批在 [`Capture`] 里，出站请求从
//! [`Egress`](rust_cli_net::Egress) 的观察者进来自动记。

use std::sync::{Arc, Weak};
use std::time::Duration;

use rust_cli_base::{Spawner, Task};
use rust_cli_kernel_api::mcp_telemetry::McpTelemetryEvent;
use rust_cli_kernel_api::process_metrics::ProcessMetrics;
use rust_cli_kernel_api::process_table::{MCP_RESOURCE_SAMPLE_INTERVAL, McpResourceSampler, ProcessSampler};
use rust_cli_kernel_api::session_api::Kernel;
use rust_cli_kernel_api::network_capture::{CaptureState, NetworkCapture};
use rust_cli_net::EgressObserver;
use rust_cli_kernel_api::process_metrics::{ResourceSampler, RESOURCE_SAMPLE_INTERVAL};

use crate::context::Context;

/// 通知方法名（Host `nibiProtocolNotifications.processResourceSample`）。
pub const RESOURCE_SAMPLE: &str = "process/resourceSample";
/// Host 开/关网络捕获（`nibiProtocolMethods.processNetworkCapture`）。
pub const NETWORK_CAPTURE: &str = "process/networkCapture";
/// CLI 送回请求批次（`nibiProtocolNotifications.processNetworkRequests`）。
pub const NETWORK_REQUESTS: &str = "process/networkRequests";

/// Bash 命令的资源事实（Host `nibiProtocolNotifications.toolExecResource`）。
pub const TOOL_EXEC_RESOURCE: &str = "process/toolExecResource";
/// MCP 进程的生命周期事件（Host `nibiProtocolNotifications.mcpTelemetry`）。
pub const MCP_TELEMETRY: &str = "process/mcpTelemetry";
/// MCP 子进程的五分钟资源样本（Host `nibiProtocolNotifications.mcpResourceSamples`）。
pub const MCP_RESOURCE_SAMPLES: &str = "process/mcpResourceSamples";

/// 入口接给协议层的遥测端口（141 审计 §9 F3）。
#[derive(Default)]
pub struct TelemetryPorts {
    /// 网络捕获（`process/networkCapture` → `process/networkRequests`）。
    pub capture: Option<Arc<Capture>>,
    /// Bash 命令的资源事实（`process/toolExecResource`）。
    pub tool_exec: Option<ToolExecChannel>,
    /// MCP 进程的生命周期事件（`process/mcpTelemetry`）。
    pub mcp_events: Option<tokio::sync::mpsc::UnboundedReceiver<McpTelemetryEvent>>,
    /// MCP 五分钟资源采样的读数端与本机事实：两个都给才起采样任务。
    pub mcp_resource: Option<McpResourcePorts>,
}

/// `process/mcpResourceSamples` 需要的东西：进程表读数与本机事实（平台、核数、内存总量）。
pub struct McpResourcePorts {
    pub sampler: Arc<dyn ProcessSampler>,
    pub metrics: Arc<dyn ProcessMetrics>,
}

/// 把 MCP 生命周期事件转成通知（通道关闭时任务结束）。
pub fn forward_mcp_events(
    context: Arc<Context>,
    spawner: &Spawner,
    mut events: tokio::sync::mpsc::UnboundedReceiver<McpTelemetryEvent>,
) {
    std::mem::drop(spawner.spawn("mcp-telemetry", async move {
        while let Some(event) = events.recv().await {
            if let Ok(params) = serde_json::to_value(&event) {
                context.peer.notify(MCP_TELEMETRY, &params).await;
            }
        }
    }));
}

/// 五分钟 MCP 资源采样（141 审计 §9 F3）：每个 stdio 子进程的进程树 → 按 `mcpId` 分组的样本。
///
/// 与 Node 的 `createMcpResourceTelemetry` 同一条口径：没有目标进程时清基线（下一拍的间隔回到 5 分钟），
/// 整次采样失败也清基线（不能把跨失败窗口的 CPU 算成均值）。
pub fn start_mcp_resource_sampler(
    context: Arc<Context>,
    kernel: Arc<dyn Kernel>,
    ports: McpResourcePorts,
    spawner: &Spawner,
) -> Task<()> {
    start_mcp_resource_sampler_with_interval(
        context,
        kernel,
        ports,
        spawner,
        MCP_RESOURCE_SAMPLE_INTERVAL,
    )
}

/// 同 [`start_mcp_resource_sampler`]，节拍可注入（测试用）。
pub fn start_mcp_resource_sampler_with_interval(
    context: Arc<Context>,
    kernel: Arc<dyn Kernel>,
    ports: McpResourcePorts,
    spawner: &Spawner,
    interval: Duration,
) -> Task<()> {
    spawner.spawn("mcp-resource-sampler", async move {
        let metrics = &ports.metrics;
        let mut state = McpResourceSampler::new(
            metrics.platform(),
            metrics.arch(),
            metrics.logical_cpu_count(),
            metrics
                .total_memory_bytes()
                .map(|bytes| bytes / (1024 * 1024 * 1024))
                .unwrap_or(0),
        );
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // 第一个 tick 立即到期；Node 的第一个样本在 5 分钟之后。
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let targets = kernel.mcp_resource_targets().await;
            if targets.is_empty() {
                state.clear();
                continue;
            }
            let roots: Vec<u32> = targets.iter().map(|target| target.pid).collect();
            let Some(trees) = ports.sampler.sample_trees(&roots).await else {
                state.clear();
                continue;
            };
            let samples = state.sample(&targets, &trees, context.clock.now_ms());
            if samples.is_empty() {
                continue;
            }
            if let Ok(params) = serde_json::to_value(&samples) {
                context.peer.notify(MCP_RESOURCE_SAMPLES, &params).await;
            }
        }
    })
}

/// 入口接给执行环境的 Bash 事实通道（141 审计 §9 F3）。
///
/// 生产者在 `env-local`（它知道进程组 pid 与终态），消费者在这里：转发成 `process/toolExecResource`。
/// 用通道而不是让执行环境直接发通知：执行环境不认识协议，也不该认识。
pub struct ToolExecChannel {
    records: tokio::sync::mpsc::UnboundedReceiver<
        rust_cli_kernel_api::process_table::ToolExecResource,
    >,
}

impl ToolExecChannel {
    /// 一对（发送端交给 `LocalEnvironment::with_tool_telemetry`）。
    pub fn channel() -> (
        tokio::sync::mpsc::UnboundedSender<rust_cli_kernel_api::process_table::ToolExecResource>,
        Self,
    ) {
        let (sender, records) = tokio::sync::mpsc::unbounded_channel();
        (sender, Self { records })
    }
}

/// 起的采样任务；任务跟着作用域走（作用域关闭时它在等待点上结束）。
pub struct ResourceTelemetry {
    task: Task<()>,
}

impl ResourceTelemetry {
    /// 起一个 60 秒节拍的采样任务。`metrics` 是平台读数（入口按平台给），`spawner` 是进程根作用域。
    pub fn start(
        context: Arc<Context>,
        metrics: Arc<dyn ProcessMetrics>,
        spawner: &Spawner,
    ) -> Self {
        Self::start_with_interval(context, metrics, spawner, RESOURCE_SAMPLE_INTERVAL)
    }

    /// 同 [`start`](Self::start)，节拍可注入（测试用）。
    pub fn start_with_interval(
        context: Arc<Context>,
        metrics: Arc<dyn ProcessMetrics>,
        spawner: &Spawner,
        interval: Duration,
    ) -> Self {
        let task = spawner.spawn("process-resource-sampler", async move {
            let mut sampler = ResourceSampler::new();
            // 第一拍只建基线（Node 同样跳过第一拍）：先采一次再进循环。
            sampler.sample(metrics.as_ref());
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // 第一次 tick 立即到期：上面刚采过基线，跳过它。
            ticker.tick().await;
            loop {
                ticker.tick().await;
                // 采样失败只丢当前样本：`sample` 自己吞掉读不到的情况。
                if let Some(sample) = sampler.sample(metrics.as_ref())
                    && let Ok(params) = serde_json::to_value(&sample)
                {
                    context.peer.notify(RESOURCE_SAMPLE, &params).await;
                }
            }
        });
        Self { task }
    }

    /// 停掉采样（进程退出或测试收尾）。
    pub fn stop(self) {
        self.task.abort();
    }
}

impl ToolExecChannel {
    /// 把执行环境送来的事实转成通知（通道关闭时任务结束）。
    pub fn forward(self, context: Arc<Context>, spawner: &Spawner) -> Task<()> {
        let mut records = self.records;
        spawner.spawn("tool-exec-telemetry", async move {
            while let Some(fact) = records.recv().await {
                if let Ok(params) = serde_json::to_value(&fact) {
                    context.peer.notify(TOOL_EXEC_RESOURCE, &params).await;
                }
            }
        })
    }
}

/// 网络捕获的运行时：状态 + 出站请求的观察者 + 攒批任务。
///
/// `process/networkCapture` 到了就换 captureId（`null` 是关）；开着时每条出站请求记一条，
/// 250 ms 后（或满 100 条时立即）发一批 `process/networkRequests`。
pub struct Capture {
    state: Arc<NetworkCapture>,
    context: Arc<Context>,
    spawner: Spawner,
    flush_pending: Arc<tokio::sync::Notify>,
}

impl Capture {
    pub fn new(context: Arc<Context>, spawner: &Spawner) -> Arc<Self> {
        Arc::new(Self {
            state: Arc::new(NetworkCapture::default()),
            context,
            spawner: spawner.clone(),
            flush_pending: Arc::new(tokio::sync::Notify::new()),
        })
    }

    /// 装上出站观察者（`Egress::observe`）。
    pub fn observer(self: &Arc<Self>) -> Option<Arc<dyn EgressObserver>> {
        Some(Arc::new(CaptureObserver {
            state: Arc::downgrade(&self.state),
            flush: self.flush_pending.clone(),
            clock: self.context.clock.clone(),
        }))
    }

    /// 起攒批任务（进程生命周期内一直跑）。
    pub fn start(self: &Arc<Self>) -> Task<()> {
        let capture = self.clone();
        self.spawner.spawn("network-capture-flush", async move {
            loop {
                // 开捕获时才有批次可发：每 250 ms 醒一次（Node 的 `setTimeout(flush, 250)`）。
                tokio::select! {
                    _ = capture.flush_pending.notified() => {}
                    _ = tokio::time::sleep(Duration::from_millis(
                        rust_cli_kernel_api::network_capture::CAPTURE_FLUSH_MS,
                    )) => {}
                }
                let batch = capture.state.with(CaptureState::take_batch);
                if let Some(batch) = batch
                    && let Ok(params) = serde_json::to_value(&batch)
                {
                    capture.context.peer.notify(NETWORK_REQUESTS, &params).await;
                }
            }
        })
    }

    /// `process/networkCapture`：`{captureId}`，`null` 是关。返回是否是合法形状。
    pub fn control(&self, params: &serde_json::Value) -> bool {
        let Some(capture_id) = params.get("captureId") else {
            return false;
        };
        match capture_id {
            serde_json::Value::Null => {
                self.state.with(|state| state.set_capture_id(None));
                true
            }
            serde_json::Value::String(id) if !id.is_empty() && id.len() <= 100 => {
                self.state
                    .with(|state| state.set_capture_id(Some(id.clone())));
                true
            }
            _ => false,
        }
    }
}

/// 出站请求 → 捕获状态。`Egress` 在每条请求发出前调它。
struct CaptureObserver {
    state: Weak<NetworkCapture>,
    flush: Arc<tokio::sync::Notify>,
    /// 记录的 `timestamp` 取注入的时钟（与其余遥测同源）。
    clock: Arc<dyn rust_cli_kernel_api::clock::Clock>,
}

impl EgressObserver for CaptureObserver {
    fn request(&self, method: &str, url: &str) {
        let Some(state) = self.state.upgrade() else {
            return;
        };
        // 没开捕获时这里什么都不做（`record` 自己判）；满一批就提醒攒批任务立即冲。
        let now = self.clock.now_ms();
        let full = state.with(|state| state.record(now, std::process::id(), method, url));
        if full {
            self.flush.notify_one();
        }
    }
}

#[cfg(test)]
#[path = "telemetry_tests.rs"]
mod tests;

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
use rust_cli_kernel_api::network_capture::{CaptureState, NetworkCapture};
use rust_cli_net::EgressObserver;
use rust_cli_kernel_api::process_metrics::{ProcessMetrics, ResourceSampler, RESOURCE_SAMPLE_INTERVAL};

use crate::context::Context;

/// 通知方法名（Host `nibiProtocolNotifications.processResourceSample`）。
pub const RESOURCE_SAMPLE: &str = "process/resourceSample";
/// Host 开/关网络捕获（`nibiProtocolMethods.processNetworkCapture`）。
pub const NETWORK_CAPTURE: &str = "process/networkCapture";
/// CLI 送回请求批次（`nibiProtocolNotifications.processNetworkRequests`）。
pub const NETWORK_REQUESTS: &str = "process/networkRequests";

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

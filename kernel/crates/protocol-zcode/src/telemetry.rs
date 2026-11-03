//! 进程资源遥测的发送端（141 审计 §9 F3）：`process/resourceSample`。
//!
//! 一个挂在 [`Server`](crate::server::Server) 上的定时任务，每 [`RESOURCE_SAMPLE_INTERVAL`] 采一拍
//! 本进程的 CPU/内存并发一条通知。Node 的 `startProtocolResourceSampler` 是同一件事：60 秒节拍、
//! 第一拍只建基线、采样失败只丢当前样本。
//!
//! 为什么在内核而不是 Host：`process.memoryUsage()` / `getrusage` 量的是**CLI 进程自己**，
//! 切到 Rust 内核后那个进程就是内核，Host 采不到。桌面资源面板的 `cli_chat` 泳道读的就是这条。

use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::{Spawner, Task};
use rust_cli_kernel_api::process_metrics::{ProcessMetrics, ResourceSampler, RESOURCE_SAMPLE_INTERVAL};

use crate::context::Context;

/// 通知方法名（Host `nibiProtocolNotifications.processResourceSample`）。
pub const RESOURCE_SAMPLE: &str = "process/resourceSample";

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

#[cfg(test)]
#[path = "telemetry_tests.rs"]
mod tests;

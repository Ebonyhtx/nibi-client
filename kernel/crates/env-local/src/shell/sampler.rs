//! Bash 命令的资源采样（141 审计 §9 F3，`process/toolExecResource`）。
//!
//! Node 侧是 `createBashResourceTelemetry`（`apps/zcode-cli/packages/adapters/src/exec/
//! bash-resource-telemetry.ts`）：命令跑着的时候每 15 秒采一次进程组，结束时（且时长 ≥ 15 秒）
//! 报一条**完成事实**。采样挂在 Bash 已有的 1 秒进度轮询上；这里用同样的 1 秒节拍自己起一个任务，
//! 只在 [`BashResourceSampler::due`] 为真时真去读进程表。
//!
//! 为什么在执行环境而不是 Bash 工具：进程组的 pid 只有 `Ledger::spawn` 知道，终态只有监督任务知道；
//! 工具在后台命令返回后就不在了。放在这里，前台、后台、超时转后台三种结局都只产生一条事实。
//!
//! 读不到 CLI 自己的 RSS 或系统可用内存时整条事实不发（Node 的 `readContext` 抛错同样只丢通知）；
//! 遥测任何失败都不影响命令本身。

use std::sync::Arc;
use std::time::Duration;

use nibi_kernel_api::env::Outcome;
use nibi_kernel_api::process_table::{BashResourceSampler, ToolExecResource, ToolExitKind};
use tokio::sync::mpsc::UnboundedSender;

use super::Running;

/// 采样检查的节拍：与 Bash 的进度轮询同频（Node `DEFAULT_PROGRESS_INTERVAL_MS`）。
const POLL: Duration = Duration::from_secs(1);

/// 命令的终态换成事实里的退出类别（Node `finish` 的三元判断）。
pub(crate) fn exit_kind(finish: &super::Finish) -> ToolExitKind {
    if finish.timed_out {
        return ToolExitKind::Timeout;
    }
    match finish.outcome {
        // 取消（TaskStop、中断）与输出超限被结束时都是被结束的。
        Outcome::Cancelled | Outcome::Interrupted => ToolExitKind::Killed,
        Outcome::Failed { .. } | Outcome::Rejected { .. } => ToolExitKind::Error,
        // `Running` / `Unknown` 不会出现在终态里；按完成处理不夸大故障。
        Outcome::Completed | Outcome::Running | Outcome::Unknown => ToolExitKind::Completed,
    }
}

/// 跟着一条 Bash 命令采样，结束时把事实交给入口（`sink` 的另一头是协议层的通知任务）。
pub(crate) async fn watch(pid: u32, running: Arc<Running>, sink: UnboundedSender<ToolExecResource>) {
    let mut sampler = BashResourceSampler::new(running.started);
    let mut finished = running.finished.subscribe();
    // 任务起来之前命令就结束了（极短的命令）：直接按终态收尾，不要等下一次变化。
    let already = finished.borrow_and_update().clone();
    let mut ticker = tokio::time::interval(POLL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // 第一个 tick 立即到期；第一次真采样由 `due` 决定（15 秒后）。
    let finish = match already {
        Some(finish) => finish,
        None => loop {
        tokio::select! {
            _ = ticker.tick() => {
                let now = std::time::Instant::now();
                if !sampler.due(now) {
                    continue;
                }
                // 采样失败只丢这一拍（`None` 与空样本都算一次尝试）。
                if let Some(samples) = nibi_kernel_proc::resources::sample_process_group(pid).await {
                    let samples: Vec<nibi_kernel_api::process_table::ProcessSample> = samples
                        .into_iter()
                        .map(|sample| nibi_kernel_api::process_table::ProcessSample {
                            pid: sample.pid,
                            rss_kb: sample.rss_kb,
                            cpu_time_ms: sample.cpu_time_ms,
                        })
                        .collect();
                    sampler.observe(&samples, now);
                }
            }
            changed = finished.changed() => {
                if changed.is_err() {
                    return;
                }
                if let Some(finish) = finished.borrow_and_update().clone() {
                    break finish;
                }
            }
        }
        },
    };
    // 时长不到 15 秒的命令没有事实（`finish` 自己判）。
    let (Some(cli_rss_kb), Some(free_kb)) = (
        crate::process_metrics::current_rss_kb(),
        crate::process_metrics::free_memory_kb(),
    ) else {
        return;
    };
    if let Some(fact) = sampler.finish(
        std::time::Instant::now(),
        exit_kind(&finish),
        cli_rss_kb,
        free_kb,
    ) {
        // 接收方已经关掉（进程在退出）：丢通知，不影响命令。
        let _ = sink.send(fact);
    }
}

#[cfg(test)]
#[path = "sampler_tests.rs"]
mod tests;

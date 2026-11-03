//! `process/resourceSample` 的发送端（141 审计 §9 F3）：节拍、第一拍跳过、样本形状上线。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::process_metrics::{ProcessMetrics, ProcessUsage};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

use super::*;

/// 每次 `read` 都把 CPU 时间推进这么多微秒。
struct Advancing {
    user_us: AtomicU64,
    step_us: u64,
}

impl ProcessMetrics for Advancing {
    fn platform(&self) -> &'static str {
        "linux"
    }

    fn arch(&self) -> &'static str {
        "x64"
    }

    fn logical_cpu_count(&self) -> u32 {
        2
    }

    fn total_memory_bytes(&self) -> Option<u64> {
        Some(8 * 1024 * 1024 * 1024)
    }

    fn uptime_seconds(&self) -> Option<u64> {
        Some(300)
    }

    fn read(&self) -> Option<ProcessUsage> {
        let user = self.user_us.fetch_add(self.step_us, Ordering::Relaxed);
        Some(ProcessUsage {
            user_us: user,
            system_us: 0,
            rss_bytes: 64 * 1024 * 1024,
            heap_used_bytes: None,
        })
    }
}

/// 固定时钟（`Context` 只要 `now_ms` 与 `time_zone`）。
struct TestClock;

impl rust_cli_kernel_api::clock::Clock for TestClock {
    fn now_ms(&self) -> u64 {
        1_760_000_000_000
    }

    fn time_zone(&self) -> String {
        "Asia/Shanghai".to_owned()
    }
}

/// 起一个假的 Host：写者那头读回来的帧。
fn channel() -> (
    rust_cli_protocol_core::connection::Peer,
    tokio::io::DuplexStream,
    TaskScope,
) {
    let scope = TaskScope::root("telemetry-test", |_| {});
    let (host_side, cli_side) = tokio::io::duplex(1 << 16);
    let (peer, writer) = connection::start(cli_side, &scope.spawner(), Options::default());
    // writer 要活着，否则写队列直接关闭。
    std::mem::forget(writer);
    (peer, host_side, scope)
}

/// 节拍到了就发一条，样本形状是 Host schema 的字段（camelCase、实例标识不含 pid）。
#[tokio::test]
async fn the_sampler_sends_resource_samples() {
    let (peer, host_side, scope) = channel();
    let context = Arc::new(Context::new(peer, Arc::new(TestClock)));
    let metrics = Arc::new(Advancing {
        user_us: AtomicU64::new(0),
        // 100ms 的节拍里用掉 100ms CPU = 1 核。
        step_us: 100_000,
    });
    let telemetry = ResourceTelemetry::start_with_interval(
        context,
        metrics,
        &scope.spawner(),
        Duration::from_millis(100),
    );
    let mut reader = BufReader::new(host_side);
    let mut line = String::new();
    // 第一拍只建基线；第二条 tick 才会有样本。
    tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
        .await
        .expect("a frame within the timeout")
        .expect("a frame");
    telemetry.stop();
    let frame: Value = serde_json::from_str(&line).expect("a JSON frame");
    assert_eq!(frame["method"], "process/resourceSample");
    let params = &frame["params"];
    assert_eq!(params["platform"], "linux");
    assert_eq!(params["arch"], "x64");
    assert_eq!(params["logicalCpuCount"], 2);
    assert_eq!(params["rssKb"], 65_536.0);
    assert_eq!(params["uptimeMinutes"], 5);
    assert_eq!(params["totalMemoryGb"], 8);
    // 实例标识是 16 位十六进制（不含 pid 的形状）。
    let token = params["instanceToken"].as_str().expect("a token");
    assert_eq!(token.len(), 16);
    assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    // 可选字段读不到时不出现（原生进程没有 V8 堆）。
    assert!(params.get("heapUsedKb").is_none(), "{params}");
}

/// `stop` 之后不再发（任务被中止）。
#[tokio::test]
async fn stopping_the_sampler_stops_the_frames() {
    let (peer, host_side, scope) = channel();
    let context = Arc::new(Context::new(peer, Arc::new(TestClock)));
    let metrics = Arc::new(Advancing {
        user_us: AtomicU64::new(0),
        step_us: 100_000,
    });
    let telemetry = ResourceTelemetry::start_with_interval(
        context,
        metrics,
        &scope.spawner(),
        Duration::from_millis(50),
    );
    telemetry.stop();
    let mut reader = BufReader::new(host_side);
    let mut line = String::new();
    // 停了之后在三个节拍内不该有帧。
    let quiet = tokio::time::timeout(Duration::from_millis(250), reader.read_line(&mut line)).await;
    assert!(quiet.is_err(), "unexpected frame: {line}");
}

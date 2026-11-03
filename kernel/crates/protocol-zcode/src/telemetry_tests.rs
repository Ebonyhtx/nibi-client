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

/// `process/networkCapture` 开/关的语义（Host `networkCaptureControlSchema`）：`{captureId}` 开，
/// `null` 关，形状不对当没收到。
#[tokio::test]
async fn the_capture_control_follows_the_host_contract() {
    let (peer, _host, scope) = channel();
    let context = Arc::new(Context::new(peer, Arc::new(TestClock)));
    let capture = Capture::new(context, &scope.spawner());
    assert!(capture.control(&serde_json::json!({"captureId": "cap-1"})));
    assert_eq!(capture.state.with(|state| state.capture_id().map(str::to_owned)), Some("cap-1".to_owned()));
    assert!(capture.control(&serde_json::json!({"captureId": null})));
    assert!(capture.state.with(|state| state.capture_id().is_none()));
    // 形状不对：空串、超长、缺字段、非字符串。
    assert!(!capture.control(&serde_json::json!({"captureId": ""})));
    assert!(!capture.control(&serde_json::json!({"captureId": "x".repeat(101)})));
    assert!(!capture.control(&serde_json::json!({})));
    assert!(!capture.control(&serde_json::json!({"captureId": 7})));
}

/// 出站请求经观察者进来、攒批任务发出去：一批 `process/networkRequests`，记录带 pid 与脱敏 URL。
#[tokio::test]
async fn captured_requests_are_batched_to_the_host() {
    let (peer, host_side, scope) = channel();
    let context = Arc::new(Context::new(peer, Arc::new(TestClock)));
    let capture = Capture::new(context, &scope.spawner());
    let observer = capture.observer().expect("an observer");
    capture.start();
    capture.control(&serde_json::json!({"captureId": "cap-1"}));
    observer.request("GET", "https://example.com/a?secret=1");
    let mut reader = BufReader::new(host_side);
    let mut line = String::new();
    // 攒批窗口是 250 ms；给足余量。
    tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
        .await
        .expect("a frame within the timeout")
        .expect("a frame");
    let frame: Value = serde_json::from_str(&line).expect("a JSON frame");
    assert_eq!(frame["method"], "process/networkRequests");
    let params = &frame["params"];
    assert_eq!(params["captureId"], "cap-1");
    let records = params["records"].as_array().expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["method"], "GET");
    assert_eq!(records[0]["processType"], "cli");
    assert_eq!(records[0]["pid"], std::process::id());
    assert_eq!(
        records[0]["url"],
        "https://example.com/a?secret=%5Bredacted%5D"
    );
}

/// Bash 事实经通道变成 `process/toolExecResource`（141 审计 §9 F3）：字段原样上线，形状是 Host schema。
#[tokio::test]
async fn tool_exec_facts_become_notifications() {
    let (peer, host_side, scope) = channel();
    let context = Arc::new(Context::new(peer, Arc::new(TestClock)));
    let (sender, channel) = ToolExecChannel::channel();
    std::mem::drop(channel.forward(context, &scope.spawner()));
    let fact = rust_cli_kernel_api::process_table::ToolExecResource {
        completion_token: Some("00000000-0000-4000-a000-000000000000".to_owned()),
        platform: "linux".to_owned(),
        tool_name: "bash".to_owned(),
        duration_ms: 30_000,
        exit_kind: rust_cli_kernel_api::process_table::ToolExitKind::Completed,
        tree_rss_kb_peak: Some(2_048),
        tree_cpu_time_ms: Some(1_500),
        sample_count: 2,
        cli_rss_kb: 65_536,
        system_free_memory_kb: 1_048_576,
    };
    sender.send(fact).expect("the forwarder is alive");
    let mut reader = BufReader::new(host_side);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
        .await
        .expect("a frame within the timeout")
        .expect("a frame");
    let frame: Value = serde_json::from_str(&line).expect("a JSON frame");
    assert_eq!(frame["method"], "process/toolExecResource");
    let params = &frame["params"];
    assert_eq!(params["toolName"], "bash");
    assert_eq!(params["durationMs"], 30_000);
    assert_eq!(params["exitKind"], "completed");
    assert_eq!(params["sampleCount"], 2);
    assert_eq!(params["treeRssKbPeak"], 2_048);
    assert_eq!(params["cliRssKb"], 65_536);
}

/// 五分钟 MCP 资源采样：按 `mcpId` 分组的一条样本，经通道变成 `process/mcpResourceSamples`
/// （`params` 是数组，与 Host schema 一致）。
#[tokio::test]
async fn mcp_resource_samples_are_sent_to_the_host() {
    use std::collections::BTreeMap;

    use async_trait::async_trait;
    use rust_cli_kernel_api::process_table::{McpResourceTarget, ProcessSample, ProcessSampler};
    use rust_cli_kernel_api::session_api::{Kernel, KernelError, SessionHandle};
    use rust_cli_kernel_api::store::{SessionFilter, SessionSummary};

    struct FakeKernel;

    #[async_trait]
    impl Kernel for FakeKernel {
        async fn create_session(
            &self,
            _request: rust_cli_kernel_api::session_api::CreateSession,
        ) -> Result<rust_cli_kernel_api::ids::SessionId, KernelError> {
            Err(KernelError::Unsupported {
                what: "session creation".to_owned(),
            })
        }

        async fn list_sessions(
            &self,
            _filter: SessionFilter,
        ) -> Result<Vec<SessionSummary>, KernelError> {
            Ok(Vec::new())
        }

        async fn open_session(
            &self,
            _session: &rust_cli_kernel_api::ids::SessionId,
        ) -> Result<Arc<dyn SessionHandle>, KernelError> {
            Err(KernelError::Unsupported {
                what: "sessions".to_owned(),
            })
        }

        async fn mcp_resource_targets(&self) -> Vec<McpResourceTarget> {
            vec![McpResourceTarget {
                pid: 100,
                mcp_id: "plugin:aaaaaaaaaaaa".to_owned(),
                instance_id: "inst-1".to_owned(),
                started_at_ms: 1_759_999_000_000,
            }]
        }
    }

    struct FakeSampler;

    #[async_trait]
    impl ProcessSampler for FakeSampler {
        fn tree_scope(&self) -> &'static str {
            "process_tree"
        }

        async fn sample_group(&self, _pgid: u32) -> Option<Vec<ProcessSample>> {
            None
        }

        async fn sample_trees(
            &self,
            roots: &[u32],
        ) -> Option<BTreeMap<u32, Vec<ProcessSample>>> {
            Some(
                roots
                    .iter()
                    .map(|root| {
                        (
                            *root,
                            vec![ProcessSample {
                                pid: i32::try_from(*root).unwrap(),
                                rss_kb: 2_048,
                                cpu_time_ms: Some(50),
                            }],
                        )
                    })
                    .collect(),
            )
        }
    }

    struct FakeMetrics;

    impl ProcessMetrics for FakeMetrics {
        fn platform(&self) -> &'static str {
            "linux"
        }
        fn arch(&self) -> &'static str {
            "x64"
        }
        fn logical_cpu_count(&self) -> u32 {
            4
        }
        fn total_memory_bytes(&self) -> Option<u64> {
            Some(16 * 1024 * 1024 * 1024)
        }
        fn uptime_seconds(&self) -> Option<u64> {
            None
        }
        fn read(&self) -> Option<ProcessUsage> {
            None
        }
    }

    let (peer, host_side, scope) = channel();
    let context = Arc::new(Context::new(peer, Arc::new(TestClock)));
    let task = start_mcp_resource_sampler_with_interval(
        context,
        Arc::new(FakeKernel),
        McpResourcePorts {
            sampler: Arc::new(FakeSampler),
            metrics: Arc::new(FakeMetrics),
        },
        &scope.spawner(),
        Duration::from_millis(50),
    );
    let mut reader = BufReader::new(host_side);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
        .await
        .expect("a frame within the timeout")
        .expect("a frame");
    task.abort();
    let frame: Value = serde_json::from_str(&line).expect("a JSON frame");
    assert_eq!(frame["method"], "process/mcpResourceSamples");
    let params = frame["params"].as_array().expect("an array of samples");
    assert_eq!(params.len(), 1);
    let sample = &params[0];
    assert_eq!(sample["mcpId"], "plugin:aaaaaaaaaaaa");
    assert_eq!(sample["processCount"], 1);
    assert_eq!(sample["rssKbTotal"], 2_048);
    assert_eq!(sample["intervalMs"], 300_000);
    assert_eq!(sample["platform"], "linux");
    assert_eq!(sample["logicalCpuCount"], 4);
    assert_eq!(sample["totalMemoryGb"], 16);
    let token = sample["instanceToken"].as_str().expect("a token");
    assert_eq!(token.len(), 16);
}

/// 没开捕获时观察者什么都不发。
#[tokio::test]
async fn requests_are_not_captured_while_the_capture_is_off() {
    let (peer, host_side, scope) = channel();
    let context = Arc::new(Context::new(peer, Arc::new(TestClock)));
    let capture = Capture::new(context, &scope.spawner());
    let observer = capture.observer().expect("an observer");
    capture.start();
    observer.request("GET", "https://example.com/a");
    let mut reader = BufReader::new(host_side);
    let mut line = String::new();
    let quiet = tokio::time::timeout(Duration::from_millis(400), reader.read_line(&mut line)).await;
    assert!(quiet.is_err(), "unexpected frame: {line}");
}

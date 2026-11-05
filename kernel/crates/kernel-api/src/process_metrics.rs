//! 进程资源遥测（141 审计 §9 F3）：`process/resourceSample` 的样本形状与采样端口。
//!
//! Node 侧是 `createNIBIProcessResourceSampler`（`apps/zcode-cli/packages/bootstrap/src/
//! process-resource-sampler.ts`），每 60 秒报一条本进程的 CPU/内存样本；桌面资源面板的主数据源。
//!
//! 这里是**端口**而不是实现：采样要读本机进程指标（`getrusage` / `GetProcessMemoryInfo`），
//! 只有入口 crate 知道自己在哪个平台上跑。协议层只负责按节拍调它、把结果写上线。
//!
//! 语义与 Node 一致的三条：
//!
//! - **CPU 是两次采样的差分**，不是累计值：`cpuCores` = ΔCPU 时间 / Δ墙钟，`cpuPercent` 再除以逻辑核数。
//!   第一次采样没有基线，不报（Node 同样跳过第一拍）。
//! - **读不到就缺席**，不用 0 冒充：`heapUsedKb` / `uptimeMinutes` / `totalMemoryGb` 都是可选字段。
//! - **`instanceToken` 不含 pid**（隐私红线）：随机 8 字节十六进制，进程生命周期内不变，供桌面统计
//!   「同时存活几个 CLI 进程」。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// 一条 `process/resourceSample` 的样本（Host `zcodeProcessResourceSampleSchema` 的逐字段镜像）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSample {
    /// `process.platform` 的词表（`win32` / `darwin` / `linux` …）。
    pub platform: String,
    /// `process.arch` 的词表（`x64` / `arm64` …）。
    pub arch: String,
    pub logical_cpu_count: u32,
    /// 与上一次采样的间隔（毫秒）。
    pub interval_ms: u64,
    /// 这一段的平均占用（核数，1.0 = 一个核跑满）。
    pub cpu_cores: f64,
    /// `cpu_cores / logical_cpu_count × 100`。
    pub cpu_percent: f64,
    pub rss_kb: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heap_used_kb: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime_minutes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_memory_gb: Option<u64>,
    /// 进程级随机标识（`[A-Za-z0-9_-]{8,64}`），不含 pid。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_token: Option<String>,
}

/// 一次采样的原始读数（端口实现只管读，差分与换算在 [`ResourceSampler`] 里做）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessUsage {
    /// 累计用户态 CPU 时间（微秒）。
    pub user_us: u64,
    /// 累计内核态 CPU 时间（微秒）。
    pub system_us: u64,
    /// 常驻内存（字节）。
    pub rss_bytes: u64,
    /// 堆已用（字节）；读不到时 `None`。
    pub heap_used_bytes: Option<u64>,
}

/// 进程指标端口：读本进程的累计 CPU 与内存。入口 crate 按平台实现。
pub trait ProcessMetrics: Send + Sync {
    /// 平台名（`process.platform` 的词表）。
    fn platform(&self) -> &'static str;
    /// 架构名（`process.arch` 的词表）。
    fn arch(&self) -> &'static str;
    /// 逻辑核数（至少 1）。
    fn logical_cpu_count(&self) -> u32;
    /// 物理内存总量（字节）；读不到时 `None`。
    fn total_memory_bytes(&self) -> Option<u64>;
    /// 系统可用物理内存（字节，Node `os.freemem()`）；读不到时 `None`。
    /// `process/toolExecResource` 的 `systemFreeMemoryKb` 用它。
    fn free_memory_bytes(&self) -> Option<u64> {
        None
    }
    /// 本进程已运行的秒数；读不到时 `None`。
    fn uptime_seconds(&self) -> Option<u64>;
    /// 累计 CPU 与当前内存；读不到时 `None`（这一拍跳过，保留旧基线）。
    fn read(&self) -> Option<ProcessUsage>;
}

/// 两次读数之间的差分状态。
///
/// 与 Node 的 `sample()` 逐条同义：第一次只建基线；`Δ墙钟 <= 0` 或 `ΔCPU < 0` 时重建基线并跳过；
/// 换算出来的间隔取整到毫秒，`<= 0` 也跳过。
#[derive(Debug, Default)]
pub struct ResourceSampler {
    baseline: Option<(ProcessUsage, Instant)>,
    instance_token: Option<String>,
}

impl ResourceSampler {
    pub fn new() -> Self {
        Self::default()
    }

    /// 采一拍（用当前时刻）。第一拍（或读数不可用）返回 `None`。
    pub fn sample(&mut self, metrics: &dyn ProcessMetrics) -> Option<ResourceSample> {
        self.sample_at(metrics, Instant::now())
    }

    /// 采一拍，时刻由调用方给（测试注入可预期的间隔）。
    pub fn sample_at(&mut self, metrics: &dyn ProcessMetrics, now: Instant) -> Option<ResourceSample> {
        let usage = metrics.read()?;
        let (previous, at) = self.baseline.replace((usage, now))?;
        let elapsed = now.saturating_duration_since(at);
        let elapsed_ns = elapsed.as_nanos();
        if elapsed_ns == 0 {
            return None;
        }
        // ΔCPU 为负说明读数回退（时钟跳变、计数器重置）：重建基线，这一拍不报。
        let cpu_us = (usage.user_us.saturating_add(usage.system_us))
            .checked_sub(previous.user_us.saturating_add(previous.system_us))?;
        let interval_ms = u64::try_from(elapsed_ns / 1_000_000).ok()?;
        if interval_ms == 0 {
            return None;
        }
        let cpu_cores = cpu_us as f64 / (elapsed_ns as f64 / 1_000.0);
        let logical = metrics.logical_cpu_count().max(1);
        Some(ResourceSample {
            platform: metrics.platform().to_owned(),
            arch: metrics.arch().to_owned(),
            logical_cpu_count: logical,
            interval_ms,
            cpu_cores: round(cpu_cores),
            cpu_percent: round(cpu_cores / f64::from(logical) * 100.0),
            rss_kb: round(usage.rss_bytes as f64 / 1_024.0),
            heap_used_kb: usage
                .heap_used_bytes
                .map(|bytes| round(bytes as f64 / 1_024.0)),
            uptime_minutes: metrics.uptime_seconds().map(|seconds| seconds / 60),
            total_memory_gb: metrics
                .total_memory_bytes()
                .map(|bytes| bytes / (1024 * 1024 * 1024)),
            instance_token: Some(self.token()),
        })
    }

    /// 进程级的随机标识（首次采样时生成一次，之后不变）。
    fn token(&mut self) -> String {
        self.instance_token
            .get_or_insert_with(|| {
                let value = rust_cli_base::random::u64();
                format!("{value:016x}")
            })
            .clone()
    }
}

/// Node 的 `roundResourceMetric`：保留四位小数。
fn round(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// 采样节拍（Host `NIBI_CLI_RESOURCE_SAMPLE_INTERVAL_MS`）：CLI 与桌面两侧必须同源，否则
/// main 侧的 `sample_count` 会静默偏离约定值。
pub const RESOURCE_SAMPLE_INTERVAL: Duration = Duration::from_secs(60);

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Fake {
        usage: Mutex<Option<ProcessUsage>>,
    }

    impl Fake {
        fn new(usage: ProcessUsage) -> Self {
            Self {
                usage: Mutex::new(Some(usage)),
            }
        }

        fn set(&self, usage: ProcessUsage) {
            *self.usage.lock().unwrap() = Some(usage);
        }
    }

    impl ProcessMetrics for Fake {
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
            Some(120)
        }

        fn read(&self) -> Option<ProcessUsage> {
            *self.usage.lock().unwrap()
        }
    }

    fn usage(user_us: u64, system_us: u64, rss: u64) -> ProcessUsage {
        ProcessUsage {
            user_us,
            system_us,
            rss_bytes: rss,
            heap_used_bytes: Some(rss / 2),
        }
    }

    /// 第一拍只建基线，不报样本（Node 同样跳过第一拍）。
    #[test]
    fn the_first_sample_only_establishes_the_baseline() {
        let fake = Fake::new(usage(1_000, 500, 2 * 1024 * 1024));
        let mut sampler = ResourceSampler::new();
        let start = Instant::now();
        assert!(sampler.sample_at(&fake, start).is_none());
    }

    /// 第二拍按差分算核数与百分比：60 秒里用了 60 秒 CPU = 1 核 = 4 核的 25%。
    #[test]
    fn a_later_sample_reports_the_difference() {
        let fake = Fake::new(usage(0, 0, 2 * 1024 * 1024));
        let mut sampler = ResourceSampler::new();
        let start = Instant::now();
        sampler.sample_at(&fake, start);
        // 60 秒墙钟、60 秒 CPU。
        fake.set(usage(30_000_000, 30_000_000, 4 * 1024 * 1024));
        let sample = sampler
            .sample_at(&fake, start + Duration::from_secs(60))
            .expect("a sample");
        assert_eq!(sample.interval_ms, 60_000);
        assert_eq!(sample.cpu_cores, 1.0);
        assert_eq!(sample.cpu_percent, 25.0);
        assert_eq!(sample.rss_kb, 4_096.0);
        assert_eq!(sample.heap_used_kb, Some(2_048.0));
        assert_eq!(sample.uptime_minutes, Some(2));
        assert_eq!(sample.total_memory_gb, Some(16));
        assert_eq!(sample.logical_cpu_count, 4);
        assert_eq!(sample.platform, "linux");
        assert_eq!(sample.arch, "x64");
    }

    /// 实例标识在进程内不变（多次采样同一个 token），且是 16 位十六进制（不含 pid 的形状）。
    #[test]
    fn the_instance_token_is_stable_and_hex() {
        let fake = Fake::new(usage(0, 0, 1024));
        let mut sampler = ResourceSampler::new();
        let start = Instant::now();
        sampler.sample_at(&fake, start);
        fake.set(usage(1_000, 0, 1024));
        let first = sampler.sample_at(&fake, start + Duration::from_secs(1)).unwrap();
        fake.set(usage(2_000, 0, 1024));
        let second = sampler.sample_at(&fake, start + Duration::from_secs(2)).unwrap();
        let token = first.instance_token.clone().expect("a token");
        assert_eq!(second.instance_token, Some(token.clone()));
        assert_eq!(token.len(), 16);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// 读数不可用（`read` 返回 `None`）时这一拍跳过，不报 0。
    #[test]
    fn an_unreadable_sample_is_skipped() {
        let fake = Fake::new(usage(0, 0, 1024));
        let mut sampler = ResourceSampler::new();
        let start = Instant::now();
        sampler.sample_at(&fake, start);
        *fake.usage.lock().unwrap() = None;
        assert!(sampler.sample_at(&fake, start + Duration::from_secs(1)).is_none());
    }

    /// CPU 读数回退（计数器重置）时重建基线，不报负值。
    #[test]
    fn a_backwards_cpu_reading_rebuilds_the_baseline() {
        let fake = Fake::new(usage(10_000, 0, 1024));
        let mut sampler = ResourceSampler::new();
        let start = Instant::now();
        sampler.sample_at(&fake, start);
        fake.set(usage(1_000, 0, 1024));
        assert!(sampler.sample_at(&fake, start + Duration::from_secs(1)).is_none());
        // 基线已经换成回退后的那一拍：下一拍正常。
        fake.set(usage(2_000, 0, 1024));
        assert!(sampler.sample_at(&fake, start + Duration::from_secs(2)).is_some());
    }
}

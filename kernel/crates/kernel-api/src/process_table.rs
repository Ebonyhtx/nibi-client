//! 进程表读数与两个资源采样场景（141 审计 §9 F3）：`process/toolExecResource` 与
//! `process/mcpResourceSamples`。
//!
//! Node 侧是 `createProcessProbe`（`apps/zcode-cli/packages/adapters/src/device/process-probe.ts`），
//! Bash 慢命令与 MCP 五分钟采样共用同一个探针。这里分两层：
//!
//! - [`ProcessSampler`] 是**端口**：按进程组或按根 pid 的树读 RSS 与累计 CPU（平台实现在入口 crate，
//!   因为只有它知道自己在哪个系统上跑，也知道能不能起 `ps` / `tasklist`）。
//! - [`BashResourceSampler`] 与 [`McpResourceSampler`] 是**纯逻辑**：节拍、差分、峰值、按 `mcpId` 分组。
//!   注入时刻，所以可以逐条单测。
//!
//! 与 Node 一致的四条口径：
//!
//! - **CPU 是差分**：Bash 的 `treeCpuTimeMs` 是同一 pid 前后两次读数之差（首次算全程）；
//!   MCP 的 `cpuTimeMsDelta` 同理，按 `(mcpInstanceId, pid)` 记基线。
//! - **读不到就缺席**：Windows 没有累计 CPU，`treeCpuTimeMs` / `cpuTimeMs` 直接不出现，不填 0。
//! - **一次采样失败只丢这一拍**：整次失败时清空基线（不能把跨失败窗口的 CPU 算成均值）。
//! - **Bash 只报时长 ≥ 15 秒的命令**：短命令没有采样价值，Host schema 也不收。

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Bash 资源采样的节拍（Node `BASH_RESOURCE_SAMPLE_INTERVAL_MS`）。
pub const BASH_RESOURCE_SAMPLE_INTERVAL: Duration = Duration::from_secs(15);
/// 一条命令最多采这么多拍（Node `BASH_RESOURCE_MAX_SAMPLES`）。
pub const BASH_RESOURCE_MAX_SAMPLES: u32 = 20;
/// MCP 资源采样的节拍（Node `NIBI_MCP_RESOURCE_SAMPLE_INTERVAL_MS`）：设备总量的过期判据也用它。
pub const MCP_RESOURCE_SAMPLE_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// 一个进程的读数（Node `ProcessProbeSample`）。`cpu_time_ms` 在 Windows 上缺席，不是 0。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessSample {
    pub pid: i32,
    /// 常驻内存（KB）。
    pub rss_kb: u64,
    /// 进程启动以来的累计 CPU 时间（毫秒）。
    pub cpu_time_ms: Option<u64>,
}

/// 进程表读数的端口。入口 crate 按平台实现（Linux 读 `/proc`，macOS 起一次 `ps`，Windows 起一次
/// `tasklist`）。
#[async_trait]
pub trait ProcessSampler: Send + Sync {
    /// 本平台「树」的口径（`process_tree` / `direct_process`）。
    fn tree_scope(&self) -> &'static str;
    /// 按进程组采样；本平台没有进程组语义（Windows）或本次失败时 `None`。
    async fn sample_group(&self, pgid: u32) -> Option<Vec<ProcessSample>>;
    /// 按根 pid 采整棵进程树（含根）；整次失败时 `None`。
    async fn sample_trees(&self, roots: &[u32]) -> Option<BTreeMap<u32, Vec<ProcessSample>>>;
}

/// 本工程的平台名换成 `process.platform` 的词表（Host schema 只收 `win32` / `darwin` / `linux` …）。
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// 本工程的架构名换成 `process.arch` 的词表（`x86_64` → `x64`，`aarch64` → `arm64` …）。
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        "loongarch64" => "loong64",
        "powerpc" => "ppc",
        "powerpc64" => "ppc64",
        "riscv64" => "riscv64",
        "s390x" => "s390x",
        other => other,
    }
}

/// 命令为什么结束（Node `NIBIToolExecResource["exitKind"]`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolExitKind {
    Completed,
    Timeout,
    Killed,
    Error,
}

/// 一条 Bash 命令的资源事实（Host `zcodeToolExecResourceSchema` 的逐字段镜像）。
///
/// 隐私红线：只有工具名、时长、退出类别与两个内存读数；命令原文、路径与会话标识都不进来。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecResource {
    /// 同一完成事实的去重标识（Node `randomUUID()`）；旧版本缺字段仍兼容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_token: Option<String>,
    pub platform: String,
    /// 固定 `bash`。
    pub tool_name: String,
    /// 命令从开始到结束的墙钟（毫秒），至少 [`BASH_RESOURCE_SAMPLE_INTERVAL`]。
    pub duration_ms: u64,
    pub exit_kind: ToolExitKind,
    /// 进程树 RSS 峰值（KB）；Windows 没有进程组数据，缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree_rss_kb_peak: Option<u64>,
    /// 进程树累计 CPU 时间（毫秒，按 pid 差分累加）；Windows 缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree_cpu_time_ms: Option<u64>,
    pub sample_count: u32,
    /// 结束时 CLI 自己的 RSS（KB）：Host 用它给这条事实一个量级参考。
    pub cli_rss_kb: u64,
    /// 结束时系统可用内存（KB）。
    pub system_free_memory_kb: u64,
}

/// 一条 Bash 命令的采样状态（Node `createBashResourceTelemetry`）。
#[derive(Debug)]
pub struct BashResourceSampler {
    started: Instant,
    last_sample: Duration,
    attempts: u32,
    sample_count: u32,
    tree_rss_kb_peak: u64,
    tree_cpu_time_ms: u64,
    cpu_by_pid: HashMap<i32, u64>,
}

impl BashResourceSampler {
    pub fn new(started: Instant) -> Self {
        Self {
            started,
            last_sample: Duration::ZERO,
            attempts: 0,
            sample_count: 0,
            tree_rss_kb_peak: 0,
            tree_cpu_time_ms: 0,
            cpu_by_pid: HashMap::new(),
        }
    }

    /// 现在该不该采（距上一拍不少于 15 秒，且没用完 20 拍）。
    pub fn due(&self, now: Instant) -> bool {
        self.attempts < BASH_RESOURCE_MAX_SAMPLES
            && now.saturating_duration_since(self.started).saturating_sub(self.last_sample)
                >= BASH_RESOURCE_SAMPLE_INTERVAL
    }

    /// 记一拍。空样本（命令已经结束）不计入 `sample_count`，但算一次尝试（Node 同一处逻辑）。
    pub fn observe(&mut self, samples: &[ProcessSample], now: Instant) {
        self.last_sample = now.saturating_duration_since(self.started);
        self.attempts = self.attempts.saturating_add(1);
        if samples.is_empty() {
            return;
        }
        self.sample_count = self.sample_count.saturating_add(1);
        let mut total_rss = 0_u64;
        for sample in samples {
            total_rss = total_rss.saturating_add(sample.rss_kb);
            let Some(cpu) = sample.cpu_time_ms else {
                continue;
            };
            let previous = self.cpu_by_pid.insert(sample.pid, cpu).unwrap_or(0);
            // 读数回退（计数器重置）时按 0 计，不报负值。
            self.tree_cpu_time_ms = self
                .tree_cpu_time_ms
                .saturating_add(cpu.saturating_sub(previous));
        }
        self.tree_rss_kb_peak = self.tree_rss_kb_peak.max(total_rss);
    }

    /// 命令结束：时长不到 15 秒时没有事实（Host schema 也不收）。
    ///
    /// `cli_rss_kb` / `system_free_memory_kb` 由调用方在同一时刻读（Node 的 `readContext`）。
    pub fn finish(
        &mut self,
        now: Instant,
        exit_kind: ToolExitKind,
        cli_rss_kb: u64,
        system_free_memory_kb: u64,
    ) -> Option<ToolExecResource> {
        let duration_ms = u64::try_from(now.saturating_duration_since(self.started).as_millis()).ok()?;
        if duration_ms < u64::try_from(BASH_RESOURCE_SAMPLE_INTERVAL.as_millis()).ok()? {
            return None;
        }
        self.cpu_by_pid.clear();
        // Windows 的「树」只剩根进程，且没有累计 CPU：两个字段缺席而不是 0。
        let (tree_rss_kb_peak, tree_cpu_time_ms) = if cfg!(windows) {
            (None, None)
        } else {
            (Some(self.tree_rss_kb_peak), Some(self.tree_cpu_time_ms))
        };
        Some(ToolExecResource {
            completion_token: Some(uuid_v4()),
            platform: node_platform().to_owned(),
            tool_name: "bash".to_owned(),
            duration_ms,
            exit_kind,
            tree_rss_kb_peak,
            tree_cpu_time_ms,
            sample_count: self.sample_count,
            cli_rss_kb,
            system_free_memory_kb,
        })
    }
}

/// 一个 MCP 子进程的遥测身份（ext 的 tracker 给出）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpResourceTarget {
    pub pid: u32,
    /// `plugin:<12 位十六进制>` / `custom:<…>` / `builtin:<编码后的名字>`。
    pub mcp_id: String,
    /// 这一次进程启动的随机标识（同一次启动的采样共用一个）。
    pub instance_id: String,
    /// 进程启动的墙钟（毫秒，`occurredAt`）。
    pub started_at_ms: u64,
}

/// 一条 MCP 资源样本（Host `zcodeMcpResourceSampleSchema` 的逐字段镜像）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceSample {
    pub mcp_id: String,
    /// CLI 进程级的随机标识（不含 pid）。
    pub instance_token: String,
    pub sampled_at: u64,
    pub interval_ms: u64,
    pub process_count: u32,
    pub rss_kb_total: u64,
    pub rss_kb_max_process: u64,
    pub cpu_time_ms_delta: u64,
    pub uptime_minutes: u64,
    pub platform: String,
    pub arch: String,
    pub logical_cpu_count: u32,
    pub total_memory_gb: u64,
}

/// MCP 五分钟采样的状态（Node `createMcpResourceTelemetry`）：按 `(mcpInstanceId, pid)` 记 CPU 基线。
#[derive(Debug)]
pub struct McpResourceSampler {
    instance_token: String,
    /// 本机事实（进程生命周期内不变，构造时给一次）。
    platform: String,
    arch: String,
    logical_cpu_count: u32,
    total_memory_gb: u64,
    previous: HashMap<String, HashMap<i32, u64>>,
    previous_at: Option<u64>,
}

impl McpResourceSampler {
    pub fn new(platform: &str, arch: &str, logical_cpu_count: u32, total_memory_gb: u64) -> Self {
        Self {
            // 进程级随机标识：稳定、不含 pid（隐私红线与 `process/resourceSample` 同一口径）。
            instance_token: format!("{:016x}", rust_cli_base::random::u64()),
            platform: platform.to_owned(),
            arch: arch.to_owned(),
            logical_cpu_count: logical_cpu_count.max(1),
            total_memory_gb,
            previous: HashMap::new(),
            previous_at: None,
        }
    }

    /// 没有目标进程时清空基线（Node `processes.length === 0` 分支）。
    pub fn clear(&mut self) {
        self.previous.clear();
        self.previous_at = None;
    }

    /// 采一拍：`trees` 是根 pid → 树内样本。整次采样失败时用 [`clear`](Self::clear)，不要传空表——
    /// 空表是「根都不在了」，同样应该清基线，两种处理等价。
    pub fn sample(
        &mut self,
        targets: &[McpResourceTarget],
        trees: &BTreeMap<u32, Vec<ProcessSample>>,
        now_ms: u64,
    ) -> Vec<McpResourceSample> {
        if targets.is_empty() {
            self.clear();
            return Vec::new();
        }
        let default_interval = u64::try_from(MCP_RESOURCE_SAMPLE_INTERVAL.as_millis()).unwrap_or(300_000);
        let interval_ms = self
            .previous_at
            .map_or(default_interval, |previous| now_ms.saturating_sub(previous).max(1));
        let mut next: HashMap<String, HashMap<i32, u64>> = HashMap::new();
        let mut groups: BTreeMap<String, McpResourceSample> = BTreeMap::new();
        let mut seen_pids: Vec<i32> = Vec::new();
        for target in targets {
            let Some(tree) = trees.get(&target.pid) else {
                continue;
            };
            if tree.is_empty() {
                continue;
            }
            let group = groups.entry(target.mcp_id.clone()).or_insert_with(|| McpResourceSample {
                mcp_id: target.mcp_id.clone(),
                instance_token: self.instance_token.clone(),
                sampled_at: now_ms,
                interval_ms,
                process_count: 0,
                rss_kb_total: 0,
                rss_kb_max_process: 0,
                cpu_time_ms_delta: 0,
                uptime_minutes: 0,
                platform: self.platform.clone(),
                arch: self.arch.clone(),
                logical_cpu_count: self.logical_cpu_count,
                total_memory_gb: self.total_memory_gb,
            });
            let mut baseline = HashMap::new();
            for sample in tree {
                // 共享根或嵌套根只计一次，防止同一 OS 进程污染应用总量。
                if seen_pids.contains(&sample.pid) {
                    continue;
                }
                seen_pids.push(sample.pid);
                group.process_count = group.process_count.saturating_add(1);
                group.rss_kb_total = group.rss_kb_total.saturating_add(sample.rss_kb);
                group.rss_kb_max_process = group.rss_kb_max_process.max(sample.rss_kb);
                if let Some(cpu) = sample.cpu_time_ms {
                    baseline.insert(sample.pid, cpu);
                    if let Some(previous) = self
                        .previous
                        .get(&target.instance_id)
                        .and_then(|by_pid| by_pid.get(&sample.pid))
                    {
                        group.cpu_time_ms_delta = group
                            .cpu_time_ms_delta
                            .saturating_add(cpu.saturating_sub(*previous));
                    }
                }
            }
            // 同一实例可能有多个根（会话里同一服务器的子进程树）：合并基线，不互相覆盖。
            next.entry(target.instance_id.clone()).or_default().extend(baseline);
            let uptime = now_ms.saturating_sub(target.started_at_ms) / 60_000;
            group.uptime_minutes = group.uptime_minutes.max(uptime);
        }
        self.previous = next;
        self.previous_at = Some(now_ms);
        // 一个组一个进程都没占到（共享 pid 被前一个组先记了）就不上报（Node `processCount > 0`）。
        groups.retain(|_, group| group.process_count > 0);
        groups.into_values().collect()
    }

    /// 本采样器的实例标识（测试与诊断用）。
    pub fn instance_token(&self) -> &str {
        &self.instance_token
    }
}

/// 随机的 UUID 形状（Node `randomUUID()` 的去重标识；v4 变体）。
pub fn uuid_v4() -> String {
    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&rust_cli_base::random::u64().to_be_bytes());
    bytes[8..].copy_from_slice(&rust_cli_base::random::u64().to_be_bytes());
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    // 8-4-4-4-12；第三段首字符固定 4（版本），第四段首字符 a（变体 10xx）。
    format!(
        "{}-{}-4{}-a{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

#[cfg(test)]
#[path = "process_table_tests.rs"]
mod tests;

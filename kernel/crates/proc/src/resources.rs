//! 进程资源采样（141 审计 §9 F3）：按进程组或按进程树读每个进程的 RSS 与累计 CPU 时间。
//!
//! Node 侧是 `createProcessProbe`（`apps/zcode-cli/packages/adapters/src/device/process-probe.ts`），
//! 两个采样场景共用：Bash 慢命令的 `process/toolExecResource`（15 秒一拍、按进程组）与 MCP 的
//! `process/mcpResourceSamples`（5 分钟一拍、按进程树）。
//!
//! 三条与 Node 相同的口径：
//!
//! - **Linux 只读 `/proc`**，不启动任何进程；macOS 只起一次 `ps`；Windows 只起一次 `tasklist`
//!   （没有 ppid、也没有累计 CPU，所以「树」在 Windows 上退化为根进程自身，`tree_scope` 如实报
//!   `direct_process`）。
//! - **每次采样 1 秒预算**：超时或失败一律「本次无样本」，不重试、不排队。
//! - **单进程读失败只跳过它**：两遍读取之间退出的进程（`/proc/<pid>/status` 已消失）不算整次失败。
//!
//! 与 [`crate::tree`] 的分工：那里为「结束整棵树」按身份（pid + 启动时间）追踪，只需要关系；
//! 这里为遥测读数，多要 RSS 与 CPU 时间。

use std::collections::BTreeMap;
#[cfg(any(not(windows), test))]
use std::collections::{BTreeSet, HashMap, VecDeque};
#[cfg(all(windows, not(test)))]
use std::collections::HashMap;
use std::time::Duration;

/// 一次采样的墙钟预算（Node `PROCESS_PROBE_SAMPLE_TIMEOUT_BASE_MS`）。
pub const PROCESS_PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// 一个进程的读数（Node `ProcessProbeSample`）。`cpu_time_ms` 在 Windows 上缺席，不是 0。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessSample {
    pub pid: i32,
    /// 常驻内存（KB）。
    pub rss_kb: u64,
    /// 进程启动以来的累计 CPU 时间（毫秒）；读不到时 `None`。
    pub cpu_time_ms: Option<u64>,
}

/// 「树」在本平台的实际口径（Node `ProcessTreeScope`）：Windows 的 `tasklist` 没有 ppid，
/// 只能拿到直连进程。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeScope {
    DirectProcess,
    ProcessTree,
}

impl TreeScope {
    /// 线上词表（`memoryScope` / `treeScope`）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectProcess => "direct_process",
            Self::ProcessTree => "process_tree",
        }
    }
}

/// 本平台 `sample_process_trees` 的口径。
pub fn tree_scope() -> TreeScope {
    if cfg!(windows) {
        TreeScope::DirectProcess
    } else {
        TreeScope::ProcessTree
    }
}

/// 按进程组采一次（Bash 的命令树）：`pgid` 是根进程的 pid（`Ledger::spawn` 让它自成进程组）。
/// Windows 没有进程组语义，返回 `None` 且不启动任何进程（Node 同样跳过）。
pub async fn sample_process_group(pgid: u32) -> Option<Vec<ProcessSample>> {
    if !samplable(pgid) {
        return None;
    }
    within_budget(sample_group(pgid)).await
}

/// 按根 pid 采整棵进程树（含根自身），返回根 pid → 树内各进程样本。采样时已不存在的根不出现在
/// 结果里；整次失败时返回 `None`。
pub async fn sample_process_trees(roots: &[u32]) -> Option<BTreeMap<u32, Vec<ProcessSample>>> {
    let mut wanted: Vec<u32> = roots.iter().copied().filter(|pid| samplable(*pid)).collect();
    wanted.sort_unstable();
    wanted.dedup();
    if wanted.is_empty() {
        return Some(BTreeMap::new());
    }
    within_budget(sample_trees(&wanted)).await
}

fn samplable(pid: u32) -> bool {
    pid > 0 && pid <= i32::MAX as u32
}

/// 1 秒硬预算：超时与内部失败同样表现为「本次无样本」。
async fn within_budget<T>(work: impl std::future::Future<Output = Option<T>>) -> Option<T> {
    tokio::time::timeout(PROCESS_PROBE_TIMEOUT, work)
        .await
        .ok()
        .flatten()
}

/// 进程表里的一行关系（RSS 与 CPU 由平台读数补齐）。
#[cfg(any(not(windows), test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Relation {
    pid: i32,
    parent: i32,
    group: i32,
    cpu_time_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// Linux：两遍 `/proc`
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
async fn sample_group(pgid: u32) -> Option<Vec<ProcessSample>> {
    let relations = linux_relations().await?;
    let members: Vec<&Relation> = relations
        .iter()
        .filter(|relation| relation.group == pgid as i32)
        .collect();
    let rss = linux_rss(&members.iter().map(|relation| relation.pid).collect::<Vec<_>>()).await;
    Some(build_samples(&members, &rss))
}

#[cfg(target_os = "linux")]
async fn sample_trees(roots: &[u32]) -> Option<BTreeMap<u32, Vec<ProcessSample>>> {
    let relations = linux_relations().await?;
    let by_pid: HashMap<i32, &Relation> = relations.iter().map(|r| (r.pid, r)).collect();
    let trees = tree_members(&relations, roots);
    let targets: Vec<i32> = trees.values().flatten().copied().collect();
    let rss = linux_rss(&targets).await;
    Some(
        trees
            .into_iter()
            .map(|(root, pids)| {
                let members: Vec<&Relation> = pids
                    .iter()
                    .filter_map(|pid| by_pid.get(pid).copied())
                    .collect();
                (root, build_samples(&members, &rss))
            })
            .collect(),
    )
}

/// 全部进程的关系与累计 CPU 时间：每个 pid 读一次 `/proc/<pid>/stat`。
#[cfg(target_os = "linux")]
#[expect(
    clippy::disallowed_methods,
    reason = "/proc 是进程信息伪文件，不是本机存储（README §3.2 的 proc 函数级豁免）"
)]
async fn linux_relations() -> Option<Vec<Relation>> {
    let mut entries = tokio::fs::read_dir("/proc").await.ok()?;
    let mut pids = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if let Some(pid) = name.to_str().and_then(|name| name.parse::<i32>().ok()) {
            pids.push(pid);
        }
    }
    let mut relations = Vec::with_capacity(pids.len());
    for pid in pids {
        let Ok(text) = tokio::fs::read_to_string(format!("/proc/{pid}/stat")).await else {
            // 刚退出的进程：只跳过它，不影响整次采样。
            continue;
        };
        if let Some(relation) = parse_linux_stat(&text) {
            relations.push(relation);
        }
    }
    Some(relations)
}

/// `/proc/<pid>/stat` 的一行。comm 可能含空格与括号，从最后一个 `)` 之后数：第 1 个字段是状态，
/// 第 2 个 ppid，第 3 个 pgrp，第 12、13 个是 utime/stime（USER_HZ，各支持平台都是 100）。
#[cfg(any(target_os = "linux", test))]
fn parse_linux_stat(line: &str) -> Option<Relation> {
    let (head, rest) = line.rsplit_once(')')?;
    let pid: i32 = head.split_once('(')?.0.trim().parse().ok()?;
    let mut fields = rest.split_whitespace();
    let _state = fields.next()?;
    let parent: i32 = fields.next()?.parse().ok()?;
    let group: i32 = fields.next()?.parse().ok()?;
    // 跳过 session … cmajflt 八个字段，第 9 个才是 utime，再下一个是 stime。
    let user: u64 = fields.nth(8)?.parse().ok()?;
    let system: u64 = fields.next()?.parse().ok()?;
    Some(Relation {
        pid,
        parent,
        group,
        // 100 tick = 1 秒（Node `LINUX_CLOCK_TICKS_PER_SECOND`）。
        cpu_time_ms: Some(user.saturating_add(system).saturating_mul(10)),
    })
}

/// 目标进程的常驻内存：只对这批 pid 读 `/proc/<pid>/status` 的 `VmRSS`。
#[cfg(target_os = "linux")]
#[expect(
    clippy::disallowed_methods,
    reason = "/proc 是进程信息伪文件，不是本机存储（README §3.2 的 proc 函数级豁免）"
)]
async fn linux_rss(pids: &[i32]) -> HashMap<i32, u64> {
    let mut rss = HashMap::with_capacity(pids.len());
    for pid in pids.iter().copied().collect::<BTreeSet<_>>() {
        let Ok(text) = tokio::fs::read_to_string(format!("/proc/{pid}/status")).await else {
            continue;
        };
        if let Some(kb) = parse_vm_rss_kb(&text) {
            rss.insert(pid, kb);
        }
    }
    rss
}

/// `/proc/<pid>/status` 里的 `VmRSS:\t  12345 kB`。
#[cfg(any(target_os = "linux", test))]
fn parse_vm_rss_kb(text: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.starts_with("VmRSS:"))?;
    line["VmRSS:".len()..].split_whitespace().next()?.parse().ok()
}

// ---------------------------------------------------------------------------
// macOS：每次采样只起一次 `ps`
// ---------------------------------------------------------------------------

#[cfg(all(unix, not(target_os = "linux")))]
async fn sample_group(pgid: u32) -> Option<Vec<ProcessSample>> {
    let rows = ps_rows(&["-o", "pid=,rss=,cputime=", "-g", &pgid.to_string()], false).await?;
    Some(samples_of(&rows))
}

#[cfg(all(unix, not(target_os = "linux")))]
async fn sample_trees(roots: &[u32]) -> Option<BTreeMap<u32, Vec<ProcessSample>>> {
    let rows = ps_rows(&["-eo", "pid=,ppid=,rss=,cputime="], true).await?;
    // `ps` 给的是全表；树在本地展开，根不存在时不出现在结果里。
    let relations: Vec<Relation> = rows
        .iter()
        .map(|row| Relation {
            pid: row.pid,
            parent: row.parent.unwrap_or(0),
            group: 0,
            cpu_time_ms: row.cpu_time_ms,
        })
        .collect();
    let trees = tree_members(&relations, roots);
    let by_pid: HashMap<i32, &SampleRow> = rows.iter().map(|row| (row.pid, row)).collect();
    Some(
        trees
            .into_iter()
            .map(|(root, pids)| {
                let members: Vec<&SampleRow> =
                    pids.iter().filter_map(|pid| by_pid.get(pid).copied()).collect();
                (root, samples_of(&members))
            })
            .collect(),
    )
}

/// `ps` 的一行；`parent` 只在取全表时存在。
#[cfg(all(unix, not(target_os = "linux")))]
#[derive(Debug, Clone, Copy)]
struct SampleRow {
    pid: i32,
    parent: Option<i32>,
    rss_kb: u64,
    cpu_time_ms: Option<u64>,
}

#[cfg(all(unix, not(target_os = "linux")))]
fn samples_of(rows: &[&SampleRow]) -> Vec<ProcessSample> {
    let mut samples: Vec<ProcessSample> = rows
        .iter()
        .map(|row| ProcessSample {
            pid: row.pid,
            rss_kb: row.rss_kb,
            cpu_time_ms: row.cpu_time_ms,
        })
        .collect();
    samples.sort_by_key(|sample| sample.pid);
    samples
}

#[cfg(all(unix, not(target_os = "linux")))]
async fn ps_rows(args: &[&str], with_parent: bool) -> Option<Vec<SampleRow>> {
    let output = crate::command("ps").args(args).output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(
        text.lines()
            .filter_map(|line| parse_ps_row(line, with_parent))
            .collect(),
    )
}

/// `pid [ppid] rss cputime`：`-o` 的 `=` 后缀让 `ps` 不打印表头。
#[cfg(all(unix, not(target_os = "linux")))]
fn parse_ps_row(line: &str, with_parent: bool) -> Option<SampleRow> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let expected = if with_parent { 4 } else { 3 };
    if fields.len() != expected {
        return None;
    }
    let pid: i32 = fields[0].parse().ok()?;
    if !samplable(u32::try_from(pid).ok()?) {
        return None;
    }
    let (parent, rss, cpu) = if with_parent {
        let parent: i32 = fields[1].parse().ok()?;
        (Some(parent), fields[2], fields[3])
    } else {
        (None, fields[1], fields[2])
    };
    Some(SampleRow {
        pid,
        parent,
        rss_kb: rss.parse().ok()?,
        cpu_time_ms: parse_bsd_cpu_time_ms(cpu),
    })
}

/// BSD `cputime` 形如 `[dd-][hh:]mm:ss[.ff]`。
#[cfg(all(unix, not(target_os = "linux")))]
fn parse_bsd_cpu_time_ms(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (days, clock) = match trimmed.split_once('-') {
        Some((days, clock)) => (days.parse::<f64>().ok()?, clock),
        None => (0.0, trimmed),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut seconds = days * 86_400.0;
    for (index, part) in parts.iter().rev().enumerate() {
        let value: f64 = part.parse().ok()?;
        seconds += value * 60_f64.powi(i32::try_from(index).ok()?);
    }
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some((seconds * 1_000.0).round() as u64)
}

// ---------------------------------------------------------------------------
// Windows：一次 `tasklist`，只有 RSS（没有 ppid、没有累计 CPU）
// ---------------------------------------------------------------------------

#[cfg(windows)]
async fn sample_group(_pgid: u32) -> Option<Vec<ProcessSample>> {
    // Windows 没有进程组语义，也没有零成本的进程树数据源（Node 同样直接放弃本次采样）。
    None
}

#[cfg(windows)]
async fn sample_trees(roots: &[u32]) -> Option<BTreeMap<u32, Vec<ProcessSample>>> {
    let rows = tasklist_rows().await?;
    let by_pid: HashMap<i32, &ProcessSample> = rows.iter().map(|row| (row.pid, row)).collect();
    Some(
        roots
            .iter()
            .filter_map(|root| {
                // 「树」只剩根进程自身（`tree_scope` 报 `direct_process`）。
                let root = i32::try_from(*root).ok()?;
                let sample = by_pid.get(&root)?;
                Some((u32::try_from(root).ok()?, vec![**sample]))
            })
            .collect(),
    )
}

#[cfg(windows)]
async fn tasklist_rows() -> Option<Vec<ProcessSample>> {
    let output = crate::command("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(
        text.lines()
            .filter_map(parse_tasklist_csv)
            .map(|row| ProcessSample {
                pid: row.pid,
                rss_kb: row.rss_kb,
                cpu_time_ms: None,
            })
            .collect(),
    )
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy)]
struct TasklistRow {
    pid: i32,
    rss_kb: u64,
}

/// `"name","1234","Console","1","12,345 K"`：pid 在第 2 列，内存在第 5 列。
#[cfg(windows)]
fn parse_tasklist_csv(line: &str) -> Option<TasklistRow> {
    let fields: Vec<&str> = line
        .split("\",\"")
        .map(|field| field.trim_matches('"'))
        .collect();
    if fields.len() < 5 {
        return None;
    }
    let pid: i32 = fields[1].parse().ok()?;
    if !samplable(u32::try_from(pid).ok()?) {
        return None;
    }
    let digits: String = fields[4].chars().filter(char::is_ascii_digit).collect();
    Some(TasklistRow {
        pid,
        rss_kb: digits.parse().ok()?,
    })
}

// ---------------------------------------------------------------------------
// 平台无关部分
// ---------------------------------------------------------------------------

/// 每个根 pid 的树内 pid（含根）。根不在表里时不出现在结果里。
#[cfg(any(not(windows), test))]
fn tree_members(relations: &[Relation], roots: &[u32]) -> BTreeMap<u32, Vec<i32>> {
    let present: BTreeSet<i32> = relations.iter().map(|relation| relation.pid).collect();
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for relation in relations {
        children.entry(relation.parent).or_default().push(relation.pid);
    }
    let mut trees = BTreeMap::new();
    for root in roots {
        let Ok(root) = i32::try_from(*root) else {
            continue;
        };
        if !present.contains(&root) {
            continue;
        }
        let mut members = Vec::new();
        let mut seen = BTreeSet::new();
        let mut queue = VecDeque::from([root]);
        while let Some(pid) = queue.pop_front() {
            if !seen.insert(pid) {
                continue;
            }
            members.push(pid);
            if let Some(list) = children.get(&pid) {
                queue.extend(list.iter().copied());
            }
        }
        members.sort_unstable();
        trees.insert(u32::try_from(root).unwrap_or(0), members);
    }
    trees
}

/// 关系行 + RSS 表 → 样本（读不到 RSS 的进程跳过，其余照常返回）。
#[cfg(any(target_os = "linux", test))]
fn build_samples(relations: &[&Relation], rss: &HashMap<i32, u64>) -> Vec<ProcessSample> {
    let mut samples: Vec<ProcessSample> = relations
        .iter()
        .filter_map(|relation| {
            let rss_kb = rss.get(&relation.pid)?;
            Some(ProcessSample {
                pid: relation.pid,
                rss_kb: *rss_kb,
                cpu_time_ms: relation.cpu_time_ms,
            })
        })
        .collect();
    samples.sort_by_key(|sample| sample.pid);
    samples
}

#[cfg(test)]
mod tests {
    use super::*;

    /// comm 里有空格与括号时也要正确切出 pid 与后续字段。
    #[test]
    fn a_linux_stat_line_is_split_after_the_last_paren() {
        // 字段：状态 S、ppid 42、pgrp 42，再八个填充，然后 utime=50、stime=25。
        let line = "1234 (a (weird) name) S 42 42 42 0 -1 4194560 100 0 0 0 50 25 0 0 20 0 1 0 98765 10000 100";
        let relation = parse_linux_stat(line).expect("a relation");
        assert_eq!(relation.pid, 1234);
        assert_eq!(relation.parent, 42);
        assert_eq!(relation.group, 42);
        // (50 + 25) tick × 10 = 750 ms。
        assert_eq!(relation.cpu_time_ms, Some(750));
    }

    #[test]
    fn a_status_line_yields_vm_rss() {
        let text = "Name:\tbash\nVmPeak:\t  100000 kB\nVmRSS:\t   12345 kB\nThreads:\t1\n";
        assert_eq!(parse_vm_rss_kb(text), Some(12_345));
        assert_eq!(parse_vm_rss_kb("Name:\tbash\n"), None);
    }

    /// 树按 ppid 展开：根自身 + 全部后代；根不存在时不出现在结果里。
    #[test]
    fn trees_follow_parent_links() {
        let relations = vec![
            Relation { pid: 10, parent: 1, group: 10, cpu_time_ms: None },
            Relation { pid: 11, parent: 10, group: 10, cpu_time_ms: None },
            Relation { pid: 12, parent: 11, group: 10, cpu_time_ms: None },
            Relation { pid: 20, parent: 1, group: 20, cpu_time_ms: None },
        ];
        let trees = tree_members(&relations, &[10, 99]);
        assert_eq!(trees.get(&10), Some(&vec![10, 11, 12]));
        assert!(trees.get(&99).is_none());
    }

    /// 样本只含读得到 RSS 的进程，并按 pid 排序。
    #[test]
    fn samples_skip_processes_without_rss() {
        let relations = vec![
            Relation { pid: 2, parent: 1, group: 2, cpu_time_ms: Some(10) },
            Relation { pid: 1, parent: 0, group: 1, cpu_time_ms: Some(5) },
            Relation { pid: 3, parent: 1, group: 3, cpu_time_ms: Some(7) },
        ];
        let refs: Vec<&Relation> = relations.iter().collect();
        let rss = HashMap::from([(1, 100), (2, 200)]);
        let samples = build_samples(&refs, &rss);
        assert_eq!(
            samples,
            vec![
                ProcessSample { pid: 1, rss_kb: 100, cpu_time_ms: Some(5) },
                ProcessSample { pid: 2, rss_kb: 200, cpu_time_ms: Some(10) },
            ]
        );
    }

    #[test]
    fn the_tree_scope_matches_the_platform() {
        let scope = tree_scope();
        if cfg!(windows) {
            assert_eq!(scope.as_str(), "direct_process");
        } else {
            assert_eq!(scope.as_str(), "process_tree");
        }
    }

    /// 摘要形状与 Node `ProcessProbeSample` 同义：pid 必须可采样。
    #[test]
    fn a_zero_pid_is_not_samplable() {
        assert!(!samplable(0));
        assert!(samplable(1));
        assert!(samplable(std::process::id()));
    }
}

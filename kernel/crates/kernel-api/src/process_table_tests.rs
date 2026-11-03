//! `process/toolExecResource` 与 `process/mcpResourceSamples` 的采样口径（141 审计 §9 F3）。

use std::time::{Duration, Instant};

use super::*;

fn sample(pid: i32, rss_kb: u64, cpu_time_ms: Option<u64>) -> ProcessSample {
    ProcessSample {
        pid,
        rss_kb,
        cpu_time_ms,
    }
}

/// 节拍：不到 15 秒不采，用完 20 拍不再采。
#[test]
fn the_bash_sampler_is_due_every_fifteen_seconds() {
    let start = Instant::now();
    let mut sampler = BashResourceSampler::new(start);
    assert!(!sampler.due(start + Duration::from_secs(14)));
    assert!(sampler.due(start + Duration::from_secs(15)));
    for _ in 0..BASH_RESOURCE_MAX_SAMPLES {
        let now = start + BASH_RESOURCE_SAMPLE_INTERVAL * (sampler.attempts + 1);
        assert!(sampler.due(now));
        sampler.observe(&[sample(1, 10, Some(0))], now);
    }
    assert!(!sampler.due(start + Duration::from_secs(24 * 60 * 60)));
}

/// 峰值取最大；CPU 按同一 pid 的差分累加（首次按全程算）。
#[test]
fn bash_sampling_accumulates_peak_rss_and_cpu_deltas() {
    let start = Instant::now();
    let mut sampler = BashResourceSampler::new(start);
    sampler.observe(
        &[sample(10, 1_000, Some(100)), sample(11, 500, Some(40))],
        start + Duration::from_secs(15),
    );
    // 第二拍：10 号涨到 3000 KB、CPU 到 300；11 号消失。
    sampler.observe(&[sample(10, 3_000, Some(300))], start + Duration::from_secs(30));
    let fact = sampler
        .finish(start + Duration::from_secs(30), ToolExitKind::Completed, 64_000, 1_000_000)
        .expect("a fact");
    assert_eq!(fact.duration_ms, 30_000);
    assert_eq!(fact.sample_count, 2);
    // 峰值取两拍里较大的树总量：第一拍 1000 + 500，第二拍 3000；CPU 首次 140，第二拍 +200。
    if cfg!(windows) {
        assert_eq!(fact.tree_rss_kb_peak, None);
        assert_eq!(fact.tree_cpu_time_ms, None);
    } else {
        assert_eq!(fact.tree_rss_kb_peak, Some(3_000));
        assert_eq!(fact.tree_cpu_time_ms, Some(340));
    }
    assert_eq!(fact.tool_name, "bash");
    assert_eq!(fact.exit_kind, ToolExitKind::Completed);
    assert_eq!(fact.cli_rss_kb, 64_000);
    assert_eq!(fact.system_free_memory_kb, 1_000_000);
    let token = fact.completion_token.expect("a token");
    assert_eq!(token.len(), 36);
    assert_eq!(&token[14..15], "4");
    assert_eq!(&token[19..20], "a");
}

/// 时长不到 15 秒的命令没有事实（Host schema 同样拒收）。
#[test]
fn short_commands_produce_no_fact() {
    let start = Instant::now();
    let mut sampler = BashResourceSampler::new(start);
    sampler.observe(&[sample(1, 100, Some(10))], start + Duration::from_secs(10));
    assert!(
        sampler
            .finish(start + Duration::from_secs(14), ToolExitKind::Killed, 1, 2)
            .is_none()
    );
    assert!(
        sampler
            .finish(start + Duration::from_secs(15), ToolExitKind::Killed, 1, 2)
            .is_some()
    );
}

/// 空样本也是一次尝试：不再立刻重采，也不计入 `sample_count`。
#[test]
fn an_empty_sample_counts_as_an_attempt_but_not_a_sample() {
    let start = Instant::now();
    let mut sampler = BashResourceSampler::new(start);
    let at = start + Duration::from_secs(15);
    sampler.observe(&[], at);
    assert!(!sampler.due(at + Duration::from_secs(1)));
    assert!(sampler.due(at + Duration::from_secs(15)));
    let fact = sampler
        .finish(start + Duration::from_secs(16), ToolExitKind::Error, 1, 2)
        .expect("a fact");
    assert_eq!(fact.sample_count, 0);
}

/// Windows 没有进程组与累计 CPU：两个 `tree*` 字段缺席而不是 0。
#[test]
fn the_tree_fields_follow_the_platform() {
    let start = Instant::now();
    let mut sampler = BashResourceSampler::new(start);
    sampler.observe(&[sample(1, 100, Some(10))], start + Duration::from_secs(15));
    let fact = sampler
        .finish(start + Duration::from_secs(20), ToolExitKind::Timeout, 1, 2)
        .expect("a fact");
    if cfg!(windows) {
        assert_eq!(fact.tree_rss_kb_peak, None);
        assert_eq!(fact.tree_cpu_time_ms, None);
    } else {
        assert_eq!(fact.tree_rss_kb_peak, Some(100));
        assert_eq!(fact.tree_cpu_time_ms, Some(10));
    }
}

fn target(pid: u32, mcp_id: &str, instance_id: &str, started_at_ms: u64) -> McpResourceTarget {
    McpResourceTarget {
        pid,
        mcp_id: mcp_id.to_owned(),
        instance_id: instance_id.to_owned(),
        started_at_ms,
    }
}

/// 按 `mcpId` 分组；共享 pid 只计一次；CPU 是同一 `(实例, pid)` 的差分。
#[test]
fn mcp_samples_group_by_id_and_diff_cpu() {
    let mut sampler = McpResourceSampler::new("linux", "x64", 8, 32);
    let targets = vec![
        target(100, "plugin:aaaaaaaaaaaa", "inst-1", 0),
        target(200, "plugin:aaaaaaaaaaaa", "inst-1", 0),
        target(300, "custom:bbbbbbbbbbbb", "inst-2", 0),
    ];
    let trees = BTreeMap::from([
        (100, vec![sample(100, 1_000, Some(50)), sample(101, 200, Some(10))]),
        (200, vec![sample(200, 500, None)]),
        (300, vec![sample(300, 300, Some(0))]),
    ]);
    let first = sampler.sample(&targets, &trees, 1_000_000);
    // 两个 mcpId → 两条样本；plugin 组 3 个进程。
    assert_eq!(first.len(), 2);
    let plugin = first
        .iter()
        .find(|entry| entry.mcp_id == "plugin:aaaaaaaaaaaa")
        .expect("the plugin group");
    assert_eq!(plugin.process_count, 3);
    assert_eq!(plugin.rss_kb_total, 1_700);
    assert_eq!(plugin.rss_kb_max_process, 1_000);
    assert_eq!(plugin.interval_ms, 300_000);
    assert_eq!(plugin.cpu_time_ms_delta, 0);
    assert_eq!(plugin.instance_token.len(), 16);

    // 第二拍：100 号 CPU 50 → 250（+200），101 号 10 → 30（+20）。
    let trees = BTreeMap::from([
        (100, vec![sample(100, 1_200, Some(250)), sample(101, 200, Some(30))]),
        (200, vec![sample(200, 600, None)]),
        (300, vec![sample(300, 300, Some(0))]),
    ]);
    let second = sampler.sample(&targets, &trees, 1_300_000);
    let plugin = second
        .iter()
        .find(|entry| entry.mcp_id == "plugin:aaaaaaaaaaaa")
        .expect("the plugin group");
    assert_eq!(plugin.cpu_time_ms_delta, 220);
    assert_eq!(plugin.interval_ms, 300_000);
}

/// 同一个 pid 出现在两棵树里只计一次（共享根或嵌套根）。
#[test]
fn shared_pids_are_counted_once() {
    let mut sampler = McpResourceSampler::new("linux", "x64", 4, 16);
    let targets = vec![
        target(100, "custom:aaaaaaaaaaaa", "a", 0),
        target(100, "custom:bbbbbbbbbbbb", "b", 0),
    ];
    let trees = BTreeMap::from([(100, vec![sample(100, 900, Some(5))])]);
    let samples = sampler.sample(&targets, &trees, 10);
    assert_eq!(samples.len(), 1);
    assert_eq!(samples[0].mcp_id, "custom:aaaaaaaaaaaa");
    assert_eq!(samples[0].rss_kb_total, 900);
}

/// 没有目标进程时清空基线：下一次的间隔回到 5 分钟，CPU 不会跨窗口累加。
#[test]
fn an_empty_target_list_clears_the_baseline() {
    let mut sampler = McpResourceSampler::new("linux", "x64", 8, 32);
    let targets = vec![target(100, "custom:aaaaaaaaaaaa", "a", 0)];
    let trees = BTreeMap::from([(100, vec![sample(100, 100, Some(10))])]);
    sampler.sample(&targets, &trees, 0);
    assert!(sampler.sample(&[], &BTreeMap::new(), 60_000).is_empty());
    let second = sampler.sample(&targets, &trees, 120_000);
    assert_eq!(second[0].interval_ms, 300_000);
    assert_eq!(second[0].cpu_time_ms_delta, 0);
}

/// 平台与架构要换成 Host schema 的词表（Node `process.platform` / `process.arch`）。
#[test]
fn the_platform_and_arch_use_the_node_vocabulary() {
    let platform = node_platform();
    assert!(
        ["win32", "darwin", "linux"].contains(&platform) || platform == std::env::consts::OS,
        "{platform}"
    );
    assert!(!platform.is_empty());
    let arch = node_arch();
    assert!(!arch.is_empty());
    if cfg!(target_arch = "x86_64") {
        assert_eq!(arch, "x64");
    }
    if cfg!(target_arch = "aarch64") {
        assert_eq!(arch, "arm64");
    }
}

/// 去重标识是 UUID v4 的形状。
#[test]
fn the_completion_token_is_a_uuid() {
    let token = uuid_v4();
    let parts: Vec<&str> = token.split('-').collect();
    assert_eq!(parts.len(), 5);
    assert_eq!(
        parts.iter().map(|part| part.len()).collect::<Vec<_>>(),
        vec![8, 4, 4, 4, 12]
    );
    assert!(token.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
    assert_ne!(uuid_v4(), token);
}

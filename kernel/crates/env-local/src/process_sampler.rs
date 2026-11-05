//! 进程表读数端口（141 审计 §9 F3）的本机实现：转给 [`nibi_kernel_proc::resources`]。
//!
//! 协议层（`process/mcpResourceSamples` 的 5 分钟节拍）只需要「按根 pid 采进程树」这一件事，
//! 平台细节留在 proc crate：Linux 读 `/proc`，macOS 起一次 `ps`，Windows 起一次 `tasklist`。

use std::collections::BTreeMap;

use async_trait::async_trait;
use nibi_kernel_api::process_table::{ProcessSample, ProcessSampler};

/// 本机实现（不持有状态：每次采样各自读一次进程表）。
#[derive(Debug, Clone, Copy, Default)]
pub struct LocalProcessSampler;

impl LocalProcessSampler {
    pub fn new() -> Self {
        Self
    }
}

fn convert(samples: Vec<nibi_kernel_proc::resources::ProcessSample>) -> Vec<ProcessSample> {
    samples
        .into_iter()
        .map(|sample| ProcessSample {
            pid: sample.pid,
            rss_kb: sample.rss_kb,
            cpu_time_ms: sample.cpu_time_ms,
        })
        .collect()
}

#[async_trait]
impl ProcessSampler for LocalProcessSampler {
    fn tree_scope(&self) -> &'static str {
        nibi_kernel_proc::resources::tree_scope().as_str()
    }

    async fn sample_group(&self, pgid: u32) -> Option<Vec<ProcessSample>> {
        nibi_kernel_proc::resources::sample_process_group(pgid)
            .await
            .map(convert)
    }

    async fn sample_trees(&self, roots: &[u32]) -> Option<BTreeMap<u32, Vec<ProcessSample>>> {
        nibi_kernel_proc::resources::sample_process_trees(roots)
            .await
            .map(|trees| {
                trees
                    .into_iter()
                    .map(|(root, samples)| (root, convert(samples)))
                    .collect()
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机上按自己的 pid 采一棵树：至少能采到本进程（Windows 上只剩直连进程）。
    #[tokio::test]
    async fn the_local_sampler_reads_this_process() {
        let sampler = LocalProcessSampler::new();
        let pid = std::process::id();
        let trees = sampler
            .sample_trees(&[pid])
            .await
            .expect("this process is samplable");
        let tree = trees.get(&pid).expect("the root is in its own tree");
        assert!(!tree.is_empty());
        assert!(tree.iter().any(|sample| sample.pid == i32::try_from(pid).unwrap()));
        assert!(tree.iter().all(|sample| sample.rss_kb > 0));
        assert!(!sampler.tree_scope().is_empty());
    }

    /// 不存在的根不出现在结果里（不是整次失败）。
    #[tokio::test]
    async fn a_missing_root_is_simply_absent() {
        let sampler = LocalProcessSampler::new();
        let trees = sampler
            .sample_trees(&[u32::MAX - 1])
            .await
            .expect("a sample");
        assert!(trees.is_empty());
    }
}

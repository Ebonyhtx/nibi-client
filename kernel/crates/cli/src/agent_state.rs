//! `agents-state.json`（设置页写入的子代理模型覆盖与用户 agent 停用）的读取。
//!
//! 位置是 `<存储根>/v2/agents-state.json`（Node `resolveSubagentStateFile`）；内核只读，写入与
//! 旧字段迁移由 Host 负责。读取器每次取 agent 定义都调用一次：Node 每回合重读同一份文件，
//! 设置页改完立即生效，不做启动快照。

use std::sync::Arc;

use nibi_kernel_agents::{AgentState, StateFuture, StateSource};
use nibi_kernel_paths::StoragePath;

/// 存储根下的读取器；文件还没写过（不存在）就是没有覆盖，其它 IO 失败只记 debug。
pub(crate) fn source(root: &StoragePath) -> Arc<StateSource> {
    let path = root.join("v2").join("agents-state.json");
    Arc::new(move || {
        let path = path.as_path().to_path_buf();
        let future: StateFuture = Box::pin(async move {
            match nibi_kernel_fs::read_optional(&path).await {
                Ok(Some(bytes)) => AgentState::parse(&String::from_utf8_lossy(&bytes)),
                Ok(None) => AgentState::default(),
                Err(error) => {
                    tracing::debug!(
                        event = "agents.state.unreadable",
                        path = %path.display(),
                        error = %error,
                        "agents-state.json is not readable; no subagent overrides"
                    );
                    AgentState::default()
                }
            }
        });
        future
    })
}

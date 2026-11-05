//! 快照 `subagents` 键（Host `subagentProjectionStateSchema`）：把内核的子代理表投影成界面要的形状。
//!
//! 事实源是 `SessionHandle::subagents()`（`crates/agents` 的 `views::entries`，TUI 的输入框列表一直用它），
//! 不是事件流：内核没有 `KernelEvent::Subagent` 的生产者。Node 那边由 `SubagentSpawned/Stopped` 事件维护
//! 同一个状态键，这里改成查询 + `subagent_changes()` 通知刷新，投影结果同形。

use nibi_kernel_api::panels::{SubagentEntry, SubagentStatus};
use serde_json::{Value, json};

/// 一次投影的三份语义（变化判据只看它们，不看 `revision`）。
pub(super) type Semantic = (Vec<String>, Vec<Value>, u64);

/// 把子代理表投影成 `subagents` 状态键的三个语义字段。
///
/// - `childSessionIds`：全部子会话（在跑与已结束），按启动顺序——界面用它校验子会话 tab 还有效。
/// - `running`：只在跑的（含等用户回答的），`status` 按等待与否分成 `waiting` / `running`。
/// - `endedTotal`：已结束的数量（目录分页的总数）。
pub(super) fn semantic(entries: &[SubagentEntry], now: u64) -> Semantic {
    let child_session_ids: Vec<String> = entries
        .iter()
        .map(|entry| entry.child.as_str().to_owned())
        .collect();
    let mut running: Vec<Value> = entries
        .iter()
        .filter_map(|entry| {
            if entry.status != SubagentStatus::Running {
                return None;
            }
            Some(json!({
                "childSessionId": entry.child.as_str(),
                "agentId": entry.agent.as_str(),
                "subagentType": entry.agent_type,
                "title": entry.description,
                // 内核只有「等用户回答」这一种非 running 语义；`blocked`（后台工作被挡住）在
                // agents 里没有独立事实，如实不造。
                "status": if entry.waiting { "waiting" } else { "running" },
                // `elapsed_ms` 是查询时刻的用时，反推启动时刻（Node 的 `startedAt` 同一用途）。
                "startedAt": now.saturating_sub(entry.elapsed_ms),
            }))
        })
        .collect();
    // 与 Node 的排序一致：新的在前，同刻按 childSessionId 反序。
    running.sort_by(|left, right| {
        let key = |value: &Value| {
            (
                value["startedAt"].as_u64().unwrap_or(0),
                value["childSessionId"].as_str().unwrap_or_default().to_owned(),
            )
        };
        key(right).cmp(&key(left))
    });
    let ended_total = entries
        .iter()
        .filter(|entry| entry.status != SubagentStatus::Running)
        .count() as u64;
    (child_session_ids, running, ended_total)
}

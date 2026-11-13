//! `session/subagents`（Host 的子代理目录侧栏，`useSessionSubagents` → `SubagentDirectorySidePane`）。
//!
//! 与快照的 `subagents` 键同一个事实源（`SessionHandle::subagents()`），只是这条旧方法还要
//! 已结束项的分页明细。Node 的 ended 列表来自会话存储与子会话投影；内核在跑的、已结束的都在
//! 同一张 `SubagentEntry` 表里，字段足够拼出 Host schema（`nibiSessionSubagentsResultSchema`）。

use base64::Engine;
use nibi_kernel_api::panels::{SubagentEntry, SubagentStatus};
use nibi_kernel_api::session_api::KernelError;
use serde_json::{Value, json};

use crate::server::{Server, kernel_error};

/// 已结束项的状态词（Host `nibiSessionEndedSubagentSchema.status`）。
fn ended_status(status: SubagentStatus) -> &'static str {
    match status {
        // 调用方已经滤掉 Running；这里只是穷尽 match。
        SubagentStatus::Running => "success",
        SubagentStatus::Completed => "success",
        SubagentStatus::Failed => "failed",
        SubagentStatus::Killed => "cancelled",
    }
}

/// 在跑项的状态词（Host `nibiSessionRunningSubagentSchema.status`）：内核只有「等用户回答」这一种
/// 非 running 语义，`blocked`（后台工作被挡住）在 agents 里没有独立事实，不造。
fn running_status(entry: &SubagentEntry) -> &'static str {
    if entry.waiting { "waiting" } else { "running" }
}

fn encode_cursor(child: &str, ended_at: u64) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(json!({"childSessionId": child, "endedAt": ended_at}).to_string())
}

/// 已结束项按 `endedAt` 从新到旧分页。游标指向「上一页最后一项之前」的位置。
fn paginate(ended: &[Value], cursor: Option<&str>, limit: usize) -> (Vec<Value>, Option<String>) {
    let decoded: Option<(String, u64)> = cursor.and_then(|cursor| {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(cursor)
            .ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        Some((
            value["childSessionId"].as_str()?.to_owned(),
            value["endedAt"].as_u64()?,
        ))
    });
    let key = |item: &Value| {
        (
            item["endedAt"].as_u64().unwrap_or(0),
            item["childSessionId"].as_str().unwrap_or_default().to_owned(),
        )
    };
    let start = match &decoded {
        Some((child, ended_at)) => ended
            .iter()
            .position(|item| {
                let (at, id) = key(item);
                at < *ended_at || (at == *ended_at && id.as_str() < child.as_str())
            })
            .unwrap_or(ended.len()),
        None => 0,
    };
    let items: Vec<Value> = ended.iter().skip(start).take(limit).cloned().collect();
    let next = items
        .last()
        .filter(|_| start + items.len() < ended.len())
        .map(|last| {
            encode_cursor(
                last["childSessionId"].as_str().unwrap_or_default(),
                last["endedAt"].as_u64().unwrap_or(0),
            )
        });
    (items, next)
}

pub async fn list(
    server: &Server,
    params: &Value,
) -> Result<Value, nibi_kernel_protocol_core::rpc::RpcError> {
    let session = params["sessionId"].as_str().unwrap_or_default();
    let limit = params["endedLimit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;
    let cursor = params["endedCursor"].as_str();
    let live = server
        .live(&nibi_kernel_api::ids::SessionId::new(session))
        .await
        .map_err(|error| kernel_error(&error))?;
    let entries = live.handle.subagents().await.map_err(|error| match error {
        KernelError::Unsupported { .. } => kernel_error(&KernelError::NotFound {
            session: nibi_kernel_api::ids::SessionId::new(session),
        }),
        other => kernel_error(&other),
    })?;

    let now = server.context.now();
    let mut child_session_ids = Vec::new();
    let mut running = Vec::new();
    let mut ended = Vec::new();
    for entry in &entries {
        child_session_ids.push(json!(entry.child.as_str()));
        if entry.status == SubagentStatus::Running {
            running.push(json!({
                "childSessionId": entry.child.as_str(),
                "agentId": entry.agent.as_str(),
                "subagentType": entry.agent_type,
                "title": entry.description,
                "status": running_status(entry),
                "startedAt": now.saturating_sub(entry.elapsed_ms),
            }));
            continue;
        }
        // `ended_ago_ms` 是查询时刻的回看，反推结束时刻；没有时按现在算（与 Node 落库时刻同一取舍）。
        let ended_at = entry
            .ended_ago_ms
            .map_or(now, |ago| now.saturating_sub(ago));
        let mut item = json!({
            "childSessionId": entry.child.as_str(),
            "agentId": entry.agent.as_str(),
            "subagentType": entry.agent_type,
            "title": entry.description,
            "status": ended_status(entry.status),
            "startedAt": ended_at.saturating_sub(entry.elapsed_ms),
            "endedAt": ended_at,
        });
        if let Some(activity) = &entry.activity {
            item["summary"] = json!(activity_summary(activity));
        }
        ended.push(item);
    }
    running.sort_by(|left, right| {
        let key = |value: &Value| {
            (
                value["startedAt"].as_u64().unwrap_or(0),
                value["childSessionId"].as_str().unwrap_or_default().to_owned(),
            )
        };
        key(right).cmp(&key(left))
    });
    ended.sort_by(|left, right| {
        let key = |value: &Value| {
            (
                value["endedAt"].as_u64().unwrap_or(0),
                value["childSessionId"].as_str().unwrap_or_default().to_owned(),
            )
        };
        key(right).cmp(&key(left))
    });

    let total = ended.len();
    let (items, next_cursor) = paginate(&ended, cursor, limit);
    // optional 纪律：没有下一页时整个 `nextCursor` 键不写（schema 是 optional，不是 nullable）。
    let mut ended_value = json!({"total": total, "items": items});
    if let Some(cursor) = next_cursor {
        ended_value["nextCursor"] = json!(cursor);
    }
    Ok(json!({
        "revision": (total + running.len()) as u64,
        "childSessionIds": child_session_ids,
        "running": running,
        "ended": ended_value,
    }))
}

/// 子代理「正在做什么」的一行文字（目录里作为 `summary`）。内核的 `activity` 是结构化枚举。
fn activity_summary(activity: &nibi_kernel_api::panels::SubagentActivity) -> String {
    use nibi_kernel_api::panels::SubagentActivity;
    match activity {
        SubagentActivity::Thinking => "thinking".to_owned(),
        SubagentActivity::Tool { name } => format!("tool: {name}"),
        SubagentActivity::Retrying { attempt, .. } => format!("retrying (attempt {attempt})"),
        SubagentActivity::Stalled { .. } => "stalled".to_owned(),
    }
}

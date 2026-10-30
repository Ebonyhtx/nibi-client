//! DWF run 的只读仓储（`dwf_run`，migration 0019）。引擎在 Node 侧写，Rust 只读
//! （docs/rust-kernel-dwf-design-2026-10-30.md 的路线 C）。事件流（`dwf_event`）是两边共用的：
//! 引擎 sidecar 写 run/actor/node/report/artifact 的事件，宿主（路线 C 的 driver）写升级问答的
//! `escalation-raised` / `escalation-resolved`——两内核的 journal 因此是同一份词汇表。
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use rust_cli_kernel_api::workflow::DynamicWorkflowRun;

/// 一个会话发起的 run（按 `time_created` 升序，与 Node 的 run 列表一致）。
pub fn list(conn: &Connection, session: &str) -> Result<Vec<DynamicWorkflowRun>> {
    let mut query = conn.prepare_cached(
        "select id, parent_session_id, cwd, name, status, resumed_from, tool_call_id,
                spent_tokens, time_created, time_updated
         from dwf_run where parent_session_id = ? order by time_created, rowid",
    )?;
    let rows = query.query_map(params![session], |row| {
        Ok(DynamicWorkflowRun {
            id: row.get(0)?,
            session_id: row.get(1)?,
            cwd: row.get(2)?,
            name: row.get(3)?,
            status: row.get(4)?,
            resumed_from: row.get(5)?,
            tool_call_id: row.get(6)?,
            spent_tokens: row.get::<_, i64>(7)?.max(0) as u64,
            created_at: row.get::<_, i64>(8)?.max(0) as u64,
            updated_at: row.get::<_, i64>(9)?.max(0) as u64,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// journal 的一行事件：`(sequence, type, payload_json, time_created)`，按序号升序。
/// `payload_json` 与 Node 同构——整个 RunEvent 的 JSON（含 `type` 字段）。
pub struct EventRow {
    pub sequence: i64,
    pub event_type: String,
    pub payload_json: String,
    pub time_created: i64,
}

/// 追加一条 run 事件。序号分配与写入必须是同一条语句（Node `appendEvent` 的同一条 INSERT）：
/// `MAX(sequence)+1` 单独读一次再插，会在多进程（WAL 下多个 Agent 共享同一个库）之间竞争出
/// 重复序号。返回分配到的序号。
pub fn append_event(
    conn: &Connection,
    run_id: &str,
    event_type: &str,
    payload_json: &str,
    now_ms: u64,
) -> Result<i64> {
    let sequence: Option<i64> = conn
        .query_row(
            "insert into dwf_event (run_id, sequence, type, payload_json, time_created)
             values (
               ?,
               coalesce((select max(sequence) + 1 from dwf_event where run_id = ?), 0),
               ?, ?, ?
             )
             returning sequence",
            params![run_id, run_id, event_type, payload_json, now_ms as i64],
            |row| row.get(0),
        )
        .optional()?;
    let Some(sequence) = sequence else {
        anyhow::bail!("dwf journal: event insert returned no sequence for run: {run_id}");
    };
    Ok(sequence)
}

/// 一个 run 的全部事件（按序号升序）。
pub fn events(conn: &Connection, run_id: &str) -> Result<Vec<EventRow>> {
    let mut query = conn.prepare_cached(
        "select sequence, type, payload_json, time_created
         from dwf_event where run_id = ? order by sequence, rowid",
    )?;
    let rows = query.query_map(params![run_id], |row| {
        Ok(EventRow {
            sequence: row.get(0)?,
            event_type: row.get(1)?,
            payload_json: row.get(2)?,
            time_created: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 从事件流重放出的在等问题（Node run 详情的 `pendingQuestions`；冷回放的数据源）：
/// `escalation-raised` 减去同 qid 的 `escalation-resolved`，按提问顺序。停驻表是内存态，
/// 这份重放就是进程重启后唯一还看得到「谁在等」的地方。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalQuestion {
    pub qid: String,
    pub actor: String,
    pub actor_name: Option<String>,
    pub question: String,
    pub context: Option<String>,
    /// 提问时刻（事件载荷里的 `askedAt`，不是落库时刻——Node 两条读面共用的同一个瞬间）。
    pub asked_at: u64,
}

pub fn pending_questions(conn: &Connection, run_id: &str) -> Result<Vec<JournalQuestion>> {
    let mut pending = Vec::new();
    for event in events(conn, run_id)? {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload_json) else {
            continue;
        };
        match event.event_type.as_str() {
            "escalation-raised" => {
                // Node 的事件带结构化 ActorRef（`{siteId, ordinal}`）；读面恢复成与快照
                // `pendingQuestions[].actor` 同一个 `siteId@ordinal` 字符串。
                let actor = match payload["actor"]["siteId"].as_str() {
                    Some(site) => Some(format!(
                        "{site}@{}",
                        payload["actor"]["ordinal"].as_u64().unwrap_or(0)
                    )),
                    None => payload["actor"].as_str().map(str::to_owned),
                };
                let (Some(qid), Some(actor), Some(question), Some(asked_at)) = (
                    payload["qid"].as_str().map(str::to_owned),
                    actor,
                    payload["question"].as_str().map(str::to_owned),
                    payload["askedAt"].as_i64(),
                ) else {
                    continue;
                };
                pending.push(JournalQuestion {
                    qid,
                    actor,
                    actor_name: payload["actorName"].as_str().map(str::to_owned),
                    question,
                    context: payload["context"].as_str().map(str::to_owned),
                    asked_at: asked_at.max(0) as u64,
                });
            }
            // 已答的问题退场；resolved 先于 raised（乱序行损坏）时忽略——没有对应的提问可退。
            "escalation-resolved" => {
                let Some(qid) = payload["qid"].as_str() else {
                    continue;
                };
                pending.retain(|question| question.qid != qid);
            }
            _ => {}
        }
    }
    Ok(pending)
}

#[cfg(test)]
#[path = "dwf_tests.rs"]
mod tests;

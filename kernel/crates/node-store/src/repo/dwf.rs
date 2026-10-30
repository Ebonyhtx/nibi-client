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

/// 一行 run 的完整读取（`GetWorkflowRun` 详情的取数面；`failure_json` 保持原文，终态
/// 的拆解——stopped 包络 / Interrupted 判别——按 Node `decodeRunSettlement` 由调用方做）。
pub struct RunRow {
    pub id: String,
    pub parent_session_id: Option<String>,
    pub name: Option<String>,
    pub script_text: Option<String>,
    pub status: String,
    pub resumed_from: Option<String>,
    pub caps_max_concurrency: i64,
    pub spent_tokens: i64,
    pub result_json: Option<String>,
    pub failure_json: Option<String>,
    pub time_created: i64,
    pub time_updated: i64,
}

pub fn run_row(conn: &Connection, run_id: &str) -> Result<Option<RunRow>> {
    conn.query_row(
        "select id, parent_session_id, name, script_text, status, resumed_from,
                caps_max_concurrency, spent_tokens, result_json, failure_json,
                time_created, time_updated
         from dwf_run where id = ?",
        params![run_id],
        |row| {
            Ok(RunRow {
                id: row.get(0)?,
                parent_session_id: row.get(1)?,
                name: row.get(2)?,
                script_text: row.get(3)?,
                status: row.get(4)?,
                resumed_from: row.get(5)?,
                caps_max_concurrency: row.get(6)?,
                spent_tokens: row.get(7)?,
                result_json: row.get(8)?,
                failure_json: row.get(9)?,
                time_created: row.get(10)?,
                time_updated: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// 节点行计数（`nodesObserved` 是已落库节点的行数，三态之和——绝不冒充「总步数」）。
pub struct NodeCounts {
    pub observed: u64,
    pub running: u64,
    pub completed: u64,
    pub failed: u64,
}

pub fn node_counts(conn: &Connection, run_id: &str) -> Result<NodeCounts> {
    let mut query = conn.prepare_cached(
        "select status, count(*) from dwf_node where run_id = ? group by status",
    )?;
    let rows = query.query_map(params![run_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut counts = NodeCounts {
        observed: 0,
        running: 0,
        completed: 0,
        failed: 0,
    };
    for row in rows {
        let (status, count) = row?;
        let count = count.max(0) as u64;
        counts.observed += count;
        match status.as_str() {
            "running" => counts.running = count,
            "completed" => counts.completed = count,
            "failed" => counts.failed = count,
            _ => {}
        }
    }
    Ok(counts)
}

/// 一个 actor 站点实例（恒定的身份表；persona 刻意不出——整段 system prompt 无界）。
pub struct ActorRow {
    pub site_id: String,
    pub ordinal: i64,
    pub name: Option<String>,
}

pub fn actors(conn: &Connection, run_id: &str) -> Result<Vec<ActorRow>> {
    let mut query = conn.prepare_cached(
        "select site_id, ordinal, name from dwf_actor where run_id = ? order by id",
    )?;
    let rows = query.query_map(params![run_id], |row| {
        Ok(ActorRow {
            site_id: row.get(0)?,
            ordinal: row.get(1)?,
            name: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// `log()` 叙事的尾巴，按时序（`order by sequence desc limit ?` 再反转——一条长 run 的
/// dwf_event 是它最大的表，为尾巴几条读全表是分页要排除的做法；type 列下推）。
pub fn log_tail(conn: &Connection, run_id: &str, limit: usize) -> Result<Vec<EventRow>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let mut query = conn.prepare_cached(
        "select sequence, type, payload_json, time_created from dwf_event
         where run_id = ? and type = 'log' order by sequence desc limit ?",
    )?;
    let mut rows = query
        .query_map(params![run_id, limit], |row| {
            Ok(EventRow {
                sequence: row.get(0)?,
                event_type: row.get(1)?,
                payload_json: row.get(2)?,
                time_created: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.reverse();
    Ok(rows)
}

/// 详情读面的 log 尾巴上限（Node `DEFAULT_LOG_TAIL_LIMIT`）。
pub const LOG_TAIL_LIMIT: usize = 20;
/// Node `INTERRUPTED_CODE`：失败码为它的 `failed` 行，逻辑状态是 `stopped(interrupted)`——
/// 「进程死了」与「脚本真失败」是模型要分别处理的两件事。
const INTERRUPTED_CODE: &str = "Interrupted";
/// 展示标签的字符上限（Node `DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS`；派生值是启发式，越长越不像标签）。
const LABEL_MAX_CHARS: usize = 80;

/// 脚本派生标签：首个非空行（trim 后截 80）——首行是**诚实的**（「脚本以此开头」），启发式
/// 每多一条就多一种在别人的脚本上给出误导标签的方式。整段皆空白时回 runId。
fn derived_label(script_text: Option<&str>, run_id: &str) -> String {
    let Some(text) = script_text else {
        return run_id.to_owned();
    };
    for line in text.split('\n') {
        let line = line.trim();
        if !line.is_empty() {
            let mut label: String = line.chars().take(LABEL_MAX_CHARS).collect();
            if line.chars().count() > LABEL_MAX_CHARS {
                label.push('…');
            }
            return label;
        }
    }
    run_id.to_owned()
}

/// 详情合成（Node `decodeRunSettlement` + run service 详情投影的 journal 侧）：run 行的终态
/// 拆解（stopped 包络 / Interrupted 判别）、标签派生、节点计数、actors、log 尾巴与冷回放的
/// 待答问题。未知 runId → `None`。停驻注册表的活项由运行时的读面并进来。
pub fn run_detail(
    conn: &Connection,
    session: &str,
    run_id: &str,
) -> Result<Option<rust_cli_kernel_api::workflow::WorkflowRunDetail>> {
    use rust_cli_kernel_api::workflow as api;
    let Some(row) = run_row(conn, run_id)? else {
        return Ok(None);
    };
    // 终态拆解的产物（Node `DwfRunSettlementFields` 的读取侧等价物）。
    struct Settlement {
        status: String,
        stop_reason: Option<String>,
        superseded_by: Option<String>,
        failure: Option<(String, String)>,
    }
    let settlement = match row.status.as_str() {
        // stopped 包络：`{stopReason, supersededBy?, error?}`（Node `encodeRunSettlement` 的
        // stopped 一支）；缺字段按缺省 stopReason=user 兜底（Node 的 decode 同规）。
        "cancelled" => {
            let envelope = row
                .failure_json
                .as_deref()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
            let stop_reason = envelope
                .as_ref()
                .and_then(|value| value["stopReason"].as_str())
                .unwrap_or("user")
                .to_owned();
            let superseded = envelope
                .as_ref()
                .and_then(|value| value["supersededBy"].as_str())
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            let failure = envelope.as_ref().and_then(|value| {
                Some((
                    value["error"]["code"].as_str()?.to_owned(),
                    value["error"]["message"].as_str()?.to_owned(),
                ))
            });
            Settlement {
                status: "stopped".to_owned(),
                stop_reason: Some(stop_reason),
                superseded_by: superseded,
                failure,
            }
        }
        // failed：code == Interrupted 是「进程死了」（stopped/interrupted），其余是脚本真失败。
        "failed" => {
            let failure_json = row
                .failure_json
                .as_deref()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
            let code = failure_json
                .as_ref()
                .and_then(|value| value["code"].as_str())
                .unwrap_or("Unknown");
            let failure = failure_json.as_ref().and_then(|value| {
                Some((
                    value["code"].as_str()?.to_owned(),
                    value["message"].as_str()?.to_owned(),
                ))
            });
            if code == INTERRUPTED_CODE {
                Settlement {
                    status: "stopped".to_owned(),
                    stop_reason: Some("interrupted".to_owned()),
                    superseded_by: None,
                    failure,
                }
            } else {
                Settlement {
                    status: "errored".to_owned(),
                    stop_reason: None,
                    superseded_by: None,
                    failure,
                }
            }
        }
        "completed" => Settlement {
            status: "completed".to_owned(),
            stop_reason: None,
            superseded_by: None,
            failure: None,
        },
        other => Settlement {
            status: other.to_owned(),
            stop_reason: None,
            superseded_by: None,
            failure: None,
        },
    };
    let Settlement {
        status,
        stop_reason,
        superseded_by,
        failure,
    } = settlement;
    let (label, label_source) = match row.name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => (name.to_owned(), "name"),
        None => (derived_label(row.script_text.as_deref(), run_id), "script"),
    };
    // completed 的顶层返回值：string 原样、其余 pretty JSON（Node `serializeWorkflowArtifact`）。
    let result_text = if status == "completed" {
        row.result_json.as_deref().and_then(|text| {
            serde_json::from_str::<serde_json::Value>(text)
                .ok()
                .map(|value| match value {
                    serde_json::Value::String(text) => text,
                    other => serde_json::to_string_pretty(&other).unwrap_or_default(),
                })
        })
    } else {
        None
    };
    let counts = node_counts(conn, run_id)?;
    let actors = actors(conn, run_id)?
        .into_iter()
        .map(|actor| api::WorkflowRunActor {
            site_id: actor.site_id,
            ordinal: actor.ordinal,
            name: actor.name,
        })
        .collect();
    let log_tail = log_tail(conn, run_id, LOG_TAIL_LIMIT)?
        .into_iter()
        .filter_map(|event| {
            let payload = serde_json::from_str::<serde_json::Value>(&event.payload_json).ok()?;
            let message = payload["message"].as_str().map(str::to_owned)?;
            Some(api::WorkflowRunLogEntry {
                sequence: event.sequence,
                message,
                at: (event.time_created >= 0).then_some(event.time_created as u64),
            })
        })
        .collect();
    let pending = pending_questions(conn, run_id)?
        .into_iter()
        .map(|question| api::WorkflowRunPendingQuestion {
            qid: question.qid,
            actor: question.actor,
            actor_name: question.actor_name,
            question: question.question,
            context: question.context,
            asked_at: question.asked_at,
        })
        .collect();
    Ok(Some(api::WorkflowRunDetail {
        run_id: row.id.clone(),
        label,
        label_source,
        status,
        stop_reason,
        resumed_from: row.resumed_from.clone(),
        superseded_by,
        owned_by_this_session: row.parent_session_id.as_deref() == Some(session),
        created_at: row.time_created.max(0) as u64,
        updated_at: row.time_updated.max(0) as u64,
        spent_tokens: row.spent_tokens.max(0) as u64,
        nodes: api::WorkflowRunNodeCounts {
            observed: counts.observed,
            running: counts.running,
            completed: counts.completed,
            failed: counts.failed,
        },
        actors,
        log_tail,
        pending_questions: pending,
        result_text,
        error: failure.map(|(code, message)| api::WorkflowRunError { code, message }),
        max_concurrency: (row.caps_max_concurrency > 0).then_some(row.caps_max_concurrency as u64),
    }))
}

#[cfg(test)]
#[path = "dwf_tests.rs"]
mod tests;

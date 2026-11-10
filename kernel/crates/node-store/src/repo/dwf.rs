//! DWF run 的只读仓储（`dwf_run`，migration 0019）。引擎在 Node 侧写，Rust 只读
//! （docs/rust-kernel-dwf-design-2026-10-30.md 的路线 C）。事件流（`dwf_event`）是两边共用的：
//! 引擎 sidecar 写 run/actor/node/report/artifact 的事件，宿主（路线 C 的 driver）写升级问答的
//! `escalation-raised` / `escalation-resolved`——两内核的 journal 因此是同一份词汇表。
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use nibi_kernel_api::workflow::DynamicWorkflowRun;

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
    pub(crate) status: String,
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

// ————————————————————————————————————————————————————————————————
// 情势截面（GetWorkflowRun 的 `<phases>` / `<subagents>` / `<health>`）：
// Node bootstrap 的 dynamic-workflow-run-roster-events.ts / -phases.ts / -subagents.ts 的移植。
// 纪律与那边逐字相同：缺席即不写，绝不用 0 冒充「不知道」；列宽由本次的行算出来。
// ————————————————————————————————————————————————————————————————

/// 「还在动吗」算数的事件类型：脚本或某个 ask 往前走了（Node `PROGRESS_EVENT_TYPES`）。
/// `node-waiting` 刻意不在其中：等槽位、等退避正是停滞本身。
fn is_progress_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "node-queued"
            | "node-dispatched"
            | "node-executing"
            | "node-settled"
            | "node-progress"
            | "phase-entered"
            | "log"
            | "report"
            | "artifact-published"
            | "usage-updated"
    )
}

/// 节点生命周期事件（相位迁移；Node `NODE_LIFECYCLE_EVENT_TYPES`）。
fn is_node_lifecycle(event_type: &str) -> bool {
    matches!(
        event_type,
        "node-queued"
            | "node-dispatched"
            | "node-executing"
            | "node-waiting"
            | "node-repairing"
            | "node-nudged"
            | "node-settled"
    )
}

/// 一个节点实例在事件轨上留下的痕迹（Node `RosterNodeTrace` 的同构物）。
#[derive(Default)]
struct NodeTrace {
    dispatched_at: Option<u64>,
    /// 最后一条生命周期事件的 type；`waiting` 判据只看它是不是 `node-waiting`。
    last_lifecycle: Option<String>,
    wait_cause: Option<String>,
    wait_reason: Option<String>,
    wait_retry_after_ms: Option<u64>,
    wait_since: Option<u64>,
    last_activity_at: Option<u64>,
}

/// 一个阶段最近一次进入与离开的时刻（Node `RosterPhaseTrace`）。
#[derive(Default, Clone)]
struct PhaseTrace {
    entered_at: Option<u64>,
    exited_at: Option<u64>,
}

/// 一次节点结算（按事件顺序）：健康面的连败与缓存命中都从这串算（Node `RosterSettlement`）。
struct SettlementTrace {
    site_id: String,
    ordinal: i64,
    outcome: String,
    cached: bool,
}

/// 一趟扫过 journal 事件的全部产物（Node `RosterEventIndex`）：
/// 情势截面要的一切时刻与一次结算序。
pub(crate) struct RosterIndex {
    nodes: std::collections::HashMap<String, NodeTrace>,
    phases: std::collections::HashMap<String, PhaseTrace>,
    /// 事件的阶段表时间源：`phase-entered` 之外，节点出生事件的 `phaseName`（reducer 同规：
    /// 出生事件打戳）。
    node_phase_names: std::collections::HashMap<String, String>,
    settlements: Vec<SettlementTrace>,
    last_progress_at: Option<u64>,
    stalled_since: Option<u64>,
    declared_phases: Vec<String>,
    /// `phase-entered` 的进入顺序（去重）；与声明表合并成阶段表行。
    entered_phases: Vec<String>,
    /// 节点出生事件的 `phaseName` → 最近一次出生时刻（进过但未声明的阶段行的进入时刻来源）。
    node_phase_times: std::collections::HashMap<String, u64>,
    current_phase: Option<String>,
    concurrency_reason: Option<String>,
    concurrency_since: Option<u64>,
}

fn later_of(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(left), None) => Some(left),
        (None, right) => right,
    }
}

/// 事件的落库时刻。缺席（非正值）一律读作「没有时钟」，绝不用 now 兜底（Node `timeOf` 同规）。
fn event_time(time_created: i64, now: u64) -> Option<u64> {
    if time_created <= 0 {
        return None;
    }
    Some((time_created as u64).min(now))
}

fn index_events(events: &[EventRow], now: u64) -> RosterIndex {
    let mut index = RosterIndex {
        nodes: std::collections::HashMap::new(),
        phases: std::collections::HashMap::new(),
        node_phase_names: std::collections::HashMap::new(),
        settlements: Vec::new(),
        last_progress_at: None,
        stalled_since: None,
        declared_phases: Vec::new(),
        entered_phases: Vec::new(),
        node_phase_times: std::collections::HashMap::new(),
        current_phase: None,
        concurrency_reason: None,
        concurrency_since: None,
    };
    let mut stalled_pending = false;
    let mut last_phase_name: Option<String> = None;
    for event in events {
        let at = event_time(event.time_created, now);
        let payload = serde_json::from_str::<serde_json::Value>(&event.payload_json);
        let payload = payload.unwrap_or_default();
        if is_progress_event(&event.event_type) {
            index.last_progress_at = later_of(index.last_progress_at, at);
            // 停滞观察之后只要有任何一条进度，停滞就已经结束了——哪怕这条进度没有时间戳。
            stalled_pending = false;
        }
        match event.event_type.as_str() {
            "run-stalled" => {
                index.stalled_since = at;
                stalled_pending = true;
                continue;
            }
            "concurrency-changed" => {
                index.concurrency_reason = payload["reason"].as_str().map(str::to_owned);
                index.concurrency_since = at;
                continue;
            }
            "run-launched" => {
                if let Some(names) = payload["phaseNames"].as_array() {
                    index.declared_phases = names
                        .iter()
                        .filter_map(|name| name.as_str())
                        .map(str::to_owned)
                        .collect();
                }
                if let Some(holes) = payload["holes"].as_array() {
                    // 声明表里的留白站位也是站点（留白按名字站在阶段表里）：进过但未声明的
                    // 阶段行由 phase-entered 补，这里不需要动。
                    let _ = holes;
                }
                continue;
            }
            "phase-entered" => {
                let name = payload["name"].as_str().unwrap_or_default().to_owned();
                // 同名再入（回边）只把进入时刻前移；它结束上一个**异名**阶段（Node `trackPhase`）。
                if let Some(previous) = &last_phase_name
                    && previous != &name
                    && let Some(at) = at
                    && let Some(previous_trace) = index.phases.get_mut(previous)
                {
                    previous_trace.exited_at = Some(at);
                }
                index.phases.insert(name.clone(), PhaseTrace { entered_at: at, exited_at: None });
                if !index.entered_phases.iter().any(|seen| seen == &name) {
                    index.entered_phases.push(name.clone());
                }
                last_phase_name = Some(name.clone());
                index.current_phase = Some(name);
                continue;
            }
            "usage-updated" => continue,
            _ => {}
        }
        let Some(instance) = payload.get("instance") else { continue };
        let Some(site_id) = instance["siteId"].as_str() else { continue };
        let Some(ordinal) = instance["ordinal"].as_i64() else { continue };
        let key = format!("{site_id}@{ordinal}");
        let trace = index.nodes.entry(key.clone()).or_default();
        if is_progress_event(&event.event_type) {
            trace.last_activity_at = later_of(trace.last_activity_at, at);
        }
        if is_node_lifecycle(&event.event_type) {
            trace.last_lifecycle = Some(event.event_type.clone());
            if event.event_type != "node-waiting" {
                trace.wait_cause = None;
                trace.wait_reason = None;
                trace.wait_retry_after_ms = None;
                trace.wait_since = None;
            }
            if event.event_type == "node-queued" {
                trace.dispatched_at = None;
            }
            if event.event_type == "node-dispatched" {
                trace.dispatched_at = at;
            }
        }
        if event.event_type == "node-waiting" {
            // 已经在等就保留**进入那一刻**：退避阶梯会连发好几条，读者问的是「卡了多久」。
            let since = trace.wait_since.or(at);
            trace.wait_cause = payload["cause"].as_str().map(str::to_owned);
            trace.wait_reason = payload["reason"].as_str().map(str::to_owned);
            trace.wait_retry_after_ms = payload["retryAfterMs"].as_u64();
            trace.wait_since = since;
        }
        if event.event_type == "node-queued" || event.event_type == "node-settled" {
            // 出生事件打戳（reducer 同规）：`node-queued` 的 `phaseName`，或缓存命中的
            // `node-settled` 重发的出生事实。
            if let Some(phase_name) = payload["phaseName"].as_str() {
                index.node_phase_names.insert(key.clone(), phase_name.to_owned());
                if let Some(at) = at {
                    index
                        .node_phase_times
                        .entry(phase_name.to_owned())
                        .and_modify(|latest| *latest = (*latest).max(at))
                        .or_insert(at);
                }
            }
        }
        if event.event_type == "node-settled" {
            index.settlements.push(SettlementTrace {
                site_id: site_id.to_owned(),
                ordinal,
                outcome: payload["outcome"].as_str().unwrap_or_default().to_owned(),
                cached: payload["cached"] == serde_json::Value::Bool(true),
            });
        }
    }
    if !stalled_pending {
        index.stalled_since = None;
    }
    index
}

/// 详情读面的 log 尾巴上限（Node `DEFAULT_LOG_TAIL_LIMIT`）。
pub const LOG_TAIL_LIMIT: usize = 20;

// ————————————————————————————————————————————————————————————————
// 阶段表 / 花名册 / 健康面的合成（Node buildPhaseViews / buildSubagentViews / buildHealth
// 的移植；纯合成规则，事件与行由 run_detail 读好递进来）。
// ————————————————————————————————————————————————————————————————

/// `subagents` 的行数上界（Node `GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents`）。超出整块裁过。
const MAX_SUBAGENTS: usize = 64;

/// `subagents` 恒在场——但一个 run 若是循环保留了超量的 actor 行，裁整块并说明裁过。
/// Rust 读面用缺席表达（消费方补 `truncated` 词）；驱动探针只数两条 run，界内。
/// 情势截面的取数入参（事件索引、节点行、actor 行、出生阶段、进度读数与待答问题）。
pub(crate) struct RosterInput<'a> {
    pub(crate) index: &'a RosterIndex,
    pub status: &'a str,
    pub(crate) declared_phases: &'a [String],
    pub(crate) entered_phases: &'a [String],
    pub(crate) node_rows: &'a [NodeRow],
    /// 节点出生阶段（`node-queued` / 缓存 `node-settled` 的 `phaseName`）。
    pub(crate) node_phase_names: &'a std::collections::HashMap<String, String>,
    /// actor 的出生阶段（`actor-created` 的 `phaseName` 重放）。
    pub(crate) actor_phases: &'a std::collections::HashMap<String, String>,
    /// 花名册的 ask 进度（`node-progress` 的归约）。
    pub(crate) progress: &'a std::collections::HashMap<String, AskProgress>,
    pub(crate) actors: &'a [ActorRow],
    pub(crate) pending_questions: &'a [nibi_kernel_api::workflow::WorkflowRunPendingQuestion],
}

/// 一次 ask 的进度读数（`node-progress` 的字段；turn/toolCalls 缺席 = 不知道，0 = 零）。
#[derive(Default, Clone)]
pub struct AskProgress {
    pub turn: Option<u64>,
    pub tool_calls: Option<u64>,
    pub last_tool: Option<nibi_kernel_api::workflow::WorkflowRunSubagentLastTool>,
    pub instructions_head: Option<String>,
}

fn roster_of(
    detail: &RosterInput<'_>,
) -> (
    Option<Vec<nibi_kernel_api::workflow::WorkflowRunPhaseView>>,
    Vec<nibi_kernel_api::workflow::WorkflowRunSubagentView>,
    nibi_kernel_api::workflow::WorkflowRunHealth,
) {
    use nibi_kernel_api::workflow as api;
    let index = detail.index;
    let terminal = is_terminal_status(detail.status);
    // —— 阶段表：声明序 + 进过未声明的（按首次进入序）；两处都空 → 整字段缺席。——
    let mut names: Vec<String> = detail.declared_phases.to_vec();
    for name in &index.entered_phases {
        if !names.iter().any(|seen| seen == name) {
            names.push(name.clone());
        }
    }
    let phases = if names.is_empty() {
        None
    } else {
        Some(
            names
                .iter()
                .map(|name| {
                    let trace = index.phases.get(name);
                    let rounds =
                        u64::try_from(detail.entered_phases.iter().filter(|seen| *seen == name).count())
                            .unwrap_or(0);
                    let entered =
                        trace.and_then(|trace| trace.entered_at).or_else(|| index.node_phase_times.get(name).copied());
                    let (nodes_settled, nodes_running, has_unsettled) = detail
                        .node_rows
                        .iter()
                        .filter(|node| {
                            detail
                                .node_phase_names
                                .get(node.key())
                                .is_some_and(|phase| phase == name)
                        })
                        .fold(
                            (0u64, 0u64, false),
                            |(mut settled, mut running, mut has), node| {
                                if node.status == "running" {
                                    running += 1;
                                    has |= node.kind != "world-read";
                                } else {
                                    settled += 1;
                                }
                                (settled, running, has)
                            },
                        );
                    let state = if rounds == 0 {
                        "ahead"
                    } else if terminal {
                        if has_unsettled { "unfinished" } else { "done" }
                    } else if index.current_phase.as_deref() == Some(name) {
                        "current"
                    } else {
                        "done"
                    };
                    api::WorkflowRunPhaseView {
                        name: name.clone(),
                        state: state.to_owned(),
                        rounds,
                        nodes_settled,
                        nodes_running,
                        entered_at: entered,
                        exited_at: trace.and_then(|trace| trace.exited_at),
                    }
                })
                .collect(),
        )
    };
    // —— 花名册：actor 行的顺序 = 铸造顺序；恒在场的数组。——
    let mut subagents = Vec::new();
    for actor in detail.actors {
        if subagents.len() >= MAX_SUBAGENTS {
            break;
        }
        let key = format!("{}@{}", actor.site_id, actor.ordinal);
        let asks: Vec<&NodeRow> = detail
            .node_rows
            .iter()
            .filter(|node| {
                node.actor_site_id.as_deref() == Some(actor.site_id.as_str())
                    && node.actor_ordinal == Some(actor.ordinal)
            })
            .collect();
        let settled_rows: Vec<&&NodeRow> = asks.iter().filter(|node| node.status != "running").collect();
        let running_ask = asks
            .iter()
            .rfind(|node| node.status == "running")
            .copied();
        let trace = running_ask.and_then(|node| index.nodes.get(node.key()));
        let parked_on = detail
            .pending_questions
            .iter()
            .find(|question| question.actor == key)
            .map(|question| question.qid.clone());
        let last_ask_failed = settled_rows.last().is_some_and(|node| node.status == "failed");
        let state: &str = if terminal {
            if running_ask.is_some() {
                "unfinished"
            } else if last_ask_failed {
                "failed"
            } else {
                "done"
            }
        } else if parked_on.is_some() {
            "parked"
        } else if running_ask.is_some() {
            if trace.is_some_and(|trace| trace.last_lifecycle.as_deref() == Some("node-waiting")) {
                "waiting"
            } else {
                "executing"
            }
        } else if last_ask_failed {
            "failed"
        } else {
            "idle"
        };
        // 当前 ask 的截面：身份来自行（actorSeq 的权威在 actor_* 列，不在事件上）。
        let current_ask = running_ask.map(|node| {
            let progress = detail.progress.get(node.key());
            api::WorkflowRunSubagentAsk {
                site_id: node.site_id.clone(),
                ordinal: u64::try_from(node.ordinal).unwrap_or(0),
                actor_seq: node.actor_seq.map(|seq| seq.max(0) as u64),
                instructions_head: progress.and_then(|progress| progress.instructions_head.clone()),
                started_at: trace.and_then(|trace| trace.dispatched_at),
                turn: progress.and_then(|progress| progress.turn),
                tool_calls: progress.and_then(|progress| progress.tool_calls),
                last_tool: progress.and_then(|progress| progress.last_tool.clone()),
            }
        });
        let phase_name = running_ask
            .and_then(|node| detail.node_phase_names.get(node.key()))
            .or_else(|| settled_rows.last().and_then(|node| detail.node_phase_names.get(node.key())))
            .or_else(|| {
                detail
                    .actor_phases
                    .get(&format!("{}@{}", actor.site_id, actor.ordinal))
            })
            .cloned();
        let tokens: u64 = settled_rows.iter().filter_map(|node| node.tokens()).sum();
        let last_progress_at = asks
            .iter()
            .filter_map(|node| index.nodes.get(node.key()).and_then(|trace| trace.last_activity_at))
            .max();
        subagents.push(api::WorkflowRunSubagentView {
            site_id: actor.site_id.clone(),
            ordinal: u64::try_from(actor.ordinal).unwrap_or(0),
            name: actor.name.clone(),
            state: state.to_owned(),
            phase_name,
            current_ask,
            wait: trace.and_then(|trace| {
                trace.wait_cause.as_ref().map(|cause| api::WorkflowRunSubagentWait {
                    cause: cause.clone(),
                    reason: trace.wait_reason.clone(),
                    retry_after_ms: trace.wait_retry_after_ms,
                    since: trace.wait_since,
                })
            }),
            parked_on,
            steps_settled: settled_rows.len() as u64,
            steps_failed: settled_rows.iter().filter(|node| node.status == "failed").count() as u64,
            tokens,
            last_progress_at,
        });
    }
    // —— 健康面：last_progress / stalled / 连败 / 缓存命中 / 终态遗留。——
    let leftover_running = if terminal {
        let count = detail.node_rows.iter().filter(|node| node.status == "running").count();
        u64::try_from(count).unwrap_or(0)
    } else {
        0
    };
    // 连败：按结算顺序结尾处连续失败的 **ask**（world-read 的失败不是子代理在垮；cancelled 断开）。
    let ask_keys: std::collections::HashSet<&str> = detail
        .node_rows
        .iter()
        .filter(|node| node.kind == "ask")
        .map(NodeRow::key)
        .collect();
    let mut consecutive_failures = 0u64;
    for settlement in index.settlements.iter().rev() {
        let key = format!("{}@{}", settlement.site_id, settlement.ordinal);
        if !ask_keys.contains(key.as_str()) {
            continue;
        }
        if settlement.outcome != "failed" {
            break;
        }
        consecutive_failures += 1;
    }
    let health = api::WorkflowRunHealth {
        last_progress_at: index.last_progress_at,
        stalled_since: index.stalled_since,
        concurrency: None,
        consecutive_failures,
        cached_steps: index.settlements.iter().filter(|s| s.cached).count() as u64,
        leftover_running: (leftover_running > 0).then_some(leftover_running),
        pending_questions_known: true,
    };
    (phases, subagents, health)
}

fn is_terminal_status(status: &str) -> bool {
    matches!(status, "completed" | "errored" | "stopped")
}

// ————————————————————————————————————————————————————————————————
// 节点行（dwf_node 的非 report 行，不带结果）：花名册的「谁名下几次 ask 成没成」。
// ————————————————————————————————————————————————————————————————

/// 一行非 report 节点（花名册读面要的字段；结果正文刻意不读——这一面没有读者）。
#[derive(Clone)]
pub struct NodeRow {
    pub site_id: String,
    pub ordinal: i64,
    pub kind: String,
    pub status: String,
    pub actor_site_id: Option<String>,
    pub actor_ordinal: Option<i64>,
    pub actor_seq: Option<i64>,
    pub stats_json: Option<String>,
    /// 实例键（构造点算好一次；`key()` 读它）。非 pub 字段：读写都走 [`NodeRow::key`]。
    _key: String,
}

impl NodeRow {
    /// 实例键 `siteId@ordinal`（与引擎的 `refToString` 同形）。
    pub fn key(&self) -> &str {
        self._key.as_str()
    }
}

// `_key` 由 run_detail 填（`NodeRow` 自身没有 run 上下文；构造点统一算好一次）。
impl NodeRow {
    fn with_key(mut self) -> Self {
        self._key = format!("{}@{}", self.site_id, self.ordinal);
        self
    }

    /// `stats_json` 的 tokens（缺席/坏 JSON 按没有算——「不知道」与 0 分开是读侧的事，
    /// 这里的用途是已结算 ask 的用量累计，缺了它这一条按 0 计）。
    fn tokens(&self) -> Option<u64> {
        let text = self.stats_json.as_deref()?;
        let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
        value["tokens"].as_u64()
    }
}

pub fn node_rows(conn: &Connection, run_id: &str) -> Result<Vec<NodeRow>> {
    let mut query = conn.prepare_cached(
        "select site_id, ordinal, kind, status, actor_site_id, actor_ordinal, actor_seq,
                artifact_id, stats_json
         from dwf_node where run_id = ? and kind != 'report' order by id",
    )?;
    let rows = query.query_map(params![run_id], |row| {
        Ok(NodeRow {
            site_id: row.get(0)?,
            ordinal: row.get(1)?,
            kind: row.get(2)?,
            status: row.get(3)?,
            actor_site_id: row.get(4)?,
            actor_ordinal: row.get(5)?,
            actor_seq: row.get(6)?,
            stats_json: row.get(8)?,
            _key: String::new(),
        }
        .with_key())
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 一条打在预置产物上的标签 report（`itemCount` 的来源；`group by` 下推，行不读出）。
pub fn tagged_report_counts(conn: &Connection, run_id: &str) -> Result<std::collections::HashMap<String, u64>> {
    let mut query = conn.prepare_cached(
        "select artifact_id, count(*) from dwf_node
         where run_id = ? and kind = 'report' and artifact_id is not null
         group by artifact_id",
    )?;
    let rows = query.query_map(params![run_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut counts = std::collections::HashMap::new();
    for row in rows {
        let (artifact_id, total) = row?;
        counts.insert(artifact_id, total.max(0) as u64);
    }
    Ok(counts)
}

// ————————————————————————————————————————————————————————————————
// 留白投影（`<holes>`）：`hole-reached` / `hole-filled` 事件 + 停驻表（Node
// `projectRunHoles` 的移植）。`waiting` 只在停驻表里有它时成立——进程亡故后没有
// promise 在等，单靠事件会把一个没人问的留白报成在等。
// ————————————————————————————————————————————————————————————————

/// 停驻表的键（宿主把引擎此刻开放的留白按 `siteId@ordinal` 报上来）。
pub type OpenHoleKey = String;

/// 留白的事实行：`hole-reached`（到达）与 `hole-filled`（补全）合流的读面产物。
pub struct HoleRow {
    pub site_id: String,
    pub ordinal: i64,
    pub name: String,
    /// 类型实参原文（脚本侧编译产物的 `typeText`）；宿主递进来的编译事实表缺席时按 unknown 占位。
    pub hole_type: String,
    pub state: String,
    pub since: Option<u64>,
    pub filled_at: Option<u64>,
    pub filled_by: Option<String>,
}

pub fn hole_rows(
    conn: &Connection,
    run_id: &str,
    open_holes: &[OpenHoleKey],
    hole_types: &std::collections::HashMap<String, String>,
) -> Result<Vec<HoleRow>> {
    let events = {
        let mut query = conn.prepare_cached(
            "select sequence, type, payload_json, time_created from dwf_event
             where run_id = ? and type in ('hole-reached', 'hole-filled') order by sequence, rowid",
        )?;
        query
            .query_map(params![run_id], |row| {
                Ok(EventRow {
                    sequence: row.get(0)?,
                    event_type: row.get(1)?,
                    payload_json: row.get(2)?,
                    time_created: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if events.is_empty() {
        return Ok(Vec::new());
    }
    let waiting: std::collections::HashSet<&String> = open_holes.iter().collect();
    let mut filled_by_site: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    let mut reached: Vec<(serde_json::Value, Option<u64>)> = Vec::new();
    for event in &events {
        let payload = serde_json::from_str::<serde_json::Value>(&event.payload_json).unwrap_or_default();
        if event.event_type == "hole-filled" {
            if let Some(site) = payload["siteId"].as_str() {
                filled_by_site.insert(site.to_owned(), payload);
            }
        } else {
            reached.push((payload, event_time(event.time_created, i64::MAX as u64).or(event_time(event.time_created, u64::MAX / 2))));
        }
    }
    let mut out = Vec::new();
    for (payload, at) in reached {
        if out.len() >= 32 {
            break;
        }
        let Some(site_id) = payload["instance"]["siteId"].as_str() else { continue };
        let Some(ordinal) = payload["instance"]["ordinal"].as_i64() else { continue };
        let name = payload["name"].as_str().unwrap_or(site_id).to_owned();
        let filled = filled_by_site.get(site_id);
        let is_waiting = waiting.contains(&format!("{site_id}@{ordinal}"));
        if !is_waiting && filled.is_none() {
            continue;
        }
        out.push(HoleRow {
            site_id: site_id.to_owned(),
            ordinal,
            name,
            hole_type: hole_types.get(site_id).cloned().unwrap_or_else(|| "unknown".to_owned()),
            state: if is_waiting { "waiting" } else { "filled" }.to_owned(),
            since: if is_waiting { at } else { None },
            filled_at: filled.and_then(|value| value["filledAt"].as_u64()),
            filled_by: filled
                .and_then(|value| value["filledBy"].as_str())
                .map(str::to_owned),
        });
    }
    Ok(out)
}

// ————————————————————————————————————————————————————————————————
// 用户面产物归并（`<artifacts>`）：`dwf_node kind='artifact'` 的行 → Node
// `artifactsOf` 的同一份清单——只收 completed 的行（失败的发布不占 id、不占版本号），
// 顶层字段取最新版，`itemCount` 是打标的 report 行数，primary 带头。
// ————————————————————————————————————————————————————————————————

/// 归并后的用户面产物（Node `DynamicWorkflowRunArtifact` 的模型面子集）。
pub struct ArtifactRow {
    pub id: String,
    pub kind: String,
    pub title: Option<String>,
    pub version: u64,
    pub content_type: Option<String>,
    pub bytes: Option<u64>,
    pub item_count: u64,
    pub primary: bool,
}

impl From<ArtifactRow> for nibi_kernel_api::workflow::WorkflowRunArtifact {
    fn from(artifact: ArtifactRow) -> Self {
        Self {
            id: artifact.id,
            kind: artifact.kind,
            title: artifact.title,
            version: artifact.version,
            content_type: artifact.content_type,
            bytes: artifact.bytes,
            item_count: artifact.item_count,
            primary: artifact.primary.then_some(true),
        }
    }
}

pub fn artifact_rows(conn: &Connection, run_id: &str) -> Result<Vec<ArtifactRow>> {
    let mut query = conn.prepare_cached(
        "select artifact_id, result_json, time_updated from dwf_node
         where run_id = ? and kind = 'artifact' and status = 'completed' order by id",
    )?;
    let rows = query
        .query_map(params![run_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // id → (kind, 最新版记录)。插入序 = 首次出现顺序（端口契约上 artifacts 的顺序）。
    let mut order: Vec<String> = Vec::new();
    let mut by_id: std::collections::HashMap<String, (String, serde_json::Value)> =
        std::collections::HashMap::new();
    for (artifact_id, result_json, _updated) in rows {
        let Some(record_text) = result_json else { continue };
        let Ok(record) = serde_json::from_str::<serde_json::Value>(&record_text) else { continue };
        // 版本不是正整数就整行丢弃（没有版本号的版本在 UI 上无法定位）。
        let version = record["version"].as_i64().unwrap_or(0);
        if version < 1 {
            continue;
        }
        let Some(kind) = record["kind"].as_str().filter(|kind| {
            matches!(*kind, "file" | "markdown" | "chart" | "table" | "metrics" | "board")
        }) else {
            continue;
        };
        let id = match artifact_id {
            Some(id) if !id.is_empty() => id,
            _ => match record["id"].as_str() {
                Some(id) if !id.is_empty() => id.to_owned(),
                _ => continue,
            },
        };
        match by_id.get_mut(&id) {
            Some((_known_kind, latest)) if version >= latest["version"].as_i64().unwrap_or(0) => {
                *latest = record;
            }
            Some(_) => {}
            None => {
                order.push(id.clone());
                by_id.insert(id, (kind.to_owned(), record));
            }
        }
    }
    if by_id.is_empty() {
        return Ok(Vec::new());
    }
    let counts = tagged_report_counts(conn, run_id)?;
    let mut out: Vec<ArtifactRow> = order
        .into_iter()
        .filter_map(|id| {
            let (kind, latest) = by_id.remove(&id)?;
            let version = latest["version"].as_i64()?.max(0) as u64;
            let is_preset = matches!(kind.as_str(), "chart" | "table" | "metrics" | "board");
            Some(ArtifactRow {
                item_count: if is_preset { counts.get(&id).copied().unwrap_or(0) } else { 0 },
                id,
                kind,
                title: latest["title"].as_str().map(str::to_owned),
                version,
                content_type: latest["contentType"].as_str().map(str::to_owned),
                bytes: latest["bytes"].as_u64(),
                primary: latest["primary"] == serde_json::Value::Bool(true),
            })
        })
        .collect();
    // 交付物带头，其余保持首次发布顺序（稳定排序）。
    out.sort_by_key(|artifact| std::cmp::Reverse(artifact.primary));
    Ok(out)
}
/// Node `INTERRUPTED_CODE`：失败码为它的 `failed` 行，逻辑状态是 `stopped(interrupted)`——
/// 「进程死了」与「脚本真失败」是模型要分别处理的两件事。
const INTERRUPTED_CODE: &str = "Interrupted";
/// 展示标签的字符上限（Node `DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS`；派生值是启发式，越长越不像标签）。
const LABEL_MAX_CHARS: usize = 80;

/// 脚本派生标签：首个非空行（trim 后截 80）——首行是**诚实的**（「脚本以此开头」），启发式
/// 每多一条就多一种在别人的脚本上给出误导标签的方式。整段皆空白时回 runId。
pub(super) fn derived_label(script_text: Option<&str>, run_id: &str) -> String {
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
/// 终态拆解的产物（Node `DwfRunSettlementFields` 的读取侧等价物）：详情面与中枢的运行历史页共用。
/// `pub(super)`：`repo::run_queries` 的 v4 查询面用同一个拆解（两处各写一份，stopped/superseded
/// 的判据迟早分叉）。
pub(super) struct Settlement {
    pub(super) status: String,
    pub(super) stop_reason: Option<String>,
    pub(super) superseded_by: Option<String>,
    pub(super) failure: Option<(String, String)>,
}

/// run 行的逻辑状态与终态拆解（Node `decodeRunSettlement` 同一条映射，只活在这一处）。
pub(super) fn settlement_of(status: &str, failure_json: Option<&str>) -> Settlement {
    match status {
        // stopped 包络：`{stopReason, supersededBy?, error?}`（Node `encodeRunSettlement` 的
        // stopped 一支）；缺字段按缺省 stopReason=user 兜底（Node 的 decode 同规）。
        "cancelled" => {
            let envelope = failure_json
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
            let failure_json =
                failure_json.and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
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
    }
}

/// 中枢运行历史页的一行（`workflows/runs` 的 `NIBISavedWorkflowRun` 的取数面）。
pub struct HubRunRow {
    pub run_id: String,
    pub name: Option<String>,
    pub status: String,
    pub stop_reason: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub spent_tokens: u64,
    pub parent_session_id: Option<String>,
    pub tool_call_id: Option<String>,
    /// `args_json` 的解析值（NULL 即缺席；「没有实参」与「实参是空袋」在记录层面可分辨）。
    pub args: Option<serde_json::Value>,
    pub cwd: Option<String>,
    /// 用户面产物（与 `GetWorkflowRun` 同一条归并；零件的 run 是空表——调用方据此让整字段缺席）。
    pub artifacts: Vec<ArtifactRow>,
}

/// 中枢的运行历史页（Node `listRuns` 的 SQL 逐字：cwd/name 谓词下推、`time_updated desc`、
/// limit **不设天花板**——调用方传「钳制上限 + 1」当截断探测行，加 `min(50,…)` 会让
/// `truncated` 在恰好 50 时永久缺席）。cwd 是**字面**等值匹配（写入侧原样落、读侧原样查）。
pub fn list_runs_hub(
    conn: &Connection,
    cwd: Option<&str>,
    name: Option<&str>,
    limit: usize,
) -> Result<Vec<HubRunRow>> {
    let sql = format!(
        "select id, parent_session_id, cwd, name, tool_call_id, args_json, spent_tokens,
                status, failure_json, time_created, time_updated
         from dwf_run
         where 1 = 1{}{}
         order by time_updated desc
         limit ?",
        if cwd.is_some() { " and cwd = ?" } else { "" },
        if name.is_some() { " and name = ?" } else { "" },
    );
    let mut statement = conn.prepare(&sql)?;
    let cwd = cwd.map(str::to_owned);
    let name = name.map(str::to_owned);
    let limit_bound = limit as i64;
    let mut bindings: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(cwd) = &cwd {
        bindings.push(Box::new(cwd.clone()));
    }
    if let Some(name) = &name {
        bindings.push(Box::new(name.clone()));
    }
    bindings.push(Box::new(limit_bound));
    let rows = statement.query_map(
        rusqlite::params_from_iter(bindings.iter().map(std::convert::AsRef::as_ref)),
        |row| {
        let settlement = settlement_of(
            &row.get::<_, String>(7)?,
            row.get::<_, Option<String>>(8)?.as_deref(),
        );
        Ok(HubRunRow {
            run_id: row.get(0)?,
            parent_session_id: row.get(1)?,
            cwd: row.get(2)?,
            name: row.get(3)?,
            tool_call_id: row.get(4)?,
            args: row
                .get::<_, Option<String>>(5)?
                .and_then(|text| serde_json::from_str(&text).ok()),
            spent_tokens: row.get::<_, i64>(6)?.max(0) as u64,
            status: settlement.status,
            stop_reason: settlement.stop_reason,
            created_at: row.get::<_, i64>(9)?.max(0) as u64,
            updated_at: row.get::<_, i64>(10)?.max(0) as u64,
            // 占位：artifact_rows 要 conn，map 闭包借不动；下面补填。
            artifacts: Vec::new(),
        })
    })?;
    let mut out = rows.collect::<rusqlite::Result<Vec<HubRunRow>>>()?;
    for entry in &mut out {
        entry.artifacts = artifact_rows(conn, &entry.run_id)?;
    }
    Ok(out)
}

pub fn run_detail(
    conn: &Connection,
    session: &str,
    run_id: &str,
) -> Result<Option<nibi_kernel_api::workflow::WorkflowRunDetail>> {
    use nibi_kernel_api::workflow as api;
    let Some(row) = run_row(conn, run_id)? else {
        return Ok(None);
    };
    let settlement = settlement_of(row.status.as_str(), row.failure_json.as_deref());
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
    let actor_rows = actors(conn, run_id)?;
    let actors = actor_rows
        .iter()
        .map(|actor| api::WorkflowRunActor {
            site_id: actor.site_id.clone(),
            ordinal: actor.ordinal,
            name: actor.name.clone(),
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
    let pending: Vec<api::WorkflowRunPendingQuestion> = pending_questions(conn, run_id)?
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

    // —— 情势截面：一次事件读喂四件事（roster / holes / launch 元数据 / 停驻合成）。——
    let events = events(conn, run_id)?;
    let now = row.time_updated.max(0) as u64;
    let index = index_events(&events, now);
    let node_rows = node_rows(conn, run_id)?;
    // 节点出生阶段（`node-queued` / 缓存 `node-settled` 的 phaseName）、actor 出生阶段与 ask 进度
    // 都只活在事件上（行上没有这些列）。
    let mut node_phase_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut actor_phases: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut progress: std::collections::HashMap<String, AskProgress> = std::collections::HashMap::new();
    let mut instructions: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for event in &events {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload_json) else { continue };
        match event.event_type.as_str() {
            "actor-created" => {
                let Some(actor) = payload["actor"]["siteId"].as_str() else { continue };
                let Some(ordinal) = payload["actor"]["ordinal"].as_i64() else { continue };
                if let Some(phase_name) = payload["phaseName"].as_str() {
                    actor_phases.insert(format!("{actor}@{ordinal}"), phase_name.to_owned());
                }
                continue;
            }
            "node-queued" | "node-settled" => {
                let Some(instance) = payload.get("instance") else { continue };
                let Some(site_id) = instance["siteId"].as_str() else { continue };
                let Some(ordinal) = instance["ordinal"].as_i64() else { continue };
                let key = format!("{site_id}@{ordinal}");
                if let Some(phase_name) = payload["phaseName"].as_str() {
                    node_phase_names.insert(key.clone(), phase_name.to_owned());
                }
                if let Some(head) = payload["instructionsHead"].as_str() {
                    instructions.insert(key, head.to_owned());
                }
                continue;
            }
            "node-progress" => {
                let Some(instance) = payload.get("instance") else { continue };
                let Some(site_id) = instance["siteId"].as_str() else { continue };
                let Some(ordinal) = instance["ordinal"].as_i64() else { continue };
                let key = format!("{site_id}@{ordinal}");
                let entry = progress.entry(key).or_default();
                entry.turn = payload["turn"].as_u64();
                entry.tool_calls = payload["toolCalls"].as_u64();
                entry.instructions_head = payload["instructionsHead"].as_str().map(str::to_owned)
                    .or_else(|| entry.instructions_head.clone());
                if let Some(last_tool) = payload.get("lastTool")
                    && let Some(name) = last_tool["name"].as_str()
                {
                    entry.last_tool = Some(api::WorkflowRunSubagentLastTool {
                        name: name.to_owned(),
                        target: last_tool["target"].as_str().map(str::to_owned),
                        at: event_time(event.time_created, u64::MAX),
                    });
                }
                continue;
            }
            "run-launched" => {
                continue;
            }
            _ => {}
        }
    }
    // launch 元数据（subagentModel / modelBindings）在 run-launched 上，零 SQL（Node 同规）。
    let launched = events
        .iter()
        .find(|event| event.event_type == "run-launched")
        .and_then(|event| serde_json::from_str::<serde_json::Value>(&event.payload_json).ok());
    let subagent_model = launched
        .as_ref()
        .and_then(|value| value["subagentModel"].as_str())
        .map(str::to_owned);
    let model_bindings = launched.as_ref().and_then(|value| {
        let bindings = value.get("modelBindings")?;
        let object = bindings.as_object()?;
        (!object.is_empty()).then(|| bindings.clone())
    });
    let input = RosterInput {
        index: &index,
        status: &status,
        declared_phases: &index.declared_phases,
        entered_phases: &index.entered_phases,
        node_rows: &node_rows,
        node_phase_names: &node_phase_names,
        actor_phases: &actor_phases,
        progress: &progress,
        actors: &actor_rows,
        pending_questions: &pending,
    };
    let (phases, subagents, health) = roster_of(&input);
    let _ = &instructions;

    // 留白：到达过的每一次，waiting 只在停驻表里有它时成立（开放集由调用方注入；本读面
    // 是纯 journal 的——没有活引擎时 waiting 只能从事件判，进程亡故后会把没人问的留白
    // 报成在等。开放集缺省按空表，调用方（runtime 合成）有活项时再注入）。
    let hole_types: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let holes = hole_rows(conn, run_id, &[], &hole_types)?;
    let holes = (!holes.is_empty()).then_some(
        holes
            .into_iter()
            .map(|hole| api::WorkflowRunHole {
                site_id: hole.site_id,
                ordinal: u64::try_from(hole.ordinal).unwrap_or(0),
                name: hole.name,
                hole_type: hole.hole_type,
                state: hole.state,
                since: hole.since,
                filled_at: hole.filled_at,
                filled_by: hole.filled_by,
            })
            .collect::<Vec<_>>(),
    );
    // 用户面产物：任意状态都附（死在第 12 步的 run 仍然交付了前面那张图）。
    let artifacts = artifact_rows(conn, run_id)?;
    let artifacts = (!artifacts.is_empty()).then_some(
        artifacts
            .into_iter()
            .map(|artifact| api::WorkflowRunArtifact {
                id: artifact.id,
                kind: artifact.kind,
                title: artifact.title,
                version: artifact.version,
                content_type: artifact.content_type,
                bytes: artifact.bytes,
                item_count: artifact.item_count,
                primary: artifact.primary.then_some(true),
            })
            .collect::<Vec<_>>(),
    );

    Ok(Some(api::WorkflowRunDetail {
        run_id: row.id.clone(),
        label,
        label_source,
        status,
        stop_reason,
        resumed_from: row.resumed_from.clone(),
        superseded_by,
        owned_by_this_session: row.parent_session_id.as_deref() == Some(session),
        // 活 run 的判据在合成层（runtime 的 WorkflowRunDetailReader）；存储只给 journal 事实。
        possibly_interrupted: false,
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
        subagent_model,
        model_bindings,
        phases,
        subagents,
        health,
        holes,
        artifacts,
    }))
}

#[cfg(test)]
#[path = "dwf_tests.rs"]
mod tests;

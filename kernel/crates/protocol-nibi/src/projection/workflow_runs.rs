//! `workflowRuns` 状态键：DWF 引擎进度的实时归约（Node `workflow-runs-reducer.ts` 的读面子集）。
//!
//! 一条 `run/event` → 一条 [`KernelEvent::WorkflowRunProgress`] → 这里推进一格。状态键的形状与
//! `packages/shared/src/nibi-protocol-v4/workflow-runs.ts` 的 schema 对齐：run 的必需键
//! （runId / status / usage / actors / nodes / lastEventSequence）一律在场，可选键在无值时整个
//! 缺席（不是 `null`、也不是空数组），与 Node 的「无则缺席」同规。
//!
//! 这一版覆盖 run 卡与详情页需要的读面：run 生命周期、actors、nodes、用量、阶段、留白、报告与
//! 升级问题。产物摘要与并发桶（`artifacts` / `concurrency`）仍由详情页的 journal 查询面提供；
//! 高频状态键不重复那两份事实。
//!
//! 归约保持纯函数：无时钟、无 I/O。序号取信封上的到达序（单调），真实 journal sequence 在
//! sidecar 的 journal 里，详情页按它分页。

use nibi_kernel_api::workflow::{WorkflowRunProgress, WorkflowRunSummaryRow};
use serde::Serialize;
use serde_json::Value;

/// 与 `WORKFLOW_RUNS_LIMITS` 同值：状态键的界是线上契约，不是展示偏好。
const MAX_RUNS: usize = 8;
const MAX_ACTORS: usize = 1_024;
const MAX_NODES: usize = 1_024;
const MAX_REPORTS: usize = 64;
const MAX_PENDING_QUESTIONS: usize = 32;
const MAX_PHASES: usize = 32;
const MAX_HOLES: usize = 32;
const MAX_PHASE_NAME: usize = 128;
const MAX_ACTOR_NAME: usize = 128;
const MAX_INSTRUCTIONS_HEAD: usize = 240;
const MAX_TEXT: usize = 2_048;
const MAX_ERROR: usize = 2_048;
const MAX_RESULT_PREVIEW: usize = 2_048;

/// 快照里的 `workflowRuns` 键（`workflowRunsStateSchema`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunsState {
    pub revision: u64,
    pub runs: Vec<WorkflowRun>,
}

impl WorkflowRunsState {
    /// 归约一条进度事件。返回 false 表示语义无变化（无效事件 / 重复事件），调用方不发增量。
    pub fn apply(&mut self, progress: &WorkflowRunProgress) -> bool {
        if progress.run_id.is_empty() || progress.event_type.is_empty() {
            return false;
        }
        let index = match self
            .runs
            .iter()
            .position(|run| run.run_id == progress.run_id)
        {
            Some(index) => index,
            None => {
                self.runs.push(WorkflowRun::new(progress));
                self.runs.len() - 1
            }
        };
        let before = self.runs[index].clone();
        self.runs[index].apply_event(progress);
        if self.runs[index] == before {
            return false;
        }
        self.revision += 1;
        // 最近若干个 run，按最旧淘汰；事件所属的 run 永远留下。
        if self.runs.len() > MAX_RUNS {
            let current = self.runs[index].run_id.clone();
            let overflow = self.runs.len() - MAX_RUNS;
            let mut removed = 0;
            let mut kept = Vec::with_capacity(MAX_RUNS);
            for run in std::mem::take(&mut self.runs) {
                if removed < overflow && run.run_id != current {
                    removed += 1;
                    continue;
                }
                kept.push(run);
            }
            while kept.len() > MAX_RUNS {
                if let Some(position) = kept.iter().position(|run| run.run_id != current) {
                    kept.remove(position);
                } else {
                    kept.remove(0);
                }
            }
            self.runs = kept;
        }
        true
    }

    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    /// 冷打开时从 `dwf_run` 的摘要行补种 run 目录（Node 的冷回放读 journal；这里只复原
    /// run 卡需要的头字段，节点/阶段仍由详情页的 journal 查询面提供）。
    ///
    /// 只在投影里还没有 run 时补：活会话的实时表是更完整的事实，不能被一份摘要覆盖。
    /// `rows` 是「最近更新在前」，这里反过来按创建顺序放进 `runs`（与实时归约一致）。
    pub fn seed(&mut self, rows: &[WorkflowRunSummaryRow]) -> bool {
        if !self.runs.is_empty() || rows.is_empty() {
            return false;
        }
        let mut runs: Vec<WorkflowRun> = rows
            .iter()
            .rev()
            .take(MAX_RUNS)
            .map(WorkflowRun::from_summary)
            .collect();
        if runs.is_empty() {
            return false;
        }
        for run in &mut runs {
            if run.status == "pending" {
                // 冷打开时 pending 只可能是崩溃残留：run 卡按 running 显示更接近事实。
                run.status = "running".to_owned();
            }
        }
        self.runs = runs;
        self.revision = 1;
        true
    }
}

/// 一条 run 的实时状态（`workflowRunSchema`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumed_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    pub usage: RunUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub resumable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_preview: Option<String>,
    pub actors: Vec<RunActor>,
    pub nodes: Vec<RunNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reports: Option<Vec<RunReport>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_questions: Option<Vec<RunQuestion>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phases: Option<Vec<RunPhase>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_alongside: Option<Vec<Vec<u64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_holes: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holes: Option<Vec<RunHole>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    pub last_event_sequence: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    pub spent_tokens: u64,
    pub nodes_used: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunActor {
    pub site_id: String,
    pub ordinal: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunNode {
    pub site_id: String,
    pub ordinal: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_site_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_ordinal: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions_head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_tool: Option<RunLastTool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLastTool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub site_id: String,
    pub ordinal: u64,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunQuestion {
    pub qid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_site_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_ordinal: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asked_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPhase {
    pub name: String,
    pub rounds: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHole {
    pub site_id: String,
    pub ordinal: u64,
    pub name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub hole_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled_by: Option<String>,
}

impl WorkflowRun {
    fn from_summary(row: &WorkflowRunSummaryRow) -> Self {
        Self {
            run_id: row.run_id.clone(),
            tool_call_id: row.tool_call_id.clone(),
            status: row.status.clone(),
            stop_reason: row.stop_reason.clone(),
            resumed_from: row.resumed_from.clone(),
            superseded_by: row.superseded_by.clone(),
            usage: RunUsage::default(),
            error: row
                .failure_message
                .as_deref()
                .map(|message| truncate(message, MAX_ERROR)),
            resumable: row.resumable,
            actors: Vec::new(),
            nodes: Vec::new(),
            last_event_sequence: 0,
            ..Self::default()
        }
    }

    fn new(progress: &WorkflowRunProgress) -> Self {
        Self {
            run_id: progress.run_id.clone(),
            tool_call_id: progress.tool_call_id.clone(),
            status: "pending".to_owned(),
            usage: RunUsage::default(),
            actors: Vec::new(),
            nodes: Vec::new(),
            last_event_sequence: progress.sequence,
            ..Self::default()
        }
    }

    fn apply_event(&mut self, progress: &WorkflowRunProgress) {
        if self.tool_call_id.is_none() {
            self.tool_call_id = progress.tool_call_id.clone();
        }
        // 水位单调：迟到的重放事件不把它拉回去。
        self.last_event_sequence = self.last_event_sequence.max(progress.sequence);
        let payload = &progress.payload;
        match progress.event_type.as_str() {
            "run-started" => {
                // resume 的重臂：清掉上一世的结算残影，用量归零；actors / nodes 表保留（缓存命中
                // 的结算会在这一世重发，先清再建会把还在跑的实例抹掉）。
                self.status = "running".to_owned();
                self.usage = RunUsage::default();
                self.stop_reason = None;
                self.superseded_by = None;
                self.error = None;
                self.resumable = false;
                self.result_preview = None;
                self.pending_questions = None;
                self.holes = self
                    .holes
                    .take()
                    .map(|holes| {
                        holes
                            .into_iter()
                            .filter(|hole| hole.state != "waiting")
                            .collect()
                    })
                    .filter(|holes: &Vec<RunHole>| !holes.is_empty());
                if let Some(resumed_from) = text(payload, "resumedFrom", 128) {
                    self.resumed_from = Some(resumed_from);
                }
                self.derive_actor_statuses();
            }
            "run-launched" => {
                self.apply_launched(payload);
            }
            "actor-created" => {
                let Some((site_id, ordinal)) = instance(payload, "actor") else {
                    return;
                };
                let name = text(payload, "name", MAX_ACTOR_NAME);
                let phase_name = text(payload, "phaseName", MAX_PHASE_NAME);
                let model = text(payload, "model", 256);
                self.upsert_actor(
                    site_id,
                    ordinal,
                    name,
                    phase_name,
                    model,
                    progress.actor_session_id.clone(),
                );
                self.derive_actor_statuses();
            }
            event @ ("node-queued" | "node-dispatched" | "node-executing" | "node-waiting"
            | "node-repairing" | "node-nudged" | "node-settled") => {
                let Some((site_id, ordinal)) = instance(payload, "instance") else {
                    return;
                };
                let phase = match event {
                    "node-queued" => "queued",
                    "node-dispatched" => "dispatched",
                    "node-executing" => "executing",
                    "node-waiting" => "waiting",
                    "node-repairing" => "repairing",
                    "node-nudged" => "nudged",
                    _ => "settled",
                };
                let born = event == "node-queued"
                    || (event == "node-settled" && payload["cached"].as_bool() == Some(true));
                let previous_index = self
                    .nodes
                    .iter()
                    .position(|node| node.site_id == site_id && node.ordinal == ordinal);
                let previous = previous_index.map(|index| self.nodes[index].clone());
                // 派发是「一个实例第一次真正开跑」：计一步（源侧的 nodesUsed 同一判据）。
                if event == "node-dispatched"
                    && previous
                        .as_ref()
                        .map_or(true, |node| node.phase == "queued")
                {
                    self.usage.nodes_used += 1;
                }
                let kind = text(payload, "kind", 32)
                    .filter(|kind| kind.as_str() == "ask" || kind.as_str() == "world-read");
                let actor = instance(payload, "actor");
                let actor_name = text(payload, "actorName", MAX_ACTOR_NAME);
                let actor_phase = text(payload, "actorPhaseName", MAX_PHASE_NAME);
                let actor_model = text(payload, "actorModel", 256);
                let phase_name = text(payload, "phaseName", MAX_PHASE_NAME);
                let instructions_head = if event == "node-queued" {
                    text(payload, "instructionsHead", MAX_INSTRUCTIONS_HEAD)
                } else {
                    None
                };
                let mut node = previous.clone().unwrap_or_default();
                node.site_id = site_id.clone();
                node.ordinal = ordinal;
                node.phase = phase.to_owned();
                if let Some(kind) = kind {
                    node.kind = Some(kind);
                }
                if let Some(outcome) = text(payload, "outcome", 32)
                    && matches!(outcome.as_str(), "ok" | "failed" | "cancelled")
                {
                    node.outcome = Some(outcome);
                }
                if payload["cached"].as_bool() == Some(true) {
                    node.cached = true;
                }
                if let Some((actor_site, actor_ordinal)) = actor.clone() {
                    node.actor_site_id = Some(actor_site);
                    node.actor_ordinal = Some(actor_ordinal);
                }
                if let Some(phase_name) = phase_name {
                    node.phase_name = Some(phase_name);
                }
                if born {
                    // 出生事件清掉上一世的进度读数（requeue 是全新的 ask）。
                    node.instructions_head = instructions_head;
                    node.turn = None;
                    node.tool_calls = None;
                    node.last_tool = None;
                }
                if event == "node-dispatched"
                    && let Some((actor_site, actor_ordinal)) = actor
                {
                    self.upsert_actor(
                        actor_site,
                        actor_ordinal,
                        actor_name,
                        actor_phase,
                        actor_model,
                        progress.actor_session_id.clone(),
                    );
                }
                if let Some(index) = previous_index {
                    self.nodes[index] = node;
                } else if self.nodes.len() < MAX_NODES {
                    self.nodes.push(node);
                } else {
                    self.truncated = true;
                }
                self.derive_actor_statuses();
            }
            "node-progress" => {
                let Some((site_id, ordinal)) = instance(payload, "instance") else {
                    return;
                };
                let Some(node) = self
                    .nodes
                    .iter_mut()
                    .find(|node| node.site_id == site_id && node.ordinal == ordinal)
                else {
                    return;
                };
                if let Some(turn) = payload["turn"].as_u64().filter(|turn| *turn > 0) {
                    node.turn = Some(turn);
                }
                if let Some(tool_calls) = payload["toolCalls"].as_u64() {
                    node.tool_calls = Some(tool_calls);
                }
                if let Some(last) = payload.get("lastTool")
                    && let Some(name) = text(last, "name", 64)
                {
                    node.last_tool = Some(RunLastTool {
                        name,
                        target: text(last, "target", 120),
                    });
                }
            }
            "usage-updated" => {
                if let Some(spent) = payload["spentTokens"].as_u64() {
                    self.usage.spent_tokens = spent;
                }
            }
            "phase-entered" => {
                let Some(name) = text(payload, "name", MAX_PHASE_NAME) else {
                    return;
                };
                let rounds = payload["ordinal"]
                    .as_u64()
                    .filter(|rounds| *rounds > 0)
                    .unwrap_or(1);
                let phases = self.phases.get_or_insert_with(Vec::new);
                if let Some(phase) = phases.iter_mut().find(|phase| phase.name == name) {
                    phase.rounds = phase.rounds.max(rounds);
                } else if phases.len() < MAX_PHASES {
                    phases.push(RunPhase {
                        name: name.clone(),
                        rounds,
                    });
                } else {
                    self.truncated = true;
                }
                self.current_phase = Some(name);
            }
            "report" => {
                let Some((site_id, ordinal)) = instance(payload, "instance") else {
                    return;
                };
                let preview = preview_of(&payload["item"]);
                let report = RunReport {
                    site_id: site_id.clone(),
                    ordinal,
                    preview,
                    artifact_id: text(payload, "artifactId", 64),
                };
                let reports = self.reports.get_or_insert_with(Vec::new);
                if let Some(existing) = reports
                    .iter_mut()
                    .find(|existing| existing.site_id == site_id && existing.ordinal == ordinal)
                {
                    *existing = report;
                } else if reports.len() < MAX_REPORTS {
                    reports.push(report);
                } else {
                    self.truncated = true;
                }
            }
            "escalation-raised" => {
                let Some(qid) = text(payload, "qid", 128) else {
                    return;
                };
                let Some(question) = text(payload, "question", MAX_TEXT) else {
                    return;
                };
                let actor = instance(payload, "actor");
                let pending = RunQuestion {
                    qid: qid.clone(),
                    actor_site_id: actor.as_ref().map(|(site, _)| site.clone()),
                    actor_ordinal: actor.map(|(_, ordinal)| ordinal),
                    actor_name: text(payload, "actorName", MAX_ACTOR_NAME),
                    question,
                    context: text(payload, "context", MAX_TEXT),
                    asked_at: payload["askedAt"].as_u64(),
                };
                let questions = self.pending_questions.get_or_insert_with(Vec::new);
                if let Some(existing) = questions.iter_mut().find(|existing| existing.qid == qid) {
                    *existing = pending;
                } else if questions.len() < MAX_PENDING_QUESTIONS {
                    questions.push(pending);
                } else {
                    self.truncated = true;
                }
            }
            "escalation-resolved" => {
                if let Some(qid) = text(payload, "qid", 128)
                    && let Some(questions) = &mut self.pending_questions
                {
                    questions.retain(|question| question.qid != qid);
                    if questions.is_empty() {
                        self.pending_questions = None;
                    }
                }
            }
            "hole-reached" => {
                let Some((site_id, ordinal)) = instance(payload, "instance") else {
                    return;
                };
                let Some(name) = text(payload, "name", MAX_PHASE_NAME) else {
                    return;
                };
                let hole = RunHole {
                    site_id: site_id.clone(),
                    ordinal,
                    name,
                    hole_type: text(payload, "type", MAX_PHASE_NAME),
                    prompt: text(payload, "prompt", 500),
                    state: "waiting".to_owned(),
                    since: None,
                    filled_at: None,
                    filled_by: None,
                };
                let holes = self.holes.get_or_insert_with(Vec::new);
                if let Some(existing) = holes
                    .iter_mut()
                    .find(|existing| existing.site_id == site_id && existing.ordinal == ordinal)
                {
                    *existing = hole;
                } else if holes.len() < MAX_HOLES {
                    holes.push(hole);
                } else {
                    self.truncated = true;
                }
            }
            "hole-filled" => {
                let Some(site_id) = text(payload, "siteId", 64) else {
                    return;
                };
                let filled_at = payload["filledAt"].as_u64();
                let filled_by = text(payload, "filledBy", 128);
                if let Some(holes) = &mut self.holes
                    && let Some(hole) = holes
                        .iter_mut()
                        .find(|hole| hole.site_id == site_id && hole.state == "waiting")
                {
                    hole.state = "filled".to_owned();
                    hole.filled_at = filled_at;
                    hole.filled_by = filled_by;
                } else {
                    // 补全事件先于到达事件（或该站点不在表里）：按「已补全」记一条。
                    let holes = self.holes.get_or_insert_with(Vec::new);
                    if holes.len() < MAX_HOLES {
                        holes.push(RunHole {
                            site_id: site_id.clone(),
                            ordinal: 0,
                            name: site_id,
                            hole_type: None,
                            prompt: None,
                            state: "filled".to_owned(),
                            since: None,
                            filled_at,
                            filled_by,
                        });
                    }
                }
                if let Some(names) = payload.get("phaseNames").and_then(Value::as_array) {
                    let names = bounded_names(names);
                    if !names.is_empty() {
                        self.phase_names = Some(names);
                    }
                }
                if let Some(holes) = phase_holes(payload.get("holes")) {
                    self.phase_holes = Some(holes);
                }
            }
            "run-settled" => {
                let status = payload["status"].as_str().unwrap_or_default();
                self.status = match status {
                    "completed" | "errored" | "stopped" => status.to_owned(),
                    _ => "errored".to_owned(),
                };
                if status == "stopped" {
                    self.stop_reason = text(payload, "stopReason", 32);
                    if self.stop_reason.as_deref() == Some("superseded") {
                        self.superseded_by = text(payload, "supersededBy", 128);
                    }
                }
                if let Some(message) = payload
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .filter(|message| !message.is_empty())
                {
                    self.error = Some(truncate(message, MAX_ERROR));
                }
                if status != "completed" && self.error.is_none() && status == "errored" {
                    self.error = Some("Workflow run failed".to_owned());
                }
                if payload["resumable"].as_bool() == Some(true) {
                    self.resumable = true;
                }
                for actor in &mut self.actors {
                    actor.status = "completed".to_owned();
                }
                if let Some(holes) = &mut self.holes {
                    holes.retain(|hole| hole.state != "waiting");
                    if holes.is_empty() {
                        self.holes = None;
                    }
                }
                self.pending_questions = None;
            }
            // log / compaction / 并发观察等不影响读面；只抬水位。
            _ => {}
        }
    }

    fn apply_launched(&mut self, payload: &Value) {
        if let Some(raw) = payload.get("phaseNames").and_then(Value::as_array) {
            let names = bounded_names(raw);
            if !names.is_empty() {
                self.phase_names = Some(names);
            }
        }
        if let Some(alongside) = self
            .phase_names
            .as_ref()
            .and_then(|names| phase_alongside(payload.get("phaseAlongside"), names.len()))
        {
            self.phase_alongside = Some(alongside);
        }
        if let Some(holes) = phase_holes(payload.get("holes")) {
            self.phase_holes = Some(holes);
        }
    }

    fn upsert_actor(
        &mut self,
        site_id: String,
        ordinal: u64,
        name: Option<String>,
        phase_name: Option<String>,
        model: Option<String>,
        session_id: Option<String>,
    ) {
        if let Some(actor) = self
            .actors
            .iter_mut()
            .find(|actor| actor.site_id == site_id && actor.ordinal == ordinal)
        {
            if name.is_some() {
                actor.name = name;
            }
            if phase_name.is_some() {
                actor.phase_name = phase_name;
            }
            if model.is_some() {
                actor.model = model;
            }
            if session_id.is_some() {
                actor.session_id = session_id;
            }
            return;
        }
        if self.actors.len() >= MAX_ACTORS {
            self.truncated = true;
            return;
        }
        self.actors.push(RunActor {
            site_id,
            ordinal,
            name,
            session_id,
            status: "waiting".to_owned(),
            phase_name,
            model,
        });
    }

    /// actor 三态由节点相位与 run 终态派生（Node `withDerivedWorkflowActorStatuses` 同规）。
    fn derive_actor_statuses(&mut self) {
        let run_live = self.status == "pending" || self.status == "running";
        let mut statuses = Vec::with_capacity(self.actors.len());
        for actor in &self.actors {
            let mut owned = false;
            let mut executing = false;
            let mut live = false;
            for node in &self.nodes {
                if node.actor_site_id.as_deref() != Some(actor.site_id.as_str())
                    || node.actor_ordinal != Some(actor.ordinal)
                {
                    continue;
                }
                owned = true;
                match node.phase.as_str() {
                    "executing" | "repairing" | "nudged" => executing = true,
                    "queued" | "dispatched" | "waiting" => live = true,
                    _ => {}
                }
            }
            statuses.push(if !run_live {
                "completed"
            } else if executing {
                "running"
            } else if live || !owned {
                "waiting"
            } else {
                "completed"
            });
        }
        for (actor, status) in self.actors.iter_mut().zip(statuses) {
            if actor.status != status {
                actor.status = status.to_owned();
            }
        }
    }
}

fn instance(payload: &Value, key: &str) -> Option<(String, u64)> {
    let value = payload.get(key)?;
    let site_id = value
        .get("siteId")?
        .as_str()
        .filter(|text| !text.is_empty())?;
    let ordinal = value.get("ordinal")?.as_u64()?;
    Some((site_id.to_owned(), ordinal))
}

fn text(payload: &Value, key: &str, limit: usize) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| truncate(text, limit))
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn preview_of(item: &Value) -> String {
    let text = match item {
        Value::String(text) => text.clone(),
        value => serde_json::to_string_pretty(value).unwrap_or_default(),
    };
    truncate(&text, MAX_RESULT_PREVIEW)
}

fn bounded_names(raw: &[Value]) -> Vec<String> {
    raw.iter()
        .filter_map(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(|name| truncate(name, MAX_PHASE_NAME))
        .take(MAX_PHASES)
        .collect()
}

fn phase_alongside(raw: Option<&Value>, count: usize) -> Option<Vec<Vec<u64>>> {
    let raw = raw?.as_array()?;
    let mut any = false;
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let mut indexes = Vec::new();
        if let Some(entry) = raw.get(index).and_then(Value::as_array) {
            for value in entry {
                let Some(value) = value.as_u64() else {
                    continue;
                };
                let Ok(value) = usize::try_from(value) else {
                    continue;
                };
                if value >= count || value == index || indexes.contains(&(value as u64)) {
                    continue;
                }
                indexes.push(value as u64);
                if indexes.len() >= MAX_PHASES {
                    break;
                }
            }
        }
        if !indexes.is_empty() {
            any = true;
        }
        out.push(indexes);
    }
    any.then_some(out)
}

fn phase_holes(raw: Option<&Value>) -> Option<Vec<u64>> {
    let raw = raw?.as_array()?;
    let mut out = Vec::new();
    for value in raw {
        let Some(value) = value.as_u64() else {
            continue;
        };
        if out.contains(&value) {
            continue;
        }
        out.push(value);
        if out.len() >= MAX_PHASES {
            break;
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

#[cfg(test)]
#[path = "workflow_runs_tests.rs"]
mod tests;

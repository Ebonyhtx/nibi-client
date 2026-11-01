//! DWF（动态工作流）run 的只读面（NIBI 的 run 卡与详情页）。
//!
//! 数据来自 `dwf_run` 表（migration 0019，Node 的 journal 仓储写的那张表）：Rust 目前只读，
//! 引擎仍在 Node 侧（见 `docs/rust-kernel-dwf-design-2026-10-30.md` 的路线 C）。写面等 sidecar
//! 接进来时再加，且由引擎独占写。

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::model::ModelSelection;
use crate::permission::PermissionMode;

/// 一条 run（`dwf_run` 的内核视图；字段名按 NIBI 的 camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicWorkflowRun {
    /// `runId`（≡ `cancelBackgroundWork` 的 `workId`）。
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `pending` / `running` / `completed` / `failed` / `cancelled`。
    pub status: String,
    /// 启动它的会话（`dwf_run.parent_session_id`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub spent_tokens: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

/// 一个 DWF actor 的固定属性（引擎 sidecar 在 `createActorSession` 时给）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowActorSpec {
    /// 父会话（`dwf_run.parent_session_id`）。
    pub parent: String,
    /// actor 子会话（Node 侧按 `(runId, actorRef)` 确定地铸出）。
    pub child: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// persona（子循环 system 的第二段；第一段是内核的通用前置）。
    pub prompt: String,
    /// 展示名（actor 会话标题）。
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<ModelSelection>,
    /// `build` / `edit` / `plan` / `yolo` / `guarded`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<PermissionMode>,
    /// 工具面：None 表示全部；`deny` 是减法（Node 的 `toolDisallowlist`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    /// typed ask 的 `result` 形状（JSON Schema）：在场时给 actor 注册 `submit_result` 工具。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit_schema: Option<serde_json::Value>,
    /// 本 run 的 id（升级问答与日志的 run 身份）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub run_id: String,
    /// actor 的结构化引用 `site@ordinal`（升级问答的提问者身份）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub actor: String,
    /// actor 的有效名（`agent("poet")` 的名字）；匿名 actor 缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
    /// 本轮的 ask 实例键（`site@ordinal`）：per-ask 的升级预算按它计。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ask: String,
    /// amend-resume 的转录种子（消费过导入的 actor 才带；宿主在建会话时兑现）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<WorkflowActorSeed>,
}

/// 一轮 actor 的结果（引擎的 `WorkflowReportSink` 由 sidecar 按它推进）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowActorTurn {
    pub child: String,
    /// 终态文本（最后一条 assistant 的正文；typed ask 接入后由 `submit_result` 优先）。
    pub text: String,
    pub tokens: u64,
    pub tool_uses: usize,
    /// `completed` / `aborted` / `failed`。
    pub stopped: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// typed ask 提交的值（`submit_result` 的参数 `result`）；没调用时缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitted: Option<serde_json::Value>,
    /// 本轮结束时 actor 会话已落库的消息条数（ask 边界记账的值；driver 据它补写
    /// `NodeRecord.messageBoundary`）。宿主在交出本轮结果**之前**数好（先数后报）。
    pub message_count: u64,
}

/// 一次 actor 轮的输入（`first` 为真时先建 actor 子会话）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowActorRequest {
    pub actor: WorkflowActorSpec,
    /// ask 的正文（引擎的 `AskMessage` 渲染后的文本）。
    pub message: String,
    pub first: bool,
}

/// 种子兑现的结局（Node `seedActorTranscript` 的返回语义：跳过的两种归一个返回值）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SeedFulfillment {
    /// 实际复制的条数。
    Copied(u64),
    /// 目标已满（≥ message_count）——修订 run 崩溃后 resume 重挂已装满的会话。
    SkippedFilled,
    /// 目标里已有自己的历史（存在非种子 id 的消息）——一个字节都不动。
    SkippedLive,
}

/// amend-resume 的转录种子（引擎 `ActorSessionSeed` 的镜像）：该 actor 消费了 ≥1 条导入 ask
/// 条目时在场——宿主必须在首个 ask 之前把源会话的前 `message_count` 条消息按值复制进新铸的
/// 会话（幂等，规则见 node-store 的 `fulfill_actor_seed`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowActorSeed {
    /// 转录来源会话（前驱或更早祖先的该名 actor 会话）。
    pub source_session_id: String,
    /// 复制源会话前多少条消息（count offset 跨前缀复制不变）。
    pub message_count: u64,
}

/// 一个停驻中的升级问答（引擎 `escalation-raised` 与快照 `pendingQuestions` 的同源事实）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowQuestion {
    /// 全局唯一的问题 id（`dwfq-<runId 片段>-<seq>`）。
    pub qid: String,
    pub run_id: String,
    /// 发起 run 的父会话：只有它看得见、也只有它能回答。
    pub parent: String,
    /// 提问的 actor，`site@ordinal` 形态。
    pub actor: String,
    /// actor 的有效名（`agent("poet")` 的 `"poet"`）；匿名 actor 缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// 提问时刻（epoch ms）。
    pub asked_at: u64,
}

/// 一次升级的结局（Node 的 `WorkflowEscalateOutcome`）：两支都是**普通工具结果**，不是错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowEscalationOutcome {
    Answered { answer: String, qid: String },
    /// `budget_exhausted` / `no_active_ask`；`message` 由端口写好、原样交给模型。
    Refused { reason: String, message: String },
}

/// 一次升级的请求：路由身份由调用方（sidecar 的 ask 轮）绑定，模型无法覆盖。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowEscalationRequest {
    pub parent: String,
    pub run_id: String,
    /// `site@ordinal`。
    pub actor: String,
    pub actor_name: Option<String>,
    /// ask 实例键（`site@ordinal`）：per-ask 的升级预算按它计。
    pub ask: String,
    pub question: String,
    pub context: Option<String>,
}

/// actor 侧升级问答的端口（`escalate` 工具读它）。
#[async_trait::async_trait]
pub trait WorkflowEscalation: Send + Sync {
    /// 升级并**阻塞**等主代理作答；取消由调用方丢弃这个 future 表达（停驻项随之撤下）。
    async fn escalate(&self, request: WorkflowEscalationRequest) -> WorkflowEscalationOutcome;
}

/// 一次答题的结局（Node 的 `DynamicWorkflowResolveQuestionResult`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowQuestionResolved {
    Answered { qid: String },
    /// `unknown_question` / `already_resolved` / `run_not_in_flight`；`message` 由注册表写好。
    Rejected { reason: String, message: String },
}

/// 答题端口（主会话的 `ResolveWorkflowQuestion` 工具读它）。
#[async_trait::async_trait]
pub trait WorkflowQuestions: Send + Sync {
    async fn resolve(
        &self,
        session: &crate::ids::SessionId,
        qid: &str,
        answer: &str,
    ) -> WorkflowQuestionResolved;
}

/// 通知通道（运行时把升级提示送进父会话的 `task-notification` 流）。
pub trait WorkflowNotices: Send + Sync {
    fn notify(&self, session: &crate::ids::SessionId, text: String);

    /// 带结构化 originMeta 的投递（Node `BackgroundResultOriginMeta`：backgroundSource/title/
    /// workId，运行卡关联键；`workflowNotification` manifest 载荷之后同车）。缺省丢弃元数据、
    /// 落回 [`Self::notify`]（不认识它的实现照常只投文本）。
    fn notify_with(
        &self,
        session: &crate::ids::SessionId,
        text: String,
        origin_meta: Option<serde_json::Value>,
    ) {
        let _ = origin_meta;
        self.notify(session, text)
    }
}

/// run 事件 journal 的窄追加面（`dwf_event`；引擎 sidecar 与宿主写同一个库）。`payload_json`
/// 与 Node 的 `RunEvent` 同形——整个事件的 JSON，**含 `type` 字段**。升级问答的双轨 record
/// （Node driver 的 journal + emit）在宿主侧走这里 + [`WorkflowNotices`]。
#[async_trait::async_trait]
pub trait WorkflowEventJournal: Send + Sync {
    async fn append_event(
        &self,
        run_id: &str,
        event_type: &str,
        payload_json: String,
    ) -> Result<(), crate::store::StoreError>;
}

/// 节点行计数（`nodesObserved` 是已落库节点的行数，三态之和——绝不冒充「总步数」，
/// 动态工作流没有静态总数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunNodeCounts {
    pub observed: u64,
    pub running: u64,
    pub completed: u64,
    pub failed: u64,
}

/// 一个 actor 站点实例（恒定的身份表；persona 刻意不出——整段 system prompt 无界）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunActor {
    pub site_id: String,
    pub ordinal: i64,
    pub name: Option<String>,
}

/// 一条 `log()` 叙事。`at` 是这条事件落 journal 的时刻；没有这一列的老 journal 上缺席。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunLogEntry {
    pub sequence: i64,
    pub message: String,
    pub at: Option<u64>,
}

/// 一个此刻停驻、等主代理作答的升级问题（升级通知丢弃后的查询兜底，模型侧唯一的发现面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunPendingQuestion {
    pub qid: String,
    /// 提问的 actor，`site@ordinal` 形态。
    pub actor: String,
    pub actor_name: Option<String>,
    pub question: String,
    pub context: Option<String>,
    /// 提问时刻（epoch ms，与 createdAt / updatedAt 同一把尺）。
    pub asked_at: u64,
}

/// 结构化失败（journal `failure_json` 的 code/message；稳定判别键——模型必须能分辨
/// 「进程死了」与「脚本真失败」）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunError {
    pub code: String,
    pub message: String,
}

/// 一个 run 的详情读面（journal + 停驻注册表的合成；`GetWorkflowRun` 的取数底座）。
/// 无从得知的字段整体缺席而不是空表（「没有」与「不知道」分开）。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowRunDetail {
    pub run_id: String,
    /// 已烹熟的展示标签（name → 脚本首个非空行 → runId；读时派生，绝不回写）。
    pub label: String,
    /// `"name"` = 用户起的名字；`"script"` = 读时从脚本派生（含 runId 兜底）。
    pub label_source: &'static str,
    /// 生命周期词：`pending` / `running` / `completed` / `errored` / `stopped`。
    pub status: String,
    /// `status == "stopped"` 才在场。
    pub stop_reason: Option<String>,
    pub resumed_from: Option<String>,
    /// 本 run 被哪次修订停下并替代（stopped(superseded) 的结算袋）。
    pub superseded_by: Option<String>,
    pub owned_by_this_session: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub spent_tokens: u64,
    pub nodes: WorkflowRunNodeCounts,
    pub actors: Vec<WorkflowRunActor>,
    pub log_tail: Vec<WorkflowRunLogEntry>,
    /// 此刻还欠答案的升级问题（journal 冷回放 ∪ 停驻注册表的活项）。
    pub pending_questions: Vec<WorkflowRunPendingQuestion>,
    /// completed 才在场：脚本的顶层返回值，已序列化成文本（string 原样、其余 pretty JSON）。
    pub result_text: Option<String>,
    /// errored 恒可回；stopped 只对 provider / interrupted 在场。
    pub error: Option<WorkflowRunError>,
    /// 本 run 自己的并发上界（低于天花板时才由调用方放行到模型面）。
    pub max_concurrency: Option<u64>,
    /// 本 run 的子代理模型（规范串，`run-launched.subagentModel`；设过才在场）。
    pub subagent_model: Option<String>,
    /// 脚本点名的绑定表（`run-launched.modelBindings`；点名过才在场）。
    pub model_bindings: Option<serde_json::Value>,
    /// 阶段表：声明序 + 进过未声明的（脚本没声明、也一个都没进过时整字段缺席）。
    pub phases: Option<Vec<WorkflowRunPhaseView>>,
    /// 子代理花名册（恒在场；按铸造顺序）。
    pub subagents: Vec<WorkflowRunSubagentView>,
    /// run 整体还在不在动（恒在场）。
    pub health: WorkflowRunHealth,
    /// 留白（到达过且此刻在等或补过；零条整字段缺席）。
    pub holes: Option<Vec<WorkflowRunHole>>,
    /// 用户面产物（零件时整字段缺席）。
    pub artifacts: Option<Vec<WorkflowRunArtifact>>,
}

/// 一个阶段在情势截面里的处境（Node `GetWorkflowRunPhase` 的镜像）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunPhaseView {
    pub name: String,
    /// `ahead` = 声明了还没到（唯一 rounds=0 的状态）。
    pub state: String,
    pub rounds: u64,
    pub nodes_settled: u64,
    pub nodes_running: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entered_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exited_at: Option<u64>,
}

/// 子代理此刻在干什么（Node `GetWorkflowRunSubagent` 的镜像）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSubagentView {
    pub site_id: String,
    pub ordinal: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 七词闭集（Node `subagentStateOf` 的同一判定顺序）。
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_ask: Option<WorkflowRunSubagentAsk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<WorkflowRunSubagentWait>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parked_on: Option<String>,
    pub steps_settled: u64,
    pub steps_failed: u64,
    pub tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_progress_at: Option<u64>,
}

/// 子代理当前 ask 的截面（Node `GetWorkflowRunSubagentAsk` 的镜像；turn/toolCalls 缺席读作
/// 「不知道」，`0` 读作「一个工具都没调过」）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSubagentAsk {
    pub site_id: String,
    pub ordinal: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions_head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool: Option<WorkflowRunSubagentLastTool>,
}

/// 最近一次被观察到的工具调用（target 是线索，不是入参）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSubagentLastTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}

/// 当前 ask 在等什么（Node `GetWorkflowRunSubagentWait` 的镜像）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSubagentWait {
    pub cause: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

/// run 整体还在不在动（Node `GetWorkflowRunHealth` 的镜像）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunHealth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_progress_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stalled_since: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<WorkflowRunConcurrencyHealth>,
    pub consecutive_failures: u64,
    pub cached_steps: u64,
    /// 仅终态 run：还标着 running 的节点行数（进程死在它们下面）。为 0 时缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leftover_running: Option<u64>,
    /// 本读面恒知停驻表（journal 冷回放 ∪ 注册表）。
    pub pending_questions_known: bool,
}

/// run 级并发现状（只在被压到界以下时在场）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunConcurrencyHealth {
    pub effective: u64,
    pub cap: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

/// 一处留白（Node `GetWorkflowRunHole` 的镜像）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunHole {
    pub site_id: String,
    pub ordinal: u64,
    pub name: String,
    /// 类型实参原文（`Verdict`）。
    pub hole_type: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filled_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filled_by: Option<String>,
}

/// 一件用户面产物（Node `GetWorkflowRunArtifact` 的镜像；不带 uri——模型读不了 store）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunArtifact {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub item_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<bool>,
}

/// run 详情的取数端口（`GetWorkflowRun` 工具读它；journal 是真相，宿主合成停驻注册表）。
#[async_trait::async_trait]
pub trait WorkflowRunIntrospection: Send + Sync {
    /// 未知 runId → `None`（调用方给 `run_not_found`）。
    async fn run_detail(
        &self,
        session: &crate::ids::SessionId,
        run_id: &str,
    ) -> Result<Option<WorkflowRunDetail>, crate::store::StoreError>;
}

/// 引擎拒绝码的前缀（Node `SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX` 等）。
pub const SAVED_WORKFLOW_START_REJECTED: &str = "fault.command.savedWorkflowStartRejected.";
pub const WORKFLOW_RUN_RESUME_REJECTED: &str = "fault.command.workflowRunResumeRejected.";
pub const WORKFLOW_RUN_SETTINGS_REJECTED: &str = "fault.command.workflowRunSettingsRejected.";

/// actor 侧的升级工具名（与 Node 的 `ESCALATE_TOOL_NAME` 逐字相同）。
pub const ESCALATE_TOOL: &str = "escalate";
/// 主会话的答题工具名（Node 的 `RESOLVE_WORKFLOW_QUESTION_TOOL_NAME`）；actor 的工具面里被藏起来。
pub const RESOLVE_WORKFLOW_QUESTION_TOOL: &str = "ResolveWorkflowQuestion";

/// `startSavedWorkflow`：按名字（可选作用域）启动已保存的工作流。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStart {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
}

/// `amendWorkflowRunSettings`：两项设置的三态（省略 = 沿用，`null` = 回默认，值 = 设定）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAmend {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_model: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<Option<u64>>,
}

/// 引擎接受一次 submit / resume / amend 之后给的两把联接键（`runId` ≡ `workId`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunStarted {
    pub run_id: String,
    pub tool_call_id: String,
    /// 修订设置时旧 run 仍在飞、被这次调整停下时在场。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_run_id: Option<String>,
    /// 设置轮材料（docs/dynamic-workflow/launch.md「The settings turn」）：只在 amend 的回复在场，
    /// 宿主据它往父会话写 controlOnly 记录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_turn: Option<WorkflowSettingsTurn>,
    /// 启动轮材料（docs/dynamic-workflow/launch.md「The launch turn」）：只在中枢启动的回复在场，
    /// 宿主据它往父会话写 controlOnly 的启动轮。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_turn: Option<WorkflowLaunchTurn>,
}

/// 一次修订的会话记录材料：run 自己的名字（无名缺席）与「改了什么」。
///
/// `amend` 是 Node `WorkflowSettingsAmendMeta` 的 JSON（`predecessorRunId` 只在铸出后继时在场；
/// 两项设置只有改动过的带 from/to，缺一端即那一端是默认；`ceiling` 装默认并发 D）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSettingsTurn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub amend: serde_json::Value,
}

/// 启动轮材料（中枢直接启动，docs/dynamic-workflow/launch.md「The launch turn」）：引擎解析
/// saved 定义之后的原样事实，宿主据它往父会话写 controlOnly 的启动轮。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLaunchTurn {
    pub name: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 校验并回填默认值之后的实参；空袋缺席（Node 的 `hasArgs`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    /// 工作流脚本原文（`metadata.workflowLaunch.script`，256k 字符上界由宿主收口）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
}

/// 引擎的业务拒绝：`reason` 是 Node 词表里的 token，前缀由调用方按命令补。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowEngineError {
    pub reason: String,
    pub message: Option<String>,
}

/// 一条补全诊断（Node `DynamicWorkflowRunFillHoleDiagnostic` 的镜像）。`in_fill` 为真时
/// `line` / `column` 是**函数体内**的坐标（拼进去的那一段），否则是脚本坐标——工具层据此把它
/// 锚到 fill 文件或 run 的草稿。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFillDiagnostic {
    pub line: u64,
    pub column: u64,
    pub message: String,
    pub code: u64,
    pub in_fill: bool,
}

/// 一次补全的结局（Node `FillWorkflowHoleResult` 的镜像）。拒绝时**零副作用**：留白照旧在等。
/// `reason` 是 Node 词表里的 token：`run_not_found` / `hole_not_waiting` / `compile_failed` /
/// `fill_ids_unstable`；`compile_failed` 恒带 `diagnostics`。
#[derive(Debug, Clone, PartialEq)]
pub enum WorkflowFillOutcome {
    Filled {
        phases_added: Vec<String>,
        script_path: Option<String>,
        script_text: String,
    },
    Refused {
        reason: String,
        message: String,
        diagnostics: Vec<WorkflowFillDiagnostic>,
    },
}

/// FillWorkflowHole 的确认前读面（Node resolveInput 里那次 `port.getTask` 的窄版）：run 行的
/// 展示元数据与留白表。`waiting` 只在引擎真的停驻着它时成立；`filled` 来自事件；两样都不是的
/// 到达不出现（进程亡故后没有 promise 在等）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowFillTarget {
    /// run 行的名字（saved 名字）；内联脚本缺席。
    pub name: Option<String>,
    /// run 的草稿（工作副本）路径；没有草稿的 run 缺席。
    pub draft_path: Option<String>,
    /// `running` / `stopped` / `completed` / `errored`（journal 行）。
    pub status: String,
    /// `status == "stopped"` 才在场。
    pub stop_reason: Option<String>,
    pub holes: Vec<WorkflowFillTargetHole>,
}

/// 确认前读面上的一处留白（工具据 `waiting` 判「这个 run 是不是在等它」）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowFillTargetHole {
    pub site_id: String,
    pub name: String,
    /// 类型实参原文（`Verdict`）；读不到时 `unknown`。
    pub hole_type: String,
    /// 留白调用在草稿里的行号（1 起）。
    pub line: Option<u64>,
    pub waiting: bool,
}

/// DWF 工具面的引擎槽：工具注册表建好时 sidecar 还没接上（`with_workflow_engine` 在入口最后
/// 才调），工具在调用时读槽；缺席即「本会话不能补全」。
pub type WorkflowEngineSlot = Arc<std::sync::Mutex<Option<Arc<dyn WorkflowEngine>>>>;

/// `workflows/runs`（NIBI 协议中枢）的一行（Node `ZCodeSavedWorkflowRun` 的取数面）：按
/// `dwf_run.name` 归属到工作流的运行历史。可选键缺席即「没有」（老行 / 无产物），不发空串。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunPageRow {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `pending` / `running` / `completed` / `errored` / `stopped`（journal 行的终态拆解）。
    pub status: String,
    /// `status == "stopped"` 才在场。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub spent_tokens: u64,
    /// 发起它的会话与 CreateWorkflow 工具调用：有这两个才能从中枢打开实例详情。老行可缺。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    /// 实际运行的项目目录（`dwf_run.cwd`）。全局档跨 cwd 查询，GUI 用它给每行标项目。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 这次运行发布的**用户面产物**（≤ 8 件，与 `GetWorkflowRun` 同一条归并）——中枢的运行
    /// 历史行在状态词之后画 kind chips。零件整字段缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<WorkflowRunArtifact>>,
}

impl WorkflowEngineError {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            message: None,
        }
    }

    pub fn with_message(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            message: Some(message.into()),
        }
    }
}

/// DWF 引擎（路线 C 的 sidecar 端口）：启动 / 恢复 / 修订 / 取消一次 run。
///
/// submit / resume / amend 成功时给 [`WorkflowRunStarted`]；业务拒绝给 [`WorkflowEngineError`]
/// （协议层按命令补 `fault.command.*Rejected.<reason>` 前缀）。run 的进度与结算走引擎自己的
/// 事件通道（`run/event`），不在这里。
#[async_trait::async_trait]
pub trait WorkflowEngine: Send + Sync {
    async fn start_saved(
        &self,
        parent: &crate::ids::SessionId,
        request: WorkflowStart,
    ) -> Result<WorkflowRunStarted, WorkflowEngineError>;

    async fn resume(
        &self,
        run_id: &str,
        name: Option<&str>,
    ) -> Result<WorkflowRunStarted, WorkflowEngineError>;

    async fn amend(&self, request: WorkflowAmend) -> Result<WorkflowRunStarted, WorkflowEngineError>;

    async fn cancel(&self, run_id: &str) -> Result<(), WorkflowEngineError>;

    /// FillWorkflowHole 的确认前读面：run 的展示元数据与留白表（[`WorkflowFillTarget`]）。
    /// 未知 runId → `Err`（`reason: "run_not_found"`）。
    async fn fill_target(
        &self,
        run_id: &str,
    ) -> Result<WorkflowFillTarget, WorkflowEngineError>;

    /// 给一处正在等的留白补上函数体（Node `port.fillHole` 的镜像）：拼接、编译、稳定性复核与
    /// 引擎放行都在引擎侧；这里只透传。`session` 落进 `hole-filled.filledBy`。
    async fn fill_hole(
        &self,
        session: &crate::ids::SessionId,
        run_id: &str,
        hole_id: &str,
        body: &str,
    ) -> Result<WorkflowFillOutcome, WorkflowEngineError>;
}

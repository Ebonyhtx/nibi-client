//! DWF（动态工作流）run 的只读面（NIBI 的 run 卡与详情页）。
//!
//! 数据来自 `dwf_run` 表（migration 0019，Node 的 journal 仓储写的那张表）：Rust 目前只读，
//! 引擎仍在 Node 侧（见 `docs/rust-kernel-dwf-design-2026-10-30.md` 的路线 C）。写面等 sidecar
//! 接进来时再加，且由引擎独占写。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// 一条 DWF 引擎进度事件（`workflowRuns` 状态键的输入；Node 的
/// `DynamicWorkflowRunProgressPayload` 同形）。
///
/// 引擎 sidecar 在一条 run 事件落 journal 之后经 `run/event` 通知宿主；`payload` 是事件对象
/// 去掉 `type` 的其余字段。宿主只按读面需要的键归约（run 行、节点、阶段、留白），不做完整
/// journal 重放。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunProgress {
    pub run_id: String,
    /// 发起这次 run 的工具调用（工具卡 → run 的联接键；中枢启动是 `launch-…`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// run 内的单调序号（`run/event` 的到达顺序；只用于 `lastEventSequence` 的单调性）。
    pub sequence: u64,
    /// 引擎事件判别式（`run-started` / `node-settled` / `run-settled` …）。
    pub event_type: String,
    /// 事件载荷（已去掉 `type`）。
    pub payload: Value,
    /// `actor-created` 上的子代理会话 id（引擎按 `(runId, actorRef)` 确定地铸出）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_session_id: Option<String>,
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

/// 「run 还欠着决定、主代理闲着」提醒钟的会话侧边（Node `WorkflowBlockedReminderClock` 的
/// 三个状态入口 + 开集事件，docs/dynamic-workflow/transcript-and-notifications.md
/// 「Reminding an idle main agent」）。会话 actor 在自己的忙闲转换处调用前三个（`user_spoke`
/// 只认真人发话，合成来源的注入不算）；开集事件（`escalation-raised` / `escalation-resolved` /
/// `hole-reached` / `hole-filled`）由引擎客户端从 run/event 转发给父会话。钟本体与宿主装配
/// 在 runtime（`blocked.rs` 纯件 + board）。
pub trait WorkflowBlockedEdges: Send + Sync {
    /// 一轮开始（任何来源）：钟停，空闲时长作废。
    fn session_busy(&self, session: &crate::ids::SessionId);

    /// 命令队列排空：空闲段从这里起算（已在空闲段里时 no-op）。
    fn session_idle(&self, session: &crate::ids::SessionId);

    /// 真人发话（prompt / steer）：每个 run 重新得到一对提醒。
    fn user_spoke(&self, session: &crate::ids::SessionId);

    /// 这个 run 的开集变了：它重新得到一对提醒（会话闲着时空闲钟从此刻重起）。
    fn open_set_changed(&self, session: &crate::ids::SessionId, run_id: &str);

    /// 会话关闭：此后不再排钟、不再发。
    fn session_closed(&self, session: &crate::ids::SessionId);
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// 在飞、不属于本会话，且同进程引擎的活 run 注册表里没有它（可能是上一个进程的残骸）。
    /// 读面（journal）不知道活 run，只有持有引擎槽的合成层能填；缺省 false。
    pub possibly_interrupted: bool,
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

/// 会话工作流工具面的激活入口（Node `activateDynamicWorkflowTools` 的内核一半）：`/workflow`
/// 命令、GUI 的启动/恢复/修订与冷恢复历史扫描都经它翻位。只加不减。
pub trait WorkflowActivation: Send + Sync {
    fn activate(&self, session: &crate::ids::SessionId);
}

/// 持久化历史里有没有过工作流用法（`/workflow` 文本或十一个工具的任一次调用）——
/// Node `persistedMessagesShowDynamicWorkflow` 的同一判据，冷恢复按它决定 `onDemand` 会话是否激活。
pub fn history_shows_dynamic_workflow(
    messages: &[crate::message::Message],
) -> bool {
    use crate::message::{ContentBlock, Message};
    const TOOLS: [&str; 11] = [
        "CreateWorkflow",
        "AmendWorkflow",
        "SaveWorkflow",
        "ListSavedWorkflows",
        "ListModels",
        "EvalWorkflowSnippet",
        "ListWorkflowRuns",
        "GetWorkflowRun",
        "ResumeWorkflowRun",
        "ResolveWorkflowQuestion",
        "FillWorkflowHole",
    ];
    for message in messages {
        match message {
            Message::User(user) => {
                for block in &user.content {
                    if let ContentBlock::Text { text } = block
                        && text
                            .split_whitespace()
                            .next()
                            .is_some_and(|first| first.eq_ignore_ascii_case("/workflow"))
                    {
                        return true;
                    }
                }
            }
            Message::Assistant(assistant) => {
                for block in &assistant.content {
                    if let ContentBlock::ToolUse { name, .. } = block
                        && TOOLS.contains(&name.as_str())
                    {
                        return true;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

/// 一次作者工具调用（Node 的 `CreateWorkflow` / `AmendWorkflow` / `SaveWorkflow` /
/// `ListSavedWorkflows` / `EvalWorkflowSnippet` / `ResumeWorkflowRun`）的两个阶段：确认前的
/// `prepare`（validateInput + resolveInput）与确认后的 `execute`（handler + formatModelContent）。
///
/// 两个阶段都由 sidecar 里的 Node 工具实现执行：校验器、诊断形状、文件落点、模型绑定与
/// model 内容都是同一份 `@nibi/core` 代码，Rust 只做工具面与权限。技能门的事实也在这里：
/// `has_loaded_skill` 由内核按**当前可见历史**判定（压缩后重新关门，与 Node 同一条语义）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAuthorRequest {
    /// Node 工具名（逐字，例如 `CreateWorkflow`）。
    pub tool: String,
    /// 模型给的入参（prepare 返回解析后的入参；execute 收同一份）。
    pub input: Value,
    /// 会话的工作目录（工具归一化与草稿落点都用它）。
    pub cwd: String,
    /// 发起调用的会话。
    pub session: String,
    /// 这次工具调用的 id（run 的 toolCallId 锚点）。
    pub tool_call: String,
    /// 当前可见历史里有没有一次成功的 `Skill(dynamic-workflows)` 调用。
    pub has_loaded_skill: bool,
    /// 会话此刻的模型选择（`ListModels` 的 `[current]` 与 `introduced_providers` 的判据）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<crate::model::ModelSelection>,
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

/// `workflows/runs`（NIBI 协议中枢）的一行（Node `NIBISavedWorkflowRun` 的取数面）：按
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

// ————————————————————————————————————————————————————————————————
// v4 查询面（141 审计 §9 第 2 项）：run 详情 7 条与枚举 1 条。
//
// 与上面的中枢读面并行而不合并：中枢回的是「按名字归属的运行历史」，它的行形状是
// `WorkflowRunPageRow`（带 args/cwd/产物 chips，界 50 条）；这一族回的是**会话视角**的
// run 目录与详情页三个切片（事件页、产物页、工作区 transcript），字段与 Node 的 v4
// schema 一一对应。两套界不同（64 条 / 500 事件 / 2000 节点），合并会把界也一起混掉。
// ————————————————————————————————————————————————————————————————

/// run 目录的一行（`v4/conversation/workflowRuns` 的元素）。
///
/// 与 [`WorkflowRunPageRow`] 的差别是**没有 cwd/args/产物 chips**，多了 `resumable`——
/// 后者由存储按 resume 门的同一个谓词算好，UI 绝不自行推导（两处谓词会漂移）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSummaryRow {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// 展示标签（服务端读时派生：`name` → 脚本首行 → runId）。
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    pub resumable: bool,
}

/// 事件日志的一行（`v4/conversation/workflowRunEvents` 的元素）：`payload` 是事件对象去掉
/// `type` 后的其余字段，已按结构界有界化（字符串长度 / 数组条数 / 键数 / 深度）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunEventRow {
    pub sequence: u64,
    /// 事件判别式（`run-started` / `node-settled` / `report` …）。
    pub r#type: String,
    pub payload: serde_json::Value,
    /// 载荷被裁剪过（原始事实仍在 journal）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// `ListWorkflowRuns` 的工具读面（按项目 cwd 跨会话枚举）：标签派生需要脚本首行，因此这一行
/// 带 `script_text`（调用方截取首行后丢弃，不把脚本搬进模型内容）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunListRow {
    pub run_id: String,
    pub name: Option<String>,
    pub script_text: Option<String>,
    /// 逻辑状态：`pending` / `running` / `completed` / `errored` / `stopped`。
    pub status: String,
    pub stop_reason: Option<String>,
    pub resumed_from: Option<String>,
    pub superseded_by: Option<String>,
    pub parent_session_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub spent_tokens: u64,
}

/// 事件日志的一页；`has_more` 由存储判定（页可能因字节上界提前收尾）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunEventPage {
    pub events: Vec<WorkflowRunEventRow>,
    pub has_more: bool,
}

/// 事件页的查询袋。条数与字节两道界都由调用方给定（存储层精确兑现、不另加天花板）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkflowRunEventQuery {
    /// 只取 sequence **严格大于**该值的事件；缺省从头取。
    pub after_sequence: Option<u64>,
    pub limit: usize,
    /// 一页载荷的字节上界（按落库的 `payload_json` 字节计）。
    pub max_bytes: u64,
}

/// 一个产物**版本**的元数据（`workflowRunArtifacts` 的元素里 `versions[]` 的形状）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunArtifactVersion {
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// store 的 `nibi-artifact://…`。**只给 CLI 侧用**——模型与 renderer 都读不了它，
    /// 协议层必须把它剥掉（[`WorkflowRunArtifactVersion::public`]）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
    pub published_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<bool>,
}

/// 一件用户面产物的**全部版本**（`workflowRunArtifacts` 的元素）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunArtifactDetail {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
    /// 最新版号（= `versions` 末项的 version）。
    pub version: u64,
    /// 版本升序；失败的发布**不在**这里（失败行不认领 id / 种类 / 版本）。
    pub versions: Vec<WorkflowRunArtifactVersion>,
    /// 打了这个 id 标签的 `report` 条目数（预置看板的数据量；内容产物恒 0）。
    pub item_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<bool>,
}

/// 看板取数的一行（`workflowRunArtifactData` 的元素）：cursor = journal sequence。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunArtifactItem {
    pub sequence: u64,
    pub site_id: String,
    pub ordinal: u64,
    /// 条目原值；请求带 `fields` 时缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<serde_json::Value>,
    /// 请求带 `fields` 时：路径 → 值（走不通的路径不在表里）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<serde_json::Value>,
}

/// 看板条目的一页。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunArtifactItemPage {
    pub items: Vec<WorkflowRunArtifactItem>,
    pub has_more: bool,
}

/// 看板条目的查询袋（条数与字节两道界由调用方给定）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunArtifactItemQuery {
    pub artifact_id: String,
    pub after_sequence: Option<u64>,
    pub limit: usize,
    pub max_bytes: u64,
    /// 只取这些字段路径（[`read_workflow_artifact_field`] 的规则）；`None` = 整条 item。
    pub fields: Option<Vec<String>>,
    /// 一个字段值的序列化字节上界（超过回成截短的字符串）。
    pub max_field_value_bytes: u64,
}

/// 工作区 transcript 的一行（`workflowRunWorkspace` 的元素；**不带正文**）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunWorkspaceNode {
    pub site_id: String,
    pub ordinal: u64,
    /// `world-read` / `world-run`。
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_truncated: Option<bool>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<WorkflowRunError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<WorkflowRunWorkspaceSummary>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// 清单上一行的摘要：不解正文就能报的几个数（哪个在场取决于 op）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunWorkspaceSummary {
    pub result_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_bytes: Option<u64>,
}

/// 一个工作区节点的正文（`workflowRunNodeResult` 的结果）：按 `max_bytes` **保形**有界化。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunNodeResult {
    pub status: String,
    /// 有界化后的正文；running 行与 failed 行缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<WorkflowRunError>,
    pub truncated: bool,
    /// 截断前的序列化字节数。
    pub total_bytes: u64,
}

/// 按点路径从一条 report item 里取值（`readWorkflowArtifactField` 的规则，协议上的契约）：
/// 按 `.` 切段；当前值是数组时，段按 `Number(段)` 当下标（非负整数且在界内才算）；是对象时
/// 按键取；走不通（null、标量、越界、缺键）得 `None`。
///
/// 这条规则同时是 CLI 在 SQLite 里取字段的依据，两侧必须逐字相同——渲染器拿到的值必须与它
/// 自己从整条 item 里取出来的逐字相同。
pub fn read_workflow_artifact_field(item: &serde_json::Value, path: &str) -> Option<serde_json::Value> {
    let mut cursor = item;
    for segment in path.split('.') {
        match cursor {
            serde_json::Value::Array(items) => {
                let index = segment.parse::<i64>().ok().filter(|index| *index >= 0)?;
                cursor = items.get(usize::try_from(index).ok()?)?;
            }
            serde_json::Value::Object(fields) => cursor = fields.get(segment)?,
            _ => return None,
        }
    }
    Some(cursor.clone())
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

    /// 作者工具的确认前阶段（Node 工具条目的 validateInput + resolveInput）。成功时回解析后的
    /// 入参（JSON 对象）；业务拒绝由实现返回 `WorkflowEngineError`（`reason` 是 Node 词表，
    /// `message` 是给模型的说明）。没有作者能力的实现返回默认的 `authoring_unavailable`。
    async fn author_prepare(
        &self,
        _request: WorkflowAuthorRequest,
    ) -> Result<Value, WorkflowEngineError> {
        Err(WorkflowEngineError::new("authoring_unavailable"))
    }

    /// 作者工具的执行阶段（handler + formatModelContent）。回复形状：
    /// `{"ok":true,"content":"…","isError":false}` 或 `{"ok":false,"message":"…"}`。
    async fn author_execute(
        &self,
        _request: WorkflowAuthorRequest,
    ) -> Result<Value, WorkflowEngineError> {
        Err(WorkflowEngineError::new("authoring_unavailable"))
    }

    /// 此刻还在跑的 run（Node 同进程的活 run 注册表）：`ListWorkflowRuns` 的
    /// `possiblyInterrupted` 用它区分「同进程另一会话仍在飞」与「上一个进程留下的残骸」。
    /// 不跟踪活 run 的实现返回 None，调用方按「非本会话且在飞」保守标注。
    fn live_run_ids(&self) -> Option<Vec<String>> {
        None
    }

    /// GUI 中枢的已保存工作流读面（`workflows/list`）：定向 scope 的目录枚举，回复是
    /// Node `listSavedWorkflowsOp` 的原形（解析器在 sidecar 的 @nibi/core，宿主只转发）。
    async fn hub_list_saved_workflows(
        &self,
        workspace_path: &str,
        scope: &str,
    ) -> Result<Value, WorkflowEngineError>;

    /// GUI 中枢的单个已保存工作流（`workflows/get`）：定向 scope 的解析，回复是 Node
    /// `getSavedWorkflowOp` 的原形（ok:true 六键或 ok:false 失败袋）。
    async fn hub_get_saved_workflow(
        &self,
        workspace_path: &str,
        name: &str,
        scope: &str,
    ) -> Result<Value, WorkflowEngineError>;

    /// GUI 中枢的已保存工作流写面（`workflows/save`）：完成卡的直接保存——按 runId 从
    /// journal 读这次 run 实际执行的脚本（sidecar 靠 `dbPath` 打开同一份 journal），按
    /// SaveWorkflow 同一套规则落盘。回复是 Node `saveSavedWorkflowFromRunOp` 的原形。
    async fn hub_save_workflow_from_run(
        &self,
        workspace_path: &str,
        run_id: &str,
        name: &str,
        meta: Value,
        scope: &str,
        overwrite: bool,
    ) -> Result<Value, WorkflowEngineError>;

    /// `workflows/updateMeta`：只改写文件顶部的元数据（读回脚本正文、整文件覆写）。回复是
    /// Node `updateSavedWorkflowMetaOp` 的原形。
    async fn hub_update_saved_workflow_meta(
        &self,
        workspace_path: &str,
        name: &str,
        meta: Value,
        scope: &str,
    ) -> Result<Value, WorkflowEngineError>;

    /// `workflows/delete`：只按名字删（名字合法性是路径穿越的防线，先验后拼在 sidecar）。
    async fn hub_delete_saved_workflow(
        &self,
        workspace_path: &str,
        name: &str,
        scope: &str,
    ) -> Result<Value, WorkflowEngineError>;

    /// `workflows/move`：全局根的同名文件搬到项目根（只此一向；无 scope 入参）。
    async fn hub_move_saved_workflow(
        &self,
        workspace_path: &str,
        name: &str,
    ) -> Result<Value, WorkflowEngineError>;

    /// `workflows/forRun`（完成卡的推导判定）：三规则按序——对话说的候选 → run 跑的脚本逐字
    /// 节相同 → run 名=定义名。回复是 Node `findSavedWorkflowForRunOp` 的原形（entry/match/
    /// runArgs，全 optional）。`candidates` 是协议层验过的数组（缺席/空同形）。
    async fn hub_find_saved_workflow_for_run(
        &self,
        workspace_path: &str,
        run_id: &str,
        candidates: Value,
    ) -> Result<Value, WorkflowEngineError>;
}

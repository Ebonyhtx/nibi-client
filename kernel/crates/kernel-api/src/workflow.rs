//! DWF（动态工作流）run 的只读面（NIBI 的 run 卡与详情页）。
//!
//! 数据来自 `dwf_run` 表（migration 0019，Node 的 journal 仓储写的那张表）：Rust 目前只读，
//! 引擎仍在 Node 侧（见 `docs/rust-kernel-dwf-design-2026-10-30.md` 的路线 C）。写面等 sidecar
//! 接进来时再加，且由引擎独占写。

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
}

/// 引擎的业务拒绝：`reason` 是 Node 词表里的 token，前缀由调用方按命令补。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowEngineError {
    pub reason: String,
    pub message: Option<String>,
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
}

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

/// 引擎拒绝码的前缀（Node `SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX` 等）。
pub const SAVED_WORKFLOW_START_REJECTED: &str = "fault.command.savedWorkflowStartRejected.";
pub const WORKFLOW_RUN_RESUME_REJECTED: &str = "fault.command.workflowRunResumeRejected.";
pub const WORKFLOW_RUN_SETTINGS_REJECTED: &str = "fault.command.workflowRunSettingsRejected.";

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

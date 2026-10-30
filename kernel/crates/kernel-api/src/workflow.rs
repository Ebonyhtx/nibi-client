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

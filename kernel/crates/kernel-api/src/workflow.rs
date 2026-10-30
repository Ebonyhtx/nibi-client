//! DWF（动态工作流）run 的只读面（NIBI 的 run 卡与详情页）。
//!
//! 数据来自 `dwf_run` 表（migration 0019，Node 的 journal 仓储写的那张表）：Rust 目前只读，
//! 引擎仍在 Node 侧（见 `docs/rust-kernel-dwf-design-2026-10-30.md` 的路线 C）。写面等 sidecar
//! 接进来时再加，且由引擎独占写。

use serde::{Deserialize, Serialize};

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

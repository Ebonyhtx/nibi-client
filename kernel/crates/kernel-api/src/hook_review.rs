//! 工作区钩子的逐条信任（NIBI 的 `requestWorkspaceHookReview` 等四条命令）。
//!
//! 形状对齐 NIBI 的 `workspaceHookReviewTrustStateSchema` 与 `workspace-hook-review.ts` 的 items：
//! 一条钩子一条 `reviewItemId`（`workspace-hook-<source>-<event>-<matcher>-<hook>`）+ 它的声明摘要。
//! 信任记录按**声明摘要**存（`rust_cli_platform::HookTrustStore`），不是按工作区路径——路径级信任是
//! 另一件事（工作区信任提示）。
//!
//! 内核只给"快照 + 授权 + 撤销"三个动作；评审流（`reviewFlowId`/`generation`/交互）在协议前端。

use serde::{Deserialize, Serialize};

/// 一条钩子的信任状态（NIBI `workspaceHookReviewTrustStateSchema` 的子集：内核能判定的那些）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookTrustState {
    /// 已按声明摘要信任。
    TrustedPersistent,
    /// 还没信任（可以评审）。
    PendingTrust,
    /// 曾信任又被撤销（与 pending 分开只为了文案；判定上等同待审）。
    Revoked,
    /// 摘要变了（配置改过），旧信任不算数。
    StaleDigest,
    /// 策略禁止持久信任（企业策略），评审也授权不了。
    BlockedPolicy,
    /// 这个工作区没有可评审的钩子。
    NotApplicable,
}

impl HookTrustState {
    /// 是不是待处理（NIBI 的 `pendingCount` 只数这三种）。
    pub fn pending(self) -> bool {
        matches!(self, Self::PendingTrust | Self::Revoked | Self::StaleDigest)
    }
}

/// 一条钩子（对齐 NIBI 评审 payload 的 `items[]` 里内核能提供的那部分）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHookItem {
    pub review_item_id: String,
    /// 事件名（NIBI 的 7 个：SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/
    /// PostToolUse/PostToolUseFailure/Stop）。
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    /// `command` 或 `process`。
    pub kind: String,
    pub display_name: String,
    pub display_command: String,
    pub source_path: String,
    pub resolved_timeout_ms: u64,
    pub resolved_max_output_bytes: u64,
    pub configured_enabled: bool,
    pub editable: bool,
    pub trust_state: HookTrustState,
    /// 声明摘要（撤销与授权都按它）。
    pub declaration_digest: String,
}

/// 一个工作区的钩子评审快照。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHookReview {
    /// 工作区身份（NIBI 的 `workspaceIdentity`）。
    pub identity: String,
    /// bundle 摘要（NIBI 的 `bundleDigest`）；没有可评审项时为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_digest: Option<String>,
    /// 拒绝码（NIBI 的 `reasonCode`）：`not_applicable` / `no_enabled_hooks` / `pending_trust` /
    /// `trusted_persistent` / `blocked_policy` / `trust_store_corrupt`。
    pub reason_code: String,
    pub items: Vec<WorkspaceHookItem>,
}

impl WorkspaceHookReview {
    /// 待处理项数（NIBI 的 `summary.pendingCount`）。
    pub fn pending_count(&self) -> usize {
        self.items.iter().filter(|item| item.trust_state.pending()).count()
    }

    /// 有没有可评审的项（NIBI 的 `requestWorkspaceHookReview` 用它决定是否开评审流）。
    pub fn has_pending(&self) -> bool {
        self.pending_count() > 0
    }
}

#[cfg(test)]
#[path = "hook_review_tests.rs"]
mod tests;

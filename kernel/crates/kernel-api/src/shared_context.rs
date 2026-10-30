//! 分享导入的本地状态（NIBI 的 `sharedContextImport` 快照字段与 `discardSharedContext`）。
//!
//! 形状对齐 NIBI 的 `sharedContextImportV2StateSchema`（`contextId` / `title` / `shareUrl` /
//! `status`）。存储是 Node 已经写好的 `session_entry`（`type = "v4/shared_context_import"`），本 crate
//! 只描述读出的值；读写经 `SessionStore` 的前端记录端口（`session_entry` 的同一张表）。

use serde::{Deserialize, Serialize};

/// 一个会话的分享导入状态（`pending` / `reserved` / `attached` / `discarded`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedContextImportState {
    pub context_id: String,
    pub title: String,
    pub share_url: String,
    /// `pending` / `reserved` / `attached` / `discarded`（NIBI 的四个值）。
    pub status: String,
}

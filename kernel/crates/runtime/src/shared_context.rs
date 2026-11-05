//! 分享导入的本地状态（NIBI `discardSharedContext` 与会话快照的 `sharedContextImport`）。
//!
//! 存储是 Node 写的 `session_entry`（`type = "v4/shared_context_import"`，`data` 带 `contextId` /
//! `shareUrl` / `status` 等 provenance 字段）。Rust 不参与导入本身（导入由 Node 的 server-operations
//! 完成），只做两件事：冷打开时读出状态喂给投影；把还没附加的一条标成 `discarded`。
//!
//! Node 的对应实现：`v4-bridge.ts` 的 `discardSharedContext` 与 `sqlite-session-store.ts` 的
//! `transitionSharedContextImport`（只允许 `pending` → `discarded`，并同步消息元数据
//! `sharedContextStatus`；Rust 的消息模型没有这条元数据，恢复时的排除规则在 Rust 侧本来就不生效）。

use super::*;
use nibi_kernel_api::shared_context::SharedContextImportState;
use nibi_kernel_api::store::FrontendRecord;
use serde_json::Value;

/// Node `session_entry.type`。
pub const SHARED_CONTEXT_IMPORT: &str = "v4/shared_context_import";

/// 可以出现在 NIBI 快照里的状态（Node `sharedContextImportV2StateSchema`）。
const STATUSES: [&str; 4] = ["pending", "reserved", "attached", "discarded"];

/// 一条 session_entry → NIBI 的 `sharedContextImport`（缺字段时 None：快照里不放半截记录）。
fn state(record: &FrontendRecord, title: &str) -> Option<SharedContextImportState> {
    let title = title.trim();
    let context_id = record.data["contextId"].as_str()?.trim();
    let share_url = record.data["shareUrl"].as_str()?.trim();
    let status = record.data["status"].as_str()?;
    if title.is_empty() || context_id.is_empty() || share_url.is_empty() || !STATUSES.contains(&status)
    {
        return None;
    }
    Some(SharedContextImportState {
        context_id: context_id.to_owned(),
        title: title.to_owned(),
        share_url: share_url.to_owned(),
        status: status.to_owned(),
    })
}

impl LocalKernel {
    /// 会话里第一条分享导入（Node 的 `entries.find`：`sessionEntries` 按 `time_created` 排序）。
    async fn shared_context_entry(
        &self,
        session: &SessionId,
    ) -> Result<Option<FrontendRecord>, KernelError> {
        Ok(self
            .ports
            .store
            .records(session, SHARED_CONTEXT_IMPORT)
            .await
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })?
            .into_iter()
            .next())
    }

    async fn session_title(&self, session: &SessionId) -> String {
        self.ports
            .store
            .load(session)
            .await
            .map(|loaded| loaded.meta.title)
            .unwrap_or_default()
    }

    /// 冷打开的种子（`sharedContextImport`）：没有导入时 None。
    pub(crate) async fn shared_context_state(
        &self,
        session: &SessionId,
    ) -> Result<Option<SharedContextImportState>, KernelError> {
        let Some(record) = self.shared_context_entry(session).await? else {
            return Ok(None);
        };
        let title = self.session_title(session).await;
        Ok(state(&record, &title))
    }

    /// NIBI `discardSharedContext`：只允许把还没附加（`pending`）的一条标成 `discarded`。
    /// 返回更新后的状态；没有可放进快照的元数据（标题/分享地址缺）时返回 None，但写入照常发生。
    pub(crate) async fn discard_import(
        &self,
        session: &SessionId,
        context_id: &str,
    ) -> Result<Option<SharedContextImportState>, KernelError> {
        let not_pending = || KernelError::Failed {
            message: "fault.command.inputRejected: shared context is not pending".to_owned(),
        };
        let records = self
            .ports
            .store
            .records(session, SHARED_CONTEXT_IMPORT)
            .await
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })?;
        let record = records
            .into_iter()
            .find(|record| record.data["contextId"].as_str() == Some(context_id))
            .ok_or_else(not_pending)?;
        if record.data["status"].as_str() != Some("pending") {
            return Err(not_pending());
        }
        let mut data: Value = record.data.clone();
        data["status"] = serde_json::json!("discarded");
        self.ports
            .store
            .put_record(
                session,
                &FrontendRecord {
                    kind: record.kind,
                    key: record.key,
                    data,
                },
            )
            .await
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })?;
        let title = self.session_title(session).await;
        Ok(self
            .shared_context_entry(session)
            .await?
            .and_then(|record| state(&record, &title)))
    }
}

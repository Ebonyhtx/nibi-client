//! 主会话 prompt 快照（K6；对齐上游 `apps/zcode-cli/packages/core/src/runtime/helpers/prompt-snapshot.ts`
//! 与 `docs/design/v2/loop/prompt-snapshot.md`）。
//!
//! 记录主会话发出的 system 段，之后的请求按记录发送，冷恢复与升级后 system 字节不变。工具不记录：MCP 工具在会话
//! 中途会变，每次请求按当前注册表发送。存储是 `session_entry` 里的一行前端记录：`type = runtime/prompt_snapshot`，
//! `id = <sessionId>:runtime-prompt-snapshot`，同 key 覆盖、不推进会话的活动时间。
//!
//! 数据形状（字段名与上游一致）：
//!
//! ```text
//! { model: { providerId, modelId }, system: [{ role: "system", content, cacheControl? }, ...] }
//! ```
//!
//! 或者墓碑 `{ cleared: true }`。不存版本与哈希。

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ids::SessionId;
use crate::model::{CacheControl, ModelSelection, SystemBlock};
use crate::store::{FrontendRecord, SessionStore, StoreError};

/// 前端记录的 kind（Node `SESSION_ENTRY_PROMPT_SNAPSHOT`）。
pub const PROMPT_SNAPSHOT_KIND: &str = "runtime/prompt_snapshot";

/// 快照记录的 id：`<sessionId>:runtime-prompt-snapshot`。
pub fn prompt_snapshot_key(session: &SessionId) -> String {
    format!("{session}:runtime-prompt-snapshot")
}

/// 快照渲染时的模型身份（Node `PromptSnapshot.model`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSnapshotModel {
    pub provider_id: String,
    pub model_id: String,
}

/// 快照里的一条 system 消息（Node `ModelInputMessage`，只用到 system 的三个字段）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSnapshotMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
}

/// 一份 prompt 快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptSnapshot {
    pub model: PromptSnapshotModel,
    pub system: Vec<PromptSnapshotMessage>,
}

impl PromptSnapshot {
    /// 按请求模型与本次请求的 system 段生成快照。
    pub fn of(selection: &ModelSelection, system: &[SystemBlock]) -> Self {
        Self {
            model: PromptSnapshotModel {
                provider_id: selection.provider.clone(),
                model_id: selection.model.clone(),
            },
            system: system
                .iter()
                .map(|block| PromptSnapshotMessage {
                    role: "system".to_owned(),
                    content: block.text.clone(),
                    cache_control: block.cache_control.clone(),
                })
                .collect(),
        }
    }

    /// 请求模型与快照模型相同（只比较 provider 与 model id；推理档不比较）。
    pub fn matches(&self, selection: &ModelSelection) -> bool {
        self.model.provider_id == selection.provider && self.model.model_id == selection.model
    }

    /// 快照记录的 system 段，按发送顺序。
    pub fn system_blocks(&self) -> Vec<SystemBlock> {
        self.system
            .iter()
            .map(|message| SystemBlock {
                text: message.content.clone(),
                cache_control: message.cache_control.clone(),
            })
            .collect()
    }
}

/// 内存里的快照状态：没有快照（Node `undefined`）由外层 `None` 表示；这里是 `Present`（有快照）与
/// `Cleared`（compaction 写的墓碑，Node `null`）。
#[derive(Debug, Clone, PartialEq)]
pub enum PromptSnapshotState {
    Present(PromptSnapshot),
    Cleared,
}

impl PromptSnapshotState {
    pub fn present(&self) -> Option<&PromptSnapshot> {
        match self {
            Self::Present(snapshot) => Some(snapshot),
            Self::Cleared => None,
        }
    }

    /// 落库的 `data`。
    pub fn data(&self) -> Value {
        match self {
            Self::Present(snapshot) => serde_json::to_value(snapshot).unwrap_or(Value::Null),
            Self::Cleared => json!({ "cleared": true }),
        }
    }
}

/// 解析一行快照记录。`None` 表示没有快照或数据无效（按没有快照处理）；墓碑是 `Some(Cleared)`。
///
/// 与上游 `parsePromptSnapshot` 一致：`cleared === true` 是墓碑；`model.providerId` / `model.modelId` 必须是字符串，
/// `system` 必须是数组，每条的 `role` 是 `system`、`content` 是字符串、`cacheControl` 缺省或对象。多出的字段忽略。
pub fn parse_prompt_snapshot(data: &Value) -> Option<PromptSnapshotState> {
    if data.get("cleared") == Some(&Value::Bool(true)) {
        return Some(PromptSnapshotState::Cleared);
    }
    let snapshot: PromptSnapshot = serde_json::from_value(data.clone()).ok()?;
    if snapshot
        .system
        .iter()
        .any(|message| message.role != "system")
    {
        return None;
    }
    Some(PromptSnapshotState::Present(snapshot))
}

/// 快照的存储行。
pub fn prompt_snapshot_record(session: &SessionId, state: &PromptSnapshotState) -> FrontendRecord {
    FrontendRecord {
        kind: PROMPT_SNAPSHOT_KIND.to_owned(),
        key: prompt_snapshot_key(session),
        data: state.data(),
    }
}

/// 读会话的快照（冷恢复）：最后一行；读取失败由调用方决定（不阻断恢复）。
pub async fn load_prompt_snapshot(
    store: &dyn SessionStore,
    session: &SessionId,
) -> Result<Option<PromptSnapshotState>, StoreError> {
    let records = store.records(session, PROMPT_SNAPSHOT_KIND).await?;
    Ok(records
        .last()
        .and_then(|record| parse_prompt_snapshot(&record.data)))
}

/// 覆盖写会话的快照（同 key 覆盖，不推进会话的活动时间）。
pub async fn save_prompt_snapshot(
    store: &dyn SessionStore,
    session: &SessionId,
    state: &PromptSnapshotState,
) -> Result<(), StoreError> {
    store
        .put_record(session, &prompt_snapshot_record(session, state))
        .await
}

/// 写墓碑：compaction 成功后清掉快照（`cleared: true`）。
pub async fn clear_prompt_snapshot(
    store: &dyn SessionStore,
    session: &SessionId,
) -> Result<(), StoreError> {
    save_prompt_snapshot(store, session, &PromptSnapshotState::Cleared).await
}

#[cfg(test)]
#[path = "prompt_snapshot_tests.rs"]
mod tests;

//! 行目标的解析（141 审计 §9 第 2 项余项）：`target: {rowId, entityId}` → 这一轮的消息 id 集合。
//!
//! Host 的 `resolveRowActionTarget` 只接受 `turnHeader` 行：文件变更与回退预览都以一轮为入口，
//! 不暴露内部 messageId（`product-projection.ts` 的注释）。内核侧同一口径：先校验行还在、entity
//! 没换（`proto.staleTarget`），再按这一轮的行收集消息 id（userInput 的 entityId 与 assistant
//! 行的 `assistantResponseId`），会话侧用它选 checkpoint 的 prompt / assistant。

use nibi_kernel_api::ids::MessageId;
use serde_json::Value;

use crate::live::Live;

/// 一个行目标。
pub(crate) struct Target {
    pub row_id: u64,
    pub entity_id: String,
}

impl Target {
    pub fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            row_id: value.get("rowId")?.as_u64()?,
            entity_id: value.get("entityId")?.as_str()?.to_owned(),
        })
    }
}

/// 这一轮的消息 id：`userInput` 行的 entityId 与任何行的 `assistantResponseId`，按行序去重。
///
/// 冷投影的轮键是 `"<user 消息 id>:turn:<n>"`，live 投影的轮键是运行时 turn id；两种都以行上的
/// `turnId` 为准，不去猜轮键的形状。
pub(crate) fn message_ids(live: &Live, target: &Target) -> Result<Vec<MessageId>, String> {
    let Some(row) = live.row(target.row_id) else {
        return Err("proto.staleTarget".to_owned());
    };
    if row.get("entityId").and_then(Value::as_str) != Some(target.entity_id.as_str()) {
        return Err("proto.staleTarget".to_owned());
    }
    if row.get("kind").and_then(Value::as_str) != Some("turnHeader") {
        return Err("guard.actionUnavailable".to_owned());
    }
    let turn = row
        .get("turnId")
        .and_then(Value::as_str)
        .ok_or_else(|| "proto.staleTarget".to_owned())?;
    let mut ids: Vec<MessageId> = Vec::new();
    for candidate in live.rows() {
        if candidate.get("turnId").and_then(Value::as_str) != Some(turn) {
            continue;
        }
        let user = (candidate.get("kind").and_then(Value::as_str) == Some("userInput"))
            .then(|| candidate.get("entityId").and_then(Value::as_str))
            .flatten();
        let assistant = candidate
            .get("assistantResponseId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        for id in user.into_iter().chain(assistant) {
            let id = MessageId::new(id.to_owned());
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    Ok(ids)
}

/// 回退类入口的同一解析，外加 Host 的两道闸：轮头带摘要，且撤销入口在场（`guard.actionUnavailable`）。
pub(crate) fn rewind_message_ids(live: &Live, target: &Target) -> Result<Vec<MessageId>, String> {
    let row = live
        .row(target.row_id)
        .ok_or_else(|| "proto.staleTarget".to_owned())?;
    if row.get("entityId").and_then(Value::as_str) != Some(target.entity_id.as_str()) {
        return Err("proto.staleTarget".to_owned());
    }
    let rewindable = row
        .get("actions")
        .and_then(|actions| actions.get("canRewindFiles"))
        .and_then(Value::as_bool)
        == Some(true);
    if row.get("fileChanges").is_none() || !rewindable {
        return Err("guard.actionUnavailable".to_owned());
    }
    message_ids(live, target)
}

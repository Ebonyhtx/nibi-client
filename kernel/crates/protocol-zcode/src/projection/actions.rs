//! 行级动作（Host `rowActionsSchema`）：`canEdit` / `canRetry` / `canFork` 与
//! `canRewindFiles`（141 审计 §9「行级 actions 的剩余缺口」）。
//!
//! 规则逐条照 Node 的 `materializeCommandRowActions`（`product-projection.ts`）：
//!
//! - **edit**：时间线上最后一条 `realUser` 的 `userInput` 行，且没有进行中的回合（Node 的
//!   `completionBlockingActive` 在 Rust 里就是有回合在跑）；编辑入口让前端把输入放回输入框。
//! - **retry**：全时间线最后一条 `assistantText` 行，且它已落定（`state: complete`）、所属轮头
//!   不在 running、同一轮里有真实的用户输入（Node 再要求 `editTarget`，Rust 的编辑/重试目标
//!   就是行自己的 entityId / `assistantResponseId`，命令层会再校验）。
//! - **fork**：某一轮的最后一段 `assistantText`，行已落定、轮头是 `completedSuccess`。
//! - **canRewindFiles**：轮头终态、有 `fileChanges` 且 `state: active`、没有待回答的交互、
//!   没有回合在跑（与 `files.rs` 的 live 规则同一条）。
//!
//! 只在会改变这些判断的事件后重算（轮开始/收口、消息落定、文件摘要、交互询问/结算），
//! 流式增量不触发；行内容没变时不发增量。

use serde_json::{Map, Value, json};

use super::state::Phase;

impl super::Projection {
    /// 按当前行重算并写回行级动作；只发出真的变了的行。
    pub(super) fn refresh_actions(&mut self, out: &mut Vec<Value>) {
        let busy = self.phase == Phase::Running;
        let pending = !self.pending.is_empty();
        // 最后一条可编辑的 realUser 输入（从尾部找）。与 Rust 的命令面一致：回合在跑时
        // `Rewind` 会被拒（`editUserQuery` 没有 stop barrier 实现），所以不展示入口。
        // Node 在 running 时仍给编辑/分叉——这是记录在案的保真差异。
        let latest_editable = (!busy)
            .then(|| {
                self.rows
                    .iter()
                    .rev()
                    .find(|row| row["kind"] == "userInput" && row["origin"] == "realUser")
                    .and_then(|row| row["rowId"].as_u64())
            })
            .flatten();
        // 全时间线最后一条 assistantText；它必须已落定、轮头不在 running、同轮有真实输入。
        let latest_assistant = self.rows.iter().rev().find(|row| {
            row["kind"] == "assistantText"
                && row["state"] == "complete"
                && row.get("assistantResponseId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty())
                && !busy
                && self.turn_header_state(row["turnId"].as_str().unwrap_or_default())
                    != Some("running".to_owned())
                && self
                    .rows
                    .iter()
                    .any(|candidate| {
                        candidate["kind"] == "userInput"
                            && candidate["origin"] == "realUser"
                            && candidate["turnId"] == row["turnId"]
                    })
        });
        let latest_assistant_id = latest_assistant.and_then(|row| row["rowId"].as_u64());
        // 每一轮的最后一段 assistantText（fork 入口）。
        let mut last_in_turn: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for row in &self.rows {
            if row["kind"] == "assistantText"
                && let (Some(turn), Some(id)) =
                    (row["turnId"].as_str(), row["rowId"].as_u64())
            {
                last_in_turn.insert(turn.to_owned(), id);
            }
        }
        let mut deltas = Vec::new();
        let mut updates: Vec<(usize, Map<String, Value>)> = Vec::new();
        for (index, row) in self.rows.iter().enumerate() {
            let kind = row["kind"].as_str().unwrap_or_default();
            if !matches!(kind, "turnHeader" | "userInput" | "assistantText") {
                continue;
            }
            let mut next = row
                .get("actions")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            match kind {
                "turnHeader" => {
                    let active_files = row
                        .get("fileChanges")
                        .and_then(Value::as_object)
                        .is_some_and(|changes| changes.get("state") != Some(&json!("reverted")));
                    let can_rewind = !busy && !pending && row["state"] != "running" && active_files;
                    if can_rewind {
                        next.insert("canRewindFiles".into(), json!(true));
                    } else {
                        next.remove("canRewindFiles");
                    }
                }
                "userInput" => {
                    if latest_editable == row["rowId"].as_u64() {
                        next.insert("canEdit".into(), json!(true));
                        next.insert("editDisposition".into(), json!("rewind"));
                    } else {
                        next.remove("canEdit");
                        next.remove("editDisposition");
                    }
                }
                _ => {
                    if latest_assistant_id == row["rowId"].as_u64() {
                        next.insert("canRetry".into(), json!(true));
                    } else {
                        next.remove("canRetry");
                    }
                    let turn = row["turnId"].as_str().unwrap_or_default();
                    let can_fork = !busy
                        && row["state"] == "complete"
                        && last_in_turn.get(turn).copied() == row["rowId"].as_u64()
                        && self.turn_header_state(turn).as_deref() == Some("completedSuccess");
                    if can_fork {
                        next.insert("canFork".into(), json!(true));
                    } else {
                        next.remove("canFork");
                    }
                }
            }
            let current = row.get("actions").and_then(Value::as_object);
            if current == Some(&next) || (current.is_none() && next.is_empty()) {
                continue;
            }
            updates.push((index, next));
        }
        for (index, next) in updates {
            let row = &mut self.rows[index];
            if next.is_empty() {
                row.remove("actions");
            } else {
                row.insert("actions".into(), Value::Object(next));
            }
            deltas.push(json!({"op": "row.upserted", "row": row.clone()}));
        }
        out.extend(deltas);
    }

    fn turn_header_state(&self, turn: &str) -> Option<String> {
        self.rows
            .iter()
            .find(|row| row["kind"] == "turnHeader" && row["turnId"].as_str() == Some(turn))
            .and_then(|row| row["state"].as_str().map(str::to_owned))
    }
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;

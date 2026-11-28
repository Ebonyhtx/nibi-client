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
        // 流式运行且当前本无动作时直接 O(1) 返回，避免每步对整条时间线做二次扫描
        if busy && !self.has_any_actions {
            return;
        }
        let pending = !self.pending.is_empty();
        let mut updates: Vec<(usize, Map<String, Value>)> = Vec::new();
        let mut next_has_any_actions = false;
        {
            // 单遍预索引 turnHeader 状态、含真实用户输入的轮次与每轮末段 assistantText（O(N)）
            let mut turn_header_states: std::collections::HashMap<&str, &str> =
                std::collections::HashMap::new();
            let mut turns_with_real_user: std::collections::HashSet<&str> =
                std::collections::HashSet::new();
            let mut last_in_turn: std::collections::HashMap<&str, u64> =
                std::collections::HashMap::new();
            let mut latest_editable: Option<u64> = None;
            for row in &self.rows {
                let kind = row["kind"].as_str().unwrap_or_default();
                match kind {
                    "turnHeader" => {
                        if let (Some(turn), Some(state)) = (
                            row.get("turnId").and_then(Value::as_str),
                            row.get("state").and_then(Value::as_str),
                        ) {
                            turn_header_states.insert(turn, state);
                        }
                    }
                    "userInput" if row["origin"] == "realUser" => {
                        latest_editable = (!busy).then(|| row["rowId"].as_u64()).flatten();
                        if let Some(turn) = row.get("turnId").and_then(Value::as_str) {
                            turns_with_real_user.insert(turn);
                        }
                    }
                    "assistantText" => {
                        if let (Some(turn), Some(id)) = (
                            row.get("turnId").and_then(Value::as_str),
                            row.get("rowId").and_then(Value::as_u64),
                        ) {
                            last_in_turn.insert(turn, id);
                        }
                    }
                    _ => {}
                }
            }
            // 全时间线最后一条已落定、轮头不在 running 且同轮有真实输入的 assistantText
            let latest_assistant_id = if busy {
                None
            } else {
                self.rows
                    .iter()
                    .rev()
                    .find(|row| {
                        let turn = row["turnId"].as_str().unwrap_or_default();
                        row["kind"] == "assistantText"
                            && row["state"] == "complete"
                            && row
                                .get("assistantResponseId")
                                .and_then(Value::as_str)
                                .is_some_and(|id| !id.is_empty())
                            && turn_header_states.get(turn).copied() != Some("running")
                            && turns_with_real_user.contains(turn)
                    })
                    .and_then(|row| row["rowId"].as_u64())
            };
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
                        let can_rewind =
                            !busy && !pending && row["state"] != "running" && active_files;
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
                            && turn_header_states.get(turn).copied() == Some("completedSuccess");
                        if can_fork {
                            next.insert("canFork".into(), json!(true));
                        } else {
                            next.remove("canFork");
                        }
                    }
                }
                if !next.is_empty() {
                    next_has_any_actions = true;
                }
                let current = row.get("actions").and_then(Value::as_object);
                if current == Some(&next) || (current.is_none() && next.is_empty()) {
                    continue;
                }
                updates.push((index, next));
            }
        }
        self.has_any_actions = next_has_any_actions;
        let mut deltas = Vec::with_capacity(updates.len());
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
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;

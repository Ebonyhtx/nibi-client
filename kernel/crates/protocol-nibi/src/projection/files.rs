//! 轮头行的文件摘要（141 审计 §9 第 2 项余项）：live 的 `FileChanges`、只回退文件后的
//! `FilesRestored`，以及冷打开的每轮摘要。Node 的同一份口径在 `product-projection.ts`
//! （`onModelComplete` 的摘要、actions 里的 `canRewindFiles`）与 `cold-file-change-summaries.ts`。

use std::collections::HashSet;

use nibi_kernel_api::file_changes::TurnFileSummary;
use nibi_kernel_api::session_api::FileChange;
use serde_json::{Map, Value, json};

use super::{Projection, turn_key};

/// 一组改动的合计：不重复的「机器 + 路径」个数与增删行数。
fn totals(files: &[FileChange]) -> (u64, u64, u64) {
    let mut seen: HashSet<(Option<&str>, &str)> = HashSet::new();
    let mut additions = 0;
    let mut deletions = 0;
    for file in files {
        seen.insert((file.machine.as_deref(), file.path.as_str()));
        additions += file.additions;
        deletions += file.deletions;
    }
    (seen.len() as u64, additions, deletions)
}

fn summary(files: u64, additions: u64, deletions: u64) -> Value {
    json!({"additions": additions, "deletions": deletions, "files": files, "state": "active"})
}

/// 收口时把这一轮攒下的文件摘要挂到轮头（`finish_turn` 用）。
pub(super) fn finish_summary(
    row: &mut Map<String, Value>,
    files: u64,
    additions: u64,
    deletions: u64,
    rewindable: bool,
    can_rewind: bool,
) {
    if files == 0 {
        return;
    }
    row.insert("fileChanges".into(), summary(files, additions, deletions));
    if rewindable && can_rewind {
        set_can_rewind(row);
    }
}

impl Projection {
    /// 这一轮有文件写入落定：先攒在回合里，收口时一次挂到轮头。
    ///
    /// Node 的轮头摘要只在回合收口时给出（`ModelComplete` 且这一轮不再发起工具调用），
    /// 工具结果刚提交就画「N 个文件已更改」会让用户以为回合已经结束。`files` 按「机器 + 路径」
    /// 去重：同一个文件在一轮里写两次只算一个（Node 的摘要取文件数），增删行数照常累加。
    pub(super) fn file_changes(
        &mut self,
        turn: &str,
        files: &[FileChange],
        rewindable: bool,
        out: &mut Vec<Value>,
    ) {
        let (_, additions, deletions) = totals(files);
        if let Some(current) = self.turn.as_mut().filter(|current| current.id == turn) {
            for file in files {
                let key = (file.machine.clone(), file.path.clone());
                if !current.file_paths.contains(&key) {
                    current.file_paths.push(key);
                }
            }
            current.file_additions += additions;
            current.file_deletions += deletions;
            current.file_rewindable &= rewindable;
            return;
        }
        // 晚于收口（或不属于当前回合）的摘要：只有轮头还没有摘要时补一次，避免与收口那一次重复累加。
        let can_rewind = self.pending.is_empty();
        self.upsert(
            &turn_key(turn),
            |row| {
                if row.get("fileChanges").is_some() {
                    return;
                }
                let mut seen_now: HashSet<(Option<String>, String)> = HashSet::new();
                for file in files {
                    seen_now.insert((file.machine.clone(), file.path.clone()));
                }
                row.insert(
                    "fileChanges".into(),
                    summary(seen_now.len() as u64, additions, deletions),
                );
                // Host 的 actions 只在终态给出（Node 的 materialization 规则：running 时没有撤销入口）。
                let terminal = row["state"] != "running";
                if rewindable && can_rewind && terminal {
                    set_can_rewind(row);
                }
            },
            out,
        );
    }

    /// 这一轮的文件回退成功了：摘要标成 reverted，撤掉撤销入口。
    pub(super) fn files_restored(&mut self, turn: &str, out: &mut Vec<Value>) {
        self.upsert(
            &turn_key(turn),
            |row| {
                if let Some(Value::Object(changes)) = row.get_mut("fileChanges") {
                    changes.insert("state".into(), json!("reverted"));
                }
                clear_can_rewind(row);
            },
            out,
        );
    }

    /// 冷打开的每轮摘要：按 user 消息 id 找到它开的轮（冷投影的轮键就是消息 id），挂到轮头。
    ///
    /// 返回增量（由 `Live` 记进主题日志）。同一轮已有摘要时不重复覆盖——事件路径上的摘要比
    /// artifact 重算的更贴近最近一次提交。
    pub fn set_file_summaries(&mut self, summaries: &[TurnFileSummary]) -> Vec<Value> {
        let mut out = Vec::new();
        for entry in summaries {
            let Some(turn) = self
                .rows
                .iter()
                .find(|row| {
                    row["kind"] == "userInput"
                        && row["entityId"].as_str() == Some(entry.prompt.as_str())
                })
                .and_then(|row| row["turnId"].as_str().map(str::to_owned))
            else {
                continue;
            };
            let key = turn_key(&turn);
            let has_summary = self
                .index
                .get(&key)
                .is_some_and(|at| self.rows[*at].get("fileChanges").is_some());
            if has_summary {
                continue;
            }
            let open = self.pending.is_empty();
            let counts = (entry.files, entry.additions, entry.deletions);
            self.upsert(
                &key,
                |row| {
                    row.insert(
                        "fileChanges".into(),
                        summary(counts.0, counts.1, counts.2),
                    );
                    if open && row["state"] != "running" {
                        set_can_rewind(row);
                    }
                },
                &mut out,
            );
        }
        out
    }
}

/// 给轮头加上撤销入口（保留已有的 actions 键）。
pub(super) fn set_can_rewind(row: &mut Map<String, Value>) {
    let actions = row
        .entry("actions")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Value::Object(actions) = actions {
        actions.insert("canRewindFiles".into(), json!(true));
    }
}

fn clear_can_rewind(row: &mut Map<String, Value>) {
    let empty = match row.get_mut("actions") {
        Some(Value::Object(actions)) => {
            actions.remove("canRewindFiles");
            actions.is_empty()
        }
        _ => false,
    };
    if empty {
        row.remove("actions");
    }
}

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;

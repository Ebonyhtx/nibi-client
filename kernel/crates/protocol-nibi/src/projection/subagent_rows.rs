//! 子代理行：`KernelEvent::Subagent`（live）与持久化关联（cold）。
//!
//! UI 的右侧会话入口靠 `kind:"subagent"` 行与父 Agent 工具行配对（`turnId + parentToolCallId`）。
//! Node 投影一直有这条链（`product-projection.ts` 的 `onSubagentSpawned/Stopped`）；Rust 以前把
//! `KernelEvent::Subagent` 当 telemetry 忽略，桌面本地会话因此从来没有 subagent 行。

use std::collections::HashMap;

use nibi_kernel_api::agents::SubagentLink;
use nibi_kernel_api::message::{ContentBlock, Message, ToolResultContent};
use nibi_kernel_api::session_api::{KernelEvent, SessionView, SubagentPhase};
use serde_json::{Value, json};

use super::{Projection, tool_key};

/// 后台启动结果的固定前缀（`kernel/prompts/agents/launched.txt`）。冷投影没有事件阶段，
/// 只能靠它区分「已启动、还在跑」与「前台已收口」。
const LAUNCHED_PREFIX: &str = "Async agent launched successfully.";

fn subagent_key(agent: &str) -> String {
    format!("subagent:{agent}")
}

/// 内核生命周期状态 → 行的封闭枚举（与 Node `mapSubagentStatus` 同口径）。
fn map_status(status: &str) -> &'static str {
    match status {
        "completed" | "success" => "success",
        "killed" | "cancelled" | "stopped" => "cancelled",
        _ => "failed",
    }
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

impl Projection {
    /// live：Spawned / Done。只有本会话时间线里存在父 Agent 工具行时才建行——嵌套子代理的
    /// 调用不在这个会话的行里，不能凭空挂一个没有锚点的卡片。
    pub(super) fn subagent_event(
        &mut self,
        event: &KernelEvent,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let KernelEvent::Subagent {
            agent,
            child,
            parent_tool_use,
            agent_type,
            background,
            status,
            error,
            phase,
        } = event
        else {
            return;
        };
        let key = subagent_key(agent.as_str());
        let existing = self.index.get(&key).copied();
        let parent_at = self
            .index
            .get(&tool_key(parent_tool_use.as_str()))
            .copied();
        if existing.is_none() && parent_at.is_none() {
            return;
        }
        let spawned = matches!(phase, SubagentPhase::Spawned);
        if let Some(at) = existing {
            let before = self.rows[at].clone();
            let row = &mut self.rows[at];
            if spawned {
                row.insert("status".into(), json!("running"));
                row.remove("endedAt");
            } else {
                row.insert("status".into(), json!(map_status(status)));
                row.insert("endedAt".into(), json!(now));
                if let Some(error) = error {
                    row.insert("summaryText".into(), json!(error));
                }
            }
            row.entry("childSessionId".to_owned())
                .or_insert_with(|| json!(child.as_str()));
            if !row.contains_key("parentToolCallId") && parent_at.is_some() {
                row.insert("parentToolCallId".into(), json!(parent_tool_use.as_str()));
            }
            row.entry("subagentType".to_owned())
                .or_insert_with(|| json!(agent_type.as_str()));
            if *background {
                row.insert("backgrounded".into(), json!(true));
                row.insert("workId".into(), json!(agent.as_str()));
            }
            if *row != before {
                out.push(json!({"op": "row.upserted", "row": row.clone()}));
            }
            if !spawned && *background {
                // 后台 Agent 的父工具结果在启动时就落成 success；子代理终态必须由投影
                // 回写到 Agent 行，卡片才会显示失败/停止并带可 hover 的原始错误（BG26）。
                // 续跑事件带的是 SendMessage 调用；锚点始终是 subagent 行上的原 Agent 调用。
                let anchor = self.rows[at]["parentToolCallId"]
                    .as_str()
                    .unwrap_or(parent_tool_use.as_str())
                    .to_owned();
                self.mirror_background_parent(&anchor, status, error.as_deref(), out);
            }
            return;
        }
        let Some(parent_at) = parent_at else {
            return;
        };
        let (turn, description) = {
            let parent = &self.rows[parent_at];
            (
                parent["turnId"].as_str().unwrap_or_default().to_owned(),
                parent["input"]["description"]
                    .as_str()
                    .or_else(|| parent["input"]["prompt"].as_str())
                    .unwrap_or(agent_type.as_str())
                    .to_owned(),
            )
        };
        let mut row = self.base(&turn, agent.as_str(), "subagent", now, seq);
        row.insert("parentToolCallId".into(), json!(parent_tool_use.as_str()));
        row.insert("subagentType".into(), json!(agent_type.as_str()));
        row.insert(
            "status".into(),
            json!(if spawned { "running" } else { map_status(status) }),
        );
        row.insert("summaryText".into(), json!(description));
        row.insert("childSessionId".into(), json!(child.as_str()));
        if *background {
            row.insert("backgrounded".into(), json!(true));
            row.insert("workId".into(), json!(agent.as_str()));
        }
        row.insert("startedAt".into(), json!(now));
        if !spawned {
            row.insert("endedAt".into(), json!(now));
            if let Some(error) = error {
                row.insert("summaryText".into(), json!(error));
            }
        }
        let terminal_background = !spawned && *background;
        self.append(key, row, out);
        if terminal_background {
            self.mirror_background_parent(parent_tool_use.as_str(), status, error.as_deref(), out);
        }
    }

    /// 后台子代理终态回写父 Agent 工具行：failed → error + 原文，killed → cancelled。
    /// 成功不覆盖（启动 ACK 本身就是 success）；前台子代理的父行已有工具结果，不重复改。
    fn mirror_background_parent(
        &mut self,
        parent_tool_use: &str,
        status: &str,
        error: Option<&str>,
        out: &mut Vec<Value>,
    ) {
        let Some(parent_at) = self.index.get(&tool_key(parent_tool_use)).copied() else {
            return;
        };
        let before = self.rows[parent_at].clone();
        let row = &mut self.rows[parent_at];
        match map_status(status) {
            "failed" => {
                row.insert("status".into(), json!("error"));
                if let Some(error) = error {
                    // toolCallRowSchema 的 error 必须同时有 code 与 message；缺 code 会让
                    // 整行被判 unreadable，Agent 卡直接消失。
                    row.insert(
                        "error".into(),
                        json!({ "code": "subagent_failed", "message": error }),
                    );
                }
            }
            "cancelled" => {
                row.insert("status".into(), json!("cancelled"));
            }
            _ => {
                // 续跑后成功：把上一轮的失败/停止收回到 success，并清掉错误原文。
                if !matches!(row["status"].as_str(), Some("error" | "cancelled")) {
                    return;
                }
                row.insert("status".into(), json!("success"));
                row.remove("error");
            }
        }
        if *row != before {
            out.push(json!({"op": "row.upserted", "row": row.clone()}));
        }
    }

    /// cold：持久化的 `SubagentLinked`（tool part 的 `state.metadata`）补回 subagent 行。
    /// turnId 与标题从父 Agent 工具行取；终态优先取 `<task-notification>` 的 `<status>`，
    /// 没有通知时按工具结果（error / launched）如实落到 failed 或 running，其余视为前台完成。
    pub(crate) fn seed_subagent_rows(
        &mut self,
        view: &SessionView,
        links: &[SubagentLink],
        now: u64,
    ) {
        if links.is_empty() {
            return;
        }
        let (results, statuses, errors) = cold_facts(view);
        for link in links {
            let Some(parent_at) = self
                .index
                .get(&tool_key(link.tool_use.as_str()))
                .copied()
            else {
                continue;
            };
            let key = subagent_key(link.agent.as_str());
            if self.index.contains_key(&key) {
                continue;
            }
            let (turn, description, input_background) = {
                let parent = &self.rows[parent_at];
                (
                    parent["turnId"].as_str().unwrap_or_default().to_owned(),
                    parent["input"]["description"]
                        .as_str()
                        .or_else(|| parent["input"]["prompt"].as_str())
                        .unwrap_or(link.agent_type.as_str())
                        .to_owned(),
                    parent["input"]["run_in_background"].as_bool() == Some(true),
                )
            };
            let result = results.get(link.tool_use.as_str());
            let launched = result.is_some_and(|(_, text)| text.starts_with(LAUNCHED_PREFIX));
            let status = statuses
                .get(link.tool_use.as_str())
                .map_or_else(
                    || {
                        if result.is_some_and(|(is_error, _)| *is_error) {
                            "failed"
                        } else if launched {
                            "running"
                        } else {
                            "success"
                        }
                    },
                    |status| map_status(status),
                );
            let mut row = self.base(&turn, link.agent.as_str(), "subagent", now, 0);
            row.insert("parentToolCallId".into(), json!(link.tool_use.as_str()));
            row.insert("subagentType".into(), json!(link.agent_type.as_str()));
            row.insert("status".into(), json!(status));
            row.insert("summaryText".into(), json!(description));
            row.insert("childSessionId".into(), json!(link.child.as_str()));
            if launched || input_background {
                row.insert("backgrounded".into(), json!(true));
                row.insert("workId".into(), json!(link.agent.as_str()));
            }
            // 冷恢复同样把后台子代理终态回写到父 Agent 行（BG26 的 restored 阶段）。
            if (launched || input_background) && matches!(status, "failed" | "cancelled") {
                let parent = &mut self.rows[parent_at];
                if status == "failed" {
                    parent.insert("status".into(), json!("error"));
                    if let Some(error) = errors.get(link.tool_use.as_str()) {
                        parent.insert(
                            "error".into(),
                            json!({ "code": "subagent_failed", "message": error }),
                        );
                    }
                } else {
                    parent.insert("status".into(), json!("cancelled"));
                }
            }
            row.insert("startedAt".into(), json!(now));
            // 紧跟在触发它的 Agent 工具行后面：配对与工作分段都依赖行序。
            self.insert_after(&tool_key(link.tool_use.as_str()), key, row);
        }
    }
}

/// 冷投影能拿到的三类事实：每个 tool result 的文本/错误位、task notification 的终态，
/// 以及失败通知里的 provider 原文（`<error>`）。
fn cold_facts(
    view: &SessionView,
) -> (
    HashMap<String, (bool, String)>,
    HashMap<String, String>,
    HashMap<String, String>,
) {
    let mut results = HashMap::new();
    let mut statuses = HashMap::new();
    let mut errors = HashMap::new();
    for message in &view.messages {
        let Message::User(user) = message else {
            continue;
        };
        for block in &user.content {
            match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    let text = content
                        .iter()
                        .filter_map(|part| match part {
                            ToolResultContent::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    results.insert(tool_use_id.as_str().to_owned(), (*is_error, text));
                }
                ContentBlock::Text { text } => {
                    let Some(id) = between(text, "<tool-use-id>", "</tool-use-id>") else {
                        continue;
                    };
                    if id.is_empty() {
                        continue;
                    }
                    if let Some(status) = between(text, "<status>", "</status>") {
                        statuses
                            .entry(id.to_owned())
                            .or_insert_with(|| status.to_owned());
                    }
                    if let Some(error) = between(text, "<error>", "</error>") {
                        errors
                            .entry(id.to_owned())
                            .or_insert_with(|| error.to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    (results, statuses, errors)
}

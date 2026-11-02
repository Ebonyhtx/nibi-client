//! 旧协议（`session/read|create|resume|messages|compact|goal|set*`）共用的快照投影。
//!
//! 形状对齐 `zcodeSessionStateSnapshotSchema`（packages/shared/src/nibi-protocol）：Host 会按严格
//! schema 解析，缺字段不是“少显示一点”，而是整个响应被拒。内核的会话视图没有逐条消息的时间戳与
//! 成本，这里用会话创建时间与 0 成本如实占位；消息顺序由数组保证，不靠时间戳排序。
//!
//! `Profile::Index` 只出正文（`session/read` 的 task-index 同步，去掉工具/思考大载荷）；
//! `Profile::Full` 出正文、思考、工具调用与结果（`session/messages` 与其它快照）。

use std::collections::HashMap;

use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, ImageSource, Message, ToolResultContent, Usage, UserMessage,
    UserOrigin,
};
use rust_cli_kernel_api::session_api::SessionView;
use rust_cli_kernel_api::store::SessionKind;
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Profile {
    Full,
    Index,
}

/// 消息的 `info` 形状（user/assistant 的判别字段不同）。
fn user_info(session: &str, message: &UserMessage, at: u64) -> Value {
    json!({
        "messageId": message.id.as_str(),
        "sessionId": session,
        "role": "user",
        "time": {"created": at},
        "agent": "main",
    })
}

fn assistant_info(
    session: &str,
    message: &AssistantMessage,
    view: &SessionView,
    parent: &str,
    at: u64,
) -> Value {
    let root = view.meta.workspace.root.as_str();
    json!({
        "messageId": message.id.as_str(),
        "sessionId": session,
        "role": "assistant",
        "time": {"created": at, "completed": at},
        "parentMessageId": parent,
        "agent": "main",
        "model": model_value(&view.selection),
        "path": {"cwd": root, "root": root},
        "cost": 0,
        "tokens": tokens_value(message.usage),
    })
}

fn model_value(selection: &rust_cli_kernel_api::model::ModelSelection) -> Value {
    let mut value = json!({
        "providerId": &selection.provider,
        "modelId": &selection.model,
    });
    if let Some(level) = &selection.reasoning {
        value["options"] = json!({"reasoningLevel": level});
    }
    value
}

fn tokens_value(usage: Option<Usage>) -> Value {
    let usage = usage.unwrap_or_default();
    json!({
        "input": usage.input_tokens,
        "output": usage.output_tokens,
        "reasoning": 0,
        "cache": {
            "read": usage.cache_read_input_tokens,
            "write": usage.cache_creation_input_tokens,
        },
    })
}

fn part_id(message: &str, index: usize, kind: &str) -> String {
    format!("{message}:{kind}:{index}")
}

fn text_part(session: &str, message: &str, index: usize, text: &str) -> Value {
    json!({
        "partId": part_id(message, index, "part"),
        "sessionId": session,
        "messageId": message,
        "type": "text",
        "text": text,
    })
}

fn reasoning_part(session: &str, message: &str, index: usize, text: &str) -> Value {
    json!({
        "partId": part_id(message, index, "reasoning"),
        "sessionId": session,
        "messageId": message,
        "type": "reasoning",
        "text": text,
    })
}

fn object_input(input: &Value) -> Value {
    if input.is_object() {
        input.clone()
    } else {
        json!({"value": input})
    }
}

fn tool_part(
    session: &str,
    message: &str,
    index: usize,
    call: &str,
    name: &str,
    input: &Value,
) -> Value {
    let input = object_input(input);
    let raw = json!({"tool": name, "input": input}).to_string();
    json!({
        "partId": part_id(message, index, "tool"),
        "sessionId": session,
        "messageId": message,
        "type": "tool",
        "callId": call,
        "tool": name,
        "state": {"status": "pending", "input": input, "raw": raw},
    })
}

fn file_part(session: &str, message: &str, index: usize, source: &ImageSource) -> Option<Value> {
    let ImageSource::Base64 { media_type, data } = source else {
        // Artifact 引用要经 Host 的 artifact 路由才可读；旧协议没有这条路由，宁可不显示。
        return None;
    };
    Some(json!({
        "partId": part_id(message, index, "file"),
        "sessionId": session,
        "messageId": message,
        "type": "file",
        "mime": media_type,
        "url": format!("data:{media_type};base64,{data}"),
    }))
}

/// 一条消息里的内容块 → 旧协议 part。工具结果单独在第 2 遍结算，不在这里出 part。
fn parts(session: &str, message: &str, content: &[ContentBlock], profile: Profile) -> Vec<Value> {
    let mut parts = Vec::new();
    for (index, block) in content.iter().enumerate() {
        match block {
            ContentBlock::Text { text } if !text.is_empty() => {
                parts.push(text_part(session, message, index, text));
            }
            ContentBlock::Thinking { thinking, .. }
                if profile == Profile::Full && !thinking.is_empty() =>
            {
                parts.push(reasoning_part(session, message, index, thinking));
            }
            ContentBlock::ToolUse { id, name, input } if profile == Profile::Full => {
                parts.push(tool_part(session, message, index, id.as_str(), name, input));
            }
            ContentBlock::Image { source } if profile == Profile::Full => {
                if let Some(part) = file_part(session, message, index, source) {
                    parts.push(part);
                }
            }
            _ => {}
        }
    }
    parts
}

fn tool_result_text(content: &[ToolResultContent]) -> String {
    content
        .iter()
        .map(|block| match block {
            ToolResultContent::Text { text } => text.as_str(),
            ToolResultContent::Image { .. } => "[image]",
            ToolResultContent::Document { .. } => "[document]",
            ToolResultContent::ToolReference { tool_name } => tool_name.as_str(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 同一会话里的工具调用位置：assistant 消息下标 → part 下标。结果到达时就地改成 completed/error。
struct ToolSlot {
    message: usize,
    part: usize,
    input: Value,
    name: String,
}

pub(crate) fn messages(view: &SessionView, profile: Profile) -> Vec<Value> {
    let session = view.meta.id.as_str();
    let at = view.meta.created_at_ms;
    let mut out: Vec<Value> = Vec::new();
    let mut last_user: Option<String> = None;
    let mut calls: HashMap<String, ToolSlot> = HashMap::new();

    for message in &view.messages {
        match message {
            Message::User(user) if user.origin == UserOrigin::Human => {
                let id = user.id.as_str().to_owned();
                last_user = Some(id.clone());
                let parts = parts(session, &id, &user.content, profile);
                out.push(json!({"info": user_info(session, user, at), "parts": parts}));
            }
            Message::User(user) if matches!(&user.origin, UserOrigin::ToolResult { .. }) => {
                if profile != Profile::Full {
                    continue;
                }
                for block in &user.content {
                    let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } = block
                    else {
                        continue;
                    };
                    let Some(slot) = calls.get(tool_use_id.as_str()) else {
                        continue;
                    };
                    let output = tool_result_text(content);
                    let state = if *is_error {
                        json!({"status": "error", "input": slot.input, "error": output,
                            "metadata": {}, "startedAt": at, "completedAt": at})
                    } else {
                        json!({"status": "completed", "input": slot.input, "output": output,
                            "title": slot.name, "metadata": {}, "startedAt": at, "completedAt": at})
                    };
                    out[slot.message]["parts"][slot.part]["state"] = state;
                }
            }
            Message::Assistant(assistant) => {
                let id = assistant.id.as_str().to_owned();
                let parent = last_user.clone().unwrap_or_else(|| id.clone());
                let parts_value = parts(session, &id, &assistant.content, profile);
                let message_index = out.len();
                for block in &assistant.content {
                    let ContentBlock::ToolUse { id, name, input } = block else {
                        continue;
                    };
                    // `parts()` 会跳过空文字等块，part 下标不能直接用块下标；按 callId 回查。
                    let Some(part) = parts_value
                        .iter()
                        .position(|part| part["type"] == "tool" && part["callId"] == id.as_str())
                    else {
                        continue;
                    };
                    calls.insert(
                        id.as_str().to_owned(),
                        ToolSlot {
                            message: message_index,
                            part,
                            input: object_input(input),
                            name: name.clone(),
                        },
                    );
                }
                out.push(json!({
                    "info": assistant_info(session, assistant, view, &parent, at),
                    "parts": parts_value,
                }));
            }
            _ => {}
        }
    }
    out
}

fn mode_name(view: &SessionView) -> String {
    if view.plan {
        "plan".to_owned()
    } else {
        view.mode.node_name().to_owned()
    }
}

fn session_kind(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Interactive => "interactive",
        SessionKind::Fork => "fork",
        SessionKind::Subagent => "subagent_child",
    }
}

pub(crate) fn snapshot(view: &SessionView, profile: Profile) -> Value {
    let session = view.meta.id.as_str();
    let workspace = view.meta.workspace.root.as_str();
    let at = view.meta.created_at_ms;
    let running = view.running;
    let status = if running { "running" } else { "idle" };
    let mode = mode_name(view);
    let messages = messages(view, profile);
    let turn_count = messages
        .iter()
        .filter(|message| message["info"]["role"] == "user")
        .count();
    let (used, size) = view
        .context_usage
        .as_ref()
        .map_or((0, 0), |usage| (usage.used_tokens, usage.max_tokens));
    let pending: Vec<Value> = view
        .pending
        .iter()
        .map(|(id, _)| json!(id.as_str()))
        .collect();

    let mut thought_level = json!({
        "enabled": view.selection.reasoning.is_some(),
        "available": [],
    });
    if let Some(level) = &view.selection.reasoning {
        thought_level["current"] = json!(level);
    }

    json!({
        "protocol": {"name": "ZCode Protocol", "version": 1},
        "session": {
            "createdAt": at,
            "mode": mode,
            "model": model_value(&view.selection),
            "traceId": view.meta.trace.as_str(),
            "sessionId": session,
            "sessionKind": session_kind(view.meta.kind),
            "status": status,
            "target": null,
            "title": &view.meta.title,
            "updatedAt": at,
            "workspace": {"workspacePath": workspace, "workspaceKey": workspace},
        },
        "settings": {
            "mode": {"current": mode},
            "model": {"available": [], "current": model_value(&view.selection)},
            "permission": {"mode": mode},
            "thoughtLevel": thought_level,
        },
        "projection": {
            "activeToolCalls": [],
            "backgroundJobs": [],
            "contextUsed": used,
            "contextWindow": size,
            "mode": mode,
            "pendingPermissions": [],
            "sessionId": session,
            "status": status,
            "target": null,
            "totalTokenCount": used,
            "turnCount": turn_count,
        },
        "runtime": {
            "eventSeq": view.last_seq,
            "pendingRequestIds": pending,
            "goalVerifications": [],
            "goalVerificationTimeline": [],
            "stateRevision": view.revision,
        },
        "messages": messages,
        "slashCommands": [],
        "todos": [],
        "todoGroups": [],
    })
}

#[cfg(test)]
#[path = "legacy_snapshot_tests.rs"]
mod tests;

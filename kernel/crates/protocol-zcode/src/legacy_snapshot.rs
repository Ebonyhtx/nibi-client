//! 旧协议（`session/read|create|resume|messages|compact|goal|set*`）共用的快照投影。
//!
//! 形状对齐 `zcodeSessionStateSnapshotSchema`（packages/shared/src/nibi-protocol）：Host 会按严格
//! schema 解析，缺字段不是“少显示一点”，而是整个响应被拒。逐条消息时间由
//! [`Kernel::session_message_times`](rust_cli_kernel_api::session_api::Kernel::session_message_times)
//! 从存储注入（node-store 的 `time_created/time_updated`），取不到时回退到会话创建时间；成本 UI
//! 不显示，仍为 0。消息顺序同时由数组保证，不单靠时间戳排序。
//!
//! `Profile::Index` 只出正文（`session/read` 的 task-index 同步，去掉工具/思考大载荷）；
//! `Profile::Full` 出正文、思考、工具调用与结果（`session/messages` 与其它快照）。
//!
//! 历史里的图片与 PDF 有两种落法：内联 base64（`ImageSource::Base64`，直接写进 part 的 `url`），
//! 或 artifact 引用（`ImageSource::Artifact`，Node 把大图外置成 `zcode-artifact://`）。旧协议没有
//! artifact 路由，所以引用要先由调用方经 [`resolve_media`] 读回内容、拼成 data URL 再进快照——
//! 否则历史图片在桌面里是空白（141 审计 §9 F5 的剩余项）。

use std::collections::HashMap;
use std::sync::Arc;

use rust_cli_kernel_api::attachment::AttachmentSource;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, ImageSource, Message, ToolResultContent, Usage, UserMessage,
    UserOrigin,
};
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::session_api::{Kernel, SessionView};
use rust_cli_kernel_api::store::{MessageTime, SessionKind};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Profile {
    Full,
    Index,
}

pub(crate) type Times = HashMap<MessageId, MessageTime>;

/// artifact 引用 → 已读回的 data URL（`resolve_media` 的产物）。
pub(crate) type Media = HashMap<String, String>;

/// 把历史里所有 artifact 引用的图片与 PDF 读回成 data URL。
///
/// 只读 `Profile::Full` 会用的那几类块；读不出的引用**不进**表（快照里照旧不显示，与以前一致），
/// 一个坏引用不该让整份快照失败。上限由 `Kernel::read_attachment` 自己管。
pub(crate) async fn resolve_media(
    kernel: &Arc<dyn Kernel>,
    session: &SessionId,
    workspace: &WorkspaceRef,
    view: &SessionView,
) -> Media {
    let mut media = Media::new();
    let mut blocks: Vec<&ContentBlock> = Vec::new();
    // attachment 消息的块是借不出来的（`blocks()` 现算），先收进一个自有缓冲。
    let attached: Vec<ContentBlock> = view
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::Attachment(attachment) => Some(attachment.blocks()),
            _ => None,
        })
        .flatten()
        .collect();
    for message in &view.messages {
        match message {
            Message::User(user) => blocks.extend(user.content.iter()),
            Message::Assistant(assistant) => blocks.extend(assistant.content.iter()),
            Message::System(_) | Message::Attachment(_) => {}
        }
    }
    blocks.extend(attached.iter());
    for block in blocks {
        let (ContentBlock::Image { source } | ContentBlock::Document { source, .. }) = block else {
            continue;
        };
        let ImageSource::Artifact {
            media_type: declared,
            artifact,
        } = source
        else {
            continue;
        };
        let uri = artifact_uri(artifact);
        if media.contains_key(&uri) {
            continue;
        }
        // 读不出的引用不进表：快照里照旧不显示，一个坏引用不该让整份快照失败。
        let Ok(payload) = kernel
            .read_attachment(
                session,
                workspace,
                AttachmentSource::Artifact { uri: uri.clone() },
                declared,
            )
            .await
        else {
            continue;
        };
        let media_type = payload
            .media_type
            .split(';')
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| declared.clone());
        use base64::Engine;
        media.insert(
            uri,
            format!(
                "data:{media_type};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&payload.bytes)
            ),
        );
    }
    media
}

/// `zcode-artifact://<会话>/<artifact>`（与内核 `ArtifactRef` 的写侧同形）。
fn artifact_uri(artifact: &rust_cli_kernel_api::store::ArtifactRef) -> String {
    format!(
        "{}{}/{}",
        rust_cli_kernel_api::persisted_output::ARTIFACT_SCHEME,
        encode_component(artifact.session.as_str()),
        encode_component(artifact.id.as_str())
    )
}

fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
        {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn time_of(times: &Times, id: &MessageId, fallback: u64) -> MessageTime {
    times.get(id).copied().unwrap_or(MessageTime {
        created_at_ms: fallback,
        updated_at_ms: None,
    })
}

/// 消息的 `info` 形状（user/assistant 的判别字段不同）。
fn user_info(session: &str, message: &UserMessage, time: MessageTime) -> Value {
    json!({
        "messageId": message.id.as_str(),
        "sessionId": session,
        "role": "user",
        "time": {"created": time.created_at_ms},
        "agent": "main",
    })
}

fn assistant_info(
    session: &str,
    message: &AssistantMessage,
    view: &SessionView,
    parent: &str,
    time: MessageTime,
) -> Value {
    let root = view.meta.workspace.root.as_str();
    let mut info = json!({
        "messageId": message.id.as_str(),
        "sessionId": session,
        "role": "assistant",
        "time": {"created": time.created_at_ms},
        "parentMessageId": parent,
        "agent": "main",
        "model": model_value(&view.selection),
        "path": {"cwd": root, "root": root},
        "cost": 0,
        "tokens": tokens_value(message.usage),
    });
    if let Some(completed) = time.updated_at_ms.filter(|updated| *updated >= time.created_at_ms) {
        info["time"]["completed"] = json!(completed);
    }
    info
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

fn file_part(
    session: &str,
    message: &str,
    index: usize,
    source: &ImageSource,
    name: Option<&str>,
    media: &Media,
) -> Option<Value> {
    // 内联的直接拼 data URL；artifact 引用取 `resolve_media` 读回的那一份（读不出时不显示）。
    let (media_type, url) = match source {
        ImageSource::Base64 { media_type, data } => {
            (media_type.clone(), format!("data:{media_type};base64,{data}"))
        }
        ImageSource::Artifact { media_type, artifact } => {
            (media_type.clone(), media.get(&artifact_uri(artifact))?.clone())
        }
    };
    let mut part = json!({
        "partId": part_id(message, index, "file"),
        "sessionId": session,
        "messageId": message,
        "type": "file",
        "mime": media_type,
        "url": url,
    });
    if let Some(name) = name {
        part["filename"] = json!(name);
    }
    Some(part)
}

/// 一条消息里的内容块 → 旧协议 part。工具结果单独在第 2 遍结算，不在这里出 part。
fn parts(
    session: &str,
    message: &str,
    content: &[ContentBlock],
    profile: Profile,
    media: &Media,
) -> Vec<Value> {
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
                if let Some(part) = file_part(session, message, index, source, None, media) {
                    parts.push(part);
                }
            }
            // 用户贴的 PDF：旧协议同样用 `file` part（Host 的 `filePartToContentBlock` 认 `application/pdf`）。
            ContentBlock::Document { source, name } if profile == Profile::Full => {
                if let Some(part) =
                    file_part(session, message, index, source, name.as_deref(), media)
                {
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
    started_at: u64,
}

pub(crate) fn messages(
    view: &SessionView,
    profile: Profile,
    times: &Times,
    media: &Media,
) -> Vec<Value> {
    let session = view.meta.id.as_str();
    let at = view.meta.created_at_ms;
    let mut out: Vec<Value> = Vec::new();
    let mut last_user: Option<String> = None;
    let mut calls: HashMap<String, ToolSlot> = HashMap::new();

    for message in &view.messages {
        let time = time_of(times, message.id(), at);
        match message {
            Message::User(user) if user.origin == UserOrigin::Human => {
                let id = user.id.as_str().to_owned();
                last_user = Some(id.clone());
                let parts = parts(session, &id, &user.content, profile, media);
                out.push(json!({"info": user_info(session, user, time), "parts": parts}));
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
                    let completed_at = time.created_at_ms;
                    let state = if *is_error {
                        json!({"status": "error", "input": slot.input, "error": output,
                            "metadata": {}, "startedAt": slot.started_at, "completedAt": completed_at})
                    } else {
                        json!({"status": "completed", "input": slot.input, "output": output,
                            "title": slot.name, "metadata": {}, "startedAt": slot.started_at,
                            "completedAt": completed_at})
                    };
                    out[slot.message]["parts"][slot.part]["state"] = state;
                }
            }
            Message::Assistant(assistant) => {
                let id = assistant.id.as_str().to_owned();
                let parent = last_user.clone().unwrap_or_else(|| id.clone());
                let parts_value = parts(session, &id, &assistant.content, profile, media);
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
                            started_at: time.created_at_ms,
                        },
                    );
                }
                out.push(json!({
                    "info": assistant_info(session, assistant, view, &parent, time),
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

pub(crate) fn snapshot(
    view: &SessionView,
    profile: Profile,
    times: &Times,
    media: &Media,
) -> Value {
    let session = view.meta.id.as_str();
    let workspace = view.meta.workspace.root.as_str();
    let at = view.meta.created_at_ms;
    let running = view.running;
    let status = if running { "running" } else { "idle" };
    let mode = mode_name(view);
    let messages = messages(view, profile, times, media);
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

    let mut snapshot = json!({
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
    });
    if let Some(parent) = &view.meta.parent {
        snapshot["session"]["parentSessionId"] = json!(parent.as_str());
    }
    snapshot
}

#[cfg(test)]
#[path = "legacy_snapshot_tests.rs"]
mod tests;

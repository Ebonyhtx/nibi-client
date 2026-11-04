//! 行的增量（[`Projection`] 的一部分，从 mod.rs 拆出：800 行上限）：流式正文与思考、落定的消息、工具调用行与权限询问。

use rust_cli_kernel_api::message::{
    CompactBoundary, CompactTrigger, ContentBlock, Message, SystemMessage, UserOrigin,
};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::session_api::TurnOutcome;
use rust_cli_kernel_api::user_input::INTERRUPT_TEXTS;
use serde_json::{Value, json};

use super::{Projection, block_key, state, text_of, tool_key};

impl Projection {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn stream(
        &mut self,
        turn: &str,
        response: u32,
        index: usize,
        delta: &BlockDelta,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let (kind, text) = match delta {
            BlockDelta::Text(text) => ("assistantText", text),
            BlockDelta::Thinking(text) => ("reasoning", text),
            BlockDelta::Signature(_) | BlockDelta::InputJson(_) => return,
        };
        if let Some(current) = &mut self.turn {
            current.response = Some(response);
        }
        let key = block_key(kind, turn, response, index);
        if !self.index.contains_key(&key) {
            let entity = format!("{turn}:{response}:{index}");
            let mut row = self.base(turn, &entity, kind, now, seq);
            row.insert("text".into(), json!(""));
            row.insert("state".into(), json!("streaming"));
            self.append(key.clone(), row, out);
        }
        let Some(&at) = self.index.get(&key) else {
            return;
        };
        let row = &mut self.rows[at];
        let joined = format!("{}{text}", row["text"].as_str().unwrap_or_default());
        row.insert("text".into(), json!(joined));
        let row_id = row["rowId"].clone();
        out.push(json!({"op": "row.delta", "rowId": row_id, "path": "text", "append": text}));
    }

    pub(super) fn message(&mut self, message: &Message, now: u64, seq: u64, out: &mut Vec<Value>) {
        match message {
            // 压缩边界落定：把 running 分隔线改成 success（冷打开时由 cold::rows 补建）。
            Message::System(SystemMessage::CompactBoundary(boundary)) => {
                self.compact_boundary(boundary, now, seq, out);
            }
            // 用户中断后补的那条消息只给模型看（Node 不显示）。
            Message::User(user)
                if user.origin == UserOrigin::Human
                    && !INTERRUPT_TEXTS.contains(&text_of(&user.content).as_str()) =>
            {
                let Some(turn) = self.turn.clone() else {
                    return;
                };
                let key = format!("user:{}", user.id.as_str());
                if self.index.contains_key(&key) {
                    return;
                }
                let mut row = self.base(&turn.id, user.id.as_str(), "userInput", now, seq);
                row.insert("text".into(), json!(text_of(&user.content)));
                // 中枢启动/设置轮的输入行：与轮头同用 workflowLaunch origin（UI 据此画启动卡而非
                // 用户气泡，Node mapUserInputOrigin），元数据原样上行；普通输入还是 realUser。
                if let Some(launch) = &turn.launch {
                    row.insert("origin".into(), json!("workflowLaunch"));
                    row.insert("workflowLaunch".into(), launch.clone());
                } else {
                    row.insert("origin".into(), json!("realUser"));
                }
                if let Some(command) = &turn.command {
                    row.insert("sourceCommandId".into(), json!(command));
                    row.insert("rootSourceCommandId".into(), json!(command));
                    if let Some(meta) = self.inputs.get(command) {
                        if let Some(origin) = &meta.origin {
                            row.insert("inputOrigin".into(), json!(origin));
                        }
                        row.insert("clientId".into(), json!(meta.client));
                        // 附件引用原样上行：UI 的预览入口靠它（Node 的 userInput.attachments）。
                        if let Some(attachments) = &meta.attachments {
                            row.insert("attachments".into(), attachments.clone());
                        }
                    }
                }
                self.append(key, row, out);
            }
            Message::Assistant(assistant) => {
                let Some(turn) = self.turn.clone() else {
                    return;
                };
                let response = turn.response.unwrap_or(u32::MAX);
                for (index, block) in assistant.content.iter().enumerate() {
                    match block {
                        ContentBlock::Text { text } => {
                            self.settle_block(
                                "assistantText",
                                &turn.id,
                                response,
                                index,
                                text,
                                assistant,
                                now,
                                seq,
                                out,
                            );
                        }
                        ContentBlock::Thinking { thinking, .. } => {
                            self.settle_block(
                                "reasoning",
                                &turn.id,
                                response,
                                index,
                                thinking,
                                assistant,
                                now,
                                seq,
                                out,
                            );
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            if !self.index.contains_key(&tool_key(id.as_str())) {
                                self.tool_row(id.as_str(), name, input, now, seq, out);
                            }
                            let message_id = assistant.id.as_str().to_owned();
                            self.upsert(
                                &tool_key(id.as_str()),
                                |row| {
                                    row.insert("assistantResponseId".into(), json!(message_id));
                                },
                                out,
                            );
                        }
                        _ => {}
                    }
                }
                if let Some(current) = &mut self.turn {
                    current.response = None;
                }
            }
            _ => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn settle_block(
        &mut self,
        kind: &str,
        turn: &str,
        response: u32,
        index: usize,
        text: &str,
        assistant: &rust_cli_kernel_api::message::AssistantMessage,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        if text.is_empty() {
            return;
        }
        let key = block_key(kind, turn, response, index);
        if !self.index.contains_key(&key) {
            let mut row = self.base(
                turn,
                &format!("{}:{index}", assistant.id.as_str()),
                kind,
                now,
                seq,
            );
            row.insert("text".into(), json!(text));
            row.insert("state".into(), json!("streaming"));
            self.append(key.clone(), row, out);
        }
        let (message_id, model) = (assistant.id.as_str().to_owned(), assistant.model.clone());
        let assistant_text = kind == "assistantText";
        let feedback = self.feedback.get(&message_id).cloned();
        self.upsert(
            &key,
            |row| {
                row.insert("text".into(), json!(text));
                row.insert("state".into(), json!("complete"));
                row.insert("assistantResponseId".into(), json!(message_id));
                if assistant_text {
                    row.insert("model".into(), json!(model));
                    // 已经点过赞/踩的回复（NIBI setAssistantFeedback）落定时带上。
                    if let Some(feedback) = &feedback {
                        row.insert("feedback".into(), json!(feedback));
                    }
                }
            },
            out,
        );
    }

    pub(super) fn tool_row(
        &mut self,
        tool_use: &str,
        name: &str,
        input: &Value,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let turn = self
            .turn
            .as_ref()
            .map_or_else(|| self.session.clone(), |turn| turn.id.clone());
        let mut row = self.base(&turn, tool_use, "toolCall", now, seq);
        row.insert("toolCallId".into(), json!(tool_use));
        row.insert("toolName".into(), json!(name));
        row.insert("status".into(), json!("running"));
        row.insert("inputText".into(), json!(input.to_string()));
        row.insert("input".into(), input.clone());
        self.append(tool_key(tool_use), row, out);
    }

    /// 登记一个询问（只有权限询问进 pendingInteractions，P1）。返回它所属的工具调用。
    pub(super) fn ask(
        &mut self,
        interaction: &str,
        request: &InteractionRequest,
        now: u64,
    ) -> Option<String> {
        let InteractionRequest::Permission {
            tool_use,
            tool,
            input,
            message,
            ..
        } = request
        else {
            return None;
        };
        let anchor = self.row_id(&tool_key(tool_use.as_str()));
        self.pending.push(json!({
            "interactionId": interaction,
            "kind": "permission",
            "anchorRowId": anchor,
            "createdAt": now,
            "payload": {
                "kind": "permission",
                "toolCallId": tool_use.as_str(),
                "toolName": tool,
                "summary": message,
                "detail": input,
                "freeText": true,
                "fullAccessOption": state::full_access_option(),
                "options": state::permission_options(),
            },
        }));
        Some(tool_use.as_str().to_owned())
    }

    /// 压缩开始：`timelineMarker`（lane=assistantWork）先落 running；边界消息到后改 success。
    /// Node 的用户文案是「正在压缩上下文」/「上下文已压缩」。
    pub(super) fn compact_started(
        &mut self,
        trigger: CompactTrigger,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        if self.compact_marker.is_some() {
            return;
        }
        let turn = self
            .turn
            .as_ref()
            .map(|turn| turn.id.clone())
            .unwrap_or_else(|| "compact".to_owned());
        let key = "compact:running".to_owned();
        let mut row = self.base(&turn, "compact:running", "timelineMarker", now, seq);
        row.insert("lane".into(), json!("assistantWork"));
        row.insert(
            "marker".into(),
            json!({"type": "compact", "origin": compact_origin(trigger), "status": "running"}),
        );
        if let Some(command) = self.turn.as_ref().and_then(|turn| turn.command.clone()) {
            row.insert("sourceCommandId".into(), json!(command));
        }
        self.compact_marker = Some(key.clone());
        self.append(key, row, out);
    }

    /// 压缩边界落定：running 行改 success 并带上摘要引用与压缩前 token；冷打开没有 running 行时补一条。
    pub(super) fn compact_boundary(
        &mut self,
        boundary: &CompactBoundary,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let marker = json!({
            "type": "compact",
            "origin": compact_origin(boundary.trigger),
            "status": "success",
            "tokensBefore": boundary.pre_tokens,
            "summaryRef": boundary.summary.as_str(),
        });
        if let Some(key) = self.compact_marker.clone() {
            self.upsert(
                &key,
                |row| {
                    row.insert("marker".into(), marker);
                },
                out,
            );
            return;
        }
        let key = format!("compact:{}", boundary.id.as_str());
        if self.index.contains_key(&key) {
            return;
        }
        let turn = self
            .turn
            .as_ref()
            .map(|turn| turn.id.clone())
            .unwrap_or_else(|| boundary.id.as_str().to_owned());
        let mut row = self.base(&turn, boundary.id.as_str(), "timelineMarker", now, seq);
        row.insert("lane".into(), json!("assistantWork"));
        row.insert("marker".into(), marker);
        self.append(key, row, out);
    }

    /// `CompactDone`：成功终态已由边界消息写入，这里只结束跟踪。
    pub(super) fn compact_done(&mut self) {
        self.compact_marker = None;
    }

    /// 回合收尾：压缩没走到边界就失败/中断时把 running 行改终态，避免永远停在「正在压缩」。
    pub(super) fn compact_turn_finished(&mut self, outcome: &TurnOutcome, out: &mut Vec<Value>) {
        let Some(key) = self.compact_marker.take() else {
            return;
        };
        let status = match outcome {
            TurnOutcome::Success => return,
            TurnOutcome::Interrupted => "cancelled",
            TurnOutcome::Failed { .. } => "failed",
        };
        self.upsert(
            &key,
            |row| {
                if let Some(marker) = row.get_mut("marker").and_then(Value::as_object_mut) {
                    marker.insert("status".into(), json!(status));
                }
            },
            out,
        );
    }
}

fn compact_origin(trigger: CompactTrigger) -> &'static str {
    match trigger {
        CompactTrigger::Manual => "manual",
        CompactTrigger::Auto | CompactTrigger::Reactive => "auto",
    }
}

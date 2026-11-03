//! 会话事件 → `v4/telemetry/event` 事实（141 审计 §9 第 5 项余项）。
//!
//! 与 Node 的 `conversation-telemetry-facts.ts` 同源同向：从会话事件流派生埋点事实，只带 id、
//! 状态与白名单里的性能字段。内核事件流能如实产出的 8 个 kind 见
//! [`rust_cli_kernel_api::conversation_telemetry`]；`model.request.status` 与
//! `workflow.lifecycle` 没有采集点（模型端口没有 request/retry/stall 事件，run 进度不经过会话
//! 事件流），不产生事实。
//!
//! 有状态：首个流块的标记、工具开始的时刻、当前轮的命令归因、权限询问的工具关联、Agent 工具
//! 的后台标记。状态按会话（一个 `Live` 一份）保存，轮收口时清掉这一轮的部分。

use std::collections::{HashMap, HashSet};

use rust_cli_kernel_api::conversation_telemetry::{
    ConversationTelemetryFact, TelemetryFactBase,
};
use rust_cli_kernel_api::ids::InteractionId;
use rust_cli_kernel_api::message::CompactTrigger;
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::session_api::{
    KernelEvent, SequencedEvent, SubagentPhase, TurnExecutionKind, TurnInputSource, TurnOutcome,
};

/// 通知方法名（Host `V4_NOTIFICATIONS.conversationTelemetryFact`）。
pub const METHOD: &str = "v4/telemetry/event";

struct TurnTrace {
    turn: String,
    command: Option<String>,
    started_at_ms: u64,
    tool_calls: u64,
}

struct ToolTrace {
    name: String,
    started_at_ms: u64,
    /// Agent 工具开的后台子代理（`run_in_background`）；其余工具为 None。
    background: Option<bool>,
}

/// 一个会话的埋点派生器。
pub(crate) struct ConversationTelemetry {
    session: String,
    turn: Option<TurnTrace>,
    /// 已经发过 `firstChunk` 的流键（轮 + 响应 + 块下标 + 通道）。
    first_chunks: HashSet<String>,
    tools: HashMap<String, ToolTrace>,
    /// 进行中的权限询问：interaction → (tool_use, tool name)。
    permissions: HashMap<InteractionId, (String, String)>,
    compact: Option<(String, u64)>,
}

impl ConversationTelemetry {
    pub fn new(session: &str) -> Self {
        Self {
            session: session.to_owned(),
            turn: None,
            first_chunks: HashSet::new(),
            tools: HashMap::new(),
            permissions: HashMap::new(),
            compact: None,
        }
    }

    fn base(&self, event: &SequencedEvent, now: u64) -> TelemetryFactBase {
        let mut base = TelemetryFactBase::new(
            format!("{}:{}", self.session, event.seq),
            event.seq,
            now,
            self.session.clone(),
        );
        if let Some(turn) = &self.turn {
            base.turn_id = Some(turn.turn.clone());
            base.source_command_id = turn.command.clone();
        }
        base
    }

    /// 一条事件衍生的事实（0 或 1 条）。`now` 是会话时钟的墙钟。
    pub fn facts(&mut self, event: &SequencedEvent, now: u64) -> Option<ConversationTelemetryFact> {
        match &event.event {
            KernelEvent::TurnStarted {
                turn,
                command,
                execution_kind,
                input_source,
                ..
            } => {
                self.turn = Some(TurnTrace {
                    turn: turn.as_str().to_owned(),
                    command: command.as_ref().map(|c| c.as_str().to_owned()),
                    started_at_ms: now,
                    tool_calls: 0,
                });
                Some(ConversationTelemetryFact::TurnStarted {
                    base: self.base(event, now),
                    execution_kind: Some(
                        match execution_kind {
                            Some(TurnExecutionKind::ControlOnly) => "controlOnly",
                            _ => "agent",
                        }
                        .to_owned(),
                    ),
                    input_source: input_source.map(|source| {
                        match source {
                            TurnInputSource::BackgroundTask => "background_task",
                        }
                        .to_owned()
                    }),
                    background_source: None,
                    automation_id: None,
                    task_trigger: None,
                    scheduled_at: None,
                })
            }
            KernelEvent::StreamDelta {
                turn,
                response,
                index,
                delta,
            } => {
                let (channel, text) = match delta {
                    BlockDelta::Text(text) => ("text", text),
                    BlockDelta::Thinking(text) => ("thought", text),
                    BlockDelta::Signature(_) | BlockDelta::InputJson(_) => return None,
                };
                let first = self
                    .first_chunks
                    .insert(format!("{turn}:{response}:{index}:{channel}"));
                Some(ConversationTelemetryFact::StreamChunk {
                    base: self.base(event, now),
                    channel: channel.to_owned(),
                    chunk_length: text.chars().count() as u64,
                    first_chunk: first,
                    assistant_message_id: None,
                    part_id: Some(format!("{turn}:{response}:{index}")),
                    parent_tool_call_id: None,
                })
            }
            KernelEvent::ToolStarted {
                tool_use,
                name,
                input,
            } => {
                if let Some(turn) = &mut self.turn {
                    turn.tool_calls += 1;
                }
                let background = (name == "Agent")
                    .then(|| input.get("run_in_background").and_then(serde_json::Value::as_bool))
                    .flatten();
                self.tools.insert(
                    tool_use.as_str().to_owned(),
                    ToolTrace {
                        name: name.clone(),
                        started_at_ms: now,
                        background,
                    },
                );
                Some(ConversationTelemetryFact::ToolLifecycle {
                    base: self.base(event, now),
                    phase: "started".to_owned(),
                    tool_call_id: tool_use.as_str().to_owned(),
                    tool_name: Some(name.clone()),
                    duration_ms: None,
                    error_code: None,
                    error_message: None,
                    parent_tool_call_id: None,
                    child_tool_call_id: None,
                    agent_id: None,
                    agent_type: None,
                    child_session_id: None,
                    background,
                    skill_name: None,
                    skill_qualified_name: None,
                    skill_plugin_id: None,
                    plugin_id: None,
                    plugin_component: None,
                    skill_source: None,
                    performance: None,
                    automation_id: None,
                })
            }
            KernelEvent::ToolProgress { tool_use, .. } => {
                let trace = self.tools.get(tool_use.as_str());
                Some(ConversationTelemetryFact::ToolLifecycle {
                    base: self.base(event, now),
                    phase: "progress".to_owned(),
                    tool_call_id: tool_use.as_str().to_owned(),
                    tool_name: trace.map(|trace| trace.name.clone()),
                    duration_ms: trace.map(|trace| now.saturating_sub(trace.started_at_ms)),
                    error_code: None,
                    error_message: None,
                    parent_tool_call_id: None,
                    child_tool_call_id: None,
                    agent_id: None,
                    agent_type: None,
                    child_session_id: None,
                    background: trace.and_then(|trace| trace.background),
                    skill_name: None,
                    skill_qualified_name: None,
                    skill_plugin_id: None,
                    plugin_id: None,
                    plugin_component: None,
                    skill_source: None,
                    performance: None,
                    automation_id: None,
                })
            }
            KernelEvent::ToolDone { tool_use, output } => {
                let trace = self.tools.remove(tool_use.as_str());
                let error = output.is_error.then(|| tool_error_text(output));
                Some(ConversationTelemetryFact::ToolLifecycle {
                    base: self.base(event, now),
                    phase: if output.is_error { "failed" } else { "completed" }.to_owned(),
                    tool_call_id: tool_use.as_str().to_owned(),
                    tool_name: trace.as_ref().map(|trace| trace.name.clone()),
                    duration_ms: trace
                        .as_ref()
                        .map(|trace| now.saturating_sub(trace.started_at_ms)),
                    error_code: None,
                    error_message: error,
                    parent_tool_call_id: None,
                    child_tool_call_id: None,
                    agent_id: None,
                    agent_type: None,
                    child_session_id: None,
                    background: trace.as_ref().and_then(|trace| trace.background),
                    skill_name: None,
                    skill_qualified_name: None,
                    skill_plugin_id: None,
                    plugin_id: None,
                    plugin_component: None,
                    skill_source: None,
                    performance: None,
                    automation_id: None,
                })
            }
            KernelEvent::InteractionAsked {
                interaction,
                request:
                    InteractionRequest::Permission {
                        tool_use,
                        tool,
                        ..
                    },
            } => {
                self.permissions
                    .insert(interaction.clone(), (tool_use.as_str().to_owned(), tool.clone()));
                Some(ConversationTelemetryFact::PermissionLifecycle {
                    base: self.base(event, now),
                    phase: "requested".to_owned(),
                    request_id: Some(interaction.as_str().to_owned()),
                    tool_call_id: tool_use.as_str().to_owned(),
                    tool_name: Some(tool.clone()),
                    child_session_id: None,
                    background: None,
                    decision: None,
                })
            }
            KernelEvent::InteractionResolved { interaction } => {
                let (tool_call_id, tool_name) = self.permissions.remove(interaction)?;
                Some(ConversationTelemetryFact::PermissionLifecycle {
                    base: self.base(event, now),
                    phase: "resolved".to_owned(),
                    request_id: Some(interaction.as_str().to_owned()),
                    tool_call_id,
                    tool_name: Some(tool_name),
                    child_session_id: None,
                    background: None,
                    // 内核的事件不带裁决结果（只带「已结算」），如实缺席。
                    decision: None,
                })
            }
            KernelEvent::Subagent {
                agent,
                phase,
                child,
                parent_tool_use,
            } => {
                let background = self
                    .tools
                    .get(parent_tool_use.as_str())
                    .and_then(|trace| trace.background)
                    .unwrap_or(false);
                Some(ConversationTelemetryFact::SubagentLifecycle {
                    base: self.base(event, now),
                    phase: match phase {
                        SubagentPhase::Spawned => "spawned",
                        SubagentPhase::Done => "stopped",
                    }
                    .to_owned(),
                    agent_id: agent.as_str().to_owned(),
                    agent_type: None,
                    child_session_id: child.as_str().to_owned(),
                    parent_tool_call_id: Some(parent_tool_use.as_str().to_owned()),
                    background,
                    status: None,
                    error_message: None,
                })
            }
            KernelEvent::TurnFinished {
                outcome, usage, ..
            } => {
                let trace = self.turn.take();
                let base = {
                    let mut base = TelemetryFactBase::new(
                        format!("{}:{}", self.session, event.seq),
                        event.seq,
                        now,
                        self.session.clone(),
                    );
                    if let Some(trace) = &trace {
                        base.turn_id = Some(trace.turn.clone());
                        base.source_command_id = trace.command.clone();
                    }
                    base
                };
                let (status, result_type, error_code, error_message) = match outcome {
                    TurnOutcome::Success => ("success", Some("success"), None, None),
                    TurnOutcome::Interrupted => (
                        "interrupted",
                        Some("cancelled"),
                        Some("USER_INTERRUPT"),
                        Some("User stopped generation"),
                    ),
                    TurnOutcome::Failed { message } => ("failed", None, None, Some(message.as_str())),
                };
                let total_tokens = usage
                    .as_ref()
                    .map(|usage| usage.input_tokens.saturating_add(usage.output_tokens));
                Some(ConversationTelemetryFact::TurnTerminal {
                    base,
                    status: status.to_owned(),
                    result_type: result_type.map(str::to_owned),
                    duration_ms: trace
                        .as_ref()
                        .map(|trace| now.saturating_sub(trace.started_at_ms)),
                    token_count: total_tokens,
                    tool_call_count: trace.as_ref().map(|trace| trace.tool_calls),
                    error_code: error_code.map(str::to_owned),
                    error_message: error_message.map(str::to_owned),
                    error_retryable: None,
                    turn_phase: None,
                    background_subagent_result_consumed: None,
                    workflow_result_consumed: None,
                })
            }
            KernelEvent::CompactStarted { trigger } => {
                self.compact = Some((trigger_name(*trigger).to_owned(), now));
                None
            }
            KernelEvent::CompactDone { .. } => {
                let (trigger, started_at) = self.compact.take()?;
                Some(ConversationTelemetryFact::CompactionTerminal {
                    base: self.base(event, now),
                    // 内核没有压缩操作 id；用会话内唯一的 `<seq>` 做关联键（Host 只当键用）。
                    operation_id: format!("compact-{}", event.seq),
                    message_id: None,
                    summary_message_id: None,
                    status: "completed".to_owned(),
                    trigger,
                    compact_reason: None,
                    reason: None,
                    attempt: None,
                    max_attempts: None,
                    started_at: Some(started_at),
                    ended_at: Some(now),
                    pre_compact_token_count: None,
                    post_compact_token_count: None,
                    true_post_compact_token_count: None,
                    model_name: None,
                    model_provider: None,
                })
            }
            // 用量事实不在事件里单列：`TurnFinished.usage` 已带本轮合计，`turn.terminal`
            // 的 tokenCount 同源，避免同一份用量发两遍。
            _ => None,
        }
    }
}

fn trigger_name(trigger: CompactTrigger) -> &'static str {
    match trigger {
        CompactTrigger::Manual => "manual",
        CompactTrigger::Auto => "auto",
        CompactTrigger::Reactive => "reactive",
    }
}

/// 工具错误的文案（Host `errorMessage`，只给一句话，不带输入）。
fn tool_error_text(output: &rust_cli_kernel_api::tool::ToolOutput) -> String {
    output
        .content
        .iter()
        .find_map(|block| match block {
            rust_cli_kernel_api::message::ToolResultContent::Text { text } => {
                Some(text.trim().to_owned())
            }
            _ => None,
        })
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "conversation_telemetry_tests.rs"]
mod tests;

//! 会话事件 → `v4/telemetry/event` 事实（141 审计 §9 第 5 项）。
//!
//! 与 Node 的 `conversation-telemetry-facts.ts` 同源同向：从会话事件流派生埋点事实，只带 id、
//! 状态与白名单里的性能字段。10 个 kind 的契约形状见
//! [`nibi_kernel_api::conversation_telemetry`]；模型请求状态来自传输层的 `ModelRequestStatus`
//! 事件，工作流归属来自 DWF 引擎写进父会话的 `WorkflowLifecycle` 事件。
//!
//! 有状态：首个流块的标记、工具开始的时刻、当前轮的命令归因、权限询问的工具关联、Agent 工具
//! 的后台标记。状态按会话（一个 `Live` 一份）保存，轮收口时清掉这一轮的部分。

use std::collections::{HashMap, HashSet};

use nibi_kernel_api::conversation_telemetry::{
    ConversationTelemetryFact, TelemetryFactBase,
};
use nibi_kernel_api::ids::InteractionId;
use nibi_kernel_api::message::CompactTrigger;
use nibi_kernel_api::model::{BlockDelta, ModelRequestStatusKind};
use nibi_kernel_api::orchestration::InteractionRequest;
use nibi_kernel_api::session_api::{
    KernelEvent, SequencedEvent, SubagentPhase, TurnExecutionKind, TurnInputSource, TurnOutcome,
    WorkflowLifecyclePhase,
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
                agent_type,
                background,
                status,
                error,
            } => {
                // `background` / `agent_type` / `status` / `error` 都由信号带上来：续跑的子代理
                // 没有 `parent_tool_use`，以前从工具轨迹反查背景标记在那条路上永远得到 false。
                Some(ConversationTelemetryFact::SubagentLifecycle {
                    base: self.base(event, now),
                    phase: match phase {
                        SubagentPhase::Spawned => "spawned",
                        SubagentPhase::Done => "stopped",
                    }
                    .to_owned(),
                    agent_id: agent.as_str().to_owned(),
                    agent_type: Some(agent_type.clone()).filter(|value| !value.is_empty()),
                    child_session_id: child.as_str().to_owned(),
                    parent_tool_call_id: Some(parent_tool_use.as_str().to_owned()),
                    background: *background,
                    status: Some(status.clone()).filter(|value| !value.is_empty()),
                    // Node 只在 stopped 且失败时带原因（`SubagentStopped.payload.error`）。
                    error_message: error.clone().filter(|value| !value.is_empty()),
                })
            }
            KernelEvent::ModelRequestStatus { status } => {
                // 每支只带契约里该有的字段（Node 的映射同形：completed 只带 duration；
                // retry 带 delay/nextAttempt/reason/statusCode；stalled 带 idle/timeout）。
                let (
                    duration_ms,
                    reason,
                    retryable,
                    status_code,
                    delay_ms,
                    next_attempt,
                    idle_ms,
                    timeout_ms,
                ) = match status.kind {
                    ModelRequestStatusKind::ModelRequestCompleted => {
                        (status.duration_ms, None, None, None, None, None, None, None)
                    }
                    ModelRequestStatusKind::ModelRequestFailed => (
                        status.duration_ms,
                        status.reason.clone(),
                        status.retryable,
                        status.status_code,
                        None,
                        None,
                        None,
                        None,
                    ),
                    ModelRequestStatusKind::ModelRequestRetryScheduled => (
                        None,
                        status.reason.clone(),
                        None,
                        status.status_code,
                        status.delay_ms,
                        status.next_attempt,
                        None,
                        None,
                    ),
                    ModelRequestStatusKind::ModelStreamStalled => (
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        status.idle_ms,
                        status.timeout_ms,
                    ),
                    ModelRequestStatusKind::ModelRequestStarted => {
                        (None, None, None, None, None, None, None, None)
                    }
                };
                Some(ConversationTelemetryFact::ModelRequestStatus {
                    base: self.base(event, now),
                    request_id: status.request_id.clone(),
                    status: status.kind.as_str().to_owned(),
                    provider_id: status.provider_id.clone(),
                    model_id: status.model_id.clone(),
                    // 内核的端点只有线上协议（anthropic-messages / openai-*），没有 Node 的
                    // providerKind（厂商词）；不冒充，如实缺席。
                    provider_kind: None,
                    provider_hostname: status.provider_hostname.clone(),
                    transport: status.transport.clone(),
                    query_source: status.query_source.clone(),
                    query_id: status.query_id.clone(),
                    attempt: status.attempt,
                    max_attempts: status.max_attempts,
                    duration_ms,
                    reason,
                    retryable,
                    status_code,
                    delay_ms,
                    next_attempt,
                    idle_ms,
                    timeout_ms,
                })
            }
            KernelEvent::WorkflowLifecycle { fact } => {
                let mut base = self.base(event, now);
                if fact.source_command_id.is_some() {
                    base.source_command_id = fact.source_command_id.clone();
                }
                Some(ConversationTelemetryFact::WorkflowLifecycle {
                    base,
                    phase: match fact.phase {
                        WorkflowLifecyclePhase::ActorSpawned => "actor-spawned",
                        WorkflowLifecyclePhase::RunSettled => "run-settled",
                    }
                    .to_owned(),
                    run_id: fact.run_id.clone(),
                    tool_call_id: fact.tool_call_id.clone(),
                    agent_id: fact.agent_id.clone(),
                    child_session_id: fact.child_session_id.clone(),
                    status: fact.status.clone(),
                    stop_reason: fact.stop_reason.clone(),
                    error_message: fact.error_message.clone(),
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
fn tool_error_text(output: &nibi_kernel_api::tool::ToolOutput) -> String {
    output
        .content
        .iter()
        .find_map(|block| match block {
            nibi_kernel_api::message::ToolResultContent::Text { text } => {
                Some(text.trim().to_owned())
            }
            _ => None,
        })
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "conversation_telemetry_tests.rs"]
mod tests;

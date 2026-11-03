//! 会话事件 → 埋点事实（141 审计 §9 第 5 项余项）：轮、流、工具、权限、子代理与压缩。

use rust_cli_kernel_api::conversation_telemetry::ConversationTelemetryFact;
use rust_cli_kernel_api::ids::{
    AgentId, InteractionId, MessageId, SessionId, ToolUseId, TurnId,
};
use rust_cli_kernel_api::message::{CompactTrigger, ToolResultContent, Usage};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::session_api::{
    KernelEvent, SequencedEvent, SubagentPhase, TurnExecutionKind, TurnInputSource, TurnOutcome,
};
use rust_cli_kernel_api::tool::ToolOutput;
use serde_json::json;

use super::*;

fn event(seq: u64, event: KernelEvent) -> SequencedEvent {
    SequencedEvent {
        seq,
        event,
        revision: seq,
    }
}

fn output(text: &str, is_error: bool) -> ToolOutput {
    ToolOutput {
        content: vec![ToolResultContent::Text {
            text: text.to_owned(),
        }],
        is_error,
        display: serde_json::Value::Null,
    }
}

fn turn_started() -> KernelEvent {
    KernelEvent::TurnStarted {
        turn: TurnId::new("t1"),
        command: Some(rust_cli_kernel_api::ids::CommandId::new("c1")),
        execution_kind: Some(TurnExecutionKind::Agent),
        workflow_launch: None,
        input_source: None,
        origin_meta: None,
    }
}

/// 一轮：开始 → 工具开始/结束 → 结束。终态带时长、工具数与 token 合计，结束后状态清空。
#[test]
fn a_turn_reports_start_tools_and_terminal() {
    let mut facts = ConversationTelemetry::new("s1");
    let start = facts
        .facts(&event(1, turn_started()), 1_000)
        .expect("turn.started");
    let ConversationTelemetryFact::TurnStarted {
        base,
        execution_kind,
        input_source,
        ..
    } = start
    else {
        panic!("{start:?}")
    };
    assert_eq!(base.event_id, "s1:1");
    assert_eq!(base.turn_id.as_deref(), Some("t1"));
    assert_eq!(base.source_command_id.as_deref(), Some("c1"));
    assert_eq!(execution_kind.as_deref(), Some("agent"));
    assert!(input_source.is_none());

    let started = facts
        .facts(
            &event(
                2,
                KernelEvent::ToolStarted {
                    tool_use: ToolUseId::new("toolu_1"),
                    name: "Bash".to_owned(),
                    input: json!({"command": "ls"}),
                },
            ),
            1_100,
        )
        .expect("started");
    let ConversationTelemetryFact::ToolLifecycle { phase, tool_name, .. } = &started else {
        panic!("{started:?}")
    };
    assert_eq!(phase, "started");
    assert_eq!(tool_name.as_deref(), Some("Bash"));

    let done = facts
        .facts(
            &event(
                3,
                KernelEvent::ToolDone {
                    tool_use: ToolUseId::new("toolu_1"),
                    output: output("ok", false),
                },
            ),
            1_350,
        )
        .expect("done");
    let ConversationTelemetryFact::ToolLifecycle {
        phase,
        duration_ms,
        error_message,
        ..
    } = &done
    else {
        panic!("{done:?}")
    };
    assert_eq!(phase, "completed");
    assert_eq!(*duration_ms, Some(250));
    assert!(error_message.is_none());

    let finished = facts
        .facts(
            &event(
                4,
                KernelEvent::TurnFinished {
                    turn: TurnId::new("t1"),
                    outcome: TurnOutcome::Interrupted,
                    usage: Some(Usage {
                        input_tokens: 10,
                        output_tokens: 5,
                        cache_creation_input_tokens: 2,
                        cache_read_input_tokens: 3,
                    }),
                },
            ),
            2_000,
        )
        .expect("terminal");
    let ConversationTelemetryFact::TurnTerminal {
        base,
        status,
        result_type,
        duration_ms,
        token_count,
        tool_call_count,
        error_code,
        ..
    } = &finished
    else {
        panic!("{finished:?}")
    };
    assert_eq!(base.turn_id.as_deref(), Some("t1"));
    assert_eq!(status, "interrupted");
    assert_eq!(result_type.as_deref(), Some("cancelled"));
    assert_eq!(*duration_ms, Some(1_000));
    assert_eq!(*token_count, Some(15));
    assert_eq!(*tool_call_count, Some(1));
    assert_eq!(error_code.as_deref(), Some("USER_INTERRUPT"));
    // 这一轮的状态已清掉：下一条工具事件不再挂这轮。
    assert!(facts.turn.is_none());
}

/// 流块：同一个块只有第一块 `firstChunk`，思考与正文分开计数。
#[test]
fn only_the_first_chunk_of_a_part_is_marked() {
    let mut facts = ConversationTelemetry::new("s1");
    facts.facts(&event(1, turn_started()), 1_000);
    let text = |seq, index, delta| {
        event(
            seq,
            KernelEvent::StreamDelta {
                turn: TurnId::new("t1"),
                response: 0,
                index,
                delta,
            },
        )
    };
    let first = facts
        .facts(&text(2, 0, BlockDelta::Text("he".to_owned())), 1_100)
        .expect("a chunk");
    let second = facts
        .facts(&text(3, 0, BlockDelta::Text("llo".to_owned())), 1_200)
        .expect("a chunk");
    let thought = facts
        .facts(&text(4, 1, BlockDelta::Thinking("hm".to_owned())), 1_300)
        .expect("a chunk");
    let ConversationTelemetryFact::StreamChunk {
        channel: c1,
        chunk_length: l1,
        first_chunk: f1,
        part_id: p1,
        ..
    } = &first
    else {
        panic!("{first:?}")
    };
    assert_eq!((c1.as_str(), *l1, *f1), ("text", 2, true));
    assert_eq!(p1.as_deref(), Some("t1:0:0"));
    let ConversationTelemetryFact::StreamChunk {
        chunk_length,
        first_chunk,
        ..
    } = &second
    else {
        panic!("{second:?}")
    };
    assert_eq!((*chunk_length, *first_chunk), (3, false));
    let ConversationTelemetryFact::StreamChunk {
        channel,
        first_chunk,
        ..
    } = &thought
    else {
        panic!("{thought:?}")
    };
    assert_eq!((channel.as_str(), *first_chunk), ("thought", true));
    // 签名与工具输入增量不产生流事实。
    assert!(
        facts
            .facts(
                &event(
                    5,
                    KernelEvent::StreamDelta {
                        turn: TurnId::new("t1"),
                        response: 0,
                        index: 2,
                        delta: BlockDelta::Signature("sig".to_owned()),
                    },
                ),
                1_400,
            )
            .is_none()
    );
}

/// 权限询问：requested / resolved 带工具关联；非权限询问不产生事实。
#[test]
fn permission_lifecycle_is_matched_by_interaction() {
    let mut facts = ConversationTelemetry::new("s1");
    facts.facts(&event(1, turn_started()), 1_000);
    let asked = facts
        .facts(
            &event(
                2,
                KernelEvent::InteractionAsked {
                    interaction: InteractionId::new("i1"),
                    request: InteractionRequest::Permission {
                        tool_use: ToolUseId::new("toolu_1"),
                        tool: "Bash".to_owned(),
                        input: json!({}),
                        message: "run?".to_owned(),
                        suggestions: Vec::new(),
                        asked_by: None,
                        machine: None,
                    },
                },
            ),
            1_100,
        )
        .expect("requested");
    let ConversationTelemetryFact::PermissionLifecycle {
        phase,
        request_id,
        tool_call_id,
        tool_name,
        ..
    } = &asked
    else {
        panic!("{asked:?}")
    };
    assert_eq!(phase, "requested");
    assert_eq!(request_id.as_deref(), Some("i1"));
    assert_eq!(tool_call_id, "toolu_1");
    assert_eq!(tool_name.as_deref(), Some("Bash"));
    let resolved = facts
        .facts(
            &event(
                3,
                KernelEvent::InteractionResolved {
                    interaction: InteractionId::new("i1"),
                },
            ),
            1_200,
        )
        .expect("resolved");
    let ConversationTelemetryFact::PermissionLifecycle { phase, decision, .. } = &resolved else {
        panic!("{resolved:?}")
    };
    assert_eq!(phase, "resolved");
    assert!(decision.is_none(), "内核不带裁决结果");
    // 问句询问不产生权限事实；重复结算也不产生。
    assert!(
        facts
            .facts(
                &event(
                    4,
                    KernelEvent::InteractionAsked {
                        interaction: InteractionId::new("i2"),
                        request: InteractionRequest::Question {
                            tool_use: ToolUseId::new("toolu_2"),
                            questions: json!([]),
                        },
                    },
                ),
                1_300,
            )
            .is_none()
    );
    assert!(
        facts
            .facts(
                &event(
                    5,
                    KernelEvent::InteractionResolved {
                        interaction: InteractionId::new("i1"),
                    },
                ),
                1_400,
            )
            .is_none()
    );
}

/// 子代理的后台标记来自 Agent 工具的输入（`run_in_background`）。
#[test]
fn a_subagent_is_background_when_the_agent_tool_says_so() {
    let mut facts = ConversationTelemetry::new("s1");
    facts.facts(&event(1, turn_started()), 1_000);
    facts.facts(
        &event(
            2,
            KernelEvent::ToolStarted {
                tool_use: ToolUseId::new("toolu_1"),
                name: "Agent".to_owned(),
                input: json!({"prompt": "go", "run_in_background": true}),
            },
        ),
        1_100,
    );
    let spawned = facts
        .facts(
            &event(
                3,
                KernelEvent::Subagent {
                    agent: AgentId::new("a1"),
                    phase: SubagentPhase::Spawned,
                    child: SessionId::new("s2"),
                    parent_tool_use: ToolUseId::new("toolu_1"),
                },
            ),
            1_200,
        )
        .expect("spawned");
    let ConversationTelemetryFact::SubagentLifecycle {
        phase,
        agent_id,
        child_session_id,
        parent_tool_call_id,
        background,
        ..
    } = &spawned
    else {
        panic!("{spawned:?}")
    };
    assert_eq!(phase, "spawned");
    assert_eq!(agent_id, "a1");
    assert_eq!(child_session_id, "s2");
    assert_eq!(parent_tool_call_id.as_deref(), Some("toolu_1"));
    assert!(*background);
    let stopped = facts
        .facts(
            &event(
                4,
                KernelEvent::Subagent {
                    agent: AgentId::new("a1"),
                    phase: SubagentPhase::Done,
                    child: SessionId::new("s2"),
                    parent_tool_use: ToolUseId::new("toolu_1"),
                },
            ),
            1_300,
        )
        .expect("stopped");
    let ConversationTelemetryFact::SubagentLifecycle { phase, .. } = &stopped else {
        panic!("{stopped:?}")
    };
    assert_eq!(phase, "stopped");
}

/// 压缩：开始只记状态，完成时一条终态（触发方式与起止时刻）。
#[test]
fn compaction_reports_its_trigger_and_window() {
    let mut facts = ConversationTelemetry::new("s1");
    assert!(
        facts
            .facts(
                &event(
                    1,
                    KernelEvent::CompactStarted {
                        trigger: CompactTrigger::Auto,
                    },
                ),
                1_000,
            )
            .is_none()
    );
    let done = facts
        .facts(
            &event(
                2,
                KernelEvent::CompactDone {
                    boundary: MessageId::new("m1"),
                },
            ),
            1_500,
        )
        .expect("terminal");
    let ConversationTelemetryFact::CompactionTerminal {
        operation_id,
        status,
        trigger,
        started_at,
        ended_at,
        ..
    } = &done
    else {
        panic!("{done:?}")
    };
    assert_eq!(operation_id, "compact-2");
    assert_eq!(status, "completed");
    assert_eq!(trigger, "auto");
    assert_eq!((*started_at, *ended_at), (Some(1_000), Some(1_500)));
}

/// 轮开始的 executionKind 与合成输入来源：控制轮与后台通知轮。
#[test]
fn control_turns_and_background_turns_keep_their_origin() {
    let mut facts = ConversationTelemetry::new("s1");
    let started = facts
        .facts(
            &event(
                1,
                KernelEvent::TurnStarted {
                    turn: TurnId::new("t1"),
                    command: None,
                    execution_kind: Some(TurnExecutionKind::ControlOnly),
                    workflow_launch: Some(json!({"runId": "r1"})),
                    input_source: Some(TurnInputSource::BackgroundTask),
                    origin_meta: Some(json!({"backgroundSource": "bash"})),
                },
            ),
            1_000,
        )
        .expect("turn.started");
    let ConversationTelemetryFact::TurnStarted {
        execution_kind,
        input_source,
        ..
    } = &started
    else {
        panic!("{started:?}")
    };
    assert_eq!(execution_kind.as_deref(), Some("controlOnly"));
    assert_eq!(input_source.as_deref(), Some("background_task"));
}

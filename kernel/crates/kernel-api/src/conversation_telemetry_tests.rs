//! `v4/telemetry/event` 的线上形状（141 审计 §9 第 5 项余项）：`kind` 判别、驼峰字段、
//! 缺席的可选字段不写（Host 的每支都是 `.strict()`）。

use serde_json::json;

use super::*;

fn base() -> TelemetryFactBase {
    TelemetryFactBase {
        source_command_id: Some("c1".to_owned()),
        turn_id: Some("t1".to_owned()),
        ..TelemetryFactBase::new("e1".to_owned(), 7, 1_000, "s1".to_owned())
    }
}

/// 公共字段摊平进载荷：版本恒 1、eventSeq 是会话内序号、可选字段不写。
#[test]
fn the_base_fields_are_flattened() {
    let fact = ConversationTelemetryFact::TurnStarted {
        base: base(),
        execution_kind: Some("agent".to_owned()),
        input_source: None,
        background_source: None,
        automation_id: None,
        task_trigger: None,
        scheduled_at: None,
    };
    let value = serde_json::to_value(&fact).expect("serializable");
    assert_eq!(value["kind"], "turn.started");
    assert_eq!(value["version"], 1);
    assert_eq!(value["eventId"], "e1");
    assert_eq!(value["eventSeq"], 7);
    assert_eq!(value["occurredAt"], 1_000);
    assert_eq!(value["sessionId"], "s1");
    assert_eq!(value["sourceCommandId"], "c1");
    assert_eq!(value["turnId"], "t1");
    assert_eq!(value["executionKind"], "agent");
    assert!(value.get("inputSource").is_none());
    assert!(value.get("memoryEnabled").is_none());
}

/// 工具生命周期：phase 与必填 id 之外都缺席（内核没有的就留空，不造零值）。
#[test]
fn a_tool_fact_carries_only_what_the_kernel_knows() {
    let fact = ConversationTelemetryFact::ToolLifecycle {
        base: base(),
        phase: "completed".to_owned(),
        tool_call_id: "toolu_1".to_owned(),
        tool_name: Some("Bash".to_owned()),
        duration_ms: Some(1_234),
        error_code: None,
        error_message: None,
        parent_tool_call_id: None,
        child_tool_call_id: None,
        agent_id: None,
        agent_type: None,
        child_session_id: None,
        background: None,
        skill_name: None,
        skill_qualified_name: None,
        skill_plugin_id: None,
        plugin_id: None,
        plugin_component: None,
        skill_source: None,
        performance: None,
        automation_id: None,
    };
    let value = serde_json::to_value(&fact).expect("serializable");
    assert_eq!(value["kind"], "tool.lifecycle");
    assert_eq!(value["phase"], "completed");
    assert_eq!(value["toolCallId"], "toolu_1");
    assert_eq!(value["toolName"], "Bash");
    assert_eq!(value["durationMs"], 1_234);
    for absent in [
        "errorCode",
        "errorMessage",
        "parentToolCallId",
        "childToolCallId",
        "agentId",
        "agentType",
        "childSessionId",
        "background",
        "pluginId",
        "performance",
    ] {
        assert!(value.get(absent).is_none(), "{absent} must stay absent");
    }
}

/// 用量增量：六个计数是必填（Host schema），内核没有的缓存项如实写 0。
#[test]
fn a_usage_fact_always_carries_the_six_counters() {
    let fact = ConversationTelemetryFact::UsageDelta {
        base: base(),
        request_id: None,
        provider_id: Some("p".to_owned()),
        model_id: Some("m".to_owned()),
        provider_kind: None,
        provider_hostname: None,
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        reasoning_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
    };
    let value = serde_json::to_value(&fact).expect("serializable");
    assert_eq!(value["kind"], "usage.delta");
    assert_eq!(value["inputTokens"], 10);
    assert_eq!(value["outputTokens"], 20);
    assert_eq!(value["totalTokens"], 30);
    assert_eq!(value["reasoningTokens"], 0);
    assert_eq!(value["cacheReadTokens"], 0);
    assert_eq!(value["cacheWriteTokens"], 0);
    assert!(value.get("requestId").is_none());
    assert_eq!(value["providerId"], "p");
}

/// 每种事实的 `kind` 都是 Host 词表里的点号拼写（蛇形重命名会写成 `turn_started`）。
#[test]
fn the_kind_spellings_match_the_contract() {
    let kinds = [
        (
            ConversationTelemetryFact::TurnTerminal {
                base: base(),
                status: "success".to_owned(),
                result_type: None,
                duration_ms: None,
                token_count: None,
                tool_call_count: None,
                error_code: None,
                error_message: None,
                error_retryable: None,
                turn_phase: None,
                background_subagent_result_consumed: None,
                workflow_result_consumed: None,
            },
            "turn.terminal",
        ),
        (
            ConversationTelemetryFact::StreamChunk {
                base: base(),
                channel: "text".to_owned(),
                chunk_length: 3,
                first_chunk: true,
                assistant_message_id: None,
                part_id: Some("t1:0:0".to_owned()),
                parent_tool_call_id: None,
            },
            "stream.chunk",
        ),
        (
            ConversationTelemetryFact::PermissionLifecycle {
                base: base(),
                phase: "requested".to_owned(),
                request_id: None,
                tool_call_id: "toolu_1".to_owned(),
                tool_name: None,
                child_session_id: None,
                background: None,
                decision: None,
            },
            "permission.lifecycle",
        ),
        (
            ConversationTelemetryFact::SubagentLifecycle {
                base: base(),
                phase: "spawned".to_owned(),
                agent_id: "a1".to_owned(),
                agent_type: None,
                child_session_id: "s2".to_owned(),
                parent_tool_call_id: None,
                background: false,
                status: None,
                error_message: None,
            },
            "subagent.lifecycle",
        ),
        (
            ConversationTelemetryFact::CompactionTerminal {
                base: base(),
                operation_id: "op1".to_owned(),
                message_id: None,
                summary_message_id: None,
                status: "completed".to_owned(),
                trigger: "auto".to_owned(),
                compact_reason: None,
                reason: None,
                attempt: None,
                max_attempts: None,
                started_at: None,
                ended_at: None,
                pre_compact_token_count: None,
                post_compact_token_count: None,
                true_post_compact_token_count: None,
                model_name: None,
                model_provider: None,
            },
            "compaction.terminal",
        ),
    ];
    for (fact, expected) in kinds {
        let value = serde_json::to_value(&fact).expect("serializable");
        assert_eq!(value["kind"], expected);
    }
}

/// 反序列化回同一形状（事件日志/测试回放会走这条路）。
#[test]
fn facts_round_trip() {
    let fact = ConversationTelemetryFact::TurnStarted {
        base: base(),
        execution_kind: None,
        input_source: Some("background_task".to_owned()),
        background_source: Some("bash".to_owned()),
        automation_id: None,
        task_trigger: None,
        scheduled_at: None,
    };
    let value = json!(fact.clone());
    let back: ConversationTelemetryFact = serde_json::from_value(value).expect("round trip");
    assert_eq!(back, fact);
}

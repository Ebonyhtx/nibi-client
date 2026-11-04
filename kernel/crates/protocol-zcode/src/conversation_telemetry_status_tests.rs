//! 模型请求状态与工作流归属的埋点事实（141 审计 §9 第 5 项的最后两支）。

use rust_cli_kernel_api::conversation_telemetry::ConversationTelemetryFact;
use rust_cli_kernel_api::model::{ModelRequestStatus, ModelRequestStatusKind};
use rust_cli_kernel_api::session_api::{
    KernelEvent, SequencedEvent, TurnExecutionKind, WorkflowLifecycleFact, WorkflowLifecyclePhase,
};

use super::*;

fn event(seq: u64, event: KernelEvent) -> SequencedEvent {
    SequencedEvent {
        seq,
        event,
        revision: seq,
    }
}

fn turn_started() -> KernelEvent {
    KernelEvent::TurnStarted {
        turn: rust_cli_kernel_api::ids::TurnId::new("t1"),
        command: Some(rust_cli_kernel_api::ids::CommandId::new("c1")),
        execution_kind: Some(TurnExecutionKind::Agent),
        workflow_launch: None,
        input_source: None,
        origin_meta: None,
    }
}

fn status(kind: ModelRequestStatusKind, request_id: &str) -> ModelRequestStatus {
    ModelRequestStatus {
        kind,
        request_id: request_id.to_owned(),
        provider_id: "p1".to_owned(),
        model_id: "m1".to_owned(),
        provider_hostname: Some("api.example.com".to_owned()),
        transport: "sse".to_owned(),
        query_source: Some("main_turn".to_owned()),
        query_id: Some("run_1".to_owned()),
        attempt: 1,
        max_attempts: 4,
        duration_ms: None,
        reason: None,
        retryable: None,
        status_code: None,
        delay_ms: None,
        next_attempt: None,
        idle_ms: None,
        timeout_ms: None,
    }
}

/// 模型请求的生命周期：每支只带契约里该有的字段（与 Node 的映射同形）。
#[test]
fn a_model_request_reports_each_lifecycle_status() {
    let mut facts = ConversationTelemetry::new("s1");
    facts.facts(&event(1, turn_started()), 1_000);

    let started = facts
        .facts(
            &event(
                2,
                KernelEvent::ModelRequestStatus {
                    status: status(ModelRequestStatusKind::ModelRequestStarted, "req-1"),
                },
            ),
            1_100,
        )
        .expect("started");
    let ConversationTelemetryFact::ModelRequestStatus {
        base,
        request_id,
        status: name,
        provider_hostname,
        transport,
        query_source,
        query_id,
        attempt,
        max_attempts,
        duration_ms,
        ..
    } = &started
    else {
        panic!("{started:?}")
    };
    assert_eq!(base.turn_id.as_deref(), Some("t1"));
    assert_eq!(base.source_command_id.as_deref(), Some("c1"));
    assert_eq!(request_id, "req-1");
    assert_eq!(name, "model_request_started");
    assert_eq!(provider_hostname.as_deref(), Some("api.example.com"));
    assert_eq!(transport, "sse");
    assert_eq!(query_source.as_deref(), Some("main_turn"));
    assert_eq!(query_id.as_deref(), Some("run_1"));
    assert_eq!((*attempt, *max_attempts), (1, 4));
    assert!(duration_ms.is_none());
    // 线上形状：kind 判别键、必填字段在场、可选字段缺席不写（Host 的 strict schema）。
    let payload = serde_json::to_value(&started).expect("serialize");
    assert_eq!(payload["kind"], "model.request.status");
    assert_eq!(payload["eventSeq"], 2);
    assert_eq!(payload["providerId"], "p1");
    assert!(payload.get("durationMs").is_none());
    assert!(payload.get("retryable").is_none());

    // 失败：duration / reason / retryable / statusCode。
    let mut failed_status = status(ModelRequestStatusKind::ModelRequestFailed, "req-1");
    failed_status.duration_ms = Some(200);
    failed_status.reason = Some("server_error".to_owned());
    failed_status.retryable = Some(true);
    failed_status.status_code = Some(500);
    let failed = facts
        .facts(
            &event(
                3,
                KernelEvent::ModelRequestStatus {
                    status: failed_status,
                },
            ),
            1_300,
        )
        .expect("failed");
    let ConversationTelemetryFact::ModelRequestStatus {
        status: name,
        duration_ms,
        reason,
        retryable,
        status_code,
        delay_ms,
        ..
    } = &failed
    else {
        panic!("{failed:?}")
    };
    assert_eq!(name, "model_request_failed");
    assert_eq!(*duration_ms, Some(200));
    assert_eq!(reason.as_deref(), Some("server_error"));
    assert_eq!(*retryable, Some(true));
    assert_eq!(*status_code, Some(500));
    assert!(delay_ms.is_none());

    // 重试排期：delay / nextAttempt / reason / statusCode，不带 duration。
    let mut retry_status = status(ModelRequestStatusKind::ModelRequestRetryScheduled, "req-1");
    retry_status.delay_ms = Some(500);
    retry_status.next_attempt = Some(2);
    retry_status.reason = Some("server_error".to_owned());
    retry_status.status_code = Some(500);
    let retry = facts
        .facts(
            &event(
                4,
                KernelEvent::ModelRequestStatus {
                    status: retry_status,
                },
            ),
            1_800,
        )
        .expect("retry");
    let ConversationTelemetryFact::ModelRequestStatus {
        status: name,
        delay_ms,
        next_attempt,
        duration_ms,
        ..
    } = &retry
    else {
        panic!("{retry:?}")
    };
    assert_eq!(name, "model_retry_scheduled");
    assert_eq!(*delay_ms, Some(500));
    assert_eq!(*next_attempt, Some(2));
    assert!(duration_ms.is_none());

    // 完成：只带 duration。
    let mut completed_status = status(ModelRequestStatusKind::ModelRequestCompleted, "req-2");
    completed_status.duration_ms = Some(90);
    let completed = facts
        .facts(
            &event(
                5,
                KernelEvent::ModelRequestStatus {
                    status: completed_status,
                },
            ),
            1_900,
        )
        .expect("completed");
    let ConversationTelemetryFact::ModelRequestStatus {
        status: name,
        duration_ms,
        reason,
        ..
    } = &completed
    else {
        panic!("{completed:?}")
    };
    assert_eq!(name, "model_request_completed");
    assert_eq!(*duration_ms, Some(90));
    assert!(reason.is_none());

    // 看门狗：idle / timeout。
    let mut stalled_status = status(ModelRequestStatusKind::ModelStreamStalled, "req-2");
    stalled_status.idle_ms = Some(1_000);
    stalled_status.timeout_ms = Some(1_000);
    let stalled = facts
        .facts(
            &event(
                6,
                KernelEvent::ModelRequestStatus {
                    status: stalled_status,
                },
            ),
            2_900,
        )
        .expect("stalled");
    let ConversationTelemetryFact::ModelRequestStatus {
        status: name,
        idle_ms,
        timeout_ms,
        ..
    } = &stalled
    else {
        panic!("{stalled:?}")
    };
    assert_eq!(name, "model_stream_stalled");
    assert_eq!((*idle_ms, *timeout_ms), (Some(1_000), Some(1_000)));
}

/// 工作流归属：actor 创建带 actor 与子会话，结算带状态与停止原因；启动输入 id 覆盖基字段。
#[test]
fn a_workflow_run_reports_actor_spawn_and_settlement() {
    let mut facts = ConversationTelemetry::new("s1");
    let spawned = facts
        .facts(
            &event(
                1,
                KernelEvent::WorkflowLifecycle {
                    fact: WorkflowLifecycleFact {
                        run_id: "dwfrun_1".to_owned(),
                        phase: WorkflowLifecyclePhase::ActorSpawned,
                        tool_call_id: Some("toolu_1".to_owned()),
                        agent_id: Some("worker@1".to_owned()),
                        child_session_id: Some("sess_dwf_1".to_owned()),
                        status: None,
                        stop_reason: None,
                        error_message: None,
                        source_command_id: None,
                    },
                },
            ),
            1_000,
        )
        .expect("actor-spawned");
    let ConversationTelemetryFact::WorkflowLifecycle {
        phase,
        run_id,
        tool_call_id,
        agent_id,
        child_session_id,
        status,
        ..
    } = &spawned
    else {
        panic!("{spawned:?}")
    };
    assert_eq!(phase, "actor-spawned");
    assert_eq!(run_id, "dwfrun_1");
    assert_eq!(tool_call_id.as_deref(), Some("toolu_1"));
    assert_eq!(agent_id.as_deref(), Some("worker@1"));
    assert_eq!(child_session_id.as_deref(), Some("sess_dwf_1"));
    assert!(status.is_none());

    let settled = facts
        .facts(
            &event(
                2,
                KernelEvent::WorkflowLifecycle {
                    fact: WorkflowLifecycleFact {
                        run_id: "dwfrun_1".to_owned(),
                        phase: WorkflowLifecyclePhase::RunSettled,
                        tool_call_id: Some("toolu_1".to_owned()),
                        agent_id: None,
                        child_session_id: None,
                        status: Some("stopped".to_owned()),
                        stop_reason: Some("provider".to_owned()),
                        error_message: Some("provider unavailable".to_owned()),
                        source_command_id: Some("c1".to_owned()),
                    },
                },
            ),
            2_000,
        )
        .expect("run-settled");
    let ConversationTelemetryFact::WorkflowLifecycle {
        base,
        phase,
        status,
        stop_reason,
        error_message,
        ..
    } = &settled
    else {
        panic!("{settled:?}")
    };
    assert_eq!(phase, "run-settled");
    assert_eq!(base.source_command_id.as_deref(), Some("c1"));
    assert_eq!(status.as_deref(), Some("stopped"));
    assert_eq!(stop_reason.as_deref(), Some("provider"));
    assert_eq!(error_message.as_deref(), Some("provider unavailable"));
    let payload = serde_json::to_value(&settled).expect("serialize");
    assert_eq!(payload["kind"], "workflow.lifecycle");
    assert_eq!(payload["phase"], "run-settled");
    assert_eq!(payload["sourceCommandId"], "c1");
    assert!(payload.get("agentId").is_none());
}

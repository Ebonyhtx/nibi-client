//! `v4/telemetry/local-ttft` 的采集（141 审计 §9 第 5 项余项）：受理、执行、首个输出、终态。

use rust_cli_kernel_api::ids::{CommandId, TurnId};
use rust_cli_kernel_api::local_ttft::LocalTtftContext;
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};

use super::*;

fn context() -> LocalTtftContext {
    LocalTtftContext {
        version: 1,
        observation_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301".to_owned(),
    }
}

fn started(command: &str) -> KernelEvent {
    KernelEvent::TurnStarted {
        turn: TurnId::new("t1"),
        command: Some(CommandId::new(command)),
        execution_kind: None,
        workflow_launch: None,
        input_source: None,
        origin_meta: None,
    }
}

/// 一条命令走完：受理 → 回合开始 → 首个正文 → 终态；每次推进 revision 加一，终态之后不再记。
#[test]
fn one_command_walks_through_the_milestones() {
    let recorder = LocalTtftRecorder::new("cli-1".to_owned());
    let received = recorder
        .receive(&context(), "c1", Some("s1"), 1_000, Some(false))
        .expect("a record");
    assert_eq!(received.revision, Some(1));
    assert_eq!(received.received_at, 1_000);
    assert_eq!(received.send_mode.as_deref(), Some("idle"));
    assert!(received.admitted_at.is_none());
    // 重复信封不记。
    assert!(recorder.receive(&context(), "c1", Some("s1"), 1_001, Some(false)).is_none());

    let admitted = recorder.admitted("c1", 1_010).expect("admitted");
    assert_eq!(admitted.admitted_at, Some(1_010));
    assert_eq!(admitted.revision, Some(2));

    let mut events = recorder.event("s1", &started("c1"), 1_020);
    let execution = events.pop().expect("execution");
    assert_eq!(execution.execution_at, Some(1_020));
    assert_eq!(execution.turn_id.as_deref(), Some("t1"));
    assert_eq!(execution.revision, Some(3));

    let mut events = recorder.event(
        "s1",
        &KernelEvent::StreamDelta {
            turn: TurnId::new("t1"),
            response: 0,
            index: 0,
            delta: BlockDelta::Text("he".to_owned()),
        },
        1_050,
    );
    let output = events.pop().expect("first output");
    assert_eq!(output.output_at, Some(1_050));
    assert_eq!(output.output_kind.as_deref(), Some("text"));
    // 同一回合的后续增量不再发快照。
    assert!(
        recorder
            .event(
                "s1",
                &KernelEvent::StreamDelta {
                    turn: TurnId::new("t1"),
                    response: 0,
                    index: 0,
                    delta: BlockDelta::Text("llo".to_owned()),
                },
                1_060,
            )
            .is_empty()
    );

    let mut events = recorder.event(
        "s1",
        &KernelEvent::TurnFinished {
            turn: TurnId::new("t1"),
            outcome: TurnOutcome::Success,
            usage: None,
        },
        2_000,
    );
    let terminal = events.pop().expect("terminal");
    assert_eq!(terminal.terminal.as_deref(), Some("completed"));
    // 终态之后记录已释放。
    assert!(recorder.admitted("c1", 2_100).is_none());
}

/// 被拒的命令记 `rejected` 并结束观察；被中断的回合记 `interrupted`。
#[test]
fn rejected_commands_and_interrupted_turns_close_the_record() {
    let recorder = LocalTtftRecorder::new("cli-1".to_owned());
    recorder.receive(&context(), "c1", Some("s1"), 1_000, Some(false));
    let rejected = recorder.rejected("c1", 1_005).expect("rejected");
    assert_eq!(rejected.terminal.as_deref(), Some("rejected"));
    assert_eq!(rejected.admitted_at, Some(1_005));
    assert!(recorder.event("s1", &started("c1"), 1_010).is_empty());

    recorder.receive(&context(), "c2", Some("s1"), 2_000, Some(false));
    recorder.event("s1", &started("c2"), 2_010);
    let mut events = recorder.event(
        "s1",
        &KernelEvent::TurnFinished {
            turn: TurnId::new("t1"),
            outcome: TurnOutcome::Interrupted,
            usage: None,
        },
        2_100,
    );
    assert_eq!(
        events.pop().and_then(|facts| facts.terminal),
        Some("interrupted".to_owned())
    );
}

/// 工具先于正文出现：首个输出的种类是 `tool`。
#[test]
fn a_tool_before_any_text_is_the_first_output() {
    let recorder = LocalTtftRecorder::new("cli-1".to_owned());
    recorder.receive(&context(), "c1", Some("s1"), 1_000, Some(false));
    recorder.event("s1", &started("c1"), 1_010);
    let mut events = recorder.event(
        "s1",
        &KernelEvent::ToolStarted {
            tool_use: rust_cli_kernel_api::ids::ToolUseId::new("toolu_1"),
            name: "Bash".to_owned(),
            input: serde_json::json!({}),
        },
        1_020,
    );
    let output = events.pop().expect("first output");
    assert_eq!(output.output_kind.as_deref(), Some("tool"));
}

/// 超过 TTL 的在途记录被清掉；容量满时新观察不记。
#[test]
fn stale_records_expire_and_capacity_is_bounded() {
    let recorder = LocalTtftRecorder::new("cli-1".to_owned());
    recorder.receive(&context(), "stale", Some("s1"), 1_000, Some(false));
    // 6 分钟后再来一条：过期的那条在 prune 时清掉。
    recorder.receive(&context(), "fresh", Some("s1"), 361_000, Some(false));
    assert!(recorder.admitted("stale", 361_001).is_none());
    assert!(recorder.admitted("fresh", 361_002).is_some());

    let recorder = LocalTtftRecorder::new("cli-1".to_owned());
    for index in 0..MAX_PENDING {
        assert!(
            recorder
                .receive(&context(), &format!("c{index}"), Some("s1"), 1_000, Some(false))
                .is_some(),
            "record {index}"
        );
    }
    assert!(
        recorder
            .receive(&context(), "overflow", Some("s1"), 1_000, Some(false))
            .is_none()
    );
}

/// 主回合模型请求开始：补 `requestAt` 与请求标识（`requestId`/`queryId`/provider/model）。
/// 重试是同一逻辑请求，不覆盖首次 `requestAt`；旁路请求（compact 等）不记。
#[test]
fn a_main_model_request_fills_request_at_and_identifiers() {
    use rust_cli_kernel_api::model::{ModelRequestStatus, ModelRequestStatusKind};

    let recorder = LocalTtftRecorder::new("cli-1".to_owned());
    recorder
        .receive(&context(), "c1", Some("s1"), 1_000, Some(false))
        .expect("a record");
    recorder.admitted("c1", 1_010);
    recorder.event("s1", &started("c1"), 1_020);
    let status = ModelRequestStatus {
        kind: ModelRequestStatusKind::ModelRequestStarted,
        request_id: "req-1".to_owned(),
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
    };
    let snapshot = recorder
        .event(
            "s1",
            &KernelEvent::ModelRequestStatus {
                status: status.clone(),
            },
            1_030,
        )
        .pop()
        .expect("request milestone");
    assert_eq!(snapshot.request_at, Some(1_030));
    assert_eq!(snapshot.request_id.as_deref(), Some("req-1"));
    assert_eq!(snapshot.query_id.as_deref(), Some("run_1"));
    assert_eq!(snapshot.provider.as_deref(), Some("p1"));
    assert_eq!(snapshot.model.as_deref(), Some("m1"));

    // 第二次尝试（新 requestId）不覆盖首次 requestAt。
    let mut retry = status.clone();
    retry.attempt = 2;
    retry.request_id = "req-2".to_owned();
    let snapshot = recorder
        .event("s1", &KernelEvent::ModelRequestStatus { status: retry }, 1_040)
        .pop()
        .expect("second attempt");
    assert_eq!(snapshot.request_at, Some(1_030));
    assert_eq!(snapshot.request_id.as_deref(), Some("req-1"));

    // 旁路请求不属于这条命令的首 token 观察。
    let mut side = status;
    side.query_source = Some("compact".to_owned());
    assert!(
        recorder
            .event("s1", &KernelEvent::ModelRequestStatus { status: side }, 1_050)
            .is_empty()
    );
}

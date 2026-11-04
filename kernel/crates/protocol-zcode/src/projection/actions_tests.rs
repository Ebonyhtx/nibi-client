//! 行级动作（141 审计 §9「行级 actions 的剩余缺口」）：edit / retry / fork / rewind 的入口闸。

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, InteractionId, MessageId, SessionId, ToolUseId, TraceId, TurnId};
use rust_cli_kernel_api::message::{AssistantMessage, ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::session_api::{FileChange, KernelEvent, SequencedEvent, SessionView, TurnOutcome};
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use rust_cli_kernel_api::testing::selection;
use serde_json::Value;

use super::super::state::Followup;
use super::super::{PermissionMode, Projection};

fn view(messages: Vec<Message>) -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: SessionId::new("session_1"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
        },
        messages,
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
        pending: Vec::new(),
        queue: Vec::new(),
        last_seq: 0,
        revision: 0,
        running: false,
        background: Vec::new(),
        peer_held: Vec::new(),
        context_usage: None,
        context_notice: Default::default(),
        output_speed: None,
        launches: Vec::new(),
        model_turns: Vec::new(),
    }
}

fn user(id: &str) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: "hi".into(),
        }],
        origin: UserOrigin::Human,
    })
}

fn assistant(id: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: "done".into(),
        }],
        model: "m".into(),
        stop_reason: None,
        usage: None,
    })
}

fn rows(projection: &Projection, kind: &str) -> Vec<serde_json::Map<String, Value>> {
    projection
        .rows()
        .into_iter()
        .filter(|row| row["kind"] == kind)
        .collect()
}

fn actions(row: &serde_json::Map<String, Value>) -> Value {
    row.get("actions").cloned().unwrap_or(Value::Null)
}

/// 两轮历史：只有最后一条真实输入可编辑、最后一条 assistant 可重试；每轮最后一段都可分叉。
#[test]
fn only_the_latest_targets_carry_the_edit_and_retry_actions() {
    let projection = Projection::from_view(
        &view(vec![user("u1"), assistant("a1"), user("u2"), assistant("a2")]),
        Followup::Queue,
        Vec::new(),
    );
    let inputs = rows(&projection, "userInput");
    assert_eq!(inputs.len(), 2);
    assert_eq!(actions(&inputs[0]), Value::Null, "旧输入不可编辑");
    assert_eq!(
        actions(&inputs[1]),
        serde_json::json!({"canEdit": true, "editDisposition": "rewind"})
    );
    let texts = rows(&projection, "assistantText");
    assert_eq!(texts.len(), 2);
    assert_eq!(actions(&texts[0]), serde_json::json!({"canFork": true}));
    assert_eq!(
        actions(&texts[1]),
        serde_json::json!({"canRetry": true, "canFork": true})
    );
}

/// 回合跑起来时三类入口都收走；收口后按同样的规则回来。
#[test]
fn a_running_turn_hides_the_actions() {
    let mut projection = Projection::from_view(
        &view(vec![user("u1"), assistant("a1")]),
        Followup::Queue,
        Vec::new(),
    );
    let mut seq = 0u64;
    let feed = |projection: &mut Projection, event: KernelEvent, seq: &mut u64| {
        *seq += 1;
        projection.apply(
            &SequencedEvent {
                seq: *seq,
                event,
                revision: *seq,
            },
            2000,
        )
    };
    feed(
        &mut projection,
        KernelEvent::TurnStarted {
            turn: TurnId::new("t1"),
            command: None,
            execution_kind: None,
            workflow_launch: None,
            input_source: None,
            origin_meta: None,
        },
        &mut seq,
    );
    assert_eq!(actions(&rows(&projection, "userInput")[0]), Value::Null);
    assert_eq!(actions(&rows(&projection, "assistantText")[0]), Value::Null);
    feed(
        &mut projection,
        KernelEvent::TurnFinished {
            turn: TurnId::new("t1"),
            outcome: TurnOutcome::Success,
            usage: None,
        },
        &mut seq,
    );
    assert_eq!(
        actions(&rows(&projection, "userInput")[0]),
        serde_json::json!({"canEdit": true, "editDisposition": "rewind"})
    );
    assert_eq!(
        actions(&rows(&projection, "assistantText")[0]),
        serde_json::json!({"canRetry": true, "canFork": true})
    );
}

/// 文件撤销入口：终态且摘要在场才有；有待回答的交互时收走，结算后回来。
#[test]
fn the_rewind_entry_follows_the_turn_state_and_pending_interactions() {
    let mut projection =
        Projection::from_view(&view(vec![user("u1")]), Followup::Queue, Vec::new());
    let mut seq = 0u64;
    let feed = |projection: &mut Projection, event: KernelEvent, seq: &mut u64| {
        *seq += 1;
        projection.apply(
            &SequencedEvent {
                seq: *seq,
                event,
                revision: *seq,
            },
            2000,
        )
    };
    feed(
        &mut projection,
        KernelEvent::TurnStarted {
            turn: TurnId::new("t1"),
            command: None,
            execution_kind: None,
            workflow_launch: None,
            input_source: None,
            origin_meta: None,
        },
        &mut seq,
    );
    feed(
        &mut projection,
        KernelEvent::FileChanges {
            turn: TurnId::new("t1"),
            files: vec![FileChange {
                path: "/w/a.txt".into(),
                additions: 1,
                deletions: 0,
                machine: None,
            }],
            rewindable: true,
        },
        &mut seq,
    );
    let header = rows(&projection, "turnHeader");
    let header = header.last().expect("a header");
    assert_eq!(actions(header), Value::Null, "running 时不给");
    feed(
        &mut projection,
        KernelEvent::TurnFinished {
            turn: TurnId::new("t1"),
            outcome: TurnOutcome::Success,
            usage: None,
        },
        &mut seq,
    );
    let header = rows(&projection, "turnHeader");
    let header = header.last().expect("a header");
    assert_eq!(actions(header), serde_json::json!({"canRewindFiles": true}));
    // 有待回答的权限询问：入口收走。
    feed(
        &mut projection,
        KernelEvent::InteractionAsked {
            interaction: InteractionId::new("i1"),
            request: InteractionRequest::Permission {
                tool_use: ToolUseId::new("toolu_1"),
                tool: "Bash".to_owned(),
                input: serde_json::json!({}),
                message: "run?".to_owned(),
                suggestions: Vec::new(),
                asked_by: None,
                machine: None,
            },
        },
        &mut seq,
    );
    let header = rows(&projection, "turnHeader");
    assert_eq!(actions(header.last().expect("a header")), Value::Null);
    feed(
        &mut projection,
        KernelEvent::InteractionResolved {
            interaction: InteractionId::new("i1"),
        },
        &mut seq,
    );
    let header = rows(&projection, "turnHeader");
    assert_eq!(
        actions(header.last().expect("a header")),
        serde_json::json!({"canRewindFiles": true})
    );
}

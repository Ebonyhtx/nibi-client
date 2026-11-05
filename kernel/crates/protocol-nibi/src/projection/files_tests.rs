//! 轮头的文件摘要与撤销入口（141 审计 §9 第 2 项余项）。

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::file_changes::TurnFileSummary;
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId, TraceId, TurnId};
use rust_cli_kernel_api::message::{AssistantMessage, ContentBlock, Message, UserMessage, UserOrigin};
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

fn feed(projection: &mut Projection, seq: &mut u64, event: KernelEvent) -> Vec<Value> {
    *seq += 1;
    projection.apply(
        &SequencedEvent {
            seq: *seq,
            event,
            revision: *seq,
        },
        2000 + *seq,
    )
}

fn change(path: &str, additions: u64) -> FileChange {
    FileChange {
        path: path.into(),
        additions,
        deletions: 0,
        machine: None,
    }
}

fn header(projection: &Projection) -> serde_json::Map<String, Value> {
    projection
        .rows()
        .into_iter()
        .filter(|row| row["kind"] == "turnHeader")
        .next_back()
        .expect("a turn header")
}

/// 一轮里两次写入落定：摘要累加；running 时不给撤销入口，收口后补上。
#[test]
fn file_changes_accumulate_and_open_the_rewind_after_the_turn() {
    let mut projection = Projection::from_view(&view(vec![user("u1")]), Followup::Queue, Vec::new());
    let mut seq = 0;
    let turn = TurnId::new("t1");
    feed(
        &mut projection,
        &mut seq,
        KernelEvent::TurnStarted {
            turn: turn.clone(),
            command: None,
            execution_kind: None,
            workflow_launch: None,
            input_source: None,
            origin_meta: None,
        },
    );
    feed(
        &mut projection,
        &mut seq,
        KernelEvent::FileChanges {
            turn: turn.clone(),
            files: vec![change("/w/a.txt", 2)],
            rewindable: true,
        },
    );
    feed(
        &mut projection,
        &mut seq,
        KernelEvent::FileChanges {
            turn: turn.clone(),
            files: vec![change("/w/a.txt", 1), change("/w/b.txt", 4)],
            rewindable: true,
        },
    );
    let row = header(&projection);
    assert_eq!(row["fileChanges"]["files"], 2, "路径去重");
    assert_eq!(row["fileChanges"]["additions"], 7);
    assert_eq!(row["fileChanges"]["state"], "active");
    assert!(row.get("actions").is_none(), "running 时没有撤销入口");
    feed(
        &mut projection,
        &mut seq,
        KernelEvent::TurnFinished {
            turn,
            outcome: TurnOutcome::Success,
            usage: None,
        },
    );
    let row = header(&projection);
    assert_eq!(row["actions"]["canRewindFiles"], true);
}

/// 只回退文件成功：摘要标成 reverted，撤销入口撤掉。
#[test]
fn files_restored_marks_the_turn_reverted() {
    let mut projection = Projection::from_view(&view(vec![user("u1")]), Followup::Queue, Vec::new());
    let mut seq = 0;
    let turn = TurnId::new("t1");
    feed(
        &mut projection,
        &mut seq,
        KernelEvent::TurnStarted {
            turn: turn.clone(),
            command: None,
            execution_kind: None,
            workflow_launch: None,
            input_source: None,
            origin_meta: None,
        },
    );
    feed(
        &mut projection,
        &mut seq,
        KernelEvent::FileChanges {
            turn: turn.clone(),
            files: vec![change("/w/a.txt", 1)],
            rewindable: true,
        },
    );
    feed(
        &mut projection,
        &mut seq,
        KernelEvent::TurnFinished {
            turn: turn.clone(),
            outcome: TurnOutcome::Success,
            usage: None,
        },
    );
    feed(
        &mut projection,
        &mut seq,
        KernelEvent::FilesRestored { turn },
    );
    let row = header(&projection);
    assert_eq!(row["fileChanges"]["state"], "reverted");
    assert!(row.get("actions").is_none(), "reverted 之后没有撤销入口");
}

/// 冷打开：摘要按 prompt 消息 id 挂回那一轮的轮头；没有对应轮头的摘要被忽略。
#[test]
fn cold_summaries_attach_to_the_turn_that_the_prompt_opened() {
    let mut projection = Projection::from_view(
        &view(vec![
            user("u1"),
            Message::Assistant(AssistantMessage {
                id: MessageId::new("a1"),
                content: vec![ContentBlock::Text {
                    text: "done".into(),
                }],
                model: "m".into(),
                stop_reason: None,
                usage: None,
            }),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    let deltas = projection.set_file_summaries(&[
        TurnFileSummary {
            prompt: MessageId::new("u1"),
            files: 3,
            additions: 10,
            deletions: 2,
        },
        TurnFileSummary {
            prompt: MessageId::new("nope"),
            files: 1,
            additions: 1,
            deletions: 0,
        },
    ]);
    assert_eq!(deltas.len(), 1, "只有 u1 那一轮有行");
    assert_eq!(deltas[0]["op"], "row.upserted");
    let row = header(&projection);
    assert_eq!(row["fileChanges"]["files"], 3);
    assert_eq!(row["fileChanges"]["additions"], 10);
    assert_eq!(row["actions"]["canRewindFiles"], true);
    // 再挂一次不重复覆盖（事件路径上的值不会被旧摘要盖掉）。
    projection.set_file_summaries(&[TurnFileSummary {
        prompt: MessageId::new("u1"),
        files: 1,
        additions: 1,
        deletions: 0,
    }]);
    assert_eq!(header(&projection)["fileChanges"]["additions"], 10);
}

//! `workflowRuns` 归约的纯函数测试：引擎事件 → run 卡/详情的实时状态。

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{KernelEvent, SequencedEvent, SessionView};
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use rust_cli_kernel_api::testing::selection;
use rust_cli_kernel_api::workflow::{WorkflowRunProgress, WorkflowRunSummaryRow};
use serde_json::{Value, json};

use super::WorkflowRunsState;
use crate::projection::{Followup, Projection};

fn progress(event_type: &str, sequence: u64, payload: Value) -> WorkflowRunProgress {
    WorkflowRunProgress {
        run_id: "dwfrun-1".to_owned(),
        tool_call_id: Some("launch-1".to_owned()),
        sequence,
        event_type: event_type.to_owned(),
        payload,
        actor_session_id: None,
    }
}

fn run_started(sequence: u64) -> WorkflowRunProgress {
    progress("run-started", sequence, json!({}))
}

fn actor_created(sequence: u64) -> WorkflowRunProgress {
    progress(
        "actor-created",
        sequence,
        json!({"actor": {"siteId": "agent#1", "ordinal": 1}, "name": "reader"}),
    )
}

fn node_queued(sequence: u64) -> WorkflowRunProgress {
    progress(
        "node-queued",
        sequence,
        json!({
            "instance": {"siteId": "agent#1", "ordinal": 1},
            "kind": "ask",
            "actor": {"siteId": "agent#1", "ordinal": 1},
            "instructionsHead": "read the files",
        }),
    )
}

fn node_dispatched(sequence: u64) -> WorkflowRunProgress {
    progress(
        "node-dispatched",
        sequence,
        json!({
            "instance": {"siteId": "agent#1", "ordinal": 1},
            "kind": "ask",
            "actor": {"siteId": "agent#1", "ordinal": 1},
            "actorName": "reader",
        }),
    )
}

fn node_settled(sequence: u64) -> WorkflowRunProgress {
    progress(
        "node-settled",
        sequence,
        json!({
            "instance": {"siteId": "agent#1", "ordinal": 1},
            "outcome": "ok",
        }),
    )
}

#[test]
fn a_run_event_creates_the_workflow_runs_state() {
    let mut state = WorkflowRunsState::default();
    assert!(state.apply(&run_started(1)));
    let value = serde_json::to_value(&state).unwrap();
    assert_eq!(value["revision"], 1);
    assert_eq!(value["runs"][0]["runId"], "dwfrun-1");
    assert_eq!(value["runs"][0]["toolCallId"], "launch-1");
    assert_eq!(value["runs"][0]["status"], "running");
    assert_eq!(value["runs"][0]["usage"]["spentTokens"], 0);
    assert_eq!(value["runs"][0]["actors"], json!([]));
    assert_eq!(value["runs"][0]["nodes"], json!([]));
    assert_eq!(value["runs"][0]["lastEventSequence"], 1);
}

#[test]
fn a_node_lifecycle_advances_the_run_card() {
    let mut state = WorkflowRunsState::default();
    for event in [
        run_started(1),
        actor_created(2),
        node_queued(3),
        node_dispatched(4),
    ] {
        assert!(state.apply(&event));
    }
    let value = serde_json::to_value(&state).unwrap();
    let run = &value["runs"][0];
    assert_eq!(run["actors"][0]["name"], "reader");
    assert_eq!(run["actors"][0]["status"], "waiting");
    assert_eq!(run["nodes"][0]["phase"], "dispatched");
    assert_eq!(run["nodes"][0]["kind"], "ask");
    assert_eq!(run["nodes"][0]["instructionsHead"], "read the files");
    // 首次派发计一步。
    assert_eq!(run["usage"]["nodesUsed"], 1);

    assert!(state.apply(&node_settled(5)));
    let value = serde_json::to_value(&state).unwrap();
    let run = &value["runs"][0];
    assert_eq!(run["nodes"][0]["phase"], "settled");
    assert_eq!(run["nodes"][0]["outcome"], "ok");
    assert_eq!(run["actors"][0]["status"], "completed");
    assert_eq!(run["lastEventSequence"], 5);
}

#[test]
fn a_settled_run_reports_status_and_stop_reason() {
    let mut state = WorkflowRunsState::default();
    assert!(state.apply(&run_started(1)));
    assert!(state.apply(&progress(
        "run-settled",
        2,
        json!({"status": "stopped", "stopReason": "user"}),
    )));
    let value = serde_json::to_value(&state).unwrap();
    assert_eq!(value["runs"][0]["status"], "stopped");
    assert_eq!(value["runs"][0]["stopReason"], "user");
    // 停下的 run 不再可恢复（没有 resumable 键）。
    assert!(value["runs"][0].get("resumable").is_none());

    let mut errored = WorkflowRunsState::default();
    assert!(errored.apply(&progress(
        "run-settled",
        1,
        json!({"status": "errored", "error": {"message": "boom"}}),
    )));
    let value = serde_json::to_value(&errored).unwrap();
    assert_eq!(value["runs"][0]["status"], "errored");
    assert_eq!(value["runs"][0]["error"], "boom");
}

#[test]
fn an_identical_replay_emits_no_change() {
    let mut state = WorkflowRunsState::default();
    assert!(state.apply(&run_started(1)));
    assert!(!state.apply(&run_started(1)));
    let revision = state.revision;
    assert_eq!(revision, 1);
    assert_eq!(state.runs.len(), 1);
}

#[test]
fn runs_are_bounded_to_eight() {
    let mut state = WorkflowRunsState::default();
    for index in 0..9 {
        let mut event = run_started(index + 1);
        event.run_id = format!("dwfrun-{index}");
        event.tool_call_id = Some(format!("launch-{index}"));
        assert!(state.apply(&event));
    }
    assert_eq!(state.runs.len(), 8);
    // 最旧的那条被淘汰，新来的都在。
    assert!(state.runs.iter().all(|run| run.run_id != "dwfrun-0"));
    assert!(state.runs.iter().any(|run| run.run_id == "dwfrun-8"));
}

fn summary(run_id: &str, status: &str) -> WorkflowRunSummaryRow {
    WorkflowRunSummaryRow {
        run_id: run_id.to_owned(),
        tool_call_id: Some(format!("launch-{run_id}")),
        label: run_id.to_owned(),
        updated_at: Some(1),
        status: status.to_owned(),
        stop_reason: (status == "stopped").then(|| "user".to_owned()),
        resumed_from: None,
        superseded_by: None,
        failure_code: None,
        failure_message: (status == "errored").then(|| "boom".to_owned()),
        resumable: false,
    }
}

#[test]
fn a_cold_open_seeds_the_run_directory_from_journal_rows() {
    let mut state = WorkflowRunsState::default();
    // 摘要按「最近更新在前」给：补种后按创建顺序放，最后一条是最近的。
    assert!(state.seed(&[
        summary("dwfrun-2", "stopped"),
        summary("dwfrun-1", "completed")
    ]));
    let value = serde_json::to_value(&state).unwrap();
    assert_eq!(value["revision"], 1);
    assert_eq!(value["runs"][0]["runId"], "dwfrun-1");
    assert_eq!(value["runs"][0]["status"], "completed");
    assert_eq!(value["runs"][1]["runId"], "dwfrun-2");
    assert_eq!(value["runs"][1]["stopReason"], "user");
    // 活表已经有时不覆盖。
    assert!(!state.seed(&[summary("dwfrun-3", "completed")]));
    assert_eq!(state.runs.len(), 2);
}

fn view() -> SessionView {
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
        messages: Vec::new(),
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

#[test]
fn the_projection_publishes_workflow_runs_and_keeps_them_in_the_snapshot() {
    let mut projection = Projection::from_view(&view(), Followup::Queue, Vec::new());
    let deltas = projection.apply(
        &SequencedEvent {
            seq: 1,
            event: KernelEvent::WorkflowRunProgress {
                progress: run_started(1),
            },
            revision: 0,
        },
        2_000,
    );
    let patch = deltas
        .iter()
        .find(|delta| delta["op"] == "state.updated")
        .expect("state.updated");
    assert_eq!(
        patch["patch"]["workflowRuns"]["runs"][0]["runId"],
        "dwfrun-1"
    );
    assert_eq!(
        patch["patch"]["workflowRuns"]["runs"][0]["status"],
        "running"
    );

    let snapshot = projection.snapshot(1, "epoch");
    assert_eq!(snapshot["workflowRuns"]["runs"][0]["runId"], "dwfrun-1");
    assert_eq!(
        snapshot["workflowRuns"]["runs"][0]["toolCallId"],
        "launch-1"
    );
}

#[test]
fn a_projection_without_runs_omits_the_optional_key() {
    let projection = Projection::from_view(&view(), Followup::Queue, Vec::new());
    let snapshot = projection.snapshot(0, "epoch");
    assert!(snapshot.get("workflowRuns").is_none(), "{snapshot}");
}

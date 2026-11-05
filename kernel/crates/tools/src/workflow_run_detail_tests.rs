//! 情势截面四块的格式（与 Node `get-workflow-run-format*.ts` 的输出逐句对齐；行的时间用
//! `generatedAt` 的一把尺）。

use super::*;
use nibi_kernel_api::workflow::{
    WorkflowRunHealth, WorkflowRunPhaseView, WorkflowRunSubagentAsk, WorkflowRunSubagentLastTool,
    WorkflowRunSubagentView,
};

fn detail(status: &str) -> WorkflowRunDetail {
    WorkflowRunDetail {
        run_id: "dwfrun-1".to_owned(),
        label: "probe".to_owned(),
        label_source: "name",
        status: status.to_owned(),
        stop_reason: None,
        resumed_from: None,
        superseded_by: None,
        owned_by_this_session: true,
        created_at: 1_000,
        updated_at: 61_000,
        spent_tokens: 0,
        nodes: nibi_kernel_api::workflow::WorkflowRunNodeCounts {
            observed: 5,
            running: 0,
            completed: 5,
            failed: 0,
        },
        actors: Vec::new(),
        log_tail: Vec::new(),
        pending_questions: Vec::new(),
        result_text: None,
        error: None,
        max_concurrency: None,
        subagent_model: None,
        model_bindings: None,
        phases: None,
        subagents: Vec::new(),
        health: WorkflowRunHealth {
            last_progress_at: Some(60_000),
            stalled_since: None,
            concurrency: None,
            consecutive_failures: 0,
            cached_steps: 2,
            leftover_running: None,
            pending_questions_known: true,
        },
        holes: None,
        artifacts: None,
    }
}

const NOW: u64 = 61_000;

#[test]
fn the_health_block_reads_one_line_and_omits_stalled_for_terminal_runs() {
    let mut detail = detail("completed");
    let text = health_block(&detail, NOW, true);
    assert_eq!(
        text,
        "<health>last_progress=1s ago  consecutive_failures=0  cached_steps=2</health>"
    );
    detail.health.stalled_since = Some(59_000);
    detail.status = "running".to_owned();
    let text = health_block(&detail, NOW, false);
    assert_eq!(
        text,
        "<health>last_progress=1s ago  stalled=since 2s ago  consecutive_failures=0  cached_steps=2</health>"
    );
}

#[test]
fn terminal_runs_flag_leftover_running_rows() {
    let mut detail = detail("errored");
    detail.health.leftover_running = Some(2);
    let text = health_block(&detail, NOW, true);
    assert!(text.contains("The 2 \"running\" steps below are leftovers of the exited process, not live work."), "{text}");
}

#[test]
fn the_phases_table_numbers_rows_and_keeps_declared_order() {
    let mut detail = detail("completed");
    detail.phases = Some(vec![
        WorkflowRunPhaseView {
            name: "counting".to_owned(),
            state: "done".to_owned(),
            rounds: 1,
            nodes_settled: 3,
            nodes_running: 0,
            entered_at: Some(1_000),
            exited_at: Some(31_000),
        },
        WorkflowRunPhaseView {
            name: "asking".to_owned(),
            state: "unfinished".to_owned(),
            rounds: 2,
            nodes_settled: 2,
            nodes_running: 1,
            entered_at: Some(31_000),
            exited_at: None,
        },
    ]);
    let text = phases_block(&detail, NOW, true).join("\n\n");
    assert!(text.contains("1. counting  done        1 round  3 steps settled  30s"), "{text}");
    assert!(text.contains("2. asking    unfinished  2 rounds  2 settled, 1 unfinished"), "{text}");
}

#[test]
fn ahead_phases_only_carry_name_and_state() {
    let mut detail = detail("running");
    detail.phases = Some(vec![WorkflowRunPhaseView {
        name: "later".to_owned(),
        state: "ahead".to_owned(),
        rounds: 0,
        nodes_settled: 0,
        nodes_running: 0,
        entered_at: None,
        exited_at: None,
    }]);
    let text = phases_block(&detail, NOW, false).join("\n\n");
    assert_eq!(text, "<phases>\n1. later  ahead\n</phases>");
}

fn subagent(state: &str) -> WorkflowRunSubagentView {
    WorkflowRunSubagentView {
        site_id: "worker".to_owned(),
        ordinal: 1,
        name: Some("worker".to_owned()),
        state: state.to_owned(),
        phase_name: Some("asking".to_owned()),
        current_ask: None,
        wait: None,
        parked_on: None,
        steps_settled: 3,
        steps_failed: 0,
        tokens: 12_345,
        last_progress_at: None,
    }
}

#[test]
fn the_subagent_roster_lists_name_address_state_phase_and_tokens() {
    let mut detail = detail("completed");
    detail.subagents = vec![subagent("done")];
    let text = subagents_block(&detail, NOW);
    assert!(text.contains("worker  worker@1  done  phase asking  3 steps  12,345 tokens"), "{text}");
}

#[test]
fn an_empty_roster_is_one_fixed_sentence() {
    let detail = detail("completed");
    let text = subagents_block(&detail, NOW);
    assert_eq!(text, "<subagents>No subagents created yet.</subagents>");
}

#[test]
fn parked_and_waiting_and_executing_cells_diverge() {
    let mut detail = detail("running");
    let mut parked = subagent("parked");
    parked.tokens = 0;
    parked.steps_settled = 0;
    parked.parked_on = Some("dwfq-x".to_owned());
    let mut waiting = subagent("waiting");
    waiting.steps_settled = 0;
    waiting.tokens = 0;
    waiting.wait = Some(nibi_kernel_api::workflow::WorkflowRunSubagentWait {
        cause: "backoff".to_owned(),
        reason: Some("rate limited".to_owned()),
        retry_after_ms: Some(90_000),
        since: Some(60_500),
    });
    let mut executing = subagent("executing");
    executing.steps_settled = 0;
    executing.tokens = 0;
    executing.current_ask = Some(WorkflowRunSubagentAsk {
        site_id: "worker".to_owned(),
        ordinal: 1,
        actor_seq: Some(0),
        instructions_head: Some("summarize the numbers".to_owned()),
        started_at: Some(60_000),
        turn: Some(2),
        tool_calls: Some(1),
        last_tool: Some(WorkflowRunSubagentLastTool {
            name: "Read".to_owned(),
            target: Some("nibi/notes.md".to_owned()),
            at: Some(60_500),
        }),
    });
    detail.subagents = vec![parked, waiting, executing];
    let text = subagents_block(&detail, NOW);
    assert!(text.contains("worker  worker@1  parked     phase asking  on question dwfq-x"), "{text}");
    assert!(text.contains("backoff after rate limited for 0s, retry in 1m 30s"), "{text}");
    assert!(text.contains("worker@1 (step 1), 1s on this step, turn 2, 1 tool call, last Read nibi/notes.md 0s ago"), "{text}");
    assert!(text.contains("task: summarize the numbers"), "{text}");
}

#[test]
fn artifacts_render_as_notification_lines_with_the_deliverable_first() {
    let mut detail = detail("completed");
    // 顺序是存储归并层的（primary 带头）；格式器保序渲染。
    detail.artifacts = Some(vec![
        nibi_kernel_api::workflow::WorkflowRunArtifact {
            id: "summary".to_owned(),
            kind: "markdown".to_owned(),
            title: Some("Summary".to_owned()),
            version: 2,
            content_type: Some("text/markdown".to_owned()),
            bytes: Some(2048),
            item_count: 0,
            primary: Some(true),
        },
        nibi_kernel_api::workflow::WorkflowRunArtifact {
            id: "board".to_owned(),
            kind: "metrics".to_owned(),
            title: Some("Numbers".to_owned()),
            version: 1,
            content_type: None,
            bytes: None,
            item_count: 7,
            primary: None,
        },
    ]);
    let text = format_model_content(&detail, NOW);
    let start = text
        .find("<artifacts count=\"2\">")
        .map(|at| at + "<artifacts count=\"2\">".len())
        .expect("the artifacts block is present");
    let end = text[start..]
        .find("</artifacts>")
        .expect("the artifacts block closes")
        + start;
    let block = &text[start..end];
    assert!(
        block.starts_with("\n- summary (markdown, primary, v2, text/markdown, 2048 bytes): Summary"),
        "{block}"
    );
    assert!(block.contains("- board (metrics, v1, 7 items): Numbers"), "{block}");
}

#[test]
fn identity_blocks_carry_the_run_level_settings_and_script_models() {
    let mut detail = detail("running");
    detail.subagent_model = Some("drive-fake/fake-model-b$enabled".to_owned());
    detail.model_bindings = Some(serde_json::json!({"fake-model-b": "drive-fake/fake-model-b$enabled"}));
    detail.max_concurrency = Some(2);
    let text = format_model_content(&detail, NOW);
    assert!(text.contains("<max_concurrency>2</max_concurrency>"), "{text}");
    assert!(text.contains("<subagent_model>drive-fake/fake-model-b$enabled</subagent_model>"), "{text}");
    assert!(
        text.contains("<script_models>\n\"fake-model-b\" = drive-fake/fake-model-b$enabled\n</script_models>"),
        "{text}"
    );
}

#[test]
fn hole_blocks_route_to_fill_workflow_hole_only_when_waiting() {
    let mut detail = detail("running");
    detail.holes = Some(vec![nibi_kernel_api::workflow::WorkflowRunHole {
        site_id: "hole#21b40fca".to_owned(),
        ordinal: 1,
        name: "fill the verdict".to_owned(),
        hole_type: "Verdict".to_owned(),
        state: "waiting".to_owned(),
        since: Some(60_000),
        filled_at: None,
        filled_by: None,
    }]);
    let text = hole_blocks(&detail, NOW).join("\n\n");
    assert!(text.starts_with("<holes>\n[hole#21b40fca] \"fill the verdict\": Verdict — waiting 1s"), "{text}");
    assert!(text.contains("call FillWorkflowHole with run_id=\"dwfrun-1\" and the hole id in brackets as hole_id."), "{text}");
    // 全补完：引导句换成收尾那句。
    detail.holes.as_mut().unwrap()[0].state = "filled".to_owned();
    detail.holes.as_mut().unwrap()[0].filled_at = Some(60_500);
    let text = hole_blocks(&detail, NOW).join("\n\n");
    assert!(text.contains("— filled 0s ago"), "{text}");
    assert!(text.contains(HOLES_ALL_FILLED_INSTRUCTION), "{text}");
}

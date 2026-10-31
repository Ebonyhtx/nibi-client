//! 终态通知文本的逐字钉子（与 Node `formatLocalWorkflowTaskNotification` 同形）。

use super::*;
use serde_json::json;

fn facts() -> RunNoticeFacts {
    RunNoticeFacts {
        name: Some("probe".to_owned()),
        ..RunNoticeFacts::default()
    }
}

#[test]
fn a_completed_run_reads_as_the_full_envelope_with_guidance() {
    let settlement = json!({"status": "completed", "artifact": "the worker said hi"});
    let text = compose_run_settled_notice("dwfrun-1", Some("launch-abc"), &facts(), &settlement)
        .expect("completed composes");
    assert_eq!(
        text,
        "<task-notification>\n\
         <task-id>dwfrun-1</task-id>\n\
         <tool-use-id>launch-abc</tool-use-id>\n\
         <status>completed</status>\n\
         <description>probe</description>\n\
         <summary>Workflow &quot;probe&quot; completed.</summary>\n\
         <result>the worker said hi</result>\n\
         </task-notification>\n\
         \n\
         The workflow completed. Present its outcome to the user as a deliverable, in this order: the conclusion; each finding with its evidence (path and line, or the command and output that showed it); which findings were confirmed by a deterministic check or an independent subagent and which are judged only; what the run did not cover.\n\
         The reported items above are individual findings: present them individually and keep their evidence. When the preview is partial (count greater than shown), say so and read the rest with GetWorkflowRun.\n\
         Do not restate the phase graph or the script."
    );
}

#[test]
fn an_unnamed_run_falls_back_to_the_run_id_as_subject() {
    let settlement = json!({"status": "completed", "artifact": {"answer": 2}});
    let text = compose_run_settled_notice("dwfrun-9", None, &RunNoticeFacts::default(), &settlement)
        .expect("completed composes");
    assert!(text.contains("<description>dwfrun-9</description>"), "{text}");
    assert!(text.contains("<summary>Workflow &quot;dwfrun-9&quot; completed.</summary>"), "{text}");
    // 非字符串产物是两空格缩进的 JSON。
    assert!(text.contains("<result>{
  &quot;answer&quot;: 2
}</result>"), "{text}");
}

#[test]
fn a_user_stopped_run_says_do_not_resume() {
    let settlement = json!({"status": "stopped", "reason": "user"});
    let text = compose_run_settled_notice("dwfrun-2", None, &facts(), &settlement)
        .expect("stopped composes");
    assert!(text.contains("<status>stopped</status>"), "{text}");
    assert!(text.contains("<stop-reason>user</stop-reason>"), "{text}");
    assert!(text.contains("<summary>Workflow &quot;probe&quot; was stopped by the user.</summary>"), "{text}");
    assert!(
        text.contains(
            "The user stopped this workflow on purpose. Do not resume it with ResumeWorkflowRun and do not amend or rebuild it unless the user asks you to.",
        ),
        "{text}"
    );
}

#[test]
fn an_errored_run_points_at_amend_with_the_script_path() {
    let settlement = json!({"status": "errored", "error": {"code": "ValidationFailed", "message": "boom"}});
    let mut my_facts = facts();
    my_facts.script_path = Some("D:/repo/.nibi/workflows/probe.dwf.ts".to_owned());
    let text = compose_run_settled_notice("dwfrun-3", Some("launch-1"), &my_facts, &settlement)
        .expect("errored composes");
    assert!(text.contains("<status>errored</status>"), "{text}");
    assert!(text.contains("<summary>Workflow &quot;probe&quot; errored: the script failed.</summary>"), "{text}");
    assert!(text.contains("<error>boom</error>"), "{text}");
    assert!(
        text.contains(
            "The run's script is at D:/repo/.nibi/workflows/probe.dwf.ts. Edit that file in place, then call AmendWorkflow (run_id=\"dwfrun-3\", path=\"D:/repo/.nibi/workflows/probe.dwf.ts\") so finished work is reused — do not paste the script inline."
        ),
        "{text}"
    );
}

#[test]
fn a_provider_stop_renders_the_table_driven_error_block() {
    let settlement = json!({
        "status": "stopped",
        "reason": "provider",
        "error": {
            "code": "ProviderStop",
            "message": "the relay said no",
            "providerStop": {
                "kind": "quota",
                "providerId": "drive-fake",
                "subagent": "worker",
                "phase": "asking",
                "modelId": "fake-model-b",
                "providerCode": "429",
            },
        },
    });
    let text = compose_run_settled_notice("dwfrun-4", None, &facts(), &settlement)
        .expect("provider stop composes");
    assert!(
        text.contains(
            "<error>\ndrive-fake reports the user's quota is exhausted (code 429).\nAsk the user to top up or upgrade the plan, or switch to another provider, then call ResumeWorkflowRun with run_id=\"dwfrun-4\".\nprovider=drive-fake model=fake-model-b subagent=worker phase=asking code=429\n</error>"
        ),
        "{text}"
    );
    assert!(
        text.contains("Then resolve the cause with the user before calling ResumeWorkflowRun with run_id=\"dwfrun-4\" — finished steps replay from the journal. Do not rebuild the workflow."),
        "{text}"
    );
}

#[test]
fn reports_carry_the_true_count_and_a_budgeted_preview() {
    let settlement = json!({"status": "completed", "artifact": "done"});
    let mut my_facts = facts();
    my_facts.reports = (1..=3)
        .map(|index| json!(format!("finding {index}")))
        .collect();
    my_facts.report_count = 11;
    let text = compose_run_settled_notice("dwfrun-5", None, &my_facts, &settlement)
        .expect("completed composes");
    assert!(text.contains("<reports count=\"11\" shown=\"3\">"), "{text}");
    assert!(text.contains("[1] finding 1
[2] finding 2
[3] finding 3"), "{text}");
    assert!(text.contains("</reports>"), "{text}");
}

#[test]
fn a_zero_report_run_has_no_reports_section() {
    let settlement = json!({"status": "completed", "artifact": "done"});
    let text = compose_run_settled_notice("dwfrun-6", None, &facts(), &settlement)
        .expect("completed composes");
    assert!(!text.contains("<reports"), "{text}");
}

#[test]
fn artifacts_merge_versions_and_lead_with_primary() {
    let settlement = json!({"status": "completed", "artifact": "done"});
    let mut my_facts = facts();
    my_facts.artifacts = vec![
        json!({"id": "board", "kind": "metrics", "title": "Numbers", "version": 1, "itemCount": 7}),
        json!({"id": "summary", "kind": "markdown", "title": "Summary", "version": 2, "contentType": "text/markdown", "bytes": 2048, "primary": true}),
        json!({"id": "board", "kind": "metrics", "title": "Numbers", "version": 2, "itemCount": 9}),
    ];
    let text = compose_run_settled_notice("dwfrun-7", None, &my_facts, &settlement)
        .expect("completed composes");
    assert!(text.contains("<artifacts count=\"2\">"), "{text}");
    // primary 带头；board 取最新版本；预置看板是点数不是字节。
    assert!(
        text.contains(
            "- summary (markdown, primary, v2, text/markdown, 2048 bytes): Summary\n- board (metrics, v2, 9 items): Numbers"
        ),
        "{text}"
    );
}

#[test]
fn xml_metacharacters_are_escaped_but_the_error_block_keeps_quotes() {
    let settlement = json!({"status": "completed", "artifact": "a <b> & \"c\" 'd'"});
    let text = compose_run_settled_notice("dwfrun-8", None, &facts(), &settlement)
        .expect("completed composes");
    assert!(
        text.contains("<result>a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;</result>"),
        "{text}"
    );
}

#[test]
fn non_terminal_settlements_are_not_delivered() {
    let facts = facts();
    assert_eq!(
        compose_run_settled_notice("dwfrun-1", None, &facts, &json!({"status": "running"})),
        None
    );
}

#[test]
fn the_iso_helper_matches_node_date_to_isostring() {
    assert_eq!(iso_millis("0"), "1970-01-01T00:00:00.000Z");
    // 2026-10-31T00:00:00.000Z 的 epoch 毫秒。
    assert_eq!(iso_millis("1793404800000"), "2026-10-31T00:00:00.000Z");
}

//! 终态通知文本的逐字钉子（与 Node `formatLocalWorkflowTaskNotification` 同形）。

use super::*;
use serde_json::json;

fn facts() -> RunNoticeFacts {
    RunNoticeFacts {
        name: Some("probe".to_owned()),
        duration_ms: Some(12),
        ..RunNoticeFacts::default()
    }
}

/// stall 通知文本的逐字钉子：三案输入与 Node `formatWorkflowStallNotification`（
/// core/runtime-task/workflow-notification-copy.ts）的实测输出逐字节对拍——同一个纯函数
/// 跑两边，字节不同即真分歧（fixture 级对拍；stall 钟在 sidecar 跑真 20 分钟墙钟，活探针
/// 等可注入阈值再接）。
#[test]
fn a_stall_notice_reads_as_the_full_envelope_with_reason_and_cap() {
    let stall = json!({"sinceMs": 1_200_001, "reason": "rate_limit", "cap": 3});
    let (text, manifest) =
        compose_stall_notice("dwfrun_stall1", Some("holeprobe"), &stall).expect("stall composes");
    assert_eq!(
        text,
        "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\
         This is an automated workflow event, NOT a message from the user.\n\
         Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\
         \n\
         <workflow-stall>\n  \
         <run-id>dwfrun_stall1</run-id>\n  \
         <run>holeprobe</run>\n  \
         <since-ms>1200001</since-ms>\n  \
         <dominant-reason>rate_limit</dominant-reason>\n  \
         <cap>3</cap>\n\
         </workflow-stall>\n\
         \n\
         Workflow run holeprobe (dwfrun_stall1) has not completed a model request in 20 minutes; the provider keeps answering rate_limit and the run is retrying with backoff (current fan-out 3).\n\
         It is still running and needs nothing from you. Tell the user if they are waiting on it; they can stop it from the run card. Do not cancel or rebuild it on your own."
    );
    assert_eq!(
        manifest,
        json!({"kind": "stall", "sinceMs": 1_200_001, "reason": "rate_limit", "cap": 3})
    );
}

#[test]
fn a_stall_without_reason_and_cap_says_the_provider_fails() {
    let stall = json!({"sinceMs": 20 * 60_000});
    let (text, manifest) = compose_stall_notice("dwfrun_stall2", None, &stall).expect("stall composes");
    // 展示名缺席落 runId；缺 reason 走「provider keeps failing」句；缺 cap 省括号。
    assert_eq!(
        text,
        "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\
         This is an automated workflow event, NOT a message from the user.\n\
         Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\
         \n\
         <workflow-stall>\n  \
         <run-id>dwfrun_stall2</run-id>\n  \
         <run>dwfrun_stall2</run>\n  \
         <since-ms>1200000</since-ms>\n\
         </workflow-stall>\n\
         \n\
         Workflow run dwfrun_stall2 (dwfrun_stall2) has not completed a model request in 20 minutes; the provider keeps failing requests and the run is retrying with backoff.\n\
         It is still running and needs nothing from you. Tell the user if they are waiting on it; they can stop it from the run card. Do not cancel or rebuild it on your own."
    );
    // manifest 的 reason/cap 缺席省键。
    assert_eq!(manifest, json!({"kind": "stall", "sinceMs": 1_200_000}));
}

#[test]
fn a_stall_escapes_xml_only_in_the_structured_half_and_clamps_minutes() {
    let stall = json!({"sinceMs": 59_999, "reason": "server_error"});
    let (text, _manifest) =
        compose_stall_notice("dwfrun_stall3", Some("weird<&>\"run"), &stall).expect("stall composes");
    // 结构化半段转义、散文半段原样（Node 的同一条分界）；59_999ms 取整后钳到 1（Node
    // Math.max(1, Math.round(...))，不单数化——"1 minutes" 逐字）。
    assert!(text.contains("<run>weird&lt;&amp;&gt;&quot;run</run>"), "{text}");
    assert!(
        text.contains(
            "Workflow run weird<&>\"run (dwfrun_stall3) has not completed a model request in 1 minutes; the provider keeps answering server_error and the run is retrying with backoff."
        ),
        "{text}"
    );
}

#[test]
fn a_malformed_stall_payload_is_skipped_not_composed() {
    // Node notifyRunStalled 的同一条纪律：sinceMs 缺席 / 非数 / 负数 → 跳过（宿主记日志）。
    for bad in [
        json!({}),
        json!({"sinceMs": "soon"}),
        json!({"sinceMs": -5}),
    ] {
        assert!(compose_stall_notice("r", Some("n"), &bad).is_none(), "{bad}");
    }
}

#[test]
fn a_completed_run_reads_as_the_full_envelope_with_guidance() {
    let settlement = json!({"status": "completed", "artifact": "the worker said hi"});
    let (text, _manifest) = compose_run_settled_notice("dwfrun-1", Some("launch-abc"), &facts(), &settlement)
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
    let (text, _manifest) = compose_run_settled_notice("dwfrun-9", None, &RunNoticeFacts::default(), &settlement)
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
    let (text, _manifest) = compose_run_settled_notice("dwfrun-2", None, &facts(), &settlement)
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
    let (text, _manifest) = compose_run_settled_notice("dwfrun-3", Some("launch-1"), &my_facts, &settlement)
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
    let (text, _manifest) = compose_run_settled_notice("dwfrun-4", None, &facts(), &settlement)
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
    let (text, _manifest) = compose_run_settled_notice("dwfrun-5", None, &my_facts, &settlement)
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
    let (text, _manifest) = compose_run_settled_notice("dwfrun-6", None, &facts(), &settlement)
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
    let (text, _manifest) = compose_run_settled_notice("dwfrun-7", None, &my_facts, &settlement)
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
    let (text, _manifest) = compose_run_settled_notice("dwfrun-8", None, &facts(), &settlement)
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

/// manifest 载荷（`originMeta.workflowNotification`）：summary/result/resultForm 与产物 chips。
#[test]
fn the_manifest_carries_the_terminal_payload_and_chips() {
    let settlement = json!({"status": "completed", "artifact": "the answer"});
    let mut my_facts = facts();
    my_facts.artifacts = vec![json!({
        "id": "summary", "kind": "markdown", "title": "Summary", "version": 2,
        "contentType": "text/markdown", "bytes": 2048, "primary": true,
        "description": "the deliverable",
    })];
    let (text, manifest) =
        compose_run_settled_notice("dwfrun-1", None, &my_facts, &settlement).expect("composes");
    assert!(text.contains("<result>the answer</result>"), "{text}");
    assert_eq!(
        manifest,
        json!({
            "kind": "terminal",
            "status": "completed",
            "summary": "probe",
            "result": "the answer",
            "resultForm": "prose",
            "artifacts": [{
                "id": "summary", "kind": "markdown", "title": "Summary",
                "version": 2, "contentType": "text/markdown", "primary": true,
                "description": "the deliverable",
            }],
            "durationMs": 12,
        }),
    );
}

/// manifest 的界：result 超 4k 截断并带 resultTruncated；未知 kind 的 chip 整条丢；
/// artifactsTruncated 是「画出来的比总数少」。
#[test]
fn the_manifest_bounds_and_kind_filter_follow_the_shared_schema() {
    let settlement = json!({"status": "completed", "artifact": "x".repeat(5_000)});
    let mut my_facts = facts();
    my_facts.artifacts = vec![
        json!({"id": "odd", "kind": "mystery", "title": "?", "version": 1}),
        json!({"id": "board", "kind": "metrics", "title": "N", "version": 1, "itemCount": 3}),
    ];
    let (_, manifest) =
        compose_run_settled_notice("dwfrun-1", None, &my_facts, &settlement).expect("composes");
    assert_eq!(manifest["resultTruncated"], json!(true));
    assert_eq!(manifest["result"].as_str().map(|s| s.chars().count()), Some(4_000));
    // 未知 kind 整条丢；剩下的那条构成截断诚实（画出来的比总数少）。
    assert_eq!(manifest["artifacts"].as_array().unwrap().len(), 1);
    assert_eq!(manifest["artifacts"][0]["id"], json!("board"));
    assert_eq!(manifest["artifactsTruncated"], json!(true));
    assert_eq!(manifest["durationMs"], json!(12));
}

/// 留白到达的通知：信封逐字 + manifest（kind:"hole"）与 Node 的对象字面量同形。
#[test]
fn the_hole_notification_reads_as_the_full_envelope_with_a_hole_manifest() {
    let hole = json!({
        "instance": {"siteId": "hole#abc123", "ordinal": 1},
        "name": "fill the verdict",
        "prompt": "What should I return for the probe?",
        "type": "Plan",
        "line": 5,
        "reachedAt": 1793440930389u64,
    });
    let (text, manifest) = compose_hole_reached_notice(
        "dwfrun-1",
        &hole,
        Some("holeprobe"),
        Some("D:/repo/.nibi/workflows/holeprobe.dwf.ts"),
    )
    .expect("composes");
    assert!(text.contains("<workflow-hole>"), "{text}");
    assert!(text.contains("  <run>holeprobe</run>"), "{text}");
    assert!(text.contains("  <hole-id>hole#abc123</hole-id>"), "{text}");
    assert!(text.contains("  <type>Plan</type>"), "{text}");
    assert!(text.contains("  <prompt>What should I return for the probe?</prompt>"), "{text}");
    assert!(text.contains("  <draft>D:/repo/.nibi/workflows/holeprobe.dwf.ts</draft>"), "{text}");
    assert!(text.contains("  <line>5</line>"), "{text}");
    assert!(
        text.contains("Workflow run holeprobe (dwfrun-1) reached the hole \"fill the verdict\" (hole#abc123) and is waiting for you to write its body."),
        "{text}"
    );
    assert!(
        text.contains("call FillWorkflowHole with run_id=\"dwfrun-1\" and hole_id=\"hole#abc123\" and the body as `script`."),
        "{text}"
    );
    assert_eq!(
        manifest,
        json!({
            "kind": "hole",
            "siteId": "hole#abc123",
            "ordinal": 1,
            "name": "fill the verdict",
            "type": "Plan",
            "prompt": "What should I return for the probe?",
            "draftPath": "D:/repo/.nibi/workflows/holeprobe.dwf.ts",
            "line": 5,
            "reachedAt": 1793440930389u64,
        }),
    );
}

/// 无脚本文件的 run：draft 句退回 GetWorkflowRun；type 缺席占位 unknown。
#[test]
fn the_hole_notification_falls_back_without_a_script_file() {
    let hole = json!({
        "instance": {"siteId": "hole#x", "ordinal": 2},
        "name": "next",
    });
    let (text, manifest) =
        compose_hole_reached_notice("dwfrun-2", &hole, None, None).expect("composes");
    assert!(text.contains("Next step: Read the run's script with GetWorkflowRun for the context"), "{text}");
    assert!(text.contains("  <type>unknown</type>"), "{text}");
    assert_eq!(manifest["type"], json!("unknown"));
    assert!(manifest.get("draftPath").is_none());
    assert!(manifest.get("line").is_none());
}

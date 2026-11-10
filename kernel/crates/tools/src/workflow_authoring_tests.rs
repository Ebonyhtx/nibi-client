//! 作者工具面的纯函数与契约测试（引擎在 sidecar，这里只测内核这一半）。

use nibi_kernel_api::ids::{MessageId, ToolUseId};
use nibi_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, ToolResultContent, UserMessage, UserOrigin,
};
use serde_json::json;

use super::{amend_is_owned, iso_timestamp, skill_loaded_in};

fn assistant(calls: &[(&str, &str, serde_json::Value)]) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new("m1"),
        content: calls
            .iter()
            .map(|(id, name, input)| ContentBlock::ToolUse {
                id: ToolUseId::new(*id),
                name: (*name).to_owned(),
                input: input.clone(),
            })
            .collect(),
        model: "test".to_owned(),
        stop_reason: None,
        usage: None,
    })
}

fn result(tool_use: &str, is_error: bool) -> Message {
    Message::User(UserMessage {
        id: MessageId::new("u1"),
        content: vec![ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new(tool_use),
            content: vec![ToolResultContent::Text {
                text: "Launching skill".to_owned(),
            }],
            is_error,
        }],
        origin: UserOrigin::ToolResult {
            assistant: MessageId::new("m1"),
        },
    })
}

#[test]
fn the_skill_gate_reads_the_visible_history() {
    let called = vec![
        assistant(&[("t1", "Skill", json!({"skill": "dynamic-workflows"}))]),
        result("t1", false),
    ];
    assert!(skill_loaded_in(&called, "dynamic-workflows"));
    // 调用失败不算读过。
    assert!(!skill_loaded_in(
        &[
            assistant(&[("t1", "Skill", json!({"skill": "dynamic-workflows"}))]),
            result("t1", true),
        ],
        "dynamic-workflows"
    ));
    // 压缩后历史里没有那次调用：门重新关上。
    assert!(!skill_loaded_in(&called[1..], "dynamic-workflows"));
    // 别的 skill 不算。
    assert!(!skill_loaded_in(
        &[
            assistant(&[("t1", "Skill", json!({"name": "other"}))]),
            result("t1", false),
        ],
        "dynamic-workflows"
    ));
}

#[test]
fn owned_amend_matches_the_node_predicate() {
    assert!(amend_is_owned(&json!({
        "owned_by_this_session": true,
        "status": "running"
    })));
    assert!(!amend_is_owned(&json!({
        "owned_by_this_session": true,
        "stop_reason": "user"
    })));
    assert!(!amend_is_owned(&json!({
        "owned_by_this_session": true,
        "introduces_providers": ["other"]
    })));
    assert!(!amend_is_owned(&json!({"owned_by_this_session": false})));
}

#[test]
fn list_timestamps_match_node_date_to_iso_string() {
    assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_timestamp(1_792_231_650_123), "2026-10-17T10:07:30.123Z");
    // 闰日。
    assert_eq!(iso_timestamp(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
}

/// Eval/Resume 的模型入参必须被 Rust 的 schema 校验接受（真机 bug：它们曾共用空 schema，
/// `code`/`path`/`run_id` 都被判成「不认识的参数」，工具处理器根本没机会运行）。
#[test]
fn eval_and_resume_schemas_accept_their_real_fields() {
    use crate::validate::validate;
    use super::Kind;
    assert!(
        validate(
            "EvalWorkflowSnippet",
            &Kind::Eval.schema(),
            &json!({"code": "return 1;"})
        )
        .is_none()
    );
    assert!(
        validate(
            "EvalWorkflowSnippet",
            &Kind::Eval.schema(),
            &json!({"path": "snippet.ts", "timeoutMs": 5000})
        )
        .is_none()
    );
    assert!(
        validate(
            "ResumeWorkflowRun",
            &Kind::Resume.schema(),
            &json!({"run_id": "dwfrun-1"})
        )
        .is_none()
    );
    assert!(
        validate("ResumeWorkflowRun", &Kind::Resume.schema(), &json!({})).is_some()
    );
}

#[test]
fn list_rows_carry_the_node_attributes() {
    use nibi_kernel_api::workflow::WorkflowRunListRow;
    let row = WorkflowRunListRow {
        run_id: "dwfrun-1".to_owned(),
        name: None,
        script_text: Some("// probe\nreturn 1;".to_owned()),
        status: "completed".to_owned(),
        stop_reason: None,
        resumed_from: Some("dwfrun-0".to_owned()),
        superseded_by: None,
        parent_session_id: Some("s1".to_owned()),
        created_at: 1_792_231_650_000,
        updated_at: 1_792_231_651_000,
        spent_tokens: 7,
    };
    let value = super::run_row(&row, "s1");
    assert_eq!(value["label"], "// probe");
    assert_eq!(value["labelSource"], "script");
    assert_eq!(value["ownedByThisSession"], true);
    assert!(value.get("possiblyInterrupted").is_none());
    let line = super::run_line(&value);
    assert!(line.contains("label=\"// probe\""), "{line}");
    assert!(line.contains("label_source=\"script\""), "{line}");
    assert!(line.contains("owned_by_this_session=\"true\""), "{line}");
    assert!(line.contains("resumed_from=\"dwfrun-0\""), "{line}");
    assert!(line.contains("spent_tokens=\"7\""), "{line}");
    assert!(
        line.contains("created_at=\"2026-10-17T10:07:30.000Z\""),
        "{line}"
    );
}

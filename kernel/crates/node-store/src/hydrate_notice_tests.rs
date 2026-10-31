//! Node 写的后台通知记录跨库读回：文本进模型上下文、origin 按通知来源还原
//! （Node `getConversationMessageProjectionPolicy` 的 providerContextOnly 判据 + 触发源拼写）。

use std::borrow::Cow;

use rust_cli_kernel_api::message::{Message, UserOrigin};
use serde_json::{Value, json};

use crate::hydrate::hydrate;
use crate::repo::messages::WithParts;

fn notice_record(source: &str, text: &str) -> WithParts {
    WithParts {
        info: json!({
            "id": "msg_notice", "sessionID": "s", "role": "user",
            "time": {"created": 1}, "agent": "zcode-agent",
            "metadata": {
                "source": source,
                "inputPresentation": "task_notification",
                "visibility": "model-only",
            },
            "source": source,
            "semantics": {
                "origin": "agent_runtime", "kind": "system_reminder", "source": source,
                "uiVisibility": "hidden", "providerVisibility": "visible",
                "transcriptVisibility": "hidden",
            },
            "synthetic": true,
            "visibility": "model-only",
            "tools": {},
        }),
        parts: vec![json!({
            "id": "part_1", "sessionID": "s", "messageID": "msg_notice",
            "type": "text", "text": text,
            "synthetic": true,
            "time": {"start": 1, "end": 1},
            "metadata": {"source": source, "visibility": "model-only"},
        })],
    }
}

fn notice_text(message: &Message) -> String {
    let Message::User(user) = message else {
        panic!("expected a user message: {message:?}");
    };
    user.content
        .iter()
        .filter_map(|block| match block {
            rust_cli_kernel_api::message::ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_node_written_task_notification_keeps_its_text_and_notice_origin() {
    for source in ["background_task", "task_notification"] {
        let messages = hydrate(&[Cow::Owned(notice_record(
            source,
            "<task-notification>\n<task-id>r</task-id>\n</task-notification>",
        ))]);
        assert_eq!(messages.len(), 1, "{source}");
        let Message::User(user) = &messages[0] else {
            panic!("expected a user message for {source}");
        };
        assert!(
            matches!(&user.origin, UserOrigin::Meta { origin_meta: None, source: kept } if kept == source),
            "{source}: {:?}",
            user.origin
        );
        assert!(notice_text(&messages[0]).contains("<task-notification>"), "{source}");
    }
}

#[test]
fn synthetic_records_outside_the_trigger_set_stay_hidden() {
    // providerVisible 但不是通知触发源（todo_reminder 这一类）：照旧不进模型上下文。
    let messages = hydrate(&[Cow::Owned(notice_record(
        "todo_reminder",
        "<system-reminder>todo</system-reminder>",
    ))]);
    assert!(messages.is_empty());
}

#[test]
fn a_hidden_synthetic_without_provider_visibility_stays_hidden() {
    let mut record = notice_record("background_task", "<task-notification>x</task-notification>");
    record.info["semantics"]["providerVisibility"] = Value::String("hidden".into());
    record.info["visibility"] = Value::String("hidden".into());
    assert!(hydrate(&[Cow::Owned(record)]).is_empty());
}

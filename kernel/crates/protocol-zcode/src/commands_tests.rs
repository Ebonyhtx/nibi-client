use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use serde_json::json;

use super::*;

fn selection(provider: &str, model: &str, reasoning: Option<&str>) -> ModelSelection {
    ModelSelection {
        provider: provider.to_owned(),
        model: model.to_owned(),
        reasoning: reasoning.map(str::to_owned),
        connection: None,
    }
}

#[test]
fn cas_check_only_fires_on_revision_mismatch() {
    let current = cas_check_with_epoch("c1", Some(7), None, 7, "epoch-1", false);
    assert!(current.is_none());
    let stale = cas_check_with_epoch("c1", Some(6), None, 7, "epoch-1", false).unwrap();
    assert_eq!(stale.status, Status::Stale);
    assert_eq!(stale.reason_code.as_deref(), Some("proto.staleRevision"));
    assert_eq!(stale.revision_at_decision, 7);
    // 缺 baseRevision 的命令在 schema 层就被拒；这里双保险同样按 stale 处理。
    let missing = cas_check_with_epoch("c1", None, None, 7, "epoch-1", false).unwrap();
    assert_eq!(missing.status, Status::Stale);
}

#[test]
fn cas_check_rejects_epoch_mismatch_only_for_row_targeting() {
    // revision 对、epoch 错：compare_epoch=true 才拒。
    let ok = cas_check_with_epoch("c1", Some(7), Some("epoch-1"), 7, "epoch-1", true);
    assert!(ok.is_none());
    let stale_epoch =
        cas_check_with_epoch("c1", Some(7), Some("epoch-0"), 7, "epoch-1", true).unwrap();
    assert_eq!(stale_epoch.status, Status::Stale);
    assert_eq!(
        stale_epoch.reason_code.as_deref(),
        Some("proto.staleLogEpoch")
    );
    // 同样的 epoch 错，在非 row-targeting 命令上不比。
    let ignored = cas_check_with_epoch("c1", Some(7), Some("epoch-0"), 7, "epoch-1", false);
    assert!(ignored.is_none());
}

#[test]
fn model_config_selection_maps_the_flat_nibi_payload() {
    let chosen = model_config_selection(&json!({
        "provider": "zai-standard-api",
        "model": "glm-5.3-flash",
        "thought": "max"
    }))
    .unwrap();
    assert_eq!(
        chosen,
        selection("zai-standard-api", "glm-5.3-flash", Some("max"))
    );

    // schema 要求 thought 必带；处理器对缺省保持宽容（reasoning=None，同上游 selection()），
    // 类型错了仍然 None。
    assert_eq!(
        model_config_selection(&json!({"provider": "p", "model": "m"})),
        Some(selection("p", "m", None))
    );
    assert!(
        model_config_selection(&json!({"provider": 1, "model": "m", "thought": "max"})).is_none()
    );
}

#[test]
fn collaboration_mode_reuses_the_send_text_mapping() {
    assert_eq!(
        mode(&json!("plan"), None),
        Some((PermissionMode::Default, true))
    );
    assert_eq!(
        mode(&json!("yolo"), None),
        Some((PermissionMode::BypassPermissions, false))
    );
    assert_eq!(mode(&json!("stealth"), None), None);
}

#[test]
fn retry_target_resolves_the_latest_turn_and_rejects_history() {
    use rust_cli_kernel_api::ids::MessageId;
    use rust_cli_kernel_api::message::{
        AssistantMessage, ContentBlock, Message, UserMessage, UserOrigin,
    };

    fn user(id: &str, text: &str) -> Message {
        Message::User(UserMessage {
            id: MessageId::new(id),
            content: vec![ContentBlock::Text {
                text: text.to_owned(),
            }],
            origin: UserOrigin::Human,
        })
    }
    fn assistant(id: &str) -> Message {
        Message::Assistant(AssistantMessage {
            id: MessageId::new(id),
            content: vec![],
            model: String::new(),
            stop_reason: None,
            usage: None,
        })
    }

    // 最后一轮：user → assistant。命中并取到原文。
    let messages = vec![
        user("u1", "first"),
        assistant("a1"),
        user("u2", "second"),
        assistant("a2"),
    ];
    let target = retry_target(&messages).unwrap();
    assert_eq!(target.user_message, "u2");
    assert_eq!(target.text, "second");

    // 最后一条不是 assistant：latest 守卫（历史回复 retry 会回退 active branch）。
    let with_tail = vec![
        user("u1", "first"),
        assistant("a1"),
        user("u2", "second"),
        assistant("a2"),
        user("u3", "follow-up"),
    ];
    let error = retry_target(&with_tail).unwrap_err();
    assert!(
        error.starts_with("guard.latestAssistantRetryOnly"),
        "{error}"
    );

    // 空会话。
    let empty: Vec<rust_cli_kernel_api::message::Message> = vec![];
    assert!(retry_target(&empty).is_err());

    // assistant 前没有 user 输入。
    let messages = vec![assistant("a1")];
    assert!(retry_target(&messages).is_err());

    // user 消息没有文本：不能重发空输入。
    let empty = Message::User(UserMessage {
        id: MessageId::new("u1"),
        content: vec![],
        origin: UserOrigin::Human,
    });
    let messages = vec![empty, assistant("a1")];
    let error = retry_target(&messages).unwrap_err();
    assert!(error.contains("no text"), "{error}");
}

#[test]
fn edit_target_guard_only_accepts_the_latest_real_query() {
    use rust_cli_kernel_api::ids::MessageId;
    use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};

    fn human(id: &str, text: &str) -> Message {
        Message::User(UserMessage {
            id: MessageId::new(id),
            content: vec![ContentBlock::Text {
                text: text.to_owned(),
            }],
            origin: UserOrigin::Human,
        })
    }
    fn assistant(id: &str) -> Message {
        Message::Assistant(rust_cli_kernel_api::message::AssistantMessage {
            id: MessageId::new(id),
            content: vec![],
            model: String::new(),
            stop_reason: None,
            usage: None,
        })
    }

    let messages = vec![
        human("u1", "first"),
        assistant("a1"),
        human("u2", "second"),
        assistant("a2"),
    ];
    assert!(edit_target_guard(&messages, "u2").is_ok());
    let error = edit_target_guard(&messages, "u1").unwrap_err();
    assert!(error.starts_with("guard.latestQueryEditOnly"), "{error}");
    // 没有 real user query。
    let messages = vec![assistant("a1")];
    assert!(edit_target_guard(&messages, "a1").is_err());
}

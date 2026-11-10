use super::*;
use nibi_kernel_api::message::AssistantMessage;

fn assistant(id: &str, usage: Usage) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: "ok".to_owned(),
        }],
        model: "test".to_owned(),
        stop_reason: None,
        usage: Some(usage),
    })
}

fn user(id: &str) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: "hi".to_owned(),
        }],
        origin: UserOrigin::Human,
    })
}

fn usage(input: u64, output: u64, read: u64, write: u64) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
    }
}

#[test]
fn every_main_request_in_the_turn_is_summed_not_just_the_last() {
    let messages = vec![
        assistant("before", usage(999, 999, 999, 999)),
        user("prompt"),
        assistant("tool_round", usage(30_945, 643, 0, 0)),
        assistant("final", usage(231, 567, 31_488, 0)),
    ];
    assert_eq!(
        turn_usage(&messages, Some(&MessageId::new("prompt"))),
        Some(usage(31_176, 1_210, 31_488, 0))
    );
}

#[test]
fn without_a_prompt_the_last_usage_is_kept_for_control_turns() {
    let messages = vec![
        user("prompt"),
        assistant("final", usage(10, 2, 8, 0)),
    ];
    assert_eq!(
        turn_usage(&messages, None),
        Some(usage(10, 2, 8, 0))
    );
}

#[test]
fn a_turn_without_usage_does_not_leak_the_previous_turn() {
    let messages = vec![
        assistant("before", usage(10, 2, 8, 0)),
        user("prompt"),
    ];
    assert_eq!(turn_usage(&messages, Some(&MessageId::new("prompt"))), None);
}

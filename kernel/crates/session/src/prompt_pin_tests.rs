//! 会话钉住的模型可见输入（R09）：新建、冷打开与压缩后重钉。
use nibi_kernel_api::ids::MessageId;
use nibi_kernel_api::message::{CompactBoundary, CompactTrigger, UserMessage, UserOrigin};
use nibi_kernel_api::session_prompt::FrontendTraits;

use super::*;

fn kernel(append: &str) -> Arc<SessionPrompt> {
    let traits = FrontendTraits {
        shell_escape: true,
        ..FrontendTraits::default()
    };
    Arc::new(SessionPrompt::new(None, Some(append.to_owned()), traits))
}

fn recorded(append: &str) -> SystemPin {
    SystemPin {
        append: Some(append.to_owned()),
        ..SystemPin::default()
    }
}

fn boundary() -> Message {
    Message::System(SystemMessage::CompactBoundary(CompactBoundary {
        id: MessageId::new("b1"),
        trigger: CompactTrigger::Manual,
        pre_tokens: 0,
        summary: MessageId::new("s1"),
        preserved: None,
        discovered_tools: Vec::new(),
    }))
}

fn human() -> Message {
    Message::User(UserMessage {
        id: MessageId::new("u1"),
        content: Vec::new(),
        origin: UserOrigin::Human,
    })
}

/// 新建的会话钉内核现在的那一份，记录就是它。
#[test]
fn a_new_session_pins_the_kernel_inputs() {
    let pin = PromptPin::created(kernel("DONE"));
    assert_eq!(pin.current().system.append.as_deref(), Some("DONE"));
    assert_eq!(pin.fact(), kernel("DONE").system.fact());
}

/// 冷打开沿用记下的 system（续写换了参数也不变，context.md §15.4）；附件那一层是内核现在的。没有记录的旧会话用内核现在的。
#[test]
fn a_reopened_session_keeps_the_recorded_system() {
    let pin = PromptPin::loaded(Some(recorded("DONE")), kernel("OVER"));
    assert_eq!(pin.current().system, recorded("DONE"));
    assert!(pin.current().live.traits.shell_escape);
    let old = PromptPin::loaded(None, kernel("OVER"));
    assert_eq!(old.current().system.append.as_deref(), Some("OVER"));
}

/// 压缩边界的那一批带重钉记录（内核现在的输入）；提交成功之后才换。别的批次不带。
#[test]
fn a_compaction_repins_after_its_commit() {
    let mut pin = PromptPin::loaded(Some(recorded("DONE")), kernel("OVER"));
    assert_eq!(pin.repin_fact(&[human()]), None);
    assert_eq!(
        pin.repin_fact(&[boundary(), human()]),
        Some(kernel("OVER").system.fact())
    );
    assert_eq!(pin.current().system, recorded("DONE"));
    pin.repinned();
    assert_eq!(pin.current().system.append.as_deref(), Some("OVER"));
    assert!(pin.current().system.shell_escape);
}

/// 附件那一层（`LivePrompt`）每回合取内核现在的：换掉 live 不动 system，换 system 不动 live。
#[test]
fn the_live_layer_updates_without_touching_the_pin() {
    let mut prompt = SessionPrompt::new(None, None, FrontendTraits::default());
    prompt.live.traits.typed_mentions = true;
    let pin = PromptPin::created(Arc::new(prompt));
    let updated = SessionPrompt {
        live: nibi_kernel_api::session_prompt::LivePrompt {
            traits: FrontendTraits {
                typed_mentions: false,
                shell_escape: false,
            },
        },
        ..pin.current().as_ref().clone()
    };
    let next = PromptPin::created(Arc::new(updated));
    assert_eq!(next.current().system, pin.current().system);
    assert!(!next.current().live.traits.typed_mentions);
}

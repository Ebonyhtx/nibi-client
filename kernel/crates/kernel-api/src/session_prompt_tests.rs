//! 会话钉住的模型可见输入（R09）：落库写法、缺省与冷打开的形状。
use super::*;
use crate::ids::SessionId;
use crate::ids::{OwnerEpoch, TraceId};
use crate::store::SessionStore;
use crate::store::{FactBatch, SessionKind, SessionMeta};
use crate::testing::MemoryStore;

/// 落库的写法读得回来；只记下最后写的那一份（键固定，存储按键合并）。
#[test]
fn a_pin_reads_back_from_its_entry() {
    let pin = SystemPin {
        custom: None,
        append: Some("Always end with DONE.".to_owned()),
        shell_escape: true,
    };
    let Fact::Entry { kind, id, data } = pin.fact() else {
        panic!("a pin is an entry");
    };
    assert_eq!(kind, entry_kinds::SYSTEM_PIN);
    assert_eq!(
        data,
        serde_json::json!({"append": "Always end with DONE.", "shell_escape": true})
    );
    let entries = vec![(id, data)];
    assert_eq!(SystemPin::recorded(&entries), Some(pin));
}

/// 这个改动之前建的会话没有记录：调用方用内核现在的输入。
#[test]
fn an_old_session_has_no_pin() {
    assert_eq!(SystemPin::recorded(&[]), None);
}

/// 形状不对的记录（不是本工程写的）同样当作没有。
#[test]
fn a_malformed_pin_is_ignored() {
    let entries = vec![(
        SYSTEM_PIN_ID.to_owned(),
        serde_json::json!({"shell_escape": "yes"}),
    )];
    assert_eq!(SystemPin::recorded(&entries), None);
}

/// 内核的缺省：`shell_escape` 跟着前端能力；换 system 那一层时附件那一层不变。
#[test]
fn the_default_pins_the_shell_hint_of_the_frontend() {
    let traits = FrontendTraits {
        shell_escape: true,
        typed_mentions: true,
    };
    let prompt = SessionPrompt::new(None, Some("A".to_owned()), traits.clone());
    assert!(prompt.system.shell_escape);
    let resumed = prompt.with_system(SystemPin::default());
    assert_eq!(resumed.system, SystemPin::default());
    assert_eq!(resumed.live.traits, traits);
}

/// `recorded` 只看最后一行同键记录（旧会话先没有、后来补写时以最后一次为准）。
#[test]
fn only_the_last_pin_wins() {
    let first = SystemPin {
        append: Some("first".to_owned()),
        ..SystemPin::default()
    };
    let second = SystemPin {
        append: Some("second".to_owned()),
        shell_escape: true,
        ..SystemPin::default()
    };
    let Fact::Entry {
        id,
        data: first_data,
        ..
    } = first.fact()
    else {
        panic!("a pin is an entry");
    };
    let Fact::Entry {
        data: second_data, ..
    } = second.fact()
    else {
        panic!("a pin is an entry");
    };
    let entries = vec![(id.clone(), first_data), (id, second_data)];
    assert_eq!(SystemPin::recorded(&entries), Some(second));
}

/// 恢复：写进会话存储的那一份读回来不变，并且与默认值不同（冷打开按它钉住）。
#[tokio::test]
async fn a_pin_survives_a_round_trip_through_the_store() {
    let store = MemoryStore::default();
    let session = SessionId::new("sess_pin");
    store
        .create(SessionMeta {
            id: session.clone(),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: crate::env::WorkspaceRef {
                environment: crate::ids::EnvironmentId::new("local"),
                root: crate::env::EnvPath::new("/w"),
            },
            title: String::new(),
            trace: TraceId::new("sess_pin"),
            created_at_ms: 0,
        })
        .await
        .unwrap();
    let pin = SystemPin {
        custom: Some("You are terse.".to_owned()),
        append: Some("End with DONE.".to_owned()),
        shell_escape: true,
    };
    store
        .commit(
            &session,
            FactBatch {
                owner_epoch: OwnerEpoch::LOCAL,
                command: None,
                facts: vec![pin.fact()],
                turn: None,
            },
        )
        .await
        .unwrap();
    let entries = store
        .entries(&session, entry_kinds::SYSTEM_PIN)
        .await
        .unwrap();
    assert_eq!(SystemPin::recorded(&entries), Some(pin));
}

/// 线格式不变：`ContextRequest` 的钉住输入只在内存（`#[serde(skip)]`），序列化不带它，旧请求反序列化为 None。
#[test]
fn the_context_request_keeps_the_pin_out_of_the_wire_shape() {
    let request = crate::orchestration::ContextRequest {
        session: SessionId::new("sess_pin"),
        workspace: crate::env::WorkspaceRef {
            environment: crate::ids::EnvironmentId::new("local"),
            root: crate::env::EnvPath::new("/w"),
        },
        agent: None,
        source: crate::model::QuerySource::MainThread,
        mode: crate::permission::PermissionMode::Default,
        tool_names: Vec::new(),
        selection: crate::model::ModelSelection {
            provider: "p".to_owned(),
            model: "m".to_owned(),
            reasoning: None,
            connection: None,
        },
        plan_flags: Default::default(),
        capabilities: None,
        mcp: None,
        default_machine: None,
        prompt: Some(std::sync::Arc::new(SessionPrompt::default())),
    };
    let value = serde_json::to_value(&request).unwrap();
    assert!(value.get("prompt").is_none(), "{value}");
    let back: crate::orchestration::ContextRequest = serde_json::from_value(value).unwrap();
    assert!(back.prompt.is_none());
}

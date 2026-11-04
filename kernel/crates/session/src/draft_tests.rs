//! 草稿会话（NIBI legacy `session/create` 的 `persistence: "deferred"`）：第一条用户输入之前不落库，
//! 不进会话列表；期间的选择与模式只在内存里，首条输入时一起写进会话行。

use std::sync::Arc;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack, Command, EndReason, KernelEvent, SessionHandle, TurnOutcome,
};
use rust_cli_kernel_api::store::{Fact, SessionStore};
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};

use crate::test_support::{Setup, envelope, submit, until};

fn model_with(replies: Vec<&str>) -> Setup {
    Setup::new(Arc::new(ScriptedModel::new(vec![text_response(&replies)])))
}

#[tokio::test]
async fn a_draft_is_stored_when_the_first_input_is_committed() {
    let mut setup = model_with(vec!["hi"]);
    setup.stored = false;
    setup.draft = true;
    let built = setup.build().await;
    let id = SessionId::new("sess_1");
    assert!(
        built.store.load(&id).await.is_err(),
        "a draft has no session row yet"
    );

    // 新建页工具栏的切模型：选择只在内存里生效，仍然没有行（Node 的草稿同样不进 sqlite）。
    let next = ModelSelection {
        provider: "p2".to_owned(),
        model: "m2".to_owned(),
        reasoning: Some("high".to_owned()),
        connection: None,
    };
    let ack = built
        .session
        .send(envelope(
            "c-model",
            Command::SetModel {
                selection: next.clone(),
            },
        ))
        .await;
    assert!(matches!(ack, Ack::Accepted { .. }));
    assert_eq!(built.session.view().await.unwrap().selection, next);
    assert!(built.store.load(&id).await.is_err());

    // 第一条用户输入：会话行、草稿期间的选择与消息一起落库。
    let mut events = built.session.subscribe(Some(0));
    let ack = built.session.send(submit("c1", "hello")).await;
    assert!(matches!(ack, Ack::Accepted { .. }));
    let seen = until(&mut events, |event| {
        matches!(event, KernelEvent::TurnFinished { .. })
    })
    .await;
    assert!(
        matches!(
            seen.last(),
            Some(KernelEvent::TurnFinished {
                outcome: TurnOutcome::Success,
                ..
            })
        ),
        "{seen:?}"
    );

    let loaded = built.store.load(&id).await.expect("the draft was promoted");
    assert!(loaded.messages.iter().any(|message| matches!(
        message,
        Message::User(user)
            if user.content.iter().any(|block| matches!(
                block,
                rust_cli_kernel_api::message::ContentBlock::Text { text } if text == "hello"
            ))
    )));
    let facts = built.store.facts(&id);
    assert!(facts.iter().any(|fact| matches!(
        fact,
        Fact::ModelSelected { selection } if *selection == next
    )));
    assert!(
        facts
            .iter()
            .any(|fact| matches!(fact, Fact::ExecutionChanged { .. }))
    );
}

#[tokio::test]
async fn closing_a_draft_stores_nothing() {
    let mut setup = model_with(Vec::new());
    setup.stored = false;
    setup.draft = true;
    let built = setup.build().await;
    let id = SessionId::new("sess_1");
    built.session.close(EndReason::Resume).await;
    assert!(
        built.store.load(&id).await.is_err(),
        "closing a draft must not create a session row"
    );
}

#[tokio::test]
async fn a_draft_keeps_the_project_mode_change_until_promotion() {
    let mut setup = model_with(vec!["hi"]);
    setup.stored = false;
    setup.draft = true;
    let built = setup.build().await;
    let id = SessionId::new("sess_1");

    // 草稿里切模式：项目层要记住这次切换，但会话行还不存在。
    let ack = built
        .session
        .send(envelope(
            "c-mode",
            Command::SetMode {
                mode: PermissionMode::BypassPermissions,
            },
        ))
        .await;
    assert!(matches!(ack, Ack::Accepted { .. }));
    assert!(built.store.load(&id).await.is_err());

    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "hello")).await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::TurnFinished { .. })
    })
    .await;

    let facts = built.store.facts(&id);
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Fact::ProjectModeSet {
                mode: PermissionMode::BypassPermissions
            }
        )),
        "{facts:?}"
    );
}

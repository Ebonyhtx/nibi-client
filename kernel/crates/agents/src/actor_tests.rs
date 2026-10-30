//! actor 轮：persona → system 第一段、工具面按 allow/deny 过滤、子会话续跑；不进 agents 面板。

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::QuerySource;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{SessionKind, SessionStore};
use rust_cli_kernel_api::testing::selection;

use super::*;
use crate::test_support::{harness, workspace};

fn profile(child: &str) -> ActorProfile {
    ActorProfile {
        parent: SessionId::new("sess_parent"),
        child: SessionId::new(child),
        workspace: workspace(),
        selection: selection(),
        mode: PermissionMode::BypassPermissions,
        prompt: "You are a DWF actor named worker.".to_owned(),
        label: "worker".to_owned(),
        allow: None,
        deny: vec!["Agent".to_owned()],
        max_turns: Some(1),
    }
}

#[tokio::test]
async fn an_actor_turn_reuses_the_subagent_loop_and_resumes_the_same_session() {
    let harness = harness(None);
    let profile = profile("sess_actor_1");
    let outcome = harness
        .agents
        .run_actor_turn(&profile, "What is the answer?", true, None)
        .await
        .unwrap();
    assert_eq!(outcome.stopped, "completed");
    assert_eq!(outcome.text, "Hello from the subagent.");
    assert_eq!(outcome.child, profile.child);

    // 子循环看到的是 actor 的 persona、Subagent 来源与去掉 Agent 的工具面。
    let seen = harness.seen();
    assert_eq!(seen.len(), 1);
    assert!(
        seen[0]
            .system
            .iter()
            .any(|block| block.text.starts_with("You are a DWF actor named worker.")),
        "{:?}",
        seen[0].system
    );
    assert_eq!(
        seen[0].request.source,
        QuerySource::Subagent("dwf-actor:worker".to_owned())
    );
    assert!(!seen[0].tools.iter().any(|tool| tool == "Agent"));
    assert_eq!(seen[0].request.session, profile.child);

    // 子会话：父会话、模型、模式与一问一答都在。
    let child = harness.store.load(&profile.child).await.unwrap();
    assert_eq!(child.meta.parent, Some(profile.parent.clone()));
    assert_eq!(child.meta.kind, SessionKind::Subagent);
    assert_eq!(child.messages.len(), 2);

    // 第二轮：同一个子会话追加一问一答。
    let second = harness
        .agents
        .run_actor_turn(&profile, "And again?", false, None)
        .await
        .unwrap();
    assert_eq!(second.stopped, "completed");
    assert_eq!(second.text, "Hello from the subagent.");
    let child = harness.store.load(&profile.child).await.unwrap();
    assert_eq!(child.messages.len(), 4);
}

#[tokio::test]
async fn resuming_a_missing_actor_session_fails_loudly() {
    let harness = harness(None);
    let profile = profile("sess_actor_missing");
    let error = harness
        .agents
        .run_actor_turn(&profile, "hello?", false, None)
        .await
        .unwrap_err();
    assert!(matches!(error, ActorError::SessionMissing { .. }), "{error}");
}

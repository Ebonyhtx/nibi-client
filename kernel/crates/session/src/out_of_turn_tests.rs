//! 回合外的工具授权入口（MCP Apps 的 `mcp/uiCallTool`）：会话当前的模式与工作目录、会话级询问。

use std::sync::Arc;

use futures_util::stream::BoxStream;
use rust_cli_kernel_api::ids::{SessionId, ToolUseId};
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{Ack, Command, KernelEvent, SequencedEvent, SessionHandle};
use rust_cli_kernel_api::testing::ScriptedModel;
use serde_json::json;

use crate::test_support::{Setup, envelope, until};

/// 不在回合里也能读到 owner（actor）的当前模式与工作目录。
#[tokio::test]
async fn the_actor_reports_the_mode_and_workspace_out_of_turn() {
    let built = Setup::new(Arc::new(ScriptedModel::new(Vec::new())))
        .build()
        .await;
    let (mode, workspace) = built.session.out_of_turn_context().await.expect("context");
    assert_eq!(mode, PermissionMode::Default);
    assert_eq!(workspace.root.as_str(), "/work");
}

/// 回合外的审批询问走会话级入口：actor 登记后可以用 `ResolveInteraction` 回答，
/// 不依赖任何在跑的回合（回合结束时也不会被取消）。
#[tokio::test]
async fn session_asks_reach_the_actor_and_can_be_answered() {
    let built = Setup::new(Arc::new(ScriptedModel::new(Vec::new())))
        .build()
        .await;
    let mut events: BoxStream<'static, SequencedEvent> = built.session.subscribe(None);
    let interactions = built.session.session_interactions();
    let pending = tokio::spawn(async move {
        interactions
            .ask(
                &SessionId::new("sess_1"),
                InteractionRequest::Permission {
                    tool_use: ToolUseId::new("toolu_ui"),
                    tool: "mcp__panel__echo".to_owned(),
                    input: json!({}),
                    message: "ZCode requested permissions to use mcp__panel__echo".to_owned(),
                    suggestions: Vec::new(),
                    asked_by: None,
                    machine: None,
                },
            )
            .await
    });
    let seen = until(&mut events, |event| {
        matches!(event, KernelEvent::InteractionAsked { .. })
    })
    .await;
    let KernelEvent::InteractionAsked { interaction, .. } = seen.last().expect("asked") else {
        panic!("{seen:?}");
    };
    let ack = built
        .session
        .send(envelope(
            "cmd-1",
            Command::ResolveInteraction {
                interaction: interaction.clone(),
                answer: json!({"decision": "allow"}),
            },
        ))
        .await;
    assert!(matches!(ack, Ack::Accepted { .. }), "{ack:?}");
    let answer = pending.await.expect("ask task").expect("answered");
    assert_eq!(answer.answer["decision"], json!("allow"));
}

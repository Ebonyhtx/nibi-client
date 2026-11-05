//! DWF actor 轮的内核入口：sidecar 通过 `Kernel::run_workflow_actor` 跑 actor 的模型轮。

use std::sync::Arc;

use futures_util::stream::{self, StreamExt};
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::message::ContentBlock;
use nibi_kernel_api::model::{ModelEvent, ModelError, ModelPort, ModelRequest};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{CreateSession, Kernel};
use nibi_kernel_api::store::SessionStore;
use nibi_kernel_api::testing::{
    FixedClock, MemoryStore, ScriptedModel, SequentialIds, environments, selection, text_response,
    tool_use_response,
};
use nibi_kernel_api::workflow::{WorkflowActorRequest, WorkflowActorSpec};
use tokio_util::sync::CancellationToken;

use super::*;

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/work"),
    }
}

fn kernel(store: Arc<MemoryStore>, model: Arc<dyn ModelPort>) -> LocalKernel {
    LocalKernel::new(
        Ports {
            model,
            environments: environments(Arc::new(
                nibi_kernel_api::testing::UnusedEnvironment,
            )),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    )
}

fn actor(parent: &SessionId, child: &str) -> WorkflowActorSpec {
    WorkflowActorSpec {
        parent: parent.as_str().to_owned(),
        child: child.to_owned(),
        workspace: Some("/work".to_owned()),
        prompt: "You are a DWF worker.".to_owned(),
        label: "worker".to_owned(),
        selection: None,
        mode: None,
        allow: None,
        deny: Vec::new(),
        max_turns: Some(1),
        submit_schema: None,
        run_id: "dwfrun_test".to_owned(),
        actor: "worker#1@1".to_owned(),
        actor_name: Some("worker".to_owned()),
        ask: "worker#1@1".to_owned(),
        seed: None,
    }
}

#[tokio::test]
async fn an_actor_turn_runs_through_the_kernel_and_returns_its_text() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(
        store.clone(),
        Arc::new(ScriptedModel::new(vec![text_response(&["actor reply"])])),
    );
    let parent = kernel
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .unwrap();

    let turn = kernel
        .run_workflow_actor(
            WorkflowActorRequest {
                actor: actor(&parent, "sess_actor_kernel"),
                message: "do the thing".to_owned(),
                first: true,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(turn.stopped, "completed");
    assert_eq!(turn.text, "actor reply");
    assert_eq!(turn.child, "sess_actor_kernel");

    // actor 子会话落了父会话与一问一答。
    let child = store
        .load(&SessionId::new("sess_actor_kernel"))
        .await
        .unwrap();
    assert_eq!(child.meta.parent, Some(parent));
    // 与子代理一样：对话两行，其余是这一步的 attachment（模型身份、延迟工具清单……）。
    let dialogue = child
        .messages
        .iter()
        .filter(|message| {
            matches!(
                message,
                nibi_kernel_api::message::Message::User(_)
                    | nibi_kernel_api::message::Message::Assistant(_)
            )
        })
        .count();
    assert_eq!(dialogue, 2);
}

#[tokio::test]
async fn a_typed_ask_submits_its_result_through_the_actor_tool() {    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(
        store.clone(),
        Arc::new(ScriptedModel::new(vec![
            // 第一轮：模型调用 submit_result（typed ask 的终止通道）。
            tool_use_response(
                "toolu_submit",
                "submit_result",
                &serde_json::json!({"result": {"answer": 42}}),
            ),
            // 工具结果回来之后，模型收尾。
            text_response(&["done"]),
        ])),
    );
    let parent = kernel
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .unwrap();
    let mut spec = actor(&parent, "sess_actor_typed");
    spec.submit_schema = Some(serde_json::json!({"type": "object"}));
    // 工具轮之后还要一轮收尾（上限 1 会在工具轮就停）；yolo 免得权限门拦下提交。
    spec.max_turns = None;
    spec.mode = Some(PermissionMode::BypassPermissions);

    let turn = kernel
        .run_workflow_actor(
            WorkflowActorRequest {
                actor: spec,
                message: "answer the question".to_owned(),
                first: true,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(turn.stopped, "completed");
    assert_eq!(turn.text, "done");
    assert_eq!(
        turn.submitted,
        Some(serde_json::json!({"answer": 42}))
    );
}

/// actor 的 `escalate` 停驻 → 父会话被通知唤醒、调 `ResolveWorkflowQuestion` 作答 → actor 带着答案继续。
///
/// 模型按「最后一条消息」路由，于是升级通知开启的父会话回合与 actor 的续跑各拿各的答复，
/// 不依赖响应的到达顺序（`ScriptedModel` 的队列在这里会因为两个会话并发而错配）。
#[tokio::test]
async fn an_actor_escalation_parks_until_the_parent_answers() {
    struct EscalationModel;

    impl ModelPort for EscalationModel {
        fn stream(
            &self,
            request: ModelRequest,
            _cancel: CancellationToken,
        ) -> futures_util::stream::BoxStream<'static, Result<ModelEvent, ModelError>> {
            let last = request
                .messages
                .last()
                .map(|message| {
                    message
                        .content
                        .iter()
                        .map(|content| match &content.block {
                            ContentBlock::Text { text } => text.clone(),
                            other => serde_json::to_string(other).unwrap_or_default(),
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            let response = if last.contains("that way") {
                text_response(&["continued after the answer"])
            } else if last.contains("Answer delivered for question") {
                // 父会话答完之后的收尾（同一个通知回合的第二次请求）。
                text_response(&["noted"])
            } else if last.contains("workflow-escalation") {
                // 父会话收到的升级通知：从通知正文里读出 qid，再调答题工具。
                let qid = last
                    .split("dwfq-")
                    .nth(1)
                    .map(|rest| {
                        let tail = rest.split('<').next().unwrap_or(rest).trim();
                        format!("dwfq-{tail}")
                    })
                    .unwrap_or_default();
                tool_use_response(
                    "toolu_resolve",
                    "ResolveWorkflowQuestion",
                    &serde_json::json!({"question_id": qid, "answer": "that way"}),
                )
            } else {
                tool_use_response(
                    "toolu_escalate",
                    "escalate",
                    &serde_json::json!({"question": "Which way?", "context": "both look equal"}),
                )
            };
            stream::iter(response).boxed()
        }
    }

    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store, Arc::new(EscalationModel));
    let parent = kernel
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .unwrap();
    let mut spec = actor(&parent, "sess_actor_escalation");
    spec.max_turns = None;
    spec.mode = Some(PermissionMode::BypassPermissions);

    let turn = kernel
        .run_workflow_actor(
            WorkflowActorRequest {
                actor: spec,
                message: "do the blocked thing".to_owned(),
                first: true,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        turn.stopped,
        "completed",
        "stopped={} error={:?} text={}",
        turn.stopped,
        turn.error,
        turn.text
    );
    assert_eq!(turn.text, "continued after the answer");
    // 作答之后表里不再有欠着答案的问题。
    assert!(
        kernel
            .pending_workflow_questions(&parent)
            .await
            .unwrap()
            .is_empty()
    );
}

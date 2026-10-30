//! DWF actor 轮的内核入口：sidecar 通过 `Kernel::run_workflow_actor` 跑 actor 的模型轮。

use std::sync::Arc;

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, Kernel};
use rust_cli_kernel_api::store::SessionStore;
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryStore, ScriptedModel, SequentialIds, environments, selection, text_response,
    tool_use_response,
};
use rust_cli_kernel_api::workflow::{WorkflowActorRequest, WorkflowActorSpec};

use super::*;

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/work"),
    }
}

fn kernel(store: Arc<MemoryStore>, model: Arc<ScriptedModel>) -> LocalKernel {
    LocalKernel::new(
        Ports {
            model,
            environments: environments(Arc::new(
                rust_cli_kernel_api::testing::UnusedEnvironment,
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
                rust_cli_kernel_api::message::Message::User(_)
                    | rust_cli_kernel_api::message::Message::Assistant(_)
            )
        })
        .count();
    assert_eq!(dialogue, 2);
}

#[tokio::test]
async fn a_typed_ask_submits_its_result_through_the_actor_tool() {
    let store = Arc::new(MemoryStore::default());
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

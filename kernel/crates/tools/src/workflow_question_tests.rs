//! `ResolveWorkflowQuestion`：把注册表的两种结局投影成模型可读的一段文字。

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, OperationContext, Origin, WorkspaceRef};
use rust_cli_kernel_api::ids::{
    EnvironmentId, Generation, OperationId, OwnerEpoch, RunId, SessionId, ToolUseId,
};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::{
    MemoryStore, ScriptedInteractions, UnusedEnvironment, local_services, machine,
};
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolUseContext};
use rust_cli_kernel_api::workflow::{WorkflowQuestionResolved, WorkflowQuestions};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::*;

struct Fixed(WorkflowQuestionResolved);

#[async_trait]
impl WorkflowQuestions for Fixed {
    async fn resolve(
        &self,
        _session: &SessionId,
        _qid: &str,
        _answer: &str,
    ) -> WorkflowQuestionResolved {
        self.0.clone()
    }
}

fn context() -> ToolUseContext {
    let env = Arc::new(UnusedEnvironment);
    ToolUseContext {
        session: SessionId::new("sess_1"),
        run: RunId::new("run_1"),
        tool_use: ToolUseId::new("toolu_1"),
        agent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/work"),
        },
        mode: PermissionMode::Default,
        cancel: CancellationToken::new(),
        machine: machine(env.clone()),
        local: local_services(env),
        artifacts: Arc::new(MemoryStore::default()),
        interactions: Arc::new(ScriptedInteractions::default()),
        operation: OperationContext {
            environment: EnvironmentId::new("local"),
            generation: Generation::new("g1"),
            owner_epoch: OwnerEpoch::LOCAL,
            operation: OperationId::new("op_1"),
            origin: Origin::Agent {
                session: SessionId::new("sess_1"),
                run: RunId::new("run_1"),
            },
        },
    }
}

#[tokio::test]
async fn an_accepted_answer_is_projected_as_a_confirmation() {
    let tool = ResolveWorkflowQuestionTool::new(Arc::new(Fixed(
        WorkflowQuestionResolved::Answered {
            qid: "dwfq-01234567-1".to_owned(),
        },
    )));
    let (progress, _rx) = tokio::sync::mpsc::channel(1);
    let output = tool
        .call(
            json!({"question_id": "dwfq-01234567-1", "answer": "that way"}),
            context(),
            progress,
        )
        .await
        .unwrap();
    assert!(!output.is_error);
    let text = match &output.content[0] {
        rust_cli_kernel_api::message::ToolResultContent::Text { text } => text.clone(),
        other => panic!("unexpected content: {other:?}"),
    };
    assert!(text.contains("Answer delivered for question dwfq-01234567-1"), "{text}");
    assert!(text.contains("the run keeps going"));
}

#[tokio::test]
async fn a_rejected_answer_passes_the_registry_message_through_as_an_error() {
    let message = "Unknown question id dwfq-missing-1.";
    let tool = ResolveWorkflowQuestionTool::new(Arc::new(Fixed(
        WorkflowQuestionResolved::Rejected {
            reason: "unknown_question".to_owned(),
            message: message.to_owned(),
        },
    )));
    let (progress, _rx) = tokio::sync::mpsc::channel(1);
    let output = tool
        .call(
            json!({"question_id": "dwfq-missing-1", "answer": "x"}),
            context(),
            progress,
        )
        .await
        .unwrap();
    assert!(output.is_error);
    let text = match &output.content[0] {
        rust_cli_kernel_api::message::ToolResultContent::Text { text } => text.clone(),
        other => panic!("unexpected content: {other:?}"),
    };
    assert_eq!(text, message);
}

#[tokio::test]
async fn an_empty_question_id_is_invalid_input() {
    let tool = ResolveWorkflowQuestionTool::new(Arc::new(Fixed(
        WorkflowQuestionResolved::Answered {
            qid: "q".to_owned(),
        },
    )));
    let (progress, _rx) = tokio::sync::mpsc::channel(1);
    let error = tool
        .call(json!({"question_id": "  ", "answer": "x"}), context(), progress)
        .await
        .unwrap_err();
    assert!(matches!(error, ToolError::InvalidInput { .. }));
}

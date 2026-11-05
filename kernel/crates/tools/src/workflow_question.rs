//! `ResolveWorkflowQuestion`：主代理回答 actor 从正在跑的 DWF run 里升级上来的阻塞问题。
//!
//! 工具本身刻意很薄：qid 查表、结算与事件都在注册表（runtime 的 `escalations`）里；这里只做
//! 取端口、透传 qid 与答案、把结果投影成模型可读的一段文字（Node 的 handler 同形）。
//!
//! 拒绝文案**原样透传**注册表写好的那段：判别键与文案分开维护则两处迟早会说不同的话，而这里
//! 的读者是模型——它读到的就是它的下一步。

use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext,
};
use nibi_kernel_api::workflow::{
    RESOLVE_WORKFLOW_QUESTION_TOOL, WorkflowQuestionResolved, WorkflowQuestions,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// 模型看到的使用纪律（与 Node 的 `RESOLVE_WORKFLOW_QUESTION_DESCRIPTION` 逐句相同）。
const DESCRIPTION: &str = "Answers a blocking question that a subagent escalated from inside a RUNNING dynamic-workflow run.

- Takes question_id — the ID from the escalation notification (it looks like `dwfq-...`). If that notification was lost, GetWorkflowRun lists the questions a run still owes an answer to.
- The run keeps running the whole time: only the subagent that asked is parked on its call, while every other subagent and the script's control flow keep going. Your answer becomes that call's result verbatim and the subagent continues from there.
- Answer directly and actionably. If you are not sure, look at the run first with GetWorkflowRun, or ask the user with AskUserQuestion, then come back and answer — nothing answers on your behalf, and the subagent waits indefinitely.
- If the question reveals the SCRIPT is structurally broken (a broken gate, wrong control flow), a sentence cannot fix that: cancel the run and continue with a revised script via CreateWorkflow's `resume_from`.";

pub struct ResolveWorkflowQuestionTool {
    questions: Arc<dyn WorkflowQuestions>,
}

impl ResolveWorkflowQuestionTool {
    pub fn new(questions: Arc<dyn WorkflowQuestions>) -> Self {
        Self { questions }
    }
}

#[async_trait]
impl Tool for ResolveWorkflowQuestionTool {
    fn name(&self) -> &str {
        RESOLVE_WORKFLOW_QUESTION_TOOL
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "question_id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "The question ID from the escalation notification, or from GetWorkflowRun's pending questions (looks like `dwfq-...`)",
                },
                "answer": {
                    "type": "string",
                    "minLength": 1,
                    "description": "The answer text, delivered verbatim to the subagent that asked",
                },
            },
            "required": ["question_id", "answer"],
            "additionalProperties": false,
        })
    }

    fn description(&self, _context: &PromptContext) -> String {
        DESCRIPTION.to_owned()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("answer a blocking question escalated by a workflow subagent")
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> nibi_kernel_api::permission::PermissionDecision {
        nibi_kernel_api::permission::PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let qid = input
            .get("question_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        let answer = input
            .get("answer")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        if qid.is_empty() {
            return Err(ToolError::InvalidInput {
                message: "`question_id` must be a non-empty string".to_owned(),
            });
        }
        if answer.is_empty() {
            return Err(ToolError::InvalidInput {
                message: "`answer` must be a non-empty string".to_owned(),
            });
        }
        match self.questions.resolve(&context.session, &qid, &answer).await {
            WorkflowQuestionResolved::Answered { qid } => Ok(ToolOutput {
                content: vec![nibi_kernel_api::message::ToolResultContent::Text {
                    text: format!(
                        "Answer delivered for question {qid}. The subagent that asked has resumed \
its turn with your answer; the run keeps going as before."
                    ),
                }],
                is_error: false,
                display: json!({"ok": true, "qid": qid}),
            }),
            WorkflowQuestionResolved::Rejected { reason, message } => Ok(ToolOutput {
                content: vec![nibi_kernel_api::message::ToolResultContent::Text { text: message }],
                is_error: true,
                display: json!({"ok": false, "reason": reason}),
            }),
        }
    }
}

#[cfg(test)]
#[path = "workflow_question_tests.rs"]
mod tests;

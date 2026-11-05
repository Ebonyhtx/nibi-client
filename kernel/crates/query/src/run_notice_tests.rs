//! 子代理在工具边界收到的通知（docs/specs/rust-cli/query.md §5.1）：插话之后，每条通知一个
//! `queued_command`（`commandMode: task-notification`），文本是通知全文。

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::abort::Abort;
use nibi_kernel_api::ids::{OperationId, SessionId};
use nibi_kernel_api::message::{ UserOrigin,ContentBlock, Message, ToolResultContent};
use nibi_kernel_api::orchestration::{
    InteractionAnswer, InteractionRequest, Interactions, OrchestrationError, QueryEvent, QueryStop,
    RunSink,
};
use nibi_kernel_api::store::StoreError;
use nibi_kernel_api::testing::{
    RecordingSink, ScriptedModel, text_response, tool_use_response,
};
use serde_json::json;

use super::tests::{parts, request};
use crate::RunScope;

const NOTICE: &str = "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>agent_2</task-id>\n</task-notification>\n</system-reminder>";

/// 记录消息的输出端，另带一队通知。
struct NoticeSink {
    inner: Arc<RecordingSink>,
    notices: Mutex<Vec<String>>,
}

#[async_trait]
impl Interactions for NoticeSink {
    async fn ask(
        &self,
        session: &SessionId,
        request: InteractionRequest,
    ) -> Result<InteractionAnswer, OrchestrationError> {
        self.inner.ask(session, request).await
    }
}

#[async_trait]
impl RunSink for NoticeSink {
    async fn commit_message(&self, message: Message) -> Result<(), StoreError> {
        self.inner.commit_message(message).await
    }

    async fn commit_intent(
        &self,
        operation: OperationId,
        fingerprint: String,
    ) -> Result<(), StoreError> {
        self.inner.commit_intent(operation, fingerprint).await
    }

    async fn emit(&self, event: QueryEvent) -> bool {
        self.inner.emit(event).await
    }

    async fn take_steering(&self) -> Vec<String> {
        self.inner.take_steering().await
    }

    async fn take_notices(&self) -> Vec<String> {
        std::mem::take(&mut *self.notices.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

#[tokio::test]
async fn notices_join_the_run_after_the_steering_input() {
    let model = Arc::new(ScriptedModel::new(vec![
        tool_use_response("toolu_1", "Read", &json!({})),
        text_response(&["done"]),
    ]));
    let first = request("go");
    let inner = Arc::new(RecordingSink::default());
    inner.steer("also check b");
    let sink = Arc::new(NoticeSink {
        inner: inner.clone(),
        notices: Mutex::new(vec![NOTICE.to_owned()]),
    });
    let scope = Arc::new(RunScope {
        session: first.session.clone(),
        run: first.run.clone(),
        workspace: first.workspace.clone(),
        agent: None,
        mode: first.mode,
        abort: Abort::new(),
        sink,
        parts: parts(model.clone(), Vec::new()),
        exhausted: Default::default(),
    });
    assert_eq!(
        super::run(scope, first).await.unwrap(),
        QueryStop::Completed
    );
    let messages = inner.messages();
    // 并入也先落一条 meta user 消息（Node 的 mid-turn drain 先 persist 批记录）：记录与
    // attachment 同文，记录带来源（缺省面没有结构化元数据），只有 attachment 进模型上下文。
    let [Message::Attachment(prompt), Message::User(record), Message::Attachment(notice)] =
        &messages[2..5]
    else {
        panic!("expected the steering input, then the notice record and attachment: {messages:?}");
    };
    assert_eq!(prompt.data["commandMode"], "prompt");
    let UserOrigin::Meta { source, origin_meta } = &record.origin else {
        panic!("expected a meta record for the notice: {record:?}");
    };
    assert_eq!(source, "task-notification");
    assert_eq!(origin_meta, &None);
    assert_eq!(notice.source, "queued_command");
    assert_eq!(notice.text, NOTICE);
    assert_eq!(
        notice.data,
        json!({"prompt": NOTICE, "commandMode": "task-notification"})
    );
    // 不是 user 角色的 attachment：模型支持对话中间的 `role: system` 时去掉包装折进去；这里的测试模型不支持，按 user 角色带着包装跟在插话后面，两段都并进前面的工具结果
    //（context.md §3 第 9 条）。
    let requests = model.requests();
    let last = requests[1].messages.last().unwrap();
    let ContentBlock::ToolResult { content, .. } = &last.content.last().unwrap().block else {
        panic!("expected the tool result: {last:?}");
    };
    let [ToolResultContent::Text { text }] = content.as_slice() else {
        panic!("expected one text in the tool result: {content:?}");
    };
    assert!(
        text.ends_with(&format!("</system-reminder>\n\n{NOTICE}")),
        "{text}"
    );
}

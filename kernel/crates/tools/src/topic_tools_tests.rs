//! 话题工具（`ReadTopicResource` / `ReplyToChannel`）的行为。
//!
//! 判五件事：资源只读当前会话已接纳输入的话题快照；授权缺失/坏数据/非机器人输入一律拒绝；
//! 索引必须落在所选快照里；附件物化成会话 artifact；回复绑定到开启这次工具调用的那条输入。
//! 没有 Host 端口时 `ReadTopicResource` 不注册，`ReplyToChannel` 保持原失败语义。

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::env::{EnvPath, OperationContext, Origin, WorkspaceRef};
use nibi_kernel_api::ids::{
    EnvironmentId, Generation, MessageId, OperationId, OwnerEpoch, RunId, SessionId, ToolUseId,
};
use nibi_kernel_api::message::{AssistantMessage, ContentBlock, Message, UserMessage, UserOrigin};
use nibi_kernel_api::orchestration::{
    InteractionAnswer, InteractionRequest, Interactions, OrchestrationError,
};
use nibi_kernel_api::permission::{PermissionDecision, PermissionMode};
use nibi_kernel_api::store::{ArtifactPurpose, ArtifactStore};
use nibi_kernel_api::testing::{MemoryArtifacts, UnusedEnvironment, local_services, machine};
use nibi_kernel_api::tool::{Tool, ToolUseContext};
use nibi_kernel_api::topic::{
    SessionReads, SessionSnapshot, TopicPort, TopicResource, TopicResourceRead,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;

struct NoInteractions;

#[async_trait]
impl Interactions for NoInteractions {
    async fn ask(
        &self,
        _session: &SessionId,
        _request: InteractionRequest,
    ) -> Result<InteractionAnswer, OrchestrationError> {
        std::future::pending().await
    }

    async fn cancel_ask(&self, _session: &SessionId, _tool_use: &ToolUseId) {}
}

fn context(artifacts: Arc<MemoryArtifacts>) -> ToolUseContext {
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
        execution: nibi_kernel_api::permission::ExecutionState::from(PermissionMode::Default),
        cancel: CancellationToken::new(),
        machine: machine(env.clone()),
        local: local_services(env),
        artifacts,
        interactions: Arc::new(NoInteractions),
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

struct Reads(SessionSnapshot);

#[async_trait]
impl SessionReads for Reads {
    async fn snapshot(&self, _session: &SessionId) -> Result<SessionSnapshot, String> {
        Ok(self.0.clone())
    }
}

/// 记录工具到底向哪个会话要了快照：资源只允许当前会话。
struct RecordingReads {
    snapshot: SessionSnapshot,
    seen: Mutex<Vec<SessionId>>,
}

#[async_trait]
impl SessionReads for RecordingReads {
    async fn snapshot(&self, session: &SessionId) -> Result<SessionSnapshot, String> {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(session.clone());
        Ok(self.snapshot.clone())
    }
}

#[derive(Default)]
struct Topic {
    replies: Mutex<Vec<Value>>,
    resource: Option<TopicResource>,
}

#[async_trait]
impl TopicPort for Topic {
    async fn read(&self, _request: &TopicResourceRead) -> Result<TopicResource, String> {
        self.resource
            .clone()
            .ok_or_else(|| "unavailable".to_owned())
    }

    async fn cancel(&self, _request_id: &str, _task_id: &str) {}

    async fn reply(&self, request: Value) -> Result<Value, String> {
        self.replies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(request);
        Ok(json!({"status": "sent", "deliveryId": "d1"}))
    }
}

fn user(id: &str, text: &str) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin: UserOrigin::Human,
    })
}

fn assistant_with_tool(id: &str, tool_use: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::ToolUse {
            id: ToolUseId::new(tool_use),
            name: REPLY_TO_CHANNEL.to_owned(),
            input: json!({"parts": [{"type": "text", "text": "hi"}]}),
        }],
        model: "m".to_owned(),
        stop_reason: None,
        usage: None,
    })
}

fn tool_text(output: &nibi_kernel_api::tool::ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            nibi_kernel_api::message::ToolResultContent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn topic_intent(command: &str, records: Value) -> Value {
    json!({
        "text": "group question",
        "sourceCommandId": command,
        "botGroupSource": {
            "botId": "b1",
            "chatId": "c1",
            "threadId": "t1",
            "authorizationId": "auth-1",
            "messageId": "m9",
            "topicContext": {"messages": records, "hasGap": false},
        },
    })
}

fn snapshot_with(intent: Value, messages: Vec<Message>) -> SessionSnapshot {
    SessionSnapshot {
        title: "Test session".to_owned(),
        directory: Some("D:/work".to_owned()),
        messages,
        intents: vec![(MessageId::new("u1"), intent)],
    }
}

async fn attachment_topic(store: &MemoryArtifacts) -> Topic {
    let stored = store
        .put(
            &SessionId::new("sess_1"),
            ArtifactPurpose::Attachment,
            "image/png".to_owned(),
            vec![1, 2, 3],
        )
        .await
        .unwrap();
    Topic {
        replies: Mutex::new(Vec::new()),
        resource: Some(TopicResource {
            reference: format!(
                "nibi-artifact://sess_1/{}",
                stored.id.as_str()
            ),
            file_name: "shot.png".to_owned(),
            mime: "image/png".to_owned(),
            bytes: 3,
        }),
    }
}

fn attachment_records() -> Value {
    json!([
        {"id": "m1", "chatId": "c1", "threadId": "t1", "text": "look", "senderId": "u", "senderType": "user", "createdAt": 1, "attachments": [{"kind": "image"}]},
    ])
}

#[tokio::test]
async fn read_topic_resource_materializes_an_admitted_attachment() {
    let store = Arc::new(MemoryArtifacts::default());
    let topic = attachment_topic(&store).await;
    let snapshot = snapshot_with(
        topic_intent("cmd-1", attachment_records()),
        vec![user("u1", "question")],
    );
    let tool = ReadTopicResourceTool::new(Arc::new(Reads(snapshot)), Some(Arc::new(topic)));
    let output = tool
        .call(
            json!({"inputId": "cmd-1", "messageId": "m1", "index": 0}),
            context(store),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&tool_text(&output)).unwrap();
    assert_eq!(value["status"], "success");
    assert_eq!(value["fileName"], "shot.png");
    assert_eq!(value["mime"], "image/png");
    assert_eq!(value["bytes"], 3);
    assert_eq!(value["messageId"], "m1");
    assert_eq!(value["index"], 0);
    let path = value["path"].as_str().unwrap();
    assert!(
        path.starts_with("nibi-artifact://sess_1/"),
        "path should point at the materialized artifact: {path}"
    );
}

#[tokio::test]
async fn read_topic_resource_rejects_an_index_outside_the_selected_snapshot() {
    let store = Arc::new(MemoryArtifacts::default());
    let topic = attachment_topic(&store).await;
    let snapshot = snapshot_with(
        topic_intent("cmd-1", attachment_records()),
        vec![user("u1", "question")],
    );
    let tool = ReadTopicResourceTool::new(Arc::new(Reads(snapshot)), Some(Arc::new(topic)));
    let error = tool
        .call(
            json!({"inputId": "cmd-1", "messageId": "m1", "index": 1}),
            context(store),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not indexed"), "{error}");
}

#[tokio::test]
async fn read_topic_resource_prefers_the_canonical_history_index() {
    let store = Arc::new(MemoryArtifacts::default());
    let topic = attachment_topic(&store).await;
    let mut intent = topic_intent("cmd-1", attachment_records());
    // canonical `topicHistory` 在场时它是唯一索引，即使 `topicContext` 仍列出附件。
    intent["botGroupSource"]["topicHistory"] = json!({"resourceMessages": []});
    let snapshot = snapshot_with(intent, vec![user("u1", "question")]);
    let tool = ReadTopicResourceTool::new(Arc::new(Reads(snapshot)), Some(Arc::new(topic)));
    let error = tool
        .call(
            json!({"inputId": "cmd-1", "messageId": "m1", "index": 0}),
            context(store),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not indexed"), "{error}");
}

#[tokio::test]
async fn read_topic_resource_rejects_unauthorized_inputs() {
    let cases = [
        // 没有 botGroupSource：普通输入不是话题授权。
        json!({"sourceCommandId": "cmd-1"}),
        // canonical 意图损坏：不得回退。
        json!({"sourceCommandId": "cmd-1", "botGroupSource": {"botId": "b1", "chatId": "c1"}}),
        // 缺少 authorizationId。
        json!({"sourceCommandId": "cmd-1", "botGroupSource": {"botId": "b1", "chatId": "c1", "threadId": "t1"}}),
    ];
    for intent in cases {
        let snapshot = snapshot_with(intent, vec![user("u1", "question")]);
        let tool =
            ReadTopicResourceTool::new(Arc::new(Reads(snapshot)), Some(Arc::new(Topic::default())));
        let error = tool
            .call(
                json!({"messageId": "m1", "index": 0}),
                context(Arc::new(MemoryArtifacts::default())),
                tokio::sync::mpsc::channel(1).0,
            )
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("No admitted topic authorization"),
            "{error}"
        );
    }

    // synthetic 用户输入不构成授权。
    let snapshot = SessionSnapshot {
        title: "Test session".to_owned(),
        directory: None,
        messages: vec![Message::User(UserMessage {
            id: MessageId::new("u1"),
            content: vec![ContentBlock::Text {
                text: "synthetic".to_owned(),
            }],
            origin: UserOrigin::Meta {
                source: "test".to_owned(),
                origin_meta: None,
            },
        })],
        intents: vec![(
            MessageId::new("u1"),
            topic_intent("cmd-1", attachment_records()),
        )],
    };
    let tool =
        ReadTopicResourceTool::new(Arc::new(Reads(snapshot)), Some(Arc::new(Topic::default())));
    let error = tool
        .call(
            json!({"messageId": "m1", "index": 0}),
            context(Arc::new(MemoryArtifacts::default())),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("No admitted topic authorization"),
        "{error}"
    );
}

#[tokio::test]
async fn read_topic_resource_reads_only_the_current_session() {
    let reads = Arc::new(RecordingReads {
        snapshot: snapshot_with(
            topic_intent("cmd-1", attachment_records()),
            vec![user("u1", "question")],
        ),
        seen: Mutex::new(Vec::new()),
    });
    let tool = ReadTopicResourceTool::new(reads.clone(), Some(Arc::new(Topic::default())));
    let _ = tool
        .call(
            json!({"messageId": "m1"}),
            context(Arc::new(MemoryArtifacts::default())),
            tokio::sync::mpsc::channel(1).0,
        )
        .await;
    assert_eq!(
        reads
            .seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_slice(),
        &[SessionId::new("sess_1")]
    );
}

#[tokio::test]
async fn read_topic_resource_requires_a_host_topic_port() {
    let snapshot = snapshot_with(
        topic_intent("cmd-1", json!([])),
        vec![user("u1", "question")],
    );
    let tools = topic_tools(Arc::new(Reads(snapshot)), None);
    assert!(!tools.iter().any(|tool| tool.name() == READ_TOPIC_RESOURCE));

    let snapshot = snapshot_with(
        topic_intent("cmd-1", json!([])),
        vec![user("u1", "question")],
    );
    let tool =
        ReadTopicResourceTool::new(Arc::new(Reads(snapshot)), Some(Arc::new(Topic::default())));
    let error = tool
        .call(
            json!({"messageId": "m1"}),
            context(Arc::new(MemoryArtifacts::default())),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap_err();
    // 端口在场但 Host 没有资源时，错误来自 Host，而不是伪装成成功。
    assert!(error.to_string().contains("unavailable"), "{error}");
}

#[tokio::test]
async fn read_topic_resource_declares_the_upstream_contract() {
    let tool = ReadTopicResourceTool::new(
        Arc::new(Reads(SessionSnapshot::default())),
        Some(Arc::new(Topic::default())),
    );
    assert_eq!(tool.name(), "ReadTopicResource");
    assert!(tool.should_defer());
    assert!(!tool.is_read_only(&json!({})));
    assert!(tool.is_concurrency_safe(&json!({})));
    assert_eq!(tool.max_result_size_chars(), Some(4_096));
    let context = context(Arc::new(MemoryArtifacts::default()));
    assert!(matches!(
        tool.check_permissions(&json!({}), &context).await,
        PermissionDecision::Allow { .. }
    ));
    let schema = tool.input_schema();
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["required"], json!(["messageId"]));
    assert_eq!(schema["properties"]["index"]["minimum"], 0);
    assert_eq!(schema["properties"]["messageId"]["maxLength"], 256);
}

#[tokio::test]
async fn read_topic_resource_rejects_invalid_input() {
    let tool = ReadTopicResourceTool::new(
        Arc::new(Reads(SessionSnapshot::default())),
        Some(Arc::new(Topic::default())),
    );
    for input in [
        json!({}),
        json!({"messageId": ""}),
        json!({"messageId": "m1", "index": -1}),
        json!({"messageId": "m1", "inputId": ""}),
    ] {
        let error = tool
            .call(
                input,
                context(Arc::new(MemoryArtifacts::default())),
                tokio::sync::mpsc::channel(1).0,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(error, nibi_kernel_api::tool::ToolError::InvalidInput { .. }),
            "{error}"
        );
    }
}

#[tokio::test]
async fn the_reply_is_bound_to_the_input_that_opened_the_tool_call() {
    let snapshot = SessionSnapshot {
        title: "Test session".to_owned(),
        directory: Some("D:/work".to_owned()),
        messages: vec![
            user("u1", "please @ Ann"),
            assistant_with_tool("a1", "toolu_1"),
        ],
        intents: vec![(MessageId::new("u1"), topic_intent("cmd-1", json!([])))],
    };
    let topic = Arc::new(Topic::default());
    let tool = ReplyToChannelTool::new(Arc::new(Reads(snapshot)), Some(topic.clone()));
    let output = tool
        .call(
            json!({"parts": [{"type": "text", "text": "done"}]}),
            context(Arc::new(MemoryArtifacts::default())),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    assert!(tool_text(&output).contains("\"status\":\"sent\""));
    let replies = topic.replies.lock().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["taskId"], "sess_1");
    assert_eq!(replies[0]["inputId"], "cmd-1");
    assert_eq!(replies[0]["toolCallId"], "toolu_1");
    assert_eq!(replies[0]["parts"][0]["text"], "done");
}

#[tokio::test]
async fn a_reply_without_an_authorized_input_fails() {
    let snapshot = SessionSnapshot {
        title: "Test session".to_owned(),
        directory: Some("D:/work".to_owned()),
        messages: vec![user("u1", "hello"), assistant_with_tool("a1", "toolu_1")],
        intents: Vec::new(),
    };
    let tool = ReplyToChannelTool::new(Arc::new(Reads(snapshot)), Some(Arc::new(Topic::default())));
    let error = tool
        .call(
            json!({"parts": [{"type": "text", "text": "done"}]}),
            context(Arc::new(MemoryArtifacts::default())),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("will not restore it"));
}
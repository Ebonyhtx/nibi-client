//! 话题工具（`ReadSessionContext` / `ReplyToChannel`）的行为。
//!
//! 判四件事：话题归档只读可信输入事实并翻页；回复绑定到开启这次工具调用的那条输入；没有授权输入时
//! 按 Node 的同一条错误失败；话题附件物化成会话 artifact。

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
use nibi_kernel_api::permission::PermissionMode;
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

#[tokio::test]
async fn the_topic_archive_reads_only_trusted_inputs_and_pages() {
    let records = json!([
        {"id": "m1", "chatId": "c1", "threadId": "t1", "text": "deploy failed", "senderId": "u", "senderType": "user", "createdAt": 1},
        {"id": "m2", "chatId": "c1", "threadId": "t1", "text": "bot reply", "senderId": "b", "senderType": "app", "createdAt": 2},
    ]);
    let snapshot = SessionSnapshot {
        messages: vec![user("u1", "question")],
        intents: vec![(MessageId::new("u1"), topic_intent("cmd-1", records))],
    };
    let tool = ReadSessionContextTool::new(Arc::new(Reads(snapshot)), None);
    let output = tool
        .call(
            json!({"query": "deploy", "strategy": "topic"}),
            context(Arc::new(MemoryArtifacts::default())),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    let text = tool_text(&output);
    assert!(text.contains("ReadSessionContext returned local context for sess_1."));
    assert!(text.contains("Previously archived messages only; unread history is not available."));
    assert!(text.contains("\"id\":\"m1\""));
    // 机器人自己发的消息不是可检索的历史。
    assert!(!text.contains("\"id\":\"m2\""));
}

#[tokio::test]
async fn the_reply_is_bound_to_the_input_that_opened_the_tool_call() {
    let snapshot = SessionSnapshot {
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

#[tokio::test]
async fn a_topic_attachment_is_materialized_as_a_session_artifact() {
    let store = Arc::new(MemoryArtifacts::default());
    let stored = store
        .put(
            &SessionId::new("sess_1"),
            ArtifactPurpose::Attachment,
            "image/png".to_owned(),
            vec![1, 2, 3],
        )
        .await
        .unwrap();
    let reference = format!(
        "nibi-artifact://{}/{}",
        stored.session.as_str(),
        stored.id.as_str()
    );
    let records = json!([
        {"id": "m1", "chatId": "c1", "threadId": "t1", "text": "look", "senderId": "u", "senderType": "user", "createdAt": 1, "attachments": [{"kind": "image"}]},
    ]);
    let snapshot = SessionSnapshot {
        messages: vec![user("u1", "question")],
        intents: vec![(MessageId::new("u1"), topic_intent("cmd-1", records))],
    };
    let topic = Arc::new(Topic {
        replies: Mutex::new(Vec::new()),
        resource: Some(TopicResource {
            reference,
            file_name: "shot.png".to_owned(),
            mime: "image/png".to_owned(),
            bytes: 3,
        }),
    });
    let tool = ReadSessionContextTool::new(Arc::new(Reads(snapshot)), Some(topic));
    let output = tool
        .call(
            json!({
                "query": "look",
                "strategy": "topic",
                "attachment": {"messageId": "m1", "index": 0},
            }),
            context(store),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    assert!(tool_text(&output).contains("nibi-artifact://sess_1/tool-result-2"));
}

/// 断词（Node `tokenizeQuery`）：小写、ASCII 词与汉字串；长度 < 2 的丢掉，汉字串补二字切片。
#[test]
fn query_terms_follow_the_node_tokenizer() {
    assert_eq!(tokenize_query("Deploy FAILED"), ["deploy", "failed"]);
    // 单字符丢掉（`< 2` 的规则）；`a.b/c-d` 是同一个词（Node 的 `[a-z0-9_./-]+`）。
    assert!(tokenize_query("a x").is_empty());
    assert_eq!(tokenize_query("src/a.rs"), ["src/a.rs"]);
    // 汉字串：整串与所有二字切片都要（Node 的 `match.slice(i, i + 2)`）。
    let terms = tokenize_query("部署失败");
    assert!(terms.contains(&"部署失败".to_owned()), "{terms:?}");
    assert!(terms.contains(&"部署".to_owned()), "{terms:?}");
    assert!(terms.contains(&"署失".to_owned()), "{terms:?}");
    assert!(terms.contains(&"失败".to_owned()), "{terms:?}");
    // 两个汉字只给整串，不补切片。
    assert_eq!(tokenize_query("部署"), ["部署"]);
}

/// 打分（Node `scoreSearchText`）：整句命中加 20，每个命中的词加 `3 + min(次数, 5)`。
#[test]
fn scores_follow_the_node_weights() {
    let terms = tokenize_query("deploy");
    assert_eq!(score_search_text("nothing here", "deploy", &terms), 0.0);
    // 整句（就是这个词）命中 20，词本身再 3 + 1。
    assert_eq!(score_search_text("deploy failed", "deploy", &terms), 24.0);
    // 整句不在、只有词在：3 + 1。
    assert_eq!(
        score_search_text("please redeploy it", "deploy now", &terms),
        4.0
    );
    // 出现 7 次也只加 5（整句 `deploy` 也命中，所以再加 20）。
    let many = "deploy deploy deploy deploy deploy deploy deploy";
    assert_eq!(score_search_text(many, "deploy", &terms), 20.0 + 3.0 + 5.0);
    // 整句命中再加 20。
    assert_eq!(
        score_search_text("please deploy now", "please deploy", &terms),
        20.0 + 4.0
    );
}

/// `relevant`：命中的片段排在前面（Node 的 20 分整句命中 + 每词 3 分），只看时间序会拿到无关的尾部。
#[tokio::test]
async fn relevant_context_picks_the_matching_messages() {
    let snapshot = SessionSnapshot {
        messages: vec![
            user("u1", "we discussed the deploy pipeline earlier"),
            user("u2", "lunch plans"),
            user("u3", "another unrelated message"),
        ],
        intents: Vec::new(),
    };
    let tool = ReadSessionContextTool::new(Arc::new(Reads(snapshot)), None);
    let output = tool
        .call(
            json!({"query": "deploy pipeline", "strategy": "relevant", "sessionId": "sess_other"}),
            context(Arc::new(MemoryArtifacts::default())),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    let text = tool_text(&output);
    assert!(text.contains("deploy pipeline"), "{text}");
    assert!(!text.contains("lunch plans"), "{text}");
    assert!(!text.contains("another unrelated message"), "{text}");
}

/// `handoff` 不看命中：从最后一条往前取满预算（Node `selectTailWithinBudget`）。
#[tokio::test]
async fn handoff_context_is_the_tail() {
    let snapshot = SessionSnapshot {
        messages: vec![
            user("u1", "early deploy note"),
            user("u2", "middle"),
            user("u3", "last words"),
        ],
        intents: Vec::new(),
    };
    let tool = ReadSessionContextTool::new(Arc::new(Reads(snapshot)), None);
    let output = tool
        .call(
            json!({"query": "deploy", "strategy": "handoff", "sessionId": "sess_other"}),
            context(Arc::new(MemoryArtifacts::default())),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    let text = tool_text(&output);
    // 预算足够时三条都在，顺序是时间序。
    assert!(text.contains("early deploy note"), "{text}");
    assert!(text.contains("last words"), "{text}");
    let early = text.find("early deploy note").unwrap();
    let last = text.find("last words").unwrap();
    assert!(early < last, "{text}");
}

/// 一个词都不命中时退化成最后 12 条（Node 的兜底），不是空结果。
#[tokio::test]
async fn relevant_context_falls_back_to_the_tail_without_a_match() {
    let messages: Vec<Message> = (0..20)
        .map(|index| user(&format!("u{index}"), &format!("message {index}")))
        .collect();
    let snapshot = SessionSnapshot {
        messages,
        intents: Vec::new(),
    };
    let tool = ReadSessionContextTool::new(Arc::new(Reads(snapshot)), None);
    let output = tool
        .call(
            json!({"query": "nothing matches this", "strategy": "relevant", "sessionId": "sess_other"}),
            context(Arc::new(MemoryArtifacts::default())),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    let text = tool_text(&output);
    assert!(text.contains("message 19"), "{text}");
    assert!(text.contains("message 8"), "{text}");
    assert!(!text.contains("message 7"), "{text}");
}

/// 没有归档话题时不能把「会话不存在」告诉模型：topic 只读当前会话。
#[test]
fn topic_not_found_does_not_claim_the_session_is_missing() {
    let text = model_content(&json!({
        "status": "not_found",
        "strategy": "topic",
        "sessionId": "sess_1",
        "content": "",
    }));
    assert_eq!(
        text,
        "No archived topic discussion was found for session sess_1. The session exists, but it has no archived group-topic messages (or none have been admitted yet)."
    );
    let text = model_content(&json!({
        "status": "not_found",
        "strategy": "relevant",
        "sessionId": "sess_2",
        "content": "",
    }));
    assert_eq!(text, "Session sess_2 was not found.");
}

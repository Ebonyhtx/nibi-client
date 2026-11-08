//! 旧会话入口经 `Handler` 的真实分派：参数映射、快照回包与 CAS 错误码。用最小 Kernel/Handle
//! 替身，不碰存储与模型。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::stream::{self, BoxStream, StreamExt};
use nibi_kernel_base::TaskScope;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::goal::{ActiveGoal, GoalView};
use nibi_kernel_api::ids::{EnvironmentId, MessageId, SessionId, TraceId};
use nibi_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::{PermissionMode, ToolPolicy};
use super::imported_history;
use nibi_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandEnvelope, CreateSession, Delivery, Kernel, KernelError,
    SequencedEvent, SessionHandle, SessionView,
};
use nibi_kernel_api::store::{
    MessageTime, SessionFilter, SessionKind, SessionMeta, SessionSummary,
};
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

type Sent = Arc<Mutex<Vec<CommandEnvelope>>>;
type Created = Arc<Mutex<Vec<CreateSession>>>;
type Parents = Arc<Mutex<Vec<Option<SessionId>>>>;
type Policies = Arc<Mutex<Vec<ToolPolicy>>>;
type Deferred = Arc<Mutex<Vec<Option<SessionId>>>>;

fn selection() -> ModelSelection {
    ModelSelection {
        provider: "p".to_owned(),
        model: "m".to_owned(),
        reasoning: None,
        connection: None,
    }
}

fn view(id: &str) -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: SessionId::new(id),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("env"),
                root: EnvPath::new("/work"),
            },
            title: "Test".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
        },
        messages: vec![Message::User(UserMessage {
            id: MessageId::new("u1"),
            content: vec![ContentBlock::Text {
                text: "hello".to_owned(),
            }],
            origin: UserOrigin::Human,
        })],
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
        pending: Vec::new(),
        queue: Vec::new(),
        last_seq: 1,
        revision: 7,
        running: false,
        background: Vec::new(),
        peer_held: Vec::new(),
        context_usage: None,
        context_notice: Default::default(),
        output_speed: None,
        launches: Vec::new(),
        model_turns: Vec::new(),
        input_intents: Vec::new(),
    }
}

struct FakeHandle {
    view: SessionView,
    sent: Sent,
    draft: bool,
}

#[async_trait]
impl SessionHandle for FakeHandle {
    fn id(&self) -> &SessionId {
        &self.view.meta.id
    }

    fn is_draft(&self) -> bool {
        self.draft
    }

    async fn send(&self, command: CommandEnvelope) -> KernelAck {
        self.sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(command);
        KernelAck::Accepted {
            result: Value::Null,
        }
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.clone())
    }

    async fn goal(&self) -> Result<GoalView, KernelError> {
        Ok(GoalView {
            active: Some(ActiveGoal {
                condition: "tests pass".to_owned(),
                iterations: 0,
                set_at_ms: 1,
                tokens: 0,
                last_reason: None,
            }),
            achieved: None,
        })
    }
}

struct FakeKernel {
    view: SessionView,
    selected: Mutex<ModelSelection>,
    sent: Sent,
    created: Created,
    policies: Policies,
    parents: Parents,
    deferred: Deferred,
    draft: bool,
}

#[async_trait]
impl Kernel for FakeKernel {
    async fn create_session(&self, request: CreateSession) -> Result<SessionId, KernelError> {
        *self
            .selected
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = request.selection.clone();
        self.created
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(request.clone());
        Ok(request.id.unwrap_or_else(|| SessionId::new("sess_new")))
    }

    async fn create_session_with_parent(
        &self,
        request: CreateSession,
        parent: Option<SessionId>,
    ) -> Result<SessionId, KernelError> {
        self.parents
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(parent);
        self.create_session(request).await
    }

    async fn create_session_deferred(
        &self,
        request: CreateSession,
        parent: Option<SessionId>,
    ) -> Result<SessionId, KernelError> {
        self.deferred
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(parent);
        self.create_session(request).await
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        let mut view = self.view.clone();
        view.selection = self
            .selected
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        Ok(Arc::new(FakeHandle {
            view,
            sent: self.sent.clone(),
            draft: self.draft,
        }))
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn session_message_times(
        &self,
        _session: &SessionId,
    ) -> Result<HashMap<MessageId, MessageTime>, KernelError> {
        let mut times = HashMap::new();
        times.insert(
            MessageId::new("u1"),
            MessageTime {
                created_at_ms: 1234,
                updated_at_ms: Some(1234),
            },
        );
        Ok(times)
    }

    async fn set_session_tool_policy(
        &self,
        _session: &SessionId,
        policy: ToolPolicy,
    ) -> Result<(), KernelError> {
        self.policies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(policy);
        Ok(())
    }
}

fn server(kernel: Arc<dyn Kernel>) -> Arc<Server> {
    let scope = TaskScope::root("legacy-session-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(
        peer,
        Arc::new(nibi_kernel_api::testing::FixedClock(5)),
    ));
    Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ))
}

type Fakes = (Arc<Server>, Sent, Created, Policies, Parents, Deferred);

fn fake_all(id: &str) -> Fakes {
    fake_all_with(id, false)
}

fn fake_all_with(id: &str, draft: bool) -> Fakes {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let created = Arc::new(Mutex::new(Vec::new()));
    let policies = Arc::new(Mutex::new(Vec::new()));
    let parents = Arc::new(Mutex::new(Vec::new()));
    let deferred = Arc::new(Mutex::new(Vec::new()));
    let kernel = Arc::new(FakeKernel {
        view: view(id),
        selected: Mutex::new(selection()),
        sent: sent.clone(),
        created: created.clone(),
        policies: policies.clone(),
        parents: parents.clone(),
        deferred: deferred.clone(),
        draft,
    });
    (server(kernel), sent, created, policies, parents, deferred)
}

fn fake(id: &str) -> (Arc<Server>, Sent, Created, Policies, Parents) {
    let (server, sent, created, policies, parents, _deferred) = fake_all(id);
    (server, sent, created, policies, parents)
}

#[tokio::test]
async fn create_maps_model_and_thought_level_then_returns_a_snapshot() {
    let (server, _sent, created, _policies, _parents) = fake("sess_new");
    let reply = Handler(server)
        .request(
            "session/create",
            json!({
                "workspace": {"workspacePath": "/work"},
                "sessionId": "sess_new",
                "model": {"providerId": "p", "modelId": "m"},
                "thoughtLevel": "high",
                "additionalDirectories": ["/extra"],
            }),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["session"]["sessionId"], "sess_new");
    assert_eq!(reply.result["settings"]["thoughtLevel"]["current"], "high");
    assert_eq!(reply.result["messages"][0]["info"]["time"]["created"], 1234);
    let created = created.lock().unwrap();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].id.as_ref().unwrap().as_str(), "sess_new");
    assert_eq!(created[0].selection.reasoning.as_deref(), Some("high"));
}

#[tokio::test]
async fn create_registers_the_tool_policy_with_the_kernel() {
    let (server, _sent, created, policies, _parents) = fake("sess_new");
    Handler(server)
        .request(
            "session/create",
            json!({
                "workspace": {"workspacePath": "/work"},
                "toolDenylist": ["Bash"],
            }),
        )
        .await
        .unwrap();
    assert_eq!(created.lock().unwrap().len(), 1);
    let policies = policies.lock().unwrap();
    assert_eq!(policies.len(), 1);
    assert_eq!(policies[0].deny, ["Bash"]);
}

#[tokio::test]
async fn create_records_the_parent_session() {
    let (server, _sent, created, _policies, parents) = fake("sess_child");
    Handler(server)
        .request(
            "session/create",
            json!({
                "workspace": {"workspacePath": "/work"},
                "sessionId": "sess_child",
                "parentSessionId": "sess_parent",
            }),
        )
        .await
        .unwrap();
    assert_eq!(created.lock().unwrap().len(), 1);
    let parents = parents.lock().unwrap();
    assert_eq!(parents.len(), 1);
    assert_eq!(
        parents[0].as_ref().map(SessionId::as_str),
        Some("sess_parent")
    );
}

#[tokio::test]
async fn create_with_deferred_persistence_asks_for_a_draft() {
    let (server, _sent, created, _policies, _parents, deferred) = fake_all("sess_new");
    let reply = Handler(server)
        .request(
            "session/create",
            json!({
                "workspace": {"workspacePath": "/work"},
                "sessionId": "sess_new",
                "persistence": "deferred",
            }),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["session"]["sessionId"], "sess_new");
    assert_eq!(deferred.lock().unwrap().len(), 1, "the draft path is used");
    assert_eq!(created.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn create_rejects_an_unknown_persistence() {
    let (server, _sent, created, _policies, _parents) = fake("sess_new");
    let error = match Handler(server)
        .request(
            "session/create",
            json!({
                "workspace": {"workspacePath": "/work"},
                "sessionId": "sess_new",
                "persistence": "eventually",
            }),
        )
        .await
    {
        Ok(_) => panic!("expected the persistence value to be refused"),
        Err(error) => error,
    };
    assert!(error.message.contains("persistence"), "{}", error.message);
    assert!(created.lock().unwrap().is_empty());
}

#[tokio::test]
async fn close_honours_expected_persistence() {
    let (server, _sent, _created, _policies, _parents, _deferred) = fake_all_with("sess_1", true);
    // 先把会话打开（deferred 的 create 会经 bridge 打开它）。
    Handler(server.clone())
        .request(
            "session/create",
            json!({
                "workspace": {"workspacePath": "/work"},
                "sessionId": "sess_1",
                "persistence": "deferred",
            }),
        )
        .await
        .unwrap();
    // 草稿还在：期望 immediate 的条件关闭不成立，Host 不能把它当真任务关掉。
    let reply = Handler(server.clone())
        .request(
            "session/close",
            json!({"sessionId": "sess_1", "expectedPersistence": "immediate"}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["closed"], false);
    // 期望 deferred：正常关闭草稿。
    let reply = Handler(server)
        .request(
            "session/close",
            json!({"sessionId": "sess_1", "expectedPersistence": "deferred"}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["closed"], true);
}

#[test]
fn imported_history_maps_claude_and_shared_context() {
    let (title, created, history) = imported_history(&json!({
        "importedHistory": {
            "source": "claudeCode",
            "title": "Migrated",
            "createdAt": 5,
            "messages": [
                {"role": "user", "content": "hi", "timestamp": 1},
                {"role": "assistant", "content": "yo"}
            ]
        }
    }))
    .unwrap();
    assert_eq!(title.as_deref(), Some("Migrated"));
    assert_eq!(created, Some(5));
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].role, "user");
    assert_eq!(history[1].content, "yo");

    let (_, _, history) = imported_history(&json!({
        "importedHistory": {
            "source": "sharedContext",
            "title": "Shared",
            "markdown": "# context"
        }
    }))
    .unwrap();
    assert_eq!(history[0].content, "# context");
}

#[tokio::test]
async fn create_fails_closed_when_the_kernel_cannot_import_history() {
    let (server, _sent, created, _policies, _parents) = fake("sess_new");
    let error = match Handler(server)
        .request(
            "session/create",
            json!({
                "workspace": {"workspacePath": "/work"},
                "importedHistory": {"source": "claudeCode", "messages": []},
            }),
        )
        .await
    {
        Ok(_) => panic!("expected imported history to be refused"),
        Err(error) => error,
    };
    assert!(error.message.contains("imported session history"));
    assert!(created.lock().unwrap().is_empty());
}

#[tokio::test]
async fn set_model_sends_set_model_and_reports_the_snapshot() {
    let (server, sent, _created, _policies, _parents) = fake("sess_1");
    let reply = Handler(server)
        .request(
            "session/setModel",
            json!({
                "sessionId": "sess_1",
                "model": {"providerId": "p2", "modelId": "m2"},
                "expectedRevision": 7,
            }),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["session"]["sessionId"], "sess_1");
    let sent = sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert!(matches!(
        &sent[0].command,
        Command::SetModel { selection } if selection.provider == "p2" && selection.model == "m2"
    ));
}

#[tokio::test]
async fn a_stale_revision_is_rejected_with_the_node_error_code() {
    let (server, sent, _created, _policies, _parents) = fake("sess_1");
    let error = match Handler(server)
        .request(
            "session/setMode",
            json!({"sessionId": "sess_1", "mode": "yolo", "expectedRevision": 6}),
        )
        .await
    {
        Ok(_) => panic!("expected a revision mismatch"),
        Err(error) => error,
    };
    assert_eq!(error.code, -32009);
    assert_eq!(error.data.unwrap()["actualRevision"], 7);
    assert!(sent.lock().unwrap().is_empty());
}

/// 旧输入入口：提交后立刻 ACK，带当前 revision；命令是 `Submit`（纯文本、立刻发送）。
#[tokio::test]
async fn send_prompt_acknowledges_with_the_state_revision() {
    let (server, sent, _created, _policies, _parents) = fake("sess_1");
    let reply = Handler(server)
        .request(
            "session/send",
            json!({"sessionId": "sess_1", "content": "hi", "inputId": "inp_1"}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["sessionId"], "sess_1");
    assert_eq!(reply.result["accepted"], true);
    assert_eq!(reply.result["stateRevision"], 7);
    let commands = sent.lock().unwrap();
    assert_eq!(commands.len(), 1);
    // `inputId` 是 Host 的幂等键：同一条输入重投时按同一个命令 id 去重。
    assert_eq!(commands[0].id.as_str(), "inp_1");
    assert!(matches!(
        &commands[0].command,
        Command::Submit { text, delivery, attachments }
            if text == "hi" && *delivery == Delivery::Queue && attachments.is_empty()
    ));
}

/// 一轮还在跑时旧入口不再接受新输入（Node `record.activeAbortController` 的同一裁决）。
#[tokio::test]
async fn send_prompt_is_rejected_while_a_turn_is_running() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let mut running = view("sess_1");
    running.running = true;
    let kernel = Arc::new(FakeKernel {
        view: running,
        selected: Mutex::new(selection()),
        sent: sent.clone(),
        created: Arc::new(Mutex::new(Vec::new())),
        policies: Arc::new(Mutex::new(Vec::new())),
        parents: Arc::new(Mutex::new(Vec::new())),
        deferred: Arc::new(Mutex::new(Vec::new())),
        draft: false,
    });
    let error = match Handler(server(kernel))
        .request(
            "session/send",
            json!({"sessionId": "sess_1", "content": "hi"}),
        )
        .await
    {
        Ok(_) => panic!("expected the active prompt to be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.code, -32010);
    assert!(sent.lock().unwrap().is_empty());
}

/// 子代理会话只读：旧入口不能绕过 V4 的用户输入准入。
#[tokio::test]
async fn send_prompt_refuses_subagent_sessions() {
    let mut subagent = view("sess_child");
    subagent.meta.kind = SessionKind::Subagent;
    let kernel = Arc::new(FakeKernel {
        view: subagent,
        selected: Mutex::new(selection()),
        sent: Arc::new(Mutex::new(Vec::new())),
        created: Arc::new(Mutex::new(Vec::new())),
        policies: Arc::new(Mutex::new(Vec::new())),
        parents: Arc::new(Mutex::new(Vec::new())),
        deferred: Arc::new(Mutex::new(Vec::new())),
        draft: false,
    });
    let error = match Handler(server(kernel))
        .request(
            "session/send",
            json!({"sessionId": "sess_child", "content": "hi"}),
        )
        .await
    {
        Ok(_) => panic!("expected the subagent session to be read-only"),
        Err(error) => error,
    };
    assert_eq!(error.code, -32010);
    assert_eq!(error.data.unwrap()["reasonCode"], "guard.subagentReadOnly");
}

/// 内联附件（GUI 的 `kind`/`mimeType`/`dataBase64`）变成内容块：图片在前、正文在后。
#[tokio::test]
async fn send_prompt_turns_inline_attachments_into_content_blocks() {
    let (server, sent, _created, _policies, _parents) = fake("sess_1");
    Handler(server)
        .request(
            "session/send",
            json!({
                "sessionId": "sess_1",
                "content": "这张图里是什么",
                "attachments": [{
                    "kind": "image",
                    "filename": "shot.png",
                    "mimeType": "image/png",
                    "dataBase64": "aGVsbG8=",
                }],
            }),
        )
        .await
        .unwrap();
    let commands = sent.lock().unwrap();
    let Command::SubmitContent { content, delivery } = &commands[0].command else {
        panic!("expected SubmitContent, got {:?}", commands[0].command);
    };
    assert_eq!(*delivery, Delivery::Queue);
    assert_eq!(content.len(), 2);
    assert!(matches!(
        &content[0],
        ContentBlock::Image { source: nibi_kernel_api::message::ImageSource::Base64 { media_type, data } }
            if media_type == "image/png" && data == "aGVsbG8="
    ));
    assert!(matches!(&content[1], ContentBlock::Text { text } if text == "这张图里是什么"));
}

/// `text/*` 附件读成文本块（≤64 KiB），不是一行说明。
#[tokio::test]
async fn send_prompt_inlines_text_attachments() {
    let (server, sent, _created, _policies, _parents) = fake("sess_1");
    Handler(server)
        .request(
            "session/send",
            json!({
                "sessionId": "sess_1",
                "content": "总结这个日志",
                "attachments": [{
                    "kind": "file",
                    "filename": "notes.txt",
                    "mimeType": "text/plain; charset=utf-8",
                    "dataBase64": "aGVsbG8K",
                }],
            }),
        )
        .await
        .unwrap();
    let commands = sent.lock().unwrap();
    let Command::SubmitContent { content, .. } = &commands[0].command else {
        panic!("expected SubmitContent, got {:?}", commands[0].command);
    };
    assert!(matches!(&content[0], ContentBlock::Text { text } if text == "hello\n"));
    assert!(matches!(&content[1], ContentBlock::Text { text } if text == "总结这个日志"));
}

/// 内核没有内容块可承载的附件类型（视频、任意文件）降级成一行说明，不让整次发送失败
/// （Node `filePartToContentBlock` 的 `[Attached …]` 兜底）。
#[tokio::test]
async fn send_prompt_degrades_unsupported_attachment_kinds() {
    let (server, sent, _created, _policies, _parents) = fake("sess_1");
    Handler(server)
        .request(
            "session/send",
            json!({
                "sessionId": "sess_1",
                "content": "看看这个",
                "attachments": [{
                    "kind": "video",
                    "filename": "clip.mp4",
                    "mimeType": "video/mp4",
                    "dataBase64": "aGVsbG8=",
                }],
            }),
        )
        .await
        .unwrap();
    let commands = sent.lock().unwrap();
    let Command::SubmitContent { content, .. } = &commands[0].command else {
        panic!("expected SubmitContent, got {:?}", commands[0].command);
    };
    assert!(matches!(
        &content[0],
        ContentBlock::Text { text } if text == "[Attached video/mp4: clip.mp4]"
    ));
    assert!(matches!(&content[1], ContentBlock::Text { text } if text == "看看这个"));
}

#[tokio::test]
async fn messages_applies_the_after_and_limit_window() {
    let (server, _sent, _created, _policies, _parents) = fake("sess_1");
    let reply = Handler(server)
        .request(
            "session/messages",
            json!({"sessionId": "sess_1", "limit": 1}),
        )
        .await
        .unwrap();
    let messages = reply.result["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["info"]["role"], "user");
}

#[tokio::test]
async fn goal_show_returns_the_active_objective() {
    let (server, _sent, _created, _policies, _parents) = fake("sess_1");
    let reply = Handler(server)
        .request(
            "session/goal",
            json!({"sessionId": "sess_1", "action": "show"}),
        )
        .await
        .unwrap();
    assert!(
        reply.result["response"]
            .as_str()
            .unwrap()
            .contains("tests pass")
    );
    assert_eq!(reply.result["startedTurn"], false);
    assert_eq!(reply.result["snapshot"]["session"]["sessionId"], "sess_1");
}

#[tokio::test]
async fn compact_sends_a_compact_command_and_reports_accepted() {
    let (server, sent, _created, _policies, _parents) = fake("sess_1");
    let reply = Handler(server)
        .request(
            "session/compact",
            json!({"sessionId": "sess_1", "inputId": "i1", "expectedRevision": 7}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["compact"]["state"], "accepted");
    assert_eq!(reply.result["compact"]["inputId"], "i1");
    let sent = sent.lock().unwrap();
    assert!(matches!(sent[0].command, Command::Compact { .. }));
}

//! 订阅的续传与背压（Node `conversation-topic-publisher.ts` 的 `subscribeReserved` / `resyncReserved`
//! 与 `v4-gateway.ts` 的 `setConnectionFlowState`）。
//!
//! 判四件事：`base` 有效时回 `mode: "resume"` 并补发 `(base, current]`；已在当前序号时不发帧；
//! `resync` 同样优先续传；`saturated` 暂停投递、`drained` 补齐。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{
    Ack, CommandEnvelope, Kernel, KernelError, SequencedEvent, SessionHandle, SessionView,
};
use nibi_kernel_api::store::{SessionFilter, SessionKind, SessionMeta, SessionSummary};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Reply};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, Lines, duplex};

use super::*;
use crate::context::Context;
use crate::server::{Defaults, Server};

struct Handle {
    view: SessionView,
    /// 会话是不是草稿（`session/create` 的 deferred）：sessions-index 据此过滤。
    draft: Arc<std::sync::atomic::AtomicBool>,
}

#[async_trait]
impl SessionHandle for Handle {
    fn id(&self) -> &SessionId {
        &self.view.meta.id
    }

    fn is_draft(&self) -> bool {
        self.draft.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn send(&self, _command: CommandEnvelope) -> Ack {
        Ack::Accepted {
            result: Value::Null,
        }
    }

    fn subscribe(
        &self,
        _after: Option<u64>,
    ) -> futures_util::stream::BoxStream<'static, SequencedEvent> {
        futures_util::stream::pending().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.clone())
    }
}

struct OnlySessions {
    view: SessionView,
    draft: Arc<std::sync::atomic::AtomicBool>,
    /// `sessions-index/reconcile` 的存储事实（按会话 id）。
    facts: std::collections::HashMap<String, nibi_kernel_api::store::SessionIndexFact>,
}

#[async_trait]
impl Kernel for OnlySessions {
    async fn create_session(
        &self,
        _request: nibi_kernel_api::session_api::CreateSession,
    ) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "session creation".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Err(KernelError::Unsupported {
            what: "sessions".to_owned(),
        })
    }

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        let mut view = self.view.clone();
        view.meta.id = session.clone();
        Ok(Arc::new(Handle {
            view,
            draft: self.draft.clone(),
        }))
    }

    async fn session_index_fact(
        &self,
        session: &SessionId,
    ) -> Result<Option<nibi_kernel_api::store::SessionIndexFact>, KernelError> {
        Ok(self.facts.get(session.as_str()).cloned())
    }
}

fn view() -> SessionView {
    view_with_kind(SessionKind::Interactive)
}

fn view_with_kind(kind: SessionKind) -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: SessionId::new("sess_1"),
            kind,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            title: "t".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1_000,
        },
        messages: Vec::new(),
        selection: nibi_kernel_api::model::ModelSelection {
            provider: "p".to_owned(),
            model: "m".to_owned(),
            reasoning: None,
            connection: None,
        },
        mode: PermissionMode::Default,
        plan: false,
        pending: Vec::new(),
        queue: Vec::new(),
        last_seq: 0,
        revision: 0,
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

/// Host 侧读线（物理帧就是一行 JSON 通知）。
struct Wire(Lines<BufReader<DuplexStream>>);

impl Wire {
    /// 下一条会话帧的逻辑帧（`params.frame`，跳过其他通知）。
    async fn next_frame(&mut self) -> Value {
        loop {
            let line = tokio::time::timeout(Duration::from_secs(2), self.0.next_line())
                .await
                .expect("timed out waiting for a frame")
                .expect("reading the line failed")
                .expect("the connection closed");
            let value: Value = serde_json::from_str(&line).expect("a JSON line");
            if value["method"] == crate::context::FRAME {
                return value["params"]["frame"].clone();
            }
        }
    }

    async fn no_frame(&mut self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(150), self.0.next_line())
                .await
                .is_err(),
            "an unexpected frame was written"
        );
    }
}

fn harness() -> (
    Arc<Server>,
    Wire,
    TaskScope,
    nibi_kernel_base::Task<()>,
    Arc<std::sync::atomic::AtomicBool>,
) {
    harness_with_facts(std::collections::HashMap::new())
}

fn harness_with_facts(
    facts: std::collections::HashMap<String, nibi_kernel_api::store::SessionIndexFact>,
) -> (
    Arc<Server>,
    Wire,
    TaskScope,
    nibi_kernel_base::Task<()>,
    Arc<std::sync::atomic::AtomicBool>,
) {
    harness_full(facts, SessionKind::Interactive)
}

fn harness_full(
    facts: std::collections::HashMap<String, nibi_kernel_api::store::SessionIndexFact>,
    kind: SessionKind,
) -> (
    Arc<Server>,
    Wire,
    TaskScope,
    nibi_kernel_base::Task<()>,
    Arc<std::sync::atomic::AtomicBool>,
) {
    let scope = TaskScope::root("subscribe-test", |_| {});
    let (agent_out, host_in) = duplex(1 << 20);
    let (peer, writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> =
        Arc::new(nibi_kernel_api::testing::FixedClock(1));
    let draft = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let server = Arc::new(Server::new(
        Arc::new(Context::new(peer, clock)),
        Arc::new(OnlySessions {
            view: view_with_kind(kind),
            draft: draft.clone(),
            facts,
        }),
        scope.spawner(),
        Defaults {
            selection: nibi_kernel_api::model::ModelSelection {
                provider: "p".into(),
                model: "m".into(),
                reasoning: None,
                connection: None,
            },
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));
    (
        server,
        Wire(BufReader::new(host_in).lines()),
        scope,
        writer,
        draft,
    )
}

/// 直接调处理方：`Reply.then` 由连接的写侧执行，测试里手动跑一次。
async fn run(reply: Reply) -> Value {
    let Reply { result, then } = reply;
    if let Some(after) = then {
        after().await;
    }
    result
}

#[tokio::test]
async fn a_subscription_resumes_from_the_client_watermark() {
    let (server, mut wire, _scope, _writer, _draft) = harness();
    let topic = "conversation/sess_1";
    let result = run(subscribe(&server, &json!({"topic": topic, "connectionId": "c1"}))
        .await
        .unwrap())
    .await;
    assert_eq!(result["ack"]["mode"], "snapshot");
    let epoch = result["ack"]["logEpoch"].as_str().unwrap().to_owned();
    let first = wire.next_frame().await;
    assert_eq!(first["payload"]["kind"], "snapshot");
    assert_eq!(first["toSeq"], 0);

    let live = server.bridge.get(&SessionId::new("sess_1")).unwrap();
    live.sink
        .set_hook_admission(Some(json!({"pendingCount": 1, "bundleDigest": "b"})))
        .await;
    let online = wire.next_frame().await;
    assert_eq!(online["payload"]["kind"], "deltas");
    assert_eq!((online["fromSeq"].as_u64(), online["toSeq"].as_u64()), (Some(0), Some(1)));

    // 水位已到当前序号：ack 换成 resume，但不需要补发。
    let result = run(subscribe(
        &server,
        &json!({"topic": topic, "connectionId": "c1", "base": {"logEpoch": epoch, "seq": 1}}),
    )
    .await
    .unwrap())
    .await;
    assert_eq!(result["ack"]["mode"], "resume");
    let subscription = result["ack"]["subscriptionId"].as_str().unwrap().to_owned();
    wire.no_frame().await;

    live.sink.set_hook_admission(None).await;
    let online = wire.next_frame().await;
    assert_eq!((online["fromSeq"].as_u64(), online["toSeq"].as_u64()), (Some(1), Some(2)));

    // resync 带落后水位：续传 (1, 2]，不相交也不丢一段。
    let result = run(resync(
        &server,
        &json!({"topic": topic, "subscriptionId": subscription, "base": {"logEpoch": epoch, "seq": 1}}),
    )
    .await
    .unwrap())
    .await;
    assert_eq!(result["ack"]["mode"], "resume");
    let replay = wire.next_frame().await;
    assert_eq!(replay["payload"]["kind"], "deltas");
    assert_eq!((replay["fromSeq"].as_u64(), replay["toSeq"].as_u64()), (Some(1), Some(2)));
    assert_eq!(replay["payload"]["deltas"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_watermark_from_another_generation_falls_back_to_a_snapshot() {
    let (server, mut wire, _scope, _writer, _draft) = harness();
    let topic = "conversation/sess_1";
    let _ = run(subscribe(&server, &json!({"topic": topic, "connectionId": "c1"}))
        .await
        .unwrap())
    .await;
    let _ = wire.next_frame().await;
    let result = run(subscribe(
        &server,
        &json!({"topic": topic, "connectionId": "c1", "base": {"logEpoch": "epoch-other", "seq": 0}}),
    )
    .await
    .unwrap())
    .await;
    assert_eq!(result["ack"]["mode"], "snapshot");
    assert_eq!(wire.next_frame().await["payload"]["kind"], "snapshot");
}

#[tokio::test]
async fn a_saturated_connection_is_paused_until_drained() {
    let (server, mut wire, _scope, _writer, _draft) = harness();
    let topic = "conversation/sess_1";
    run(subscribe(&server, &json!({"topic": topic, "connectionId": "c1"}))
        .await
        .unwrap())
    .await;
    let _ = wire.next_frame().await;

    run(flow(&server, &json!({"connectionId": "c1", "state": "saturated"}))
        .await
        .unwrap())
    .await;
    let live = server.bridge.get(&SessionId::new("sess_1")).unwrap();
    live.sink
        .set_hook_admission(Some(json!({"pendingCount": 1, "bundleDigest": "b"})))
        .await;
    wire.no_frame().await;

    run(flow(&server, &json!({"connectionId": "c1", "state": "drained"}))
        .await
        .unwrap())
    .await;
    let resumed = wire.next_frame().await;
    assert_eq!(resumed["payload"]["kind"], "deltas");
    // 暂停期间的一整段（位置没动过）。
    assert_eq!((resumed["fromSeq"].as_u64(), resumed["toSeq"].as_u64()), (Some(0), Some(1)));
}

#[tokio::test]
async fn a_closed_connection_drops_its_subscriptions() {
    let (server, mut wire, _scope, _writer, _draft) = harness();
    let topic = "conversation/sess_1";
    run(subscribe(&server, &json!({"topic": topic, "connectionId": "c1"}))
        .await
        .unwrap())
    .await;
    let _ = wire.next_frame().await;
    run(flow(&server, &json!({"connectionId": "c1", "state": "closed"}))
        .await
        .unwrap())
    .await;
    let live = server.bridge.get(&SessionId::new("sess_1")).unwrap();
    live.sink
        .set_hook_admission(Some(json!({"pendingCount": 1, "bundleDigest": "b"})))
        .await;
    wire.no_frame().await;
}

impl Wire {
    /// 在 `ms` 内把到达的帧全读出来（用于断言某个主题「没有说话」）。
    async fn frames_within(&mut self, ms: u64) -> Vec<Value> {
        let mut frames = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_millis(ms), self.0.next_line()).await {
                Ok(Ok(Some(line))) => {
                    let value: Value = serde_json::from_str(&line).expect("a JSON line");
                    if value["method"] == crate::context::FRAME {
                        frames.push(value["params"]["frame"].clone());
                    }
                }
                _ => return frames,
            }
        }
    }
}

/// 草稿（deferred，还没有会话行）不进会话列表：Node 的 sessions-index 用
/// `host.isDraftSession` 把这类会话从快照与 `session.upserted` 里过滤掉，点「新建任务」
/// 才不会在侧栏多出一条空会话。首条输入把它提升成真会话之后，第一帧就补发列表行。
#[tokio::test]
async fn a_draft_session_stays_out_of_the_sessions_index_until_promoted() {
    let (server, mut wire, _scope, _writer, draft) = harness();
    let index_topic = "sessions-index//w";
    let conversation_topic = "conversation/sess_1";

    run(subscribe(
        &server,
        &json!({"topic": index_topic, "connectionId": "c1"}),
    )
    .await
    .unwrap())
    .await;
    let snapshot = wire.next_frame().await;
    assert_eq!(snapshot["topic"], index_topic);
    assert_eq!(snapshot["payload"]["kind"], "snapshot");
    assert!(
        snapshot["payload"]["snapshot"]["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    draft.store(true, std::sync::atomic::Ordering::SeqCst);
    run(subscribe(
        &server,
        &json!({"topic": conversation_topic, "connectionId": "c1"}),
    )
    .await
    .unwrap())
    .await;
    let first = wire.next_frame().await;
    assert_eq!(first["topic"], conversation_topic);

    // 草稿上的状态变化只发会话自己的增量，不发列表行。
    let live = server.bridge.get(&SessionId::new("sess_1")).unwrap();
    live.sink
        .set_hook_admission(Some(json!({"pendingCount": 1, "bundleDigest": "b"})))
        .await;
    let frames = wire.frames_within(200).await;
    assert!(
        frames.iter().any(|frame| frame["topic"] == conversation_topic),
        "the conversation delta should still be delivered"
    );
    assert!(
        frames.iter().all(|frame| frame["topic"] != index_topic),
        "a draft must not publish a sessions-index row"
    );

    // 提升（首条输入落库）之后，下一个状态变化就把列表行补上。
    draft.store(false, std::sync::atomic::Ordering::SeqCst);
    live.sink.set_hook_admission(None).await;
    let frames = wire.frames_within(300).await;
    let upserted = frames
        .iter()
        .find(|frame| {
            frame["topic"] == index_topic
                && frame["payload"]["deltas"][0]["op"] == "session.upserted"
        })
        .expect("the promoted session should be published to the index");
    assert_eq!(
        upserted["payload"]["deltas"][0]["session"]["sessionId"],
        "sess_1"
    );

    // 软删除之后必须把这一行从列表里撤掉（Node `session.removed`）：只删存储不发这一帧，
    // Host 的 tasks-index 会按旧行把会话加回来，归档管理里的删除永远“失败”。
    server.topics.remove("sess_1");
    let frames = wire.frames_within(300).await;
    let removed = frames
        .iter()
        .find(|frame| {
            frame["topic"] == index_topic
                && frame["payload"]["deltas"][0]["op"] == "session.removed"
        })
        .expect("a deleted session should be removed from the index");
    assert_eq!(removed["payload"]["deltas"][0]["sessionId"], "sess_1");

    // 新的订阅者拿到的快照里没有它（内存行已撤、存储行由 kernel 过滤）。
    run(subscribe(
        &server,
        &json!({"topic": index_topic, "connectionId": "c2"}),
    )
    .await
    .unwrap())
    .await;
    let snapshot = wire.next_frame().await;
    assert_eq!(snapshot["topic"], index_topic);
    assert!(
        snapshot["payload"]["snapshot"]["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

/// `sessions-index/reconcile` 与 Node 同口径：软删除的会话回 `exists: true, deleted: true`（Host 靠它
/// 把 tasks-index 的行落墓碑），别的目录的会话回 `exists: false`。
#[tokio::test]
async fn reconcile_reports_soft_deleted_sessions_as_deleted() {
    let fact = |title: &str, directory: &str, deleted: bool| {
        nibi_kernel_api::store::SessionIndexFact {
            title: title.to_owned(),
            title_source: Some("custom".to_owned()),
            created_at_ms: 10,
            updated_at_ms: 20,
            deleted,
            last_outcome: None,
            directory: directory.to_owned(),
            workspace_id: None,
        }
    };
    let facts = std::collections::HashMap::from([
        ("sess_gone".to_owned(), fact("gone", "/w", true)),
        ("sess_live".to_owned(), fact("live", "/w", false)),
        ("sess_other".to_owned(), fact("other", "/elsewhere", false)),
    ]);
    let (server, _wire, _scope, _writer, _draft) = harness_with_facts(facts);
    let result = run(reconcile(
        &server,
        &json!({
            "workspaceId": "/w",
            "sessionIds": ["sess_gone", "sess_live", "sess_other", "sess_missing"],
        }),
    )
    .await
    .unwrap())
    .await;
    let sessions = result["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 4);
    assert_eq!(
        sessions[0],
        json!({
            "sessionId": "sess_gone",
            "exists": true,
            "deleted": true,
            "title": "gone",
            "titleSource": "custom",
            "createdAt": 10,
            "updatedAt": 20,
        })
    );
    assert_eq!(sessions[1]["sessionId"], "sess_live");
    assert_eq!(sessions[1]["exists"], true);
    assert_eq!(sessions[1]["deleted"], false);
    assert_eq!(sessions[2], json!({"sessionId": "sess_other", "exists": false, "deleted": false}));
    assert_eq!(sessions[3], json!({"sessionId": "sess_missing", "exists": false, "deleted": false}));
}

/// 辅助对话不进会话列表：Node 的 sessions-index 只发布 task-list 类型（`selection_side_chat` 不在
/// 白名单里），侧栏因此不会出现一条「Selection side chat」。
#[tokio::test]
async fn a_selection_side_chat_stays_out_of_the_sessions_index() {
    let (server, mut wire, _scope, _writer, _draft) = harness_full(
        std::collections::HashMap::new(),
        SessionKind::SelectionSideChat,
    );
    let index_topic = "sessions-index//w";
    let conversation_topic = "conversation/sess_1";
    run(subscribe(
        &server,
        &json!({"topic": index_topic, "connectionId": "c1"}),
    )
    .await
    .unwrap())
    .await;
    let snapshot = wire.next_frame().await;
    assert_eq!(snapshot["topic"], index_topic);
    assert!(
        snapshot["payload"]["snapshot"]["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    run(subscribe(
        &server,
        &json!({"topic": conversation_topic, "connectionId": "c1"}),
    )
    .await
    .unwrap())
    .await;
    let first = wire.next_frame().await;
    assert_eq!(first["topic"], conversation_topic);

    let live = server.bridge.get(&SessionId::new("sess_1")).unwrap();
    live.sink
        .set_hook_admission(Some(json!({"pendingCount": 1, "bundleDigest": "b"})))
        .await;
    let frames = wire.frames_within(200).await;
    assert!(
        frames.iter().any(|frame| frame["topic"] == conversation_topic),
        "the side chat still gets its own conversation deltas"
    );
    assert!(
        frames.iter().all(|frame| frame["topic"] != index_topic),
        "a side chat must not publish a sessions-index row"
    );
}

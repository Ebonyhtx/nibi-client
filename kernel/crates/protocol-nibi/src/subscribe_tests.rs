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

struct Handle(SessionView);

#[async_trait]
impl SessionHandle for Handle {
    fn id(&self) -> &SessionId {
        &self.0.meta.id
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
        Ok(self.0.clone())
    }
}

struct OnlySessions(SessionView);

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
        let mut view = self.0.clone();
        view.meta.id = session.clone();
        Ok(Arc::new(Handle(view)))
    }
}

fn view() -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: SessionId::new("sess_1"),
            kind: SessionKind::Interactive,
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

fn harness() -> (Arc<Server>, Wire, TaskScope, nibi_kernel_base::Task<()>) {
    let scope = TaskScope::root("subscribe-test", |_| {});
    let (agent_out, host_in) = duplex(1 << 20);
    let (peer, writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> =
        Arc::new(nibi_kernel_api::testing::FixedClock(1));
    let server = Arc::new(Server::new(
        Arc::new(Context::new(peer, clock)),
        Arc::new(OnlySessions(view())),
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
    let (server, mut wire, _scope, _writer) = harness();
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
    let (server, mut wire, _scope, _writer) = harness();
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
    let (server, mut wire, _scope, _writer) = harness();
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
    let (server, mut wire, _scope, _writer) = harness();
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

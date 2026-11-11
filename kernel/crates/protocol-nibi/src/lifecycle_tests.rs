//! `session/lifecycle/*` 的协议面：参数形状、回包字段、租约、`stopping` 闸门（上游
//! `fault.sessionLifecycle.stopping`）与 `session/lifecycle/changed` 的订阅路由。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::residency::{
    ResidencyLease, SessionLifecycleFailure, SessionLifecycleObserver, SessionLifecycleOperation,
    SessionLifecycleSnapshot, SessionLifecycleState,
};
use nibi_kernel_api::session_api::{
    Ack, CommandEnvelope, CreateSession, Kernel, KernelError, SequencedEvent, SessionHandle,
    SessionView,
};
use nibi_kernel_api::store::{SessionFilter, SessionKind, SessionMeta, SessionSummary};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, Lines, duplex};

use crate::context::Context;
use crate::server::{
    Defaults, Handler, SESSION_LIFECYCLE_CHANGED, SESSION_LIFECYCLE_STOPPING, Server,
};

#[derive(Default)]
struct Seen {
    states: Mutex<Vec<SessionId>>,
    ensure: Mutex<Vec<(SessionId, Option<String>)>>,
    stops: Mutex<Vec<SessionId>>,
    restarts: Mutex<Vec<(SessionId, Option<String>)>>,
    leases: Mutex<Vec<Vec<SessionId>>>,
    /// 协议层注入的观察者（`install_lifecycle_observer`）。
    observer: Mutex<Option<Arc<dyn SessionLifecycleObserver>>>,
}

struct FakeKernel {
    seen: Arc<Seen>,
    stopping: SessionId,
}

#[async_trait]
impl Kernel for FakeKernel {
    async fn create_session(&self, _request: CreateSession) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "session creation".to_owned(),
        })
    }

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Ok(Arc::new(TestHandle {
            view: view(session),
        }))
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn acquire_residency_lease(&self, sessions: &[SessionId]) -> Option<ResidencyLease> {
        self.seen.leases.lock().unwrap().push(sessions.to_vec());
        Some(ResidencyLease::new(|| {}))
    }

    async fn session_lifecycle_state(
        &self,
        session: &SessionId,
    ) -> Result<SessionLifecycleSnapshot, KernelError> {
        self.seen.states.lock().unwrap().push(session.clone());
        if session.as_str() == "sess_missing" {
            return Err(KernelError::NotFound {
                session: session.clone(),
            });
        }
        Ok(SessionLifecycleSnapshot {
            session_id: session.clone(),
            state: SessionLifecycleState::Faulted,
            generation: 2,
            revision: 7,
            last_error: Some(SessionLifecycleFailure {
                operation: SessionLifecycleOperation::Restart,
                code: "resourceReleaseFailed".to_owned(),
                message: "release failed".to_owned(),
            }),
        })
    }

    async fn ensure_session_ready(
        &self,
        session: &SessionId,
        workspace: Option<WorkspaceRef>,
    ) -> Result<(), KernelError> {
        self.seen.ensure.lock().unwrap().push((
            session.clone(),
            workspace.map(|workspace| workspace.root.as_str().to_owned()),
        ));
        Ok(())
    }

    async fn stop_session_runtime(&self, session: &SessionId) -> Result<(), KernelError> {
        self.seen.stops.lock().unwrap().push(session.clone());
        Ok(())
    }

    async fn restart_session_runtime(
        &self,
        session: &SessionId,
        workspace: Option<WorkspaceRef>,
    ) -> Result<(), KernelError> {
        self.seen.restarts.lock().unwrap().push((
            session.clone(),
            workspace.map(|workspace| workspace.root.as_str().to_owned()),
        ));
        Ok(())
    }

    fn is_session_stopping(&self, session: &SessionId) -> bool {
        session == &self.stopping
    }

    fn set_session_lifecycle_observer(&self, observer: Arc<dyn SessionLifecycleObserver>) {
        *self.seen.observer.lock().unwrap() = Some(observer);
    }
}

/// 协议桥冷打开用的会话句柄：视图固定，事件流永远没有事件（推送测试不需要会话内容）。
struct TestHandle {
    view: SessionView,
}

#[async_trait]
impl SessionHandle for TestHandle {
    fn id(&self) -> &SessionId {
        &self.view.meta.id
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

fn view(session: &SessionId) -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: session.clone(),
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
        selection: selection(),
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

fn selection() -> ModelSelection {
    ModelSelection {
        provider: "p".to_owned(),
        model: "m".to_owned(),
        reasoning: None,
        connection: None,
    }
}

fn server() -> (Arc<Seen>, Arc<Server>) {
    let scope = TaskScope::root("lifecycle-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(
        peer,
        Arc::new(nibi_kernel_api::testing::FixedClock(1_000)),
    ));
    let seen = Arc::new(Seen::default());
    let kernel = Arc::new(FakeKernel {
        seen: seen.clone(),
        stopping: SessionId::new("sess_stopping"),
    });
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));
    server.install_lifecycle_observer();
    (seen, server)
}

/// Host 侧的读线（一行一条 JSON-RPC 消息）。
struct Wire(Lines<BufReader<DuplexStream>>);

impl Wire {
    /// 下一条消息（不筛方法）。
    async fn next_message(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(2), self.0.next_line())
            .await
            .expect("timed out waiting for a message")
            .expect("reading the line failed")
            .expect("the connection closed");
        serde_json::from_str(&line).expect("a JSON line")
    }

    /// 下一条指定方法的通知（跳过别的消息），返回 `params`。
    async fn next_notification(&mut self, method: &str) -> Value {
        loop {
            let value = self.next_message().await;
            if value["method"] == method {
                return value["params"].clone();
            }
        }
    }

    /// 一段时间内没有任何消息写出。
    async fn no_message(&mut self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(150), self.0.next_line())
                .await
                .is_err(),
            "an unexpected message was written"
        );
    }

    /// 丢掉这段时间里已经写出/随时写出的消息（冷开放的播种帧等），之后再看静默。
    async fn drain(&mut self, quiet: Duration) {
        while tokio::time::timeout(quiet, self.0.next_line())
            .await
            .is_ok()
        {}
    }
}

/// 带读线的装配：通知测试要看见写出去的消息。
fn notify_harness() -> (
    Arc<Seen>,
    Arc<Server>,
    Wire,
    TaskScope,
    nibi_kernel_base::Task<()>,
) {
    let scope = TaskScope::root("lifecycle-notify-test", |_| {});
    let (agent_out, host_in) = duplex(1 << 16);
    let (peer, writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(
        peer,
        Arc::new(nibi_kernel_api::testing::FixedClock(1_000)),
    ));
    let seen = Arc::new(Seen::default());
    let kernel = Arc::new(FakeKernel {
        seen: seen.clone(),
        stopping: SessionId::new("sess_stopping"),
    });
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));
    server.install_lifecycle_observer();
    (
        seen,
        server,
        Wire(BufReader::new(host_in).lines()),
        scope,
        writer,
    )
}

/// 直接调处理方：`Reply.then` 由连接的写侧执行，测试里手动跑一次。
async fn run(reply: nibi_kernel_protocol_core::connection::Reply) -> Value {
    let nibi_kernel_protocol_core::connection::Reply { result, then } = reply;
    if let Some(after) = then {
        after().await;
    }
    result
}

/// 模拟状态机的一次发布（内核会经 `LifecycleHost::on_change` 调进来）。
fn emit(seen: &Arc<Seen>, snapshot: &SessionLifecycleSnapshot) {
    let observer = seen
        .observer
        .lock()
        .unwrap()
        .clone()
        .expect("the protocol observer was not installed");
    observer.lifecycle_changed(snapshot);
}

fn faulty_snapshot(session: &str, state: SessionLifecycleState) -> SessionLifecycleSnapshot {
    SessionLifecycleSnapshot {
        session_id: SessionId::new(session),
        state,
        generation: 2,
        revision: 7,
        last_error: Some(SessionLifecycleFailure {
            operation: SessionLifecycleOperation::Restart,
            code: "resourceReleaseFailed".to_owned(),
            message: "release failed".to_owned(),
        }),
    }
}

async fn request(server: &Arc<Server>, method: &str, params: Value) -> Result<Value, String> {
    match Handler(server.clone()).request(method, params).await {
        Ok(reply) => Ok(reply.result),
        Err(error) => Err(error.to_string()),
    }
}

/// `getState` 回包与 `sessionLifecycleSnapshotSchema` 同形：camelCase、`lastError` 恒在场。
#[tokio::test]
async fn get_state_returns_the_frozen_snapshot_shape() {
    let (seen, server) = server();
    let value = request(
        &server,
        "session/lifecycle/getState",
        json!({"sessionId": "sess_a"}),
    )
    .await
    .unwrap();
    assert_eq!(
        value,
        json!({
            "sessionId": "sess_a",
            "state": "faulted",
            "generation": 2,
            "revision": 7,
            "lastError": {
                "operation": "restart",
                "code": "resourceReleaseFailed",
                "message": "release failed",
            },
        })
    );
    assert_eq!(seen.states.lock().unwrap().as_slice(), [SessionId::new("sess_a")]);
    // 查询是观察：不取租约。
    assert!(seen.leases.lock().unwrap().is_empty());
}

/// 四个方法的参数：ensureReady/restart 带可选 workspace，stop 只认 sessionId；回包是 `completed: true`。
#[tokio::test]
async fn lifecycle_mutations_forward_the_params_and_complete() {
    let (seen, server) = server();
    let value = request(
        &server,
        "session/lifecycle/ensureReady",
        json!({"sessionId": "sess_a", "workspace": {"workspaceKey": "k", "workspacePath": "/work"}}),
    )
    .await
    .unwrap();
    assert_eq!(value, json!({"completed": true}));
    let value = request(
        &server,
        "session/lifecycle/restart",
        json!({"sessionId": "sess_b"}),
    )
    .await
    .unwrap();
    assert_eq!(value, json!({"completed": true}));
    let value = request(
        &server,
        "session/lifecycle/stop",
        json!({"sessionId": "sess_c"}),
    )
    .await
    .unwrap();
    assert_eq!(value, json!({"completed": true}));

    assert_eq!(
        seen.ensure.lock().unwrap().as_slice(),
        [(SessionId::new("sess_a"), Some("/work".to_owned()))]
    );
    assert_eq!(
        seen.restarts.lock().unwrap().as_slice(),
        [(SessionId::new("sess_b"), None)]
    );
    assert_eq!(
        seen.stops.lock().unwrap().as_slice(),
        [SessionId::new("sess_c")]
    );
    // 生命周期变更用进程级租约（空会话列表），并按会话的互斥由 owner 管理。
    assert_eq!(
        seen.leases.lock().unwrap().as_slice(),
        [vec![], vec![], vec![]]
    );
}

/// 业务请求按参数里的会话取租约；订阅按 topic 归到会话。
#[tokio::test]
async fn requests_hold_a_lease_for_their_sessions() {
    let (seen, server) = server();
    let _ = request(
        &server,
        "v4/conversation/subscribe",
        json!({"topic": "conversation/sess_sub", "connectionId": "c", "clientMode": "desktop-continuous"}),
    )
    .await;
    let leases = seen.leases.lock().unwrap().clone();
    assert_eq!(leases, [vec![SessionId::new("sess_sub")]]);
}

/// `stopping` 期间 `v4/command` 与订阅被拒（`fault.sessionLifecycle.stopping`）。
#[tokio::test]
async fn stopping_rejects_commands_and_subscriptions() {
    let (_seen, server) = server();
    let command = request(
        &server,
        "v4/command",
        json!({"commandId": "c1", "clientId": "client", "sessionId": "sess_stopping",
               "type": "sendText", "payload": {}, "issuedAt": 1}),
    )
    .await;
    assert!(command.unwrap_err().contains(SESSION_LIFECYCLE_STOPPING));
    let subscribe = request(
        &server,
        "v4/conversation/subscribe",
        json!({"topic": "conversation/sess_stopping", "connectionId": "c", "clientMode": "desktop-continuous"}),
    )
    .await;
    assert!(subscribe.unwrap_err().contains(SESSION_LIFECYCLE_STOPPING));
}

/// 不存在的会话按 `sessionUnavailable` 回（-32004）。
#[tokio::test]
async fn get_state_reports_a_missing_session_as_unavailable() {
    let (_seen, server) = server();
    let error = request(
        &server,
        "session/lifecycle/getState",
        json!({"sessionId": "sess_missing"}),
    )
    .await
    .unwrap_err();
    assert!(error.contains("Session unavailable"), "{error}");
}

/// 参数缺 sessionId 是 `-32602`。
#[tokio::test]
async fn lifecycle_methods_require_a_session_id() {
    let (_seen, server) = server();
    let error = request(&server, "session/lifecycle/getState", json!({}))
        .await
        .unwrap_err();
    assert!(error.contains("Invalid params"), "{error}");
}

/// 订阅了这个会话的连接收到每次状态发布；参数与 `getState` 的回包逐字段相同
/// （`sessionLifecycleSnapshotSchema`，`lastError` 恒在场）。
#[tokio::test]
async fn lifecycle_changes_are_pushed_to_session_subscribers() {
    let (seen, server, mut wire, _scope, _writer) = notify_harness();
    let topic = "conversation/sess_a";
    let subscribed = crate::subscribe::subscribe(
        &server,
        &json!({"topic": topic, "connectionId": "c1", "clientMode": "desktop-continuous"}),
    )
    .await
    .unwrap();
    run(subscribed).await;
    let first = wire.next_message().await;
    assert_eq!(first["method"], crate::context::FRAME);
    let subscription = server.bridge.get(&SessionId::new("sess_a")).unwrap();
    assert!(subscription.sink.has_subscribers());

    // 状态机的一次发布 = 一条通知。
    for (state, revision) in [
        (SessionLifecycleState::Starting, 1_u64),
        (SessionLifecycleState::Ready, 2),
        (SessionLifecycleState::Stopping, 3),
        (SessionLifecycleState::Faulted, 4),
    ] {
        let mut snapshot = faulty_snapshot("sess_a", state);
        snapshot.revision = revision;
        emit(&seen, &snapshot);
        let params = wire.next_notification(SESSION_LIFECYCLE_CHANGED).await;
        assert_eq!(params["sessionId"], "sess_a");
        assert_eq!(params["state"], state.as_str());
        assert_eq!(params["revision"], revision);
        // 与 getState 同一形状：`lastError` 的字段都在场（这里用固定的失败事实比较）。
        assert_eq!(params["lastError"]["operation"], "restart");
        assert_eq!(params["lastError"]["code"], "resourceReleaseFailed");
        assert_eq!(params["lastError"]["message"], "release failed");
    }
    wire.no_message().await;

    // 同一条快照走两条路：通知的 params 与 `getState` 的回包逐字段相同。
    let state = request(
        &server,
        "session/lifecycle/getState",
        json!({"sessionId": "sess_a"}),
    )
    .await
    .unwrap();
    emit(
        &seen,
        &faulty_snapshot("sess_a", SessionLifecycleState::Faulted),
    );
    let params = wire.next_notification(SESSION_LIFECYCLE_CHANGED).await;
    assert_eq!(params, state);
    assert_eq!(state["state"], "faulted");
    assert_eq!(state["generation"], 2);
    assert_eq!(state["revision"], 7);
}

/// 没有订阅的连接不收到通知；没有人订阅读线也不阻塞、不报错。
#[tokio::test]
async fn lifecycle_changes_skip_sessions_without_subscribers() {
    let (seen, server, mut wire, _scope, _writer) = notify_harness();

    // 会话没有在协议桥里打开：没有订阅者，静默跳过。
    emit(
        &seen,
        &faulty_snapshot("sess_unopened", SessionLifecycleState::Ready),
    );
    wire.no_message().await;

    // 打开了但没有订阅：同样不推（只有订阅者关心生命周期变化）。
    let opened = server.live(&SessionId::new("sess_open")).await.unwrap();
    assert!(!opened.sink.has_subscribers());
    wire.drain(Duration::from_millis(50)).await;
    emit(
        &seen,
        &faulty_snapshot("sess_open", SessionLifecycleState::Ready),
    );
    wire.no_message().await;

    // 推一个别的会话的状态不会串到已订阅的会话上。
    let subscribed = crate::subscribe::subscribe(
        &server,
        &json!({"topic": "conversation/sess_a", "connectionId": "c1",
                "clientMode": "desktop-continuous"}),
    )
    .await
    .unwrap();
    run(subscribed).await;
    // 订阅的首帧先到（与生命周期通知无关）；排掉它再看静默。
    let first = wire.next_message().await;
    assert_eq!(first["method"], crate::context::FRAME);
    emit(
        &seen,
        &faulty_snapshot("sess_unopened", SessionLifecycleState::Stopping),
    );
    wire.no_message().await;

    // 订阅了就会收到（证明上面的静默是路由判定，不是读线坏了）。
    emit(
        &seen,
        &faulty_snapshot("sess_a", SessionLifecycleState::Ready),
    );
    let params = wire.next_notification(SESSION_LIFECYCLE_CHANGED).await;
    assert_eq!(params["sessionId"], "sess_a");
}

/// 连接已断开时推送失败，但生命周期事实不变：`getState` 仍给同一份快照。
#[tokio::test]
async fn a_failed_notification_does_not_change_lifecycle_facts() {
    let (seen, server, _wire, _scope, writer) = notify_harness();
    let subscribed = crate::subscribe::subscribe(
        &server,
        &json!({"topic": "conversation/sess_a", "connectionId": "c1",
                "clientMode": "desktop-continuous"}),
    )
    .await
    .unwrap();
    run(subscribed).await;

    // 写者停掉：连接的写队列不再有接收方（`try_notify` 返回假）。
    writer.abort();
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if !server.context.peer.try_notify("test/probe", &json!({})) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(closed.is_ok(), "the connection did not close");

    emit(
        &seen,
        &faulty_snapshot("sess_a", SessionLifecycleState::Ready),
    );
    let state = request(
        &server,
        "session/lifecycle/getState",
        json!({"sessionId": "sess_a"}),
    )
    .await
    .unwrap();
    assert_eq!(state["state"], "faulted");
    assert_eq!(state["generation"], 2);
    assert_eq!(state["revision"], 7);
}

//! `session/lifecycle/*` 的协议面：参数形状、回包字段、租约与 `stopping` 闸门（上游 `fault.sessionLifecycle.stopping`）。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::residency::{
    ResidencyLease, SessionLifecycleFailure, SessionLifecycleOperation, SessionLifecycleSnapshot,
    SessionLifecycleState,
};
use nibi_kernel_api::session_api::{CreateSession, Kernel, KernelError, SessionHandle};
use nibi_kernel_api::store::{SessionFilter, SessionSummary};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server, SESSION_LIFECYCLE_STOPPING};

#[derive(Default)]
struct Seen {
    states: Mutex<Vec<SessionId>>,
    ensure: Mutex<Vec<(SessionId, Option<String>)>>,
    stops: Mutex<Vec<SessionId>>,
    restarts: Mutex<Vec<(SessionId, Option<String>)>>,
    leases: Mutex<Vec<Vec<SessionId>>>,
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
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "session open".to_owned(),
        })
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
    (seen, server)
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

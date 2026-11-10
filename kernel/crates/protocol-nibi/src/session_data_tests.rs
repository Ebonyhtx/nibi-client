//! `v4/storage/sessionData/measure|purge` 的协议面：上游 zod `.strict()` 的参数形状、转发与回包。
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Kernel, KernelError, SessionHandle};
use nibi_kernel_api::session_data::{
    SessionDataBytes, SessionDataFailure, SessionDataKept, SessionDataKeptReason,
    SessionDataMeasure, SessionDataMemoryBytes, SessionDataParams, SessionDataPurge,
};
use nibi_kernel_api::store::{SessionFilter, SessionSummary};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

#[derive(Default)]
struct Seen {
    measure: Mutex<Vec<SessionDataParams>>,
    purge: Mutex<Vec<SessionDataParams>>,
}

struct FakeKernel {
    seen: Arc<Seen>,
}

#[async_trait]
impl Kernel for FakeKernel {
    async fn create_session(
        &self,
        _request: nibi_kernel_api::session_api::CreateSession,
    ) -> Result<SessionId, KernelError> {
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

    async fn measure_session_data(
        &self,
        params: SessionDataParams,
    ) -> Result<SessionDataMeasure, KernelError> {
        self.seen.measure.lock().unwrap().push(params);
        Ok(SessionDataMeasure {
            sessions: vec![
                SessionDataBytes {
                    session_id: SessionId::new("sess_a"),
                    bytes: 15,
                },
                SessionDataBytes {
                    session_id: SessionId::new("sess_b"),
                    bytes: 0,
                },
            ],
            memory: vec![SessionDataMemoryBytes {
                workspace_path: "/w/app".to_owned(),
                bytes: 4,
            }],
        })
    }

    async fn purge_session_data(
        &self,
        params: SessionDataParams,
    ) -> Result<SessionDataPurge, KernelError> {
        self.seen.purge.lock().unwrap().push(params);
        Ok(SessionDataPurge {
            deleted: vec![SessionDataBytes {
                session_id: SessionId::new("sess_a"),
                bytes: 15,
            }],
            kept: vec![SessionDataKept {
                session_id: SessionId::new("sess_b"),
                reason: SessionDataKeptReason::Referenced,
            }],
            failed: vec![SessionDataFailure {
                session_id: None,
                workspace_path: Some("/w/app".to_owned()),
                code: "EACCES".to_owned(),
            }],
            memory: vec![SessionDataMemoryBytes {
                workspace_path: "/w/app".to_owned(),
                bytes: 4,
            }],
        })
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
    let scope = TaskScope::root("session-data-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(
        peer,
        Arc::new(nibi_kernel_api::testing::FixedClock(1_000)),
    ));
    let seen = Arc::new(Seen::default());
    let kernel = Arc::new(FakeKernel { seen: seen.clone() });
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

async fn request_error(server: Arc<Server>, method: &str, params: Value) -> String {
    match Handler(server).request(method, params).await {
        Ok(_) => panic!("expected {method} to fail"),
        Err(error) => error.to_string(),
    }
}

#[tokio::test]
async fn measure_accepts_the_upstream_strict_shape_and_returns_its_fields() {
    let (seen, server) = server();
    let reply = Handler(server)
        .request(
            "v4/storage/sessionData/measure",
            json!({
                "sessionIds": ["sess_a", "sess_b"],
                "directories": [
                    {"workspacePath": "/w/app"},
                    {"workspacePath": "/w/app2", "workspaceIdentity": "remote-1"},
                ],
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        reply.result,
        json!({
            "sessions": [
                {"sessionId": "sess_a", "bytes": 15},
                {"sessionId": "sess_b", "bytes": 0},
            ],
            "memory": [{"workspacePath": "/w/app", "bytes": 4}],
        })
    );
    let params = seen.measure.lock().unwrap();
    assert_eq!(params[0].session_ids[1], SessionId::new("sess_b"));
    assert_eq!(
        params[0].directories[1].workspace_identity.as_deref(),
        Some("remote-1")
    );
}

#[tokio::test]
async fn purge_returns_deleted_kept_and_failed_in_the_upstream_shape() {
    let (seen, server) = server();
    let reply = Handler(server)
        .request(
            "v4/storage/sessionData/purge",
            json!({"sessionIds": ["sess_a"], "directories": []}),
        )
        .await
        .unwrap();
    assert_eq!(
        reply.result,
        json!({
            "deleted": [{"sessionId": "sess_a", "bytes": 15}],
            "kept": [{"sessionId": "sess_b", "reason": "referenced"}],
            "failed": [{"workspacePath": "/w/app", "code": "EACCES"}],
            "memory": [{"workspacePath": "/w/app", "bytes": 4}],
        })
    );
    assert_eq!(
        seen.purge.lock().unwrap()[0].session_ids,
        [SessionId::new("sess_a")]
    );
}

#[tokio::test]
async fn both_methods_reject_unknown_keys_and_bad_values_like_zod() {
    let (_seen, server) = server();
    for params in [
        json!({"sessionIds": []}),
        json!({"sessionIds": [], "directories": [], "extra": 1}),
        json!({"sessionIds": [""], "directories": []}),
        json!({"sessionIds": [1], "directories": []}),
        json!({"sessionIds": [], "directories": [{"workspacePath": ""}]}),
        json!({"sessionIds": [], "directories": [{"workspacePath": "/w", "workspaceIdentity": null}]}),
        json!({"sessionIds": [], "directories": [{"workspacePath": "/w", "extra": true}]}),
        json!({"sessionIds": [], "directories": "no"}),
        json!(null),
    ] {
        for method in [
            "v4/storage/sessionData/measure",
            "v4/storage/sessionData/purge",
        ] {
            let error = request_error(server.clone(), method, params.clone()).await;
            assert!(error.contains("Invalid params"), "{method}: {error}");
        }
    }
}

#[tokio::test]
async fn a_kernel_without_the_capability_returns_a_standard_error_not_method_not_found() {
    #[derive(Default)]
    struct NoData;
    #[async_trait]
    impl Kernel for NoData {
        async fn create_session(
            &self,
            _request: nibi_kernel_api::session_api::CreateSession,
        ) -> Result<SessionId, KernelError> {
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
    }

    let scope = TaskScope::root("session-data-no-data", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(
        peer,
        Arc::new(nibi_kernel_api::testing::FixedClock(1_000)),
    ));
    let server = Arc::new(Server::new(
        context,
        Arc::new(NoData),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));
    let error = match Handler(server)
        .request(
            "v4/storage/sessionData/measure",
            json!({"sessionIds": [], "directories": []}),
        )
        .await
    {
        Ok(_) => panic!("a kernel without the session data surface should fail"),
        Err(error) => error,
    };
    // 标准内部错误（-32603），不是 method-not-found（-32601）。
    assert_ne!(error.code, -32601);
    assert!(error.message.contains("not implemented"), "{error:?}");
}

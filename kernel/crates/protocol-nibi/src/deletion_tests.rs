//! `v4/storage/sessionData/deletionPreview|deletionExecute` 的协议面：严格参数形状、转发与回包、
//! 删成功后的 `session.removed`。
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_api::deletion::{
    DeletionBlock, DeletionOutcome, DeletionPreview, DeletionResult, RetainedArtifact,
    TitledSession,
};
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Kernel, KernelError, SessionHandle};
use nibi_kernel_api::store::{SessionFilter, SessionSummary};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, Lines};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

#[derive(Default)]
struct Seen {
    preview: Mutex<Vec<(SessionId, WorkspaceRef)>>,
    execute: Mutex<Vec<(SessionId, WorkspaceRef, String, String)>>,
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

    async fn deletion_preview(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
    ) -> Result<DeletionPreview, KernelError> {
        self.seen
            .preview
            .lock()
            .unwrap()
            .push((session.clone(), workspace.clone()));
        Ok(DeletionPreview {
            sessions: vec![session.clone(), SessionId::new("sess_child")],
            forks: vec![TitledSession {
                session: SessionId::new("sess_fork"),
                title: "fork".to_owned(),
            }],
            retained: vec![RetainedArtifact {
                session: session.clone(),
                artifact: "shared".to_owned(),
                file_name: "shared.png".to_owned(),
                referrers: vec![TitledSession {
                    session: SessionId::new("sess_fork"),
                    title: "fork".to_owned(),
                }],
            }],
            deleted_files: 2,
            blocked: None,
            incomplete: false,
            completed: false,
            revision: "rev-1".to_owned(),
        })
    }

    async fn delete_permanently(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        revision: &str,
        operation: &str,
    ) -> Result<DeletionResult, KernelError> {
        self.seen.execute.lock().unwrap().push((
            session.clone(),
            workspace.clone(),
            revision.to_owned(),
            operation.to_owned(),
        ));
        Ok(DeletionResult {
            outcome: DeletionOutcome::Deleted,
            sessions: vec![session.clone(), SessionId::new("sess_child")],
            retained: 1,
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

/// Host 侧读线（物理帧就是一行 JSON 通知）。
struct Wire(Lines<BufReader<DuplexStream>>);

impl Wire {
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

fn server() -> (
    Arc<Seen>,
    Arc<Server>,
    Wire,
    nibi_kernel_base::Task<()>,
    TaskScope,
) {
    let scope = TaskScope::root("deletion-test", |_| {});
    let (out, host_in) = tokio::io::duplex(1 << 16);
    let (peer, writer) = connection::start(out, &scope.spawner(), Options::default());
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
            environment: EnvironmentId::new("local"),
        },
        None,
    ));
    (
        seen,
        server,
        Wire(BufReader::new(host_in).lines()),
        writer,
        scope,
    )
}

fn workspace() -> Value {
    json!({"workspacePath": "/w/app", "workspaceIdentity": "local"})
}

async fn request_error(server: Arc<Server>, method: &str, params: Value) -> String {
    match Handler(server).request(method, params).await {
        Ok(_) => panic!("expected {method} to fail"),
        Err(error) => error.to_string(),
    }
}

#[tokio::test]
async fn preview_accepts_the_strict_shape_and_returns_its_fields() {
    let (seen, server, _wire, _writer, _scope) = server();
    let reply = Handler(server)
        .request(
            "v4/storage/sessionData/deletionPreview",
            json!({"sessionId": "sess_root", "workspace": workspace()}),
        )
        .await
        .unwrap();
    assert_eq!(
        reply.result,
        json!({
            "sessionId": "sess_root",
            "revision": "rev-1",
            "sessionIds": ["sess_root", "sess_child"],
            "forks": [{"sessionId": "sess_fork", "title": "fork"}],
            "retainedArtifacts": [{
                "sessionId": "sess_root",
                "artifactId": "shared",
                "fileName": "shared.png",
                "referrers": [{"sessionId": "sess_fork", "title": "fork"}],
            }],
            "deletedFiles": 2,
            "incomplete": false,
            "completed": false,
        })
    );
    let seen = seen.preview.lock().unwrap();
    assert_eq!(seen[0].0, SessionId::new("sess_root"));
    assert_eq!(seen[0].1.root, EnvPath::new("/w/app"));
    assert_eq!(seen[0].1.environment, EnvironmentId::new("local"));
}

#[tokio::test]
async fn execute_forwards_the_revision_and_operation_and_emits_session_removed() {
    let (_seen, server, mut wire, _writer, _scope) = server();
    // 列表里先有一行，删成功之后要发 `session.removed`（Host 的 tasks-index 靠它撤行）。
    server.topics.upsert(
        "local",
        json!({"sessionId": "sess_root", "workspaceId": "local", "title": "root"}),
    );
    server
        .topics
        .subscribe("sessions-index/local", "sub-1", "conn-1");
    server.topics.start(
        "sessions-index/local".to_owned(),
        "sub-1".to_owned(),
        Vec::new(),
        crate::wire::Purpose::Initial,
    );
    let snapshot = wire.next_frame().await;
    assert_eq!(
        snapshot["payload"]["snapshot"]["sessions"][0]["sessionId"],
        "sess_root"
    );

    let reply = Handler(server)
        .request(
            "v4/storage/sessionData/deletionExecute",
            json!({
                "sessionId": "sess_root",
                "workspace": workspace(),
                "revision": "rev-1",
                "operationId": "op-1",
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        reply.result,
        json!({
            "sessionId": "sess_root",
            "status": "deleted",
            "sessionIds": ["sess_root", "sess_child"],
            "retainedArtifacts": 1,
        })
    );

    let frames = wire.frames_within(300).await;
    let removed = frames
        .iter()
        .find(|frame| frame["payload"]["deltas"][0]["op"] == "session.removed")
        .expect("a deleted session should be removed from the index");
    assert_eq!(removed["topic"], "sessions-index/local");
    assert_eq!(removed["payload"]["deltas"][0]["sessionId"], "sess_root");
    // 只有列表里真有的那一行发增量（子代理会话不在列表里）。
    assert_eq!(frames.len(), 1, "{frames:?}");
}

#[tokio::test]
async fn execute_reports_blocked_outcomes_with_the_reason() {
    struct Blocked;
    #[async_trait]
    impl Kernel for Blocked {
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

        async fn delete_permanently(
            &self,
            session: &SessionId,
            _workspace: &WorkspaceRef,
            _revision: &str,
            _operation: &str,
        ) -> Result<DeletionResult, KernelError> {
            Ok(DeletionResult {
                outcome: DeletionOutcome::Blocked(DeletionBlock::Running),
                sessions: vec![session.clone()],
                retained: 0,
            })
        }
    }

    let scope = TaskScope::root("deletion-blocked", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(
        peer,
        Arc::new(nibi_kernel_api::testing::FixedClock(1_000)),
    ));
    let server = Arc::new(Server::new(
        context,
        Arc::new(Blocked),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
        None,
    ));
    let reply = Handler(server)
        .request(
            "v4/storage/sessionData/deletionExecute",
            json!({
                "sessionId": "sess_root",
                "workspace": {"workspacePath": "/w/app"},
                "revision": "rev-1",
                "operationId": "op-1",
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        reply.result,
        json!({
            "sessionId": "sess_root",
            "status": "blocked",
            "sessionIds": ["sess_root"],
            "retainedArtifacts": 0,
            "reason": "running",
        })
    );
}

#[tokio::test]
async fn both_methods_reject_unknown_keys_and_bad_values_like_zod() {
    let (_seen, server, _wire, _writer, _scope) = server();
    for params in [
        json!({}),
        json!({"sessionId": "", "workspace": {"workspacePath": "/w"}}),
        json!({"sessionId": "s", "workspace": {"workspacePath": ""}}),
        json!({"sessionId": "s", "workspace": {"workspacePath": "/w", "workspaceIdentity": null}}),
        json!({"sessionId": "s", "workspace": {"workspacePath": "/w", "extra": 1}}),
        json!({"sessionId": "s"}),
        json!({"sessionId": "s", "workspace": "/w"}),
        json!({"sessionId": "s", "workspace": {"workspacePath": "/w"}, "extra": true}),
        json!(null),
    ] {
        let error = request_error(
            server.clone(),
            "v4/storage/sessionData/deletionPreview",
            params.clone(),
        )
        .await;
        assert!(error.contains("Invalid params"), "{error}");
    }
    for params in [
        json!({"sessionId": "s", "workspace": {"workspacePath": "/w"}}),
        json!({"sessionId": "s", "workspace": {"workspacePath": "/w"}, "revision": ""}),
        json!({"sessionId": "s", "workspace": {"workspacePath": "/w"}, "operationId": "op"}),
        json!({"sessionId": "s", "workspace": {"workspacePath": "/w"}, "revision": "r", "operationId": ""}),
        json!({"sessionId": "s", "workspace": {"workspacePath": "/w"}, "revision": 1, "operationId": "op"}),
    ] {
        let error = request_error(
            server.clone(),
            "v4/storage/sessionData/deletionExecute",
            params,
        )
        .await;
        assert!(error.contains("Invalid params"), "{error}");
    }
}

#[tokio::test]
async fn a_kernel_without_the_capability_returns_a_standard_error_not_method_not_found() {
    #[derive(Default)]
    struct NoDeletion;
    #[async_trait]
    impl Kernel for NoDeletion {
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

    let scope = TaskScope::root("deletion-no-capability", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(
        peer,
        Arc::new(nibi_kernel_api::testing::FixedClock(1_000)),
    ));
    let server = Arc::new(Server::new(
        context,
        Arc::new(NoDeletion),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
        None,
    ));
    let error = match Handler(server)
        .request(
            "v4/storage/sessionData/deletionPreview",
            json!({"sessionId": "s", "workspace": {"workspacePath": "/w"}}),
        )
        .await
    {
        Ok(_) => panic!("a kernel without the deletion surface should fail"),
        Err(error) => error,
    };
    // 标准内部错误（-32603），不是 method-not-found（-32601）。
    assert_ne!(error.code, -32601);
    assert!(error.message.contains("not implemented"), "{error:?}");
}

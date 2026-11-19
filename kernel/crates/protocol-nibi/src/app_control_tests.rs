//! App 控制反向请求的协议测试：方法名、可信参数、回包解析、错误映射与 60 s 超时。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_api::app_control::{
    AppControlErrorCode, AppSessionControlHost, AppTrustedContext, ListProjectsInput,
    OpenSessionInput,
};
use nibi_kernel_api::session_control::{SessionArchiveReader, SessionRef, SessionRefKind};
use nibi_kernel_api::testing::FixedClock;
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Reply, Service};
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, duplex};

fn ctx() -> AppTrustedContext {
    AppTrustedContext {
        caller_session_id: "sess_caller".to_owned(),
        call_id: "toolu_9".to_owned(),
        turn_id: Some("turn_1".to_owned()),
        workspace_path: "/Users/dev/work".to_owned(),
        workspace_identity: Some("ws-1".to_owned()),
        ui_target: None,
    }
}

struct Silent;

#[async_trait]
impl Service for Silent {
    async fn request(&self, _method: &str, _params: Value) -> Result<Reply, RpcError> {
        std::future::pending::<()>().await;
        unreachable!()
    }
}

fn host(context: Arc<super::Context>) -> super::HostAppControl {
    super::HostAppControl::new(context)
}

#[tokio::test]
async fn list_projects_sends_the_allowlisted_method_and_trusted_params() {
    let scope = TaskScope::root("app-control-raw", |_| {});
    let (mut to_kernel, kernel_in) = duplex(1 << 20);
    let (kernel_out, from_kernel) = duplex(1 << 20);
    let (peer, _writer) = connection::start(kernel_out, &scope.spawner(), Options::default());
    let spawner = scope.spawner();
    let _serve = scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(kernel_in),
            peer.clone(),
            Arc::new(Silent),
            spawner,
            Options::default(),
        ),
    );
    let context = Arc::new(super::Context::new(peer, Arc::new(FixedClock(0))));
    let host = host(context);
    let pending = tokio::spawn(async move {
        host.list_projects(
            &ctx(),
            ListProjectsInput {
                query: Some("alpha".to_owned()),
            },
        )
        .await
    });
    let mut from_kernel = BufReader::new(from_kernel).lines();
    let line = tokio::time::timeout(Duration::from_secs(5), from_kernel.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let request: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(request["method"], "appControl/listProjects");
    assert_eq!(request["params"]["callerSessionId"], "sess_caller");
    assert_eq!(request["params"]["callId"], "toolu_9");
    assert_eq!(request["params"]["turnId"], "turn_1");
    assert_eq!(request["params"]["workspacePath"], "/Users/dev/work");
    assert_eq!(request["params"]["workspaceIdentity"], "ws-1");
    assert_eq!(request["params"]["input"], json!({"query": "alpha"}));
    // uiTarget 是 Host 绑定的，模型与内核都不传。
    assert!(request["params"].get("uiTarget").is_none());
    let id = request["id"].clone();
    let response = json!({
        "id": id,
        "result": {
            "ok": true,
            "result": {
                "projects": [{
                    "project": {"kind": "app", "projectId": "proj-1"},
                    "title": "Alpha",
                }],
                "searchScope": {"scopes": [{"kind": "app", "scope": "host"}], "unavailableSources": []},
            },
        },
    });
    to_kernel
        .write_all(format!("{response}\n").as_bytes())
        .await
        .unwrap();
    let result = pending.await.unwrap().unwrap();
    assert_eq!(result.projects[0].title, "Alpha");
    assert_eq!(result.search_scope.scopes.len(), 1);
}

#[tokio::test]
async fn session_archived_reads_the_host_task_index_without_a_tool_call() {
    let scope = TaskScope::root("app-control-archived", |_| {});
    let (mut to_kernel, kernel_in) = duplex(1 << 20);
    let (kernel_out, from_kernel) = duplex(1 << 20);
    let (peer, _writer) = connection::start(kernel_out, &scope.spawner(), Options::default());
    let spawner = scope.spawner();
    let _serve = scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(kernel_in),
            peer.clone(),
            Arc::new(Silent),
            spawner,
            Options::default(),
        ),
    );
    let context = Arc::new(super::Context::new(peer, Arc::new(FixedClock(0))));
    let host = host(context);
    let target = SessionRef {
        kind: SessionRefKind::Cli,
        workspace_path: "/Users/dev/work".to_owned(),
        workspace_identity: Some("ws-1".to_owned()),
        session_id: "sess_archived".to_owned(),
    };
    let pending =
        tokio::spawn(async move { SessionArchiveReader::is_session_archived(&host, &target).await });
    let mut from_kernel = BufReader::new(from_kernel).lines();
    let line = tokio::time::timeout(Duration::from_secs(5), from_kernel.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let request: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(request["method"], "appControl/sessionArchived");
    assert_eq!(
        request["params"]["input"],
        json!({"sessionId": "sess_archived"})
    );
    assert_eq!(request["params"]["workspacePath"], "/Users/dev/work");
    let id = request["id"].clone();
    let response = json!({
        "id": id,
        "result": {"ok": true, "result": {"archived": true}},
    });
    to_kernel
        .write_all(format!("{response}\n").as_bytes())
        .await
        .unwrap();
    assert_eq!(pending.await.unwrap().unwrap(), Some(true));
}

#[tokio::test]
async fn host_error_envelope_maps_to_the_stable_code() {
    let scope = TaskScope::root("app-control-error", |_| {});
    let (mut to_kernel, kernel_in) = duplex(1 << 20);
    let (kernel_out, from_kernel) = duplex(1 << 20);
    let (peer, _writer) = connection::start(kernel_out, &scope.spawner(), Options::default());
    let spawner = scope.spawner();
    let _serve = scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(kernel_in),
            peer.clone(),
            Arc::new(Silent),
            spawner,
            Options::default(),
        ),
    );
    let context = Arc::new(super::Context::new(peer, Arc::new(FixedClock(0))));
    let host = host(context);
    let pending = tokio::spawn(async move {
        host.open_session(
            &ctx(),
            OpenSessionInput {
                session_id: "sess_1".to_owned(),
            },
        )
        .await
    });
    let mut from_kernel = BufReader::new(from_kernel).lines();
    let line = tokio::time::timeout(Duration::from_secs(5), from_kernel.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let request: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(request["method"], "appControl/openSession");
    let response = json!({
        "id": request["id"],
        "result": {"ok": false, "error": {"code": "forbidden", "message": "outside the trusted scope"}},
    });
    to_kernel
        .write_all(format!("{response}\n").as_bytes())
        .await
        .unwrap();
    let error = pending.await.unwrap().unwrap_err();
    assert_eq!(error.code, AppControlErrorCode::Forbidden);
    assert!(error.message.contains("trusted scope"));
}

#[tokio::test(start_paused = true)]
async fn a_stalled_host_times_out_after_sixty_seconds() {
    let scope = TaskScope::root("app-control-timeout", |_| {});
    let silent: Arc<dyn Service> = Arc::new(Silent);
    let (kernel_out, kernel_in) = duplex(1 << 20);
    let (peer, _writer) = connection::start(kernel_out, &scope.spawner(), Options::default());
    let spawner = scope.spawner();
    let _serve = scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(kernel_in),
            peer.clone(),
            silent,
            spawner,
            Options::default(),
        ),
    );
    let context = Arc::new(super::Context::new(peer, Arc::new(FixedClock(0))));
    let host = host(context);
    let error = host
        .open_session(
            &ctx(),
            OpenSessionInput {
                session_id: "sess_1".to_owned(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, AppControlErrorCode::Unavailable);
    assert!(error.message.contains("timed out"), "{}", error.message);
}

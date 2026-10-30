//! 分享导入的本地状态：冷打开的种子与 `discardSharedContext` 的状态翻转。

use std::sync::Arc;

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::Kernel;
use rust_cli_kernel_api::store::{
    FrontendRecord, SessionKind, SessionMeta, SessionStore,
};
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryStore, ScriptedModel, SequentialIds, environments, selection,
};

use super::*;

fn kernel(store: Arc<MemoryStore>) -> LocalKernel {
    LocalKernel::new(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(Arc::new(
                rust_cli_kernel_api::testing::UnusedEnvironment,
            )),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    )
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/work"),
    }
}

async fn imported_session(store: &MemoryStore) -> SessionId {
    let id = SessionId::new("sess_import");
    store
        .create(SessionMeta {
            id: id.clone(),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: workspace(),
            title: "Imported share".to_owned(),
            trace: TraceId::new("sess_import"),
            created_at_ms: 0,
        })
        .await
        .unwrap();
    store
        .put_record(
            &id,
            &FrontendRecord {
                kind: "v4/shared_context_import".to_owned(),
                key: format!("v4_shared_context_import:{id}:share_1"),
                data: serde_json::json!({
                    "shareId": "share_1",
                    "shareUrl": "https://nibi.example/cn/share/abc123",
                    "contextId": "ctx_1",
                    "status": "pending",
                }),
            },
        )
        .await
        .unwrap();
    id
}

#[tokio::test]
async fn a_pending_import_is_seeded_and_discarding_flips_it() {
    let store = Arc::new(MemoryStore::default());
    let id = imported_session(&store).await;
    let kernel = kernel(store.clone());

    let seeded = kernel.shared_context_import(&id).await.unwrap().unwrap();
    assert_eq!(seeded.context_id, "ctx_1");
    assert_eq!(seeded.status, "pending");
    assert_eq!(seeded.title, "Imported share");
    assert_eq!(seeded.share_url, "https://nibi.example/cn/share/abc123");

    let discarded = kernel.discard_shared_context(&id, "ctx_1").await.unwrap().unwrap();
    assert_eq!(discarded.status, "discarded");
    // 只改 status，其余 provenance 原样保留。
    let records = store.records(&id, "v4/shared_context_import").await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].data["status"], "discarded");
    assert_eq!(records[0].data["shareId"], "share_1");
    assert_eq!(records[0].key, format!("v4_shared_context_import:{id}:share_1"));

    // 再丢一次：不是 pending，按 Node 的 fault 拒绝。
    let error = kernel.discard_shared_context(&id, "ctx_1").await.unwrap_err();
    assert!(
        error.to_string().contains("fault.command.inputRejected"),
        "{error}"
    );
    // 未知 contextId 同样拒绝。
    let error = kernel.discard_shared_context(&id, "ctx_missing").await.unwrap_err();
    assert!(error.to_string().contains("fault.command.inputRejected"), "{error}");
}

#[tokio::test]
async fn a_session_without_an_import_has_no_state() {
    let store = Arc::new(MemoryStore::default());
    let id = SessionId::new("sess_plain");
    store
        .create(SessionMeta {
            id: id.clone(),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: workspace(),
            title: String::new(),
            trace: TraceId::new("sess_plain"),
            created_at_ms: 0,
        })
        .await
        .unwrap();
    let kernel = kernel(store);
    assert!(kernel.shared_context_import(&id).await.unwrap().is_none());
}

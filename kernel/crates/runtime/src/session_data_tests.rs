//! `v4/storage/sessionData/measure|purge` 的内核语义：测量口径、运行中/被引用保留、幂等与不越界。
use std::sync::Arc;

use futures_util::StreamExt;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{CommandId, EnvironmentId, SessionId};
use nibi_kernel_api::model::{ModelError, ModelEvent, ModelPort, ModelRequest};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Command, CommandEnvelope, CreateSession, Delivery, Kernel};
use nibi_kernel_api::session_data::{
    SessionDataDirectory, SessionDataKeptReason, SessionDataParams,
};
use nibi_kernel_api::store::{SessionKind, SessionStore};
use nibi_kernel_api::testing::{
    FixedClock, MemoryStore, SequentialIds, UnusedEnvironment, environments, selection,
};
use tokio_util::sync::CancellationToken;

use crate::{Defaults, LocalKernel, Ports};

/// 永远不结束的模型：会话始终有一轮在跑，用来验证「运行中保留」。
struct PendingModel;

impl ModelPort for PendingModel {
    fn stream(
        &self,
        _request: ModelRequest,
        _cancel: CancellationToken,
    ) -> futures_util::stream::BoxStream<'static, Result<ModelEvent, ModelError>> {
        futures_util::stream::pending().boxed()
    }
}

fn kernel<E: nibi_kernel_api::testing::AllPorts + 'static>(
    store: Arc<MemoryStore>,
    env: Arc<E>,
) -> LocalKernel {
    LocalKernel::new(
        Ports {
            model: Arc::new(PendingModel),
            environments: environments(env),
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

fn environment() -> Arc<UnusedEnvironment> {
    Arc::new(UnusedEnvironment)
}

fn workspace(root: &str) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(root),
    }
}

fn create(id: &str, root: &str) -> CreateSession {
    CreateSession {
        id: Some(SessionId::new(id)),
        workspace: workspace(root),
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
    }
}

fn params(sessions: &[&str], directories: &[&str]) -> SessionDataParams {
    SessionDataParams {
        session_ids: sessions.iter().map(|id| SessionId::new(*id)).collect(),
        directories: directories
            .iter()
            .map(|path| SessionDataDirectory {
                workspace_path: (*path).to_owned(),
                workspace_identity: None,
            })
            .collect(),
    }
}

async fn create_child(store: &MemoryStore, id: &str, parent: &str, kind: SessionKind) {
    use nibi_kernel_api::ids::TraceId;
    use nibi_kernel_api::store::SessionMeta;
    store
        .create(SessionMeta {
            id: SessionId::new(id),
            kind,
            parent: Some(SessionId::new(parent)),
            workspace: workspace("/w/app"),
            title: id.to_owned(),
            trace: TraceId::new(id),
            created_at_ms: 1_000,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn measure_sums_owned_children_and_memory_without_opening_sessions() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone(), environment());
    // 直接写存储、不经过内核：measure 不应自己打开会话。
    use nibi_kernel_api::ids::TraceId;
    use nibi_kernel_api::store::{SessionMeta, SessionStore};
    store
        .create(SessionMeta {
            id: SessionId::new("sess_a"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: workspace("/w/app"),
            title: "a".to_owned(),
            trace: TraceId::new("sess_a"),
            created_at_ms: 1_000,
        })
        .await
        .unwrap();
    create_child(&store, "sess_sub", "sess_a", SessionKind::Subagent).await;
    store.set_session_files(&SessionId::new("sess_a"), 10);
    store.set_session_files(&SessionId::new("sess_sub"), 5);
    store.set_memory_bytes("/w/app", 7);

    let measured = kernel
        .measure_session_data(params(&["sess_a", "sess_empty"], &["/w/app"]))
        .await
        .unwrap();
    assert_eq!(
        measured.sessions,
        [
            nibi_kernel_api::session_data::SessionDataBytes {
                session_id: SessionId::new("sess_a"),
                bytes: 15,
            },
            nibi_kernel_api::session_data::SessionDataBytes {
                session_id: SessionId::new("sess_empty"),
                bytes: 0,
            },
        ]
    );
    assert_eq!(
        measured.memory,
        [nibi_kernel_api::session_data::SessionDataMemoryBytes {
            workspace_path: "/w/app".to_owned(),
            bytes: 7,
        }]
    );
    // 只读：会话表没有因此打开会话（关掉内核时也没有 actor 要收尾）。
    assert!(kernel.settled(&SessionId::new("sess_a")).await.is_none());
}

#[tokio::test]
async fn purge_keeps_a_running_session_and_its_tree() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone(), environment());
    let id = kernel
        .create_session(create("sess_run", "/w/app"))
        .await
        .unwrap();
    create_child(&store, "sess_sub", "sess_run", SessionKind::Subagent).await;
    store.set_session_files(&id, 10);
    store.set_session_files(&SessionId::new("sess_sub"), 5);
    let session = kernel.open_session(&id).await.unwrap();
    session
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::Submit {
                text: "hello".into(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    for _ in 0..200 {
        if session.view().await.unwrap().running {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(session.view().await.unwrap().running);

    let result = kernel
        .purge_session_data(params(&["sess_run"], &[]))
        .await
        .unwrap();
    assert!(result.deleted.is_empty());
    assert_eq!(result.kept.len(), 1);
    assert_eq!(result.kept[0].session_id, id);
    assert_eq!(result.kept[0].reason, SessionDataKeptReason::Running);
    // 行与文件都还在。
    assert!(store.contains(&id));
    assert!(store.contains(&SessionId::new("sess_sub")));
    assert_eq!(store.measure_session_files(&id).await.unwrap(), 10);
}

#[tokio::test]
async fn purge_keeps_referenced_trees_and_follows_the_fixed_point() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone(), environment());
    for id in ["sess_a", "sess_b", "sess_c"] {
        kernel.create_session(create(id, "/w/app")).await.unwrap();
    }
    // C 引用 B，B 引用 A；只删 A/B，C 不在本次删除范围——B 被保留，A 又因 B 被保留。
    store.set_artifact_referrer(&SessionId::new("sess_b"), &SessionId::new("sess_c"));
    store.set_artifact_referrer(&SessionId::new("sess_a"), &SessionId::new("sess_b"));
    store.set_session_files(&SessionId::new("sess_a"), 100);
    store.set_session_files(&SessionId::new("sess_b"), 50);

    let result = kernel
        .purge_session_data(params(&["sess_a", "sess_b"], &[]))
        .await
        .unwrap();
    assert!(result.deleted.is_empty(), "{result:?}");
    let kept: Vec<(String, SessionDataKeptReason)> = result
        .kept
        .iter()
        .map(|entry| (entry.session_id.as_str().to_owned(), entry.reason))
        .collect();
    assert_eq!(
        kept,
        [
            ("sess_a".to_owned(), SessionDataKeptReason::Referenced),
            ("sess_b".to_owned(), SessionDataKeptReason::Referenced),
        ]
    );
    assert!(store.contains(&SessionId::new("sess_a")));
    assert!(store.contains(&SessionId::new("sess_b")));
}

#[tokio::test]
async fn purge_is_idempotent_and_never_touches_other_sessions() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone(), environment());
    for id in ["sess_gone", "sess_keep"] {
        kernel.create_session(create(id, "/w/app")).await.unwrap();
    }
    store.set_session_files(&SessionId::new("sess_gone"), 9);
    store.set_memory_bytes("/w/app", 4);

    let first = kernel
        .purge_session_data(params(&["sess_gone"], &["/w/app"]))
        .await
        .unwrap();
    assert_eq!(
        first.deleted,
        [nibi_kernel_api::session_data::SessionDataBytes {
            session_id: SessionId::new("sess_gone"),
            bytes: 9,
        }]
    );
    assert_eq!(first.memory[0].bytes, 4);
    assert!(!store.contains(&SessionId::new("sess_gone")));
    assert!(store.contains(&SessionId::new("sess_keep")));

    // 第二次：会话与目录记忆都按 0 字节成功（幂等）；不存在的根同样如此。
    let second = kernel
        .purge_session_data(params(&["sess_gone", "sess_missing"], &["/w/app"]))
        .await
        .unwrap();
    assert_eq!(
        second
            .deleted
            .iter()
            .map(|entry| (entry.session_id.as_str().to_owned(), entry.bytes))
            .collect::<Vec<_>>(),
        [("sess_gone".to_owned(), 0), ("sess_missing".to_owned(), 0)]
    );
    assert_eq!(second.memory[0].bytes, 0);
    assert!(second.failed.is_empty());
    assert!(store.contains(&SessionId::new("sess_keep")));
}

#[tokio::test]
async fn a_shared_session_is_kept_as_referenced() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone(), environment());
    kernel
        .create_session(create("sess_shared", "/w/app"))
        .await
        .unwrap();
    store.pin(&SessionId::new("sess_shared"));
    let result = kernel
        .purge_session_data(params(&["sess_shared"], &[]))
        .await
        .unwrap();
    assert_eq!(result.kept[0].reason, SessionDataKeptReason::Referenced);
    assert!(store.contains(&SessionId::new("sess_shared")));
}

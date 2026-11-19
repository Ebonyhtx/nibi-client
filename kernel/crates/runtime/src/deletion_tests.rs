//! 永久删除的内核语义：在用的阻止、空闲的关掉再删、范围变了不删、根不在 = not-found、别的工作区不删、删完幂等，
//! 被引用的附件文件留下。
use std::sync::Arc;

use futures_util::StreamExt;
use nibi_kernel_api::deletion::{
    DeletionBlock, DeletionOutcome, DeletionPreview, Receipt, SessionFile,
};
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{CommandId, EnvironmentId, SessionId, TraceId};
use nibi_kernel_api::model::{ModelError, ModelEvent, ModelPort, ModelRequest};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Command, CommandEnvelope, CreateSession, Delivery, Kernel};
use nibi_kernel_api::store::{SessionKind, SessionMeta, SessionStore};
use nibi_kernel_api::testing::{
    FixedClock, MemoryStore, SequentialIds, UnusedEnvironment, environments, selection,
};
use tokio_util::sync::CancellationToken;

use crate::{Defaults, LocalKernel, Ports};

/// 永远不结束的模型：会话始终有一轮在跑，用来验证「在用的阻止删除」。
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

fn kernel(store: Arc<MemoryStore>) -> LocalKernel {
    LocalKernel::new(
        Ports {
            model: Arc::new(PendingModel),
            environments: environments(Arc::new(UnusedEnvironment)),
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

async fn child(store: &MemoryStore, id: &str, parent: &str, kind: SessionKind) {
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

fn file(path: &str, name: &str, artifact: bool, bytes: u64) -> SessionFile {
    SessionFile {
        relative_path: path.to_owned(),
        name: name.to_owned(),
        artifact,
        bytes,
    }
}

/// 打开着、空闲的会话：关掉再删；行与文件都没了，会话表里也没有它。
#[tokio::test]
async fn an_idle_open_session_is_closed_then_deleted() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone());
    let root = kernel
        .create_session(create("sess_root", "/w/app"))
        .await
        .unwrap();
    child(&store, "sess_child", "sess_root", SessionKind::Subagent).await;
    store.add_file(
        &root,
        file("cli/artifacts/sess_root/a.png", "a.png", true, 1),
    );
    let handle = kernel.open_session(&root).await.unwrap();

    let preview = kernel
        .deletion_preview(&root, &workspace("/w/app"))
        .await
        .unwrap();
    assert_eq!(
        preview.sessions,
        [root.clone(), SessionId::new("sess_child")]
    );
    assert_eq!(preview.blocked, None);
    assert_eq!(preview.deleted_files, 1);

    let result = kernel
        .delete_permanently(&root, &workspace("/w/app"), &preview.revision, "op")
        .await
        .unwrap();
    assert_eq!(result.outcome, DeletionOutcome::Deleted);
    assert_eq!(result.sessions, preview.sessions);
    assert!(!store.contains(&root) && !store.contains(&SessionId::new("sess_child")));
    assert!(store.files_of(&root).is_empty());
    assert!(kernel.settled(&root).await.is_none(), "the actor is gone");
    assert!(handle.view().await.is_err(), "the old handle is closed");

    // 再删一次：凭据说已经删完，执行回 deleted（确认时的 revision 已经不看了）
    assert_eq!(store.receipt(&root), Some(Receipt::Deleted));
    let again = kernel
        .deletion_preview(&root, &workspace("/w/app"))
        .await
        .unwrap();
    assert!(again.completed);
    let result = kernel
        .delete_permanently(&root, &workspace("/w/app"), "stale", "op")
        .await
        .unwrap();
    assert_eq!(result.outcome, DeletionOutcome::Deleted);
}

/// 根不在库里、也没有凭据：同 Node，not-found，什么都不删。
#[tokio::test]
async fn a_missing_root_without_a_receipt_is_not_found() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone());
    let root = SessionId::new("sess_gone");
    let preview = kernel
        .deletion_preview(&root, &workspace("/w/app"))
        .await
        .unwrap();
    assert_eq!(preview.blocked, Some(DeletionBlock::NotFound));
    let result = kernel
        .delete_permanently(&root, &workspace("/w/app"), &preview.revision, "op")
        .await
        .unwrap();
    assert_eq!(
        result.outcome,
        DeletionOutcome::Blocked(DeletionBlock::NotFound)
    );
}

/// 回合在跑：预检与执行都阻止，不停它，行留着。
#[tokio::test]
async fn a_running_session_blocks_and_keeps_running() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone());
    let root = kernel
        .create_session(create("sess_run", "/w/app"))
        .await
        .unwrap();
    let handle = kernel.open_session(&root).await.unwrap();
    handle
        .send(CommandEnvelope {
            id: CommandId::new("cmd_run"),
            command: Command::Submit {
                text: "go".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    for _ in 0..200 {
        if handle.view().await.unwrap().running {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(handle.view().await.unwrap().running);

    let preview = kernel
        .deletion_preview(&root, &workspace("/w/app"))
        .await
        .unwrap();
    assert_eq!(preview.blocked, Some(DeletionBlock::Running));
    let result = kernel
        .delete_permanently(&root, &workspace("/w/app"), &preview.revision, "op")
        .await
        .unwrap();
    assert_eq!(
        result.outcome,
        DeletionOutcome::Blocked(DeletionBlock::Running)
    );
    assert!(store.contains(&root));
    assert!(handle.view().await.unwrap().running, "still running");
}

/// Node 写下的待处理工作同样阻止。
#[tokio::test]
async fn pending_work_blocks_the_preview_and_the_execution() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone());
    let root = kernel
        .create_session(create("sess_pending", "/w/app"))
        .await
        .unwrap();
    store.set_pending_work(&root);
    let preview = kernel
        .deletion_preview(&root, &workspace("/w/app"))
        .await
        .unwrap();
    assert_eq!(preview.blocked, Some(DeletionBlock::Running));
    let result = kernel
        .delete_permanently(&root, &workspace("/w/app"), &preview.revision, "op")
        .await
        .unwrap();
    assert_eq!(
        result.outcome,
        DeletionOutcome::Blocked(DeletionBlock::Running)
    );
    assert!(store.contains(&root));
}

/// 确认之后会话变了：旧的 revision 不删（不扩大确认的范围）。
#[tokio::test]
async fn a_changed_scope_is_not_deleted() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone());
    let root = kernel
        .create_session(create("sess_changed", "/w/app"))
        .await
        .unwrap();
    let preview = kernel
        .deletion_preview(&root, &workspace("/w/app"))
        .await
        .unwrap();
    store.set_updated(&root, 5_000);
    let result = kernel
        .delete_permanently(&root, &workspace("/w/app"), &preview.revision, "op")
        .await
        .unwrap();
    assert_eq!(
        result.outcome,
        DeletionOutcome::Blocked(DeletionBlock::Changed)
    );
    assert!(store.contains(&root));
    // 用新的 revision 就能删
    let fresh = kernel
        .deletion_preview(&root, &workspace("/w/app"))
        .await
        .unwrap();
    let result = kernel
        .delete_permanently(&root, &workspace("/w/app"), &fresh.revision, "op")
        .await
        .unwrap();
    assert_eq!(result.outcome, DeletionOutcome::Deleted);
}

/// 根在别的工作区：预检与执行都给 OtherWorkspace，什么都不删。
#[tokio::test]
async fn another_workspace_is_not_deleted() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone());
    let root = kernel
        .create_session(create("sess_remote", "/w/app"))
        .await
        .unwrap();
    let preview: DeletionPreview = kernel
        .deletion_preview(&root, &workspace("/other"))
        .await
        .unwrap();
    assert_eq!(preview.blocked, Some(DeletionBlock::OtherWorkspace));
    let result = kernel
        .delete_permanently(&root, &workspace("/other"), &preview.revision, "op")
        .await
        .unwrap();
    assert_eq!(
        result.outcome,
        DeletionOutcome::Blocked(DeletionBlock::OtherWorkspace)
    );
    assert!(store.contains(&root));
}

/// 被树外会话引用的附件文件留下，别的文件删掉；fork 列进预检但不删。
#[tokio::test]
async fn a_referenced_attachment_file_is_retained() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone());
    let root = kernel
        .create_session(create("sess_keep", "/w/app"))
        .await
        .unwrap();
    child(&store, "sess_fork", "sess_keep", SessionKind::Fork).await;
    store.set_artifact_referrer(&root, &SessionId::new("sess_fork"));
    store.add_file(
        &root,
        file("cli/artifacts/sess_keep/shared.png", "shared.png", true, 3),
    );
    store.add_file(
        &root,
        file(
            "cli/artifacts/sess_keep/private.png",
            "private.png",
            true,
            4,
        ),
    );

    let preview = kernel
        .deletion_preview(&root, &workspace("/w/app"))
        .await
        .unwrap();
    assert_eq!(preview.forks.len(), 1);
    assert_eq!(preview.forks[0].session.as_str(), "sess_fork");
    assert_eq!(preview.retained.len(), 1);
    assert_eq!(preview.retained[0].artifact, "shared");
    assert_eq!(preview.deleted_files, 1);

    let result = kernel
        .delete_permanently(&root, &workspace("/w/app"), &preview.revision, "op")
        .await
        .unwrap();
    assert_eq!(result.outcome, DeletionOutcome::Deleted);
    assert_eq!(result.retained, 1);
    let left: Vec<String> = store
        .files_of(&root)
        .into_iter()
        .map(|file| file.name)
        .collect();
    assert_eq!(left, ["shared.png"]);
    // fork 是独立任务，留着
    assert!(store.contains(&SessionId::new("sess_fork")));
}

//! NIBI `createSession.permissionScope: "session"`（群协作会话）：创建后写会话行的 permission 并让
//! 已打开会话换用自己的规则层（Node `v4-bridge` 的 `updateSession` 与 `loadProjectPermissionRuleset`）。

use std::sync::Arc;

use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, Kernel};
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryEnvironment, MemoryStore, ScriptedModel, SequentialIds, environments,
    selection,
};

use super::*;

fn kernel(store: Arc<MemoryStore>) -> LocalKernel {
    let env = Arc::new(MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/work"),
        platform: "darwin".into(),
        os_version: "x".into(),
        shell: "zsh".into(),
        is_git_repo: false,
        additional_directories: Vec::new(),
        home: None,
    }));
    LocalKernel::new(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
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

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/work"),
    }
}

/// 群协作会话：写 `{version:1, scope:"session", mode:"build"}`，`session_rules` 认这个作用域；
/// 其他 scope 不动会话行。
#[tokio::test]
async fn a_session_scoped_session_writes_its_permission_row() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone());
    let session = kernel
        .create_session(CreateSession {
            id: Some(SessionId::new("sess_group")),
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::AcceptEdits,
            plan: true,
        })
        .await
        .expect("created");
    kernel
        .apply_session_permission_scope(&session, "session")
        .await
        .expect("scoped");
    assert_eq!(
        store.session_permission(&session),
        Some(serde_json::json!({"version": 1, "scope": "session", "mode": "build"}))
    );
    assert_eq!(
        store.session_rules(&session).await.expect("rules"),
        Some(rust_cli_kernel_api::permission::ProjectRules::default())
    );

    // 不是 "session" 的作用域（协议 schema 只放行这一个值）不写行。
    let other = kernel
        .create_session(CreateSession {
            id: Some(SessionId::new("sess_other")),
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .expect("created");
    kernel
        .apply_session_permission_scope(&other, "project")
        .await
        .expect("no-op");
    assert_eq!(store.session_permission(&other), None);
}

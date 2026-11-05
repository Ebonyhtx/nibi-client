//! NIBI Host 的动态工作流灰度门（P0-2）：Host 关闭时什么都不发，所以「没有策略」要靠调用方区分——
//! Host 进程（app-server）按关闭，CLI/TUI 不参加灰度（工具全注册）。workspace 策略与 createSession
//! 显式值按 Node `resolveDynamicWorkflowRuntimeGate` 合成，冷恢复按当时的策略重算。

use std::sync::Arc;

use nibi_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{
    CreateSession, DynamicWorkflowGate, EndReason, Kernel,
};
use nibi_kernel_api::testing::{
    FixedClock, MemoryEnvironment, MemoryStore, ScriptedModel, SequentialIds, environments,
    selection,
};

use super::*;

fn kernel(store: Arc<MemoryStore>, host_serving: bool) -> LocalKernel {
    let env = Arc::new(MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/work"),
        platform: "darwin".into(),
        os_version: "x".into(),
        shell: "zsh".into(),
        is_git_repo: false,
        additional_directories: Vec::new(),
        home: None,
    }));
    let kernel = LocalKernel::new(
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
    );
    if host_serving {
        kernel.with_host_serving()
    } else {
        kernel
    }
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/work"),
    }
}

async fn create(kernel: &LocalKernel, id: &str) -> SessionId {
    kernel
        .create_session(CreateSession {
            id: Some(SessionId::new(id)),
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .expect("created")
}

/// 会话工具表（`session_catalog` 与发给模型的快照同一条规则）。
async fn catalog_tools(kernel: &LocalKernel, session: &SessionId) -> Vec<String> {
    kernel
        .session_catalog(nibi_kernel_api::catalog::CatalogQuery {
            session: session.clone(),
            workspace: workspace(),
            selection: selection(),
        })
        .await
        .expect("catalog")
        .tools
}

/// 三件套都在（开启态）。
fn assert_has_workflow_tools(tools: &[String]) {
    for name in ["FillWorkflowHole", "GetWorkflowRun", "ResolveWorkflowQuestion"] {
        assert!(tools.iter().any(|tool| tool == name), "{name} missing in {tools:?}");
    }
}

/// 三件套都不在（关闭态）。
fn assert_has_no_workflow_tools(tools: &[String]) {
    for name in ["FillWorkflowHole", "GetWorkflowRun", "ResolveWorkflowQuestion"] {
        assert!(!tools.iter().any(|tool| tool == name), "{name} present in {tools:?}");
    }
}

/// CLI/TUI（没有 Host 协议）：不参加灰度，三件套照常注册。
#[tokio::test]
async fn a_cli_session_does_not_take_part_in_the_gray_release() {
    let kernel = kernel(Arc::new(MemoryStore::default()), false);
    let session = create(&kernel, "sess_cli").await;
    assert_eq!(
        kernel.gate.dynamic_workflow(&session),
        DynamicWorkflowGate::UNGATED
    );
    assert_has_workflow_tools(&catalog_tools(&kernel, &session).await);
}

/// Host 进程：没有同步到策略 = 关闭；策略开启之后创建的会话打开；已活跃会话不回收（Node 同一语义）。
#[tokio::test]
async fn a_host_session_is_closed_until_the_workspace_policy_says_otherwise() {
    let kernel = kernel(Arc::new(MemoryStore::default()), true);
    let before = create(&kernel, "sess_before").await;
    assert!(!kernel.gate.dynamic_workflow(&before).enabled);
    assert_has_no_workflow_tools(&catalog_tools(&kernel, &before).await);

    kernel
        .update_dynamic_workflow_policy(&workspace(), DynamicWorkflowGate::new(true, false))
        .await
        .expect("policy");
    let after = create(&kernel, "sess_after").await;
    assert!(kernel.gate.dynamic_workflow(&after).enabled);
    assert_has_workflow_tools(&catalog_tools(&kernel, &after).await);
    // 已有会话的工具面不回收。
    assert!(!kernel.gate.dynamic_workflow(&before).enabled);
    assert_has_no_workflow_tools(&catalog_tools(&kernel, &before).await);
}

/// createSession 的显式 true 覆盖缺席的 workspace 策略（Node 的取值 = 显式 true 或策略开启）。
#[tokio::test]
async fn an_explicit_session_gate_overrides_the_absent_workspace_policy() {
    let kernel = kernel(Arc::new(MemoryStore::default()), true);
    let session = create(&kernel, "sess_explicit").await;
    assert!(!kernel.gate.dynamic_workflow(&session).enabled);
    kernel
        .set_session_dynamic_workflow(&session, DynamicWorkflowGate::new(true, true))
        .await
        .expect("override");
    let gate = kernel.gate.dynamic_workflow(&session);
    assert!(gate.enabled);
    assert!(gate.on_demand);
    assert_has_workflow_tools(&catalog_tools(&kernel, &session).await);
}

/// 冷恢复按此刻的 workspace 策略重算（Node 的 resume 与 create 走同一条 record 门）。
#[tokio::test]
async fn a_cold_resume_recomputes_the_gate_from_the_workspace_policy() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone(), true);
    let session = create(&kernel, "sess_resume").await;
    assert!(!kernel.gate.dynamic_workflow(&session).enabled);
    kernel
        .open_session(&session)
        .await
        .expect("open")
        .close(EndReason::Resume)
        .await;

    // 关闭时 `release` 清掉了登记；Host 的 workspace 策略已经开启，恢复时重新算出门。
    kernel
        .update_dynamic_workflow_policy(&workspace(), DynamicWorkflowGate::new(true, false))
        .await
        .expect("policy");
    kernel.open_session(&session).await.expect("reopen");
    assert!(kernel.gate.dynamic_workflow(&session).enabled);
    assert_has_workflow_tools(&catalog_tools(&kernel, &session).await);
}

/// 子会话继承父会话的门（父显式打开而 workspace 策略缺席时，子代理不能退回关闭）。
#[tokio::test]
async fn a_child_session_inherits_the_parent_gate() {
    let kernel = kernel(Arc::new(MemoryStore::default()), true);
    let parent = create(&kernel, "sess_parent").await;
    kernel
        .set_session_dynamic_workflow(&parent, DynamicWorkflowGate::new(true, false))
        .await
        .expect("override");
    let child = kernel
        .create_session_with_parent(
            CreateSession {
                id: Some(SessionId::new("sess_child")),
                workspace: workspace(),
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
            },
            Some(parent),
        )
        .await
        .expect("child");
    assert!(kernel.gate.dynamic_workflow(&child).enabled);
    assert_has_workflow_tools(&catalog_tools(&kernel, &child).await);
}

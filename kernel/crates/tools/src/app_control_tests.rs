//! App 控制 4 个工具的单元测试：假 Host 覆盖元数据、schema、输入校验、回执复验、取消与 32 KiB。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_api::app_control::{
    AppControlActionName, AppControlError, AppKind, AppProjectEntry, AppProjectRef, AppScope,
    AppSearchScope, AppSessionControlHost, AppTrustedContext, AppUnavailableSource,
    ListProjectsInput, ListProjectsResult, MutationResult, MutationStatus, OpenSessionInput,
    OpenSessionResult, OpenSessionStatus, SetSessionArchivedInput, SetSessionPinnedInput,
};
use nibi_kernel_api::tool::Tool;
use serde_json::{Value, json};

use super::{AppControlTool, app_control_tools};
use crate::test_more::{Ctx, output_text};

#[derive(Default)]
struct FakeHost {
    calls: Mutex<Vec<String>>,
    last_ctx: Mutex<Option<AppTrustedContext>>,
    projects: Mutex<Option<ListProjectsResult>>,
    open: Mutex<Option<OpenSessionResult>>,
    archived: Mutex<Option<MutationResult>>,
    pinned: Mutex<Option<MutationResult>>,
    cancel_delay: Mutex<Option<Duration>>,
    cancels: AtomicUsize,
}

impl FakeHost {
    fn note(&self, value: impl Into<String>) {
        self.calls.lock().unwrap().push(value.into());
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn with_projects(result: ListProjectsResult) -> Self {
        let host = Self::default();
        *host.projects.lock().unwrap() = Some(result);
        host
    }
}

fn project(id: &str, title: &str) -> AppProjectEntry {
    AppProjectEntry {
        project: AppProjectRef {
            kind: AppKind::App,
            project_id: id.to_owned(),
            source_server_id: None,
        },
        title: title.to_owned(),
    }
}

fn projects(rows: Vec<AppProjectEntry>) -> ListProjectsResult {
    ListProjectsResult {
        projects: rows,
        search_scope: AppSearchScope {
            scopes: vec![AppScope::Host {
                kind: AppKind::App,
                source_server_id: None,
            }],
            unavailable_sources: vec![AppUnavailableSource {
                source_server_id: "src-offline".to_owned(),
                reason: "offline".to_owned(),
            }],
        },
    }
}

#[async_trait]
impl AppSessionControlHost for FakeHost {
    async fn list_projects(
        &self,
        ctx: &AppTrustedContext,
        input: ListProjectsInput,
    ) -> Result<ListProjectsResult, AppControlError> {
        self.note(format!("listProjects query={:?}", input.query));
        *self.last_ctx.lock().unwrap() = Some(ctx.clone());
        self.projects
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AppControlError::unavailable("not configured"))
    }

    async fn open_session(
        &self,
        ctx: &AppTrustedContext,
        input: OpenSessionInput,
    ) -> Result<OpenSessionResult, AppControlError> {
        self.note(format!("openSession {}", input.session_id));
        *self.last_ctx.lock().unwrap() = Some(ctx.clone());
        let delay = *self.cancel_delay.lock().unwrap();
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
        }
        self.open.lock().unwrap().clone().ok_or_else(|| {
            AppControlError::unavailable("App navigation is not connected in this process")
        })
    }

    async fn set_session_archived(
        &self,
        _ctx: &AppTrustedContext,
        input: SetSessionArchivedInput,
    ) -> Result<MutationResult, AppControlError> {
        self.note(format!(
            "setSessionArchived {} {} {}",
            input.session_id, input.archived, input.request_id
        ));
        Ok(self
            .archived
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(MutationResult {
                status: MutationStatus::Applied,
                request_id: input.request_id,
                reason: None,
            }))
    }

    async fn set_session_pinned(
        &self,
        _ctx: &AppTrustedContext,
        input: SetSessionPinnedInput,
    ) -> Result<MutationResult, AppControlError> {
        self.note(format!(
            "setSessionPinned {} {} {}",
            input.session_id, input.pinned, input.request_id
        ));
        Ok(self
            .pinned
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(MutationResult {
                status: MutationStatus::Applied,
                request_id: input.request_id,
                reason: None,
            }))
    }

    async fn cancel(&self, _ctx: &AppTrustedContext) -> Result<(), AppControlError> {
        self.cancels.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn tool(action: AppControlActionName, host: Arc<FakeHost>) -> Arc<dyn Tool> {
    let slot = Arc::new(std::sync::OnceLock::new());
    let _ = slot.set(host as Arc<dyn AppSessionControlHost>);
    Arc::new(AppControlTool::new(action, slot))
}

fn context() -> nibi_kernel_api::tool::ToolUseContext {
    Ctx::new(Arc::new(
        nibi_kernel_api::testing::ScriptedInteractions::default(),
    ))
    .build()
}

fn failure(error: &nibi_kernel_api::tool::ToolError) -> String {
    error.to_string()
}

#[test]
fn metadata_matches_the_app_control_contract() {
    let host = Arc::new(FakeHost::default());
    for action in [
        AppControlActionName::ListProjects,
        AppControlActionName::OpenSession,
        AppControlActionName::SetSessionArchived,
        AppControlActionName::SetSessionPinned,
    ] {
        let entry = tool(action, host.clone());
        assert!(entry.should_defer());
        assert_eq!(entry.max_result_size_chars(), Some(32_768));
        assert_eq!(
            entry.is_read_only(&json!({})),
            action == AppControlActionName::ListProjects
        );
        let schema = entry.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["properties"]["sessionId"].is_object(),
            action != AppControlActionName::ListProjects
        );
    }
    let names: Vec<String> = app_control_tools(Arc::new(std::sync::OnceLock::new()))
        .iter()
        .map(|entry| entry.name().to_owned())
        .collect();
    assert_eq!(
        names,
        vec![
            "ListProjects",
            "OpenSession",
            "SetSessionArchived",
            "SetSessionPinned"
        ]
    );
}

#[tokio::test]
async fn list_projects_passes_only_trusted_identity_and_query() {
    let host = Arc::new(FakeHost::with_projects(projects(vec![project(
        "proj-1", "Alpha",
    )])));
    let entry = tool(AppControlActionName::ListProjects, host.clone());
    let output = entry
        .call(
            json!({"query": "alp"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    assert_eq!(host.calls(), vec!["listProjects query=Some(\"alp\")"]);
    let ctx = host.last_ctx.lock().unwrap().clone().unwrap();
    assert_eq!(ctx.caller_session_id, "sess_1");
    assert_eq!(ctx.call_id, "toolu_1");
    assert_eq!(ctx.workspace_path, "/Users/dev/work");
    assert_eq!(ctx.ui_target, None);
    let value: Value = serde_json::from_str(&output_text(&output)).unwrap();
    assert_eq!(
        value,
        json!({
            "projects": [{"project": {"kind": "app", "projectId": "proj-1"}, "title": "Alpha"}],
            "searchScope": {
                "scopes": [{"kind": "app", "scope": "host"}],
                "unavailableSources": [{"sourceServerId": "src-offline", "reason": "offline"}],
            },
        })
    );
}

#[tokio::test]
async fn input_validation_rejects_model_identity_and_bad_ids() {
    let host = Arc::new(FakeHost::default());
    let list = tool(AppControlActionName::ListProjects, host.clone());
    let error = list
        .call(
            json!({"query": "x", "workspacePath": "/tmp/evil"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap_err();
    assert!(failure(&error).contains("unknown field"), "{error:?}");

    let open = tool(AppControlActionName::OpenSession, host.clone());
    for bad in ["dummy", "sess_", " sess_1", "session_\u{0}x"] {
        let error = open
            .call(
                json!({"sessionId": bad}),
                context(),
                tokio::sync::mpsc::channel(1).0,
            )
            .await
            .unwrap_err();
        assert!(failure(&error).contains("sessionId"), "{bad:?}: {error:?}");
    }

    let archived = tool(AppControlActionName::SetSessionArchived, host.clone());
    let error = archived
        .call(
            json!({"sessionId": "sess_1", "archived": true, "retryOf": " x"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap_err();
    assert!(failure(&error).contains("retryOf"), "{error:?}");
    assert!(host.calls().is_empty());
}

#[tokio::test]
async fn mutations_use_retry_of_then_tool_call_id_as_request_id() {
    let host = Arc::new(FakeHost::default());
    let archived = tool(AppControlActionName::SetSessionArchived, host.clone());
    let output = archived
        .call(
            json!({"sessionId": "sess_1", "archived": true}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    assert!(output_text(&output).contains("\"requestId\":\"toolu_1\""));

    let retried = archived
        .call(
            json!({"sessionId": "sess_1", "archived": true, "retryOf": "req-9"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap();
    assert!(output_text(&retried).contains("\"requestId\":\"req-9\""));
    assert_eq!(
        host.calls(),
        vec![
            "setSessionArchived sess_1 true toolu_1",
            "setSessionArchived sess_1 true req-9",
        ]
    );
}

#[tokio::test]
async fn mutation_receipt_must_echo_the_request_id() {
    let host = Arc::new(FakeHost::default());
    *host.archived.lock().unwrap() = Some(MutationResult {
        status: MutationStatus::Applied,
        request_id: "someone-else".to_owned(),
        reason: None,
    });
    let archived = tool(AppControlActionName::SetSessionArchived, host);
    let error = archived
        .call(
            json!({"sessionId": "sess_1", "archived": true}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .unwrap_err();
    assert!(failure(&error).contains("different requestId"), "{error:?}");
}

#[tokio::test]
async fn output_validation_rejects_non_app_and_duplicate_projects() {
    let host = Arc::new(FakeHost::with_projects(projects(vec![
        project("proj-1", "Alpha"),
        project("proj-1", "Alpha again"),
    ])));
    let list = tool(AppControlActionName::ListProjects, host.clone());
    let error = list
        .call(json!({}), context(), tokio::sync::mpsc::channel(1).0)
        .await
        .unwrap_err();
    assert!(failure(&error).contains("duplicate"), "{error:?}");

    let mut bad = projects(vec![project("proj-1", "Alpha")]);
    bad.search_scope.scopes.push(AppScope::Project {
        kind: AppKind::App,
        project_id: " ".to_owned(),
        source_server_id: None,
    });
    *host.projects.lock().unwrap() = Some(bad);
    let error = list
        .call(json!({}), context(), tokio::sync::mpsc::channel(1).0)
        .await
        .unwrap_err();
    assert!(
        failure(&error).contains("invalid project scope"),
        "{error:?}"
    );
}

#[tokio::test]
async fn missing_host_fails_closed_with_unavailable() {
    let slot = Arc::new(std::sync::OnceLock::new());
    let list = Arc::new(AppControlTool::new(
        AppControlActionName::ListProjects,
        slot,
    )) as Arc<dyn Tool>;
    let error = list
        .call(json!({}), context(), tokio::sync::mpsc::channel(1).0)
        .await
        .unwrap_err();
    assert!(failure(&error).contains("unavailable"), "{error:?}");
}

#[tokio::test]
async fn subagents_never_receive_app_control() {
    let host = Arc::new(FakeHost::with_projects(projects(Vec::new())));
    let list = tool(AppControlActionName::ListProjects, host.clone());
    let mut ctx = context();
    ctx.agent = Some(nibi_kernel_api::ids::AgentId::new("agent-1"));
    let error = list
        .call(json!({}), ctx, tokio::sync::mpsc::channel(1).0)
        .await
        .unwrap_err();
    assert!(failure(&error).contains("forbidden"), "{error:?}");
    assert!(host.calls().is_empty());
}

#[tokio::test]
async fn cancellation_maps_to_a_stable_error_and_cancels_the_host_call() {
    let host = Arc::new(FakeHost::default());
    *host.open.lock().unwrap() = Some(OpenSessionResult {
        status: OpenSessionStatus::Opened,
        ui_target: Some("window:1".to_owned()),
        reason: None,
    });
    *host.cancel_delay.lock().unwrap() = Some(Duration::from_secs(30));
    let open = tool(AppControlActionName::OpenSession, host.clone());
    let ctx = context();
    let cancel = ctx.cancel.clone();
    let pending = tokio::spawn(async move {
        open.call(
            json!({"sessionId": "sess_target"}),
            ctx,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    cancel.cancel();
    let error = pending.await.unwrap().unwrap_err();
    assert!(failure(&error).contains("cancelled"), "{error:?}");
    assert_eq!(host.cancels.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn oversized_results_are_persisted_as_an_artifact() {
    let rows = (0..400)
        .map(|index| project(&format!("proj-{index}"), &"x".repeat(200)))
        .collect();
    let host = Arc::new(FakeHost::with_projects(projects(rows)));
    let list = tool(AppControlActionName::ListProjects, host);
    let output = list
        .call(json!({}), context(), tokio::sync::mpsc::channel(1).0)
        .await
        .unwrap();
    let text = output_text(&output);
    assert!(text.contains("<persisted-output>"), "{text}");
    assert!(text.len() < 32_768, "persisted preview must stay bounded");
}

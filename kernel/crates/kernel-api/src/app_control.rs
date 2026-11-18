//! App-exclusive 会话控制工具的内核侧端口（上游 3.18.2 的 App 控制面）。
//!
//! 模型工具面只有 4 个动作：[`AppControlActionName::ListProjects`]、
//! [`AppControlActionName::OpenSession`]、[`AppControlActionName::SetSessionArchived`]、
//! [`AppControlActionName::SetSessionPinned`]。身份、授权范围、发现范围与 `uiTarget` 全部由
//! Host 从自己的数据派生；模型只能给 `sessionId` / `query` / 布尔值。内核把
//! [`AppTrustedContext`] 交给实现在 `nibi-kernel-protocol-nibi` 的 Host 端口，由它经
//! `Context::peer.request` 把请求转发给桌面 Host。
//!
//! 这些工具**只**在 App 入口注册（`app-server` 装端口时）；CLI/TUI 没有 Host 时不注册，
//! 即使误注册也会因为槽为空按 `unavailable` 失败。

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// `ListProjects` 的查询上限（上游 `appListProjectsInputSchema`）。
pub const APP_PROJECT_QUERY_MAX: usize = 4096;

/// App 引用的 `kind`：与 CLI 引用区分，Host 只接受 App 引用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    App,
}

fn canonical_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= APP_PROJECT_QUERY_MAX
        && value.trim() == value
        && !value.contains('\0')
}

fn canonical_identifier_or_empty(value: &str) -> bool {
    canonical_identifier(value)
}

/// 一个 App 项目引用（`appProjectRefSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppProjectRef {
    pub kind: AppKind,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_server_id: Option<String>,
}

/// 一个 App workspace 引用（`appWorkspaceRefSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWorkspaceRef {
    pub kind: AppKind,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_server_id: Option<String>,
}

/// 一个 App 会话引用（`appSessionRefSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionRef {
    pub kind: AppKind,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_server_id: Option<String>,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<AppProjectRef>,
}

/// App 的授权/发现范围（`appScopeSchema`）：host、project、workspace 三种。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "camelCase")]
pub enum AppScope {
    #[serde(rename_all = "camelCase")]
    Host {
        kind: AppKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_server_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Project {
        kind: AppKind,
        project_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_server_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Workspace {
        kind: AppKind,
        workspace_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_identity: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_server_id: Option<String>,
    },
}

impl AppScope {
    /// 范围的身份键：source server + 各层 id。用于回执里的去重与内核侧的边界检查。
    pub fn identity(&self) -> String {
        match self {
            Self::Host {
                source_server_id, ..
            } => {
                format!("host\0{}", source_server_id.as_deref().unwrap_or_default())
            }
            Self::Project {
                project_id,
                source_server_id,
                ..
            } => format!(
                "project\0{}\0{project_id}",
                source_server_id.as_deref().unwrap_or_default()
            ),
            Self::Workspace {
                workspace_path,
                workspace_identity,
                source_server_id,
                ..
            } => format!(
                "workspace\0{}\0{}\0{workspace_path}",
                source_server_id.as_deref().unwrap_or_default(),
                workspace_identity
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(workspace_path)
            ),
        }
    }
}

/// 一次调用的可信事实：全部来自 [`nibi_kernel_api::tool::ToolUseContext`]，模型 JSON 不能构造。
/// 授权范围（allowedScopes）与发现范围（discoveryScopes）由 Host 从自己的数据派生，内核不传。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppTrustedContext {
    pub caller_session_id: String,
    /// 这次工具调用的 id；Host 用它登记并支持 `appControl/cancel`。
    pub call_id: String,
    pub turn_id: Option<String>,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    /// Host 绑定的窗口；内核不填，Host 从连接派生（模型不能提供）。
    pub ui_target: Option<String>,
}

/// 反应到工具面的 4 个动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppControlActionName {
    ListProjects,
    OpenSession,
    SetSessionArchived,
    SetSessionPinned,
}

impl AppControlActionName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ListProjects => "ListProjects",
            Self::OpenSession => "OpenSession",
            Self::SetSessionArchived => "SetSessionArchived",
            Self::SetSessionPinned => "SetSessionPinned",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppControlErrorCode {
    InvalidInput,
    InvalidOutput,
    Forbidden,
    Unavailable,
    Conflict,
    Cancelled,
}

impl AppControlErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::InvalidOutput => "invalid_output",
            Self::Forbidden => "forbidden",
            Self::Unavailable => "unavailable",
            Self::Conflict => "conflict",
            Self::Cancelled => "cancelled",
        }
    }

    /// Host 回包里的字符串码（`{ok:false,error:{code,message}}`）映射回内核错误码。
    pub fn from_wire(value: &str) -> Self {
        match value {
            "invalid_input" => Self::InvalidInput,
            "invalid_output" => Self::InvalidOutput,
            "forbidden" => Self::Forbidden,
            "conflict" => Self::Conflict,
            "cancelled" => Self::Cancelled,
            _ => Self::Unavailable,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppControlError {
    pub code: AppControlErrorCode,
    pub message: String,
}

impl AppControlError {
    pub fn new(code: AppControlErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(AppControlErrorCode::InvalidInput, message)
    }

    pub fn invalid_output(message: impl Into<String>) -> Self {
        Self::new(AppControlErrorCode::InvalidOutput, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(AppControlErrorCode::Forbidden, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(AppControlErrorCode::Unavailable, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(AppControlErrorCode::Conflict, message)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(AppControlErrorCode::Cancelled, message)
    }
}

impl std::fmt::Display for AppControlError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for AppControlError {}

/// `ListProjects` 的端口输入（`appListProjectsInputSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListProjectsInput {
    pub query: Option<String>,
}

/// `OpenSession` 的端口输入；Host 用调用者的可信 workspace 解析完整引用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenSessionInput {
    pub session_id: String,
}

/// `SetSessionArchived` 的端口输入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetSessionArchivedInput {
    pub session_id: String,
    pub archived: bool,
    pub request_id: String,
}

/// `SetSessionPinned` 的端口输入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetSessionPinnedInput {
    pub session_id: String,
    pub pinned: bool,
    pub request_id: String,
}

/// `ListProjects` 的一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppProjectEntry {
    pub project: AppProjectRef,
    pub title: String,
}

/// 无法搜索的来源（离线 / 旧 Host / 未连接）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUnavailableSource {
    pub source_server_id: String,
    pub reason: String,
}

/// 回执里的真实搜索范围（`appSearchScopeSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSearchScope {
    pub scopes: Vec<AppScope>,
    pub unavailable_sources: Vec<AppUnavailableSource>,
}

/// `ListProjects` 的回执（`listProjectsResultSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsResult {
    pub projects: Vec<AppProjectEntry>,
    pub search_scope: AppSearchScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenSessionStatus {
    Opened,
    Unavailable,
}

/// `OpenSession` 的回执（`openSessionResultSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionResult {
    pub status: OpenSessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MutationStatus {
    Applied,
    Rejected,
    Unknown,
}

/// 组织类动作的回执（`mutationResultSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub status: MutationStatus,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// App 控制端口：拥有 App 数据的 Host 实现；工具层只经这条边界访问。
#[async_trait]
pub trait AppSessionControlHost: Send + Sync {
    async fn list_projects(
        &self,
        ctx: &AppTrustedContext,
        input: ListProjectsInput,
    ) -> Result<ListProjectsResult, AppControlError>;

    async fn open_session(
        &self,
        ctx: &AppTrustedContext,
        input: OpenSessionInput,
    ) -> Result<OpenSessionResult, AppControlError>;

    async fn set_session_archived(
        &self,
        ctx: &AppTrustedContext,
        input: SetSessionArchivedInput,
    ) -> Result<MutationResult, AppControlError>;

    async fn set_session_pinned(
        &self,
        ctx: &AppTrustedContext,
        input: SetSessionPinnedInput,
    ) -> Result<MutationResult, AppControlError>;

    /// 工具调用被取消时的 best-effort 撤销；Host 可以选择什么都不做。失败不影响取消结果。
    async fn cancel(&self, _ctx: &AppTrustedContext) -> Result<(), AppControlError> {
        Ok(())
    }
}

/// 入口在 `extensions.app_control` 里装端口；`runtime` 只在槽里面有端口时注册 4 个工具。
pub type AppSessionControlHostSlot = Arc<OnceLock<Arc<dyn AppSessionControlHost>>>;

/// 从槽里取端口；还没接上时 None（工具按 `unavailable` 失败，不静默成功）。
pub fn app_session_control_host(
    slot: &AppSessionControlHostSlot,
) -> Option<Arc<dyn AppSessionControlHost>> {
    slot.get().cloned()
}

/// 回执边界：项目引用必须是 App 引用、标识符规范、没有重复行。
pub fn validate_project_entry(entry: &AppProjectEntry) -> Result<(), AppControlError> {
    if entry.project.kind != AppKind::App {
        return Err(AppControlError::invalid_output(
            "Host returned a non-app project reference",
        ));
    }
    if !canonical_identifier(&entry.project.project_id) {
        return Err(AppControlError::invalid_output(
            "Host returned an invalid project id",
        ));
    }
    if let Some(source) = entry.project.source_server_id.as_deref()
        && !canonical_identifier_or_empty(source)
    {
        return Err(AppControlError::invalid_output(
            "Host returned an invalid source server id",
        ));
    }
    if entry.title.trim().is_empty() {
        return Err(AppControlError::invalid_output(
            "Host returned a project without a title",
        ));
    }
    Ok(())
}

/// 回执边界：搜索范围里的每个 scope 必须是合法的 App scope，且不可用来源有原因。
pub fn validate_search_scope(scope: &AppSearchScope) -> Result<(), AppControlError> {
    for item in &scope.scopes {
        match item {
            AppScope::Host {
                kind,
                source_server_id,
            } => {
                if *kind != AppKind::App {
                    return Err(AppControlError::invalid_output(
                        "Host returned a non-app scope",
                    ));
                }
                if let Some(source) = source_server_id.as_deref()
                    && !canonical_identifier(source)
                {
                    return Err(AppControlError::invalid_output(
                        "Host returned an invalid source server id",
                    ));
                }
            }
            AppScope::Project {
                kind,
                project_id,
                source_server_id,
            } => {
                if *kind != AppKind::App || !canonical_identifier(project_id) {
                    return Err(AppControlError::invalid_output(
                        "Host returned an invalid project scope",
                    ));
                }
                if let Some(source) = source_server_id.as_deref()
                    && !canonical_identifier(source)
                {
                    return Err(AppControlError::invalid_output(
                        "Host returned an invalid source server id",
                    ));
                }
            }
            AppScope::Workspace {
                kind,
                workspace_path,
                source_server_id,
                ..
            } => {
                if *kind != AppKind::App
                    || workspace_path.trim().is_empty()
                    || workspace_path.contains('\0')
                {
                    return Err(AppControlError::invalid_output(
                        "Host returned an invalid workspace scope",
                    ));
                }
                if let Some(source) = source_server_id.as_deref()
                    && !canonical_identifier(source)
                {
                    return Err(AppControlError::invalid_output(
                        "Host returned an invalid source server id",
                    ));
                }
            }
        }
    }
    for source in &scope.unavailable_sources {
        if !canonical_identifier(&source.source_server_id) || source.reason.trim().is_empty() {
            return Err(AppControlError::invalid_output(
                "Host returned an invalid unavailable source",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_wire_shape_matches_the_app_contract() {
        let scopes = vec![
            AppScope::Host {
                kind: AppKind::App,
                source_server_id: None,
            },
            AppScope::Project {
                kind: AppKind::App,
                project_id: "proj-1".to_owned(),
                source_server_id: Some("src-1".to_owned()),
            },
            AppScope::Workspace {
                kind: AppKind::App,
                workspace_path: "/Users/dev/w".to_owned(),
                workspace_identity: Some("ws-1".to_owned()),
                source_server_id: None,
            },
        ];
        let value = serde_json::to_value(&scopes).unwrap();
        assert_eq!(
            value,
            serde_json::json!([
                {"kind": "app", "scope": "host"},
                {"kind": "app", "scope": "project", "projectId": "proj-1", "sourceServerId": "src-1"},
                {"kind": "app", "scope": "workspace", "workspacePath": "/Users/dev/w", "workspaceIdentity": "ws-1"}
            ])
        );
        let round: Vec<AppScope> = serde_json::from_value(value).unwrap();
        assert_eq!(round, scopes);
    }

    #[test]
    fn search_scope_rejects_duplicate_or_empty_sources() {
        let invalid = AppSearchScope {
            scopes: Vec::new(),
            unavailable_sources: vec![AppUnavailableSource {
                source_server_id: "src-1".to_owned(),
                reason: " ".to_owned(),
            }],
        };
        assert!(validate_search_scope(&invalid).is_err());
    }
}

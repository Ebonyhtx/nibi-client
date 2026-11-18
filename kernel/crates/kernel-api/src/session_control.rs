//! 会话控制工具的内核侧端口（上游 `packages/session-control` 的 CLI 8 个方法）。
//!
//! 模型工具面只暴露 `sessionId`；身份、授权范围与请求身份全部来自工具层按 `ToolUseContext`
//! 构造的可信上下文（[`TrustedContext`]）。本模块只放端口形状与结果类型，授权、幂等与等待编排
//! 在 `nibi-kernel-tools` 的 `session_control` 里；拥有会话的实现（`nibi-kernel-runtime`）实现
//! [`SessionControlHost`]，经 [`SessionControlHostSlot`] 在注册表建好之后接上。
//!
//! 结果类型按上游契约序列化成 camelCase（`sessionId`、`requestId`、`nextCursor`、`firstInput`…），
//! 工具把整份结果作为 JSON 文本交给模型。

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub const DEFAULT_WAIT_TIMEOUT_MS: u64 = 30_000;
pub const MAX_WAIT_TIMEOUT_MS: u64 = 300_000;
/// 列表 / 读取的一页上限与读取的缺省页大小。
pub const LIST_LIMIT_MAX: u32 = 200;
pub const READ_LIMIT_DEFAULT: u32 = 50;

/// 会话引用的种类。Phase 1 只有独立 CLI 的 workspace 引用；App 的 host/project 范围明确禁止。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionRefKind {
    Cli,
}

/// 一个会话的完整引用（端口内部用；模型看不到它）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub kind: SessionRefKind,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    pub session_id: String,
}

impl SessionRef {
    /// `workspaceIdentity.trim() || workspacePath`：identity 与路径是同一个 workspaceKey 的两种表达。
    pub fn workspace_key(&self) -> &str {
        workspace_identity_key(self.workspace_identity.as_deref(), &self.workspace_path)
    }
}

/// 可信的授权范围。Phase 1 只有 CLI workspace 范围。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub kind: SessionRefKind,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
}

impl Scope {
    pub fn workspace_key(&self) -> &str {
        workspace_identity_key(self.workspace_identity.as_deref(), &self.workspace_path)
    }
}

/// 空白的 identity 不能当作“没有”，`trim()` 后为空时退回路径。
fn workspace_identity_key<'a>(identity: Option<&'a str>, path: &'a str) -> &'a str {
    identity
        .map(str::trim)
        .filter(|identity| !identity.is_empty())
        .unwrap_or(path)
}

impl From<&SessionRef> for Scope {
    fn from(session: &SessionRef) -> Self {
        Self {
            kind: session.kind,
            workspace_path: session.workspace_path.clone(),
            workspace_identity: session.workspace_identity.clone(),
        }
    }
}

/// 一次调用的可信上下文：调用者会话、根会话（self-wait 的判据）与授权范围。
/// 只能由工具层从 `ToolUseContext` 构造，不能从模型 JSON 反序列化（没有 `Deserialize`）。
#[derive(Debug, Clone)]
pub struct TrustedContext {
    pub caller_id: String,
    pub root_session: SessionRef,
    pub allowed_scopes: Vec<Scope>,
    pub trace_id: Option<String>,
    pub turn_id: Option<String>,
    pub tool_call_id: Option<String>,
}

impl TrustedContext {
    /// 目标引用的范围是不是可信上下文授予的范围（`sameScope`）。
    pub fn allows(&self, session: &SessionRef) -> bool {
        let scope = Scope::from(session);
        // Phase 1 只有 kind=cli + workspace 范围；跨 workspace 与 host/project 范围一律不允许。
        session.kind == SessionRefKind::Cli
            && self
                .allowed_scopes
                .iter()
                .any(|allowed| allowed.workspace_key() == scope.workspace_key())
    }
}

/// 一次操作引用：session 供路由，sessionId 供模型原样回放。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRef {
    pub session: SessionRef,
    pub session_id: String,
    pub command_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Unknown,
    Idle,
    Accepted,
    Queued,
    Running,
    Completed,
    Interrupted,
    Failed,
    NeedsAttention,
}

impl OperationStatus {
    /// 终态：只有这四个满足等待条件；accepted / queued / running / idle 不算完成。
    pub fn is_settled(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Interrupted | Self::Failed | Self::NeedsAttention
        )
    }
}

/// 等待中的关注点（权限审批 / 提问）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationAttention {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSnapshot {
    pub operation: OperationRef,
    pub epoch: String,
    pub revision: u64,
    pub status: OperationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<OperationAttention>,
}

impl OperationSnapshot {
    /// 还没开始观察时的占位（与上游 `{epoch:"unobserved", revision:0, status:"unknown"}` 同形）。
    pub fn unobserved(operation: OperationRef) -> Self {
        Self {
            operation,
            epoch: "unobserved".to_owned(),
            revision: 0,
            status: OperationStatus::Unknown,
            execution_id: None,
            reason: None,
            attention: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OperationUpdate {
    Snapshot {
        snapshot: OperationSnapshot,
    },
    Invalidated {
        operation: OperationRef,
        reason: String,
    },
}

/// 一个 operation 的观察流：initial 与 updates 必须同 epoch、revision 严格递增；断连 / 换代 /
/// 缺口必须显式 `invalidated`。`close` 幂等、及时释放，并结束待取的更新。
#[async_trait]
pub trait SessionControlFeed: Send {
    fn initial(&self) -> OperationSnapshot;
    async fn recv(&mut self) -> Option<OperationUpdate>;
    async fn close(&mut self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Unknown,
    Idle,
    Running,
    NeedsAttention,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionControlActionName {
    ListSessions,
    ReadSession,
    CreateSession,
    ForkSession,
    SendToSession,
    WaitSessions,
    InterruptSession,
    RenameSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session: SessionRef,
    pub title: String,
    pub status: SessionStatus,
    pub available_actions: Vec<SessionControlActionName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsResult {
    pub sessions: Vec<SessionSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadView {
    Summary,
    Messages,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: String,
    /// `user` / `assistant` / `system` / `tool`。
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "view", rename_all = "lowercase")]
pub enum ReadSessionResult {
    Summary {
        summary: SessionSummary,
    },
    #[serde(rename_all = "camelCase")]
    Messages {
        session: SessionRef,
        messages: Vec<SessionMessage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_cursor: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Admission {
    Accepted,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    StartNow,
    Queued,
    None,
    Unknown,
}

/// admission 与 delivery 不能互相矛盾（上游 `validDelivery`）。
pub fn delivery_matches(admission: Admission, delivery: Delivery) -> bool {
    match admission {
        Admission::Accepted => matches!(
            delivery,
            Delivery::StartNow | Delivery::Queued | Delivery::Unknown
        ),
        Admission::Rejected => delivery == Delivery::None,
        Admission::Unknown => delivery == Delivery::Unknown,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendToSessionResult {
    pub request_id: String,
    pub session: SessionRef,
    pub operation: OperationRef,
    pub admission: Admission,
    pub delivery: Delivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CreationStatus {
    Created,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResult {
    pub request_id: String,
    pub creation: CreationStatus,
    pub first_input: Admission,
    pub delivery: Delivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<OperationRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForkStatus {
    Created,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkSessionResult {
    pub status: ForkStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionRef>,
    pub request_id: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub status: MutationStatus,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitMode {
    Any,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitStatus {
    Completed,
    TimedOut,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitSessionsResult {
    pub status: WaitStatus,
    pub operations: Vec<OperationSnapshot>,
}

/// 稳定的错误码（上游 `sessionControlErrorCodeSchema`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionControlErrorCode {
    InvalidInput,
    InvalidOutput,
    Forbidden,
    SelfWait,
    Unavailable,
    Conflict,
    Cancelled,
    ObservationInvalid,
}

impl SessionControlErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::InvalidOutput => "invalid_output",
            Self::Forbidden => "forbidden",
            Self::SelfWait => "self_wait",
            Self::Unavailable => "unavailable",
            Self::Conflict => "conflict",
            Self::Cancelled => "cancelled",
            Self::ObservationInvalid => "observation_invalid",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionControlError {
    pub code: SessionControlErrorCode,
    pub message: String,
}

impl SessionControlError {
    pub fn new(code: SessionControlErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(SessionControlErrorCode::InvalidInput, message)
    }

    pub fn invalid_output(message: impl Into<String>) -> Self {
        Self::new(SessionControlErrorCode::InvalidOutput, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(SessionControlErrorCode::Forbidden, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(SessionControlErrorCode::Unavailable, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(SessionControlErrorCode::Conflict, message)
    }
}

impl std::fmt::Display for SessionControlError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for SessionControlError {}

/// 端口输入：目标已由工具层解析为完整引用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListSessionsInput {
    pub query: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadSessionInput {
    pub session: SessionRef,
    pub view: ReadView,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateSessionInput {
    pub prompt: String,
    pub model: Option<String>,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkSessionInput {
    pub session: SessionRef,
    pub at_message: String,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendToSessionInput {
    pub session: SessionRef,
    pub prompt: String,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterruptSessionInput {
    pub session: SessionRef,
    pub expected_execution_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameSessionInput {
    pub session: SessionRef,
    pub title: String,
    pub request_id: String,
}

/// 会话控制的拥有者侧端口：解析会话 ID、执行 8 个操作、打开 operation 观察流。
///
/// 所有方法收到的目标都已在工具层按可信范围校验过；实现仍须按 `ctx` 再校验一次（owner 复验，
/// 不把预检当许可证）。
#[async_trait]
pub trait SessionControlHost: Send + Sync {
    /// 按会话 ID 在本机会话库精确解析完整引用；找不到返回 None。不检查 owner（由调用方授权）。
    async fn resolve_session(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionRef>, SessionControlError>;

    /// 调用者会话的根会话（父链顶端，self-wait 的判据）。缺省按会话自己算（顶层会话即根）。
    async fn root_session(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionRef>, SessionControlError> {
        self.resolve_session(session_id).await
    }

    async fn list_sessions(
        &self,
        ctx: &TrustedContext,
        input: ListSessionsInput,
    ) -> Result<ListSessionsResult, SessionControlError>;

    async fn read_session(
        &self,
        ctx: &TrustedContext,
        input: ReadSessionInput,
    ) -> Result<ReadSessionResult, SessionControlError>;

    async fn create_session(
        &self,
        ctx: &TrustedContext,
        input: CreateSessionInput,
    ) -> Result<CreateSessionResult, SessionControlError>;

    async fn fork_session(
        &self,
        ctx: &TrustedContext,
        input: ForkSessionInput,
    ) -> Result<ForkSessionResult, SessionControlError>;

    async fn send_to_session(
        &self,
        ctx: &TrustedContext,
        input: SendToSessionInput,
    ) -> Result<SendToSessionResult, SessionControlError>;

    async fn interrupt_session(
        &self,
        ctx: &TrustedContext,
        input: InterruptSessionInput,
    ) -> Result<MutationResult, SessionControlError>;

    async fn rename_session(
        &self,
        ctx: &TrustedContext,
        input: RenameSessionInput,
    ) -> Result<MutationResult, SessionControlError>;

    /// 打开一个 operation 的观察流。`initial` 与后续更新来自同一水位；无法观察时返回
    /// `observation_invalid`。
    async fn open_observation(
        &self,
        ctx: &TrustedContext,
        operation: &OperationRef,
    ) -> Result<Box<dyn SessionControlFeed>, SessionControlError>;
}

/// 工具注册表先建好、入口拿到 `Arc<LocalKernel>` 之后才注入的端口槽。槽为空时工具按
/// `unavailable` 失败（fail closed），不提供占位实现。
pub type SessionControlHostSlot = Arc<OnceLock<Arc<dyn SessionControlHost>>>;

/// 内核创建/分叉出真实会话后通知 Host 的回调。Host 用它把内核直接建的会话补进
/// sessions-index/tasks-index；没有 Host 的入口（CLI/TUI）不装。
pub trait SessionControlCreatedNotifier: Send + Sync {
    fn session_created(&self, caller_session_id: &str, session_id: &str, workspace_path: &str);
}

/// 从槽里取当前端口；还没接上时 None。
pub fn session_control_host(slot: &SessionControlHostSlot) -> Option<Arc<dyn SessionControlHost>> {
    slot.get().cloned()
}

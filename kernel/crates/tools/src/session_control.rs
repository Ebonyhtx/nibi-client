//! 会话控制的 8 个模型工具（上游 `packages/session-control` 的 CLI 用例层）。
//!
//! 工具面只暴露 `sessionId`：调用者身份、workspace 授权范围与 `requestId` 都来自
//! [`ToolUseContext`]，模型不能提供。每个指向已有会话的工具先经端口把 ID 解析成完整引用，再按调用者
//! 自己的 workspace 复验；读工具放行、写工具询问用户。写请求的幂等键是 `retryOf ?? toolCallId`，
//! 回执按 `(callerId, rootSession, requestId)` 记录：同 fingerprint 回放、不同 fingerprint
//! `conflict`。结果超过 32 KiB 时整份 JSON 落成 tool-output artifact，只回有界的
//! `<persisted-output>` 预览。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::permission::PermissionDecision;
use nibi_kernel_api::session_control::{
    Admission, CreateSessionInput, CreationStatus, ForkSessionInput, ForkStatus,
    InterruptSessionInput, LIST_LIMIT_MAX, ListSessionsInput, MAX_WAIT_TIMEOUT_MS, OperationRef,
    READ_LIMIT_DEFAULT, ReadSessionInput, ReadSessionResult, ReadView, RenameSessionInput, Scope,
    SendToSessionInput, SessionControlActionName, SessionControlError, SessionControlErrorCode,
    SessionControlHost, SessionControlHostSlot, SessionRef, SessionRefKind, TrustedContext,
    WaitMode, delivery_matches,
};
use nibi_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation,
};
use nibi_kernel_api::{message::ToolResultContent, persisted_output};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::common::utf16_len;
use crate::session_control_wait::wait_for_operations;

/// 结果的字符上限（上游 `max_result_size_chars`）。
pub const MAX_RESULT_SIZE_CHARS: usize = 32_768;

const IDENTIFIER_MAX: usize = 4_096;
const PROMPT_MAX: usize = 1_000_000;
const TITLE_MAX: usize = 1_024;
const WAIT_OPERATIONS_MAX: usize = 100;

const LIST_SESSIONS: &str = "ListSessions";
const READ_SESSION: &str = "ReadSession";
/// 也给 `policy_filter` 判 `ListModels` 的第二个消费者（`CreateSession.model`）是否在场。
pub(crate) const CREATE_SESSION: &str = "CreateSession";
const FORK_SESSION: &str = "ForkSession";
const SEND_TO_SESSION: &str = "SendToSession";
const WAIT_SESSIONS: &str = "WaitSessions";
const INTERRUPT_SESSION: &str = "InterruptSession";
const RENAME_SESSION: &str = "RenameSession";

/// 规范标识符：不能静默 trim（两个不同请求不能合并到同一个幂等键），不能含 NUL。
fn canonical_identifier(value: &str) -> bool {
    !value.is_empty()
        && utf16_len(value) <= IDENTIFIER_MAX
        && value.trim() == value
        && !value.contains('\0')
}

/// 会话 ID：`sess_<uuid>` 与旧版 `session_…` 都必须按原样精确接受；占位值在 schema 这层就挡住。
fn session_identifier(value: &str) -> bool {
    if !canonical_identifier(value) {
        return false;
    }
    let suffix = value
        .strip_prefix("session_")
        .or_else(|| value.strip_prefix("sess_"));
    match suffix {
        Some(suffix) => {
            !suffix.is_empty()
                && suffix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        }
        None => false,
    }
}

fn prompt_valid(value: &str) -> bool {
    !value.is_empty() && utf16_len(value) <= PROMPT_MAX && !value.trim().is_empty()
}

fn optional_identifier(value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) if !canonical_identifier(value) => Err(format!(
            "Expected a canonical identifier (1..4096 characters, trimmed, no NUL): {value:?}"
        )),
        _ => Ok(()),
    }
}

fn limit_valid(limit: Option<u32>) -> Result<(), String> {
    match limit {
        Some(limit) if !(1..=LIST_LIMIT_MAX).contains(&limit) => {
            Err(format!("limit must be between 1 and {LIST_LIMIT_MAX}"))
        }
        _ => Ok(()),
    }
}

// ── 端口输入（serde 只接受工具面字段；`requestId` 不是模型字段）──────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    session_id: String,
    view: ReadView,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    retry_of: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForkInput {
    session_id: String,
    at_message: String,
    #[serde(default)]
    retry_of: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendInput {
    session_id: String,
    prompt: String,
    #[serde(default)]
    retry_of: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InterruptInput {
    session_id: String,
    expected_execution_id: String,
    #[serde(default)]
    retry_of: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameInput {
    session_id: String,
    title: String,
    #[serde(default)]
    retry_of: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitInput {
    operations: Vec<WaitTargetInput>,
    mode: WaitMode,
    #[serde(default = "default_wait_timeout")]
    timeout_ms: u64,
}

/// 回执里的 operation 同时带完整 `session` 与裸 `sessionId`，模型会把整个对象原样放回来。
/// 多出来的 `session` 只剥掉、不拒绝（上游 `waitToolTarget` 同一读法）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitTargetInput {
    session_id: String,
    command_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    session: Option<Value>,
}

fn default_wait_timeout() -> u64 {
    nibi_kernel_api::session_control::DEFAULT_WAIT_TIMEOUT_MS
}

fn parse<T: for<'de> Deserialize<'de>>(input: &Value) -> Result<T, String> {
    serde_json::from_value(input.clone()).map_err(|error| error.to_string())
}

/// 解析并校验一个工具的输入（不访问端口）。`validate_input` 与 `call` 共用，避免两套规则。
fn parse_input(action: SessionControlActionName, input: &Value) -> Result<ParsedInput, String> {
    match action {
        SessionControlActionName::ListSessions => {
            let parsed: ListInput = parse(input)?;
            if let Some(query) = &parsed.query
                && utf16_len(query) > IDENTIFIER_MAX
            {
                return Err("query must be at most 4096 characters".to_owned());
            }
            optional_identifier(parsed.cursor.as_deref())?;
            limit_valid(parsed.limit)?;
            Ok(ParsedInput::List(parsed))
        }
        SessionControlActionName::ReadSession => {
            let parsed: ReadInput = parse(input)?;
            require_session_id(&parsed.session_id)?;
            optional_identifier(parsed.cursor.as_deref())?;
            limit_valid(parsed.limit)?;
            Ok(ParsedInput::Read(parsed))
        }
        SessionControlActionName::CreateSession => {
            let parsed: CreateInput = parse(input)?;
            if !prompt_valid(&parsed.prompt) {
                return Err("prompt must be 1..1000000 characters and not blank".to_owned());
            }
            optional_identifier(parsed.model.as_deref())?;
            optional_identifier(parsed.retry_of.as_deref())?;
            Ok(ParsedInput::Create(parsed))
        }
        SessionControlActionName::ForkSession => {
            let parsed: ForkInput = parse(input)?;
            require_session_id(&parsed.session_id)?;
            optional_identifier(Some(&parsed.at_message))?;
            optional_identifier(parsed.retry_of.as_deref())?;
            Ok(ParsedInput::Fork(parsed))
        }
        SessionControlActionName::SendToSession => {
            let parsed: SendInput = parse(input)?;
            require_session_id(&parsed.session_id)?;
            if !prompt_valid(&parsed.prompt) {
                return Err("prompt must be 1..1000000 characters and not blank".to_owned());
            }
            optional_identifier(parsed.retry_of.as_deref())?;
            Ok(ParsedInput::Send(parsed))
        }
        SessionControlActionName::InterruptSession => {
            let parsed: InterruptInput = parse(input)?;
            require_session_id(&parsed.session_id)?;
            optional_identifier(Some(&parsed.expected_execution_id))?;
            optional_identifier(parsed.retry_of.as_deref())?;
            Ok(ParsedInput::Interrupt(parsed))
        }
        SessionControlActionName::RenameSession => {
            let parsed: RenameInput = parse(input)?;
            require_session_id(&parsed.session_id)?;
            let title = parsed.title.trim();
            if title.is_empty() || utf16_len(title) > TITLE_MAX {
                return Err("title must be 1..1024 characters after trimming".to_owned());
            }
            optional_identifier(parsed.retry_of.as_deref())?;
            Ok(ParsedInput::Rename(RenameInput {
                session_id: parsed.session_id,
                title: title.to_owned(),
                retry_of: parsed.retry_of,
            }))
        }
        SessionControlActionName::WaitSessions => {
            let parsed: WaitInput = parse(input)?;
            if parsed.operations.is_empty() || parsed.operations.len() > WAIT_OPERATIONS_MAX {
                return Err(format!(
                    "operations must contain 1..{WAIT_OPERATIONS_MAX} entries"
                ));
            }
            if parsed.timeout_ms > MAX_WAIT_TIMEOUT_MS {
                return Err(format!("timeoutMs must be at most {MAX_WAIT_TIMEOUT_MS}"));
            }
            let mut seen: Vec<(String, String)> = Vec::new();
            for operation in &parsed.operations {
                require_session_id(&operation.session_id)?;
                optional_identifier(Some(&operation.command_id))?;
                let pair = (operation.session_id.clone(), operation.command_id.clone());
                if seen.contains(&pair) {
                    return Err("invalid_input: duplicate operation reference".to_owned());
                }
                seen.push(pair);
            }
            // self-wait 单独在 `call` 里按 `self_wait` 错误码拒绝（不是输入格式错误）。
            Ok(ParsedInput::Wait(parsed))
        }
    }
}

fn require_session_id(value: &str) -> Result<(), String> {
    if session_identifier(value) {
        Ok(())
    } else {
        Err(format!(
            "Expected a session id like sess_… or the legacy session_… form, got {value:?}"
        ))
    }
}

enum ParsedInput {
    List(ListInput),
    Read(ReadInput),
    Create(CreateInput),
    Fork(ForkInput),
    Send(SendInput),
    Interrupt(InterruptInput),
    Rename(RenameInput),
    Wait(WaitInput),
}

// ── 幂等回执 ────────────────────────────────────────────────────────────────────────────

/// 回执上限（与 Node 侧 `SessionControlReceiptCache` 同一档位）：4096 个请求、128 个
/// `(callerId, rootSession)` 组合。到上限后**拒绝新请求**（`unavailable`），已有回执仍可对账；
/// 不淘汰仍可重放的回执。
const RECEIPTS_TOTAL: usize = 4_096;
const RECEIPTS_ROOTS: usize = 128;

#[derive(Default)]
pub(crate) struct Receipts {
    state: Mutex<ReceiptState>,
}

#[derive(Default)]
struct ReceiptState {
    entries: HashMap<String, ReceiptEntry>,
    roots: std::collections::HashSet<String>,
}

enum ReceiptEntry {
    Pending { fingerprint: String },
    Done { fingerprint: String, result: Value },
}

impl ReceiptEntry {
    fn fingerprint(&self) -> &str {
        match self {
            Self::Pending { fingerprint } | Self::Done { fingerprint, .. } => fingerprint,
        }
    }
}

pub(crate) enum Begin {
    Replay(Value),
    Conflict(String),
    Capacity(String),
    Execute,
}

fn receipt_key(caller: &str, root: &str, request: &str) -> String {
    format!("{caller}\u{1f}{root}\u{1f}{request}")
}

fn root_key(caller: &str, root: &str) -> String {
    format!("{caller}\u{1f}{root}")
}

impl Receipts {
    pub(crate) fn begin(
        &self,
        caller: &str,
        root: &str,
        request: &str,
        fingerprint: &str,
    ) -> Begin {
        let key = receipt_key(caller, root, request);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = state.entries.get(&key) {
            if entry.fingerprint() != fingerprint {
                return Begin::Conflict(
                    "requestId already belongs to a different request".to_owned(),
                );
            }
            return match entry {
                ReceiptEntry::Done { result, .. } => Begin::Replay(result.clone()),
                // 同一请求的重入只能命中同一回执；同步 API 下先到的那次仍在执行。
                ReceiptEntry::Pending { .. } => {
                    Begin::Conflict("a retry of this request is already in progress".to_owned())
                }
            };
        }
        let root = root_key(caller, root);
        if !state.roots.contains(&root) {
            if state.roots.len() >= RECEIPTS_ROOTS {
                return Begin::Capacity(
                    "session-control caller/root capacity reached; existing receipts remain queryable"
                        .to_owned(),
                );
            }
            state.roots.insert(root);
        }
        if state.entries.len() >= RECEIPTS_TOTAL {
            return Begin::Capacity(
                "session-control request capacity reached; existing receipts remain queryable"
                    .to_owned(),
            );
        }
        state.entries.insert(
            key,
            ReceiptEntry::Pending {
                fingerprint: fingerprint.to_owned(),
            },
        );
        Begin::Execute
    }

    pub(crate) fn record(
        &self,
        caller: &str,
        root: &str,
        request: &str,
        fingerprint: &str,
        result: Value,
    ) {
        let key = receipt_key(caller, root, request);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.entries.insert(
            key,
            ReceiptEntry::Done {
                fingerprint: fingerprint.to_owned(),
                result,
            },
        );
    }

    /// 执行失败时撤掉占位，让下一次重试真正执行。
    pub(crate) fn abort(&self, caller: &str, root: &str, request: &str) {
        let key = receipt_key(caller, root, request);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(state.entries.get(&key), Some(ReceiptEntry::Pending { .. })) {
            state.entries.remove(&key);
        }
    }
}

// ── 可信上下文与目标校验 ────────────────────────────────────────────────────────────────

fn caller_session(context: &ToolUseContext) -> SessionRef {
    SessionRef {
        kind: SessionRefKind::Cli,
        workspace_path: context.workspace.root.as_str().to_owned(),
        workspace_identity: None,
        session_id: context.session.to_string(),
    }
}

fn trusted_context(context: &ToolUseContext, root: SessionRef) -> TrustedContext {
    TrustedContext {
        caller_id: context.session.to_string(),
        root_session: root.clone(),
        allowed_scopes: vec![Scope::from(&root)],
        trace_id: None,
        turn_id: None,
        tool_call_id: Some(context.tool_use.to_string()),
    }
}

async fn resolve_target(
    host: &dyn SessionControlHost,
    ctx: &TrustedContext,
    session_id: &str,
) -> Result<SessionRef, SessionControlError> {
    require_session_id(session_id).map_err(SessionControlError::invalid_input)?;
    let Some(session) = host.resolve_session(session_id).await? else {
        return Err(SessionControlError::forbidden(
            "Target is outside the trusted scope",
        ));
    };
    if session.session_id != session_id {
        return Err(SessionControlError::invalid_output(
            "Owner resolved a different session",
        ));
    }
    if session.kind != SessionRefKind::Cli || !ctx.allows(&session) {
        return Err(SessionControlError::forbidden(
            "Target is outside the trusted scope",
        ));
    }
    Ok(session)
}

fn assert_output_scope(
    session: &SessionRef,
    ctx: &TrustedContext,
) -> Result<(), SessionControlError> {
    if session.kind != SessionRefKind::Cli || !ctx.allows(session) {
        return Err(SessionControlError::invalid_output(
            "Owner returned an unauthorized session",
        ));
    }
    Ok(())
}

fn same_session(left: &SessionRef, right: &SessionRef) -> bool {
    left.session_id == right.session_id && left.workspace_key() == right.workspace_key()
}

fn assert_output_session(
    actual: &SessionRef,
    expected: &SessionRef,
    ctx: &TrustedContext,
) -> Result<(), SessionControlError> {
    assert_output_scope(actual, ctx)?;
    if !same_session(actual, expected) {
        return Err(SessionControlError::invalid_output(
            "Owner returned a different session",
        ));
    }
    Ok(())
}

fn request_id(retry_of: Option<&str>, context: &ToolUseContext) -> String {
    retry_of.map_or_else(|| context.tool_use.to_string(), str::to_owned)
}

fn operation(session: &SessionRef, command_id: String) -> OperationRef {
    OperationRef {
        session: session.clone(),
        session_id: session.session_id.clone(),
        command_id,
    }
}

// ── 结果预算 ────────────────────────────────────────────────────────────────────────────

/// 结果超过 32 KiB 时整份 JSON 落成 tool-output artifact，返回 `<persisted-output>` 预览；
/// 落盘失败时按同一标记截断，绝不把超限正文交给模型。
pub(crate) async fn bounded_json(value: &Value, context: &ToolUseContext) -> String {
    let text = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned());
    if utf16_len(&text) <= MAX_RESULT_SIZE_CHARS {
        return text;
    }
    match persisted_output::persist(
        context.artifacts.as_ref(),
        &context.session,
        &text,
        "application/json",
    )
    .await
    {
        Ok(message) => message,
        Err(_) => {
            let (shown, more) = persisted_output::preview(&text);
            format!(
                "{open}\nOutput too large ({size}). Full output could not be saved to an artifact.\n\nPreview (first {preview_size}):\n{shown}{}{close}",
                if more { "\n...\n" } else { "\n" },
                open = persisted_output::OPEN,
                close = persisted_output::CLOSE,
                size = persisted_output::format_bytes(utf16_len(&text) as u64),
                preview_size =
                    persisted_output::format_bytes(persisted_output::PREVIEW_UNITS as u64),
            )
        }
    }
}

fn text_output(text: String) -> ToolOutput {
    ToolOutput {
        content: vec![ToolResultContent::Text { text }],
        is_error: false,
        display: Value::Null,
    }
}

fn failed(error: SessionControlError) -> ToolError {
    ToolError::Failed {
        message: error.to_string(),
    }
}

// ── 工具 ────────────────────────────────────────────────────────────────────────────────

pub struct SessionControlTool {
    action: SessionControlActionName,
    slot: SessionControlHostSlot,
    receipts: Arc<Receipts>,
}

impl SessionControlTool {
    pub fn new(
        action: SessionControlActionName,
        slot: SessionControlHostSlot,
        receipts: Arc<Receipts>,
    ) -> Self {
        Self {
            action,
            slot,
            receipts,
        }
    }

    fn is_read(action: SessionControlActionName) -> bool {
        matches!(
            action,
            SessionControlActionName::ListSessions
                | SessionControlActionName::ReadSession
                | SessionControlActionName::WaitSessions
        )
    }

    fn host(&self) -> Result<Arc<dyn SessionControlHost>, SessionControlError> {
        nibi_kernel_api::session_control::session_control_host(&self.slot).ok_or_else(|| {
            SessionControlError::unavailable("Session control is not connected in this process")
        })
    }

    /// 写工具的请求身份：`retryOf ?? toolCallId`。
    fn begin_receipt(
        &self,
        parsed: &ParsedInput,
        context: &ToolUseContext,
    ) -> Option<(String, String)> {
        let retry_of = match parsed {
            ParsedInput::Create(input) => input.retry_of.as_deref(),
            ParsedInput::Fork(input) => input.retry_of.as_deref(),
            ParsedInput::Send(input) => input.retry_of.as_deref(),
            ParsedInput::Interrupt(input) => input.retry_of.as_deref(),
            ParsedInput::Rename(input) => input.retry_of.as_deref(),
            ParsedInput::List(_) | ParsedInput::Read(_) | ParsedInput::Wait(_) => return None,
        };
        Some((request_id(retry_of, context), fingerprint(parsed)))
    }
}

fn fingerprint(parsed: &ParsedInput) -> String {
    let value = match parsed {
        ParsedInput::Create(input) => json!({
            "action": "createSession",
            "prompt": input.prompt,
            "model": input.model,
        }),
        ParsedInput::Fork(input) => json!({
            "action": "forkSession",
            "sessionId": input.session_id,
            "atMessage": input.at_message,
        }),
        ParsedInput::Send(input) => json!({
            "action": "sendToSession",
            "sessionId": input.session_id,
            "prompt": input.prompt,
        }),
        ParsedInput::Interrupt(input) => json!({
            "action": "interruptSession",
            "sessionId": input.session_id,
            "expectedExecutionId": input.expected_execution_id,
        }),
        ParsedInput::Rename(input) => json!({
            "action": "renameSession",
            "sessionId": input.session_id,
            "title": input.title,
        }),
        ParsedInput::List(input) => json!({
            "action": "listSessions",
            "query": input.query,
            "cursor": input.cursor,
            "limit": input.limit,
        }),
        ParsedInput::Read(input) => json!({
            "action": "readSession",
            "sessionId": input.session_id,
            "view": input.view,
            "cursor": input.cursor,
            "limit": input.limit,
        }),
        ParsedInput::Wait(input) => json!({
            "action": "waitSessions",
            "operations": input.operations.iter().map(|operation| {
                json!({"sessionId": operation.session_id, "commandId": operation.command_id})
            }).collect::<Vec<_>>(),
            "mode": input.mode,
            "timeoutMs": input.timeout_ms,
        }),
    };
    serde_json::to_string(&value).unwrap_or_default()
}

#[async_trait]
impl Tool for SessionControlTool {
    fn name(&self) -> &str {
        match self.action {
            SessionControlActionName::ListSessions => LIST_SESSIONS,
            SessionControlActionName::ReadSession => READ_SESSION,
            SessionControlActionName::CreateSession => CREATE_SESSION,
            SessionControlActionName::ForkSession => FORK_SESSION,
            SessionControlActionName::SendToSession => SEND_TO_SESSION,
            SessionControlActionName::WaitSessions => WAIT_SESSIONS,
            SessionControlActionName::InterruptSession => INTERRUPT_SESSION,
            SessionControlActionName::RenameSession => RENAME_SESSION,
        }
    }

    fn input_schema(&self) -> Value {
        schema(self.action)
    }

    fn description(&self, _context: &PromptContext) -> String {
        description(self.action).to_owned()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        Self::is_read(self.action)
    }

    /// 上游把这 8 个工具标成 deferred：首屏只列名字，模型经 ToolSearch 按需取 schema。
    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some(
            "session sessions conversation cross-session list read create fork send wait interrupt rename background control another session",
        )
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        Self::is_read(self.action)
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(MAX_RESULT_SIZE_CHARS)
    }

    async fn validate_input(&self, input: &Value, _context: &ToolUseContext) -> Validation {
        match parse_input(self.action, input) {
            Ok(_) => Validation::Ok,
            Err(message) => Validation::Invalid {
                message,
                error_code: None,
            },
        }
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        if Self::is_read(self.action) {
            return PermissionDecision::Allow {
                updated_input: None,
            };
        }
        PermissionDecision::Ask {
            message: format!(
                "Session control: {} changes sessions outside the current conversation. Allow this cross-session operation?",
                self.name()
            ),
            suggestions: Vec::new(),
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let parsed = parse_input(self.action, &input)
            .map_err(|message| ToolError::InvalidInput { message })?;
        // 上游 `sessionControlForRuntime`：子代理永不注入会话控制绑定（根会话匹配也拦不住）。
        if context.agent.is_some() {
            return Err(failed(SessionControlError::forbidden(
                "Session control is unavailable in this execution context",
            )));
        }
        // 上游 `assertActive`：取消在进入 owner 之前就报稳定的 `cancelled`，不留半次调用。
        if context.cancel.is_cancelled() {
            return Err(failed(SessionControlError::new(
                SessionControlErrorCode::Cancelled,
                "Call cancelled before owner admission",
            )));
        }
        let host = self.host().map_err(failed)?;
        let root = host
            .root_session(&context.session.to_string())
            .await
            .map_err(failed)?
            .unwrap_or_else(|| caller_session(&context));
        let ctx = trusted_context(&context, root);

        let (request, receipt_fingerprint) = match self.begin_receipt(&parsed, &context) {
            Some((request, fingerprint)) => (Some(request), Some(fingerprint)),
            None => (None, None),
        };
        if let (Some(request), Some(fingerprint)) = (&request, &receipt_fingerprint) {
            match self.receipts.begin(
                &ctx.caller_id,
                &ctx.root_session.session_id,
                request,
                fingerprint,
            ) {
                Begin::Replay(result) => {
                    return Ok(text_output(bounded_json(&result, &context).await));
                }
                Begin::Conflict(message) => {
                    return Err(failed(SessionControlError::conflict(message)));
                }
                Begin::Capacity(message) => {
                    return Err(failed(SessionControlError::unavailable(message)));
                }
                Begin::Execute => {}
            }
        }

        let result = self
            .execute(&host, &ctx, parsed, &context, request.as_deref())
            .await;

        match (result, request, receipt_fingerprint) {
            (Ok(value), Some(request), Some(fingerprint)) => {
                self.receipts.record(
                    &ctx.caller_id,
                    &ctx.root_session.session_id,
                    &request,
                    &fingerprint,
                    value.clone(),
                );
                Ok(text_output(bounded_json(&value, &context).await))
            }
            (Ok(value), None, None) => Ok(text_output(bounded_json(&value, &context).await)),
            (Err(error), Some(request), Some(_)) => {
                // 只有「还没进入 owner 的拒绝」可以安全地不记账；其它失败撤掉占位，让重试继续。
                self.receipts
                    .abort(&ctx.caller_id, &ctx.root_session.session_id, &request);
                Err(failed(error))
            }
            (Err(error), ..) => Err(failed(error)),
            (Ok(_), None, Some(_)) | (Ok(_), Some(_), None) => Err(failed(
                SessionControlError::invalid_input("request identity was not resolved"),
            )),
        }
    }
}

impl SessionControlTool {
    async fn execute(
        &self,
        host: &Arc<dyn SessionControlHost>,
        ctx: &TrustedContext,
        parsed: ParsedInput,
        context: &ToolUseContext,
        request: Option<&str>,
    ) -> Result<Value, SessionControlError> {
        match parsed {
            ParsedInput::List(input) => {
                let result = host
                    .list_sessions(
                        ctx,
                        ListSessionsInput {
                            query: input.query,
                            cursor: input.cursor,
                            limit: input.limit,
                        },
                    )
                    .await?;
                for summary in &result.sessions {
                    assert_output_scope(&summary.session, ctx)?;
                }
                to_value(&result)
            }
            ParsedInput::Read(input) => {
                let session = resolve_target(host.as_ref(), ctx, &input.session_id).await?;
                let result = host
                    .read_session(
                        ctx,
                        ReadSessionInput {
                            session: session.clone(),
                            view: input.view,
                            cursor: input.cursor,
                            limit: input.limit,
                        },
                    )
                    .await?;
                match &result {
                    ReadSessionResult::Summary { summary } => {
                        assert_output_session(&summary.session, &session, ctx)?;
                    }
                    ReadSessionResult::Messages {
                        session: returned, ..
                    } => assert_output_session(returned, &session, ctx)?,
                }
                if !matches!(
                    (&result, input.view),
                    (ReadSessionResult::Summary { .. }, ReadView::Summary)
                        | (ReadSessionResult::Messages { .. }, ReadView::Messages)
                ) {
                    return Err(SessionControlError::invalid_output(
                        "Owner returned a different read view",
                    ));
                }
                to_value(&result)
            }
            ParsedInput::Create(input) => {
                // 创建只落在调用者绑定的 workspace。
                let scope =
                    ctx.allowed_scopes.first().cloned().ok_or_else(|| {
                        SessionControlError::forbidden("No trusted workspace scope")
                    })?;
                if scope.kind != SessionRefKind::Cli {
                    return Err(SessionControlError::forbidden(
                        "Creation requires a CLI workspace",
                    ));
                }
                let request = request.ok_or_else(|| {
                    SessionControlError::invalid_input("request identity is missing")
                })?;
                let result = host
                    .create_session(
                        ctx,
                        CreateSessionInput {
                            prompt: input.prompt,
                            model: input.model,
                            request_id: request.to_owned(),
                        },
                    )
                    .await?;
                let creation = result.creation;
                let first_input = result.first_input;
                let delivery = result.delivery;
                if !delivery_matches(first_input, delivery) {
                    return Err(SessionControlError::invalid_output(
                        "First-input admission and delivery disagree",
                    ));
                }
                if creation == CreationStatus::Created && result.session.is_none() {
                    return Err(SessionControlError::invalid_output(
                        "Created session requires a session reference",
                    ));
                }
                if let Some(session) = &result.session {
                    assert_output_scope(session, ctx)?;
                }
                if let Some(operation) = &result.operation {
                    let session = result.session.as_ref().ok_or_else(|| {
                        SessionControlError::invalid_output("Operation requires session")
                    })?;
                    assert_output_session(&operation.session, session, ctx)?;
                    if operation.session_id != session.session_id {
                        return Err(SessionControlError::invalid_output(
                            "Operation session id disagrees with its reference",
                        ));
                    }
                }
                if first_input == Admission::Accepted
                    && (creation != CreationStatus::Created || result.operation.is_none())
                {
                    return Err(SessionControlError::invalid_output(
                        "Accepted input requires created session and operation",
                    ));
                }
                to_value(&result)
            }
            ParsedInput::Fork(input) => {
                let session = resolve_target(host.as_ref(), ctx, &input.session_id).await?;
                let request = request.ok_or_else(|| {
                    SessionControlError::invalid_input("request identity is missing")
                })?;
                let result = host
                    .fork_session(
                        ctx,
                        ForkSessionInput {
                            session: session.clone(),
                            at_message: input.at_message,
                            request_id: request.to_owned(),
                        },
                    )
                    .await?;
                if result.status == ForkStatus::Created && result.session.is_none() {
                    return Err(SessionControlError::invalid_output(
                        "Created fork requires session",
                    ));
                }
                if let Some(forked) = &result.session {
                    assert_output_scope(forked, ctx)?;
                    if forked.session_id == session.session_id {
                        return Err(SessionControlError::invalid_output(
                            "Fork must create a new root session",
                        ));
                    }
                }
                to_value(&result)
            }
            ParsedInput::Send(input) => {
                let session = resolve_target(host.as_ref(), ctx, &input.session_id).await?;
                let request = request.ok_or_else(|| {
                    SessionControlError::invalid_input("request identity is missing")
                })?;
                let result = host
                    .send_to_session(
                        ctx,
                        SendToSessionInput {
                            session: session.clone(),
                            prompt: input.prompt,
                            request_id: request.to_owned(),
                        },
                    )
                    .await?;
                assert_output_session(&result.session, &session, ctx)?;
                assert_output_session(&result.operation.session, &session, ctx)?;
                if result.operation.session_id != session.session_id {
                    return Err(SessionControlError::invalid_output(
                        "Operation session id disagrees with its reference",
                    ));
                }
                if !delivery_matches(result.admission, result.delivery) {
                    return Err(SessionControlError::invalid_output(
                        "Admission and delivery disagree",
                    ));
                }
                to_value(&result)
            }
            ParsedInput::Interrupt(input) => {
                let session = resolve_target(host.as_ref(), ctx, &input.session_id).await?;
                let request = request.ok_or_else(|| {
                    SessionControlError::invalid_input("request identity is missing")
                })?;
                let result = host
                    .interrupt_session(
                        ctx,
                        InterruptSessionInput {
                            session,
                            expected_execution_id: input.expected_execution_id,
                            request_id: request.to_owned(),
                        },
                    )
                    .await?;
                to_value(&result)
            }
            ParsedInput::Rename(input) => {
                let session = resolve_target(host.as_ref(), ctx, &input.session_id).await?;
                let request = request.ok_or_else(|| {
                    SessionControlError::invalid_input("request identity is missing")
                })?;
                let result = host
                    .rename_session(
                        ctx,
                        RenameSessionInput {
                            session,
                            title: input.title,
                            request_id: request.to_owned(),
                        },
                    )
                    .await?;
                to_value(&result)
            }
            ParsedInput::Wait(input) => {
                // self-wait 在解析端口之前就拒绝：调用者自己的根会话永远等不到「别人」结算。
                if input
                    .operations
                    .iter()
                    .any(|target| target.session_id == ctx.root_session.session_id)
                {
                    return Err(SessionControlError::new(
                        SessionControlErrorCode::SelfWait,
                        "Cannot wait for the calling root session",
                    ));
                }
                let mut operations = Vec::with_capacity(input.operations.len());
                for target in &input.operations {
                    let session = resolve_target(host.as_ref(), ctx, &target.session_id).await?;
                    if same_session(&session, &ctx.root_session) {
                        return Err(SessionControlError::new(
                            SessionControlErrorCode::SelfWait,
                            "Cannot wait for the calling root session",
                        ));
                    }
                    let operation = operation(&session, target.command_id.clone());
                    if operations.iter().any(|earlier: &OperationRef| {
                        earlier.command_id == operation.command_id
                            && same_session(&earlier.session, &operation.session)
                    }) {
                        return Err(SessionControlError::invalid_input(
                            "Duplicate operation reference",
                        ));
                    }
                    operations.push(operation);
                }
                let result = wait_for_operations(
                    Arc::clone(host),
                    ctx.clone(),
                    operations,
                    input.mode,
                    input.timeout_ms,
                    context.cancel.clone(),
                )
                .await?;
                for snapshot in &result.operations {
                    assert_output_scope(&snapshot.operation.session, ctx)?;
                }
                to_value(&result)
            }
        }
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, SessionControlError> {
    serde_json::to_value(value).map_err(|error| {
        SessionControlError::invalid_output(format!("Owner result is not serializable: {error}"))
    })
}

/// 8 个会话控制工具。`receipts` 在进程内共享：键里有调用者与 requestId，不会串会话。
pub fn session_control_tools(slot: SessionControlHostSlot) -> Vec<Arc<dyn Tool>> {
    let receipts = Arc::new(Receipts::default());
    [
        SessionControlActionName::ListSessions,
        SessionControlActionName::ReadSession,
        SessionControlActionName::CreateSession,
        SessionControlActionName::ForkSession,
        SessionControlActionName::SendToSession,
        SessionControlActionName::WaitSessions,
        SessionControlActionName::InterruptSession,
        SessionControlActionName::RenameSession,
    ]
    .into_iter()
    .map(|action| {
        Arc::new(SessionControlTool::new(
            action,
            slot.clone(),
            receipts.clone(),
        )) as Arc<dyn Tool>
    })
    .collect()
}

fn description(action: SessionControlActionName) -> &'static str {
    match action {
        SessionControlActionName::ListSessions => {
            "List the NIBI sessions in this workspace, most recently updated first. Use the returned session ids with the other session tools; pass nextCursor back to read the next page."
        }
        SessionControlActionName::ReadSession => {
            "Read one NIBI session by id. view=\"summary\" returns its title and status; view=\"messages\" returns its transcript page by page. Pass nextCursor from a previous page to continue."
        }
        SessionControlActionName::CreateSession => {
            "Create a new NIBI session in this workspace and send it a first message. The current conversation keeps the user's focus; the new session runs in the background. To retry an inconclusive call, pass the requestId from its result as retryOf."
        }
        SessionControlActionName::ForkSession => {
            "Fork a new root session from an existing NIBI session at a stable message boundary (atMessage is a message id from ReadSession with view=\"messages\"). No prompt is sent to the fork. To retry an inconclusive call, pass the requestId from its result as retryOf."
        }
        SessionControlActionName::SendToSession => {
            "Send a message to another NIBI session. If that session is busy the message is queued; the target keeps its own model and permission settings. To retry an inconclusive call, pass the requestId from its result as retryOf."
        }
        SessionControlActionName::WaitSessions => {
            "Wait for operations returned by CreateSession or SendToSession. mode=\"any\" returns when one target settles; mode=\"all\" when every target settles. Terminal statuses are completed, interrupted, failed and needs_attention. timeoutMs defaults to 30000 and may be 0 (read current status only). Waiting never interrupts the targets; a timeout returns timed_out with the latest snapshots."
        }
        SessionControlActionName::InterruptSession => {
            "Interrupt the running execution in another NIBI session. expectedExecutionId must be the executionId reported by ListSessions or WaitSessions for that session; if none was reported there is nothing to interrupt. To retry an inconclusive call, pass the requestId from its result as retryOf."
        }
        SessionControlActionName::RenameSession => {
            "Rename another NIBI session. The title is trimmed and must be 1..1024 characters. To retry an inconclusive call, pass the requestId from its result as retryOf."
        }
    }
}

fn identifier_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": IDENTIFIER_MAX,
        "description": description,
    })
}

fn retry_of_schema() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": IDENTIFIER_MAX,
        "description": "Only when retrying a request whose result was inconclusive: pass the requestId from that call's result. Leave it out otherwise, and never invent one.",
    })
}

fn session_id_schema() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": IDENTIFIER_MAX,
        "description": "The target session id, for example sess_1a2b3c4d-… . Older sessions use session_… . Take it from a tool result or the user, never invent one.",
    })
}

fn prompt_schema() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": PROMPT_MAX,
        "description": "The message to send. Must not be blank.",
    })
}

fn pagination_properties() -> Value {
    json!({
        "cursor": {
            "type": "string",
            "minLength": 1,
            "maxLength": IDENTIFIER_MAX,
            "description": "The nextCursor from the previous page of this same call. Omit it for the first page.",
        },
        "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": LIST_LIMIT_MAX,
            "description": "Maximum number of entries to return.",
        },
    })
}

fn schema(action: SessionControlActionName) -> Value {
    match action {
        SessionControlActionName::ListSessions => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "query": {
                    "type": "string",
                    "maxLength": IDENTIFIER_MAX,
                    "description": "Optional title substring to filter the list.",
                },
                "cursor": pagination_properties()["cursor"].clone(),
                "limit": pagination_properties()["limit"].clone(),
            },
        }),
        SessionControlActionName::ReadSession => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sessionId": session_id_schema(),
                "view": {
                    "type": "string",
                    "enum": ["summary", "messages"],
                    "description": "summary returns the session header; messages returns its transcript.",
                },
                "cursor": pagination_properties()["cursor"].clone(),
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_LIMIT_MAX,
                    "default": READ_LIMIT_DEFAULT,
                    "description": "Maximum number of messages to return (default 50).",
                },
            },
            "required": ["sessionId", "view"],
        }),
        SessionControlActionName::CreateSession => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "prompt": prompt_schema(),
                "model": identifier_schema("A model id from ListModels, either `modelId` or `providerId/modelId`. Omit it to use the configured default."),
                "retryOf": retry_of_schema(),
            },
            "required": ["prompt"],
        }),
        SessionControlActionName::ForkSession => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sessionId": session_id_schema(),
                "atMessage": identifier_schema("A message id from ReadSession with view=messages — the `id` of the entry to fork at. Never invent one."),
                "retryOf": retry_of_schema(),
            },
            "required": ["sessionId", "atMessage"],
        }),
        SessionControlActionName::SendToSession => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sessionId": session_id_schema(),
                "prompt": prompt_schema(),
                "retryOf": retry_of_schema(),
            },
            "required": ["sessionId", "prompt"],
        }),
        SessionControlActionName::WaitSessions => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "operations": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": WAIT_OPERATIONS_MAX,
                    "description": "The operations to wait for, as returned by CreateSession or SendToSession.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "sessionId": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": IDENTIFIER_MAX,
                                "description": "The id of the session that returned this operation, as given in its result.",
                            },
                            "commandId": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": IDENTIFIER_MAX,
                                "description": "Replay the whole `operation` object from the create or send result; do not rebuild it.",
                            },
                        },
                        "required": ["sessionId", "commandId"],
                    },
                },
                "mode": {
                    "type": "string",
                    "enum": ["any", "all"],
                    "description": "any returns when one target settles; all waits for every target.",
                },
                "timeoutMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": MAX_WAIT_TIMEOUT_MS,
                    "default": nibi_kernel_api::session_control::DEFAULT_WAIT_TIMEOUT_MS,
                    "description": "Maximum wait in milliseconds. 0 reads the current status only.",
                },
            },
            "required": ["operations", "mode"],
        }),
        SessionControlActionName::InterruptSession => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sessionId": session_id_schema(),
                "expectedExecutionId": identifier_schema("The executionId reported by ListSessions or WaitSessions for this session. If neither reports one the session is not executing, so there is nothing to interrupt."),
                "retryOf": retry_of_schema(),
            },
            "required": ["sessionId", "expectedExecutionId"],
        }),
        SessionControlActionName::RenameSession => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sessionId": session_id_schema(),
                "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": TITLE_MAX,
                    "description": "The new title, trimmed.",
                },
                "retryOf": retry_of_schema(),
            },
            "required": ["sessionId", "title"],
        }),
    }
}

#[cfg(test)]
#[path = "session_control_tests.rs"]
mod tests;

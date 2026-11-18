//! App-exclusive 会话控制的 4 个模型工具（上游 3.18.2 的 App 控制面）。
//!
//! `ListProjects` 只读、自动放行；`OpenSession` / `SetSessionArchived` / `SetSessionPinned`
//! 都需要用户确认。工具面只暴露 `sessionId` / `query` / 布尔值与可选的 `retryOf`：
//! workspace、调用者身份、`uiTarget` 与授权范围全部来自 [`ToolUseContext`] 与 Host 自己的数据。
//!
//! 写请求的请求身份是 `retryOf ?? toolCallId`；Host 按它保证幂等，内核只复验回执里的
//! `requestId` 必须与发出的一致。结果超过 32 KiB 时整份 JSON 落成 tool-output artifact。
//!
//! 端口由 App 入口装进 `extensions.app_control`；槽为空（CLI/TUI）时这些工具不注册，
//! 即使被误调用也按 `unavailable` 失败。

use async_trait::async_trait;
use nibi_kernel_api::app_control::{
    AppControlActionName, AppControlError, AppSessionControlHost, AppSessionControlHostSlot,
    AppTrustedContext, ListProjectsInput, ListProjectsResult, MutationResult, OpenSessionInput,
    OpenSessionResult, SetSessionArchivedInput, SetSessionPinnedInput, app_session_control_host,
    validate_project_entry, validate_search_scope,
};
use nibi_kernel_api::permission::PermissionDecision;
use nibi_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation,
};
use nibi_kernel_api::{message::ToolResultContent, persisted_output};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::common::utf16_len;
use crate::session_control::MAX_RESULT_SIZE_CHARS;

const IDENTIFIER_MAX: usize = 4_096;
const QUERY_MAX: usize = nibi_kernel_api::app_control::APP_PROJECT_QUERY_MAX;

const LIST_PROJECTS: &str = "ListProjects";
const OPEN_SESSION: &str = "OpenSession";
const SET_SESSION_ARCHIVED: &str = "SetSessionArchived";
const SET_SESSION_PINNED: &str = "SetSessionPinned";

/// App 会话 ID 与 CLI 使用同一套历史格式；占位值在 schema 这层就挡住。
fn session_identifier(value: &str) -> bool {
    if value.is_empty()
        || utf16_len(value) > IDENTIFIER_MAX
        || value.trim() != value
        || value.contains('\0')
    {
        return false;
    }
    let Some(suffix) = value
        .strip_prefix("session_")
        .or_else(|| value.strip_prefix("sess_"))
    else {
        return false;
    };
    !suffix.is_empty()
        && suffix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn canonical_identifier(value: &str) -> bool {
    !value.is_empty()
        && utf16_len(value) <= IDENTIFIER_MAX
        && value.trim() == value
        && !value.contains('\0')
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectsInput {
    #[serde(default)]
    query: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenInput {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchivedInput {
    session_id: String,
    archived: bool,
    #[serde(default)]
    retry_of: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PinnedInput {
    session_id: String,
    pinned: bool,
    #[serde(default)]
    retry_of: Option<String>,
}

enum ParsedInput {
    Projects(ProjectsInput),
    Open(OpenInput),
    Archived(ArchivedInput),
    Pinned(PinnedInput),
}

fn parse<T: for<'de> Deserialize<'de>>(input: &Value) -> Result<T, String> {
    serde_json::from_value(input.clone()).map_err(|error| error.to_string())
}

fn parse_input(action: AppControlActionName, input: &Value) -> Result<ParsedInput, String> {
    match action {
        AppControlActionName::ListProjects => {
            let parsed: ProjectsInput = parse(input)?;
            if let Some(query) = &parsed.query
                && utf16_len(query) > QUERY_MAX
            {
                return Err("query must be at most 4096 characters".to_owned());
            }
            Ok(ParsedInput::Projects(parsed))
        }
        AppControlActionName::OpenSession => {
            let parsed: OpenInput = parse(input)?;
            if !session_identifier(&parsed.session_id) {
                return Err(
                    "sessionId must look like sess_… or the legacy session_… form".to_owned(),
                );
            }
            Ok(ParsedInput::Open(parsed))
        }
        AppControlActionName::SetSessionArchived => {
            let parsed: ArchivedInput = parse(input)?;
            if !session_identifier(&parsed.session_id) {
                return Err(
                    "sessionId must look like sess_… or the legacy session_… form".to_owned(),
                );
            }
            if let Some(retry) = parsed.retry_of.as_deref()
                && !canonical_identifier(retry)
            {
                return Err("retryOf must be a canonical identifier".to_owned());
            }
            Ok(ParsedInput::Archived(parsed))
        }
        AppControlActionName::SetSessionPinned => {
            let parsed: PinnedInput = parse(input)?;
            if !session_identifier(&parsed.session_id) {
                return Err(
                    "sessionId must look like sess_… or the legacy session_… form".to_owned(),
                );
            }
            if let Some(retry) = parsed.retry_of.as_deref()
                && !canonical_identifier(retry)
            {
                return Err("retryOf must be a canonical identifier".to_owned());
            }
            Ok(ParsedInput::Pinned(parsed))
        }
    }
}

fn request_identity(retry_of: Option<&str>, context: &ToolUseContext) -> String {
    retry_of.map_or_else(|| context.tool_use.to_string(), str::to_owned)
}

fn trusted_context(context: &ToolUseContext) -> AppTrustedContext {
    AppTrustedContext {
        caller_session_id: context.session.to_string(),
        call_id: context.tool_use.to_string(),
        turn_id: None,
        workspace_path: context.workspace.root.as_str().to_owned(),
        workspace_identity: None,
        ui_target: None,
    }
}

/// 结果超过 32 KiB 时整份 JSON 落成 artifact；落盘失败时按同一标记截断。
async fn bounded_json(value: &Value, context: &ToolUseContext) -> String {
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

fn failed(error: AppControlError) -> ToolError {
    ToolError::Failed {
        message: error.to_string(),
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, AppControlError> {
    serde_json::to_value(value).map_err(|error| {
        AppControlError::invalid_output(format!("Host result is not serializable: {error}"))
    })
}

fn validate_projects(result: &ListProjectsResult) -> Result<(), AppControlError> {
    let mut seen = std::collections::HashSet::new();
    for entry in &result.projects {
        validate_project_entry(entry)?;
        let key = format!(
            "{}\0{}",
            entry
                .project
                .source_server_id
                .as_deref()
                .unwrap_or_default(),
            entry.project.project_id
        );
        if !seen.insert(key) {
            return Err(AppControlError::invalid_output(
                "Host returned a duplicate project",
            ));
        }
    }
    validate_search_scope(&result.search_scope)
}

fn validate_open(result: &OpenSessionResult) -> Result<(), AppControlError> {
    if let Some(target) = result.ui_target.as_deref()
        && !canonical_identifier(target)
    {
        return Err(AppControlError::invalid_output(
            "Host returned an invalid ui target",
        ));
    }
    Ok(())
}

fn validate_mutation(result: &MutationResult, expected: &str) -> Result<(), AppControlError> {
    if result.request_id != expected {
        return Err(AppControlError::invalid_output(
            "Host returned a different requestId",
        ));
    }
    Ok(())
}

pub struct AppControlTool {
    action: AppControlActionName,
    slot: AppSessionControlHostSlot,
}

impl AppControlTool {
    pub fn new(action: AppControlActionName, slot: AppSessionControlHostSlot) -> Self {
        Self { action, slot }
    }

    fn is_read(action: AppControlActionName) -> bool {
        matches!(action, AppControlActionName::ListProjects)
    }

    fn host(&self) -> Result<std::sync::Arc<dyn AppSessionControlHost>, AppControlError> {
        app_session_control_host(&self.slot).ok_or_else(|| {
            AppControlError::unavailable("App control is not connected in this process")
        })
    }

    async fn with_cancel<T, F>(
        &self,
        host: &std::sync::Arc<dyn AppSessionControlHost>,
        ctx: &AppTrustedContext,
        context: &ToolUseContext,
        future: F,
    ) -> Result<T, AppControlError>
    where
        F: std::future::Future<Output = Result<T, AppControlError>>,
    {
        if context.cancel.is_cancelled() {
            let _ = host.cancel(ctx).await;
            return Err(AppControlError::cancelled(
                "Call cancelled before owner admission",
            ));
        }
        tokio::select! {
            result = future => result,
            () = context.cancel.cancelled() => {
                // best-effort：Host 的 cancel 失败不能覆盖调用方看到的稳定 cancelled。
                let _ = host.cancel(ctx).await;
                Err(AppControlError::cancelled("Call cancelled"))
            }
        }
    }

    async fn execute(
        &self,
        host: &std::sync::Arc<dyn AppSessionControlHost>,
        ctx: &AppTrustedContext,
        parsed: ParsedInput,
        context: &ToolUseContext,
    ) -> Result<Value, AppControlError> {
        match parsed {
            ParsedInput::Projects(input) => {
                let result = self
                    .with_cancel(
                        host,
                        ctx,
                        context,
                        host.list_projects(ctx, ListProjectsInput { query: input.query }),
                    )
                    .await?;
                validate_projects(&result)?;
                to_value(&result)
            }
            ParsedInput::Open(input) => {
                let result = self
                    .with_cancel(
                        host,
                        ctx,
                        context,
                        host.open_session(
                            ctx,
                            OpenSessionInput {
                                session_id: input.session_id,
                            },
                        ),
                    )
                    .await?;
                validate_open(&result)?;
                to_value(&result)
            }
            ParsedInput::Archived(input) => {
                let request = request_identity(input.retry_of.as_deref(), context);
                let result = self
                    .with_cancel(
                        host,
                        ctx,
                        context,
                        host.set_session_archived(
                            ctx,
                            SetSessionArchivedInput {
                                session_id: input.session_id,
                                archived: input.archived,
                                request_id: request.clone(),
                            },
                        ),
                    )
                    .await?;
                validate_mutation(&result, &request)?;
                to_value(&result)
            }
            ParsedInput::Pinned(input) => {
                let request = request_identity(input.retry_of.as_deref(), context);
                let result = self
                    .with_cancel(
                        host,
                        ctx,
                        context,
                        host.set_session_pinned(
                            ctx,
                            SetSessionPinnedInput {
                                session_id: input.session_id,
                                pinned: input.pinned,
                                request_id: request.clone(),
                            },
                        ),
                    )
                    .await?;
                validate_mutation(&result, &request)?;
                to_value(&result)
            }
        }
    }
}

#[async_trait]
impl Tool for AppControlTool {
    fn name(&self) -> &str {
        match self.action {
            AppControlActionName::ListProjects => LIST_PROJECTS,
            AppControlActionName::OpenSession => OPEN_SESSION,
            AppControlActionName::SetSessionArchived => SET_SESSION_ARCHIVED,
            AppControlActionName::SetSessionPinned => SET_SESSION_PINNED,
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

    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("app desktop projects open session archive pin sidebar navigate focus list projects")
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
                "App control: {} opens or changes an App session outside this conversation. Allow it?",
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
        if context.agent.is_some() {
            return Err(failed(AppControlError::forbidden(
                "App control is unavailable in this execution context",
            )));
        }
        if context.cancel.is_cancelled() {
            return Err(failed(AppControlError::cancelled(
                "Call cancelled before owner admission",
            )));
        }
        let host = self.host().map_err(failed)?;
        let ctx = trusted_context(&context);
        let value = self
            .execute(&host, &ctx, parsed, &context)
            .await
            .map_err(failed)?;
        Ok(text_output(bounded_json(&value, &context).await))
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

fn session_id_schema() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": IDENTIFIER_MAX,
        "pattern": "^(?:sess|session)_[A-Za-z0-9._-]+$",
        "description": "The App session id, for example sess_1a2b3c4d-… . Older sessions use session_… . Take it from a tool result or the user, never invent one.",
    })
}

fn retry_of_schema() -> Value {
    identifier_schema(
        "Only when retrying a request whose result was inconclusive: pass the requestId from that call's result. Leave it out otherwise, and never invent one.",
    )
}

fn schema(action: AppControlActionName) -> Value {
    match action {
        AppControlActionName::ListProjects => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "query": {
                    "type": "string",
                    "maxLength": QUERY_MAX,
                    "description": "Optional project title substring. Omit it to list every discovery source.",
                },
            },
        }),
        AppControlActionName::OpenSession => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sessionId": session_id_schema(),
            },
            "required": ["sessionId"],
        }),
        AppControlActionName::SetSessionArchived => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sessionId": session_id_schema(),
                "archived": {
                    "type": "boolean",
                    "description": "true archives the session; false restores it.",
                },
                "retryOf": retry_of_schema(),
            },
            "required": ["sessionId", "archived"],
        }),
        AppControlActionName::SetSessionPinned => json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sessionId": session_id_schema(),
                "pinned": {
                    "type": "boolean",
                    "description": "true pins the session to the top; false unpins it.",
                },
                "retryOf": retry_of_schema(),
            },
            "required": ["sessionId", "pinned"],
        }),
    }
}

fn description(action: AppControlActionName) -> &'static str {
    match action {
        AppControlActionName::ListProjects => {
            "List the projects visible in the NIBI app and the sources that were actually searched. Use the returned project references with the other App tools; never rebuild them."
        }
        AppControlActionName::OpenSession => {
            "Open an App session in the window that is bound to this conversation. This asks the user for approval and does not focus or raise any OS window. If the session cannot be opened the result is unavailable with a reason."
        }
        AppControlActionName::SetSessionArchived => {
            "Archive or restore an App session. The app's task index is authoritative; this never touches the kernel session store or interrupts execution. To retry an inconclusive call, pass the requestId from its result as retryOf."
        }
        AppControlActionName::SetSessionPinned => {
            "Pin or unpin an App session. The app's task index is authoritative; this never touches the kernel session store or interrupts execution. To retry an inconclusive call, pass the requestId from its result as retryOf."
        }
    }
}

/// App 控制 4 个工具；只在入口装了端口时由 runtime 注册。
pub fn app_control_tools(slot: AppSessionControlHostSlot) -> Vec<std::sync::Arc<dyn Tool>> {
    [
        AppControlActionName::ListProjects,
        AppControlActionName::OpenSession,
        AppControlActionName::SetSessionArchived,
        AppControlActionName::SetSessionPinned,
    ]
    .into_iter()
    .map(|action| {
        std::sync::Arc::new(AppControlTool::new(action, slot.clone())) as std::sync::Arc<dyn Tool>
    })
    .collect()
}

#[cfg(test)]
#[path = "app_control_tests.rs"]
mod tests;

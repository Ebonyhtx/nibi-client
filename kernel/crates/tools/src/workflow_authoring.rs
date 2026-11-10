//! DWF 作者工具（Node `CreateWorkflow` / `AmendWorkflow` / `SaveWorkflow` /
//! `ListSavedWorkflows` / `EvalWorkflowSnippet` / `ResumeWorkflowRun` / `ListWorkflowRuns` /
//! `ListModels` 的内核工具面）。
//!
//! 分工：校验器、确认前的归一化、诊断形状与 model 内容都是 Node 的同一份 `@nibi/core`
//! 实现（sidecar 的 `author/prepare` 与 `author/execute`）。Rust 只做三件事——工具契约
//! （名字/描述/schema）、权限门（确认前先解析，确认门由解析结果给出）、技能门（按当前
//! **可见历史**判定，压缩后重新关门，与 Node 的同一条语义）。
//!
//! `ListModels` 与 `ListWorkflowRuns` 不走 sidecar：前者读本机模型目录，后者读 journal——
//! 两条都是纯读面，CLI/TUI 没有 DWF 引擎时也必须能答。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::message::{ContentBlock, Message, UserOrigin};
use nibi_kernel_api::permission::PermissionDecision;
use nibi_kernel_api::provider::ModelDirectorySlot;
use nibi_kernel_api::store::SessionStore;
use nibi_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation,
};
use nibi_kernel_api::workflow::{
    WorkflowAuthorRequest, WorkflowEngine, WorkflowEngineSlot, WorkflowRunListRow,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// 技能门要求先加载的内置技能名（Node `DYNAMIC_WORKFLOW_SKILL_NAME` 逐字）。
pub const DYNAMIC_WORKFLOW_SKILL: &str = "dynamic-workflows";

/// 六个由 sidecar 承载的作者工具名。
pub const CREATE_WORKFLOW_TOOL: &str = "CreateWorkflow";
pub const AMEND_WORKFLOW_TOOL: &str = "AmendWorkflow";
pub const SAVE_WORKFLOW_TOOL: &str = "SaveWorkflow";
pub const LIST_SAVED_WORKFLOWS_TOOL: &str = "ListSavedWorkflows";
pub const EVAL_WORKFLOW_SNIPPET_TOOL: &str = "EvalWorkflowSnippet";
pub const RESUME_WORKFLOW_RUN_TOOL: &str = "ResumeWorkflowRun";
/// 两个内核原生读面。
pub const LIST_WORKFLOW_RUNS_TOOL: &str = "ListWorkflowRuns";
pub const LIST_MODELS_TOOL: &str = "ListModels";

/// 灰度门关闭时下架的十一个工具（Node `DYNAMIC_WORKFLOW_TOOL_NAMES` 逐字）。
pub const DYNAMIC_WORKFLOW_TOOL_NAMES: [&str; 11] = [
    CREATE_WORKFLOW_TOOL,
    AMEND_WORKFLOW_TOOL,
    SAVE_WORKFLOW_TOOL,
    LIST_SAVED_WORKFLOWS_TOOL,
    LIST_MODELS_TOOL,
    EVAL_WORKFLOW_SNIPPET_TOOL,
    LIST_WORKFLOW_RUNS_TOOL,
    crate::workflow_run_detail::GET_WORKFLOW_RUN_TOOL,
    RESUME_WORKFLOW_RUN_TOOL,
    nibi_kernel_api::workflow::RESOLVE_WORKFLOW_QUESTION_TOOL,
    crate::fill_workflow_hole::FILL_WORKFLOW_HOLE_TOOL,
];

/// 需要 DWF 引擎（sidecar）才能工作的**作者**工具：没有引擎时不进工具表。留白补全不属于这一组
/// （它在灰度门里一直存在，没有引擎时按能力缺席失败，既有语义）。
pub const ENGINE_TOOLS: [&str; 6] = [
    CREATE_WORKFLOW_TOOL,
    AMEND_WORKFLOW_TOOL,
    SAVE_WORKFLOW_TOOL,
    LIST_SAVED_WORKFLOWS_TOOL,
    EVAL_WORKFLOW_SNIPPET_TOOL,
    RESUME_WORKFLOW_RUN_TOOL,
];

/// 作者工具的 `prepare` 结果：解析后的入参 + 确认门。
#[derive(Clone)]
struct Prepared {
    input: Value,
    gate: String,
}

/// 解析缓存：`tool_use` → 原入参 + 解析结果。确认窗在 `check_permissions` 里读它，
/// `call` 用同一份解析结果执行——一次调用只解析一次（Node 的生命周期同一条）。
#[derive(Default)]
struct PreparedCache {
    entries: Mutex<HashMap<String, (Value, Prepared)>>,
}

impl PreparedCache {
    fn put(&self, tool_use: &str, original: Value, prepared: Prepared) {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(tool_use.to_owned(), (original, prepared));
    }

    fn get(&self, tool_use: &str, input: &Value) -> Option<Prepared> {
        let entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let (original, prepared) = entries.get(tool_use)?;
        // hook 改过输入：缓存的那份不是将要执行的字节，重新解析。
        (original == input).then(|| prepared.clone())
    }

    fn take(&self, tool_use: &str) -> Option<Prepared> {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(tool_use)
            .map(|(_, prepared)| prepared)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Create,
    Amend,
    Save,
    ListSaved,
    Eval,
    Resume,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Create => CREATE_WORKFLOW_TOOL,
            Self::Amend => AMEND_WORKFLOW_TOOL,
            Self::Save => SAVE_WORKFLOW_TOOL,
            Self::ListSaved => LIST_SAVED_WORKFLOWS_TOOL,
            Self::Eval => EVAL_WORKFLOW_SNIPPET_TOOL,
            Self::Resume => RESUME_WORKFLOW_RUN_TOOL,
        }
    }

    fn description(self) -> String {
        match self {
            Self::Create => create_description(),
            Self::Amend => amend_description(),
            Self::Save => save_description(),
            Self::ListSaved => list_saved_description(),
            Self::Eval => eval_description(),
            Self::Resume => resume_description(),
        }
    }

    fn schema(self) -> Value {
        match self {
            Self::Create => create_schema(),
            Self::Amend => amend_schema(),
            Self::Save => save_schema(),
            Self::Eval => eval_schema(),
            Self::Resume => resume_schema(),
            Self::ListSaved => json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
        }
    }

    fn read_only(self) -> bool {
        matches!(self, Self::ListSaved)
    }

    fn concurrency_safe(self) -> bool {
        matches!(self, Self::ListSaved | Self::Eval)
    }

    fn search_hint(self) -> &'static str {
        match self {
            Self::Create => "author and run a dynamic-workflow script in the background",
            Self::Amend => "revise an existing dynamic-workflow run's script or settings",
            Self::Save => "save a workflow script into the project as a reusable definition",
            Self::ListSaved => "list the workflow definitions saved in this project",
            Self::Eval => {
                "compile and run a small workflow snippet against the real execution path"
            }
            Self::Resume => "resume a stopped dynamic-workflow run under the same run ID",
        }
    }
}

/// 六个侧车作者工具。
pub struct AuthoringTool {
    kind: Kind,
    engine: WorkflowEngineSlot,
    prepared: Arc<PreparedCache>,
    current: Option<nibi_kernel_api::model::ModelSelection>,
}

impl AuthoringTool {
    fn new(
        kind: Kind,
        engine: WorkflowEngineSlot,
        prepared: Arc<PreparedCache>,
        current: Option<nibi_kernel_api::model::ModelSelection>,
    ) -> Self {
        Self {
            kind,
            engine,
            prepared,
            current,
        }
    }

    fn engine(&self) -> Option<Arc<dyn WorkflowEngine>> {
        self.engine
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn unavailable(&self) -> Validation {
        Validation::Invalid {
            message: format!(
                "workflow_authoring_unavailable: this session cannot run {} — workflow execution \
is not available here. This is a capability gap, not a bad input.",
                self.kind.name()
            ),
            error_code: Some(1),
        }
    }

    /// 当前**可见历史**里有没有一次成功的 `Skill(dynamic-workflows)` 调用。探针缺席
    /// （没有会话历史的替身）时不生效，与 Node 的 `hasLoadedSkill` 同一条。
    async fn skill_loaded(&self, context: &ToolUseContext) -> bool {
        let Some(messages) = context.interactions.conversation(&context.session).await else {
            return true;
        };
        skill_loaded_in(&messages, DYNAMIC_WORKFLOW_SKILL)
    }

    async fn request(&self, input: Value, context: &ToolUseContext) -> WorkflowAuthorRequest {
        WorkflowAuthorRequest {
            tool: self.kind.name().to_owned(),
            input,
            cwd: context.workspace.root.as_str().to_owned(),
            session: context.session.as_str().to_owned(),
            tool_call: context.tool_use.as_str().to_owned(),
            has_loaded_skill: self.skill_loaded(context).await,
            current: self.current.clone(),
        }
    }

    /// 调 `author/prepare`；失败时给 `Validation::Invalid`（业务失败，不是执行错误）。
    async fn prepare(
        &self,
        input: Value,
        context: &ToolUseContext,
    ) -> Result<Prepared, Validation> {
        let Some(engine) = self.engine() else {
            return Err(self.unavailable());
        };
        let reply = engine
            .author_prepare(self.request(input.clone(), context).await)
            .await
            .map_err(|error| Validation::Invalid {
                message: error.message.unwrap_or(error.reason),
                error_code: Some(2),
            })?;
        if reply["ok"].as_bool() != Some(true) {
            return Err(Validation::Invalid {
                message: reply["message"]
                    .as_str()
                    .unwrap_or("the call was refused")
                    .to_owned(),
                error_code: reply["errorCode"]
                    .as_i64()
                    .and_then(|code| i32::try_from(code).ok()),
            });
        }
        let gate = reply["gate"].as_str().unwrap_or("ask").to_owned();
        let prepared = Prepared {
            input: reply.get("input").cloned().unwrap_or(Value::Null),
            gate,
        };
        self.prepared
            .put(context.tool_use.as_str(), input, prepared.clone());
        Ok(prepared)
    }
}

#[async_trait]
impl Tool for AuthoringTool {
    fn name(&self) -> &str {
        self.kind.name()
    }

    fn input_schema(&self) -> Value {
        self.kind.schema()
    }

    fn description(&self, _context: &PromptContext) -> String {
        self.kind.description()
    }

    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some(self.kind.search_hint())
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        self.kind.read_only()
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        self.kind.concurrency_safe()
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(100_000)
    }

    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        match self.prepare(input.clone(), context).await {
            Ok(_) => Validation::Ok,
            Err(invalid) => invalid,
        }
    }

    async fn check_permissions(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        match self.kind {
            Kind::ListSaved | Kind::Resume => PermissionDecision::Allow {
                updated_input: None,
            },
            Kind::Create | Kind::Save => ask(self.kind.name(), self.kind.name()),
            Kind::Eval => {
                let prepared = self.prepared.get(context.tool_use.as_str(), input);
                match prepared.as_ref().map(|prepared| prepared.gate.as_str()) {
                    Some("proceed") => PermissionDecision::Allow {
                        updated_input: None,
                    },
                    _ => ask(
                        self.kind.name(),
                        "EvalWorkflowSnippet runs a snippet that carries world.run commands",
                    ),
                }
            }
            Kind::Amend => {
                let prepared = self.prepared.get(context.tool_use.as_str(), input);
                if prepared
                    .as_ref()
                    .is_some_and(|prepared| amend_is_owned(&prepared.input["predecessor"]))
                {
                    PermissionDecision::Allow {
                        updated_input: None,
                    }
                } else {
                    ask(
                        AMEND_WORKFLOW_TOOL,
                        "AmendWorkflow starts a revised workflow run",
                    )
                }
            }
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let prepared = match self.prepared.get(context.tool_use.as_str(), &input) {
            Some(prepared) => prepared,
            // hook 改过输入或缓存已被取走：重新解析（Node 在 hook 之后的重新校验同理）。
            None => self
                .prepare(input, &context)
                .await
                .map_err(|invalid| match invalid {
                    Validation::Invalid { message, .. } => ToolError::Failed { message },
                    Validation::Ok => ToolError::Failed {
                        message: "the call could not be prepared".to_owned(),
                    },
                })?,
        };
        let Some(engine) = self.engine() else {
            return Err(ToolError::Failed {
                message: format!(
                    "workflow_authoring_unavailable: this session cannot run {}",
                    self.kind.name()
                ),
            });
        };
        let reply = engine
            .author_execute(self.request(prepared.input, &context).await)
            .await
            .map_err(|error| ToolError::Failed {
                message: error.message.unwrap_or(error.reason),
            })?;
        self.prepared.take(context.tool_use.as_str());
        if reply["ok"].as_bool() != Some(true) {
            return Err(ToolError::Failed {
                message: reply["message"]
                    .as_str()
                    .unwrap_or("the call was refused")
                    .to_owned(),
            });
        }
        let content = match &reply["content"] {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        Ok(ToolOutput {
            content: vec![nibi_kernel_api::message::ToolResultContent::Text { text: content }],
            is_error: reply["isError"].as_bool() == Some(true),
            display: Value::Null,
        })
    }
}

fn ask(tool: &str, what: &str) -> PermissionDecision {
    PermissionDecision::Ask {
        message: format!("{tool}: the user must confirm before {what}."),
        suggestions: Vec::new(),
    }
}

/// `isAmendWorkflowOwnedPredecessor`：本会话的 run、不是用户亲手停下、没有引入新 provider。
fn amend_is_owned(predecessor: &Value) -> bool {
    predecessor["owned_by_this_session"].as_bool() == Some(true)
        && predecessor["stop_reason"].as_str() != Some("user")
        && predecessor.get("introduces_providers").is_none()
}

/// `sessionHasLoadedSkill`：成功的 Skill 调用在**当前可见历史**里。
fn skill_loaded_in(messages: &[Message], name: &str) -> bool {
    let mut calls: HashSet<&str> = HashSet::new();
    for message in messages {
        match message {
            Message::Assistant(assistant) => {
                for block in &assistant.content {
                    if let ContentBlock::ToolUse {
                        id,
                        name: tool,
                        input,
                    } = block
                        && tool == "Skill"
                        && skill_name(input) == Some(name)
                    {
                        calls.insert(id.as_str());
                    }
                }
            }
            Message::User(user) if matches!(user.origin, UserOrigin::ToolResult { .. }) => {
                for block in &user.content {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        is_error,
                        ..
                    } = block
                        && !*is_error
                        && calls.contains(tool_use_id.as_str())
                    {
                        return true;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

fn skill_name(input: &Value) -> Option<&str> {
    input
        .get("skill")
        .and_then(Value::as_str)
        .or_else(|| input.get("name").and_then(Value::as_str))
}

/// 全部十一个 DWF 工具里的六个作者面 + 两个原生读面。
pub fn authoring_tools(
    engine: WorkflowEngineSlot,
    models: ModelDirectorySlot,
    current: Option<nibi_kernel_api::model::ModelSelection>,
    store: Arc<dyn SessionStore>,
) -> Vec<Arc<dyn Tool>> {
    let prepared = Arc::new(PreparedCache::default());
    let mut tools: Vec<Arc<dyn Tool>> = [
        Kind::Create,
        Kind::Amend,
        Kind::Save,
        Kind::ListSaved,
        Kind::Eval,
        Kind::Resume,
    ]
    .into_iter()
    .map(|kind| {
        Arc::new(AuthoringTool::new(
            kind,
            engine.clone(),
            prepared.clone(),
            current.clone(),
        )) as Arc<dyn Tool>
    })
    .collect();
    tools.push(Arc::new(ListWorkflowRunsTool {
        store: store.clone(),
    }));
    tools.push(Arc::new(ListModelsTool { models, current }));
    tools
}

// ————————————————————————————————————————————————————————————————
// 原生读面：ListWorkflowRuns / ListModels
// ————————————————————————————————————————————————————————————————

pub struct ListWorkflowRunsTool {
    store: Arc<dyn SessionStore>,
}

#[async_trait]
impl Tool for ListWorkflowRunsTool {
    fn name(&self) -> &str {
        LIST_WORKFLOW_RUNS_TOOL
    }

    fn input_schema(&self) -> Value {
        list_runs_schema()
    }

    fn description(&self, _context: &PromptContext) -> String {
        list_runs_description()
    }

    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("list this project's dynamic-workflow runs, including other sessions'")
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(100_000)
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let limit = input["limit"]
            .as_u64()
            .map_or(20, |limit| limit.clamp(1, 50)) as usize;
        let statuses: Option<Vec<String>> = input["statuses"].as_array().map(|statuses| {
            statuses
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        });
        let rows = self
            .store
            .workflow_runs_by_cwd(
                context.workspace.root.as_str(),
                limit + 1,
                statuses.as_deref(),
            )
            .await
            .map_err(|error| ToolError::Failed {
                message: error.to_string(),
            })?;
        let truncated = rows.len() > limit;
        let runs: Vec<Value> = rows
            .into_iter()
            .take(limit)
            .map(|row| run_row(&row, context.session.as_str()))
            .collect();
        let mut header = format!("count=\"{}\"", runs.len());
        if truncated {
            header.push_str(" truncated=\"true\"");
        }
        let text = if runs.is_empty() {
            format!(
                "<workflow_runs {header}>\nNo workflow runs recorded for this project.\n</workflow_runs>"
            )
        } else {
            let mut out = format!("<workflow_runs {header}>");
            for run in &runs {
                out.push('\n');
                out.push_str(&run_line(run));
            }
            out.push_str("\n</workflow_runs>");
            out
        };
        Ok(ToolOutput {
            content: vec![nibi_kernel_api::message::ToolResultContent::Text { text }],
            is_error: false,
            display: Value::Null,
        })
    }
}

fn run_row(row: &WorkflowRunListRow, session: &str) -> Value {
    let label = row
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| (name.to_owned(), "name"))
        .or_else(|| {
            row.script_text
                .as_deref()
                .and_then(first_non_empty_line)
                .map(|line| (bound_label(line), "script"))
        })
        .unwrap_or_else(|| (row.run_id.clone(), "script"));
    let owned = row.parent_session_id.as_deref() == Some(session);
    let in_flight = matches!(row.status.as_str(), "pending" | "running");
    let mut value = serde_json::Map::new();
    value.insert("runId".to_owned(), json!(row.run_id));
    value.insert("label".to_owned(), json!(label.0));
    value.insert("labelSource".to_owned(), json!(label.1));
    value.insert("status".to_owned(), json!(row.status));
    if let Some(stop) = &row.stop_reason {
        value.insert("stopReason".to_owned(), json!(stop));
    }
    if let Some(from) = &row.resumed_from {
        value.insert("resumedFrom".to_owned(), json!(from));
    }
    if let Some(by) = &row.superseded_by {
        value.insert("supersededBy".to_owned(), json!(by));
    }
    value.insert("ownedByThisSession".to_owned(), json!(owned));
    if in_flight && !owned {
        value.insert("possiblyInterrupted".to_owned(), json!(true));
    }
    value.insert("createdAt".to_owned(), json!(row.created_at));
    value.insert("updatedAt".to_owned(), json!(row.updated_at));
    value.insert("spentTokens".to_owned(), json!(row.spent_tokens));
    Value::Object(value)
}

fn first_non_empty_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

fn bound_label(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= 80 {
        return line.to_owned();
    }
    chars.into_iter().take(80).collect()
}

/// Node `workflowRunAttribute`：一 run 一行的属性写法（标签里的引号转义，布尔写 true/false）。
fn attr(name: &str, value: &str) -> String {
    format!(" {name}=\"{}\"", value.replace('"', "&quot;"))
}

fn run_line(run: &Value) -> String {
    let text = |name: &str| run.get(name).and_then(Value::as_str).unwrap_or_default();
    let flag = |name: &str| run.get(name).and_then(Value::as_bool) == Some(true);
    let number = |name: &str| run.get(name).and_then(Value::as_u64).unwrap_or_default();
    let mut line = format!(
        "<run{} {} {}",
        attr("id", text("runId")),
        attr("status", text("status")),
        attr("label", text("label")),
    );
    if run.get("stopReason").is_some() {
        line.push_str(&attr("stop_reason", text("stopReason")));
    }
    if run.get("resumedFrom").is_some() {
        line.push_str(&attr("resumed_from", text("resumedFrom")));
    }
    if run.get("supersededBy").is_some() {
        line.push_str(&attr("superseded_by", text("supersededBy")));
    }
    line.push_str(&attr("label_source", text("labelSource")));
    line.push_str(&attr(
        "owned_by_this_session",
        if flag("ownedByThisSession") {
            "true"
        } else {
            "false"
        },
    ));
    if flag("possiblyInterrupted") {
        line.push_str(&attr("possibly_interrupted", "true"));
    }
    line.push_str(&attr("spent_tokens", &number("spentTokens").to_string()));
    line.push_str(&attr("created_at", &iso_timestamp(number("createdAt"))));
    line.push_str(&attr("updated_at", &iso_timestamp(number("updatedAt"))));
    line.push_str("/>");
    line
}

/// epoch 毫秒 → `Date.toISOString()` 的 UTC 形式（`2026-10-20T08:00:00.000Z`）。
fn iso_timestamp(ms: u64) -> String {
    let seconds = ms / 1_000;
    let millis = ms % 1_000;
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60
    )
}

/// 1970-01-01 起的天数 → 公历年月日（Howard Hinnant 的 `civil_from_days`）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if m <= 2 { y + 1 } else { y },
        u32::try_from(m).unwrap_or_default(),
        u32::try_from(d).unwrap_or_default(),
    )
}

pub struct ListModelsTool {
    models: ModelDirectorySlot,
    /// 会话此刻的选择（工具构造时的默认选择；会话中途换模型时这一行只是起点）。
    current: Option<nibi_kernel_api::model::ModelSelection>,
}

#[async_trait]
impl Tool for ListModelsTool {
    fn name(&self) -> &str {
        LIST_MODELS_TOOL
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object", "properties": {}, "additionalProperties": false})
    }

    fn description(&self, _context: &PromptContext) -> String {
        list_models_description()
    }

    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("list the models this host has configured for workflow subagents")
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(100_000)
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        _input: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let directory = self
            .models
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some(directory) = directory else {
            return Err(ToolError::Failed {
                message:
                    "model_catalog_unavailable: this session cannot list models — the host did not \
provide a model catalog. This is a capability gap, not an empty configuration. Omit \
`subagent_model` on CreateWorkflow and AmendWorkflow; the workflow's subagents will run on the \
session model."
                        .to_owned(),
            });
        };
        let catalog = directory.catalog().await;
        let lines: Vec<String> = catalog
            .models
            .iter()
            .map(|model| {
                let id = format!("{}/{}", model.provider, model.model);
                let mut parts = vec![id];
                if !model.provider_name.is_empty() {
                    parts.push(format!(" — {}", model.provider_name));
                }
                if !model.reasoning_levels.is_empty() {
                    let levels = model.reasoning_levels.join(",");
                    let fallback = model
                        .reasoning_levels
                        .last()
                        .map(|level| format!(" (default {level})"))
                        .unwrap_or_default();
                    parts.push(format!("; levels: {levels}{fallback}"));
                }
                if self.current.as_ref().is_some_and(|current| {
                    current.provider.eq_ignore_ascii_case(&model.provider)
                        && current.model.eq_ignore_ascii_case(&model.model)
                }) {
                    parts.push(" [current]".to_owned());
                }
                parts.join("")
            })
            .collect();
        let text = if lines.is_empty() {
            "<models count=\"0\">\nNo models are configured on this host. Omit `subagent_model`: \
the workflow's subagents run on the session model.\n</models>"
                .to_owned()
        } else {
            format!(
                "<models count=\"{}\">\n{}\n</models>",
                lines.len(),
                lines.join("\n")
            )
        };
        Ok(ToolOutput {
            content: vec![nibi_kernel_api::message::ToolResultContent::Text { text }],
            is_error: false,
            display: Value::Null,
        })
    }
}

// ————————————————————————————————————————————————————————————————
// 契约：描述与 schema（与 Node 工具逐字/同形）
// ————————————————————————————————————————————————————————————————

fn create_description() -> String {
    [
        "Create and run a dynamic workflow: a TypeScript script that orchestrates multiple model-driven subagents with plain control flow (loops, conditionals, fan-out) and typed intermediate results. The script is typechecked, the user is asked to confirm it, and the run starts in the background; you are notified with its final result when it settles. Compilation errors come back as diagnostics.",
        "",
        "When to use:",
        "- The user explicitly asks for a workflow — \"use a workflow\", \"with a workflow\", \"使用 workflow\", \"用工作流\", or any phrasing that names workflow/工作流 as the means: this tool is mandatory. Do not substitute the Agent/Task subagent tools, do not do the work inline yourself, and do not judge the task too small for a workflow — the user chose the tool, and that choice is theirs. Size only decides how many subagents the script gets, never whether it is written.",
        "- Without such an explicit request, do not start a workflow: delegate with the Agent tool or do the work yourself, even for multi-step or multi-subagent tasks.",
        "",
        "Before writing or revising a script, load the `dynamic-workflows` skill with the Skill tool: it carries the facade declarations the script is checked against, the authoring rules, and this tool's full contract. A call that submits a script is refused until that skill has been loaded in this session; running a saved workflow by name is exempt.",
        "",
        "Pass exactly one source: `script` (a one-off script written inline; it is saved to a draft file the result names — revise that file and resubmit with `path`, never paste the script again), `saved` (a workflow saved in this project or globally, by name; check ListSavedWorkflows before writing one from scratch), or `path` (a script file on disk, normally the file a previous result named). To change a run that already exists — errored, completed, stopped or still running — call AmendWorkflow instead of starting over.",
    ]
    .join("\n")
}

fn amend_description() -> String {
    [
        "Amend an existing dynamic-workflow run with a revised script or revised settings. Starts a NEW run that supersedes the old one and imports its finished work as a cache, so only what you changed is paid for again. Works on ANY run of this project: completed, errored, stopped — or still running.",
        "",
        "When to use:",
        "- The run errored, or completed but needs one more stage: fix or extend the script and amend. Never rewrite the workflow from scratch with CreateWorkflow.",
        "- The run is STILL RUNNING and is visibly going wrong: amend it NOW, in one call. Do not TaskStop it first and do not wait for it to finish — this tool stops the running predecessor and starts the revision; the earlier you amend, the less is re-paid.",
        "- The user wants the same workflow with fewer subagents at once, its subagents on another model, or another name: amend with only that field and neither `path` nor `script`.",
        "- To continue a stopped run unchanged, use ResumeWorkflowRun instead.",
        "",
        "Load the `dynamic-workflows` skill with the Skill tool before revising a script: it carries the cache rules, what each omitted field keeps, and the confirmation rule. A call that passes `path` or `script` is refused until that skill has been loaded in this session; a settings-only call is not. Pass `path` (the run's script file, edited in place — the usual form) or `script` (the whole revised script inline), never both.",
    ]
    .join("\n")
}

fn save_description() -> String {
    [
        "Save a dynamic-workflow script with its metadata so it can be run again later by name (CreateWorkflow's `saved` source; ListSavedWorkflows lists them). The required `scope` decides whether it lives in this project or globally.",
        "",
        "NEVER call this tool unsolicited: saving writes a file into the user's repository, and that is their decision. When a workflow you just built looks reusable, suggest saving it in one sentence and wait; call SaveWorkflow only after the user agrees, or when the user asks directly.",
        "",
        "Load the `dynamic-workflows` skill with the Skill tool first: it carries the file format, the argument declarations and the authoring rules. The call is refused until that skill has been loaded in this session. Pass `script` (the body only) or `script_path` (a draft file, saved without re-emitting it), never both.",
    ]
    .join("\n")
}

fn list_saved_description() -> String {
    [
        "Lists the dynamic workflows saved in this project (`.nibi/workflows/`, keyed on the session's working directory) and the global archive (`~/.nibi/workflows`, available from every project). These are workflow DEFINITIONS you can run, not past runs — for the run history use ListWorkflowRuns instead.",
        "",
        "- Each row gives the name, what the workflow does, when to reach for it, and the arguments it takes.",
        "- Run one by passing its name to CreateWorkflow as `saved: { name, args }`. The user still confirms the run.",
        "- Check here before writing a workflow from scratch: if the project already saved one that fits, running it beats rebuilding it.",
        "- `invalid` lists saved files that could not be read (usually a hand-edited metadata block). They are named so they can be fixed, not silently skipped.",
    ]
    .join("\n")
}

fn eval_description() -> String {
    [
        "Compile and run a small dynamic-workflow TypeScript snippet synchronously, against the same compiler, sandbox and world-read execution path a real run uses. It is the test bench for workflow authoring: check a parser against real command output, see what a glob actually returns, or exercise a gate predicate on real repository state before putting it in a CreateWorkflow script. No agent()/report(); nothing persists; the result comes back in this call.",
        "",
        "Load the `dynamic-workflows` skill with the Skill tool first: it carries the snippet facade and the rules. The call is refused until that skill has been loaded in this session. Pass `code` (inline) or `path` (a file holding the snippet), never both.",
    ]
    .join("\n")
}

fn resume_description() -> String {
    [
        "Resumes a dynamic-workflow run whose status is `stopped` — the user cancelled it, you stopped it with TaskStop, a provider-side error stopped it (expired sign-in, model not in the plan, quota cap), or the process that owned it exited (`interrupted`). The run continues under the same run ID: finished steps are replayed from the journal without spending tokens, unfinished steps are dispatched again. The one stopped run that is NOT resumable is a `superseded` one: an AmendWorkflow replaced it, and its successor is the live run.",
        "",
        "- Takes run_id — from CreateWorkflow's or AmendWorkflow's result, from a completion notification, or from GetWorkflowRun / ListWorkflowRuns.",
        "- The resumed run is backgrounded: you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.",
        "- An `errored` run (the script itself failed) is NOT resumable — replaying it would fail the same way. Fix the script and submit it with AmendWorkflow instead. A completed run is not resumable either; a `superseded` run is refused with the successor's ID.",
        "- Stop reason `user` means the user stopped it on purpose: resume it only when the user asks you to; never resume a run the user just cancelled on your own initiative. Reason `model` is your own TaskStop. Reason `provider` means a provider-side error stopped it: resolve the cause with the user first (the stop notification names it), then resume. Reason `interrupted` (the process died) is different: continuing it is usually what the user wants.",
    ]
    .join("\n")
}

fn list_runs_description() -> String {
    [
        "Lists this project's dynamic-workflow runs (the session's working directory is the project key), most recently updated first. Includes runs started by other sessions — the run journal is per-project, not per-session.",
        "",
        "- Each row gives the run ID, its label, lifecycle status, whether this session started it, tokens spent, and timestamps.",
        "- `possibly_interrupted=\"true\"` means this session cannot confirm the run is still alive: it may be a leftover from a process that exited, or a sibling session's run still in flight. It is an annotation, not a verdict — do not report it as a failure.",
        "- Pass a run ID to GetWorkflowRun for progress detail, the log tail, the final result, or the failure.",
        "- Three terminal states: `completed`; `errored` (the script itself failed); `stopped` with `stop_reason` — `user` (cancelled on purpose: resume only when the user asks), `model` (your own TaskStop), `provider` (a provider-side error stopped it: read GetWorkflowRun for the cause, resolve it with the user, then resume), `interrupted` (the owning process exited: continuing it is usually what the user wants), `superseded` (an AmendWorkflow replaced it; `superseded_by` names the live successor — never resume a superseded run).",
        "- Any stopped run other than a superseded one can be continued with ResumeWorkflowRun — no rebuild needed, same run ID, same script. An errored run cannot.",
        "- ANY run here — completed, stopped, errored, or still running — can instead be revised with AmendWorkflow: pass its run ID and the corrected script; the new run imports the old one's finished work as a warm cache (and stops it first if it is still running). A run whose script errored is the case to reach for it — fix the script instead of rewriting the workflow from scratch. `resumed_from` on a row names the run it was amended from.",
    ]
    .join("\n")
}

fn list_models_description() -> String {
    [
        "Lists the models this host has configured, so a dynamic workflow's subagents can be pointed at one.",
        "",
        "- Each row's `id` (`providerId/modelId`) pastes verbatim into the `subagent_model` field of CreateWorkflow or AmendWorkflow. Append `$<level>` to pick a reasoning level from that row's `reasoningLevels`.",
        "- This tool does NOT change the model you are running on. The session model is the user's choice and only the user changes it; `subagent_model` only moves the workflow's subagents.",
        "- The model the session is on right now is marked `[current]` — setting the subagents to that one is the same as omitting the field.",
        "- A row marked `disabled` cannot be used (no API key, disabled by policy). Resolve that with the user rather than picking around it silently.",
    ]
    .join("\n")
}

fn create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "minLength": 1,
                "description": "Short run label in the user's language. Always pass it for an inline script; defaults to the saved workflow's name."
            },
            "script": {
                "type": "string",
                "description": "The whole workflow script, inline. Exactly one of `script`, `saved` and `path`."
            },
            "saved": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1},
                    "args": {"type": "object", "additionalProperties": true},
                    "scope": {"type": "string", "enum": ["project", "global"]}
                },
                "required": ["name"],
                "additionalProperties": false,
                "description": "A saved workflow to run, by name. Exactly one of `script`, `saved` and `path`."
            },
            "path": {
                "type": "string",
                "minLength": 1,
                "description": "A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`."
            },
            "args": {
                "type": "object",
                "additionalProperties": true,
                "description": "Values for the arguments a `path` file declares. Only with `path`."
            },
            "max_concurrency": {
                "type": "integer",
                "minimum": 1,
                "description": "Subagents working at once, above or below the default. Only when the user asks for more or less parallelism; never as a reaction to provider errors."
            },
            "subagent_model": {
                "type": "string",
                "description": "Model for the subagents (`providerId/modelId` or a model id). Only when the user asks, and never a model under another provider the user did not name — ask them first if one would help; you stay on the session model."
            }
        },
        "additionalProperties": false
    })
}

fn amend_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "run_id": {
                "type": "string",
                "minLength": 1,
                "description": "ID of the run to amend (from a result, a notification, GetWorkflowRun or ListWorkflowRuns)."
            },
            "script": {
                "type": "string",
                "minLength": 1,
                "description": "The whole revised script, inline. This OR `path`, never both; omit both to keep the predecessor's script."
            },
            "path": {
                "type": "string",
                "minLength": 1,
                "description": "The revised script's file, usually the predecessor's own script file edited in place. This OR `script`, never both."
            },
            "name": {
                "type": "string",
                "minLength": 1,
                "description": "Display label for the new run; defaults to the predecessor's."
            },
            "max_concurrency": {
                "type": ["integer", "null"],
                "minimum": 1,
                "description": "Omit to keep the predecessor's limit, null to return to the default, a number to set one above or below it (only when the user asks)."
            },
            "subagent_model": {
                "type": ["string", "null"],
                "description": "Omit to keep the predecessor's choice, null for the session model, a model id to set one (only when the user asks, never a model under another provider the user did not name)."
            }
        },
        "required": ["run_id"],
        "additionalProperties": false
    })
}

fn save_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "description": "File-safe identifier: letters, digits, dot, dash and underscore."
            },
            "description": {"type": "string", "minLength": 1, "description": "One line saying what the workflow does."},
            "whenToUse": {"type": "string", "minLength": 1, "description": "When this workflow is the right answer."},
            "args": {"type": "object", "additionalProperties": true, "description": "Argument declarations the script reads off `args`."},
            "script": {"type": "string", "description": "The script body, inline, without a metadata block. This OR `script_path`, never both."},
            "script_path": {"type": "string", "minLength": 1, "description": "A file holding the script body, usually a draft a result named. This OR `script`, never both."},
            "scope": {"type": "string", "enum": ["project", "global"], "description": "\"project\" when the script depends on this repository; \"global\" when it depends on nothing in it. Required, no default."},
            "run_id": {"type": "string", "minLength": 1, "description": "Provenance only: the id of the run this workflow was distilled from, when saving a workflow that just ran."}
        },
        "required": ["name", "description", "scope"],
        "additionalProperties": false
    })
}

fn eval_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "minLength": 1,
                "description": "The snippet, inline. This OR `path`, never both."
            },
            "path": {
                "type": "string",
                "minLength": 1,
                "description": "A file holding the snippet, read whole. This OR `code`, never both."
            },
            "timeoutMs": {
                "type": "integer",
                "minimum": 1_000,
                "maximum": 600_000,
                "description": "Wall clock for the whole snippet, in ms. Default 60000, at most 600000."
            }
        },
        "additionalProperties": false
    })
}

fn resume_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "run_id": {
                "type": "string",
                "minLength": 1,
                "description": "The workflow run ID to resume — a cancelled run or one that failed with code `Interrupted`, as seen with GetWorkflowRun or ListWorkflowRuns"
            }
        },
        "required": ["run_id"],
        "additionalProperties": false
    })
}

fn list_runs_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 50,
                "description": "Maximum number of runs to return (1-50, default 20). Most recently updated runs come first."
            },
            "statuses": {
                "type": "array",
                "items": {"type": "string", "enum": ["pending", "running", "completed", "errored", "stopped"]},
                "description": "Optional status filter. Omit to see every run in this project."
            }
        },
        "additionalProperties": false
    })
}

#[cfg(test)]
#[path = "workflow_authoring_tests.rs"]
mod tests;

//! `FillWorkflowHole`：给正在跑的 DWF run 里一处留白补上函数体（路线 C）。
//!
//! 分工与 Node 同形（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：确认之前的
//! 一切（run / 留白 / 函数体字节）在 [`WorkflowEngine::fill_target`] 读面与本地校验；拼接、编译、
//! 站点稳定性复核、引擎放行与草稿改写在 sidecar（[`WorkflowEngine::fill_hole`]）。这里做 handler
//! 该做的三件事——把内联函数体先写进 fill 文件（编译结果读出来**之前**）、调端口、把诊断锚到它
//! 落在的那个文件；拒绝文案与成功回话逐字沿用 Node 的句子。
//!
//! 引擎经**槽**取得：注册表建好时 sidecar 还没接上（`with_workflow_engine` 在入口最后才调），
//! 工具在调用时读槽；缺席回 Node 端口缺席的同一条「本会话不能补全」。UI 轨的两件——确认窗预览
//! 单槽与技能门——路线 C 没有宿主面（技能门属于创作面切片，预览属于确认窗），记在尾单。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, ReadFile, WritePrecondition};
use rust_cli_kernel_api::env_files::PutFile;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation,
};
use rust_cli_kernel_api::workflow::{WorkflowEngine, WorkflowEngineSlot, WorkflowFillOutcome};
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// 模型看到的使用纪律（Node `FILL_WORKFLOW_HOLE_TOOL_DESCRIPTION` 逐句相同）。
const DESCRIPTION: &str = "Supplies the body of a hole that a RUNNING dynamic-workflow run has reached and is waiting at. Starts nothing: the run keeps its id, journal and subagents, and grows by the statements you write.\n\
\n\
- Takes run_id and hole_id — both from the hole notification (or from GetWorkflowRun's holes if that notification was lost). Only the branch parked at the hole waits; the rest of the run keeps going, and nothing times out.\n\
- Read the run's draft at the path the notification names for context: the body is compiled WHERE THE HOLE STANDS and sees every binding declared before it. Write only the statements of the hole's function — not the `hole(...)` call, not an arrow, not the script around it — and return a value of the hole's type, or end with a new tail hole named for the next step when the workflow's shape is not known yet (the skill's §15).\n\
- Rehearse fixed logic in EvalWorkflowSnippet first. A hole is filled once: a body under a loop runs on every iteration with that iteration's bindings.\n\
- On diagnostics the fill is saved to a fill file; edit that file in place and resubmit with `path` instead of pasting the body again. To change anything OUTSIDE the hole, use AmendWorkflow.\n\
\n\
Load the `dynamic-workflows` skill with the Skill tool before writing a body: it carries the facade the body is checked against and the hole rules. A call is refused until that skill has been loaded in this session. Pass `script` (the statements inline) or `path` (a file holding them), never both.";

/** 「恰好给一个函数体来源」的违规说明（Node `FILL_WORKFLOW_HOLE_SOURCE_ERROR` 逐字）。 */
const SOURCE_ERROR: &str = "Provide exactly one body source: `script` for the hole's statements written inline, or `path` for a file holding them (usually the fill file a rejected attempt was saved to). Passing both, or neither, is ambiguous.";

const MODEL_BYTES: usize = 24_000;

/// 工具名（Node `FILL_WORKFLOW_HOLE_TOOL_NAME` 逐字）。
pub const FILL_WORKFLOW_HOLE_TOOL: &str = "FillWorkflowHole";

pub struct FillWorkflowHoleTool {
    /// 引擎槽（`with_workflow_engine` 在注册表建好之后写入；调用时读）。
    engine: WorkflowEngineSlot,
    /// 「上一次被拒的函数体」表（Node `rejectedFills`）：键 `session\0run\0hole`，值函数体字节。
    /// 只对 `path` 提交比对——内联再贴一遍会铸一个新的 fill 文件，那是另一种错误，由诊断说。
    rejected: Mutex<HashMap<String, String>>,
}

impl FillWorkflowHoleTool {
    pub fn new(engine: WorkflowEngineSlot) -> Self {
        Self {
            engine,
            rejected: Mutex::new(HashMap::new()),
        }
    }

    fn engine(&self) -> Option<Arc<dyn WorkflowEngine>> {
        self.engine
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn remember_rejected(&self, session: &str, run_id: &str, hole_id: &str, body: &str) {
        self.rejected
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(rejection_key(session, run_id, hole_id), body.to_owned());
    }

    fn rejected_body(&self, session: &str, run_id: &str, hole_id: &str) -> Option<String> {
        self.rejected
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&rejection_key(session, run_id, hole_id))
            .cloned()
    }
}

fn rejection_key(session: &str, run_id: &str, hole_id: &str) -> String {
    format!("{session}\u{0}{run_id}\u{0}{hole_id}")
}

/// 「本会话不能补全」：引擎缺席（sidecar 没接）。绝不静默成功——那会让一支脚本永远停在留白处。
fn fill_unavailable_text() -> String {
    "workflow_fill_unavailable: this session cannot fill workflow holes — workflow execution is not available here. This is a capability gap, not a bad hole id.".to_owned()
}

/// `run_not_found` 的确认前文案（Node resolveInput 的加长版：`run_id` 的正确来源）。
fn run_not_found_text(run_id: &str) -> String {
    format!(
        "run_not_found: no workflow run with ID {run_id} exists for this project. Use \
ListWorkflowRuns to see the runs that do. Nothing was filled: `run_id` pointed at a run that does \
not exist — take it from the hole notification or from ListWorkflowRuns."
    )
}

/// 留白不是 run 正在等的（确认前读面；Node notWaitingFailure 同一条包法）。
fn not_waiting_text(detail: &str) -> String {
    format!("hole_not_waiting: {detail} Nothing was filled.")
}

fn unchanged_fill_text(described: &str, run_id: &str, hole_id: &str) -> String {
    format!(
        "fill_unchanged: {described} is byte-for-byte the body that was just rejected for hole \
{hole_id} of run {run_id}, so resubmitting it would fail the same way. Edit the file first (the \
diagnostics name the lines), then call FillWorkflowHole again with the same `path`. Nothing was \
filled."
    )
}

fn fill_file_unreadable_text(detail: &str) -> String {
    format!(
        "workflow_fill_file_unreadable: {detail}. Pass `path` for the fill file a previous result \
named, or submit the body inline as `script`. Nothing was filled."
    )
}

/// 端口的非诊断拒绝 → 各配稳定错误码（Node fillRefusalFor 同一张表；message 原样来自引擎）。
fn refusal_text(reason: &str, message: &str, run_id: &str) -> String {
    match reason {
        "run_not_found" => run_not_found_text(run_id),
        "hole_not_waiting" => format!("hole_not_waiting: {message}"),
        "fill_ids_unstable" => format!(
            "fill_ids_unstable: {message} This is a host fault, not a problem with your body: the \
hole is still waiting. Report it to the user rather than rewriting the body."
        ),
        other => format!("workflow_fill_refused: {message} (reason: {other})"),
    }
}

/// 诊断行：`{path}:L{line}:C{column} {message}`，锚到**它落在的文件**——函数体内的按 fill 文件的
/// 行，函数体外的（如 9005 的另一处在父脚本里）按 run 草稿的行与路径，因为那才是它指着的代码。
fn format_fill_diagnostic_lines(
    diagnostics: &[rust_cli_kernel_api::workflow::WorkflowFillDiagnostic],
    fill_file: Option<&str>,
    draft_file: Option<&str>,
) -> Vec<String> {
    diagnostics
        .iter()
        .map(|diagnostic| {
            let anchor = if diagnostic.in_fill { fill_file } else { draft_file };
            let reference = format!("L{}:C{}", diagnostic.line, diagnostic.column);
            match anchor {
                Some(anchor) => format!("{anchor}:{reference} {}", diagnostic.message),
                None => format!("{reference} {}", diagnostic.message),
            }
        })
        .collect()
}

/// 编译失败的整段回话（Node compileFailureResponse 逐字）：出路写明，省掉模型那一轮猜。
/// `fill_file` 是 `(模型面写法, 是否本次内联刚铸的 draft)`——lead 按来源分句（「saved at」对
/// 「The fill file is」），写不成时缺席。
fn compile_failure_text(
    run_id: &str,
    hole_id: &str,
    diagnostics: &[rust_cli_kernel_api::workflow::WorkflowFillDiagnostic],
    fill_file: Option<(&str, bool)>,
    draft_file: Option<&str>,
) -> String {
    let lead = match fill_file {
        None => "The fill could not be saved to a file; fix the body below and resubmit it inline."
            .to_owned(),
        Some((path, true)) => format!(
            "The fill is saved at {path}. Edit that file in place and resubmit with `path`; do not \
paste it inline again."
        ),
        Some((path, false)) => {
            format!("The fill file is {path}. Edit that file in place and resubmit with `path`.")
        }
    };
    let outside_fill = diagnostics.iter().any(|diagnostic| !diagnostic.in_fill);
    let recorded_script_note = outside_fill.then(|| {
        format!(
            "The lines outside the fill are in the run's recorded script{}: this tool cannot \
change them, and editing the draft on disk does not change what the fill is compiled into. Fix \
them with AmendWorkflow (pass the corrected script, or its `path`); the revised run will reach \
the hole and ask again.",
            draft_file
                .map(|file| format!(" ({file} as the run launched it)"))
                .unwrap_or_default()
        )
    });
    [
        Some(lead),
        Some("The effective script does not compile:".to_owned()),
        Some(format_fill_diagnostic_lines(diagnostics, fill_file.map(|(path, _)| path), draft_file).join("\n")),
        recorded_script_note,
        Some(String::new()),
        Some(format!(
            "NOTE: Nothing was spliced or journaled — hole {hole_id} of run {run_id} is still \
waiting for its body."
        )),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n")
}

/// 名字 → 文件名主干（Node `workflowDraftSlug` 同一条规则）：空白连成 `-`，字母数字与 `_ . -`
/// 之外的一概丢掉，按码点截到 64；什么都不剩、或只剩点时用兜底词。
pub(crate) fn workflow_draft_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in name.trim().chars() {
        if ch.is_whitespace() {
            pending_dash = !slug.is_empty();
            continue;
        }
        if pending_dash {
            slug.push('-');
            pending_dash = false;
        }
        if ch.is_alphanumeric() || matches!(ch, '_' | '.' | '-') {
            slug.push(ch);
        }
    }
    let cut: String = slug.chars().take(64).collect();
    let stripped = cut.trim_matches(|c| c == '.' || c == '-');
    if stripped.is_empty() || stripped.chars().all(|c| c == '.') {
        return "workflow".to_owned();
    }
    stripped.to_owned()
}

/// 脚本文件的模型面写法（Node `describeWorkflowScriptPath` 同一条规则）：工作目录之下给工作区
/// 相对路径（POSIX 形状的两端用 `/` 相对化；Windows 同盘符才相对化，分隔符统一 `/`），否则原样
/// 给绝对路径——目录外的兄弟路径、跨盘符与空结果都退回绝对路径。
pub(crate) fn describe_workflow_script_path(absolute: &str, cwd: &str) -> String {
    if cwd.is_empty() {
        return absolute.to_owned();
    }
    let posix_like = |value: &str| value.starts_with('/') && !value.contains('\\');
    if posix_like(cwd) && posix_like(absolute) {
        if let Some(relative) = relative_parts(cwd.split('/'), absolute.split('/')) {
            return relative;
        }
        return absolute.to_owned();
    }
    let split_drive = |value: &str| -> Option<(String, String)> {
        let bytes = value.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            Some((value[..2].to_ascii_lowercase(), value[2..].to_owned()))
        } else {
            None
        }
    };
    if let (Some((drive_cwd, rest_cwd)), Some((drive_abs, rest_abs))) =
        (split_drive(cwd), split_drive(absolute))
        && drive_cwd == drive_abs
    {
        let normalize = |value: &str| value.replace('\\', "/");
        let rest_cwd = normalize(&rest_cwd);
        let rest_abs = normalize(&rest_abs);
        if let Some(relative) = relative_parts(rest_cwd.split('/'), rest_abs.split('/')) {
            return relative;
        }
    }
    absolute.to_owned()
}

/// 共同前缀相对化（`path.relative` 在本工具用到的子集）：不同根、空结果或 `..` 起头的一律
/// `None`（调用方退回绝对路径，与 Node 的守卫同一条）。
fn relative_parts<'a>(
    cwd: impl Iterator<Item = &'a str>,
    absolute: impl Iterator<Item = &'a str>,
) -> Option<String> {
    let cwd: Vec<&str> = cwd.filter(|part| !part.is_empty()).collect();
    let absolute: Vec<&str> = absolute.filter(|part| !part.is_empty()).collect();
    let mut common = 0usize;
    while common < cwd.len() && common < absolute.len() && cwd[common] == absolute[common] {
        common += 1;
    }
    if common == 0 {
        return None;
    }
    let mut parts: Vec<&str> = vec![".."; cwd.len() - common];
    parts.extend(absolute[common..].iter().copied());
    if parts.is_empty() || parts.first() == Some(&"..") {
        return None;
    }
    Some(parts.join("/"))
}

/// 确认前的等待判定（Node findWaitingHole 同一棵树，逐条文案）。返回 `Some` 即拒绝。
fn waiting_check(
    target: &rust_cli_kernel_api::workflow::WorkflowFillTarget,
    run_id: &str,
    hole_id: &str,
) -> Option<String> {
    if target.status == "stopped" {
        return Some(not_waiting_text(&format!(
            "run {run_id} is stopped ({}), so nothing is waiting at {hole_id}. Continue it with \
ResumeWorkflowRun first; the hole will ask again once the script reaches it.",
            target.stop_reason.as_deref().unwrap_or("unknown reason")
        )));
    }
    if target.status == "completed" || target.status == "errored" {
        return Some(not_waiting_text(&format!(
            "run {run_id} has already {}, so nothing is waiting at {hole_id}.",
            target.status
        )));
    }
    let entry = target.holes.iter().find(|hole| hole.site_id == hole_id);
    let Some(entry) = entry else {
        return Some(not_waiting_text(&format!(
            "run {run_id} is not waiting at {hole_id}: no hole with that id has been reached \
(unknown id, or the script has not got there yet). GetWorkflowRun lists the holes it is waiting \
at."
        )));
    };
    if !entry.waiting {
        return Some(not_waiting_text(&format!(
            "hole {hole_id} (\"{}\") of run {run_id} is already filled; the branch has resumed \
with that body. To change what it does, edit the run's draft and use AmendWorkflow.",
            entry.name
        )));
    }
    None
}

/// 确认窗预览与技能门属于 UI 轨（路线 C 没有宿主面），权限面先放行：
/// Node 的 owner 规则对本会话自己的 run 也在 always-ask 分支里放行，探针与灰度走的就是这一条。
#[async_trait]
impl Tool for FillWorkflowHoleTool {
    fn name(&self) -> &str {
        FILL_WORKFLOW_HOLE_TOOL
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "run_id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "ID of the run that is waiting at the hole (from the hole notification).",
                },
                "hole_id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "The hole's site id from the notification or from GetWorkflowRun's holes, e.g. `hole#21b40fca`.",
                },
                "script": {
                    "type": "string",
                    "minLength": 1,
                    "description": "The body: only the statements of the hole's function, inline. This OR `path`, never both. It is compiled where the hole stands and sees every binding declared before it; it must return the hole's type.",
                },
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "A file holding those statements — usually the fill file named by a rejected attempt, edited in place. This OR `script`, never both.",
                },
            },
            "required": ["run_id", "hole_id"],
            "additionalProperties": false,
        })
    }

    fn description(&self, _context: &PromptContext) -> String {
        DESCRIPTION.to_owned()
    }

    fn should_defer(&self) -> bool {
        true
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(MODEL_BYTES)
    }

    fn search_hint(&self) -> Option<&str> {
        Some("supply the body of a hole a running dynamic-workflow run is waiting at")
    }

    async fn validate_input(&self, input: &Value, _context: &ToolUseContext) -> Validation {
        let script = input.get("script").and_then(Value::as_str);
        let path = input.get("path").and_then(Value::as_str);
        let sources = usize::from(script.is_some()) + usize::from(path.is_some());
        if sources == 1 {
            return Validation::Ok;
        }
        // 两个都不给也是违规——没有可沿用的函数体（schema 的 minLength 不设防绕过归一化的调用方）。
        Validation::Invalid {
            message: SOURCE_ERROR.to_owned(),
            error_code: Some(400),
        }
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> rust_cli_kernel_api::permission::PermissionDecision {
        rust_cli_kernel_api::permission::PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let run_id = input
            .get("run_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        let hole_id = input
            .get("hole_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        if run_id.is_empty() {
            return Err(ToolError::InvalidInput {
                message: "`run_id` must be a non-empty string".to_owned(),
            });
        }
        if hole_id.is_empty() {
            return Err(ToolError::InvalidInput {
                message: "`hole_id` must be a non-empty string".to_owned(),
            });
        }
        let script = input.get("script").and_then(Value::as_str);
        let path = input.get("path").and_then(Value::as_str);
        let sources = usize::from(script.is_some()) + usize::from(path.is_some());
        if sources != 1 {
            return Err(ToolError::InvalidInput {
                message: SOURCE_ERROR.to_owned(),
            });
        }
        let Some(engine) = self.engine() else {
            return Ok(failed_output(&fill_unavailable_text(), "fill_unavailable", 31));
        };
        let cwd = context.workspace.root.as_str().to_owned();

        // 两条来源归一成同一份函数体字节：`path` 逐字节读（不剥任何元数据块：fill 文件装的就是
        // 语句本身），读不出来点名文件。
        let body = match path {
            Some(path) => {
                let absolute = resolve_script_path(&cwd, path);
                let described = describe_workflow_script_path(&absolute, &cwd);
                let read = context
                    .machine
                    .files()
                    .read_file(
                        &context.workspace,
                        ReadFile {
                            path: EnvPath::new(absolute.clone()),
                        },
                    )
                    .await;
                match read {
                    Ok(content) => {
                        let text = String::from_utf8_lossy(&content.bytes).into_owned();
                        if text.is_empty() {
                            return Ok(failed_output(
                                &fill_file_unreadable_text(&format!("{described} is empty")),
                                "fill_file",
                                34,
                            ));
                        }
                        (text, Some((absolute, described)))
                    }
                    Err(error) => {
                        return Ok(failed_output(
                            &fill_file_unreadable_text(&format!(
                                "{described} could not be read: {error}"
                            )),
                            "fill_file",
                            34,
                        ));
                    }
                }
            }
            None => (script.unwrap_or_default().to_owned(), None),
        };

        // 确认前的一切（Node resolveInput 的端口读）：run 在不在、留白在不在等。
        let target = match engine.fill_target(&run_id).await {
            Ok(target) => target,
            Err(error) if error.reason == "run_not_found" => {
                return Ok(failed_output(&run_not_found_text(&run_id), "run_not_found", 1));
            }
            Err(error) => {
                let message = error
                    .message
                    .unwrap_or_else(|| "the run could not be read".to_owned());
                return Ok(failed_output(&message, "start_failed", 1));
            }
        };
        if let Some(refusal) = waiting_check(&target, &run_id, &hole_id) {
            return Ok(failed_output(&refusal, "hole_not_waiting", 32));
        }
        let entry = target
            .holes
            .iter()
            .find(|hole| hole.site_id == hole_id)
            .cloned();

        // 「一个 `path` 的字节等于上一次被拒的那份」是忘了编辑，在调引擎之前抓住。
        if path.is_some()
            && let Some(rejected) = self.rejected_body(context.session.as_str(), &run_id, &hole_id)
            && rejected == body.0
        {
            let described = body
                .1
                .as_ref()
                .map(|(_, described)| described.clone())
                .unwrap_or_else(|| path.unwrap_or_default().to_owned());
            return Ok(failed_output(
                &unchanged_fill_text(&described, &run_id, &hole_id),
                "fill_unchanged",
                33,
            ));
        }

        // 内联函数体**先**落盘，再读编译结果（docs/dynamic-workflow/launch.md「The fill file」）：
        // 编不过的函数体走不到别处，这里是它唯一必经的地方。`path` 提交什么都不铸——那个文件
        // 已经是工作副本。
        let hole_name = entry
            .as_ref()
            .map(|hole| hole.name.clone())
            .unwrap_or_else(|| hole_id.clone());
        let fill_file: Option<(String, String)> = if path.is_some() {
            body.1.clone()
        } else {
            match self.write_fill_file(&target, &hole_name, &body.0, &cwd, &context).await {
                Some(absolute) => {
                    let described = describe_workflow_script_path(&absolute, &cwd);
                    Some((absolute, described))
                }
                None => None,
            }
        };
        let fill_described = fill_file.as_ref().map(|(_, described)| described.clone());
        let draft_file = target.draft_path.as_deref().map(|draft| {
            let described = describe_workflow_script_path(draft, &cwd);
            (draft.to_owned(), described)
        });

        let outcome = engine
            .fill_hole(&context.session, &run_id, &hole_id, &body.0)
            .await;
        match outcome {
            Ok(WorkflowFillOutcome::Filled {
                phases_added,
                script_path,
                ..
            }) => {
                let phases = if phases_added.is_empty() {
                    "It added no phases.".to_owned()
                } else {
                    format!(
                        "It added the phase{} {}.",
                        if phases_added.len() == 1 { "" } else { "s" },
                        phases_added.join(", ")
                    )
                };
                let draft = match &script_path {
                    None => "The run has no draft file, so a later revision must pass the whole \
script to AmendWorkflow."
                        .to_owned(),
                    Some(path) => format!(
                        "The run's draft {} now holds the effective script: edit that file and \
pass `path` to AmendWorkflow for any later revision.",
                        describe_workflow_script_path(path, &cwd)
                    ),
                };
                let response = format!(
                    "The fill joined run {run_id} at hole \"{hole_name}\" ({hole_id}); the branch \
parked there has resumed and the run keeps going in the background. {phases} {draft} Do not \
wait for the run or poll it with TaskOutput; you will be notified when it completes."
                );
                let mut fill = json!({
                    "siteId": hole_id,
                    "name": hole_name,
                });
                if let Some(draft) = &target.draft_path {
                    fill["draftPath"] = json!(draft);
                }
                if let Some(line) = entry.as_ref().and_then(|hole| hole.line) {
                    fill["line"] = json!(line);
                }
                Ok(ToolOutput {
                    content: vec![rust_cli_kernel_api::message::ToolResultContent::Text {
                        text: response.clone(),
                    }],
                    is_error: false,
                    display: json!({
                        "ok": true,
                        "fill": fill,
                        "diagnostics": [],
                        "response": response,
                    }),
                })
            }
            Ok(WorkflowFillOutcome::Refused {
                reason,
                message,
                diagnostics,
            }) => {
                if reason == "compile_failed" {
                    // 记下这份被拒的字节：同一份再经 `path` 交回来就是忘了编辑（`fill_unchanged`）。
                    self.remember_rejected(
                        context.session.as_str(),
                        &run_id,
                        &hole_id,
                        &body.0,
                    );
                    let response = compile_failure_text(
                        &run_id,
                        &hole_id,
                        &diagnostics,
                        // 内联提交刚写下的（「saved at」）或模型自己给的（「The fill file is」）。
                        fill_described
                            .as_deref()
                            .map(|described| (described, path.is_none())),
                        draft_file.as_ref().map(|(_, described)| described.as_str()),
                    );
                    let mut fill = json!({
                        "siteId": hole_id,
                        "name": hole_name,
                    });
                    if let Some(draft) = &target.draft_path {
                        fill["draftPath"] = json!(draft);
                    }
                    if let Some(line) = entry.as_ref().and_then(|hole| hole.line) {
                        fill["line"] = json!(line);
                    }
                    return Ok(ToolOutput {
                        content: vec![rust_cli_kernel_api::message::ToolResultContent::Text {
                            text: response.clone(),
                        }],
                        is_error: false,
                        display: json!({
                            "ok": false,
                            "fill": fill,
                            "diagnostics": diagnostics
                                .iter()
                                .map(|diagnostic| {
                                    json!({
                                        "code": diagnostic.code,
                                        "column": diagnostic.column,
                                        "line": diagnostic.line,
                                        "message": diagnostic.message,
                                    })
                                })
                                .collect::<Vec<_>>(),
                            "response": response,
                        }),
                    });
                }
                Ok(failed_output(
                    &refusal_text(&reason, &message, &run_id),
                    &reason,
                    match reason.as_str() {
                        "run_not_found" => 1,
                        "fill_ids_unstable" => 35,
                        _ => 32,
                    },
                ))
            }
            Err(error) => {
                let message = error
                    .message
                    .unwrap_or_else(|| "the fill could not be applied".to_owned());
                Ok(failed_output(&message, &error.reason, 1))
            }
        }
    }
}

impl FillWorkflowHoleTool {
    /// 内联函数体的 fill 文件：`<run-slug>.<hole-slug>.dwf.ts`，同名顺延 `-2`、`-3`…
    /// 一次内联重提铸新文件，绝不在模型背后覆盖。写不成回 `None`（尽力而为，与草稿同规）。
    async fn write_fill_file(
        &self,
        target: &rust_cli_kernel_api::workflow::WorkflowFillTarget,
        hole_name: &str,
        body: &str,
        cwd: &str,
        context: &ToolUseContext,
    ) -> Option<String> {
        let run_slug = match &target.draft_path {
            Some(draft) => {
                let name = Path::new(draft)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned();
                match name.strip_suffix(".dwf.ts") {
                    Some(stem) => stem.to_owned(),
                    None => name,
                }
            }
            None => workflow_draft_slug(target.name.as_deref().unwrap_or("workflow")),
        };
        let hole_slug = workflow_draft_slug(hole_name);
        if hole_slug.is_empty() {
            return None;
        }
        let dir = format!("{}/.nibi/workflow-drafts", cwd.trim_end_matches(['/', '\\']));
        let bytes = body.as_bytes().to_vec();
        for attempt in 1..=1_000u32 {
            let file_name = if attempt == 1 {
                format!("{run_slug}.{hole_slug}.dwf.ts")
            } else {
                format!("{run_slug}.{hole_slug}-{attempt}.dwf.ts")
            };
            let candidate = format!("{dir}/{file_name}");
            let written = context
                .machine
                .files()
                .put_file(
                    &context.workspace,
                    context.operation.clone(),
                    PutFile {
                        path: EnvPath::new(candidate.clone()),
                        bytes: bytes.clone(),
                        precondition: WritePrecondition::Absent,
                        create_parents: true,
                    },
                )
                .await;
            match written {
                Ok(_) => return Some(candidate),
                Err(rust_cli_kernel_api::env::EnvError::PreconditionFailed { .. }) => continue,
                Err(_) => return None,
            }
        }
        None
    }
}

/// 失败的工具结果（文本判别键在 message 前缀；数值只是 Node 码表里的日志位）。
fn failed_output(text: &str, reason: &str, code: u32) -> ToolOutput {
    ToolOutput {
        content: vec![rust_cli_kernel_api::message::ToolResultContent::Text {
            text: text.to_owned(),
        }],
        is_error: true,
        display: json!({"ok": false, "reason": reason, "errorCode": code}),
    }
}

/// `path` 相对工作目录解析（相对与绝对都收；Windows 盘符也算绝对）。
fn resolve_script_path(cwd: &str, path: &str) -> String {
    let absolute = std::path::Path::new(path).is_absolute()
        || (path.len() > 2 && path.as_bytes()[1] == b':');
    if absolute {
        path.to_owned()
    } else {
        format!(
            "{}/{}",
            cwd.trim_end_matches(['/', '\\']),
            path.replace('\\', "/")
        )
    }
}

#[cfg(test)]
#[path = "fill_workflow_hole_tests.rs"]
mod tests;

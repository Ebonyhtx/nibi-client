//! `GetWorkflowRun` 工具（Node `get-workflow-run.ts` 的路线 C 读面）：单 run 的自适应详情——
//! 进度摘要 + 身份 + 待答问题 + 留白 + 健康/阶段/花名册 + log 尾巴 + 用量 + 收场 + 路由。
//! 数据源是 journal（`SessionStore::workflow_run_detail`）并上停驻注册表的活项
//! （`WorkflowRunIntrospection` 端口，运行时合成）。
//!
//! 刻意**不做** wait/block 语义：等待是 TaskOutput 的活，这里是即时快照。

use std::sync::Arc;

use nibi_kernel_api::clock::Clock;
use nibi_kernel_api::message::ToolResultContent;
use nibi_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext,
};
use nibi_kernel_api::workflow::{
    WorkflowRunArtifact, WorkflowRunDetail, WorkflowRunIntrospection, WorkflowRunSubagentAsk,
    WorkflowRunSubagentView,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// 工具名（与 Node 的 `GET_WORKFLOW_RUN_TOOL_NAME` 逐字相同）。
pub const GET_WORKFLOW_RUN_TOOL: &str = "GetWorkflowRun";

const DESCRIPTION: &str = "Returns the current state of one dynamic-workflow run: progress, token usage and the tail of its log() narration while it runs; the final result once it completed; the structured failure if it errored or was stopped.\n\
\n\
Runs this session starts settle on their own: you receive a completion notification carrying the final output. Do NOT poll this tool while waiting for one — continue with other work.\n\
Reach for it when: (a) the user asks how a workflow is going, (b) you want to review this project's earlier runs, including ones other sessions started, (c) a completion notification was truncated and you need the run's full record by ID.\n\
\n\
- Takes run_id — from CreateWorkflow's or AmendWorkflow's result, from a completion notification, or from ListWorkflowRuns.\n\
- This is an instant snapshot and never waits. To block until a run THIS session started finishes, use TaskOutput instead: that is the waiting tool. GetWorkflowRun is the right tool when you must not wait, or when the run belongs to another session (TaskOutput cannot see those).\n\
- The `artifacts` section lists what the run published for the user — files, documents and live dashboards that are ALREADY shown to them as cards. Refer to one by its title; do not paste its contents back. The one marked `primary` is the deliverable: point the user to it first.\n\
- Three terminal states: `completed`; `errored` (the script itself failed — not resumable, amend it); `stopped` with a stop reason — `user` (cancelled on purpose: resume only when the user asks), `model` (your own TaskStop), `provider` (a provider-side error such as an expired sign-in, a model missing from the plan or a quota cap — the `<error>` block names the cause and the fix; resolve it with the user, then resume), `interrupted` (the process that owned the run exited — continuing it is usually what the user wants), `superseded` (an AmendWorkflow replaced it; `<superseded_by>` names the successor — read that run instead, never resume this one).\n\
- A stopped run (other than a superseded one) can be continued with ResumeWorkflowRun — no rebuild needed, same run ID, same script.\n\
- ANY run — completed, stopped, errored, or still running — can instead be revised with AmendWorkflow: pass its run ID and the corrected script, and the finished work is imported as cache. When the script itself errored, that is the move — fix the script and keep the work that already succeeded, rather than rewriting from scratch.";

/// 停驻问题的引导句（Node `PENDING_QUESTIONS_INSTRUCTION` 逐字）：合成读面恒知道停驻表，
/// 所以「查不到」的那一句（Node `PENDING_QUESTIONS_UNKNOWN`）在本读面上不可达，不收。
const PENDING_QUESTIONS_INSTRUCTION: &str = "Each of these subagents is parked waiting for an answer and nothing times out on its behalf. Answer one with ResolveWorkflowQuestion using the ID in brackets. The rest of the run keeps running meanwhile.";

/// 留白块的引导句（Node `holeBlocks` 逐字）：有在等的与全补完的两支。
const HOLES_WAITING_INSTRUCTION_PREFIX: &str = "Each waiting hole parks one branch of the script until you supply its body, and nothing times out on its behalf. Read the run's draft for context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id=\"";
const HOLES_WAITING_INSTRUCTION_SUFFIX: &str = "\" and the hole id in brackets as hole_id. The rest of the run keeps running meanwhile.";
const HOLES_ALL_FILLED_INSTRUCTION: &str = "Every hole above has been filled; its body is part of the run's script now (see <amendable> to change it).";

/// 能力缺席的业务失败（逐字同 Node：静默回空会让模型把「没跑过 workflow」和「读不到」混成同一结论）。
const INTROSPECTION_UNAVAILABLE: &str = "workflow_introspection_unavailable: this session cannot read workflow runs — workflow execution is not available here, so no run history is reachable. This is a capability gap, not an empty project.";

/// 摘要的字符上界；超出时整句整句地丢，实在丢不动才硬切——省略号留一个字符。
const SUMMARY_MAX_CHARS: usize = 400;
const SUMMARY_ELLIPSIS: &str = "…";

/// 终态三词：run 已经没有下一步动作了（与摘要侧同集）。
fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "errored" | "stopped")
}

pub struct GetWorkflowRunTool {
    introspection: Arc<dyn WorkflowRunIntrospection>,
    clock: Arc<dyn Clock>,
}

impl GetWorkflowRunTool {
    pub fn new(
        introspection: Arc<dyn WorkflowRunIntrospection>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            introspection,
            clock,
        }
    }
}

#[async_trait::async_trait]
impl Tool for GetWorkflowRunTool {
    fn name(&self) -> &str {
        GET_WORKFLOW_RUN_TOOL
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "run_id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "The workflow run ID to inspect (as returned by CreateWorkflow or ListWorkflowRuns)",
                },
            },
            "required": ["run_id"],
            "additionalProperties": false,
        })
    }

    fn description(&self, _context: &PromptContext) -> String {
        DESCRIPTION.to_owned()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("inspect one dynamic-workflow run's progress, result or failure")
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> nibi_kernel_api::permission::PermissionDecision {
        nibi_kernel_api::permission::PermissionDecision::Allow {
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
        if run_id.is_empty() {
            return Err(ToolError::InvalidInput {
                message: "`run_id` must be a non-empty string".to_owned(),
            });
        }
        let detail = match self.introspection.run_detail(&context.session, &run_id).await {
            Ok(detail) => detail,
            Err(nibi_kernel_api::store::StoreError::Unsupported { .. }) => {
                return Ok(unavailable_output());
            }
            Err(error) => {
                return Err(ToolError::InvalidInput {
                    message: format!("the run journal could not be read: {error}"),
                });
            }
        };
        let Some(detail) = detail else {
            return Ok(ToolOutput {
                content: vec![ToolResultContent::Text {
                    text: format!(
                        "run_not_found: no workflow run with ID {run_id} exists for this project. \
Use ListWorkflowRuns to see the runs that do."
                    ),
                }],
                is_error: true,
                display: json!({"ok": false, "reason": "run_not_found", "runId": run_id}),
            });
        };
        Ok(ToolOutput {
            content: vec![ToolResultContent::Text {
                text: format_model_content(&detail, self.clock.now_ms()),
            }],
            is_error: false,
            display: json!({
                "ok": true,
                "runId": detail.run_id,
                "status": detail.status,
                "possiblyInterrupted": detail.possibly_interrupted.then_some(true),
            }),
        })
    }
}

fn unavailable_output() -> ToolOutput {
    ToolOutput {
        content: vec![ToolResultContent::Text {
            text: INTROSPECTION_UNAVAILABLE.to_owned(),
        }],
        is_error: true,
        display: json!({"ok": false, "reason": "workflow_introspection_unavailable"}),
    }
}

/// 块序是契约（Node `formatGetWorkflowRunModelContent`，同一顺序的子集）：先一句话说清处境，
/// 再是身份与生命周期，再是**此刻等着模型做的事**（停驻的问题），然后是叙事、用量与收场路由。
fn format_model_content(detail: &WorkflowRunDetail, now: u64) -> String {
    let summary = build_summary(detail, now);
    let terminal = is_terminal(&detail.status);
    let mut blocks = vec![
        format!("<summary>{}</summary>", escape(&summary)),
        format!("<run_id>{}</run_id>", escape(&detail.run_id)),
        format!(
            "<label source=\"{}\">{}</label>",
            detail.label_source,
            escape(&detail.label)
        ),
        format!("<status>{}</status>", escape(&detail.status)),
    ];
    if let Some(reason) = &detail.stop_reason {
        blocks.push(format!("<stop_reason>{}</stop_reason>", escape(reason)));
    }
    if let Some(resumed) = &detail.resumed_from {
        blocks.push(format!("<resumed_from>{}</resumed_from>", escape(resumed)));
    }
    if let Some(bound) = &detail.max_concurrency {
        blocks.push(format!("<max_concurrency>{bound}</max_concurrency>"));
    }
    if let Some(model) = &detail.subagent_model {
        blocks.push(format!("<subagent_model>{}</subagent_model>", escape(model)));
    }
    if let Some(bindings) = &detail.model_bindings
        && let Some(object) = bindings.as_object()
        && !object.is_empty()
    {
        let rows = object
            .iter()
            .map(|(name, canonical)| {
                format!(
                    "\"{}\" = {}",
                    escape(name),
                    escape(canonical.as_str().unwrap_or_default())
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        blocks.push(format!("<script_models>\n{rows}\n</script_models>"));
    }
    if let Some(superseded) = &detail.superseded_by {
        blocks.push(format!(
            "<superseded_by>{}</superseded_by>",
            escape(superseded)
        ));
    }
    blocks.push(format!(
        "<owned_by_this_session>{}</owned_by_this_session>",
        detail.owned_by_this_session
    ));
    if detail.possibly_interrupted {
        // Node `get-workflow-run-format.ts` 的同一句（评估为「注解，不是判决」）。
        blocks.push(
            "<possibly_interrupted>true — this session cannot confirm the run is still alive</possibly_interrupted>"
                .to_owned(),
        );
    }
    blocks.push(format!(
        "<created_at>{}</created_at>",
        format_instant(now, detail.created_at)
    ));
    blocks.push(format!(
        "<updated_at>{}</updated_at>",
        format_instant(now, detail.updated_at)
    ));
    blocks.extend(pending_question_blocks(detail, now));
    blocks.extend(hole_blocks(detail, now));
    blocks.push(health_block(detail, now, terminal));
    blocks.extend(phases_block(detail, now, terminal));
    blocks.push(subagents_block(detail, now));
    // 叙事尾巴（Node `formatWorkflowRunLogTailBlock` 逐字）：块恒在场；事件带落库时刻时前缀
    // 年龄，老 journal 上没有这一列的行只有序号。空段（= 不知道的事实）直接消失，不留下
    // 两个连着的间隔；行尾 trim 掉最后一列的补白。
    let log_lines = detail
        .log_tail
        .iter()
        .map(|entry| {
            let cells = [
                format!("[{}]", entry.sequence),
                entry
                    .at
                    .and_then(|at| format_relative_age(now, Some(at)))
                    .unwrap_or_default(),
                escape(&entry.message),
            ];
            cells
                .into_iter()
                .filter(|cell| !cell.is_empty())
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>();
    blocks.push(if log_lines.is_empty() {
        "<log_tail>No log() narration recorded yet.</log_tail>".to_owned()
    } else {
        format!("<log_tail>\n{}\n</log_tail>", log_lines.join("\n"))
    });
    blocks.push(format!(
        "<usage>spent_tokens={} nodes_observed={} nodes_running={} nodes_completed={} nodes_failed={}</usage>",
        detail.spent_tokens,
        detail.nodes.observed,
        detail.nodes.running,
        detail.nodes.completed,
        detail.nodes.failed
    ));
    if let Some(result) = &detail.result_text {
        // 产物原样进块（不转义）：它可能是一整段 JSON 或代码，转义会让模型读到的与真实产物不同。
        blocks.push(format!("<result>\n{result}\n</result>"));
    }
    if let Some(error) = &detail.error {
        blocks.push(format!(
            "<error code=\"{}\">{}</error>",
            escape(&error.code),
            escape(&error.message)
        ));
    }
    if let Some(artifacts) = &detail.artifacts
        && !artifacts.is_empty()
    {
        // 用户面产物排在 result / error 之后（同完成通知的顺序）：行的格式与完成通知逐字
        // 共用一个格式器（Node `formatPublishedArtifactLine`）。
        let lines = artifacts
            .iter()
            .map(|artifact| escape(&artifact_line(artifact)))
            .collect::<Vec<_>>()
            .join("\n");
        blocks.push(format!(
            "<artifacts count=\"{}\">\n{lines}\n</artifacts>",
            artifacts.len()
        ));
    }
    blocks.extend(routing_blocks(detail));
    blocks.join("\n\n")
}

/// `- report (markdown, primary, v2, …): Title`（Node `formatPublishedArtifactLine` 逐字）。
fn artifact_line(artifact: &WorkflowRunArtifact) -> String {
    let mut parts: Vec<String> = Vec::new();
    if artifact.primary == Some(true) {
        parts.push(artifact.kind.clone());
        parts.push("primary".to_owned());
    } else {
        parts.push(artifact.kind.clone());
    }
    parts.push(format!("v{}", artifact.version));
    if let Some(content_type) = &artifact.content_type
        && !content_type.is_empty()
    {
        parts.push(content_type.clone());
    }
    let preset = matches!(artifact.kind.as_str(), "chart" | "table" | "metrics" | "board");
    if preset {
        parts.push(format!(
            "{} item{}",
            artifact.item_count,
            if artifact.item_count == 1 { "" } else { "s" }
        ));
    } else if let Some(bytes) = artifact.bytes {
        parts.push(format!("{bytes} bytes"));
    }
    let head = format!("- {} ({})", artifact.id, parts.join(", "));
    match artifact.title.as_deref().map(str::trim) {
        Some(title) if !title.is_empty() => format!("{head}: {title}"),
        _ => head,
    }
}

/// 留白块（Node `holeBlocks` 逐字）：紧随停驻的问题——同一种「此刻等着模型做的事」。
fn hole_blocks(detail: &WorkflowRunDetail, now: u64) -> Vec<String> {
    let Some(holes) = &detail.holes else {
        return Vec::new();
    };
    if holes.is_empty() {
        return Vec::new();
    }
    let lines = holes
        .iter()
        .map(|hole| {
            let head = format!(
                "[{}] \"{}\": {}",
                escape(&hole.site_id),
                escape(&hole.name),
                escape(&hole.hole_type)
            );
            if hole.state == "waiting" {
                let age = format_relative_age(now, hole.since)
                    .map_or_else(String::new, |age| format!(" — waiting {}", age.replace(" ago", "")));
                return format!("{head}{age}");
            }
            let age = hole
                .filled_at
                .and_then(|at| format_relative_age(now, Some(at)))
                .map_or_else(String::new, |age| format!(" — filled {age}"));
            let by = hole
                .filled_by
                .as_deref()
                .map_or_else(String::new, |by| format!(" by {}", escape(by)));
            format!("{head}{age}{by}")
        })
        .collect::<Vec<_>>();
    let waiting = holes.iter().filter(|hole| hole.state == "waiting").count();
    let instruction = if waiting == 0 {
        HOLES_ALL_FILLED_INSTRUCTION.to_owned()
    } else {
        format!(
            "{HOLES_WAITING_INSTRUCTION_PREFIX}{}{HOLES_WAITING_INSTRUCTION_SUFFIX}",
            escape(&detail.run_id)
        )
    };
    vec![format!("<holes>\n{}\n\n{instruction}\n</holes>", lines.join("\n"))]
}

/// `<health>`（Node `formatWorkflowRunHealthBlock` 逐字）：一行 key=value；终态 run 带遗留说明。
fn health_block(detail: &WorkflowRunDetail, now: u64, terminal: bool) -> String {
    let health = &detail.health;
    let mut cells: Vec<String> = Vec::new();
    if let Some(age) = format_relative_age(now, health.last_progress_at) {
        cells.push(format!("last_progress={age}"));
    }
    if let Some(concurrency) = &health.concurrency {
        let why = [
            concurrency.reason.as_deref().map(escape),
            concurrency
                .since
                .and_then(|since| format_relative_age(now, Some(since)))
                .map(|age| format!("since {age}")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
        cells.push(format!(
            "concurrency={}/{}{}",
            concurrency.effective,
            concurrency.cap,
            if why.is_empty() { String::new() } else { format!(" ({why})") }
        ));
    }
    if !terminal {
        let stalled = match format_relative_age(now, health.stalled_since) {
            Some(age) => format!("since {age}"),
            None => "no".to_owned(),
        };
        cells.push(format!("stalled={stalled}"));
    }
    cells.push(format!("consecutive_failures={}", health.consecutive_failures));
    cells.push(format!("cached_steps={}", health.cached_steps));
    let note = match (terminal, health.leftover_running) {
        (true, Some(leftover)) if leftover > 0 => format!(
            "\nThe {leftover} \"running\" step{} below {} leftover{} of the exited process, not live work.",
            if leftover == 1 { "" } else { "s" },
            if leftover == 1 { "is a" } else { "are" },
            if leftover == 1 { "" } else { "s" },
        ),
        _ => String::new(),
    };
    format!("<health>{}{note}</health>", cells.join("  "))
}

/// `<phases>`（Node `formatWorkflowRunPhasesBlock` 逐字）：列宽由本次的行算出来（有上界 24）；
/// `ahead` 的行只有名字和状态。
fn phases_block(detail: &WorkflowRunDetail, now: u64, terminal: bool) -> Vec<String> {
    let Some(phases) = &detail.phases else {
        return Vec::new();
    };
    if phases.is_empty() {
        return Vec::new();
    }
    const MAX_COLUMN_WIDTH: usize = 24;
    let width = |values: &[String]| -> usize {
        values
            .iter()
            .map(|value| value.chars().count())
            .max()
            .unwrap_or(0)
            .min(MAX_COLUMN_WIDTH)
    };
    let names: Vec<String> = phases
        .iter()
        .enumerate()
        .map(|(index, phase)| format!("{}. {}", index + 1, escape(&phase.name)))
        .collect();
    let states: Vec<String> = phases.iter().map(|phase| phase.state.clone()).collect();
    let name_width = width(&names);
    let state_width = width(&states);
    let lines = phases
        .iter()
        .enumerate()
        .map(|(index, phase)| {
            let name = pad_column(&names[index], name_width);
            let state = pad_column(&states[index], state_width);
            let rounds = if phase.rounds == 0 {
                String::new()
            } else {
                format!(
                    "{} round{}",
                    phase.rounds,
                    if phase.rounds == 1 { "" } else { "s" }
                )
            };
            let counts = if phase.nodes_running > 0 {
                format!(
                    "{} settled, {} {}",
                    phase.nodes_settled,
                    phase.nodes_running,
                    if terminal { "unfinished" } else { "running" }
                )
            } else if phase.nodes_settled == 0 {
                String::new()
            } else {
                format!(
                    "{} step{} settled",
                    phase.nodes_settled,
                    if phase.nodes_settled == 1 { "" } else { "s" }
                )
            };
            // 没有离开时刻：活着的 run 说「到现在为止」，终态 run 什么也不说——它的离开时刻
            // 无人记录，拿读时的 now 去减等于把「进程死后的这几个小时」算进那个阶段。
            let duration = match (phase.entered_at, phase.exited_at) {
                (_, Some(exited_at)) if phase.entered_at.is_some() => {
                    format_duration(exited_at.saturating_sub(phase.entered_at.unwrap_or(0)))
                }
                (Some(entered_at), None) if !terminal => {
                    format!("{} so far", format_duration(now.saturating_sub(entered_at)))
                }
                _ => String::new(),
            };
            [name, state, rounds, counts, duration]
                .into_iter()
                .filter(|cell| !cell.is_empty())
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>();
    vec![format!("<phases>\n{}\n</phases>", lines.join("\n"))]
}

fn pad_column(value: &str, width: usize) -> String {
    let length = value.chars().count();
    if length >= width {
        value.to_owned()
    } else {
        format!("{value}{}", " ".repeat(width - length))
    }
}

/// `<subagents>`（Node `formatWorkflowRunSubagentsBlock` 逐字）：一行一个子代理 + 缩进的
/// task 行；「正在做什么」按相位分叉。
fn subagents_block(detail: &WorkflowRunDetail, now: u64) -> String {
    if detail.subagents.is_empty() {
        return "<subagents>No subagents created yet.</subagents>".to_owned();
    }
    const MAX_COLUMN_WIDTH: usize = 24;
    const TASK_LINE_INDENT: &str = "  ";
    let width = |values: &[String]| -> usize {
        values
            .iter()
            .map(|value| value.chars().count())
            .max()
            .unwrap_or(0)
            .min(MAX_COLUMN_WIDTH)
    };
    let names: Vec<String> = detail
        .subagents
        .iter()
        .map(|subagent| subagent.name.as_deref().map(escape).unwrap_or_default())
        .collect();
    let addresses: Vec<String> = detail
        .subagents
        .iter()
        .map(|subagent| format!("{}@{}", escape(&subagent.site_id), subagent.ordinal))
        .collect();
    let states: Vec<String> = detail
        .subagents
        .iter()
        .map(|subagent| subagent.state.clone())
        .collect();
    let name_width = width(&names);
    let address_width = width(&addresses);
    let state_width = width(&states);
    let asked_at_by_qid: std::collections::HashMap<&str, u64> = detail
        .pending_questions
        .iter()
        .map(|question| (question.qid.as_str(), question.asked_at))
        .collect();
    let mut lines: Vec<String> = Vec::new();
    detail.subagents.iter().enumerate().for_each(|(index, subagent)| {
        let activity = subagent_activity_cell(subagent, now, &asked_at_by_qid);
        let phase_cell = subagent
            .phase_name
            .as_deref()
            .map_or_else(String::new, |name| format!("phase {}", escape(name)));
        let tokens_cell = if subagent.tokens > 0 {
            format!("{} tokens", format_count(subagent.tokens))
        } else {
            String::new()
        };
        lines.push(
            [
                pad_column(&names[index], name_width),
                pad_column(&addresses[index], address_width),
                pad_column(&states[index], state_width),
                phase_cell,
                activity,
                tokens_cell,
            ]
            .into_iter()
            .filter(|cell| !cell.is_empty())
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_owned(),
        );
        if let Some(head) = subagent
            .current_ask
            .as_ref()
            .and_then(|ask| ask.instructions_head.as_deref())
            .filter(|head| !head.is_empty())
        {
            lines.push(format!("{TASK_LINE_INDENT}task: {}", escape(head)));
        }
    });
    format!("<subagents>\n{}\n</subagents>", lines.join("\n"))
}

/// 「正在做什么」格（Node `subagentActivityCell` 的同一条判定链）。
fn subagent_activity_cell(
    subagent: &WorkflowRunSubagentView,
    now: u64,
    asked_at_by_qid: &std::collections::HashMap<&str, u64>,
) -> String {
    if subagent.state == "parked"
        && let Some(parked_on) = &subagent.parked_on
    {
        let waited = asked_at_by_qid
            .get(parked_on.as_str())
            .and_then(|at| format_relative_age(now, Some(*at)))
            .map_or_else(String::new, |age| format!(" for {}", age.replace(" ago", "")));
        return format!("on question {}{waited}", escape(parked_on));
    }
    if subagent.state == "waiting" {
        return wait_cell(subagent, now);
    }
    if subagent.state == "unfinished"
        && let Some(ask) = &subagent.current_ask
    {
        return format!("{} was in flight at the stop", ask_address(ask));
    }
    if let Some(ask) = &subagent.current_ask {
        return executing_cell(ask, now);
    }
    settled_cell(subagent)
}

fn ask_address(ask: &WorkflowRunSubagentAsk) -> String {
    // actorSeq 是 journal 的 0 基列；模型面按人读的 1 基说「第几步」。
    let step = ask
        .actor_seq
        .map_or_else(String::new, |seq| format!(" (step {})", seq + 1));
    format!("{}@{}{step}", escape(&ask.site_id), ask.ordinal)
}

fn executing_cell(ask: &WorkflowRunSubagentAsk, now: u64) -> String {
    let mut parts = vec![ask_address(ask)];
    if let Some(started_at) = ask.started_at
        && let Some(age) = format_relative_age(now, Some(started_at))
    {
        parts.push(format!("{} on this step", age.replace(" ago", "")));
    }
    if let Some(turn) = ask.turn {
        parts.push(format!("turn {turn}"));
    }
    if let Some(tool_calls) = ask.tool_calls {
        parts.push(format!(
            "{} tool call{}",
            tool_calls,
            if tool_calls == 1 { "" } else { "s" }
        ));
    }
    if let Some(last_tool) = &ask.last_tool {
        let target = last_tool
            .target
            .as_deref()
            .map_or_else(String::new, |target| format!(" {}", escape(target)));
        let age = last_tool
            .at
            .and_then(|at| format_relative_age(now, Some(at)))
            .map_or_else(String::new, |age| format!(" {age}"));
        parts.push(format!(
            "last {}{target}{age}",
            escape(&last_tool.name)
        ));
    }
    parts.join(", ")
}

fn wait_cell(subagent: &WorkflowRunSubagentView, now: u64) -> String {
    let Some(wait) = &subagent.wait else {
        return String::new();
    };
    let waited = wait
        .since
        .and_then(|since| format_relative_age(now, Some(since)))
        .map_or_else(String::new, |age| format!(" for {}", age.replace(" ago", "")));
    if wait.cause == "slot" {
        return format!("waiting for a slot{waited}");
    }
    let after = wait
        .reason
        .as_deref()
        .map_or_else(String::new, |reason| format!(" after {}", escape(reason)));
    let retry = wait
        .retry_after_ms
        .map_or_else(String::new, |ms| format!(", retry in {}", format_duration(ms)));
    format!("backoff{after}{waited}{retry}")
}

fn settled_cell(subagent: &WorkflowRunSubagentView) -> String {
    if subagent.steps_settled == 0 && subagent.steps_failed == 0 {
        return String::new();
    }
    let failed = if subagent.steps_failed > 0 {
        format!(", {} failed", subagent.steps_failed)
    } else {
        String::new()
    };
    format!(
        "{} step{}{failed}",
        subagent.steps_settled,
        if subagent.steps_settled == 1 { "" } else { "s" }
    )
}

/// 停驻中的升级问题，排在用量/收场之前：这一块是**一件此刻等着模型做的事**，埋在叙事后面
/// 等于把唯一的解除阻塞路径藏起来。
fn pending_question_blocks(detail: &WorkflowRunDetail, now: u64) -> Vec<String> {
    if detail.pending_questions.is_empty() {
        return Vec::new();
    }
    let rendered = detail
        .pending_questions
        .iter()
        .map(|question| {
            let who = question.actor_name.as_deref().unwrap_or(&question.actor);
            let asked = format_relative_age(now, Some(question.asked_at))
                .map_or_else(
                    || format!("asked at {}", nibi_kernel_base::js::date::iso_timestamp(question.asked_at)),
                    |age| format!("asked {age}"),
                );
            let mut lines = vec![
                format!("[{}] {} {}", escape(&question.qid), escape(who), asked),
                escape(&question.question),
            ];
            if let Some(context) = &question.context {
                lines.push(format!("context: {}", escape(context)));
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    vec![format!(
        "<pending_questions>\n{rendered}\n\n{PENDING_QUESTIONS_INSTRUCTION}\n</pending_questions>"
    )]
}

/// 路由：被替代 → 只指向后继；否则可恢复与可修订各占一块，各说各的（与 Node 同一套文案）。
fn routing_blocks(detail: &WorkflowRunDetail) -> Vec<String> {
    if detail.stop_reason.as_deref() == Some("superseded") {
        let successor = detail
            .superseded_by
            .as_deref()
            .map_or_else(|| "its successor".to_owned(), |id| format!("run {}", escape(id)));
        return vec![format!(
            "<superseded>This run was stopped by an AmendWorkflow and superseded by {successor}, which owns its unfinished work. Do not resume it (ResumeWorkflowRun will refuse) and do not amend it again; read or amend {successor} instead.</superseded>"
        )];
    }
    let mut blocks = Vec::new();
    // 可恢复终态的判定谓词与 resume 门同语义：`stopped` 不论 reason，绝不放宽到 `errored`。
    if detail.status == "stopped" {
        let reason_sentence = match detail.stop_reason.as_deref() {
            Some("user") => " This run was stopped on purpose by the user: resume it only when the user asks.",
            Some("model") => " You stopped this run yourself with TaskStop: resume it unchanged only if that is what the user wants. If you stopped it to fix the script, do not wait — amend it now, see <amendable>.",
            Some("provider") => " A provider-side error stopped it: resolve the cause named in <error> with the user before resuming, or it will stop again the same way.",
            _ => "",
        };
        blocks.push(format!(
            "<resumable>This run can be continued with ResumeWorkflowRun — it will resume under the same run ID, replaying finished steps and re-dispatching the unfinished ones.{reason_sentence} The script must be byte-for-byte the one this run was started with; to change it, see <amendable>.</resumable>"
        ));
    }
    blocks.push(format_amendable_hint(detail));
    blocks
}

fn format_amendable_hint(detail: &WorkflowRunDetail) -> String {
    let run_id = escape(&detail.run_id);
    let tail = match detail.status.as_str() {
        "errored" => "This is the highest-value case for it: the script itself failed, so fix the script and re-run — every step that already succeeded is imported instead of being paid for a second time. Do NOT rewrite from scratch.",
        "completed" => "Use it to extend or refine a finished workflow — added steps run live, unchanged ones cost nothing.",
        "stopped" => "Use it when the script or a setting needs to change; use ResumeWorkflowRun to continue it unchanged. A run stopped because its script was wrong is amended now, not after the user asks: the cache holds everything that settled before the stop, and waiting buys nothing.",
        _ => "It is still running: if the script is visibly wrong, amend it now — AmendWorkflow stops this run, imports everything that settled so far, and starts the revision in one call. Do not TaskStop it first and do not wait for it to finish.",
    };
    let body = [
        format!("This run can be superseded by a revised script: call AmendWorkflow with `run_id: \"{run_id}\"` and your new script."),
        "That mints a NEW run and imports this one's finished work as a warm cache — matched per named subagent along its conversation prefix — so steps you did not change settle from cache at zero tokens and only the revised part runs live.".to_owned(),
        "To change only its settings (max_concurrency, subagent_model, name), omit both `script` and `path`: the new run keeps this run's script.".to_owned(),
        tail.to_owned(),
    ]
    .join(" ");
    format!("<amendable>{body}</amendable>")
}

/// 情势的一句话（Node `buildWorkflowRunSummary` 的子集：阶段/留白/花名册读面未接的从句整体
/// 不出现）。一条纪律贯穿：**不知道就不说**，绝不用 0 或「unknown」冒充一个事实。
fn build_summary(detail: &WorkflowRunDetail, now: u64) -> String {
    let terminal = is_terminal(&detail.status);
    let mut sentences = vec![
        format!(
            "{}.",
            status_clause(detail, now, terminal)
        ),
        format!("{}.", steps_clause(detail, terminal)),
    ];
    let optional = [
        failure_clause(detail),
        questions_clause(detail),
        ownership_clause(detail),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    sentences.extend(optional);
    while sentences.len() > 2 && sentences.join(" ").chars().count() > SUMMARY_MAX_CHARS {
        sentences.pop();
    }
    let text = sentences.join(" ");
    if text.chars().count() <= SUMMARY_MAX_CHARS {
        return text;
    }
    let mut cut: String = text.chars().take(SUMMARY_MAX_CHARS - SUMMARY_ELLIPSIS.len()).collect();
    cut.push_str(SUMMARY_ELLIPSIS);
    cut
}

/// 状态 + 它已经跑了多久 / 结束了多久。
fn status_clause(detail: &WorkflowRunDetail, now: u64, terminal: bool) -> String {
    let elapsed = format_duration(detail.updated_at.saturating_sub(detail.created_at));
    if !terminal {
        return if detail.status == "pending" {
            "Pending, not dispatched yet".to_owned()
        } else {
            format!("Running for {}", format_duration(now.saturating_sub(detail.created_at)))
        };
    }
    match detail.status.as_str() {
        "completed" => format!("Completed in {elapsed}"),
        "errored" => format!("Errored after {elapsed}"),
        // stopped：先说停在多久以前（读者要判断的是「这事还新鲜吗」），再说它一共跑了多久。
        _ => {
            let reason = detail.stop_reason.as_deref().unwrap_or("stopped");
            let ended = format_relative_age(now, Some(detail.updated_at))
                .map_or_else(String::new, |age| format!(" {age}"));
            format!("Stopped ({reason}){ended} after {elapsed}")
        }
    }
}

/// 步数。`nodesObserved` 是已落库节点行数，绝不冒充「总步数」——动态工作流没有静态总数。
fn steps_clause(detail: &WorkflowRunDetail, terminal: bool) -> String {
    let settled = detail.nodes.completed + detail.nodes.failed;
    if terminal {
        let failed = if detail.nodes.failed > 0 {
            format!(", {} failed", detail.nodes.failed)
        } else {
            String::new()
        };
        return format!(
            "{} step{} settled{}, {} tokens",
            settled,
            if settled == 1 { "" } else { "s" },
            failed,
            format_count(detail.spent_tokens)
        );
    }
    let running = if detail.nodes.running > 0 {
        format!(", {} running", detail.nodes.running)
    } else {
        String::new()
    };
    format!(
        "{} of {} dispatched steps settled{}",
        settled, detail.nodes.observed, running
    )
}

/// 待答问题：本会话读得出停驻表（journal + 注册表合成），所以这里没有「不知道」分支——
/// 读不到的形态是整块缺席，不是一句谎话。
fn questions_clause(detail: &WorkflowRunDetail) -> Option<String> {
    let count = detail.pending_questions.len();
    (count > 0).then(|| {
        format!(
            "{} question{} awaiting your answer.",
            count,
            if count == 1 { "" } else { "s" }
        )
    })
}

/// 失败码进摘要：模型据它分辨「进程死了」与「脚本真失败」，而这决定它下一步走哪条路由。
fn failure_clause(detail: &WorkflowRunDetail) -> Option<String> {
    let relevant = detail.status == "errored" || detail.stop_reason.as_deref() == Some("provider");
    let code = detail.error.as_ref().map(|error| error.code.clone())?;
    relevant.then(|| format!("Failure: {code}."))
}

/// 非本会话拥有的 run：通知不会来，TaskOutput 也看不到它——summary 首句必须写明归属。
fn ownership_clause(detail: &WorkflowRunDetail) -> Option<String> {
    (!detail.owned_by_this_session).then(|| "Owned by another session.".to_owned())
}

/// 「多久以前」。`at` 缺席时回 `None`——读侧据此**整段省略**这个年龄，而不是渲染一个 0。
fn format_relative_age(now: u64, at: Option<u64>) -> Option<String> {
    at.map(|at| format!("{} ago", format_duration(now.saturating_sub(at))))
}

/// 毫秒 → 人读的时长（`40s` / `5m 10s` / `2h 15m` / `3d 2h`）。只保留两级；分与秒补零
/// （同为 60 进制的子单位，不补零时 `1m 5s` 与 `1m 50s` 一眼难分），日下的小时不补。
fn format_duration(ms: u64) -> String {
    const SECOND: u64 = 1_000;
    const MINUTE: u64 = 60_000;
    const HOUR: u64 = 3_600_000;
    const DAY: u64 = 86_400_000;
    if ms < MINUTE {
        return format!("{}s", ms / SECOND);
    }
    if ms < HOUR {
        return format!("{}m {:02}s", ms / MINUTE, (ms % MINUTE) / SECOND);
    }
    if ms < DAY {
        return format!("{}h {:02}m", ms / HOUR, (ms % HOUR) / MINUTE);
    }
    format!("{}d {}h", ms / DAY, (ms % DAY) / HOUR)
}

/// ISO 时刻与相对年龄；年龄不可知时只显示 ISO 时刻。
fn format_instant(now: u64, at: u64) -> String {
    match format_relative_age(now, Some(at)) {
        Some(age) => format!("{} ({age})", nibi_kernel_base::js::date::iso_timestamp(at)),
        None => nibi_kernel_base::js::date::iso_timestamp(at),
    }
}

/// 千分位（`toLocaleString` 依赖宿主 ICU，模型面的字要能逐字钉住，这里自己插逗号）。
fn format_count(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(character);
    }
    out
}

/// XML-ish 转义（与 escalations.rs 的同一张五实体表——Node 两处共用 notification.ts 的
/// escapeXml，Rust 侧按 crate 边界各持一份，表内容逐字相同）。
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
#[path = "workflow_run_detail_tests.rs"]
mod tests;

//! 工作流 run 终态通知的**模型面文本**（`run/settled.notice` → 父会话的 `<task-notification>`）。
//!
//! 逐字移植 Node 的 `formatLocalWorkflowTaskNotification`（core/runtime-task/notification.ts 的
//! local_workflow 分支）+ `buildWorkflowTaskSummary` / `workflowDeliveryGuidance`
//!（workflow-notification-copy.ts）+ `<reports>` / `<artifacts>` 两节（tool/executor 的
//! workflow-artifact.ts / workflow-published-artifacts.ts）+ `serializeWorkflowArtifact`
//!（shared 的 nibi-protocol-v4）。文案是给主代理的行动指令——逐字节对齐由
//! `check-dwf-engine` 的 `dwfNoticeText` 钉住（两内核同一字段互比）。
//!
//! 数据来自 sidecar 的 `run/settled.notice`（journal 是唯一数据源，submit/resume/amend 三条入口
//! 同构）；`tool_use_id` 由宿主补（中枢启动的 `launch-` 锚点只在宿主手里，resume 沿用 sidecar
//! 带来的 run 行值）。

use serde_json::Value;

/// 一次结算随附的通知事实（sidecar `run/settled.notice` 的形状，全部来自 journal）。
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RunNoticeFacts {
    pub(crate) name: Option<String>,
    pub(crate) tool_call_id: Option<String>,
    pub(crate) script_path: Option<String>,
    /// `report(item)` 的条目（快照同款上限：前 256 条带 item）。
    pub(crate) reports: Vec<Value>,
    /// report 的**真实总条数**（预览可能只有前 256 条）。
    pub(crate) report_count: u64,
    /// `artifact-published` 的产物记录（每次成功发布一条；合并取每 id 最新版）。
    pub(crate) artifacts: Vec<Value>,
    pub(crate) spent_tokens: Option<u64>,
}

impl RunNoticeFacts {
    pub(crate) fn parse(value: &Value) -> Self {
        let string = |key: &str| {
            value[key]
                .as_str()
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        Self {
            name: string("name"),
            tool_call_id: string("toolCallId"),
            script_path: string("scriptPath"),
            reports: value["reports"]
                .as_array()
                .map(|items| items.to_vec())
                .unwrap_or_default(),
            report_count: value["reportCount"].as_u64().unwrap_or(0),
            artifacts: value["artifacts"]
                .as_array()
                .map(|items| items.to_vec())
                .unwrap_or_default(),
            spent_tokens: value["spentTokens"].as_u64(),
        }
    }
}

const TASK_NOTIFICATION_MAX_CHARS: usize = 120_000;
/// `<reports>` 一节的字符预算；单条的界让一条超长产物吃不掉整节。
const REPORTS_PREVIEW_MAX_CHARS: usize = 8_000;
const REPORT_ITEM_MAX_CHARS: usize = 2_000;
/// `<artifacts>` 一节最多几行（Node `WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES`）。
const ARTIFACTS_MAX_LINES: usize = 8;
/// 预置看板的「大小」是点数不是字节（`PRESET_ARTIFACT_KINDS`）。
const PRESET_ARTIFACT_KINDS: [&str; 4] = ["chart", "table", "metrics", "board"];

/// 终态通知全文；三终态（completed / errored / stopped）之外原样返回 None（调用方不投）。
pub(crate) fn compose_run_settled_notice(
    run_id: &str,
    tool_use_id: Option<&str>,
    facts: &RunNoticeFacts,
    settlement: &Value,
) -> Option<String> {
    let status = settlement["status"].as_str()?;
    let run_status = match status {
        "completed" => "completed",
        "errored" => "errored",
        "stopped" => "stopped",
        _ => return None,
    };
    // 追踪器的通用词（Node `normalizeBackgroundTaskNotificationStatus`）：stopped 折成 killed、
    // errored 折成 failed——`<status>` 行说真话用 runStatus，summary 的兜底分支用通用词。
    let tracker_status = match run_status {
        "completed" => "completed",
        "errored" => "failed",
        _ => "killed",
    };
    let stop_reason = settlement["reason"].as_str();
    // 主语（Node `workflowTaskSubject` 的宿主侧读法）：run 行上的名字缺席时退回 runId。
    let subject = facts.name.as_deref().unwrap_or(run_id).to_owned();
    // 结构化失败（errored 恒有；stopped 只在带上 error 时有）。
    let failure = settlement.get("error").filter(|error| error.is_object());
    let error_message = failure
        .map(|error| error["message"].as_str().unwrap_or_default().to_owned())
        .filter(|message| !message.is_empty());

    let mut lines = vec![
        "<task-notification>".to_owned(),
        format!("<task-id>{}</task-id>", escape_xml(run_id)),
    ];
    if let Some(tool_use_id) = tool_use_id.filter(|id| !id.is_empty()) {
        lines.push(format!("<tool-use-id>{}</tool-use-id>", escape_xml(tool_use_id)));
    }
    lines.push(format!("<status>{run_status}</status>"));
    if let Some(reason) = stop_reason {
        lines.push(format!("<stop-reason>{}</stop-reason>", escape_xml(reason)));
    }
    lines.push(format!("<description>{}</description>", escape_xml(&subject)));
    lines.push(format!(
        "<summary>{}</summary>",
        escape_xml(&build_summary(&subject, run_status, tracker_status, stop_reason))
    ));
    if run_status == "completed"
        && let Some(result) = serialize_artifact(settlement.get("artifact"))
    {
        lines.push(format!("<result>{}</result>", escape_xml(&result)));
    }
    // provider 停下：`<error>` 是表驱动文案（多行块）；其余终态照旧一句 message。
    let provider_stop = failure.and_then(|error| error.get("providerStop")).filter(|value| !value.is_null());
    if let Some(details) = provider_stop {
        lines.push(format!(
            "<error>\n{}\n</error>",
            escape_local_bash_xml(&format_provider_stop_error(details, run_id))
        ));
    } else if let Some(message) = &error_message {
        lines.push(format!("<error>{}</error>", escape_xml(message)));
    }
    if let Some(section) = reports_section(&facts.reports, facts.report_count) {
        lines.push(format!(
            "<reports count=\"{}\"{}>",
            section.count, section.shown_attr
        ));
        lines.push(escape_xml(&section.preview));
        lines.push("</reports>".to_owned());
    }
    if let Some(section) = artifacts_section(&facts.artifacts) {
        lines.push(format!(
            "<artifacts count=\"{}\"{}>",
            section.count, section.shown_attr
        ));
        lines.push(escape_xml(&section.preview));
        lines.push("</artifacts>".to_owned());
    }
    lines.push("</task-notification>".to_owned());
    // 呈现指引排在最后（120k 总截断先斩指引再斩产物）。
    lines.push(String::new());
    lines.push(delivery_guidance(
        run_status,
        stop_reason,
        facts.artifacts.is_empty(),
        run_id,
        facts.script_path.as_deref(),
    ));

    Some(truncate(lines.join("\n")))
}

/// `Workflow "{subject}" …` 的一句话摘要（Node `buildWorkflowTaskSummary`）。
fn build_summary(subject: &str, run_status: &str, tracker_status: &str, stop_reason: Option<&str>) -> String {
    let prefix = format!("Workflow \"{subject}\"");
    if run_status == "errored" {
        return format!("{prefix} errored: the script failed.");
    }
    if run_status == "stopped" || tracker_status == "killed" {
        return match stop_reason {
            Some("user") => format!("{prefix} was stopped by the user."),
            Some("model") => format!("{prefix} was stopped by you (TaskStop)."),
            Some("provider") => format!("{prefix} was stopped on a provider error."),
            Some("interrupted") => format!("{prefix} was stopped: the process that owned it exited."),
            Some("superseded") => format!("{prefix} was stopped and superseded by an amended run."),
            _ => format!("{prefix} was stopped."),
        };
    }
    if tracker_status == "completed" {
        format!("{prefix} completed.")
    } else {
        format!("{prefix} failed.")
    }
}

/// 脚本顶层返回值 → 模型面文本（Node `serializeWorkflowArtifact`）：字符串原样，其余
/// 两空格缩进的 JSON，序列化不出就 `String(value)`——绝不整段丢掉。
fn serialize_artifact(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Null => Some("null".to_owned()),
        other => Some(
            serde_json::to_string_pretty(other)
                .unwrap_or_else(|_| other.to_string()),
        ),
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let head: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{head}\u{2026}")
}

struct PreviewSection {
    count: u64,
    /// `count` 更大时的 `shown="…"` 属性（预览是局部的那个信号）。
    shown_attr: String,
    preview: String,
}

/// `<reports>` 一节（Node `buildWorkflowReportsNotificationSection`）：`[n] item` 逐条、整节
/// 8k 预算（至少给一条）、`count` 恒是真实总条数。零条整节缺席。
fn reports_section(items: &[Value], total: u64) -> Option<PreviewSection> {
    if items.is_empty() {
        return None;
    }
    let mut lines: Vec<String> = Vec::new();
    let mut used = 0usize;
    for (index, item) in items.iter().enumerate() {
        let text = clip(&serialize_artifact(Some(item)).unwrap_or_default(), REPORT_ITEM_MAX_CHARS);
        let line = format!("[{}] {text}", index + 1);
        // 至少给一条：一条超长产物也比「报过 11 条但一条都看不到」有用。
        if !lines.is_empty() && used + line.chars().count() + 1 > REPORTS_PREVIEW_MAX_CHARS {
            break;
        }
        used += line.chars().count() + 1;
        lines.push(line);
    }
    let count = total.max(items.len() as u64);
    let shown_attr = if (lines.len() as u64) < count {
        format!(" shown=\"{}\"", lines.len())
    } else {
        String::new()
    };
    Some(PreviewSection {
        count,
        shown_attr,
        preview: lines.join("\n"),
    })
}

/// `<artifacts>` 一节（Node `buildWorkflowArtifactsNotificationSection`）：每 id 取最新版本、
/// primary 带头、最多 8 行。零件整节缺席。
fn artifacts_section(records: &[Value]) -> Option<PreviewSection> {
    if records.is_empty() {
        return None;
    }
    // 每 id 取版本号最大的一条（并列取后出现的——同版本重发布以最后一次为准）。
    let mut latest: Vec<(String, u64, usize)> = Vec::new();
    for (index, record) in records.iter().enumerate() {
        let Some(id) = record["id"].as_str() else {
            continue;
        };
        let version = record["version"].as_u64().unwrap_or(0);
        if let Some(slot) = latest.iter_mut().find(|(known, _, _)| known == id) {
            if version >= slot.1 {
                slot.1 = version;
                slot.2 = index;
            }
        } else {
            latest.push((id.to_owned(), version, index));
        }
    }
    let mut rows: Vec<&Value> = latest
        .into_iter()
        .filter_map(|(_, _, index)| records.get(index))
        .collect();
    // primary 带头（稳定排序：同 primary 保持 journal 顺序）。
    rows.sort_by_key(|record| !record["primary"].as_bool().unwrap_or(false));
    if rows.is_empty() {
        return None;
    }
    let lines: Vec<String> = rows
        .iter()
        .take(ARTIFACTS_MAX_LINES)
        .map(|record| artifact_line(record))
        .collect();
    let count = rows.len() as u64;
    let shown_attr = if (lines.len() as u64) < count {
        format!(" shown=\"{}\"", lines.len())
    } else {
        String::new()
    };
    Some(PreviewSection {
        count,
        shown_attr,
        preview: lines.join("\n"),
    })
}

/// 一件产物 → 一行：`- {id} ({kind}, primary?, v{version}, {contentType}?, {n} items|{bytes} bytes): {title}`。
/// 预置看板把字节换成点数；title 缺席时连冒号一起省略（Node `formatPublishedArtifactLine`）。
fn artifact_line(record: &Value) -> String {
    let id = record["id"].as_str().unwrap_or_default();
    let kind = record["kind"].as_str().unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    if record["primary"].as_bool() == Some(true) {
        parts.push(kind.to_owned());
        parts.push("primary".to_owned());
    } else {
        parts.push(kind.to_owned());
    }
    parts.push(format!("v{}", record["version"].as_u64().unwrap_or(0)));
    if let Some(content_type) = record["contentType"].as_str().filter(|text| !text.is_empty()) {
        parts.push(content_type.to_owned());
    }
    if PRESET_ARTIFACT_KINDS.contains(&kind) {
        if let Some(items) = record["itemCount"].as_u64() {
            parts.push(format!("{items} item{}", if items == 1 { "" } else { "s" }));
        }
    } else if let Some(bytes) = record["bytes"].as_u64() {
        parts.push(format!("{bytes} bytes"));
    }
    let head = format!("- {id} ({})", parts.join(", "));
    match record["title"].as_str().map(str::trim).filter(|title| !title.is_empty()) {
        Some(title) => format!("{head}: {title}"),
        None => head,
    }
}

/// 终态通知末尾的呈现指引（Node `workflowDeliveryGuidance` 的三终态 × stopped 五 reason）。
fn delivery_guidance(
    run_status: &str,
    stop_reason: Option<&str>,
    no_artifacts: bool,
    run_id: &str,
    script_path: Option<&str>,
) -> String {
    let artifacts_short = if no_artifacts {
        Vec::new()
    } else {
        vec!["Artifacts listed above are already in front of the user.".to_owned()]
    };
    if run_status == "completed" {
        let mut lines = vec![
            "The workflow completed. Present its outcome to the user as a deliverable, in this order: the conclusion; each finding with its evidence (path and line, or the command and output that showed it); which findings were confirmed by a deterministic check or an independent subagent and which are judged only; what the run did not cover.".to_owned(),
            "The reported items above are individual findings: present them individually and keep their evidence. When the preview is partial (count greater than shown), say so and read the rest with GetWorkflowRun.".to_owned(),
        ];
        if !no_artifacts {
            lines.push("Artifacts listed above are already in front of the user as cards; refer to them by title and do not paste their contents. The one marked primary is the deliverable: point the user to it first.".to_owned());
        }
        lines.push("Do not restate the phase graph or the script.".to_owned());
        return lines.join("\n");
    }
    if stop_reason == Some("user") {
        let mut lines = vec![
            "The user stopped this workflow on purpose. Do not resume it with ResumeWorkflowRun and do not amend or rebuild it unless the user asks you to.".to_owned(),
            "Present what it finished before it was stopped: the reported items above are finished findings — show them individually with their evidence. Then stop and wait for the user to say what happens next.".to_owned(),
        ];
        lines.extend(artifacts_short);
        return lines.join("\n");
    }
    if stop_reason == Some("model") {
        let script_sentence = match script_path {
            Some(path) => format!(" Its script is at {path}: edit that file and pass `path`."),
            None => String::new(),
        };
        let mut lines = vec![format!(
            "You stopped this workflow with TaskStop. If you stopped it to fix the script, do that now: call AmendWorkflow with this run's ID and the corrected script — everything that settled before the stop is imported as cache, and the sooner the fix runs the less it re-pays. (Next time, amend the running run directly: AmendWorkflow stops it for you.){script_sentence}"
        )];
        lines.push("Otherwise present what it finished: the reported items above are finished findings — show them individually with their evidence. Resume it unchanged only if that is what the user wants.".to_owned());
        lines.extend(artifacts_short);
        return lines.join("\n");
    }
    if stop_reason == Some("provider") {
        let mut lines = vec![
            "A provider-side error stopped this run; the <error> block above names the cause and the fix. Present what the run finished: the reported items above are finished findings — show them individually with their evidence.".to_owned(),
            format!("Then resolve the cause with the user before calling ResumeWorkflowRun with run_id=\"{run_id}\" — finished steps replay from the journal. Do not rebuild the workflow."),
        ];
        lines.extend(artifacts_short);
        return lines.join("\n");
    }
    if stop_reason == Some("interrupted") {
        let mut lines = vec![
            "The process that owned this run exited before it finished. Present what it finished: the reported items above are finished findings — show them individually with their evidence.".to_owned(),
            format!("Then call ResumeWorkflowRun with run_id=\"{run_id}\" — finished steps replay from the journal and only the unfinished ones run again."),
        ];
        lines.extend(artifacts_short);
        return lines.join("\n");
    }
    if stop_reason == Some("superseded") {
        // 正常到不了：superseded 的终态通知在 coordinator 处被压下；留这一支不说错话。
        let mut lines = vec![
            "This run was stopped because you amended it: a newer run supersedes it and is already running. Do not resume this run and do not amend it again; wait for the successor's notification.".to_owned(),
        ];
        lines.extend(artifacts_short);
        return lines.join("\n");
    }
    if run_status == "stopped" {
        let mut lines = vec![
            "This workflow was stopped before it finished. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence.".to_owned(),
            format!("It can be continued with ResumeWorkflowRun (run_id=\"{run_id}\"); ask the user before resuming a run you did not stop yourself."),
        ];
        lines.extend(artifacts_short);
        return lines.join("\n");
    }
    if run_status == "errored" {
        let fix = match script_path {
            Some(path) => format!(
                "The run's script is at {path}. Edit that file in place, then call AmendWorkflow (run_id=\"{run_id}\", path=\"{path}\") so finished work is reused — do not paste the script inline. ResumeWorkflowRun will refuse this run: replaying the same script would fail the same way."
            ),
            None => format!(
                "Fix the script and submit it with AmendWorkflow (run_id=\"{run_id}\") so finished work is reused. ResumeWorkflowRun will refuse this run: replaying the same script would fail the same way."
            ),
        };
        let mut lines = vec![
            "The workflow script failed. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence. Then explain the failure and what it means for the user's request.".to_owned(),
        ];
        lines.extend(artifacts_short);
        lines.push(fix);
        return lines.join("\n");
    }
    let mut lines = vec![
        "The workflow did not complete. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence. Then explain the failure and what it means for the user's request.".to_owned(),
    ];
    lines.extend(artifacts_short);
    lines.push("If the script itself was wrong, a corrected script submitted with AmendWorkflow re-uses the finished work; if the process died (error code Interrupted), the run is resumable as-is.".to_owned());
    lines.join("\n")
}

/// provider 停下的表驱动 `<error>` 文案（Node `formatWorkflowProviderStopError`）。
fn format_provider_stop_error(details: &Value, run_id: &str) -> String {
    let text = |key: &str| details[key].as_str().filter(|value| !value.is_empty());
    let provider = text("providerLabel")
        .or_else(|| text("providerId"))
        .unwrap_or("the provider");
    let provider_ref = match (text("providerLabel"), text("providerId")) {
        (Some(label), Some(id)) => format!("{label} ({id})"),
        _ => provider.to_owned(),
    };
    let subagent = text("subagentName")
        .or_else(|| text("subagent"))
        .unwrap_or("a subagent");
    let phase = match text("phase") {
        Some(phase) => format!(" (phase \"{phase}\")"),
        None => String::new(),
    };
    let model = text("modelId").unwrap_or("the current model");
    let code = text("providerCode").or_else(|| text("reason")).unwrap_or("");
    let resume = format!("then call ResumeWorkflowRun with run_id=\"{run_id}\"");
    let sentences: [String; 2] = match text("kind") {
        Some("auth") => [
            format!("Sign-in to {provider_ref} expired while subagent {subagent}{phase} was running."),
            format!("Ask the user to sign in to {provider} again, {resume}. Finished steps are kept."),
        ],
        Some("not_configured") => [
            format!("Provider {} is not configured on this machine, so subagent {subagent}{phase} could not send its request.", text("providerId").unwrap_or(provider)),
            format!("Ask the user to configure the provider or switch this session to another model, {resume}."),
        ],
        Some("model_unavailable") => [
            format!("Model {model} is not available on {provider} (not in the user's plan, or retired)."),
            format!("Ask the user to switch this session to a model the plan includes, {resume}. Subagents follow the session's model."),
        ],
        Some("invalid_request") => [
            format!("{provider} rejected subagent {subagent}{phase}'s request as invalid (code {code})."),
            format!("Switching the session to another model usually clears this; {resume}. If it stops again with the same code, show the raw message to the user."),
        ],
        Some("quota") => match text("resetAt") {
            Some(reset_at) => [
                format!("{provider} reports the user's usage cap is reached (code {code}); it resets at {}.", iso_millis(reset_at)),
                format!("Tell the user; after the reset, call ResumeWorkflowRun with run_id=\"{run_id}\". Do not rebuild the workflow."),
            ],
            None => [
                format!("{provider} reports the user's quota is exhausted (code {code})."),
                format!("Ask the user to top up or upgrade the plan, or switch to another provider, {resume}."),
            ],
        },
        _ => [
            format!("{provider} refused subagent {subagent}{phase}'s request with a permanent error (code {code})."),
            format!("Resolve it with the user (the raw message below says what the provider wants), {resume}."),
        ],
    };
    let mut fact_lines = vec![
        format!("provider={}", text("providerId").unwrap_or("unknown")),
        format!("model={}", text("modelId").unwrap_or("unknown")),
        format!("subagent={}", text("subagent").unwrap_or("unknown")),
    ];
    if let Some(phase) = text("phase") {
        fact_lines.push(format!("phase={phase}"));
    }
    fact_lines.push(format!("code={code}"));
    let mut lines = sentences.to_vec();
    lines.push(fact_lines.join(" "));
    if let Some(raw) = text("rawMessage") {
        lines.push(format!("raw: {raw}"));
    }
    lines.join("\n")
}

/// epoch 毫秒 → ISO（Node `new Date(resetAt).toISOString()`）。
fn iso_millis(text: &str) -> String {
    let millis: i64 = text.parse().unwrap_or(0);
    // 时间只在 quota 文案里出现；days→secs 手写换算，不引 chrono。
    let secs = millis.div_euclid(1000);
    let millis_part = millis.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let day_secs = secs.rem_euclid(86_400);
    let (hour, minute, second) = (day_secs / 3600, (day_secs % 3600) / 60, day_secs % 60);
    // 1970-01-01 起的民用日期（Howard Hinnant 的 civil_from_days 算法）。
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{millis_part:03}Z")
}

fn escape_xml(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
    out
}

/// 错误块里的转义只处理 <>&（引号原样——块里有要让模型照抄的 `run_id="…"`）。
fn escape_local_bash_xml(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            other => out.push(other),
        }
    }
    out
}

fn truncate(value: String) -> String {
    if value.chars().count() <= TASK_NOTIFICATION_MAX_CHARS {
        return value;
    }
    let head: String = value.chars().take(TASK_NOTIFICATION_MAX_CHARS).collect();
    format!("{head}\n[truncated]")
}

#[cfg(test)]
#[path = "dwf_run_notification_tests.rs"]
mod tests;

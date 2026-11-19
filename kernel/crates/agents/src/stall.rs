//! 后台子代理长时间无进展的发现与报告（docs/specs/rust-cli/agents.md；语义对齐 Node 3.18.2
//! `subagent/background-stall.ts`）。
//!
//! 运行时只负责「发现并报告」，停不停由主代理决定：没有一刀切的超时。
//! - 进展 = 新的模型请求开始或完成、工具开始、工具结果；`ToolProgress` 心跳不算（卡死的命令也会一直发心跳），
//!   流式增量也不单独算（模型流有自己的空闲看门狗）。等审批的时间不算无进展，审批结束从那一刻重新计时。
//! - 活动只记在 `live::Live` 的条目上（唯一 owner），由子循环事件折进来；这里只持有每个子代理的提醒次数，
//!   其余全部从条目派生。
//! - 首个提醒在无进展 `first_ms` 后，之后每次间隔加倍（上限 `max_interval_ms`）；有新进展后计数清零。
//!
//! 提醒只报告，不改任何状态：它走与终态通知相同的邮箱/Hub 路由，但信封是 `<background-agent-stall>`（不是
//! `<task-notification>`），所以 App 与主代理都不会把它读成子代理结束。

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use nibi_kernel_api::ids::{AgentId, SessionId, ToolUseId};
use nibi_kernel_api::model::ModelRequestStatusKind;
use nibi_kernel_api::orchestration::QueryEvent;

use crate::Core;
use crate::live::{AgentState, LiveAgent};

/// 首个提醒的无进展阈值（15 分钟）。
pub const DEFAULT_FIRST_MS: u64 = 15 * 60_000;
/// 提醒间隔的上限（4 小时）。
pub const DEFAULT_MAX_INTERVAL_MS: u64 = 4 * 60 * 60_000;
/// 提醒里的任务描述上限（Agent 入参的 description 没有硬上限）。
const DESCRIPTION_MAX_CHARS: usize = 200;
/// 在途工具摘要的上限。
const TOOL_SUMMARY_MAX_CHARS: usize = 200;
/// 提醒里列出的在途工具个数；其余只给个数。
const RUNNING_TOOLS_MAX: usize = 5;
/// 与标准后台通知同一个上限（Node `TASK_NOTIFICATION_MAX_CHARS`）。
const NOTIFICATION_MAX_CHARS: usize = 120_000;
/// 一次等待的最长分段：更远的到期分段等，醒来先核对是否真的到期（Node `MAX_TIMER_DELAY_MS`）。
pub const MAX_TIMER_DELAY_MS: u64 = 2_147_483_647;

/// 无进展提醒的两个阈值（`NIBI_SUBAGENT_STALL_NOTIFY_MS` / `NIBI_SUBAGENT_STALL_MAX_INTERVAL_MS`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StallConfig {
    pub first_ms: u64,
    pub max_interval_ms: u64,
}

impl StallConfig {
    /// 非正数按缺省；上限不小于首个阈值。
    pub fn new(first_ms: Option<u64>, max_interval_ms: Option<u64>) -> Self {
        let first = positive_or(first_ms, DEFAULT_FIRST_MS);
        Self {
            first_ms: first,
            max_interval_ms: positive_or(max_interval_ms, DEFAULT_MAX_INTERVAL_MS).max(first),
        }
    }
}

impl Default for StallConfig {
    fn default() -> Self {
        Self::new(None, None)
    }
}

/// 在途工具（`ToolStarted` 到 `ToolFinished` 之间）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunningTool {
    pub(crate) tool_use: ToolUseId,
    pub(crate) name: String,
    pub(crate) summary: Option<String>,
    pub(crate) started_ms: u64,
}

/// 子代理的活动投影（Node `SubagentActivitySnapshot` 的 Rust 侧）：最近进展时刻、在途工具、等着的审批。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Activity {
    /// 最近一次进展的时刻；None 表示这次运行还没有进展（基准是运行的开始时刻）。
    pub(crate) last_progress_ms: Option<u64>,
    pub(crate) running: Vec<RunningTool>,
    /// 还在等用户回答的权限审批（并行的多个审批按工具调用记）。
    pub(crate) pending_permissions: Vec<ToolUseId>,
}

impl Activity {
    /// 这个事件会不会改变活动。不是进展的事件（`ToolProgress`、流式增量、模型重试/停顿通知）在这里挡掉，
    /// 不给条目分配活动、也不惊动无进展钟。
    pub(crate) fn relevant(event: &QueryEvent) -> bool {
        match event {
            QueryEvent::ModelRequestStatus { status } => matches!(
                status.kind,
                ModelRequestStatusKind::ModelRequestStarted
                    | ModelRequestStatusKind::ModelRequestCompleted
            ),
            QueryEvent::ToolStarted { .. } | QueryEvent::ToolFinished { .. } => true,
            QueryEvent::Delta { .. }
            | QueryEvent::ToolProgress { .. }
            | QueryEvent::ModelNotice { .. } => false,
        }
    }

    /// 折进一个事件。`relevant` 为真时总会改变活动。
    pub(crate) fn apply(&mut self, event: &QueryEvent, now: u64) {
        match event {
            QueryEvent::ModelRequestStatus { .. } => self.last_progress_ms = Some(now),
            QueryEvent::ToolStarted {
                tool_use,
                name,
                input,
            } => {
                let tool = RunningTool {
                    tool_use: tool_use.clone(),
                    name: name.clone(),
                    summary: tool_input_summary(input),
                    started_ms: now,
                };
                self.running.retain(|item| item.tool_use != *tool_use);
                self.running.push(tool);
                self.last_progress_ms = Some(now);
            }
            QueryEvent::ToolFinished { tool_use, .. } => {
                self.running.retain(|item| item.tool_use != *tool_use);
                self.pending_permissions.retain(|id| id != tool_use);
                self.last_progress_ms = Some(now);
            }
            QueryEvent::Delta { .. }
            | QueryEvent::ToolProgress { .. }
            | QueryEvent::ModelNotice { .. } => {}
        }
    }

    /// 开始等一个权限审批：只记挂起，不算进展。
    pub(crate) fn permission_started(&mut self, tool_use: &ToolUseId) {
        if !self.pending_permissions.contains(tool_use) {
            self.pending_permissions.push(tool_use.clone());
        }
    }

    /// 审批结束（允许或拒绝）：从这一刻重新计时（等人的时间不算无进展）。
    pub(crate) fn permission_ended(&mut self, tool_use: &ToolUseId, now: u64) {
        self.pending_permissions.retain(|id| id != tool_use);
        self.last_progress_ms = Some(now);
    }

    pub(crate) fn waiting_permission(&self) -> bool {
        !self.pending_permissions.is_empty()
    }
}

/// 无进展钟从条目上读到的快照（只在 `Live` 的锁里构造）。
#[derive(Debug, Clone)]
pub(crate) struct StallAgent {
    pub(crate) agent: AgentId,
    pub(crate) parent: SessionId,
    pub(crate) description: String,
    pub(crate) started_ms: u64,
    pub(crate) progress_ms: u64,
    /// 这次运行的代号（SendMessage 续跑换新）。
    pub(crate) epoch: u64,
    pub(crate) running: Vec<RunningTool>,
    pub(crate) waiting_permission: bool,
}

/// 出队时核对提醒是否仍然成立的依据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StallStamp {
    pub(crate) parent: SessionId,
    pub(crate) epoch: u64,
    pub(crate) last_progress_ms: u64,
}

impl StallStamp {
    /// 子代理已结束、换了执行（续跑）、有了新进展或进入审批时，提醒不再成立。
    pub(crate) fn matches(&self, entry: &LiveAgent) -> bool {
        matches!(entry.state, AgentState::Running { .. })
            && entry.background
            && entry.parent == self.parent
            && entry.shown.run_epoch == self.epoch
            && entry.progress_ms() == self.last_progress_ms
            && !entry.waiting_permission()
    }
}

/// 一条提醒（Node `BackgroundSubagentStallReminder`）。
#[derive(Debug, Clone)]
pub(crate) struct StallReminder {
    pub(crate) agent: AgentId,
    pub(crate) parent: SessionId,
    pub(crate) description: String,
    pub(crate) epoch: u64,
    pub(crate) now_ms: u64,
    pub(crate) last_progress_ms: u64,
    pub(crate) running_for_ms: u64,
    pub(crate) no_progress_for_ms: u64,
    pub(crate) running: Vec<RunningTool>,
    pub(crate) next_report_in_ms: u64,
    pub(crate) ordinal: u32,
}

impl StallReminder {
    pub(crate) fn stamp(&self) -> StallStamp {
        StallStamp {
            parent: self.parent.clone(),
            epoch: self.epoch,
            last_progress_ms: self.last_progress_ms,
        }
    }

    /// 送达前的核对（与 `StallStamp::matches` 同一条件）。
    pub(crate) fn matches(&self, entry: &LiveAgent) -> bool {
        self.stamp().matches(entry)
    }
}

/// 每个子代理的提醒状态。其余全部从条目派生：有新进展（`progress_ms` 前进）或换了执行就重置。
#[derive(Debug, Clone)]
struct State {
    reminders: u32,
    last_reminder_ms: Option<u64>,
    progress_ms: u64,
    epoch: u64,
}

/// 无进展钟的状态机：注入 `now` 与在跑的后台子代理快照，不碰真实时间（async 驱动在 [`StallWatcher`]）。
#[derive(Debug, Clone)]
pub(crate) struct StallClock {
    first_ms: u64,
    max_interval_ms: u64,
    states: BTreeMap<AgentId, State>,
}

impl StallClock {
    pub(crate) fn new(config: StallConfig) -> Self {
        Self {
            first_ms: config.first_ms,
            max_interval_ms: config.max_interval_ms,
            states: BTreeMap::new(),
        }
    }

    /// 按当前在跑的后台子代理对齐状态：消失的删掉，有进展或换了执行的从零开始。
    pub(crate) fn reconcile(&mut self, live: &[StallAgent]) {
        let live: BTreeMap<&AgentId, &StallAgent> =
            live.iter().map(|agent| (&agent.agent, agent)).collect();
        self.states.retain(|id, _| live.contains_key(id));
        for agent in live.values() {
            let reset = self.states.get(&agent.agent).is_none_or(|state| {
                state.progress_ms != agent.progress_ms || state.epoch != agent.epoch
            });
            if reset {
                self.states.insert(
                    agent.agent.clone(),
                    State {
                        reminders: 0,
                        last_reminder_ms: None,
                        progress_ms: agent.progress_ms,
                        epoch: agent.epoch,
                    },
                );
            }
        }
    }

    /// 下一次到期时刻；没有可提醒的子代理（或都在等审批）时 None。
    pub(crate) fn next_due(&self, live: &[StallAgent]) -> Option<u64> {
        let live: BTreeMap<&AgentId, &StallAgent> =
            live.iter().map(|agent| (&agent.agent, agent)).collect();
        let (first, max) = (self.first_ms, self.max_interval_ms);
        self.states
            .iter()
            .filter(|(id, _)| live.get(*id).is_some_and(|agent| !agent.waiting_permission))
            .map(|(_, state)| due_at(state, first, max))
            .min()
    }

    /// 到期且仍然成立的提醒；每发一条，下一次到期往后推（间隔按已发次数加倍）。
    pub(crate) fn fire(&mut self, live: &[StallAgent], now: u64) -> Vec<StallReminder> {
        let live: BTreeMap<&AgentId, &StallAgent> =
            live.iter().map(|agent| (&agent.agent, agent)).collect();
        let (first, max) = (self.first_ms, self.max_interval_ms);
        let mut reminders = Vec::new();
        for (id, state) in &mut self.states {
            let Some(agent) = live.get(id) else {
                continue;
            };
            if agent.waiting_permission || due_at(state, first, max) > now {
                continue;
            }
            state.reminders += 1;
            state.last_reminder_ms = Some(now);
            reminders.push(StallReminder {
                agent: agent.agent.clone(),
                parent: agent.parent.clone(),
                description: agent.description.clone(),
                epoch: agent.epoch,
                now_ms: now,
                last_progress_ms: agent.progress_ms,
                running_for_ms: now.saturating_sub(agent.started_ms),
                no_progress_for_ms: now.saturating_sub(agent.progress_ms),
                running: agent.running.clone(),
                next_report_in_ms: interval_after(state.reminders, first, max),
                ordinal: state.reminders,
            });
        }
        reminders
    }
}

fn due_at(state: &State, first: u64, max: u64) -> u64 {
    match state.last_reminder_ms {
        None => state.progress_ms.saturating_add(first),
        Some(last) => last.saturating_add(interval_after(state.reminders, first, max)),
    }
}

/// 已发 `reminders` 次之后的下一个间隔：首个阈值起每次加倍，到上限为止。
fn interval_after(reminders: u32, first: u64, max: u64) -> u64 {
    let factor = 1u64.checked_shl(reminders).unwrap_or(u64::MAX);
    first.saturating_mul(factor).min(max)
}

/// 后台无进展钟的 async 驱动（runtime 在根作用域里以常驻任务启动，作用域关闭即停止）。
pub struct StallWatcher {
    core: Arc<Core>,
    clock: StallClock,
}

impl StallWatcher {
    pub(crate) fn new(core: Arc<Core>, config: StallConfig) -> Self {
        Self {
            core,
            clock: StallClock::new(config),
        }
    }

    /// 跟着 `Live` 的变化通知对齐定时器；到点先重新核对（可能只是分段醒来），再送出仍然成立的提醒。
    pub async fn run(mut self) {
        let mut changes = self.core.live.subscribe();
        loop {
            // 先标记已看到的版本：reconcile 期间发生的改动会让下面的 changed() 立即返回。
            changes.borrow_and_update();
            let live = self.core.live.stall_agents();
            self.clock.reconcile(&live);
            let Some(due) = self.clock.next_due(&live) else {
                if changes.changed().await.is_err() {
                    return;
                }
                continue;
            };
            let now = self.core.live.now_ms();
            let delay = due.saturating_sub(now).min(MAX_TIMER_DELAY_MS);
            tokio::select! {
                changed = changes.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                () = tokio::time::sleep(Duration::from_millis(delay)) => {
                    let now = self.core.live.now_ms();
                    let live = self.core.live.stall_agents();
                    for reminder in self.clock.fire(&live, now) {
                        deliver(&self.core, &reminder).await;
                    }
                }
            }
        }
    }
}

/// 送出一条提醒：与终态通知同一条路由（在跑进邮箱、停放就续跑、已结束送顶层会话），但信封不同、
/// 状态不落终态。送出前在 `Live` 的同一把锁里核对提醒是否仍然成立。
async fn deliver(core: &Arc<Core>, reminder: &StallReminder) {
    tracing::info!(
        agent = %reminder.agent,
        event = "subagent.background.stall_reminder_sent",
        no_progress_for_ms = reminder.no_progress_for_ms,
        next_report_in_ms = reminder.next_report_in_ms,
        ordinal = reminder.ordinal,
        "background subagent stall reminder sent"
    );
    let wake = crate::routing::deliver_stall(core, reminder);
    crate::routing::wake(core, wake.into_iter().collect()).await;
}

/// 提醒正文（Node `formatBackgroundSubagentStallNotification`）：系统通知横幅 + `<background-agent-stall>` 块。
///
/// 刻意不用 `<task-notification>`：App 把带 tool-use-id 的该标签读成子代理终态。描述、工具名与摘要来自 Agent
/// 入参与 child 模型生成的工具入参，XML 块与正文里都转义；描述与摘要限长。
pub(crate) fn format(reminder: &StallReminder) -> String {
    let description = escape_xml(&stall_description(&reminder.description));
    let agent = escape_xml(reminder.agent.as_str());
    let mut tools: Vec<(&RunningTool, u64)> = reminder
        .running
        .iter()
        .map(|tool| {
            (
                tool,
                reminder.now_ms.saturating_sub(tool.started_ms),
            )
        })
        .collect();
    tools.sort_by(|left, right| right.1.cmp(&left.1));
    let listed = &tools[..tools.len().min(RUNNING_TOOLS_MAX)];
    let mut lines: Vec<String> = SYSTEM_NOTIFICATION_BANNER
        .iter()
        .map(|line| (*line).to_owned())
        .collect();
    lines.extend([
        "<background-agent-stall>".to_owned(),
        format!("  <task-id>{agent}</task-id>"),
        format!("  <description>{description}</description>"),
        format!(
            "  <running-for-ms>{}</running-for-ms>",
            reminder.running_for_ms
        ),
        format!(
            "  <no-progress-for-ms>{}</no-progress-for-ms>",
            reminder.no_progress_for_ms
        ),
        format!(
            "  <last-progress-at>{}</last-progress-at>",
            iso8601(reminder.last_progress_ms)
        ),
    ]);
    for (tool, running_for) in listed {
        lines.push(format!(
            "  <running-tool name=\"{}\" running-for-ms=\"{running_for}\">{}</running-tool>",
            escape_xml(&tool.name),
            escape_xml(tool.summary.as_deref().unwrap_or_default()),
        ));
    }
    if tools.len() > listed.len() {
        lines.push(format!(
            "  <more-running-tools>{}</more-running-tools>",
            tools.len() - listed.len()
        ));
    }
    lines.push(format!(
        "  <next-report-in-ms>{}</next-report-in-ms>",
        reminder.next_report_in_ms
    ));
    lines.push("</background-agent-stall>".to_owned());
    lines.push(String::new());
    lines.push(format!(
        "Background agent \"{description}\" ({agent}) has been running for {} and has made no progress for {}: no new model request and no tool call has finished.",
        minutes(reminder.running_for_ms),
        minutes(reminder.no_progress_for_ms),
    ));
    if let Some((tool, running_for)) = listed.first() {
        let summary = match tool.summary.as_deref().filter(|summary| !summary.is_empty()) {
            Some(summary) => format!(": {}", escape_xml(summary)),
            None => String::new(),
        };
        lines.push(format!(
            "It is inside {}, which has been running for {}{summary}.",
            escape_xml(&tool.name),
            minutes(*running_for),
        ));
    }
    lines.push(
        "This is a status report, not a failure. Test suites, builds, simulations and polling loops with sleep often run this long or longer."
            .to_owned(),
    );
    lines.push(format!(
        "If that fits what the agent is doing, do nothing and end your turn; if it is still quiet, the next report comes in about {}.",
        minutes(reminder.next_report_in_ms),
    ));
    lines.push(
        "Stop it with TaskStop only if you have a concrete reason to think it is stuck (for example, it waits for input that will never arrive). TaskOutput with block=false shows its current activity. Tell the user if they are waiting on it."
            .to_owned(),
    );
    truncate_notification(&lines.join("\n"))
}

const SYSTEM_NOTIFICATION_BANNER: [&str; 4] = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated status report about a background agent, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
];

/// 提醒与轮标题里使用的任务描述：单行、有上限。
pub(crate) fn stall_description(description: &str) -> String {
    let line = single_line(description, DESCRIPTION_MAX_CHARS);
    if line.is_empty() {
        "Subagent".to_owned()
    } else {
        line
    }
}

/// 工具入参里最有信息量的一行（Node `toolInputSummary`）。
fn tool_input_summary(input: &serde_json::Value) -> Option<String> {
    let record = input.as_object()?;
    const KEYS: [&str; 7] = [
        "command",
        "description",
        "file_path",
        "path",
        "pattern",
        "url",
        "prompt",
    ];
    let value = KEYS.iter().find_map(|key| {
        record
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
    })?;
    Some(single_line(value, TOOL_SUMMARY_MAX_CHARS))
}

fn single_line(value: &str, max_chars: usize) -> String {
    let line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = line.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        let mut head: String = head.chars().take(max_chars - 1).collect();
        head.push('\u{2026}');
        head
    } else {
        head
    }
}

fn truncate_notification(value: &str) -> String {
    if value.chars().count() <= NOTIFICATION_MAX_CHARS {
        return value.to_owned();
    }
    let head: String = value.chars().take(NOTIFICATION_MAX_CHARS).collect();
    format!("{head}\n[truncated]")
}

/// XML 文本与属性值（Node `escapeXml`：`<>&'"` 全转义）。
fn escape_xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '&' => escaped.push_str("&amp;"),
            '\'' => escaped.push_str("&apos;"),
            '"' => escaped.push_str("&quot;"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// 分钟数：不足 2 小时按整分钟，否则按一位小数的整小时（Node `minutes`）。
fn minutes(ms: u64) -> String {
    let value = (ms as f64 / 60_000.0).round().max(1.0) as u64;
    if value < 120 {
        format!("{value} minute{}", if value == 1 { "" } else { "s" })
    } else {
        let hours = (value as f64 / 60.0 * 10.0).round() / 10.0;
        format!("{hours} hours")
    }
}

/// 纪元毫秒的 ISO 8601 UTC（`Date.prototype.toISOString` 同形，含毫秒）。
fn iso8601(ms: u64) -> String {
    let millis = ms % 1_000;
    let seconds = ms / 1_000;
    let days = seconds / 86_400;
    let within = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let (hour, minute, second) = (within / 3_600, within % 3_600 / 60, within % 60);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    )
}

/// Howard Hinnant 的 civil-from-days：1970-01-01 起的天数 → (年, 月, 日)。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = (days - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn positive_or(value: Option<u64>, fallback: u64) -> u64 {
    match value {
        Some(value) if value > 0 => value,
        _ => fallback,
    }
}

#[cfg(test)]
#[path = "stall_tests.rs"]
mod tests;

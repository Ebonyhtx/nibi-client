//! 「run 还欠着决定、主代理闲着」的提醒（docs/dynamic-workflow/transcript-and-notifications.md
//! 「Reminding an idle main agent」）。Node 同名机制（core/runtime-task/workflow-blocked-reminder.ts
//! 的钟 + workflow-notification-copy.ts 的 `formatWorkflowBlockedNotification`）的逐字移植。
//!
//! 升级问题与留白各自只发一条通知、唤起一轮。那一轮可能白跑：请求失败、应用退出、模型没作答就
//! 收尾、或者一轮里带了几条而漏掉一条——这些在 run 那一侧都不留痕，而停驻的分支没有超时。所以
//! 这里不看「通知送到了没有」，只看状态：**会话空闲着、且它在飞的某个 run 还开着决定**，到点就
//! 再告诉主代理一次。
//!
//! 钟的三条纪律（与 Node 逐字）：
//!   - 量的是**空闲时长**（命令队列排空起算，任何一轮开始即归零），不是决定开了多久——一轮在跑
//!     的时候，原通知要么已经在模型眼前、要么排在这一轮后面，旁边再塞一条只是重复；
//!   - 开着什么**到点现读**（宿主的 [`WorkflowBlockedReminderHost::read_open`]）——这里不留开集
//!     的副本，唯一跨空闲段留存的状态是每个 run 已经提醒过几次；开集事件只用来忘掉这个数；
//!   - 每个 run 至多 [`WORKFLOW_BLOCKED_REMINDER_DELAYS_MS`] 那么多次，**入队即计数**：provider
//!     一直失败时代价是两轮提醒然后安静，而不是一个重试环。
//!
//! 本模块是纯件：时钟、定时器、「谁在飞 / 开着什么 / 怎么发」全由宿主递进来。会话侧的接线
//! （busy/idle/userSpoke 边、开集事件、live-run 查询）落在宿主装配层。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use futures_util::future::BoxFuture;

const MINUTE_MS: u64 = 60_000;

/// 两次提醒各自要求的空闲时长（Node `WORKFLOW_BLOCKED_REMINDER_DELAYS_MS`）：第一次 15 分钟；
/// 第二次在第一次唤起的那一轮结束后再空闲 30 分钟。下标 = 该 run 已经提醒过的次数，越界即
/// 「不再提醒」。
pub const WORKFLOW_BLOCKED_REMINDER_DELAYS_MS: [u64; 2] = [15 * MINUTE_MS, 30 * MINUTE_MS];

/// 一个 run 此刻开着的决定。`holes` 只含 `waiting` 的。
#[derive(Clone, Debug, Default)]
pub struct WorkflowOpenDecisions {
    pub questions: Vec<WorkflowBlockedQuestion>,
    pub holes: Vec<WorkflowBlockedHole>,
    /// run 的草稿文件（快照的 `scriptPath`）；提醒文案据它告诉模型去哪读留白的上下文。
    pub draft_path: Option<String>,
}

/// 一个停驻中的升级问答（Node `DynamicWorkflowRunPendingQuestion` 里提醒文案消费的字段）。
#[derive(Clone, Debug)]
pub struct WorkflowBlockedQuestion {
    pub qid: String,
    pub actor: String,
    pub actor_name: Option<String>,
    pub question: String,
    pub context: Option<String>,
    /// epoch ms（缺席按 0 算等待时长）。
    pub asked_at: Option<u64>,
}

/// 一个还在等的留白（Node `DynamicWorkflowRunHole` 里提醒文案消费的字段）。
#[derive(Clone, Debug)]
pub struct WorkflowBlockedHole {
    pub site_id: String,
    pub name: String,
    pub hole_type: String,
    pub line: Option<u64>,
    /// 到达时刻（epoch ms；缺席按 0 算等待时长）。
    pub since: Option<u64>,
}

/// 一条该发的提醒。`ordinal` 从 1 起，`total` 是上限；`now` 是到点时刻（算等待时长用同一个钟）。
pub struct WorkflowBlockedReminder {
    pub run_id: String,
    pub open: WorkflowOpenDecisions,
    pub ordinal: usize,
    pub total: usize,
    pub now: u64,
}

/// 到点回调：钟把「产生本次到点 future 的闭包」交给宿主，宿主负责异步驱动它（生产
/// `tokio::spawn`；测试手动驱动，一毫秒不真等）。返回的 id 供
/// [`WorkflowBlockedReminderHost::cancel_timer`] 取消。
pub type BoxedFire = Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send>;

/// 钟看到的宿主（Node `WorkflowBlockedReminderHost` 的同形端口）。
pub trait WorkflowBlockedReminderHost: Send + Sync + 'static {
    fn now_ms(&self) -> u64;
    /// 会话此刻是否空闲（没有在跑的、排着的、预留的回合）。到点时的最后一道核对。
    fn is_idle(&self) -> bool;
    /// 本会话此刻在飞的 workflow run（每次求值现读，不缓存）。
    fn live_run_ids(&self) -> Vec<String>;
    /// 读这个 run 此刻开着的决定；没有开着的即 `None`。可以失败——钟跳过这个 run。
    fn read_open(
        &self,
        run_id: &str,
    ) -> BoxFuture<'static, Result<Option<WorkflowOpenDecisions>, String>>;
    /// 发出一条提醒。同步、不抛。
    fn remind(&self, reminder: WorkflowBlockedReminder);
    /// 读快照失败的去处（缺省记一条日志）。
    fn on_read_error(&self, run_id: &str, error: &str) {
        tracing::warn!(event = "dwf.blocked.read_failed", run = %run_id, %error);
    }
    /// 排一个定时器，返回 id（[`Self::cancel_timer`] 用）。**不得同步重入钟**——
    /// Node 的 `setTimeout` 同一条假设。
    fn schedule(&self, delay_ms: u64, fire: BoxedFire) -> u64;
    /// 取消一个已排的定时器（幂等）。
    fn cancel_timer(&self, timer: u64);
}

/// 钟的内部状态（Node 的三个私有字段 + epoch + 停钟）。
struct ClockState {
    /// 每个 run 已经提醒过的次数（0 即缺席）。这是本钟唯一跨空闲段留存的状态。
    sent: HashMap<String, usize>,
    /// 当前空闲段的起点；`None` = 会话不在空闲段里（在跑一轮，或从没闲下来过）。
    idle_since: Option<u64>,
    timer: Option<u64>,
    /// 每次停钟 / 重排自增；到点回调与读快照的续体据它判断自己是否已经作废。
    epoch: u64,
    stopped: bool,
}

/// 钟的本体。句柄（[`WorkflowBlockedReminderClock`]）只是它的 `Arc` 视图——到点回调是
/// `'static` 的，进不去借用，所以状态从构造起就住在 `Arc` 里。
struct ClockCore<H: WorkflowBlockedReminderHost> {
    host: Arc<H>,
    delays: Vec<u64>,
    state: Mutex<ClockState>,
}

impl<H: WorkflowBlockedReminderHost> ClockCore<H> {
    fn lock(&self) -> MutexGuard<'_, ClockState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn session_busy(self: &Arc<Self>) {
        let mut state = self.lock();
        state.idle_since = None;
        self.disarm(&mut state);
    }

    /// 命令队列排空。已经在空闲段里时是 no-op：空排一次队列不是一轮，不能把空闲时长冲回零。
    fn session_idle(self: &Arc<Self>) {
        let mut state = self.lock();
        if state.stopped || state.idle_since.is_some() {
            return;
        }
        state.idle_since = Some(self.host.now_ms());
        self.arm(&mut state, 0);
    }

    /// 用户发来消息（prompt，或 steer 进在跑的一轮）：每个 run 重新得到一对提醒。
    fn user_spoke(self: &Arc<Self>) {
        self.lock().sent.clear();
    }

    /// 这个 run 的开集变了（raised / resolved / reached / filled）：它重新得到一对提醒。会话正
    /// 闲着的话空闲钟也从此刻重起——否则一个已经闲了三小时的会话上，新的一对会因为「早就过了
    /// 15 分钟」而永远排不上。
    fn open_set_changed(self: &Arc<Self>, run_id: &str) {
        let mut state = self.lock();
        state.sent.remove(run_id);
        if state.stopped || state.idle_since.is_none() {
            return;
        }
        state.idle_since = Some(self.host.now_ms());
        self.arm(&mut state, 0);
    }

    /// 会话关闭：此后任何入口都不再排钟、不再发。
    fn stop(self: &Arc<Self>) {
        let mut state = self.lock();
        state.stopped = true;
        state.idle_since = None;
        self.disarm(&mut state);
    }

    /// 停钟 / 重排：epoch 自增作废在途的到点，宿主的定时器一并取消。
    fn disarm(self: &Arc<Self>, state: &mut ClockState) {
        state.epoch += 1;
        if let Some(timer) = state.timer.take() {
            self.host.cancel_timer(timer);
        }
    }

    /// 这个 run 下一次提醒要求的空闲时长；次数用完即 `None`。
    fn delay_for(state: &ClockState, delays: &[u64], run_id: &str) -> Option<u64> {
        delays.get(state.sent.get(run_id).copied().unwrap_or(0)).copied()
    }

    /// 此刻在飞的 run；顺手忘掉不再在飞的 run 的次数——同一个 id 之后被 resume 重臂是新的一世，
    /// 从第 1 次算起。
    fn live_runs(self: &Arc<Self>, state: &mut ClockState) -> Vec<String> {
        let live = self.host.live_run_ids();
        if !state.sent.is_empty() {
            let alive: std::collections::HashSet<&String> = live.iter().collect();
            state.sent.retain(|run_id, _| alive.contains(run_id));
        }
        live
    }

    /// 排下一个到点：在飞的 run 里、大于 `reached` 的最小延迟。没有就什么也不排。
    fn arm(self: &Arc<Self>, state: &mut ClockState, reached: u64) {
        self.disarm(state);
        let Some(idle_since) = state.idle_since else {
            return;
        };
        let mut next: Option<u64> = None;
        for run_id in self.live_runs(state) {
            let delay = Self::delay_for(state, &self.delays, &run_id);
            let Some(delay) = delay.filter(|delay| *delay > reached) else {
                continue;
            };
            if next.is_none_or(|current| delay < current) {
                next = Some(delay);
            }
        }
        let Some(target) = next else {
            return;
        };
        let epoch = state.epoch;
        let wait = idle_since.saturating_add(target).saturating_sub(self.host.now_ms());
        let clock = Arc::downgrade(self);
        let fire: BoxedFire = Box::new(move || {
            Box::pin(async move {
                if let Some(clock) = clock.upgrade() {
                    clock.expire(epoch, target).await;
                }
            })
        });
        state.timer = Some(self.host.schedule(wait, fire));
    }

    /// 空闲时长到了 `reached`：现读每个到期 run 的开集，仍开着的各发一条。
    async fn expire(self: Arc<Self>, epoch: u64, reached: u64) {
        {
            let mut state = self.lock();
            if state.epoch != epoch || state.stopped {
                return;
            }
            state.timer = None;
        }
        // 最后一道核对：钟应当已经被那一轮的开始停掉，这里只防接线漏了一处。
        if !self.host.is_idle() {
            return;
        }

        let mut due: Vec<(String, WorkflowOpenDecisions)> = Vec::new();
        let live = {
            let mut state = self.lock();
            self.live_runs(&mut state)
        };
        for run_id in live {
            let due_run = {
                let state = self.lock();
                Self::delay_for(&state, &self.delays, &run_id)
                    .filter(|delay| *delay <= reached)
            };
            if due_run.is_none() {
                continue;
            }
            match self.host.read_open(&run_id).await {
                Ok(Some(open)) if !open.questions.is_empty() || !open.holes.is_empty() => {
                    due.push((run_id, open));
                }
                Ok(_) => {}
                Err(error) => self.host.on_read_error(&run_id, &error),
            }
        }
        // 读快照期间来了一轮（或会话关了）：这次到点作废。那一轮要么自己带着通知，要么结束后
        // 重新起钟。
        if self.lock().epoch != epoch {
            return;
        }

        let now = self.host.now_ms();
        for (run_id, open) in due {
            let ordinal = {
                let mut state = self.lock();
                let ordinal = state.sent.get(&run_id).copied().unwrap_or(0) + 1;
                // 入队即计数，先记后发：`remind` 会同步唤起一轮并经 session_busy 停钟。
                state.sent.insert(run_id.clone(), ordinal);
                ordinal
            };
            self.host.remind(WorkflowBlockedReminder {
                run_id,
                open,
                ordinal,
                total: self.delays.len(),
                now,
            });
        }
        // 没有一轮因此开始（没有到期且仍开着的，或通知被入口丢了）：排更晚的那个延迟，若有。
        if self.lock().epoch == epoch {
            let mut state = self.lock();
            self.arm(&mut state, reached);
        }
    }
}

/// 「主代理闲着、run 还欠着决定」的提醒钟。可克隆（到点回调拿的是同一份 `Arc` 本体）；
/// 纯状态机——量的字段与三条纪律见模块注释。
pub struct WorkflowBlockedReminderClock<H: WorkflowBlockedReminderHost>(Arc<ClockCore<H>>);

impl<H: WorkflowBlockedReminderHost> Clone for WorkflowBlockedReminderClock<H> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<H: WorkflowBlockedReminderHost> WorkflowBlockedReminderClock<H> {
    pub fn new(host: Arc<H>) -> Self {
        Self::with_delays(host, WORKFLOW_BLOCKED_REMINDER_DELAYS_MS.to_vec())
    }

    /// 测试注入更短的延迟档（Node 构造函数第二参的同一缝）。
    pub fn with_delays(host: Arc<H>, delays: Vec<u64>) -> Self {
        Self(Arc::new(ClockCore {
            host,
            delays,
            state: Mutex::new(ClockState {
                sent: HashMap::new(),
                idle_since: None,
                timer: None,
                epoch: 0,
                stopped: false,
            }),
        }))
    }

    /// 一轮开始（任何来源）：钟停，空闲时长作废。
    pub fn session_busy(&self) {
        self.0.session_busy();
    }

    /// 命令队列排空：空闲段从现在起算（已在空闲段里是 no-op）。
    pub fn session_idle(&self) {
        self.0.session_idle();
    }

    /// 用户发来消息：每个 run 重新得到一对提醒。
    pub fn user_spoke(&self) {
        self.0.user_spoke();
    }

    /// 这个 run 的开集变了：它重新得到一对提醒（会话闲着时空闲钟从此刻重起）。
    pub fn open_set_changed(&self, run_id: &str) {
        self.0.open_set_changed(run_id);
    }

    /// 会话关闭：此后任何入口都不再排钟、不再发。
    pub fn stop(&self) {
        self.0.stop();
    }
}

// ============================================================
// 提醒文案（Node formatWorkflowBlockedNotification 逐字）
// ============================================================

/// 提醒里各列多少个决定；超出的经 `count` ≠ `shown` 说真话，全量在 GetWorkflowRun。
const WORKFLOW_BLOCKED_MAX_LISTED: usize = 8;
/// 提醒里问题 / 上下文正文的界（原通知是 4000；这里是汇总，原文已在历史里）。
const WORKFLOW_BLOCKED_TEXT_MAX_CHARS: usize = 2_000;
/// 终态通知族的截断上界（Node `TASK_NOTIFICATION_MAX_CHARS`）。
const TASK_NOTIFICATION_MAX_CHARS: usize = 120_000;
const MS_PER_MINUTE: u64 = 60_000;

/// run 中通知共用的抬头：让模型不把系统通知读成用户输入。
const SYSTEM_NOTIFICATION_BANNER: [&str; 4] = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated workflow event, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
];

pub struct WorkflowBlockedNoticeInput {
    pub run_label: String,
    pub run_id: String,
    /// 第几次提醒（1 起）与上限。
    pub ordinal: usize,
    pub total: usize,
    /// 铸造时刻（epoch ms）；每个决定的等待时长都以它为准。
    pub now: u64,
    pub questions: Vec<WorkflowBlockedQuestion>,
    /// 只含还在等的留白。
    pub holes: Vec<WorkflowBlockedHole>,
    pub draft_path: Option<String>,
}

fn bound_blocked_text(value: &str) -> String {
    if value.chars().count() <= WORKFLOW_BLOCKED_TEXT_MAX_CHARS {
        return value.to_owned();
    }
    let head: String = value.chars().take(WORKFLOW_BLOCKED_TEXT_MAX_CHARS - 1).collect();
    format!("{head}…")
}

fn waited_ms(now: u64, since: Option<u64>) -> u64 {
    since.map_or(0, |since| now.saturating_sub(since))
}

fn count_noun(count: usize, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

/// 主代理闲着、run 还欠着决定时的提醒。与升级 / 留白那两条的差别：它们各播报**一个**新出现的
/// 义务，这条按 run 汇总**此刻仍开着的全部**义务——因为发它的前提正是「先前那一轮没有把事办了」。
pub fn format_workflow_blocked_notification(input: &WorkflowBlockedNoticeInput) -> String {
    let run_id = &input.run_id;
    let mut lines: Vec<String> = SYSTEM_NOTIFICATION_BANNER
        .iter()
        .map(std::string::ToString::to_string)
        .collect();
    lines.push("<workflow-blocked>".to_owned());
    lines.push(format!("  <run-id>{}</run-id>", escape_xml(run_id)));
    lines.push(format!("  <run>{}</run>", escape_xml(&input.run_label)));
    lines.push(format!("  <reminder>{} of {}</reminder>", input.ordinal, input.total));
    let shown_questions: Vec<_> = input
        .questions
        .iter()
        .take(WORKFLOW_BLOCKED_MAX_LISTED)
        .collect();
    if !input.questions.is_empty() {
        lines.push(format!(
            "  <open-questions count=\"{}\" shown=\"{}\">",
            input.questions.len(),
            shown_questions.len()
        ));
        for question in &shown_questions {
            // 匿名子代理落到结构化引用，与升级通知同一条兜底链。
            let subagent = question.actor_name.as_deref().unwrap_or(&question.actor);
            lines.push(format!(
                "    <question id=\"{}\" subagent=\"{}\" waited-ms=\"{}\">",
                escape_xml(&question.qid),
                escape_xml(subagent),
                waited_ms(input.now, question.asked_at)
            ));
            lines.push(format!(
                "      <text>{}</text>",
                escape_xml(&bound_blocked_text(&question.question))
            ));
            if let Some(context) = question.context.as_deref().filter(|c| !c.is_empty()) {
                lines.push(format!(
                    "      <context>{}</context>",
                    escape_xml(&bound_blocked_text(context))
                ));
            }
            lines.push("    </question>".to_owned());
        }
        lines.push("  </open-questions>".to_owned());
    }
    let shown_holes: Vec<_> = input.holes.iter().take(WORKFLOW_BLOCKED_MAX_LISTED).collect();
    if !input.holes.is_empty() {
        lines.push(format!(
            "  <open-holes count=\"{}\" shown=\"{}\">",
            input.holes.len(),
            shown_holes.len()
        ));
        for hole in &shown_holes {
            let line = hole.line.map_or(String::new(), |line| format!(" line=\"{line}\""));
            lines.push(format!(
                "    <hole id=\"{}\" name=\"{}\" type=\"{}\"{} waited-ms=\"{}\"/>",
                escape_xml(&hole.site_id),
                escape_xml(&hole.name),
                escape_xml(&hole.hole_type),
                line,
                waited_ms(input.now, hole.since)
            ));
        }
        lines.push("  </open-holes>".to_owned());
    }
    if let Some(draft) = &input.draft_path {
        lines.push(format!("  <draft>{}</draft>", escape_xml(draft)));
    }
    lines.push("</workflow-blocked>".to_owned());
    lines.push(String::new());

    let total = input.questions.len() + input.holes.len();
    let oldest = input
        .questions
        .iter()
        .map(|question| waited_ms(input.now, question.asked_at))
        .chain(input.holes.iter().map(|hole| waited_ms(input.now, hole.since)))
        .max()
        .unwrap_or(0);
    let minutes = (oldest / MS_PER_MINUTE + u64::from(oldest % MS_PER_MINUTE * 2 >= MS_PER_MINUTE)).max(1);
    let what = [
        (!input.questions.is_empty())
            .then(|| count_noun(input.questions.len(), "question")),
        (!input.holes.is_empty()).then(|| count_noun(input.holes.len(), "hole")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" and ");
    lines.push(if total == 1 {
        format!(
            "Workflow run {} ({}) is still waiting on you: {what} is open, for {minutes} minutes, and you have not acted on it since your last turn ended.",
            input.run_label, run_id
        )
    } else {
        format!(
            "Workflow run {} ({}) is still waiting on you: {what} are open, the oldest for {minutes} minutes, and you have not acted on them since your last turn ended.",
            input.run_label, run_id
        )
    });
    if !input.questions.is_empty() {
        lines.push(
            "Next step for each question: call ResolveWorkflowQuestion with its id as question_id and your answer."
                .to_owned(),
        );
    }
    if !input.holes.is_empty() {
        let context = input.draft_path.as_deref().map_or_else(
            || format!("read the run's script with GetWorkflowRun (run_id=\"{run_id}\")"),
            |draft| format!("read the draft at {draft}"),
        );
        lines.push(format!(
            "Next step for each hole: {context} for the context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id=\"{run_id}\" and its id as hole_id and the body as `script`."
        ));
    }
    if input.questions.len() > shown_questions.len() || input.holes.len() > shown_holes.len() {
        lines.push(format!(
            "GetWorkflowRun lists the ones not shown here (run_id=\"{run_id}\")."
        ));
    }
    lines.push(
        "If a decision needs the user, tell the user exactly what you need from them and end your turn; do not guess an answer to make the reminders stop."
            .to_owned(),
    );
    lines.push(if input.ordinal < input.total {
        "One more reminder follows if nothing changes.".to_owned()
    } else {
        "This is the last reminder: nothing further is sent until the user writes or this run's open decisions change.".to_owned()
    });
    lines.push(
        "Either way the parked branches keep waiting; nothing times out on their behalf."
            .to_owned(),
    );
    truncate_task_notification(lines.join("\n"))
}

/// `escapeXml`（Node runtime-task/notification.ts 同一实现：五个 XML 元字符）。
fn escape_xml(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
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

/// `truncateTaskNotification`：超界截断并加 `[truncated]` 行（终态通知族同一条尺）。
fn truncate_task_notification(value: String) -> String {
    if value.chars().count() <= TASK_NOTIFICATION_MAX_CHARS {
        return value;
    }
    let head: String = value.chars().take(TASK_NOTIFICATION_MAX_CHARS).collect();
    format!("{head}\n[truncated]")
}

#[cfg(test)]
#[path = "blocked_tests.rs"]
mod tests;

//! CronCreate / CronDelete / CronList（docs/specs/rust-cli/tools-more.md §10.2）。
//!
//! 工具只改任务表（[`CronBoard`]），任务记在顶层会话名下（`Interactions::owner_session`，前台子代理
//! 转给父会话）。触发由会话 actor 在空闲时取走到期任务（§10.4）。`durable: true` 的任务写进
//! `.nibi/scheduled_tasks.json`（§16）；计数、删除校验与列出每次重读文件。

use async_trait::async_trait;
use nibi_kernel_api::cron_store::{CronScheduleRule, CronScheduleUnit, NewCronTask};
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::permission::{PermissionDecision, PermissionMode};
use nibi_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation,
};
use nibi_kernel_base::names::{DOT_DIR, SCHEDULED_TASKS_FILE};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::common::{Definition, definition, parse};
use crate::cron_board::{CronBoard, MAX_JOBS};
use crate::cron_expr;
use crate::cron_rule;

pub const CREATE: &str = "CronCreate";
pub const DELETE: &str = "CronDelete";
pub const LIST: &str = "CronList";
pub const UPDATE: &str = "CronUpdate";

/// CronCreate 结果的两种说明之一（另一种 `Persisted to
/// .nibi/scheduled_tasks.json` 在结果里用共用的名字拼）。产品名按替换规则换成 NIBI（2026-10-18 用户确认、2026-11-05 品牌化批次统一，
/// tools-more.md §10.2），路径取产品目录 `.nibi`，其余逐字。
const SESSION_ONLY: &str = "Session-only (not written to disk, dies when NIBI exits)";

pub(crate) async fn owner(context: &ToolUseContext) -> SessionId {
    context.interactions.owner_session(&context.session).await
}

/// 任务 ID：取这次调用的操作 ID（`op_<uuid>`）里 uuid 的前 8 位。
pub(crate) fn job_id(context: &ToolUseContext) -> String {
    let operation = context.operation.operation.as_str();
    let uuid = operation.rsplit('_').next().unwrap_or(operation);
    uuid.chars().take(8).collect()
}

pub(crate) fn output(content: String, display: Value) -> ToolOutput {
    let mut output = crate::common::text(content);
    output.display = display;
    output
}

/// 三个工具共有的部分：定义、任务表、延迟加载与提示词。
pub(crate) struct Shared {
    pub(crate) definition: Definition,
    pub(crate) board: CronBoard,
    pub(crate) hint: &'static str,
}

impl Shared {
    fn new(name: &str, board: &CronBoard, hint: &'static str) -> Self {
        Self {
            definition: definition(name),
            board: board.clone(),
            hint,
        }
    }
}

/// 三个 cron 工具（按工具池的顺序）。`monitor`：Monitor 开着时 CronCreate 的描述在 `## Runtime behavior` 之前多
/// “Not for live watching” 一节（工作线 F83，tools-more.md §19.9）。
pub fn cron_tools(board: &CronBoard, monitor: bool) -> Vec<std::sync::Arc<dyn Tool>> {
    let mut create = Shared::new(CREATE, board, "schedule a recurring or one-shot prompt");
    if monitor {
        const ANCHOR: &str = "## Runtime behavior";
        create.definition.description = create.definition.description.replacen(
            ANCHOR,
            &format!(
                "{}\n\n{ANCHOR}",
                nibi_kernel_prompts::monitor::cron_create_section()
            ),
            1,
        );
    }
    vec![
        std::sync::Arc::new(CronCreateTool(create)),
        std::sync::Arc::new(CronDeleteTool(Shared::new(
            DELETE,
            board,
            "cancel a scheduled cron job",
        ))),
        std::sync::Arc::new(CronUpdateTool(Shared::new(
            UPDATE,
            board,
            "update an existing scheduled cron job",
        ))),
        std::sync::Arc::new(crate::cron_list::CronListTool(Shared::new(
            LIST,
            board,
            "list active cron jobs",
        ))),
    ]
}

macro_rules! shared_tool_methods {
    () => {
        fn input_schema(&self) -> Value {
            self.0.definition.schema.clone()
        }

        fn description(&self, _context: &PromptContext) -> String {
            self.0.definition.description.clone()
        }

        fn should_defer(&self) -> bool {
            true
        }

        fn search_hint(&self) -> Option<&str> {
            Some(self.0.hint)
        }

        fn max_result_size_chars(&self) -> Option<usize> {
            Some(100_000)
        }
    };
}
pub(crate) use shared_tool_methods;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    #[serde(default)]
    cron: Option<String>,
    prompt: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    recurring: Option<bool>,
    #[serde(default)]
    durable: Option<bool>,
    #[serde(default)]
    max_runs: Option<u32>,
    #[serde(default)]
    delay_minutes: Option<u32>,
    #[serde(default)]
    interval_unit: Option<CronScheduleUnit>,
    #[serde(default)]
    interval: Option<u32>,
}

/// 一个任务的完整调度事实（读现有会话任务或持久任务）。
#[derive(Clone)]
struct Current {
    cron: String,
    prompt: String,
    recurring: bool,
    title: Option<String>,
    max_runs: Option<u32>,
    run_count: u32,
    schedule_rule: Option<CronScheduleRule>,
    fire_at: Option<u64>,
}

/// `delayMinutes` 的一次性触发时刻。
fn delay_fire_at(now: u64, minutes: u32) -> u64 {
    now.saturating_add(u64::from(minutes) * 60_000)
}

/// 延迟任务的兼容 cron（本地时间的固定日历；调度以 `fireAt` 为准）。
pub(crate) fn delay_cron(at: u64, offset: &dyn Fn(u64) -> i32) -> String {
    let (_, month, day, hour, minute, _) = cron_expr::local_parts(at, offset);
    format!("{minute} {hour} {day} {month} *")
}

fn human(cron: &str, rule: Option<&CronScheduleRule>, delay_minutes: Option<u32>) -> String {
    if let Some(minutes) = delay_minutes {
        return format!("In {minutes} minutes");
    }
    if let Some(rule) = rule {
        return cron_rule::human(rule);
    }
    cron_expr::human(cron)
}

/// 一次性相对任务的展示写法（列表里没有原始分钟数时用确切时刻）。
pub(crate) fn human_at(at: u64, offset: &dyn Fn(u64) -> i32) -> String {
    let (_, month, day, hour, minute, _) = cron_expr::local_parts(at, offset);
    format!(
        "Once at {} on {month}/{day}",
        cron_expr::clock_time(minute, hour)
    )
}

/// 校验 create 的组合约束；合法时返回规范化的调度事实。
struct Resolved {
    cron: String,
    recurring: bool,
    schedule_rule: Option<CronScheduleRule>,
    fire_at: Option<u64>,
    delay_minutes: Option<u32>,
}

#[allow(clippy::too_many_lines)]
fn resolve_create(
    input: &CreateInput,
    now: u64,
    offset: &dyn Fn(u64) -> i32,
) -> Result<Resolved, Validation> {
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty());
    if input.title.is_some() && title.is_none() {
        return Err(coded("title must not be empty.".to_owned(), 4));
    }
    if let Some(minutes) = input.delay_minutes {
        if minutes == 0 || minutes > 525_600 {
            return Err(coded(
                "delayMinutes must be an integer from 1 to 525600.".to_owned(),
                4,
            ));
        }
        if input.cron.is_some() {
            return Err(coded(
                "a relative delay must omit cron; the host computes the schedule from its real clock"
                    .to_owned(),
                4,
            ));
        }
        if input.recurring == Some(true) {
            return Err(coded(
                "a relative delay creates a one-shot automation and cannot use recurring=true"
                    .to_owned(),
                4,
            ));
        }
        if input.max_runs.is_some() {
            return Err(coded(
                "a relative delay runs once and cannot use maxRuns".to_owned(),
                4,
            ));
        }
        if input.interval_unit.is_some() || input.interval.is_some() {
            return Err(coded(
                "intervalUnit cannot combine with a relative delayMinutes".to_owned(),
                4,
            ));
        }
        let fire_at = delay_fire_at(now, minutes);
        return Ok(Resolved {
            cron: delay_cron(fire_at, offset),
            recurring: false,
            schedule_rule: None,
            fire_at: Some(fire_at),
            delay_minutes: Some(minutes),
        });
    }
    let Some(cron) = input.cron.as_deref() else {
        return Err(coded(
            "cron is required when delayMinutes is not set".to_owned(),
            4,
        ));
    };
    let has_unit = input.interval_unit.is_some();
    let has_interval = input.interval.is_some();
    if has_unit != has_interval {
        return Err(coded(
            "intervalUnit and interval must be set together".to_owned(),
            4,
        ));
    }
    if has_unit {
        let interval = input.interval.unwrap_or(0);
        if !(1..=200).contains(&interval) {
            return Err(coded(
                "interval must be an integer from 1 to 200.".to_owned(),
                4,
            ));
        }
    }
    let recurring = if has_unit {
        if input.recurring == Some(false) {
            return Err(coded(
                "intervalUnit is a recurring carrier and requires recurring=true".to_owned(),
                4,
            ));
        }
        if input.max_runs.is_some() {
            return Err(coded(
                "intervalUnit is a recurring carrier and cannot combine with maxRuns".to_owned(),
                4,
            ));
        }
        true
    } else {
        if let Some(max_runs) = input.max_runs
            && max_runs == 0
        {
            return Err(coded("maxRuns must be a positive integer.".to_owned(), 4));
        }
        input.recurring.unwrap_or(true)
    };
    if recurring && input.max_runs.is_some() {
        return Err(coded(
            "recurring=true is indefinite and must not be combined with maxRuns.".to_owned(),
            4,
        ));
    }
    if cron_expr::parse(cron).is_none() {
        return Err(coded(
            format!("Invalid cron expression '{cron}'. Expected 5 fields: M H DoM Mon DoW."),
            1,
        ));
    }
    let rule = input
        .interval_unit
        .map(|unit| cron_rule::from_cron(unit, input.interval.unwrap_or(1), cron, now, offset));
    Ok(Resolved {
        cron: cron.to_owned(),
        recurring,
        schedule_rule: rule,
        fire_at: None,
        delay_minutes: None,
    })
}

pub struct CronCreateTool(Shared);

#[async_trait]
impl Tool for CronCreateTool {
    fn name(&self) -> &str {
        CREATE
    }

    shared_tool_methods!();

    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        let Ok(input) = parse::<CreateInput>(input) else {
            return Validation::Ok;
        };
        let board = &self.0.board;
        let now = board.now_ms();
        let offset = board.offset();
        let resolved = match resolve_create(&input, now, &offset) {
            Ok(resolved) => resolved,
            Err(validation) => return validation,
        };
        if resolved.fire_at.is_none() {
            let next = match resolved.schedule_rule.as_ref() {
                Some(rule) => cron_rule::next(rule, now, &offset),
                None => cron_expr::next_after(&resolved.cron, now, &offset),
            };
            if next.is_none() {
                return coded(
                    format!(
                        "Cron expression '{}' does not match any calendar date in the next year.",
                        resolved.cron
                    ),
                    2,
                );
            }
        }
        let total = board.read_durable().await.len() + board.session_count(&owner(context).await);
        if total >= MAX_JOBS {
            return coded(
                format!("Too many scheduled jobs (max {MAX_JOBS}). Cancel one first."),
                3,
            );
        }
        Validation::Ok
    }

    /// auto 模式交给分类器（passthrough），其余直接放行。
    async fn check_permissions(
        &self,
        _input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        if context.mode == PermissionMode::Auto {
            return PermissionDecision::Passthrough;
        }
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
        let input: CreateInput = parse(&input)?;
        let board = &self.0.board;
        let resolved =
            resolve_create(&input, board.now_ms(), &board.offset()).map_err(|error| {
                ToolError::InvalidInput {
                    message: match error {
                        Validation::Invalid { message, .. } => message,
                        Validation::Ok => "invalid CronCreate input".to_owned(),
                    },
                }
            })?;
        let title = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_owned);
        let id = job_id(&context);
        let owner = owner(&context).await;
        let durable = input.durable.unwrap_or(false)
            && board
                .add_durable(NewCronTask {
                    id: id.clone(),
                    cron: resolved.cron.clone(),
                    prompt: input.prompt.clone(),
                    created_at: board.now_ms(),
                    recurring: resolved.recurring,
                    created_by: owner.clone(),
                    title: title.clone(),
                    max_runs: input.max_runs,
                    schedule_rule: resolved.schedule_rule.clone(),
                    fire_at: resolved.fire_at,
                })
                .await
                .map_err(|message| ToolError::Failed { message })?;
        if !durable {
            board.add_with(
                &owner,
                id.clone(),
                &resolved.cron,
                &input.prompt,
                resolved.recurring,
                title.clone(),
                input.max_runs,
                resolved.schedule_rule.clone(),
                resolved.fire_at,
            );
        }
        let human = human(
            &resolved.cron,
            resolved.schedule_rule.as_ref(),
            resolved.delay_minutes,
        );
        // 落盘的位置取共用的名字（F55，与 env-local 的定时任务存储同一个文件）；文字不变。
        let note = if durable {
            format!("Persisted to {DOT_DIR}/{SCHEDULED_TASKS_FILE}")
        } else {
            SESSION_ONLY.to_owned()
        };
        let titled = title
            .as_deref()
            .map(|title| format!(" — title: {title}"))
            .unwrap_or_default();
        let text = if let Some(max_runs) = input.max_runs {
            format!(
                "Scheduled job {id} ({human}){titled}. {note}. It will fire up to {max_runs} times then auto-delete."
            )
        } else if resolved.recurring {
            let expiry = if resolved.schedule_rule.is_some() {
                "It repeats on its saved interval. Use CronDelete to cancel sooner."
            } else {
                "Auto-expires after 7 days. Use CronDelete to cancel sooner."
            };
            format!("Scheduled recurring job {id} ({human}){titled}. {note}. {expiry}")
        } else {
            format!(
                "Scheduled one-shot task {id} ({human}){titled}. {note}. It will fire once then auto-delete."
            )
        };
        let display = json!({
            "id": id,
            "title": title,
            "humanSchedule": human,
            "recurring": resolved.recurring,
            "durable": durable,
            "maxRuns": input.max_runs,
            "scheduleRule": resolved.schedule_rule,
            "fireAt": resolved.fire_at,
        });
        Ok(output(text, display))
    }
}

pub(crate) fn coded(message: String, code: i32) -> Validation {
    Validation::Invalid {
        message,
        error_code: Some(code),
    }
}

#[derive(Deserialize)]
struct DeleteInput {
    id: String,
}

pub struct CronDeleteTool(Shared);

#[async_trait]
impl Tool for CronDeleteTool {
    fn name(&self) -> &str {
        DELETE
    }

    shared_tool_methods!();

    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        let Ok(input) = parse::<DeleteInput>(input) else {
            return Validation::Ok;
        };
        let board = &self.0.board;
        let known = board.has_session_job(&owner(context).await, &input.id)
            || board
                .read_durable()
                .await
                .iter()
                .any(|task| task.id == input.id);
        if !known {
            return coded(format!("No scheduled job with id '{}'", input.id), 1);
        }
        Validation::Ok
    }

    /// 没有专属的权限检查，默认放行。
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
        let input: DeleteInput = parse(&input)?;
        self.0
            .board
            .delete(&owner(&context).await, &input.id)
            .await
            .map_err(|message| ToolError::Failed { message })?;
        Ok(output(
            format!("Cancelled job {}.", input.id),
            json!({"id": input.id}),
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInput {
    id: String,
    #[serde(default)]
    cron: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    recurring: Option<bool>,
    /// 缺省 = 不改；`null` = 清除；整数 = 设为该上限。
    #[serde(default)]
    max_runs: Option<Value>,
    #[serde(default)]
    interval_unit: Option<CronScheduleUnit>,
    #[serde(default)]
    interval: Option<u32>,
}

impl UpdateInput {
    fn has_field(&self) -> bool {
        self.cron.is_some()
            || self.prompt.is_some()
            || self.title.is_some()
            || self.recurring.is_some()
            || self.max_runs.is_some()
            || self.interval_unit.is_some()
            || self.interval.is_some()
    }
}

/// 现有任务的完整调度事实（会话任务优先，其次文件里的持久任务）。
async fn current(board: &CronBoard, owner: &SessionId, id: &str) -> Option<Current> {
    if let Some(job) = board
        .session_jobs(owner)
        .into_iter()
        .find(|job| job.id == id)
    {
        return Some(Current {
            cron: job.cron,
            prompt: job.prompt,
            recurring: job.recurring,
            title: job.title,
            max_runs: job.max_runs,
            run_count: job.run_count,
            schedule_rule: job.schedule_rule,
            fire_at: job.fire_at,
        });
    }
    board
        .read_durable()
        .await
        .into_iter()
        .find(|task| task.id == id)
        .map(|task| Current {
            cron: task.cron,
            prompt: task.prompt,
            recurring: task.recurring,
            title: task.title,
            max_runs: task.max_runs,
            run_count: task.run_count,
            schedule_rule: task.schedule_rule,
            fire_at: task.fire_at,
        })
}

enum MaxRunsPatch {
    Keep,
    Clear,
    Set(u32),
}

fn resolve_update(
    input: &UpdateInput,
    current: &Current,
    now: u64,
    offset: &dyn Fn(u64) -> i32,
) -> Result<Current, Validation> {
    if !input.has_field() {
        return Err(coded(
            "CronUpdate requires at least one field to update".to_owned(),
            4,
        ));
    }
    let has_unit = input.interval_unit.is_some();
    let has_interval = input.interval.is_some();
    if has_unit != has_interval {
        return Err(coded(
            "intervalUnit and interval must be set together".to_owned(),
            4,
        ));
    }
    if has_unit {
        let interval = input.interval.unwrap_or(0);
        if !(1..=200).contains(&interval) {
            return Err(coded(
                "interval must be an integer from 1 to 200.".to_owned(),
                4,
            ));
        }
    }
    let patch = match input.max_runs.as_ref() {
        None => MaxRunsPatch::Keep,
        Some(Value::Null) => MaxRunsPatch::Clear,
        Some(Value::Number(number)) => {
            let Some(value) = number.as_u64().and_then(|value| u32::try_from(value).ok()) else {
                return Err(coded("maxRuns must be a positive integer.".to_owned(), 4));
            };
            if value == 0 {
                return Err(coded("maxRuns must be a positive integer.".to_owned(), 4));
            }
            MaxRunsPatch::Set(value)
        }
        Some(_) => {
            return Err(coded(
                "maxRuns must be a positive integer or null.".to_owned(),
                4,
            ));
        }
    };
    if matches!(patch, MaxRunsPatch::Clear) && input.recurring != Some(true) {
        return Err(coded(
            "Clearing maxRuns requires recurring=true in the same update".to_owned(),
            4,
        ));
    }
    let next_recurring = if has_unit {
        if input.recurring == Some(false) {
            return Err(coded(
                "intervalUnit is a recurring carrier and cannot combine with recurring=false"
                    .to_owned(),
                4,
            ));
        }
        if matches!(patch, MaxRunsPatch::Set(_)) {
            return Err(coded(
                "intervalUnit is a recurring carrier and cannot combine with a numeric maxRuns"
                    .to_owned(),
                4,
            ));
        }
        true
    } else {
        input.recurring.unwrap_or(current.recurring)
    };
    if next_recurring && matches!(patch, MaxRunsPatch::Set(_)) {
        return Err(coded(
            "recurring=true cannot be combined with a numeric maxRuns".to_owned(),
            4,
        ));
    }
    let cron = input.cron.clone().unwrap_or_else(|| current.cron.clone());
    if input.cron.is_some() && cron_expr::parse(&cron).is_none() {
        return Err(coded(
            format!("Invalid cron expression '{cron}'. Expected 5 fields: M H DoM Mon DoW."),
            2,
        ));
    }
    let title = match input.title.as_deref() {
        None => current.title.clone(),
        Some(title) => {
            let title = title.trim();
            if title.is_empty() {
                return Err(coded("title must not be empty.".to_owned(), 4));
            }
            Some(title.to_owned())
        }
    };
    let cron_changed = input
        .cron
        .as_deref()
        .is_some_and(|cron| cron != current.cron);
    let max_runs = if has_unit {
        None
    } else {
        match patch {
            MaxRunsPatch::Clear => None,
            MaxRunsPatch::Set(value) => Some(value),
            // 只切换 recurring=true 时清掉旧上限（Node 领域层同一归一化）。
            MaxRunsPatch::Keep if input.recurring == Some(true) => None,
            MaxRunsPatch::Keep => current.max_runs,
        }
    };
    let schedule_rule = if let Some(unit) = input.interval_unit {
        Some(cron_rule::from_cron(
            unit,
            input.interval.unwrap_or(1),
            &cron,
            now,
            offset,
        ))
    } else if cron_changed {
        // cron 变了而没有 carrier：旧规则不能继续覆盖新 cron（Node 同一口径）。
        None
    } else {
        current.schedule_rule.clone()
    };
    let fire_at = if input.cron.is_some() || has_unit {
        None
    } else {
        current.fire_at
    };
    let next = match schedule_rule.as_ref() {
        Some(rule) => cron_rule::next(rule, now, offset),
        None => cron_expr::next_after(&cron, now, offset),
    };
    if next.is_none() {
        return Err(coded(
            format!("Cron expression '{cron}' does not match any calendar date in the next year."),
            3,
        ));
    }
    Ok(Current {
        cron,
        prompt: input
            .prompt
            .clone()
            .unwrap_or_else(|| current.prompt.clone()),
        recurring: next_recurring,
        title,
        max_runs,
        run_count: current.run_count,
        schedule_rule,
        fire_at,
    })
}

pub struct CronUpdateTool(Shared);

#[async_trait]
impl Tool for CronUpdateTool {
    fn name(&self) -> &str {
        UPDATE
    }

    shared_tool_methods!();

    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        let Ok(input) = parse::<UpdateInput>(input) else {
            return Validation::Ok;
        };
        let board = &self.0.board;
        let owner = owner(context).await;
        let Some(existing) = current(board, &owner, &input.id).await else {
            return coded(format!("No scheduled job with id '{}'", input.id), 1);
        };
        match resolve_update(&input, &existing, board.now_ms(), &board.offset()) {
            Ok(_) => Validation::Ok,
            Err(validation) => validation,
        }
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        if context.mode == PermissionMode::Auto {
            return PermissionDecision::Passthrough;
        }
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
        let input: UpdateInput = parse(&input)?;
        let board = &self.0.board;
        let owner = owner(&context).await;
        let Some(existing) = current(board, &owner, &input.id).await else {
            return Err(ToolError::Failed {
                message: format!("No scheduled job with id '{}'", input.id),
            });
        };
        let next = resolve_update(&input, &existing, board.now_ms(), &board.offset()).map_err(
            |error| ToolError::InvalidInput {
                message: match error {
                    Validation::Invalid { message, .. } => message,
                    Validation::Ok => "invalid CronUpdate input".to_owned(),
                },
            },
        )?;
        if !board
            .update(
                &owner,
                &input.id,
                &next.cron,
                &next.prompt,
                next.recurring,
                next.title.clone(),
                next.max_runs,
                next.schedule_rule.clone(),
                next.fire_at,
            )
            .await
            .map_err(|message| ToolError::Failed { message })?
        {
            return Err(ToolError::Failed {
                message: format!("No scheduled job with id '{}'", input.id),
            });
        }
        let human = human(&next.cron, next.schedule_rule.as_ref(), None);
        let titled = next
            .title
            .as_deref()
            .map(|title| format!(" — title: {title}"))
            .unwrap_or_default();
        Ok(output(
            format!("Updated job {} ({human}){titled}.", input.id),
            json!({
                "id": input.id,
                "title": next.title,
                "humanSchedule": human,
                "recurring": next.recurring,
                "maxRuns": next.max_runs,
                "scheduleRule": next.schedule_rule,
                "fireAt": next.fire_at,
            }),
        ))
    }
}

#[cfg(test)]
#[path = "cron_tools_tests.rs"]
mod tests;

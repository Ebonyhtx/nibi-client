use std::sync::Arc;

use nibi_kernel_api::ids::OperationId;
use nibi_kernel_api::permission::{PermissionDecision, PermissionMode};
use nibi_kernel_api::testing::{FixedClock, ScriptedInteractions};
use nibi_kernel_api::tool::{PromptContext, Tool, ToolUseContext, Validation};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use nibi_kernel_api::ids::SessionId;

use super::*;
use crate::test_more::{Ctx, output_text};

/// 2026-10-17T10:07:30Z。
const NOW: u64 = 1_792_231_650_000;

fn board() -> CronBoard {
    CronBoard::new(Arc::new(FixedClock(NOW)), None)
}

fn context(operation: &str, mode: PermissionMode) -> ToolUseContext {
    let mut ctx = Ctx::new(Arc::new(ScriptedInteractions::default()));
    ctx.mode = mode;
    let mut context = ctx.build();
    context.operation.operation = OperationId::new(operation);
    context
}

fn tool(board: &CronBoard, name: &str) -> Arc<dyn Tool> {
    cron_tools(board, false)
        .into_iter()
        .find(|tool| tool.name() == name)
        .unwrap_or_else(|| panic!("{name}"))
}

async fn call(tool: &Arc<dyn Tool>, input: Value, context: ToolUseContext) -> String {
    let (progress, _rx) = mpsc::channel(1);
    let output = tool
        .call(input, context, progress)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    output_text(&output)
}

fn error(validation: Validation) -> (String, Option<i32>) {
    match validation {
        Validation::Invalid {
            message,
            error_code,
        } => (message, error_code),
        Validation::Ok => panic!("expected an error"),
    }
}

#[test]
fn definitions_are_deferred_with_search_hints() {
    let board = board();
    let prompt = PromptContext {
        tool_names: Vec::new(),
        mode: PermissionMode::Default,
    };
    for (tool, hint) in cron_tools(&board, false).iter().zip([
        "schedule a recurring or one-shot prompt",
        "cancel a scheduled cron job",
        "update an existing scheduled cron job",
        "list active cron jobs",
    ]) {
        assert!(tool.should_defer());
        assert_eq!(tool.search_hint(), Some(hint));
        assert!(!tool.description(&prompt).is_empty(), "{}", tool.name());
        assert_eq!(tool.input_schema()["additionalProperties"], json!(false));
    }
    let create = tool(&board, CREATE).description(&prompt);
    assert!(create.starts_with("Schedule a prompt to be enqueued at a future time."));
    // 持久任务打开时的文本（tools-more.md §16.6，D17 取消）。
    assert!(create.contains("## Durability"));
    assert!(create.contains("Pass durable: true to write to .nibi/scheduled_tasks.json"));
    let schema = tool(&board, CREATE).input_schema();
    assert!(
        schema["properties"]["durable"]["description"]
            .as_str()
            .unwrap()
            .starts_with("true = persist to .nibi/scheduled_tasks.json")
    );
}

#[tokio::test]
async fn create_validates_its_input() {
    let board = board();
    let create = tool(&board, CREATE);
    let ctx = context("op_1", PermissionMode::Default);
    let check = |cron: &str| json!({"cron": cron, "prompt": "p"});
    assert_eq!(
        error(create.validate_input(&check("* * * *"), &ctx).await),
        (
            "Invalid cron expression '* * * *'. Expected 5 fields: M H DoM Mon DoW.".to_owned(),
            Some(1)
        )
    );
    assert_eq!(
        error(create.validate_input(&check("30 2 31 2 *"), &ctx).await),
        (
            "Cron expression '30 2 31 2 *' does not match any calendar date in the next year."
                .to_owned(),
            Some(2)
        )
    );
    for index in 0..MAX_JOBS {
        board.add(
            &ctx.session,
            format!("{index:08x}"),
            "*/5 * * * *",
            "p",
            true,
        );
    }
    assert_eq!(
        error(create.validate_input(&check("*/5 * * * *"), &ctx).await),
        (
            "Too many scheduled jobs (max 50). Cancel one first.".to_owned(),
            Some(3)
        )
    );
}

#[tokio::test]
async fn create_reports_the_job_and_lists_it() {
    let board = board();
    let create = tool(&board, CREATE);
    let op = "op_1a2b3c4d-0000-4000-8000-000000000000";
    let text = call(
        &create,
        json!({"cron": "*/5 * * * *", "prompt": "check the deploy"}),
        context(op, PermissionMode::Default),
    )
    .await;
    assert_eq!(
        text,
        "Scheduled recurring job 1a2b3c4d (Every 5 minutes). Session-only (not written to disk, dies when NIBI exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
    );
    let text = call(
        &create,
        json!({"cron": "0 9 * * 1-5", "prompt": "line one\nline two", "recurring": false}),
        context("op_ffffffff-0000", PermissionMode::Default),
    )
    .await;
    assert_eq!(
        text,
        "Scheduled one-shot task ffffffff (Weekdays at 9:00 AM). Session-only (not written to disk, dies when NIBI exits). It will fire once then auto-delete."
    );
    let list = call(
        &tool(&board, LIST),
        json!({}),
        context("op_2", PermissionMode::Default),
    )
    .await;
    assert_eq!(
        list,
        "1a2b3c4d \u{2014} Every 5 minutes (recurring) [session-only]: check the deploy\nffffffff \u{2014} Weekdays at 9:00 AM (one-shot) [session-only]: line one\u{2026}"
    );
}

#[tokio::test]
async fn delete_and_empty_list() {
    let board = board();
    let delete = tool(&board, DELETE);
    let ctx = context("op_1", PermissionMode::Default);
    assert_eq!(
        error(delete.validate_input(&json!({"id": "nope"}), &ctx).await),
        ("No scheduled job with id 'nope'".to_owned(), Some(1))
    );
    board.add(&ctx.session, "abcd0123".to_owned(), "7 * * * *", "p", true);
    assert_eq!(
        delete
            .validate_input(&json!({"id": "abcd0123"}), &ctx)
            .await,
        Validation::Ok
    );
    let text = call(&delete, json!({"id": "abcd0123"}), ctx.clone()).await;
    assert_eq!(text, "Cancelled job abcd0123.");
    let list = call(&tool(&board, LIST), json!({}), ctx).await;
    assert_eq!(list, "No scheduled jobs.");
}

#[tokio::test]
async fn update_changes_fields_and_keeps_omitted_ones() {
    let board = board();
    let update = tool(&board, UPDATE);
    let ctx = context("op_1", PermissionMode::Default);
    assert_eq!(
        error(update.validate_input(&json!({"id": "nope"}), &ctx).await),
        ("No scheduled job with id 'nope'".to_owned(), Some(1))
    );
    board.add(
        &ctx.session,
        "abcd0123".to_owned(),
        "7 * * * *",
        "old",
        true,
    );
    assert_eq!(
        error(
            update
                .validate_input(&json!({"id": "abcd0123", "cron": "bad"}), &ctx)
                .await
        ),
        (
            "Invalid cron expression 'bad'. Expected 5 fields: M H DoM Mon DoW.".to_owned(),
            Some(2)
        )
    );
    let text = call(
        &update,
        json!({"id": "abcd0123", "cron": "*/6 * * * *"}),
        ctx.clone(),
    )
    .await;
    assert_eq!(text, "Updated job abcd0123 (Every 6 minutes).");
    // 省略的 prompt / recurring 保留原值。
    let list = call(&tool(&board, LIST), json!({}), ctx).await;
    assert_eq!(
        list,
        "abcd0123 \u{2014} Every 6 minutes (recurring) [session-only]: old"
    );
}

#[tokio::test]
async fn auto_mode_goes_to_the_classifier() {
    let board = board();
    let create = tool(&board, CREATE);
    let input = json!({"cron": "7 * * * *", "prompt": "p"});
    assert_eq!(
        create
            .check_permissions(&input, &context("op_1", PermissionMode::Auto))
            .await,
        PermissionDecision::Passthrough
    );
    assert_eq!(
        create
            .check_permissions(&input, &context("op_1", PermissionMode::Default))
            .await,
        PermissionDecision::Allow {
            updated_input: None
        }
    );
}

#[test]
fn prompts_are_truncated_by_display_width() {
    assert_eq!(crate::cron_list::truncate_display("short", 80), "short");
    let long = "x".repeat(81);
    assert_eq!(
        crate::cron_list::truncate_display(&long, 80),
        format!("{}\u{2026}", "x".repeat(79))
    );
    // 全角字符占两列。
    let wide = "\u{4e2d}".repeat(41);
    assert_eq!(
        crate::cron_list::truncate_display(&wide, 80),
        format!("{}\u{2026}", "\u{4e2d}".repeat(39))
    );
    let first = format!("{}\nrest", "y".repeat(80));
    assert_eq!(
        crate::cron_list::truncate_display(&first, 80),
        format!("{}\u{2026}", "y".repeat(79))
    );
}

/// `durable: true`：写进文件（结果说明换成 Persisted），列出时排在会话任务前、不带 [session-only]，
/// 删除时从文件删（tools-more.md §16.6）。
#[tokio::test]
async fn durable_jobs_go_to_the_file() {
    let store = Arc::new(nibi_kernel_api::testing::MemoryCronStore::default());
    let board = CronBoard::new(Arc::new(FixedClock(NOW)), Some(store.clone()));
    let create = tool(&board, CREATE);
    let ctx = || {
        context(
            "op_1a2b3c4d-0000-4000-8000-000000000000",
            PermissionMode::Default,
        )
    };
    let text = call(
        &create,
        json!({"cron": "*/5 * * * *", "prompt": "check the deploy", "durable": true}),
        ctx(),
    )
    .await;
    assert_eq!(
        text,
        "Scheduled recurring job 1a2b3c4d (Every 5 minutes). Persisted to .nibi/scheduled_tasks.json. Auto-expires after 7 days. Use CronDelete to cancel sooner."
    );
    let stored = store.snapshot();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].created_at, NOW);
    let session = context(
        "op_ffffffff-0000-4000-8000-000000000000",
        PermissionMode::Default,
    );
    call(
        &create,
        json!({"cron": "0 9 * * 1-5", "prompt": "standup", "recurring": false}),
        session,
    )
    .await;
    let list = call(&tool(&board, LIST), json!({}), ctx()).await;
    assert_eq!(
        list,
        "1a2b3c4d \u{2014} Every 5 minutes (recurring): check the deploy\nffffffff \u{2014} Weekdays at 9:00 AM (one-shot) [session-only]: standup"
    );
    let delete = tool(&board, DELETE);
    assert_eq!(
        delete
            .validate_input(&json!({"id": "1a2b3c4d"}), &ctx())
            .await,
        Validation::Ok
    );
    call(&delete, json!({"id": "1a2b3c4d"}), ctx()).await;
    assert!(store.snapshot().is_empty());
    // 文件里的任务也计入 50 个的上限。
    assert_eq!(
        board.read_durable().await.len() + board.session_count(&SessionId::new("x")),
        0
    );
}

/// `delayMinutes`：一次性任务钉在相对触发时刻，不走 cron 的墙钟对齐。
#[tokio::test]
async fn delay_minutes_create_an_exact_one_shot() {
    let board = board();
    let create = tool(&board, CREATE);
    let ctx = context(
        "op_1a2b3c4d-0000-4000-8000-000000000000",
        PermissionMode::Default,
    );
    let text = call(
        &create,
        json!({"prompt": "stand up", "delayMinutes": 3, "title": "3 分钟后提醒"}),
        ctx.clone(),
    )
    .await;
    assert_eq!(
        text,
        "Scheduled one-shot task 1a2b3c4d (In 3 minutes) — title: 3 分钟后提醒. Session-only (not written to disk, dies when NIBI exits). It will fire once then auto-delete."
    );
    let job = board.session_jobs(&ctx.session).remove(0);
    assert_eq!(job.fire_at, Some(NOW + 3 * 60_000));
    assert_eq!(job.next_fire, Some(NOW + 3 * 60_000));
    assert!(!job.recurring);
    assert_eq!(job.title.as_deref(), Some("3 分钟后提醒"));
    // 到点触发一次后删除。
    let fires = board.take_session_jobs(&ctx.session, NOW + 3 * 60_000);
    assert_eq!(fires.len(), 1);
    assert!(board.session_jobs(&ctx.session).is_empty());
}

/// `intervalUnit + interval`：真实频率由规则推进，兼容 cron 只负责时/分位置。
#[tokio::test]
async fn interval_carrier_uses_the_schedule_rule() {
    let board = board();
    let create = tool(&board, CREATE);
    let ctx = context(
        "op_1a2b3c4d-0000-4000-8000-000000000000",
        PermissionMode::Default,
    );
    let text = call(
        &create,
        json!({
            "cron": "49 * * * *",
            "prompt": "check",
            "intervalUnit": "hourly",
            "interval": 31,
            "title": "每 31 小时",
        }),
        ctx.clone(),
    )
    .await;
    assert_eq!(
        text,
        "Scheduled recurring job 1a2b3c4d (Every 31 hours at :49) — title: 每 31 小时. Session-only (not written to disk, dies when NIBI exits). It repeats on its saved interval. Use CronDelete to cancel sooner."
    );
    let job = board.session_jobs(&ctx.session).remove(0);
    let rule = job.schedule_rule.expect("the carrier becomes a rule");
    assert_eq!(rule.interval, 31);
    assert_eq!(rule.minute, 49);
    let (_, _, _, _, minute, _) = cron_expr::local_parts(job.next_fire.unwrap(), &board.offset());
    assert_eq!(minute, 49);
}

/// `maxRuns`：有限次任务跑满次数才删除，不是一次就删。
#[tokio::test]
async fn max_runs_are_counted_before_deleting() {
    let board = board();
    let create = tool(&board, CREATE);
    let ctx = context(
        "op_1a2b3c4d-0000-4000-8000-000000000000",
        PermissionMode::Default,
    );
    let text = call(
        &create,
        json!({"cron": "*/5 * * * *", "prompt": "ping", "recurring": false, "maxRuns": 2}),
        ctx.clone(),
    )
    .await;
    assert_eq!(
        text,
        "Scheduled job 1a2b3c4d (Every 5 minutes). Session-only (not written to disk, dies when NIBI exits). It will fire up to 2 times then auto-delete."
    );
    assert_eq!(
        board
            .take_session_jobs(&ctx.session, NOW + 10 * 60_000)
            .len(),
        1
    );
    let job = board.session_jobs(&ctx.session).remove(0);
    assert_eq!(job.run_count, 1);
    assert_eq!(
        board
            .take_session_jobs(&ctx.session, NOW + 20 * 60_000)
            .len(),
        1
    );
    assert!(board.session_jobs(&ctx.session).is_empty());
}

/// 更新可以改标题、次数与长间隔；省略的字段保留。
#[tokio::test]
async fn update_changes_title_counts_and_interval() {
    let board = board();
    let create = tool(&board, CREATE);
    let ctx = context(
        "op_1a2b3c4d-0000-4000-8000-000000000000",
        PermissionMode::Default,
    );
    call(
        &create,
        json!({"cron": "*/5 * * * *", "prompt": "ping", "title": "每 5 分钟"}),
        ctx.clone(),
    )
    .await;
    let update = tool(&board, UPDATE);
    let text = call(
        &update,
        json!({"id": "1a2b3c4d", "title": "每 6 分钟", "cron": "*/6 * * * *"}),
        ctx.clone(),
    )
    .await;
    assert_eq!(
        text,
        "Updated job 1a2b3c4d (Every 6 minutes) — title: 每 6 分钟."
    );
    let text = call(
        &update,
        json!({
            "id": "1a2b3c4d",
            "intervalUnit": "minute",
            "interval": 61,
            "cron": "* * * * *",
        }),
        ctx.clone(),
    )
    .await;
    assert_eq!(
        text,
        "Updated job 1a2b3c4d (Every 61 minutes) — title: 每 6 分钟."
    );
    let job = board.session_jobs(&ctx.session).remove(0);
    assert_eq!(
        job.schedule_rule.as_ref().map(|rule| rule.interval),
        Some(61)
    );
    assert_eq!(job.title.as_deref(), Some("每 6 分钟"));
}

/// 组合约束在 validate 阶段拒绝（与 Node contract 同一组）。
#[tokio::test]
async fn invalid_combinations_are_rejected() {
    let board = board();
    let create = tool(&board, CREATE);
    let ctx = context("op_1", PermissionMode::Default);
    let message = |validation| error(validation).0;
    assert_eq!(
        message(
            create
                .validate_input(
                    &json!({"cron": "* * * * *", "prompt": "p", "delayMinutes": 3}),
                    &ctx
                )
                .await
        ),
        "a relative delay must omit cron; the host computes the schedule from its real clock"
    );
    assert_eq!(
        message(
            create
                .validate_input(
                    &json!({"prompt": "p", "delayMinutes": 3, "recurring": true}),
                    &ctx
                )
                .await
        ),
        "a relative delay creates a one-shot automation and cannot use recurring=true"
    );
    assert_eq!(
        message(
            create
                .validate_input(
                    &json!({"cron": "* * * * *", "prompt": "p", "intervalUnit": "minute"}),
                    &ctx
                )
                .await
        ),
        "intervalUnit and interval must be set together"
    );
    assert_eq!(
        message(
            create
                .validate_input(
                    &json!({"cron": "* * * * *", "prompt": "p", "recurring": true, "maxRuns": 2}),
                    &ctx
                )
                .await
        ),
        "recurring=true is indefinite and must not be combined with maxRuns."
    );
    let update = tool(&board, UPDATE);
    assert_eq!(
        message(update.validate_input(&json!({"id": "nope"}), &ctx).await),
        "No scheduled job with id 'nope'"
    );
}

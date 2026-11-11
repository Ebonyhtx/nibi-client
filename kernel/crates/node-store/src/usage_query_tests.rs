//! `/usage` 的两个查询（usage.md §4、§5.2）：会话树的 API 时长、活动统计的聚合与范围、只扫索引。
use nibi_kernel_api::ids::{MessageId, SessionId};
use nibi_kernel_api::message::Usage;
use nibi_kernel_api::metering::{
    ActivityDay, ActivityQuery, ActivityRange, CallStatus, ModelCall, ModelTokens,
};
use nibi_kernel_api::model::{ModelSelection, QuerySource};
use nibi_kernel_api::store::{Fact, SessionKind, SessionStore};

use super::{days_sql, sessions_sql};
use crate::tests::{TestStore, batch, meta, started, user};

const DAY: u64 = 86_400_000;

fn sid(id: &str) -> SessionId {
    SessionId::new(id)
}

fn call(message: &str, model: &str, started: u64, duration: u64, status: CallStatus) -> Fact {
    let source = if message.starts_with("msg_sub") {
        QuerySource::Subagent("Explore".into())
    } else {
        QuerySource::MainThread
    };
    Fact::ModelCalled {
        call: ModelCall {
            message: MessageId::new(message),
            source,
            selection: ModelSelection {
                provider: "p".into(),
                model: model.into(),
                reasoning: None,
                connection: None,
            },
            started_at_ms: started,
            first_token_at_ms: None,
            first_content_at_ms: None,
            completed_at_ms: started + duration,
            status,
            stop_reason: None,
            tool_calls: 0,
            usage: Some(Usage {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 5,
                cache_read_input_tokens: 50,
            }),
            retries: 0,
            error: None,
        },
    }
}

/// 在 `at` 时刻提交一条人类输入（消息 id 不带时间：创建时间是提交时间）。
async fn said(t: &TestStore, session: &str, id: &str, at: u64) {
    t.source.at(at);
    t.store
        .commit(&sid(session), batch(None, vec![user(id, "hi")]))
        .await
        .unwrap();
}

async fn facts(t: &TestStore, session: &str, facts: Vec<Fact>) {
    t.store
        .commit(&sid(session), batch(None, facts))
        .await
        .unwrap();
}

async fn child(t: &TestStore, id: &str, parent: &str) {
    let mut child = meta(id, "/w", "");
    child.kind = SessionKind::Subagent;
    child.parent = Some(sid(parent));
    t.store.create(child).await.unwrap();
}

/// 两个会话、一个子代理子会话、一个已删除和一个没有消息的会话（今天是第 10 天，1970-01-11）。
async fn library() -> TestStore {
    let t = TestStore::new();
    started(&t, "sess_a").await;
    started(&t, "sess_b").await;
    started(&t, "sess_gone").await;
    started(&t, "sess_empty").await;
    child(&t, "sess_subagent_agent_1", "sess_a").await;
    said(&t, "sess_a", "msg_a1", DAY + 1_000).await;
    said(&t, "sess_a", "msg_a2", DAY + 2_000).await;
    said(&t, "sess_a", "msg_a3", 3 * DAY + 61_000).await;
    said(&t, "sess_b", "msg_b1", 9 * DAY).await;
    said(&t, "sess_b", "msg_b2", 10 * DAY + 5_000).await;
    said(&t, "sess_subagent_agent_1", "msg_c1", 9 * DAY).await;
    said(&t, "sess_gone", "msg_g1", 10 * DAY).await;
    t.connection()
        .execute(
            "update session set time_deleted = 1 where id = 'sess_gone'",
            [],
        )
        .unwrap();
    // 用量行：主线程、子代理、旁路请求与一条失败。
    facts(
        &t,
        "sess_a",
        vec![
            call("msg_r1", "opus", DAY + 1_100, 900, CallStatus::Completed),
            call("msg_r2", "opus", DAY + 2_100, 300, CallStatus::Error),
        ],
    )
    .await;
    facts(
        &t,
        "sess_subagent_agent_1",
        vec![call(
            "msg_sub1",
            "haiku",
            9 * DAY,
            500,
            CallStatus::Completed,
        )],
    )
    .await;
    facts(
        &t,
        "sess_b",
        vec![call(
            "msg_r3",
            "opus",
            9 * DAY + 100,
            700,
            CallStatus::Completed,
        )],
    )
    .await;
    t
}

fn query(range: ActivityRange, offset: i32) -> ActivityQuery {
    ActivityQuery {
        range,
        today: "1970-01-11".into(),
        utc_offset_minutes: offset,
    }
}

fn day(date: &str, messages: u64) -> ActivityDay {
    ActivityDay {
        date: date.into(),
        messages,
    }
}

#[tokio::test]
async fn api_duration_sums_completed_calls_of_the_session_and_its_subagents() {
    let t = library().await;
    let a = t.store.metering(&sid("sess_a")).await.unwrap();
    assert_eq!(a.api_duration_ms, 900 + 500);
    let b = t.store.metering(&sid("sess_b")).await.unwrap();
    assert_eq!(b.api_duration_ms, 700);
    assert!(t.store.metering(&sid("sess_none")).await.is_err());
}

#[tokio::test]
async fn all_time_activity_counts_top_level_sessions_and_their_messages() {
    let t = library().await;
    let stats = t
        .store
        .activity(query(ActivityRange::All, 0))
        .await
        .unwrap();
    assert_eq!(stats.sessions, 2);
    assert_eq!(stats.longest_session_ms, Some(2 * DAY + 60_000));
    assert_eq!(stats.first_session_ms, Some(DAY + 1_000));
    assert_eq!(stats.last_session_ms, Some(9 * DAY));
    assert_eq!(
        stats.days,
        vec![
            day("1970-01-02", 2),
            day("1970-01-04", 1),
            day("1970-01-10", 1),
            day("1970-01-11", 1),
        ]
    );
    // opus：三行主线程（失败的也算 token，统计 transcript 里的用量）；haiku：子代理。每行不含缓存的输入是
    // 155 − 55 = 100。
    assert_eq!(
        stats.models,
        vec![
            ModelTokens {
                model: "opus".into(),
                input: 300,
                output: 60,
                cache_read: 150,
                cache_write: 15
            },
            ModelTokens {
                model: "haiku".into(),
                input: 100,
                output: 20,
                cache_read: 50,
                cache_write: 5
            },
        ]
    );
}

#[tokio::test]
async fn a_week_keeps_sessions_started_and_messages_sent_in_its_days() {
    let t = library().await;
    let stats = t
        .store
        .activity(query(ActivityRange::Week, 0))
        .await
        .unwrap();
    assert_eq!(stats.sessions, 1);
    assert_eq!(stats.first_session_ms, Some(9 * DAY));
    assert_eq!(stats.days, vec![day("1970-01-10", 1), day("1970-01-11", 1)]);
    // 一样多时按模型名排（结果稳定）：haiku 在 opus 前面；opus 只剩第 9 天的一行。
    let names: Vec<_> = stats
        .models
        .iter()
        .map(|m| (m.model.as_str(), m.input))
        .collect();
    assert_eq!(names, [("haiku", 100), ("opus", 100)]);
}

#[tokio::test]
async fn local_days_follow_the_clock_offset() {
    let t = library().await;
    // UTC−1 小时：每条消息都在 UTC 的零点后一小时内，落到前一个本地日。
    let west = t
        .store
        .activity(query(ActivityRange::All, -60))
        .await
        .unwrap();
    assert_eq!(
        west.days
            .iter()
            .map(|d| d.date.as_str())
            .collect::<Vec<_>>(),
        ["1970-01-01", "1970-01-03", "1970-01-09", "1970-01-10"]
    );
}

#[tokio::test]
async fn legacy_rows_with_input_excluding_cache_keep_their_input() {
    let t = library().await;
    // Node 旧版写的行：`input_tokens` 不含缓存（总数 = 输入 + 缓存 + 输出），`inputSideTokensFromStoredUsage`
    // 判为旧行；没有缓存时输入原样。
    let conn = t.connection();
    for (id, input, read, total) in [("u1", 10, 100, 115), ("u2", 7, 0, 12)] {
        conn.execute(
            "insert into model_usage (id, logical_request_id, session_id, query_source, provider_id,
               model_id, status, started_at, input_tokens, output_tokens, cache_read_input_tokens,
               provider_total_tokens, computed_total_tokens)
             values (?1, ?1, 'sess_b', 'main_turn', 'p', 'legacy', 'completed', ?2, ?3, 5, ?4, ?5, ?5)",
            rusqlite::params![id, 9 * DAY as i64, input, read, total],
        )
        .unwrap();
    }
    conn.execute(
        "insert into model_usage (id, logical_request_id, session_id, query_source, provider_id,
           model_id, status, started_at, input_tokens, output_tokens)
         values ('t1', 't1', 'sess_b', 'session_title', 'p', 'title-model', 'completed', ?1, 9, 9)",
        [9 * DAY as i64],
    )
    .unwrap();
    let stats = t
        .store
        .activity(query(ActivityRange::All, 0))
        .await
        .unwrap();
    let legacy = stats.models.iter().find(|m| m.model == "legacy").unwrap();
    assert_eq!(
        (legacy.input, legacy.cache_read, legacy.output),
        (17, 100, 10)
    );
    assert!(stats.models.iter().all(|m| m.model != "title-model"));
}

#[test]
fn the_message_queries_only_scan_the_covering_index() {
    // 大库也要快（usage.md §5.2）：会话在外层，消息只走覆盖索引，不读消息行（行里是大 JSON）。
    let dir = tempfile::tempdir().unwrap();
    let (conn, _) = crate::repo::open::open(
        &dir.path().join("db.sqlite"),
        crate::repo::open::MIGRATION_LOCK_WAIT,
        1,
    )
    .unwrap();
    for (sql, params) in [(sessions_sql(), 1), (days_sql(), 2)] {
        let mut plan = conn.prepare(&format!("explain query plan {sql}")).unwrap();
        let steps: Vec<String> = plan
            .query_map(rusqlite::params_from_iter(vec![0_i64; params]), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let text = steps.join("\n");
        assert!(
            text.contains("COVERING INDEX message_session_time_created_id_idx"),
            "{sql}\n{text}"
        );
        assert!(
            !text.contains("SCAN m\n") && !text.ends_with("SCAN m"),
            "{text}"
        );
    }
}

// ———— v4 usage 查询（141 审计 §9 第 2 项）————

/// 应用级聚合的口径（Node `queryAppUsage` 的同一条 SQL）：只按 `started_at` 落在
/// `[since, until]` 的行、按模型与工具分组、三张表按本地日归桶。
#[tokio::test]
async fn app_usage_aggregates_across_sessions_by_day() {
    use nibi_kernel_api::usage::AppUsageQuery;
    let t = TestStore::new();
    started(&t, "sess_u1").await;
    started(&t, "sess_u2").await;
    facts(
        &t,
        "sess_u1",
        vec![
            call("msg_u1", "opus", DAY + 1_000, 900, CallStatus::Completed),
            call("msg_u2", "opus", DAY + 2_000, 300, CallStatus::Error),
        ],
    )
    .await;
    facts(
        &t,
        "sess_u2",
        vec![call("msg_u3", "haiku", 2 * DAY + 5_000, 700, CallStatus::Completed)],
    )
    .await;
    t.connection()
        .execute(
            "insert into turn_usage (session_id, turn_id, status, started_at, duration_ms,
                model_request_count, input_tokens, output_tokens, computed_total_tokens)
             values ('sess_u1', 'turn_1', 'completed', ?1, 1200, 2, 200, 40, 400)",
            [DAY as i64 + 1_000],
        )
        .unwrap();
    t.connection()
        .execute(
            "insert into tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, duration_ms)
             values ('tool_1', 'sess_u1', 'tc_1', 'read', 'error', ?1, 30)",
            [DAY as i64 + 1_500],
        )
        .unwrap();

    let usage = super::app_usage(
        &t.connection(),
        &AppUsageQuery {
            since_ms: 0,
            until_ms: 3 * DAY,
            tz_offset_ms: 0,
        },
    )
    .unwrap();
    assert_eq!(usage.model_request_count, 3);
    assert_eq!(usage.model_error_count, 1);
    // 三行各 155 输入（夹具的 100 + 5 缓存写 + 50 缓存读，node-store 按 AI SDK v6 归一成
    // 总输入）与 20 输出。这里刻意断言**原始列之和**而不是减去缓存：Node 的
    // `queryAppUsage` 同样直接 `sum(input_tokens)`，两侧口径必须逐字相同。
    assert_eq!(usage.input_tokens, 465);
    assert_eq!(usage.output_tokens, 60);
    assert_eq!(usage.models.len(), 2);
    assert_eq!(usage.models[0].model_id.as_deref(), Some("opus"));
    assert_eq!(usage.models[0].request_count, 2);
    assert_eq!(usage.tool_call_count, 1);
    assert_eq!(usage.tool_error_count, 1);
    assert_eq!(usage.tools[0].tool_name, "read");
    assert_eq!(usage.tools[0].avg_duration_ms, Some(30.0));
    assert_eq!(usage.total_sessions, 1);
    assert_eq!(usage.total_turns, 1);
    // 按本地日：第 0 天两行、第 1 天一行。
    assert_eq!(usage.days.len(), 2);
    assert_eq!(usage.days[0].day_index, 1);
    assert_eq!(usage.days[0].tool_call_count, 1);
    assert_eq!(usage.days[1].day_index, 2);

    // 时间窗把第 0 天的行排除在外。
    let windowed = super::app_usage(
        &t.connection(),
        &AppUsageQuery {
            since_ms: 2 * DAY,
            until_ms: 3 * DAY,
            tz_offset_ms: 0,
        },
    )
    .unwrap();
    assert_eq!(windowed.model_request_count, 1);
    assert_eq!(windowed.days.len(), 1);
}

/// 会话级用量的增量记账（Node `queryTaskUsage`）：同一来源的第二行只算「输入侧的增量」，
/// 压缩让 context 变小时不回扣历史，但基线降到压缩后的值。
#[tokio::test]
async fn session_usage_accounts_input_side_incrementally_per_source() {
    let t = TestStore::new();
    started(&t, "sess_t1").await;
    // hand-written rows：三行同源，输入侧 1000 → 1500 → 800（压缩）。
    for (id, at, input) in [("r1", DAY, 1_000), ("r2", DAY + 1_000, 1_500), ("r3", DAY + 2_000, 800)] {
        t.connection()
            .execute(
                "insert into model_usage (id, logical_request_id, session_id, query_source,
                    provider_id, model_id, status, started_at, input_tokens, output_tokens,
                    computed_total_tokens)
                 values (?1, ?1, 'sess_t1', 'main_turn', 'p', 'opus', 'completed', ?2, ?3, 10, ?4)",
                rusqlite::params![id, at as i64, input as i64, (input + 10) as i64],
            )
            .unwrap();
    }
    let usage = super::session_usage(&t.connection(), "sess_t1").unwrap();
    // 增量：1000 + 500 + 0（800 < 基线 1500，不回扣）= 1500 输入；非输入侧每行 10。
    assert_eq!(usage.input_tokens, 1_500);
    assert_eq!(usage.total_tokens, 1_530);
    assert_eq!(usage.model_request_count, 3);
    assert_eq!(usage.input_baseline_by_source.get("main_turn"), Some(&800));

    // 空会话是零值（不是错误）。
    started(&t, "sess_empty_usage").await;
    let empty = super::session_usage(&t.connection(), "sess_empty_usage").unwrap();
    assert_eq!(empty, nibi_kernel_api::usage::SessionUsage::default());
}

#[test]
fn dates_and_day_indexes_round_trip() {
    assert_eq!(super::day_index("1970-01-01"), Some(0));
    assert_eq!(super::day_index("2026-10-18"), Some(20_744));
    assert_eq!(super::day_index("not a date"), None);
}

#[test]
fn the_day_bucket_sql_text_is_unchanged() {
    // F58：一天的毫秒数改为引用 base 的 `DAY_MS`（u64），SQL 里仍是同一段文字。
    assert!(
        days_sql().starts_with("select cast((m.time_created + ?1) / 86400000 as integer) as day")
    );
}

//! `/usage` 的两个只读查询（docs/specs/rust-cli/usage.md §4、§5.2）：都是聚合 SQL，不把消息或用量行整表读进
//! 内存。会话的开始与时长、按天的消息数只扫 `message_session_time_created_id_idx`。
use rusqlite::Connection;
use rust_cli_kernel_api::clock::civil_date;
use rust_cli_kernel_api::metering::{
    ActivityDay, ActivityQuery, ActivityRange, ActivityStats, ModelTokens, SessionMetering,
};
use rust_cli_kernel_api::store::StoreError;

use crate::{OrStorage, storage};

/// 一天的毫秒数：只定义在 base 的 `js::date::DAY_MS`（u64，F58：以前这里另写一份 i64）。SQL 文本与 i64 的日界
/// 算术用这个局部的 i64 值，文本逐字不变。
const DAY_MS: i64 = rust_cli_base::js::date::DAY_MS as i64;

/// 会话及其子代理子会话（`parent_id` 递归）里成功请求的耗时之和（`Total duration (API)`）。
pub(crate) const METERING: &str = "with recursive tree(id) as (
       select ?1
       union
       select s.id from session s join tree t on s.parent_id = t.id
        where s.task_type = 'subagent_child'
     )
     select coalesce(sum(duration_ms), 0) from model_usage
      where session_id in (select id from tree) and status = 'completed'";

pub fn metering(conn: &Connection, session: &str) -> Result<SessionMetering, StoreError> {
    let total: i64 = conn
        .prepare_cached(METERING)
        .storage()?
        .query_row([session], |r| r.get(0))
        .storage()?;
    Ok(SessionMetering {
        api_duration_ms: u64::try_from(total).unwrap_or(0),
    })
}

/// 统计里的会话：未删除、不是子代理或工作流的子运行（子代理的 transcript 不统计）。
const COUNTED: &str = "s.time_deleted is null
       and s.task_type not in ('subagent_child', 'workflow_child', 'nested_workflow_child')";

/// 范围内开始的会话：个数、最长时长、最早与最晚的开始。开始与结束是这个会话消息的最早与最晚
/// 创建时间（每个会话两次索引上的 min / max）。
pub(crate) fn sessions_sql() -> String {
    format!(
        "with started as (
           select (select min(m.time_created) from message m where m.session_id = s.id) as first,
                  (select max(m.time_created) from message m where m.session_id = s.id) as last
             from session s where {COUNTED}
         )
         select count(*), max(last - first), min(first), max(first)
           from started where first is not null and first >= ?1"
    )
}

/// 按本地日的消息数（`dailyActivity.messageCount`）。`cross join` 固定会话在外层：每个会话一段覆盖索引。
pub(crate) fn days_sql() -> String {
    format!(
        "select cast((m.time_created + ?1) / {DAY_MS} as integer) as day, count(*)
           from session s cross join message m on m.session_id = s.id
          where {COUNTED} and m.time_created >= ?2
          group by day order by day"
    )
}

/// 按模型的 token（`modelUsage`）：transcript 里的请求（主线程、子代理、工作流子运行）。`input_tokens` 是
/// AI SDK 的总输入；不含缓存的输入按 Node `inputSideTokensFromStoredUsage` 的判别得出（旧行的输入不含缓存）。
pub(crate) const MODELS: &str = "select model_id,
       coalesce(sum(case
         when input_tokens <= 0 then 0
         when cache_read_input_tokens + cache_creation_input_tokens <= 0 then input_tokens
         when coalesce(provider_total_tokens, computed_total_tokens) > 0
          and abs(coalesce(provider_total_tokens, computed_total_tokens)
                  - (input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens))
            < abs(coalesce(provider_total_tokens, computed_total_tokens) - (input_tokens + output_tokens))
           then input_tokens
         else max(input_tokens - cache_read_input_tokens - cache_creation_input_tokens, 0)
       end), 0),
       coalesce(sum(output_tokens), 0),
       coalesce(sum(cache_read_input_tokens), 0),
       coalesce(sum(cache_creation_input_tokens), 0)
     from model_usage
    where query_source in ('main_turn', 'subagent', 'workflow_child') and started_at >= ?1
    group by model_id";

/// `YYYY-MM-DD` → 自 1970-01-01 的天数（Howard Hinnant 的 days_from_civil）。
pub(crate) fn day_index(date: &str) -> Option<i64> {
    let mut parts = date.splitn(3, '-').map(str::parse::<i64>);
    let (year, month, day) = (
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    );
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted = (month + 9) % 12;
    let day_of_year = (153 * shifted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

pub fn activity(conn: &Connection, query: &ActivityQuery) -> Result<ActivityStats, StoreError> {
    let offset = i64::from(query.utc_offset_minutes) * 60_000;
    let today =
        day_index(&query.today).ok_or_else(|| storage(format!("not a date: {}", query.today)))?;
    // 7 天与 30 天从 today − (N − 1) 的本地日开始；本地日 d 从 UTC 毫秒 d·DAY − 偏移开始。
    let from = match query.range {
        ActivityRange::All => i64::MIN,
        range => {
            let days = i64::try_from(range.days().unwrap_or(0)).unwrap_or(0);
            (today - (days - 1)) * DAY_MS - offset
        }
    };
    let (sessions, longest, first, last) = conn
        .prepare_cached(&sessions_sql())
        .storage()?
        .query_row([from], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))
        })
        .storage()?;
    let days = conn
        .prepare_cached(&days_sql())
        .storage()?
        .query_map([offset, from], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })
        .storage()?
        .map(|row| {
            row.map(|(day, messages)| ActivityDay {
                date: civil_date(to_u64(day) * rust_cli_base::js::date::DAY_MS),
                messages: to_u64(messages),
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .storage()?;
    let mut models = conn
        .prepare_cached(MODELS)
        .storage()?
        .query_map([from], |r| {
            Ok(ModelTokens {
                model: r.get(0)?,
                input: to_u64(r.get(1)?),
                output: to_u64(r.get(2)?),
                cache_read: to_u64(r.get(3)?),
                cache_write: to_u64(r.get(4)?),
            })
        })
        .storage()?
        .collect::<Result<Vec<_>, _>>()
        .storage()?;
    // 按总数降序；相同时按模型名，结果稳定。
    models.sort_by(|a, b| {
        b.total()
            .cmp(&a.total())
            .then_with(|| a.model.cmp(&b.model))
    });
    models.retain(|model| model.total() > 0);
    Ok(ActivityStats {
        range: Some(query.range),
        today: query.today.clone(),
        days,
        models,
        sessions: to_u64(sessions),
        longest_session_ms: longest.map(to_u64),
        first_session_ms: first.map(to_u64),
        last_session_ms: last.map(to_u64),
    })
}

// ————————————————————————————————————————————————————————————————
// v4 usage 查询（141 审计 §9 第 2 项）：`v4/usage/stats` 与 `v4/conversation/usage`。
//
// SQL 逐字对齐 Node `repositories/usage.ts` 的 `queryAppUsage` / `queryTaskUsage`——两侧读
// 同一批表，口径一旦分叉，同一个用户在两个内核下会看到不同的用量。**不做展示推导**：按本地日
// 切分在这里（偏移由调用方给），热力图 / 连续天数 / 份额是协议层的纯投影（Node 的
// `buildAppUsageSnapshot`）。
// ————————————————————————————————————————————————————————————————

/// 应用级用量的四路聚合 + 汇总（Node `queryAppUsage` 的 SQL 逐字移植）。
pub fn app_usage(
    conn: &Connection,
    query: &rust_cli_kernel_api::usage::AppUsageQuery,
) -> Result<rust_cli_kernel_api::usage::AppUsage, StoreError> {
    use rust_cli_kernel_api::usage::{AppUsage, AppUsageDayModelRow, AppUsageDayRow, AppUsageModelRow, AppUsageToolRow};

    let (since, until, offset) = (
        i64::try_from(query.since_ms).unwrap_or(i64::MAX),
        i64::try_from(query.until_ms).unwrap_or(i64::MAX),
        query.tz_offset_ms,
    );

    // 模型侧的总计。`avg(...)` 在没有行时是 NULL——「没有可用样本」与「0 ms」必须分开。
    let (total_tokens, input_tokens, output_tokens, reasoning_tokens, cache_creation, cache_read, requests, errors, avg_ttft) = conn
        .prepare_cached(
            "select
               coalesce(sum(computed_total_tokens), 0),
               coalesce(sum(input_tokens), 0),
               coalesce(sum(output_tokens), 0),
               coalesce(sum(reasoning_tokens), 0),
               coalesce(sum(cache_creation_input_tokens), 0),
               coalesce(sum(cache_read_input_tokens), 0),
               count(*),
               coalesce(sum(case when status = 'error' then 1 else 0 end), 0),
               avg(time_to_first_token_ms)
             from model_usage
             where started_at >= ?1 and started_at <= ?2",
        )
        .storage()?
        .query_row([since, until], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<f64>>(8)?,
            ))
        })
        .storage()?;

    let (total_sessions, total_turns, avg_turn_duration) = conn
        .prepare_cached(
            "select
               count(distinct session_id),
               count(*),
               avg(case when status = 'completed' then duration_ms else null end)
             from turn_usage
             where started_at >= ?1 and started_at <= ?2",
        )
        .storage()?
        .query_row([since, until], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<f64>>(2)?,
            ))
        })
        .storage()?;

    let longest_session: i64 = conn
        .prepare_cached(
            "select coalesce(max(sessionDurationMs), 0) from (
               select coalesce(sum(case when status = 'completed' then duration_ms else 0 end), 0)
                 as sessionDurationMs
               from turn_usage
               where started_at >= ?1 and started_at <= ?2
               group by session_id
             )",
        )
        .storage()?
        .query_row([since, until], |row| row.get(0))
        .storage()?;

    let (tool_calls, tool_errors) = conn
        .prepare_cached(
            "select count(*), coalesce(sum(case when status = 'error' then 1 else 0 end), 0)
             from tool_usage where started_at >= ?1 and started_at <= ?2",
        )
        .storage()?
        .query_row([since, until], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .storage()?;

    let models = conn
        .prepare_cached(
            "select model_id,
                    coalesce(sum(computed_total_tokens), 0),
                    coalesce(sum(input_tokens), 0),
                    coalesce(sum(output_tokens), 0),
                    count(*)
             from model_usage
             where started_at >= ?1 and started_at <= ?2
             group by model_id
             order by 2 desc",
        )
        .storage()?
        .query_map([since, until], |row| {
            Ok(AppUsageModelRow {
                model_id: row.get::<_, Option<String>>(0)?,
                total_tokens: to_u64(row.get::<_, i64>(1)?),
                input_tokens: to_u64(row.get::<_, i64>(2)?),
                output_tokens: to_u64(row.get::<_, i64>(3)?),
                request_count: to_u64(row.get::<_, i64>(4)?),
            })
        })
        .storage()?
        .collect::<Result<Vec<_>, _>>()
        .storage()?;

    let tools = conn
        .prepare_cached(
            "select tool_name,
                    count(*),
                    coalesce(sum(case when status = 'error' then 1 else 0 end), 0),
                    avg(duration_ms)
             from tool_usage
             where started_at >= ?1 and started_at <= ?2
             group by tool_name
             order by 2 desc",
        )
        .storage()?
        .query_map([since, until], |row| {
            Ok(AppUsageToolRow {
                tool_name: row.get(0)?,
                call_count: to_u64(row.get::<_, i64>(1)?),
                error_count: to_u64(row.get::<_, i64>(2)?),
                avg_duration_ms: row.get::<_, Option<f64>>(3)?,
            })
        })
        .storage()?
        .collect::<Result<Vec<_>, _>>()
        .storage()?;

    // 三张表按本地日归桶，再在内存里合并（三个 `group by` 各自走索引，合并是一次小表遍历）。
    // 偏移是调用方给的查询时刻值——Node 的 `queryAppUsage` 同一条近似（DST 跨日边界最多 1 小时
    // 误差，对用量统计可接受）。
    let day_tokens = conn
        .prepare_cached(
            "select cast((started_at + ?1) / ?2 as integer), coalesce(sum(computed_total_tokens), 0)
             from model_usage where started_at >= ?3 and started_at <= ?4
             group by 1",
        )
        .storage()?
        .query_map([offset, DAY_MS, since, until], |row| {
            Ok((row.get::<_, i64>(0)?, to_u64(row.get::<_, i64>(1)?)))
        })
        .storage()?
        .collect::<Result<Vec<_>, _>>()
        .storage()?;
    let day_turns = conn
        .prepare_cached(
            "select cast((started_at + ?1) / ?2 as integer), count(*)
             from turn_usage where started_at >= ?3 and started_at <= ?4
             group by 1",
        )
        .storage()?
        .query_map([offset, DAY_MS, since, until], |row| {
            Ok((row.get::<_, i64>(0)?, to_u64(row.get::<_, i64>(1)?)))
        })
        .storage()?
        .collect::<Result<Vec<_>, _>>()
        .storage()?;
    let day_tools = conn
        .prepare_cached(
            "select cast((started_at + ?1) / ?2 as integer), count(*)
             from tool_usage where started_at >= ?3 and started_at <= ?4
             group by 1",
        )
        .storage()?
        .query_map([offset, DAY_MS, since, until], |row| {
            Ok((row.get::<_, i64>(0)?, to_u64(row.get::<_, i64>(1)?)))
        })
        .storage()?
        .collect::<Result<Vec<_>, _>>()
        .storage()?;
    let mut day_map: std::collections::BTreeMap<i64, AppUsageDayRow> =
        std::collections::BTreeMap::new();
    for (day, tokens) in day_tokens {
        day_map.insert(
            day,
            AppUsageDayRow {
                day_index: day,
                total_tokens: tokens,
                turn_count: 0,
                tool_call_count: 0,
            },
        );
    }
    for (day, turns) in day_turns {
        day_map.entry(day).or_insert(AppUsageDayRow {
            day_index: day,
            total_tokens: 0,
            turn_count: 0,
            tool_call_count: 0,
        }).turn_count = turns;
    }
    for (day, calls) in day_tools {
        day_map.entry(day).or_insert(AppUsageDayRow {
            day_index: day,
            total_tokens: 0,
            turn_count: 0,
            tool_call_count: 0,
        }).tool_call_count = calls;
    }

    let day_models = conn
        .prepare_cached(
            "select cast((started_at + ?1) / ?2 as integer), model_id,
                    coalesce(sum(computed_total_tokens), 0)
             from model_usage where started_at >= ?3 and started_at <= ?4
             group by 1, model_id",
        )
        .storage()?
        .query_map([offset, DAY_MS, since, until], |row| {
            Ok(AppUsageDayModelRow {
                day_index: row.get::<_, i64>(0)?,
                model_id: row.get::<_, Option<String>>(1)?,
                total_tokens: to_u64(row.get::<_, i64>(2)?),
            })
        })
        .storage()?
        .collect::<Result<Vec<_>, _>>()
        .storage()?;

    Ok(AppUsage {
        total_tokens: to_u64(total_tokens),
        input_tokens: to_u64(input_tokens),
        output_tokens: to_u64(output_tokens),
        reasoning_tokens: to_u64(reasoning_tokens),
        cache_creation_tokens: to_u64(cache_creation),
        cache_read_tokens: to_u64(cache_read),
        model_request_count: to_u64(requests),
        model_error_count: to_u64(errors),
        avg_time_to_first_token_ms: avg_ttft,
        total_sessions: to_u64(total_sessions),
        total_turns: to_u64(total_turns),
        avg_turn_duration_ms: avg_turn_duration,
        longest_session_ms: to_u64(longest_session),
        tool_call_count: to_u64(tool_calls),
        tool_error_count: to_u64(tool_errors),
        models,
        tools,
        days: day_map.into_values().collect(),
        day_models,
    })
}

/// 会话级 token 用量（Node `queryTaskUsage` 的逐行模拟）。
///
/// 逐行而不是纯 SQL 聚合的理由就是 Node 的那条注释：输入侧要按来源做**增量**记账（压缩会让
/// 后续 context 变小，累计消耗不能因此回扣历史，但基线必须降到压缩后的值），这是顺序相关的
/// 状态机，SQL 的 `group by` 表达不出来。
pub fn session_usage(
    conn: &Connection,
    session: &str,
) -> Result<rust_cli_kernel_api::usage::SessionUsage, StoreError> {
    use rust_cli_kernel_api::usage::SessionUsage;
    let rows = conn
        .prepare_cached(
            "select query_source, status, input_tokens, output_tokens, reasoning_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens,
                    computed_total_tokens, provider_total_tokens
             from model_usage
             where session_id = ?
             order by started_at asc, id asc",
        )
        .storage()?
        .query_map([session], |row| {
            Ok(SessionUsageRow {
                query_source: row.get(0)?,
                status: row.get(1)?,
                input_tokens: row.get::<_, i64>(2)?.max(0) as u64,
                output_tokens: row.get::<_, i64>(3)?.max(0) as u64,
                reasoning_tokens: row.get::<_, i64>(4)?.max(0) as u64,
                cache_creation_tokens: row.get::<_, i64>(5)?.max(0) as u64,
                cache_read_tokens: row.get::<_, i64>(6)?.max(0) as u64,
                computed_total_tokens: row.get::<_, i64>(7)?.max(0) as u64,
                provider_total_tokens: row.get::<_, Option<i64>>(8)?.map(|value| value.max(0) as u64),
            })
        })
        .storage()?
        .collect::<Result<Vec<_>, _>>()
        .storage()?;

    let mut usage = SessionUsage::default();
    for row in rows {
        let raw_total = row.provider_total_tokens.unwrap_or(row.computed_total_tokens);
        let input_side = input_side_tokens(&row);
        let source = baseline_source(&row.query_source);
        let incremental_input = match source {
            // 压缩会让后续 context input 变小：累计消耗不能回扣历史，但基线必须降到压缩后的
            // 值，后续新增轮次才能继续按增量计算。
            Some(source) => {
                let baseline = usage.input_baseline_by_source.get(source).copied().unwrap_or(0);
                let incremental = input_side.saturating_sub(baseline);
                usage
                    .input_baseline_by_source
                    .insert(source.to_owned(), input_side);
                incremental
            }
            None => input_side,
        };
        let non_input = raw_total.saturating_sub(input_side);
        usage.total_tokens = usage.total_tokens.saturating_add(incremental_input).saturating_add(non_input);
        usage.input_tokens = usage.input_tokens.saturating_add(incremental_input);
        usage.output_tokens = usage.output_tokens.saturating_add(row.output_tokens);
        usage.reasoning_tokens = usage.reasoning_tokens.saturating_add(row.reasoning_tokens);
        // 缓存读写只在不属于三个已知来源时单列（已知来源的输入侧已含它们）。
        if source.is_none() {
            usage.cache_creation_tokens = usage.cache_creation_tokens.saturating_add(row.cache_creation_tokens);
            usage.cache_read_tokens = usage.cache_read_tokens.saturating_add(row.cache_read_tokens);
        }
        usage.model_request_count = usage.model_request_count.saturating_add(1);
        if row.status == "error" {
            usage.model_error_count = usage.model_error_count.saturating_add(1);
        }
    }
    Ok(usage)
}

struct SessionUsageRow {
    query_source: String,
    status: String,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    computed_total_tokens: u64,
    provider_total_tokens: Option<u64>,
}

/// Node `inputSideTokensFromStoredUsage`：AI SDK v6 写出的 `input_tokens` 已是总输入（含缓存
/// 读写）；老行的输入不含缓存，靠「哪个总数更接近」判出来。
fn input_side_tokens(row: &SessionUsageRow) -> u64 {
    let input = row.input_tokens;
    let cache = row.cache_creation_tokens.saturating_add(row.cache_read_tokens);
    if input == 0 {
        return cache;
    }
    if cache == 0 {
        return input;
    }
    let output = row.output_tokens;
    let total = row.provider_total_tokens.unwrap_or(row.computed_total_tokens);
    if total > 0 {
        let total_input_distance = total.abs_diff(input.saturating_add(output));
        let no_cache_input_distance =
            total.abs_diff(input.saturating_add(cache).saturating_add(output));
        if no_cache_input_distance < total_input_distance {
            return input.saturating_add(cache);
        }
    }
    input
}

/// Node `taskUsageInputBaselineSource`：三个已知来源才做增量记账。
fn baseline_source(query_source: &str) -> Option<&'static str> {
    match query_source {
        "main_turn" => Some("main_turn"),
        "subagent" => Some("subagent"),
        "workflow_child" => Some("workflow_child"),
        _ => None,
    }
}

#[cfg(test)]
#[path = "usage_query_tests.rs"]
mod tests;

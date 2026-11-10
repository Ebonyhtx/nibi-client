//! 每 N 个单位的长间隔调度（Node `computeScheduleRuleNextRunAt` 的同一口径）。
//!
//! 五段 cron 的字段步长有上限（分 59、时 24、日 31、月 12），「每 61 分钟」「每 40 天」
//! 这类间隔只能用一条规则表达；`cron` 仍是兼容/展示表达式。规则按本地日历推进：
//! 分钟/小时/天/周是固定长度，月/年按日历月份加，不做 UTC 固定毫秒累加。

use nibi_kernel_api::cron_store::{CronScheduleRule, CronScheduleUnit};

use crate::cron_expr::{self, DAY_NAMES, clock_time};

type Offset<'a> = &'a dyn Fn(u64) -> i32;

/// 本地日期与时间：`(1970 起的天数, 年, 月, 日, 时, 分)`。
fn local_date(utc_ms: u64, offset: Offset<'_>) -> (i64, i64, u32, u32, u32, u32) {
    let (year, month, day, hour, minute, _) = cron_expr::local_parts(utc_ms, offset);
    (
        cron_expr::days_from(year, month, day),
        year,
        month,
        day,
        hour,
        minute,
    )
}

fn at_local(days: i64, hour: u32, minute: u32, offset: Offset<'_>) -> u64 {
    cron_expr::to_utc(
        days * 1_440 + i64::from(hour) * 60 + i64::from(minute),
        offset,
    )
}

fn weekday(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

/// 一个月有几天：下个月 1 日减去本月 1 日。
fn days_in_month(year: i64, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    (cron_expr::days_from(next_year, next_month, 1) - cron_expr::days_from(year, month, 1)) as u32
}

fn single(token: &str) -> Option<u32> {
    if token == "*" || token == "?" {
        return None;
    }
    token.parse().ok()
}

/// 逗号分隔的数字列表（月内日期、月份）。
fn numbers(token: &str) -> Option<Vec<u32>> {
    if token == "*" || token == "?" {
        return None;
    }
    let mut values: Vec<u32> = token
        .split(',')
        .filter_map(|piece| piece.parse::<u32>().ok())
        .collect();
    values.sort_unstable();
    values.dedup();
    (!values.is_empty()).then_some(values)
}

/// 星期列表：cron 的 `7` 也是周日。
fn weekdays(token: &str) -> Option<Vec<u32>> {
    let mut values: Vec<u32> = numbers(token)?
        .into_iter()
        .map(|value| if value == 7 { 0 } else { value })
        .filter(|value| *value <= 6)
        .collect();
    values.sort_unstable();
    values.dedup();
    (!values.is_empty()).then_some(values)
}

/// 兼容 cron + 真实间隔 → 权威规则（缺字段时回退到锚点的本地日期/时间）。
pub(crate) fn from_cron(
    unit: CronScheduleUnit,
    interval: u32,
    cron: &str,
    anchor_at: u64,
    offset: Offset<'_>,
) -> CronScheduleRule {
    let parts: Vec<&str> = cron.split_whitespace().collect();
    let token = |index: usize| parts.get(index).copied().unwrap_or("*");
    let (_, _, month, day, hour, minute) = local_date(anchor_at, offset);
    let rule_minute = single(token(0)).unwrap_or(minute);
    let rule_hour = single(token(1)).unwrap_or(hour);
    let month_days = numbers(token(2)).unwrap_or_else(|| vec![day]);
    let months = numbers(token(3)).unwrap_or_else(|| vec![month]);
    let weekdays = weekdays(token(4)).unwrap_or_else(|| vec![1]);
    match unit {
        CronScheduleUnit::Minute => CronScheduleRule {
            unit,
            interval,
            hour,
            minute,
            anchor_at,
            weekdays: Vec::new(),
            month_days: Vec::new(),
            months: Vec::new(),
        },
        CronScheduleUnit::Hourly => CronScheduleRule {
            unit,
            interval,
            hour: 0,
            minute: rule_minute,
            anchor_at,
            weekdays: Vec::new(),
            month_days: Vec::new(),
            months: Vec::new(),
        },
        CronScheduleUnit::Daily => CronScheduleRule {
            unit,
            interval,
            hour: rule_hour,
            minute: rule_minute,
            anchor_at,
            weekdays: Vec::new(),
            month_days: Vec::new(),
            months: Vec::new(),
        },
        CronScheduleUnit::Weekly => CronScheduleRule {
            unit,
            interval,
            hour: rule_hour,
            minute: rule_minute,
            anchor_at,
            weekdays,
            month_days: Vec::new(),
            months: Vec::new(),
        },
        CronScheduleUnit::Monthly => CronScheduleRule {
            unit,
            interval,
            hour: rule_hour,
            minute: rule_minute,
            anchor_at,
            weekdays: Vec::new(),
            month_days,
            months: Vec::new(),
        },
        CronScheduleUnit::Yearly => CronScheduleRule {
            unit,
            interval,
            hour: rule_hour,
            minute: rule_minute,
            anchor_at,
            weekdays: Vec::new(),
            month_days,
            months,
        },
    }
}

/// 严格晚于 `from` 的下一次触发；规则不可计算时为 None。
pub(crate) fn next(rule: &CronScheduleRule, from: u64, offset: Offset<'_>) -> Option<u64> {
    let interval = rule.interval.max(1);
    let anchor = rule.anchor_at;
    match rule.unit {
        CronScheduleUnit::Minute => {
            let step = i64::from(interval) * cron_expr::MINUTE_MS;
            let steps = ((from as i64 - anchor as i64).div_euclid(step) + 1).max(1);
            Some((anchor as i64 + steps * step).max(0) as u64)
        }
        CronScheduleUnit::Hourly => {
            let (days, _, _, _, hour, _) = local_date(anchor, offset);
            let base = at_local(days, hour, rule.minute, offset);
            let step = i64::from(interval) * 3_600_000;
            let steps = ((from as i64 - base as i64).div_euclid(step) + 1).max(0);
            Some((base as i64 + steps * step).max(0) as u64)
        }
        CronScheduleUnit::Daily => {
            let (anchor_days, _, _, _, _, _) = local_date(anchor, offset);
            for index in 0..36_600 {
                let days = anchor_days + i64::from(index) * i64::from(interval);
                let candidate = at_local(days, rule.hour, rule.minute, offset);
                if candidate > from {
                    return Some(candidate);
                }
            }
            None
        }
        CronScheduleUnit::Weekly => {
            let (anchor_days, _, _, _, _, _) = local_date(anchor, offset);
            // 周一为一周起点（Node 同一算法：Sunday=0 → (0+6)%7=6）。
            let monday = anchor_days - i64::from((weekday(anchor_days) + 6) % 7);
            let mut weekdays = rule.weekdays.clone();
            if weekdays.is_empty() {
                weekdays.push(1);
            }
            weekdays.sort_unstable();
            let mut week = 0u32;
            while week < 5_220 {
                for day in &weekdays {
                    let offset_days = i64::from((*day + 6) % 7);
                    let days = monday + i64::from(week) * 7 + offset_days;
                    let candidate = at_local(days, rule.hour, rule.minute, offset);
                    if candidate > from {
                        return Some(candidate);
                    }
                }
                week = week.saturating_add(interval);
            }
            None
        }
        CronScheduleUnit::Monthly => {
            let (_, year, month, _, _, _) = local_date(anchor, offset);
            let start = year * 12 + i64::from(month - 1);
            let mut days = rule.month_days.clone();
            if days.is_empty() {
                days.push(1);
            }
            days.sort_unstable();
            let mut offset_months = 0u32;
            while offset_months <= 1_200 {
                let absolute = start + i64::from(offset_months);
                let candidate_year = absolute.div_euclid(12);
                let candidate_month = absolute.rem_euclid(12) as u32 + 1;
                for day in &days {
                    if *day == 0 || *day > days_in_month(candidate_year, candidate_month) {
                        continue;
                    }
                    let days = cron_expr::days_from(candidate_year, candidate_month, *day);
                    let candidate = at_local(days, rule.hour, rule.minute, offset);
                    if candidate > from {
                        return Some(candidate);
                    }
                }
                offset_months = offset_months.saturating_add(interval);
            }
            None
        }
        CronScheduleUnit::Yearly => {
            let (_, year, month, day, _, _) = local_date(anchor, offset);
            let target_month = rule.months.first().copied().unwrap_or(month);
            let target_day = rule.month_days.first().copied().unwrap_or(day);
            let mut offset_years = 0u32;
            while offset_years < 400 {
                let candidate_year = year + i64::from(offset_years);
                if target_day == 0
                    || target_day > days_in_month(candidate_year, target_month.clamp(1, 12))
                {
                    offset_years = offset_years.saturating_add(interval);
                    continue;
                }
                let days =
                    cron_expr::days_from(candidate_year, target_month.clamp(1, 12), target_day);
                let candidate = at_local(days, rule.hour, rule.minute, offset);
                if candidate > from {
                    return Some(candidate);
                }
                offset_years = offset_years.saturating_add(interval);
            }
            None
        }
    }
}

/// 人读写法；与 `cron_expr::human` 的英文风格一致。
pub(crate) fn human(rule: &CronScheduleRule) -> String {
    let n = rule.interval.max(1);
    let every = |unit: &str| {
        if n == 1 {
            format!("Every {unit}")
        } else {
            format!("Every {n} {unit}s")
        }
    };
    match rule.unit {
        CronScheduleUnit::Minute => every("minute"),
        CronScheduleUnit::Hourly => {
            format!("{} at :{:02}", every("hour"), rule.minute)
        }
        CronScheduleUnit::Daily => {
            format!("{} at {}", every("day"), clock_time(rule.minute, rule.hour))
        }
        CronScheduleUnit::Weekly => {
            let names: Vec<&str> = rule
                .weekdays
                .iter()
                .map(|day| DAY_NAMES[(*day % 7) as usize])
                .collect();
            let names = if names.is_empty() {
                DAY_NAMES[1].to_owned()
            } else {
                names.join(", ")
            };
            format!(
                "{} on {} at {}",
                every("week"),
                names,
                clock_time(rule.minute, rule.hour)
            )
        }
        CronScheduleUnit::Monthly => {
            let days: Vec<String> = rule.month_days.iter().map(u32::to_string).collect();
            let days = if days.is_empty() {
                "1".to_owned()
            } else {
                days.join(", ")
            };
            format!(
                "{} on day {} at {}",
                every("month"),
                days,
                clock_time(rule.minute, rule.hour)
            )
        }
        CronScheduleUnit::Yearly => {
            let month = rule.months.first().copied().unwrap_or(1);
            let day = rule.month_days.first().copied().unwrap_or(1);
            format!(
                "{} on {month}/{day} at {}",
                every("year"),
                clock_time(rule.minute, rule.hour)
            )
        }
    }
}

#[cfg(test)]
#[path = "cron_rule_tests.rs"]
mod tests;

//! 长间隔规则的推进与展示（Node `computeScheduleRuleNextRunAt` 同一口径）。

use nibi_kernel_api::cron_store::CronScheduleUnit;

use super::*;
use crate::cron_expr;

/// 2026-10-17T10:07:30Z（周六）。
const NOW: u64 = 1_792_231_650_000;
const HOUR: u64 = 3_600_000;
const DAY: u64 = 86_400_000;

fn utc(_: u64) -> i32 {
    0
}

fn rule(unit: CronScheduleUnit, interval: u32, cron: &str) -> CronScheduleRule {
    from_cron(unit, interval, cron, NOW, &utc)
}

#[test]
fn minute_intervals_are_anchored_at_creation() {
    let rule = rule(CronScheduleUnit::Minute, 61, "* * * * *");
    let first = next(&rule, NOW, &utc).unwrap();
    assert_eq!(first, NOW + 61 * 60_000);
    let second = next(&rule, first, &utc).unwrap();
    assert_eq!(second - first, 61 * 60_000);
}

#[test]
fn hourly_intervals_keep_the_minute_and_add_hours() {
    let rule = rule(CronScheduleUnit::Hourly, 31, "49 * * * *");
    assert_eq!(rule.minute, 49);
    let first = next(&rule, NOW, &utc).unwrap();
    let (_, _, _, _, minute, _) = cron_expr::local_parts(first, &utc);
    assert_eq!(minute, 49);
    let second = next(&rule, first, &utc).unwrap();
    assert_eq!(second - first, 31 * HOUR);
}

#[test]
fn daily_intervals_add_calendar_days() {
    let rule = rule(CronScheduleUnit::Daily, 40, "0 9 * * *");
    let first = next(&rule, NOW, &utc).unwrap();
    let (_, _, _, hour, minute, _) = cron_expr::local_parts(first, &utc);
    assert_eq!((hour, minute), (9, 0));
    let second = next(&rule, first, &utc).unwrap();
    assert_eq!(second - first, 40 * DAY);
}

#[test]
fn weekly_intervals_start_on_the_monday_week() {
    let rule = rule(CronScheduleUnit::Weekly, 8, "0 9 * * 1");
    let first = next(&rule, NOW, &utc).unwrap();
    // 锚点所在周的周一（10/12）已过，下一次是 8 周后的周一（12/07）。
    let (_, month, day, hour, minute, _) = cron_expr::local_parts(first, &utc);
    assert_eq!((month, day, hour, minute), (12, 7, 9, 0));
    let second = next(&rule, first, &utc).unwrap();
    assert_eq!(second - first, 8 * 7 * DAY);
}

#[test]
fn monthly_intervals_add_calendar_months() {
    let rule = rule(CronScheduleUnit::Monthly, 13, "0 9 15 * *");
    let first = next(&rule, NOW, &utc).unwrap();
    // 锚点月份（10 月）的 15 日已过，下一次是 13 个月后的 11 月。
    let (year, month, day, _, _, _) = cron_expr::local_parts(first, &utc);
    assert_eq!((year, month, day), (2027, 11, 15));
    let second = next(&rule, first, &utc).unwrap();
    let (year, month, day, _, _, _) = cron_expr::local_parts(second, &utc);
    assert_eq!((year, month, day), (2028, 12, 15));
}

#[test]
fn yearly_intervals_skip_invalid_dates() {
    let rule = rule(CronScheduleUnit::Yearly, 2, "0 9 15 6 *");
    let first = next(&rule, NOW, &utc).unwrap();
    // 2026-06-15 已过，下一次是 2 年后的 2028-06-15。
    let (year, month, day, _, _, _) = cron_expr::local_parts(first, &utc);
    assert_eq!((year, month, day), (2028, 6, 15));
    let second = next(&rule, first, &utc).unwrap();
    let (year, month, day, _, _, _) = cron_expr::local_parts(second, &utc);
    assert_eq!((year, month, day), (2030, 6, 15));
}

#[test]
fn human_text_uses_the_real_interval() {
    assert_eq!(
        human(&rule(CronScheduleUnit::Hourly, 31, "49 * * * *")),
        "Every 31 hours at :49"
    );
    assert_eq!(
        human(&rule(CronScheduleUnit::Daily, 40, "0 9 * * *")),
        "Every 40 days at 9:00 AM"
    );
    assert_eq!(
        human(&rule(CronScheduleUnit::Weekly, 8, "0 9 * * 1")),
        "Every 8 weeks on Monday at 9:00 AM"
    );
    assert_eq!(
        human(&rule(CronScheduleUnit::Monthly, 13, "0 9 15 * *")),
        "Every 13 months on day 15 at 9:00 AM"
    );
    assert_eq!(
        human(&rule(CronScheduleUnit::Yearly, 2, "0 9 15 6 *")),
        "Every 2 years on 6/15 at 9:00 AM"
    );
}

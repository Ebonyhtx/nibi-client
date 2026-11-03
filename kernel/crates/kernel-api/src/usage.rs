//! v4 usage 查询的取数契约（`v4/usage/stats` 与 `v4/conversation/usage`）。
//!
//! 两张面的**事实源都是会话库里的用量表**（`model_usage` / `turn_usage` / `tool_usage`，
//! migration 0010 起 Node 与 Rust 共用同一批表）。内核只负责聚合，不做归桶与展示推导：
//! 按本地日切分、热力图、连续天数与份额都是协议层的纯投影（与 Node 的
//! `queryAppUsage` + `buildAppUsageSnapshot` 同一分法）。
//!
//! 这一层刻意只给**行级聚合结果**：`AppUsageDays` 里每行一个本地日索引，偏移由调用方给——
//! 时区解析在协议层（它才拿得到请求里的 `timeZone`），统计口径（`input_tokens` 含不含缓存、
//! 错误按什么判）留在这里，与 Node 的 SQL 逐字对齐。

use serde::{Deserialize, Serialize};

/// 应用级用量的一次聚合查询（`v4/usage/stats`）。
///
/// `since_ms == 0` 表示「全部」（Node 的 `range: "all"` 传 `since = 0`）；`tz_offset_ms` 是
/// 查询时刻的本地偏移，只用于把 `started_at` 归到本地日。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppUsageQuery {
    pub since_ms: u64,
    pub until_ms: u64,
    /// 本地日偏移（毫秒，东正西负）。Node 用 `floor((started_at + off) / DAY)` 归桶。
    pub tz_offset_ms: i64,
}

/// 模型用量的一行（`model_usage` 的窄投影）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsageModelRow {
    /// 模型 id；老行可能没有（Node 的 `model_id` 可空）。
    pub model_id: Option<String>,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub request_count: u64,
}

/// 工具用量的一行（`tool_usage` 的窄投影）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsageToolRow {
    pub tool_name: String,
    pub call_count: u64,
    pub error_count: u64,
    /// 平均耗时；没有可用行时缺席（Node 的 `avg(duration_ms)` 为 NULL）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_duration_ms: Option<f64>,
}

/// 一个本地日的三路计数（token / 回合 / 工具调用），三张表合并后的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsageDayRow {
    /// `floor((started_at + tz_offset) / DAY_MS)`——本地日索引（不是 UTC 日）。
    pub day_index: i64,
    pub total_tokens: u64,
    pub turn_count: u64,
    pub tool_call_count: u64,
}

/// 一个本地日里某个模型的 token（趋势图的数据点）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsageDayModelRow {
    pub day_index: i64,
    pub model_id: Option<String>,
    pub total_tokens: u64,
}

/// 应用级用量聚合的原始结果（Node `AppUsageQueryResult` 的镜像）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsage {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub model_request_count: u64,
    pub model_error_count: u64,
    /// 首个 token 的平均延迟；没有可用行时缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_time_to_first_token_ms: Option<f64>,
    pub total_sessions: u64,
    pub total_turns: u64,
    /// 完成回合的平均时长；没有完成回合时缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_turn_duration_ms: Option<f64>,
    pub longest_session_ms: u64,
    pub tool_call_count: u64,
    pub tool_error_count: u64,
    pub models: Vec<AppUsageModelRow>,
    pub tools: Vec<AppUsageToolRow>,
    /// 按日索引升序。
    pub days: Vec<AppUsageDayRow>,
    pub day_models: Vec<AppUsageDayModelRow>,
}

/// 会话级 token 用量（`v4/conversation/usage` 的取数面；`sessionId` 由协议层补）。
///
/// 口径与 Node `queryTaskUsage` 一致：输入侧按来源做**增量**记账（压缩会让后续 context 变小，
/// 累计消耗不能回扣历史），缓存读写只在不属于三个已知来源时单列。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub model_request_count: u64,
    pub model_error_count: u64,
    /// 来源 → 已记入基线的输入侧 token 数（下次增量比较的起点）。
    pub input_baseline_by_source: std::collections::BTreeMap<String, u64>,
}

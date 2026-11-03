//! 首 token 时延事实（141 审计 §9 第 5 项余项）：`v4/telemetry/local-ttft` 的线上形状。
//!
//! Host 契约是 `packages/shared/src/localTtft.ts` 的 `localTtftFactsSchema`。renderer 在命令信封上
//! 带 `ttft: {version, observationId}`（`localTtftContextSchema`）；内核在命令受理、回合开始、
//! 首个输出与终态时各发一份快照。
//!
//! 内核没有采集点的字段如实缺席：`requestAt`（模型请求开始没有事件）、`details`（回合准备阶段
//! 没有分段计时）、`queryId`/`requestId`/`logicalCallId`（模型端口没有请求标识）、`clockInvalid`
//! （时钟探测面未实现）。

use serde::{Deserialize, Serialize};

/// renderer 附在命令信封上的观察上下文（`localTtftContextSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalTtftContext {
    pub version: u8,
    pub observation_id: String,
}

/// 一份首 token 时延事实（`localTtftFactsSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTtftFacts {
    pub version: u8,
    pub observation_id: String,
    pub instance_id: String,
    pub command_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 第几次快照（每次状态推进加一）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_mode: Option<String>,
    pub received_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admitted_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_at: Option<u64>,
    /// 首个输出的种类：`text` / `reasoning` / `tool`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_kind: Option<String>,
    /// 终态：`completed` / `failed` / `cancelled` / `rejected` / `interrupted`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clock_invalid: Option<bool>,
}

#[cfg(test)]
#[path = "local_ttft_tests.rs"]
mod tests;

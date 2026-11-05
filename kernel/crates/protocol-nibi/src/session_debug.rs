//! `session/debug`（Host 的开发者工具面板 `DeveloperToolsPane` → `useSessionDebug`）。
//!
//! 两个事实源，都是内核事件流里已有的东西：
//!
//! - **网络面**：`KernelEvent::ModelRequestStatus`（模型传输层每次尝试一条；`local_ttft` 与
//!   `v4/telemetry/event` 已在消费同一批事实）。一条状态事实一条 `networkEntries`。
//! - **轮次面**：`KernelEvent::TurnFinished { usage }`。一轮一条 `rounds`，用量就是这一轮的
//!   累计用量；`cache` 是同一批轮次的累计。
//!
//! 刻意不把网络面的 `completed` 当轮次：模型传输层的一次「完成」是一次尝试，一轮可能有多次
//! 尝试（重试后成功），按它算轮次会把重试重复计数。
//!
//! 如实缺席（与 Node 的差异都源于内核不产生那份事实）：`requestHeaders` / `responseHeaders` 恒为
//! 空对象与 0 计数（模型层不把线上头带进事件，Node 的 adapter 脱敏后带上）；`providerKind` /
//! `baseURL` 同理缺席；`generationDurationMs` / `tokensPerSecond` 为 null（内核不把首输出时刻
//! 放进事件，`OutputSpeed` 只给最近一次请求且不落库）。Host schema 允许这些空值。

use std::collections::{HashSet, VecDeque};

use nibi_kernel_api::message::Usage;
use nibi_kernel_api::model::{ModelRequestStatus, ModelRequestStatusKind};
use serde_json::{Value, json};

/// Host `SESSION_DEBUG_LIMITS`（`packages/shared/src/session-debug.ts`）。
const ROUNDS: usize = 200;
const NETWORK: usize = 100;
const DEDUPE: usize = 2000;

/// 一个会话的调试累积器。
#[derive(Debug, Default)]
pub struct DebugRecorder {
    network: VecDeque<Value>,
    rounds: VecDeque<Value>,
    seen_network: HashSet<String>,
    request_count: u64,
    total_input: u64,
    total_cache_read: u64,
    /// 有过缺字段的轮次：之后的总命中率一律 null（与 Node 的 `hasUnknownCacheUsage` 同义）。
    has_unknown_cache: bool,
}

fn remember(keys: &mut HashSet<String>, key: &str) -> bool {
    if !keys.insert(key.to_owned()) {
        return false;
    }
    if keys.len() > DEDUPE
        && let Some(oldest) = keys.iter().next().cloned()
    {
        keys.remove(&oldest);
    }
    true
}

impl DebugRecorder {
    /// 吃一条模型请求状态（只有网络面用它）。
    pub fn observe_status(&mut self, status: &ModelRequestStatus, now: u64) -> bool {
        // 内核的 status 没有事件 id：请求 + 尝试 + 状态拼一个去重键。
        let event_key = format!(
            "{}:{}:{}:{}",
            status.request_id,
            status.attempt,
            status.kind.as_str(),
            status.query_id.as_deref().unwrap_or(""),
        );
        if !remember(&mut self.seen_network, &event_key) {
            return false;
        }
        self.network
            .push_back(network_entry(status, &event_key, now));
        while self.network.len() > NETWORK {
            self.network.pop_front();
        }
        true
    }

    /// 吃一个结束的回合（只有轮次面用它）。`main_turn` 之外的回合（控制轮、标题）不算。
    pub fn observe_turn(&mut self, usage: Option<&Usage>, now: u64) -> bool {
        let Some(usage) = usage else {
            // 没有用量的回合不进轮次表；Node 那边也不会为它记一轮。
            return false;
        };
        self.request_count += 1;
        self.total_input += usage.input_tokens;
        self.total_cache_read += usage.cache_read_input_tokens;
        let hit_rate = (usage.input_tokens > 0)
            .then(|| usage.cache_read_input_tokens as f64 / usage.input_tokens as f64);
        self.rounds.push_back(json!({
            "eventKey": format!("round:{}", self.request_count),
            "requestId": format!("round:{}", self.request_count),
            "requestIndex": self.request_count,
            "recordedAt": now,
            "usage": {
                "inputTokens": usage.input_tokens,
                "outputTokens": usage.output_tokens,
                "totalTokens": usage.input_tokens + usage.output_tokens,
                "cachedInputTokens": usage.cache_read_input_tokens,
                "cachedWriteInputTokens": usage.cache_creation_input_tokens,
            },
            "hitRate": hit_rate,
            // 内核的事件流不把首输出时刻带出来：如实 null（schema 允许 nullable）。
            "generationDurationMs": null,
            "tokensPerSecond": null,
        }));
        while self.rounds.len() > ROUNDS {
            self.rounds.pop_front();
        }
        true
    }

    /// 当前的调试快照（Host `sessionDebugSnapshotSchema`）。
    pub fn snapshot(&self, session: &str) -> Value {
        let cache = (self.request_count > 0).then(|| {
            json!({
                "hitRateRequestCount": self.request_count,
                "totalInputTokens": self.total_input,
                "totalCacheReadTokens": self.total_cache_read,
                "hitRate": (!self.has_unknown_cache && self.total_input > 0)
                    .then(|| self.total_cache_read as f64 / self.total_input as f64),
            })
        });
        json!({
            "sessionId": session,
            "rounds": self.rounds.iter().cloned().collect::<Vec<_>>(),
            "networkEntries": self.network.iter().cloned().collect::<Vec<_>>(),
            "cache": cache,
        })
    }
}

/// 一条网络条目。Host `sessionDebugNetworkEntrySchema` 是 strict：只写它认的键。
fn network_entry(status: &ModelRequestStatus, event_key: &str, now: u64) -> Value {
    let mut entry = json!({
        "eventKey": event_key,
        // 内核没有独立的 traceId：同一请求的身份用 queryId，没有时退回 requestId。
        "traceId": status.query_id.as_deref().unwrap_or(status.request_id.as_str()),
        "recordedAt": now,
        "statusType": status.kind.as_str(),
        "requestId": status.request_id,
        "providerId": status.provider_id,
        "modelId": status.model_id,
        "transport": status.transport,
        "attempt": status.attempt,
        "maxAttempts": status.max_attempts,
        // 模型层不把线上头带进事件：如实空对象与 0（schema 要求这几个键存在）。
        "requestHeaders": {},
        "responseHeaders": {},
        "requestHeaderCount": 0,
        "responseHeaderCount": 0,
    });
    if let Some(source) = &status.query_source {
        entry["querySource"] = json!(source);
    }
    if let Some(id) = &status.query_id {
        entry["queryId"] = json!(id);
    }
    // 各状态专属字段（Node 的映射同形：completed 只带 duration；failed 带 reason/retryable/
    // statusCode；retry 带 delay/nextAttempt/reason/statusCode；stalled 带 idle/timeout）。
    match status.kind {
        ModelRequestStatusKind::ModelRequestStarted => {}
        ModelRequestStatusKind::ModelRequestCompleted => {
            if let Some(duration) = status.duration_ms {
                entry["durationMs"] = json!(duration);
            }
        }
        ModelRequestStatusKind::ModelRequestFailed => {
            if let Some(duration) = status.duration_ms {
                entry["durationMs"] = json!(duration);
            }
            write_if(&mut entry, "reason", status.reason.as_ref());
            if let Some(retryable) = status.retryable {
                entry["retryable"] = json!(retryable);
            }
            if let Some(code) = status.status_code {
                entry["statusCode"] = json!(code);
            }
        }
        ModelRequestStatusKind::ModelRequestRetryScheduled => {
            write_if(&mut entry, "reason", status.reason.as_ref());
            if let Some(code) = status.status_code {
                entry["statusCode"] = json!(code);
            }
            if let Some(delay) = status.delay_ms {
                entry["delayMs"] = json!(delay);
            }
            if let Some(next) = status.next_attempt {
                entry["nextAttempt"] = json!(next);
            }
        }
        ModelRequestStatusKind::ModelStreamStalled => {
            if let Some(idle) = status.idle_ms {
                entry["idleMs"] = json!(idle);
            }
            if let Some(timeout) = status.timeout_ms {
                entry["timeoutMs"] = json!(timeout);
            }
        }
    }
    entry
}

fn write_if(entry: &mut Value, key: &str, value: Option<&String>) {
    if let Some(value) = value {
        entry[key] = json!(value);
    }
}

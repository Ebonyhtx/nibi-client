//! `session/requestRuntimePreferences`（Node `resolveSessionStartupPreferences` /
//! `requestSessionRuntimePreferences`）：会话物化时问 Host 一轮启动偏好。
//!
//! Node 拿了五项加上一个执行档位；Rust 会话层有真实开关的只有两项：
//!
//! - `askUserQuestionAutoResolutionEnabled` → 自动结束计时（与本会话的偏好一起决定起不起表）；
//! - `additionalDirectories` → 附加工作目录（判决链与环境段按会话取）。
//!
//! 其余（`memoryEnabled` / `toolSearchMode` / `subagentRuntimeConfigEnabled` /
//! `nativeSearchEnhancementsEnabled`）在 Rust 里没有会话级开关：延迟工具搜索按端点能力判定
//! （`query::deferred`）、子代理配置在内核依赖里闭环、memory 只有入站命令上的字段。它们不出现在
//! 这里，免得记一份永远不生效的偏好。
//!
//! 没有 Host（纯 CLI/TUI）或对端不认识这个方法时立刻回退到内核缺省（Node 对 `-32601`/`-32020`
//! 的兼容回退同一姿态）；超时只告警，不拦打开。

use std::time::Duration;

use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::ids::SessionId;
use serde_json::{Value, json};

use crate::context::Context;

pub const METHOD: &str = "session/requestRuntimePreferences";
/// Node `NIBI_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS`。
const LIMIT: Duration = Duration::from_secs(15);

/// Rust 会话层能消费的启动偏好。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StartupPreferences {
    pub auto_resolution: Option<bool>,
    pub additional_directories: Vec<EnvPath>,
}

/// Node `zcodeSessionRuntimePreferencesResultSchema` 里本内核用得到的字段。
pub fn parse(value: &Value) -> StartupPreferences {
    StartupPreferences {
        auto_resolution: value
            .get("askUserQuestionAutoResolutionEnabled")
            .and_then(Value::as_bool),
        additional_directories: value
            .get("additionalDirectories")
            .and_then(Value::as_array)
            .map(|directories| {
                directories
                    .iter()
                    .filter_map(Value::as_str)
                    .map(EnvPath::new)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// 问一次 Host；任何失败都回 `None`（用内核缺省）。
pub async fn request(context: &Context, session: &SessionId) -> Option<Value> {
    let params = json!({"sessionId": session.as_str(), "scope": "runtime-materialization"});
    match tokio::time::timeout(LIMIT, context.peer.request(METHOD, &params)).await {
        Ok(Ok(value)) => Some(value),
        Ok(Err(error)) => {
            tracing::debug!(
                event = "protocol.runtime_preferences.fallback",
                session = session.as_str(),
                code = error.code,
                "the host did not provide session runtime preferences"
            );
            None
        }
        Err(_) => {
            tracing::warn!(
                event = "protocol.runtime_preferences.timeout",
                session = session.as_str(),
                "the session runtime preferences request timed out"
            );
            None
        }
    }
}

#[cfg(test)]
#[path = "runtime_preferences_tests.rs"]
mod tests;

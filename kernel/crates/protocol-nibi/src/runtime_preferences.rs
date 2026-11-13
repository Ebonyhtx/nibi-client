//! `session/requestRuntimePreferences`（Node `resolveSessionStartupPreferences` /
//! `requestSessionRuntimePreferences`）：会话物化时问 Host 一轮启动偏好。
//!
//! Node 拿的五项加一个执行档位里，Rust 会话层真正消费的是：
//!
//! - `askUserQuestionAutoResolutionEnabled` → 自动结束计时；
//! - `additionalDirectories` → 附加工作目录（判决链与环境段按会话取）；
//! - `toolSearchMode` / `nativeSearchEnhancementsEnabled` → 设置页「工具搜索」「增强 Find 和 Grep」
//!   （按会话存进本机执行环境，查询与 Bash 各自读）；
//! - `integratedTerminalShell` → 设置页「集成终端 Shell」（`user-execution` 档，Node 也只在这个档位给）。
//!
//! `memoryEnabled` 是会话级记忆开关（`Kernel::set_session_memory_enabled`）；`subagentRuntimeConfigEnabled`
//! 仍在内核依赖里闭环，不出现在这里。
//!
//! 没有 Host（纯 CLI/TUI）或对端不认识这个方法时立刻回退到内核缺省（Node 对 `-32601`/`-32020`
//! 的兼容回退同一姿态）；超时只告警，不拦打开。

use std::time::Duration;

use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::session_prefs::{
    AppToolSearchMode, IntegratedShell, SessionExecutionPreferences, ShellDialect,
};
use serde_json::{Value, json};

use crate::context::Context;

pub const METHOD: &str = "session/requestRuntimePreferences";
/// `runtime-materialization`：Node 在会话物化时问的档位（AUQ、附加目录、工具搜索、增强搜索）。
pub const MATERIALIZATION_SCOPE: &str = "runtime-materialization";
/// `user-execution`：Node 在第一次跑 Bash 前问的档位（集成终端 Shell）。
pub const USER_EXECUTION_SCOPE: &str = "user-execution";
/// Node `NIBI_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS`。
const LIMIT: Duration = Duration::from_secs(15);

/// Rust 会话层能消费的启动偏好。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StartupPreferences {
    pub auto_resolution: Option<bool>,
    pub additional_directories: Vec<EnvPath>,
    /// NIBI 设置页「工作区记忆」；缺省（旧 Host / CLI）按开启。
    pub memory_enabled: Option<bool>,
    pub execution: SessionExecutionPreferences,
}

/// Node `nibiSessionRuntimePreferencesResultSchema` 里本内核用得到的字段。
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
        memory_enabled: value.get("memoryEnabled").and_then(Value::as_bool),
        execution: SessionExecutionPreferences {
            tool_search: value
                .get("toolSearchMode")
                .and_then(Value::as_str)
                .and_then(tool_search_mode),
            native_search_enhancements: value
                .get("nativeSearchEnhancementsEnabled")
                .and_then(Value::as_bool),
            integrated_shell: None,
        },
    }
}

/// `toolSearchMode` 的三档（设置页只写这三个值；旧值/未知值按「没给」）。
fn tool_search_mode(value: &str) -> Option<AppToolSearchMode> {
    match value {
        "off" => Some(AppToolSearchMode::Off),
        "local" => Some(AppToolSearchMode::Local),
        "auto" => Some(AppToolSearchMode::Auto),
        _ => None,
    }
}

/// `user-execution` 档里的 `integratedTerminalShell`：`mode: "auto"` 表示用内核自动探测
/// （Node `integratedTerminalShellToExecutionSelection` 返回 undefined），不产生覆盖。
pub fn parse_execution_shell(value: &Value) -> Option<IntegratedShell> {
    let selection = value.get("integratedTerminalShell")?;
    if selection.get("mode").and_then(Value::as_str) != Some("shell") {
        return None;
    }
    let dialect = match selection.get("dialect").and_then(Value::as_str)? {
        "cmd" => ShellDialect::Cmd,
        "git-bash" => ShellDialect::GitBash,
        _ => return None,
    };
    let path = selection
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())?;
    Some(IntegratedShell {
        dialect,
        path: path.to_owned(),
    })
}

/// 问 Host 的一个档位（`runtime-materialization` / `user-execution`）。
pub async fn request_scope(
    context: &Context,
    session: &SessionId,
    scope: &str,
) -> Option<Value> {
    let params = json!({"sessionId": session.as_str(), "scope": scope});
    match tokio::time::timeout(LIMIT, context.peer.request(METHOD, &params)).await {
        Ok(Ok(value)) => Some(value),
        Ok(Err(error)) => {
            tracing::debug!(
                event = "protocol.runtime_preferences.fallback",
                session = session.as_str(),
                scope,
                code = error.code,
                "the host did not provide session runtime preferences"
            );
            None
        }
        Err(_) => {
            tracing::warn!(
                event = "protocol.runtime_preferences.timeout",
                session = session.as_str(),
                scope,
                "the session runtime preferences request timed out"
            );
            None
        }
    }
}

#[cfg(test)]
#[path = "runtime_preferences_tests.rs"]
mod tests;

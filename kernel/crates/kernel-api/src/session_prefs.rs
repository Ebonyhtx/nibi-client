//! 会话物化时 Host 给的执行偏好（Node `session/requestRuntimePreferences` 的三项，NIBI 设置页
//! 「常规」里的工具搜索、增强 Find/Grep、集成终端 Shell）。
//!
//! Node 在会话物化时把这三项交给 agent，之后新建/冷恢复的会话按物化那一刻的值执行，当前会话保持
//! 原设置。Rust 内核的 app-server 一进程承载多个会话，所以偏好按会话存（本机执行环境里的一张表），
//! 查询与 Bash 执行各自按会话读取；不放进进程级 `Defaults`，也不改 `ToolUseContext`（它由几十处
//! 测试构造，加必填字段会把噪声铺满整个仓库）。

use serde::{Deserialize, Serialize};

/// 设置页「工具搜索」的三档（`AppSettings.toolSearchMode`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppToolSearchMode {
    /// 关闭：发完整工具目录，不注册 ToolSearch。
    Off,
    /// 本地按需加载（Rust 产品路径固定本地）。
    Local,
    /// 按模型选择原生或本地；Rust 产品路径固定本地，与 `Local` 同一行为。
    Auto,
}

/// 设置页「集成终端 Shell」的方言（Windows 只有这两种）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellDialect {
    Cmd,
    /// Git Bash（POSIX 语法；Rust 的 Bash 工具本来就要求它）。
    GitBash,
}

/// 用户显式选择的 shell。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegratedShell {
    pub dialect: ShellDialect,
    /// 可执行文件的绝对路径（`cmd.exe` 或 `bash.exe`）；Host 已经校验过存在性。
    pub path: String,
}

/// 一个会话的执行偏好。字段缺省表示 Host 没给（内核用缺省行为）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionExecutionPreferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_search: Option<AppToolSearchMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_search_enhancements: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrated_shell: Option<IntegratedShell>,
}

impl SessionExecutionPreferences {
    /// 三项都没给：不用写表，也不改变任何缺省行为。
    pub fn is_empty(&self) -> bool {
        self.tool_search.is_none()
            && self.native_search_enhancements.is_none()
            && self.integrated_shell.is_none()
    }

    /// 只补缺的字段（先物化的值优先；冷恢复时 Host 可能只给一部分）。
    pub fn fill_missing_from(&mut self, other: &Self) {
        if self.tool_search.is_none() {
            self.tool_search = other.tool_search;
        }
        if self.native_search_enhancements.is_none() {
            self.native_search_enhancements = other.native_search_enhancements;
        }
        if self.integrated_shell.is_none() {
            self.integrated_shell = other.integrated_shell.clone();
        }
    }
}

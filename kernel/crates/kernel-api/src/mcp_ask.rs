//! MCP 询问的公共结论类型（docs/specs/rust-cli/ext.md §3.13.6）：Elicitation 类 hook 的结论用
//! [`ElicitationAction`]（对齐上游 ZCode-rs 0.1.88 的 `kernel-api/src/mcp_ask.rs` 的同名类型）。

use serde::{Deserialize, Serialize};

/// 服务器要用户做的一个动作（MCP `ElicitResult.action`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElicitationAction {
    Accept,
    Decline,
    Cancel,
}

impl ElicitationAction {
    /// 线上的动作名（hook 的 `action`）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }
}

#[cfg(test)]
#[path = "mcp_ask_tests.rs"]
mod tests;

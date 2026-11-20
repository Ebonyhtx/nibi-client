//! 权限规则的语法（docs/specs/rust-cli/shell-permissions.md §4.2）：规则串的解析与写回。
//!
//! 规则串是 `Tool` 或 `Tool(content)`：content 里的 `(`、`)`、`\` 用反斜杠转义；`Tool()` 与 `Tool(*)` 等同于整个
//! 工具。旧工具名按别名表换成新名。判决链（policy）与 hook 的权限更新（hooks）共用这一份（对齐上游 ZCode-rs
//! 0.1.88 的 `kernel-api/src/permission/syntax.rs`）：以前 policy 自己一份，hooks 没有。

use crate::permission::PermissionRule;
use crate::tool::canonical_tool_name;

/// 规则的工具名：旧名换成新名（与 hook 的 matcher 共用 [`crate::tool::LEGACY_TOOL_NAMES`]）。
/// `AgentOutputTool` / `BashOutputTool` 已退役（不再是别名）；保留它们，免得用户已有的 deny 规则失效。
pub fn canonical_rule_tool(name: &str) -> &str {
    match name {
        "AgentOutputTool" | "BashOutputTool" => "TaskOutput",
        other => canonical_tool_name(other),
    }
}

/// `index` 处的字符前面的反斜杠是偶数个（没有被转义）。
fn unescaped(text: &str, index: usize) -> bool {
    text[..index]
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'\\')
        .count()
        % 2
        == 0
}

fn first_unescaped(text: &str, needle: u8) -> Option<usize> {
    (0..text.len()).find(|&index| text.as_bytes()[index] == needle && unescaped(text, index))
}

fn last_unescaped(text: &str, needle: u8) -> Option<usize> {
    (0..text.len())
        .rev()
        .find(|&index| text.as_bytes()[index] == needle && unescaped(text, index))
}

fn unescape(content: &str) -> String {
    content
        .replace(r"\(", "(")
        .replace(r"\)", ")")
        .replace(r"\\", r"\")
}

fn escape(content: &str) -> String {
    content
        .replace('\\', r"\\")
        .replace('(', r"\(")
        .replace(')', r"\)")
}

/// 规则串解析成规则值。
pub fn parse_rule(text: &str) -> PermissionRule {
    let whole = || PermissionRule {
        tool: canonical_rule_tool(text).to_owned(),
        content: None,
    };
    let Some(open) = first_unescaped(text, b'(') else {
        return whole();
    };
    let Some(close) = last_unescaped(text, b')') else {
        return whole();
    };
    if close <= open || close != text.len() - 1 || open == 0 {
        return whole();
    }
    let tool = canonical_rule_tool(&text[..open]).to_owned();
    let raw = &text[open + 1..close];
    let content = (!raw.is_empty() && raw != "*").then(|| unescape(raw));
    PermissionRule { tool, content }
}

/// 规则值写回规则串。
pub fn format_rule(rule: &PermissionRule) -> String {
    match rule.content.as_deref() {
        None | Some("") => rule.tool.clone(),
        Some(content) => format!("{}({})", rule.tool, escape(content)),
    }
}

#[cfg(test)]
#[path = "syntax_tests.rs"]
mod tests;

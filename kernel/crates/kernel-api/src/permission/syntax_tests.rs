//! 规则串的解析与写回（shell-permissions.md §4.2）。

use super::*;
use crate::permission::PermissionRule;

fn rule(tool: &str, content: Option<&str>) -> PermissionRule {
    PermissionRule {
        tool: tool.to_owned(),
        content: content.map(str::to_owned),
    }
}

#[test]
fn rule_strings_round_trip_with_escapes() {
    assert_eq!(parse_rule("Bash"), rule("Bash", None));
    assert_eq!(
        parse_rule("Bash(git status:*)"),
        rule("Bash", Some("git status:*"))
    );
    assert_eq!(parse_rule("Bash()"), rule("Bash", None));
    assert_eq!(parse_rule("Bash(*)"), rule("Bash", None));
    assert_eq!(
        parse_rule(r"Bash(echo \(x\))"),
        rule("Bash", Some("echo (x)"))
    );
    assert_eq!(
        format_rule(&rule("Bash", Some("echo (x)"))),
        r"Bash(echo \(x\))"
    );
    // 旧名换成新名。
    assert_eq!(parse_rule("Task"), rule("Agent", None));
    assert_eq!(parse_rule("KillShell"), rule("TaskStop", None));
    assert_eq!(parse_rule("Read(//etc/**)"), rule("Read", Some("//etc/**")));
    // 右括号不在末尾：整串是工具名。
    assert_eq!(parse_rule("Bash(x) y"), rule("Bash(x) y", None));
}

#[test]
fn formatting_an_empty_content_is_the_whole_tool() {
    assert_eq!(format_rule(&rule("Bash", None)), "Bash");
    assert_eq!(format_rule(&rule("Bash", Some(""))), "Bash");
    assert_eq!(format_rule(&rule("Bash", Some(r"a\b"))), r"Bash(a\\b)");
}

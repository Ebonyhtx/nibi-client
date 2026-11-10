//! 自定义命令的名字、frontmatter 提取与扫描边界的单元测试。

use super::*;

#[test]
fn command_names_follow_node_pattern() {
    assert!(valid_name("greet"));
    assert!(valid_name("mathmodel"));
    assert!(valid_name("sub:do"));
    assert!(valid_name("a"));
    assert!(!valid_name(""));
    assert!(!valid_name("Greet"));
    assert!(!valid_name("-greet"));
    assert!(!valid_name("greet space"));
    assert!(!valid_name(&"a".repeat(65)));
}

#[test]
fn relative_paths_become_command_names() {
    assert_eq!(
        command_name("/p/.nibi/commands", "/p/.nibi/commands/greet.md").as_deref(),
        Some("greet")
    );
    assert_eq!(
        command_name("/p/.nibi/commands", "/p/.nibi/commands/sub/do.md").as_deref(),
        Some("sub:do")
    );
    assert_eq!(
        command_name("/p/.nibi/commands", "/p/.nibi/commands/readme.txt"),
        None
    );
}

#[test]
fn description_falls_back_to_the_first_body_line() {
    assert_eq!(first_line("# Title\n\nBody.").as_deref(), Some("Title"));
    assert_eq!(first_line("- one\n- two").as_deref(), Some("one"));
    assert_eq!(first_line(" \n\n"), None);
}

#[test]
fn long_descriptions_are_truncated() {
    let text = "x".repeat(MAX_DESCRIPTION_LENGTH + 10);
    assert_eq!(
        truncate(&text, MAX_DESCRIPTION_LENGTH).chars().count(),
        MAX_DESCRIPTION_LENGTH
    );
}

#[test]
fn reserved_names_are_lowercased_and_stripped() {
    assert!(is_reserved("/Compact"));
    assert!(is_reserved("plan"));
    assert!(!is_reserved("mathmodel"));
}

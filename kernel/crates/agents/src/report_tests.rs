//! 子代理的结果与通知（agents.md §5）：不读对照数据的用例。读对照数据、逐字比较的在 `report_parity_tests.rs`
//! （docs/specs/rust-cli/export.md §5）。

use super::{Ending, Report, handback, launched, notification};

fn report(text: &str, tokens: u64, duration_ms: u64) -> Report {
    Report {
        text: text.to_owned(),
        tokens,
        tool_uses: 0,
        duration_ms,
    }
}

/// 一次性的 agent 没有尾注；空报告给出占位文本。
#[test]
fn an_empty_one_shot_report_has_the_placeholder() {
    let short = handback("x", &report("", 0, 0), false);
    assert!(short.ends_with("The report follows:\n  (Subagent completed but returned no output.)"));
}

/// 启动结果的 agentId 一行：本工程的 `agent_<uuid>` 带 `-`，按原样写出（对齐脚本取 ID 的模式要认 `[\w-]+`，
/// L18 修正的回归）。
#[test]
fn the_launch_result_keeps_the_dashed_agent_id() {
    let ours = launched("agent_3f2b9c1e-8a4d-4c2e-9f1a-2b3c4d5e6f70");
    assert!(ours.contains("\nagentId: agent_3f2b9c1e-8a4d-4c2e-9f1a-2b3c4d5e6f70 (internal ID"));
}

/// 失败：摘要带错误（没有时 `Unknown error`），已有的文本作 `<result>`，`<usage>` 也带（K4：
/// 失败通知不能只有 error/agentId/duration）；`<summary>` 与 `<result>` 转义 `&`、`<`、`>`。
#[test]
fn failed_notifications_carry_the_error_and_escape_markup() {
    let text = notification(
        "a1",
        Some("toolu_1"),
        "Fix <b> & c",
        Ending::Failed,
        &report("partial <x>", 3, 4),
        Some("disk full"),
    );
    assert!(
        text.contains("<summary>Agent \"Fix &lt;b&gt; &amp; c\" failed. disk full</summary>"),
        "{text}"
    );
    assert!(text.contains("</note>\n<result>partial &lt;x&gt;</result>"));
    assert!(text.contains("\n<error>disk full</error>\n<usage>"), "{text}");
    assert!(
        text.contains(
            "<usage><subagent_tokens>3</subagent_tokens><tool_uses>0</tool_uses><duration_ms>4</duration_ms></usage>"
        ),
        "{text}"
    );
    let unknown = notification("a1", None, "d", Ending::Failed, &report("", 0, 0), None);
    assert!(unknown.contains("failed. Unknown error</summary>"));
    // 没有工具调用（SendMessage 留下的消息续跑之后，A8）：没有 `<tool-use-id>` 这一行。
    assert!(
        unknown.starts_with("<system-reminder>\n[SYSTEM NOTIFICATION")
            && unknown.contains("<task-id>a1</task-id>\n<status>failed</status>")
    );
    assert!(!unknown.contains("<result>"));
    // 失败也带 `<usage>`（K4）。
    assert!(unknown.contains("<usage><subagent_tokens>0</subagent_tokens>"), "{unknown}");
    // `<error>` 与 `<summary>` 一样转义标记字符，父模型不会读到半截 XML。
    let escaped = notification(
        "a1",
        None,
        "d",
        Ending::Failed,
        &report("", 0, 0),
        Some("a & <b>"),
    );
    assert!(escaped.contains("<error>a &amp; &lt;b&gt;</error>"), "{escaped}");
}

/// 完成与停止不带 `<error>`：只有失败才有 provider 原文。
#[test]
fn only_failed_notifications_have_an_error_block() {
    for (ending, error) in [(Ending::Completed, Some("ignored")), (Ending::Killed, None)] {
        let text = notification("a1", None, "d", ending, &report("done", 1, 2), error);
        assert!(!text.contains("<error>"), "{text}");
    }
}

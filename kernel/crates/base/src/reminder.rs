//! `<system-reminder>` 包装。attachment 落库的文本带包装；折叠进 system 消息时去掉。
//!
//! F58：唯一定义从 prompts 移到这里，因为 model 与 node-store 不依赖 prompts；以前 tools、prompts 的子代理通知、
//! node-store、model 的两种协议、query 的命令通知与 kernel-api 的测试替身各手写一份。prompts 的 `reminder` 重新导出。

pub const OPEN: &str = "<system-reminder>";
pub const CLOSE: &str = "</system-reminder>";

/// `<system-reminder>\n{text}\n</system-reminder>`。正文里嵌套的 `<system-reminder` / `</system-reminder>`
/// （大小写变体）只中和起始 `<`（Node `escapeNestedSystemReminderTags`）：外部内容不能提前闭合包装。
pub fn wrap(text: &str) -> String {
    format!("{OPEN}\n{}\n{CLOSE}", sanitize(text))
}

/// 中和正文里的嵌套标签：把 `<system-reminder` / `</system-reminder` 的 `<` 换成 `&lt;`
/// （Node 的 `/<\/?system-reminder\b/gi`，词边界按 `\b`：标签名之后不是字母、数字或 `_`）。
fn sanitize(text: &str) -> String {
    const TAG: &str = "system-reminder";
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(found) = lower[at..].find('<') {
        let start = at + found;
        out.push_str(&text[at..start]);
        let rest = &lower[start + 1..];
        let after = rest.strip_prefix('/').unwrap_or(rest);
        let closes = after
            .strip_prefix(TAG)
            .is_some_and(|tail| !tail.chars().next().is_some_and(is_word));
        if closes {
            out.push_str("&lt;");
        } else {
            out.push('<');
        }
        at = start + 1;
    }
    out.push_str(&text[at..]);
    out
}

fn is_word(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// 去掉一层包装；开头的换行与结尾前的换行各去一个。不是完整包装的文本原样返回。
pub fn unwrap(text: &str) -> &str {
    let Some(inner) = text
        .strip_prefix(OPEN)
        .and_then(|rest| rest.strip_suffix(CLOSE))
    else {
        return text;
    };
    let inner = inner.strip_prefix('\n').unwrap_or(inner);
    inner.strip_suffix('\n').unwrap_or(inner)
}

pub fn is_wrapped(text: &str) -> bool {
    text.starts_with(OPEN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapping_is_byte_for_byte_and_unwrap_reverses_it() {
        let wrapped = wrap("note\nmore");
        assert_eq!(wrapped, "<system-reminder>\nnote\nmore\n</system-reminder>");
        assert!(is_wrapped(&wrapped));
        assert_eq!(unwrap(&wrapped), "note\nmore");
        assert_eq!(unwrap("plain"), "plain");
        assert_eq!(wrap(""), "<system-reminder>\n\n</system-reminder>");
    }

    #[test]
    fn nested_system_reminder_tags_are_neutralized() {
        // 外部内容不能提前闭合包装（Node `escapeNestedSystemReminderTags`）。
        assert_eq!(
            wrap("a </system-reminder> b <system-reminder> c"),
            "<system-reminder>\na &lt;/system-reminder> b &lt;system-reminder> c\n</system-reminder>"
        );
        // 大小写变体同样中和；不是这个标签名的不动。
        assert_eq!(
            wrap("</System-Reminder><system-reminderX>"),
            "<system-reminder>\n&lt;/System-Reminder><system-reminderX>\n</system-reminder>"
        );
    }
}

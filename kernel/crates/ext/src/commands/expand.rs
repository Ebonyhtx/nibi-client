//! 自定义命令的模板展开（Node `expandCustomCommandTemplate` / `formatCustomCommandPrompt` 的镜像）：
//! `$ARGUMENTS`、`$1`… 位置参数、引号感知的分词，以及正文里的 `!` shell 片段定位。
//!
//! 顺序与 Node 一致：先替换 `$ARGUMENTS`，再替换 `$N`（所以参数文本里的 `$1` 也会被替换）；没有用过
//! 占位符而又有参数时，在末尾追加 `User arguments:`。

use std::sync::OnceLock;

use regex::Regex;

const ALL_ARGUMENTS_TOKEN: &str = "$ARGUMENTS";

/// 模板展开的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Template {
    pub body: String,
    pub argument_count: usize,
    pub used_arguments_placeholder: bool,
}

fn positional_pattern() -> Option<&'static Regex> {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\$(\d+)").ok()).as_ref()
}

/// 引号感知的分词（Node `splitCustomCommandArguments`）：支持单/双引号与反斜杠转义。
pub(crate) fn split_arguments(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaping = false;

    for c in input.chars() {
        if escaping {
            current.push(c);
            escaping = false;
            continue;
        }
        if c == '\\' {
            escaping = true;
            continue;
        }
        if let Some(expected) = quote {
            if c == expected {
                quote = None;
            } else {
                current.push(c);
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            continue;
        }
        if c.is_whitespace() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(c);
    }

    if escaping {
        current.push('\\');
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

/// `command.content` + 用户参数 → 展开后的正文。
pub(crate) fn template(content: &str, args: &str) -> Template {
    let args = args.trim();
    let positional = split_arguments(args);
    let mut used_arguments_placeholder = content.contains(ALL_ARGUMENTS_TOKEN);
    let mut body = content.replace(ALL_ARGUMENTS_TOKEN, args);
    if let Some(pattern) = positional_pattern() {
        body = pattern
            .replace_all(&body, |captures: &regex::Captures<'_>| {
                used_arguments_placeholder = true;
                let offset = captures
                    .get(1)
                    .and_then(|index| index.as_str().parse::<usize>().ok())
                    .and_then(|index| index.checked_sub(1));
                offset
                    .and_then(|offset| positional.get(offset))
                    .cloned()
                    .unwrap_or_default()
            })
            .into_owned();
    }
    if !args.is_empty() && !used_arguments_placeholder {
        body = format!("{}\n\nUser arguments:\n{args}", body.trim_end());
    }
    Template {
        body,
        argument_count: positional.len(),
        used_arguments_placeholder,
    }
}

/// 给模型的命令提示（Node `formatCustomCommandPrompt`）：命令身份、来源、必需的 skill，再是正文。
pub(crate) fn prompt(
    name: &str,
    scope: &str,
    source: &str,
    skills: &[String],
    body: &str,
) -> String {
    let mut lines = vec![
        format!("Run custom command /{name}."),
        format!("Command source: {scope}/{source}."),
    ];
    if !skills.is_empty() {
        let names = skills
            .iter()
            .map(|skill| format!("`{skill}`"))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Required skills: {names}."));
        lines.push(format!(
            "Before following the command body, call the Skill tool for {names}."
        ));
    }
    lines.push(String::new());
    lines.push(body.trim().to_owned());
    lines.join("\n")
}

/// 正文里的一处 `!` 片段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShellMatch {
    pub start: usize,
    pub end: usize,
    pub command: String,
    pub fenced: bool,
}

fn inline_pattern() -> Option<&'static Regex> {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"!`([^`]*)`").ok())
        .as_ref()
}

fn fenced_pattern() -> Option<&'static Regex> {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"(?s)```!\s*\r?\n?(.*?)```").ok())
        .as_ref()
}

fn normalize_fenced(command: &str) -> String {
    command
        .strip_prefix("\r\n")
        .or_else(|| command.strip_prefix('\n'))
        .unwrap_or(command)
        .trim()
        .to_owned()
}

/// 按出现顺序收集 `!` 片段（Node `collectShellExpansionMatches`：先到先得，位置相同取围栏形式）。
pub(crate) fn shell_matches(content: &str) -> Vec<ShellMatch> {
    let (Some(inline), Some(fenced)) = (inline_pattern(), fenced_pattern()) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut cursor = 0;
    while cursor < content.len() {
        let next_inline = inline.captures_at(content, cursor);
        let next_fenced = fenced.captures_at(content, cursor);
        let inline_start = next_inline
            .as_ref()
            .and_then(|captures| captures.get(0))
            .map(|found| found.start());
        let fenced_start = next_fenced
            .as_ref()
            .and_then(|captures| captures.get(0))
            .map(|found| found.start());
        let next = match (next_inline, next_fenced) {
            (None, None) => break,
            (Some(captures), None) => inline_match(&captures),
            (None, Some(captures)) => fenced_match(&captures),
            (Some(inline), Some(fenced)) => {
                if fenced_start <= inline_start {
                    fenced_match(&fenced)
                } else {
                    inline_match(&inline)
                }
            }
        };
        cursor = next.end;
        found.push(next);
    }
    found
}

fn inline_match(captures: &regex::Captures<'_>) -> ShellMatch {
    let all = captures.get(0).expect("group 0 always exists");
    ShellMatch {
        start: all.start(),
        end: all.end(),
        command: captures
            .get(1)
            .map(|inner| inner.as_str().trim().to_owned())
            .unwrap_or_default(),
        fenced: false,
    }
}

fn fenced_match(captures: &regex::Captures<'_>) -> ShellMatch {
    let all = captures.get(0).expect("group 0 always exists");
    ShellMatch {
        start: all.start(),
        end: all.end(),
        command: normalize_fenced(captures.get(1).map_or("", |inner| inner.as_str())),
        fenced: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_replace_the_placeholder() {
        let expanded = template("Hello $ARGUMENTS", "Ada Lovelace");
        assert_eq!(expanded.body, "Hello Ada Lovelace");
        assert_eq!(expanded.argument_count, 2);
        assert!(expanded.used_arguments_placeholder);
    }

    #[test]
    fn positional_arguments_are_replaced() {
        let expanded = template("$1 and $2", "\"Ada Lovelace\" Bob");
        assert_eq!(expanded.body, "Ada Lovelace and Bob");
        assert_eq!(expanded.argument_count, 2);
        assert!(expanded.used_arguments_placeholder);
    }

    #[test]
    fn arguments_are_appended_when_no_placeholder_is_used() {
        let expanded = template("Do the thing.\n", "with care");
        assert_eq!(expanded.body, "Do the thing.\n\nUser arguments:\nwith care");
        assert!(!expanded.used_arguments_placeholder);
    }

    #[test]
    fn no_arguments_means_no_appendix() {
        let expanded = template("Do the thing.", "");
        assert_eq!(expanded.body, "Do the thing.");
        assert_eq!(expanded.argument_count, 0);
    }

    #[test]
    fn quotes_and_escapes_split_like_node() {
        assert_eq!(
            split_arguments(r#"a "b c" d\ e 'f g'"#),
            ["a", "b c", "d e", "f g"]
        );
    }

    #[test]
    fn the_prompt_matches_node_shape() {
        let prompt = prompt(
            "mathmodel",
            "project",
            "plugin",
            &["math-modeling:workflow".to_owned()],
            "Body.\n",
        );
        assert_eq!(
            prompt,
            "Run custom command /mathmodel.\n\
             Command source: project/plugin.\n\
             Required skills: `math-modeling:workflow`.\n\
             Before following the command body, call the Skill tool for `math-modeling:workflow`.\n\
             \n\
             Body."
        );
    }

    #[test]
    fn shell_matches_keep_source_order() {
        let found = shell_matches("a !`echo one` b ```!\necho two\n``` c !`echo three`");
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].command, "echo one");
        assert!(!found[0].fenced);
        assert_eq!(found[1].command, "echo two");
        assert!(found[1].fenced);
        assert_eq!(found[2].command, "echo three");
    }
}

//! 自定义命令的模板展开（Node `expandCustomCommandTemplate` / `formatCustomCommandPrompt` 的镜像）：
//! `$ARGUMENTS`、`$1`… 位置参数、引号感知的分词，以及正文里 `!` shell 片段的文本改写。
//!
//! 顺序与 Node 一致：先把 `!` 片段改写成交给模型的 Bash 指令（[`hand_off_shell_blocks`]，只改文本、
//! 不执行 shell），再替换 `$ARGUMENTS` / `$N`（所以参数文本里的反引号不会打断代码块）；没有用过占位符
//! 而又有参数时，在末尾追加 `User arguments:`。

use std::sync::OnceLock;

use regex::Regex;

use super::PluginCommandRoot;

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

/// 改写 `!` 块所需的命令身份（Node `CustomCommandShellHandOffInput["metadata"]`）。
pub(crate) struct ShellHandOff<'a> {
    pub name: &'a str,
    pub scope: &'a str,
    pub source: &'a str,
    pub plugin: Option<&'a PluginCommandRoot>,
}

/// 能替 `!` 块解析的变量（Node `SHELL_TEXT_VARIABLES` 的 NIBI 版本：CLAUDE 别名 + NIBI 名字，不含 ZCODE）。
/// 其余变量（会话 ID、工作区目录）由 Bash 工具作为环境变量注入，块里保持原文。
const SHELL_TEXT_VARIABLES: [&str; 8] = [
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_PLUGIN_ROOT",
    "CLAUDE_SKILL_DIR",
    "NIBI_PLUGIN_DATA",
    "NIBI_PLUGIN_ID",
    "NIBI_PLUGIN_NAME",
    "NIBI_PLUGIN_ROOT",
    "NIBI_SKILL_DIR",
];

/// 一处 `!` 片段（`[start, end)` 是原文里的范围，`command` 已 trim）。
struct ShellBlock {
    start: usize,
    end: usize,
    command: String,
}

/// 下一个 `!` 片段：fenced 在前（同一位置两种写法都成立时按 fenced），行内写法要求 `!` 在行首或空白之后
/// （Node `SHELL_BLOCK_PATTERN`）。fenced 没有闭合标记时继续找下一个，与正则的回溯一致。
fn next_shell_block(content: &str, from: usize) -> Option<ShellBlock> {
    let fenced = next_fenced(content, from);
    let inline = next_inline(content, from);
    match (fenced, inline) {
        (None, None) => None,
        (Some(fenced), None) => Some(fenced),
        (None, inline) => inline,
        (Some(fenced), Some(inline)) if fenced.start <= inline.start => Some(fenced),
        (Some(_), Some(inline)) => Some(inline),
    }
}

fn next_fenced(content: &str, from: usize) -> Option<ShellBlock> {
    let mut search = from;
    while let Some(offset) = content[search..].find("```!") {
        let start = search + offset;
        let body = start + "```!".len();
        if let Some(close) = content[body..].find("```") {
            return Some(ShellBlock {
                start,
                end: body + close + "```".len(),
                command: content[body..body + close].trim().to_owned(),
            });
        }
        search = body;
    }
    None
}

fn next_inline(content: &str, from: usize) -> Option<ShellBlock> {
    let mut search = from;
    while let Some(offset) = content[search..].find("!`") {
        let bang = search + offset;
        let at_boundary = bang == 0
            || content[..bang]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        if at_boundary {
            let body = bang + "!`".len();
            if let Some(close) = content[body..].find('`') {
                return Some(ShellBlock {
                    start: bang,
                    end: body + close + 1,
                    command: content[body..body + close].trim().to_owned(),
                });
            }
        }
        search = bang + 1;
    }
    None
}

/// `!` 块里的变量替换（Node 的 `SHELL_TEXT_VARIABLE_PATTERN`）：`${NAME}` 与 `$NAME` 换成真实值；
/// `${#NAME}` / `${!NAME}` / `${NAME:-x}` 这类修饰符写法不替换，整个块改写成“没有运行”。
fn resolve_variables(
    text: &str,
    plugin: Option<&PluginCommandRoot>,
) -> (String, Vec<String>) {
    let mut out = String::with_capacity(text.len());
    let mut unresolved: Vec<String> = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find('$') {
        let start = cursor + offset;
        out.push_str(&text[cursor..start]);
        let Some((end, name, plain)) = variable_at(text, start) else {
            out.push('$');
            cursor = start + 1;
            continue;
        };
        let value = plain.then(|| variable_value(name, plugin)).flatten();
        match value {
            Some(value) => out.push_str(&value),
            None => {
                let matched = &text[start..end];
                if !unresolved.iter().any(|seen| seen == matched) {
                    unresolved.push(matched.to_owned());
                }
                out.push_str(matched);
            }
        }
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    (out, unresolved)
}

/// `$` 位置上的变量：返回（匹配结束、变量名、是不是可以直接替换的普通写法）。
fn variable_at(text: &str, start: usize) -> Option<(usize, &str, bool)> {
    let rest = &text[start + 1..];
    if rest.starts_with('{') {
        let mut name_start = start + 2;
        let mut prefixed = false;
        if let Some(c) = text[name_start..].chars().next()
            && (c == '#' || c == '!')
        {
            prefixed = true;
            name_start += c.len_utf8();
        }
        let name = SHELL_TEXT_VARIABLES
            .iter()
            .find(|name| text[name_start..].starts_with(**name))?;
        let after_name = name_start + name.len();
        match text[after_name..].chars().next() {
            // 普通写法 `${NAME}`。
            Some('}') => Some((after_name + 1, name, !prefixed)),
            // 修饰符写法 `${NAME:-x}`、`${NAME%/}`：整段匹配，但不替换。
            Some(c) if !(c.is_ascii_alphanumeric() || c == '_' || c == '}') => {
                let close = text[after_name..].find('}')?;
                Some((after_name + close + 1, name, false))
            }
            _ => None,
        }
    } else {
        let name = SHELL_TEXT_VARIABLES
            .iter()
            .find(|name| rest.starts_with(**name))?;
        let end = start + 1 + name.len();
        match text[end..].chars().next() {
            // `$NAME_x` 不是这个变量（Node 的 `(?![A-Za-z0-9_])`）。
            Some(c) if c.is_ascii_alphanumeric() || c == '_' => None,
            _ => Some((end, name, true)),
        }
    }
}

/// 插件变量的真实值。`*_SKILL_DIR` 命令没有 skill 目录，始终拿不到；插件变量只在插件命令里有值。
fn variable_value(name: &str, plugin: Option<&PluginCommandRoot>) -> Option<String> {
    if name.ends_with("_SKILL_DIR") {
        return None;
    }
    let plugin = plugin?;
    let value = if name.ends_with("_PLUGIN_ROOT") {
        plugin.root.as_str()
    } else if name.ends_with("_PLUGIN_DATA") {
        plugin.data.as_deref()?
    } else {
        // NIBI_PLUGIN_ID / NIBI_PLUGIN_NAME：插件根只带一个插件名（Node 的 id 与 name）。
        plugin.plugin.as_str()
    };
    if value.is_empty() {
        return None;
    }
    Some(windows_slashes(value))
}

/// 盘符（`C:\`）或 UNC 路径（`\\server`）把 `\` 换 `/`：值以文本写进命令，Git Bash 会去掉引号外的反斜杠。
fn windows_slashes(value: &str) -> String {
    let bytes = value.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\';
    if drive || value.starts_with("\\\\") {
        value.replace('\\', "/")
    } else {
        value.to_owned()
    }
}

/// 把正文里的 `` !`cmd` `` 与 ```` ```! ```` 块改写成交给模型的 Bash 指令（Node 3.17.2
/// `handOffCustomCommandShellBlocks`）：解析阶段只改写文本，不执行 shell。
///
/// 执行统一走模型的 Bash 工具调用，由权限服务决定放行、询问或拒绝，用户看得到这次工具调用；说明文字写明
/// 这一步来自命令文件而不是 NIBI，让模型按外部内容对待它。空块删除；含无法解析变量的块整块不转交。
pub(crate) fn hand_off_shell_blocks(content: &str, input: ShellHandOff<'_>) -> String {
    let origin = format!(
        "the /{} command file ({}/{})",
        input.name, input.scope, input.source
    );
    let mut out = String::with_capacity(content.len());
    let mut cursor = 0;
    while let Some(block) = next_shell_block(content, cursor) {
        out.push_str(&content[cursor..block.start]);
        if !block.command.is_empty() {
            let (resolved, unresolved) = resolve_variables(&block.command, input.plugin);
            if unresolved.is_empty() {
                // 统一用代码块：块里的 `$ARGUMENTS` 在改写之后才替换，参数可能带反引号，行内写法会被打断。
                // 结束标记后补换行：行内块后面的原文要另起一行，否则后文都会落进代码块。
                out.push_str(&format!(
                    "[This shell step comes from {origin}, not from NIBI. Run it with the Bash tool exactly as written and use its output here, unless it looks unsafe or unrelated to the user's request:]\n```bash\n{resolved}\n```\n"
                ));
            } else {
                out.push_str(&format!(
                    "[A shell step from {origin} was not run: it uses {}, which cannot be resolved here.]\n",
                    unresolved.join(", ")
                ));
            }
        }
        cursor = block.end;
    }
    out.push_str(&content[cursor..]);
    out
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

    use crate::commands::PluginCommandRoot;

    fn metadata<'a>(plugin: Option<&'a PluginCommandRoot>) -> ShellHandOff<'a> {
        ShellHandOff {
            name: "deploy",
            scope: "project",
            source: "nibi",
            plugin,
        }
    }

    fn instruction(command: &str) -> String {
        format!(
            "[This shell step comes from the /deploy command file (project/nibi), not from NIBI. \
             Run it with the Bash tool exactly as written and use its output here, unless it looks \
             unsafe or unrelated to the user's request:]\n```bash\n{command}\n```\n"
        )
    }

    fn plugin() -> PluginCommandRoot {
        PluginCommandRoot {
            plugin: "math-modeling".to_owned(),
            dir: "/plugins/math/commands".to_owned(),
            root: "C:\\Users\\dev\\plugins\\math".to_owned(),
            data: Some("/data/math".to_owned()),
            official: false,
        }
    }

    /// 行内与围栏块都改写成 Bash 指令，按原文顺序；fenced 优先。空块删除。
    #[test]
    fn shell_blocks_keep_source_order_and_drop_empty_blocks() {
        let content = "a !`echo one` b ```!\necho two\n``` c !`` d ```!   ```";
        assert_eq!(
            hand_off_shell_blocks(content, metadata(None)),
            format!(
                "a {} b {} c  d ",
                instruction("echo one"),
                instruction("echo two")
            )
        );
    }

    /// 插件变量换成真实值；CLAUDE 别名与 NIBI 名字都认；Windows 路径换正斜杠。
    #[test]
    fn plugin_variables_resolve_to_real_values() {
        let plugin = plugin();
        let content = "!`${NIBI_PLUGIN_ROOT}/run.sh $CLAUDE_PLUGIN_DATA ${NIBI_PLUGIN_ID} ${NIBI_PLUGIN_NAME} ${CLAUDE_PLUGIN_ROOT}`";
        let expected = instruction(
            "C:/Users/dev/plugins/math/run.sh /data/math math-modeling math-modeling C:/Users/dev/plugins/math",
        );
        assert_eq!(
            hand_off_shell_blocks(content, metadata(Some(&plugin))),
            expected
        );
    }

    /// `*_SKILL_DIR` 命令没有 skill 目录，始终不能解析：整块不转交，列出变量。
    #[test]
    fn skill_directories_are_never_resolved() {
        let plugin = plugin();
        for name in ["NIBI_SKILL_DIR", "CLAUDE_SKILL_DIR"] {
            let content = format!("!`cat ${{{name}}}/SKILL.md`");
            assert_eq!(
                hand_off_shell_blocks(&content, metadata(Some(&plugin))),
                format!(
                    "[A shell step from the /deploy command file (project/nibi) was not run: it uses ${{{name}}}, which cannot be resolved here.]\n"
                ),
                "{name}"
            );
        }
    }

    /// 非插件命令没有插件变量；修饰符写法（`#`/`!` 前缀、`:-` 等）不替换，整块不转交。
    #[test]
    fn unresolvable_and_modified_variables_keep_the_whole_block() {
        assert_eq!(
            hand_off_shell_blocks("!`echo ${NIBI_PLUGIN_ROOT}`", metadata(None)),
            "[A shell step from the /deploy command file (project/nibi) was not run: it uses ${NIBI_PLUGIN_ROOT}, which cannot be resolved here.]\n"
        );
        let plugin = plugin();
        let content = "!`echo ${#NIBI_PLUGIN_ROOT} ${!CLAUDE_PLUGIN_ROOT} ${NIBI_PLUGIN_ROOT:-x} $NIBI_PLUGIN_DATA`";
        assert_eq!(
            hand_off_shell_blocks(content, metadata(Some(&plugin))),
            "[A shell step from the /deploy command file (project/nibi) was not run: it uses \
             ${#NIBI_PLUGIN_ROOT}, ${!CLAUDE_PLUGIN_ROOT}, ${NIBI_PLUGIN_ROOT:-x}, which cannot be \
             resolved here.]\n"
        );
    }

    /// 变量名后面跟着标识符字符时不是这个变量（`$NIBI_PLUGIN_ROOT_X` 保持原文），也不进 unresolved。
    #[test]
    fn a_longer_name_is_not_a_plugin_variable() {
        assert_eq!(
            hand_off_shell_blocks("!`echo $NIBI_PLUGIN_ROOT_X`", metadata(Some(&plugin()))),
            instruction("echo $NIBI_PLUGIN_ROOT_X")
        );
    }

    /// 盘符与 UNC 值换正斜杠；POSIX 路径不动。
    #[test]
    fn windows_and_unc_values_use_forward_slashes() {
        assert_eq!(windows_slashes("C:\\Users\\dev"), "C:/Users/dev");
        assert_eq!(windows_slashes("\\\\server\\share"), "//server/share");
        assert_eq!(windows_slashes("/opt/plugin"), "/opt/plugin");
    }

    /// `!` 在行首或空白之后才成立；`Warning!` 与紧跟在词后的 `!` 不是块。
    #[test]
    fn a_bang_glued_to_a_word_is_text() {
        for content in ["Warning!`rm -rf /`", "a!`rm`", "x!`y`"] {
            assert_eq!(
                hand_off_shell_blocks(content, metadata(None)),
                content,
                "{content}"
            );
        }
        assert_eq!(
            hand_off_shell_blocks("line\n!`echo hi`", metadata(None)),
            format!("line\n{}", instruction("echo hi"))
        );
    }

    /// fenced 块优先于同一位置的行内写法，且围栏里的内容原样（trim 后）交给模型。
    #[test]
    fn fenced_blocks_take_precedence() {
        assert_eq!(
            hand_off_shell_blocks("```!\n  echo hi\n```", metadata(None)),
            instruction("echo hi")
        );
        // 未闭合的 fenced 忽略，继续找后面的行内块（同正则的回溯）。
        assert_eq!(
            hand_off_shell_blocks("```! never closes !`echo hi`", metadata(None)),
            format!("```! never closes {}", instruction("echo hi"))
        );
    }
}

//! 自定义命令的展开与 `/` 目录（Node `resolveZCodeCustomCommandPrompt` 的镜像）：
//! 解析 `/<名字> [参数]`、找命令、参数替换、`!` shell 展开，再按 Node 的提示形状交给会话。
//!
//! 与 skill 命令同一个 `UserCommands` 入口：自定义命令先于同名 skill（Node 的 input facade 也是先
//! 解析自定义命令），保留名直接落到后面的 skill/内置命令，不借同名接管内置语义。

use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::tool::ToolUseContext;
use nibi_kernel_api::user_command::{
    ExpandedKind, ExpandedMessage, Expansion, LOCAL_COMMAND_CAVEAT_SOURCE, LOCAL_COMMAND_SOURCE,
    UserCommand, UserCommands, command_input, command_tags,
};

use super::{CustomCommand, CustomCommands, is_reserved, prompt, shell_matches, template};
use crate::skills::SkillCommands;

/// 自定义命令正文的消息来源（不写成 `skill`，免得上报/上下文把它当 skill 调用）。
pub const CUSTOM_COMMAND_SOURCE: &str = "custom-command";

/// 本地命令之前的 caveat（与 skill/内置命令同一条产品文案）。
const CAVEAT: &str = nibi_kernel_api::user_input::BASH_CAVEAT;

fn input(text: String) -> ExpandedMessage {
    ExpandedMessage {
        text,
        kind: ExpandedKind::Input,
    }
}

fn meta(source: &str, text: String) -> ExpandedMessage {
    ExpandedMessage {
        text,
        kind: ExpandedKind::Meta {
            source: source.to_owned(),
        },
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// 不调模型的本地结果（拒绝/失败）：caveat、命令输入、结果。
fn local(name: &str, args: &str, output: String) -> Expansion {
    Expansion::Messages {
        messages: vec![
            meta(LOCAL_COMMAND_CAVEAT_SOURCE, CAVEAT.to_owned()),
            input(command_input(name, args)),
            meta(LOCAL_COMMAND_SOURCE, output),
        ],
        query: false,
    }
}

/// 解析斜杠输入：trim 后以 `/` 开头；名字到第一个空白为止，其余 trim 后是参数（Node 的正则同义）。
pub(crate) fn parse(input: &str) -> Option<(String, String)> {
    let text = input.trim();
    let rest = text.strip_prefix('/')?;
    let (name, args) = match rest.find(char::is_whitespace) {
        Some(at) => (&rest[..at], rest[at..].trim()),
        None => (rest, ""),
    };
    (!name.is_empty()).then(|| (name.to_lowercase(), args.to_owned()))
}

impl CustomCommands {
    /// 展开自定义命令；不是自定义命令时 None（交给 skill/内置命令）。
    pub(crate) async fn expand_custom(
        &self,
        text: &str,
        context: &ToolUseContext,
    ) -> Option<Expansion> {
        let (name, args) = parse(text)?;
        // Node `isReservedZCodeSlashCommandName`：保留名在这里直接当“不是自定义命令”。
        if is_reserved(&name) {
            return None;
        }
        let command = self
            .find(&context.workspace, Some(&context.session), &name)
            .await?;
        if let Err(reason) = self.check_license(&command) {
            return Some(local(&command.name, &args, reason));
        }
        let expanded = template(&command.body, &args);
        let body = match self.expand_shell(&command, &expanded.body, context).await {
            Ok(body) => body,
            Err(error) => {
                return Some(local(
                    &command.name,
                    &args,
                    format!(
                        "<local-command-stderr>{}</local-command-stderr>",
                        escape(&error)
                    ),
                ));
            }
        };
        let prompt = prompt(
            &command.name,
            command.scope.as_str(),
            command.source.as_str(),
            &command.skills,
            &body,
        );
        Some(Expansion::Messages {
            messages: vec![
                // 命令标签让 TUI/存储显示为用户输入的样子（`/<名字> <参数>`），正文在 meta 消息里。
                input(command_tags(&command.name, &args)),
                meta(CUSTOM_COMMAND_SOURCE, prompt),
            ],
            query: true,
        })
    }

    async fn expand_shell(
        &self,
        command: &CustomCommand,
        body: &str,
        context: &ToolUseContext,
    ) -> Result<String, String> {
        let matches = shell_matches(body);
        if matches.is_empty() {
            return Ok(body.to_owned());
        }
        let Some(runner) = &self.runner else {
            return Err(format!(
                "Custom command /{} uses unsupported shell expansion. Dynamic expansion is not available.",
                command.name
            ));
        };
        let mut output = body.to_owned();
        for found in matches.iter().rev() {
            let shell = substitute_variables(&found.command, command, context);
            let expanded = runner
                .run_command(&shell, &command.allowed_tools, context)
                .await?;
            output.replace_range(found.start..found.end, expanded.trim_end());
        }
        Ok(output)
    }
}

/// `!` 命令里的 `${NIBI_PLUGIN_ROOT}` 一类变量（Node 用环境变量注入；Bash 工具没有 env 参数，
/// 这里在命令文本上替换，效果相同）。未提供插件上下文时保留原文，由 shell 自己报错。
fn substitute_variables(command: &str, custom: &CustomCommand, context: &ToolUseContext) -> String {
    let project = context.workspace.root.as_str();
    let session = context.session.as_str();
    let mut variables: Vec<(&str, &str)> = vec![
        ("CLAUDE_PROJECT_DIR", project),
        ("NIBI_PROJECT_DIR", project),
        ("ZCODE_PROJECT_DIR", project),
        ("CLAUDE_CODE_SESSION_ID", session),
        ("CLAUDE_SESSION_ID", session),
        ("NIBI_SESSION_ID", session),
    ];
    if let Some(plugin) = &custom.plugin {
        variables.extend([
            ("CLAUDE_PLUGIN_ROOT", plugin.root.as_str()),
            ("NIBI_PLUGIN_ROOT", plugin.root.as_str()),
            ("ZCODE_PLUGIN_ROOT", plugin.root.as_str()),
        ]);
        if let Some(data) = &plugin.data {
            variables.extend([
                ("CLAUDE_PLUGIN_DATA", data.as_str()),
                ("NIBI_PLUGIN_DATA", data.as_str()),
                ("ZCODE_PLUGIN_DATA", data.as_str()),
            ]);
        }
    }
    let mut text = command.to_owned();
    for (name, value) in variables {
        text = text.replace(&format!("${{{name}}}"), value);
        text = replace_bare(&text, name, value);
    }
    text
}

/// `$NAME`（不带花括号）的替换：只替换后面不是标识符字符的出现。
fn replace_bare(text: &str, name: &str, value: &str) -> String {
    let needle = format!("${name}");
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = text[cursor..].find(&needle) {
        let start = cursor + found;
        let end = start + needle.len();
        output.push_str(&text[cursor..start]);
        let boundary = text[end..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        if boundary {
            output.push_str(value);
        } else {
            output.push_str(&needle);
        }
        cursor = end;
    }
    output.push_str(&text[cursor..]);
    output
}

#[async_trait]
impl UserCommands for CustomCommands {
    async fn commands(&self, workspace: &WorkspaceRef) -> Vec<UserCommand> {
        // 这个 trait 方法没有会话参数：用进程级插件根（CLI/TUI 的启动快照；桌面 app-server 也在
        // `Ext::start` 里只加载插件元数据，MCP 连接仍按会话建立）。
        self.discover(workspace, None)
            .await
            .into_iter()
            .filter(|command| !is_reserved(&command.name))
            .map(|command| UserCommand {
                name: command.name,
                description: command.description,
                argument_hint: command.argument_hint,
                hidden: false,
                non_interactive: command.disable_non_interactive,
                custom: true,
            })
            .collect()
    }

    async fn expand(&self, text: &str, context: ToolUseContext) -> Expansion {
        match self.expand_custom(text, &context).await {
            Some(expansion) => expansion,
            None => Expansion::NotCommand,
        }
    }
}

/// 自定义命令 + skill 命令：自定义命令先于同名 skill，名字在 `/` 目录里只出现一次。
pub struct CommandSet {
    skills: Arc<SkillCommands>,
    custom: Arc<CustomCommands>,
}

impl CommandSet {
    pub fn new(skills: Arc<SkillCommands>, custom: Arc<CustomCommands>) -> Self {
        Self { skills, custom }
    }

    pub(crate) fn set_paid_gate(
        &self,
        gate: Arc<dyn nibi_kernel_api::paid_plugin::PaidPluginGate>,
    ) {
        self.skills.set_paid_gate(gate.clone());
        self.custom.set_paid_gate(gate);
    }

    pub fn set_plugin_roots(&self, roots: Vec<super::PluginCommandRoot>) {
        self.custom.set_plugin_roots(roots);
    }

    pub fn set_session_plugin_roots(
        &self,
        session: nibi_kernel_api::ids::SessionId,
        roots: Vec<super::PluginCommandRoot>,
    ) {
        self.custom.set_session_plugin_roots(session, roots);
    }

    pub fn clear_session(&self, session: &nibi_kernel_api::ids::SessionId) {
        self.custom.clear_session(session);
    }

    pub fn copy_session(
        &self,
        from: &nibi_kernel_api::ids::SessionId,
        to: nibi_kernel_api::ids::SessionId,
    ) {
        self.custom.copy_session(from, to);
    }
}

#[async_trait]
impl UserCommands for CommandSet {
    async fn commands(&self, workspace: &WorkspaceRef) -> Vec<UserCommand> {
        let mut commands = self.custom.commands(workspace).await;
        let known: std::collections::HashSet<String> = commands
            .iter()
            .map(|command| command.name.clone())
            .collect();
        commands.extend(
            self.skills
                .commands(workspace)
                .await
                .into_iter()
                .filter(|command| !known.contains(&command.name)),
        );
        // 内置 `/workflow` 排在最前（Node 的目录顺序是 builtin、custom、skill）。
        if !commands
            .iter()
            .any(|command| command.name == super::builtin::WORKFLOW)
        {
            commands.insert(0, super::builtin::user_command());
        }
        commands
    }

    async fn expand(&self, text: &str, context: ToolUseContext) -> Expansion {
        // 内置 prompt 命令先于自定义命令（名字是保留字，custom 本来也不会命中）。
        if let Some(expansion) = super::builtin::expand(text) {
            return expansion;
        }
        if let Some(expansion) = self.custom.expand_custom(text, &context).await {
            return expansion;
        }
        self.skills.expand(text, context).await
    }
}

#[cfg(test)]
#[path = "user_tests.rs"]
mod tests;

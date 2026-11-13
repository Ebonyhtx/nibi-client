//! 自定义命令的展开与 `/` 目录（Node `resolveNibiCustomCommandPrompt` 的镜像）：
//! 解析 `/<名字> [参数]`、找命令、`!` 块交权改写、参数替换，再按 Node 的提示形状交给会话。
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

use super::{
    CustomCommands, ShellHandOff, hand_off_shell_blocks, is_reserved, prompt, template,
};
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
        // Node `isReservedNibiSlashCommandName`：保留名在这里直接当“不是自定义命令”。
        if is_reserved(&name) {
            return None;
        }
        let command = self
            .find(&context.workspace, Some(&context.session), &name)
            .await?;
        if let Err(reason) = self.check_license(&command) {
            return Some(local(&command.name, &args, reason));
        }
        // 修复线 A3（Node 3.17.2 `handOffCustomCommandShellBlocks`）：`!` 块只在解析阶段改写成 Bash 指令，
        // 真正执行交给模型的 Bash 工具（权限服务决定放行、询问或拒绝）。改写必须在参数替换之前：参数里的
        // 反引号不会打断改写出来的代码块。
        let rewritten = hand_off_shell_blocks(
            &command.body,
            ShellHandOff {
                name: &command.name,
                scope: command.scope.as_str(),
                source: command.source.as_str(),
                plugin: command.plugin.as_ref(),
            },
        );
        let expanded = template(&rewritten, &args);
        let body = expanded.body;
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

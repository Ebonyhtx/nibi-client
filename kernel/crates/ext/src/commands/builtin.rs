//! 内置 prompt 型斜杠命令（Node `builtin-prompt-command.ts` 的镜像）。
//!
//! `/init` 已经在 `skills::builtin` 里作为内置提示词 skill 实现；这里补 `/workflow`：它的正文随 CLI
//! 编译，名字是保留字，展开形状与 Node 的 `expandBuiltinWorkflowCommandPrompt` 一致（custom command
//! 的提示形状 + `dynamic-workflows` skill 前言），不再依赖某个插件是否安装。

use nibi_kernel_api::user_command::{
    ExpandedKind, ExpandedMessage, Expansion, UserCommand, command_tags,
};

use super::{CUSTOM_COMMAND_SOURCE, parse, prompt, template};

/// Node `BUILTIN_WORKFLOW_COMMAND_NAME`。
pub const WORKFLOW: &str = "workflow";
const WORKFLOW_SKILL: &str = "dynamic-workflows";
const DESCRIPTION: &str = "Design and launch a dynamic workflow for a task.";
const ARGUMENT_HINT: &str = "what the workflow should accomplish";

/// Node `BUILTIN_WORKFLOW_COMMAND_BODY`（`$ARGUMENTS` 必须在场）。
const BODY: &str = "Use the `dynamic-workflows` skill to design and launch a dynamic workflow for this request:\n\n$ARGUMENTS\n\nDecide the subagent topology before writing any code: how many subagents, which of them\nshare a context, what result each one returns. Then write the script and call the\n`CreateWorkflow` tool. (`CreateWorkflow` is the dynamic-workflow tool. Do not use the\nlegacy `Workflow` tool, and do not substitute the `Agent` tool.)\n";

/// `/workflow` 的展开；不是它时 None（交给自定义命令/skill）。
pub(crate) fn expand(input: &str) -> Option<Expansion> {
    let (name, args) = parse(input)?;
    if name != WORKFLOW {
        return None;
    }
    let expanded = template(BODY, &args);
    let prompt = prompt(
        WORKFLOW,
        "system",
        "nibi",
        &[WORKFLOW_SKILL.to_owned()],
        &expanded.body,
    );
    Some(Expansion::Messages {
        messages: vec![
            ExpandedMessage {
                text: command_tags(WORKFLOW, &args),
                kind: ExpandedKind::Input,
            },
            ExpandedMessage {
                text: prompt,
                kind: ExpandedKind::Meta {
                    source: CUSTOM_COMMAND_SOURCE.to_owned(),
                },
            },
        ],
        query: true,
    })
}

/// `/` 目录里的那一行（TUI 与协议目录共用；协议目录另有一份内置表）。
pub(crate) fn user_command() -> UserCommand {
    UserCommand {
        name: WORKFLOW.to_owned(),
        description: DESCRIPTION.to_owned(),
        argument_hint: Some(ARGUMENT_HINT.to_owned()),
        hidden: false,
        non_interactive: false,
        custom: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(expansion: &Expansion, index: usize) -> &str {
        let Expansion::Messages { messages, .. } = expansion else {
            panic!("not an expansion");
        };
        messages[index].text.as_str()
    }

    #[test]
    fn workflow_expands_with_arguments_and_the_skill_preface() {
        let expansion = expand("/workflow ship it").expect("workflow");
        assert_eq!(
            text(&expansion, 0),
            "<command-message>workflow</command-message>\n<command-name>/workflow</command-name>\n<command-args>ship it</command-args>"
        );
        let prompt = text(&expansion, 1);
        assert!(prompt.starts_with(
            "Run custom command /workflow.\nCommand source: system/nibi.\nRequired skills: `dynamic-workflows`."
        ));
        assert!(prompt.contains("ship it"));
        assert!(prompt.contains("`CreateWorkflow` tool"));
    }

    #[test]
    fn other_names_pass_through() {
        assert!(expand("/mathmodel x").is_none());
        assert!(expand("not a command").is_none());
    }
}

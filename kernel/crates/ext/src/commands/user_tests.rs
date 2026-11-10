//! 自定义命令的展开（Node `resolveZCodeCustomCommandPrompt`）：优先级、参数、skill 前言与 `!` 展开。

use std::sync::Arc;

use nibi_kernel_api::clock::Ids;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::testing::{MemoryEnvironment, SequentialIds};
use nibi_kernel_api::user_command::{ExpandedKind, Expansion, UserCommands};
use nibi_kernel_policy::PolicyGate;

use super::*;
use crate::commands::PluginCommandRoot;
use crate::skills::runner;
use crate::test_support::{EchoBash, facts, tool_context};

const GREET: &str =
    "---\ndescription: Greet someone\nargument-hint: <name>\n---\nHello $ARGUMENTS.";
const NESTED: &str = "---\ndescription: Nested command\n---\nNested body.";
const RESERVED: &str = "---\ndescription: Must not override compact\n---\nReserved body.";
const SHELL: &str =
    "---\ndescription: Runs a shell\nallowed-tools: Bash(echo:*)\n---\nOut: !`echo hi`";

fn with_files(files: &[(&str, &str)]) -> Arc<MemoryEnvironment> {
    let mut env = MemoryEnvironment::new(facts());
    for (path, text) in files {
        env = env.with_file(path, text);
    }
    Arc::new(env)
}

fn commands(env: Arc<MemoryEnvironment>) -> (CustomCommands, Arc<EchoBash>) {
    let bash = Arc::new(EchoBash::default());
    let ids: Arc<dyn Ids> = Arc::new(SequentialIds::default());
    let runner = Some(runner(bash.clone(), Arc::new(PolicyGate::default()), ids));
    (CustomCommands::new(env.clone(), env, runner), bash)
}

async fn expand(env: Arc<MemoryEnvironment>, text: &str) -> Expansion {
    let context = tool_context(env.clone(), PermissionMode::DontAsk);
    commands(env).0.expand(text, context).await
}

fn text_of(expansion: &Expansion, index: usize) -> String {
    let Expansion::Messages { messages, .. } = expansion else {
        panic!("not an expansion: {expansion:?}");
    };
    messages[index].text.clone()
}

fn kind_of(expansion: &Expansion, index: usize) -> ExpandedKind {
    let Expansion::Messages { messages, .. } = expansion else {
        panic!("not an expansion: {expansion:?}");
    };
    messages[index].kind.clone()
}

#[tokio::test]
async fn a_project_command_expands_args_and_keeps_the_command_display() {
    let expansion = expand(
        with_files(&[(
            concat!("/Users/dev/project", "/.nibi/commands/greet.md"),
            GREET,
        )]),
        "/greet Ada",
    )
    .await;
    assert_eq!(
        text_of(&expansion, 0),
        "<command-message>greet</command-message>\n<command-name>/greet</command-name>\n<command-args>Ada</command-args>"
    );
    assert_eq!(kind_of(&expansion, 0), ExpandedKind::Input);
    assert_eq!(
        text_of(&expansion, 1),
        "Run custom command /greet.\nCommand source: project/nibi.\n\nHello Ada."
    );
    assert_eq!(
        kind_of(&expansion, 1),
        ExpandedKind::Meta {
            source: CUSTOM_COMMAND_SOURCE.to_owned()
        }
    );
}

#[tokio::test]
async fn nested_paths_become_colon_separated_names() {
    let expansion = expand(
        with_files(&[(
            concat!("/Users/dev/project", "/.nibi/commands/sub/do.md"),
            NESTED,
        )]),
        "/sub:do",
    )
    .await;
    assert!(text_of(&expansion, 1).contains("Run custom command /sub:do."));
}

#[tokio::test]
async fn user_commands_win_over_project_commands() {
    let expansion = expand(
        with_files(&[
            (
                concat!("/Users/dev", "/.nibi/commands/same.md"),
                "---\ndescription: user\n---\nUser body.",
            ),
            (
                concat!("/Users/dev/project", "/.nibi/commands/same.md"),
                "---\ndescription: project\n---\nProject body.",
            ),
        ]),
        "/same",
    )
    .await;
    assert!(text_of(&expansion, 1).ends_with("User body."));
}

#[tokio::test]
async fn nibi_wins_over_agents_at_the_same_level() {
    let expansion = expand(
        with_files(&[
            (
                concat!("/Users/dev/project", "/.nibi/commands/same.md"),
                "---\ndescription: nibi\n---\nNibi body.",
            ),
            (
                concat!("/Users/dev/project", "/.agents/commands/same.md"),
                "---\ndescription: agents\n---\nAgents body.",
            ),
        ]),
        "/same",
    )
    .await;
    assert!(text_of(&expansion, 1).ends_with("Nibi body."));
}

#[tokio::test]
async fn reserved_names_are_not_custom_commands() {
    assert_eq!(
        expand(
            with_files(&[(
                concat!("/Users/dev/project", "/.nibi/commands/compact.md"),
                RESERVED
            )]),
            "/compact",
        )
        .await,
        Expansion::NotCommand
    );
}

#[tokio::test]
async fn arguments_are_appended_when_the_body_has_no_placeholder() {
    let expansion = expand(
        with_files(&[(
            concat!("/Users/dev/project", "/.nibi/commands/plain.md"),
            "---\ndescription: plain\n---\nDo the thing.",
        )]),
        "/plain with care",
    )
    .await;
    assert!(text_of(&expansion, 1).ends_with("Do the thing.\n\nUser arguments:\nwith care"));
}

#[tokio::test]
async fn shell_fragments_run_through_bash() {
    let env = with_files(&[(
        concat!("/Users/dev/project", "/.nibi/commands/shell.md"),
        SHELL,
    )]);
    let (custom, bash) = commands(env.clone());
    let expansion = custom
        .expand("/shell", tool_context(env, PermissionMode::DontAsk))
        .await;
    assert!(text_of(&expansion, 1).ends_with("Out: out:echo hi"));
    assert_eq!(bash.commands.lock().unwrap()[0].0, "echo hi");
}

#[tokio::test]
async fn plugin_commands_come_from_plugin_roots() {
    let env = with_files(&[(
        "/Users/dev/plugins/math/commands/mathmodel.md",
        "---\ndescription: 数模工作台\nargument-hint: \"[题目]\"\n---\n打开工作台。\n\n$ARGUMENTS",
    )]);
    let (custom, _) = commands(env.clone());
    custom.set_plugin_roots(vec![PluginCommandRoot {
        plugin: "math-modeling".to_owned(),
        dir: "/Users/dev/plugins/math/commands".to_owned(),
        root: "/Users/dev/plugins/math".to_owned(),
        data: None,
        official: false,
    }]);
    let expansion = custom
        .expand(
            "/mathmodel 这道题",
            tool_context(env.clone(), PermissionMode::DontAsk),
        )
        .await;
    assert_eq!(
        text_of(&expansion, 1),
        "Run custom command /mathmodel.\nCommand source: user/plugin.\n\n打开工作台。\n\n这道题"
    );
    let listed = custom.commands(&crate::test_support::workspace()).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "mathmodel");
    assert_eq!(listed[0].argument_hint.as_deref(), Some("[题目]"));
}

#[tokio::test]
async fn additional_directories_namespace_their_commands() {
    let mut facts = facts();
    facts.additional_directories = vec![nibi_kernel_api::env::EnvPath::new("/Users/dev/extra")];
    let env = Arc::new(MemoryEnvironment::new(facts).with_file(
        "/Users/dev/extra/.nibi/commands/task.md",
        "---\ndescription: extra task\n---\nExtra body.",
    ));
    let (custom, _) = commands(env.clone());
    let context = tool_context(env, PermissionMode::DontAsk);
    let expansion = custom.expand("/extra/task", context).await;
    assert!(text_of(&expansion, 1).starts_with("Run custom command /extra/task."));
}

#[tokio::test]
async fn disable_noninteractive_is_exposed_to_the_protocol_listing() {
    let env = with_files(&[(
        concat!("/Users/dev/project", "/.nibi/commands/ci.md"),
        "---\ndescription: interactive only\ndisable-noninteractive: true\n---\nBody.",
    )]);
    let (custom, _) = commands(env);
    let listed = custom.commands(&crate::test_support::workspace()).await;
    assert_eq!(listed.len(), 1);
    assert!(listed[0].non_interactive);
}

#[tokio::test]
async fn a_missing_command_falls_through() {
    let env = with_files(&[(
        concat!("/Users/dev/project", "/.nibi/commands/greet.md"),
        GREET,
    )]);
    assert_eq!(expand(env, "/nope").await, Expansion::NotCommand);
}

#[tokio::test]
async fn custom_commands_beat_a_skill_with_the_same_name() {
    let env = with_files(&[
        (
            concat!("/Users/dev/project", "/.nibi/commands/greet.md"),
            "---\ndescription: custom greet\n---\nCustom body.",
        ),
        (
            concat!("/Users/dev/project", "/.nibi/skills/greet/SKILL.md"),
            "---\ndescription: skill greet\n---\nSkill body.",
        ),
    ]);
    let skill_catalog = Arc::new(crate::skills::SkillCatalog::new(env.clone(), env.clone()));
    let ids: Arc<dyn Ids> = Arc::new(SequentialIds::default());
    let bash = Arc::new(EchoBash::default());
    let skills = Arc::new(crate::skills::SkillCommands::new(
        skill_catalog,
        Some(runner(bash, Arc::new(PolicyGate::default()), ids)),
    ));
    let custom = Arc::new(commands(env.clone()).0);
    let set = CommandSet::new(skills, custom);
    let listed = set.commands(&crate::test_support::workspace()).await;
    let greet: Vec<_> = listed
        .iter()
        .filter(|command| command.name == "greet")
        .collect();
    assert_eq!(greet.len(), 1);
    assert_eq!(greet[0].description, "custom greet");
    let expansion = set
        .expand("/greet", tool_context(env, PermissionMode::DontAsk))
        .await;
    assert!(text_of(&expansion, 1).ends_with("Custom body."));
}

#[tokio::test]
async fn home_commands_are_listed_before_project_commands() {
    // 只是一个根系顺序的烟测：两个名字都出现，且同名只留用户那份。
    let env = with_files(&[
        (
            concat!("/Users/dev", "/.nibi/commands/user-cmd.md"),
            "---\ndescription: user\n---\nUser.",
        ),
        (
            concat!("/Users/dev/project", "/.nibi/commands/project-cmd.md"),
            "---\ndescription: project\n---\nProject.",
        ),
    ]);
    let (custom, _) = commands(env);
    let listed = custom.commands(&crate::test_support::workspace()).await;
    assert_eq!(
        listed
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>(),
        ["project-cmd", "user-cmd"]
    );
}

#[tokio::test]
async fn disabled_command_paths_are_hidden_and_not_expanded() {
    let env = with_files(&[(
        concat!("/Users/dev/project", "/.nibi/commands/greet.md"),
        GREET,
    )]);
    let (custom, _) = commands(env.clone());
    custom.set_disabled_paths(vec![
        concat!("/Users/dev/project", "/.nibi/commands/greet.md").to_owned(),
    ]);
    let listed = custom.commands(&crate::test_support::workspace()).await;
    assert!(listed.is_empty());
    assert_eq!(
        custom
            .expand("/greet Ada", tool_context(env, PermissionMode::DontAsk))
            .await,
        Expansion::NotCommand
    );
}

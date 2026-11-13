#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "tests create temporary command files (README §4)"
)]

use std::path::Path;
use std::sync::Arc;

use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_env_local::LocalEnvironment;
use nibi_kernel_ext::commands::CustomCommands;

use super::*;

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

#[test]
fn the_subcommands_and_flags_are_parsed() {
    assert_eq!(
        parse(&args(&["commands", "list", "--json", "--cwd", "sub"])),
        Some(Ok(Command::List {
            json: true,
            cwd: Some("sub".to_owned()),
        }))
    );
    assert_eq!(
        parse(&args(&["commands", "inspect", "review", "--json"])),
        Some(Ok(Command::Inspect {
            name: "review".to_owned(),
            json: true,
            cwd: None,
        }))
    );
    assert_eq!(
        parse(&args(&["commands", "builtin", "--json"])),
        Some(Ok(Command::Builtin { json: true }))
    );
    assert_eq!(
        parse(&args(&["commands", "inspect"])),
        Some(Err(
            "missing command name\nUsage:\n  nibi commands list [--json] [--cwd <path>]\n  nibi commands inspect <name> [--json] [--cwd <path>]\n  nibi commands builtin [--json]\n"
                .to_owned()
        ))
    );
    assert_eq!(
        parse(&args(&["commands", "builtin", "--cwd", "x"])),
        Some(Err(
            "unknown option '--cwd'\nUsage:\n  nibi commands list [--json] [--cwd <path>]\n  nibi commands inspect <name> [--json] [--cwd <path>]\n  nibi commands builtin [--json]\n"
                .to_owned()
        ))
    );
    assert_eq!(
        parse(&args(&["commands", "wat"])),
        Some(Err(
            "unknown commands subcommand 'wat'\nUsage:\n  nibi commands list [--json] [--cwd <path>]\n  nibi commands inspect <name> [--json] [--cwd <path>]\n  nibi commands builtin [--json]\n"
                .to_owned()
        ))
    );
    assert_eq!(
        parse(&args(&["commands", "builtin", "-h"])),
        Some(Ok(Command::Help))
    );
    assert_eq!(parse(&args(&["skills"])), None);
}

#[test]
fn builtin_json_lists_all_33_commands_with_aliases_and_both_descriptions() {
    let value: Value = serde_json::from_str(&builtin_text(true)).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    let commands = value["commands"].as_array().unwrap();
    assert_eq!(commands.len(), 33);
    assert_eq!(commands.len(), COMMANDS.len());
    let clear = commands
        .iter()
        .find(|command| command["name"] == "clear")
        .unwrap();
    assert_eq!(clear["implemented"], true);
    assert_eq!(
        clear["description"]["en"],
        "Start a new session with empty context; previous session stays on disk (resumable with /resume)"
    );
    assert!(
        clear["description"]["zh"]
            .as_str()
            .unwrap()
            .contains("新会话")
    );
    assert_eq!(clear["aliases"], json!(["reset", "new"]));
    let exit = commands
        .iter()
        .find(|command| command["name"] == "exit")
        .unwrap();
    assert_eq!(exit["aliases"], json!(["quit"]));
}

fn write_command(root: &Path, name: &str, body: &str) {
    let dir = root.join(".nibi").join("commands");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.md")), body).unwrap();
}

async fn custom(home: &Path, cwd: &Path) -> (CustomCommands, WorkspaceRef) {
    let env = Arc::new(LocalEnvironment::new(Some(home.to_path_buf())));
    let commands = CustomCommands::new(env.clone(), env);
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new(crate::LOCAL_ENVIRONMENT),
        root: EnvPath::new(cwd.to_string_lossy()),
    };
    (commands, workspace)
}

#[tokio::test]
async fn custom_commands_are_listed_and_inspected() {
    let home = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    write_command(
        cwd.path(),
        "review",
        "---\ndescription: Review the current diff\nargument-hint: <path>\nallowed-tools: Read\n---\n\nReview $ARGUMENTS\n",
    );
    // 保留名（内置斜杠命令）不列出来，也不响应 inspect。
    write_command(
        cwd.path(),
        "help",
        "---\ndescription: should be hidden\n---\n",
    );
    let (commands, workspace) = custom(home.path(), cwd.path()).await;
    let listed = commands.list(&workspace).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "review");
    assert_eq!(listed[0].description, "Review the current diff");
    assert!(commands.inspect(&workspace, "review").await.is_some());
    assert!(commands.inspect(&workspace, "help").await.is_none());
    assert!(commands.inspect(&workspace, "missing").await.is_none());

    let value: Value = serde_json::from_str(&list_text(&listed, true)).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["commands"][0]["name"], "review");
    assert_eq!(value["commands"][0]["source"], "nibi");
    assert_eq!(value["commands"][0]["scope"], "project");
    assert_eq!(value["commands"][0]["argumentHint"], "<path>");
    assert_eq!(value["commands"][0]["allowedTools"][0], "Read");
    assert!(
        value["commands"][0]["path"]
            .as_str()
            .unwrap()
            .ends_with("review.md")
    );

    let inspected = commands.inspect(&workspace, "review").await.unwrap();
    let value: Value = serde_json::from_str(&inspect_text(&inspected, true)).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["command"]["name"], "review");
    assert!(
        value["command"]["description"]
            .as_str()
            .unwrap()
            .contains("Review")
    );
}

#[test]
fn cwd_resolution_expands_home_and_relative_paths() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    assert_eq!(workspace_root(root.path(), home.path(), None), root.path());
    assert_eq!(
        workspace_root(root.path(), home.path(), Some("sub")),
        root.path().join("sub")
    );
    assert_eq!(
        workspace_root(root.path(), home.path(), Some("~")),
        home.path()
    );
}

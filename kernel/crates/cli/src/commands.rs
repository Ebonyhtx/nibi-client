//! `nibi commands list|inspect|builtin`（docs/specs/rust-cli/rust-cli-noninteractive-commands.md §5）：
//!
//! - `list` / `inspect` 是用户与项目的自定义命令（`.nibi/commands`、`.agents/commands`、插件
//!   `commands/`），语义与 Node 的 `nibi commands` 对齐；
//! - `builtin` 是 TUI 的 33 个内置斜杠命令与别名，直接消费 `tui::ui::commands`，不复制清单。
//!
//! 只读，不进入 TUI、不启动会话。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_env_local::LocalEnvironment;
use nibi_kernel_ext::commands::{CommandSource, CustomCommand, CustomCommands};
use nibi_kernel_paths::{StorageSettings, expand_home};
use nibi_kernel_tui::ui::commands::{COMMANDS, aliases_of};
use serde_json::{Value, json};

use crate::config::{self, ConfigInputs};
use crate::{Startup, output};

pub(crate) const USAGE: &str = "Usage:
  nibi commands list [--json] [--cwd <path>]
  nibi commands inspect <name> [--json] [--cwd <path>]
  nibi commands builtin [--json]
";

/// 解析出的命令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Command {
    Help,
    List {
        json: bool,
        cwd: Option<String>,
    },
    Inspect {
        name: String,
        json: bool,
        cwd: Option<String>,
    },
    Builtin {
        json: bool,
    },
}

/// `nibi commands …`：不是 commands 命令时为 None；错误是写到 stderr 的完整文本。
pub(crate) fn parse(args: &[String]) -> Option<Result<Command, String>> {
    let (first, rest) = args.split_first()?;
    if first != "commands" {
        return None;
    }
    let fail = |message: &str| Err(format!("{message}\n{USAGE}"));
    if rest.iter().any(|arg| arg == "-h" || arg == "--help") {
        return Some(Ok(Command::Help));
    }
    let Some(subcommand) = rest.first().map(String::as_str) else {
        return Some(fail(
            "missing commands subcommand (list, inspect or builtin)",
        ));
    };
    if subcommand.starts_with('-') {
        return Some(fail(&format!("unknown option '{subcommand}'")));
    }
    let mut json = false;
    let mut cwd = None;
    let mut positionals = Vec::new();
    let mut rest = rest[1..].iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--json" => json = true,
            "--cwd" if subcommand != "builtin" => {
                let Some(value) = rest.next() else {
                    return Some(fail("option '--cwd <path>' argument missing"));
                };
                cwd = Some(value.clone());
            }
            other if other.starts_with('-') => {
                return Some(fail(&format!("unknown option '{other}'")));
            }
            other => positionals.push(other.to_owned()),
        }
    }
    match subcommand {
        "list" | "ls" => {
            if let Some(extra) = positionals.first() {
                return Some(fail(&format!("unknown argument '{extra}'")));
            }
            Some(Ok(Command::List { json, cwd }))
        }
        "inspect" => {
            let Some(name) = positionals.first() else {
                return Some(fail("missing command name"));
            };
            if positionals.len() > 1 {
                return Some(fail(&format!("unknown argument '{}'", positionals[1])));
            }
            Some(Ok(Command::Inspect {
                name: name.clone(),
                json,
                cwd,
            }))
        }
        "builtin" => {
            if let Some(extra) = positionals.first() {
                return Some(fail(&format!("unknown argument '{extra}'")));
            }
            Some(Ok(Command::Builtin { json }))
        }
        other => Some(fail(&format!("unknown commands subcommand '{other}'"))),
    }
}

/// `--help`：写用法、退出码 0（不需要读配置或插件）。
pub(crate) fn help() -> u8 {
    output::print_raw(USAGE);
    0
}

/// 执行命令，返回退出码（0 成功、1 用户/配置错误）。
pub(crate) async fn run(command: Command, startup: &Startup) -> u8 {
    if command == Command::Help {
        return help();
    }
    match execute(command, startup).await {
        Ok(text) => {
            output::print_raw(&text);
            0
        }
        Err(message) => {
            output::eprint_line(&format!("Error: {message}"));
            1
        }
    }
}

async fn execute(command: Command, startup: &Startup) -> Result<String, String> {
    let (json, cwd, inspect) = match command {
        Command::Help => return Ok(USAGE.to_owned()),
        Command::Builtin { json } => return Ok(builtin_text(json)),
        Command::List { json, cwd } => (json, cwd, None),
        Command::Inspect { name, json, cwd } => (json, cwd, Some(name)),
    };
    let cwd = workspace_root(&startup.cwd, &startup.home, cwd.as_deref());
    let workspace = workspace(&cwd);
    let paths = crate::setup::storage_paths(startup, &StorageSettings::default());
    let env = Arc::new(LocalEnvironment::new(Some(startup.home.clone())));
    let config = config::assemble(&ConfigInputs {
        files: env.as_ref(),
        workspace: &workspace,
        paths: &paths,
        process_env: &startup.env,
        flag: None,
        paid_license: Some(crate::read_paid_license(startup)),
    })
    .await;
    let roots = crate::setup::extension_roots(env.as_ref(), &workspace, startup, &config).await;
    let commands = CustomCommands::new(env.clone(), env.clone());
    commands.set_disabled_paths(config.disabled_command_paths.clone());
    commands.set_plugin_roots(roots.commands);
    match inspect {
        None => Ok(list_text(&commands.list(&workspace).await, json)),
        Some(name) => match commands.inspect(&workspace, &name).await {
            Some(command) => Ok(inspect_text(&command, json)),
            None => Err(format!("unknown command: {name}")),
        },
    }
}

/// `--cwd`：`~` 展开、相对路径相对入口的 cwd；没有时用入口的 cwd。
fn workspace_root(cwd: &Path, home: &Path, value: Option<&str>) -> PathBuf {
    let Some(value) = value else {
        return cwd.to_path_buf();
    };
    let expanded = expand_home(value, home);
    if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    }
}

fn workspace(root: &Path) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new(crate::LOCAL_ENVIRONMENT),
        root: EnvPath::new(root.to_string_lossy()),
    }
}

fn source(source: CommandSource) -> &'static str {
    source.as_str()
}

fn command_json(command: &CustomCommand) -> Value {
    json!({
        "name": command.name,
        "source": source(command.source),
        "scope": command.scope.as_str(),
        "plugin": command.plugin.as_ref().map(|plugin| plugin.plugin.as_str()),
        "path": command.path,
        "root": command.root,
        "description": command.description,
        "argumentHint": command.argument_hint,
        "allowedTools": command.allowed_tools,
        "skills": command.skills,
        "disableNonInteractive": command.disable_non_interactive,
    })
}

fn list_text(commands: &[CustomCommand], json: bool) -> String {
    if json {
        let values: Vec<Value> = commands.iter().map(command_json).collect();
        return json_text(&json!({"schemaVersion": 1, "commands": values}));
    }
    if commands.is_empty() {
        return "No custom commands found.\n".to_owned();
    }
    let mut lines = Vec::new();
    for command in commands {
        let source = command.plugin.as_ref().map_or_else(
            || source(command.source).to_owned(),
            |plugin| format!("{}:{}", source(command.source), plugin.plugin),
        );
        lines.push(format!(
            "{:<24} {:<14} {description}",
            command.name,
            source,
            description = command.description
        ));
        lines.push(format!("  {}", command.path));
    }
    lines.join("\n") + "\n"
}

fn inspect_text(command: &CustomCommand, json: bool) -> String {
    if json {
        return json_text(&json!({"schemaVersion": 1, "command": command_json(command)}));
    }
    let source = command.plugin.as_ref().map_or_else(
        || source(command.source).to_owned(),
        |plugin| format!("{}:{}", source(command.source), plugin.plugin),
    );
    let mut lines = vec![
        format!("{}  {}", command.name, command.description),
        format!("  source   {source}"),
        format!("  scope    {}", command.scope.as_str()),
        format!("  path     {}", command.path),
    ];
    if let Some(hint) = &command.argument_hint {
        lines.push(format!("  hint     {hint}"));
    }
    if !command.allowed_tools.is_empty() {
        lines.push(format!("  tools    {}", command.allowed_tools.join(", ")));
    }
    lines.join("\n") + "\n"
}

fn builtin_text(json: bool) -> String {
    if json {
        let values: Vec<Value> = COMMANDS
            .iter()
            .map(|command| {
                json!({
                    "name": command.name,
                    "implemented": command.implemented,
                    "description": {"en": command.en, "zh": command.zh},
                    "aliases": aliases_of(command.name),
                })
            })
            .collect();
        return json_text(&json!({"schemaVersion": 1, "commands": values}));
    }
    let mut lines = Vec::new();
    for command in COMMANDS {
        let aliases = aliases_of(command.name);
        let suffix = if aliases.is_empty() {
            String::new()
        } else {
            format!(" (aliases: {})", aliases.join(", "))
        };
        let state = if command.implemented {
            ""
        } else {
            " [not implemented]"
        };
        lines.push(format!("/{}{suffix}{state}  {}", command.name, command.en));
    }
    lines.join("\n") + "\n"
}

fn json_text(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;

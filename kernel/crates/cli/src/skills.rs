//! `nibi skills list|inspect`（docs/specs/rust-cli/rust-cli-noninteractive-commands.md §4）：
//! 不进入 TUI、不启动会话，盘点当前可用的 skill。
//!
//! 数据源与 TUI 的 `/skills` 相同：`ext::SkillCatalog`（用户/项目/内置/插件/随包技能包），
//! 配置里的 `skills.enabled` 与 `skill.*.enable: false` 同样生效。只读。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use nibi_kernel_api::env::{EnvPath, ReadFile, WorkspaceRef};
use nibi_kernel_api::env_files::PathStyle;
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_env_local::LocalEnvironment;
use nibi_kernel_ext::{SkillCatalog, SkillSource};
use nibi_kernel_paths::{StorageSettings, expand_home};
use serde_json::{Value, json};

use crate::config::{self, ConfigInputs};
use crate::{Startup, output};

pub(crate) const USAGE: &str = "Usage:
  nibi skills list [--json] [--cwd <path>]
  nibi skills inspect <name> [--json] [--cwd <path>]
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
}

/// `nibi skills …`：不是 skills 命令时为 None；错误是写到 stderr 的完整文本。
pub(crate) fn parse(args: &[String]) -> Option<Result<Command, String>> {
    let (first, rest) = args.split_first()?;
    if first != "skills" {
        return None;
    }
    let fail = |message: &str| Err(format!("{message}\n{USAGE}"));
    if rest.iter().any(|arg| arg == "-h" || arg == "--help") {
        return Some(Ok(Command::Help));
    }
    let Some(subcommand) = rest.first().map(String::as_str) else {
        return Some(fail("missing skills subcommand (list or inspect)"));
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
            "--cwd" => {
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
                return Some(fail("missing skill name"));
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
        other => Some(fail(&format!("unknown skills subcommand '{other}'"))),
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
        // spec §4：未知 skill 的 stderr 就是 `unknown skill: <name>`，不加 `Error:` 前缀。
        Err(message) if message.starts_with("unknown skill: ") => {
            output::eprint_line(&message);
            1
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
    let catalog = SkillCatalog::new(env.clone(), env.clone());
    catalog.set_enabled(config.skills_enabled);
    catalog.set_disabled_paths(config.disabled_skill_paths.clone());
    catalog.set_plugin_roots(roots.skills);
    catalog.set_extra_roots(roots.skill_roots);
    let skills = catalog.skills(&workspace).await;
    match inspect {
        None => Ok(list_text(&skills, json)),
        Some(name) => {
            let Some(skill) = skills.iter().find(|skill| skill.name == name) else {
                return Err(format!("unknown skill: {name}"));
            };
            let raw = read_raw(env.as_ref(), &workspace, &skill.dir).await;
            Ok(inspect_text(skill, raw.as_deref(), json))
        }
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

/// SKILL.md 的路径（`Skill.dir` 是目录）。
fn skill_file(dir: &str) -> String {
    PathStyle::infer(dir).join(dir, &["SKILL.md"])
}

async fn read_raw(
    files: &dyn nibi_kernel_api::machine::Files,
    workspace: &WorkspaceRef,
    dir: &str,
) -> Option<String> {
    let request = ReadFile {
        path: EnvPath::new(skill_file(dir)),
    };
    let content = files.read_file(workspace, request).await.ok()?;
    Some(String::from_utf8_lossy(&content.bytes).into_owned())
}

fn source(source: &SkillSource) -> (&'static str, Option<&str>) {
    match source {
        SkillSource::Managed => ("managed", None),
        SkillSource::User => ("user", None),
        SkillSource::Project => ("project", None),
        SkillSource::Plugin { plugin } => ("plugin", Some(plugin)),
        SkillSource::Builtin => ("builtin", None),
        SkillSource::Bundled => ("bundled", None),
    }
}

fn metadata(skill: &nibi_kernel_ext::Skill) -> Value {
    json!({
        "display": skill.display,
        "description": skill.description,
        "whenToUse": skill.when_to_use,
        "argumentHint": skill.argument_hint,
        "arguments": skill.arg_names,
        "allowedTools": skill.allowed_tools,
        "disallowedTools": skill.disallowed_tools,
        "disableModelInvocation": skill.disable_model_invocation,
        "userInvocable": skill.user_invocable,
        "paths": skill.paths,
        "shell": match skill.shell {
            nibi_kernel_ext::skills::SkillShell::Bash => "bash",
            nibi_kernel_ext::skills::SkillShell::PowerShell => "powershell",
        },
        "model": skill.model,
        "effort": skill.effort,
        "fork": skill.fork,
        "agent": skill.agent,
        "hasHooks": skill.has_hooks,
    })
}

fn list_json(skill: &nibi_kernel_ext::Skill) -> Value {
    let (source, plugin) = source(&skill.source);
    json!({
        "name": skill.name,
        "source": source,
        "plugin": plugin,
        "path": skill_file(&skill.dir),
        "dir": skill.dir,
        "description": skill.description,
        "enabled": true,
    })
}

fn list_text(skills: &[Arc<nibi_kernel_ext::Skill>], json: bool) -> String {
    if json {
        let values: Vec<Value> = skills.iter().map(|skill| list_json(skill)).collect();
        return json_text(&json!({"schemaVersion": 1, "skills": values}));
    }
    if skills.is_empty() {
        return "No skills found.\n".to_owned();
    }
    let mut lines = Vec::new();
    for skill in skills {
        let (source, plugin) = source(&skill.source);
        let source =
            plugin.map_or_else(|| source.to_owned(), |plugin| format!("{source}:{plugin}"));
        lines.push(format!(
            "{:<24} {:<14} {description}",
            skill.name,
            source,
            description = skill.description
        ));
        lines.push(format!("  {}", skill_file(&skill.dir)));
    }
    lines.join("\n") + "\n"
}

fn inspect_json(skill: &nibi_kernel_ext::Skill, raw: Option<&str>) -> Value {
    let mut value = list_json(skill);
    if let Some(object) = value.as_object_mut() {
        object.insert("allowedTools".to_owned(), json!(skill.allowed_tools));
        object.insert("metadata".to_owned(), metadata(skill));
        object.insert(
            "frontmatter".to_owned(),
            raw.and_then(nibi_kernel_ext::skills::frontmatter_text)
                .map_or(Value::Null, Value::String),
        );
    }
    json!({"schemaVersion": 1, "skill": value})
}

fn inspect_text(skill: &nibi_kernel_ext::Skill, raw: Option<&str>, json: bool) -> String {
    if json {
        return json_text(&inspect_json(skill, raw));
    }
    let (source, plugin) = source(&skill.source);
    let source = plugin.map_or_else(|| source.to_owned(), |plugin| format!("{source}:{plugin}"));
    let mut lines = vec![
        format!("{}  {}", skill.name, skill.description),
        format!("  source   {source}"),
        format!("  path     {}", skill_file(&skill.dir)),
        "  enabled  true".to_owned(),
    ];
    if !skill.allowed_tools.is_empty() {
        lines.push(format!("  tools    {}", skill.allowed_tools.join(", ")));
    }
    if let Some(when) = &skill.when_to_use {
        lines.push(format!("  when     {when}"));
    }
    if let Some(frontmatter) = raw.and_then(nibi_kernel_ext::skills::frontmatter_text) {
        lines.push(String::new());
        lines.push(frontmatter);
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
#[path = "skills_tests.rs"]
mod tests;

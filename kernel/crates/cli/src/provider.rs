//! `nibi provider …`：模型 Provider 的查看与配置（与 TUI 的 `/provider`、桌面共用 `provider_config.json`）。
//!
//! 只读写本机文件，不出网：`list` / `show` / `path` 是只读，`add` / `key` / `remove` / `use` 写个人配置。
//! API key 从不作为命令行参数（会进 shell 历史）：`--api-key-stdin` 从标准输入读一行，或设
//! `NIBI_PROVIDER_API_KEY`。

use std::io::Read as _;

use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::provider::WireProtocol;
use nibi_kernel_base::secret::RedactedString;
use nibi_kernel_platform::{Platform, ProviderDraft, ProviderSummary};
use serde_json::{Value, json};

/// 子命令。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Command {
    List {
        json: bool,
    },
    Show {
        id: String,
        json: bool,
    },
    Path {
        json: bool,
    },
    Add {
        options: AddOptions,
        json: bool,
    },
    Key {
        id: String,
        key_stdin: bool,
        json: bool,
    },
    Remove {
        id: String,
        json: bool,
    },
    Use {
        id: String,
        json: bool,
    },
}

/// `nibi provider add` 的选项。
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AddOptions {
    pub name: String,
    pub base_url: String,
    /// `None`：带模板时用模板的协议。
    pub protocol: Option<WireProtocol>,
    pub models: Vec<String>,
    pub template: Option<String>,
    pub key_stdin: bool,
}

const USAGE: &str =
    "Usage: nibi provider <list|show <id>|path|add|key <id>|remove <id>|use <id>> [--json]";
const ADD_USAGE: &str = "Usage: nibi provider add --name <name> --base-url <url> --protocol <anthropic|chat|responses> --model <id> [--model <id>] [--template <id>] [--api-key-stdin]";

/// 第一个参数是 `provider` 时解析成命令；其他命令返回空。
pub(crate) fn parse(args: &[String]) -> Option<Result<Command, String>> {
    let (first, rest) = args.split_first()?;
    if first != "provider" {
        return None;
    }
    Some(parse_command(rest))
}

fn parse_command(args: &[String]) -> Result<Command, String> {
    let (kind, rest) = match args.split_first() {
        Some((kind, rest)) => (kind.as_str(), rest),
        None => return Err(USAGE.to_owned()),
    };
    let json = rest.iter().any(|arg| arg == "--json");
    match kind {
        "list" | "ls" => {
            expect_flags(rest, &["--json"], USAGE)?;
            Ok(Command::List { json })
        }
        "path" => {
            expect_flags(rest, &["--json"], USAGE)?;
            Ok(Command::Path { json })
        }
        "show" => {
            let id = positional(rest, USAGE)?;
            expect_flags_after(rest, &id, &["--json"], USAGE)?;
            Ok(Command::Show { id, json })
        }
        "remove" | "rm" => {
            let id = positional(rest, USAGE)?;
            expect_flags_after(rest, &id, &["--json"], USAGE)?;
            Ok(Command::Remove { id, json })
        }
        "use" => {
            let id = positional(rest, USAGE)?;
            expect_flags_after(rest, &id, &["--json"], USAGE)?;
            Ok(Command::Use { id, json })
        }
        "key" => {
            let id = positional(rest, USAGE)?;
            expect_flags_after(rest, &id, &["--json", "--api-key-stdin"], USAGE)?;
            Ok(Command::Key {
                id,
                key_stdin: rest.iter().any(|arg| arg == "--api-key-stdin"),
                json,
            })
        }
        "add" => parse_add(rest, json),
        _ => Err(USAGE.to_owned()),
    }
}

fn parse_add(args: &[String], json: bool) -> Result<Command, String> {
    let (mut name, mut base_url, mut template, mut key_stdin) = (None, None, None, false);
    let (mut protocol, mut models) = (None, Vec::new());
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let value = |index: usize| args.get(index + 1).cloned();
        match arg {
            "--json" => index += 1,
            "--api-key-stdin" => {
                key_stdin = true;
                index += 1;
            }
            "--name" => {
                name = value(index);
                index += 2;
            }
            "--base-url" => {
                base_url = value(index);
                index += 2;
            }
            "--protocol" => {
                protocol = value(index);
                index += 2;
            }
            "--template" => {
                template = value(index);
                index += 2;
            }
            "--model" => {
                let Some(model) = value(index) else {
                    return Err(ADD_USAGE.to_owned());
                };
                models.push(model);
                index += 2;
            }
            other if other.starts_with('-') => return Err(ADD_USAGE.to_owned()),
            other => {
                models.extend(other.split(',').map(str::to_owned));
                index += 1;
            }
        }
    }
    let name = name.filter(|value| !value.trim().is_empty());
    let base_url = base_url.filter(|value| !value.trim().is_empty());
    let protocol = match protocol.as_deref().map(parse_protocol) {
        Some(Some(protocol)) => Some(protocol),
        Some(None) => return Err(format!("unknown protocol; {ADD_USAGE}")),
        None => None,
    };
    let models: Vec<String> = models
        .iter()
        .flat_map(|model| model.split(','))
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
        .collect();
    // 选预设时可以省略 base URL / 协议 / 模型：模板给了缺省值。
    match (&name, &base_url, protocol, models.is_empty()) {
        (Some(_), Some(_), Some(_), false) => {}
        (Some(_), _, _, _) if template.is_some() => {}
        _ => return Err(ADD_USAGE.to_owned()),
    }
    Ok(Command::Add {
        options: AddOptions {
            name: name.unwrap_or_default(),
            base_url: base_url.unwrap_or_default(),
            protocol,
            models,
            template,
            key_stdin,
        },
        json,
    })
}

fn parse_protocol(value: &str) -> Option<WireProtocol> {
    match value.trim().to_ascii_lowercase().as_str() {
        "anthropic" | "anthropic-messages" | "messages" => Some(WireProtocol::AnthropicMessages),
        "chat" | "openai" | "openai-chat" | "openai-chat-completions" => {
            Some(WireProtocol::OpenAiChatCompletions)
        }
        "responses" | "openai-responses" => Some(WireProtocol::OpenAiResponses),
        _ => None,
    }
}

/// 第一个位置参数（子命令的 id）。
fn positional(args: &[String], usage: &str) -> Result<String, String> {
    args.iter()
        .find(|arg| !arg.starts_with('-'))
        .cloned()
        .ok_or_else(|| usage.to_owned())
}

fn expect_flags(args: &[String], allowed: &[&str], usage: &str) -> Result<(), String> {
    if args.iter().all(|arg| allowed.contains(&arg.as_str())) {
        Ok(())
    } else {
        Err(usage.to_owned())
    }
}

/// `id` 之外只允许列出的旗标。
fn expect_flags_after(
    args: &[String],
    id: &str,
    allowed: &[&str],
    usage: &str,
) -> Result<(), String> {
    let mut seen_id = false;
    for arg in args {
        if !seen_id && arg == id {
            seen_id = true;
            continue;
        }
        if !allowed.contains(&arg.as_str()) {
            return Err(usage.to_owned());
        }
    }
    Ok(())
}

/// 命令的执行上下文：平台层、配置文件路径与进程环境（`NIBI_PROVIDER_API_KEY`）。
pub(crate) struct Context<'a> {
    pub platform: &'a Platform,
    pub env: &'a [(String, String)],
}

/// 执行命令，返回退出码。成功写标准输出，错误写标准错误（`Error: <message>`）。
pub(crate) async fn run(command: Command, context: &Context<'_>) -> u8 {
    match execute(command, context).await {
        Ok(output) => {
            crate::output::print_raw(&output);
            0
        }
        Err(message) => {
            eprintln!("Error: {message}");
            1
        }
    }
}

async fn execute(command: Command, context: &Context<'_>) -> Result<String, String> {
    let config = context
        .platform
        .provider_config_file()
        .as_path()
        .display()
        .to_string();
    match command {
        Command::List { json } => {
            let items = context.platform.provider_list().await?;
            if json {
                let values: Vec<Value> = items.iter().map(summary_json).collect();
                return Ok(json_text(&Value::Array(values)));
            }
            if items.is_empty() {
                return Ok(format!(
                    "No provider configured. Add one with: nibi provider add --name ... --base-url ...\n{config}\n"
                ));
            }
            Ok(items.iter().map(render).collect::<Vec<_>>().join("\n"))
        }
        Command::Show { id, json } => {
            let items = context.platform.provider_list().await?;
            let item = items
                .iter()
                .find(|item| item.id == id)
                .ok_or_else(|| format!("no provider with id {id}"))?;
            if json {
                return Ok(json_text(&summary_json(item)));
            }
            Ok(render(item))
        }
        Command::Path { json } => {
            if json {
                Ok(format!("{}\n", json!({"path": config})))
            } else {
                Ok(format!("{config}\n"))
            }
        }
        Command::Add { options, json } => {
            let key = api_key(options.key_stdin, context.env)?;
            // 预设补上没给的端点、协议、模型与名字（与 TUI 选预设之后看到的一致）。
            let preset = match &options.template {
                None => None,
                Some(id) => Some(
                    context
                        .platform
                        .provider_presets()
                        .await?
                        .into_iter()
                        .find(|preset| &preset.id == id)
                        .ok_or_else(|| format!("unknown provider template: {id}"))?,
                ),
            };
            let draft = ProviderDraft {
                provider_id: None,
                name: options.name,
                base_url: options.base_url,
                protocol: options
                    .protocol
                    .or_else(|| preset.as_ref().map(|preset| preset.protocol))
                    .unwrap_or(WireProtocol::OpenAiChatCompletions),
                models: options.models,
                api_key: key,
                template: options.template,
                enabled: true,
            };
            let id = context.platform.save_provider(draft).await?;
            if json {
                return Ok(format!("{}\n", json!({"id": id, "config": config})));
            }
            Ok(format!("Saved {id}\n{config}\n"))
        }
        Command::Key {
            id,
            key_stdin,
            json,
        } => {
            let key = api_key(key_stdin, context.env)?.ok_or_else(|| {
                "an API key is required: --api-key-stdin or NIBI_PROVIDER_API_KEY".to_owned()
            })?;
            let items = context.platform.provider_list().await?;
            let item = items
                .iter()
                .find(|item| item.id == id)
                .ok_or_else(|| format!("no provider with id {id}"))?;
            let draft = ProviderDraft {
                provider_id: Some(item.id.clone()),
                name: item.name.clone(),
                base_url: item.base_url.clone(),
                protocol: item.protocol.unwrap_or(WireProtocol::OpenAiChatCompletions),
                models: item.models.clone(),
                api_key: Some(key),
                template: item.template.clone(),
                enabled: item.enabled,
            };
            context.platform.save_provider(draft).await?;
            if json {
                Ok(format!("{}\n", json!({"id": id, "config": config})))
            } else {
                Ok(format!("Saved the API key for {id}\n{config}\n"))
            }
        }
        Command::Remove { id, json } => {
            context.platform.remove_provider(&id).await?;
            if json {
                Ok(format!("{}\n", json!({"removed": id, "config": config})))
            } else {
                Ok(format!("Removed {id}\n{config}\n"))
            }
        }
        Command::Use { id, json } => {
            let items = context.platform.provider_list().await?;
            let item = items
                .iter()
                .find(|item| item.id == id)
                .ok_or_else(|| format!("no provider with id {id}"))?;
            let model = item
                .models
                .first()
                .ok_or_else(|| format!("provider {id} has no model"))?;
            let selection = ModelSelection {
                provider: item.id.clone(),
                model: model.clone(),
                reasoning: None,
                connection: None,
            };
            context.platform.save_default_model(&selection).await?;
            if json {
                Ok(format!(
                    "{}\n",
                    json!({"provider": selection.provider, "model": selection.model, "config": config})
                ))
            } else {
                Ok(format!(
                    "Default model set to {}/{}\n{config}\n",
                    selection.provider, selection.model
                ))
            }
        }
    }
}

/// API key：`--api-key-stdin` 读标准输入的一行，否则看 `NIBI_PROVIDER_API_KEY`。都没有时 `Ok(None)`。
fn api_key(from_stdin: bool, env: &[(String, String)]) -> Result<Option<RedactedString>, String> {
    if from_stdin {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| format!("cannot read the API key from stdin: {error}"))?;
        let key = text.lines().next().unwrap_or_default().trim();
        if key.is_empty() {
            return Err("stdin did not contain an API key".to_owned());
        }
        return Ok(Some(RedactedString::new(key.to_owned())));
    }
    Ok(env
        .iter()
        .find(|(name, _)| name == "NIBI_PROVIDER_API_KEY")
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| RedactedString::new(value.to_owned())))
}

fn json_text(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

/// `--json` 的形状（与 TUI、协议里的 camelCase 一致）。
fn summary_json(item: &ProviderSummary) -> Value {
    json!({
        "id": item.id,
        "name": item.name,
        "baseUrl": item.base_url,
        "protocol": item.protocol.map(|protocol| protocol.as_str()),
        "models": item.models,
        "hasKey": item.has_key,
        "account": item.account,
        "personal": item.personal,
        "enabled": item.enabled,
        "template": item.template,
    })
}

fn render(item: &ProviderSummary) -> String {
    let key = if item.account {
        "account".to_owned()
    } else if item.has_key {
        "set".to_owned()
    } else {
        "missing".to_owned()
    };
    let mut lines = vec![format!("{}  {}", item.id, item.name)];
    let field = |label: &str, value: &str| format!("  {label:<9} {value}");
    lines.push(field("base URL", &item.base_url));
    lines.push(field(
        "protocol",
        item.protocol
            .map(|protocol| protocol.as_str())
            .unwrap_or("-"),
    ));
    lines.push(field(
        "models",
        if item.models.is_empty() {
            "none".to_owned()
        } else {
            item.models.join(", ")
        }
        .as_str(),
    ));
    lines.push(field("api key", &key));
    if let Some(template) = &item.template {
        lines.push(field("template", template));
    }
    lines.push(String::new());
    lines.join("\n")
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;

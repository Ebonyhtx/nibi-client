//! 个人 Provider 的读、加、改、删（Rust TUI 的 `/provider` 与 `nibi provider`）。
//!
//! 读写的是 Node、App 共用的 `provider_config.json`（platform.md §3）：
//!
//! - `providerConfigRules.providerRules` 里一条 `personal:<id>` 规则（`providerName`、`enabled`、
//!   `config.api` / `config.access` / `config.personalModelIds`，可选 `templateId` 继承内置模板）；
//! - `modelConfigRules.providerModelRules` 里每个自定义模型一条完整的能力规则（与
//!   `packages/provider/src/config` 的 schema 相同，缺一个叶子模型就不可执行）；
//! - `defaultModelSelection`（新加的 provider 顺手设为默认模型）。
//!
//! 内置模板（`providerConfigRules.templateRules`）只作为预设：带着 `templateId` 的个人规则继承它的
//! `api` / `access` / `builtinModelIds`，所以选预设时不用手填 base URL、协议与模型名。

use std::collections::HashSet;

use nibi_kernel_api::provider::WireProtocol;
use nibi_kernel_base::secret::RedactedString;
use nibi_kernel_fs::LockOptions;
use nibi_kernel_paths::StoragePath;
use serde_json::{Map, Value, json};

use super::rules::{array, ids, overlay, text};

/// 一个 Provider 的概览（`/provider`、`nibi provider list`）。`models` 是配置里的模型清单，不是“可执行”
/// 的那一份：没有 key 的 Provider 也要能看见并补 key。
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: Option<WireProtocol>,
    pub models: Vec<String>,
    /// API key 已配置（个人规则里的 `access.apiKey` 非空）。
    pub has_key: bool,
    /// 官方账号 Provider（`access.type = zhipu-account`）：不能填 key、不能改端点。
    pub account: bool,
    /// 个人配置里的规则；只有这些能改模型清单与删除。
    pub personal: bool,
    pub enabled: bool,
    /// 继承的内置模板（选预设时写进去的 `templateId`）。
    pub template: Option<String>,
    /// 第一个可执行模型的最后一个档位：`/provider use` 写默认模型时要带上它（Node 只认带档位的选择）。
    /// 没有可执行模型（缺 key、端点无效）时为空。
    pub default_reasoning: Option<String>,
}

/// 内置模板（新建 Provider 的预设）。
#[derive(Debug, Clone, PartialEq)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: WireProtocol,
    pub models: Vec<String>,
}

/// 新建或修改一个 Provider。
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    /// 已有 Provider 的 id；`None` 是新建（按名字生成 `personal:<slug>`）。
    pub provider_id: Option<String>,
    pub name: String,
    pub base_url: String,
    pub protocol: WireProtocol,
    /// 自定义模型的 id；带模板时是模板之外的额外模型（模板自带的不必重复）。
    pub models: Vec<String>,
    /// `None`：保留已有的 key（新建时就是没有 key）。
    pub api_key: Option<RedactedString>,
    /// 继承的内置模板。
    pub template: Option<String>,
    pub enabled: bool,
}

/// 文件的空配置（与 Node `encodeProviderConfigFile(emptyUpdate)` 相同）。
fn empty_personal() -> Value {
    json!({
        "schemaVersion": 1,
        "config": {
            "providerOrder": [],
            "providerConfigRules": {"providerRules": []},
            "modelConfigRules": {"providerModelRules": [], "manualProviderModelRules": []},
        },
    })
}

/// 自定义模型的默认能力：能拿到就能用（文本、工具、128k 窗口、8k 输出）。两处 `map` 是空对象字面量：
/// 不影响请求体，但 schema 与 `model_complete` 要求它存在且可编译。
fn default_model_rule(provider_id: &str, model_id: &str) -> Value {
    json!({
        "providerId": provider_id,
        "modelId": model_id,
        "config": {
            "enabled": true,
            "properties": {
                "requiresMfjsToolSchema": false,
                "contextWindow": 128000,
                "inputFormat": {
                    "supportsText": true,
                    "supportsImage": false,
                    "supportsVideo": false,
                    "supportsAudio": false,
                    "supportsPdf": false,
                },
                "outputFormat": {"supportsText": true},
                "supportsToolCall": true,
                "supportsJsonSchemaOutput": false,
                "supportsNativeWebSearch": false,
                "supportsMidConversationSystem": false,
            },
            "optionSpecs": {
                "reasoningLevel": {"values": ["low", "high"], "map": "{}"},
                "maxOutputTokens": {"max": 8192, "map": "{}"},
            },
        },
    })
}

/// 内置模板的一条：`templateRules` 里 `api.type` / `api.baseUrl` / `builtinModelIds` 齐全的那些。
fn templates(builtin: &Value) -> Vec<Preset> {
    array(&builtin["providerConfigRules"]["templateRules"])
        .iter()
        .filter_map(|rule| {
            let config = &rule["config"];
            let protocol = WireProtocol::parse(text(&config["api"], "type"))?;
            let base_url = text(&config["api"], "baseUrl").to_owned();
            if base_url.is_empty() {
                return None;
            }
            let name = rule["templateNameMap"]["zh-CN"]
                .as_str()
                .filter(|name| !name.trim().is_empty())
                .or_else(|| rule["templateNameMap"]["en-US"].as_str())
                .unwrap_or_else(|| text(rule, "templateId"))
                .to_owned();
            Some(Preset {
                id: text(rule, "templateId").to_owned(),
                name,
                base_url,
                protocol,
                models: ids(&config["builtinModelIds"]),
            })
        })
        .collect()
}

/// 预设清单（新建 Provider 时选）。上游的两套「套餐」生态（Z.ai / BigModel Coding Plan）不列：
/// 它们是另一家的账号产品，NIBI 的模型入口只留普通第三方 API（端点 + key）。
pub fn presets(builtin: &Value) -> Vec<Preset> {
    let mut seen = HashSet::new();
    templates(builtin)
        .into_iter()
        .filter(|preset| !preset.id.is_empty())
        .filter(|preset| !preset.id.starts_with("zai-") && !preset.id.starts_with("bigmodel-"))
        .filter(|preset| seen.insert(preset.id.clone()))
        .collect()
}

/// 一个目录的全部 Provider：内置（模板 + 规则）与个人规则合并后的结果。内置 providerRules 当前是空的
/// （分家后不带上游账号），但保留合并规则，桌面那份更全的内置配置同样适用。
pub fn summaries(builtin: &Value, personal: &Value) -> Vec<Summary> {
    let templates = templates(builtin);
    let template_of = |id: &str| templates.iter().find(|preset| preset.id == id);
    let mut out: Vec<Summary> = Vec::new();
    let mut add = |rule: &Value, base: Option<&Value>, personal: bool| {
        let id = text(rule, "providerId");
        if id.is_empty() {
            return;
        }
        if let Some(known) = out.iter_mut().find(|entry| entry.id == id) {
            // 个人规则盖在内置之上：只更新能覆盖的字段。
            merge_summary(known, rule, base, personal);
            return;
        }
        let mut config = base
            .map(|base| base["config"].clone())
            .unwrap_or(Value::Null);
        merge_config(&mut config, &rule["config"]);
        let template = rule["templateId"].as_str().map(str::to_owned).or_else(|| {
            base.and_then(|base| base["templateId"].as_str())
                .map(str::to_owned)
        });
        let template_config = template.as_deref().and_then(template_of).map(|preset| {
            json!({
                "api": {"type": preset.protocol.as_str(), "baseUrl": preset.base_url},
                "builtinModelIds": preset.models,
            })
        });
        if let Some(template_config) = &template_config {
            let mut merged = template_config.clone();
            overlay(&mut merged, &config);
            config = merged;
        }
        let name = rule["providerName"]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .or_else(|| base.and_then(|base| base["providerName"].as_str()))
            .or_else(|| {
                template
                    .as_deref()
                    .and_then(template_of)
                    .map(|preset| preset.name.as_str())
            })
            .unwrap_or(&id)
            .to_owned();
        let mut models = ids(&config["builtinModelIds"]);
        for model in ids(&config["personalModelIds"]) {
            if !models.contains(&model) {
                models.push(model);
            }
        }
        out.push(Summary {
            id: id.to_owned(),
            name,
            base_url: text(&config["api"], "baseUrl").to_owned(),
            protocol: WireProtocol::parse(text(&config["api"], "type")),
            models,
            has_key: config["access"]["apiKey"]
                .as_str()
                .is_some_and(|key| !key.trim().is_empty()),
            account: config["access"]["type"] == "zhipu-account",
            personal,
            enabled: rule["enabled"] != false,
            template,
            default_reasoning: None,
        });
    };
    for rule in array(&builtin["providerConfigRules"]["providerRules"]) {
        add(rule, None, false);
    }
    for rule in array(&personal["providerConfigRules"]["providerRules"]) {
        add(rule, None, true);
    }
    out
}

fn merge_summary(entry: &mut Summary, rule: &Value, _base: Option<&Value>, personal: bool) {
    let config = &rule["config"];
    if let Some(name) = rule["providerName"]
        .as_str()
        .filter(|name| !name.trim().is_empty())
    {
        entry.name = name.to_owned();
    }
    if let Some(base_url) = config["api"]["baseUrl"].as_str() {
        entry.base_url = base_url.to_owned();
    }
    if let Some(protocol) = WireProtocol::parse(text(&config["api"], "type")) {
        entry.protocol = Some(protocol);
    }
    for model in ids(&config["personalModelIds"]) {
        if !entry.models.contains(&model) {
            entry.models.push(model);
        }
    }
    if config["access"]["apiKey"]
        .as_str()
        .is_some_and(|key| !key.trim().is_empty())
    {
        entry.has_key = true;
    }
    if config["access"]["type"] == "zhipu-account" {
        entry.account = true;
    }
    if personal {
        entry.personal = true;
    }
    if rule["enabled"] == false {
        entry.enabled = false;
    }
    if let Some(template) = rule["templateId"].as_str() {
        entry.template = Some(template.to_owned());
    }
}

/// 与 [`super::rules::overlay`] 相同的合并，但接受 `Null` 起点（这里没有模板的判断）。
fn merge_config(base: &mut Value, next: &Value) {
    if !base.is_object() {
        *base = json!({});
    }
    overlay(base, next);
}

fn valid_base_url(base_url: &str) -> bool {
    url::Url::parse(base_url).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
    })
}

/// 名字 → `personal:<slug>`：只保留 ASCII 字母数字，其他字符变 `-`。
fn slug(name: &str) -> String {
    let mut out = String::new();
    for character in name.trim().chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "provider".to_owned()
    } else {
        out.chars().take(40).collect()
    }
}

fn provider_id(draft: &Draft, taken: &HashSet<String>) -> String {
    if let Some(id) = &draft.provider_id {
        return id.clone();
    }
    let base = format!("personal:{}", slug(&draft.name));
    if !taken.contains(&base) {
        return base;
    }
    for index in 2..1000 {
        let candidate = format!("{base}-{index}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    base
}

/// 读个人配置（不存在时是空配置）。放在锁里调用。
async fn read_personal(path: &std::path::Path) -> anyhow::Result<Value> {
    match nibi_kernel_fs::read_optional(path).await? {
        None => Ok(empty_personal()),
        Some(bytes) => Ok(serde_json::from_slice::<Value>(&bytes)
            .map_err(|error| anyhow::anyhow!("{}: {error}", path.display()))?),
    }
}

fn config_body(config: &mut Value) -> anyhow::Result<&mut Map<String, Value>> {
    if config["schemaVersion"] != 1 {
        return Err(anyhow::anyhow!("not a schemaVersion 1 provider config"));
    }
    config
        .get_mut("config")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow::anyhow!("not a schemaVersion 1 provider config"))
}

fn rules_mut(body: &mut Map<String, Value>, group: &str, key: &str) -> Vec<Value> {
    let rules = body.entry(group).or_insert_with(|| json!({}));
    if !rules.is_object() {
        *rules = json!({});
    }
    let values = rules
        .as_object_mut()
        .expect("object")
        .entry(key)
        .or_insert_with(|| json!([]));
    if !values.is_array() {
        *values = json!([]);
    }
    values.as_array_mut().expect("array").drain(..).collect()
}

fn set_rules(body: &mut Map<String, Value>, group: &str, key: &str, values: Vec<Value>) {
    let rules = body.entry(group).or_insert_with(|| json!({}));
    if !rules.is_object() {
        *rules = json!({});
    }
    rules
        .as_object_mut()
        .expect("object")
        .insert(key.to_owned(), Value::Array(values));
}

/// 新建或修改一个个人 Provider，返回它的 id。写文件持目录锁、原子替换、权限 0600；其余字段原样保留。
pub async fn save(file: &StoragePath, builtin: &Value, draft: &Draft) -> Result<String, String> {
    let template = draft
        .template
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let preset = match &template {
        None => None,
        Some(template) => Some(
            templates(builtin)
                .into_iter()
                .find(|preset| &preset.id == template)
                .ok_or_else(|| format!("unknown provider template: {template}"))?,
        ),
    };
    // 预设给了缺省端点与模型：只给 `--template` 时也能建起来（TUI 会先填好，CLI 允许省略）。
    let base_url = if draft.base_url.trim().is_empty() {
        preset
            .as_ref()
            .map(|preset| preset.base_url.trim_end_matches('/').to_owned())
            .unwrap_or_default()
    } else {
        draft.base_url.trim().trim_end_matches('/').to_owned()
    };
    let name = if draft.name.trim().is_empty() {
        preset
            .as_ref()
            .map(|preset| preset.name.clone())
            .unwrap_or_default()
    } else {
        draft.name.trim().to_owned()
    };
    if name.is_empty() {
        return Err("provider name is required".to_owned());
    }
    if !valid_base_url(&base_url) {
        return Err(format!(
            "base URL must be an http(s) URL without credentials: {}",
            draft.base_url.trim()
        ));
    }
    let models: Vec<String> = {
        let mut seen = HashSet::new();
        draft
            .models
            .iter()
            .map(|model| model.trim().to_owned())
            .filter(|model| !model.is_empty() && seen.insert(model.clone()))
            .collect()
    };
    let template_models = preset
        .as_ref()
        .map(|preset| preset.models.clone())
        .unwrap_or_default();
    let models = if models.is_empty() && !template_models.is_empty() {
        template_models.clone()
    } else {
        models
    };
    if template.is_none() && models.is_empty() {
        return Err("a custom provider needs at least one model id".to_owned());
    }
    let extra_models: Vec<String> = models
        .iter()
        .filter(|model| !template_models.contains(model))
        .cloned()
        .collect();
    let draft = Draft {
        name,
        base_url,
        models,
        ..draft.clone()
    };
    let path = file.as_path();
    let write = async move || {
        let mut config = read_personal(path).await?;
        let mut body = config_body(&mut config)?.clone();
        let mut existing = rules_mut(&mut body, "providerConfigRules", "providerRules");
        let mut taken: HashSet<String> = existing
            .iter()
            .filter_map(|rule| rule["providerId"].as_str().map(str::to_owned))
            .collect();
        for rule in array(&builtin["providerConfigRules"]["providerRules"]) {
            if let Some(id) = rule["providerId"].as_str() {
                taken.insert(id.to_owned());
            }
        }
        let is_new = draft.provider_id.is_none();
        let id = provider_id(&draft, &taken);
        let index = existing
            .iter()
            .position(|rule| rule["providerId"].as_str() == Some(id.as_str()));
        if index.is_none() && !is_new && !id.starts_with("personal:") {
            return Err(anyhow::anyhow!("provider {id} is not a personal provider"));
        }
        let mut rule = index
            .map(|index| existing[index].clone())
            .unwrap_or_else(|| json!({"providerId": id}));
        let mut config_rule = rule["config"].clone();
        if !config_rule.is_object() {
            config_rule = json!({});
        }
        if is_new {
            config_rule["group"] = Value::String("standard-personal".to_owned());
        }
        rule["providerName"] = Value::String(draft.name.clone());
        rule["enabled"] = Value::Bool(draft.enabled);
        if let Some(template) = &draft.template {
            rule["templateId"] = Value::String(template.clone());
        }
        let mut api = config_rule["api"].clone();
        if !api.is_object() {
            api = json!({});
        }
        api["type"] = Value::String(draft.protocol.as_str().to_owned());
        api["baseUrl"] = Value::String(draft.base_url.clone());
        config_rule["api"] = api;
        if let Some(key) = &draft.api_key {
            let key = key.expose().trim();
            if key.is_empty() {
                return Err(anyhow::anyhow!("API key is empty"));
            }
            config_rule["access"] = json!({"type": "api-key", "apiKey": key});
        } else if is_new {
            config_rule["access"] = json!({"type": "api-key"});
        }
        if draft.template.is_some() {
            if extra_models.is_empty() {
                if let Some(config) = config_rule.as_object_mut() {
                    config.remove("personalModelIds");
                }
            } else {
                config_rule["personalModelIds"] = json!(extra_models);
            }
        } else {
            config_rule["personalModelIds"] = json!(draft.models);
        }
        rule["config"] = config_rule;
        match index {
            Some(index) => existing[index] = rule.clone(),
            None => existing.push(rule.clone()),
        }
        set_rules(&mut body, "providerConfigRules", "providerRules", existing);
        // 模型规则：自定义模型（模板之外的）各一条完整能力规则；删掉的模型去掉它的规则。
        let mut model_rules = rules_mut(&mut body, "modelConfigRules", "providerModelRules");
        let wanted: Vec<&String> = if draft.template.is_some() {
            extra_models.iter().collect()
        } else {
            draft.models.iter().collect()
        };
        model_rules.retain(|rule| {
            rule["providerId"].as_str() != Some(id.as_str())
                || rule["modelId"]
                    .as_str()
                    .is_some_and(|model| wanted.iter().any(|wanted| wanted.as_str() == model))
        });
        for model in &wanted {
            let present = model_rules.iter().any(|rule| {
                rule["providerId"].as_str() == Some(id.as_str())
                    && rule["modelId"].as_str() == Some(model.as_str())
            });
            if !present {
                model_rules.push(default_model_rule(&id, model));
            }
        }
        set_rules(
            &mut body,
            "modelConfigRules",
            "providerModelRules",
            model_rules,
        );
        // 顺序与默认模型：新 Provider 追加在最后，并成为默认模型（否则新装的环境仍然没有可用的模型）。
        let mut order: Vec<Value> = body
            .get("providerOrder")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !order
            .iter()
            .any(|value| value.as_str() == Some(id.as_str()))
        {
            order.push(Value::String(id.clone()));
        }
        body.insert("providerOrder".to_owned(), Value::Array(order));
        if is_new && !draft.models.is_empty() {
            body.insert(
                "defaultModelSelection".to_owned(),
                json!({"providerId": id, "modelId": draft.models[0]}),
            );
        }
        config["config"] = Value::Object(body);
        let text = crate::cli_config::node_pretty(&config);
        nibi_kernel_fs::atomic_write(path, text.as_bytes(), crate::credentials::PRIVATE_WRITE)
            .await?;
        Ok(id)
    };
    nibi_kernel_fs::with_file_lock(path, &LockOptions::default(), write)
        .await
        .map_err(|error| format!("{}: {error:#}", path.display()))
}

/// 删除一个个人 Provider 的规则、它的模型规则与顺序项；默认模型指向它时一起清掉。
pub async fn remove(file: &StoragePath, id: &str) -> Result<(), String> {
    if !id.starts_with("personal:") {
        return Err(format!("provider {id} is not a personal provider"));
    }
    let path = file.as_path();
    let write = async move || {
        let mut config = read_personal(path).await?;
        let mut body = config_body(&mut config)?.clone();
        let mut rules = rules_mut(&mut body, "providerConfigRules", "providerRules");
        let before = rules.len();
        rules.retain(|rule| rule["providerId"].as_str() != Some(id));
        if rules.len() == before {
            return Err(anyhow::anyhow!("provider {id} is not configured"));
        }
        set_rules(&mut body, "providerConfigRules", "providerRules", rules);
        let mut model_rules = rules_mut(&mut body, "modelConfigRules", "providerModelRules");
        model_rules.retain(|rule| rule["providerId"].as_str() != Some(id));
        set_rules(
            &mut body,
            "modelConfigRules",
            "providerModelRules",
            model_rules,
        );
        let order: Vec<Value> = body
            .get("providerOrder")
            .and_then(Value::as_array)
            .map(|order| {
                order
                    .iter()
                    .filter(|value| value.as_str() != Some(id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        body.insert("providerOrder".to_owned(), Value::Array(order));
        if body["defaultModelSelection"]["providerId"].as_str() == Some(id) {
            body.remove("defaultModelSelection");
        }
        config["config"] = Value::Object(body);
        let text = crate::cli_config::node_pretty(&config);
        nibi_kernel_fs::atomic_write(path, text.as_bytes(), crate::credentials::PRIVATE_WRITE)
            .await?;
        Ok(())
    };
    nibi_kernel_fs::with_file_lock(path, &LockOptions::default(), write)
        .await
        .map_err(|error| format!("{}: {error:#}", path.display()))
}

#[cfg(test)]
#[path = "edit_tests.rs"]
mod tests;

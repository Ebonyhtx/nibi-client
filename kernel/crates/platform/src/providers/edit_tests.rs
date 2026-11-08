//! 个人 Provider 的加、改、删（`/provider`、`nibi provider`）：写出来的文件能被同一套解析读回。

use nibi_kernel_base::secret::RedactedString;
use nibi_kernel_paths::StoragePaths;
use serde_json::Value;

use super::*;
use crate::providers::BUNDLED_BUILTIN;

/// 内置配置的 `config`（与 `Registry::builtin_config` 给的是同一层）。
fn builtin() -> Value {
    let document: Value = serde_json::from_str(BUNDLED_BUILTIN).unwrap();
    document["config"].clone()
}

fn paths(dir: &std::path::Path) -> StoragePaths {
    StoragePaths::resolve(&Default::default(), dir, dir)
}

fn draft(name: &str, models: &[&str]) -> Draft {
    Draft {
        provider_id: None,
        name: name.to_owned(),
        base_url: "https://gateway.example.com/v1".to_owned(),
        protocol: WireProtocol::OpenAiChatCompletions,
        models: models.iter().map(|model| (*model).to_owned()).collect(),
        api_key: Some(RedactedString::new("sk-test")),
        template: None,
        enabled: true,
    }
}

fn read(paths: &StoragePaths) -> Value {
    let text = std::fs::read_to_string(paths.provider_config().as_path()).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn adds_a_custom_provider_with_its_model_rules_and_default() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let id = save(
        &paths.provider_config(),
        &builtin(),
        &draft("My Gateway", &["glm-5"]),
    )
    .await
    .unwrap();
    assert_eq!(id, "personal:my-gateway");

    let file = read(&paths);
    let rule = &file["config"]["providerConfigRules"]["providerRules"][0];
    assert_eq!(rule["providerId"], "personal:my-gateway");
    assert_eq!(rule["providerName"], "My Gateway");
    assert_eq!(rule["enabled"], true);
    assert_eq!(rule["config"]["group"], "standard-personal");
    assert_eq!(rule["config"]["access"]["type"], "api-key");
    assert_eq!(rule["config"]["access"]["apiKey"], "sk-test");
    assert_eq!(rule["config"]["api"]["type"], "openai-chat-completions");
    assert_eq!(
        rule["config"]["api"]["baseUrl"],
        "https://gateway.example.com/v1"
    );
    assert_eq!(
        rule["config"]["personalModelIds"],
        serde_json::json!(["glm-5"])
    );
    // 自定义模型要一条完整的能力规则，否则不可执行。
    let model_rule = &file["config"]["modelConfigRules"]["providerModelRules"][0];
    assert_eq!(model_rule["providerId"], "personal:my-gateway");
    assert_eq!(model_rule["modelId"], "glm-5");
    assert_eq!(
        model_rule["config"]["optionSpecs"]["maxOutputTokens"]["max"],
        8192
    );
    // 新 Provider 成为默认模型，新装的环境立刻可用。
    assert_eq!(
        file["config"]["defaultModelSelection"],
        serde_json::json!({"providerId": "personal:my-gateway", "modelId": "glm-5"})
    );

    let summary = summaries(&builtin(), &file["config"])
        .into_iter()
        .find(|entry| entry.id == id)
        .unwrap();
    assert_eq!(summary.name, "My Gateway");
    assert_eq!(summary.models, vec!["glm-5".to_owned()]);
    assert!(summary.has_key);
    assert!(summary.personal);
    assert_eq!(summary.protocol, Some(WireProtocol::OpenAiChatCompletions));
}

#[test]
fn the_preset_list_covers_third_party_apis_and_upstream_model_endpoints() {
    let presets = presets(&builtin());
    // 普通第三方 API。
    assert!(presets.iter().any(|preset| preset.id == "deepseek"));
    assert!(presets.iter().any(|preset| preset.id == "openai"));
    assert!(presets.iter().any(|preset| preset.id == "anthropic"));
    // 上游的模型端点也保留（用户可以用自己的 key 用它的模型），只是不接账号与会员。
    assert!(presets.iter().any(|preset| preset.id == "zai-api"));
    assert!(presets.iter().any(|preset| preset.id == "bigmodel-api"));
}

#[tokio::test]
async fn a_preset_inherits_the_template_models() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let mut preset = draft("DeepSeek", &[]);
    preset.template = Some("deepseek".to_owned());
    preset.base_url = "https://api.deepseek.com/anthropic".to_owned();
    preset.protocol = WireProtocol::AnthropicMessages;
    let id = save(&paths.provider_config(), &builtin(), &preset)
        .await
        .unwrap();

    let file = read(&paths);
    let rule = &file["config"]["providerConfigRules"]["providerRules"][0];
    assert_eq!(rule["templateId"], "deepseek");
    // 模板自带模型：不重复写 personalModelIds，也不给模板模型生成能力规则。
    assert!(rule["config"].get("personalModelIds").is_none());
    assert!(
        file["config"]["modelConfigRules"]["providerModelRules"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let summary = summaries(&builtin(), &file["config"])
        .into_iter()
        .find(|entry| entry.id == id)
        .unwrap();
    assert!(summary.models.contains(&"deepseek-v4-pro".to_owned()));
    assert_eq!(summary.template.as_deref(), Some("deepseek"));
}

#[tokio::test]
async fn editing_keeps_the_key_and_syncs_the_model_rules() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let id = save(
        &paths.provider_config(),
        &builtin(),
        &draft("Gateway", &["model-a", "model-b"]),
    )
    .await
    .unwrap();

    let mut edit = draft("Gateway Renamed", &["model-b", "model-c"]);
    edit.provider_id = Some(id.clone());
    edit.base_url = "https://relay.example.com/v1".to_owned();
    edit.api_key = None;
    save(&paths.provider_config(), &builtin(), &edit)
        .await
        .unwrap();

    let file = read(&paths);
    let rule = &file["config"]["providerConfigRules"]["providerRules"][0];
    assert_eq!(rule["providerName"], "Gateway Renamed");
    assert_eq!(
        rule["config"]["api"]["baseUrl"],
        "https://relay.example.com/v1"
    );
    // 没给 key 时保留原来的。
    assert_eq!(rule["config"]["access"]["apiKey"], "sk-test");
    assert_eq!(
        rule["config"]["personalModelIds"],
        serde_json::json!(["model-b", "model-c"])
    );
    let models: Vec<&str> = file["config"]["modelConfigRules"]["providerModelRules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|rule| rule["modelId"].as_str().unwrap())
        .collect();
    assert_eq!(models, vec!["model-b", "model-c"]);
    // 只有一条规则，编辑不会重复追加。
    assert_eq!(
        file["config"]["providerConfigRules"]["providerRules"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn removal_accepts_legacy_ids_without_the_personal_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    // 桌面早期写的规则 id 就是 `new-provider`（没有 `personal:`）：直接写进文件再删。
    std::fs::create_dir_all(paths.provider_config().as_path().parent().unwrap()).unwrap();
    std::fs::write(
        paths.provider_config().as_path(),
        serde_json::json!({
            "schemaVersion": 1,
            "config": {
                "providerOrder": ["new-provider"],
                "providerConfigRules": {"providerRules": [{
                    "providerId": "new-provider",
                    "providerName": "Legacy",
                    "config": {
                        "group": "standard-personal",
                        "access": {"type": "api-key", "apiKey": "sk-test"},
                        "api": {"type": "openai-chat-completions", "baseUrl": "https://legacy.example.com/v1"},
                        "personalModelIds": ["m"]
                    }
                }]},
                "modelConfigRules": {"providerModelRules": [], "manualProviderModelRules": []},
                "defaultModelSelection": {"providerId": "new-provider", "modelId": "m"}
            }
        })
        .to_string(),
    )
    .unwrap();
    remove(&paths.provider_config(), "new-provider")
        .await
        .unwrap();
    assert!(
        read(&paths)["config"]["providerConfigRules"]["providerRules"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn removal_clears_the_rule_models_order_and_default() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let id = save(&paths.provider_config(), &builtin(), &draft("Gone", &["m"]))
        .await
        .unwrap();
    remove(&paths.provider_config(), &id).await.unwrap();

    let file = read(&paths);
    assert!(
        file["config"]["providerConfigRules"]["providerRules"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        file["config"]["modelConfigRules"]["providerModelRules"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        file["config"]["providerOrder"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(file["config"]["defaultModelSelection"].is_null());
}

/// 写出来的配置要真的能被 Registry 解析成可执行模型（模板的模型规则、自定义模型的能力规则都算）。
#[tokio::test]
async fn the_saved_provider_resolves_to_executable_models() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let secret = crate::credentials::CredentialSecret {
        explicit: Some(RedactedString::new("s")),
        platform: "linux".to_owned(),
        home: "/home/dev".to_owned(),
        username: "dev".to_owned(),
    };
    let credentials = crate::credentials::CredentialStore::new(paths.credentials(), &secret);
    let registry = crate::providers::Registry::new(
        None,
        paths.provider_config(),
        credentials.clone(),
        crate::test_support::offline_account(credentials).await,
    );

    // 预设：模型能力来自内置模板。
    let mut preset = draft("DeepSeek", &[]);
    preset.template = Some("deepseek".to_owned());
    preset.base_url = "https://api.deepseek.com/anthropic".to_owned();
    preset.protocol = WireProtocol::AnthropicMessages;
    save(&paths.provider_config(), &builtin(), &preset)
        .await
        .unwrap();
    let snapshot = registry.current().await;
    let models: Vec<String> = snapshot
        .snapshot
        .templates
        .iter()
        .filter(|template| template.provider == "personal:deepseek")
        .map(|template| template.model.clone())
        .collect();
    assert!(models.contains(&"deepseek-v4-pro".to_owned()), "{models:?}");
    assert!(
        snapshot
            .snapshot
            .templates
            .iter()
            .all(|template| template.base_url == "https://api.deepseek.com/anthropic")
    );

    // 自定义：每个模型都有一条完整的能力规则，所以也可执行。
    save(
        &paths.provider_config(),
        &builtin(),
        &draft("Gateway", &["glm-5"]),
    )
    .await
    .unwrap();
    let snapshot = registry.current().await;
    assert!(
        snapshot
            .snapshot
            .templates
            .iter()
            .any(|template| template.provider == "personal:gateway" && template.model == "glm-5")
    );
}

/// 新 Provider 顺手成为默认模型（要带上有效的 `options.reasoningLevel`，Node 才认这个字段）。
#[tokio::test]
async fn a_new_provider_becomes_the_default_model() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let secret = crate::credentials::CredentialSecret {
        explicit: Some(RedactedString::new("s")),
        platform: "linux".to_owned(),
        home: "/home/dev".to_owned(),
        username: "dev".to_owned(),
    };
    let platform = crate::Platform::new(
        &paths,
        &secret,
        crate::test_support::offline_services().await,
    );
    let id = platform
        .save_provider(Draft {
            provider_id: None,
            name: "Gateway".to_owned(),
            base_url: "https://gateway.example.com/v1".to_owned(),
            protocol: WireProtocol::OpenAiChatCompletions,
            models: vec!["glm-5".to_owned()],
            api_key: Some(RedactedString::new("sk-test")),
            template: None,
            enabled: true,
        })
        .await
        .unwrap();
    let selection = platform.default_selection().await.unwrap();
    assert_eq!(selection.provider, id);
    assert_eq!(selection.model, "glm-5");
    assert_eq!(selection.reasoning.as_deref(), Some("high"));
    // `/provider use` 与 `nibi provider use` 都靠这份档位写默认模型。
    let items = platform.provider_list().await.unwrap();
    assert_eq!(items[0].default_reasoning.as_deref(), Some("high"));
}

#[tokio::test]
async fn invalid_input_is_rejected_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let mut bad = draft("Bad", &["m"]);
    bad.base_url = "ftp://example.com".to_owned();
    assert!(
        save(&paths.provider_config(), &builtin(), &bad)
            .await
            .unwrap_err()
            .contains("http(s)")
    );
    let empty = draft("Empty", &[]);
    assert!(
        save(&paths.provider_config(), &builtin(), &empty)
            .await
            .unwrap_err()
            .contains("at least one model")
    );
    assert!(!paths.provider_config().as_path().exists());
}

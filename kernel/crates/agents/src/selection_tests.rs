//! `model` / `thoughtLevel` 的解析（Node `parseSubagentMarkdownSelection`）。

use nibi_kernel_api::model::ModelSelection;

use super::AgentModelSelection;

#[test]
fn a_picker_value_carries_the_provider_and_its_reasoning_suffix() {
    let parsed = AgentModelSelection::parse("e2e-upstream-alt/deepseek-v4-pro$high", None)
        .expect("picker 串");
    assert_eq!(parsed.provider, "e2e-upstream-alt");
    assert_eq!(parsed.model, "deepseek-v4-pro");
    assert_eq!(parsed.reasoning.as_deref(), Some("high"));
    // `thoughtLevel` 压过 Picker 串里的档位（Node 同一顺序）。
    let parsed = AgentModelSelection::parse("e2e/glm$low", Some(" high ")).expect("picker 串");
    assert_eq!(parsed.reasoning.as_deref(), Some("high"));
    // `$` 在最前或最后时属于型号原文。
    let parsed = AgentModelSelection::parse("e2e/a$", None).expect("picker 串");
    assert_eq!(parsed.model, "a$");
}

#[test]
fn a_custom_value_decodes_both_segments() {
    let parsed = AgentModelSelection::parse("custom:e2e-alt%3Ateam:deepseek%2Fv4-pro", None)
        .expect("custom");
    assert_eq!(parsed.provider, "e2e-alt:team");
    assert_eq!(parsed.model, "deepseek/v4-pro");
    assert_eq!(parsed.reasoning, None);
    // 旧编码 `custom:builtin:<name>:<model>` 的 provider 是 `builtin:<name>`。
    let parsed = AgentModelSelection::parse("custom:builtin:zai-coding-plan:glm-5.3", None)
        .expect("legacy custom");
    assert_eq!(parsed.provider, "builtin:zai-coding-plan");
    assert_eq!(parsed.model, "glm-5.3");
}

#[test]
fn inherit_names_and_bare_ids_are_not_selections() {
    for value in [
        "",
        "inherit",
        "Main",
        "sonnet",
        "opus",
        "haiku",
        "deepseek-v4-pro",
        "/model-without-provider",
        "custom:",
        "custom:provider",
    ] {
        assert!(
            AgentModelSelection::parse(value, Some("high")).is_none(),
            "{value}"
        );
    }
}

#[test]
fn a_selection_keeps_the_connection_only_within_the_same_provider() {
    let connection = nibi_kernel_api::model::ModelConnection {
        product_id: "prod-1".to_owned(),
        organization_id: "org-1".to_owned(),
        project_id: "p-1".to_owned(),
    };
    let parent = ModelSelection {
        provider: "e2e-upstream".to_owned(),
        model: "deepseek-v4-flash".to_owned(),
        reasoning: Some("max".to_owned()),
        connection: Some(Box::new(connection.clone())),
    };
    let same = AgentModelSelection::parse("e2e-upstream/deepseek-v4-pro", None).expect("same");
    let selection = same.selection(&parent);
    assert_eq!(selection.provider, "e2e-upstream");
    assert_eq!(selection.model, "deepseek-v4-pro");
    assert_eq!(selection.reasoning, None);
    assert_eq!(selection.connection, Some(Box::new(connection)));
    // 换供应商时不沿用父会话的团队项目连接（由平台层挑目标供应商的默认连接）。
    let other =
        AgentModelSelection::parse("e2e-upstream-alt/deepseek-v4-pro", None).expect("other");
    assert_eq!(other.selection(&parent).connection, None);
}

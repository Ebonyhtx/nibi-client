//! `agents-state.json` 的解析与套用（Node 存储迁移的当前字段与旧双 map）。

use serde_json::json;

use super::AgentState;
use crate::definitions::{AgentSource, builtins};
use crate::plugin::PluginAgentFile;

fn plugin_definition() -> crate::definitions::AgentDefinition {
    crate::plugin::parse(
        "---\nname: visual-judge\ndescription: Judge it.\n---\nJ.",
        &PluginAgentFile {
            plugin: "documents".to_owned(),
            plugin_id: "documents@nibi-official".to_owned(),
            root: "/plugins/documents".to_owned(),
            path: "/plugins/documents/agents/visual-judge.md".to_owned(),
            namespace: Vec::new(),
        },
        "/repo",
    )
}

#[test]
fn the_current_maps_are_authoritative() {
    let state = AgentState::from_value(&json!({
        "builtInModelSelectionOverrides": {
            "Explore": {
                "providerId": "e2e-upstream-alt",
                "modelId": "deepseek-v4-pro",
                "options": { "reasoningLevel": "high" }
            }
        },
        "pluginAgentModelSelectionOverrides": {
            "plugin:documents@nibi-official:visual-judge": {
                "providerId": "e2e-upstream-alt",
                "modelId": "deepseek-v4-pro",
                "options": { "reasoningLevel": "high" }
            },
            "plugin:broken@inline:lost": { "providerId": "", "modelId": "x" }
        },
        // 旧字段在场也不能复活（Node `Object.hasOwn` 同一判据）。
        "builtInModelOverrides": { "Explore": "e2e-upstream/legacy-model" }
    }));
    assert_eq!(state.built_in.len(), 1);
    assert_eq!(
        state.built_in["Explore"].provider.as_str(),
        "e2e-upstream-alt"
    );
    assert_eq!(state.built_in["Explore"].reasoning.as_deref(), Some("high"));
    assert_eq!(state.plugin.len(), 1);

    let plugin = plugin_definition();
    let over = state.model_override(&plugin).expect("插件覆盖");
    assert_eq!(over.provider, "e2e-upstream-alt");
    assert_eq!(over.model, "deepseek-v4-pro");
    assert_eq!(over.reasoning.as_deref(), Some("high"));

    let general = builtins()
        .into_iter()
        .find(|definition| definition.agent_type == "general-purpose")
        .expect("general-purpose");
    assert_eq!(state.model_override(&general), None);
}

#[test]
fn legacy_maps_are_read_when_the_current_fields_are_absent() {
    let state = AgentState::from_value(&json!({
        "builtInModelOverrides": { "Explore": "custom:e2e-upstream-alt:deepseek-v4-pro" },
        "builtInThoughtLevelOverrides": { "Explore": "high" },
        "pluginAgentModelOverrides": {
            "plugin:documents@nibi-official:visual-judge": "e2e-upstream-alt/deepseek-v4-pro$max"
        },
        "pluginAgentThoughtLevelOverrides": {
            "plugin:documents@nibi-official:visual-judge": "high"
        }
    }));
    assert_eq!(state.built_in["Explore"].provider, "e2e-upstream-alt");
    assert_eq!(state.built_in["Explore"].model, "deepseek-v4-pro");
    assert_eq!(state.built_in["Explore"].reasoning.as_deref(), Some("high"));
    let plugin = plugin_definition();
    let over = state.model_override(&plugin).expect("插件覆盖");
    assert_eq!(over.reasoning.as_deref(), Some("high"));
}

#[test]
fn disabled_ids_only_apply_to_user_agents() {
    let state = AgentState::from_value(&json!({
        "disabledAgentIds": ["user:user:helper", "  ", 7]
    }));
    assert_eq!(state.disabled.len(), 1);
    let user = crate::custom::parse(
        "---\nname: Helper\ndescription: Helps.\n---\nH.",
        AgentSource::User,
    )
    .expect("user agent");
    assert_eq!(user.state_id.as_deref(), Some("user:user:helper"));
    assert!(state.is_disabled(&user));
    let project = crate::custom::parse(
        "---\nname: Helper\ndescription: Helps.\n---\nH.",
        AgentSource::Project,
    )
    .expect("project agent");
    assert!(!state.is_disabled(&project));
    let plugin = plugin_definition();
    assert!(!state.is_disabled(&plugin));
}

#[test]
fn broken_json_means_no_configuration() {
    assert_eq!(AgentState::parse("{not json"), AgentState::default());
    assert_eq!(AgentState::parse("[]"), AgentState::default());
}

//! `agents-state.json`（Host 设置页写入）里内核用得到的部分：模型覆盖与用户 agent 的停用。
//!
//! 读取口径与 Node 的存储迁移一致（`packages/shared/src/subagent-state-migration.ts`）：
//!
//! - `builtInModelSelectionOverrides` / `pluginAgentModelSelectionOverrides` 在场时是唯一权威，
//!   空值或坏值都不能复活旧字段（Node `Object.hasOwn` 同一判据）；
//! - 两个字段不在场时才读旧双 map：`builtInModelOverrides` + `builtInThoughtLevelOverrides`、
//!   `pluginAgentModelOverrides` + `pluginAgentThoughtLevelOverrides`（Picker 串 + 档位）；
//! - `disabledAgentIds` 只拦用户级 Markdown agent（键 `user:user:<name 小写>`），插件/项目 agent 不受它控制。
//!
//! 文件本身由 Host 写入与迁移；内核只读，且每次取 agent 定义都重读（Node 每回合重读同一份）。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::definitions::{AgentDefinition, AgentSource};
use crate::selection::AgentModelSelection;

/// `agents-state.json` 的内核视图。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentState {
    /// 键是内置类型名（`general-purpose` / `Explore`）。
    pub built_in: BTreeMap<String, AgentModelSelection>,
    /// 键是 `plugin:<pluginId>:<agentName 小写>`（Node `createPluginAgentStateId`）。
    pub plugin: BTreeMap<String, AgentModelSelection>,
    /// `disabledAgentIds` 原文（过滤用户 agent 时按 `user:user:<name 小写>` 比对）。
    pub disabled: BTreeSet<String>,
}

impl AgentState {
    /// 解析一份 `agents-state.json`；坏 JSON 与坏字段都按“没有配置”处理，不拦派发。
    pub fn parse(raw: &str) -> Self {
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            return Self::default();
        };
        Self::from_value(&value)
    }

    pub fn from_value(value: &Value) -> Self {
        let Some(object) = value.as_object() else {
            return Self::default();
        };
        let built_in = if object.contains_key("builtInModelSelectionOverrides") {
            selections(field(object, "builtInModelSelectionOverrides"))
        } else {
            legacy_selections(
                field(object, "builtInModelOverrides"),
                field(object, "builtInThoughtLevelOverrides"),
            )
        };
        let plugin = if object.contains_key("pluginAgentModelSelectionOverrides") {
            selections(field(object, "pluginAgentModelSelectionOverrides"))
        } else {
            legacy_selections(
                field(object, "pluginAgentModelOverrides"),
                field(object, "pluginAgentThoughtLevelOverrides"),
            )
            .into_iter()
            .filter(|(id, _)| id.starts_with("plugin:"))
            .collect()
        };
        Self {
            built_in,
            plugin,
            disabled: object
                .get("disabledAgentIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    /// 这一项的设置页覆盖：内置按类型名，插件按状态键；用户/项目 agent 没有全局覆盖。
    pub fn model_override(&self, definition: &AgentDefinition) -> Option<&AgentModelSelection> {
        let id = definition.state_id.as_deref()?;
        match definition.source {
            AgentSource::BuiltIn => self.built_in.get(id),
            AgentSource::Plugin => self.plugin.get(id),
            AgentSource::User | AgentSource::Project => None,
        }
    }

    /// 用户级 Markdown agent 是否被设置页停用（`disabledAgentIds`）。
    pub fn is_disabled(&self, definition: &AgentDefinition) -> bool {
        definition.source == AgentSource::User
            && definition
                .state_id
                .as_deref()
                .is_some_and(|id| self.disabled.contains(id))
    }
}

fn field<'a>(object: &'a Map<String, Value>, key: &str) -> &'a Value {
    object.get(key).unwrap_or(&Value::Null)
}

/// 当前格式：`{providerId, modelId, options?: {reasoningLevel?}}`。
fn selections(value: &Value) -> BTreeMap<String, AgentModelSelection> {
    let Some(object) = value.as_object() else {
        return BTreeMap::new();
    };
    object
        .iter()
        .filter_map(|(id, selection)| {
            let selection = selection_from_value(selection)?;
            Some((id.trim().to_owned(), selection))
        })
        .filter(|(id, _)| !id.is_empty())
        .collect()
}

fn selection_from_value(value: &Value) -> Option<AgentModelSelection> {
    let record = value.as_object()?;
    let provider = record.get("providerId")?.as_str()?.trim();
    let model = record.get("modelId")?.as_str()?.trim();
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let reasoning = record
        .get("options")
        .and_then(Value::as_object)
        .and_then(|options| options.get("reasoningLevel"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|level| !level.is_empty())
        .map(str::to_owned);
    Some(AgentModelSelection {
        provider: provider.to_owned(),
        model: model.to_owned(),
        reasoning,
    })
}

/// 旧双 map：`{<id>: "<picker 串>"}` + `{<id>: "<档位>"}`；档位缺席时只按模型串解析。
fn legacy_selections(
    models: &Value,
    thought_levels: &Value,
) -> BTreeMap<String, AgentModelSelection> {
    let empty = Map::new();
    let models = models.as_object().unwrap_or(&empty);
    let levels = thought_levels.as_object().unwrap_or(&empty);
    models
        .iter()
        .filter_map(|(id, model)| {
            let model = model.as_str()?;
            let level = levels.get(id).and_then(Value::as_str);
            let selection = AgentModelSelection::parse(model, level)?;
            Some((id.trim().to_owned(), selection))
        })
        .filter(|(id, _)| !id.is_empty())
        .collect()
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;

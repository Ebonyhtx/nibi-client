//! Composer `@` 插件面板的身份目录（Node `buildPluginReferenceCatalog`，见 `docs/plugin-reference-mention.md`）。
//!
//! - 已加载的插件（enabled）与有 manifest 但没加载的候选（disabled）都进目录：停用条目支撑
//!   `disabled_in_session` 诊断，不可被引用。
//! - 冲突定义：同 manifest.name 的多个**启用**插件互相标记 `conflictingPluginIds`（V1 fail closed）；
//!   停用条目不参与冲突——runtime 名字空间里没有它。
//! - `skillQualifiedNames` / `subagentNames` / `mcpServerNames` 是「声明」的能力名，与 live 发现取交集后才注入；
//!   名字前缀都是 manifest name（skill/MCP/subagent 的 runtime 名字空间）。
//! - 展示字段（icon/displayName/description i18n）来自商店 listing，按稳定 ID join；它们只是展示投影，
//!   不改变 identifiers-only 契约。

use std::collections::{BTreeMap, BTreeSet};

use nibi_kernel_api::listing::{MarketplaceListing, PluginDisplay, PluginReference};

use super::{Plugin, Skipped};

/// Composer `@` 插件面板的两份数据：身份目录（含停用条目）与商店目录条目（含未安装的）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PluginCatalog {
    pub references: Vec<PluginReference>,
    pub listings: Vec<MarketplaceListing>,
}

/// 没加载（停用/被抑制/依赖 Node 运行时/会员门禁）的候选声明出来的组件名。
///
/// 与 [`Plugin`] 上的 `skill_names` / `agent_names` 同口径；加载失败的候选（manifest 缺失或非法）没有。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeclaredComponents {
    pub skill_names: Vec<String>,
    pub agent_names: Vec<String>,
}

impl DeclaredComponents {
    pub(crate) fn of(plugin: &Plugin) -> Self {
        Self {
            skill_names: plugin.skill_names.clone(),
            agent_names: plugin.agent_names.clone(),
        }
    }
}

/// `name:item` 形式的限定名，排序去重。
fn qualified(plugin: &str, names: &[String]) -> Vec<String> {
    names
        .iter()
        .map(|name| format!("{plugin}:{name}"))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// 目录里的一条（身份面 + 展示面）。`listing` 是商店目录按稳定 ID join 到的展示投影。
fn entry(
    plugin_id: &str,
    name: &str,
    marketplace: &str,
    enabled: bool,
    declared: DeclaredComponents,
    mcp_server_names: Vec<String>,
    root_path: &str,
    manifest_description: Option<&str>,
    listing: Option<&MarketplaceListing>,
) -> PluginReference {
    let description = manifest_description
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned);
    let display = match listing {
        Some(listing) => PluginDisplay {
            description,
            ..listing.display()
        },
        None => PluginDisplay {
            description,
            ..PluginDisplay::default()
        },
    };
    PluginReference {
        plugin_id: plugin_id.to_owned(),
        name: name.to_owned(),
        marketplace: marketplace.to_owned(),
        enabled,
        conflicting_plugin_ids: Vec::new(),
        skill_qualified_names: qualified(name, &declared.skill_names),
        mcp_server_names: mcp_server_names
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        subagent_names: qualified(name, &declared.agent_names),
        category: listing.and_then(|listing| listing.listing.category.clone()),
        display,
        root_path: root_path.to_owned(),
    }
}

/// 全部条目：先已加载的（enabled），再没加载但有 manifest 的候选（disabled）。
///
/// 条目按稳定 ID 去重（先加载的赢）；同 manifest name 的启用插件互相标记冲突。
pub(crate) fn catalog(
    plugins: &[Plugin],
    skipped: &[Skipped],
    listings: &[MarketplaceListing],
) -> Vec<PluginReference> {
    let by_id: BTreeMap<&str, &MarketplaceListing> = listings
        .iter()
        .map(|listing| (listing.plugin_id.as_str(), listing))
        .collect();
    // 同 manifest name 的启用插件（冲突判定）。
    let mut enabled_ids_by_name: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for plugin in plugins {
        enabled_ids_by_name
            .entry(plugin.name.as_str())
            .or_default()
            .push(plugin.id.as_str());
    }

    let mut entries: Vec<PluginReference> = Vec::with_capacity(plugins.len() + skipped.len());
    for plugin in plugins {
        let mut entry = entry(
            &plugin.id,
            &plugin.name,
            &plugin.marketplace,
            true,
            DeclaredComponents::of(plugin),
            plugin
                .mcp_servers
                .iter()
                .map(|server| server.name.clone())
                .collect(),
            &plugin.dir,
            plugin
                .manifest
                .get("description")
                .and_then(serde_json::Value::as_str),
            by_id.get(plugin.id.as_str()).copied(),
        );
        entry.conflicting_plugin_ids = enabled_ids_by_name
            .get(plugin.name.as_str())
            .map(|ids| {
                ids.iter()
                    .filter(|id| **id != plugin.id)
                    .map(|id| (*id).to_owned())
                    .collect()
            })
            .unwrap_or_default();
        entries.push(entry);
    }
    for skip in skipped {
        let Some(id) = skip.id.as_deref() else {
            continue;
        };
        let Some((name, marketplace)) = id.rsplit_once('@') else {
            continue;
        };
        if name.is_empty() || marketplace.is_empty() {
            continue;
        }
        if entries.iter().any(|entry| entry.plugin_id == id) {
            continue;
        }
        entries.push(entry(
            id,
            name,
            marketplace,
            false,
            skip.components.clone(),
            Vec::new(),
            &skip.dir,
            None,
            by_id.get(id).copied(),
        ));
    }
    entries
}

#[cfg(test)]
#[path = "reference_tests.rs"]
mod tests;

//! 商店目录的展示投影（`plugins/referenceCatalog` 的 icon/displayName/description 与
//! `plugins/resolveSuggestedReference` 的 listing）。
//!
//! 数据源与 Node 同一份本机存储：
//! - `marketplaces/nibi-official/bundled-marketplace.json` 的内置分片（`manifest.plugins`，随包播种）；
//! - `marketplaces/<marketplace>/marketplace.json` 的目录快照（Host 的插件管理落盘，本内核只读）。
//!
//! 只做展示：不读 `cachePath`、不下载、不写任何文件。条目按稳定 ID
//! （`<manifest.name>@<marketplace>`）去重，后读到的快照覆盖分片里的同名条目（远端比随包新）。

use std::collections::BTreeMap;
use std::path::Path;

use nibi_kernel_api::listing::{MarketplaceListing, PluginListing};
use nibi_kernel_paths::StoragePath;
use serde_json::{Map, Value};

use nibi_kernel_base::names::OFFICIAL_MARKETPLACE;

const BUNDLED_PARTITION: &str = "bundled-marketplace.json";
const MARKETPLACE_FILE: &str = "marketplace.json";
const MARKETPLACES_DIR: &str = "marketplaces";

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// `displayName_i18n` / `description_i18n` / `examplePrompts_i18n`：只有非空字符串项进入。
fn text_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for (locale, text) in value.and_then(Value::as_object).into_iter().flatten() {
        if let Some(text) = text
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            map.insert(locale.clone(), text.to_owned());
        }
    }
    map
}

fn text_list_map(value: Option<&Value>) -> BTreeMap<String, Vec<String>> {
    let mut map = BTreeMap::new();
    for (locale, list) in value.and_then(Value::as_object).into_iter().flatten() {
        let items: Vec<String> = list
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_owned)
            .collect();
        if !items.is_empty() {
            map.insert(locale.clone(), items);
        }
    }
    map
}

/// `author` 兼容字符串与 `{name, url}`（Node `normalizeAuthorValue`）。
fn author(value: Option<&Value>) -> (Option<String>, Option<String>) {
    match value {
        Some(Value::String(name)) => {
            let name = name.trim();
            ((!name.is_empty()).then(|| name.to_owned()), None)
        }
        Some(Value::Object(object)) => {
            let name = text(object, "name").map(str::to_owned);
            let url = text(object, "url").map(str::to_owned);
            (name, url)
        }
        _ => (None, None),
    }
}

/// 目录条目的展示投影；没有一条可用展示字段时返回 None（Node `parseEntryStoreListing`）。
fn listing(entry: &Map<String, Value>) -> Option<PluginListing> {
    let (author, author_url) = author(entry.get("author"));
    let listing = PluginListing {
        display_name: text(entry, "displayName").map(str::to_owned),
        display_name_i18n: text_map(entry.get("displayName_i18n")),
        description_i18n: text_map(entry.get("description_i18n")),
        icon: text(entry, "icon").map(str::to_owned),
        category: text(entry, "category").map(str::to_owned),
        publisher_type: match text(entry, "publisherType") {
            Some("official") => Some("official".to_owned()),
            Some("community") => Some("community".to_owned()),
            _ => None,
        },
        author,
        author_url,
        homepage: text(entry, "homepage").map(str::to_owned),
        privacy_policy: text(entry, "privacyPolicy").map(str::to_owned),
        terms_of_service: text(entry, "termsOfService").map(str::to_owned),
        hero_image: text(entry, "heroImage").map(str::to_owned),
        example_prompts: entry
            .get("examplePrompts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_owned)
            .collect(),
        example_prompts_i18n: text_list_map(entry.get("examplePrompts_i18n")),
        requires_paid_plan: entry.get("requiresPaidPlan").and_then(Value::as_bool) == Some(true),
    };
    if listing == PluginListing::default() {
        None
    } else {
        Some(listing)
    }
}

/// 一份目录清单（`{plugins: [...]}`）里的条目；`marketplace` 是这份清单的 id。
pub fn entries(manifest: &Value, marketplace: &str) -> Vec<MarketplaceListing> {
    manifest
        .get("plugins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|entry| {
            let name = text(entry, "name")?;
            Some(MarketplaceListing {
                plugin_id: format!("{name}@{marketplace}"),
                plugin_name: name.to_owned(),
                marketplace: marketplace.to_owned(),
                listing: listing(entry)?,
            })
        })
        .collect()
}

async fn read_json(path: &Path) -> Option<Value> {
    let bytes = nibi_kernel_fs::read_optional(path).await.ok().flatten()?;
    serde_json::from_slice(&bytes).ok()
}

/// 同一稳定 ID 再次出现时合并两条 listing：新条目里有值的字段覆盖，空字段保留原值
/// （快照里常见的「只写图标」条目不会把内置分片的显示名/分类抹掉）。
fn merge(base: &mut PluginListing, other: PluginListing) {
    let fill = |target: &mut Option<String>, source: Option<String>| {
        if source.is_some() {
            *target = source;
        }
    };
    fill(&mut base.display_name, other.display_name);
    fill(&mut base.icon, other.icon);
    fill(&mut base.category, other.category);
    fill(&mut base.publisher_type, other.publisher_type);
    fill(&mut base.author, other.author);
    fill(&mut base.author_url, other.author_url);
    fill(&mut base.homepage, other.homepage);
    fill(&mut base.privacy_policy, other.privacy_policy);
    fill(&mut base.terms_of_service, other.terms_of_service);
    fill(&mut base.hero_image, other.hero_image);
    if !other.display_name_i18n.is_empty() {
        base.display_name_i18n = other.display_name_i18n;
    }
    if !other.description_i18n.is_empty() {
        base.description_i18n = other.description_i18n;
    }
    if !other.example_prompts.is_empty() {
        base.example_prompts = other.example_prompts;
    }
    if !other.example_prompts_i18n.is_empty() {
        base.example_prompts_i18n = other.example_prompts_i18n;
    }
    base.requires_paid_plan |= other.requires_paid_plan;
}

/// 本机存储里的商店条目：内置分片 + 各 marketplace 的目录快照，按稳定 ID 合并（后读到的覆盖同名键）。
pub async fn listings(root: &StoragePath) -> Vec<MarketplaceListing> {
    let mut found: Vec<MarketplaceListing> = Vec::new();
    let mut index: BTreeMap<String, usize> = BTreeMap::new();
    let mut push = |entry: MarketplaceListing| match index.get(&entry.plugin_id) {
        Some(at) => merge(&mut found[*at].listing, entry.listing),
        None => {
            index.insert(entry.plugin_id.clone(), found.len());
            found.push(entry);
        }
    };

    let marketplaces = root.as_path().join(MARKETPLACES_DIR);
    let bundled = marketplaces
        .join(OFFICIAL_MARKETPLACE)
        .join(BUNDLED_PARTITION);
    if let Some(partition) = read_json(&bundled).await
        && partition.get("version").and_then(Value::as_u64) == Some(1)
        && let Some(manifest) = partition.get("manifest")
    {
        for entry in entries(manifest, OFFICIAL_MARKETPLACE) {
            push(entry);
        }
    }

    let mut ids = match nibi_kernel_fs::subdirectories(&marketplaces).await {
        Ok(ids) => ids,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            tracing::warn!(dir = %marketplaces.display(), %error, "plugin marketplaces could not be scanned");
            Vec::new()
        }
    };
    ids.sort();
    for id in ids {
        let path = marketplaces.join(&id).join(MARKETPLACE_FILE);
        let Some(manifest) = read_json(&path).await else {
            continue;
        };
        for entry in entries(&manifest, &id) {
            push(entry);
        }
    }
    found
}

#[cfg(test)]
#[path = "plugin_marketplace_tests.rs"]
mod tests;

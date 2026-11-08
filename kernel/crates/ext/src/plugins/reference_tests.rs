//! Composer `@` 插件面板的身份目录：身份、冲突、停用条目与商店展示的 join。

use serde_json::json;

use super::*;
use nibi_kernel_api::listing::{MarketplaceListing, PluginListing};

use super::super::{Plugin, SkipReason, Skipped};

fn plugin(name: &str, marketplace: &str) -> Plugin {
    Plugin {
        id: format!("{name}@{marketplace}"),
        name: name.to_owned(),
        marketplace: marketplace.to_owned(),
        dir: format!("/plugins/{name}"),
        manifest: json!({"description": format!("{name} description")}),
        skill_dirs: Vec::new(),
        skill_names: Vec::new(),
        agent_names: Vec::new(),
        mcp_servers: Vec::new(),
        agent_files: Vec::new(),
        hooks: Vec::new(),
    }
}

fn listing(name: &str, marketplace: &str) -> MarketplaceListing {
    MarketplaceListing {
        plugin_id: format!("{name}@{marketplace}"),
        plugin_name: name.to_owned(),
        marketplace: marketplace.to_owned(),
        listing: PluginListing {
            display_name: Some(format!("{name} display")),
            icon: Some(format!("https://cdn.example/{name}.png")),
            category: Some("productivity".to_owned()),
            description_i18n: [("zh-CN".to_owned(), "描述".to_owned())].into(),
            ..PluginListing::default()
        },
    }
}

#[test]
fn entries_carry_identity_and_declared_names() {
    let mut loaded = plugin("pdf", "nibi-official");
    loaded.skill_names = vec!["extract".to_owned(), "convert".to_owned()];
    loaded.agent_names = vec!["reader".to_owned()];
    let catalog = catalog(&[loaded], &[], &[listing("pdf", "nibi-official")]);
    assert_eq!(catalog.len(), 1);
    let entry = &catalog[0];
    assert_eq!(entry.plugin_id, "pdf@nibi-official");
    assert!(entry.enabled);
    assert_eq!(
        entry.skill_qualified_names,
        ["pdf:convert".to_owned(), "pdf:extract".to_owned()]
    );
    assert_eq!(entry.subagent_names, ["pdf:reader".to_owned()]);
    assert_eq!(entry.root_path, "/plugins/pdf");
    // 身份目录的描述来自插件 manifest，展示字段来自商店 listing。
    assert_eq!(
        entry.display.description.as_deref(),
        Some("pdf description")
    );
    assert_eq!(entry.display.display_name.as_deref(), Some("pdf display"));
    assert_eq!(
        entry.display.icon.as_deref(),
        Some("https://cdn.example/pdf.png")
    );
    assert_eq!(entry.category.as_deref(), Some("productivity"));
}

#[test]
fn conflicts_mark_every_enabled_plugin_sharing_the_manifest_name() {
    let official = plugin("kit", "nibi-official");
    let custom = plugin("kit", "my-market");
    let catalog = catalog(&[official, custom], &[], &[]);
    assert_eq!(catalog.len(), 2);
    assert_eq!(catalog[0].conflicting_plugin_ids, ["kit@my-market"]);
    assert_eq!(catalog[1].conflicting_plugin_ids, ["kit@nibi-official"]);
}

#[test]
fn disabled_candidates_stay_in_the_catalog_without_conflicts() {
    let loaded = plugin("kit", "nibi-official");
    let disabled = Skipped {
        dir: "/plugins/kit2".to_owned(),
        id: Some("kit2@nibi-official".to_owned()),
        components: DeclaredComponents {
            skill_names: vec!["run".to_owned()],
            agent_names: vec!["helper".to_owned()],
        },
        reason: SkipReason::Disabled,
    };
    let catalog = catalog(&[loaded], &[disabled], &[listing("kit2", "nibi-official")]);
    assert_eq!(catalog.len(), 2);
    let entry = &catalog[1];
    assert!(!entry.enabled);
    assert!(entry.conflicting_plugin_ids.is_empty());
    assert_eq!(entry.skill_qualified_names, ["kit2:run".to_owned()]);
    assert_eq!(entry.subagent_names, ["kit2:helper".to_owned()]);
    // 停用的插件也能显示商店里的图标与显示名（Node 同口径）。
    assert_eq!(
        entry.display.icon.as_deref(),
        Some("https://cdn.example/kit2.png")
    );
}

#[test]
fn skipped_candidates_without_an_id_or_with_a_duplicate_are_not_listed_twice() {
    let loaded = plugin("kit", "nibi-official");
    let no_manifest = Skipped {
        dir: "/plugins/broken".to_owned(),
        id: None,
        components: DeclaredComponents::default(),
        reason: SkipReason::ManifestMissing,
    };
    let duplicate = Skipped {
        dir: "/plugins/kit".to_owned(),
        id: Some("kit@nibi-official".to_owned()),
        components: DeclaredComponents::default(),
        reason: SkipReason::DuplicateId,
    };
    let catalog = catalog(&[loaded], &[no_manifest, duplicate], &[]);
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].plugin_id, "kit@nibi-official");
}

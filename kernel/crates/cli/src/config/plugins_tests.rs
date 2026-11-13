//! `plugins` 段、插件存储根与插件候选（config.md §2.1、ext.md §4.1）。
#![allow(clippy::disallowed_methods, reason = "测试准备临时目录里的插件清单")]

use nibi_kernel_ext::plugins::PluginOrigin;
use nibi_kernel_api::permission::RuleSource;
use nibi_kernel_paths::StoragePaths;
use serde_json::{Map, Value, json};

use super::*;

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

fn layers<'a>(user: &'a Map<String, Value>, projects: &'a [Map<String, Value>]) -> Vec<Layer<'a>> {
    std::iter::once(Layer {
        source: RuleSource::UserSettings,
        object: user,
        path: "user",
    })
    .chain(projects.iter().map(|object| Layer {
        source: RuleSource::ProjectSettings,
        object,
        path: "project",
    }))
    .collect()
}

/// 期望值按 `resolve_dir` 的规则算：本机 `Path::join` + `nibi_kernel_base::path::normalize`
/// （Node 的 `path.resolve` 也是本机写法，Windows 上是 `C:\…`，POSIX 上是 `/…`）。
fn resolved(parts: &[&str]) -> String {
    let mut path = std::path::PathBuf::from(parts[0]);
    for part in &parts[1..] {
        path.push(part);
    }
    nibi_kernel_base::path::normalize(&path)
        .to_string_lossy()
        .into_owned()
}

#[test]
fn the_plugins_section_merges_like_node() {
    let user = object(json!({"plugins": {
        "dirs": ["/Users/dev/a", "rel"],
        "enabledPlugins": {"x@m": true, "y@m": true},
        "suppressedBuiltins": ["s1@nibi-official"],
        "extraKnownMarketplaces": {"team": {"source": {"source": "github", "repo": "example/plugins"}}},
        "options": {"x@m": {"key": "value"}}
    }}));
    let projects = [
        object(json!({"plugins": {
            "dirs": ["rel", "/Users/dev/b"],
            "enabledPlugins": {"y@m": false},
            "options": {"x@m": {"key": "override", "second": 2}}
        }})),
        object(json!({"plugins": {"suppressedBuiltins": ["s2@nibi-official"]}})),
    ];
    let mut warnings = Vec::new();
    let merged = merge(&layers(&user, &projects), &mut warnings);
    assert!(warnings.is_empty(), "{warnings:?}");
    assert!(merged.enabled);
    // `dirs` 拼接去重；`enabledPlugins` 按 id 覆盖；`suppressedBuiltins` 由最后写它的层整体替换。
    assert_eq!(merged.dirs, ["/Users/dev/a", "rel", "/Users/dev/b"]);
    assert_eq!(
        merged.enabled_plugins.into_iter().collect::<Vec<_>>(),
        [("x@m".to_owned(), true), ("y@m".to_owned(), false)]
    );
    assert_eq!(merged.suppressed_builtins, ["s2@nibi-official"]);
    // `options` 按插件 id + 选项键合并（Node `mergePluginOptions`）：同键后者覆盖，未提到的键保留。
    let options: Vec<(String, Vec<(String, serde_json::Value)>)> = merged
        .options
        .into_iter()
        .map(|(id, values)| (id, values.into_iter().collect()))
        .collect();
    assert_eq!(
        options,
        [(
            "x@m".to_owned(),
            vec![
                ("key".to_owned(), serde_json::json!("override")),
                ("second".to_owned(), serde_json::json!(2)),
            ]
        )]
    );

    let off = [object(json!({"plugins": {"enabled": false}}))];
    let merged = merge(&layers(&user, &off), &mut warnings);
    assert!(!merged.enabled);
}

#[test]
fn bad_plugin_items_are_skipped_with_warnings() {
    let user = object(json!({"plugins": "all"}));
    let projects = [object(json!({"plugins": {
        "enabled": "yes",
        "dirs": ["ok", "", 3],
        "enabledPlugins": {"a@m": true, "b@m": "no"},
        "suppressedBuiltins": "s"
    }}))];
    let mut warnings = Vec::new();
    let merged = merge(&layers(&user, &projects), &mut warnings);
    assert!(merged.enabled);
    assert_eq!(merged.dirs, ["ok"]);
    assert_eq!(
        merged.enabled_plugins.into_iter().collect::<Vec<_>>(),
        [("a@m".to_owned(), true)]
    );
    assert!(merged.suppressed_builtins.is_empty());
    assert_eq!(warnings.len(), 6, "{warnings:?}");
    assert!(warnings[0].starts_with("user: plugins must be an object"));
}

#[tokio::test]
async fn candidates_follow_the_node_order() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let root = StoragePaths::resolve(&Default::default(), home, home).plugin_storage(None, home);
    let guide = root
        .as_path()
        .join("cache")
        .join("nibi-official")
        .join("nibi-guide")
        .join("0.3.0");
    let partition = root
        .as_path()
        .join("marketplaces/nibi-official/bundled-marketplace.json");
    std::fs::create_dir_all(partition.parent().unwrap()).unwrap();
    std::fs::write(
        &partition,
        json!({"version": 1, "manifest": {"plugins": [
            {"name": "nibi-guide", "cachePath": guide.to_string_lossy()}
        ]}})
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        root.as_path().join("installed_plugins.json"),
        json!({"version": 1, "plugins": [{
            "id": "kit@market", "name": "kit", "marketplace": "market", "version": "1.0.0",
            "installPath": "/Users/dev/kit", "installedAt": "2026-10-01T00:00:00.000Z", "scope": "user"
        }]})
        .to_string(),
    )
    .unwrap();
    let abs = dir.path().join("abs").to_string_lossy().into_owned();
    let repo = dir.path().join("repo").to_string_lossy().into_owned();
    let section = PluginSection {
        enabled: true,
        dirs: vec![abs.clone(), "rel/kit".to_owned()],
        enabled_plugins: [("kit@market".to_owned(), true)].into_iter().collect(),
        suppressed_builtins: vec!["nibi-guide@nibi-official".to_owned()],
        options: Default::default(),
    };
    let sources = sources(section.clone(), &repo, &root, None, &[]).await;
    let candidates: Vec<(String, &str, PluginOrigin)> = sources
        .candidates
        .iter()
        .map(|c| (c.dir.as_str().to_owned(), c.marketplace.as_str(), c.origin))
        .collect();
    assert_eq!(
        candidates,
        [
            (abs, "inline", PluginOrigin::ConfigDir),
            (
                resolved(&[&repo, "rel", "kit"]),
                "inline",
                PluginOrigin::ConfigDir
            ),
            (
                guide.to_string_lossy().into_owned(),
                "nibi-official",
                PluginOrigin::Official
            ),
            (
                "/Users/dev/kit".to_owned(),
                "market",
                PluginOrigin::Installed
            ),
        ]
    );
    assert_eq!(sources.enabled_plugins, section.enabled_plugins);
    assert_eq!(sources.suppressed_builtins, section.suppressed_builtins);

    // `plugins.enabled: false`：配置目录、内置与已安装插件都不加载。
    let off = PluginSection {
        enabled: false,
        ..section
    };
    assert!(sources_of(off, &root).await.candidates.is_empty());
}

async fn sources_of(
    section: PluginSection,
    root: &nibi_kernel_paths::StoragePath,
) -> nibi_kernel_ext::plugins::PluginSources {
    sources(section, "/Users/dev/repo", root, None, &[]).await
}

#[test]
fn config_dirs_resolve_like_node_path_resolve() {
    // 绝对路径原样；相对路径相对工作区根，`.` 与 `..` 按字面化简；不展开 `~`（Node `resolve`）。
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().to_string_lossy().into_owned();
    let repo = dir.path().join("repo").to_string_lossy().into_owned();
    let absolute = dir.path().join("kit").to_string_lossy().into_owned();
    assert_eq!(resolve_dir(&repo, &absolute), absolute);
    assert_eq!(resolve_dir(&repo, "./kit"), resolved(&[&repo, "kit"]));
    assert_eq!(resolve_dir(&repo, "../kit/"), resolved(&[&base, "kit"]));
    assert_eq!(
        resolve_dir(&repo, "~/kit"),
        resolved(&[&repo, "~", "kit"])
    );
}

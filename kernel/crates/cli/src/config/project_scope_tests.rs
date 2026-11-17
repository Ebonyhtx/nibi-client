//! 项目配置白名单（PROJECT-CONFIG）的投影与跨语言清单一致性。
use serde_json::{Map, Value, json};

use super::*;

const ROOT: &str = "/Users/dev/repo";
const BASE: &str = "/Users/dev/repo";

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

fn scope(value: Value) -> (Map<String, Value>, Vec<String>) {
    project_scope(&object(value), BASE, ROOT)
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

/// canonical artifact：Node 与 Rust 都从这里取清单，两边各有一个 mirror。
#[test]
fn the_shared_policy_artifact_matches_the_kernel_mirror() {
    let raw =
        include_str!("../../../../../packages/shared/src/kernel-contract/project-config.keys.json");
    let value: Value = serde_json::from_str(raw).expect("valid project config policy JSON");
    assert_eq!(
        strings(&value["allowedTopLevelKeys"]),
        PROJECT_CONFIG_POLICY.allowed_top_level
    );
    assert_eq!(
        strings(&value["ignoredTopLevelKeys"]),
        PROJECT_CONFIG_POLICY.ignored_top_level
    );
    assert_eq!(
        strings(&value["allowedPluginKeys"]),
        PROJECT_CONFIG_POLICY.allowed_plugin
    );
    assert_eq!(
        strings(&value["ignoredPluginKeys"]),
        PROJECT_CONFIG_POLICY.ignored_plugin
    );
}

#[test]
fn the_scope_keeps_only_project_declarations() {
    let (scoped, ignored) = scope(json!({
        "hooks": {"enabled": true},
        "mcp": {"servers": {"repo": {"command": "node"}}},
        "plugins": {
            "enabledPlugins": {"off@x": false, "evil@x": true},
            "options": {"off@x": {"token": "x"}},
            "dirs": ["plugins/local", "/Users/dev/repo/plugins/absolute", "/tmp/evil", "../outside"],
            "extraKnownMarketplaces": {"evil": {"source": {"source": "file", "path": "/tmp"}}}
        },
        "permission": {"mode": "yolo", "allowedTools": ["Bash(rm:*)"]},
        "storage": {"dir": "/tmp/evil", "sessionDbPath": "/tmp/evil.sqlite"},
        "ui": {"locale": "zh-CN"}
    }));
    assert!(scoped.contains_key("hooks"));
    assert!(scoped.contains_key("mcp"));
    let plugins = scoped["plugins"].as_object().expect("plugins object");
    assert_eq!(
        plugins["enabledPlugins"]
            .as_object()
            .expect("enabledPlugins")
            .iter()
            .map(|(id, enabled)| (id.as_str(), enabled.as_bool()))
            .collect::<Vec<_>>(),
        [("off@x", Some(false))]
    );
    assert_eq!(plugins["options"]["off@x"]["token"].as_str(), Some("x"));
    // 工作区内的 dir 解析成绝对路径后保留；越界项（外部路径与 `..` 逃逸）丢弃。
    assert_eq!(
        strings(&plugins["dirs"]),
        [
            "/Users/dev/repo/plugins/local",
            "/Users/dev/repo/plugins/absolute"
        ]
    );
    assert!(!plugins.contains_key("extraKnownMarketplaces"));
    assert!(!scoped.contains_key("permission"));
    assert!(!scoped.contains_key("storage"));
    assert!(!scoped.contains_key("ui"));
    assert_eq!(
        ignored,
        [
            "plugins.enabledPlugins.evil@x",
            "plugins.dirs[2]",
            "plugins.dirs[3]",
            "plugins.extraKnownMarketplaces",
            "permission.mode",
            "permission.allowedTools",
            "storage.dir",
            "storage.sessionDbPath",
            "ui.locale",
        ]
    );
}

/// 相对 dir 按项目配置的 baseDir 解析（`.nibi/config.json` 的上一层，不是文件所在目录）。
#[test]
fn plugin_dirs_resolve_against_the_project_config_base_dir() {
    let (scoped, ignored) = project_scope(
        &object(json!({"plugins": {"dirs": ["plugins/kit"]}})),
        "/Users/dev/repo/packages/app",
        ROOT,
    );
    assert_eq!(
        strings(&scoped["plugins"]["dirs"]),
        ["/Users/dev/repo/packages/app/plugins/kit"]
    );
    assert!(ignored.is_empty());
}

#[test]
fn plugin_dirs_outside_the_discovery_root_are_dropped_with_indexes() {
    let (scoped, ignored) = scope(json!({
        "plugins": {"dirs": [
            "/Users/dev/repo/plugins/ok",
            "/Users/dev/elsewhere",
            "../outside",
            "/tmp/evil"
        ]}
    }));
    assert_eq!(
        strings(&scoped["plugins"]["dirs"]),
        ["/Users/dev/repo/plugins/ok"]
    );
    assert_eq!(
        ignored,
        ["plugins.dirs[1]", "plugins.dirs[2]", "plugins.dirs[3]"]
    );
}

#[test]
fn a_sibling_directory_with_the_same_prefix_is_not_inside_the_root() {
    let (scoped, ignored) = scope(json!({
        "plugins": {"dirs": ["/Users/dev/repository/plugins"]}
    }));
    assert!(
        scoped["plugins"]["dirs"]
            .as_array()
            .is_some_and(Vec::is_empty)
    );
    assert_eq!(ignored, ["plugins.dirs[0]"]);
}

/// 词法路径在工作区内、realpath 在工作区外的符号链接必须被丢弃。
#[cfg(unix)]
#[test]
fn a_symlinked_plugin_dir_resolving_outside_the_root_is_dropped() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    let nested = root.join("packages/app");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(nested.join(".nibi")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    symlink(&outside, nested.join("plugins")).unwrap();

    let (scoped, ignored) = project_scope(
        &object(json!({"plugins": {"dirs": ["plugins"]}})),
        &nested.to_string_lossy(),
        &root.to_string_lossy(),
    );
    assert!(
        scoped["plugins"]["dirs"]
            .as_array()
            .is_some_and(Vec::is_empty)
    );
    assert_eq!(ignored, ["plugins.dirs[0]"]);
}

#[test]
fn unknown_keys_are_dropped_and_empty_objects_report_the_section() {
    let (scoped, ignored) = scope(json!({
        "futureFeature": {"nested": true},
        "emptySection": {},
        "$schema": "https://example.test/nibi.json"
    }));
    assert!(scoped.is_empty());
    assert_eq!(ignored, ["futureFeature.nested", "emptySection", "$schema"]);
}

#[test]
fn enabled_plugins_with_a_non_boolean_value_are_left_for_the_merge_warning() {
    let (scoped, ignored) = scope(json!({
        "plugins": {"enabledPlugins": {"a@x": true, "b@x": "no"}}
    }));
    assert_eq!(
        scoped["plugins"]["enabledPlugins"]
            .as_object()
            .expect("enabledPlugins")
            .iter()
            .map(|(id, enabled)| (id.as_str(), enabled.as_bool()))
            .collect::<Vec<_>>(),
        [("b@x", None)]
    );
    assert_eq!(ignored, ["plugins.enabledPlugins.a@x"]);
}

#[test]
fn a_non_object_plugins_section_is_left_for_the_merge_warning() {
    let (scoped, ignored) = scope(json!({"plugins": "all"}));
    assert_eq!(scoped, object(json!({"plugins": "all"})));
    assert!(ignored.is_empty());
}

#[test]
fn an_empty_enabled_plugins_object_is_kept() {
    let (scoped, ignored) = scope(json!({
        "plugins": {"enabledPlugins": {}}
    }));
    assert_eq!(
        scoped["plugins"]["enabledPlugins"],
        Value::Object(Map::new())
    );
    assert!(ignored.is_empty());
}

/// 非数组/坏项留给 `plugins::merge` 记原有警告，不在这里误报。
#[test]
fn malformed_dirs_are_left_for_the_merge_warning() {
    let (scoped, ignored) = scope(json!({
        "plugins": {"dirs": ["plugins/local", 3, ""]}
    }));
    assert_eq!(
        scoped["plugins"]["dirs"],
        json!(["/Users/dev/repo/plugins/local", 3, ""])
    );
    assert!(ignored.is_empty());
}

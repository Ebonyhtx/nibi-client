//! 项目级配置的白名单投影（PROJECT-CONFIG，docs/specs/rust-cli/config.md §1.1）。
//!
//! 项目文件来自工作区，属于不可信输入：只放行已经存在独立信任门禁、且只是声明的能力——`hooks`
//! （工作区 Hook 信任）、`mcp`（工作区 MCP 信任）与 `plugins.dirs` / `plugins.enabledPlugins` /
//! `plugins.options`。`plugins.dirs` 解析后必须落在工作区根之内；权限、存储、网络、模型流、功能
//! 开关、skills/commands、日志、UI 等键全部剔除；以后新增的键缺省不向项目开放。投影发生在把项目
//! 文件构造为配置层的边界，之后的合并、hooks/MCP 信任与插件解析都只看到白名单内的声明。
//!
//! 清单的 canonical 版本是 `packages/shared/src/kernel-contract/project-config.keys.json`（Node 与
//! Rust 共用）；本文件的 [`PROJECT_CONFIG_POLICY`] 是 Rust mirror，一致性由测试用 `include_str!`
//! 核对。

use nibi_kernel_api::env_files::PathStyle;
use serde_json::{Map, Value};

/// 项目配置白名单（canonical JSON 的 Rust mirror）。
pub(crate) struct ProjectConfigPolicy {
    pub(crate) allowed_top_level: &'static [&'static str],
    pub(crate) ignored_top_level: &'static [&'static str],
    pub(crate) allowed_plugin: &'static [&'static str],
    pub(crate) ignored_plugin: &'static [&'static str],
}

/// 与 `packages/shared/src/kernel-contract/project-config.keys.json` 同步；测试会核对。
pub(crate) const PROJECT_CONFIG_POLICY: ProjectConfigPolicy = ProjectConfigPolicy {
    allowed_top_level: &["hooks", "mcp", "plugins"],
    ignored_top_level: &[
        "$schema",
        "askUserQuestionTimeout",
        "checkForUpdateOnStartup",
        "command",
        "commandOverrides",
        "features",
        "logging",
        "memory",
        "modelAnomalyGuard",
        "modelStream",
        "network",
        "permission",
        "skill",
        "skillOverrides",
        "skills",
        "storage",
        "toolConcurrency",
        "ui",
    ],
    allowed_plugin: &["dirs", "enabledPlugins", "options"],
    ignored_plugin: &["enabled", "extraKnownMarketplaces", "suppressedBuiltins"],
};

/// 被剔除的键路径。对象递归到叶子（`permission.mode`、`storage.dir`），数组与标量算一个键。
fn ignored_paths(key: &str, value: &Value) -> Vec<String> {
    match value {
        Value::Object(object) if !object.is_empty() => object
            .iter()
            .flat_map(|(child, value)| ignored_paths(&format!("{key}.{child}"), value))
            .collect(),
        _ => vec![key.to_owned()],
    }
}

/// 项目配置文件的 baseDir（Node `getProjectConfigBaseDir`）：`.nibi/config.json` 取 `.nibi` 的上一层，
/// 其余取文件所在目录。相对 `plugins.dirs` 按它解析。
pub(crate) fn project_base_dir(workspace_root: &str, path: &str) -> String {
    let style = PathStyle::infer(workspace_root);
    let parent = style.dirname(path);
    if style.file_name(&parent) == nibi_kernel_base::names::PROJECT_DOT_DIR {
        style.dirname(&parent)
    } else {
        parent
    }
}

/// `plugins.dirs`：每项按项目配置的 baseDir 解析，只有落在工作区根 `workspace_root` 之内才保留；
/// 越界项丢弃并返回精确下标。非字符串/空串留给 `plugins::merge` 记它自己的警告。
///
/// 存在时再取 canonicalize：仓库里放一个指向工作区外的符号链接可以绕过纯词法的前缀检查。
/// 目录不存在时无法加载插件，词法检查足够；存在时把解析后的真实路径交给插件发现。
fn scope_plugin_dirs(value: &Value, base_dir: &str, workspace_root: &str) -> (Value, Vec<String>) {
    let Some(items) = value.as_array() else {
        return (value.clone(), Vec::new());
    };
    let style = PathStyle::infer(workspace_root);
    let canonical_workspace_root = canonicalize_existing_path(workspace_root);
    let mut kept = Vec::with_capacity(items.len());
    let mut ignored = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(dir) = item.as_str().filter(|dir| !dir.is_empty()) else {
            kept.push(item.clone());
            continue;
        };
        let resolved = if style.is_absolute(dir) {
            style.normalize(dir)
        } else {
            style.resolve(base_dir, dir, None)
        };
        let canonical = canonicalize_existing_path(&resolved);
        if style.is_within(&canonical, &canonical_workspace_root) {
            kept.push(Value::String(canonical));
        } else {
            ignored.push(format!("plugins.dirs[{index}]"));
        }
    }
    (Value::Array(kept), ignored)
}

/// 路径存在时取 canonicalize（解开符号链接）；不存在或读取失败时退回词法路径。
/// Windows 的 canonicalize 带 `\\?\` 前缀，`PathStyle` 的 normalize 不认它，必须剥掉。
fn canonicalize_existing_path(path: &str) -> String {
    match std::fs::canonicalize(path) {
        Ok(canonical) => strip_windows_verbatim_prefix(&canonical.to_string_lossy()),
        Err(_) => path.to_owned(),
    }
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        path.to_owned()
    }
}

/// `plugins.enabledPlugins`：项目层只允许 `false`（禁用）；`true` 丢弃并返回精确路径。
/// 非布尔值原样留下，由 `plugins::merge` 记它自己的类型警告。
fn scope_enabled_plugins(value: &Value) -> (Value, Vec<String>) {
    let Some(table) = value.as_object() else {
        return (value.clone(), Vec::new());
    };
    let mut kept = Map::new();
    let mut ignored = Vec::new();
    for (id, flag) in table {
        match flag.as_bool() {
            Some(false) => {
                kept.insert(id.clone(), Value::Bool(false));
            }
            Some(true) => ignored.push(format!("plugins.enabledPlugins.{id}")),
            None => {
                kept.insert(id.clone(), flag.clone());
            }
        }
    }
    (Value::Object(kept), ignored)
}

/// 项目文件 → 只读扩展声明：返回投影后的对象与被剔除的键（`plugins` 下写成 `plugins.<键>`）。
/// 未知键也剔除（allowlist），[`PROJECT_CONFIG_POLICY`] 的 ignored 清单只用于文档与一致性测试。
/// `plugins.dirs` 的越界项写成 `plugins.dirs[<下标>]`。
pub(crate) fn project_scope(
    object: &Map<String, Value>,
    base_dir: &str,
    workspace_root: &str,
) -> (Map<String, Value>, Vec<String>) {
    let mut kept = Map::new();
    let mut ignored = Vec::new();
    for (key, value) in object {
        if key == "plugins" {
            let Value::Object(plugins) = value else {
                // 不是对象时留给 `plugins::merge` 记 "plugins must be an object"。
                kept.insert(key.clone(), value.clone());
                continue;
            };
            let mut scoped = Map::new();
            for (plugin_key, plugin_value) in plugins {
                if plugin_key == "dirs" {
                    let (value, dropped) =
                        scope_plugin_dirs(plugin_value, base_dir, workspace_root);
                    scoped.insert(plugin_key.clone(), value);
                    ignored.extend(dropped);
                } else if plugin_key == "enabledPlugins" {
                    let (value, dropped) = scope_enabled_plugins(plugin_value);
                    scoped.insert(plugin_key.clone(), value);
                    ignored.extend(dropped);
                } else if PROJECT_CONFIG_POLICY
                    .allowed_plugin
                    .contains(&plugin_key.as_str())
                {
                    scoped.insert(plugin_key.clone(), plugin_value.clone());
                } else {
                    ignored.push(format!("plugins.{plugin_key}"));
                }
            }
            kept.insert(key.clone(), Value::Object(scoped));
        } else if PROJECT_CONFIG_POLICY
            .allowed_top_level
            .contains(&key.as_str())
        {
            kept.insert(key.clone(), value.clone());
        } else {
            ignored.extend(ignored_paths(key, value));
        }
    }
    (kept, ignored)
}

#[cfg(test)]
#[path = "project_scope_tests.rs"]
mod tests;

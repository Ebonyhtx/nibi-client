//! PermissionRequest 放行时的 `updatedPermissions`（docs/specs/rust-cli/permission-updates.md §2.2、§2.4）：逐项校验，
//! 换成本工程的权限更新（对齐上游 ZCode-rs 0.1.88）。
//!
//! 每一项单独校验，坏的那一项丢掉、记一条日志，别的项照用：类型、behavior、destination 不认识；规则类的 `rules` 不是数组；
//! 放宽的更新（add / replace 的 allow，remove 的 deny / ask）里有一条规则形状不对或写回再读变了，整项丢掉；收紧的更新逐条
//! 跳过形状不对的规则，全不对时整项丢掉；`addDirectories` 有一项不是去空白后非空、不含 NUL 的字符串，整项丢掉；`setMode`
//! 的模式不认识或是完全访问。destination 只决定去处：只在内存的进会话层，三种设置文件都落在本机（项目与用户的配置文件
//! 不写，§7）。
//!
//! 安全：hook 的任意 JSON 不当规则直接执行——只有这里校验过的项才成为 [`PermissionUpdate`]；全部丢掉时没有更新，
//! 不会放宽任何权限。子代理里的 hook 更新落在子代理的会话上（`Session`），不会改父会话。

use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::permission::syntax::{format_rule, parse_rule};
use nibi_kernel_api::permission::{PermissionMode, PermissionRule, RuleBehavior};
use nibi_kernel_api::permission_updates::{PermissionUpdate, UpdatePlace};
use serde_json::Value;

/// 只在内存的 destination：都进会话层。
const IN_MEMORY: [&str; 8] = [
    "session",
    "cliArg",
    "command",
    "flagSettings",
    "policySettings",
    "toolsNarrowing",
    "mcpServerPolicy",
    "hostCredential",
];
/// 写进设置文件的 destination（本机、项目、用户的设置）：本工程都落在本机项目规则集。
const PERSISTENT: [&str; 3] = ["localSettings", "projectSettings", "userSettings"];

/// `updatedPermissions` 里的权限更新（按出现顺序）；不是数组时没有。
pub(crate) fn parse(updates: Option<&Value>) -> Vec<PermissionUpdate> {
    let Some(updates) = updates.and_then(Value::as_array) else {
        return Vec::new();
    };
    updates
        .iter()
        .filter_map(|update| match one(update) {
            Ok(parsed) => Some(parsed),
            Err(reason) => {
                skipped(update, reason);
                None
            }
        })
        .collect()
}

/// 一项更新；丢掉时是原因（进日志，不带规则内容与路径）。
fn one(update: &Value) -> Result<PermissionUpdate, &'static str> {
    let update = update
        .as_object()
        .ok_or("the permission update is not an object")?;
    let destination = update.get("destination").and_then(Value::as_str);
    let kind = update.get("type").and_then(Value::as_str);
    let place = match destination {
        Some(name) if IN_MEMORY.contains(&name) => UpdatePlace::Session,
        Some(name) if PERSISTENT.contains(&name) => UpdatePlace::Local,
        // Node 的 hook 结果 schema（contracts/hooks/index.ts 的 `updatedPermissions`）只有 addRules、没有
        // destination；它落本机项目规则集（`persistProjectPermissionUpdates`）。上游的形状仍按上面的表校验。
        None if kind == Some("addRules") => UpdatePlace::Local,
        _ => return Err("the destination is not one of the known ones"),
    };
    match kind {
        Some(kind @ ("addRules" | "replaceRules" | "removeRules")) => {
            let behavior = match update.get("behavior").and_then(Value::as_str) {
                Some("allow") => RuleBehavior::Allow,
                Some("deny") => RuleBehavior::Deny,
                Some("ask") => RuleBehavior::Ask,
                _ => return Err("the behavior is not allow, deny or ask"),
            };
            let items = update
                .get("rules")
                .and_then(Value::as_array)
                .ok_or("the rules are not an array")?;
            let restrictive = if kind == "removeRules" {
                behavior == RuleBehavior::Allow
            } else {
                behavior != RuleBehavior::Allow
            };
            let rules = if restrictive {
                let rules: Vec<PermissionRule> =
                    items.iter().filter_map(shaped).map(normalized).collect();
                if rules.is_empty() && !items.is_empty() {
                    return Err("every rule of a restrictive update is malformed");
                }
                rules
            } else {
                items
                    .iter()
                    .map(|item| shaped(item).and_then(round_trip))
                    .collect::<Option<Vec<_>>>()
                    .ok_or("a widening update carries a malformed rule")?
            };
            Ok(match kind {
                "addRules" => PermissionUpdate::AddRules {
                    place,
                    behavior,
                    rules,
                },
                "replaceRules" => PermissionUpdate::ReplaceRules {
                    place,
                    behavior,
                    rules,
                },
                _ => PermissionUpdate::RemoveRules {
                    place,
                    behavior,
                    rules,
                },
            })
        }
        Some("addDirectories") => {
            let directories = update
                .get("directories")
                .and_then(Value::as_array)
                .ok_or("the directories are not an array")?
                .iter()
                .map(|item| {
                    item.as_str()
                        .filter(|dir| !dir.trim().is_empty() && !dir.contains('\0'))
                        .map(EnvPath::new)
                })
                .collect::<Option<Vec<_>>>()
                .ok_or("a directory is not a usable path")?;
            Ok(PermissionUpdate::AddDirectories { place, directories })
        }
        Some("removeDirectories") => {
            let directories = update
                .get("directories")
                .and_then(Value::as_array)
                .ok_or("the directories are not an array")?
                .iter()
                .filter_map(|item| item.as_str().map(EnvPath::new))
                .collect();
            Ok(PermissionUpdate::RemoveDirectories { place, directories })
        }
        Some("setMode") => {
            let mode = update
                .get("mode")
                .and_then(Value::as_str)
                .and_then(PermissionMode::from_cli_choice)
                .ok_or("the mode is not one of the known ones")?;
            // 完全访问要用户在确认框里勾选，hook 不能替用户做这个决定（permission-updates.md D3）。
            if mode == PermissionMode::BypassPermissions {
                return Err("full access is not taken from a hook");
            }
            Ok(PermissionUpdate::SetMode { place, mode })
        }
        _ => Err("the permission update type is not one of the known ones"),
    }
}

/// `{toolName, ruleContent?}`：`toolName` 是非空字符串（空名的规则什么都不匹配），`ruleContent` 有值时是字符串。
fn shaped(value: &Value) -> Option<PermissionRule> {
    let tool = value
        .get("toolName")?
        .as_str()
        .filter(|tool| !tool.is_empty())?;
    let content = match value.get("ruleContent") {
        None => None,
        Some(content) => Some(content.as_str()?.to_owned()),
    };
    Some(PermissionRule {
        tool: tool.to_owned(),
        content,
    })
}

/// 写回再读的规则（旧名换成新名）。
fn normalized(rule: PermissionRule) -> PermissionRule {
    parse_rule(&format_rule(&rule))
}

/// 放宽的规则：写回再读之后内容不变才收（只换了工具的旧名时用换后的）。
fn round_trip(rule: PermissionRule) -> Option<PermissionRule> {
    let back = normalized(rule.clone());
    (back.content == rule.content).then_some(back)
}

/// 丢掉的更新：只记类型、behavior、destination 与原因，不记规则内容与路径。hook 返回这类更新时才有，一次调用至多几条。
fn skipped(update: &Value, reason: &str) {
    let field = |key: &str| {
        update
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    tracing::info!(
        event = "hooks.permission_updates.skipped",
        kind = %field("type"),
        behavior = %field("behavior"),
        destination = %field("destination"),
        reason,
        "a PermissionRequest hook permission update is skipped"
    );
}

#[cfg(test)]
#[path = "permission_updates_tests.rs"]
mod tests;

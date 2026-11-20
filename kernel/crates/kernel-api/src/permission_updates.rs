//! 一组权限更新（docs/specs/rust-cli/permission-updates.md §2）：一次「允许」一并套用的改动。用户的「总是允许」与
//! PermissionRequest hook 的 `updatedPermissions` 都换成它（对齐上游 ZCode-rs 0.1.88）。
//!
//! 这里只有纯数据与纯函数：解析在 hooks（`hooks/src/permission_updates.rs`），落库与改内存由会话 actor / 判决链的
//! owner 做（permission-updates.md §4：先算出事实，一批提交，成功后改内存）。

use serde::{Deserialize, Serialize};

use crate::env::EnvPath;
use crate::env_files::PathStyle;
use crate::permission::{
    PermissionMode, PermissionRule, ProjectRules, RuleBehavior, RuleSource, SourcedRule,
};

/// 一项更新落在哪里。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePlace {
    /// 只在这个会话（内存，会话关闭就没有）。
    Session,
    /// 这台机器的这个项目（Node 的 `local_setting`：本机项目规则集与持久模式），并在这个会话里立即生效。
    Local,
}

/// 一项权限更新（hook 的六种类型，destination 换成 [`UpdatePlace`]，permission-updates.md §2.2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PermissionUpdate {
    /// 加规则（按规则去重）。
    AddRules {
        place: UpdatePlace,
        behavior: RuleBehavior,
        rules: Vec<PermissionRule>,
    },
    /// 这一处这一类的规则整份换成 `rules`。
    ReplaceRules {
        place: UpdatePlace,
        behavior: RuleBehavior,
        rules: Vec<PermissionRule>,
    },
    /// 去掉这一处这一类里的这些规则。
    RemoveRules {
        place: UpdatePlace,
        behavior: RuleBehavior,
        rules: Vec<PermissionRule>,
    },
    /// 切会话的权限模式（`Plan` 是打开 plan 开关）；`Local` 另记为项目的持久模式。
    SetMode {
        place: UpdatePlace,
        mode: PermissionMode,
    },
    /// 加附加工作目录（绝对路径；已在工作目录里的不加）；`Local` 另记进本机项目规则集。
    AddDirectories {
        place: UpdatePlace,
        directories: Vec<EnvPath>,
    },
    /// 去掉附加工作目录；`Local` 另从本机项目规则集里去掉。
    RemoveDirectories {
        place: UpdatePlace,
        directories: Vec<EnvPath>,
    },
}

impl PermissionUpdate {
    /// 用户的「总是允许」（询问里选「不再询问」）：这些允许规则加进本机项目规则集；没有规则时没有更新。
    pub fn always_allow(rules: Vec<PermissionRule>) -> Vec<Self> {
        if rules.is_empty() {
            return Vec::new();
        }
        vec![Self::AddRules {
            place: UpdatePlace::Local,
            behavior: RuleBehavior::Allow,
            rules,
        }]
    }

    /// 改本机项目规则集里的规则：落库之后判决链要读回 LocalSettings 层。
    pub fn changes_local_rules(&self) -> bool {
        matches!(
            self,
            Self::AddRules {
                place: UpdatePlace::Local,
                ..
            } | Self::ReplaceRules {
                place: UpdatePlace::Local,
                ..
            } | Self::RemoveRules {
                place: UpdatePlace::Local,
                ..
            }
        )
    }

    /// 落在本机的 `SetMode`（项目持久模式）。
    pub fn sets_local_mode(&self) -> bool {
        matches!(
            self,
            Self::SetMode {
                place: UpdatePlace::Local,
                ..
            }
        )
    }
}

/// 去掉 `AddDirectories` / `RemoveDirectories` 里的相对路径（按工作区根 `root` 推断路径风格；相对路径的基准说不清）。
/// 落更新的一方先过这一步，内存与事实用同一份。
pub fn absolute_only(updates: &[PermissionUpdate], root: &EnvPath) -> Vec<PermissionUpdate> {
    let style = PathStyle::infer(root.as_str());
    let absolute = |directories: &[EnvPath]| {
        directories
            .iter()
            .filter(|dir| style.is_absolute(dir.as_str()))
            .cloned()
            .collect::<Vec<_>>()
    };
    updates
        .iter()
        .map(|update| match update {
            PermissionUpdate::AddDirectories { place, directories } => {
                PermissionUpdate::AddDirectories {
                    place: *place,
                    directories: absolute(directories),
                }
            }
            PermissionUpdate::RemoveDirectories { place, directories } => {
                PermissionUpdate::RemoveDirectories {
                    place: *place,
                    directories: absolute(directories),
                }
            }
            other => other.clone(),
        })
        .collect()
}

/// 会话级规则层上套用一项 `Session` 的规则更新：加（去重）、整份换掉一类、删；别的更新不动它。
/// 层里的规则来源都是 [`RuleSource::Session`]。
pub fn apply_to_layer(layer: &mut Vec<SourcedRule>, update: &PermissionUpdate) {
    fn add(layer: &mut Vec<SourcedRule>, behavior: RuleBehavior, rules: &[PermissionRule]) {
        for rule in rules {
            let rule = SourcedRule {
                source: RuleSource::Session,
                behavior,
                rule: rule.clone(),
            };
            if !layer.contains(&rule) {
                layer.push(rule);
            }
        }
    }
    match update {
        PermissionUpdate::AddRules {
            place: UpdatePlace::Session,
            behavior,
            rules,
        } => add(layer, *behavior, rules),
        PermissionUpdate::ReplaceRules {
            place: UpdatePlace::Session,
            behavior,
            rules,
        } => {
            layer.retain(|known| known.behavior != *behavior);
            add(layer, *behavior, rules);
        }
        PermissionUpdate::RemoveRules {
            place: UpdatePlace::Session,
            behavior,
            rules,
        } => layer.retain(|known| known.behavior != *behavior || !rules.contains(&known.rule)),
        PermissionUpdate::AddRules { .. }
        | PermissionUpdate::ReplaceRules { .. }
        | PermissionUpdate::RemoveRules { .. }
        | PermissionUpdate::SetMode { .. }
        | PermissionUpdate::AddDirectories { .. }
        | PermissionUpdate::RemoveDirectories { .. } => {}
    }
}

/// 项目规则集上套用一项 `Local` 的规则更新（会话行 `scope = session` 的情形也用它）：加去重、整份换、删。
/// 返回有没有改动。
pub fn apply_to_project_rules(project: &mut ProjectRules, update: &PermissionUpdate) -> bool {
    let (place, behavior, rules, replace) = match update {
        PermissionUpdate::AddRules {
            place,
            behavior,
            rules,
        } => (*place, *behavior, rules.as_slice(), false),
        PermissionUpdate::ReplaceRules {
            place,
            behavior,
            rules,
        } => (*place, *behavior, rules.as_slice(), true),
        PermissionUpdate::RemoveRules {
            place,
            behavior,
            rules,
        } => (*place, *behavior, rules.as_slice(), false),
        _ => return false,
    };
    if place != UpdatePlace::Local {
        return false;
    }
    let list = match behavior {
        RuleBehavior::Allow => &mut project.allow,
        RuleBehavior::Deny => &mut project.deny,
        RuleBehavior::Ask => &mut project.ask,
    };
    let before = list.clone();
    if replace {
        list.clear();
    }
    if matches!(update, PermissionUpdate::RemoveRules { .. }) {
        list.retain(|rule| !rules.contains(rule));
    } else {
        for rule in rules {
            if !list.contains(rule) {
                list.push(rule.clone());
            }
        }
    }
    *list != before
}

#[cfg(test)]
#[path = "permission_updates_tests.rs"]
mod tests;

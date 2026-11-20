//! 一组权限更新的纯函数（permission-updates.md §2、§3）。

use super::*;
use crate::permission::ProjectRules;

fn rule(tool: &str, content: Option<&str>) -> PermissionRule {
    PermissionRule {
        tool: tool.to_owned(),
        content: content.map(str::to_owned),
    }
}

fn session(behavior: RuleBehavior, rule: PermissionRule) -> SourcedRule {
    SourcedRule {
        source: RuleSource::Session,
        behavior,
        rule,
    }
}

#[test]
fn always_allow_is_one_local_allow_update_or_nothing() {
    assert!(PermissionUpdate::always_allow(Vec::new()).is_empty());
    let updates = PermissionUpdate::always_allow(vec![rule("Bash", Some("ls *"))]);
    assert_eq!(
        updates,
        [PermissionUpdate::AddRules {
            place: UpdatePlace::Local,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Bash", Some("ls *"))],
        }]
    );
    assert!(updates[0].changes_local_rules());
}

#[test]
fn only_local_rule_updates_need_the_local_layer_read_back() {
    let session_rules = PermissionUpdate::AddRules {
        place: UpdatePlace::Session,
        behavior: RuleBehavior::Deny,
        rules: vec![rule("Write", None)],
    };
    let local_mode = PermissionUpdate::SetMode {
        place: UpdatePlace::Local,
        mode: PermissionMode::AcceptEdits,
    };
    let local_dirs = PermissionUpdate::AddDirectories {
        place: UpdatePlace::Local,
        directories: vec![EnvPath::new("/Users/dev/extra")],
    };
    let local_remove = PermissionUpdate::RemoveRules {
        place: UpdatePlace::Local,
        behavior: RuleBehavior::Ask,
        rules: vec![rule("Bash", None)],
    };
    assert!(!session_rules.changes_local_rules());
    assert!(!local_mode.changes_local_rules());
    assert!(!local_dirs.changes_local_rules());
    assert!(local_remove.changes_local_rules());
    assert!(local_mode.sets_local_mode());
    assert!(!session_rules.sets_local_mode());
}

#[test]
fn session_updates_apply_to_the_session_layer_only() {
    let mut layer = vec![session(RuleBehavior::Allow, rule("Read", None))];
    apply_to_layer(
        &mut layer,
        &PermissionUpdate::AddRules {
            place: UpdatePlace::Session,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Read", None), rule("Bash", Some("ls:*"))],
        },
    );
    assert_eq!(
        layer,
        [
            session(RuleBehavior::Allow, rule("Read", None)),
            session(RuleBehavior::Allow, rule("Bash", Some("ls:*"))),
        ]
    );
    apply_to_layer(
        &mut layer,
        &PermissionUpdate::ReplaceRules {
            place: UpdatePlace::Session,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Write", None)],
        },
    );
    assert_eq!(layer, [session(RuleBehavior::Allow, rule("Write", None))]);
    apply_to_layer(
        &mut layer,
        &PermissionUpdate::RemoveRules {
            place: UpdatePlace::Session,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Write", None)],
        },
    );
    assert!(layer.is_empty());
    // Local 与 SetMode 不改会话层。
    apply_to_layer(
        &mut layer,
        &PermissionUpdate::AddRules {
            place: UpdatePlace::Local,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Bash", None)],
        },
    );
    assert!(layer.is_empty());
}

#[test]
fn local_updates_apply_to_project_rules() {
    let mut project = ProjectRules {
        allow: vec![rule("Read", None)],
        ..ProjectRules::default()
    };
    assert!(apply_to_project_rules(
        &mut project,
        &PermissionUpdate::AddRules {
            place: UpdatePlace::Local,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Read", None), rule("Bash", Some("npm test"))],
        }
    ));
    assert_eq!(
        project.allow,
        [rule("Read", None), rule("Bash", Some("npm test"))]
    );
    assert!(apply_to_project_rules(
        &mut project,
        &PermissionUpdate::ReplaceRules {
            place: UpdatePlace::Local,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Write", None)],
        }
    ));
    assert_eq!(project.allow, [rule("Write", None)]);
    assert!(apply_to_project_rules(
        &mut project,
        &PermissionUpdate::RemoveRules {
            place: UpdatePlace::Local,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Write", None)],
        }
    ));
    assert!(project.allow.is_empty());
    // Session 的规则不动项目规则集。
    assert!(!apply_to_project_rules(
        &mut project,
        &PermissionUpdate::AddRules {
            place: UpdatePlace::Session,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Bash", None)],
        }
    ));
    assert!(project.allow.is_empty());
}

#[test]
fn relative_directories_are_dropped() {
    let updates = [
        PermissionUpdate::AddDirectories {
            place: UpdatePlace::Session,
            directories: vec![EnvPath::new("/Users/dev/a"), EnvPath::new("relative")],
        },
        PermissionUpdate::RemoveDirectories {
            place: UpdatePlace::Local,
            directories: vec![EnvPath::new("also/relative")],
        },
    ];
    assert_eq!(
        absolute_only(&updates, &EnvPath::new("/Users/dev/project")),
        [
            PermissionUpdate::AddDirectories {
                place: UpdatePlace::Session,
                directories: vec![EnvPath::new("/Users/dev/a")],
            },
            PermissionUpdate::RemoveDirectories {
                place: UpdatePlace::Local,
                directories: Vec::new(),
            },
        ]
    );
}

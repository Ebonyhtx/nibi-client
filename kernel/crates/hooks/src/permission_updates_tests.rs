//! `updatedPermissions` 的解析（docs/specs/rust-cli/permission-updates.md §2.2、§2.4）：逐项校验，换成本工程的去处。

use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::permission::{PermissionMode, RuleBehavior};
use serde_json::json;

use super::*;

fn rule(tool: &str, content: Option<&str>) -> PermissionRule {
    PermissionRule {
        tool: tool.to_owned(),
        content: content.map(str::to_owned),
    }
}

fn add(place: UpdatePlace, behavior: RuleBehavior, rules: Vec<PermissionRule>) -> PermissionUpdate {
    PermissionUpdate::AddRules {
        place,
        behavior,
        rules,
    }
}

/// 11 种 destination：只在内存的进会话层，三种设置文件都落在本机。
#[test]
fn destinations_map_to_the_session_or_this_machine() {
    let updates = json!([
        {"type": "addRules", "behavior": "allow", "destination": "localSettings",
         "rules": [{"toolName": "Bash", "ruleContent": "npm test"}]},
        {"type": "addRules", "behavior": "allow", "destination": "projectSettings",
         "rules": [{"toolName": "Read"}]},
        {"type": "addRules", "behavior": "allow", "destination": "userSettings",
         "rules": [{"toolName": "WebFetch", "ruleContent": "domain:example.com"}]},
        {"type": "addRules", "behavior": "deny", "destination": "session",
         "rules": [{"toolName": "Write"}]},
        {"type": "addRules", "behavior": "ask", "destination": "cliArg",
         "rules": [{"toolName": "Bash"}]},
        {"type": "addRules", "behavior": "allow", "destination": "elsewhere",
         "rules": [{"toolName": "Bash"}]},
    ]);
    assert_eq!(
        parse(Some(&updates)),
        [
            add(
                UpdatePlace::Local,
                RuleBehavior::Allow,
                vec![rule("Bash", Some("npm test"))]
            ),
            add(
                UpdatePlace::Local,
                RuleBehavior::Allow,
                vec![rule("Read", None)]
            ),
            add(
                UpdatePlace::Local,
                RuleBehavior::Allow,
                vec![rule("WebFetch", Some("domain:example.com"))]
            ),
            add(
                UpdatePlace::Session,
                RuleBehavior::Deny,
                vec![rule("Write", None)]
            ),
            add(
                UpdatePlace::Session,
                RuleBehavior::Ask,
                vec![rule("Bash", None)]
            ),
        ]
    );
    assert!(parse(None).is_empty());
    assert!(parse(Some(&json!({"type": "addRules"}))).is_empty());
}

/// 放宽的（add / replace 的 allow，remove 的 deny / ask）有一条规则形状不对就整项丢掉；收紧的逐条跳过，全不对时整项丢掉。
#[test]
fn widening_updates_drop_whole_and_restrictive_ones_skip_rules() {
    let updates = json!([
        {"type": "addRules", "behavior": "allow", "destination": "localSettings",
         "rules": [{"toolName": "Bash", "ruleContent": "ls"}, {"toolName": ""}]},
        {"type": "replaceRules", "behavior": "allow", "destination": "session",
         "rules": [{"toolName": "Bash", "ruleContent": 7}]},
        {"type": "removeRules", "behavior": "deny", "destination": "session",
         "rules": [{"toolName": 3}]},
        {"type": "addRules", "behavior": "deny", "destination": "session",
         "rules": [{"toolName": "Write"}, {"toolName": 3}, "Bash"]},
        {"type": "removeRules", "behavior": "allow", "destination": "localSettings",
         "rules": [{"ruleContent": "x"}]},
        {"type": "replaceRules", "behavior": "ask", "destination": "localSettings",
         "rules": []},
        {"type": "addRules", "behavior": "allow", "destination": "localSettings",
         "rules": "Bash"},
        {"type": "addRules", "behavior": "never", "destination": "localSettings",
         "rules": []},
    ]);
    assert_eq!(
        parse(Some(&updates)),
        [
            add(
                UpdatePlace::Session,
                RuleBehavior::Deny,
                vec![rule("Write", None)]
            ),
            PermissionUpdate::ReplaceRules {
                place: UpdatePlace::Local,
                behavior: RuleBehavior::Ask,
                rules: Vec::new(),
            },
        ]
    );
}

/// 规则写回再读：旧名换成新名；写回之后内容变了的放宽规则整项丢掉。
#[test]
fn rules_are_normalized_by_a_round_trip() {
    let updates = json!([
        {"type": "addRules", "behavior": "allow", "destination": "session",
         "rules": [{"toolName": "Task", "ruleContent": "Explore"}]},
        {"type": "addRules", "behavior": "allow", "destination": "session",
         "rules": [{"toolName": "Bash", "ruleContent": ""}]},
        {"type": "removeRules", "behavior": "allow", "destination": "session",
         "rules": [{"toolName": "KillShell"}]},
    ]);
    assert_eq!(
        parse(Some(&updates)),
        [
            add(
                UpdatePlace::Session,
                RuleBehavior::Allow,
                vec![rule("Agent", Some("Explore"))]
            ),
            PermissionUpdate::RemoveRules {
                place: UpdatePlace::Session,
                behavior: RuleBehavior::Allow,
                rules: vec![rule("TaskStop", None)],
            },
        ]
    );
}

#[test]
fn directories_follow_the_checks_of_their_kind() {
    let updates = json!([
        {"type": "addDirectories", "destination": "localSettings",
         "directories": ["/Users/dev/a", "/Users/dev/b"]},
        {"type": "addDirectories", "destination": "session", "directories": ["/Users/dev/c", "  "]},
        {"type": "addDirectories", "destination": "session", "directories": ["/Users/dev/c\u{0}"]},
        {"type": "addDirectories", "destination": "session", "directories": ["/Users/dev/c", 1]},
        {"type": "addDirectories", "destination": "session", "directories": "/Users/dev/c"},
        {"type": "removeDirectories", "destination": "session", "directories": ["/Users/dev/a", 1]},
    ]);
    assert_eq!(
        parse(Some(&updates)),
        [
            PermissionUpdate::AddDirectories {
                place: UpdatePlace::Local,
                directories: vec![EnvPath::new("/Users/dev/a"), EnvPath::new("/Users/dev/b")],
            },
            PermissionUpdate::RemoveDirectories {
                place: UpdatePlace::Session,
                directories: vec![EnvPath::new("/Users/dev/a")],
            },
        ]
    );
}

/// 模式按命令行的模式名认；`bypassPermissions` 不认（完全访问要用户确认，permission-updates.md D3）；不认识的跳过。
#[test]
fn modes_are_taken_by_their_cli_names_except_full_access() {
    let updates = json!([
        {"type": "setMode", "destination": "session", "mode": "acceptEdits"},
        {"type": "setMode", "destination": "localSettings", "mode": "plan"},
        {"type": "setMode", "destination": "session", "mode": "bypassPermissions"},
        {"type": "setMode", "destination": "session", "mode": "guarded"},
        {"type": "setMode", "destination": "session", "mode": 3},
        {"type": "unknownKind", "destination": "session"},
        "not an object",
    ]);
    assert_eq!(
        parse(Some(&updates)),
        [
            PermissionUpdate::SetMode {
                place: UpdatePlace::Session,
                mode: PermissionMode::AcceptEdits,
            },
            PermissionUpdate::SetMode {
                place: UpdatePlace::Local,
                mode: PermissionMode::Plan,
            },
        ]
    );
}

/// 安全（fail-closed）：整项不认识时没有更新，不会把 hook 的任意 JSON 当规则执行。
#[test]
fn unknown_or_malformed_updates_never_widen_permissions() {
    let updates = json!([
        {"type": "addRules", "behavior": "allow", "destination": "localSettings",
         "rules": [{"toolName": "Bash", "ruleContent": "rm -rf /"}]},
        {"type": "addRules", "behavior": "allow", "destination": "localSettings",
         "rules": [{"toolName": "Bash", "ruleContent": "rm -rf /"}, {"toolName": 0}]},
        {"type": "setMode", "destination": "session", "mode": "bypassPermissions"},
    ]);
    // 第一项只是“规则内容看起来危险”，仍然是一个合法规则（由判决链判断，不在解析里改写）；第二项整项丢掉；
    // 第三项完全访问丢掉。
    assert_eq!(
        parse(Some(&updates)),
        [add(
            UpdatePlace::Local,
            RuleBehavior::Allow,
            vec![rule("Bash", Some("rm -rf /"))]
        )]
    );
    // 规则数组缺失或不是数组：没有更新。
    assert!(
        parse(Some(&json!({"type": "addRules", "behavior": "allow",
        "destination": "localSettings"})))
        .is_empty()
    );
    assert!(
        parse(Some(&json!({"type": "addRules", "behavior": "allow",
        "destination": "localSettings", "rules": {}})))
        .is_empty()
    );
}

/// 子代理来源的隔离：`Session` 的去处只有 [`UpdatePlace::Session`]（父会话看不到）；`Local` 是项目级，
/// 与子代理身份无关（与上游一致，见风险报告）。
#[test]
fn session_updates_stay_session_scoped() {
    let updates = json!([
        {"type": "addRules", "behavior": "allow", "destination": "session",
         "rules": [{"toolName": "Bash", "ruleContent": "rm -rf /tmp/x"}]},
    ]);
    let parsed = parse(Some(&updates));
    assert_eq!(
        parsed,
        [add(
            UpdatePlace::Session,
            RuleBehavior::Allow,
            vec![rule("Bash", Some("rm -rf /tmp/x"))]
        )]
    );
    assert!(!parsed[0].changes_local_rules());
}

/// Node 的 hook 结果 schema（contracts/hooks/index.ts 的 `updatedPermissions`）没有 destination、只有
/// `addRules`：按 Node 的落点（本机项目规则集）收，形状与 Node 的一致。
#[test]
fn node_shaped_updates_without_a_destination_are_local() {
    let updates = json!([
        {"type": "addRules", "behavior": "allow",
         "rules": [{"toolName": "Bash", "ruleContent": "npm test"}]},
    ]);
    assert_eq!(
        parse(Some(&updates)),
        [add(
            UpdatePlace::Local,
            RuleBehavior::Allow,
            vec![rule("Bash", Some("npm test"))]
        )]
    );
    // 别的类型仍要求 destination（上游的形状）。
    assert!(
        parse(Some(&json!([
            {"type": "replaceRules", "behavior": "allow", "rules": [{"toolName": "Read"}]},
        ])))
        .is_empty()
    );
}

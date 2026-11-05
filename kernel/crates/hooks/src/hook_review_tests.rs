//! 钩子评审快照的判定：待审/全信任/策略阻断/无项。

use super::*;
use crate::project_config::{ProjectFile, ProjectKind};
use nibi_kernel_platform::ConfigFile;
use serde_json::json;

fn project_file(path: &str, order: usize, hooks: serde_json::Value) -> ProjectFile {
    let mut object = serde_json::Map::new();
    object.insert("hooks".into(), hooks);
    ProjectFile {
        path: path.to_owned(),
        kind: ProjectKind::DotProjectConfig,
        order,
        editable: true,
        file: ConfigFile::Loaded(object),
    }
}

fn two_hooks() -> serde_json::Value {
    json!({
        "enabled": true,
        "events": {
            "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo pre"}]}],
            "Stop": [{"hooks": [{"type": "command", "command": "echo stop"}]}]
        }
    })
}

#[test]
fn pending_until_every_enabled_declaration_is_trusted() {
    let root = "/w";
    let files = vec![project_file("/w/.nibi/config.json", 0, two_hooks())];
    let none = review(root, &files, &NodeHooks::default(), &HashSet::new(), false, false);
    assert_eq!(none.reason_code, "pending_trust");
    assert_eq!(none.items.len(), 2);
    assert!(none.bundle_digest.is_some());
    assert!(none.has_pending());
    // 单据摘要与 reviewItemId 按 Node 的排法（source 0、事件内序号）。
    assert_eq!(none.items[0].review_item_id, "workspace-hook-0-PreToolUse-0-0");
    assert_eq!(none.items[1].review_item_id, "workspace-hook-0-Stop-0-0");
    assert_eq!(none.items[0].source_path, ".nibi/config.json");
    assert_eq!(none.items[0].matcher.as_deref(), Some("Bash"));
    assert_eq!(none.items[0].kind, "command");

    // 只信任一条：仍然待审。
    let one: HashSet<String> = [none.items[0].declaration_digest.clone()].into_iter().collect();
    let partial = review(root, &files, &NodeHooks::default(), &one, false, false);
    assert_eq!(partial.reason_code, "pending_trust");
    assert_eq!(partial.pending_count(), 1);
    assert_eq!(partial.items[0].trust_state, HookTrustState::TrustedPersistent);

    // 全信任：不再待审。
    let all: HashSet<String> = none
        .items
        .iter()
        .map(|item| item.declaration_digest.clone())
        .collect();
    let trusted = review(root, &files, &NodeHooks::default(), &all, false, false);
    assert_eq!(trusted.reason_code, "trusted_persistent");
    assert!(!trusted.has_pending());
}

#[test]
fn policy_block_and_corrupt_store_win_over_trust() {
    let files = vec![project_file("/w/.nibi/config.json", 0, two_hooks())];
    let all: HashSet<String> = review("/w", &files, &NodeHooks::default(), &HashSet::new(), false, false)
        .items
        .iter()
        .map(|item| item.declaration_digest.clone())
        .collect();
    let blocked = review("/w", &files, &NodeHooks::default(), &all, true, false);
    assert_eq!(blocked.reason_code, "blocked_policy");
    assert!(blocked
        .items
        .iter()
        .all(|item| item.trust_state == HookTrustState::BlockedPolicy));
    let corrupt = review("/w", &files, &NodeHooks::default(), &all, false, true);
    assert_eq!(corrupt.reason_code, "trust_store_corrupt");
    assert!(corrupt
        .items
        .iter()
        .all(|item| item.trust_state == HookTrustState::PendingTrust));
}

#[test]
fn no_project_hooks_is_not_applicable() {
    let files = vec![project_file("/w/.nibi/config.json", 0, json!({"enabled": true}))];
    let empty = review("/w", &files, &NodeHooks::default(), &HashSet::new(), false, false);
    assert_eq!(empty.reason_code, "not_applicable");
    assert!(empty.bundle_digest.is_none());
    assert!(empty.items.is_empty());
    assert!(!empty.has_pending());
}

#[test]
fn user_layer_timeout_reaches_the_declaration_digests() {
    // 用户层的 timeoutMs 进 runtimeRoot，而每条声明的摘要含 `defaultTimeoutMs`（Node 的
    // createWorkspaceHookDeclarationDigest 同义）——所以它不仅改生效超时，也改声明摘要与 bundle。
    let files = vec![project_file("/w/.nibi/config.json", 0, two_hooks())];
    let plain = review("/w", &files, &NodeHooks::default(), &HashSet::new(), false, false);
    let user = NodeHooks {
        timeout_ms: Some(5000.0),
        ..NodeHooks::default()
    };
    let changed = review("/w", &files, &user, &HashSet::new(), false, false);
    assert_eq!(changed.items.len(), plain.items.len());
    assert_ne!(changed.bundle_digest, plain.bundle_digest);
    assert_ne!(
        changed.items[0].declaration_digest,
        plain.items[0].declaration_digest
    );
    assert!(changed
        .items
        .iter()
        .all(|item| item.resolved_timeout_ms == 5000));
    assert!(plain
        .items
        .iter()
        .all(|item| item.resolved_timeout_ms != 5000));
}

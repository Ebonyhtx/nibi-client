//! 钩子评审快照的形状与判定（与 NIBI payload 的字段名对齐）。

use super::*;

fn item(state: HookTrustState) -> WorkspaceHookItem {
    WorkspaceHookItem {
        review_item_id: "workspace-hook-0-PreToolUse-0-0".into(),
        event: "PreToolUse".into(),
        matcher: Some("Bash".into()),
        kind: "command".into(),
        display_name: "guard".into(),
        display_command: "node guard.js".into(),
        source_path: ".nibi/config.json".into(),
        resolved_timeout_ms: 60_000,
        resolved_max_output_bytes: 32_768,
        configured_enabled: true,
        editable: true,
        trust_state: state,
        declaration_digest: "607f038e".into(),
    }
}

#[test]
fn the_snapshot_serializes_with_the_nibi_field_names() {
    let review = WorkspaceHookReview {
        identity: "/w".into(),
        bundle_digest: Some("ab".repeat(32)),
        reason_code: "pending_trust".into(),
        items: vec![item(HookTrustState::PendingTrust), item(HookTrustState::TrustedPersistent)],
    };
    let value = serde_json::to_value(&review).unwrap();
    assert_eq!(value["identity"], "/w");
    assert_eq!(value["reasonCode"], "pending_trust");
    assert_eq!(value["items"][0]["reviewItemId"], "workspace-hook-0-PreToolUse-0-0");
    assert_eq!(value["items"][0]["displayCommand"], "node guard.js");
    assert_eq!(value["items"][0]["resolvedTimeoutMs"], 60_000);
    assert_eq!(value["items"][0]["trustState"], "pending_trust");
    assert_eq!(value["items"][1]["trustState"], "trusted_persistent");
    // 待处理项只数 pending/revoked/stale_digest（NIBI 的 summary.pendingCount）。
    assert_eq!(review.pending_count(), 1);
    assert!(review.has_pending());
    let back: WorkspaceHookReview = serde_json::from_value(value).unwrap();
    assert_eq!(back, review);
}

#[test]
fn a_review_without_items_is_not_applicable_and_has_no_pending() {
    let review = WorkspaceHookReview {
        identity: "/w".into(),
        bundle_digest: None,
        reason_code: "not_applicable".into(),
        items: Vec::new(),
    };
    assert_eq!(review.pending_count(), 0);
    assert!(!review.has_pending());
    let value = serde_json::to_value(&review).unwrap();
    // 没有 bundle 时不写这个字段（Host 按缺席处理）。
    assert!(value.get("bundleDigest").is_none());
}

#[test]
fn every_blocked_state_is_pending_except_policy_and_trusted() {
    for state in [HookTrustState::Revoked, HookTrustState::StaleDigest] {
        assert!(state.pending(), "{state:?}");
    }
    for state in [HookTrustState::BlockedPolicy, HookTrustState::TrustedPersistent, HookTrustState::NotApplicable] {
        assert!(!state.pending(), "{state:?}");
    }
}

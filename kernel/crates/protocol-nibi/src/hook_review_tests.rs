//! 评审交互的形状（对着 NIBI 的 `workspaceHookReviewRequestPayloadSchema`）与 flow 的匹配规则。

use super::*;
use nibi_kernel_api::hook_review::{WorkspaceHookItem, WorkspaceHookSource};

fn item(id: &str, event: &str, state: HookTrustState, enabled: bool) -> WorkspaceHookItem {
    WorkspaceHookItem {
        review_item_id: id.into(),
        event: event.into(),
        matcher: Some("Bash".into()),
        kind: "command".into(),
        display_name: format!("{event} · Bash"),
        display_command: "guard.sh".into(),
        source_path: ".nibi/config.json".into(),
        resolved_timeout_ms: 30_000,
        resolved_max_output_bytes: 32_768,
        execution_mode: "foreground".into(),
        configured_enabled: enabled,
        editable: true,
        trust_state: state,
        declaration_digest: "a".repeat(64),
        source_discovery_order: 0,
        matcher_index: 0,
        hook_index: 0,
    }
}

fn review() -> WorkspaceHookReview {
    WorkspaceHookReview {
        identity: "/w".into(),
        bundle_digest: Some("b".repeat(64)),
        reason_code: "pending_trust".into(),
        sources: vec![WorkspaceHookSource {
            path: "/w/.nibi/config.json".into(),
            display_path: ".nibi/config.json".into(),
            editable: true,
        }],
        items: vec![
            item("workspace-hook-0-PreToolUse-0-0", "PreToolUse", HookTrustState::PendingTrust, true),
            item("workspace-hook-0-Stop-0-0", "Stop", HookTrustState::TrustedPersistent, false),
        ],
    }
}

fn flow() -> Flow {
    Flow {
        review_flow_id: "workspace-hook-review:flow-1".into(),
        generation: 2,
        interaction_id: "workspace-hook-interaction:review-1".into(),
        identity: "/w".into(),
        bundle_digest: "b".repeat(64),
        remote_session_id: None,
        created_at: 1_000,
        deadline_at: 601_000,
    }
}

#[test]
fn the_request_payload_has_exactly_the_nibi_fields() {
    let payload = request_payload("sess_1", &flow(), &review());
    let keys: std::collections::BTreeSet<&str> = payload
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        std::collections::BTreeSet::from([
            "kind",
            "reviewFlowId",
            "generation",
            "interactionId",
            "sessionId",
            "taskId",
            "runId",
            "workspaceIdentity",
            "workspaceLabel",
            "bundleDigest",
            "createdAt",
            "deadlineAt",
            "sourceFiles",
            "summary",
            "items",
            "warningCode",
        ])
    );
    assert_eq!(payload["kind"], "workspaceHookReview");
    assert_eq!(payload["workspaceLabel"], "w");
    assert_eq!(payload["deadlineAt"], 601_000);
    assert_eq!(payload["warningCode"], "workspace_hooks_execute_code");
    // 摘要：hooks 总数、事件去重数、待审数（不看 configuredEnabled）。
    assert_eq!(payload["summary"]["hookCount"], 2);
    assert_eq!(payload["summary"]["eventCount"], 2);
    assert_eq!(payload["summary"]["pendingCount"], 1);
    assert_eq!(payload["items"][0]["type"], "command");
    assert_eq!(payload["items"][0]["executionMode"], "foreground");
    assert_eq!(payload["items"][0]["trustState"], "pending_trust");
    assert_eq!(payload["items"][1]["trustState"], "trusted_persistent");
    // items 的键也正好是 schema 里那 12 个。
    let item_keys: std::collections::BTreeSet<&str> = payload["items"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        item_keys,
        std::collections::BTreeSet::from([
            "reviewItemId",
            "event",
            "matcher",
            "type",
            "displayName",
            "displayCommand",
            "sourcePath",
            "resolvedTimeoutMs",
            "resolvedMaxOutputBytes",
            "executionMode",
            "configuredEnabled",
            "editable",
            "trustState",
        ])
    );
}

#[test]
fn a_remote_session_is_echoed_and_a_local_one_is_omitted() {
    let mut flow = flow();
    flow.remote_session_id = Some("remote_1".into());
    assert_eq!(request_payload("sess_1", &flow, &review())["remoteSessionId"], "remote_1");
    flow.remote_session_id = None;
    assert!(request_payload("sess_1", &flow, &review()).get("remoteSessionId").is_none());
}

#[test]
fn the_admission_banner_counts_only_enabled_pending_items() {
    // 第一条启用且待审 → 1；第二条已信任 → 不算。
    assert_eq!(admission(&review()).unwrap()["pendingCount"], 1);
    // 待审但未启用：评审仍可做，提示条不出现（Node admission 的口径）。
    let mut disabled = review();
    disabled.items[0].configured_enabled = false;
    disabled.items[1].trust_state = HookTrustState::TrustedPersistent;
    assert!(admission(&disabled).is_none());
}

#[test]
fn flow_matching_separates_superseded_from_snapshot_mismatch() {
    let flow = flow();
    let mut payload = json!({
        "sessionId": "sess_1",
        "workspaceIdentity": "/w",
        "bundleDigest": "b".repeat(64),
        "reviewFlowId": "workspace-hook-review:flow-1",
        "generation": 2,
        "interactionId": "workspace-hook-interaction:review-1",
    });
    assert!(flow.matches_generation(&payload));
    assert!(flow.matches_snapshot(&payload));
    payload["generation"] = json!(1);
    assert!(!flow.matches_generation(&payload));
    payload["generation"] = json!(2);
    payload["bundleDigest"] = json!("c".repeat(64));
    assert!(flow.matches_generation(&payload));
    assert!(!flow.matches_snapshot(&payload));
}

#[test]
fn the_workspace_label_is_the_last_path_segment() {
    assert_eq!(workspace_label("/Users/dev/repo"), "repo");
    assert_eq!(workspace_label("/Users/dev/repo/"), "repo");
    assert_eq!(workspace_label("D:\\workspace\\NIBI-Client"), "NIBI-Client");
    assert_eq!(workspace_label("/"), "/");
}

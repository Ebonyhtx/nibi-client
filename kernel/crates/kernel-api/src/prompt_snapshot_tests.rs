//! prompt 快照的数据形状与解析（K6；字段名对齐上游 `prompt-snapshot.ts`）。
use serde_json::json;

use super::{
    PromptSnapshot, PromptSnapshotState, parse_prompt_snapshot, prompt_snapshot_key,
    prompt_snapshot_record,
};
use crate::ids::SessionId;
use crate::model::{CacheControl, ModelSelection, SystemBlock};
use crate::testing::selection;

fn model(provider: &str, model: &str) -> ModelSelection {
    ModelSelection {
        provider: provider.to_owned(),
        model: model.to_owned(),
        reasoning: Some("high".to_owned()),
        connection: None,
    }
}

fn blocks() -> Vec<SystemBlock> {
    vec![
        SystemBlock {
            text: "identity".to_owned(),
            cache_control: None,
        },
        SystemBlock {
            text: "static".to_owned(),
            cache_control: Some(CacheControl {
                kind: "ephemeral".to_owned(),
                ttl: None,
                scope: Some("global".to_owned()),
            }),
        },
    ]
}

/// 落库的字段名与上游一致：`providerId` / `modelId` / `cacheControl`，system 是 `role` + `content`。
#[test]
fn the_record_data_uses_the_upstream_field_names() {
    let snapshot = PromptSnapshot::of(&model("fixture", "scripted"), &blocks());
    let state = PromptSnapshotState::Present(snapshot);
    assert_eq!(
        state.data(),
        json!({
            "model": { "providerId": "fixture", "modelId": "scripted" },
            "system": [
                { "role": "system", "content": "identity" },
                {
                    "role": "system",
                    "content": "static",
                    "cacheControl": { "type": "ephemeral", "scope": "global" }
                }
            ]
        })
    );
}

/// 写进去的数据读回来字节不变（缓存前缀看字节）。
#[test]
fn parse_round_trips_the_system_bytes() {
    let snapshot = PromptSnapshot::of(&model("fixture", "scripted"), &blocks());
    let parsed = parse_prompt_snapshot(&snapshot_state_data(&snapshot)).unwrap();
    let PromptSnapshotState::Present(parsed) = parsed else {
        panic!("expected a snapshot")
    };
    assert_eq!(parsed, snapshot);
    assert_eq!(parsed.system_blocks(), blocks());
}

fn snapshot_state_data(snapshot: &PromptSnapshot) -> serde_json::Value {
    PromptSnapshotState::Present(snapshot.clone()).data()
}

/// 只比较 provider 与 model id，推理档不参与。
#[test]
fn the_model_identity_ignores_the_reasoning_level() {
    let snapshot = PromptSnapshot::of(&model("fixture", "scripted"), &blocks());
    assert!(snapshot.matches(&model("fixture", "scripted")));
    let other_reasoning = ModelSelection {
        reasoning: Some("low".to_owned()),
        ..model("fixture", "scripted")
    };
    assert!(snapshot.matches(&other_reasoning));
    assert!(!snapshot.matches(&model("fixture", "other")));
    assert!(!snapshot.matches(&model("other", "scripted")));
}

/// 墓碑是 `{cleared: true}`。
#[test]
fn the_tombstone_is_cleared_true() {
    let data = PromptSnapshotState::Cleared.data();
    assert_eq!(data, json!({ "cleared": true }));
    assert_eq!(
        parse_prompt_snapshot(&data),
        Some(PromptSnapshotState::Cleared)
    );
}

/// 无效数据按没有快照处理（不报错、不阻断恢复）。
#[test]
fn malformed_data_counts_as_no_snapshot() {
    for data in [
        json!(null),
        json!("snapshot"),
        json!([]),
        json!({ "cleared": false }),
        json!({ "model": { "providerId": "fixture" }, "system": [] }),
        json!({ "model": { "providerId": 1, "modelId": "scripted" }, "system": [] }),
        json!({ "model": { "providerId": "fixture", "modelId": "scripted" }, "system": "x" }),
        json!({
            "model": { "providerId": "fixture", "modelId": "scripted" },
            "system": [{ "role": "user", "content": "hi" }]
        }),
        json!({
            "model": { "providerId": "fixture", "modelId": "scripted" },
            "system": [{ "role": "system", "content": [{ "type": "text", "text": "hi" }] }]
        }),
        json!({
            "model": { "providerId": "fixture", "modelId": "scripted" },
            "system": [{ "role": "system", "content": "hi", "cacheControl": "ephemeral" }]
        }),
    ] {
        assert_eq!(parse_prompt_snapshot(&data), None, "{data}");
    }
}

/// 存储行的 key 与 kind。
#[test]
fn the_record_key_is_session_scoped() {
    let session = SessionId::new("sess_1");
    let record = prompt_snapshot_record(
        &session,
        &PromptSnapshotState::Present(PromptSnapshot::of(&selection(), &blocks())),
    );
    assert_eq!(record.kind, "runtime/prompt_snapshot");
    assert_eq!(record.key, "sess_1:runtime-prompt-snapshot");
    assert_eq!(record.key, prompt_snapshot_key(&session));
}

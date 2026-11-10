//! `workspace-mcp-trust-v1.json` 的 strict 读取（A5/A6）。
#![allow(
    clippy::disallowed_methods,
    reason = "测试直接写信任记录夹具以验证 strict 解析"
)]

use nibi_kernel_paths::{StoragePaths, StorageSettings};
use serde_json::json;

use super::*;

async fn store_with(content: &str) -> (tempfile::TempDir, McpTrustStore) {
    let dir = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&StorageSettings::default(), dir.path(), dir.path());
    let store = McpTrustStore::new(paths.mcp_trust_store(None));
    tokio::fs::create_dir_all(store.path().as_path().parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(store.path().as_path(), content)
        .await
        .unwrap();
    (dir, store)
}

fn record(identity: &str, server: &str, digest: &str) -> serde_json::Value {
    json!({
        "workspaceIdentity": identity,
        "serverName": server,
        "declarationDigest": digest,
        "grantedAt": "2026-11-11T00:00:00.000Z",
    })
}

#[tokio::test]
async fn missing_file_is_no_grant() {
    let dir = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&StorageSettings::default(), dir.path(), dir.path());
    let store = McpTrustStore::new(paths.mcp_trust_store(None));
    assert_eq!(store.load().await, McpTrustLoad::Missing);
}

#[tokio::test]
async fn reads_host_records_and_filters_by_workspace() {
    let digest = "a".repeat(64);
    let (_dir, store) = store_with(
        &serde_json::to_string(&json!({
            "schemaVersion": 1,
            "records": [record("/ws", "probe", &digest)],
        }))
        .unwrap(),
    )
    .await;
    let McpTrustLoad::Records(records) = store.load().await else {
        panic!("expected records");
    };
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].server_name, "probe");
    assert_eq!(
        store.load().await.trusted_digests("/ws"),
        vec![digest.clone()]
    );
    assert!(store.load().await.trusted_digests("/other").is_empty());
    assert!(store.load().await.records_server("/ws", "probe"));
}

#[tokio::test]
async fn strict_schema_rejects_unknown_fields_and_duplicates() {
    let digest = "a".repeat(64);
    for content in [
        // 未知顶层字段
        json!({"schemaVersion": 1, "records": [], "extra": true}).to_string(),
        // 未知记录字段
        json!({"schemaVersion": 1, "records": [{
            "workspaceIdentity": "/ws", "serverName": "probe",
            "declarationDigest": digest, "grantedAt": "2026-11-11T00:00:00.000Z",
            "extra": 1,
        }]})
        .to_string(),
        // 未知版本
        json!({"schemaVersion": 99, "records": []}).to_string(),
        // 重复键
        json!({"schemaVersion": 1, "records": vec![
            record("/ws", "probe", &digest), record("/ws", "probe", &digest),
        ]})
        .to_string(),
        // 非法摘要
        json!({"schemaVersion": 1, "records": [record("/ws", "probe", "not-a-digest")]})
            .to_string(),
        // 非 ISO 时间
        json!({"schemaVersion": 1, "records": [{
            "workspaceIdentity": "/ws", "serverName": "probe",
            "declarationDigest": digest, "grantedAt": "yesterday",
        }]})
        .to_string(),
        "not json".to_owned(),
    ] {
        let (_dir, store) = store_with(&content).await;
        assert_eq!(
            store.load().await,
            McpTrustLoad::Corrupt,
            "content must be rejected: {content}"
        );
    }
}

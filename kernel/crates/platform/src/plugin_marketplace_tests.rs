//! 商店目录的展示投影：内置分片 + 目录快照的合并、字段映射与去重。
use std::path::Path;

use nibi_kernel_paths::StoragePaths;

use super::*;
use crate::test_support::write;

fn storage(dir: &Path) -> StoragePath {
    StoragePaths::resolve(&Default::default(), dir, dir).plugin_storage(None, dir)
}

#[tokio::test]
async fn bundled_and_snapshot_entries_are_merged_with_the_snapshot_winning() {
    let dir = tempfile::tempdir().unwrap();
    let root = storage(dir.path());
    let marketplaces = root.as_path().join("marketplaces");
    write(
        &marketplaces
            .join("nibi-official")
            .join("bundled-marketplace.json"),
        r#"{"version": 1, "manifest": {"name": "nibi-official", "plugins": [
            {"name": "visualize", "cachePath": "/cache/nibi-official/visualize/0.1.0",
             "displayName": "Visualize", "displayName_i18n": {"zh-CN": "交互视图"},
             "icon": "https://cdn.example/visualize.png", "category": "productivity"}
        ]}}"#,
    )
    .await;
    write(
        &marketplaces.join("nibi-official").join("marketplace.json"),
        r#"{"name": "nibi-official", "plugins": [
            {"name": "visualize", "icon": "https://cdn.example/visualize-v2.png"},
            {"name": "pdf", "icon": "https://cdn.example/pdf.png",
             "description_i18n": {"zh-CN": "PDF 处理"},
             "author": {"name": "NIBI", "url": "https://nibistudio.cn"},
             "requiresPaidPlan": true, "publisherType": "official"},
            {"name": "pdf", "icon": "https://cdn.example/pdf-new.png"}
        ]}"#,
    )
    .await;

    let found = listings(&root).await;
    assert_eq!(found.len(), 2);
    // 快照覆盖分片：同一稳定 ID 只留一条，icon 取快照的。
    let visualize = found
        .iter()
        .find(|entry| entry.plugin_id == "visualize@nibi-official")
        .expect("visualize");
    assert_eq!(
        visualize.listing.icon.as_deref(),
        Some("https://cdn.example/visualize-v2.png")
    );
    // 同一份清单里重复的条目也去重（后一条覆盖前一条），作者/付费/发布方按 Node 的规则解析。
    let pdf = found
        .iter()
        .find(|entry| entry.plugin_id == "pdf@nibi-official")
        .expect("pdf");
    assert_eq!(
        pdf.listing.icon.as_deref(),
        Some("https://cdn.example/pdf-new.png")
    );
    assert_eq!(pdf.listing.author.as_deref(), Some("NIBI"));
    assert_eq!(
        pdf.listing.author_url.as_deref(),
        Some("https://nibistudio.cn")
    );
    assert!(pdf.listing.requires_paid_plan);
    assert_eq!(pdf.listing.publisher_type.as_deref(), Some("official"));
}

#[tokio::test]
async fn entries_without_display_fields_are_skipped_and_custom_marketplaces_are_read() {
    let dir = tempfile::tempdir().unwrap();
    let root = storage(dir.path());
    let marketplaces = root.as_path().join("marketplaces");
    // 只有多语言描述也算展示字段；完全空的条目不进目录（Node `parseEntryStoreListing`）。
    write(
        &marketplaces.join("my-market").join("marketplace.json"),
        r#"{"plugins": [
            {"name": "empty"},
            {"name": "zh-only", "displayName_i18n": {"zh-CN": "中文名"}}
        ]}"#,
    )
    .await;
    let found = listings(&root).await;
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].plugin_id, "zh-only@my-market");
    assert_eq!(found[0].plugin_name, "zh-only");
    assert_eq!(found[0].marketplace, "my-market");
    assert_eq!(
        found[0]
            .listing
            .display_name_i18n
            .get("zh-CN")
            .map(String::as_str),
        Some("中文名")
    );
}

#[tokio::test]
async fn a_missing_storage_root_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    assert!(listings(&storage(dir.path())).await.is_empty());
}

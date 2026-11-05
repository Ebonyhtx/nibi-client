//! 工作区钩子评审的内核侧：发现 → 判定 → 授权 / 撤销的整条链路（信任库用内存替身）。

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::hook_review::{
    HookTrust, HookTrustError, HookTrustGrant, HookTrustSnapshot, HookTrustState,
};
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Kernel, KernelError};
use nibi_kernel_api::testing::{FixedClock, MemoryStore, ScriptedModel, SequentialIds, environments};

use super::*;

/// 内存信任库：记录 grant 的入参，撤销按摘要删。
#[derive(Default)]
struct MemoryTrust {
    trusted: Mutex<BTreeSet<String>>,
    granted: Mutex<Vec<(String, Vec<HookTrustGrant>)>>,
    revoked: Mutex<Vec<(String, Option<Vec<String>>)>>,
}

#[async_trait]
impl HookTrust for MemoryTrust {
    async fn load(&self, _identity: &str) -> HookTrustSnapshot {
        HookTrustSnapshot {
            trusted: self.trusted.lock().unwrap().clone(),
            corrupt: false,
        }
    }

    async fn grant(
        &self,
        identity: &str,
        grants: Vec<HookTrustGrant>,
        _now_ms: u64,
    ) -> Result<usize, HookTrustError> {
        let count = grants.len();
        let mut trusted = self.trusted.lock().unwrap();
        for grant in &grants {
            trusted.insert(grant.declaration_digest.clone());
        }
        drop(trusted);
        self.granted
            .lock()
            .unwrap()
            .push((identity.to_owned(), grants));
        Ok(count)
    }

    async fn revoke(
        &self,
        identity: &str,
        digests: Option<&[String]>,
    ) -> Result<usize, HookTrustError> {
        let mut trusted = self.trusted.lock().unwrap();
        let removed = match digests {
            Some(digests) => {
                let mut removed = 0;
                for digest in digests {
                    if trusted.remove(digest) {
                        removed += 1;
                    }
                }
                removed
            }
            None => {
                let removed = trusted.len();
                trusted.clear();
                removed
            }
        };
        drop(trusted);
        self.revoked
            .lock()
            .unwrap()
            .push((identity.to_owned(), digests.map(<[String]>::to_vec)));
        Ok(removed)
    }
}

fn kernel(trust: Option<Arc<MemoryTrust>>, home: &std::path::Path) -> LocalKernel {
    let store = Arc::new(MemoryStore::default());
    let env = Arc::new(nibi_kernel_env_local::LocalEnvironment::new(Some(
        home.to_path_buf(),
    )));
    let kernel = LocalKernel::new(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(env),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: nibi_kernel_api::testing::selection(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    );
    match trust {
        Some(trust) => kernel.with_hook_review(
            nibi_kernel_hooks::node_config::NodeHooks::default(),
            trust,
        ),
        None => kernel,
    }
}

/// 一个有两钩子的 `.nibi/config.json`（一个后台命令钩子、一个 process 钩子）。
async fn workspace_with_hooks() -> (tempfile::TempDir, WorkspaceRef) {
    let dir = tempfile::tempdir().unwrap();
    let dot = dir.path().join(".nibi");
    nibi_kernel_fs::create_dir_all(&dot).await.unwrap();
    nibi_kernel_fs::atomic_write(
        &dot.join("config.json"),
        serde_json::json!({
            "hooks": {
                "enabled": true,
                "events": {
                    "PreToolUse": [{
                        "matcher": "Bash|Write",
                        "hooks": [
                            {"type": "command", "command": "guard.sh", "async": true},
                            {"type": "process", "command": "node", "args": ["check.js"]}
                        ]
                    }]
                }
            }
        })
        .to_string()
        .as_bytes(),
        nibi_kernel_fs::WriteOptions {
            mode: nibi_kernel_fs::FileMode::Default,
            temp_name: nibi_kernel_fs::TempName::Visible,
            parent: nibi_kernel_fs::ParentDir::Create,
            rename_retry: &[],
        },
    )
    .await
    .unwrap();
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(dir.path().to_string_lossy()),
    };
    (dir, workspace)
}

#[tokio::test]
async fn the_review_reads_the_project_file_and_pending_turns_trusted_after_grant() {
    let (dir, workspace) = workspace_with_hooks().await;
    let trust = Arc::new(MemoryTrust::default());
    let kernel = kernel(Some(trust.clone()), dir.path());
    let review = kernel.workspace_hook_review(&workspace).await.unwrap();
    assert_eq!(review.identity, workspace.root.as_str());
    assert_eq!(review.pending_count(), 2);
    assert_eq!(review.reason_code, "pending_trust");
    assert_eq!(review.bundle_digest.as_deref().map(str::len), Some(64));
    let items = &review.items;
    assert_eq!(items[0].event, "PreToolUse");
    assert_eq!(items[0].matcher.as_deref(), Some("Bash|Write"));
    assert_eq!(items[0].kind, "command");
    assert_eq!(items[0].display_name, "PreToolUse · Bash|Write");
    assert_eq!(items[0].display_command, "guard.sh");
    assert_eq!(items[0].execution_mode, "background");
    assert_eq!(items[0].source_path, ".nibi/config.json");
    assert!(items[0].editable);
    assert_eq!(items[1].display_command, "node check.js");
    assert_eq!(items[1].execution_mode, "foreground");
    assert_eq!(items[1].trust_state, HookTrustState::PendingTrust);
    // 没信任前项目层的 hooks 不运行（快照里没有）。
    assert!(kernel.hooks().await.is_empty());

    // 授权第一条：写盘的是当前快照里的摘要与「at grant」元数据。
    let granted = kernel
        .grant_workspace_hooks(&workspace, std::slice::from_ref(&items[0].review_item_id))
        .await
        .unwrap();
    assert_eq!(granted, 1);
    let recorded = trust.granted.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0, workspace.root.as_str());
    assert_eq!(recorded[0].1[0].declaration_digest, items[0].declaration_digest);
    assert_eq!(recorded[0].1[0].event, "PreToolUse");
    assert_eq!(recorded[0].1[0].matcher.as_deref(), Some("Bash|Write"));
    assert_eq!(recorded[0].1[0].bundle_digest, review.bundle_digest);
    // 授权当场生效：只有已信任的那一条进了 hooks 快照。
    let admitted = kernel.hooks().await;
    assert_eq!(admitted.len(), 1, "{admitted:?}");
    assert_eq!(admitted[0].source, "project");
    assert_eq!(admitted[0].display, "guard.sh");

    // 再读：第一条已信任，第二条仍待审。
    let after = kernel.workspace_hook_review(&workspace).await.unwrap();
    assert_eq!(after.items[0].trust_state, HookTrustState::TrustedPersistent);
    assert_eq!(after.items[1].trust_state, HookTrustState::PendingTrust);
    assert_eq!(after.pending_count(), 1);

    // 撤销：回到待审。
    let revoked = kernel
        .revoke_workspace_hooks(
            &workspace,
            std::slice::from_ref(&items[0].declaration_digest),
        )
        .await
        .unwrap();
    assert_eq!(revoked, 1);
    // 撤销当场生效：项目层的 hooks 又空了。
    assert!(kernel.hooks().await.is_empty());
    let again = kernel.workspace_hook_review(&workspace).await.unwrap();
    assert_eq!(again.items[0].trust_state, HookTrustState::PendingTrust);
    assert_eq!(again.pending_count(), 2);
}

#[tokio::test]
async fn toggling_rewrites_only_the_enabled_field_of_the_editable_config() {
    let (dir, workspace) = workspace_with_hooks().await;
    let kernel = kernel(Some(Arc::new(MemoryTrust::default())), dir.path());
    let before = kernel.workspace_hook_review(&workspace).await.unwrap();
    let toggle_id = before.items[0].review_item_id.clone();
    assert!(before.items[0].configured_enabled);

    kernel
        .set_workspace_hook_enabled(&workspace, &toggle_id, false)
        .await
        .unwrap();
    let path = dir.path().join(".nibi").join("config.json");
    let bytes = nibi_kernel_fs::read_optional(&path).await.unwrap().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    // 只改了第一条的 enabled；第二条没有这个字段（不凭空补）。
    assert_eq!(
        value["hooks"]["events"]["PreToolUse"][0]["hooks"][0]["enabled"],
        serde_json::json!(false)
    );
    assert!(
        value["hooks"]["events"]["PreToolUse"][0]["hooks"][1]
            .get("enabled")
            .is_none()
    );
    let after = kernel.workspace_hook_review(&workspace).await.unwrap();
    assert!(!after.items[0].configured_enabled);
    // bundle 摘要带着启用状态：改开关就是换 bundle（评审流因此要换一代）。
    assert_ne!(after.bundle_digest, before.bundle_digest);

    // 打开：回到原样，摘要也回到原值。
    kernel
        .set_workspace_hook_enabled(&workspace, &toggle_id, true)
        .await
        .unwrap();
    let back = kernel.workspace_hook_review(&workspace).await.unwrap();
    assert!(back.items[0].configured_enabled);
    assert_eq!(back.bundle_digest, before.bundle_digest);
}

#[tokio::test]
async fn an_unknown_review_item_grants_nothing_and_a_workspace_without_hooks_is_not_applicable() {
    let (dir, workspace) = workspace_with_hooks().await;
    let trust = Arc::new(MemoryTrust::default());
    let kernel = kernel(Some(trust.clone()), dir.path());
    let granted = kernel
        .grant_workspace_hooks(&workspace, &["workspace-hook-9-9-9-9".to_owned()])
        .await
        .unwrap();
    assert_eq!(granted, 0);
    assert!(trust.granted.lock().unwrap().is_empty());

    // 没有项目文件的目录：没有可评审项。
    let empty = tempfile::tempdir().unwrap();
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(empty.path().to_string_lossy()),
    };
    let review = kernel.workspace_hook_review(&workspace).await.unwrap();
    assert_eq!(review.reason_code, "not_applicable");
    assert!(review.bundle_digest.is_none());
    assert!(!review.has_pending());
}

#[tokio::test]
async fn a_kernel_without_a_trust_store_stays_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let kernel = kernel(None, dir.path());
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(dir.path().to_string_lossy()),
    };
    let error = kernel.workspace_hook_review(&workspace).await.unwrap_err();
    assert!(matches!(error, KernelError::Unsupported { .. }));
}

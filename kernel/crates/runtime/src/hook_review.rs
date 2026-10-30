//! 工作区钩子评审的内核侧（NIBI `requestWorkspaceHookReview` / `respondWorkspaceHookReview` /
//! `revokeWorkspaceHookTrust`）。
//!
//! 判定在 `rust_cli_hooks::hook_review`（纯函数，digest 与 Node 逐字节一致）；这里只把三样东西接起来：
//! 工作区的项目文件（经执行环境发现，config.md §1）、入口注入的用户层 hooks（默认超时与输出上限）、
//! 入口注入的信任库（`~/.nibi` 的位置由 `StoragePaths` 决定，内核不碰存储根）。
//!
//! 评审流（`reviewFlowId` / `generation` / 交互 / 截止时间）在协议前端；内核只回答"现在是什么状态"
//! 与"信任 / 撤销这些项"。

use std::collections::{BTreeSet, HashSet};

use super::*;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::hook_review::{
    HookTrust, HookTrustError, HookTrustGrant, WorkspaceHookReview,
};

fn trust_failed(error: HookTrustError) -> KernelError {
    match error {
        HookTrustError::Corrupt => KernelError::Failed {
            message: HookTrustError::Corrupt.to_string(),
        },
        HookTrustError::Failed { reason } => KernelError::Failed { message: reason },
    }
}

impl LocalKernel {
    /// 没有接信任库的入口（TUI / `-p`）：三个方法都报 `Unsupported`。
    fn hook_trust(&self) -> Result<&Arc<dyn HookTrust>, KernelError> {
        self.hook_trust.as_ref().ok_or_else(|| KernelError::Unsupported {
            what: "workspace hook review".to_owned(),
        })
    }

    /// 当前快照：项目文件现场发现（没有文件监听，与 Node 的每次评审重建一致），信任集合来自信任库。
    pub(crate) async fn hook_review_snapshot(
        &self,
        workspace: &WorkspaceRef,
    ) -> Result<WorkspaceHookReview, KernelError> {
        let trust = self.hook_trust()?;
        let files =
            rust_cli_hooks::project_config::discover(self.machine.files().as_ref(), workspace).await;
        let identity = workspace.root.as_str();
        let loaded = trust.load(identity).await;
        let trusted: HashSet<String> = loaded.trusted.into_iter().collect();
        Ok(rust_cli_hooks::hook_review::review(
            identity,
            &files,
            self.user_hooks.as_ref(),
            &trusted,
            // 企业策略的持久信任开关还没有来源（Node 的 `workspaceHookPolicy`）：缺省不阻断。
            false,
            loaded.corrupt,
        ))
    }

    /// 按评审项授权：只认当前快照里的 id，其余忽略；返回写入条数。
    pub(crate) async fn grant_hooks(
        &self,
        workspace: &WorkspaceRef,
        review_item_ids: &[String],
    ) -> Result<usize, KernelError> {
        let trust = self.hook_trust()?;
        let review = self.hook_review_snapshot(workspace).await?;
        let wanted: BTreeSet<&str> = review_item_ids.iter().map(String::as_str).collect();
        let grants: Vec<HookTrustGrant> = review
            .items
            .iter()
            .filter(|item| wanted.contains(item.review_item_id.as_str()))
            .map(|item| HookTrustGrant {
                declaration_digest: item.declaration_digest.clone(),
                event: item.event.clone(),
                display_command: item.display_command.clone(),
                source_path: item.source_path.clone(),
                source_discovery_order: item.source_discovery_order,
                matcher: item.matcher.clone(),
                matcher_index: item.matcher_index,
                hook_index: item.hook_index,
                bundle_digest: review.bundle_digest.clone(),
            })
            .collect();
        if grants.is_empty() {
            return Ok(0);
        }
        trust
            .grant(&review.identity, grants, self.ports.clock.now_ms())
            .await
            .map_err(trust_failed)
    }

    /// 按声明摘要撤销（当前快照里已没有的摘要也照样撤销：信任记录与配置是否还在无关）。
    pub(crate) async fn revoke_hooks(
        &self,
        workspace: &WorkspaceRef,
        declaration_digests: &[String],
    ) -> Result<usize, KernelError> {
        let trust = self.hook_trust()?;
        trust
            .revoke(workspace.root.as_str(), Some(declaration_digests))
            .await
            .map_err(trust_failed)
    }
}

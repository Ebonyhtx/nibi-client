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
        let written = trust
            .grant(&review.identity, grants, self.ports.clock.now_ms())
            .await
            .map_err(trust_failed)?;
        self.refresh_admitted_hooks(workspace).await?;
        Ok(written)
    }

    /// 按声明摘要撤销（当前快照里已没有的摘要也照样撤销：信任记录与配置是否还在无关）。
    pub(crate) async fn revoke_hooks(
        &self,
        workspace: &WorkspaceRef,
        declaration_digests: &[String],
    ) -> Result<usize, KernelError> {
        let trust = self.hook_trust()?;
        let removed = trust
            .revoke(workspace.root.as_str(), Some(declaration_digests))
            .await
            .map_err(trust_failed)?;
        self.refresh_admitted_hooks(workspace).await?;
        Ok(removed)
    }

    /// 信任变化后重建项目层的 hooks 快照：新授权的钩子当场开始运行、撤销的当场停掉
    /// （Node 在 admission refresh 里做同一件事）。用户层、命令行层与插件 hooks 不动。
    async fn refresh_admitted_hooks(&self, workspace: &WorkspaceRef) -> Result<(), KernelError> {
        let trust = self.hook_trust()?;
        let files =
            rust_cli_hooks::project_config::discover(self.machine.files().as_ref(), workspace).await;
        let identity = workspace.root.as_str();
        let loaded = trust.load(identity).await;
        let trusted: HashSet<String> = loaded.trusted.into_iter().collect();
        let settings = rust_cli_hooks::hook_review::admitted_for(
            identity,
            &files,
            self.user_hooks.as_ref(),
            &trusted,
        );
        self.hooks.replace_project(settings);
        Ok(())
    }

    /// NIBI `toggleWorkspaceHookReviewItem`：在可编辑的项目配置里改一条钩子的 `enabled`。
    ///
    /// 只改这一个字段（NIBI 的 `writeWorkspaceHookConfiguredToggle`）：写之前用刚读到的文件重新解析，
    /// 声明本体（命令、matcher、序号）与评审时不一致就拒绝——防止评审之后被第三方改动；
    /// 写完整份 JSON（两空格缩进 + 换行，`serde_json` 打开 preserve_order 后与 Node 的
    /// `JSON.stringify(value, null, 2)` 同形）。
    pub(crate) async fn toggle_hook(
        &self,
        workspace: &WorkspaceRef,
        review_item_id: &str,
        enabled: bool,
    ) -> Result<(), KernelError> {
        let mismatch = || KernelError::Failed {
            message: "workspace_hooks_snapshot_mismatch: the workspace hooks changed after the review"
                .to_owned(),
        };
        let review = self.hook_review_snapshot(workspace).await?;
        let item = review
            .items
            .iter()
            .find(|item| item.review_item_id == review_item_id)
            .cloned()
            .ok_or_else(mismatch)?;
        if !item.editable
            || item.source_path != rust_cli_hooks::project_config::DOT_PROJECT_CONFIG
        {
            return Err(mismatch());
        }
        let files =
            rust_cli_hooks::project_config::discover(self.machine.files().as_ref(), workspace).await;
        let file = files
            .iter()
            .find(|file| {
                file.editable
                    && file.kind == rust_cli_hooks::project_config::ProjectKind::DotProjectConfig
                    && rust_cli_hooks::project_config::relative(workspace.root.as_str(), &file.path)
                        == item.source_path
            })
            .ok_or_else(mismatch)?;
        let read = self
            .machine
            .files()
            .read_file(
                workspace,
                rust_cli_kernel_api::env::ReadFile {
                    path: rust_cli_kernel_api::env::EnvPath::new(file.path.clone()),
                },
            )
            .await
            .map_err(|error| KernelError::Failed {
                message: format!("workspace_hooks_config_unreadable: {error}"),
            })?;
        let mut value: serde_json::Value =
            serde_json::from_slice(&read.bytes).map_err(|error| KernelError::Failed {
                message: format!("workspace_hooks_config_unreadable: {error}"),
            })?;
        // 守卫：磁盘上的声明与评审时看到的是同一条（命令与 matcher 都要对上）。
        let (hooks, _) = rust_cli_hooks::node_config::NodeHooks::from_json(&value["hooks"]);
        let current = hooks
            .events
            .iter()
            .find(|(event, _)| event.as_str() == item.event)
            .and_then(|(_, matchers)| matchers.get(item.matcher_index))
            .filter(|matcher| matcher.matcher == item.matcher)
            .and_then(|matcher| matcher.hooks.get(item.hook_index))
            .ok_or_else(mismatch)?;
        if current.display() != item.display_command {
            return Err(mismatch());
        }
        let declaration = value
            .get_mut("hooks")
            .and_then(|hooks| hooks.get_mut("events"))
            .and_then(|events| events.get_mut(item.event.as_str()))
            .and_then(serde_json::Value::as_array_mut)
            .and_then(|matchers| matchers.get_mut(item.matcher_index))
            .and_then(|matcher| matcher.get_mut("hooks"))
            .and_then(serde_json::Value::as_array_mut)
            .and_then(|hooks| hooks.get_mut(item.hook_index))
            .ok_or_else(mismatch)?;
        declaration["enabled"] = serde_json::json!(enabled);
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&value).map_err(|error| KernelError::Failed {
                message: format!("workspace_hooks_config_write_failed: {error}"),
            })?
        );
        let context = rust_cli_kernel_api::env::OperationContext {
            environment: workspace.environment.clone(),
            generation: self.generation.clone(),
            owner_epoch: OwnerEpoch::LOCAL,
            operation: self.ports.ids.operation(),
            origin: rust_cli_kernel_api::env::Origin::User { session: None },
        };
        self.machine
            .files()
            .put_file(
                workspace,
                context,
                rust_cli_kernel_api::env_files::PutFile {
                    path: rust_cli_kernel_api::env::EnvPath::new(file.path.clone()),
                    bytes: text.into_bytes(),
                    precondition: rust_cli_kernel_api::env::WritePrecondition::Any,
                    create_parents: false,
                },
            )
            .await
            .map_err(|error| KernelError::Failed {
                message: format!("workspace_hooks_config_write_failed: {error}"),
            })?;
        self.refresh_admitted_hooks(workspace).await?;
        Ok(())
    }
}

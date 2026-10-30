//! 工作区钩子的评审快照（NIBI `requestWorkspaceHookReview` 的数据来源）。
//!
//! 纯函数：输入是已发现的项目文件、用户层 hooks、信任集合与两个外部判定（信任库损坏、企业策略阻断），
//! 输出 [`WorkspaceHookReview`]（`kernel-api::hook_review`）。这样每条信任状态的判定都能单测，不用起
//! runtime，也不用碰文件系统。
//!
//! 判定顺序与 Node 的 `workspace-hook-trust-evaluation` 一致：策略阻断 > 库损坏 > 无项 > 全信任 > 待审。

use std::collections::HashSet;

use rust_cli_kernel_api::hook_review::{HookTrustState, WorkspaceHookItem, WorkspaceHookReview};

use crate::node_config::{NODE_EVENTS, NodeHook, NodeHooks};
use crate::project_config::{ProjectFile, relative};
use crate::workspace_digest::{self, DigestSource};

/// 含 `hooks` 的项目文件与解析出的 hooks；7 个事件以外的事件去掉并记警告。
pub fn candidates<'a>(
    files: &'a [ProjectFile],
    warnings: &mut Vec<String>,
) -> Vec<(&'a ProjectFile, NodeHooks)> {
    let mut found = Vec::new();
    for file in files {
        let Some(value) = file.file.object().and_then(|object| object.get("hooks")) else {
            continue;
        };
        let (mut hooks, parsed) = NodeHooks::from_json(value);
        warnings.extend(parsed.into_iter().map(|w| format!("{}: {w}", file.path)));
        hooks.events.retain(|(event, _)| {
            let kept = NODE_EVENTS.contains(event);
            if !kept {
                warnings.push(format!(
                    "{}: project hooks for {} are not supported (only the Node CLI events can be trusted)",
                    file.path,
                    event.as_str()
                ));
            }
            kept
        });
        found.push((file, hooks));
    }
    found
}

/// digest 的来源（Node `WorkspaceHookSourceInput`）。
pub fn sources<'a>(
    root: &str,
    candidates: &'a [(&ProjectFile, NodeHooks)],
) -> Vec<DigestSource<'a>> {
    candidates
        .iter()
        .map(|(file, hooks)| DigestSource {
            relative_path: relative(root, &file.path),
            discovery_order: file.order,
            kind: file.kind.as_str(),
            explicit: false,
            editable: file.editable,
            hooks,
        })
        .collect()
}

/// 一条钩子的展示名：Node 的 `displayName` 是「事件 · matcher」或事件名，不是命令。
fn display_name(event: &str, matcher: Option<&str>) -> String {
    match matcher {
        Some(matcher) => format!("{event} · {matcher}"),
        None => event.to_owned(),
    }
}

fn kind_name(hook: &NodeHook) -> String {
    match &hook.kind {
        crate::node_config::NodeHookKind::Command { .. } => "command".to_owned(),
        crate::node_config::NodeHookKind::Process { .. } => "process".to_owned(),
    }
}

/// Node 的 `executionMode`：命令钩子带 `async` 时是后台，其余是前台。
fn execution_mode(hook: &NodeHook) -> String {
    match &hook.kind {
        crate::node_config::NodeHookKind::Command { background, .. } if *background => {
            "background".to_owned()
        }
        _ => "foreground".to_owned(),
    }
}

/// 一条钩子的信任状态：策略阻断与库损坏优先，其次看信任集合。
fn trust_state(
    trusted: &HashSet<String>,
    digest: &str,
    policy_blocked: bool,
    store_corrupt: bool,
) -> HookTrustState {
    if policy_blocked {
        return HookTrustState::BlockedPolicy;
    }
    if store_corrupt {
        return HookTrustState::PendingTrust;
    }
    if trusted.contains(digest) {
        HookTrustState::TrustedPersistent
    } else {
        HookTrustState::PendingTrust
    }
}

/// 评审快照。`identity` 是工作区身份（NIBI 的 `workspaceIdentity`）。
pub fn review(
    identity: &str,
    files: &[ProjectFile],
    user_hooks: &NodeHooks,
    trusted: &HashSet<String>,
    policy_blocked: bool,
    store_corrupt: bool,
) -> WorkspaceHookReview {
    let mut warnings = Vec::new();
    let found = candidates(files, &mut warnings);
    for warning in &warnings {
        tracing::debug!(%warning, "workspace hook candidate skipped");
    }
    let root = workspace_digest::runtime_root(
        std::iter::once(user_hooks).chain(found.iter().map(|(_, hooks)| hooks)),
    );
    let Some(bundle) = workspace_digest::bundle(&sources(identity, &found), &root) else {
        return WorkspaceHookReview {
            identity: identity.to_owned(),
            bundle_digest: None,
            reason_code: if store_corrupt {
                "trust_store_corrupt".to_owned()
            } else {
                "not_applicable".to_owned()
            },
            items: Vec::new(),
        };
    };
    let items: Vec<WorkspaceHookItem> = bundle
        .entries
        .iter()
        .map(|entry| WorkspaceHookItem {
            review_item_id: entry.review_item_id.clone(),
            event: entry.event.as_str().to_owned(),
            matcher: entry.matcher.clone(),
            kind: kind_name(&entry.hook),
            display_name: display_name(entry.event.as_str(), entry.matcher.as_deref()),
            display_command: entry.hook.display(),
            source_path: entry.source_relative_path.clone(),
            resolved_timeout_ms: entry.resolved_timeout_ms.max(1.0) as u64,
            resolved_max_output_bytes: root.max_output_bytes.max(1.0) as u64,
            execution_mode: execution_mode(&entry.hook),
            configured_enabled: entry.configured_enabled,
            editable: entry.editable,
            trust_state: trust_state(trusted, &entry.digest, policy_blocked, store_corrupt),
            declaration_digest: entry.digest.clone(),
            source_discovery_order: entry.source_discovery_order,
            matcher_index: entry.matcher_index,
            hook_index: entry.hook_index,
        })
        .collect();
    let enabled: Vec<&WorkspaceHookItem> = items.iter().filter(|item| item.configured_enabled).collect();
    let reason_code = if store_corrupt {
        "trust_store_corrupt"
    } else if policy_blocked {
        "blocked_policy"
    } else if enabled.is_empty() {
        "no_enabled_hooks"
    } else if enabled.iter().all(|item| item.trust_state == HookTrustState::TrustedPersistent) {
        "trusted_persistent"
    } else {
        "pending_trust"
    };
    WorkspaceHookReview {
        identity: identity.to_owned(),
        bundle_digest: Some(bundle.bundle_digest),
        reason_code: reason_code.to_owned(),
        items,
    }
}


#[cfg(test)]
#[path = "hook_review_tests.rs"]
mod tests;

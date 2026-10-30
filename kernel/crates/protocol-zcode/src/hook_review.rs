//! 工作区钩子评审的协议侧（NIBI 的 `requestWorkspaceHookReview` / `respondWorkspaceHookReview` /
//! `revokeWorkspaceHookTrust`）：快照来自 [`Kernel::workspace_hook_review`]，评审流
//! （`reviewFlowId` / `generation` / `interactionId` / 截止时间）在这里。
//!
//! 语义对齐 Node 的 `WorkspaceHookReviewController`（`apps/zcode-cli/packages/bootstrap/src/app/
//! workspace-hook-review-controller.ts`）与 core 的 `WorkspaceHookReviewFlowRegistry`：
//!
//! - `reviewFlowId` 每个会话一份，跨 generation 不变；`generation` 单调 +1；每条 generation 一个
//!   `interactionId`，同一会话只留一条待审交互（旧的被替换 = superseded）；
//! - 命令的 target 必须与当前 flow 的 `(reviewFlowId, generation, interactionId)` 和
//!   `(workspaceIdentity, bundleDigest)` 都对上：前者不符是 `workspace_hooks_review_superseded`，
//!   后者不符是 `workspace_hooks_snapshot_mismatch`；
//! - 截止时间是 10 分钟（`WORKSPACE_HOOK_REVIEW_TIMEOUT_MS`）；到期撤掉交互，不回报结算事件
//!   （Host 的投影按同一个 `deadlineAt` 自行收口）。
//!
//! 提示条（`workspaceHookAdmission`）在冷打开会话、以及每次评审/授权/撤销之后按当前快照重算：
//! `pendingCount` 只数「启用且待审」的声明（Node admission 的口径）。

use std::sync::Arc;

use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::hook_review::{HookTrustState, WorkspaceHookReview};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::KernelError;
use serde_json::{Value, json};

use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::server::Server;

/// Node `WORKSPACE_HOOK_REVIEW_TIMEOUT_MS`（10 分钟）。
pub const DEADLINE_MS: u64 = 10 * 60 * 1000;

/// 一条评审 generation。命令只认当前这一条。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flow {
    pub review_flow_id: String,
    pub generation: u64,
    pub interaction_id: String,
    pub identity: String,
    pub bundle_digest: String,
    pub remote_session_id: Option<String>,
    pub created_at: u64,
    pub deadline_at: u64,
}

impl Flow {
    fn expired(&self, now: u64) -> bool {
        now >= self.deadline_at
    }

    /// 命令的 target 与这一代对得上（Node `matchesGeneration`）。
    fn matches_generation(&self, payload: &Value) -> bool {
        payload["reviewFlowId"].as_str() == Some(self.review_flow_id.as_str())
            && payload["generation"].as_u64() == Some(self.generation)
            && payload["interactionId"].as_str() == Some(self.interaction_id.as_str())
    }

    /// 命令的 target 与这一代的快照对得上（Node `matchesSnapshot`）。
    fn matches_snapshot(&self, payload: &Value) -> bool {
        payload["sessionId"].as_str().is_some()
            && payload["workspaceIdentity"].as_str() == Some(self.identity.as_str())
            && payload["bundleDigest"].as_str() == Some(self.bundle_digest.as_str())
    }
}

fn refused(command: &str, reason: &str, message: impl Into<String>, revision: u64) -> Ack {
    Ack::refused(command, Status::Rejected, reason, message, revision)
}

/// 内核没有这个能力（信任库没接）：Node 的 `workspace_hooks_require_trust_capable_host`。
fn capability_error(command: &str, error: &KernelError, revision: u64) -> Ack {
    match error {
        KernelError::Unsupported { what } => refused(
            command,
            "workspace_hooks_require_trust_capable_host",
            format!("workspace hook trust is not available: {what}"),
            revision,
        ),
        other => refused(
            command,
            "workspace_hooks_config_unreadable",
            format!("reading the workspace hooks failed: {other}"),
            revision,
        ),
    }
}

fn workspace(server: &Server, live: &Live) -> WorkspaceRef {
    server.workspace(live.workspace())
}

async fn snapshot(server: &Server, live: &Live) -> Result<WorkspaceHookReview, KernelError> {
    server
        .kernel
        .workspace_hook_review(&workspace(server, live))
        .await
}

/// 当前 flow（过期的当作没有：交互已由计时任务撤掉）。
fn current(server: &Server, session: &SessionId) -> Option<Flow> {
    let now = server.context.now();
    server
        .hook_reviews
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(session)
        .filter(|flow| !flow.expired(now))
        .cloned()
}

fn store(server: &Server, session: &SessionId, flow: Flow) {
    server
        .hook_reviews
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(session.clone(), flow);
}

/// 一条新的 generation：新 `interactionId`；`reviewFlowId` 与 generation 沿用上一代并 +1。
fn next_flow(
    server: &Server,
    review: &WorkspaceHookReview,
    remote: Option<&str>,
    previous: Option<&Flow>,
) -> Flow {
    let now = server.context.now();
    Flow {
        review_flow_id: previous.map_or_else(
            || format!("workspace-hook-review:{}", server.context.fresh("flow")),
            |flow| flow.review_flow_id.clone(),
        ),
        generation: previous.map_or(1, |flow| flow.generation + 1),
        interaction_id: format!(
            "workspace-hook-interaction:{}",
            server.context.fresh("review")
        ),
        identity: review.identity.clone(),
        bundle_digest: review.bundle_digest.clone().unwrap_or_default(),
        remote_session_id: remote.map(str::to_owned),
        created_at: now,
        deadline_at: now + DEADLINE_MS,
    }
}

/// 工作区的展示名（NIBI 的 `workspaceLabel`）：路径的最后一段。
fn workspace_label(identity: &str) -> String {
    identity
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|label| !label.is_empty())
        .unwrap_or(identity)
        .to_owned()
}

fn trust_state_name(state: HookTrustState) -> Value {
    serde_json::to_value(state).unwrap_or(Value::Null)
}

/// 评审交互的 payload（NIBI `workspaceHookReviewRequestPayloadSchema`）。
fn request_payload(session: &str, flow: &Flow, review: &WorkspaceHookReview) -> Value {
    let items: Vec<Value> = review
        .items
        .iter()
        .map(|item| {
            let mut value = json!({
                "reviewItemId": item.review_item_id,
                "event": item.event,
                "type": item.kind,
                "displayName": item.display_name,
                "displayCommand": item.display_command,
                "sourcePath": item.source_path,
                "resolvedTimeoutMs": item.resolved_timeout_ms,
                "resolvedMaxOutputBytes": item.resolved_max_output_bytes,
                "executionMode": item.execution_mode,
                "configuredEnabled": item.configured_enabled,
                "editable": item.editable,
                "trustState": trust_state_name(item.trust_state),
            });
            if let Some(matcher) = &item.matcher {
                value["matcher"] = json!(matcher);
            }
            value
        })
        .collect();
    let event_count = items
        .iter()
        .filter_map(|item| item["event"].as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let mut payload = json!({
        "kind": "workspaceHookReview",
        "reviewFlowId": flow.review_flow_id,
        "generation": flow.generation,
        "interactionId": flow.interaction_id,
        "sessionId": session,
        // NIBI 的 taskId/runId 是会话的 agent 任务标识，Host 原样回传；这里用会话 ID。
        "taskId": session,
        "runId": session,
        "workspaceIdentity": flow.identity,
        "workspaceLabel": workspace_label(&flow.identity),
        "bundleDigest": flow.bundle_digest,
        "createdAt": flow.created_at,
        "deadlineAt": flow.deadline_at,
        "sourceFiles": review.sources,
        "summary": {
            "eventCount": event_count,
            "hookCount": items.len(),
            "pendingCount": review.pending_count(),
        },
        "items": items,
        "warningCode": "workspace_hooks_execute_code",
    });
    if let Some(remote) = &flow.remote_session_id {
        payload["remoteSessionId"] = json!(remote);
    }
    payload
}

/// 提示条状态：`pendingCount` 只数启用且待审的声明。
fn admission(review: &WorkspaceHookReview) -> Option<Value> {
    let pending = review.admission_pending_count();
    (pending > 0).then(|| {
        json!({
            "pendingCount": pending,
            "bundleDigest": review.bundle_digest.clone().unwrap_or_default(),
            "workspaceIdentity": review.identity,
        })
    })
}

/// 把快照的提示条状态写进投影（只在真的变了时发增量）。
async fn refresh_admission(live: &Live, review: &WorkspaceHookReview) {
    live.set_hook_admission(admission(review)).await;
}

/// 开一条新的 generation：登记交互、刷新提示条、挂截止计时。
async fn publish(
    server: &Server,
    live: &Arc<Live>,
    session: &str,
    flow: &Flow,
    review: &WorkspaceHookReview,
) {
    live.set_hook_review(request_payload(session, flow, review))
        .await;
    refresh_admission(live, review).await;
    let sink = live.clone();
    let wait = flow.deadline_at.saturating_sub(server.context.now());
    let (id, generation) = (flow.review_flow_id.clone(), flow.generation);
    server.spawner.spawn("hook-review-deadline", async move {
        tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
        sink.expire_hook_review(&id, generation).await;
    });
}

/// 结算当前的 generation，并在仍有待审项时开出下一代（Node `refreshPendingFlow`）。
async fn settle_and_refresh(server: &Server, live: &Arc<Live>, session: &str) {
    let id = SessionId::new(session);
    let Some(flow) = current(server, &id) else {
        return;
    };
    live.settle_hook_review(&flow.interaction_id).await;
    let Ok(review) = snapshot(server, live).await else {
        return;
    };
    refresh_admission(live, &review).await;
    if review.has_pending() {
        let next = next_flow(server, &review, flow.remote_session_id.as_deref(), Some(&flow));
        store(server, &id, next.clone());
        publish(server, live, id.as_str(), &next, &review).await;
    } else {
        server
            .hook_reviews
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
    }
}

/// 冷打开会话时按当前快照填提示条（Node 在 activate 时上报 admission）。
pub async fn refresh_session_admission(server: &Server, live: &Arc<Live>) {
    if let Ok(review) = snapshot(server, live).await {
        refresh_admission(live, &review).await;
    }
}

/// NIBI `requestWorkspaceHookReview`（软门禁：按需开评审流）。
pub async fn request(
    server: &Server,
    live: &Arc<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let command = envelope.command_id.as_str();
    let Some(session) = envelope.session_id.clone() else {
        return refused(
            command,
            "proto.sessionRequired",
            "requestWorkspaceHookReview needs a sessionId",
            revision,
        );
    };
    let payload = &envelope.payload;
    if payload["sessionId"].as_str() != Some(session.as_str()) {
        return refused(
            command,
            "workspace_hooks_snapshot_mismatch",
            "the command targets another session",
            revision,
        );
    }
    let review = match snapshot(server, live).await {
        Ok(review) => review,
        Err(error) => return capability_error(command, &error, revision),
    };
    let identity = payload["workspaceIdentity"].as_str().unwrap_or_default();
    let digest = payload["bundleDigest"].as_str().unwrap_or_default();
    if identity != review.identity
        || Some(digest) != review.bundle_digest.as_deref()
    {
        refresh_admission(live, &review).await;
        return refused(
            command,
            "workspace_hooks_snapshot_mismatch",
            "the workspace hooks changed since the request was made",
            revision,
        );
    }
    if !review.has_pending() {
        refresh_admission(live, &review).await;
        if review.has_blocked_policy() {
            return refused(
                command,
                "workspace_hooks_blocked_by_policy",
                "persistent workspace hook trust is blocked by policy",
                revision,
            );
        }
        if review.reason_code == "trust_store_corrupt" {
            return refused(
                command,
                "workspace_hooks_trust_store_corrupt",
                "the workspace hook trust store is corrupt",
                revision,
            );
        }
        return Ack::accepted(command, revision, None);
    }
    let id = SessionId::new(&session);
    let previous = current(server, &id);
    match previous
        .clone()
        .filter(|flow| Some(flow.bundle_digest.as_str()) == review.bundle_digest.as_deref())
    {
        // 同一份快照已经有一条待审交互：幂等复用，不重发。
        Some(flow) => {
            refresh_admission(live, &review).await;
            store(server, &id, flow);
        }
        None => {
            let flow = next_flow(
                server,
                &review,
                payload["remoteSessionId"].as_str(),
                previous.as_ref(),
            );
            // 旧 generation 的交互先撤掉（superseded）。
            if let Some(old) = &previous {
                live.settle_hook_review(&old.interaction_id).await;
            }
            store(server, &id, flow.clone());
            publish(server, live, &session, &flow, &review).await;
        }
    }
    Ack::accepted(command, revision, None)
}

/// NIBI `respondWorkspaceHookReview`：按选中的评审项授权持久信任。
pub async fn respond(server: &Server, live: &Arc<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let command = envelope.command_id.as_str();
    let Some(session) = envelope.session_id.clone() else {
        return refused(
            command,
            "proto.sessionRequired",
            "respondWorkspaceHookReview needs a sessionId",
            revision,
        );
    };
    let payload = &envelope.payload;
    if payload["sessionId"].as_str() != Some(session.as_str()) {
        return refused(
            command,
            "workspace_hooks_snapshot_mismatch",
            "the command targets another session",
            revision,
        );
    }
    let id = SessionId::new(&session);
    let Some(flow) = current(server, &id) else {
        return refused(
            command,
            "workspace_hooks_review_superseded",
            "the workspace hook review is no longer pending",
            revision,
        );
    };
    if !flow.matches_generation(payload) {
        return refused(
            command,
            "workspace_hooks_review_superseded",
            "a newer workspace hook review replaced this one",
            revision,
        );
    }
    if !flow.matches_snapshot(payload) {
        return refused(
            command,
            "workspace_hooks_snapshot_mismatch",
            "the workspace hooks changed since the review opened",
            revision,
        );
    }
    let review = match snapshot(server, live).await {
        Ok(review) => review,
        Err(error) => return capability_error(command, &error, revision),
    };
    if review.identity != flow.identity
        || review.bundle_digest.as_deref() != Some(flow.bundle_digest.as_str())
    {
        return refused(
            command,
            "workspace_hooks_snapshot_mismatch",
            "the workspace hooks changed since the review opened",
            revision,
        );
    }
    let ids: Vec<String> = payload["decision"]["reviewItemIds"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let known: std::collections::HashSet<&str> = review
        .items
        .iter()
        .map(|item| item.review_item_id.as_str())
        .collect();
    if ids.is_empty() || ids.iter().any(|id| !known.contains(id.as_str())) {
        return refused(
            command,
            "workspace_hooks_snapshot_mismatch",
            "the review items are not part of the current workspace hooks",
            revision,
        );
    }
    if let Err(error) = server
        .kernel
        .grant_workspace_hooks(&workspace(server, live), &ids)
        .await
    {
        return trust_error(command, &error, revision);
    }
    settle_and_refresh(server, live, &session).await;
    Ack::accepted(command, revision, None)
}

/// NIBI `revokeWorkspaceHookTrust` 的两种 target：
/// 评审流内的 `reviewItemIds`，与直接按 `hookDeclarationDigests` 撤销。
pub async fn revoke(server: &Server, live: &Arc<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let command = envelope.command_id.as_str();
    let Some(session) = envelope.session_id.clone() else {
        return refused(
            command,
            "proto.sessionRequired",
            "revokeWorkspaceHookTrust needs a sessionId",
            revision,
        );
    };
    let payload = &envelope.payload;
    if payload["sessionId"].as_str() != Some(session.as_str()) {
        return refused(
            command,
            "workspace_hooks_snapshot_mismatch",
            "the command targets another session",
            revision,
        );
    }
    let id = SessionId::new(&session);
    let review = match snapshot(server, live).await {
        Ok(review) => review,
        Err(error) => return capability_error(command, &error, revision),
    };
    if payload["workspaceIdentity"].as_str() != Some(review.identity.as_str())
        || payload["bundleDigest"].as_str() != review.bundle_digest.as_deref()
    {
        return refused(
            command,
            "workspace_hooks_snapshot_mismatch",
            "the workspace hooks changed since the request was made",
            revision,
        );
    }
    let digests: Vec<String> = if let Some(values) = payload["hookDeclarationDigests"].as_array() {
        // 直接按摘要撤销：摘要必须是当前快照里的声明。
        let values: Vec<String> = values
            .iter()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect();
        let known: std::collections::HashSet<&str> = review
            .items
            .iter()
            .map(|item| item.declaration_digest.as_str())
            .collect();
        if values.is_empty() || values.iter().any(|digest| !known.contains(digest.as_str())) {
            return refused(
                command,
                "workspace_hooks_snapshot_mismatch",
                "the digests are not part of the current workspace hooks",
                revision,
            );
        }
        values
    } else {
        // 评审流内撤销：target 必须对得上当前这一代。
        let Some(flow) = current(server, &id) else {
            return refused(
                command,
                "workspace_hooks_review_superseded",
                "the workspace hook review is no longer pending",
                revision,
            );
        };
        if !flow.matches_generation(payload) {
            return refused(
                command,
                "workspace_hooks_review_superseded",
                "a newer workspace hook review replaced this one",
                revision,
            );
        }
        if !flow.matches_snapshot(payload) {
            return refused(
                command,
                "workspace_hooks_snapshot_mismatch",
                "the workspace hooks changed since the review opened",
                revision,
            );
        }
        let ids: Vec<&str> = payload["reviewItemIds"]
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let digests: Vec<String> = review
            .items
            .iter()
            .filter(|item| ids.contains(&item.review_item_id.as_str()))
            .map(|item| item.declaration_digest.clone())
            .collect();
        if digests.len() != ids.len() || digests.is_empty() {
            return refused(
                command,
                "workspace_hooks_snapshot_mismatch",
                "the review items are not part of the current workspace hooks",
                revision,
            );
        }
        digests
    };
    if let Err(error) = server
        .kernel
        .revoke_workspace_hooks(&workspace(server, live), &digests)
        .await
    {
        return trust_error(command, &error, revision);
    }
    settle_and_refresh(server, live, &session).await;
    Ack::accepted(command, revision, None)
}

fn trust_error(command: &str, error: &KernelError, revision: u64) -> Ack {
    let message = error.to_string();
    let reason = if message.contains("workspace_hooks_trust_store_corrupt") {
        "workspace_hooks_trust_store_corrupt"
    } else {
        "workspace_hooks_config_write_failed"
    };
    refused(command, reason, message, revision)
}

#[cfg(test)]
#[path = "hook_review_tests.rs"]
mod tests;

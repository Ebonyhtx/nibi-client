//! 订阅（docs/specs/rust-cli/app-protocol.md §6）：`v4/conversation/subscribe` / `unsubscribe` / `resync`、
//! `v4/connection/flow` 与 `v4/sessionsIndex/reconcile`。P1 只有 desktop-continuous：回复只有 ACK（mode 一律 snapshot），
//! 首帧在回复之后发；resync 一律回快照。

use std::sync::Arc;

use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::ids::{CommandId, SessionId};
use rust_cli_kernel_api::session_api::{Command, CommandEnvelope};
use rust_cli_kernel_api::store::SessionFilter;
use rust_cli_protocol_core::connection::Reply;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::index::{CONFIG_PREFIX, INDEX_PREFIX, Summary};
use crate::live::{CONVERSATION_PREFIX, Live};
use crate::projection::state::Phase;
use crate::server::{Server, kernel_error};
use crate::wire::Purpose;
use rust_cli_protocol_core::sessions::Bridged;

/// 存储里一个工作区的会话 → 会话列表的行。
async fn stored_rows(server: &Server, workspace: &str) -> Vec<Value> {
    let filter = SessionFilter {
        workspace: server.workspace(workspace),
        limit: 200,
    };
    match server.kernel.workspace_sessions(filter).await {
        Ok(sessions) => sessions
            .into_iter()
            .map(|session| {
                let summary = &session.summary;
                Summary {
                    session: summary.id.as_str(),
                    workspace,
                    title: &summary.title,
                    phase: Phase::CompletedSuccess,
                    created_at: summary.updated_at_ms,
                    activity_at: summary.updated_at_ms,
                    last_reply: session.last_reply.as_deref(),
                    permissions: 0,
                }
                .to_value()
            })
            .collect(),
        Err(error) => {
            tracing::warn!(event = "protocol.index.read_failed", error = %error, "listing the workspace sessions failed");
            Vec::new()
        }
    }
}

/// 冷打开的恢复提示（NIBI Host 的 `conversation/subscribe` 参数）：`additionalDirectories` 是会话的
/// 附加工作目录（判决链与环境段按会话取），`resumeThoughtLevel` 是旧会话的思考档位暗示（task index 的
/// 权威值），与持久化的选择不同时改一次。
///
/// 两者都只在不改错的地方 warn，不让订阅失败（Node 的冷恢复同样尽力而为）。
async fn apply_resume_hints(server: &Server, live: &Arc<Bridged<Live>>, params: &Value) {
    if let Some(dirs) = params["additionalDirectories"].as_array() {
        let directories: Vec<EnvPath> = dirs
            .iter()
            .filter_map(Value::as_str)
            .map(EnvPath::new)
            .collect();
        if let Err(error) = server
            .kernel
            .set_session_directories(live.handle.id(), directories)
            .await
        {
            tracing::warn!(
                event = "protocol.subscribe.additional_directories_failed",
                session = %live.handle.id(),
                error = %error,
                "the kernel refused the resume additional directories"
            );
        }
    }
    let Some(thought) = params["resumeThoughtLevel"].as_str() else {
        return;
    };
    let Ok(view) = live.handle.view().await else {
        return;
    };
    if view.selection.reasoning.as_deref() == Some(thought) {
        return;
    }
    let mut selection = view.selection;
    selection.reasoning = Some(thought.to_owned());
    let envelope = CommandEnvelope {
        id: CommandId::new(format!("subscribe:{}:thought", live.handle.id().as_str())),
        command: Command::SetModel { selection },
    };
    if let rust_cli_kernel_api::session_api::Ack::Rejected { reason } =
        live.handle.send(envelope).await
    {
        tracing::warn!(
            event = "protocol.subscribe.resume_thought_rejected",
            session = %live.handle.id(),
            reason = %reason,
            "the kernel rejected the resumed thought level"
        );
    }
}

fn ack(subscription: &str, epoch: &str) -> Value {
    json!({"ack": {"subscriptionId": subscription, "mode": "snapshot", "logEpoch": epoch}})
}

pub async fn subscribe(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let topic = params["topic"].as_str().unwrap_or_default().to_owned();
    let connection = params["connectionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if let Some(session) = topic.strip_prefix(CONVERSATION_PREFIX) {
        let id = SessionId::new(session);
        // 冷打开（Host 的 `resumePersistedSession` 路径）：subscribe 带来的两个恢复提示只在冷打开时应用
        // （schema 注释：live conversation 不消费）。Live 会话在内存表里，`get` 直接给句柄。
        let cold = server.bridge.get(&id).is_none();
        let live = server.live(&id).await.map_err(|error| kernel_error(&error))?;
        if cold {
            apply_resume_hints(server, &live, params).await;
            // 冷打开的会话按当前快照上报工作区钩子的提示条（Node 在 activate 时上报 admission）。
            crate::hook_review::refresh_session_admission(server, &live.sink).await;
        }
        let subscription = server.context.fresh("sub");
        let epoch = live.sink.subscribe(&subscription, &connection);
        return Ok(Reply::then(
            ack(&subscription, &epoch),
            start_on_pump(live, subscription, Purpose::Initial),
        ));
    }
    let index = topic.strip_prefix(INDEX_PREFIX);
    if index.is_none() && !topic.starts_with(CONFIG_PREFIX) {
        return Err(RpcError::invalid_params(format!("unknown topic {topic}")));
    }
    let stored = match index {
        Some(workspace) => stored_rows(server, workspace).await,
        None => Vec::new(),
    };
    let subscription = server
        .context
        .fresh(if index.is_some() { "six" } else { "wcs" });
    let epoch = server.topics.subscribe(&topic, &subscription, &connection);
    let topics = server.topics.clone();
    let id = subscription.clone();
    Ok(Reply::then(
        ack(&subscription, &epoch),
        Box::new(move || {
            topics.start(topic, id, stored, Purpose::Initial);
            Box::pin(async {})
        }),
    ))
}

pub async fn unsubscribe(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let topic = params["topic"].as_str().unwrap_or_default();
    let subscription = params["subscriptionId"].as_str().unwrap_or_default();
    if let Some(session) = topic.strip_prefix(CONVERSATION_PREFIX) {
        if let Some(live) = server.bridge.get(&SessionId::new(session)) {
            live.sink.unsubscribe(subscription);
        }
    } else {
        server.topics.unsubscribe(topic, subscription);
    }
    Ok(Reply::new(json!({})))
}

/// 重新同步：P1 一律回快照（续传在 P2）。
pub async fn resync(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let topic = params["topic"].as_str().unwrap_or_default().to_owned();
    let subscription = params["subscriptionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let gone = || RpcError::invalid_params(format!("unknown subscription {subscription}"));
    if let Some(session) = topic.strip_prefix(CONVERSATION_PREFIX) {
        let live = server
            .bridge
            .get(&SessionId::new(session))
            .ok_or_else(gone)?;
        let epoch = live.sink.restart(&subscription).ok_or_else(gone)?;
        return Ok(Reply::then(
            ack(&subscription, &epoch),
            start_on_pump(live, subscription, Purpose::Recovery),
        ));
    }
    let epoch = server
        .topics
        .restart(&topic, &subscription)
        .ok_or_else(gone)?;
    let stored = match topic.strip_prefix(INDEX_PREFIX) {
        Some(workspace) => stored_rows(server, workspace).await,
        None => Vec::new(),
    };
    let topics = server.topics.clone();
    let id = subscription.clone();
    Ok(Reply::then(
        ack(&subscription, &epoch),
        Box::new(move || {
            topics.start(topic, id, stored, Purpose::Recovery);
            Box::pin(async {})
        }),
    ))
}

/// 下游背压：P1 只在 closed 时去掉这条连接的订阅（暂停与恢复在 P2）。
pub async fn flow(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    if params["state"] == "closed" {
        let connection = params["connectionId"].as_str().unwrap_or_default();
        server.topics.drop_connection(connection);
        for live in server.bridge.sessions() {
            live.sink.drop_connection(connection);
        }
    }
    Ok(Reply::new(json!({})))
}

/// 会话列表对账：按 sessionIds 回存在与否、标题与时间。
pub async fn reconcile(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let workspace = params["workspaceId"].as_str().unwrap_or_default();
    let ids: Vec<&str> = params["sessionIds"]
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut sessions = Vec::new();
    for id in ids {
        let session = SessionId::new(id);
        let row = match server.bridge.get(&session) {
            Some(live) => Some(live.sink.summary()),
            None => match server.kernel.session_snapshot(&session).await {
                Ok(view) => Some(
                    Summary {
                        session: id,
                        workspace,
                        title: &view.meta.title,
                        phase: Phase::CompletedSuccess,
                        created_at: view.meta.created_at_ms,
                        activity_at: view.meta.created_at_ms,
                        last_reply: None,
                        permissions: 0,
                    }
                    .to_value(),
                ),
                Err(_) => None,
            },
        };
        sessions.push(match row {
            Some(row) => {
                let mut entry = json!({
                    "sessionId": id,
                    "exists": true,
                    "deleted": false,
                    "title": row["title"],
                    "titleSource": row["titleSource"],
                    "createdAt": row["createdAt"],
                    "updatedAt": row["lastActivityAt"],
                });
                if let Some(outcome) = row.get("lastOutcome") {
                    entry["lastOutcome"] = outcome.clone();
                }
                entry
            }
            None => json!({"sessionId": id, "exists": false, "deleted": false}),
        });
    }
    Ok(Reply::new(json!({"sessions": sessions})))
}

/// 新建的会话马上进会话列表（在会话的泵任务里发）。
pub fn announce(live: &Arc<Bridged<Live>>) {
    let sink = live.sink.clone();
    live.run(Box::pin(async move { sink.publish_summary().await }));
}

/// 回复之后在会话的泵任务里发首帧（排在已经收到的事件之后）。
fn start_on_pump(
    live: Arc<Bridged<Live>>,
    subscription: String,
    purpose: Purpose,
) -> rust_cli_protocol_core::connection::After {
    Box::new(move || {
        let sink = live.sink.clone();
        live.run(Box::pin(
            async move { sink.start(&subscription, purpose).await },
        ));
        Box::pin(async {})
    })
}

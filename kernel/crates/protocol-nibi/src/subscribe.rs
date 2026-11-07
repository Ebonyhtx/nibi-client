//! 订阅（docs/specs/rust-cli/app-protocol.md §6）：`v4/conversation/subscribe` / `unsubscribe` / `resync`、
//! `v4/connection/flow` 与 `v4/sessionsIndex/reconcile`。
//!
//! 续传按 Node 的判据：`base.logEpoch` 是本进程这一代、`base.seq` 在保留窗内 → `mode: "resume"` 并补发
//! `(base.seq, current]`；否则回 `mode: "snapshot"`。`resync` 同样优先续传（`forceSnapshot` 时一律快照）。
//! 背压按 `saturated` / `drained` / `closed` 三态处理。

use std::sync::Arc;

use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::ids::{CommandId, SessionId};
use nibi_kernel_api::session_api::{Command, CommandEnvelope};
use nibi_kernel_api::store::SessionFilter;
use nibi_kernel_protocol_core::connection::Reply;
use nibi_kernel_protocol_core::rpc::RpcError;
use nibi_kernel_protocol_core::sessions::SessionSink as _;
use serde_json::{Value, json};

use crate::index::{CONFIG_PREFIX, INDEX_PREFIX, Summary};
use crate::live::{CONVERSATION_PREFIX, Live};
use crate::projection::state::Phase;
use crate::server::{Server, kernel_error};
use crate::wire::Purpose;
use nibi_kernel_protocol_core::sessions::Bridged;

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
                    pending: &[],
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
    if let nibi_kernel_api::session_api::Ack::Rejected { reason } =
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

fn ack(subscription: &str, epoch: &str, mode: &str) -> Value {
    json!({"ack": {"subscriptionId": subscription, "mode": mode, "logEpoch": epoch}})
}

/// 客户端带上来的水位（`subscribe` 的 `base`；`resync` 的同名字段可为 null）。
fn base(params: &Value) -> Option<(&str, u64)> {
    let base = params.get("base")?;
    Some((base.get("logEpoch")?.as_str()?, base.get("seq")?.as_u64()?))
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
            // 分享导入的本地状态（NIBI 快照的 `sharedContextImport`）：从 session_entry 种子进来。
            if let Ok(Some(import)) = server.kernel.shared_context_import(&id).await
                && let Ok(value) = serde_json::to_value(import)
            {
                live.sink.seed_shared_context_import(Some(value));
            }
        }
        let subscription = server.context.fresh("sub");
        let epoch = live.sink.subscribe(&subscription, &connection);
        // 水位有效才续传；否则回快照（Node `subscribeReserved` 的 resumable 判据）。
        if let Some((base_epoch, seq)) = base(params)
            && let Some(resumed) = live.sink.resume(&subscription, base_epoch, seq)
        {
            return Ok(match resumed {
                Some((from, to, deltas)) => Reply::then(
                    ack(&subscription, &epoch, "resume"),
                    resume_on_pump(live, subscription, from, to, deltas),
                ),
                None => Reply::new(ack(&subscription, &epoch, "resume")),
            });
        }
        return Ok(Reply::then(
            ack(&subscription, &epoch, "snapshot"),
            start_on_pump(live, subscription, Purpose::Initial),
        ));
    }
    let index = topic.strip_prefix(INDEX_PREFIX);
    if index.is_none() && !topic.starts_with(CONFIG_PREFIX) {
        return Err(RpcError::invalid_params(format!("unknown topic {topic}")));
    }
    let subscription = server
        .context
        .fresh(if index.is_some() { "six" } else { "wcs" });
    let epoch = server.topics.subscribe(&topic, &subscription, &connection);
    if let Some((base_epoch, seq)) = base(params)
        && let Some(resumed) = server.topics.resume(&topic, &subscription, base_epoch, seq)
    {
        return Ok(match resumed {
            Some(frame) => {
                server.topics.send(frame);
                Reply::new(ack(&subscription, &epoch, "resume"))
            }
            None => Reply::new(ack(&subscription, &epoch, "resume")),
        });
    }
    let stored = match index {
        Some(workspace) => stored_rows(server, workspace).await,
        None => Vec::new(),
    };
    let topics = server.topics.clone();
    let id = subscription.clone();
    let topic_for_job = topic.clone();
    Ok(Reply::then(
        ack(&subscription, &epoch, "snapshot"),
        Box::new(move || {
            topics.start(topic_for_job, id, stored, Purpose::Initial);
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

/// 重新同步：`base` 有效且没要求强制快照时续传，否则回快照（Node `resyncReserved`）。
pub async fn resync(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let topic = params["topic"].as_str().unwrap_or_default().to_owned();
    let subscription = params["subscriptionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let gone = || RpcError::invalid_params(format!("unknown subscription {subscription}"));
    let force = params["forceSnapshot"].as_bool().unwrap_or(false);
    if let Some(session) = topic.strip_prefix(CONVERSATION_PREFIX) {
        let live = server
            .bridge
            .get(&SessionId::new(session))
            .ok_or_else(gone)?;
        if !force
            && let Some((base_epoch, seq)) = base(params)
            && let Some(resumed) = live.sink.resume(&subscription, base_epoch, seq)
        {
            let epoch = live.sink.epoch();
            return Ok(match resumed {
                Some((from, to, deltas)) => Reply::then(
                    ack(&subscription, &epoch, "resume"),
                    resume_on_pump(live, subscription, from, to, deltas),
                ),
                None => Reply::new(ack(&subscription, &epoch, "resume")),
            });
        }
        let epoch = live.sink.restart(&subscription).ok_or_else(gone)?;
        return Ok(Reply::then(
            ack(&subscription, &epoch, "snapshot"),
            start_on_pump(live, subscription, Purpose::Recovery),
        ));
    }
    let epoch = server.topics.epoch(&topic).ok_or_else(gone)?;
    if !force
        && let Some((base_epoch, seq)) = base(params)
        && let Some(resumed) = server.topics.resume(&topic, &subscription, base_epoch, seq)
    {
        if let Some(frame) = resumed {
            server.topics.send(frame);
        }
        return Ok(Reply::new(ack(&subscription, &epoch, "resume")));
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
    let topic_for_job = topic.clone();
    Ok(Reply::then(
        ack(&subscription, &epoch, "snapshot"),
        Box::new(move || {
            topics.start(topic_for_job, id, stored, Purpose::Recovery);
            Box::pin(async {})
        }),
    ))
}

/// 下游背压（Node `setConnectionFlowState`）：`saturated` 暂停这条连接的投递（订阅与位置保留），
/// `drained` 恢复并补发暂停期间攒下的增量，`closed` 去掉这条连接的全部订阅。
pub async fn flow(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let connection = params["connectionId"].as_str().unwrap_or_default();
    match params["state"].as_str() {
        Some("saturated") => {
            server.context.set_connection_paused(connection, true);
        }
        Some("drained") => {
            server.context.set_connection_paused(connection, false);
            // 暂停期间的位置没动：会话主题在自己的泵里补发，工作区主题走单写者。
            for live in server.bridge.sessions() {
                let sink = live.sink.clone();
                live.run(Box::pin(async move { sink.flush().await }));
            }
            server.topics.flush_all();
        }
        Some("closed") => {
            server.context.set_connection_paused(connection, false);
            server.topics.drop_connection(connection);
            for live in server.bridge.sessions() {
                live.sink.drop_connection(connection);
            }
            // 附件事务的暂存按连接隔离（Host `clearConnection`）：连接断了，这个连接的半截上传与
            // 已提交记录都不再有用。
            server
                .uploads
                .with(|table| table.clear_connection(connection));
        }
        _ => {}
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
                        pending: &[],
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
) -> nibi_kernel_protocol_core::connection::After {
    Box::new(move || {
        let sink = live.sink.clone();
        live.run(Box::pin(
            async move { sink.start(&subscription, purpose).await },
        ));
        Box::pin(async {})
    })
}

/// 回复之后在会话的泵任务里补发续传的那一段（与首帧同一条写路径，不交叠）。
fn resume_on_pump(
    live: Arc<Bridged<Live>>,
    subscription: String,
    from: u64,
    to: u64,
    deltas: Vec<Value>,
) -> nibi_kernel_protocol_core::connection::After {
    Box::new(move || {
        let sink = live.sink.clone();
        live.run(Box::pin(async move {
            sink.send_resume(&subscription, from, to, deltas).await;
        }));
        Box::pin(async {})
    })
}

#[cfg(test)]
#[path = "subscribe_tests.rs"]
mod tests;

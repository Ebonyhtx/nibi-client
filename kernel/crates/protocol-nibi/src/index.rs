//! 会话列表（`sessions-index/<workspaceId>`）与工作区配置（`workspace-config/<workspaceId>`）两种主题的发布者。
//!
//! 会话列表的快照 = 存储里这个工作区的会话 + 本进程打开着的会话的实时行；之后每次实时行变了发一个 `session.upserted`。
//! 工作区配置在 P1 只有快照（配置项与斜杠命令为空，斜杠命令由 `workspace/readPresentation` 给）。

use std::collections::HashMap;
use std::sync::Arc;

use nibi_kernel_protocol_core::delivery::TopicLog;
use serde_json::{Value, json};
use std::sync::{Mutex, MutexGuard, PoisonError};

use nibi_kernel_protocol_core::serial::Serial;

use crate::context::Context;
use crate::projection::state::Phase;
use crate::wire::Purpose;

pub const INDEX_PREFIX: &str = "sessions-index/";
pub const CONFIG_PREFIX: &str = "workspace-config/";

/// 会话列表的一行（`sessionSummarySchema`）。
pub struct Summary<'a> {
    pub session: &'a str,
    pub workspace: &'a str,
    pub title: &'a str,
    pub phase: Phase,
    pub created_at: u64,
    pub activity_at: u64,
    pub last_reply: Option<&'a str>,
    /// 待答交互（权限 / 提问）：侧栏据此显示徽标、工具身份与自动结束倒计时。
    pub pending: &'a [Value],
}

impl Summary<'_> {
    pub fn to_value(&self) -> Value {
        let mut row = json!({
            "sessionId": self.session,
            "workspaceId": self.workspace,
            "title": self.title,
            "titleSource": if self.title.is_empty() { "default" } else { "generated" },
            "phase": self.phase.name(),
            "sessionEnded": self.phase.ended(),
            "hasBackgroundWork": false,
            "lastActivityAt": self.activity_at,
            "createdAt": self.created_at,
        });
        let outcome = match self.phase {
            Phase::CompletedSuccess => Some("completed"),
            Phase::CompletedInterrupted => Some("interrupted"),
            Phase::Error => Some("error"),
            Phase::Draft | Phase::Running => None,
        };
        if let Some(outcome) = outcome {
            row["lastOutcome"] = json!(outcome);
        }
        if let Some(reply) = self.last_reply.filter(|reply| !reply.is_empty()) {
            let preview: String = reply.chars().take(200).collect();
            row["lastAssistantPreview"] = json!(preview);
        }
        // 侧栏只要轻量身份：不下发问题、命令或答案，也不带工作区钩子评审（它归 Hooks 设置页）。
        let queued: Vec<&Value> = self
            .pending
            .iter()
            .filter(|pending| {
                matches!(
                    pending["payload"]["kind"].as_str(),
                    Some("permission" | "userInput")
                )
            })
            .collect();
        if let Some(first) = queued.first() {
            let mut summary = json!({
                "interactionId": first["interactionId"],
                "kind": first["payload"]["kind"],
            });
            if let Some(tool) = first["payload"]["toolName"].as_str() {
                summary["toolName"] = json!(tool);
            }
            if let Some(auto) = first.get("autoResolution").filter(|auto| !auto.is_null()) {
                summary["autoResolution"] = auto.clone();
            }
            row["pendingInteraction"] = summary;
        }
        let permissions = queued
            .iter()
            .filter(|pending| pending["payload"]["kind"] == "permission")
            .count();
        let user_inputs = queued.len() - permissions;
        if permissions > 0 || user_inputs > 0 {
            row["pendingInteractionSummary"] =
                json!({"permissionCount": permissions, "userInputCount": user_inputs});
        }
        row
    }
}

/// Node `SessionsIndexPublisher.maxDeltaLog`：工作区主题保留最近多少帧供续传。
const INDEX_RETENTION: usize = 512;

struct Published {
    log: TopicLog<Value>,
    /// 实时行（会话 ID → 最新的行）。
    rows: HashMap<String, Value>,
    /// 最近一次首帧用过的存储行（退化重发快照时按同一份重建，不丢只存在于存储里的会话）。
    seeded: Vec<Value>,
}

/// 一个要写出的逻辑帧（锁里算好，锁外写）。
pub(crate) struct Outgoing {
    topic: String,
    subscription: String,
    range: (u64, u64),
    payload: Value,
    purpose: Purpose,
}

/// 两种工作区级主题的发布者。登记与去掉订阅直接改表；发帧的工作（首帧、实时行）经单写者按顺序做。
pub struct Topics {
    context: Arc<Context>,
    published: Mutex<HashMap<String, Published>>,
    serial: Serial,
}

impl Topics {
    pub fn new(context: Arc<Context>, spawner: &nibi_kernel_base::Spawner) -> Self {
        Self {
            context,
            published: Mutex::new(HashMap::new()),
            serial: Serial::new(spawner, "index-topics"),
        }
    }

    fn table(&self) -> MutexGuard<'_, HashMap<String, Published>> {
        self.published
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn entry<'a>(
        context: &Context,
        table: &'a mut HashMap<String, Published>,
        topic: &str,
    ) -> &'a mut Published {
        table.entry(topic.to_owned()).or_insert_with(|| Published {
            // Node `SessionsIndexPublisher.maxDeltaLog`：工作区主题的重放缓冲更小，溢出退化为快照。
            log: TopicLog::with_retention(context.fresh("epoch"), INDEX_RETENTION),
            rows: HashMap::new(),
            seeded: Vec::new(),
        })
    }

    async fn write(context: &Context, outgoing: Vec<Outgoing>) {
        for frame in outgoing {
            context
                .frame(
                    &frame.topic,
                    &frame.subscription,
                    frame.range,
                    frame.payload,
                    frame.purpose,
                )
                .await;
        }
    }

    /// 登记订阅（还没有首帧），返回主题的代际标识。
    pub fn subscribe(&self, topic: &str, subscription: &str, connection: &str) -> String {
        let mut table = self.table();
        let entry = Self::entry(&self.context, &mut table, topic);
        if let Some(replaced) = entry.log.subscribe(subscription, connection) {
            self.context.forget(&replaced);
        }
        entry.log.epoch().to_owned()
    }

    /// 主题的代际标识（这个主题还没建时为 None）。
    pub fn epoch(&self, topic: &str) -> Option<String> {
        self.table()
            .get(topic)
            .map(|entry| entry.log.epoch().to_owned())
    }

    /// 发首帧（快照，经单写者）。`stored` 是存储里的会话行（会话列表；工作区配置为空），实时行覆盖同一个会话的存储行。
    pub fn start(
        self: &Arc<Self>,
        topic: String,
        subscription: String,
        stored: Vec<Value>,
        purpose: Purpose,
    ) {
        let topics = self.clone();
        self.serial.run(Box::pin(async move {
            let outgoing = topics.snapshot(&topic, &subscription, stored, purpose);
            Self::write(&topics.context, outgoing.into_iter().collect()).await;
        }));
    }

    fn snapshot(
        &self,
        topic: &str,
        subscription: &str,
        stored: Vec<Value>,
        purpose: Purpose,
    ) -> Option<Outgoing> {
        let mut table = self.table();
        let entry = table.get_mut(topic)?;
        let seq = entry.log.start(subscription)?;
        // 记住这一份存储行：之后断档重发快照时按同一份重建，不丢只存在于存储里的会话。
        if !stored.is_empty() {
            entry.seeded = stored.clone();
        }
        let snapshot = Self::payload(entry, topic, stored);
        Some(Outgoing {
            topic: topic.to_owned(),
            subscription: subscription.to_owned(),
            range: (0, seq),
            payload: json!({"kind": "snapshot", "snapshot": snapshot}),
            purpose,
        })
    }

    /// 一个工作区主题的快照正文（首帧与断档重发共用）。
    fn payload(entry: &Published, topic: &str, stored: Vec<Value>) -> Value {
        let workspace = topic
            .strip_prefix(INDEX_PREFIX)
            .or_else(|| topic.strip_prefix(CONFIG_PREFIX))
            .unwrap_or_default();
        if topic.starts_with(INDEX_PREFIX) {
            let mut sessions: Vec<Value> = stored
                .into_iter()
                .filter(|row| {
                    row["sessionId"]
                        .as_str()
                        .is_none_or(|id| !entry.rows.contains_key(id))
                })
                .collect();
            sessions.extend(entry.rows.values().cloned());
            json!({"protocolVersion": 1, "workspaceId": workspace, "logEpoch": entry.log.epoch(),
                "sessions": sessions})
        } else {
            json!({"protocolVersion": 1, "workspaceId": workspace, "logEpoch": entry.log.epoch(),
                "config": {"configOptions": [], "slashCommands": []}})
        }
    }

    /// 续传（`subscribe` / `resync` 带 `base`）：`None` = 不可续传（调用方回快照）；
    /// `Some(None)` = 客户端已在当前序号；`Some(Some(frame))` = 补发这一段。
    pub fn resume(
        &self,
        topic: &str,
        subscription: &str,
        epoch: &str,
        base: u64,
    ) -> Option<Option<Outgoing>> {
        let mut table = self.table();
        let entry = table.get_mut(topic)?;
        let to = entry.log.resume(subscription, epoch, base)?;
        if to == base {
            return Some(None);
        }
        let deltas = entry.log.deltas_after(base);
        if crate::wire::needs_snapshot(&deltas) {
            return None;
        }
        Some(Some(Outgoing {
            topic: topic.to_owned(),
            subscription: subscription.to_owned(),
            range: (base, to),
            payload: json!({"kind": "deltas", "deltas": deltas}),
            purpose: Purpose::Recovery,
        }))
    }

    /// 把一个补发帧交给单写者（与首帧、实时行同序）。
    pub fn send(self: &Arc<Self>, outgoing: Outgoing) {
        let topics = self.clone();
        self.serial.run(Box::pin(async move {
            Self::write(&topics.context, vec![outgoing]).await;
        }));
    }

    /// `drained` 之后补发暂停期间积累的增量（所有主题，经单写者）。
    pub fn flush_all(self: &Arc<Self>) {
        let topics = self.clone();
        self.serial.run(Box::pin(async move {
            let outgoing = {
                let mut table = topics.table();
                table
                    .iter_mut()
                    .flat_map(|(topic, entry)| topics.flush_topic(topic, entry))
                    .collect()
            };
            Self::write(&topics.context, outgoing).await;
        }));
    }

    /// 重新同步：下一次首帧重新取快照。订阅不在时返回 None，否则给代际标识。
    pub fn restart(&self, topic: &str, subscription: &str) -> Option<String> {
        let mut table = self.table();
        let entry = table.get_mut(topic)?;
        entry
            .log
            .restart(subscription)
            .then(|| entry.log.epoch().to_owned())
    }

    pub fn unsubscribe(&self, topic: &str, subscription: &str) -> bool {
        let removed = self
            .table()
            .get_mut(topic)
            .is_some_and(|entry| entry.log.unsubscribe(subscription));
        if removed {
            self.context.forget(subscription);
        }
        removed
    }

    pub fn drop_connection(&self, connection: &str) {
        let mut table = self.table();
        for entry in table.values_mut() {
            for gone in entry.log.drop_connection(connection) {
                self.context.forget(&gone);
            }
        }
    }

    /// 会话列表的一行变了（经单写者）：记下并发给已经开始的订阅者。
    pub fn upsert(self: &Arc<Self>, workspace: &str, row: Value) {
        let topics = self.clone();
        let topic = format!("{INDEX_PREFIX}{workspace}");
        self.serial.run(Box::pin(async move {
            let outgoing = topics.changed(&topic, row);
            Self::write(&topics.context, outgoing).await;
        }));
    }

    fn changed(&self, topic: &str, row: Value) -> Vec<Outgoing> {
        let Some(session) = row["sessionId"].as_str().map(str::to_owned) else {
            return Vec::new();
        };
        let mut table = self.table();
        let entry = Self::entry(&self.context, &mut table, topic);
        if entry.rows.get(&session) == Some(&row) {
            return Vec::new();
        }
        entry.rows.insert(session, row.clone());
        entry
            .log
            .record(vec![json!({"op": "session.upserted", "session": row})]);
        self.flush_topic(topic, entry)
    }

    /// 一个主题的待发增量（暂停的连接跳过）。断档或超过下游缓冲上限时退化重发快照
    /// （Node `SessionsIndexPublisher` 的「溢出/断档退化为 snapshot」，conflated 语义下与续传等价）。
    fn flush_topic(&self, topic: &str, entry: &mut Published) -> Vec<Outgoing> {
        let paused = self.context.paused_connections();
        entry
            .log
            .flush(&paused)
            .into_iter()
            .map(|batch| {
                if crate::wire::needs_snapshot(&batch.deltas) {
                    let snapshot = Self::payload(entry, topic, entry.seeded.clone());
                    Outgoing {
                        topic: topic.to_owned(),
                        subscription: batch.subscription,
                        range: (0, batch.to),
                        payload: json!({"kind": "snapshot", "snapshot": snapshot}),
                        purpose: Purpose::Recovery,
                    }
                } else {
                    Outgoing {
                        topic: topic.to_owned(),
                        subscription: batch.subscription,
                        range: (batch.from, batch.to),
                        payload: json!({"kind": "deltas", "deltas": batch.deltas}),
                        purpose: Purpose::Online,
                    }
                }
            })
            .collect()
    }
}

//! 打开着的会话：会话桥的接收方。每个会话一份投影与一个 `conversation/<sessionId>` 主题；内核事件 → 投影 → 增量，
//! 窗口到期时发给已经开始的订阅者；会话列表的行变了时更新会话列表。
//!
//! 投影与主题日志在一把锁里，只在计算时短暂持有；发帧的工作（事件、窗口、首帧、协议配置的变化）都在会话的泵任务里按
//! 顺序做（protocol-core 的会话桥），所以首帧之后的增量只给一次，首帧与增量不交错。

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use rust_cli_kernel_api::session_api::{SequencedEvent, SessionView};
use rust_cli_protocol_core::delivery::TopicLog;
use rust_cli_protocol_core::sessions::SessionSink;
use serde_json::{Map, Value, json};

use crate::context::Context;
use crate::index::{Summary, Topics};
use crate::projection::state::{Followup, Phase};
use crate::projection::{InputMeta, Projection};
use crate::wire::Purpose;

pub const CONVERSATION_PREFIX: &str = "conversation/";

struct State {
    projection: Projection,
    log: TopicLog<Value>,
    /// 最后一次发出去的会话列表行（活动时间记成 0，不参与比较）。
    summary: Option<Value>,
}

/// 锁里算好、锁外写出的东西：（订阅、区间、payload）与变了的会话列表行。
struct Outgoing {
    frames: Vec<(String, (u64, u64), Value)>,
    summary: Option<Value>,
}

pub struct Live {
    context: Arc<Context>,
    topics: Arc<Topics>,
    session: String,
    workspace: String,
    created_at: u64,
    state: Mutex<State>,
}

impl Live {
    pub fn new(
        context: Arc<Context>,
        topics: Arc<Topics>,
        view: &SessionView,
        followup: Followup,
    ) -> Self {
        let levels = view.selection.reasoning.iter().cloned().collect();
        let epoch = context.fresh("epoch");
        context.register(view.meta.id.as_str(), view.meta.workspace.root.as_str());
        Self {
            session: view.meta.id.as_str().to_owned(),
            workspace: view.meta.workspace.root.as_str().to_owned(),
            created_at: view.meta.created_at_ms,
            state: Mutex::new(State {
                projection: Projection::from_view(view, followup, levels),
                log: TopicLog::new(epoch),
                summary: None,
            }),
            context,
            topics,
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn topic(&self) -> String {
        format!("{CONVERSATION_PREFIX}{}", self.session)
    }

    /// 登记订阅（还没有首帧），返回主题的代际标识。
    pub fn subscribe(&self, subscription: &str, connection: &str) -> String {
        let mut state = self.state();
        if let Some(replaced) = state.log.subscribe(subscription, connection) {
            self.context.forget(&replaced);
        }
        state.log.epoch().to_owned()
    }

    /// 发首帧（当前的快照）。在会话的泵任务里调用（`Bridged::run`）。
    pub async fn start(&self, subscription: &str, purpose: Purpose) {
        let (range, payload) = {
            let mut state = self.state();
            let Some(seq) = state.log.start(subscription) else {
                return;
            };
            let snapshot = state.projection.snapshot(seq, state.log.epoch());
            ((0, seq), json!({"kind": "snapshot", "snapshot": snapshot}))
        };
        self.context
            .frame(&self.topic(), subscription, range, payload, purpose)
            .await;
    }

    /// 重新同步：订阅回到“还没有首帧”。订阅不在时返回 None，否则给代际标识。
    pub fn restart(&self, subscription: &str) -> Option<String> {
        let mut state = self.state();
        state
            .log
            .restart(subscription)
            .then(|| state.log.epoch().to_owned())
    }

    pub fn unsubscribe(&self, subscription: &str) -> bool {
        let removed = self.state().log.unsubscribe(subscription);
        if removed {
            self.context.forget(subscription);
        }
        removed
    }

    pub fn drop_connection(&self, connection: &str) {
        let gone = self.state().log.drop_connection(connection);
        for subscription in gone {
            self.context.forget(&subscription);
        }
    }

    pub fn remember_input(&self, command: &str, meta: InputMeta) {
        self.state().projection.remember_input(command, meta);
    }

    /// 用户拒绝了这个工具调用：之后它的结果投成 cancelled（与 Node 相同）。
    pub fn deny(&self, tool_use: &rust_cli_kernel_api::ids::ToolUseId) {
        self.state().projection.deny(tool_use.as_str());
    }

    pub fn followup(&self) -> Followup {
        self.state().projection.followup()
    }

    /// 投影的阶段与 revision（命令裁决的读数；revision 来自会话 actor）。
    /// 当前主题代际（snapshot 的 `logEpoch`；Host 在 row-targeting 命令里作为 baseLogEpoch 回传）。
    pub fn epoch(&self) -> String {
        self.state().log.epoch().to_owned()
    }

    /// 按 rowId 找投影行（row-targeting 命令的 target 解析）。
    pub fn row(&self, row_id: u64) -> Option<Map<String, Value>> {
        self.state().projection.row(row_id).cloned()
    }

    pub fn status(&self) -> (Phase, u64) {
        let state = self.state();
        (state.projection.phase(), state.projection.revision())
    }

    /// NIBI `setAssistantFeedback`：把赞/踩写进投影（行存在时发 `row.upserted`）。
    pub async fn set_feedback(&self, message: &str, feedback: Option<String>) {
        let outgoing = {
            let mut state = self.state();
            let deltas = state.projection.set_feedback(message, feedback);
            state.log.record(deltas);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// 协议保存的配置变了：记一组增量并发出。在会话的泵任务里调用。
    pub async fn set_followup(&self, followup: Followup) {
        let outgoing = {
            let mut state = self.state();
            let delta = state.projection.set_followup(followup);
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// 会话的工作区根（工作区钩子评审的工作区身份）。
    pub fn workspace(&self) -> &str {
        &self.workspace
    }

    /// NIBI `requestWorkspaceHookReview`：登记待审交互（`pendingInteractions` 增量）。
    pub async fn set_hook_review(&self, request: Value) {
        let outgoing = {
            let mut state = self.state();
            let delta = state.projection.set_hook_review(request);
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// 评审结算：撤掉这条交互（已结算 / 被新的 generation 替换）。
    pub async fn settle_hook_review(&self, interaction_id: &str) {
        let outgoing = {
            let mut state = self.state();
            let Some(delta) = state.projection.settle_hook_review(interaction_id) else {
                return;
            };
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// NIBI 的提示条状态（`workspaceHookAdmission`）：只说真的变了的那次。
    pub async fn set_hook_admission(&self, admission: Option<Value>) {
        let outgoing = {
            let mut state = self.state();
            let Some(delta) = state.projection.set_hook_admission(admission) else {
                return;
            };
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// 评审截止：还是这一代才撤（被替换后新的那一代不受影响）。
    pub async fn expire_hook_review(&self, flow: &str, generation: u64) {
        let outgoing = {
            let mut state = self.state();
            let Some(current) = state.projection.hook_review() else {
                return;
            };
            if current["reviewFlowId"].as_str() != Some(flow)
                || current["generation"].as_u64() != Some(generation)
            {
                return;
            }
            let interaction = current["interactionId"].as_str().unwrap_or_default().to_owned();
            let Some(delta) = state.projection.settle_hook_review(&interaction) else {
                return;
            };
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// 会话列表的当前行。
    pub fn summary(&self) -> Value {
        let state = self.state();
        self.summary_of(&state)
    }

    fn summary_of(&self, state: &State) -> Value {
        let reply = state.projection.last_reply();
        Summary {
            session: &self.session,
            workspace: &self.workspace,
            title: state.projection.title(),
            phase: state.projection.phase(),
            created_at: self.created_at,
            activity_at: self.context.now(),
            last_reply: reply.as_deref(),
            permissions: state.projection.pending_permissions(),
        }
        .to_value()
    }

    /// 待发的增量与变了的会话列表行（阶段、标题、待回答的询问或预览变了才发，活动时间不算）。
    fn collect(&self, state: &mut State) -> Outgoing {
        let frames = state
            .log
            .flush()
            .into_iter()
            .map(|batch| {
                (
                    batch.subscription,
                    (batch.from, batch.to),
                    json!({"kind": "deltas", "deltas": batch.deltas}),
                )
            })
            .collect();
        let row = self.summary_of(state);
        let mut comparable = row.clone();
        comparable["lastActivityAt"] = json!(0);
        let summary = (state.summary.as_ref() != Some(&comparable)).then(|| {
            state.summary = Some(comparable);
            row
        });
        Outgoing { frames, summary }
    }

    async fn write(&self, outgoing: Outgoing) {
        let topic = self.topic();
        for (subscription, range, payload) in outgoing.frames {
            self.context
                .frame(&topic, &subscription, range, payload, Purpose::Online)
                .await;
        }
        if let Some(row) = outgoing.summary {
            self.topics.upsert(&self.workspace, row);
        }
    }

    /// 把当前的会话列表行发出去（建会话之后，列表马上看得到）。在会话的泵任务里调用。
    pub async fn publish_summary(&self) {
        let outgoing = {
            let mut state = self.state();
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }
}

#[async_trait]
impl SessionSink for Live {
    async fn event(&self, event: SequencedEvent) {
        let now = self.context.now();
        let mut state = self.state();
        let deltas = state.projection.apply(&event, now);
        state.log.record(deltas);
    }

    async fn flush(&self) {
        let outgoing = {
            let mut state = self.state();
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }
}

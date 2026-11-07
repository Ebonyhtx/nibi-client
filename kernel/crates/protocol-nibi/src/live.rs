//! 打开着的会话：会话桥的接收方。每个会话一份投影与一个 `conversation/<sessionId>` 主题；内核事件 → 投影 → 增量，
//! 窗口到期时发给已经开始的订阅者；会话列表的行变了时更新会话列表。
//!
//! 投影与主题日志在一把锁里，只在计算时短暂持有；发帧的工作（事件、窗口、首帧、协议配置的变化）都在会话的泵任务里按
//! 顺序做（protocol-core 的会话桥），所以首帧之后的增量只给一次，首帧与增量不交错。

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::session_api::{KernelEvent, SequencedEvent, SessionView, TurnOutcome};
use nibi_kernel_protocol_core::delivery::TopicLog;
use nibi_kernel_protocol_core::sessions::SessionSink;
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
    /// 冷打开的每轮文件摘要已经挂上（只算一次，之后靠 `FileChanges` 事件）。
    summaries: bool,
    /// `v4/telemetry/event` 的事实派生（141 审计 §9 第 5 项余项）。
    telemetry: crate::conversation_telemetry::ConversationTelemetry,
    /// `session/debug` 的累积（开发者工具的网络面与轮次面）。
    debug: crate::session_debug::DebugRecorder,
    /// 待发的通知（方法名 + 载荷；在 `flush` 里一次发完，与逻辑帧同序；流式增量不逐条 await）。
    pending_facts: Vec<(String, Value)>,
    /// 当前回合（CUA 操作事件的 `tool-scheduled` 需要 `turnId`；`TurnStarted` 置、`TurnFinished` 清）。
    current_turn: Option<String>,
}

/// 锁里算好、锁外写出的东西：（订阅、区间、payload）与变了的会话列表行。
struct Outgoing {
    frames: Vec<(String, (u64, u64), Value)>,
    summary: Option<Value>,
}

pub struct Live {
    context: Arc<Context>,
    topics: Arc<Topics>,
    local_ttft: Arc<crate::local_ttft::LocalTtftRecorder>,
    spawner: nibi_kernel_base::Spawner,
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
        local_ttft: Arc<crate::local_ttft::LocalTtftRecorder>,
        spawner: nibi_kernel_base::Spawner,
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
                summaries: false,
                telemetry: crate::conversation_telemetry::ConversationTelemetry::new(
                    view.meta.id.as_str(),
                ),
                debug: crate::session_debug::DebugRecorder::default(),
                pending_facts: Vec::new(),
                current_turn: None,
            }),
            context,
            topics,
            local_ttft,
            spawner,
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
    pub fn deny(&self, tool_use: &nibi_kernel_api::ids::ToolUseId) {
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

    /// 主题日志的序号（只读查询的 `atSeq`：客户端据此丢弃跨代际的陈旧读）。
    pub fn seq(&self) -> u64 {
        self.state().log.seq()
    }

    /// 按 rowId 找投影行（row-targeting 命令的 target 解析）。
    pub fn row(&self, row_id: u64) -> Option<Map<String, Value>> {
        self.state().projection.row(row_id).cloned()
    }

    /// 当前投影的全部行（附件回读的行/序号/引用三重授权要按 `attachments` 找；与快照的窗口同源）。
    pub fn rows(&self) -> Vec<Map<String, Value>> {
        self.state().projection.rows()
    }

    pub fn status(&self) -> (Phase, u64) {
        let state = self.state();
        (state.projection.phase(), state.projection.revision())
    }

    /// 一条只进 live 帧的增量（`pluginUi.*`，141 审计 §9 第 6 项）：不改投影、不进冷恢复。
    pub async fn emit_delta(&self, delta: Value) {
        let outgoing = {
            let mut state = self.state();
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
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

    /// 分享导入的种子（冷打开）：直改投影，不发增量（Node `seedSharedContextImport` 同义）。
    pub fn seed_shared_context_import(&self, value: Option<Value>) {
        self.state()
            .projection
            .seed_shared_context_import(value);
    }

    /// 分享导入的状态变了（`discardSharedContext`）：发一条 `state.updated`。
    pub async fn set_shared_context_import(&self, value: Option<Value>) {
        let outgoing = {
            let mut state = self.state();
            let Some(delta) = state.projection.set_shared_context_import(value) else {
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

    /// 会话所属的工作区根（fork 后补发列表行要用）。
    pub(crate) fn workspace_root(&self) -> &str {
        &self.workspace
    }

    /// 新会话（fork）在存储里创建后补发一次会话列表行。
    ///
    /// sessions-index 的实时行只来自打开过的 Live 会话；fork 不会自动打开子会话，缺这一行
    /// Host 的任务列表要等重启后的快照才看得到。
    pub(crate) fn publish_stored_session(
        &self,
        session: &str,
        title: &str,
        created_at: u64,
        last_reply: Option<&str>,
    ) {
        let row = Summary {
            session,
            workspace: &self.workspace,
            title,
            phase: Phase::CompletedSuccess,
            created_at,
            activity_at: self.context.now(),
            last_reply,
            permissions: 0,
        }
        .to_value();
        self.topics.upsert(&self.workspace, row);
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

    /// 冷打开的每轮文件摘要还没挂（`server.live()` 据此决定要不要读 artifact）。
    pub fn needs_file_summaries(&self) -> bool {
        !self.state().summaries
    }

    /// 冷打开的每轮文件摘要挂到轮头（141 审计 §9 第 2 项余项）。只算一次：之后的写入走
    /// `FileChanges` 事件。读不出 artifact 的回合由会话侧跳过，这里拿到的就是可用的那些。
    pub async fn set_file_summaries(
        &self,
        summaries: &[nibi_kernel_api::file_changes::TurnFileSummary],
    ) {
        let outgoing = {
            let mut state = self.state();
            if state.summaries {
                return;
            }
            state.summaries = true;
            let deltas = state.projection.set_file_summaries(summaries);
            if deltas.is_empty() {
                return;
            }
            state.log.record(deltas);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// 冷打开时用 `dwf_run` 的摘要补种 `workflowRuns`（Node 的冷回放同一入口的轻量版）：
    /// 投影还没有 run 时写入头字段并发一条整键 `state.updated`，首帧快照同时带上它。
    pub async fn seed_workflow_runs(
        &self,
        rows: &[nibi_kernel_api::workflow::WorkflowRunSummaryRow],
    ) {
        let outgoing = {
            let mut state = self.state();
            let Some(value) = state.projection.seed_workflow_runs(rows) else {
                return;
            };
            state.log.record(vec![json!({
                "op": "state.updated",
                "patch": {"workflowRuns": value},
            })]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// 把当前的会话列表行发出去（建会话之后，列表马上看得到）。在会话的泵任务里调用。
    pub async fn publish_summary(&self) {
        let outgoing = {
            let mut state = self.state();
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// 刷新快照的 `subagents` 键（`SessionHandle::subagents()` 的结果）。语义没变时不发帧。
    /// 在会话的泵任务里调用，与事件帧同序。
    pub async fn publish_subagents(&self, entries: &[nibi_kernel_api::panels::SubagentEntry]) {
        let now = self.context.now();
        let outgoing = {
            let mut state = self.state();
            let Some(delta) = state.projection.set_subagents(entries, now) else {
                return;
            };
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// `session/debug` 的当前快照（Host `sessionDebugSnapshotSchema`）。
    pub fn debug_snapshot(&self) -> Value {
        self.state().debug.snapshot(&self.session)
    }

    /// 快照的 `subagents` 键当前值（测试断言投影用；线上只经快照与增量出去）。
    #[cfg(test)]
    pub fn snapshot_for_test(&self) -> Value {
        self.state().projection.snapshot(0, "test")["subagents"].clone()
    }

    /// 直接喂一条内核事件（测试用：不经过会话 actor 的事件流）。
    #[cfg(test)]
    pub async fn event_for_test(&self, event: nibi_kernel_api::session_api::SequencedEvent) {
        <Self as nibi_kernel_protocol_core::sessions::SessionSink>::event(self, event).await;
    }
}

#[async_trait]
impl SessionSink for Live {
    async fn event(&self, event: SequencedEvent) {
        let now = self.context.now();
        // 事实派生与投影在同一把锁里（顺序即事件顺序）；发出在 `flush` 里。
        let mut state = self.state();
        let cua_events = cua_operation_events(
            &self.session,
            &event,
            now,
            state.current_turn.as_deref(),
        );
        match &event.event {
            KernelEvent::TurnStarted { turn, .. } => {
                state.current_turn = Some(turn.as_str().to_owned());
            }
            KernelEvent::TurnFinished { .. } => {
                state.current_turn = None;
            }
            _ => {}
        }
        for payload in cua_events {
            state
                .pending_facts
                .push((CUA_OPERATION_EVENT.to_owned(), payload));
        }
        let turn_finished = matches!(&event.event, KernelEvent::TurnFinished { .. });
        let deltas = state.projection.apply(&event, now);
        state.log.record(deltas);
        if let Some(fact) = state.telemetry.facts(&event, now)
            && let Ok(payload) = serde_json::to_value(fact)
        {
            state
                .pending_facts
                .push((crate::conversation_telemetry::METHOD.to_owned(), payload));
        }
        for fact in self.local_ttft.event(&self.session, &event.event, now) {
            if let Ok(payload) = serde_json::to_value(fact) {
                state
                    .pending_facts
                    .push((crate::local_ttft::METHOD.to_owned(), payload));
            }
        }
        // `session/debug` 的两个面（网络面吃状态事实，轮次面吃结束的回合）。
        match &event.event {
            nibi_kernel_api::session_api::KernelEvent::ModelRequestStatus { status } => {
                state.debug.observe_status(status, now);
            }
            nibi_kernel_api::session_api::KernelEvent::TurnFinished { usage, .. } => {
                state.debug.observe_turn(usage.as_ref(), now);
            }
            _ => {}
        }
        drop(state);
        // 浏览器 broker 的逐轮生命周期：与 Node 一样在 TurnFinished 后发 `turnEnded`。
        if turn_finished
            && let Some(broker) = self.context.browser_broker().cloned()
        {
            let session = self.session.clone();
            drop(self.spawner.spawn("browser-turn-ended", async move {
                broker.turn_ended(&session).await;
            }));
        }
    }

    async fn flush(&self) {
        let (outgoing, facts) = {
            let mut state = self.state();
            let facts = std::mem::take(&mut state.pending_facts);
            (self.collect(&mut state), facts)
        };
        for (method, fact) in facts {
            self.context.notify(&method, &fact).await;
        }
        self.write(outgoing).await;
    }
}

const CUA_OPERATION_EVENT: &str = "computer-use/operation-event";

/// Node `computer-use-operation-event.ts` 的同一张映射：回合/工具事件 → CUA 操作通知。
///
/// 只给 `mcp__node_repl__js` 且源码里出现 `setupComputerUseRuntime` 的调用发 `computerUse`；
/// 其他工具不发（Host 的 tracker 只关心 CUA，Node 侧的非 CUA 工具事件对指示器没有作用）。
fn cua_operation_events(
    session: &str,
    event: &SequencedEvent,
    now: u64,
    current_turn: Option<&str>,
) -> Vec<Value> {
    let base = |kind: &str| {
        json!({
            "eventId": format!("cua-{session}-{}", event.seq),
            "sequenceNumber": event.seq,
            "sessionId": session,
            "timestamp": now,
            "kind": kind,
        })
    };
    match &event.event {
        KernelEvent::TurnStarted { turn, .. } => {
            let mut payload = base("turn-started");
            payload["turnId"] = json!(turn.as_str());
            vec![payload]
        }
        KernelEvent::TurnFinished { turn, outcome, .. } => {
            let kind = match outcome {
                TurnOutcome::Success => "turn-completed",
                TurnOutcome::Interrupted | TurnOutcome::Failed { .. } => "turn-failed",
            };
            let mut payload = base(kind);
            payload["turnId"] = json!(turn.as_str());
            vec![payload]
        }
        KernelEvent::ToolStarted {
            tool_use,
            name,
            input,
        } => {
            if name != "mcp__node_repl__js" || !uses_computer_use(input) {
                return Vec::new();
            }
            let Some(turn) = current_turn else {
                return Vec::new();
            };
            let tool_call_id = tool_use.as_str();
            let mut scheduled = base("tool-scheduled");
            scheduled["eventId"] = json!(format!("cua-{session}-{}-scheduled", event.seq));
            scheduled["turnId"] = json!(turn);
            scheduled["toolCallId"] = json!(tool_call_id);
            scheduled["toolName"] = json!(name);
            scheduled["input"] = input.clone();
            scheduled["computerUse"] = json!(true);
            let mut started = base("tool-started");
            started["eventId"] = json!(format!("cua-{session}-{}-started", event.seq));
            started["turnId"] = json!(turn);
            started["toolCallId"] = json!(tool_call_id);
            started["toolName"] = json!(name);
            vec![scheduled, started]
        }
        _ => Vec::new(),
    }
}

fn uses_computer_use(input: &Value) -> bool {
    input
        .get("code")
        .and_then(Value::as_str)
        .is_some_and(|code| code.contains("setupComputerUseRuntime"))
}

#[cfg(test)]
mod cua_operation_tests {
    use super::*;
    use nibi_kernel_api::ids::{ToolUseId, TurnId};

    #[test]
    fn a_cua_tool_start_emits_scheduled_then_started() {
        let event = SequencedEvent {
            seq: 7,
            revision: 0,
            event: KernelEvent::ToolStarted {
                tool_use: ToolUseId::new("toolu_1"),
                name: "mcp__node_repl__js".to_owned(),
                input: json!({"code": "await setupComputerUseRuntime({ globals });"}),
            },
        };
        let events = cua_operation_events("s1", &event, 1_000, Some("turn-1"));
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["kind"], "tool-scheduled");
        assert_eq!(events[0]["computerUse"], true);
        assert_eq!(events[0]["turnId"], "turn-1");
        assert_eq!(events[0]["toolCallId"], "toolu_1");
        assert_eq!(events[1]["kind"], "tool-started");
        assert_eq!(events[1]["toolCallId"], "toolu_1");
    }

    #[test]
    fn a_non_cua_tool_emits_nothing() {
        let event = SequencedEvent {
            seq: 8,
            revision: 0,
            event: KernelEvent::ToolStarted {
                tool_use: ToolUseId::new("toolu_2"),
                name: "Bash".to_owned(),
                input: json!({"command": "ls"}),
            },
        };
        assert!(cua_operation_events("s1", &event, 1_000, Some("turn-1")).is_empty());
    }

    #[test]
    fn turn_started_carries_the_turn_id() {
        let event = SequencedEvent {
            seq: 9,
            revision: 0,
            event: KernelEvent::TurnStarted {
                turn: TurnId::new("turn-1"),
                command: None,
                execution_kind: None,
                workflow_launch: None,
                input_source: None,
                origin_meta: None,
            },
        };
        let events = cua_operation_events("s1", &event, 1_000, None);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["kind"], "turn-started");
        assert_eq!(events[0]["turnId"], "turn-1");
    }
}

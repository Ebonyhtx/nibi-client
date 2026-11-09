//! 会话投影（docs/specs/rust-cli/app-protocol.md §6.1）：内核事件 → App 的行与状态。纯计算：`(投影, 事件) → (投影',
//! 增量)`，从 [`SessionView`] 能重建（[`cold`]），所以不是第二份事实。revision 只来自事件（会话 actor 是 owner，G1）。
//!
//! 行：turnHeader（回合）、userInput（真人输入）、assistantText、reasoning、toolCall；其余事件只改状态或忽略（P1）。

mod actions;
mod auto_resolution;
mod cold;
mod files;
mod rows;
pub mod state;
mod subagents;
mod workflow_runs;

pub use auto_resolution::Step;

use std::collections::HashMap;

use nibi_kernel_api::message::{ContentBlock, ToolResultContent, Usage};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{
    KernelEvent, QueuedInput, SequencedEvent, SessionView, TurnExecutionKind, TurnInputSource,
    TurnOutcome,
};
use nibi_kernel_api::tool::ToolOutput;
use serde_json::{Map, Value, json};

use state::{ActiveWork, Followup, LastError, Phase};
use workflow_runs::WorkflowRunsState;

/// 快照里最多带的行（尾部窗口）。
const WINDOW_ROWS: usize = 200;

/// sendText 带来的输入的事实（行与队列项要用）。
#[derive(Debug, Clone, PartialEq)]
pub struct InputMeta {
    pub client: String,
    pub origin: Option<String>,
    pub text: String,
    pub selection: Option<Value>,
    pub mode: Option<String>,
    pub plan: Option<bool>,
    pub admitted_at: u64,
    pub requested: &'static str,
    pub admitted: &'static str,
    /// 命令带的附件引用（NIBI `AttachmentRef`，原样进 userInput 行的 `attachments`）。
    pub attachments: Option<Value>,
    /// 这条输入的规范意图（`conversation_intent::canonical`）：行上原文、机器人来源、引用与插件
    /// 来源都从它取（模型文本是注入后的那一份，行上要显示原文）。
    pub intent: Option<Value>,
}

/// 一个回合里的行。
#[derive(Debug, Clone)]
struct Turn {
    id: String,
    command: Option<String>,
    started_at: u64,
    /// 当前模型响应的序号（流式增量带来；assistant 消息落定时用它找行）。
    response: Option<u32>,
    keys: Vec<String>,
    /// 控制轮标记（NIBI 中枢启动/设置轮，launch.md）：行与 control 的走法都按它分岔。
    execution_kind: Option<TurnExecutionKind>,
    /// 控制轮的 `metadata.workflowLaunch`（轮头行与 userInput 行的 `workflowLaunch` 字段）。
    launch: Option<Value>,
    /// 这一轮写过的「机器 + 路径」（摘要的 `files` 去重，Node 的 summary 按文件数算）。
    file_paths: Vec<(Option<String>, String)>,
    /// 这一轮的增删行数：`FileChanges` 会在每个工具结果落定时到一次，先攒着等收口。
    file_additions: u64,
    file_deletions: u64,
    /// 当前的 checkpoint 是否都允许撤销（任一事件不可撤销就不给入口）。
    file_rewindable: bool,
}

/// 一个会话的投影。
#[derive(Debug, Clone)]
pub struct Projection {
    session: String,
    rows: Vec<Map<String, Value>>,
    index: HashMap<String, usize>,
    next_row: u64,
    revision: u64,
    phase: Phase,
    active: Option<ActiveWork>,
    error: Option<LastError>,
    executions: u64,
    title: String,
    selection: ModelSelection,
    mode: PermissionMode,
    plan: bool,
    followup: Followup,
    levels: Vec<String>,
    context: Option<(u64, u64)>,
    total: Usage,
    queue: Vec<QueuedInput>,
    pending: Vec<Value>,
    turn: Option<Turn>,
    inputs: HashMap<String, InputMeta>,
    /// 每条真人输入的规范意图（冷打开时来自 `SessionView.input_intents`，键是 user 消息 id）：
    /// 行上原文、机器人来源、引用与插件来源都从它取。
    input_intents: HashMap<String, Value>,
    /// 用户拒绝了的工具调用：结果投成 cancelled。
    denied: std::collections::HashSet<String>,
    /// 助手回复的赞/踩（NIBI setAssistantFeedback），按 assistant 消息 id：行落定时带上。
    feedback: std::collections::BTreeMap<String, String>,
    /// 待审的工作区钩子评审请求（NIBI `workspaceHookReview` 交互的 payload，`requestWorkspaceHookReview`）。
    hook_review: Option<Value>,
    /// 工作区钩子的准入提示条（NIBI `workspaceHookAdmission`；null 表示没有待审项）。
    hook_admission: Option<Value>,
    /// 分享导入的本地状态（NIBI 快照的 `sharedContextImport`）：冷打开时从存储种子进来，
    /// `discardSharedContext` 改成 `discarded`。
    shared_context_import: Option<Value>,
    /// 正在跑的压缩分隔线（`timelineMarker` 的 key）：`CompactStarted` 落 running，
    /// 边界消息改 success，`CompactDone`/回合失败收尾。
    compact_marker: Option<String>,
    /// 已切换、还没开跑的模型（from → to）：下一轮开头落 `modelChange` 分隔线
    /// （Node 的 lightBoundary；只比 provider/model，切思考档不落）。
    pending_model_change: Option<(ModelSelection, ModelSelection)>,
    /// DWF 引擎 run 的实时运行态（快照的 `workflowRuns` 键）：一条 `run/event` 推进一格，
    /// run 卡、状态与 Stop 都从这里读（Node `workflowRuns` 投影的同名状态键）。
    workflow_runs: WorkflowRunsState,
    /// 子代理目录（快照的 `subagents` 键）：`SessionHandle::subagents()` 的投影，`revision` 只在
    /// 语义变了时加一（与 Node `materializeSubagentProjection` 同一判据）。
    subagents: SubagentsState,
    /// AskUserQuestion 的自动结束（Node `V4InteractionRegistry` 的会话侧状态）：资格、在途与
    /// 队首激活；计时值本身写在待答交互的 `autoResolution` 字段里。
    auto_resolution: auto_resolution::AutoResolution,
    created_at: u64,
}

/// `subagents` 状态键的当前值。
///
/// 事实源是内核的 `SessionHandle::subagents()`（agents 的在跑子代理表，TUI 一直用它），**不是**事件流。
///
/// `KernelEvent::Subagent` 从 `36492d5a` 起确实有生产者了（`AgentSignal::Subagent` → 会话 actor），
/// 但那条事件只带 `agent`/`child`/`parentToolUse`/`phase`——没有界面要的 `subagentType`、标题、
/// 用时、等待状态。所以这里仍然按查询面投影，再用 `subagent_changes()` 决定何时重取：
/// 事件那条链是给 `v4/telemetry/event` 的 `subagent.lifecycle` 事实用的，两者各取所需。
#[derive(Debug, Clone, PartialEq, Default)]
struct SubagentsState {
    revision: u64,
    value: Value,
}

impl SubagentsState {
    /// 空状态（没有子代理）：`revision` 从 0 起，renderer 用 0 区分「还没建立权威态」。
    fn empty() -> Self {
        Self {
            revision: 0,
            value: json!({"revision": 0, "childSessionIds": [], "running": [], "endedTotal": 0}),
        }
    }

    /// 换成新的子代理表：语义没变时返回 None（不发帧）。
    fn set(&mut self, entries: &[nibi_kernel_api::panels::SubagentEntry], now: u64) -> Option<Value> {
        let (child_session_ids, running, ended_total) = subagents::semantic(entries, now);
        if json!(child_session_ids) == self.value["childSessionIds"]
            && json!(running) == self.value["running"]
            && json!(ended_total) == self.value["endedTotal"]
        {
            return None;
        }
        self.revision += 1;
        self.value = json!({
            "revision": self.revision,
            "childSessionIds": child_session_ids,
            "running": running,
            "endedTotal": ended_total,
        });
        Some(json!({"op": "state.updated", "patch": {"subagents": self.value}}))
    }
}

pub(crate) fn text_of(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn output_text(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            ToolResultContent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn turn_key(turn: &str) -> String {
    format!("turn:{turn}")
}

fn block_key(kind: &str, turn: &str, response: u32, index: usize) -> String {
    format!("{kind}:{turn}:{response}:{index}")
}

fn tool_key(tool_use: &str) -> String {
    format!("tool:{tool_use}")
}

impl Projection {
    /// 从视图建投影（纯投影的单测用；不开启自动结束）。
    #[cfg(test)]
    pub fn from_view(view: &SessionView, followup: Followup, levels: Vec<String>) -> Self {
        Self::from_view_with_auto_resolution(view, followup, levels, false, view.meta.created_at_ms)
    }

    /// 同 `from_view`，另给自动结束的偏好与“现在”：冷打开时待答的 AskUserQuestion
    /// 从这一刻起表（Node 在交互登记时起表；Rust 没有持久化绝对时间，冷打开是唯一的参照）。
    pub fn from_view_with_auto_resolution(
        view: &SessionView,
        followup: Followup,
        levels: Vec<String>,
        auto_resolution_enabled: bool,
        now: u64,
    ) -> Self {
        let mut projection = Self {
            session: view.meta.id.as_str().to_owned(),
            rows: Vec::new(),
            index: HashMap::new(),
            next_row: 1,
            revision: view.revision,
            phase: Phase::Draft,
            active: None,
            error: None,
            executions: 0,
            title: view.meta.title.clone(),
            feedback: std::collections::BTreeMap::new(),
            selection: view.selection.clone(),
            mode: view.mode,
            plan: view.plan,
            followup,
            levels,
            // App 的「总量」用模型的原始窗口（Node `usage.contextWindow.maxTokens`）；旧视图只带
            // 有效窗口时退回它。
            context: view.context_usage.as_ref().map(|usage| {
                (
                    usage.used_tokens,
                    usage.window_tokens.unwrap_or(usage.max_tokens),
                )
            }),
            total: Usage::default(),
            queue: view.queue.clone(),
            pending: Vec::new(),
            hook_review: None,
            hook_admission: None,
            shared_context_import: None,
            compact_marker: None,
            pending_model_change: None,
            workflow_runs: WorkflowRunsState::default(),
            subagents: SubagentsState::empty(),
            auto_resolution: auto_resolution::AutoResolution::new(auto_resolution_enabled),
            turn: None,
            inputs: HashMap::new(),
            input_intents: view
                .input_intents
                .iter()
                .map(|(message, intent)| (message.as_str().to_owned(), intent.clone()))
                .collect(),
            denied: std::collections::HashSet::new(),
            created_at: view.meta.created_at_ms,
        };
        cold::rows(&mut projection, view);
        for (interaction, request) in &view.pending {
            projection.ask(interaction.as_str(), request, view.meta.created_at_ms);
        }
        // 冷打开时待答的问题：队首那个够格的从现在起表。
        projection
            .auto_resolution
            .seed(&mut projection.pending, now);
        // 冷快照也要带行级动作（快照本身承载状态，不需要增量）。
        projection.refresh_actions(&mut Vec::new());
        projection
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// 按 rowId 找行（row-targeting 命令解析 target 用）；没有时 None。
    pub fn row(&self, row_id: u64) -> Option<&Map<String, Value>> {
        self.rows
            .iter()
            .find(|row| row.get("rowId").and_then(Value::as_u64) == Some(row_id))
    }

    /// 全部行（附件回读的授权要在里面按 `attachments` 找）。
    pub fn rows(&self) -> Vec<Map<String, Value>> {
        self.rows.clone()
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn followup(&self) -> Followup {
        self.followup
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    /// 最后一条 assistant 正文（会话列表的预览）。
    pub fn last_reply(&self) -> Option<String> {
        self.rows.iter().rev().find_map(|row| {
            (row["kind"] == "assistantText")
                .then(|| row["text"].as_str().map(str::to_owned))
                .flatten()
        })
    }

    #[cfg(test)]
    pub fn pending_permissions(&self) -> usize {
        self.pending.len()
    }

    /// 用户拒绝了这个工具调用（resolveInteraction 的裁决在内核事件之前）：结果投成 cancelled（与 Node 相同）。
    pub fn deny(&mut self, tool_use: &str) {
        self.denied.insert(tool_use.to_owned());
    }

    /// 记下 sendText 的事实（行与队列项要用）。
    pub fn remember_input(&mut self, command: &str, meta: InputMeta) {
        self.inputs.insert(command.to_owned(), meta);
    }

    /// 协议自己保存的配置变了（setFollowupMode）：返回 `state.updated`。
    pub fn set_followup(&mut self, followup: Followup) -> Value {
        self.followup = followup;
        json!({"op": "state.updated", "patch": {
            "config": self.config(),
            "inputRouting": state::input_routing(self.phase, self.followup),
        }})
    }

    fn config(&self) -> Value {
        state::config(
            &self.selection,
            self.mode,
            self.plan,
            self.followup,
            &self.levels,
        )
    }

    /// 当前登记着的待审工作区钩子评审（超时判断用）。
    pub fn hook_review(&self) -> Option<&Value> {
        self.hook_review.as_ref()
    }

    /// NIBI `requestWorkspaceHookReview` 打开的评审：登记/替换 pendingInteractions 里的
    /// `workspaceHookReview` 交互（同一会话只留一条），返回 `state.updated`。
    pub fn set_hook_review(&mut self, request: Value) -> Value {
        self.hook_review = Some(request.clone());
        self.pending
            .retain(|pending| pending["payload"]["kind"] != "workspaceHookReview");
        self.pending.push(json!({
            "interactionId": request["interactionId"],
            "kind": "workspaceHookReview",
            "anchorRowId": null,
            "createdAt": request["createdAt"],
            "payload": request,
        }));
        json!({"op": "state.updated", "patch": {"pendingInteractions": self.pending}})
    }

    /// 撤掉一条评审交互（已结算 / 超时 / 被新的 generation 替换）。不在时返回 None。
    pub fn settle_hook_review(&mut self, interaction_id: &str) -> Option<Value> {
        let matches = |pending: &Value| {
            pending["payload"]["kind"] == "workspaceHookReview"
                && pending["interactionId"].as_str() == Some(interaction_id)
        };
        if self
            .hook_review
            .as_ref()
            .is_some_and(|request| request["interactionId"].as_str() == Some(interaction_id))
        {
            self.hook_review = None;
        }
        if !self.pending.iter().any(matches) {
            return None;
        }
        self.pending.retain(|pending| !matches(pending));
        Some(json!({"op": "state.updated", "patch": {"pendingInteractions": self.pending}}))
    }

    /// 提示条状态（NIBI `workspaceHookAdmission`）：值没变时不发增量。
    pub fn set_hook_admission(&mut self, admission: Option<Value>) -> Option<Value> {
        if self.hook_admission == admission {
            return None;
        }
        self.hook_admission = admission.clone();
        Some(json!({"op": "state.updated", "patch": {"workspaceHookAdmission": admission}}))
    }

    /// 分享导入的种子（冷打开）：不发增量（Node 的 `seedSharedContextImport` 同义）。
    pub fn seed_shared_context_import(&mut self, value: Option<Value>) {
        self.shared_context_import = value;
    }

    /// `workflowRuns` 的冷种子（`dwf_run` 摘要）：返回整份状态给调用方发 `state.updated`；
    /// 实时表已经在时不覆盖（返回 None）。
    pub fn seed_workflow_runs(
        &mut self,
        rows: &[nibi_kernel_api::workflow::WorkflowRunSummaryRow],
    ) -> Option<Value> {
        self.workflow_runs
            .seed(rows)
            .then(|| json!(self.workflow_runs))
    }

    /// 分享导入的状态变了（`discardSharedContext`）：`state.updated` 里带上整份状态。
    pub fn set_shared_context_import(&mut self, value: Option<Value>) -> Option<Value> {
        if self.shared_context_import == value {
            return None;
        }
        self.shared_context_import = value.clone();
        Some(json!({"op": "state.updated", "patch": {"sharedContextImport": value}}))
    }

    /// 换上新的子代理表（`SessionHandle::subagents()` 的结果）。语义没变时返回 None。
    pub fn set_subagents(
        &mut self,
        entries: &[nibi_kernel_api::panels::SubagentEntry],
        now: u64,
    ) -> Option<Value> {
        self.subagents.set(entries, now)
    }

    /// 待答交互的当前值（`pendingInteractions` 整键）与只读引用。
    pub fn pending_value(&self) -> Value {
        json!(self.pending)
    }

    pub fn pending(&self) -> &[Value] {
        &self.pending
    }

    /// 自动结束的偏好变了。关掉时把正在计时的问题换成 `snoozed`，返回换掉的条数。
    pub fn set_auto_resolution_enabled(&mut self, enabled: bool, now: u64) -> usize {
        self.auto_resolution
            .set_enabled(&mut self.pending, enabled, now)
    }

    /// 用户第一次操作：这个问题永久停止自动结束。不是活动倒计时时返回 false。
    pub fn snooze_auto_resolution(&mut self, interaction: &str, now: u64) -> bool {
        self.auto_resolution
            .snooze(&mut self.pending, interaction, now)
    }

    /// 到点的状态转换与自动应答（按队列顺序）。
    pub fn auto_resolution_due(&self, now: u64) -> Vec<auto_resolution::Step> {
        self.auto_resolution.due(&self.pending, now)
    }

    /// `hiddenGrace` → `visibleCountdown`。
    pub fn auto_resolution_mark_visible(&mut self, interaction: &str) -> bool {
        self.auto_resolution
            .mark_visible(&mut self.pending, interaction)
    }

    /// 已经发出自动应答，等内核收口。
    pub fn auto_resolution_mark_in_flight(&mut self, interaction: &str) {
        self.auto_resolution.mark_in_flight(interaction);
    }

    /// 自动应答被拒（交互已经不在）：撤掉计时与资格。
    pub fn auto_resolution_abandon(&mut self, interaction: &str) -> bool {
        self.auto_resolution.abandon(&mut self.pending, interaction)
    }

    /// 下一次需要醒来处理的时刻。
    pub fn next_auto_resolution_at(&self) -> Option<u64> {
        self.auto_resolution.next_at(&self.pending)
    }

    fn base(
        &self,
        key_turn: &str,
        entity: &str,
        kind: &str,
        now: u64,
        seq: u64,
    ) -> Map<String, Value> {
        let mut row = Map::new();
        row.insert("rowId".into(), json!(self.next_row));
        row.insert("turnId".into(), json!(key_turn));
        row.insert("entityId".into(), json!(entity));
        row.insert("productTurnId".into(), json!(key_turn));
        row.insert("visibility".into(), json!("visible"));
        row.insert("createdAt".into(), json!(now));
        row.insert("createdAtSeq".into(), json!(seq));
        row.insert("kind".into(), json!(kind));
        row
    }

    fn append(&mut self, key: String, row: Map<String, Value>, out: &mut Vec<Value>) {
        self.next_row += 1;
        out.push(json!({"op": "row.appended", "row": row}));
        self.index.insert(key.clone(), self.rows.len());
        self.rows.push(row);
        if let Some(turn) = &mut self.turn {
            turn.keys.push(key);
        }
    }

    fn upsert(
        &mut self,
        key: &str,
        change: impl FnOnce(&mut Map<String, Value>),
        out: &mut Vec<Value>,
    ) {
        let Some(&at) = self.index.get(key) else {
            return;
        };
        let row = &mut self.rows[at];
        let before = row.clone();
        change(row);
        if *row != before {
            out.push(json!({"op": "row.upserted", "row": row.clone()}));
        }
    }

    fn row_id(&self, key: &str) -> Option<u64> {
        self.index
            .get(key)
            .and_then(|at| self.rows[*at]["rowId"].as_u64())
    }

    fn control(&self) -> Value {
        state::control(self.phase, self.active.as_ref(), self.error.as_ref())
    }

    /// 回合的开始、结束等改变阶段的事件：control、availability 与 inputRouting 一起换。
    fn phase_patch(&self, patch: &mut Map<String, Value>) {
        patch.insert("control".into(), self.control());
        patch.insert("availability".into(), state::availability());
        patch.insert(
            "inputRouting".into(),
            state::input_routing(self.phase, self.followup),
        );
    }

    /// 一个事件 → 增量（`row.*` 与 `state.updated`）。`now` 是行的时间。
    pub fn apply(&mut self, event: &SequencedEvent, now: u64) -> Vec<Value> {
        let mut out = Vec::new();
        let mut patch = Map::new();
        let seq = event.seq;
        match &event.event {
            KernelEvent::TurnStarted {
                turn,
                command,
                execution_kind,
                workflow_launch,
                input_source,
                origin_meta,
            } => {
                self.start_turn(
                    turn.as_str(),
                    command.as_ref().map(|c| c.as_str().to_owned()),
                    *execution_kind,
                    workflow_launch.as_ref(),
                    *input_source,
                    origin_meta.as_ref(),
                    now,
                    seq,
                    &mut out,
                );
                // 控制轮不动 session control（Node 的 onTurnStarted 只在 agent 分支推 running，
                // controlOnly 不伪造 running 与工时）。
                if *execution_kind != Some(TurnExecutionKind::ControlOnly) {
                    self.phase_patch(&mut patch);
                }
            }
            KernelEvent::MessageDone { message } => self.message(message, now, seq, &mut out),
            KernelEvent::FileChanges {
                turn,
                files,
                rewindable,
            } => self.file_changes(turn.as_str(), files, *rewindable, &mut out),
            KernelEvent::FilesRestored { turn } => {
                self.files_restored(turn.as_str(), &mut out);
            }
            KernelEvent::HistoryRewritten { .. } => {
                // rewind 后投影重建（与 TUI 的 runner 同语义）：清空行、重置状态。
                // 发 `row.removed{fromRowId:0}` 让客户端也清空（协议已有的 op，
                // delta.ts:112）；后续事件的行追加到空投影上。
                if !self.rows.is_empty() {
                    out.push(json!({"op": "row.removed", "fromRowId": 0}));
                }
                self.rows.clear();
                self.index.clear();
                self.turn = None;
                self.active = None;
                self.error = None;
                self.phase = Phase::Draft;
                self.phase_patch(&mut patch);
            }
            KernelEvent::StreamDelta {
                turn,
                response,
                index,
                delta,
            } => self.stream(turn.as_str(), *response, *index, delta, now, seq, &mut out),
            KernelEvent::ToolStarted {
                tool_use,
                name,
                input,
            } => {
                let key = tool_key(tool_use.as_str());
                if !self.index.contains_key(&key) {
                    self.tool_row(tool_use.as_str(), name, input, now, seq, &mut out);
                }
                self.upsert(
                    &key,
                    |row| {
                        if row["status"] != "pendingApproval" {
                            row.insert("status".into(), json!("running"));
                        }
                        row.entry("startedAt").or_insert(json!(now));
                    },
                    &mut out,
                );
            }
            KernelEvent::ToolDone { tool_use, output } => {
                let text = output_text(output);
                let status = if self.denied.remove(tool_use.as_str()) {
                    "cancelled"
                } else if output.is_error {
                    "error"
                } else {
                    "success"
                };
                self.upsert(
                    &tool_key(tool_use.as_str()),
                    |row| {
                        row.insert("status".into(), json!(status));
                        row.insert("output".into(), json!({"text": text}));
                        row.insert("endedAt".into(), json!(now));
                        row.remove("approvalInteractionId");
                    },
                    &mut out,
                );
            }
            KernelEvent::InteractionAsked {
                interaction,
                request,
            } => {
                if let Some(tool) = self.ask(interaction.as_str(), request, now) {
                    let id = interaction.as_str().to_owned();
                    self.upsert(
                        &tool_key(&tool),
                        |row| {
                            row.insert("status".into(), json!("pendingApproval"));
                            row.insert("approvalInteractionId".into(), json!(id));
                        },
                        &mut out,
                    );
                    // 队首如果是这个问题，现在起表（Node 的 register → activateHead）。
                    self.auto_resolution
                        .on_asked(&mut self.pending, interaction.as_str(), now);
                    patch.insert("pendingInteractions".into(), json!(self.pending));
                }
            }
            KernelEvent::InteractionResolved { interaction } => {
                let before = self.pending.len();
                let tool = self
                    .pending
                    .iter()
                    .find(|pending| pending["interactionId"] == interaction.as_str())
                    .and_then(|pending| {
                        pending["payload"]["toolCallId"].as_str().map(str::to_owned)
                    });
                self.pending
                    .retain(|pending| pending["interactionId"] != interaction.as_str());
                // 队首走了：下一个够格的问题从这一刻起表（Node 的 remove → activateHead）。
                let activated =
                    self.auto_resolution
                        .on_resolved(&mut self.pending, interaction.as_str(), now);
                if self.pending.len() != before || activated {
                    patch.insert("pendingInteractions".into(), json!(self.pending));
                }
                if let Some(tool) = tool {
                    self.upsert(
                        &tool_key(&tool),
                        |row| {
                            if row["status"] == "pendingApproval" {
                                row.insert("status".into(), json!("running"));
                            }
                        },
                        &mut out,
                    );
                }
            }
            KernelEvent::TurnFinished {
                turn,
                outcome,
                usage,
            } => {
                // 控制轮收尾（Node onTurnComplete 的 controlOnly 分支）：只收口轮头，不碰 session
                // control、不补 usage——会话还停在 draft 时除外（leaveDraftAfterControlOnlyTurn：
                // 冷恢复矛盾，sessions-index 会把恒为 draft 的会话丢掉）。
                let control_only = self.turn.as_ref().is_some_and(|turn| {
                    turn.execution_kind == Some(TurnExecutionKind::ControlOnly)
                });
                let advanced = self.finish_turn(
                    turn.as_str(),
                    outcome,
                    usage.as_ref().filter(|_| !control_only),
                    control_only,
                    now,
                    &mut out,
                );
                self.compact_turn_finished(outcome, &mut out);
                if !control_only || advanced {
                    self.phase_patch(&mut patch);
                }
                if !control_only {
                    patch.insert("usage".into(), state::usage(self.context, &self.total));
                }
                if !self.pending.is_empty() {
                    self.pending.clear();
                    self.auto_resolution.clear();
                    patch.insert("pendingInteractions".into(), json!([]));
                }
            }
            KernelEvent::ContextUsage {
                used_tokens,
                max_tokens,
                window_tokens,
            } => {
                self.context = Some((*used_tokens, window_tokens.unwrap_or(*max_tokens)));
                patch.insert("usage".into(), state::usage(self.context, &self.total));
            }
            KernelEvent::TitleChanged { title } => {
                self.title.clone_from(title);
                patch.insert("meta".into(), state::meta(&self.title, true));
            }
            KernelEvent::ModelChanged { selection } => {
                // 切换先记住，等下一轮真正开跑才落分隔线（Node：切换后没有新回合就不画线）。
                // 新会话的第一条选择不是「切换」：有些入口先给空基线、再落真实模型，落线会显示
                // 「模型已切换 → X」这种没有 from 的假事件。
                let baseline_ready =
                    !self.selection.provider.is_empty() && !self.selection.model.is_empty();
                if baseline_ready
                    && (self.selection.provider != selection.provider
                        || self.selection.model != selection.model)
                {
                    self.pending_model_change = Some((self.selection.clone(), selection.clone()));
                }
                self.selection = selection.clone();
                patch.insert("config".into(), self.config());
            }
            KernelEvent::ModeChanged { mode } => {
                self.mode = *mode;
                patch.insert("config".into(), self.config());
            }
            KernelEvent::PlanChanged { enabled } => {
                self.plan = *enabled;
                patch.insert("config".into(), self.config());
            }
            KernelEvent::QueueChanged { items } => {
                // 立即开跑的输入（空闲时提交）在内核里也经过队列：不投成排队项；投出的值没变时不发。
                let before = self.queue_state();
                self.queue.clone_from(items);
                let after = self.queue_state();
                if after != before {
                    patch.insert("queue".into(), after);
                }
            }
            KernelEvent::CompactStarted { trigger } => {
                self.compact_started(*trigger, now, seq, &mut out);
            }
            KernelEvent::CompactDone { .. } => {
                self.compact_done();
            }
            KernelEvent::WorkflowRunProgress { progress } => {
                // 整键替换（`workflowRuns` 是高频派生状态，Node 发键级增量；Rust 这一版先发整键，
                // 行数与条目都由归约的界压住）。语义无变化时不发，与 Node reducer 的幂等同规。
                if self.workflow_runs.apply(progress) {
                    patch.insert("workflowRuns".into(), json!(self.workflow_runs));
                }
            }
            _ => {}
        }
        if event.revision != self.revision {
            self.revision = event.revision;
            patch.insert("revision".into(), json!(self.revision));
        }
        // 行级动作只在会改变它们的事件后重算（流式增量不触发）。
        if matches!(
            &event.event,
            KernelEvent::TurnStarted { .. }
                | KernelEvent::TurnFinished { .. }
                | KernelEvent::MessageDone { .. }
                | KernelEvent::FileChanges { .. }
                | KernelEvent::InteractionAsked { .. }
                | KernelEvent::InteractionResolved { .. }
        ) {
            self.refresh_actions(&mut out);
        }
        if !patch.is_empty() {
            out.push(json!({"op": "state.updated", "patch": patch}));
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn start_turn(
        &mut self,
        turn: &str,
        command: Option<String>,
        execution_kind: Option<TurnExecutionKind>,
        launch: Option<&Value>,
        input_source: Option<TurnInputSource>,
        origin_meta: Option<&Value>,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let control_only = execution_kind == Some(TurnExecutionKind::ControlOnly);
        // 控制轮不开模型回合：不推进 running、不立 activeWork、不清 lastError
        // （Node 的 onTurnStarted 只在 agent 分支动 session control）。
        if !control_only {
            self.executions += 1;
            self.phase = Phase::Running;
            self.error = None;
            self.active = Some(ActiveWork {
                execution: format!("runtime_command_{}", self.executions),
                command: command.clone(),
                started_at: now,
            });
        }
        self.turn = Some(Turn {
            id: turn.to_owned(),
            command: command.clone(),
            started_at: now,
            response: None,
            keys: Vec::new(),
            execution_kind,
            launch: launch.cloned(),
            file_paths: Vec::new(),
            file_additions: 0,
            file_deletions: 0,
            file_rewindable: true,
        });
        // 模型切换的分隔线：切换事件先记在 pending，真正开跑的下一轮才落一行
        // （Node 的 `modelChange` 是 lightBoundary，只比 provider/model）。
        if let Some((from, to)) = self.pending_model_change.take() {
            self.append_model_change(turn, &from, &to, now, seq, out);
        }
        let mut row = self.base(turn, turn, "turnHeader", now, seq);
        // 轮头的 origin（Node `turnHeaderOrigin(inputSource)` 同一张表）：中枢启动/设置轮
        // workflowLaunch（UI 据此画启动卡而非用户气泡）、后台通知轮 backgroundResult、
        // 其余 userInput。
        let origin = match (launch.is_some(), input_source) {
            (true, _) => "workflowLaunch",
            (false, Some(TurnInputSource::BackgroundTask)) => "backgroundResult",
            (false, None) => "userInput",
        };
        row.insert("origin".into(), json!(origin));
        let kind = if control_only { "controlOnly" } else { "agent" };
        row.insert("executionKind".into(), json!(kind));
        if let Some(launch) = launch {
            row.insert("workflowLaunch".into(), launch.clone());
        }
        // 后台通知的运行卡关联键（Node buildTurnHeaderRow 的 originMeta 同形）。
        if let Some(origin_meta) = origin_meta {
            row.insert("originMeta".into(), origin_meta.clone());
        }
        if let Some(command) = &command {
            row.insert("sourceCommandId".into(), json!(command));
        }
        row.insert("state".into(), json!("running"));
        row.insert("startedAt".into(), json!(now));
        self.append(turn_key(turn), row, out);
    }

    /// `modelChange` 分隔线（Node 的 lightBoundary 行）：轮头之前一行，`entityId` 带 from→to。
    /// 实时由 `ModelChanged` 记 pending、下一轮开头落；冷打开按每轮消息上的选择比较后直接落。
    fn append_model_change(
        &mut self,
        turn: &str,
        from: &ModelSelection,
        to: &ModelSelection,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let entity = format!(
            "model-change:{turn}:{}/{}->{}/{}",
            from.provider, from.model, to.provider, to.model
        );
        let mut row = self.base(turn, &entity, "timelineMarker", now, seq);
        row.insert("lane".into(), json!("lightBoundary"));
        row.insert(
            "marker".into(),
            json!({
                "type": "modelChange",
                "fromProvider": from.provider,
                "fromModel": from.model,
                "toProvider": to.provider,
                "toModel": to.model,
                "toThought": to.reasoning.clone().unwrap_or_default(),
            }),
        );
        self.append(format!("model-change:{turn}"), row, out);
    }

    /// 收口一个回合；返回控制轮是否把 draft 会话推进了终态（普通回合总是 true）。
    fn finish_turn(
        &mut self,
        turn: &str,
        outcome: &TurnOutcome,
        usage: Option<&Usage>,
        control_only: bool,
        now: u64,
        out: &mut Vec<Value>,
    ) -> bool {
        if let Some(usage) = usage {
            state::add_usage(&mut self.total, usage);
        }
        let (header, row_state, phase) = match outcome {
            TurnOutcome::Success => ("completedSuccess", "complete", Phase::CompletedSuccess),
            TurnOutcome::Interrupted => (
                "completedInterrupted",
                "interrupted",
                Phase::CompletedInterrupted,
            ),
            TurnOutcome::Failed { message } => {
                self.error = Some(LastError {
                    message: message.clone(),
                    at: now,
                });
                ("failed", "failed", Phase::Error)
            }
        };
        // 控制轮不动会话 control（Node：非 draft 会话上的控制轮照旧不碰 session control）；
        // draft 会话上推进到终态，sessions-index 才会认领中枢直接启动的会话。
        let advanced = !control_only || self.phase == Phase::Draft;
        if advanced {
            self.phase = phase;
        }
        self.active = None;
        let started = self.turn.as_ref().map_or(now, |turn| turn.started_at);
        // 收口时一次挂上这一轮的文件摘要（Node 只在最后一个 model step 给 summary）。
        let file_summary = self.turn.as_ref().map(|turn| {
            (
                turn.file_paths.len() as u64,
                turn.file_additions,
                turn.file_deletions,
                turn.file_rewindable,
            )
        });
        let keys = self.turn.take().map(|turn| turn.keys).unwrap_or_default();
        for key in &keys {
            self.upsert(
                key,
                |row| match row["kind"].as_str() {
                    Some("assistantText") if row["state"] == "streaming" => {
                        row.insert("state".into(), json!(row_state));
                    }
                    Some("reasoning") if row["state"] == "streaming" => {
                        let reasoning = if row_state == "failed" {
                            "interrupted"
                        } else {
                            row_state
                        };
                        row.insert("state".into(), json!(reasoning));
                    }
                    Some("toolCall")
                        if matches!(
                            row["status"].as_str(),
                            Some("inputStreaming" | "pendingApproval" | "running")
                        ) =>
                    {
                        row.insert("status".into(), json!("cancelled"));
                        row.remove("approvalInteractionId");
                        row.insert("endedAt".into(), json!(now));
                    }
                    _ => {}
                },
                out,
            );
        }
        let output_tokens = usage.map(|usage| usage.output_tokens);
        // 终态才给「撤销文件」入口（Node 的 materialization 规则：running 时不给）。
        let can_rewind = self.pending.is_empty();
        self.upsert(
            &turn_key(turn),
            |row| {
                row.insert("state".into(), json!(header));
                row.insert("endedAt".into(), json!(now));
                // 控制轮没有 Agent 工时（Node 的 controlOnly 分支不带 activeMs；0 秒也不能
                // 落下去——旧 UI 会把它格式化成「已工作 1 秒」）。
                if !control_only {
                    row.insert("activeMs".into(), json!(now.saturating_sub(started)));
                }
                if let Some(tokens) = output_tokens {
                    row.insert("outputTokens".into(), json!(tokens));
                }
                // 这一轮的 checkpoint 都在收口前落定：摘要与撤销入口一次写齐。
                if let Some((count, additions, deletions, rewindable)) = file_summary {
                    files::finish_summary(
                        row, count, additions, deletions, rewindable, can_rewind,
                    );
                }
                // 轮头已经有一轮的摘要（`FileChanges` 早于收口到达）：这时补上撤销入口。
                if can_rewind
                    && row
                        .get("fileChanges")
                        .and_then(Value::as_object)
                        .is_some_and(|changes| changes.get("state") != Some(&json!("reverted")))
                {
                    files::set_can_rewind(row);
                }
            },
            out,
        );
        advanced
    }

    /// 队列（`queueStateSchema`）：内核的排队输入加上 sendText 时记下的事实。
    /// NIBI `setAssistantFeedback`：按 assistant 消息 id 记赞/踩，并把已经落定的
    /// `assistantText` 行原地更新（`row.upserted`）。
    pub fn set_feedback(&mut self, message: &str, feedback: Option<String>) -> Vec<Value> {
        match &feedback {
            Some(value) => {
                self.feedback.insert(message.to_owned(), value.clone());
            }
            None => {
                self.feedback.remove(message);
            }
        }
        let mut out = Vec::new();
        let at = self.rows.iter().position(|row| {
            row.get("kind").and_then(Value::as_str) == Some("assistantText")
                && row.get("assistantResponseId").and_then(Value::as_str) == Some(message)
        });
        if let Some(at) = at {
            let mut row = self.rows[at].clone();
            match &feedback {
                Some(value) => {
                    row.insert("feedback".into(), json!(value));
                }
                None => {
                    row.remove("feedback");
                }
            }
            if row != self.rows[at] {
                self.rows[at] = row.clone();
                out.push(json!({"op": "row.upserted", "row": row}));
            }
        }
        out
    }

    fn queue_state(&self) -> Value {
        let items: Vec<Value> = self
            .queue
            .iter()
            .filter(|item| {
                self.inputs
                    .get(item.command.as_str())
                    .is_none_or(|meta| meta.admitted != "startNow")
            })
            .map(|item| {
                let command = item.command.as_str();
                let meta = self.inputs.get(command);
                let mut value = json!({
                    "sourceCommandId": command,
                    "queueItemId": format!("queue_{command}"),
                    "clientId": meta.map_or("unknown", |meta| meta.client.as_str()),
                    "kind": "sendText",
                    // 排队项显示原文（模型文本是注入后的那一份）。
                    "text": meta
                        .and_then(|meta| meta.intent.as_ref())
                        .and_then(|intent| intent["text"].as_str())
                        .unwrap_or(item.text.as_str()),
                    "attachments": [],
                    "delivery": {
                        "requested": meta.map_or("queue", |meta| meta.requested),
                        "admitted": meta.map_or("queue", |meta| meta.admitted),
                    },
                    "order": {"admissionSeq": 0},
                    "steer": {"state": "notRequested"},
                    "dispatch": {"state": "queued"},
                    "admittedAt": meta.map_or(self.created_at, |meta| meta.admitted_at),
                });
                if let Some(meta) = meta {
                    if let Some(origin) = &meta.origin {
                        value["inputOrigin"] = json!(origin);
                    }
                    if let Some(selection) = &meta.selection {
                        value["modelSelection"] = selection.clone();
                    }
                    if let Some(mode) = &meta.mode {
                        value["mode"] = json!(mode);
                    }
                    if let Some(plan) = meta.plan {
                        value["planEnabled"] = json!(plan);
                    }
                }
                value
            })
            .collect();
        json!({"items": items, "autoDrain": true})
    }

    /// 快照（`conversationSnapshotSchema`）：`seq` 是主题的序号，`epoch` 是主题的代际标识。
    pub fn snapshot(&self, seq: u64, epoch: &str) -> Value {
        let start = self.rows.len().saturating_sub(WINDOW_ROWS);
        let mut snapshot = json!({
            "protocolVersion": 1,
            "sessionId": self.session,
            "logEpoch": epoch,
            "seq": seq,
            "revision": self.revision,
            "control": self.control(),
            "availability": state::availability(),
            "inputRouting": state::input_routing(self.phase, self.followup),
            "meta": state::meta(&self.title, true),
            "config": self.config(),
            "modelTransition": null,
            "usage": state::usage(self.context, &self.total),
            "queue": self.queue_state(),
            "pendingInteractions": self.pending,
            "pendingCommands": [],
            "backgroundWorks": [],
            "subagents": self.subagents.value,
            "goal": null,
            "plan": null,
            "workspaceHookAdmission": self.hook_admission,
            "rows": {
                "window": &self.rows[start..],
                "totalCount": self.rows.len(),
                "firstRowId": self.rows.first().map(|row| row["rowId"].clone()),
            },
        });
        // 协议里这个键是 optional、不是 nullable：没有分享导入时**不写**，不能写 null
        // （Host 的 `sharedContextImportSchema` 会拒整帧，客户端报 `fault.subscription.contentRejected`）。
        if let Some(value) = &self.shared_context_import {
            snapshot["sharedContextImport"] = value.clone();
        }
        // 同一条 optional 纪律：没有 run 时整个键不写（schema 是 optional，不是 nullable）。
        if !self.workflow_runs.is_empty() {
            snapshot["workflowRuns"] = json!(self.workflow_runs);
        }
        snapshot
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;

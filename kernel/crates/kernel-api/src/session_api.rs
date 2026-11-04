//! 前端使用的内核会话 API（docs/specs/rust-cli/README.md §3、§7）。
//!
//! TUI 与 headless 只经这里驱动内核；第二阶段的 ZCode Protocol 前端也一样。事件覆盖 spec §7
//! 列出的 V4 适配层输入，每个事件带会话内单调递增的 seq，并能从持久事实重建（§6 规则 13）。

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::env::WorkspaceRef;
use crate::ids::{
    AgentId, CommandId, InteractionId, MessageId, SessionId, ShellTaskId, ToolUseId, TurnId,
};
use crate::message::{CompactTrigger, Message, Usage};
use crate::model::{BlockDelta, ModelSelection};
use crate::orchestration::InteractionRequest;
use crate::permission::{PermissionMode, ToolPolicy};
use crate::store::{
    ArtifactRef, MessageTime, SessionFilter, SessionLaunchTurn, SessionMeta, SessionSummary,
};
use crate::tool::{ToolOutput, ToolProgress};

/// 轮的执行种类（Node `TurnExecutionKind`，contracts session.events.ts）：`agent` 是普通模型
/// 回合；`controlOnly` 不开模型回合——NIBI 中枢启动 / run 卡「配置」的控制轮
/// （docs/dynamic-workflow/launch.md「The settings turn」）。事件上缺席（`None`）按 `agent` 读，
/// 与 Node 的 `payload.executionKind ?? "agent"` 同一读法。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnExecutionKind {
    Agent,
    ControlOnly,
}

/// 合成输入开的轮的来源（Node `TurnStarted.inputSource`，contracts session.events.ts 的
/// `SyntheticUserMessageSource` 子集）：投影据它在轮头行派生 `origin`（Node `turnHeaderOrigin`
/// 的同一张表——`background_task` → `backgroundResult`；真人输入缺席，origin 是 `userInput`）。
/// 同伴消息的 `subagent_message` 在 Node 的表里落默认 `userInput`，内核不给它这个标记。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnInputSource {
    /// 后台任务通知（`<task-notification>` 信封开的 model-only 轮；shell / 子代理 / 工作流 run
    /// 的完成与提问通知都走它）。
    BackgroundTask,
}

/// 运行中提交的输入怎样投递（工具边界吸收排队消息）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// 当前回合结束后作为新回合发送。
    Queue,
    /// 在下一个工具边界注入当前回合。
    Steer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewindScope {
    Conversation,
    Code,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Submit {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<ArtifactRef>,
        delivery: Delivery,
    },
    Interrupt,
    /// 进程要退出（修复线 F38，docs/specs/rust-cli/session-lifecycle.md §3.5）：以 [`crate::abort::AbortReason::Shutdown`]
    /// 中止在跑的回合（之后这个回合不再记录），此后不再开回合。没有回合在跑时也 `Accepted`。
    Shutdown,
    /// esc 撤回刚发的输入（修复线 F38，session-lifecycle.md §5.5）：空闲、队列为空、
    /// 最后一条可选的人类输入之后没有回答时，对话回退到它之前（与 `Rewind{conversation}` 同一个 `session.revert`）。
    /// `Accepted.result` 是 `{message, removed}`：`message` 是这条输入（[`crate::message::Message`]，前端放回输入框）。
    /// 条件不满足时 `Rejected`。
    RestoreCancelled,
    ResolveInteraction {
        interaction: InteractionId,
        answer: Value,
    },
    SetModel {
        selection: ModelSelection,
    },
    /// 改权限模式（plan 开关不变）；`Plan` 是旧写法，只打开 plan（修复线 F20，shell-permissions.md §4.6）。
    SetMode {
        mode: PermissionMode,
    },
    /// 打开或关掉 plan 开关，权限模式不变（修复线 F20，TUI 的 `/plan`；Node `setExecutionState({planEnabled})`）。
    SetPlan {
        enabled: bool,
    },
    Compact {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
    },
    Rewind {
        target: MessageId,
        scope: RewindScope,
    },
    /// 只回退文件、不动对话，且只回退给定消息集合里的 checkpoint（NIBI `applyFileRewind` 的
    /// turn 语义：一轮里的 user / assistant 消息 id）。`turn` 有值时成功后发
    /// [`KernelEvent::FilesRestored`]，投影据此把这一轮的 `fileChanges.state` 标成 `reverted`。
    RestoreFiles {
        messages: Vec<MessageId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn: Option<TurnId>,
    },
    /// 从 `at` 处分叉出新会话；Ack 的 `result` 是新会话 ID。
    Fork {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<MessageId>,
    },
    /// 用户改名（`/rename`，Node `setCustomSessionTitle`）：标题来源记为 `custom`，之后不再自动生成
    /// （docs/specs/rust-cli/titles.md §4）。
    Rename {
        title: String,
    },
    /// 不带参数的 `/rename`（docs/specs/rust-cli/titles.md §8）：会话 actor
    /// 用模型从对话起名，再按 `Rename` 写入。回执等名字：`Accepted.result` 是 `{name, message}`，
    /// 起不出名字时 `Rejected.reason` 是给用户看的文本。
    GenerateName,
    /// 带内容块的输入（文字加粘贴的图片，docs/specs/rust-cli/tui-input.md §3）：回合与 [`Command::Submit`]
    /// 相同，输入消息的内容就是这些块；UPS、标题与斜杠展开只看文字块。
    SubmitContent {
        content: Vec<crate::message::ContentBlock>,
        delivery: Delivery,
    },
    /// 改一条排队输入的正文（NIBI `editQueueItem`）：同 id 原地更新，位置与种类不变。
    EditQueued { item: CommandId, text: String },
    /// 删一条排队输入（NIBI `deleteQueueItem`）：不在队列里时 `Rejected`（调用方按 noop 处理）。
    DeleteQueued { item: CommandId },
    /// 移动一条排队输入（NIBI `reorderQueueItem`）：`before` 为 None 时移到队尾。
    ReorderQueued {
        item: CommandId,
        before: Option<CommandId>,
    },
    /// 自动排空（NIBI `setAutoDrain`）：关掉时回合结束后不自动开队首（通知与定时任务照常）；
    /// 打开且空闲时立刻按队列开回合。
    SetAutoDrain { enabled: bool },
    /// 立刻发送一条排队输入（NIBI `sendQueuedNow`）：忙时先中止当前回合再开它，空闲时直接开。
    SendQueuedNow { item: CommandId },
    /// 从当前对话派生一个侧聊会话（NIBI `createSelectionSideSession`）：复制到最近一条消息为止，
    /// 选择可覆盖（`selection` 为空时继承当前），文件不动。只在空闲时接受。
    /// `Accepted.result` 是 `{session, copied}`。
    CreateSelectionSideSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selection: Option<ModelSelection>,
    },
    /// 暂停或恢复 `/goal` 的续跑（NIBI `pauseGoal` / `resumeGoal`）：暂停时条件仍保存，但回合结束
    /// 不再按它续跑；恢复只是重新武装（下一个回合结束照常判定）。暂停会中止正在跑的回合。
    /// `Accepted.result` 是 `{active, paused}`：没有目标时两者都是 false（幂等成功）。
    SetGoalPaused { paused: bool },
    /// bash 模式的输入（`!命令`，tui-input.md §2）：会话经 [`crate::user_input::UserInputs::bash`] 执行，
    /// 记下 `<bash-input>` 与输出两条 user 消息，再调模型。
    Bash {
        command: String,
        delivery: Delivery,
    },
    /// `/fork`（docs/specs/rust-cli/session-lifecycle.md §6.5，工作线 F75）：从一条可选的用户输入分出新会话，
    /// 新会话带到这一轮为止（这一轮最后一条 assistant），文件不动。只在空闲时接受；`Accepted.result` 是
    /// `{session, response, copied, message}`（`message` 是复制到的那条消息，F78）。`input` 不是可选的输入时 `Rejected`。
    ForkFromInput {
        input: MessageId,
    },
    /// 批准或拒绝一条扣住的同伴消息（docs/specs/rust-cli/cross-session.md §2.4，F28）：`message` 是
    /// [`crate::peers::HeldPeerMessage::msg_id`]。已经解决（过期、改模式放行）时 `Rejected`。
    ResolvePeerMessage {
        message: String,
        approve: bool,
    },
    /// 停止会话里的一个后台任务（`/tasks`，docs/specs/rust-cli/tui-display.md §3.1）：与 TaskStop 工具同一条
    /// 停止路径。`task` 是 [`crate::manage::BackgroundEntry::id`]；回执 `Accepted.result` 是 `{message}`，
    /// 找不到或不在跑时 `Rejected.reason` 是给用户看的文本。
    StopTask {
        task: String,
    },
    /// `/cd`（docs/specs/rust-cli/tui-manage.md §7）：把会话的工作目录换成 `root`（会话 actor 先设执行环境的
    /// shell cwd），`note` 是给模型的说明，作为 meta 用户消息一起提交。运行中时 `Rejected`。
    SetWorkspace {
        root: crate::env::EnvPath,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// `/cd` 由会话 actor 判定（docs/specs/rust-cli/tui-manage.md §7.1，F1）：运行中 `Rejected`（固定的文字）；
    /// 否则 `Accepted.result` 是 [`crate::manage::DirectoryOutcome`]。移动时 actor 设 shell cwd、改工作区、
    /// 发 [`KernelEvent::WorkspaceChanged`]，给模型的说明（固定的说明文字加新目录的规则文件）由 actor 组成并提交。
    ChangeDirectory {
        root: crate::env::EnvPath,
    },
    /// 同 [`Command::ChangeDirectory`]，移动成功时 `record` 与说明文字同一批、排在它之前提交（修复线 L-A，
    /// docs/specs/rust-cli/tui-manage.md §11.2：对照实现的 `/cd` 先记命令输入与输出，说明文字是之后的 meta 消息）。
    ChangeDirectoryRecorded {
        root: crate::env::EnvPath,
        record: crate::user_command::LocalCommandRecord,
    },
    /// 本地命令写进对话的记录（修复线 L-A，docs/specs/rust-cli/tui-manage.md §11）：空闲时马上提交一批；回合或压缩在跑时
    /// 留到它收尾、开下一个回合之前提交。总是 `Accepted`（提交失败只记日志）。
    RecordLocalCommand {
        record: crate::user_command::LocalCommandRecord,
    },
    /// 把这个会话在跑的前台 Bash 转到后台（修复线 L-A，docs/specs/rust-cli/tui-input.md §11）：用户的转后台键
    /// （`User`），或低延迟投递的输入（`DeliverMessage`）。会话 actor 交给本机的执行环境；总是 `Accepted`，`result`
    /// 是转了的个数。
    BackgroundForeground {
        reason: crate::env_command::BackgroundReason,
    },
    /// 把续写时补在内存里、还没落库的 assistant（`No response requested.`，docs/specs/rust-cli/session-lifecycle.md
    /// §6.3.1，工作线 F79；有补给未结调用的中断结果时一起，§6.3，工作线 F81）现在单独提交一批。交互界面在会话里切到这个会话（`/resume`、`/fork`）之后发：切过去就算换了
    /// 对话。没有要写的（没有补、已经写过、被回退掉）时什么都不做，回执是 `Accepted`；提交失败时 `Rejected`，它留到下一批
    /// 带消息的提交。
    StoreResumeSentinel,
    /// 工作流控制轮（NIBI 中枢与 run 卡「配置」的 controlOnly 记录，docs/dynamic-workflow/launch.md
    /// 「The settings turn」）：落一条可见的合成 user 消息（文本进模型上下文，`metadata.workflowLaunch`
    /// 与 `source: "workflow_launch"` 供 GUI 与冷恢复认它），不开模型回合。忙时排队，回合收尾先落。
    /// 总是 `Accepted`（提交失败 `Rejected`）。
    WorkflowLaunch {
        /// 模型可见的规范句（Node `buildSettingsMessageText` 的逐字移植）。
        text: String,
        /// `metadata.workflowLaunch`（runId/toolCallId/name?/amend，有界后的 JSON）。
        launch: Value,
    },
}

/// 带 ID 的命令；同一个 ID 重复提交时返回 [`Ack::Duplicate`]，不重复执行。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandEnvelope {
    pub id: CommandId,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Ack {
    Accepted {
        #[serde(default, skip_serializing_if = "Value::is_null")]
        result: Value,
    },
    Duplicate,
    Rejected {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum TurnOutcome {
    Success,
    Interrupted,
    Failed { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
    /// 文件所在的远端机器（远端执行 F98，docs/specs/rust-cli/remote-exec.md §25.4.5：`/rewind` 写成 `dev-a:README.md`）；
    /// 本机为 None，不写出。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedInput {
    pub command: CommandId,
    pub text: String,
    pub delivery: Delivery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentPhase {
    Spawned,
    Done,
}

/// 只供显示的系统提示的级别（informational system 消息的 `level`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warning,
}

/// 内核事件。新增变体时同步更新前端与 spec §7。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum KernelEvent {
    SessionCreated {
        meta: SessionMeta,
    },
    TitleChanged {
        title: String,
    },
    ModelChanged {
        selection: ModelSelection,
    },
    /// 权限模式变了（修复线 F20 起只带权限模式，不会是 `Plan`；plan 开关见 [`KernelEvent::PlanChanged`]）。
    ModeChanged {
        mode: PermissionMode,
    },
    /// plan 开关变了（修复线 F20）。
    PlanChanged {
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    TurnStarted {
        turn: TurnId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<CommandId>,
        /// 控制轮标记（NIBI 中枢启动/设置轮）：投影据它在轮头行写 `executionKind: "controlOnly"`，
        /// 不把会话 control 推进 running（Node 的 onTurnStarted 只在 agent 分支动 control）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_kind: Option<TurnExecutionKind>,
        /// 控制轮的 `metadata.workflowLaunch`（与消息记录上同一份）：轮头行与 userInput 行
        /// 的 `workflowLaunch` 字段、`origin: "workflowLaunch"` 都由它驱动。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workflow_launch: Option<Value>,
        /// 合成输入的来源（后台通知等）：轮头行的 `origin` 由它派生（Node
        /// `turnHeaderOrigin(inputSource)`）；缺席是普通用户输入轮。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_source: Option<TurnInputSource>,
        /// 后台通知的结构化 originMeta（Node `BackgroundResultOriginMeta`）：轮头行的
        /// `originMeta` 字段（GUI 运行卡的关联键）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin_meta: Option<Value>,
    },
    TurnFinished {
        turn: TurnId,
        outcome: TurnOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
    },
    /// 正文、thinking、工具输入的流式增量；`response` 是本回合内第几次模型响应。
    StreamDelta {
        turn: TurnId,
        response: u32,
        index: usize,
        delta: BlockDelta,
    },
    /// 一条消息已完整并已落库。
    MessageDone {
        message: Message,
    },
    ToolStarted {
        tool_use: ToolUseId,
        name: String,
        input: Value,
    },
    ToolProgress {
        tool_use: ToolUseId,
        progress: ToolProgress,
    },
    ToolDone {
        tool_use: ToolUseId,
        output: ToolOutput,
    },
    FileChanges {
        turn: TurnId,
        files: Vec<FileChange>,
        rewindable: bool,
    },
    /// 只回退文件的回退成功了（NIBI `applyFileRewind`）：投影把这一轮的 `fileChanges.state`
    /// 标成 `reverted`（Node `RewindTriggered{scope: workspace, reason: file_summary_rewind}`）。
    FilesRestored {
        turn: TurnId,
    },
    InteractionAsked {
        interaction: InteractionId,
        request: InteractionRequest,
    },
    InteractionResolved {
        interaction: InteractionId,
    },
    ContextUsage {
        used_tokens: u64,
        max_tokens: u64,
    },
    /// 上下文快满的提示（docs/specs/rust-cli/compact.md §2.1）：提交带用量的 assistant 与压缩结果之后重算。
    ContextNotice {
        notice: crate::compaction::ContextNotice,
    },
    /// 完成的主回合请求的输出速度（footer 的 TPS，tui-display.md §2.6，F105）：计量提交之后发，不落库。
    OutputSpeed {
        speed: crate::metering::OutputSpeed,
    },
    TasksChanged {
        tasks: Value,
    },
    QueueChanged {
        items: Vec<QueuedInput>,
    },
    BackgroundWork {
        work: String,
        status: String,
    },
    Subagent {
        agent: AgentId,
        phase: SubagentPhase,
        child: SessionId,
        parent_tool_use: ToolUseId,
    },
    CompactStarted {
        trigger: CompactTrigger,
    },
    CompactDone {
        boundary: MessageId,
    },
    /// 历史被改写（rewind、编辑重发）；前端丢弃旧视图后重新取快照。
    HistoryRewritten {
        generation: u64,
    },
    /// 定时任务触发的界面行（tools-more.md §18.3，L22）：不进模型上下文、不落库，
    /// 紧接着是这次触发开的回合。`at` 是本地时间（`Oct 18 3:04pm`）；`fold` 有值时前端收起上一个 loop tick。
    ScheduledFire {
        at: String,
        kind: crate::cron::CronFireKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fold: Option<crate::cron::LoopFold>,
    },
    /// 只供显示的系统提示，不发给模型、不落库（L18：插话被 UserPromptSubmit 阻塞，
    /// docs/specs/rust-cli/query.md §4.2）。
    SystemNotice {
        level: NoticeLevel,
        text: String,
    },
    /// 会话的工作目录换了（EnterWorktree / ExitWorktree / `/cd`，F1）：前端的工作区只从这里与快照的
    /// `meta.workspace` 取（tools-more.md §11.4、tui-manage.md §7.1）。
    WorkspaceChanged {
        workspace: WorkspaceRef,
    },
    /// 扣住的同伴消息变了（cross-session.md §2.4，F28）：整份快照，界面的批准框只从它与
    /// [`SessionView::peer_held`] 取。
    PeerHeldChanged {
        held: Vec<crate::peers::HeldPeerMessage>,
    },
    /// 主线程模型请求的通知（重试、停顿、恢复）：不落库，前端用它显示重试与停顿
    /// （docs/specs/rust-cli/stall-visibility.md §3）。
    ModelNotice {
        notice: crate::model::ModelNotice,
    },
    /// 模型请求的生命周期状态（`v4/telemetry/event` 的 `model.request.status` 事实来源）：
    /// 只落实时日志，不落库、不进模型上下文。
    ModelRequestStatus {
        status: crate::model::ModelRequestStatus,
    },
    /// 动态工作流的归属事实（`v4/telemetry/event` 的 `workflow.lifecycle` 事实来源）：DWF 引擎的
    /// `actor-created` / `run-settled` 写进父会话的事件流。不落库、不进模型上下文。
    WorkflowLifecycle {
        fact: WorkflowLifecycleFact,
    },
}

/// `workflow.lifecycle` 的两个阶段（Host `workflowLifecycleFactSchema.phase` 的拼写）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowLifecyclePhase {
    ActorSpawned,
    RunSettled,
}

/// 动态工作流子代理的归属事实（Node `conversation-telemetry-workflow-facts.ts` 同源同向）：
/// 只带 id 与状态，不带脚本、prompt、结果正文。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLifecycleFact {
    pub run_id: String,
    pub phase: WorkflowLifecyclePhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// `actor-spawned` 必带：`siteId@ordinal`（与引擎 refToString 同串）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// `actor-spawned` 必带：引擎铸的 actor 子会话 id。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<String>,
    /// `run-settled` 必带：`completed` / `errored` / `stopped`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// 只在 `stopped` 时在场。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// 发起这个 run 的输入 id（Node 的 `launchInputId`）。内核的引擎客户端拿不到时缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_command_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SequencedEvent {
    pub seq: u64,
    pub event: KernelEvent,
    /// 会话的状态 revision（缺口 G1，docs/specs/rust-cli/app-protocol.md §6.4）：会话 actor 在可见状态变化时加一
    /// （回合开始与结束、消息落定、工具开始与结束、询问、队列、模式、模型、plan、标题、历史改写、压缩、工作区、子代理与
    /// 后台任务）；流式增量、进度、用量与只供显示的提示不加。新会话从 0 开始，只在 actor 的寿命内单调（进程重启后从 0
    /// 重来）。这条事件之后的值；serde 缺省 0。
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateSession {
    /// 第二阶段由 Host 给出会话 ID；为空时内核生成。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<SessionId>,
    pub workspace: WorkspaceRef,
    pub selection: ModelSelection,
    /// 权限模式；`Plan` 是旧写法（plan 开、default）。
    pub mode: PermissionMode,
    /// plan 开关（修复线 F20；serde 缺省 false）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
}

/// 导入的历史消息（NIBI `createSession.importedHistory`，Claude Code 迁移）：只有角色、正文与
/// 原时间戳；时间戳用于展示，内核消息本身仍按提交时间落库。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportedMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<u64>,
}

/// 会话的当前视图（前端重连或首次打开时用）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionView {
    pub meta: SessionMeta,
    /// 显示用的历史：冷读取时是只供显示的压缩点之前的消息（[`crate::store::LoadedSession::earlier`]）接上会话 actor 的
    /// 历史（工作线 F102，docs/specs/rust-cli/compact.md §5.1）。要模型侧的那一段时取 [`crate::history::active`]。
    pub messages: Vec<Message>,
    pub selection: ModelSelection,
    /// 权限模式（修复线 F20 起不会是 `Plan`）。
    pub mode: PermissionMode,
    /// plan 开关（修复线 F20；serde 缺省 false）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
    pub pending: Vec<(InteractionId, InteractionRequest)>,
    pub queue: Vec<QueuedInput>,
    pub last_seq: u64,
    /// `last_seq` 时的状态 revision（缺口 G1，同 [`SequencedEvent::revision`]；serde 缺省 0）。
    #[serde(default)]
    pub revision: u64,
    /// 有回合正在运行。
    #[serde(default)]
    pub running: bool,
    /// 执行环境里还没有处理完的后台命令（`ShellState::background`）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub background: Vec<ShellTaskId>,
    /// 扣住、等用户批准的同伴消息（cross-session.md §2.4，F28；serde 缺省为空）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub peer_held: Vec<crate::peers::HeldPeerMessage>,
    /// 上下文用量（token、有效窗口）：会话 actor 按当前历史与模型经 `Compactor::context_usage` 算（compact.md §2.1、
    /// tui-display.md §2.6，修复线 F27；子代理的快照由 agents 按子会话同样算，F112）；压缩模块不知道时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<crate::compaction::ContextOccupancy>,
    /// 上下文快满的提示（同一处算，F27）：冷加载后不用等下一条回复。
    #[serde(default)]
    pub context_notice: crate::compaction::ContextNotice,
    /// 本进程里最近一个完成的主回合请求（子代理的快照是子代理请求，F112）的输出速度（F105）：只在内存里，冷打开的为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_speed: Option<crate::metering::OutputSpeed>,
    /// 这段历史里的工作流控制轮（NIBI 中枢启动 / run 卡「配置」的消息记录带 `source: "workflow_launch"`
    /// 与 `metadata.workflowLaunch`，launch.md）：冷投影据它在 real-user 轮边界里重建 controlOnly 的
    /// 启动/设置轮（Node transcript-hydration 的 `workflowLaunchOfMessage` 同一判据）。serde 缺省为空。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub launches: Vec<SessionLaunchTurn>,
}

// 会话生命周期的类型（SessionStart / SessionEnd 的来源、rewind 选择器的条目）放在分出的文件里（400 行上限，
// L24 合并后拆出；路径与名字不变）。
#[path = "session_api_lifecycle.rs"]
mod lifecycle;
pub use lifecycle::{EndReason, RewindOption, StartSource};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KernelError {
    #[error("session not found: {session}")]
    NotFound { session: SessionId },
    #[error("{message}")]
    Failed { message: String },
    #[error("not implemented: {what}")]
    Unsupported { what: String },
}

#[async_trait]
pub trait SessionHandle: Send + Sync {
    fn id(&self) -> &SessionId;

    /// 这个会话还是草稿（legacy `session/create` 的 `persistence: "deferred"`，第一条用户输入之前
    /// 还没有会话行）。`session/close` 的 `expectedPersistence` 条件关闭用它。缺省不是草稿。
    fn is_draft(&self) -> bool {
        false
    }

    async fn send(&self, command: CommandEnvelope) -> Ack;

    /// 订阅 `after` 之后的事件；`after` 为空时从当前位置开始。
    fn subscribe(&self, after: Option<u64>) -> BoxStream<'static, SequencedEvent>;

    async fn view(&self) -> Result<SessionView, KernelError>;

    /// 前端离开会话时调用：运行 SessionEnd hook，返回只给用户看的提示（失败的 hook）。
    async fn close(&self, _reason: EndReason) -> Vec<String> {
        Vec::new()
    }

    /// rewind 选择器的条目（活动历史里可选的 user 消息，按顺序）。
    async fn rewind_options(&self) -> Result<Vec<RewindOption>, KernelError> {
        Err(KernelError::Unsupported {
            what: "rewind options".to_owned(),
        })
    }

    /// `/goal` 面板的数据：会话 actor 的当前目标与最近一次达成的结果（docs/specs/rust-cli/goal.md §6.2）。
    async fn goal(&self) -> Result<crate::goal::GoalView, KernelError> {
        Err(KernelError::Unsupported {
            what: "goal".to_owned(),
        })
    }

    /// 会话里还在跑的后台命令与后台子代理（`/tasks` 与 footer 的计数，tui-display.md §2.3、§3.1）。
    async fn background_tasks(&self) -> Result<Vec<crate::manage::BackgroundEntry>, KernelError> {
        Err(KernelError::Unsupported {
            what: "background tasks".to_owned(),
        })
    }

    /// 这个顶层会话里本进程启动过的子代理（含嵌套的），按启动顺序（tui-panels.md §1.1，L30）。
    async fn subagents(&self) -> Result<Vec<crate::panels::SubagentEntry>, KernelError> {
        Err(KernelError::Unsupported {
            what: "subagents".to_owned(),
        })
    }

    /// 子代理的状态有变化时产生一项（多次变化可能合并成一项）；收到后重取 [`SessionHandle::subagents`]
    /// （修复线 F34 起前端重取 [`SessionHandle::tasks_snapshot`]）。
    fn subagent_changes(&self) -> BoxStream<'static, ()> {
        futures_util::stream::pending().boxed()
    }

    /// 子代理列表与后台任务的同一份快照（修复线 F34，tui-panels.md §0、§3.1）：一次查询、一次回执。前端在子代理的变化
    /// 通知与后台任务相关的事件之后都重取它，不再分别取 [`SessionHandle::subagents`] 与
    /// [`SessionHandle::background_tasks`]（两者保留，只加不改）。缺省实现依次取那两个方法（不是同一次读取，只为别的
    /// 实现照常可用）。
    async fn tasks_snapshot(&self) -> Result<crate::panels::TasksSnapshot, KernelError> {
        Ok(crate::panels::TasksSnapshot {
            subagents: self.subagents().await?,
            background: self.background_tasks().await?,
        })
    }

    /// 子代理的只读快照：子会话里已提交的消息；`running` 是它是否在跑（tui-panels.md §1.4）。
    async fn subagent_view(&self, _agent: &AgentId) -> Result<SessionView, KernelError> {
        Err(KernelError::Unsupported {
            what: "subagent view".to_owned(),
        })
    }

    /// 一个后台命令的详情（Shell 详情，tui-panels.md §3.3）；不认识时为 None。
    /// 一个后台命令的输出尾窗（`v4/conversation/backgroundBashOutput`）：`max_bytes` 由协议层给
    /// （Host 的界是 8 KiB）。任务不认识、或所在的机器不支持时 `None`。
    async fn background_output(
        &self,
        _task: &str,
        _max_bytes: u64,
    ) -> Result<Option<crate::manage::BackgroundOutput>, KernelError> {
        Ok(None)
    }

    /// 每一轮的改动摘要（冷投影的轮头 `fileChanges`）：按开启这一轮的 user 消息分组。
    /// 读不出 artifact 的回合跳过（只影响轮头角标，不影响会话打开）。
    async fn file_change_summaries(
        &self,
    ) -> Result<Vec<crate::file_changes::TurnFileSummary>, KernelError> {
        Err(KernelError::Unsupported {
            what: "file change summaries".to_owned(),
        })
    }

    /// `v4/conversation/fileChanges`：给定消息集合（一轮里的 user / assistant 消息）的文件改动明细。
    async fn file_changes(
        &self,
        _messages: &[MessageId],
    ) -> Result<crate::file_changes::FileChangesReport, KernelError> {
        Err(KernelError::Unsupported {
            what: "file changes".to_owned(),
        })
    }

    /// `v4/conversation/fileRewindPreview`：给定消息集合的只读回退预览（不登记 token、不改文件）。
    async fn file_rewind_preview(
        &self,
        _messages: &[MessageId],
    ) -> Result<crate::file_changes::RewindPreview, KernelError> {
        Err(KernelError::Unsupported {
            what: "file rewind preview".to_owned(),
        })
    }

    async fn shell_detail(
        &self,
        _task: &str,
    ) -> Result<Option<crate::panels::ShellDetail>, KernelError> {
        Err(KernelError::Unsupported {
            what: "shell detail".to_owned(),
        })
    }
}

#[async_trait]
pub trait Kernel: Send + Sync {
    async fn create_session(&self, request: CreateSession) -> Result<SessionId, KernelError>;

    /// 建会话并写入导入的历史（NIBI `createSession.importedHistory`）：标题、创建时间与父会话
    /// 一起落库，历史消息按提交顺序写进同一个会话。缺省 `Unsupported`，调用方必须 fail-closed，
    /// 不能静默建一个空会话。
    async fn create_session_with_history(
        &self,
        _request: CreateSession,
        _title: Option<String>,
        _created_at_ms: Option<u64>,
        _parent: Option<SessionId>,
        _history: Vec<ImportedMessage>,
    ) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "imported session history".to_owned(),
        })
    }

    /// 建会话时落父会话（legacy `session/create` 的 `parentSessionId`）：fork / 项目会话的父链。
    /// 缺省忽略父会话、照常建会话；能落父链的入口覆写（运行时的实现与 `create_session_with_history`
    /// 共用一条写入路径）。
    async fn create_session_with_parent(
        &self,
        request: CreateSession,
        _parent: Option<SessionId>,
    ) -> Result<SessionId, KernelError> {
        self.create_session(request).await
    }

    /// 建会话但先不落库（legacy `session/create` 的 `persistence: "deferred"`）：草稿只在内存里，
    /// 不出现在会话列表、`sessions-index` 与搜索里；第一条用户输入提交时才写会话行与历史
    /// （Node `ensureSessionPersisted`）。`parent` 同 [`Self::create_session_with_parent`]。
    /// 缺省 `Unsupported`，调用方降级成立即落库并在日志里点名。
    async fn create_session_deferred(
        &self,
        _request: CreateSession,
        _parent: Option<SessionId>,
    ) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "deferred session persistence".to_owned(),
        })
    }

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError>;

    async fn list_sessions(
        &self,
        filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError>;

    /// 同 [`Kernel::create_session`]，另给 SessionStart 的来源（`/clear` 之后的新会话是 `Clear`）。
    async fn create_session_as(
        &self,
        request: CreateSession,
        _source: StartSource,
    ) -> Result<SessionId, KernelError> {
        self.create_session(request).await
    }

    /// 同 [`Kernel::open_session`]，另给 SessionStart 的来源（刚 fork 出的会话是 `Fork`）。
    /// 会话已经打开时来源不起作用。
    async fn open_session_as(
        &self,
        session: &SessionId,
        _source: StartSource,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        self.open_session(session).await
    }

    /// 上下文用量（`/context`，docs/specs/rust-cli/context-usage.md）：只读，不改会话。
    async fn context_usage(
        &self,
        _query: crate::context_usage::ContextUsageQuery,
    ) -> Result<crate::context_usage::ContextUsage, KernelError> {
        Err(KernelError::Unsupported {
            what: "context usage".to_owned(),
        })
    }

    /// 给会话装上创建期给的 MCP 服务器（NIBI 协议 `createSession.mcpServers`）：
    /// 这批服务器属于这个会话，连接在后台建立、不等结果；会话的工具表就是它们（与 Node 的
    /// runtimeConfig.mcp 同语义）。空列表表示"这个会话没有 MCP"，不连接任何服务器。
    ///
    /// 缺省实现不接（TUI / `-p` 用进程级配置，不经过这里）：返回 `Unsupported`，调用方只记日志。
    async fn start_session_mcp(
        &self,
        _session: &SessionId,
        _workspace: &WorkspaceRef,
        _servers: Vec<crate::mcp_session::SessionMcpServer>,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "session MCP servers".to_owned(),
        })
    }

    /// 会话关闭时释放它的 MCP 连接（含连接任务）：之后打开同一会话要由调用方重新给。
    /// 缺省什么都不做。
    fn stop_session_mcp(&self, _session: &SessionId) {}

    /// 给会话装上附加工作目录（NIBI `createSession.additionalDirectories`）：判决链把它们按
    /// "在工作区内"处理，提示词的环境段列出它们。空列表等于没有。缺省实现返回 `Unsupported`。
    async fn set_session_directories(
        &self,
        _session: &SessionId,
        _directories: Vec<crate::env::EnvPath>,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "session additional directories".to_owned(),
        })
    }

    /// 工作区钩子的评审快照（NIBI `requestWorkspaceHookReview` 的数据来源）：bundle 摘要、逐条钩子
    /// 与它们的信任状态。只读。缺省实现返回 `Unsupported`。
    async fn workspace_hook_review(
        &self,
        _workspace: &WorkspaceRef,
    ) -> Result<crate::hook_review::WorkspaceHookReview, KernelError> {
        Err(KernelError::Unsupported {
            what: "workspace hook review".to_owned(),
        })
    }

    /// 按评审项授权持久信任（NIBI `respondWorkspaceHookReview`）：返回授了几条。
    /// 不在快照里的 id 忽略。缺省实现返回 `Unsupported`。
    async fn grant_workspace_hooks(
        &self,
        _workspace: &WorkspaceRef,
        _review_item_ids: &[String],
    ) -> Result<usize, KernelError> {
        Err(KernelError::Unsupported {
            what: "workspace hook review".to_owned(),
        })
    }

    /// 按声明摘要撤销持久信任（NIBI `revokeWorkspaceHookTrust`）：返回撤了几条。
    /// 缺省实现返回 `Unsupported`。
    async fn revoke_workspace_hooks(
        &self,
        _workspace: &WorkspaceRef,
        _declaration_digests: &[String],
    ) -> Result<usize, KernelError> {
        Err(KernelError::Unsupported {
            what: "workspace hook review".to_owned(),
        })
    }

    /// 在可编辑的项目配置（`<工作区根>/.nibi/config.json`）里打开或关闭一条钩子（NIBI
    /// `toggleWorkspaceHookReviewItem`）：只改 `enabled`，声明本体与信任记录不动。
    /// 缺省实现返回 `Unsupported`。
    async fn set_workspace_hook_enabled(
        &self,
        _workspace: &WorkspaceRef,
        _review_item_id: &str,
        _enabled: bool,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "workspace hook config writes".to_owned(),
        })
    }

    /// 会话的分享导入状态（NIBI 快照的 `sharedContextImport`）：冷打开时喂给投影。没有导入时 None。
    async fn shared_context_import(
        &self,
        _session: &SessionId,
    ) -> Result<Option<crate::shared_context::SharedContextImportState>, KernelError> {
        Ok(None)
    }

    /// NIBI `discardSharedContext`：把还没附加（`pending`）的分享导入标成 `discarded`，返回更新后的
    /// 状态（没有可放进快照的元数据时是 None，但写入照常发生）。缺省实现返回 `Unsupported`。
    async fn discard_shared_context(
        &self,
        _session: &SessionId,
        _context_id: &str,
    ) -> Result<Option<crate::shared_context::SharedContextImportState>, KernelError> {
        Err(KernelError::Unsupported {
            what: "shared context imports".to_owned(),
        })
    }

    /// 会话发起的 DWF run（NIBI run 卡 / 详情页的只读数据，`dwf_run` 表）。run 的真相在引擎的
    /// journal；这里只是读面。缺省实现返回空（TUI / `-p` 不展示 run）。
    async fn dynamic_workflow_runs(
        &self,
        _session: &SessionId,
    ) -> Result<Vec<crate::workflow::DynamicWorkflowRun>, KernelError> {
        Ok(Vec::new())
    }

    // ——— v4 查询面（141 审计 §9 第 2 项）———
    //
    // 六条 run 读面与两条 usage 聚合。**缺省一律返回空 / `Unsupported`**：这些是 NIBI 桌面
    // 的投影面，TUI 与 `-p` 没有读者；协议层按「内核不支持 → 回空结果」处理，与 Node 的
    // journal 缺席同规（中枢显示「尚未运行」而不是报错）。

    /// 本会话的 run 目录（`v4/conversation/workflowRuns`），最近更新在前。
    async fn workflow_run_summaries(
        &self,
        _session: &SessionId,
        _limit: usize,
    ) -> Result<Vec<crate::workflow::WorkflowRunSummaryRow>, KernelError> {
        Ok(Vec::new())
    }

    /// 一个 run 的事件日志的一页（`v4/conversation/workflowRunEvents`）。
    async fn workflow_run_events(
        &self,
        _session: &SessionId,
        _run_id: &str,
        _query: crate::workflow::WorkflowRunEventQuery,
    ) -> Result<crate::workflow::WorkflowRunEventPage, KernelError> {
        Ok(crate::workflow::WorkflowRunEventPage {
            events: Vec::new(),
            has_more: false,
        })
    }

    /// 一个 run 的用户面产物清单（`v4/conversation/workflowRunArtifacts`）。未知 / 不属于本会话
    /// 回 `None`。
    async fn workflow_run_artifacts(
        &self,
        _session: &SessionId,
        _run_id: &str,
    ) -> Result<Option<Vec<crate::workflow::WorkflowRunArtifactDetail>>, KernelError> {
        Ok(None)
    }

    /// 喂给某个预置产物的 `report` 条目的一页（`v4/conversation/workflowRunArtifactData`）。
    async fn workflow_run_artifact_items(
        &self,
        _session: &SessionId,
        _run_id: &str,
        _query: crate::workflow::WorkflowRunArtifactItemQuery,
    ) -> Result<crate::workflow::WorkflowRunArtifactItemPage, KernelError> {
        Ok(crate::workflow::WorkflowRunArtifactItemPage {
            items: Vec::new(),
            has_more: false,
        })
    }

    /// 一个产物版本的字节（`v4/conversation/workflowRunArtifactRead`）：run 属于本会话 ∧
    /// journal 里有该版本的 completed 行才读。无此版本 / 不是你的 run / 是看板 → `None`。
    async fn workflow_run_artifact_bytes(
        &self,
        _session: &SessionId,
        _run_id: &str,
        _artifact_id: &str,
        _version: u64,
    ) -> Result<Option<(Vec<u8>, Option<String>)>, KernelError> {
        Ok(None)
    }

    /// 一个 run 的工作区 transcript 清单（`v4/conversation/workflowRunWorkspace`，不带正文）。
    async fn workflow_run_workspace(
        &self,
        _session: &SessionId,
        _run_id: &str,
    ) -> Result<Option<Vec<crate::workflow::WorkflowRunWorkspaceNode>>, KernelError> {
        Ok(None)
    }

    /// 一个工作区节点的正文（`v4/conversation/workflowRunNodeResult`），按 `max_bytes` 保形有界化。
    async fn workflow_run_node_result(
        &self,
        _session: &SessionId,
        _run_id: &str,
        _site_id: &str,
        _ordinal: u64,
        _max_bytes: u64,
    ) -> Result<Option<crate::workflow::WorkflowRunNodeResult>, KernelError> {
        Ok(None)
    }

    /// 应用级用量聚合（`v4/usage/stats`）。缺省 `Unsupported`：协议层据此回空快照（UI 显示空态）。
    async fn app_usage(
        &self,
        _query: crate::usage::AppUsageQuery,
    ) -> Result<crate::usage::AppUsage, KernelError> {
        Err(KernelError::Unsupported {
            what: "app usage aggregation".to_owned(),
        })
    }

    /// 会话级 token 用量（`v4/conversation/usage`）。缺省 `Unsupported`，协议层回零值结果。
    async fn session_usage(
        &self,
        _session: &SessionId,
    ) -> Result<crate::usage::SessionUsage, KernelError> {
        Err(KernelError::Unsupported {
            what: "session usage aggregation".to_owned(),
        })
    }

    /// NIBI `startSavedWorkflow`：按名字启动一个已保存的工作流（引擎在 sidecar）。
    /// 缺省实现返回 `Unsupported`（引擎没接的入口）。
    async fn start_saved_workflow(
        &self,
        _parent: &SessionId,
        _request: crate::workflow::WorkflowStart,
    ) -> Result<crate::workflow::WorkflowRunStarted, KernelError> {
        Err(KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })
    }

    /// NIBI `resumeWorkflowRun`：恢复一个可恢复的 run（`workId ≡ runId`）。
    async fn resume_workflow_run(
        &self,
        _run_id: &str,
        _name: Option<&str>,
    ) -> Result<crate::workflow::WorkflowRunStarted, KernelError> {
        Err(KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })
    }

    /// NIBI `cancelBackgroundWork` 的 DWF 分支：`workId ≡ runId` 指向一个 DWF run 时取消它。
    /// 缺省实现返回 `Unsupported`（没有引擎的入口）。
    async fn cancel_workflow_run(&self, _run_id: &str) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })
    }

    /// NIBI `amendWorkflowRunSettings`：以新设置修订一个 run（两项设置三态）。
    async fn amend_workflow_run(
        &self,
        _request: crate::workflow::WorkflowAmend,
    ) -> Result<crate::workflow::WorkflowRunStarted, KernelError> {
        Err(KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })
    }

    /// 跑一轮 DWF actor（路线 C：引擎在 Node sidecar，actor 的模型轮在 Rust）。
    ///
    /// `first` 为真时先建 actor 子会话；`cancel` 取消时按 `aborted` 收口。缺省实现返回 `Unsupported`
    /// （TUI / `-p` 不跑 DWF）。
    async fn run_workflow_actor(
        &self,
        _request: crate::workflow::WorkflowActorRequest,
        _cancel: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<crate::workflow::WorkflowActorTurn, KernelError> {
        Err(KernelError::Unsupported {
            what: "dynamic workflow actors".to_owned(),
        })
    }

    /// 回答一个 actor 升级上来的阻塞问题（主代理的 `ResolveWorkflowQuestion` 工具）。
    ///
    /// 只有 run 的父会话能回答自己的问题（跨会话的 qid 按 `unknown_question` 拒绝）。
    /// 缺省实现返回 `Unsupported`（没有 DWF 引擎的入口）。
    async fn resolve_workflow_question(
        &self,
        _session: &SessionId,
        _qid: &str,
        _answer: &str,
    ) -> Result<crate::workflow::WorkflowQuestionResolved, KernelError> {
        Err(KernelError::Unsupported {
            what: "dynamic workflow questions".to_owned(),
        })
    }

    /// 一个会话名下的 run 还欠答案的问题（按提问顺序）。缺省为空。
    async fn pending_workflow_questions(
        &self,
        _session: &SessionId,
    ) -> Result<Vec<crate::workflow::WorkflowQuestion>, KernelError> {
        Ok(Vec::new())
    }

    /// 读出一条会话附件（NIBI `AttachmentRef`）：artifact URI 经会话的 artifact 存储，路径经会话所在
    /// 机器的文件端口。`workspace` 是这条命令的会话工作区（相对路径按它解析）。
    ///
    /// 缺省实现返回 `Unsupported`：调用方按"附件不可用"拒绝这条命令（不静默丢内容）。
    async fn load_attachment(
        &self,
        _session: &SessionId,
        _workspace: &WorkspaceRef,
        _source: crate::attachment::AttachmentSource,
    ) -> Result<crate::attachment::LoadedAttachment, KernelError> {
        Err(KernelError::Unsupported {
            what: "session attachments".to_owned(),
        })
    }

    /// 把一次上传事务的完整内容写进会话的 artifact 存储（`v4/attachment/commit`）。
    ///
    /// 调用方（协议层）已经逐片核过总量与 checksum；这里只负责**原子写**并回引用。会话不存在时
    /// `NotFound`。缺省实现 `Unsupported`，协议层回结构化的 `fault.attachment.putUnsupported`。
    async fn store_attachment(
        &self,
        _session: &SessionId,
        _file_name: &str,
        _media_type: &str,
        _bytes: Vec<u8>,
    ) -> Result<crate::attachment::StoredAttachment, KernelError> {
        Err(KernelError::Unsupported {
            what: "session attachment storage".to_owned(),
        })
    }

    /// 读出一条**已发送**附件的内容与元数据（`v4/attachment/read` 与 share 的
    /// `conversation/attachmentRead|attachmentStat`）。与 [`Self::load_attachment`] 的区别：那条是
    /// 命令准入时把引用变成内容块，这条是 UI 按已授权的行/引用回读，`mtime_ms` 供 share 预检判断
    /// 文件是否在选中之后被改过。
    ///
    /// 缺省实现 `Unsupported`，协议层回 `fault.attachment.readUnsupported` / `statUnsupported`。
    async fn read_attachment(
        &self,
        _session: &SessionId,
        _workspace: &WorkspaceRef,
        _source: crate::attachment::AttachmentSource,
        _media_type: &str,
    ) -> Result<crate::attachment::AttachmentPayload, KernelError> {
        Err(KernelError::Unsupported {
            what: "session attachment reads".to_owned(),
        })
    }

    /// `@` 补全的文件清单（docs/specs/rust-cli/tui-input.md §1.2）：相对 shell 当前目录的文件路径。
    async fn workspace_files(
        &self,
        _workspace: &crate::env::WorkspaceRef,
    ) -> Result<Vec<String>, KernelError> {
        Err(KernelError::Unsupported {
            what: "workspace files".to_owned(),
        })
    }

    /// 这个工作区里用户可调用的斜杠命令（skill，TUI 的补全；ext.md §2.7，L22）。默认没有。
    async fn user_commands(
        &self,
        _workspace: &crate::env::WorkspaceRef,
    ) -> Vec<crate::user_command::UserCommand> {
        Vec::new()
    }

    /// MCP 服务器的状态（`/mcp`、`/status`，tui-display.md §3.4，L28）。默认没有。
    async fn mcp_servers(&self) -> Vec<crate::manage::McpServerInfo> {
        Vec::new()
    }

    /// `mcp/list`（141 审计 §9 第 6 项，Host `zcodeMcpListParamsSchema`）：`connect` 收敛连接集合并
    /// 等连接落定，`status` 只读快照。默认 `Unsupported`（没有 MCP 能力的实现）。
    async fn mcp_list(
        &self,
        _request: crate::mcp_status::McpListRequest,
    ) -> Result<Vec<crate::mcp_status::McpServerStatus>, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP server status listing".to_owned(),
        })
    }

    /// `mcp/uiOpenInstance`（MCP Apps）：为页面开一个实例凭证。默认 `Unsupported`。
    async fn mcp_ui_open(
        &self,
        _request: crate::mcp_ui::McpUiOpenRequest,
    ) -> Result<crate::mcp_ui::McpAppInstance, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app instances".to_owned(),
        })
    }

    /// `mcp/uiCloseInstance`：`only_if_idle` 时只关没有进行中调用的实例。
    async fn mcp_ui_close(
        &self,
        _request: crate::mcp_ui::McpUiInstanceRequest,
        _only_if_idle: bool,
    ) -> Result<bool, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app instances".to_owned(),
        })
    }

    /// `mcp/uiValidateInstance`：凭证、作用域与当前连接三者都对上才算有效。
    async fn mcp_ui_validate(
        &self,
        _request: crate::mcp_ui::McpUiInstanceRequest,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app instances".to_owned(),
        })
    }

    /// `mcp/readResource`：宿主取页面的 `ui://` HTML（实例绑定的资源）。
    async fn mcp_ui_read_resource(
        &self,
        _request: crate::mcp_ui::McpUiReadRequest,
    ) -> Result<Vec<crate::mcp_ui::McpResourceContent>, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app resources".to_owned(),
        })
    }

    /// `mcp/uiReadResource`：页面发起的资源读取（`_meta` 由协议层剥掉并判界）。
    async fn mcp_ui_read_resource_for_ui(
        &self,
        _request: crate::mcp_ui::McpUiReadRequest,
    ) -> Result<Vec<crate::mcp_ui::McpResourceContent>, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app resources".to_owned(),
        })
    }

    /// `mcp/uiListResources`：页面发起的 `resources/list`（一页）。
    async fn mcp_ui_list_resources(
        &self,
        _request: crate::mcp_ui::McpUiListRequest,
    ) -> Result<crate::mcp_ui::McpResourcePage, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app resources".to_owned(),
        })
    }

    /// `mcp/uiListResourceTemplates`：页面发起的 `resources/templates/list`（一页）。
    async fn mcp_ui_list_resource_templates(
        &self,
        _request: crate::mcp_ui::McpUiListRequest,
    ) -> Result<crate::mcp_ui::McpResourceTemplatePage, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app resources".to_owned(),
        })
    }

    /// `mcp/uiSubscribeResource`：页面订阅一个资源（按服务器与 URI 引用计数）。
    async fn mcp_ui_subscribe(
        &self,
        _request: crate::mcp_ui::McpUiSubscriptionRequest,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app resource subscriptions".to_owned(),
        })
    }

    /// `mcp/uiUnsubscribeResource`：页面退订一个资源（最后一个订阅者退订时通知服务器）。
    async fn mcp_ui_unsubscribe(
        &self,
        _request: crate::mcp_ui::McpUiSubscriptionRequest,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app resource subscriptions".to_owned(),
        })
    }

    /// `mcp/uiCallTool`：页面回调一个本服务器的工具（工具名是服务器给的原始名）。
    ///
    /// 复用宿主的工具审批链（schema → PreToolUse hooks → 权限判决，可能经会话询问用户），
    /// 批准后直接发 `tools/call`；结果是 MCP 的原始 `CallToolResult`，不产生对话回合、不落库。
    /// 缺省 `Unsupported`（没有 MCP 能力的实现）。
    async fn mcp_ui_call_tool(
        &self,
        _request: crate::mcp_ui::McpUiCallToolRequest,
    ) -> Result<serde_json::Value, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app tool calls".to_owned(),
        })
    }

    /// `mcp/uiCancelCall`：取消一个进行中的页面工具调用；没有这个调用时 `false`（幂等）。
    async fn mcp_ui_cancel_call(
        &self,
        _request: crate::mcp_ui::McpUiCancelCallRequest,
    ) -> Result<bool, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app tool calls".to_owned(),
        })
    }

    /// `mcp/uiRegisterAppTools`（App-Provided Tools）：页面把它的工具登记给模型，返回曝光部分的
    /// 页面名与模型名。缺省 `Unsupported`。
    async fn mcp_ui_register_app_tools(
        &self,
        _request: crate::mcp_ui::McpUiRegisterAppToolsRequest,
    ) -> Result<Vec<crate::mcp_ui::McpUiAppToolRegistration>, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app tools".to_owned(),
        })
    }

    /// `mcp/uiUnregisterAppTools`：收回实例的工具，返回它登记时声明的工具数。
    async fn mcp_ui_unregister_app_tools(
        &self,
        _request: crate::mcp_ui::McpUiUnregisterAppToolsRequest,
    ) -> Result<usize, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app tools".to_owned(),
        })
    }

    /// `mcp/uiClaimAppToolCall`：渲染端认领一次待执行的 AppTool 调用。
    async fn mcp_ui_claim_app_tool_call(
        &self,
        _request: crate::mcp_ui::McpUiClaimAppToolCallRequest,
    ) -> Result<bool, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app tools".to_owned(),
        })
    }

    /// `mcp/uiResolveAppToolCall`：页面回传执行结果或错误（二者恰有一个）。
    async fn mcp_ui_resolve_app_tool_call(
        &self,
        _request: crate::mcp_ui::McpUiResolveAppToolCallRequest,
    ) -> Result<bool, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app tools".to_owned(),
        })
    }

    /// `mcp/uiSampling`：页面请求宿主模型采样一次（回合外的一次性模型请求）。
    async fn mcp_ui_sampling(
        &self,
        _request: crate::mcp_ui::McpUiSamplingRequest,
    ) -> Result<crate::mcp_ui::McpUiSamplingResult, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app sampling".to_owned(),
        })
    }

    /// `mcp/uiCancelSampling`：取消进行中的采样；没有时 `false`（幂等）。
    async fn mcp_ui_cancel_sampling(
        &self,
        _request: crate::mcp_ui::McpUiCancelSamplingRequest,
    ) -> Result<bool, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP app sampling".to_owned(),
        })
    }

    /// 仍在运行的 MCP 子进程（`process/childProcesses`，141 审计 §9 F3）：pid 与归属，不含采样值。
    /// 桌面按 pid 把整机进程表归到插件；缺省为空（没有 MCP 能力的实现）。
    async fn mcp_child_processes(&self) -> Vec<crate::mcp_state::McpChildProcess> {
        Vec::new()
    }

    /// 五分钟 MCP 资源采样的目标（`process/mcpResourceSamples`，141 审计 §9 F3）：与
    /// [`mcp_child_processes`](Self::mcp_child_processes) 同一份清单，另带 `mcpId` / 实例标识 /
    /// 启动时刻。缺省为空（没有 MCP 能力的实现）。
    async fn mcp_resource_targets(&self) -> Vec<crate::process_table::McpResourceTarget> {
        Vec::new()
    }

    /// `/plan open`（tui-manage.md §8，L29）：会话的计划文件位置，以及它是否有内容。
    async fn plan_file(
        &self,
        _query: crate::manage::PlanFileQuery,
    ) -> Result<crate::manage::PlanFile, KernelError> {
        Err(KernelError::Unsupported {
            what: "plan file".to_owned(),
        })
    }

    /// `/cd <path>`（tui-manage.md §7，L29）：解析与检查路径；有会话时经会话 actor 换工作目录。错误是给用户看的
    /// 文字（`Failed`）。
    async fn change_directory(
        &self,
        _request: crate::manage::ChangeDirectory,
    ) -> Result<crate::manage::DirectoryChanged, KernelError> {
        Err(KernelError::Unsupported {
            what: "changing the working directory".to_owned(),
        })
    }

    /// `/mcp reconnect|enable|disable`（tui-manage.md §6，L29）：经 ext 的连接管理改连接，返回这些服务器
    /// 改动后的状态。默认 `Unsupported`。
    async fn mcp_control(
        &self,
        _control: crate::manage::McpControl,
    ) -> Result<Vec<crate::manage::McpServerInfo>, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP server control".to_owned(),
        })
    }

    /// 当前生效的 hook 配置（`/hooks`，tui-display.md §3.5，L28）：只读。默认没有。
    async fn hooks(&self) -> Vec<crate::manage::HookEntry> {
        Vec::new()
    }

    /// `/diff` 的未提交改动（tui-manage.md §4，L29）：执行环境里 git 的原始输出。
    async fn uncommitted_diff(
        &self,
        _workspace: &crate::env::WorkspaceRef,
    ) -> Result<crate::env_git::GitDiff, KernelError> {
        Err(KernelError::Unsupported {
            what: "uncommitted diff".to_owned(),
        })
    }

    /// `/export <文件名>`（tui-manage.md §3，L29）：经执行环境写文件，返回写入的绝对路径。
    async fn write_export(&self, _file: crate::manage::ExportFile) -> Result<String, KernelError> {
        Err(KernelError::Unsupported {
            what: "exporting the conversation".to_owned(),
        })
    }

    /// `/permissions` 的规则列表（tui-manage.md §1.1，L29）：规则快照、本机项目规则集（现读）与会话规则。
    async fn permission_rules(
        &self,
        _query: crate::permission::PermissionRulesQuery,
    ) -> Result<Vec<crate::permission::SourcedRule>, KernelError> {
        Err(KernelError::Unsupported {
            what: "permission rules".to_owned(),
        })
    }

    /// `/permissions` 的修改（tui-manage.md §1.1）：落库后换上新的规则快照，返回修改后的列表。
    async fn change_permission_rules(
        &self,
        _change: crate::permission::PermissionRulesChange,
    ) -> Result<Vec<crate::permission::SourcedRule>, KernelError> {
        Err(KernelError::Unsupported {
            what: "changing permission rules".to_owned(),
        })
    }

    /// `/usage` 的 API 时长（docs/specs/rust-cli/usage.md §4）：从存储的用量表查。默认 `Unsupported`。
    async fn session_metering(
        &self,
        _session: &SessionId,
    ) -> Result<crate::metering::SessionMetering, KernelError> {
        Err(KernelError::Unsupported {
            what: "session metering".to_owned(),
        })
    }

    /// footer 的请求统计（TPS 与缓存命中率，docs/specs/rust-cli/tui-display.md §2.6，修复线 F27）：从存储的用量表查。
    /// 默认 `Unsupported`。
    async fn request_stats(
        &self,
        _session: &SessionId,
    ) -> Result<crate::metering::RequestStats, KernelError> {
        Err(KernelError::Unsupported {
            what: "request stats".to_owned(),
        })
    }

    /// 活动统计（`/stats`，usage.md §5）：今天与时区偏移取自内核的时钟，聚合在存储。默认 `Unsupported`。
    async fn activity(
        &self,
        _range: crate::metering::ActivityRange,
    ) -> Result<crate::metering::ActivityStats, KernelError> {
        Err(KernelError::Unsupported {
            what: "activity stats".to_owned(),
        })
    }

    /// ← 项目页与 `/resume` 页的会话（修复线 F29，tui-panels.md §2.1）：存储的查询加本进程里打开着的会话的
    /// 实时状态与目录的分支。默认 `Unsupported`。
    async fn project_sessions(
        &self,
        _query: crate::store::SessionQuery,
    ) -> Result<crate::panels::ProjectSessions, KernelError> {
        Err(KernelError::Unsupported {
            what: "project sessions".to_owned(),
        })
    }

    /// 给会话改名（F29，tui-manage.md §10.6）：打开着的经它的 actor（`Command::Rename`），否则直接写存储。
    async fn rename_session(
        &self,
        _session: &SessionId,
        _title: String,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "renaming sessions".to_owned(),
        })
    }

    /// 删除会话（F29，tui-manage.md §10.6）：打开着的拒绝（`Failed`），否则存储软删除。
    async fn delete_session(&self, _session: &SessionId) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "deleting sessions".to_owned(),
        })
    }

    /// 会话的只读快照（F29，`/resume` 页的预览与全屏对话）：打开着的问它的 actor，否则从存储冷加载；不打开会话、
    /// 不启动 actor、不跑 SessionStart。
    async fn session_snapshot(&self, _session: &SessionId) -> Result<SessionView, KernelError> {
        Err(KernelError::Unsupported {
            what: "session snapshots".to_owned(),
        })
    }

    /// 会话里每条消息的持久时间（旧协议快照的时间戳）。缺省 `Unsupported`，调用方回退到会话
    /// 创建时间；node-store 从 `message` 行的 `time_created/time_updated` 读出。
    async fn session_message_times(
        &self,
        _session: &SessionId,
    ) -> Result<HashMap<MessageId, MessageTime>, KernelError> {
        Err(KernelError::Unsupported {
            what: "message timestamps".to_owned(),
        })
    }

    /// 设置会话级工具清单（NIBI `createSession.toolAllowlist/toolDenylist`）：判决链与工具注册表
    /// 都按它过滤。缺省 `Unsupported`，调用方必须 fail-closed，不能继续用未限制的工具面。
    async fn set_session_tool_policy(
        &self,
        _session: &SessionId,
        _policy: ToolPolicy,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "session tool policies".to_owned(),
        })
    }

    /// 会话可用的工具、agent 与 skill（`-p` 的 stream-json 写 `system/init`，docs/specs/rust-cli/headless.md §3.3，
    /// 修复线 F39）：只读。默认 `Unsupported`。
    async fn session_catalog(
        &self,
        _query: crate::catalog::CatalogQuery,
    ) -> Result<crate::catalog::SessionCatalog, KernelError> {
        Err(KernelError::Unsupported {
            what: "session catalog".to_owned(),
        })
    }

    /// 给会话投一条后台通知（`Agents::notify` 的 `task-notification` 同一条路，空闲时开 model-only
    /// 的通知轮）：工作流 run 的终态通知从这里进父会话（升级提示同路，runtime 组装时接上通知中心）。
    /// 缺省没有通知中心（TUI / `-p` 不经这里）。
    fn workflow_notices(&self) -> Option<std::sync::Arc<dyn crate::workflow::WorkflowNotices>> {
        None
    }

    /// 「run 还欠着决定、主代理闲着」提醒钟的会话侧边（[`crate::workflow::WorkflowBlockedEdges`]，
    /// docs/dynamic-workflow/transcript-and-notifications.md「Reminding an idle main agent」）：
    /// 会话 actor 在忙闲转换处调用，引擎客户端把 run 的开集事件经这里转发给父会话的钟。
    /// 缺省没有（TUI / `-p` 不经这里）。
    fn workflow_blocked(&self) -> Option<std::sync::Arc<dyn crate::workflow::WorkflowBlockedEdges>> {
        None
    }

    /// 把 DWF 引擎的归属事实写进父会话的事件流（`v4/telemetry/event` 的 `workflow.lifecycle`
    /// 事实来源）：`actor-created` → `actor-spawned`，`run-settled` → `run-settled`。会话不在本进程
    /// （已关闭）或入口没有会话事件流时返回 false，调用方只记日志。
    fn note_workflow_lifecycle(&self, _session: &SessionId, _fact: WorkflowLifecycleFact) -> bool {
        false
    }

    /// GUI 中枢的已保存工作流读面（`workflows/list` / `workflows/get`）：frontmatter 解析器在
    /// sidecar 的 @nibi/core，没接 sidecar 的入口回 `Unsupported`（协议层按空页 / not_found 降级）。
    async fn hub_list_saved_workflows(
        &self,
        _workspace_path: &str,
        _scope: &str,
    ) -> Result<serde_json::Value, KernelError> {
        Err(KernelError::Unsupported {
            what: "saved workflow listing".to_owned(),
        })
    }

    async fn hub_get_saved_workflow(
        &self,
        _workspace_path: &str,
        _name: &str,
        _scope: &str,
    ) -> Result<serde_json::Value, KernelError> {
        Err(KernelError::Unsupported {
            what: "saved workflow lookup".to_owned(),
        })
    }

    /// GUI 中枢的已保存工作流写面（`workflows/save` / `updateMeta` / `delete` / `move`）：
    /// 序列化器与编译检查在 sidecar，没接 sidecar 的入口**没有降级**——写面没有「照旧空页」
    /// 的诚实形状（假装删除了一个看不见的文件、或写一个解析不了的文件都是谎），缺省 `Unsupported`
    /// 由 runtime 层升为明确失败。
    async fn hub_save_workflow_from_run(
        &self,
        _workspace_path: &str,
        _run_id: &str,
        _name: &str,
        _meta: serde_json::Value,
        _scope: &str,
        _overwrite: bool,
    ) -> Result<serde_json::Value, KernelError> {
        Err(KernelError::Unsupported {
            what: "saving workflows from runs".to_owned(),
        })
    }

    async fn hub_update_saved_workflow_meta(
        &self,
        _workspace_path: &str,
        _name: &str,
        _meta: serde_json::Value,
        _scope: &str,
    ) -> Result<serde_json::Value, KernelError> {
        Err(KernelError::Unsupported {
            what: "saved workflow meta updates".to_owned(),
        })
    }

    async fn hub_delete_saved_workflow(
        &self,
        _workspace_path: &str,
        _name: &str,
        _scope: &str,
    ) -> Result<serde_json::Value, KernelError> {
        Err(KernelError::Unsupported {
            what: "saved workflow deletion".to_owned(),
        })
    }

    async fn hub_move_saved_workflow(
        &self,
        _workspace_path: &str,
        _name: &str,
    ) -> Result<serde_json::Value, KernelError> {
        Err(KernelError::Unsupported {
            what: "saved workflow moves".to_owned(),
        })
    }

    /// `workflows/forRun`（完成卡的推导判定）：候选与脚本比对都要 sidecar 的 frontmatter
    /// 解析器。没接 sidecar 的入口回 `Unsupported`，runtime 层按「run 记录缺席」的原形降级
    /// （Node 自己查不到 run 时回的就是空对象）。
    async fn hub_find_saved_workflow_for_run(
        &self,
        _workspace_path: &str,
        _run_id: &str,
        _candidates: serde_json::Value,
    ) -> Result<serde_json::Value, KernelError> {
        Err(KernelError::Unsupported {
            what: "saved workflow lookup for a run".to_owned(),
        })
    }

    /// `workflows/runs`（NIBI 协议中枢）：运行历史的一页（journal 直读，**跨会话**）。
    /// 不支持的入口回 `Unsupported`——协议层按 Node 的 journal 缺席同规回空页。
    async fn workflow_runs_page(
        &self,
        _cwd: Option<String>,
        _name: Option<String>,
        _limit: usize,
    ) -> Result<Vec<crate::workflow::WorkflowRunPageRow>, KernelError> {
        Err(KernelError::Unsupported {
            what: "workflow runs page".to_owned(),
        })
    }

    /// 旧会话的询问（docs/specs/rust-cli/agents.md §4.1.2，工作线 F72）：先给出还没回答的，再给出之后的变化。缺省
    /// 没有（流不结束）。
    fn detached_asks(&self) -> BoxStream<'static, crate::interaction::DetachedEvent> {
        futures_util::stream::pending().boxed()
    }

    /// 回答旧会话的询问（回答的形状同 [`Command::ResolveInteraction`]）。缺省 `Unsupported`。
    async fn resolve_detached(
        &self,
        _interaction: &InteractionId,
        _answer: Value,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "answering questions of closed sessions".to_owned(),
        })
    }

    /// 写一条前端记录（缺口 G2，docs/specs/rust-cli/app-protocol.md §5.2）：内核不解释它，经存储端口原样落库（同 key
    /// 覆盖）；会话不存在时 `NotFound`。缺省 `Unsupported`。
    async fn put_session_record(
        &self,
        _session: &SessionId,
        _record: crate::store::FrontendRecord,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "frontend records".to_owned(),
        })
    }

    /// 这个会话里某一种前端记录，按写入顺序（缺口 G2）。缺省没有。
    async fn session_records(
        &self,
        _session: &SessionId,
        _kind: &str,
    ) -> Result<Vec<crate::store::FrontendRecord>, KernelError> {
        Ok(Vec::new())
    }

    /// 工作区的会话（与 [`Kernel::list_sessions`] 同一个来源），合并本进程里打开着的会话的实时状态
    /// （← 面板，tui-panels.md §2.1，L30）。默认没有实时状态。
    async fn workspace_sessions(
        &self,
        filter: SessionFilter,
    ) -> Result<Vec<crate::panels::WorkspaceSession>, KernelError> {
        Ok(self
            .list_sessions(filter)
            .await?
            .into_iter()
            .map(|summary| crate::panels::WorkspaceSession {
                summary,
                activity: None,
                last_reply: None,
            })
            .collect())
    }
}

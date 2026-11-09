//! 会话存储与 Artifact 端口（docs/specs/rust-cli/README.md §5、§6）。
//!
//! 内核只提交“事实”（[`Fact`]），不知道记录格式。本地适配器 `node-store` 把事实映射成 Node 的
//! message / part / session_entry 记录（逐字节与 Node 一致）；云端适配器映射成自己的表。
//! 一个模型步骤的事实在一次 [`SessionStore::commit`] 里提交，事务成功后才返回回执。

use std::collections::HashMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::env::WorkspaceRef;
use crate::ids::{
    AgentId, ArtifactId, CommandId, InteractionId, MessageId, OperationId, OwnerEpoch, SessionId,
    ToolUseId, TraceId, TurnId,
};
use crate::message::Message;
use crate::model::ModelSelection;
use crate::orchestration::InteractionRequest;
use crate::permission::PermissionMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Interactive,
    Subagent,
    Fork,
    /// 辅助对话（`selection_side_chat`）：像 fork 一样复制父会话历史，但不进任务列表，
    /// 标题是「Selection side chat」（Node `buildForkedSessionInput` 的 kind）。
    SelectionSideChat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: SessionId,
    pub kind: SessionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<SessionId>,
    pub workspace: WorkspaceRef,
    pub title: String,
    pub trace: TraceId,
    pub created_at_ms: u64,
}

/// 对话分支切点（Node `session.revert`）：活动分支 = `kept` + 切点之后追加的消息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevertCursor {
    pub target: MessageId,
    pub kept: Vec<MessageId>,
    pub cut_after: MessageId,
    pub generation: u64,
}

/// 一次文件写入的 checkpoint（Node `runtime/workspace_checkpoint`，docs/specs/rust-cli/
/// session-lifecycle.md §4）。写入前后的内容在 `snapshot` 指向的 artifact 里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceCheckpoint {
    /// `checkpoint_<uuid>`。
    pub id: String,
    /// 回合开始的那条 user 消息（Node `messageId` / `targetMessageId`）。
    pub prompt: MessageId,
    /// 发出这次工具调用的 assistant 消息（Node `toolMessageId`）。
    pub assistant: MessageId,
    pub tool_use: ToolUseId,
    pub snapshot: ArtifactRef,
    /// 改的是哪台远端机器上的文件（R3，remote-exec.md §20.7.5、§20.9）；本机为 None。远端的存成本工程的记录，
    /// Node / App 看不到。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// 内核提交给存储的一条事实。新增变体时同步更新各存储适配器的映射与 spec §5。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Fact {
    MessageAppended {
        message: Message,
    },
    TitleChanged {
        title: String,
    },
    ModelSelected {
        selection: ModelSelection,
    },
    /// 旧的单值写法：权限模式值换模式并关掉 plan，`Plan` 只打开 plan（Node `resolveExecutionState`）。
    ModeChanged {
        mode: PermissionMode,
    },
    /// 执行状态（权限模式 × plan 开关）整体写入（修复线 F20，docs/specs/rust-cli/node-store.md §4.3）。
    ExecutionChanged {
        state: crate::permission::ExecutionState,
    },
    RevertSet {
        cursor: RevertCursor,
    },
    /// 执行操作的意图：先落库，再调执行环境（§6 规则 3）。
    OperationIntent {
        operation: OperationId,
        fingerprint: String,
    },
    /// 本工程独有的状态，映射成带 `nibi-kernel/` 前缀的 session_entry（Node 忽略未知类型）。
    Entry {
        kind: String,
        id: String,
        data: Value,
    },
    /// 一次文件写入的 checkpoint；与对应的工具结果在同一批提交。
    CheckpointCreated {
        checkpoint: WorkspaceCheckpoint,
    },
    /// 代码回退已把这些 checkpoint 的写入撤销；之后的冷加载不再给出它们。
    CheckpointsRestored {
        checkpoints: Vec<String>,
    },
    /// 生成的会话标题（docs/specs/rust-cli/titles.md §4）。存储按 Node 的条件写入：当前标题来源仍是
    /// `default` / `first_input` / `generated`；不满足时这一批提交失败，什么都不写。`message` 是首条输入。
    TitleGenerated {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<MessageId>,
    },
    /// 用户选“总是允许”时加入本机项目规则集的规则（Node `local_setting(permission/ruleset)`，
    /// docs/specs/rust-cli/shell-permissions.md §5）；与交互的解决在同一批提交。
    PermissionRulesAdded {
        behavior: crate::permission::RuleBehavior,
        rules: Vec<crate::permission::PermissionRule>,
    },
    /// 本机项目的持久模式（Node `local_setting(permission/mode)`，docs/specs/rust-cli/config.md §2.2）：
    /// 用户切换模式时与 `ModeChanged` 同一批提交。`mode` 是 Node 的执行模式（切到 plan 时是切换前的模式）。
    ProjectModeSet {
        mode: crate::permission::PermissionMode,
    },
    /// 一次模型请求的计时与结果（Node `model_usage`，docs/specs/rust-cli/usage.md §2.2）：与这次响应的
    /// assistant 消息同批提交；没有提交消息（失败、丢弃的响应）时单独一批。
    ///
    /// 用量事实（这一个、`ToolCalled` 与 `TurnEnded` 的用量部分）是观测：存储写不进去时只放弃这一行并记日志，同批的
    /// 其他事实照常提交（usage.md §2.5，工作线 F77）。
    ModelCalled {
        call: crate::metering::ModelCall,
    },
    /// 一次工具调用（Node `tool_usage`，usage.md §2.3）：与它的工具结果同批提交。
    ToolCalled {
        call: crate::metering::ToolCall,
    },
    /// 回合结束（Node `turn_usage`，usage.md §2.4）：存储按当前轮的输入消息与用量行算出其余字段。
    TurnEnded {
        status: crate::metering::CallStatus,
    },
    /// 子代理调用关联到它的子会话（修复线 F2）：Node 的子代理查询（`subagent-session-query.ts`）从 tool part 的
    /// `state.metadata` 读 `childSessionId`、`agentId`、`agentType`。与这次调用的工具结果同批提交，排在结果之后
    /// （[`crate::agents::subagent_link`]）。
    SubagentLinked {
        tool_use: ToolUseId,
        agent: AgentId,
        child: SessionId,
        agent_type: String,
    },
    /// 工作流控制轮的合成输入（NIBI `startSavedWorkflow` 启动轮 / `amendWorkflowRunSettings` 设置轮，
    /// docs/dynamic-workflow/launch.md）：可见的合成 user 消息，`text` 进模型上下文，
    /// `launch` 是 `metadata.workflowLaunch`（runId/toolCallId/name?/amend）。存储按 Node
    /// `persistWorkflowLaunchUserMessage` 的形状写（`source: "workflow_launch"`），这一批自成一轮。
    WorkflowLaunchMessage {
        id: MessageId,
        text: String,
        launch: Value,
    },
}

/// 本机项目规则集的一次修改（`SessionStore::change_project_rules`）：`behavior` 这一类里先删 `remove`、再加
/// `add`（Node `applyPermissionUpdates` 的去重规则）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRulesChange {
    pub behavior: crate::permission::RuleBehavior,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add: Vec<crate::permission::PermissionRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove: Vec<crate::permission::PermissionRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FactBatch {
    pub owner_epoch: OwnerEpoch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<CommandId>,
    pub facts: Vec<Fact>,
    /// 这一批事实所属的当前轮（[`TurnAnchor::after`]）；没有时由存储自己推导（docs/specs/rust-cli/node-store.md §4，
    /// 修复线 F6）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnAnchor>,
}

/// 当前轮：开启它的真实用户输入与轮次 ID（Node `currentUserMessageId` 与 `turnTraceContext.turnId`）。
///
/// 会话状态的 owner（会话 actor、子代理的子会话）持有它并随批次给出：存储写父消息、`anchor.turnId` 与用量行的轮次时
/// 直接用，不再逐行从库里推导（node-store.md §4，修复线 F6，审查 R5-3）。`turn` 为 None 只出现在冷读取里（库里的
/// 输入没有 `anchor.turnId`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnAnchor {
    pub prompt: MessageId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnId>,
}

impl TurnAnchor {
    /// 提交 `facts` 时的当前轮：批次里正好有一条开启新回合的输入（[`crate::user_input::opens_turn`]）时是它，轮次 ID
    /// 由 `turn` 生成；没有时沿用 `current`；有几条时（复制历史）一个锚点表达不了，为 None，由存储按库推导。
    pub fn after(
        current: Option<&TurnAnchor>,
        facts: &[Fact],
        turn: impl FnOnce() -> TurnId,
    ) -> Option<TurnAnchor> {
        let mut prompts = facts.iter().filter_map(|fact| match fact {
            Fact::MessageAppended {
                message: Message::User(user),
            } if crate::user_input::opens_turn(user) => Some(&user.id),
            // 工作流控制轮自己是一轮（Node 的 controlOnly turn 也推进 turnNumber）。
            Fact::WorkflowLaunchMessage { id, .. } => Some(id),
            _ => None,
        });
        match (prompts.next(), prompts.next()) {
            (None, _) => current.cloned(),
            (Some(prompt), None) => Some(TurnAnchor {
                prompt: prompt.clone(),
                turn: Some(turn()),
            }),
            (Some(_), Some(_)) => None,
        }
    }
}

/// 事务成功后才返回；`sequence` 在一个会话内单调递增。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitReceipt {
    pub sequence: u64,
}

/// 冷视图里的工作流控制轮（[`LoadedSession::launches`] / `SessionView::launches`）：哪条 user 消息是
/// NIBI 中枢启动 / run 卡「配置」的控制轮与它的 `metadata.workflowLaunch`（launch.md「The launch/settings
/// turn」）。存储上由消息记录的 `source: "workflow_launch"` 判定（Node `workflowLaunchOfMessage` 同一
/// 判据）；`hydrate` 的 `Message::User` 不带消息元数据，冷投影据这份清单在 real-user 轮边界里重建
/// controlOnly 的启动/设置轮。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionLaunchTurn {
    pub message: MessageId,
    /// 消息记录上的 `metadata.workflowLaunch`（runId/toolCallId/name?/scope/path?/args?/description?/script?，原样）。
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub launch: Value,
}

/// 一条用户输入时刻的模型选择（Node 消息记录上的 `modelSelection`）。冷投影据它补
/// `modelChange` 分隔线：与上一轮的比较变了才画（Node 的 transcript hydration 同判据）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionModelTurn {
    pub message: MessageId,
    pub selection: ModelSelection,
}

/// 一条消息的持久时间（Node `message` 行的 `time_created` / `time_updated`）。旧协议快照的
/// `info.time.created/completed` 用它；内核的会话视图本身不存逐条时间。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageTime {
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
}

/// 冷加载结果：活动分支上的消息（已应用切点与压缩边界）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoadedSession {
    pub meta: SessionMeta,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelSelection>,
    /// 权限模式（修复线 F20 起不会是 `Plan`；旧实现给出 `Plan` 时按“plan 开、default”读）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<PermissionMode>,
    /// plan 开关（修复线 F20；serde 缺省 false）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
    /// 已登记意图、还没有结果的操作（§6 规则 5）。恢复逻辑按 Unknown 处理，不重跑。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open_operations: Vec<OpenOperation>,
    /// 已持久化、还没有回答（也没有取消）的交互，按提问顺序。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_interactions: Vec<PendingInteraction>,
    /// 还没有被代码回退撤销的文件 checkpoint，按写入顺序。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checkpoints: Vec<WorkspaceCheckpoint>,
    /// 库里的当前轮（最后一条真实用户输入）：会话 actor 打开会话时以它为起点（[`FactBatch::turn`]）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnAnchor>,
    /// 当前轮已经结束、结果是错误（API 错误、轮数用尽等，Node `turn_usage.status = error`）。续写时据此判断最后一条
    /// 没有回答的 user 消息要不要补一条 assistant（docs/specs/rust-cli/session-lifecycle.md §6.3.1）。serde 缺省 false。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub last_turn_failed: bool,
    /// 只供显示的、最后一个压缩点之前的消息（工作线 F102，docs/specs/rust-cli/compact.md §5.1）：应用回退之后的完整链里
    /// 排在 `messages` 之前、不在 `messages` 里的那些，按存储顺序；不含最后一个压缩点的保留段（它们在 `messages` 里）。
    /// 模型侧的历史只是 `messages`；界面显示 `earlier ++ messages`。没有压缩点时为空（serde 缺省为空、为空时不写出）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub earlier: Vec<Message>,
    /// 这段历史里的工作流控制轮（[`SessionLaunchTurn`]，earlier 与 messages 都算；serde 缺省为空）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub launches: Vec<SessionLaunchTurn>,
    /// 每轮真实输入的模型选择（[`SessionModelTurn`]，earlier 与 messages 都算；serde 缺省为空）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_turns: Vec<SessionModelTurn>,
    /// 每条真人输入的规范意图（Node 消息的 `metadata.conversationInputIntent`）：行上显示的原文、
    /// 机器人来源、引用与插件来源。键是那条 user 消息；没有意图的输入不在表里（serde 缺省为空）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_intents: Vec<(MessageId, serde_json::Value)>,
}

/// 真人输入的规范意图 entry 的 kind：会话 actor 与消息同一批写（`Fact::Entry`），节点存储把它并进
/// 消息的 `metadata.conversationInputIntent`（Node 同一个键）。
pub const INPUT_INTENT_ENTRY: &str = "conversation_input_intent";

/// 有意图、没有结果的操作（[`Fact::OperationIntent`] 原样）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenOperation {
    pub operation: OperationId,
    pub fingerprint: String,
}

/// 仍待回答的交互（会话 actor 提问时持久化的请求）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingInteraction {
    pub interaction: InteractionId,
    pub request: InteractionRequest,
}

/// `/fork` 的新会话（docs/specs/rust-cli/session-lifecycle.md §6.5.2，Node 分叉对话的形状）：存储在一个事务里写完会话行、
/// 模型与模式、复制的消息、目标状态、时间线与分叉提示。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionFork {
    pub parent: SessionId,
    pub child: SessionId,
    pub created_at_ms: u64,
    /// 复制到这条消息为止（含）：按用户输入分叉（F75）是这一轮最后一条 assistant。
    pub through: MessageId,
    pub selection: ModelSelection,
    pub mode: PermissionMode,
    /// plan 开关（修复线 F20；serde 缺省 false）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
    /// 分叉的种类（Node `buildForkedSessionInput` 的 `kind`）：普通分叉 / 辅助对话。缺省是普通分叉。
    #[serde(default)]
    pub kind: SessionForkKind,
}

/// 分叉的种类：决定会话的 `task_type`、标题与是否写「分叉提示」。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionForkKind {
    #[default]
    Fork,
    SelectionSideChat,
}

/// [`SessionStore::fork`] 的回执。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkReceipt {
    /// 复制的消息数（Node `copiedMessageCount`）。
    pub copied: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: SessionId,
    pub title: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionFilter {
    pub workspace: WorkspaceRef,
    pub limit: usize,
}

/// 会话目录的一行（legacy `session/list`，Host 的任务列表与项目谱系校验）：Node `SessionInfo`
/// 里 Host 真的会读的列。
///
/// 与 [`SessionSummary`] 分开而不是扩充它：那是 TUI `/resume` 的最小投影（docs/specs/rust-cli/
/// session-lifecycle.md §6.2），只要 id/标题/活动时间；这条要保留**原始 `task_type`**（7 个值，
/// [`SessionKind`] 只有 3 个）、`title_source`、`workspace_id` 与 `path`——Host 靠它们区分辅助
/// 会话、判断项目归属，以及沿父链证明身份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDirectoryEntry {
    pub id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<SessionId>,
    /// Node `SessionInfo.traceID`；旧行可能没有。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<String>,
    /// 会话行的 `task_type` 原值（存储已把未知值回退成 `interactive`）。
    pub task_type: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_source: Option<String>,
    /// 会话行的 `workspace_id`（远端身份）；本机会话为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// 会话行的 `directory`（工作区根）。
    pub directory: String,
    /// 会话行的 `path`（Node `SessionInfo.path`，可能是工作区的子目录）；旧行为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// [`SessionStore::session_directory`] 的查询（Node `listSessions` / `getSession` 的两种读法）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDirectoryQuery {
    /// 只列这条目录下的会话（Node `listSessions({directory})`）。None 表示不限目录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    /// 显式 ID 查询（Node 逐个 `getSession`）：不加目录与任务类型的筛选，归属校验由调用方做。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<SessionId>>,
    pub limit: usize,
}

/// 会话列表的排序（修复线 F29，`/resume` 页的 Sort，docs/specs/rust-cli/tui-manage.md §10）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOrder {
    /// 按最近活动（`time_updated`）从新到旧。
    #[default]
    Updated,
    /// 按创建时间从新到旧。
    Created,
}

/// ← 项目页与 `/resume` 页的会话查询（修复线 F29，docs/specs/rust-cli/node-store.md §5.1）：App 任务列表的口径，
/// 可以不限目录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionQuery {
    pub environment: crate::ids::EnvironmentId,
    /// 只列这个目录的会话；None 是所有目录（“所有项目”）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<crate::env::EnvPath>,
    #[serde(default)]
    pub order: SessionOrder,
    pub limit: usize,
}

/// 查询结果里的一个会话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: SessionId,
    /// 会话名（会话行的 `title`；没有时为空）。
    pub title: String,
    /// 会话的工作目录（会话行的 `directory`）。
    pub root: crate::env::EnvPath,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    /// 首条真实用户输入的文字（界面原文，最多 500 个字符）；还没有输入时为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
}

/// [`SessionStore::query_sessions`] 的结果。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPage {
    pub sessions: Vec<SessionRecord>,
    /// 超出 `limit` 还有更多会话。
    #[serde(default)]
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoreError {
    #[error("session not found: {session}")]
    NotFound { session: SessionId },
    #[error("stale owner epoch for {session}")]
    StaleOwner { session: SessionId },
    #[error("storage error: {message}")]
    Storage { message: String },
    #[error("not implemented: {what}")]
    Unsupported { what: String },
}

/// 前端记录（缺口 G2，docs/specs/rust-cli/app-protocol.md §5.2）：前端给出的不透明记录，挂在一个会话上。内核与存储
/// 不解释 `kind` 与 `data`：node-store 原样写成 `session_entry`（`type = kind`、`id = key`，同 key 覆盖）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FrontendRecord {
    pub kind: String,
    pub key: String,
    pub data: Value,
}

/// `sessions-index/reconcile` 的一条会话事实（Node `sessionsIndex/reconcile`）。
///
/// 与 [`SessionStore::load`] 的区别：**软删除的行也要能读到**（`deleted: true`）。Host 靠这个标记把
/// tasks-index 里的行落墓碑；只回 `exists: false` 的话 Host 会当成“CLI 里暂时缺这一行”（orphan），
/// 归档管理里删掉的会话于是永远留在列表里（2026-11-09 真机：删除命令成功、行不消失）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionIndexFact {
    pub title: String,
    pub title_source: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub deleted: bool,
    pub last_outcome: Option<String>,
    /// 会话工作目录（Node `session.directory`）。
    pub directory: String,
    /// 远端工作区身份（本机会话为 None）。
    pub workspace_id: Option<String>,
}

#[async_trait]
pub trait SessionStore: Send + Sync {
    async fn create(&self, meta: SessionMeta) -> Result<(), StoreError>;

    async fn commit(
        &self,
        session: &SessionId,
        batch: FactBatch,
    ) -> Result<CommitReceipt, StoreError>;

    async fn load(&self, session: &SessionId) -> Result<LoadedSession, StoreError>;

    /// `sessions-index/reconcile` 的单条事实（含软删除的行）。缺省实现没有这份读面。
    async fn session_index_fact(
        &self,
        _session: &SessionId,
    ) -> Result<Option<SessionIndexFact>, StoreError> {
        Ok(None)
    }

    /// 会话里每条消息的持久时间（旧协议快照的时间戳；见 [`MessageTime`]）。缺省实现返回
    /// `Unsupported`，调用方回退到会话创建时间。
    async fn message_times(
        &self,
        _session: &SessionId,
    ) -> Result<HashMap<MessageId, MessageTime>, StoreError> {
        Err(StoreError::Unsupported {
            what: "message timestamps".to_owned(),
        })
    }

    async fn list(&self, filter: SessionFilter) -> Result<Vec<SessionSummary>, StoreError>;

    /// 会话目录（legacy `session/list`）：按目录或显式 ID 读出 Host 要的整行投影
    /// （[`SessionDirectoryEntry`]）。与 [`Self::list`] 的口径不同——后者是 TUI 的最小投影，
    /// 用「顶层或 fork」判可见性；这里的目录分支必须是 Node `TASK_LIST_SESSION_TYPES`
    /// （`interactive` / `fork` / `workflow_parent`），否则有父的 `workflow_parent` 会漏。
    /// 不支持的实现返回 `Unsupported`，调用方降级为空列表。
    async fn session_directory(
        &self,
        _query: SessionDirectoryQuery,
    ) -> Result<Vec<SessionDirectoryEntry>, StoreError> {
        Err(StoreError::Unsupported {
            what: "session directory".to_owned(),
        })
    }

    /// 本机项目规则集（Node `local_setting(permission/ruleset)`，shell-permissions.md §5）：启动时读回，
    /// 作为 LocalSettings 来源。不支持的实现返回 `Unsupported`。
    async fn project_rules(
        &self,
        _workspace: &WorkspaceRef,
    ) -> Result<crate::permission::ProjectRules, StoreError> {
        Err(StoreError::Unsupported {
            what: "project permission rules".to_owned(),
        })
    }

    /// 改本机项目规则集（`/permissions`，docs/specs/rust-cli/tui-manage.md §1.1）：在一个事务里读当前值、按 Node
    /// 的写法加或删、upsert，返回落库后的规则集。不支持的实现返回 `Unsupported`。
    async fn change_project_rules(
        &self,
        _workspace: &WorkspaceRef,
        _change: ProjectRulesChange,
    ) -> Result<crate::permission::ProjectRules, StoreError> {
        Err(StoreError::Unsupported {
            what: "changing project permission rules".to_owned(),
        })
    }

    /// 会话自己的规则集（Node `loadProjectPermissionRuleset`，修复线 F2）：Node 群协作会话的
    /// `session.permission.scope` 是 `session`，规则与模式只在会话行里，不读也不写本机项目的规则与持久模式。
    /// 其他会话为 None（规则在 [`Self::project_rules`]）。不支持的实现也是 None。
    async fn session_rules(
        &self,
        _session: &SessionId,
    ) -> Result<Option<crate::permission::ProjectRules>, StoreError> {
        Ok(None)
    }

    /// 写会话的权限记录（Node `updateSession({permission})`）：`createSession.permissionScope: "session"`
    /// 在创建后立即写 `{version:1, scope:"session", mode:"build"}`，之后的规则与模式都落这一列。
    /// 不支持的实现返回 `Unsupported`。
    async fn set_session_permission(
        &self,
        _session: &SessionId,
        _permission: Value,
    ) -> Result<(), StoreError> {
        Err(StoreError::Unsupported {
            what: "session permission record".to_owned(),
        })
    }

    /// 本机项目的持久模式（Node `getProjectPermissionMode`，docs/specs/rust-cli/config.md §2.2）：启动时读一次，
    /// 作为新会话的缺省模式；没有或不合法时为 None。不支持的实现返回 `Unsupported`。
    async fn project_mode(
        &self,
        _workspace: &WorkspaceRef,
    ) -> Result<Option<crate::permission::PermissionMode>, StoreError> {
        Err(StoreError::Unsupported {
            what: "project permission mode".to_owned(),
        })
    }

    /// Node `/fork` 的新会话，一个事务写完（[`SessionFork`]）。目标消息不在原会话的 fork 源分支里时
    /// 整批失败，不留会话行。不支持的实现返回 `Unsupported`。
    async fn fork(&self, _fork: SessionFork) -> Result<ForkReceipt, StoreError> {
        Err(StoreError::Unsupported {
            what: "fork from a checkpoint".to_owned(),
        })
    }

    /// `/usage` 的 API 时长（docs/specs/rust-cli/usage.md §4）：会话及其子代理子会话里成功请求的耗时之和。
    /// 不支持的实现返回 `Unsupported`。
    async fn metering(
        &self,
        _session: &SessionId,
    ) -> Result<crate::metering::SessionMetering, StoreError> {
        Err(StoreError::Unsupported {
            what: "session metering".to_owned(),
        })
    }

    /// footer 的请求统计（docs/specs/rust-cli/usage.md §4.1，修复线 F27）：本会话完成的主回合请求在用量表里的聚合；
    /// 修复线 F112 起子会话给出它完成的子代理请求（子代理的行只在子会话，主会话的结果不变）。
    /// 只读；每次都从行聚合，不缓存。不支持的实现返回 `Unsupported`。
    async fn request_stats(
        &self,
        _session: &SessionId,
    ) -> Result<crate::metering::RequestStats, StoreError> {
        Err(StoreError::Unsupported {
            what: "request stats".to_owned(),
        })
    }

    /// 活动统计的原始聚合（usage.md §5.2）：只读的聚合查询。不支持的实现返回 `Unsupported`。
    async fn activity(
        &self,
        _query: crate::metering::ActivityQuery,
    ) -> Result<crate::metering::ActivityStats, StoreError> {
        Err(StoreError::Unsupported {
            what: "activity stats".to_owned(),
        })
    }

    /// 工作区信任（docs/specs/rust-cli/workspace-trust.md §2.3）：按给出的顺序，返回 `candidates` 里第一个
    /// 有信任记录的键；都没有时为 None。只读。不支持的实现返回 `Unsupported`。
    async fn trusted_workspace(
        &self,
        _candidates: &[crate::workspace_trust::TrustKey],
    ) -> Result<Option<crate::workspace_trust::TrustKey>, StoreError> {
        Err(StoreError::Unsupported {
            what: "workspace trust".to_owned(),
        })
    }

    /// 这个会话里某一种 `nibi-kernel/<kind>` entry 的全部记录，按写入顺序：`(id, data)`（跨会话的入站与回执在
    /// 重开会话时恢复，docs/specs/rust-cli/cross-session.md §2.2，F28）。只读；不支持的实现返回空。
    async fn entries(
        &self,
        _session: &SessionId,
        _kind: &str,
    ) -> Result<Vec<(String, Value)>, StoreError> {
        Ok(Vec::new())
    }

    /// 写一条前端记录（缺口 G2）：同 key 覆盖，不推进会话的活动时间。会话不存在时 `NotFound`；不支持的实现返回
    /// `Unsupported`。
    async fn put_record(
        &self,
        _session: &SessionId,
        _record: &FrontendRecord,
    ) -> Result<(), StoreError> {
        Err(StoreError::Unsupported {
            what: "frontend records".to_owned(),
        })
    }

    /// 这个会话里某一种前端记录，按写入顺序（缺口 G2）。不支持的实现返回空。
    async fn records(
        &self,
        _session: &SessionId,
        _kind: &str,
    ) -> Result<Vec<FrontendRecord>, StoreError> {
        Ok(Vec::new())
    }

    /// 这个会话发起的 DWF run（`dwf_run.parent_session_id`，只读；run 的真相在引擎的 journal）。
    /// 不支持的实现返回空（TUI / 内存存储没有 DWF）。
    async fn workflow_runs(
        &self,
        _session: &SessionId,
    ) -> Result<Vec<crate::workflow::DynamicWorkflowRun>, StoreError> {
        Ok(Vec::new())
    }

    /// 追加一条 DWF run 事件（`dwf_event`；序号在同一条 INSERT 里分配，多进程共享同一个库）。
    /// `payload_json` 与 Node 的 `RunEvent` 同形（整个事件的 JSON，含 `type` 字段）——升级问答
    /// 的 `escalation-raised` / `escalation-resolved` 由宿主（路线 C 的 driver）写，其余事件在
    /// 引擎 sidecar。不支持的实现返回 `Unsupported`。
    async fn append_workflow_event(
        &self,
        _run_id: &str,
        _event_type: &str,
        _payload_json: String,
    ) -> Result<(), StoreError> {
        Err(StoreError::Unsupported {
            what: "workflow event journal".to_owned(),
        })
    }

    /// 一个 run 的详情读面（journal 侧全部事实 + 冷回放的待答问题；停驻注册表的活项由调用方
    /// 合成）。未知 runId 返回 `None`。不支持的实现返回 `None`（TUI / 内存存储没有 DWF）。
    async fn workflow_run_detail(
        &self,
        _session: &SessionId,
        _run_id: &str,
    ) -> Result<Option<crate::workflow::WorkflowRunDetail>, StoreError> {
        Ok(None)
    }

    // ——— v4 查询面（141 审计 §9 第 2 项）：run 目录 + 详情页四个切片 ———
    //
    // 四条读面都**先过同一条授权链**（run 行存在 ∧ `parent_session_id` 等于本会话；NULL 的
    // 老行不放行——「无从判定」不是「判定通过」），再碰任何行。拒绝一律归一成空结果
    // （空目录 / 空页 / `None`），不告诉越权的调用方它猜对了哪一半。

    /// 本会话发起的 run 目录（`v4/conversation/workflowRuns`），最近更新在前。
    ///
    /// `limit` 是**页上限**（调用方已钳过），存储层不再设自己的天花板。不支持的实现返回空。
    async fn workflow_run_summaries(
        &self,
        _session: &SessionId,
        _limit: usize,
    ) -> Result<Vec<crate::workflow::WorkflowRunSummaryRow>, StoreError> {
        Ok(Vec::new())
    }

    /// 一个 run 的事件日志的一页（条数与字节两道界）。未知 / 不属于本会话 → 空页。
    async fn workflow_run_events(
        &self,
        _session: &SessionId,
        _run_id: &str,
        _query: crate::workflow::WorkflowRunEventQuery,
    ) -> Result<crate::workflow::WorkflowRunEventPage, StoreError> {
        Ok(crate::workflow::WorkflowRunEventPage {
            events: Vec::new(),
            has_more: false,
        })
    }

    /// 一个 run 的用户面产物清单（全量版本）。未知 / 不属于本会话 → `None`。
    async fn workflow_run_artifacts(
        &self,
        _session: &SessionId,
        _run_id: &str,
    ) -> Result<Option<Vec<crate::workflow::WorkflowRunArtifactDetail>>, StoreError> {
        Ok(None)
    }

    /// 喂给某个预置产物的 `report` 条目的一页。未知 / 不属于本会话 → 空页。
    async fn workflow_run_artifact_items(
        &self,
        _session: &SessionId,
        _run_id: &str,
        _query: crate::workflow::WorkflowRunArtifactItemQuery,
    ) -> Result<crate::workflow::WorkflowRunArtifactItemPage, StoreError> {
        Ok(crate::workflow::WorkflowRunArtifactItemPage {
            items: Vec::new(),
            has_more: false,
        })
    }

    /// 一个产物版本的字节（`workflowRunArtifactRead` 的取数面）：run 必须属于本会话 ∧
    /// journal 里有 `(artifactId, version)` 的 completed 行，然后才拿**行上的** uri 去读。
    ///
    /// 返回 `(bytes, contentType)`；`content_type` 取 journal 记录上的值（UI 分派渲染器的精确
    /// 匹配契约），不是 store 按文件名回推的那一份。无此版本 / 不是你的 run / 是看板 → `None`
    /// ——三者对调用方是同一个业务事实。
    async fn workflow_run_artifact_bytes(
        &self,
        _session: &SessionId,
        _run_id: &str,
        _artifact_id: &str,
        _version: u64,
    ) -> Result<Option<(Vec<u8>, Option<String>)>, StoreError> {
        Ok(None)
    }

    /// 一个 run 的工作区 transcript 清单（`world-read` / `world-run` 行，**不带正文**）。
    /// 未知 / 不属于本会话 → `None`（网关归一成空清单）。
    async fn workflow_run_workspace(
        &self,
        _session: &SessionId,
        _run_id: &str,
    ) -> Result<Option<Vec<crate::workflow::WorkflowRunWorkspaceNode>>, StoreError> {
        Ok(None)
    }

    /// 一个工作区节点的正文，按 `max_bytes` 保形有界化。非 world 行 / 未知 / 不是你的 run →
    /// `None`。
    async fn workflow_run_node_result(
        &self,
        _session: &SessionId,
        _run_id: &str,
        _site_id: &str,
        _ordinal: u64,
        _max_bytes: u64,
    ) -> Result<Option<crate::workflow::WorkflowRunNodeResult>, StoreError> {
        Ok(None)
    }

    // ——— v4 usage 查询 ———

    /// 应用级用量聚合（`v4/usage/stats` 的取数面）。不支持的实现返回 `Unsupported`。
    async fn app_usage(
        &self,
        _query: crate::usage::AppUsageQuery,
    ) -> Result<crate::usage::AppUsage, StoreError> {
        Err(StoreError::Unsupported {
            what: "app usage aggregation".to_owned(),
        })
    }

    /// 会话级 token 用量（`v4/conversation/usage` 的取数面）。不支持的实现返回
    /// `Unsupported`。
    async fn session_usage(&self, _session: &SessionId) -> Result<crate::usage::SessionUsage, StoreError> {
        Err(StoreError::Unsupported {
            what: "session usage aggregation".to_owned(),
        })
    }

    /// amend-resume 的种子兑现（Node `seedActorTranscript` 同一条规则）：把源会话的前
    /// `message_count` 条消息按值复制进目标会话（新 id、parentID 重映射），幂等——目标已满
    /// （≥ message_count）或已有自己的历史时跳过。源会话短于边界是 corruption 级错误（大声失败）。
    async fn fulfill_actor_seed(
        &self,
        _target: &SessionId,
        _source: &SessionId,
        _message_count: u64,
    ) -> Result<crate::workflow::SeedFulfillment, StoreError> {
        Err(StoreError::Unsupported {
            what: "actor seed fulfillment".to_owned(),
        })
    }

    /// 一个会话已落库的消息条数（ask 边界记账的值；「数消息与复制消息走同一个存取面」——
    /// 口径必须与 [`Self::fulfill_actor_seed`] 一致）。
    async fn session_message_count(&self, _session: &SessionId) -> Result<u64, StoreError> {
        Err(StoreError::Unsupported {
            what: "session message count".to_owned(),
        })
    }

    /// `workflows/runs`（NIBI 协议中枢）的运行历史页（journal 直读，**跨会话**）：cwd/name 过滤
    /// 与 `time_updated desc` 排序、limit 全部下推 SQL。`limit` 是「页上限 + 1」的截断探测
    /// 语义（调用方多取一条判 `truncated`），存储层不设自己的天花板。不支持的实现返回
    /// `Unsupported`。
    async fn workflow_runs_page(
        &self,
        _cwd: Option<String>,
        _name: Option<String>,
        _limit: usize,
    ) -> Result<Vec<crate::workflow::WorkflowRunPageRow>, StoreError> {
        Err(StoreError::Unsupported {
            what: "workflow runs page".to_owned(),
        })
    }

    /// 记下一个工作区已信任（upsert，workspace-trust.md §2.3）。不支持的实现返回 `Unsupported`。
    async fn trust_workspace(
        &self,
        _key: &crate::workspace_trust::TrustKey,
    ) -> Result<(), StoreError> {
        Err(StoreError::Unsupported {
            what: "workspace trust".to_owned(),
        })
    }

    /// ← 项目页与 `/resume` 页的会话（修复线 F29，node-store.md §5.1）：只读。不支持的实现返回 `Unsupported`。
    async fn query_sessions(&self, _query: SessionQuery) -> Result<SessionPage, StoreError> {
        Err(StoreError::Unsupported {
            what: "session queries".to_owned(),
        })
    }

    /// 给没有打开的会话改名（Node `setCustomSessionTitle`：标题来源记为 custom，不改活动时间）。会话不存在或已删除时
    /// `NotFound`。打开着的会话经它的 actor 改名（`Command::Rename`），不走这里。不支持的实现返回 `Unsupported`。
    async fn rename(&self, _session: &SessionId, _title: &str) -> Result<(), StoreError> {
        Err(StoreError::Unsupported {
            what: "renaming sessions".to_owned(),
        })
    }

    /// 删除会话（Node `softDeleteSession`：记删除时刻，消息保留，之后不再读出与列出）。会话不存在时 `NotFound`；
    /// 已删除时什么都不做。不支持的实现返回 `Unsupported`。
    async fn delete(&self, _session: &SessionId) -> Result<(), StoreError> {
        Err(StoreError::Unsupported {
            what: "deleting sessions".to_owned(),
        })
    }
}

/// Artifact 的用途：决定是否进入文件选择器、保留策略（cloud 规则 7）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactPurpose {
    ToolOutput,
    Attachment,
    Media,
    Checkpoint,
    Deliverable,
}

/// Artifact 引用（Node `nibi-artifact://<sessionId>/<artifactId>`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub session: SessionId,
    pub id: ArtifactId,
    pub purpose: ArtifactPurpose,
    pub media_type: String,
    pub size: u64,
}

#[async_trait]
pub trait ArtifactStore: Send + Sync {
    /// 先写对象并核验，再返回引用；调用方拿到引用后才能把它提交进会话事实。
    async fn put(
        &self,
        session: &SessionId,
        purpose: ArtifactPurpose,
        media_type: String,
        bytes: Vec<u8>,
    ) -> Result<ArtifactRef, StoreError>;

    async fn get(&self, artifact: &ArtifactRef) -> Result<Vec<u8>, StoreError>;

    /// 按会话与 artifact id 找回完整引用（修复线 F18，docs/specs/rust-cli/tools-files.md §1.4）。模型交回的落盘
    /// 位置 `nibi-artifact://<会话>/<artifact>` 只有这两项；大小、用途与类型由实现方从自己的记录取，内核不凭空
    /// 造引用。读内容仍经 [`Self::get`]（照常核对大小）。找不到时为 `None`。不支持的实现返回 `Unsupported`。
    async fn find(
        &self,
        _session: &SessionId,
        _id: &ArtifactId,
    ) -> Result<Option<ArtifactRef>, StoreError> {
        Err(StoreError::Unsupported {
            what: "artifact lookup by id".to_owned(),
        })
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;

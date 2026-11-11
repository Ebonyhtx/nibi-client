//! 重启后的子代理恢复（docs/subagent-restart-resume.md）：重建 `Live`、补中断结果、续跑与补发通知。
//!
//! 入口 [`crate::Agents::restore_loaded_session`] 由 runtime 在冷加载顶层会话、会话 actor 启动之后调用一次，
//! 并带上 actor 的会话级询问入口（[`crate::child::Asks`]）：续跑中的提问/审批因此与正常后台子代理同一条通道。
//! 只处理顶层会话：子会话与 DWF actor 会话不进入；没有 `subagent_spawn` entry 的子会话（DWF actor 等）跳过。
//!
//! 恢复的三种去向：
//! - 有 `subagent_result`：只重建条目的终态；父会话没有 `subagent_result_delivered` 时补发通知，绝不重跑
//!   （用户 TaskStop、正常完成、失败结束都写结果）；
//! - 没有结果且可以续跑：写 `subagent_resume_attempt`、给末尾未结的 `tool_use` 补 `INTERRUPTED_CALL`、
//!   追加一条 `process-restart` 的 meta 消息，再在同一个子会话里重新驱动；
//! - 没有结果但不能续跑（fork 前缀不落库、续跑次数到上限、agent 定义已不存在）：只标记为失败并说明原因。
//!
//! 存储异常一律只记日志，不向调用方返回错误：恢复失败不影响会话打开。

use std::collections::HashSet;
use std::sync::Arc;

use nibi_kernel_api::abort::Abort;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::ids::{AgentId, MessageId, SessionId, ToolUseId};
use nibi_kernel_api::message::{
    ContentBlock, INTERRUPTED_CALL, Message, ToolResultContent, UserMessage, UserOrigin,
};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::orchestration::Interactions;
use nibi_kernel_api::permission::ExecutionState;
use nibi_kernel_api::store::{Fact, StoreError};
use serde::Deserialize;

use crate::Core;
use crate::child::Asks;
use crate::definitions::{AgentDefinition, AgentSource};
use crate::live::{AgentState, LiveAgent, Shown};
use crate::report::{self, Ending, Report};
use crate::routing;
use crate::spawn::{self, Opening};

/// 子会话里记身份与派生参数的 entry（重启后只有它能说明“这个子会话是谁”）。
pub(crate) const SPAWN_ENTRY: &str = "subagent_spawn";
/// 子代理一次运行的终态（完成、失败、被停止都写）。
pub(crate) const RESULT_ENTRY: &str = "subagent_result";
/// 自动续跑的尝试计数（跨重启累计）。
pub(crate) const ATTEMPT_ENTRY: &str = "subagent_resume_attempt";
/// 本次运行开始（每次 `create` / `resume` 覆盖）：与 `subagent_result` 的结束时刻比较，
/// 判断崩溃时是“上一轮已完成”还是“新一轮跑到一半”。
pub(crate) const RUN_ENTRY: &str = "subagent_run";
/// 结果通知已投递（写在父会话，避免重启后重复补发）。
pub(crate) const DELIVERED_ENTRY: &str = "subagent_result_delivered";

/// 自动续跑的次数上限（跨重启累计；到上限只标记失败，不循环）。
const MAX_ATTEMPTS: u32 = 2;

/// 续跑消息（docs/subagent-restart-resume.md 的固定文案）：要求先核对现场，不从头开始。
const CONTINUE: &str = "Continue the previous task from where it left off. The client restarted while you were running.\nDo not start over: first check what you have already done (the messages above and the workspace),\nthen finish the remaining work and report the result.";

/// 自动续跑同时进行的上限（进程内）：重启瞬间不会把所有子代理一起拉起，超出的排在信号量上。
/// 名额在后台任务里取，`restore_session` 本身不阻塞会话打开。
static RESUME_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// `subagent_spawn` 的内容（与 `spawn::create` 的写入同形）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnData {
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    child_session_id: Option<String>,
    #[serde(default)]
    parent_session: Option<String>,
    #[serde(default)]
    root_session: Option<String>,
    #[serde(default)]
    owner_agent_id: Option<String>,
    #[serde(default)]
    depth: u32,
    #[serde(default)]
    tool_use_id: Option<String>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    agent_type: String,
    workspace: WorkspaceRef,
    #[serde(default)]
    machine: Option<String>,
    /// Node 回退内核在“继承父模型/未声明权限模式”时可能不写这两项。缺了仍要恢复可见，
    /// 但不能自动续跑（没有可靠的模型与权限事实）。
    #[serde(default)]
    selection: Option<ModelSelection>,
    #[serde(default)]
    execution: Option<ExecutionState>,
    #[serde(default)]
    background: bool,
    #[serde(default)]
    fork: bool,
}

/// `subagent_run` 的内容。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunData {
    #[serde(default)]
    started_at_ms: u64,
}

/// `subagent_result` 的内容。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultData {
    #[serde(default)]
    ending: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    tokens: u64,
    #[serde(default)]
    tool_uses: usize,
    #[serde(default)]
    duration_ms: u64,
    #[serde(default)]
    tool_use_id: Option<String>,
    #[serde(default)]
    finished_at_ms: u64,
}

impl crate::Agents {
    /// 冷加载顶层会话后调用：恢复它的子代理（只读列表、状态、续跑与补发通知）。
    ///
    /// 只处理 `parent` 为 None 的会话；内部异常只记日志。没有会话 actor 的入口时不注入询问入口
    /// （恢复出的子代理与 `-p` 一样不询问），runtime 走 [`Self::restore_loaded_session`] 并传入它。
    pub async fn restore_session(&self, session: &SessionId) {
        let is_child = match self.core.ports.store.load(session).await {
            Ok(loaded) => loaded.meta.parent.is_some(),
            Err(error) => {
                tracing::warn!(session = %session, %error, "the subagents could not be restored");
                return;
            }
        };
        self.restore_loaded_session(session, is_child, None).await;
    }

    /// 冷加载路径调用：会话已经读过，`is_child` 来自 `LoadedSession.meta.parent`，避免再全量读一次历史。
    ///
    /// `asks` 是会话 actor 的会话级询问入口（`Session::session_interactions`）：恢复出的后台子代理
    /// （含自动续跑的）经它提问与审批，与正常后台子代理的 `context.interactions.lasting(...)` 是同一条通道。
    /// runtime 在 actor 启动之后、打开返回之前调用这里，所以入口一定已经就绪；恢复本身不等待 actor。
    pub async fn restore_loaded_session(
        &self,
        session: &SessionId,
        is_child: bool,
        asks: Option<Arc<dyn Interactions>>,
    ) {
        if is_child {
            return;
        }
        restore(&self.core, session, asks).await;
    }
}

async fn restore(core: &Arc<Core>, root: &SessionId, asks: Option<Arc<dyn Interactions>>) {
    // 只有交互界面里的后台子代理能询问（`agent_tool` 的同一个条件，agents.md §4.1.1）：`-p` 与
    // stream-json 保持“没有人能回答”。入口在 `restore_agent` 里给每个重建的条目一份（`Asks` 可复制）。
    let asks = core.background_prompts.then_some(asks).flatten().map(Asks);
    // 子会话（以及 DWF actor 会话）不从这里进入：调用方已经按 `meta.parent` 过滤。
    let trees = match core
        .ports
        .store
        .owned_session_trees(std::slice::from_ref(root))
        .await
    {
        Ok(trees) => trees,
        Err(error) => {
            tracing::warn!(session = %root, %error, "the subagent sessions could not be listed");
            return;
        }
    };
    let Some(children) = trees.get(root) else {
        return;
    };
    for child in children {
        if child == root {
            continue;
        }
        if let Err(error) = restore_child(core, root, child, asks.clone()).await {
            tracing::warn!(session = %child, %error, "this subagent could not be restored");
        }
    }
}

async fn restore_child(
    core: &Arc<Core>,
    root: &SessionId,
    child: &SessionId,
    asks: Option<Asks>,
) -> Result<(), StoreError> {
    let spawns = core.ports.store.entries(child, SPAWN_ENTRY).await?;
    // 没有 `subagent_spawn` 的会话不是本功能派生的子代理（DWF actor 等）。
    for (entry_id, data) in spawns {
        let spawn: SpawnData = match serde_json::from_value(data) {
            Ok(spawn) => spawn,
            Err(error) => {
                tracing::warn!(session = %child, %error, "a subagent spawn entry could not be read");
                continue;
            }
        };
        if let Err(error) = restore_agent(core, root, child, &entry_id, &spawn, asks.clone()).await
        {
            tracing::warn!(agent = %entry_id, %error, "this subagent could not be restored");
        }
    }
    Ok(())
}

async fn restore_agent(
    core: &Arc<Core>,
    root: &SessionId,
    child: &SessionId,
    entry_id: &str,
    spawn: &SpawnData,
    asks: Option<Asks>,
) -> Result<(), StoreError> {
    let agent_id = AgentId::new(
        spawn
            .agent_id
            .clone()
            .unwrap_or_else(|| entry_id.to_owned()),
    );
    // 同进程去重：已经在 `Live` 里的子代理不重复恢复（同一次冷加载只应恢复一次）。
    if core.live.get(&agent_id).is_some() {
        return Ok(());
    }
    let parent = spawn
        .parent_session
        .as_deref()
        .map_or_else(|| root.clone(), SessionId::new);
    let root_session = spawn
        .root_session
        .as_deref()
        .map_or_else(|| root.clone(), SessionId::new);
    let child_session = spawn
        .child_session_id
        .as_deref()
        .map_or_else(|| child.clone(), SessionId::new);
    let definition = definition_for(core, spawn, &parent).await;

    if let Some(result) = latest_result(core, child, &agent_id).await? {
        // 有终态：恢复可见的条目；通知丢了就补，绝不重跑（killed 也一样）。
        let ending = ending_of(&result.ending);
        let report = Report {
            text: result.text,
            tokens: result.tokens,
            tool_uses: result.tool_uses,
            duration_ms: result.duration_ms,
        };
        let finished_at = if result.finished_at_ms == 0 {
            core.ports.clock.now_ms()
        } else {
            result.finished_at_ms
        };
        let live = build_live(
            spawn,
            agent_id,
            child_session,
            parent,
            root_session,
            definition.unwrap_or_else(|| placeholder(spawn)),
            AgentState::Finished(ending),
            Some(finished_at),
            asks,
        );
        core.live.insert(live.clone());
        // 通知里的 `<tool-use-id>` 用产生这条结果的那次运行（续跑产生的通知不属于哪次工具调用）。
        deliver_result(core, &live, result.tool_use_id.as_deref(), ending, &report).await;
        return Ok(());
    }

    let attempts = attempts(core, child, &agent_id).await?;
    if let Some(report) = blocked_report(spawn, attempts) {
        let live = build_live(
            spawn,
            agent_id,
            child_session,
            parent,
            root_session,
            definition.unwrap_or_else(|| placeholder(spawn)),
            AgentState::Finished(Ending::Failed),
            None,
            asks,
        );
        tracing::warn!(
            agent = %live.agent,
            reason = %report.text,
            "the interrupted subagent is not resumed automatically"
        );
        fail_and_deliver(core, live, report.text).await;
        return Ok(());
    }
    let Some(definition) = definition else {
        let report = Report {
            text: format!(
                "Agent type '{}' is no longer available, so this subagent cannot be resumed automatically. Review its session and resume it manually.",
                spawn.agent_type
            ),
            ..Report::default()
        };
        tracing::warn!(agent = %agent_id, reason = %report.text, "the interrupted subagent has no definition");
        let live = build_live(
            spawn,
            agent_id,
            child_session,
            parent,
            root_session,
            placeholder(spawn),
            AgentState::Finished(Ending::Failed),
            None,
            asks,
        );
        fail_and_deliver(core, live, report.text).await;
        return Ok(());
    };

    // 先记尝试（跨重启累计），再补中断结果、追继续跑消息。
    let attempt = Fact::Entry {
        kind: ATTEMPT_ENTRY.to_owned(),
        id: agent_id.as_str().to_owned(),
        data: serde_json::json!({
            "count": attempts.saturating_add(1),
            "lastAtMs": core.ports.clock.now_ms(),
            "reason": "process_restart",
        }),
    };
    spawn::commit(core, child, vec![attempt], None).await?;

    // 冷读子会话：崩溃瞬间在执行的工具结果未知，按 `session/resume.rs` 的 `settle` 口径补
    // `INTERRUPTED_CALL`（只处理末尾未结的调用；已有结果的调用不动，也不重放工具）。
    let loaded = core.ports.store.load(child).await?;
    let added = interrupted_results(&loaded.messages, || core.ports.ids.message());
    if !added.is_empty() {
        let facts = added
            .into_iter()
            .map(|message| Fact::MessageAppended { message })
            .collect();
        spawn::commit(core, child, facts, loaded.turn.as_ref()).await?;
    }

    let mut live = build_live(
        spawn,
        agent_id,
        child_session,
        parent,
        root_session,
        definition,
        AgentState::Running {
            abort: Abort::new(),
            mailbox: Vec::new(),
        },
        None,
        asks,
    );
    let origin = UserOrigin::Meta {
        source: "process-restart".to_owned(),
        origin_meta: None,
    };
    match spawn::resume(core, &live, CONTINUE, origin).await {
        Ok(opening) => {
            // 先登记再启动：运行结束的收尾（`routing::settle`）要在表里找到它。
            core.live.insert(live.clone());
            background_limited(core, live, opening);
        }
        Err(error) => {
            tracing::warn!(agent = %live.agent, %error, "the interrupted subagent could not be resumed");
            live.state = AgentState::Finished(Ending::Failed);
            fail_and_deliver(
                core,
                live,
                format!("This subagent was interrupted by a client restart and could not be resumed: {error}"),
            )
            .await;
        }
    }
    Ok(())
}

/// 自动续跑：在子代理的作用域里跑，整个运行期间占一个名额（同时最多 2 个续跑在跑）。
fn background_limited(core: &Arc<Core>, agent: LiveAgent, opening: Opening) {
    let task_core = core.clone();
    let _task = core.ports.spawner.spawn("subagent", async move {
        // 信号量不会关闭；拿不到名额只可能是被丢弃（作用域关闭），那时也不必再跑。
        let _slot = RESUME_SLOTS.acquire().await;
        let finished = spawn::drive(&task_core, &agent, opening, None, None).await;
        let settled = routing::settle(&task_core, &agent.agent, &finished);
        routing::wake(&task_core, settled.wakes).await;
    });
}

async fn definition_for(
    core: &Core,
    spawn: &SpawnData,
    parent: &SessionId,
) -> Option<AgentDefinition> {
    // fork 不在 agent 清单里，按 fork 自己的定义重建（前缀不落库，之后不会续跑）。
    if spawn.fork || spawn.agent_type == crate::fork::FORK {
        return Some(crate::fork::definition());
    }
    core.catalog
        .definitions_for(Some(parent), &spawn.workspace)
        .await
        .into_iter()
        .find(|definition| definition.agent_type == spawn.agent_type)
}

/// 定义已不存在的占位：条目仍要能显示（类型名来自 spawn entry），只是不能再续跑。
fn placeholder(spawn: &SpawnData) -> AgentDefinition {
    AgentDefinition {
        agent_type: if spawn.agent_type.is_empty() {
            crate::definitions::GENERAL_PURPOSE.to_owned()
        } else {
            spawn.agent_type.clone()
        },
        when_to_use: String::new(),
        tools: None,
        disallowed_tools: Vec::new(),
        prompt: String::new(),
        source: AgentSource::BuiltIn,
        plugin: None,
        model: None,
        effort: None,
        max_turns: None,
        permission_mode: None,
        background: spawn.background,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_live(
    spawn: &SpawnData,
    agent: AgentId,
    child: SessionId,
    parent: SessionId,
    root: SessionId,
    definition: AgentDefinition,
    state: AgentState,
    ended_ms: Option<u64>,
    asks: Option<Asks>,
) -> LiveAgent {
    LiveAgent {
        agent,
        child,
        parent,
        root,
        owner: spawn.owner_agent_id.as_deref().map(AgentId::new),
        depth: spawn.depth,
        tool_use: spawn.tool_use_id.as_deref().map(ToolUseId::new),
        description: spawn.description.clone(),
        definition: Arc::new(definition),
        workspace: spawn.workspace.clone(),
        machine: spawn.machine.clone(),
        selection: spawn.selection.clone().unwrap_or(ModelSelection {
            provider: String::new(),
            model: String::new(),
            reasoning: None,
            connection: None,
        }),
        execution: spawn
            .execution
            .unwrap_or_else(|| ExecutionState::from(nibi_kernel_api::permission::PermissionMode::Default)),
        background: spawn.background,
        // 与会话 actor 的入口是同一个（runtime 冷加载时经 `restore_loaded_session` 注入）：续跑期间的
        // 提问/审批与正常后台子代理走同一条通道（agents.md §4.1.1；以前这里是 None）。
        asks,
        state,
        shown: Shown {
            ended_ms,
            ..Shown::default()
        },
        fork_prefix: None,
    }
}

fn ending_of(value: &str) -> Ending {
    match value {
        "completed" => Ending::Completed,
        "killed" => Ending::Killed,
        "failed" => Ending::Failed,
        other => {
            tracing::warn!(
                ending = other,
                "an unknown subagent ending is treated as failed"
            );
            Ending::Failed
        }
    }
}

/// 没有结果时不能自动续跑的两种情形（fork 前缀不落库、续跑次数到上限）。可以续跑时为 None。
fn blocked_report(spawn: &SpawnData, attempts: u32) -> Option<Report> {
    if spawn.selection.is_none() || spawn.execution.is_none() {
        return Some(Report {
            text: "This subagent was created by another kernel without model or permission facts, so it cannot be resumed automatically. Review its session and resume it manually."
                .to_owned(),
            ..Report::default()
        });
    }
    if spawn.fork || spawn.agent_type == crate::fork::FORK {
        return Some(Report {
            text: "This fork subagent was interrupted by a client restart. Its inherited prefix is not persisted, so it cannot be resumed automatically; review its session and handle it manually."
                .to_owned(),
            ..Report::default()
        });
    }
    if attempts >= MAX_ATTEMPTS {
        return Some(Report {
            text: format!(
                "This subagent was interrupted by client restarts and reached the automatic resume limit ({MAX_ATTEMPTS} attempts). Review its session and resume it manually."
            ),
            ..Report::default()
        });
    }
    None
}

async fn latest_result(
    core: &Core,
    child: &SessionId,
    agent: &AgentId,
) -> Result<Option<ResultData>, StoreError> {
    let entries = core.ports.store.entries(child, RESULT_ENTRY).await?;
    let found = entries
        .iter()
        .rev()
        .find(|(id, _)| id == agent.as_str())
        .or_else(|| entries.last());
    let result = found.and_then(|(_, data)| {
        serde_json::from_value::<ResultData>(data.clone())
            .map_err(|error| {
                tracing::warn!(agent = %agent, %error, "a subagent result entry could not be read");
                error
            })
            .ok()
    });
    let Some(result) = result else {
        return Ok(None);
    };
    // 上一轮已完成、之后又被 SendMessage/续跑拉起：`subagent_run` 比结果新，说明崩溃发生在
    // 新一轮里，旧结果不能当作“已完成”跳过恢复。
    let runs = core.ports.store.entries(child, RUN_ENTRY).await?;
    let run_started = runs
        .iter()
        .rev()
        .find(|(id, _)| id == agent.as_str())
        .or_else(|| runs.last())
        .and_then(|(_, data)| serde_json::from_value::<RunData>(data.clone()).ok())
        .map_or(0, |run| run.started_at_ms);
    if run_started > result.finished_at_ms {
        return Ok(None);
    }
    Ok(Some(result))
}

async fn attempts(core: &Core, child: &SessionId, agent: &AgentId) -> Result<u32, StoreError> {
    let entries = core.ports.store.entries(child, ATTEMPT_ENTRY).await?;
    let count = entries
        .iter()
        .rev()
        .find(|(id, _)| id == agent.as_str())
        .or_else(|| entries.last())
        .and_then(|(_, data)| data.get("count"))
        .and_then(serde_json::Value::as_u64);
    Ok(count.map_or(0, |count| u32::try_from(count).unwrap_or(u32::MAX)))
}

/// 不能自动续跑时落一个失败终态并通知：用户能看到原因，下次重启也不会反复尝试或重复记日志。
async fn fail_and_deliver(core: &Arc<Core>, live: LiveAgent, reason: String) {
    let report = Report {
        text: reason.clone(),
        ..Report::default()
    };
    let result = Fact::Entry {
        kind: RESULT_ENTRY.to_owned(),
        id: live.agent.as_str().to_owned(),
        data: serde_json::json!({
            "ending": Ending::Failed.status(),
            "text": &report.text,
            "tokens": 0,
            "toolUses": 0,
            "durationMs": 0,
            "toolUseId": live.tool_use.as_ref().map(ToolUseId::as_str),
            "finishedAtMs": core.ports.clock.now_ms(),
        }),
    };
    if let Err(error) = spawn::commit(core, &live.child, vec![result], None).await {
        tracing::warn!(agent = %live.agent, %error, "the failed subagent result could not be stored");
    }
    core.live.insert(live.clone());
    deliver_result(
        core,
        &live,
        live.tool_use.as_ref().map(ToolUseId::as_str),
        Ending::Failed,
        &report,
    )
    .await;
}

/// 补发结果通知：父会话没有投递标记时送顶层会话（与后台子代理的终态通知同一条路），成功后写标记。
async fn deliver_result(
    core: &Arc<Core>,
    live: &LiveAgent,
    tool_use: Option<&str>,
    ending: Ending,
    report: &Report,
) {
    let delivered = match core
        .ports
        .store
        .entries(&live.parent, DELIVERED_ENTRY)
        .await
    {
        Ok(entries) => entries.iter().any(|(id, _)| id == live.agent.as_str()),
        Err(error) => {
            // 读不到标记时按“已投递”处理：宁可不补，也不每次重启都刷一遍通知。
            tracing::warn!(agent = %live.agent, %error, "the delivered marker could not be read");
            return;
        }
    };
    if delivered {
        return;
    }
    let envelope = report::envelope(
        live.agent.as_str(),
        tool_use,
        &live.description,
        ending,
        report,
        None,
    );
    core.hub.notify(
        &live.root,
        live.agent.clone(),
        ending.status(),
        nibi_kernel_prompts::agents::notification_wrap(&envelope),
        None,
    );
    let marker = Fact::Entry {
        kind: DELIVERED_ENTRY.to_owned(),
        id: live.agent.as_str().to_owned(),
        data: serde_json::json!({ "deliveredAtMs": core.ports.clock.now_ms() }),
    };
    if let Err(error) = spawn::commit(core, &live.parent, vec![marker], None).await {
        tracing::warn!(agent = %live.agent, %error, "the delivered marker could not be stored");
    }
}

fn calls(message: &Message) -> impl Iterator<Item = &ToolUseId> {
    let blocks: &[ContentBlock] = match message {
        Message::Assistant(assistant) => &assistant.content,
        _ => &[],
    };
    blocks.iter().filter_map(|block| match block {
        ContentBlock::ToolUse { id, .. } => Some(id),
        _ => None,
    })
}

fn has_result(user: &UserMessage) -> bool {
    user.content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
}

/// 末尾的未结调用（与 `kernel/crates/session/src/resume.rs` 的 `trailing` 同一个口径，本 crate 不能依赖
/// session，因此在这里实现一份）：从最后往前，越过 system、attachment 与带工具结果的 user；还没越过回复时也
/// 越过 meta 消息；遇到别的 user（人类输入）为止。
fn trailing(messages: &[Message], unresolved: &HashSet<&ToolUseId>) -> HashSet<ToolUseId> {
    let mut out = HashSet::new();
    let mut seen_reply = false;
    for message in messages.iter().rev() {
        match message {
            Message::System(_) | Message::Attachment(_) => {}
            Message::User(user) if has_result(user) => {}
            Message::User(user)
                if !seen_reply && matches!(user.origin, UserOrigin::Meta { .. }) => {}
            Message::User(_) => break,
            Message::Assistant(_) => {
                seen_reply = true;
                out.extend(calls(message).filter(|id| unresolved.contains(id)).cloned());
            }
        }
    }
    out
}

/// 末尾没有结果的 `tool_use` 补一条 `is_error` 的中断结果（按回复与块的顺序），返回还没落库的消息。
fn interrupted_results(messages: &[Message], mut id: impl FnMut() -> MessageId) -> Vec<Message> {
    let results: HashSet<&ToolUseId> = messages
        .iter()
        .filter_map(|message| match message {
            Message::User(user) => Some(user.content.iter()),
            _ => None,
        })
        .flatten()
        .filter_map(|block| match block {
            ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id),
            _ => None,
        })
        .collect();
    let unresolved: HashSet<&ToolUseId> = messages
        .iter()
        .flat_map(calls)
        .filter(|id| !results.contains(id))
        .collect();
    if unresolved.is_empty() {
        return Vec::new();
    }
    let keep = trailing(messages, &unresolved);
    messages
        .iter()
        .flat_map(|message| calls(message).map(move |call| (message.id().clone(), call.clone())))
        .filter(|(_, call)| keep.contains(call))
        .map(|(assistant, call)| {
            Message::User(UserMessage {
                id: id(),
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: call,
                    content: vec![ToolResultContent::Text {
                        text: INTERRUPTED_CALL.to_owned(),
                    }],
                    is_error: true,
                }],
                origin: UserOrigin::ToolResult { assistant },
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "restore_tests.rs"]
mod tests;

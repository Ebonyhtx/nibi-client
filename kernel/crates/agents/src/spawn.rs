//! 跑一个子代理：建子会话、组装子循环、等它结束、整理结果（docs/specs/rust-cli/agents.md §4、§5）。

use std::sync::Arc;

use nibi_kernel_api::abort::{Abort, AbortReason};
use nibi_kernel_api::env_shell;
use nibi_kernel_api::ids::{AgentId, OwnerEpoch, SessionId, ToolUseId, TraceId};
use nibi_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use nibi_kernel_api::metering::CallStatus;
use nibi_kernel_api::model::{ModelSelection, QuerySource};
use nibi_kernel_api::orchestration::{QueryError, QueryRequest, QueryStop, ToolRegistry};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::store::{
    Fact, FactBatch, SessionKind, SessionMeta, StoreError, TurnAnchor,
};
use tokio_util::sync::CancellationToken;

use crate::Core;
use crate::child::{ChildSink, Parent};
use crate::context::SubagentContext;
use crate::live::{AgentState, LiveAgent};
use crate::report::{self, Ending, Report};
use crate::routing;
use crate::runs::{RunInfo, Tracked};
use crate::toolset::{FilteredTools, ToolRule};

/// 子代理的模型：定义里的模型 ID（`inherit` 与缺省继承父运行），`effort` 参数优先于定义。provider 与账号连接
/// （Team Plan 的团队项目，工作线 F49）都跟父运行：同一个团队项目、换一个模型。
pub(crate) fn selection(
    parent: &ModelSelection,
    model: Option<&str>,
    effort: Option<String>,
) -> ModelSelection {
    let mut selection = match model.filter(|model| *model != "inherit") {
        Some(model) => ModelSelection {
            provider: parent.provider.clone(),
            model: model.to_owned(),
            reasoning: None,
            connection: parent.connection.clone(),
        },
        None => parent.clone(),
    };
    if effort.is_some() {
        selection.reasoning = effort;
    }
    selection
}

/// 模式的严格程度（Node 3.17.2 `PERMISSION_MODE_STRICTNESS`：plan < build < edit < guarded < yolo）。
/// `auto` 尚未实现，不参与比较；`dontAsk` 是 NIBI 的命令行模式，与 build 同级（它只会多拒绝询问，不会放宽）。
fn strictness(mode: PermissionMode) -> Option<u8> {
    match mode {
        PermissionMode::Plan => Some(0),
        PermissionMode::Default | PermissionMode::DontAsk => Some(1),
        PermissionMode::AcceptEdits => Some(2),
        PermissionMode::Guarded => Some(3),
        PermissionMode::BypassPermissions => Some(4),
        PermissionMode::Auto => None,
    }
}

/// 子模式只能收紧父模式（Node `restrictPermissionMode`）：返回更严格的一个；任一方无法比较（`auto`）时
/// 继承父模式。修复线 A2：以前只收紧 bypassPermissions，`edit`/`guarded` 一类声明能把 build 父会话放宽。
pub(crate) fn restrict(parent: PermissionMode, child: PermissionMode) -> PermissionMode {
    match (strictness(parent), strictness(child)) {
        (Some(parent_rank), Some(child_rank)) if child_rank < parent_rank => child,
        _ => parent,
    }
}

/// 子代理的模式：定义里的 `permissionMode` 只能在父运行的模式上收紧；没有声明时继承父运行（含 plan）。
/// 插件 profile 的声明同样走这里（只收紧）：插件是第三方代码，不能借声明把父会话变宽。
pub(crate) fn mode(parent: PermissionMode, declared: Option<PermissionMode>) -> PermissionMode {
    match declared {
        Some(declared) => restrict(parent, declared),
        None => parent,
    }
}

/// 子代理的执行状态（Node `resolveExecutionState({mode: childMode === "plan" ? config.mode : childMode,
/// planEnabled: childMode === "plan"})`）：声明收紧后的模式是 plan 时保留 plan 开关、基础模式继承父会话；
/// 其余情况就是那个模式（plan 关着）。父会话的执行状态由 `ToolUseContext.execution` 给出。
pub(crate) fn execution(
    parent: nibi_kernel_api::permission::ExecutionState,
    declared: Option<PermissionMode>,
) -> nibi_kernel_api::permission::ExecutionState {
    let child = mode(parent.effective(), declared);
    if child == PermissionMode::Plan {
        nibi_kernel_api::permission::ExecutionState {
            mode: parent.base_mode(),
            plan: true,
        }
    } else {
        nibi_kernel_api::permission::ExecutionState::from(child)
    }
}

pub(crate) fn user(core: &Core, text: &str, origin: UserOrigin) -> Message {
    Message::User(UserMessage {
        id: core.ports.ids.message(),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin,
    })
}

/// 提交到子会话；返回这一批之后的当前轮（子会话的当前轮由这里与 `ChildSink` 持有，node-store.md §4，修复线 F6）。
pub(crate) async fn commit(
    core: &Core,
    session: &SessionId,
    facts: Vec<Fact>,
    current: Option<&TurnAnchor>,
) -> Result<Option<TurnAnchor>, StoreError> {
    let turn = TurnAnchor::after(current, &facts, || core.ports.ids.turn());
    let batch = FactBatch {
        owner_epoch: OwnerEpoch::LOCAL,
        command: None,
        facts,
        turn: turn.clone(),
    };
    core.ports.store.commit(session, batch).await?;
    Ok(turn)
}

/// 一次运行的开头：历史（最后一条是这次运行的输入）与子会话的当前轮。
pub(crate) struct Opening {
    pub(crate) messages: Vec<Message>,
    pub(crate) turn: Option<TurnAnchor>,
}

/// 建子会话并提交模型、模式与第一条 user 消息；返回登记好的子代理（状态为运行中）。
pub(crate) async fn create(
    core: &Core,
    mut agent: LiveAgent,
    parent: &RunInfo,
    prompt: &str,
) -> Result<(LiveAgent, Opening), StoreError> {
    let meta = SessionMeta {
        id: agent.child.clone(),
        kind: SessionKind::Subagent,
        parent: Some(parent.session.clone()),
        workspace: agent.workspace.clone(),
        title: agent.description.clone(),
        trace: TraceId::new(agent.root.as_str()),
        created_at_ms: core.ports.clock.now_ms(),
    };
    core.ports.store.create(meta).await?;
    // 子代理会话看到与父会话同一批会话级 MCP 工具（Node 的子代理 app 继承父 `config.mcp`），
    // 也继承父会话的附加工作目录与插件快照（skills/hooks/agents）。
    core.inherit_session_mcp(&parent.session, &agent.child);
    core.inherit_session_directories(&parent.session, &agent.child);
    core.inherit_session_plugins(&parent.session, &agent.child);
    inherit_directory(core, &agent).await;
    let first = user(core, prompt, UserOrigin::Human);
    let mut facts = vec![
        Fact::ModelSelected {
            selection: agent.selection.clone(),
        },
        // 子会话的执行状态整体落库（基础模式 + plan）：只写 `ModeChanged{plan}` 时续写会丢掉基础模式
        // （Node 的子会话也持久化 `childExecutionState`，修复线 A1/A2）。
        Fact::ExecutionChanged {
            state: agent.execution,
        },
    ];
    // fork：子会话记下父会话与切点（溯源用，node-store.md §4.8.1）；继承的前缀不落库。
    if let Some(prefix) = &agent.fork_prefix {
        facts.push(Fact::Entry {
            kind: crate::fork::PARENT_ENTRY.to_owned(),
            id: agent.agent.as_str().to_owned(),
            data: serde_json::json!({
                "parentSession": parent.session.as_str(),
                "throughMessageId": prefix
                    .iter()
                    .rev()
                    .nth(2)
                    .map(|message| message.id().as_str().to_owned()),
                "toolUseId": agent.tool_use.as_ref().map(|id| id.as_str().to_owned()),
            }),
        });
    }
    // 重启后续跑要用的身份（docs/subagent-restart-resume.md）：与模型/模式/第一条消息同一批落库，
    // 冷加载时进程里已没有 `Live`，只有这条 entry 能说明“这个子会话是谁、属于谁”。
    facts.push(Fact::Entry {
        kind: crate::restore::SPAWN_ENTRY.to_owned(),
        id: agent.agent.as_str().to_owned(),
        data: serde_json::json!({
            "agentId": agent.agent.as_str(),
            "childSessionId": agent.child.as_str(),
            "parentSession": parent.session.as_str(),
            "rootSession": agent.root.as_str(),
            "ownerAgentId": agent.owner.as_ref().map(AgentId::as_str),
            "depth": agent.depth,
            "toolUseId": agent.tool_use.as_ref().map(ToolUseId::as_str),
            "description": &agent.description,
            "agentType": &agent.definition.agent_type,
            "workspace": &agent.workspace,
            "machine": &agent.machine,
            "selection": &agent.selection,
            "execution": agent.execution,
            "background": agent.background,
            "fork": agent.fork_prefix.is_some(),
            "createdAtMs": core.ports.clock.now_ms(),
        }),
    });
    facts.push(Fact::MessageAppended {
        message: first.clone(),
    });
    let turn = commit(core, &agent.child, facts, None).await?;
    agent.state = AgentState::Running {
        abort: Abort::new(),
        mailbox: Vec::new(),
    };
    core.live.insert(agent.clone());
    // 子代理开始：告诉顶层会话（会话 actor 把它写成 `KernelEvent::Subagent`，
    // `v4/telemetry/event` 的 `subagent.lifecycle` 事实从那里来）。
    // 在 `insert` 之后发：收到信号的一方去读目录时，表里已经有它。
    core.hub.subagent_lifecycle(
        &agent,
        nibi_kernel_api::agents::SubagentLifecyclePhase::Spawned,
        // 开始时状态就是 running（Node `SubagentSpawned.payload.status`）。
        "running".to_owned(),
        None,
    );
    let messages = with_prefix(&agent, vec![first]);
    Ok((agent, Opening { messages, turn }))
}

/// 子会话的当前目录取父会话此刻的当前目录（派生时复制父会话的 cwd，之后主线程的
/// `cd` 传不过去，tools-files.md §3.3）。缺陷修复（F19）：以前子会话没有自己的 shell cwd，文件工具、判决链与 Bash 都
/// 落回工作区根——父会话 `cd sub` 之后，子代理的 `x.txt` 是根下的 x.txt。执行环境不支持时照旧（工作区根）。
async fn inherit_directory(core: &Core, agent: &LiveAgent) {
    let shell = core.ports.machine.shell().as_ref();
    let cwd = env_shell::current_dir(shell, &agent.workspace, &agent.parent).await;
    if let Err(error) = shell.set_shell_cwd(&agent.child, cwd).await {
        tracing::debug!(%error, "the subagent starts in the workspace root");
    }
}

/// 续跑已结束或停放的子代理：在子会话里追加 user 消息（SendMessage 是用户来源；通知是 meta，
/// 来源 `task-notification`，agents.md §5.1），返回完整历史。
pub(crate) async fn resume(
    core: &Core,
    agent: &LiveAgent,
    message: &str,
    origin: UserOrigin,
) -> Result<Opening, StoreError> {
    let loaded = core.ports.store.load(&agent.child).await?;
    let mut messages = with_prefix(agent, loaded.messages);
    let next = user(core, message, origin);
    let turn = commit(
        core,
        &agent.child,
        vec![Fact::MessageAppended {
            message: next.clone(),
        }],
        loaded.turn.as_ref(),
    )
    .await?;
    messages.push(next);
    Ok(Opening { messages, turn })
}

/// fork 的子会话只存自己的消息：前面拼上内存里继承的前缀（修复线 L-A，agents.md §8.1.3）。
fn with_prefix(agent: &LiveAgent, own: Vec<Message>) -> Vec<Message> {
    match &agent.fork_prefix {
        Some(prefix) => prefix.iter().cloned().chain(own).collect(),
        None => own,
    }
}

/// 一次子循环的结果。
pub(crate) struct Finished {
    pub(crate) ending: Ending,
    pub(crate) report: Report,
    /// 子循环本身出错（不是模型的 API 错误）。
    pub(crate) error: Option<QueryError>,
}

fn abort_of(agent: &LiveAgent) -> Abort {
    match &agent.state {
        AgentState::Running { abort, .. } => abort.clone(),
        AgentState::Parked(_) | AgentState::Finished(_) => Abort::new(),
    }
}

/// 跑到结束。前台时 `cancel` 是父工具调用的取消信号，收到后中止子循环并等它收尾。
pub(crate) async fn drive(
    core: &Arc<Core>,
    agent: &LiveAgent,
    opening: Opening,
    parent: Option<Parent>,
    cancel: Option<CancellationToken>,
) -> Finished {
    let Opening { messages, turn } = opening;
    let started = core.ports.clock.now_ms();
    tracing::info!(
        event = "subagent.start",
        session = %agent.parent,
        agent = %agent.agent,
        child = %agent.child,
        agent_type = %agent.definition.agent_type,
        background = agent.background,
        depth = agent.depth,
        "subagent started"
    );
    let abort = abort_of(agent);
    // 这次运行开头的 user 消息是列表的最后一条（新建时是 prompt，续跑时是追加的消息）。
    let prompt = messages
        .last()
        .map_or_else(|| core.ports.ids.message(), |message| message.id().clone());
    let sink = Arc::new(
        ChildSink::new(
            core.ports.store.clone(),
            core.ports.ids.clone(),
            core.live.clone(),
            agent.agent.clone(),
            agent.child.clone(),
            prompt,
            parent,
        )
        .with_turn(turn)
        .with_execution(agent.execution)
        .asking(&agent.definition.agent_type, agent.asks.clone())
        .with_core(core.clone()),
    );
    let result = match core.registry() {
        Some(registry) => {
            run_loop(core, agent, registry, messages, sink.clone(), abort, cancel).await
        }
        // 主线程的注册表已随内核释放（R1-13）：不带工具空跑没有意义，按失败结束。
        None => Err(QueryError::Unsupported {
            what: "running a subagent after the kernel was released".to_owned(),
        }),
    };
    // 子会话这一轮的 `turn_usage`（usage.md §2.4）：用量行是观测，写不进去只记日志。
    let status = match &result {
        Ok(QueryStop::Aborted) => CallStatus::Cancelled,
        // 与终态一致：API 错误与 stop hook 阻塞都算这一轮失败（docs/subagent-restart-resume.md「顺带修正」）。
        Ok(QueryStop::ApiError { .. } | QueryStop::Blocked { .. }) | Err(_) => CallStatus::Error,
        Ok(QueryStop::Completed | QueryStop::MaxTurns) => CallStatus::Completed,
    };
    if let Err(error) = sink.commit(vec![Fact::TurnEnded { status }]).await {
        tracing::warn!(%error, "the subagent turn usage could not be stored");
    }
    let (last, tool_uses) = sink.outcome();
    let mut text = report::final_text(last.as_ref());
    let (ending, error) = ending_of(result, &mut text);
    let duration_ms = core.ports.clock.now_ms().saturating_sub(started);
    let report = Report {
        text,
        tokens: report::tokens(last.and_then(|last| last.usage)),
        tool_uses,
        duration_ms,
    };
    // 重启后的终态（docs/subagent-restart-resume.md）：完成、失败与停止都写，恢复逻辑据此不再重跑
    // 用户停掉或已经结束的子代理；通知丢了时也靠它补发。写在 `TurnEnded` 之后，作为独立一批。
    let finished_at = core.ports.clock.now_ms();
    let stored = Fact::Entry {
        kind: crate::restore::RESULT_ENTRY.to_owned(),
        id: agent.agent.as_str().to_owned(),
        data: serde_json::json!({
            "ending": ending.status(),
            "text": &report.text,
            "tokens": report.tokens,
            "toolUses": report.tool_uses,
            "durationMs": report.duration_ms,
            "toolUseId": agent.tool_use.as_ref().map(ToolUseId::as_str),
            "finishedAtMs": finished_at,
        }),
    };
    if let Err(error) = sink.commit(vec![stored]).await {
        tracing::warn!(agent = %agent.agent, %error, "the subagent result could not be stored");
    }
    // `Option` 的字段在 None 时不写（logging.md §2）。
    let failure = error.as_ref().map(ToString::to_string);
    tracing::info!(
        event = "subagent.end",
        session = %agent.parent,
        agent = %agent.agent,
        child = %agent.child,
        background = agent.background,
        ending = ?ending,
        duration_ms,
        tool_uses,
        error = failure.as_deref(),
        "subagent finished"
    );
    Finished {
        ending,
        report,
        error,
    }
}

/// 子循环结果的终态：中止是 `Killed`；API 错误与 stop hook 阻塞是 `Failed`（以前算 `Completed`，重启恢复
/// 就无法区分“跑完了”和“网络失败”，docs/subagent-restart-resume.md「顺带修正」）；其余完成。子循环以一条
/// API 错误消息结束时，报表为空就用它当部分文本。
pub(crate) fn ending_of(
    result: Result<QueryStop, QueryError>,
    text: &mut String,
) -> (Ending, Option<QueryError>) {
    match result {
        Ok(QueryStop::Aborted) => (Ending::Killed, None),
        Ok(QueryStop::ApiError { message } | QueryStop::Blocked { message }) => {
            if text.is_empty() {
                *text = message.clone();
            }
            // `QueryError` 没有“API 错误”这一变体；`InvalidRequest` 是唯一带自由文本、且不冒充
            // 网络/协议错误的载体（错误文本原样进 `<summary>` 的 `failed: …`）。
            (
                Ending::Failed,
                Some(QueryError::Api { message }),
            )
        }
        Ok(QueryStop::Completed | QueryStop::MaxTurns) => (Ending::Completed, None),
        // 失败时 `<result>` 仍是已有的文本，错误进 `<summary>`（`failed: <error>`，agents.md §5）。
        Err(error) => (Ending::Failed, Some(error)),
    }
}

/// 组装子循环并跑到结束。前台时 `cancel` 是父工具调用的取消信号，收到后中止子循环并等它收尾。
async fn run_loop(
    core: &Arc<Core>,
    agent: &LiveAgent,
    registry: Arc<dyn ToolRegistry>,
    messages: Vec<Message>,
    sink: Arc<ChildSink>,
    abort: Abort,
    cancel: Option<CancellationToken>,
) -> Result<QueryStop, QueryError> {
    // fork：主线程的整份注册表与主线程的 system（同对照实现，修复线 L-A，agents.md §8.1.2）。
    let (tools, context): (
        Arc<dyn ToolRegistry>,
        Arc<dyn nibi_kernel_api::orchestration::ContextBuilder>,
    ) = if agent.fork_prefix.is_some() {
        (
            registry,
            Arc::new(crate::fork::ForkContext {
                inner: core.ports.context.clone(),
            }),
        )
    } else {
        (
            Arc::new(FilteredTools {
                inner: registry,
                rule: ToolRule::new(&agent.definition, agent.background, agent.depth),
            }),
            Arc::new(SubagentContext {
                inner: core.ports.context.clone(),
                system: report::system(&agent.definition.prompt, &agent.selection),
            }),
        )
    };
    let runner = Tracked {
        inner: core.ports.queries.runner(tools, context),
        book: core.runs.clone(),
    };
    let request = QueryRequest {
        session: agent.child.clone(),
        run: core.ports.ids.run(),
        workspace: agent.workspace.clone(),
        agent: Some(agent.agent.clone()),
        messages,
        selection: agent.selection.clone(),
        mode: agent.mode(),
        source: QuerySource::Subagent(agent.definition.agent_type.clone()),
        max_turns: agent.definition.max_turns,
        prompt_hook_messages: Vec::new(),
    };
    let run = nibi_kernel_api::orchestration::QueryRunner::run(
        &runner,
        request,
        sink.clone(),
        abort.clone(),
    );
    tokio::pin!(run);
    match cancel {
        Some(cancel) => tokio::select! {
            result = &mut run => result,
            () = cancel.cancelled() => {
                abort.abort(AbortReason::User);
                run.await
            }
        },
        None => run.await,
    }
}

/// 后台运行：在 agents 的作用域里跑；结束后按 agents.md §5.1 停放、续跑或送出通知（`routing`）。
pub(crate) fn background(core: &Arc<Core>, agent: LiveAgent, opening: Opening) {
    let task_core = core.clone();
    let _task = core.ports.spawner.spawn("subagent", async move {
        let finished = drive(&task_core, &agent, opening, None, None).await;
        let settled = routing::settle(&task_core, &agent.agent, &finished);
        routing::wake(&task_core, settled.wakes).await;
    });
}

/// 新子代理的 ID（Node 的 `agent_<uuid>` 与 `sess_subagent_agent_<uuid>`）。
pub(crate) fn ids(core: &Core) -> (AgentId, SessionId) {
    core.ports.ids.subagent()
}

#[cfg(test)]
#[path = "spawn_tests.rs"]
mod tests;

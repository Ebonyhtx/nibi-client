//! DWF actor 轮（NIBI 动态工作流的路线 C：引擎在 Node sidecar，actor 的模型轮跑在 Rust）。
//!
//! 与子代理共用同一条子循环（`QueryLoop` + 子会话落库 + 工具过滤），但**不**进 agents 面板、
//! 不产生 hand-back 文本与完成通知：DWF 的 actor 归 run 引擎所有，父会话只通过 run 事件看到它。
//!
//! 一轮 = 一条 user 消息 → 子循环 → 终态文本与用量。typed ask 的 `submit_result` 与求助的
//! `escalate` 工具还没接（C1 的下一步）；这一层先把「persona → system → 一轮 → 终态」打通。

use std::sync::Arc;

use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::ids::{AgentId, SessionId, TraceId};
use rust_cli_kernel_api::message::UserOrigin;
use rust_cli_kernel_api::model::{ModelSelection, QuerySource};
use rust_cli_kernel_api::orchestration::{ContextBuilder, QueryRequest, ToolRegistry};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{
    Fact, SessionKind, SessionMeta, StoreError, TurnAnchor,
};
use tokio_util::sync::CancellationToken;

use crate::child::ChildSink;
use crate::context::SubagentContext;
use crate::definitions::{AgentDefinition, AgentSource};
use crate::toolset::{FilteredTools, ToolRule};
use crate::{Agents, Core};

/// 一个 actor 的固定属性（一个 run 内跨多轮不变）。
#[derive(Debug, Clone)]
pub struct ActorProfile {
    /// 父会话（`dwf_run.parent_session_id`）。
    pub parent: SessionId,
    /// actor 子会话（新建时由调用方铸造；Node 侧 id 由 `(runId, actorRef)` 纯确定地算）。
    pub child: SessionId,
    pub workspace: WorkspaceRef,
    pub selection: ModelSelection,
    pub mode: PermissionMode,
    /// persona：子循环 system 的第一段（Node 的 `PersonaSpec.prompt`）。
    pub prompt: String,
    /// 展示名（会话标题；run 侧板的 actor 名字）。
    pub label: String,
    /// 工具面：None 表示全部；`deny` 是减法（Node 的 `toolDisallowlist`）。
    pub allow: Option<Vec<String>>,
    pub deny: Vec<String>,
    pub max_turns: Option<u32>,
}

/// 一轮的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorTurnOutcome {
    /// actor 子会话（续跑时与传入的一致）。
    pub child: SessionId,
    /// 终态文本（最后一条 assistant 的正文；typed ask 接入后由 `submit_result` 优先）。
    pub text: String,
    pub tokens: u64,
    pub tool_uses: usize,
    /// `completed` / `aborted` / `failed`。
    pub stopped: &'static str,
    pub error: Option<String>,
}

/// 一轮失败（不会因为会话缺失等 IO 问题 panic）。
#[derive(Debug)]
pub enum ActorError {
    Store(StoreError),
    /// 续跑时 actor 会话不存在。
    SessionMissing { session: SessionId },
    /// 内核已释放注册表（关闭中）。
    Unavailable,
}

impl std::fmt::Display for ActorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(f, "{error}"),
            Self::SessionMissing { session } => write!(f, "actor session {session} does not exist"),
            Self::Unavailable => f.write_str("the kernel was released; the actor turn cannot run"),
        }
    }
}

impl std::error::Error for ActorError {}

impl From<StoreError> for ActorError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// 合成一个 actor 的定义：prompt 就是 persona，工具面按 allow/deny 过滤。
fn definition(profile: &ActorProfile) -> AgentDefinition {
    AgentDefinition {
        agent_type: format!("dwf-actor:{}", profile.label),
        when_to_use: String::new(),
        tools: profile.allow.clone(),
        disallowed_tools: profile.deny.clone(),
        prompt: profile.prompt.clone(),
        source: AgentSource::BuiltIn,
        model: None,
        effort: None,
        max_turns: profile.max_turns,
        permission_mode: None,
        background: false,
    }
}

/// 新建（`first`）或续跑 actor 子会话并提交这一轮的 user 消息；返回历史与当前轮。
async fn open(
    core: &Core,
    profile: &ActorProfile,
    message: &str,
    first: bool,
) -> Result<(Vec<rust_cli_kernel_api::message::Message>, Option<TurnAnchor>), ActorError> {
    let user = crate::spawn::user(core, message, UserOrigin::Human);
    if first {
        core.ports
            .store
            .create(SessionMeta {
                id: profile.child.clone(),
                kind: SessionKind::Subagent,
                parent: Some(profile.parent.clone()),
                workspace: profile.workspace.clone(),
                title: profile.label.clone(),
                trace: TraceId::new(profile.parent.as_str()),
                created_at_ms: core.ports.clock.now_ms(),
            })
            .await?;
        let turn = crate::spawn::commit(
            core,
            &profile.child,
            vec![
                Fact::ModelSelected {
                    selection: profile.selection.clone(),
                },
                Fact::ModeChanged {
                    mode: profile.mode,
                },
                Fact::MessageAppended {
                    message: user.clone(),
                },
            ],
            None,
        )
        .await?;
        return Ok((vec![user], turn));
    }
    let loaded = core
        .ports
        .store
        .load(&profile.child)
        .await
        .map_err(|error| match error {
            StoreError::NotFound { .. } => ActorError::SessionMissing {
                session: profile.child.clone(),
            },
            other => ActorError::Store(other),
        })?;
    let turn = crate::spawn::commit(
        core,
        &profile.child,
        vec![Fact::MessageAppended {
            message: user.clone(),
        }],
        loaded.turn.as_ref(),
    )
    .await?;
    let mut messages = loaded.messages;
    messages.push(user);
    Ok((messages, turn))
}

impl Agents {
    /// 跑一轮 actor：`first` 为真时先建子会话；否则在既有子会话里追加消息。
    ///
    /// 取消（sidecar 的 `cancel_ask`）走与子代理同一个 abort：回合收尾后返回 `aborted`。
    pub async fn run_actor_turn(
        &self,
        profile: &ActorProfile,
        message: &str,
        first: bool,
        cancel: Option<CancellationToken>,
    ) -> Result<ActorTurnOutcome, ActorError> {
        let core = &self.core;
        let (messages, turn) = open(core, profile, message, first).await?;
        let Some(registry) = core.registry() else {
            return Err(ActorError::Unavailable);
        };
        let definition = definition(profile);
        let tools: Arc<dyn ToolRegistry> = Arc::new(FilteredTools {
            inner: registry,
            rule: ToolRule::new(&definition, false, 1),
        });
        let context: Arc<dyn ContextBuilder> = Arc::new(SubagentContext {
            inner: core.ports.context.clone(),
            system: crate::report::system(&definition.prompt),
        });
        let runner = core.ports.queries.runner(tools, context);
        let prompt = messages
            .last()
            .map_or_else(|| core.ports.ids.message(), |message| message.id().clone());
        let sink = Arc::new(
            ChildSink::new(
                core.ports.store.clone(),
                core.ports.ids.clone(),
                core.live.clone(),
                AgentId::new("dwf-actor"),
                profile.child.clone(),
                prompt,
                None,
            )
            .with_turn(turn),
        );
        let abort = rust_cli_kernel_api::abort::Abort::new();
        let request = QueryRequest {
            session: profile.child.clone(),
            run: core.ports.ids.run(),
            workspace: profile.workspace.clone(),
            agent: Some(AgentId::new("dwf-actor")),
            messages,
            selection: profile.selection.clone(),
            mode: profile.mode,
            source: QuerySource::Subagent(definition.agent_type.clone()),
            max_turns: definition.max_turns,
            prompt_hook_messages: Vec::new(),
        };
        let run = runner.run(request, sink.clone(), abort.clone());
        tokio::pin!(run);
        let result = match cancel {
            Some(cancel) => tokio::select! {
                result = &mut run => result,
                () = cancel.cancelled() => {
                    abort.abort(rust_cli_kernel_api::abort::AbortReason::User);
                    run.await
                }
            },
            None => run.await,
        };
        let (last, tool_uses) = sink.outcome();
        let mut text = crate::report::final_text(last.as_ref());
        let (stopped, error) = match result {
            Ok(rust_cli_kernel_api::orchestration::QueryStop::Aborted) => ("aborted", None),
            Ok(rust_cli_kernel_api::orchestration::QueryStop::ApiError { message }
            | rust_cli_kernel_api::orchestration::QueryStop::Blocked { message }) => {
                if text.is_empty() {
                    text = message;
                }
                ("completed", None)
            }
            Ok(
                rust_cli_kernel_api::orchestration::QueryStop::Completed
                | rust_cli_kernel_api::orchestration::QueryStop::MaxTurns,
            ) => ("completed", None),
            Err(error) => ("failed", Some(error.to_string())),
        };
        Ok(ActorTurnOutcome {
            child: profile.child.clone(),
            text,
            tokens: crate::report::tokens(last.and_then(|last| last.usage)),
            tool_uses,
            stopped,
            error,
        })
    }
}

#[cfg(test)]
#[path = "actor_tests.rs"]
mod tests;

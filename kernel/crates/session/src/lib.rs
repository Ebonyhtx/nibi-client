//! 会话 actor：一个会话的状态的唯一 owner（docs/specs/rust-cli/README.md §3、§8）。
//!
//! 接收命令（按 CommandId 幂等）、排队、驱动主循环、把主循环事件转成持久事实（先提交再发事件）、
//! 给事件分配 seq。前端只经 [`SessionHandle`] 访问。
//!
//! 已实现：回合、排队、中断、切换模型与模式、主循环的提交屏障（[`sink`]）、待回答的交互
//! （先持久化再通知）；会话侧 hooks、文件 checkpoint、rewind、fork 与中断后续跑
//! （docs/specs/rust-cli/session-lifecycle.md）。

mod actor;
mod agent_signals;
mod bash;
mod checkpoints;
mod closing;
mod compact;
mod cron;
mod detached;
mod file_changes;
mod fork;
mod fork_input;
mod goal;
mod hooks;
#[cfg(test)]
mod input_tests;
mod lane;
mod local_record;
mod log;
mod loop_fold;
mod loop_tick;
#[cfg(test)]
mod metering_tests;
#[cfg(test)]
mod out_of_turn_tests;
mod mode;
mod monitors;
mod notices;
mod peer_receipts;
mod peer_restore;
mod peers;
mod rename;
mod rename_text;
mod resume;
mod resume_sentinel;
mod queue;
mod rewind;
mod rewind_machines;
mod rewind_plan;
mod rules;
mod sink;
mod slash;
mod steering;
mod tasks;
#[cfg(test)]
mod test_support;
mod title;
mod title_model;
mod title_parse;
mod turn;
mod watched;
mod workspace;

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use nibi_kernel_base::{Spawner, Task};
use nibi_kernel_api::agents::AgentSignals;
use nibi_kernel_api::clock::{Clock, Ids};
use nibi_kernel_api::ids::{Generation, MessageId, SessionId};
use nibi_kernel_api::local_services::LocalServices;
use nibi_kernel_api::machine::MachineEnv;
use nibi_kernel_api::message::Message;
use nibi_kernel_api::model::{ModelPort, ModelSelection};
use nibi_kernel_api::orchestration::{Compactor, HookRunner, QueryRunner};
use nibi_kernel_api::session_api::{
    Ack, CommandEnvelope, EndReason, KernelError, KernelEvent, RewindOption, SequencedEvent,
    SessionHandle, SessionView, StartSource,
};
use nibi_kernel_api::store::{
    ArtifactStore, SessionLaunchTurn, SessionMeta, SessionStore, WorkspaceCheckpoint,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::actor::{Actor, Request};
pub use crate::detached::DetachedAsks;
use crate::log::EventLog;
pub use crate::peers::PeerDeps;
pub use crate::title_model::TitleModel;

/// 命令队列的缓冲；满了时发送方等待。
const REQUESTS: usize = 64;

/// 会话 actor 依赖的能力。
#[derive(Clone)]
pub struct SessionDeps {
    pub store: Arc<dyn SessionStore>,
    pub ids: Arc<dyn Ids>,
    pub runner: Arc<dyn QueryRunner>,
    /// 手动压缩（`Command::Compact`，docs/specs/rust-cli/compact.md §4.2）。
    pub compactor: Arc<dyn Compactor>,
    /// 会话的机器：订阅后台命令的终态通知、查询后台工作（docs/specs/rust-cli/query.md §5）、shell 当前目录、代码回退
    /// （R0 只有本机；R3 起按机器分开，remote-exec.md §15.8.1）。
    pub machine: MachineEnv,
    /// 只在本机的服务：斜杠命令的工具上下文要带它。
    pub local: LocalServices,
    /// 执行环境的注册表（R3，remote-exec.md §20.7）：远端机器上的后台通知、Monitor、代码回退与会话关闭经它找到那台机器。
    pub machines: Arc<dyn nibi_kernel_api::env_registry::EnvironmentRegistry>,
    /// 每次提问最多几轮（`--max-turns`）。
    pub max_turns: Option<u32>,
    /// 子代理的信号：后台子代理的终态通知、任务清单变化（docs/specs/rust-cli/agents.md §5）。
    pub agents: Arc<dyn AgentSignals>,
    /// 会话内定时任务的唤醒与到期任务（docs/specs/rust-cli/tools-more.md §10.4）；`-p` 是 `NoCron`。
    pub cron: Arc<dyn nibi_kernel_api::cron::CronSignals>,
    /// 会话侧 hooks（UserPromptSubmit、SessionStart、SessionEnd、Notification）。
    pub hooks: Arc<dyn HookRunner>,
    /// 用户输入的斜杠命令（skill 的用户调用，docs/specs/rust-cli/ext.md §2.7）：回合任务先展开再跑 UPS。
    pub commands: Arc<dyn nibi_kernel_api::user_command::UserCommands>,
    /// 用户输入的 `@` 提及与 bash 模式（docs/specs/rust-cli/tui-input.md §1.1、§2.2）：回合任务在斜杠展开之后调用。
    pub inputs: Arc<dyn nibi_kernel_api::user_input::UserInputs>,
    /// checkpoint 的 artifact（rewind 读回写入前后的内容）。
    pub artifacts: Arc<dyn ArtifactStore>,
    /// fork 出的会话的创建时间；会话标题请求的用量计时（工作线 F73）。
    pub clock: Arc<dyn Clock>,
    /// 本地执行环境实例的 generation（回退事务的操作上下文）。
    pub generation: Generation,
    /// 会话自己的任务作用域：actor 与主循环都在这里启动。
    pub spawner: Spawner,
    /// 关闭任务的作用域（内核的根作用域，session-lifecycle.md §3.3.1）：关闭不依赖调用方的 future；会话自己的作用域
    /// 在关闭的最后一步释放，关闭任务不能在里面跑。
    pub closing: Spawner,
    /// 会话标题的生成（交互形态才有；`-p` 为 None，docs/specs/rust-cli/titles.md §2）。
    pub titles: Option<TitleModel>,
    /// 会话 actor 自己发的旁路请求用的模型端口（不带参数的 `/rename` 起名，titles.md §8；`-p` 也有）。
    pub side_model: Arc<dyn ModelPort>,
    /// 关闭之后由组装方释放的按会话状态（session-lifecycle.md §3.3）。
    pub released: Arc<dyn Released>,
    /// `/cd` 的说明里新目录的规则文件（tui-manage.md §7.1）：actor 用自己的活动历史调用。
    pub directory_rules: Arc<dyn nibi_kernel_api::orchestration::DirectoryRules>,
    /// 本机跨会话通信（docs/specs/rust-cli/cross-session.md §2.4）。
    pub peers: PeerDeps,
    /// 父会话关闭之后旧会话的询问入口（进程级，agents.md §4.1.2，工作线 F72）；没有时那些询问按会话已关闭失败。
    pub detached: Option<Arc<DetachedAsks>>,
    /// 「run 还欠着决定、主代理闲着」提醒钟的会话侧边（kernel-api `WorkflowBlockedEdges`，
    /// transcript-and-notifications.md「Reminding an idle main agent」）：actor 在忙闲转换处
    /// 调用，钟与宿主装配在 runtime。没有时（测试 / 嵌入）没有提醒链。
    pub blocked: Option<Arc<dyn nibi_kernel_api::workflow::WorkflowBlockedEdges>>,
}

/// 会话关闭的收尾（docs/specs/rust-cli/session-lifecycle.md §3.3、§3.3.1）：每个会话的关闭任务各调用一次。
pub trait Released: Send + Sync {
    /// 关闭任务的第一步（早于 SessionEnd）：组装方把会话表里的条目标成“关闭中”，之后打开同一个会话的调用等关闭走完。
    fn closing(&self, _session: &SessionId) {}

    /// 关闭任务的最后一步（actor 退出、执行环境与定时任务释放之后）：组装方（runtime）清掉各能力按会话保存的表，
    /// 最后把会话移出会话表、释放它的任务作用域。
    fn released(&self, session: &SessionId);
}

/// 没有按会话的表要释放（测试与嵌入）。
pub struct NothingToRelease;

impl Released for NothingToRelease {
    fn released(&self, _session: &SessionId) {}
}

/// 打开会话时的状态（新建或冷加载）。
pub struct SessionState {
    pub meta: SessionMeta,
    pub messages: Vec<Message>,
    /// 只供显示的、最后一个压缩点之前的消息（冷加载的 `LoadedSession.earlier`，工作线 F102）；新建的会话为空。
    pub earlier: Vec<Message>,
    pub selection: ModelSelection,
    /// 执行状态（权限模式 × plan 开关，修复线 F20）；旧的单值模式经 `From<PermissionMode>`（`Plan` 是 plan 开）。
    pub mode: nibi_kernel_api::permission::ExecutionState,
    /// 还没有被代码回退撤销的 checkpoint（冷加载的 `LoadedSession.checkpoints`）。
    pub checkpoints: Vec<WorkspaceCheckpoint>,
    /// SessionStart hook 的来源（session-lifecycle.md §3.2）。
    pub start: StartSource,
    /// 当前轮（冷加载的 `LoadedSession.turn`；新建的会话没有）。
    pub turn: Option<nibi_kernel_api::store::TurnAnchor>,
    /// 当前轮以错误结束（冷加载的 `LoadedSession.last_turn_failed`）：续写时不补 assistant（session-lifecycle.md
    /// §6.3.1）。
    pub last_turn_failed: bool,
    /// 工作流控制轮（冷加载的 `LoadedSession.launches`，launch.md）：会话 actor 在 `write_launch` 时追加，
    /// `view()` 带给冷投影。
    pub launches: Vec<SessionLaunchTurn>,
    /// 每轮输入的模型选择（冷加载的 `LoadedSession.model_turns`）：actor 在提交用户输入时追加，
    /// `view()` 带给冷投影（模型切换分隔线）。
    pub model_turns: Vec<nibi_kernel_api::store::SessionModelTurn>,
    /// 草稿（NIBI legacy `session/create` 的 `persistence: "deferred"`）：还没有会话行，状态与消息只在
    /// 内存里；第一条用户输入提交时 actor 才写会话行与初始事实（`actor.rs` 的 `promote`）。
    pub draft: bool,
}

/// 会话是新建的还是从存储加载的；新建时发出 `SessionCreated`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opened {
    Created,
    Loaded,
}

pub struct Session {
    id: SessionId,
    requests: mpsc::Sender<Request>,
    log: Arc<EventLog>,
    deps: SessionDeps,
    /// 草稿（`persistence: "deferred"`）：第一条用户输入之前还没有会话行，列表类投影不显示它。actor
    /// 提交首条输入时把它置为 false（[`Actor::promote`]），这里与 actor 共用同一个旗标。
    draft: Arc<std::sync::atomic::AtomicBool>,
    /// 每台远端机器上一份的后台命令（远端执行 F96，remote-exec.md §23.3）：快照的唯一 owner 是会话；重连中的机器用它。
    last_remote: tasks::LastSeen,
    /// 关闭的进度（[`closing`]）：None 还没关；Some 关闭任务已经起了，令牌在它结束时取消。
    closing: Mutex<Option<CancellationToken>>,
    _actor: Task<Option<()>>,
}

impl Session {
    pub fn spawn(deps: SessionDeps, mut state: SessionState, opened: Opened) -> Self {
        let id = state.meta.id.clone();
        let log = Arc::new(EventLog::new());
        let draft = Arc::new(std::sync::atomic::AtomicBool::new(state.draft));
        let mut pending = Vec::new();
        match opened {
            Opened::Created => {
                log.append(KernelEvent::SessionCreated {
                    meta: state.meta.clone(),
                });
            }
            // 中断后续跑：末尾没有结果的调用补中断结果、更早的去掉 tool_use 块（session-lifecycle.md §6.3，工作线
            // F81）；最后一条 user 消息没有回答时补一条 assistant（§6.3.1）。补的消息由 actor 随第一批带消息的提交
            // 落库（工作线 F77），会话里切过去时由 `Command::StoreResumeSentinel` 马上落库（F79）。
            Opened::Loaded => {
                let ids = deps.ids.clone();
                let (messages, results) =
                    resume::settle(std::mem::take(&mut state.messages), || ids.message());
                state.messages = messages;
                pending = results;
                pending.extend(resume_sentinel::insert(
                    &mut state.messages,
                    state.last_turn_failed,
                    || ids.message(),
                ));
            }
        }
        let (requests, receiver) = mpsc::channel(REQUESTS);
        let spawner = deps.spawner.clone();
        // 从存储打开的会话：进入循环之前先让任务表从活动历史复原会话任务（tools-more.md
        // §18.2），第一次 `take_due` 时任务表已就绪。新建的会话没有历史，不调。
        let resume = (opened == Opened::Loaded).then(|| state.messages.clone());
        let cron = deps.cron.clone();
        let session = id.clone();
        let actor = Actor::new(
            deps.clone(),
            log.clone(),
            state,
            requests.downgrade(),
            pending,
            draft.clone(),
        );
        let task = spawner.spawn_resident("session-actor", async move {
            if let Some(history) = resume {
                cron.resume(&session, &history).await;
            }
            actor.run(receiver).await
        });
        Self {
            id,
            requests,
            log,
            deps,
            draft,
            last_remote: tasks::LastSeen::default(),
            closing: Mutex::default(),
            _actor: task,
        }
    }

    /// 这个会话还是草稿（还没有会话行）：列表类投影（工作区面板、项目页）不把它算进去。
    pub fn is_draft(&self) -> bool {
        self.draft.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 草稿的外部活动（Node `ensureSessionPersistedForExternalActivity`）：让 actor 现在写会话行与
    /// 初始事实。已经不是草稿时直接返回；关闭中的草稿不落库。
    pub async fn persist_draft(&self) -> Result<(), KernelError> {
        if !self.is_draft() {
            return Ok(());
        }
        self.ask(|reply| Request::Persist { reply })
            .await?
            .map_err(|message| KernelError::Failed { message })
    }

    async fn ask<T>(
        &self,
        request: impl FnOnce(oneshot::Sender<T>) -> Request,
    ) -> Result<T, KernelError> {
        closing::ask(&self.requests, request).await
    }

    /// 把 DWF 引擎的归属事实写进本会话的事件流（`v4/telemetry/event` 的 `workflow.lifecycle`
    /// 事实来源）：只广播、不落库、不动 revision（`log.rs` 的 `changes_state`）。
    pub fn note_workflow_lifecycle(
        &self,
        fact: nibi_kernel_api::session_api::WorkflowLifecycleFact,
    ) {
        self.log
            .append(KernelEvent::WorkflowLifecycle { fact });
    }

    /// 把 DWF 引擎的一条进度事件写进本会话的事件流（快照 `workflowRuns` 的实时来源）：与
    /// [`Self::note_workflow_lifecycle`] 同一条只广播、不落库的路径。
    pub fn note_workflow_run_progress(
        &self,
        progress: nibi_kernel_api::workflow::WorkflowRunProgress,
    ) {
        self.log
            .append(KernelEvent::WorkflowRunProgress { progress });
    }

    /// 给定消息集合选中这一轮的 checkpoint；空集合是全部（冷打开的摘要）。
    async fn checkpoints(&self, messages: &[MessageId]) -> Result<Vec<WorkspaceCheckpoint>, KernelError> {
        self.ask(|reply| Request::Checkpoints {
            messages: messages.to_vec(),
            reply,
        })
        .await
    }

    /// 回合外的工具授权（MCP Apps 的页面调用）要的会话当前状态：权限模式与工作目录。
    /// 两者都按请求时的值回答，owner 是会话 actor（`/cd` 与模式切换之后立即生效）。
    pub async fn out_of_turn_context(
        &self,
    ) -> Result<
        (
            nibi_kernel_api::permission::PermissionMode,
            nibi_kernel_api::env::WorkspaceRef,
        ),
        KernelError,
    > {
        self.ask(|reply| Request::TurnContext { reply }).await
    }

    /// 回合外的模型请求（MCP Apps 采样）要的当前模型选择：owner 是会话 actor。
    pub async fn out_of_turn_selection(
        &self,
    ) -> Result<nibi_kernel_api::model::ModelSelection, KernelError> {
        self.ask(|reply| Request::Selection { reply }).await
    }

    /// 记一次回合外模型请求的用量（MCP Apps 采样）：Node 在 `sample-model.ts` 的 `finally` 里写
    /// `model_usage`，请求失败或取消也记。草稿会话先落库（Node 采样前 `ensureSessionPersisted`），
    /// 否则用量行没有会话行可挂。
    pub async fn record_usage(
        &self,
        call: nibi_kernel_api::metering::ModelCall,
    ) -> Result<(), KernelError> {
        self.persist_draft().await?;
        self.ask(|reply| Request::RecordUsage {
            call: Box::new(call),
            reply,
        })
        .await?
        .map_err(|message| KernelError::Failed { message })
    }

    /// 会话级的询问入口（`Interactions::lasting`）：回合外工具授权的审批链用它，
    /// 询问不随回合结束取消、只随会话关闭取消。
    pub fn session_interactions(&self) -> Arc<dyn nibi_kernel_api::orchestration::Interactions> {
        Arc::new(crate::sink::SessionAsks {
            requests: self.requests.downgrade(),
            session: self.id.clone(),
            detached: self.deps.detached.clone(),
        })
    }
}

fn closed() -> KernelError {
    KernelError::Failed {
        message: "the session is closed".to_owned(),
    }
}

#[async_trait]
impl SessionHandle for Session {
    fn id(&self) -> &SessionId {
        &self.id
    }

    fn is_draft(&self) -> bool {
        Session::is_draft(self)
    }

    async fn send(&self, envelope: CommandEnvelope) -> Ack {
        let (reply, answer) = oneshot::channel();
        if self
            .requests
            .send(Request::Command { envelope, reply })
            .await
            .is_err()
        {
            return Ack::Rejected {
                reason: closed().to_string(),
            };
        }
        answer.await.unwrap_or_else(|_| Ack::Rejected {
            reason: closed().to_string(),
        })
    }

    fn subscribe(&self, after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        self.log.subscribe(after)
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        self.ask(|reply| Request::View { reply }).await
    }

    /// SessionEnd 在关闭任务里跑（hook 只读 meta），不占用 actor（spec §3.3）。之后关闭 actor、释放执行环境
    /// 与定时任务、交组装方释放按会话的表；只关一次，关闭任务不依赖调用方（[`closing`]，§3.3.1）。
    ///
    /// 修复（R1-1）：以前这里只跑 SessionEnd 与 `cron.session_closed`，actor 一直活着（内核的会话表持有句柄）：
    /// `/clear`、`/resume`、fork 之后旧会话收到后台通知就在用户看不到的地方自己开回合，按会话的表与 EventLog 不释放，
    /// `Commands::close_session` 没有调用方，再打开同一会话拿到旧 actor、不跑 SessionStart。现在：前台工作
    /// 中止，后台工作保留（`/clear`、`/resume` 不 `forget`），actor 退出，组装方把会话移出会话表。
    async fn close(&self, reason: EndReason) -> Vec<String> {
        closing::close(self, reason).await
    }

    /// actor 给出可选消息与 checkpoint 的快照；读 artifact 算统计在调用方的任务里做。
    async fn rewind_options(&self) -> Result<Vec<RewindOption>, KernelError> {
        let snapshot = self.ask(|reply| Request::RewindOptions { reply }).await?;
        Ok(rewind::options(self.deps.artifacts.as_ref(), snapshot).await)
    }

    /// 每轮的改动摘要：actor 给出 checkpoint，artifact 在调用方的任务里读（与 `rewind_options` 同一分工）。
    async fn file_change_summaries(
        &self,
    ) -> Result<Vec<nibi_kernel_api::file_changes::TurnFileSummary>, KernelError> {
        let checkpoints = self.checkpoints(&[]).await?;
        let selected: Vec<&WorkspaceCheckpoint> = checkpoints.iter().collect();
        Ok(file_changes::summaries(self.deps.artifacts.as_ref(), &selected).await)
    }

    async fn file_changes(
        &self,
        messages: &[MessageId],
    ) -> Result<nibi_kernel_api::file_changes::FileChangesReport, KernelError> {
        let checkpoints = self.checkpoints(messages).await?;
        let selected: Vec<&WorkspaceCheckpoint> = checkpoints.iter().collect();
        file_changes::report(self.deps.artifacts.as_ref(), &selected)
            .await
            .map_err(|message| KernelError::Failed { message })
    }

    async fn file_rewind_preview(
        &self,
        messages: &[MessageId],
    ) -> Result<nibi_kernel_api::file_changes::RewindPreview, KernelError> {
        let checkpoints = self.checkpoints(messages).await?;
        let meta = self.ask(|reply| Request::Meta { reply }).await?;
        let selected: Vec<&WorkspaceCheckpoint> = checkpoints.iter().collect();
        Ok(file_changes::preview(
            self.deps.artifacts.as_ref(),
            self.deps.machine.files(),
            &meta.workspace,
            self.deps.machines.as_ref(),
            &selected,
        )
        .await)
    }

    async fn goal(&self) -> Result<nibi_kernel_api::goal::GoalView, KernelError> {
        self.ask(|reply| Request::Goal { reply }).await
    }

    /// 后台任务的事实不在 actor 里（执行环境的账本与 agents）：取 meta 后在调用方的任务里汇总
    /// （docs/specs/rust-cli/tui-display.md §3.1）。
    async fn background_tasks(
        &self,
    ) -> Result<Vec<nibi_kernel_api::manage::BackgroundEntry>, KernelError> {
        let meta = self.ask(|reply| Request::Meta { reply }).await?;
        Ok(
            tasks::background_entries(&self.deps, &self.last_remote, &meta.workspace, &meta.id)
                .await,
        )
    }

    /// 子代理的事实在 agents 里（tui-panels.md §1）：不经 actor，直接转给它，按这个顶层会话过滤。
    async fn subagents(
        &self,
    ) -> Result<Vec<nibi_kernel_api::panels::SubagentEntry>, KernelError> {
        Ok(self.deps.agents.subagents(&self.id).await)
    }

    fn subagent_changes(&self) -> BoxStream<'static, ()> {
        self.deps.agents.subagent_changes()
    }

    /// 子代理列表与后台任务的同一份快照（修复线 F34，tui-panels.md §0）：actor 只给出工作区，命令与子代理在调用方的
    /// 任务里取，一次回执。
    async fn tasks_snapshot(
        &self,
    ) -> Result<nibi_kernel_api::panels::TasksSnapshot, KernelError> {
        let meta = self.ask(|reply| Request::Meta { reply }).await?;
        Ok(tasks::snapshot(&self.deps, &self.last_remote, &meta.workspace, &meta.id).await)
    }

    async fn subagent_view(
        &self,
        agent: &nibi_kernel_api::ids::AgentId,
    ) -> Result<SessionView, KernelError> {
        self.deps.agents.subagent_view(&self.id, agent).await
    }

    /// 后台命令的输出尾窗（`v4/conversation/backgroundBashOutput`）。
    async fn background_output(
        &self,
        task: &str,
        max_bytes: u64,
    ) -> Result<Option<nibi_kernel_api::manage::BackgroundOutput>, KernelError> {
        let meta = self.ask(|reply| Request::Meta { reply }).await?;
        tasks::background_output(&self.deps, &meta.workspace, &meta.id, task, max_bytes)
            .await
            .map_err(|error| match error {
                nibi_kernel_api::env::EnvError::Unsupported { what } => {
                    KernelError::Unsupported { what }
                }
                other => KernelError::Failed {
                    message: other.to_string(),
                },
            })
    }

    /// Shell 详情：与 `background_tasks` 同一份账本与输出文件（tui-panels.md §3.3）。
    async fn shell_detail(
        &self,
        task: &str,
    ) -> Result<Option<nibi_kernel_api::panels::ShellDetail>, KernelError> {
        let meta = self.ask(|reply| Request::Meta { reply }).await?;
        Ok(tasks::shell_detail(&self.deps, &meta.workspace, &meta.id, task).await)
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "queue_tests.rs"]
mod queue_tests;

#[cfg(test)]
#[path = "machines_tests.rs"]
mod machines_tests;

#[cfg(test)]
#[path = "draft_tests.rs"]
mod draft_tests;

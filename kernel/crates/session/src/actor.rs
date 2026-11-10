//! 会话 actor 的循环：命令、主循环的提交请求、回合收尾都在这一个任务里按序处理（会话状态的
//! 唯一 owner）。回合内的逻辑见 [`crate::turn`]。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use nibi_kernel_base::Task;
use nibi_kernel_api::abort::{Abort, AbortReason};
use nibi_kernel_api::agents::AgentSignal;
use nibi_kernel_api::checkpoint::PendingCheckpoints;
use nibi_kernel_api::hooks::HookOutcome;
use nibi_kernel_api::ids::{
    CommandId, InteractionId, MessageId, OwnerEpoch, RunId, ToolUseId, TurnId,
};
use nibi_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::orchestration::{
    InteractionAnswer, InteractionRequest, OrchestrationError, QueryError, QueryStop,
};
use nibi_kernel_api::session_api::{
    Ack, Command, CommandEnvelope, Delivery, KernelEvent, QueuedInput, SessionView,
    TurnExecutionKind, TurnOutcome,
};
use nibi_kernel_api::store::{
    Fact, FactBatch, SessionLaunchTurn, SessionMeta, TurnAnchor, WorkspaceCheckpoint,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::SessionDeps;
use crate::agent_signals::AgentStream;
use crate::cron::CronStream;
use crate::log::EventLog;
use crate::notices::{Notices, next_notice};
use crate::sink::SinkRequest;
use crate::title::{TitleState, title_done};
use crate::turn::TurnInput;

pub(crate) enum Request {
    Command {
        envelope: CommandEnvelope,
        reply: oneshot::Sender<Ack>,
    },
    View {
        reply: oneshot::Sender<SessionView>,
    },
    Meta {
        reply: oneshot::Sender<SessionMeta>,
    },
    /// 常驻池的轻量事实（NIBI `session-resident-pool.ts` 的 `readResidencyFacts`）：在跑回合、排队输入、
    /// 待回答交互与后台工作。不复制历史——`View` 对长会话很贵，池每次收敛都会问。
    ResidencyFacts {
        reply: oneshot::Sender<nibi_kernel_api::residency::SessionResidencyFacts>,
    },
    RewindOptions {
        reply: oneshot::Sender<crate::rewind::Snapshot>,
    },
    /// 给定消息集合选中这一轮的 checkpoint（文件变更明细与回退预览）；空集合是全部。
    Checkpoints {
        messages: Vec<MessageId>,
        reply: oneshot::Sender<Vec<nibi_kernel_api::store::WorkspaceCheckpoint>>,
    },
    Goal {
        reply: oneshot::Sender<nibi_kernel_api::goal::GoalView>,
    },
    /// 回合外的工具授权要的会话当前状态：执行状态（权限模式 + plan 开关）与工作目录（MCP Apps 的页面调用）。
    TurnContext {
        reply: oneshot::Sender<(
            nibi_kernel_api::permission::ExecutionState,
            nibi_kernel_api::env::WorkspaceRef,
        )>,
    },
    /// 回合外的模型请求（MCP Apps 采样）要的当前模型选择。
    Selection {
        reply: oneshot::Sender<nibi_kernel_api::model::ModelSelection>,
    },
    /// 回合外模型请求（MCP Apps 采样）的用量行：与主回合的用量走同一个 `Fact::ModelCalled`
    /// （Node 在 `sample-model.ts` 的 `finally` 里写 `model_usage`）。单独一批，不产生会话消息。
    RecordUsage {
        call: Box<nibi_kernel_api::metering::ModelCall>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// 关闭会话（`SessionHandle::close`）：中止前台工作，等它收尾后回复并退出（spec §3.3）。`reason` 是中止在跑的
    /// 回合用的原因：退出是 `Shutdown`，`/clear`、`/resume` 是 `User`（修复线 F38）。
    Close {
        reply: oneshot::Sender<()>,
        reason: AbortReason,
    },
    /// 草稿的外部活动（Node `ensureSessionPersistedForExternalActivity`）：现在写会话行与初始事实。
    /// 不是草稿时立即回 `Ok`。
    Persist {
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// 会话级的询问（`Interactions::lasting`，agents.md §4.1.1）：不属于哪个回合，回合结束与中断都不取消它。
    Ask {
        request: InteractionRequest,
        reply: oneshot::Sender<Result<InteractionAnswer, OrchestrationError>>,
    },
    /// 撤回会话级的询问（工具被取消；与 `Ask` 走同一个通道，所以总排在它的 `Ask` 之后）。
    CancelAsk {
        tool_use: ToolUseId,
    },
    /// 回合外的旁路辅助补全（后台子代理的 `ReadSessionContext` lite 抽取）：与回合内的
    /// `SinkRequest::Auxiliary` 走同一个 actor 方法，只是不依赖正在跑的回合。
    Auxiliary {
        request: nibi_kernel_api::auxiliary::AuxiliaryTextRequest,
        reply: oneshot::Sender<Result<Option<String>, OrchestrationError>>,
    },
}

/// 待回答的交互属于谁：回合里的询问随回合结束取消；会话级的询问只随会话关闭取消。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AskScope {
    Turn,
    Session,
}

/// 不属于回合的后台工作（SessionStart、代码回退）的结果，回到 actor 后才提交（spec §2）。
pub(crate) enum JobDone {
    Startup(Box<nibi_kernel_api::hooks::HookOutcome>),
    Rewind(Box<crate::rewind::Finished>),
    RestoreFiles(Box<crate::rewind::FinishedFiles>),
}

pub(crate) struct Job {
    pub(crate) task: Task<JobDone>,
    /// SessionStart 可以被中断；回退事务不能中途放弃，不取消。
    pub(crate) cancel: Option<CancellationToken>,
}

/// 等待用户回答的交互：已持久化为待回答事实。
pub(crate) struct Pending {
    pub(crate) id: InteractionId,
    pub(crate) request: InteractionRequest,
    pub(crate) reply: oneshot::Sender<Result<InteractionAnswer, OrchestrationError>>,
    /// 权限询问的 Notification 计时；交互被回答或取消（丢弃）时取消。
    pub(crate) _notify: Option<tokio_util::sync::DropGuard>,
    pub(crate) scope: AskScope,
}

pub(crate) struct Running {
    pub(crate) turn: TurnId,
    /// 这次运行（主循环的回合）；压缩没有（它的子循环自己取）。会话标题的请求用它（工作线 F64）。
    pub(crate) run: Option<RunId>,
    pub(crate) abort: Abort,
    pub(crate) requests: mpsc::Receiver<SinkRequest>,
    pub(crate) task: Task<Result<QueryStop, QueryError>>,
    /// 提交失败的原因；有值时本回合以失败收尾，之后的提交一律拒绝。
    pub(crate) failure: Option<String>,
    /// 开启本回合的 user 消息：checkpoint 的 `messageId`（spec §4.2）。
    pub(crate) prompt: Option<MessageId>,
    /// 开启本回合的命令；提交 `prompt` 时写进批次（Node `anchor.sourceCommandId`）。
    pub(crate) command: Option<CommandId>,
    /// 这一轮输入携带的固定事实（`sendText` 的 automationId / botDeliveryTarget）。
    pub(crate) turn_facts: nibi_kernel_api::automation::TurnFacts,
}

enum Next {
    Request(Request),
    Sink(Option<SinkRequest>),
    Notice(nibi_kernel_api::machine_notices::MachineNotice),
    Agent(AgentSignal),
    Cron,
    Job(Result<JobDone, nibi_kernel_base::TaskError>),
    Title(crate::title::TitleDone),
    Name(Result<Option<String>, nibi_kernel_base::TaskError>),
    /// 一次旁路辅助补全结束（auxiliary.rs）：第几个任务与它的结果。
    Aux(
        usize,
        Result<Result<String, nibi_kernel_api::model::ModelError>, nibi_kernel_base::TaskError>,
    ),
    /// 跨会话的入站（消息或回执，cross-session.md §2.4）。
    Peer(nibi_kernel_api::peers::PeerSignal),
    /// 扣住的消息里最早的到期时刻到了（醒来后按时钟判断）。
    PeerDeadline,
    /// Monitor 的输出事件与截止时刻（工作线 F83，monitors.rs）。
    Monitor(
        nibi_kernel_api::ids::ShellTaskId,
        Result<nibi_kernel_api::env::CommandEvent, nibi_kernel_api::env::EnvError>,
    ),
    MonitorDue,
}

/// 正在运行的回合的提交请求；没有回合时一直等。
async fn sink_request(running: &mut Option<Running>) -> Option<SinkRequest> {
    match running {
        Some(running) => running.requests.recv().await,
        None => std::future::pending().await,
    }
}

/// 后台工作的结果；没有时一直等。
async fn job_done(job: &mut Option<Job>) -> Result<JobDone, nibi_kernel_base::TaskError> {
    match job {
        Some(job) => (&mut job.task).await,
        None => std::future::pending().await,
    }
}

pub(crate) struct Actor {
    pub(crate) deps: SessionDeps,
    pub(crate) log: Arc<EventLog>,
    pub(crate) meta: SessionMeta,
    pub(crate) messages: Vec<Message>,
    /// 冷读取时只供显示的、最后一个压缩点之前的消息（工作线 F102，compact.md §5.1）：打开后不变，只进 `view()`。
    /// 模型侧的一切（主循环、压缩、token、标题、rewind、fork、goal 与任务的恢复）只看 `messages`。
    pub(crate) earlier: Vec<Message>,
    pub(crate) selection: ModelSelection,
    /// 执行状态：权限模式 × plan 开关（修复线 F20，shell-permissions.md §4.6）。判决用的模式是 [`Self::mode`]。
    pub(crate) execution: nibi_kernel_api::permission::ExecutionState,
    /// 计划模式的两个会话标志（已退出计划模式、待发退出提示）：与 `mode` 同一个
    /// owner，改模式时更新，提交 reentry / exit 时清掉；不持久化（context.md §13.4）。
    pub(crate) plan_flags: nibi_kernel_api::plan::PlanModeFlags,
    pub(crate) queue: VecDeque<QueuedInput>,
    /// next 通道：插话输入与两种后台通知的到达顺序（优先级 `next`，lane.rs）。
    pub(crate) lane: VecDeque<crate::lane::Lane>,
    /// 已从任务表取走、还没开回合的定时任务（排在通道与 `Queue` 输入之后）。
    pub(crate) cron_fires: VecDeque<nibi_kernel_api::cron::CronFire>,
    pub(crate) pending: Vec<Pending>,
    pub(crate) running: Option<Running>,
    pub(crate) job: Option<Job>,
    /// 没有被代码回退撤销的 checkpoint，按写入顺序（spec §4）。
    pub(crate) checkpoints: Vec<WorkspaceCheckpoint>,
    /// 工具已结束、结果还没提交的 checkpoint（`ToolFinished` 的 display）。
    pub(crate) unsettled: PendingCheckpoints,
    /// 工具已结束、结果还没提交的子代理关联（Agent 工具的 display，checkpoints.rs）。
    pub(crate) links: HashMap<ToolUseId, Fact>,
    /// 并入点跑过 UPS 而留下的插话（只在回合结束后取）与记下的结果（steering.rs）。
    pub(crate) screened: HashMap<CommandId, Option<Box<HookOutcome>>>,
    /// 排队输入里的 bash 模式命令与带内容块的输入（bash.rs，tui-input.md §2.2、§3.2）。
    pub(crate) queued_kinds: HashMap<CommandId, crate::bash::QueuedKind>,
    /// 自动排空（NIBI `setAutoDrain`）：关掉时回合结束后不自动开队首；通知与定时任务照常。
    pub(crate) auto_drain: bool,
    /// 被 `sendQueuedNow` 提升的输入：抢占当前回合后由 [`Actor::start_next`] 先开它。
    pub(crate) promote: Option<(QueuedInput, Option<crate::bash::QueuedKind>)>,
    /// 历史被改写的次数（`HistoryRewritten.generation`）。
    pub(crate) generation: u64,
    /// 会话标题的生成（title.rs）与不带参数的 `/rename` 的起名任务（rename.rs）。
    pub(crate) titles: TitleState,
    /// `/loop` 哨兵展开的状态（loop_tick.rs）：不持久化，主线程压缩后清空。
    pub(crate) loop_ticks: crate::loop_tick::LoopTicks,
    pub(crate) naming: Option<crate::rename::NameJob>,
    /// 在跑的旁路辅助模型调用（`ReadSessionContext` 的 lite 抽取，auxiliary.rs）：可以同时有多个
    /// （只读工具并发安全）。
    pub(crate) aux_jobs: Vec<crate::auxiliary::AuxJob>,
    /// `/goal` 的目标（goal.rs）：提交 `goal_status` 后才改，冷加载从活动历史恢复。
    pub(crate) goal: crate::goal::Goals,
    /// 回合或压缩在跑时到达的本地命令记录（修复线 L-A，local_record.rs）：收尾后按到达顺序提交。
    pub(crate) held_records: Vec<nibi_kernel_api::user_command::LocalCommandRecord>,
    /// 回合在跑时到达的工作流控制轮（NIBI 中枢/「配置」，launch.md「The settings turn」）：
    /// 收尾后按到达顺序落（与 Node 的 runtime 命令队列同一条时机——先于新 run 的通知）。
    pub(crate) pending_launch: VecDeque<LaunchTurn>,
    /// 已落的工作流控制轮（冷加载的 `LoadedSession.launches` + 本进程落的）：`view()` 带给冷投影
    /// （`Message::User` 不带消息元数据，冷投影靠这份清单认 controlOnly 轮）。
    pub(crate) launches: Vec<SessionLaunchTurn>,
    /// 每轮输入的模型选择（冷加载的 `LoadedSession.model_turns` + 本进程提交的用户输入）：
    /// `view()` 带给冷投影补模型切换分隔线。锁不跨 await（与 `turn` 同一写法）。
    pub(crate) model_turns: std::sync::Mutex<Vec<nibi_kernel_api::store::SessionModelTurn>>,
    /// 每条真人输入的规范意图（冷加载的 `LoadedSession.input_intents` + 本进程落的）：`view()` 带给
    /// 冷投影恢复行上原文、机器人来源与引用。
    pub(crate) input_intents: Vec<(nibi_kernel_api::ids::MessageId, serde_json::Value)>,
    /// 已经收到、还没落进消息的意图（[`Command::RecordInputIntent`]，键是输入的命令 id）。
    /// 协议层在 `Submit` 之前发；消息落库时按开启本回合的命令取走。
    pub(crate) pending_intents: HashMap<CommandId, serde_json::Value>,
    /// 已经收到、还没开回合的轮次事实（[`Command::SetTurnFacts`]，键是输入的命令 id）。排队输入
    /// 升格为回合时才取走；不写会话级配置（绑定会话里的用户轮仍然可以改任务）。
    pub(crate) pending_turn_facts: HashMap<CommandId, nibi_kernel_api::automation::TurnFacts>,
    seen: HashSet<CommandId>,
    /// 草稿（NIBI legacy `session/create` 的 `persistence: "deferred"`）：还没有会话行。期间的提交只改
    /// 内存；第一条用户输入（[`opens_turn`]）提交时 [`Self::promote`] 写会话行与初始事实，之后照常落库。
    /// 与 [`crate::Session`] 共用同一个旗标（列表投影读它）。
    draft: Arc<AtomicBool>,
    /// 草稿期间用户改过的项目权限模式（`Fact::ProjectModeSet`）：提升会话时与初始事实一起提交，
    /// 否则这次切换会随着草稿一起丢掉。
    pending_project_mode: std::sync::Mutex<Option<nibi_kernel_api::permission::PermissionMode>>,
    /// 当前轮（开启它的真实用户输入与轮次 ID）：随每个批次交给存储（node-store.md §4，修复线 F6）；冷加载时取
    /// `LoadedSession.turn`。只在 `commit` 里改，锁不跨 await。
    turn: std::sync::Mutex<Option<TurnAnchor>>,
    /// 续写时补在内存里、还没落库的消息，按历史里的顺序：末尾未结调用的中断结果（session-lifecycle.md §6.3，工作线
    /// F81）与 `No response requested.`（§6.3.1，工作线 F77）。第一批带消息的提交把它们排在最前面，成功后清掉；
    /// `StoreResumeSentinel` 把它们单独提交（F79）。只在 `commit` 与 `store_resume_sentinel` 里改，锁不跨 await。
    resume_pending: std::sync::Mutex<Vec<MessageId>>,
    /// 正在关闭：前台工作收尾后回复它并退出循环；期间不开新回合、不接新命令（spec §3.3）。
    pub(crate) closing: Option<oneshot::Sender<()>>,
    /// 收到了 `Shutdown`（进程要退出，修复线 F38，spec §3.5）：之后不再开回合。
    pub(crate) shutting_down: bool,
    stream: Notices,
    agent_stream: AgentStream,
    cron_stream: CronStream,
    /// 跨会话的入站流与状态（peers.rs）。
    peer_stream: crate::watched::Watched<nibi_kernel_api::peers::PeerSignal>,
    pub(crate) peers: crate::peers::PeerState,
    /// Monitor 的切行、批、限流与终态的合成（工作线 F83，monitors.rs）：只在 actor 里。
    pub(crate) monitors: crate::monitors::Monitors,
    /// 最近一个完成的主回合请求的输出速度（footer 的 TPS，修复线 F105）：只在内存，冷打开时为空。
    pub(crate) output_speed: Option<nibi_kernel_api::metering::OutputSpeed>,
    /// 自己的请求通道（弱引用）：交给回合的输出端，给出会话级的询问入口；不让 actor 因此不退出。
    asks: mpsc::WeakSender<Request>,
}

pub(crate) fn rejected(reason: impl Into<String>) -> Ack {
    Ack::Rejected {
        reason: reason.into(),
    }
}

pub(crate) fn accepted() -> Ack {
    Ack::Accepted {
        result: serde_json::Value::Null,
    }
}

/// 这一批事实会不会开一个真正的用户回合（Node 草稿提升的判据：首条输入，不是 hook 附件或后台元消息）。
fn promotes(facts: &[Fact]) -> bool {
    facts.iter().any(|fact| match fact {
        Fact::MessageAppended {
            message: Message::User(user),
        } => nibi_kernel_api::user_input::opens_turn(user),
        _ => false,
    })
}

/// 排队中的工作流控制轮（[`Command::WorkflowLaunch`]）：忙时先攒着，回合收尾按到达顺序落。
pub(crate) struct LaunchTurn {
    pub(crate) command: CommandId,
    pub(crate) text: String,
    pub(crate) launch: serde_json::Value,
}

impl Actor {
    /// `resume_pending`：续写时补在内存里的消息（`resume::settle` 的中断结果与 `resume_sentinel::insert` 的占位，按
    /// 历史里的顺序），随第一批带消息的提交落库。
    pub(crate) fn new(
        deps: SessionDeps,
        log: Arc<EventLog>,
        state: crate::SessionState,
        asks: mpsc::WeakSender<Request>,
        resume_pending: Vec<MessageId>,
        draft: Arc<AtomicBool>,
    ) -> Self {
        // 本机与连上的远端机器的通知（R3，remote-exec.md §20.7.2）。
        let stream = Notices::new(nibi_kernel_api::machine_notices::all_shell_notices(
            deps.machines.clone(),
            state.meta.id.clone(),
        ));
        let agent_stream = AgentStream::new(deps.agents.signals(&state.meta.id));
        let cron_stream = CronStream::new(deps.cron.wakeups(&state.meta.id));
        let peer_stream = crate::watched::Watched::new(deps.peers.port.signals(&state.meta.id));
        let start = state.start;
        let goal = crate::goal::Goals::restore(&state.messages, deps.clock.now_ms());
        let mut actor = Self {
            deps,
            log,
            meta: state.meta,
            messages: state.messages,
            earlier: state.earlier,
            selection: state.selection,
            execution: state.mode,
            plan_flags: Default::default(),
            queue: VecDeque::new(),
            lane: VecDeque::new(),
            cron_fires: VecDeque::new(),
            pending: Vec::new(),
            running: None,
            job: None,
            checkpoints: state.checkpoints,
            unsettled: PendingCheckpoints::default(),
            links: HashMap::new(),
            screened: HashMap::new(),
            queued_kinds: HashMap::new(),
            auto_drain: true,
            promote: None,
            generation: 0,
            titles: TitleState::default(),
            loop_ticks: Default::default(),
            naming: None,
            aux_jobs: Vec::new(),
            goal,
            held_records: Vec::new(),
            pending_launch: VecDeque::new(),
            launches: state.launches,
            model_turns: std::sync::Mutex::new(state.model_turns),
            input_intents: state.input_intents,
            pending_intents: HashMap::new(),
            pending_turn_facts: HashMap::new(),
            seen: HashSet::new(),
            draft,
            pending_project_mode: std::sync::Mutex::new(None),
            turn: std::sync::Mutex::new(state.turn),
            resume_pending: std::sync::Mutex::new(resume_pending),
            closing: None,
            shutting_down: false,
            stream,
            agent_stream,
            cron_stream,
            peer_stream,
            peers: crate::peers::PeerState::default(),
            monitors: crate::monitors::Monitors::default(),
            output_speed: None,
            asks,
        };
        actor.start_session(start);
        actor
    }

    /// 回合（或命令、压缩）的输出端：请求经 `sender` 交给 actor；会话级的询问入口经自己的请求通道。
    pub(crate) fn sink(&self, sender: mpsc::Sender<SinkRequest>) -> crate::sink::ActorSink {
        crate::sink::ActorSink {
            sender,
            asks: self.asks.clone(),
            session: self.meta.id.clone(),
            detached: self.deps.detached.clone(),
        }
    }

    /// 有回合或后台工作在跑：新输入排队，回退 / fork 拒绝。
    pub(crate) fn busy(&self) -> bool {
        self.running.is_some() || self.job.is_some()
    }

    pub(crate) async fn run(mut self, mut requests: mpsc::Receiver<Request>) {
        // 跨会话：绑定为主会话并从库里恢复（cross-session.md §2.2）；在处理第一条命令之前。
        self.peers_open().await;
        // 提醒钟的忙闲沿（上一次的 busy 值；None = 循环还没算过）：变化时才调（transcript-and-
        // notifications.md「Reminding an idle main agent」——一轮开始钟停，队列排空起算空闲）。
        let mut last_busy: Option<bool> = None;
        loop {
            // 修复（R1-1）：以前这里在“所有句柄都已释放”（`recv` 返回 None）时退出，但内核的会话表一直持有
            // 句柄，这个分支永远到不了——关闭后 actor 还活着，收到后台通知就自己开回合。现在由 `Request::Close`
            // 显式关闭：前台工作收尾后在这里退出。句柄只在会话表释放作用域之后才会全部释放，那时 actor 已被中止，
            // 所以 `recv` 的 None 不需要分支（`Some` 模式不匹配时 select! 只是停用这一支）。
            if !self.busy()
                && let Some(reply) = self.closing.take()
            {
                self.peers_close().await;
                let _ = reply.send(());
                return;
            }
            let now_ms = self.deps.clock.now_ms();
            let monitor_due = self.monitors.next_deadline();
            let next = tokio::select! {
                Some(request) = requests.recv() => Next::Request(request),
                request = sink_request(&mut self.running) => Next::Sink(request),
                notice = next_notice(&mut self.stream) => Next::Notice(notice),
                signal = self.agent_stream.next() => Next::Agent(signal),
                () = self.cron_stream.next() => Next::Cron,
                done = job_done(&mut self.job) => Next::Job(done),
                done = title_done(&mut self.titles) => Next::Title(done),
                done = crate::rename::name_done(&mut self.naming) => Next::Name(done),
                done = crate::auxiliary::aux_done(&mut self.aux_jobs) => Next::Aux(done.0, done.1),
                signal = self.peer_stream.next() => Next::Peer(signal),
                () = crate::peers::deadline(&self.peers, now_ms) => Next::PeerDeadline,
                (task, event) = crate::monitors::next_event(&mut self.monitors) => Next::Monitor(task, event),
                () = crate::monitors::deadline(monitor_due, now_ms) => Next::MonitorDue,
            };
            match next {
                Next::Request(request) => self.handle(request).await,
                Next::Sink(Some(request)) => self.on_sink(request).await,
                Next::Notice(notice) => self.on_notice(notice).await,
                Next::Agent(signal) => self.on_agent_signal(signal).await,
                Next::Cron => self.on_cron_wakeup().await,
                Next::Job(done) => self.on_job(done).await,
                Next::Title(done) => self.on_title(done).await,
                Next::Name(result) => self.on_name(result).await,
                Next::Aux(index, result) => self.on_aux(index, result),
                Next::Peer(signal) => self.on_peer_signal(signal).await,
                Next::PeerDeadline => self.peers_expire(true).await,
                Next::Monitor(task, event) => self.on_monitor_event(task, event).await,
                Next::MonitorDue => self.on_monitor_due().await,
                // 主循环的输出端已全部释放：它已经返回，收尾本回合。
                Next::Sink(None) => self.finish_turn().await,
            }
            // 登记里的 busy / idle 只看 actor 自己的状态，变化时才写（cross-session.md §2.1）。
            let busy_now = self.busy();
            let status = if busy_now {
                nibi_kernel_api::peers::PeerStatus::Busy
            } else {
                nibi_kernel_api::peers::PeerStatus::Idle
            };
            self.peer_status(status).await;
            // 提醒钟的忙闲沿跟着同一条裁决走（变化时才调；已在段里时钟自己 no-op）。
            if last_busy != Some(busy_now) {
                if let Some(blocked) = &self.deps.blocked {
                    if busy_now {
                        blocked.session_busy(&self.meta.id);
                    } else {
                        blocked.session_idle(&self.meta.id);
                    }
                }
                last_busy = Some(busy_now);
            }
        }
    }

    /// 关闭（spec §3.3，`/clear`、`/resume` 的前台任务处理）：中止在跑的回合与可取消的后台工作，取消待回答的
    /// 交互；排队的输入与通知不再开回合（通知没有 ack，留在执行环境与 agents 里，会话再打开时送达）。
    async fn close(&mut self, reply: oneshot::Sender<()>, reason: AbortReason) {
        tracing::info!(event = "session.closing", session = %self.meta.id, busy = self.busy(), "session closing");
        self.closing = Some(reply);
        // 提醒钟随会话关（此后不再排钟、不再发）。
        if let Some(blocked) = &self.deps.blocked {
            blocked.session_closed(&self.meta.id);
        }
        // `/clear`、`/resume`（用户中止）之后旧会话的后台子代理照样询问（agents.md §4.1.2，工作线 F72）：先登记这个会话
        // 与它的标题，下面取消的会话级询问与之后的询问都转到进程级的入口。退出程序时不登记。
        if reason == AbortReason::User
            && let Some(detached) = &self.deps.detached
        {
            detached.closed(&self.meta.id, &self.meta.title);
        }
        if let Some(running) = &self.running {
            running.abort.abort(reason);
        }
        if let Some(cancel) = self.job.as_ref().and_then(|job| job.cancel.as_ref()) {
            cancel.cancel();
        }
        self.cancel_pending().await;
    }

    async fn handle(&mut self, request: Request) {
        match request {
            Request::View { reply } => {
                let _ = reply.send(self.view().await);
            }
            Request::Meta { reply } => {
                let _ = reply.send(self.meta.clone());
            }
            Request::ResidencyFacts { reply } => {
                // 后台命令与后台子代理的事实不在 actor 状态里（执行环境的账本与 agents），
                // 与 `view()` 同一条读取路径；其余取 actor 自己的队列与计数。
                let background_shells = self.background().await.len();
                let background_subagents = self.background_agents().await.len();
                let queued_commands = self.queue.len()
                    + self.lane.len()
                    + self.cron_fires.len()
                    + usize::from(self.promote.is_some());
                let _ = reply.send(nibi_kernel_api::residency::SessionResidencyFacts {
                    // `job` 是回合级的后台工作（SessionStart、代码回退）：没结束前不算空闲。
                    running: self.running.is_some() || self.job.is_some(),
                    queued_commands,
                    pending_interactions: self.pending.len(),
                    background_shells,
                    background_subagents,
                    created_at_ms: self.meta.created_at_ms,
                });
            }
            Request::RewindOptions { reply } => {
                let _ = reply.send(self.rewind_snapshot());
            }
            Request::Checkpoints { messages, reply } => {
                let selected = crate::file_changes::select(&self.checkpoints, &messages)
                    .into_iter()
                    .cloned()
                    .collect();
                let _ = reply.send(selected);
            }
            Request::Goal { reply } => {
                let _ = reply.send(self.goal_view());
            }
            Request::TurnContext { reply } => {
                let _ = reply.send((self.execution, self.meta.workspace.clone()));
            }
            Request::Selection { reply } => {
                let _ = reply.send(self.selection.clone());
            }
            Request::Auxiliary { request, reply } => self.auxiliary(request, reply),
            Request::RecordUsage { call, reply } => {
                // 用量是观测：写不进去只记日志，不影响这次采样（Node 的 `recordModelUsageFact` 同）。
                let result = self
                    .commit(None, vec![Fact::ModelCalled { call: *call }])
                    .await;
                let _ = reply.send(result);
            }
            // 草稿提升：关闭中不写会话行（草稿随关闭一起消失），其余情况立即落库。
            Request::Persist { reply } => {
                let result = if self.closing.is_some() || self.shutting_down {
                    Err("the session is closing".to_owned())
                } else if self.draft.load(Ordering::SeqCst) {
                    self.promote().await
                } else {
                    Ok(())
                };
                let _ = reply.send(result);
            }
            Request::Close { reply, reason } => self.close(reply, reason).await,
            // 关闭中、要退出时不再登记询问：丢下回复，询问方按会话已关闭处理。
            Request::Ask { reply, .. } if self.closing.is_some() || self.shutting_down => {
                drop(reply);
            }
            Request::Ask { request, reply } => self.ask(request, reply, AskScope::Session).await,
            Request::CancelAsk { tool_use } => self.cancel_ask(&tool_use).await,
            // 关闭中不接新命令：会话即将退出。
            Request::Command { reply, .. } if self.closing.is_some() => {
                let _ = reply.send(rejected("the session is closed"));
            }
            Request::Command { envelope, reply } => {
                if !self.seen.insert(envelope.id.clone()) {
                    let _ = reply.send(Ack::Duplicate);
                    return;
                }
                // 代码回退的回执要等事务结束（spec §5.1），起名的回执要等名字（titles.md §8.2）。
                match envelope.command {
                    Command::Rewind { target, scope } => {
                        return self.rewind(envelope.id, target, scope, reply).await;
                    }
                    Command::RestoreFiles { messages, turn } => {
                        return self.restore_files(envelope.id, messages, turn, reply).await;
                    }
                    Command::GenerateName => return self.generate_name(envelope.id, reply),
                    _ => {}
                }
                let ack = self.command(envelope).await;
                let _ = reply.send(ack);
                // 队列命令可能让会话停在"空闲 + 有排队项"：自动排空开着就把它开起来
                // （`setAutoDrain(true)` 与回合收尾擦肩而过时的兜底）。
                if self.auto_drain {
                    self.settle_queue().await;
                }
            }
        }
    }

    /// 空闲、自动排空开着、队列或通道里有输入：开队首。只在这条命令处理完之后看一眼，
    /// 不在回合进行中抢跑。
    async fn settle_queue(&mut self) {
        if self.busy() {
            return;
        }
        let pending = !self.queue.is_empty()
            || !self.pending_launch.is_empty()
            || self
                .lane
                .iter()
                .any(|lane| matches!(lane, crate::lane::Lane::Input(_)));
        if pending {
            self.start_next().await;
        }
    }

    /// 工作流控制轮（NIBI 中枢与「配置」的 controlOnly 记录，launch.md「The settings turn」）：
    /// 忙时排队，空闲时立即落。落库失败整个拒绝（调用方决定重试与否）；内存与事件只在提交成功后动。
    async fn workflow_launch(
        &mut self,
        id: CommandId,
        text: String,
        launch: serde_json::Value,
    ) -> Ack {
        if self.busy() {
            self.pending_launch.push_back(LaunchTurn {
                command: id,
                text,
                launch,
            });
            return accepted();
        }
        match self.write_launch(id, text, launch).await {
            Ok(()) => accepted(),
            Err(reason) => rejected(reason),
        }
    }

    /// 落一条控制轮：合成 user 消息（Node `persistWorkflowLaunchUserMessage` 的形状）+
    /// 完整的轮边界（`TurnStarted` / `TurnFinished`），不开模型回合。文本进 `messages`
    /// （模型下一回合照常读它）；存储按 `WorkflowLaunchMessage` 写（node-store 的
    /// `append_launch`，`source: "workflow_launch"` + `metadata.workflowLaunch`）。
    pub(crate) async fn write_launch(
        &mut self,
        command: CommandId,
        text: String,
        launch: serde_json::Value,
    ) -> Result<(), String> {
        let message = Message::User(UserMessage {
            id: self.deps.ids.message(),
            content: vec![ContentBlock::Text { text: text.clone() }],
            origin: UserOrigin::Human,
        });
        let turn = self.deps.ids.turn();
        self.commit(
            Some(command.clone()),
            vec![Fact::WorkflowLaunchMessage {
                id: message.id().clone(),
                text,
                launch: launch.clone(),
            }],
        )
        .await?;
        // 控制轮的完整轮边界（Node `emitControlOnlyUserTurn` 同形）：executionKind=controlOnly +
        // workflowLaunch 元数据（活投影的轮头行与 userInput 行靠它画启动卡），不开模型回合。
        self.log.append(KernelEvent::TurnStarted {
            turn: turn.clone(),
            command: Some(command),
            execution_kind: Some(TurnExecutionKind::ControlOnly),
            workflow_launch: Some(launch.clone()),
            input_source: None,
            origin_meta: None,
        });
        self.log.append(KernelEvent::MessageDone {
            message: message.clone(),
        });
        self.launches.push(SessionLaunchTurn {
            message: message.id().clone(),
            launch,
        });
        self.messages.push(message);
        self.log.append(KernelEvent::TurnFinished {
            turn,
            outcome: TurnOutcome::Success,
            usage: None,
        });
        Ok(())
    }

    async fn command(&mut self, envelope: CommandEnvelope) -> Ack {
        let CommandEnvelope { id, command } = envelope;
        match command {
            Command::Submit { text, delivery, .. } => {
                if self.busy() {
                    // 插话（Steer）进 next 通道，由主循环在下一个工具边界领取（steering.rs），其余等回合结束。
                    if delivery == Delivery::Steer {
                        self.lane.push_back(crate::lane::Lane::Input(id.clone()));
                    }
                    self.queue.push_back(QueuedInput {
                        command: id,
                        text,
                        delivery,
                    });
                    self.emit_queue();
                    return accepted();
                }
                match self
                    .start_turn(TurnInput::Human {
                        command: id,
                        text,
                        screened: None,
                        more: Vec::new(),
                    })
                    .await
                {
                    Ok(()) => accepted(),
                    Err(reason) => rejected(reason),
                }
            }
            Command::RecordInputIntent { command, intent } => {
                // 只记在输入的命令上；消息落库时（`record_with`）按开启本回合的命令取走。
                self.pending_intents.insert(command, intent);
                accepted()
            }
            Command::SetTurnFacts { command, facts } => {
                // 与意图一样只在输入的命令上；开这一轮时取走，排队输入等升格时再取。
                self.pending_turn_facts.insert(command, facts);
                accepted()
            }
            Command::Interrupt => self.interrupt().await,
            Command::Shutdown => self.shutdown().await,
            Command::RestoreCancelled => self.restore_cancelled(id).await,
            Command::ResolveInteraction {
                interaction,
                answer,
            } => self.resolve(id, interaction, answer).await,
            Command::SetModel { selection } => {
                let fact = Fact::ModelSelected {
                    selection: selection.clone(),
                };
                if let Err(reason) = self.commit(Some(id), vec![fact]).await {
                    return rejected(reason);
                }
                self.selection = selection.clone();
                self.log.append(KernelEvent::ModelChanged { selection });
                // F27：有效窗口随模型变，上下文提示与 footer 的 ctx 按新模型重算（按当前模型算）；修前要等下一条回复。
                self.context_changed();
                accepted()
            }
            Command::SetMode { mode } => match self.user_mode(id, mode).await {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            },
            Command::SetPlan { enabled } => match self.user_plan(id, enabled).await {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            },
            Command::Compact { instructions } => match self.start_compaction(id, instructions) {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            },
            Command::Fork { at } => self.fork(id, at).await,
            Command::ForkFromInput { input } => self.fork_from_input(input).await,
            Command::Rename { title } => self.rename(id, title).await,
            Command::StopTask { task } => self.stop_task(task).await,
            Command::ResolvePeerMessage { message, approve } => {
                match self.resolve_peer(&message, approve).await {
                    Ok(()) => accepted(),
                    Err(reason) => rejected(reason),
                }
            }
            Command::SetWorkspace { root, note } => self.set_workspace(id, root, note).await,
            Command::ChangeDirectory { root } => self.change_directory(id, root, None).await,
            Command::ChangeDirectoryRecorded { root, record } => {
                self.change_directory(id, root, Some(record)).await
            }
            Command::RecordLocalCommand { record } => self.record_local_command(id, record).await,
            Command::BackgroundForeground { reason } => self.background_foreground(reason).await,
            Command::StoreResumeSentinel => self.store_resume_sentinel(id).await,
            // 在 `handle` 里处理（回执要等事务结束或名字）。
            Command::Rewind { .. } | Command::RestoreFiles { .. } | Command::GenerateName => {
                rejected("this command is handled by the actor loop")
            }
            Command::Bash {
                command: line,
                delivery: _,
            } => {
                self.bash_command(id, line);
                accepted()
            }
            Command::SubmitContent {
                content,
                delivery: _,
            } => match self.content_command(id, content).await {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            },
            Command::EditQueued { item, text } => self.edit_queued(item, text),
            Command::DeleteQueued { item } => self.delete_queued(item),
            Command::ReorderQueued { item, before } => self.reorder_queued(item, before),
            Command::SetAutoDrain { enabled } => self.set_auto_drain(enabled).await,
            Command::SendQueuedNow { item } => self.send_queued_now(item).await,
            Command::SetGoalPaused { paused } => self.set_goal_paused(paused).await,
            Command::CreateSelectionSideSession { selection } => {
                self.create_selection_side_session(selection).await
            }
            Command::WorkflowLaunch { text, launch } => {
                self.workflow_launch(id, text, launch).await
            }
        }
    }

    pub(crate) async fn commit(
        &self,
        command: Option<CommandId>,
        facts: Vec<Fact>,
    ) -> Result<(), String> {
        // 性能修复（修复线 F6，审查 R5-3）：当前轮由 actor 给出，存储不再为 assistant 与每个用量行各从库里推导一次
        // （那条查询要倒着扫本提示的全部消息）。批次里有新的人类输入时这里换轮次，提交成功后才记下。
        let current = self.turn_anchor();
        let turn = TurnAnchor::after(current.as_ref(), &facts, || self.deps.ids.turn());
        let pending = self.pending_resume(&facts);
        let stored_pending = !pending.is_empty();
        let facts: Vec<Fact> = pending.into_iter().chain(facts).collect();
        // 这一批新落库的用户输入带着提交时刻的选择（Node 消息记录的 `modelSelection`）：
        // 冷投影靠它重建模型切换分隔线。
        let recorded: Vec<MessageId> = facts
            .iter()
            .filter_map(|fact| match fact {
                Fact::MessageAppended {
                    message: Message::User(user),
                } => Some(user.id.clone()),
                _ => None,
            })
            .collect();
        if self.draft.load(Ordering::SeqCst) {
            if !promotes(&facts) {
                // 草稿期间的状态变更（切模型、切模式、hook 消息）只在内存里；会话行等第一条用户输入。
                self.remember_draft(&facts);
                return Ok(());
            }
            self.promote().await?;
        }
        let batch = FactBatch {
            owner_epoch: OwnerEpoch::LOCAL,
            command,
            facts,
            turn: turn.clone(),
        };
        self.deps
            .store
            .commit(&self.meta.id, batch)
            .await
            .map_err(|error| error.to_string())?;
        *self
            .turn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = turn;
        if !recorded.is_empty() {
            let mut turns = self
                .model_turns
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            turns.extend(recorded.into_iter().map(|message| {
                nibi_kernel_api::store::SessionModelTurn {
                    message,
                    selection: self.selection.clone(),
                    started_at_ms: None,
                    ended_at_ms: None,
                    active_ms: None,
                }
            }));
        }
        if stored_pending {
            self.resume_pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
        }
        Ok(())
    }

    /// 草稿的第一次真实用户输入：补写会话行、当前选择/模式与草稿期间已经产生的消息（SessionStart hook
    /// 的附件等）。之后 `self.draft` 为 false，提交走正常路径。
    async fn promote(&self) -> Result<(), String> {
        self.deps
            .store
            .create(self.meta.clone())
            .await
            .map_err(|error| error.to_string())?;
        // 行已经存在；即使下面的初始事实写失败也不再当作草稿（否则下一次提交会重复建行）。
        self.draft.store(false, Ordering::SeqCst);
        let mut facts = vec![
            Fact::ModelSelected {
                selection: self.selection.clone(),
            },
            Fact::ExecutionChanged {
                state: self.execution,
            },
        ];
        if let Some(mode) = self
            .pending_project_mode
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            facts.push(Fact::ProjectModeSet { mode });
        }
        facts.extend(
            self.messages
                .iter()
                .cloned()
                .map(|message| Fact::MessageAppended { message }),
        );
        let batch = FactBatch {
            owner_epoch: OwnerEpoch::LOCAL,
            command: None,
            facts,
            turn: None,
        };
        self.deps
            .store
            .commit(&self.meta.id, batch)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// 草稿期间不落库、但提升时必须补上的一小类事实：项目层的权限模式（`user_mode` 的 `save`）。
    fn remember_draft(&self, facts: &[Fact]) {
        let mode = facts.iter().rev().find_map(|fact| match fact {
            Fact::ProjectModeSet { mode } => Some(*mode),
            _ => None,
        });
        if let Some(mode) = mode {
            *self
                .pending_project_mode
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(mode);
        }
    }

    /// 续写时补的消息还没落库、这一批有消息：返回它们，按历史里的顺序排在这一批最前面（工作线 F77、F81，
    /// session-lifecycle.md §6.3、§6.3.1）。已不在活动历史里（被回退掉）的丢掉。
    fn pending_resume(&self, facts: &[Fact]) -> Vec<Fact> {
        if !facts
            .iter()
            .any(|fact| matches!(fact, Fact::MessageAppended { .. }))
        {
            return Vec::new();
        }
        let mut pending = self
            .resume_pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let found: Vec<Fact> = pending
            .iter()
            .filter_map(|id| self.messages.iter().find(|message| message.id() == id))
            .map(|message| Fact::MessageAppended {
                message: message.clone(),
            })
            .collect();
        if found.is_empty() {
            pending.clear();
        }
        found
    }

    /// 会话里切到这个会话（`/resume`、`/fork`）之后：续写时补在内存里、还没落库的消息（末尾未结调用的中断结果与
    /// `No response requested.`）马上单独提交一批（工作线 F79、F81，session-lifecycle.md §6.3、§6.3.1）。没有要写的时候
    /// 什么都不做；提交失败时放回去，随下一批带消息的提交写。
    async fn store_resume_sentinel(&self, id: CommandId) -> Ack {
        // 先取下再提交：`commit` 看到这一批有消息时不会再把它们排进来一次。
        let pending = std::mem::take(
            &mut *self
                .resume_pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        // 已不在活动历史里（被回退掉）的丢掉，同 `pending_resume`。
        let facts: Vec<Fact> = pending
            .iter()
            .filter_map(|wanted| self.messages.iter().find(|message| message.id() == wanted))
            .map(|message| Fact::MessageAppended {
                message: message.clone(),
            })
            .collect();
        if facts.is_empty() {
            return accepted();
        }
        match self.commit(Some(id), facts).await {
            Ok(()) => accepted(),
            Err(reason) => {
                *self
                    .resume_pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = pending;
                rejected(reason)
            }
        }
    }

    /// 提交一批锚在给定回合的事实，不改当前轮：起任务时记下回合、结果晚到的旁路请求用（会话标题的用量行，
    /// usage.md §2.1.1，工作线 F73）。
    pub(crate) async fn commit_in_turn(
        &self,
        turn: Option<TurnAnchor>,
        facts: Vec<Fact>,
    ) -> Result<(), String> {
        let batch = FactBatch {
            owner_epoch: OwnerEpoch::LOCAL,
            command: None,
            facts,
            turn,
        };
        self.deps
            .store
            .commit(&self.meta.id, batch)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn turn_anchor(&self) -> Option<TurnAnchor> {
        self.turn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    async fn on_job(&mut self, done: Result<JobDone, nibi_kernel_base::TaskError>) {
        self.job = None;
        match done {
            Ok(JobDone::Startup(outcome)) => self.finish_startup(*outcome).await,
            Ok(JobDone::Rewind(finished)) => self.finish_rewind(*finished).await,
            Ok(JobDone::RestoreFiles(finished)) => self.finish_restore_files(*finished).await,
            Err(error) => {
                tracing::warn!(%error, "a session job ended without a result");
                self.start_next().await;
            }
        }
    }

    pub(crate) fn emit_queue(&self) {
        self.log.append(KernelEvent::QueueChanged {
            items: self.queue.iter().cloned().collect(),
        });
    }

    async fn view(&self) -> SessionView {
        SessionView {
            meta: self.meta.clone(),
            messages: [self.earlier.as_slice(), self.messages.as_slice()].concat(),
            selection: self.selection.clone(),
            mode: self.execution.mode,
            plan: self.execution.plan,
            pending: self
                .pending
                .iter()
                .map(|pending| (pending.id.clone(), pending.request.clone()))
                .collect(),
            queue: self.queue.iter().cloned().collect(),
            last_seq: self.log.last_seq(),
            revision: self.log.revision(),
            running: self.running.is_some(),
            background: [self.background().await, self.background_agents().await].concat(),
            peer_held: self.peers.views(),
            // 冷加载后不用等下一条回复（F27）：与 `context_changed` 同样两个函数。
            context_usage: self.context_occupancy(),
            context_notice: self.context_notice().unwrap_or_default(),
            output_speed: self.output_speed,
            launches: self.launches.clone(),
            model_turns: self
                .model_turns
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone(),
            input_intents: self.input_intents.clone(),
        }
    }
}

#[cfg(test)]
#[path = "turn_anchor_tests.rs"]
mod turn_anchor_tests;

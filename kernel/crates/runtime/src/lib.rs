//! 内核组装（docs/specs/rust-cli/README.md §3）。
//!
//! 把各能力 crate 的实现接到端口上，得到实现 [`Kernel`] 的 [`LocalKernel`]；不含任何适配器，
//! 适配器（模型、执行环境、存储）由入口 crate 构造后经 [`Ports`] 传入。时间与 ID 也经 [`Ports`] 注入：本机实现是
//! node-store 的 `SystemClock` / `NodeIds`（F7 从这里移走，内核 crate 不碰系统时钟与随机源，README §4）。
//!
//! 每个会话一个 actor，运行在自己的子任务作用域里；内核释放时根作用域中止全部会话任务。

mod agents;
mod attachment;
pub mod blocked;
mod blocked_board;
mod catalog;
mod config;
mod directory;
mod escalations;
mod export;
mod ext;
mod generate_text;
mod hook_review;
mod kernel;
mod late;
mod listings;
mod node_repl;
mod permissions;
mod projects;
mod sampling;
mod shared_context;
mod table;
mod topic_reads;
mod usage;
mod workspace_sessions;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::{Mutex, PoisonError};

use async_trait::async_trait;
use nibi_kernel_agents::{AgentCatalog, Agents, AgentsConfig, AgentsPorts, MemoryTaskLists};
use nibi_kernel_base::TaskScope;
use nibi_kernel_compact::{CompactPorts, Compaction, DenyTools, Disabled};
use nibi_kernel_context::{ContextPorts, PromptAssembler};
use nibi_kernel_ext::{Ext, ExtPorts};
use nibi_kernel_hooks::{HookEngine, HookPorts};
use nibi_kernel_api::agents::{AgentSignals, TaskListStore};
use nibi_kernel_api::clock::{Clock, Ids};
use nibi_kernel_api::env::{OperationContext, Origin, WorkspaceRef};
use nibi_kernel_api::env_registry::EnvironmentRegistry;
use nibi_kernel_api::ids::{Generation, OwnerEpoch, SessionId, ToolUseId, TraceId};
use nibi_kernel_api::local_services::LocalServices;
use nibi_kernel_api::machine::MachineEnv;
use nibi_kernel_api::model::{ModelPort, ModelSelection};
use nibi_kernel_api::orchestration::{Compactor, QueryRunner};
use nibi_kernel_api::peers::ModeClass;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{
    CreateSession, DynamicWorkflowGate, Kernel, KernelError, SessionHandle, StartSource,
};
use nibi_kernel_api::store::{
    ArtifactStore, Fact, FactBatch, SessionFilter, SessionKind, SessionMeta, SessionStore,
    SessionSummary, StoreError,
};
use nibi_kernel_api::tool::{ReadFileStates, ToolOutput, ToolUseContext};
use nibi_kernel_policy::PolicyGate;
use nibi_kernel_query::{QueryLoop, QueryParts};
use nibi_kernel_session::{Opened, Session, SessionState};
use nibi_kernel_tools::Pipeline;
use table::{Closer, OpenSessions};

pub use ext::{ExtConfig, Extensions, PluginSnapshotLoader};
pub use permissions::{
    bash_rule_label, bash_rule_seed, format_rule as format_permission_rule,
    parse_rule as parse_permission_rule,
};
pub use nibi_kernel_compact::{CompactConfig, Thresholds as CompactThresholds};
pub use nibi_kernel_context::{Attribution, ContextConfig, OutputStyle, Surface};
// hooks 快照（`LocalKernel::replace_hooks` 的参数）：前端的测试组装它不必依赖 hooks crate（修复线 F37 的 TUI 测试）。
pub use nibi_kernel_hooks::{HookSource, HooksConfig, HooksSettings};
pub use nibi_kernel_query::{RequestLimits, ThinkingTokens};
pub use nibi_kernel_session::{PeerDeps, TitleModel};
pub use nibi_kernel_tools::BashTimeouts;

/// 内核需要的全部端口。
#[derive(Clone)]
pub struct Ports {
    pub model: Arc<dyn ModelPort>,
    /// 执行环境的注册表（R0 只有本机，remote-exec.md §15.8.1）：内核建好时取本机的机器与本机服务分给各能力。
    pub environments: Arc<dyn EnvironmentRegistry>,
    pub store: Arc<dyn SessionStore>,
    pub artifacts: Arc<dyn ArtifactStore>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
}

/// 冷加载的会话没有记录模型或模式时使用的默认值。
#[derive(Debug, Clone)]
pub struct Defaults {
    pub selection: ModelSelection,
    pub mode: PermissionMode,
    /// 每次提问最多几轮（`--max-turns`）；None 不限制。
    pub max_turns: Option<u32>,
    /// 启动参数点名了 Glob 或 Grep：有 Bash 时也暴露这两个工具
    /// （tools-files.md §1.1）。
    pub search_tools: bool,
    /// 任务工具的显式开关（入口读 `NIBI_ENABLE_TODO_TOOLS` / `NIBI_ENABLE_TASKS`，
    /// 修复线 F42）：Some(true) 打开，Some(false) 关闭，None 按默认模型（agents.md §7）。
    pub task_tools: Option<bool>,
    /// 入口按环境变量给的上限（cli-args.md §9，修复线 F42）。
    pub limits: Limits,
}

/// 入口按环境变量给的开关（cli-args.md §9.1–§9.3，修复线 F42）：主循环的输出上限与 thinking、Bash 的超时；工作线 F89 加
/// `ENABLE_TOOL_SEARCH`（`request.tool_search`：ToolSearch 工具启用与否、主循环与 `/context` 每一步开不开，tools-more.md
/// §3.2.1）。缺省是都没设。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Limits {
    /// 主循环、子代理与压缩摘要的 `max_tokens` 与 thinking（query.md §1.4），ToolSearch 的设置（工作线 F89）。
    pub request: RequestLimits,
    /// Bash 工具（模型的调用与 bash 模式）的缺省与最大超时。
    pub bash: BashTimeouts,
    /// `NIBI_FORK_SUBAGENT`（对照实现有同义的开关，修复线 L-A，agents.md §8.1.1）：Some(true) 打开 fork
    /// 子代理（`-p` 也开），Some(false) 关掉，None 按形态（交互会话开，`-p` 关）。
    pub fork_subagent: Option<bool>,
}

/// 子代理会话继承父会话的插件快照（skills/hooks/agents 根）。
///
/// agents crate 建子会话时直接走 store（不经过 `Kernel::create_session_inner`），没有机会执行
/// 会话级快照；Node 的子代理 app 与父共用插件，这里把父会话的三份根复制给子会话。
struct SubagentPlugins {
    ext: Arc<Ext>,
    agents: Arc<AgentCatalog>,
    hooks: Arc<HookEngine>,
    /// 子代理继承父会话的执行偏好（Node `source.kind === "inherit"`）：工具搜索、增强搜索、
    /// 集成 Shell 与父会话一致。执行环境没有这张表时缺省什么都不做。
    commands: Arc<dyn nibi_kernel_api::machine::Commands>,
}

impl nibi_kernel_agents::SubagentPluginInheritance for SubagentPlugins {
    fn inherit(&self, parent: &SessionId, child: &SessionId) {
        self.ext
            .copy_session_skill_roots(parent, child.clone());
        self.agents.copy_session(parent, child.clone());
        self.hooks.copy_session(parent, child.clone());
        self.commands
            .inherit_session_execution_preferences(parent, child);
    }
}

pub struct LocalKernel {
    ports: Ports,
    /// 本机（注册表的 `local_machine()`）：会话、`/cd`、导出、项目清单、`@` 清单都在本机。
    machine: MachineEnv,
    /// 只在本机的服务（`/diff`）。
    local: LocalServices,
    defaults: Defaults,
    runner: Arc<dyn QueryRunner>,
    /// 工具执行管线（与主循环同一个实例）：回合外授权（MCP Apps 的页面调用）经它跑校验、hooks 与权限。
    executor: Arc<dyn nibi_kernel_api::orchestration::ToolExecutor>,
    /// 子代理的信号来源（后台子代理的通知、任务清单变化），交给每个会话 actor。
    agents: Arc<dyn AgentSignals>,
    /// 同一个 `Agents` 实例（DWF 的 actor 轮经它跑；信号与工具注册表都是这一份）。
    actors: Arc<nibi_kernel_agents::Agents>,
    /// 定时任务的唤醒与到期任务（tools-more.md §10.4）；`-p` 不触发，是 `NoCron`。
    cron: Arc<dyn nibi_kernel_api::cron::CronSignals>,
    compactor: Arc<dyn Compactor>,
    gate: Arc<PolicyGate>,
    /// skill、MCP 与插件（docs/specs/rust-cli/ext.md）。
    ext: Arc<Ext>,
    /// 会话创建时重新读插件快照的入口（NIBI 多会话进程）；None 时用启动快照（CLI/TUI）。
    plugin_loader: Option<Arc<dyn ext::PluginSnapshotLoader>>,
    /// 入口投影的进程环境（内置 `node_repl` 服务器的凭据白名单来源；runtime 不直接读 `std::env`）。
    node_repl_env: Option<std::collections::BTreeMap<String, String>>,
    /// 会话侧 hooks 与回退事务的执行环境实例（L10，docs/specs/rust-cli/session-lifecycle.md）。
    hooks: Arc<HookEngine>,
    /// agent 类型的来源（context 的清单与 Agent 工具共用）；插件 agent 在插件加载后设置。
    agent_catalog: Arc<AgentCatalog>,
    /// 会话标题的生成：入口在 TUI 下经 `with_titles` 打开（`-p` 不生成，docs/specs/rust-cli/titles.md §2）。
    titles: Option<TitleModel>,
    /// `/context` 的分析（context-usage.md），与主循环共用同一批实例。
    usage: Arc<usage::UsageAnalyzer>,
    /// 用户输入的 `@` 提及与 bash 模式（tui-input.md §1.1、§2.2）：基础注册表里的 Read 与 Bash。
    inputs: Arc<dyn nibi_kernel_api::user_input::UserInputs>,
    generation: Generation,
    scope: TaskScope,
    /// 会话表（session-lifecycle.md §3.3.1）：每个会话归谁的唯一来源。
    sessions: OpenSessions,
    /// 关闭时标成关闭中、释放按会话的表（[`Closer`]）。
    closer: Arc<Closer>,
    /// 本机跨会话通信（cross-session.md §2.4）：每个会话 actor 共用这一份端口。
    peers: nibi_kernel_session::PeerDeps,
    /// 父会话关闭之后旧会话的询问入口（进程级，agents.md §4.1.2，工作线 F72）：每个会话 actor 共用这一份。
    detached: Arc<nibi_kernel_session::DetachedAsks>,
    /// 会话的附加工作目录（NIBI createSession.additionalDirectories）：判决链与环境段读的同一份表。
    directories: Arc<nibi_kernel_api::session_paths::SessionDirectories>,
    /// 工作区钩子的信任库（NIBI 协议前端的钩子评审）：入口注入，没接的入口三个方法报 Unsupported。
    hook_trust: Option<Arc<dyn nibi_kernel_api::hook_review::HookTrust>>,
    /// 用户层 hooks（评审 digest 的默认超时与输出上限来源，config.md §4.1）。
    user_hooks: Arc<nibi_kernel_hooks::node_config::NodeHooks>,
    /// DWF 引擎（路线 C 的 sidecar）：入口注入，没接的入口三个命令报 Unsupported。
    workflow_engine: Option<Arc<dyn nibi_kernel_api::workflow::WorkflowEngine>>,
    /// 同一引擎的工具面槽：注册表建好时引擎还没接上，`FillWorkflowHole` 在调用时读它。
    workflow_engine_slot: nibi_kernel_tools::WorkflowEngineSlot,
    /// DWF 升级问答的停驻表（actor 的 `escalate` 与主会话的 `ResolveWorkflowQuestion` 共用）。
    escalations: Arc<escalations::WorkflowEscalations>,
    /// 本进程在服务 Host 协议（`app-server` 入口置位）：Host 关闭灰度时**什么都不发**，所以「没有
    /// workspace 策略」要靠调用方区分——Host 会话按关闭，CLI/TUI 不参加灰度（工具全注册）。
    host_serving: bool,
    /// workspace 级的动态工作流策略（Node `appRuntimePreferences`）：Host 经
    /// `workspace/updateDynamicWorkflowPolicy` 同步；键是工作区根。只影响之后创建/恢复的会话。
    dynamic_workflow: Mutex<HashMap<String, nibi_kernel_api::session_api::DynamicWorkflowGate>>,
    /// 「run 还欠着决定、主代理闲着」提醒钟的会话侧边（blocked_board.md）：actor 的忙闲沿与
    /// 引擎客户端的开集沿都汇到这里，每个会话一尊钟。
    blocked: Arc<blocked_board::WorkflowBlockedBoard>,
}

impl LocalKernel {
    /// 上下文按 TUI 形态组装；`-p` 用 [`LocalKernel::with_context`] 传入 `Surface::Print`。
    pub fn new(ports: Ports, defaults: Defaults) -> Self {
        Self::with_context(ports, defaults, ContextConfig::new(Surface::Interactive))
    }

    /// 任务清单放在内存里（测试、嵌入）；入口 crate 用 [`LocalKernel::with_task_lists`] 接本地存储。
    pub fn with_context(ports: Ports, defaults: Defaults, context: ContextConfig) -> Self {
        Self::with_options(
            ports,
            defaults,
            context,
            CompactConfig::default(),
            Arc::new(MemoryTaskLists::default()),
        )
    }

    /// 同 [`LocalKernel::with_context`]，另给扩展（前端的集成测试接跨会话的端口，cross-session.md §6）。
    pub fn with_context_and_extensions(
        ports: Ports,
        defaults: Defaults,
        context: ContextConfig,
        extensions: Extensions,
    ) -> Self {
        Self::with_extensions(
            ports,
            defaults,
            context,
            CompactConfig::default(),
            Arc::new(MemoryTaskLists::default()),
            extensions,
        )
    }

    /// 另给压缩配置（自动压缩开关、阈值覆盖、Provider 目录；docs/specs/rust-cli/compact.md §2）与
    /// 任务清单（Task v2）的存储（docs/specs/rust-cli/agents.md §7）。
    pub fn with_options(
        ports: Ports,
        defaults: Defaults,
        context: ContextConfig,
        compact: CompactConfig,
        tasks: Arc<dyn TaskListStore>,
    ) -> Self {
        Self::with_extensions(ports, defaults, context, compact, tasks, Extensions::none())
    }

    /// 另给 MCP 传输与扩展配置（docs/specs/rust-cli/ext.md §1）。内核建好后由入口调用
    /// [`LocalKernel::start_extensions`] 开始连接 MCP 服务器。
    pub fn with_extensions(
        ports: Ports,
        defaults: Defaults,
        context: ContextConfig,
        compact: CompactConfig,
        tasks: Arc<dyn TaskListStore>,
        extensions: Extensions,
    ) -> Self {
        let scope = TaskScope::root("nibi-kernel-cli", |panic| {
            tracing::error!(scope = %panic.scope, task = panic.task, message = %panic.message, "task panicked");
        });
        // 本地执行环境的实例随进程变化（spec §6 规则 3）；hook 命令与工具共用同一个实例。ID 经注入的 Ids
        // （F7，审查 R2-11：以前直接调用 `Uuid::new_v4`）。
        let generation = ports.ids.generation();
        // 各能力拿本机的端口：R0 只有本机；规则文件、记忆、插件与 skills 本来就只在本机读（remote-exec.md §3）。
        let machine = ports.environments.local_machine();
        let local = ports.environments.local();
        // hooks 的配置快照由入口层组装后经 `HookEngine::replace` 交进来（hooks.md §2.2）。
        let hooks = Arc::new(HookEngine::new(HookPorts {
            commands: machine.commands().clone(),
            shell: machine.shell().clone(),
            ids: ports.ids.clone(),
            model: Some(ports.model.clone()),
            http: None,
            generation: generation.clone(),
            // 大输出与工具结果落在同一个存储（hooks.md §4.5，修复线 F15）。
            artifacts: ports.artifacts.clone(),
        }));
        let non_interactive = matches!(context.surface, Surface::Print);
        let late = Arc::new(late::LateCompactor::default());
        // 一个判决链实例：工具注册（Edit / Write 的先读规则）与执行管线共用，会话内“总是允许”的
        // 规则因此对两边都生效。规则快照由入口层接入配置后替换（shell-permissions.md §5）。
        // 会话的附加工作目录（NIBI createSession.additionalDirectories）：判决链与环境段共用一份。
        let session_directories = Arc::new(
            nibi_kernel_api::session_paths::SessionDirectories::new(),
        );
        let gate = Arc::new(
            PolicyGate::default().with_session_directories(session_directories.clone()),
        );
        // ToolSearch 与延迟工具清单看同一个主线程注册表，建好注册表后绑定（tools-more.md §3.4）；`ENABLE_TOOL_SEARCH` 为关时
        // ToolSearch 不启用（工作线 F89，§3.2.1）。
        let catalog = Arc::new(nibi_kernel_tools::ToolCatalog::new(
            defaults.limits.request.tool_search,
        ));
        // 会话内定时任务（L11b）：任务表在这里，触发由会话 actor 在空闲时取走。
        let cron =
            nibi_kernel_tools::CronBoard::new(ports.clock.clone(), extensions.cron_store.clone());
        // DWF 升级问答的停驻表：主会话的 `ResolveWorkflowQuestion` 与 actor 的 `escalate`
        // 共用一份；通知通道在 `Agents` 建好之后接上（走后台子代理通知同一条路）。事件 journal
        // 用会话库（`dwf_event`，与引擎 sidecar 共写同一份 `db.sqlite`）。
        let escalations = Arc::new(escalations::WorkflowEscalations::new(ports.clock.clone()));
        escalations.attach_journal(Arc::new(escalations::SessionJournalSink(
            ports.store.clone(),
        )));
        // run 行的只读面：升级通知的 originMeta 展示名走 run 行的标签链（Node
        // registry.description 的同源兜底）。
        escalations.attach_store(ports.store.clone());
        // 基础工具：文件与搜索（L3）、Bash（L4）、交互与 Web 工具（L11a）；Skill 与 MCP 工具由 ext
        // 加在后面（L9），Agent 等由 agents 再加（L7）。
        // Read 整读 PDF 前按会话当前模型的生效配置查 `supports_pdf`（tools-files.md §1.5，修复线 F24）。
        let pdf_model = nibi_kernel_tools::SideModel {
            model: ports.model.clone(),
            selection: defaults.selection.clone(),
        };
        let builtin = nibi_kernel_tools::builtin_with(gate.clone(), Some(pdf_model));
        // 压缩时清空的 readFileState 与文件工具是同一份（compact.md §3.4）；关闭会话时也释放它（[`Closer`]）。
        let read_files: Arc<nibi_kernel_tools::ReadFileState> =
            builtin.file_state().cloned().unwrap_or_default();
        let file_states: Arc<dyn ReadFileStates> = read_files.clone();
        let worktrees = Arc::new(nibi_kernel_tools::WorktreeBoard::default());
        // DWF 工具面的引擎槽：入口的 `with_workflow_engine` 在注册表建好之后才调，工具在调用时读。
        let workflow_engine_slot: nibi_kernel_tools::WorkflowEngineSlot =
            Arc::new(std::sync::Mutex::new(None));
        let base: Arc<dyn nibi_kernel_api::orchestration::ToolRegistry> = Arc::new(
            builtin
                .with_search_opt_in(defaults.search_tools)
                // 后台命令的期限只在 `-p`（shell-permissions.md §1.1，修复线 F9）；启动时是 bypass 类别时
                // 描述去掉“不要用 cat”一行（§4.9，修复线 F43），整个进程不变。
                .with_leading(Arc::new({
                    // `BASH_*_TIMEOUT_MS` 的缺省与上限（cli-args.md §9.3，修复线 F42）；进程启动时是 bypass 类别时
                    // 去掉“不要用 cat”一行（修复线 F43，shell-permissions.md §4.9）。
                    let bash = nibi_kernel_tools::BashTool::new()
                        .with_timeouts(defaults.limits.bash)
                        // 读文件的命令记进文件工具的同一份 readFileState（tools-files.md §4.2）。
                        .with_file_state(read_files.clone())
                        .with_background_deadline(non_interactive)
                        .with_bash_first_trimmed(ModeClass::of(defaults.mode) == ModeClass::Bypass)
                        // Monitor 开着时描述多一句、前台长 `sleep` 拦下（tools-more.md §19.9）。
                        .with_monitor(extensions.monitor);
                    // stream-json 输入：后台命令的缺省期限 max(1800000, 前台缺省)（headless.md §6.1）。
                    if extensions.streaming_input {
                        bash.with_streaming_input()
                    } else {
                        bash
                    }
                }))
                .with_tools(nibi_kernel_tools::interaction_tools(
                    &catalog,
                    !non_interactive,
                ))
                .with_tools(nibi_kernel_tools::web_tools(
                    nibi_kernel_tools::SideModel {
                        model: ports.model.clone(),
                        selection: defaults.selection.clone(),
                    },
                    ports.clock.clone(),
                ))
                .with_tools(nibi_kernel_tools::cron_tools(&cron, extensions.monitor))
                // `/loop` 动态模式的自定节奏（L17，tools-more.md §17.2）：默认注册、不延迟。
                .with_tools(vec![Arc::new(nibi_kernel_tools::ScheduleWakeupTool::new(
                    &cron,
                ))])
                // Monitor（工作线 F83，tools-more.md §19）：单次的 `-p` 上限 10 分钟，其余 30 分钟。
                .with_tools(if extensions.monitor {
                    let session = !non_interactive || extensions.streaming_input;
                    vec![Arc::new(
                        nibi_kernel_tools::MonitorTool::new().with_session_cap(session),
                    )]
                } else {
                    Vec::new()
                })
                .with_tools(vec![Arc::new(nibi_kernel_tools::ReportFindingsTool::new())])
                // DWF 升级问答的答题入口（主会话；actor 的工具面里被藏起来）。
                .with_tools(vec![Arc::new(
                    nibi_kernel_tools::ResolveWorkflowQuestionTool::new(escalations.clone()),
                )])
                // DWF run 详情（`GetWorkflowRun`）：journal 读面 ∪ 停驻注册表的活项——
                // 升级通知与答题拒绝文案里引用的查询兜底。
                .with_tools(vec![Arc::new(nibi_kernel_tools::GetWorkflowRunTool::new(
                    Arc::new(escalations::WorkflowRunDetailReader {
                        store: ports.store.clone(),
                        escalations: escalations.clone(),
                    }),
                    ports.clock.clone(),
                ))])
                // DWF 留白补全（`FillWorkflowHole`）：引擎经槽取得（sidecar 在入口最后才接上；
                // 缺席回「本会话不能补全」的同一条结构化失败）。
                .with_tools(vec![Arc::new(nibi_kernel_tools::FillWorkflowHoleTool::new(
                    workflow_engine_slot.clone(),
                ))])
                .with_tools(nibi_kernel_tools::worktree_tools(&worktrees))
                // 话题（bot 群）的两个工具：`ReadSessionContext` 读历史/话题附件，
                // `ReplyToChannel` 经 Host 发带原生 @ 的回复。冷读走会话存储，
                // Host 能力由入口装在 `extensions.topic`。
                .with_tools(nibi_kernel_tools::topic_tools(
                    Arc::new(topic_reads::StoreReads::new(ports.store.clone())),
                    extensions.topic.clone(),
                )),
        );
        // 用户输入的提及与 bash 模式用基础注册表里的 Read 与 Bash（与模型的调用共用 readFileState 与 shell 状态）。
        let inputs: Arc<dyn nibi_kernel_api::user_input::UserInputs> = Arc::new(
            nibi_kernel_tools::UserInputTools::new(base.as_ref(), gate.clone())
                .with_bash_timeouts(defaults.limits.bash),
        );
        // 会话表（session-lifecycle.md §3.3.1）：每个会话归谁的唯一来源。采样端口也要用它把回合外
        // 请求的用量行交给发起会话的 actor，所以在建端口之前就建好。
        let sessions = OpenSessions::default();
        // MCP Apps 采样：回合外的一次性模型请求用会话的缺省选择（页面不给模型选择）。
        let sampling: Arc<dyn nibi_kernel_api::mcp_ui::McpUiSamplingPort> =
            Arc::new(sampling::KernelSampling::new(
                ports.model.clone(),
                defaults.selection.clone(),
                ports.clock.clone(),
                ports.ids.clone(),
                sessions.clone(),
                ports.store.clone(),
            ));
        let plugin_loader = extensions.plugin_loader.clone();
        let ext = Arc::new(Ext::new(
            ExtPorts {
                info: machine.info().clone(),
                files: machine.files().clone(),
                ids: ports.ids.clone(),
                gate: gate.clone(),
                mcp: machine.mcp().clone(),
                // 绑定到远端机器的 MCP 服务器经注册表取那台机器的管道（R5，remote-exec.md §22.6）。
                machines: Some(ports.environments.clone()),
                spawner: scope.spawner(),
                clock: ports.clock.clone(),
                mcp_telemetry: extensions.mcp_telemetry.clone(),
                mcp_ui_events: extensions.mcp_ui.clone(),
                mcp_oauth: extensions.mcp_oauth.clone(),
                sampling: Some(sampling),
            },
            base,
            extensions.config,
        ));
        ext.set_print_session(non_interactive);
        // agent 清单（context）与 Agent 工具共用一个目录：插件 agent 设置一次，两处同时看到（L12）。
        let agent_catalog = Arc::new(AgentCatalog::new(
            machine.info().clone(),
            machine.files().clone(),
        ));
        let context = PromptAssembler::new(
            ContextPorts {
                info: machine.info().clone(),
                files: machine.files().clone(),
                shell: machine.shell().clone(),
                git: local.git().clone(),
                clock: ports.clock.clone(),
                ids: ports.ids.clone(),
                // agent 清单由 agents 给出（L7），延迟工具由 ToolCatalog 给出（L11a），skill 清单与 MCP
                // instructions 由 ext 给出（L9）。
                listings: Arc::new(listings::CombinedListings(vec![
                    agent_catalog.clone(),
                    catalog.clone(),
                    ext.listings(),
                ])),
            },
            context,
        )
        // 读过的文件在磁盘上被改动（tools-files.md §4.1）：与文件工具同一份 readFileState；远端机器上读过的文件每台每步
        // 一次批量 stat（R3，remote-exec.md §20.7.4）。
        .with_changed_files(Arc::new(
            nibi_kernel_tools::FileChanges::new(read_files.clone(), machine.files().clone())
                .with_machines(ports.environments.clone()),
        ))
        // 机器清单提醒（R3，remote-exec.md §20.5.3）。
        .with_machines(ports.environments.clone())
        // 会话的附加工作目录（NIBI createSession.additionalDirectories）。
        .with_session_directories(session_directories.clone());
        let context = Arc::new(context);
        let assembler = context.clone();
        let closer = Arc::new(Closer {
            sessions: Arc::downgrade(&sessions),
            context: context.clone(),
            read_files,
            worktrees,
            gate: gate.clone(),
            mcp: ext.mcp().clone(),
            ext: ext.clone(),
            directories: session_directories.clone(),
            hooks: hooks.clone(),
            agents: agent_catalog.clone(),
        });
        let parts = QueryParts {
            model: ports.model.clone(),
            context: context.clone(),
            // 整个工具的 deny 规则从清单里去掉（tools-files.md §1.1.1，工作线 F69）：主线程、子代理、延迟清单与
            // 压缩摘要都从这一层往外取，规则用判决链当前的快照。
            tools: Arc::new(nibi_kernel_tools::PolicyFiltered::new(
                ext.registry(),
                gate.clone(),
            )),
            // 按调用的 `machine` 选机器（R3，remote-exec.md §20.6）。
            executor: Arc::new(
                Pipeline::new(
                    Arc::new(permissions::SharedRules {
                        gate: gate.clone(),
                        store: ports.store.clone(),
                    }),
                    hooks.clone(),
                )
                .with_machines(ports.environments.clone()),
            ),
            // 先交出“稍后接上”的句柄：子循环（agents）与主循环共用，压缩器建好后再设置（late.rs）。
            compactor: late.clone(),
            hooks: hooks.clone(),
            ids: ports.ids.clone(),
            clock: ports.clock.clone(),
            machine: machine.clone(),
            machines: ports.environments.clone(),
            local: local.clone(),
            artifacts: ports.artifacts.clone(),
            generation,
            non_interactive,
            limits: defaults.limits.request,
        };
        // 回合外的工具审批（MCP Apps 的 `mcp/uiCallTool`）用同一条执行管线：校验、PreToolUse hooks 与
        // 权限判决都在 `Pipeline::authorize` 里，调用本身由 ext 的 MCP 连接发出（不产生对话回合）。
        let executor = parts.executor.clone();
        // 子代理与任务清单（工作线 L7）：主线程的工具注册表换成 agents 的（基础工具 + Agent 等），
        // 主循环包一层运行登记；子循环由 `LoopFactory` 用同一套能力组装。
        let agents = Arc::new(Agents::new(
            AgentsPorts {
                directories: session_directories.clone(),
                store: ports.store.clone(),
                ids: ports.ids.clone(),
                clock: ports.clock.clone(),
                machine: machine.clone(),
                machines: ports.environments.clone(),
                tasks,
                queries: Arc::new(agents::LoopFactory {
                    parts: parts.clone(),
                }),
                context: context.clone(),
                // 只读查看的子代理快照算 ctx 与上下文提示（修复线 F112）：与主循环、子循环同一个压缩器。
                compactor: late.clone(),
                catalog: agent_catalog.clone(),
                spawner: scope.spawner(),
                shell_notice: agents::shell_notice,
                monitor: nibi_kernel_agents::MonitorTexts {
                    notice: nibi_kernel_query::monitor_notice_text,
                    end: agents::monitor_end,
                },
                peers: extensions.peers.port.clone(),
                plugins: Some(Arc::new(SubagentPlugins {
                    ext: ext.clone(),
                    agents: agent_catalog.clone(),
                    hooks: hooks.clone(),
                    commands: machine.commands().clone(),
                })),
            },
            parts.tools.clone(),
            AgentsConfig {
                task_tools: defaults.task_tools.unwrap_or_else(|| {
                    nibi_kernel_agents::task_tools_enabled(&defaults.selection.model, false)
                }),
                // 只有交互模式停放还有后台子代理的子代理（agents.md §5.1）。
                keep_alive: !non_interactive,
                // 修复线 F67：交互界面里后台子代理也能询问（agents.md §4.1.1）。
                background_prompts: !non_interactive,
                // 修复线 L-A：交互会话缺省打开 fork 子代理，`-p` 关；环境变量可以改（agents.md §8.1.1）。
                fork: defaults.limits.fork_subagent.unwrap_or(!non_interactive),
            },
        ));
        let tools = agents.registry();
        catalog.bind(&tools);
        // 升级提示经 `Agents` 的通知中心送进父会话（与后台子代理的通知同一条 `task-notification` 路）。
        escalations.attach_notifier(agents.clone());
        // 「run 还欠着决定、主代理闲着」的提醒钟（blocked_board）：每个会话一尊钟，忙闲沿由
        // actor 报、开集沿由引擎客户端转发；发也走 `Agents` 的通知中心同一条路。会话 actor 在
        // 打开时经会话依赖拿到侧边（table.rs 的 deps 装配）。
        let blocked = Arc::new(blocked_board::WorkflowBlockedBoard::new(
            ports.store.clone(),
            escalations.clone(),
            workflow_engine_slot.clone(),
            ports.clock.clone(),
            scope.spawner(),
        ));
        blocked.attach_notifier(agents.clone());
        // 任务提醒读的清单（agents.md §7.4）：agents 要用上下文，所以建好之后再接给它。
        assembler.bind_tasks(agents.task_reader());
        let usage = Arc::new(usage::UsageAnalyzer {
            model: ports.model.clone(),
            context: assembler,
            tools: tools.clone(),
            agents: agent_catalog.clone(),
            skills: ext.skills().clone(),
            compact: compact.clone(),
            tool_search: defaults.limits.request.tool_search,
        });
        // 摘要请求的子循环：同一个上下文与主线程的工具清单（共享缓存前缀），工具一律拒绝，自己不再压缩
        // （compact.md §3.2）。
        let summary = QueryLoop::new(QueryParts {
            executor: Arc::new(DenyTools),
            tools: tools.clone(),
            compactor: Arc::new(Disabled),
            ..parts.clone()
        });
        let compactor: Arc<dyn Compactor> = Arc::new(Compaction::new(
            CompactPorts {
                runner: Arc::new(summary),
                tools: tools.clone(),
                files: file_states,
                context,
                hooks: hooks.clone(),
                ids: ports.ids.clone(),
                machine: machine.clone(),
                local: local.clone(),
                artifacts: ports.artifacts.clone(),
                generation: parts.generation.clone(),
            },
            compact,
        ));
        late.set(compactor.clone());
        let generation = parts.generation.clone();
        let parts = QueryParts { tools, ..parts };
        let runner = agents.track(Arc::new(QueryLoop::new(parts)));
        let detached = Arc::new(nibi_kernel_session::DetachedAsks::new(
            ports.store.clone(),
            ports.ids.clone(),
        ));
        Self {
            ports,
            machine,
            local,
            defaults,
            runner,
            executor,
            agents: agents.signals(),
            actors: agents.clone(),
            cron: if non_interactive {
                Arc::new(nibi_kernel_api::cron::NoCron)
            } else {
                cron.signals()
            },
            compactor,
            gate,
            ext,
            plugin_loader,
            node_repl_env: extensions.node_repl_env,
            hooks,
            agent_catalog,
            titles: None,
            usage,
            inputs,
            generation,
            scope,
            sessions,
            closer,
            peers: extensions.peers,
            detached,
            directories: session_directories,
            hook_trust: None,
            user_hooks: Arc::new(nibi_kernel_hooks::node_config::NodeHooks::default()),
            workflow_engine: None,
            workflow_engine_slot,
            escalations,
            host_serving: false,
            dynamic_workflow: Mutex::default(),
            blocked,
        }
    }

    /// DWF 引擎（路线 C 的 sidecar）：入口注入。TUI / `-p` 与没接 sidecar 的入口不接，三个命令保持
    /// `Unsupported`。
    pub fn with_workflow_engine(
        mut self,
        engine: Arc<dyn nibi_kernel_api::workflow::WorkflowEngine>,
    ) -> Self {
        if let Ok(mut slot) = self.workflow_engine_slot.lock() {
            *slot = Some(engine.clone());
        }
        self.workflow_engine = Some(engine);
        self
    }

    /// 工作区钩子评审（NIBI 协议前端）：用户层 hooks 与信任库。TUI / `-p` 不接，
    /// [`Kernel::workspace_hook_review`] 三个方法保持 `Unsupported`。
    pub fn with_hook_review(
        mut self,
        user_hooks: nibi_kernel_hooks::node_config::NodeHooks,
        trust: Arc<dyn nibi_kernel_api::hook_review::HookTrust>,
    ) -> Self {
        self.user_hooks = Arc::new(user_hooks);
        self.hook_trust = Some(trust);
        self
    }

    /// 本进程在服务 Host 协议（`app-server` 入口）：动态工作流的灰度缺省按 Host 语义——
    /// 没有 workspace 策略就是关闭，而不是 CLI/TUI 的「不参加灰度、工具全注册」。
    /// 缺省门同时落到判决链上：子代理与 actor 会话直接经存储建、不经过会话启动路径，
    /// 它们也必须按 Host 的结论走，否则 Agent 工具就是绕开灰度的后门。
    #[must_use]
    pub fn with_host_serving(mut self) -> Self {
        self.host_serving = true;
        self.gate
            .set_dynamic_workflow_default(DynamicWorkflowGate::default());
        self
    }

    /// 这个工作区此刻的动态工作流门（Node `resolveDynamicWorkflowRuntimeGate` 的 workspace 一半）：
    /// Host 进程读 Host 同步来的策略，缺席按关闭；CLI/TUI 不参加灰度。
    pub(crate) fn dynamic_workflow_gate(&self, workspace: &WorkspaceRef) -> DynamicWorkflowGate {
        if !self.host_serving {
            return DynamicWorkflowGate::UNGATED;
        }
        self.dynamic_workflow
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(workspace.root.as_str())
            .copied()
            .unwrap_or_default()
    }

    /// 加载插件、开始连接 MCP 服务器（不等待连接完成，ext.md §3.3）。插件的 agent 文件交给 agent
    /// 目录、hooks 登记到 hooks 引擎（ext.md §4，L12）；返回时两者都已生效，之后才开会话。
    pub async fn start_extensions(&self) {
        let plugins = self.ext.start().await;
        let (agents, hooks) = ext::plugin_parts(&plugins);
        self.agent_catalog.set_plugins(agents);
        self.hooks.register_plugins(hooks);
    }

    /// `-p` 在第一个请求前的 MCP 等待（ext.md §3.3.1，修复线 F36）：alwaysLoad 的服务器与 prewait，到期就开跑，
    /// 没连上的服务器在后台继续连。
    pub async fn wait_for_extensions(&self) {
        self.ext.wait_for_print().await;
    }

    pub fn ports(&self) -> &Ports {
        &self.ports
    }

    /// 模型目录（辅助档的推理档位与输出上限来源）：入口经 `with_titles` 注入，`-p` 等显式覆盖时没有。
    pub(crate) fn model_directory(
        &self,
    ) -> Option<Arc<dyn nibi_kernel_api::provider::ModelDirectory>> {
        self.titles
            .as_ref()
            .and_then(|titles| titles.directory.clone())
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "hook_review_tests.rs"]
mod hook_review_tests;

#[cfg(test)]
#[path = "shared_context_tests.rs"]
mod shared_context_tests;

#[cfg(test)]
#[path = "workflow_actor_tests.rs"]
mod workflow_actor_tests;

#[cfg(test)]
#[path = "metering_tests.rs"]
mod metering_tests;

#[cfg(test)]
#[path = "closing_tests.rs"]
mod closing_tests;

#[cfg(test)]
#[path = "permission_scope_tests.rs"]
mod permission_scope_tests;

#[cfg(test)]
#[path = "dynamic_workflow_tests.rs"]
mod dynamic_workflow_tests;

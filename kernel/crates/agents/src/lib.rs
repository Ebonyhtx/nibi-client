//! 子代理与任务清单（docs/specs/rust-cli/agents.md）。
//!
//! 内容：Agent 工具、内置与自定义 agent、子循环（子会话
//! `sess_subagent_agent_*` 加 `parent_id`，经 [`SubagentQueries`] 跑）、前台与后台、
//! `<task-notification>`、ListAgents、SendMessage、TaskStop；Task v2 四个工具（库外文件，变化后
//! 投影到 Node 的 `todo` 表）。
//!
//! 不做 IO：会话经 [`SessionStore`]，工作区文件经执行端口（kernel-api `machine`），任务清单经 [`TaskListStore`]。
//! runtime 组装：[`Agents::registry`] 是主线程的工具注册表，[`Agents::track`] 包住主循环，
//! [`Agents::signals`] 交给会话 actor，[`AgentCatalog`] 交给 context 作 agent 清单。

mod actor;
mod agent_tool;
mod child;
mod context;
mod custom;
mod definitions;
mod doing;
mod fork;
mod frontmatter;
mod live;
mod messaging;
mod monitors;
mod peer_send;
mod plugin;
mod report;
mod routing;
mod runs;
mod shell_notices;
mod signals;
mod spawn;
mod task_stop;
mod tasks;
mod toolset;
mod views;

use std::sync::{Arc, Weak};

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use rust_cli_base::Spawner;
use rust_cli_kernel_api::agents::{AgentSignal, AgentSignals, SubagentQueries, TaskListStore};
use rust_cli_kernel_api::clock::{Clock, Ids};
use rust_cli_kernel_api::env_shell::ShellNotice;
use rust_cli_kernel_api::ids::{AgentId, SessionId};
use rust_cli_kernel_api::machine::MachineEnv;
use rust_cli_kernel_api::mcp_state::McpConnections;
use rust_cli_kernel_api::orchestration::{ContextBuilder, QueryRunner, ToolRegistry, ToolSnapshot};
use rust_cli_kernel_api::store::SessionStore;
use rust_cli_kernel_api::tool::Tool;

pub use actor::{ActorError, ActorProfile, ActorTurnOutcome};
pub use agent_tool::AgentTool;
pub use context::AgentCatalog;
pub use definitions::{AgentDefinition, AgentSource, builtins};
pub use monitors::MonitorTexts;
pub use plugin::PluginAgentFile;
pub use tasks::{MemoryTaskLists, task_tools_enabled};

use crate::live::Live;
use crate::runs::{RunBook, Tracked};
use crate::signals::Hub;
use crate::tasks::TaskBoard;

/// agents 用到的端口，由 runtime 注入。
#[derive(Clone)]
pub struct AgentsPorts {
    pub store: Arc<dyn SessionStore>,
    pub ids: Arc<dyn Ids>,
    pub clock: Arc<dyn Clock>,
    /// 子会话所在的机器：后台命令的通知、monitor、shell 当前目录、TaskStop（R0 只有本机，remote-exec.md §15.8.1）。
    pub machine: MachineEnv,
    /// 执行环境的注册表（R3，remote-exec.md §20.6、§20.7.2）：远端机器上的后台通知、monitor 与 TaskStop 经它找到那台机器。
    pub machines: Arc<dyn rust_cli_kernel_api::env_registry::EnvironmentRegistry>,
    pub tasks: Arc<dyn TaskListStore>,
    pub queries: Arc<dyn SubagentQueries>,
    /// 主线程的上下文组装；子代理的 attachment 也由它按 `QuerySource::Subagent` 产生。
    pub context: Arc<dyn ContextBuilder>,
    /// 主循环与子循环共用的压缩器（修复线 F112）：只读查看的快照用它算子代理的 ctx 与上下文提示（tui-panels.md §1.7）。
    pub compactor: Arc<dyn rust_cli_kernel_api::compaction::Compactor>,
    /// agent 类型的来源；与 context 的 agent 清单是同一个实例（插件 agent 由 runtime 设置）。
    pub catalog: Arc<AgentCatalog>,
    /// 后台子代理在这里启动。
    pub spawner: Spawner,
    /// 后台命令通知的 `(<status>, <task-notification> 信封)`（runtime 给 `rust_cli_query` 的实现；agents
    /// 不依赖 query）：子代理里的命令通知送给它（agents.md §5.2，L18）。
    pub shell_notice: fn(&ShellNotice) -> (&'static str, String),
    /// 子代理里 Monitor 的文字（同上，runtime 给 `rust_cli_query` 的实现，agents.md §5.3，工作线 F83）。
    pub monitor: MonitorTexts,
    /// 本机的同伴会话（ListAgents 的同伴段、SendMessage 发给同伴；docs/specs/rust-cli/cross-session.md）。
    pub peers: Arc<dyn rust_cli_kernel_api::peers::PeerMessaging>,
    /// 会话的附加工作目录（NIBI `createSession.additionalDirectories`）：子代理继承父会话的条目。
    pub directories: Arc<rust_cli_kernel_api::session_paths::SessionDirectories>,
}

/// 开关。
#[derive(Debug, Clone, Copy, Default)]
pub struct AgentsConfig {
    /// 注册 Task v2 四个工具（[`task_tools_enabled`]）。
    pub task_tools: bool,
    /// 子代理跑完时若还有在跑的后台子代理就停放、等它们的通知后续跑（只在交互模式这样做；
    /// `-p` 不停放，agents.md §5.1）。
    pub keep_alive: bool,
    /// 后台子代理能询问用户（交互界面；`-p` 与 stream-json 不询问，agents.md §4.1.1）。
    pub background_prompts: bool,
    /// fork 子代理（修复线 L-A，agents.md §8.1）：交互会话打开，`-p` 关。打开时 Agent 用 fork 写法、全部在后台。
    pub fork: bool,
}

impl AgentsPorts {
    /// 一台机器：本机（None），或注册表里那台；没连上时是“没连上”的机器（调用报错）。
    pub(crate) fn machine_named(&self, name: Option<&str>) -> MachineEnv {
        match name {
            None => self.machine.clone(),
            Some(name) => self
                .machines
                .machine(name)
                .unwrap_or_else(|| MachineEnv::unavailable(name)),
        }
    }
}

pub(crate) struct Core {
    pub(crate) ports: AgentsPorts,
    pub(crate) catalog: Arc<AgentCatalog>,
    pub(crate) runs: Arc<RunBook>,
    pub(crate) live: Arc<Live>,
    pub(crate) hub: Hub,
    pub(crate) board: TaskBoard,
    /// 子代理里的 Monitor（agents.md §5.3，工作线 F83）。
    pub(crate) monitors: monitors::MonitorBoard,
    pub(crate) keep_alive: bool,
    pub(crate) background_prompts: bool,
    pub(crate) fork: bool,
    /// 主线程的完整注册表（基础工具 + 本 crate 的工具）；子代理从它过滤。弱引用：注册表里的工具持有 Core，
    /// 两者在 [`Agents::new`] 里用 `Arc::new_cyclic` 一次建好，没有“先建后接”的空档。
    registry: Weak<AgentRegistry>,
}

impl Core {
    /// 主线程的注册表；内核已经释放它时（关闭中还在跑的后台子代理）为 None。
    ///
    /// 缺陷修复（审查 R1-13）：原来注册表先建后接（`OnceLock`），取不到时给一个空注册表，子代理会静默地不带任何
    /// 工具运行。现在构造时就接好，取不到只可能是内核已释放，调用方按失败结束子代理。
    pub(crate) fn registry(&self) -> Option<Arc<dyn ToolRegistry>> {
        self.registry
            .upgrade()
            .map(|registry| registry as Arc<dyn ToolRegistry>)
    }

    /// 子代理会话继承父会话的会话级 MCP（NIBI `createSession.mcpServers`）：Node 的子代理 app 直接
    /// 继承父的 `config.mcp`，这里让子会话看到同一批工具。内核已释放注册表时什么都不做。
    pub(crate) fn inherit_session_mcp(&self, parent: &SessionId, child: &SessionId) {
        if let Some(registry) = self.registry() {
            registry.inherit_session_mcp(parent, child);
        }
    }

    /// 子代理继承父会话的附加工作目录（NIBI `createSession.additionalDirectories`）：判决链与提示词
    /// 都按子会话取，因此复制一份借用的条目到子会话。
    pub(crate) fn inherit_session_directories(&self, parent: &SessionId, child: &SessionId) {
        self.ports.directories.inherit(parent, child);
    }
}

/// 主线程的工具：基础工具在前，本 crate 的工具在后。
struct AgentRegistry {
    base: Arc<dyn ToolRegistry>,
    own: Vec<Arc<dyn Tool>>,
    core: Arc<Core>,
}

impl AgentRegistry {
    /// 本 crate 的工具里启用、没被基础注册表藏起来的（整个工具的 deny 规则，tools-files.md §1.1.1）。
    ///
    /// 修 bug（工作线 F69）：以前 Agent、TaskStop 等被 deny 时仍在清单里，调用后才被拒。
    fn own_visible(&self) -> impl Iterator<Item = &Arc<dyn Tool>> {
        self.own
            .iter()
            .filter(|tool| tool.is_enabled() && !self.base.hides(tool.name()))
    }
}

impl ToolRegistry for AgentRegistry {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let mut tools = self.base.tools();
        tools.extend(self.own_visible().cloned());
        tools
    }

    /// 基础注册表的快照（同一时点的 MCP 状态，query.md §1.3）加上本 crate 的工具。
    fn snapshot(&self, session: &SessionId) -> ToolSnapshot {
        let mut snapshot = self.base.snapshot(session);
        snapshot.tools.extend(self.own_visible().cloned());
        snapshot
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        self.base.mcp()
    }

    /// 会话级的 MCP 连接（NIBI `createSession.mcpServers`）由基础注册表给。
    fn mcp_for(&self, session: &SessionId) -> Option<Arc<dyn McpConnections>> {
        self.base.mcp_for(session)
    }

    /// 首个模型请求前等的会话级 MCP（NIBI `createSession.mcpServers`）。
    fn session_mcp(&self, session: &SessionId) -> Option<Arc<dyn McpConnections>> {
        self.base.session_mcp(session)
    }

    /// 子代理会话继承父会话的会话级 MCP（基础注册表持有会话到连接的映射）。
    fn inherit_session_mcp(&self, parent: &SessionId, child: &SessionId) {
        self.base.inherit_session_mcp(parent, child);
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        match self
            .own
            .iter()
            .find(|tool| tool.name() == name || tool.aliases().contains(&name))
        {
            Some(tool) if self.base.hides(tool.name()) => None,
            Some(tool) => Some(tool.clone()),
            None => self.base.find(name),
        }
    }

    /// 会话级的 MCP 工具只在自己会话里可见（NIBI `createSession.mcpServers`）。
    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        match self
            .own
            .iter()
            .find(|tool| tool.name() == name || tool.aliases().contains(&name))
        {
            Some(tool) if self.base.hides(tool.name()) => None,
            Some(tool) => Some(tool.clone()),
            None => self.base.find_for(session, name),
        }
    }

    fn hides(&self, name: &str) -> bool {
        self.base.hides(name)
    }

    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.base.withheld(name)
    }
}

pub struct Agents {
    core: Arc<Core>,
    registry: Arc<AgentRegistry>,
}

impl Agents {
    pub fn new(ports: AgentsPorts, base: Arc<dyn ToolRegistry>, config: AgentsConfig) -> Self {
        let live = Arc::new(Live::new(ports.clock.clone()));
        let registry = Arc::new_cyclic(|registry: &Weak<AgentRegistry>| {
            let core = Arc::new(Core {
                catalog: ports.catalog.clone(),
                board: TaskBoard::new(ports.tasks.clone(), &ports.spawner),
                ports,
                runs: Arc::default(),
                live,
                hub: Hub::default(),
                monitors: monitors::MonitorBoard::default(),
                keep_alive: config.keep_alive,
                background_prompts: config.background_prompts,
                fork: config.fork,
                registry: registry.clone(),
            });
            let mut own: Vec<Arc<dyn Tool>> = vec![Arc::new(AgentTool { core: core.clone() })];
            own.extend(messaging::tools(&core));
            if config.task_tools {
                own.extend(tasks::tools(&core));
            }
            AgentRegistry { base, own, core }
        });
        Self {
            core: registry.core.clone(),
            registry,
        }
    }

    /// 主线程的工具注册表。
    pub fn registry(&self) -> Arc<dyn ToolRegistry> {
        self.registry.clone()
    }

    /// 包住主循环：登记每次运行的模型与模式，Agent 工具按 `RunId` 取父运行的值。
    pub fn track(&self, runner: Arc<dyn QueryRunner>) -> Arc<dyn QueryRunner> {
        Arc::new(Tracked {
            inner: runner,
            book: self.core.runs.clone(),
        })
    }

    /// 交给会话 actor 的信号来源。
    pub fn signals(&self) -> Arc<dyn AgentSignals> {
        Arc::new(Signals(self.core.clone()))
    }

    /// 任务提醒读的任务清单（agents.md §7.4）：子会话读顶层会话的清单。
    pub fn task_reader(&self) -> Arc<dyn rust_cli_kernel_api::agents::TaskReader> {
        Arc::new(TaskLists(self.core.clone()))
    }

    /// 往会话投递一条后台通知（DWF 升级问答）：与后台子代理的终态通知同一条路——meta user
    /// 消息、空闲时开回合、提交后按 seq ack、按文字去重。
    pub fn notify(&self, session: &SessionId, status: &str, text: String) -> u64 {
        self.core.hub.notify(
            session,
            AgentId::new("workflow"),
            status,
            rust_cli_base::reminder::wrap(&text),
        )
    }
}

impl rust_cli_kernel_api::workflow::WorkflowNotices for Agents {
    fn notify(&self, session: &SessionId, text: String) {
        let _ = self.notify(session, "escalation", text);
    }
}

struct TaskLists(Arc<Core>);

#[async_trait]
impl rust_cli_kernel_api::agents::TaskReader for TaskLists {
    async fn tasks(&self, session: &SessionId) -> Vec<rust_cli_kernel_api::agents::TaskRecord> {
        let list = self.0.live.root_of(session);
        let mut tasks = match self.0.board.read(&list).await {
            Ok(list) => list.tasks,
            Err(error) => {
                tracing::warn!(%error, "the task list could not be read for the reminder");
                Vec::new()
            }
        };
        // 按数字 ID 升序（ID 是递增的十进制数）。
        tasks.sort_by_key(|task| task.id.parse::<u64>().unwrap_or(u64::MAX));
        tasks
    }
}

struct Signals(Arc<Core>);

#[async_trait]
impl AgentSignals for Signals {
    fn signals(&self, session: &SessionId) -> BoxStream<'static, AgentSignal> {
        self.0.hub.subscribe(session)
    }

    async fn ack(&self, session: &SessionId, seq: u64) {
        self.0.hub.ack(session, seq);
    }

    async fn background(&self, session: &SessionId) -> Vec<AgentId> {
        // 先看运行状态、再看通知：子代理结束时在同一把锁里送出通知再标记结束（`routing`），所以读到
        // “已结束”时通知一定已在等候（或已 ack），两次读之间不会两头都落空。嵌套的后台子代理也算：
        // 它的通知可能送到这个顶层会话（agents.md §5.1）。
        let mut agents: Vec<AgentId> = self
            .0
            .live
            .background_in(session)
            .into_iter()
            .map(|agent| agent.agent)
            .collect();
        for pending in self.0.hub.pending(session) {
            if !agents.contains(&pending) {
                agents.push(pending);
            }
        }
        // 子代理子会话里还在跑或通知未 ack 的后台命令（agents.md §5.2 第 4 条，L18）。转发任务先交出通知
        // 再 ack，所以一条通知要么还在执行环境里、要么已在子代理的邮箱或 `signals::Hub` 里，没有两头都看不到的空档。
        for command in shell_notices::background_commands(&self.0, session).await {
            if !agents.contains(&command) {
                agents.push(command);
            }
        }
        agents
    }

    /// 还在跑的后台子代理（含停放的；与 TaskStop 的“能停”同一个判断，tui-display.md §3.1）。
    async fn background_entries(
        &self,
        session: &SessionId,
    ) -> Vec<rust_cli_kernel_api::manage::BackgroundEntry> {
        self.0
            .live
            .background_in(session)
            .iter()
            .map(views::background_entry)
            .collect()
    }

    /// 用户停止（`/tasks`）：主线程的可见范围，与 TaskStop 工具同一个函数。
    async fn stop_task(
        &self,
        session: &SessionId,
        task: &str,
        operation: rust_cli_kernel_api::env::OperationContext,
    ) -> Result<String, String> {
        let tool = task_stop::TaskStopTool {
            core: self.0.clone(),
        };
        let caller = task_stop::Caller {
            session,
            agent: None,
            machine: &self.0.ports.machine,
            operation: &operation,
        };
        tool.stop(task, &caller)
            .await
            .map(|stopped| stopped.message())
            .map_err(|error| error.to_string())
    }

    /// 输入框下面的子代理列表（tui-panels.md §1.1）。
    async fn subagents(
        &self,
        session: &SessionId,
    ) -> Vec<rust_cli_kernel_api::panels::SubagentEntry> {
        views::entries(&self.0.live, session)
    }

    fn subagent_changes(&self) -> BoxStream<'static, ()> {
        views::changes(&self.0.live)
    }

    /// 列表的行与 pill 里的子代理：`live::Live` 的同一次读取（修复线 F34）。
    async fn tasks_snapshot(
        &self,
        session: &SessionId,
    ) -> rust_cli_kernel_api::panels::TasksSnapshot {
        views::tasks(&self.0.live, session)
    }

    /// 只读查看（tui-panels.md §1.4）：子会话的存储是唯一事实源。
    async fn subagent_view(
        &self,
        session: &SessionId,
        agent: &AgentId,
    ) -> Result<
        rust_cli_kernel_api::session_api::SessionView,
        rust_cli_kernel_api::session_api::KernelError,
    > {
        views::view(&self.0, session, agent).await
    }
}

#[cfg(test)]
mod test_support;

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "machines_tests.rs"]
mod machines_tests;

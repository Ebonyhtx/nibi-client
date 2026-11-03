//! 扩展：skill、MCP、插件（docs/specs/rust-cli/ext.md）。
//!
//! - skill（[`skills`]）：来源与优先级、SKILL.md frontmatter、清单与预算、Skill 工具（参数替换、变量、
//!   `!` 内联命令）、`paths` 条件激活；
//! - MCP（[`mcp`]）：连接管理（握手、工具清单、调用、通知、重连）、工具命名与包装、结果转换与截断、
//!   instructions、resources；传输经 kernel-api 的 [`McpTransport`]，本地实现在 env-local；
//! - 插件（[`plugins`]）：来源与启用判定、目录与 manifest，提供 skill、MCP 服务器、agent 与 hooks。
//!
//! 不做 IO：文件经执行环境端口，MCP 消息经传输端口，任务经 base 的 [`Spawner`]。runtime 组装：
//! [`Ext::registry`] 包住基础工具注册表（加上 Skill 与 MCP 工具），[`Ext::listings`] 是 skill 清单与
//! MCP instructions 的来源，[`Ext::start`] 在内核建好后开始连接 MCP 服务器。

#[cfg(test)]
mod clock_tests;
pub mod mcp;
pub mod plugins;
pub mod skills;
#[cfg(test)]
mod test_support;

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_kernel_api::clock::{Clock, Ids};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::listing::{ListingEntry, ListingSource, Listings};
use rust_cli_kernel_api::machine::{EnvInfo, Files};
use rust_cli_kernel_api::mcp::McpTransport;
use rust_cli_kernel_api::mcp_state::{McpConnections, WAIT_FOR_MCP_SERVERS};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::orchestration::{
    ContextRequest, OrchestrationError, ToolRegistry, ToolSnapshot,
};
use rust_cli_kernel_api::tool::Tool;
use rust_cli_policy::PolicyGate;

pub use mcp::{McpManager, McpScope, McpServer, McpServers, McpSettings};
pub use mcp::{McpTelemetry, McpTelemetrySetup, McpTelemetrySlot};
pub use plugins::{Plugin, PluginAgentFile, PluginSources, Plugins};
pub use skills::{Skill, SkillCatalog, SkillCommands, SkillSource, SkillTool};

use mcp::SessionMcp;

/// ext 用到的端口，由 runtime 注入。
#[derive(Clone)]
pub struct ExtPorts {
    /// skill、插件都是本机的文件（工作区、用户目录、插件缓存），经本机的端口读（runtime 从注册表的本机取，
    /// remote-exec.md §3、§15.8.1）。
    pub info: Arc<dyn EnvInfo>,
    pub files: Arc<dyn Files>,
    pub ids: Arc<dyn Ids>,
    /// Skill 的 `!` 命令用判决链（带 skill 的 `allowed-tools`，ext.md §2.5）。
    pub gate: Arc<PolicyGate>,
    pub mcp: Arc<dyn McpTransport>,
    /// 远端机器的注册表（R5，remote-exec.md §22.6）：绑定到远端机器的 MCP 服务器从这里取那台机器的管道；None 时
    /// （只给测试的组装）它们都连不上。
    pub machines: Option<Arc<dyn rust_cli_kernel_api::env_registry::EnvironmentRegistry>>,
    /// MCP 的连接任务在这里启动。
    pub spawner: Spawner,
    /// MCP 等待的截止时刻（ext.md §3.3.1、§3.8）。
    pub clock: Arc<dyn Clock>,
    /// MCP 进程遥测（`process/mcpTelemetry`，141 审计 §9 F3）：入口给的通道与加盐用的设备标识。
    /// None 时什么都不发（TUI、测试）。
    pub mcp_telemetry: Option<mcp::McpTelemetrySetup>,
}

/// 入口层给出的配置快照。
#[derive(Debug, Clone, Default)]
pub struct ExtConfig {
    /// MCP 服务器、连接与调用的超时、输出上限（ext.md §3.1）。
    pub mcp: McpSettings,
    /// 插件目录（`--plugin-dir`，执行环境里的路径，ext.md §4）。
    pub plugin_dirs: Vec<EnvPath>,
    /// Node 配置与已安装插件给出的候选目录与启用设置（ext.md §4.1、config.md §2.1）。
    pub plugins: PluginSources,
    /// MCP 服务器与插件所在的工作区（stdio 服务器的 cwd）；None 时不连接 MCP、不加载插件。
    pub workspace: Option<WorkspaceRef>,
    /// 配置里停用的 MCP 服务器（`enabled: false`）：登记为 disabled、不连接，`/mcp enable` 时才连
    /// （docs/specs/rust-cli/tui-manage.md §6.1）。
    pub mcp_disabled: Vec<McpServer>,
}

pub struct Ext {
    skills: Arc<SkillCatalog>,
    commands: Arc<SkillCommands>,
    mcp: Arc<McpManager>,
    /// 会话级的 MCP（NIBI `createSession.mcpServers`）：每个会话一套连接，见 [`SessionMcp`]。
    session_mcp: Arc<SessionMcp>,
    /// `mcp/list` 的状态检查：每个工作区一套独立连接（141 审计 §9 第 6 项）。
    status_mcp: Arc<mcp::McpStatusRegistry>,
    registry: Arc<ExtRegistry>,
    /// 插件目录（`--plugin-dir` 与入口给的候选，都在本机）。
    files: Arc<dyn Files>,
    config: ExtConfig,
}

impl Ext {
    /// `base` 是基础工具注册表（文件、Bash 等）；Skill 的 `!` 命令用其中的 `Bash`。
    pub fn new(ports: ExtPorts, base: Arc<dyn ToolRegistry>, config: ExtConfig) -> Self {
        let skills = Arc::new(SkillCatalog::new(ports.info.clone(), ports.files.clone()));
        let runner = base
            .find("Bash")
            .map(|bash| skills::runner(bash, ports.gate.clone(), ports.ids.clone()));
        // 用户调用（`/<名字>`，ext.md §2.7）与 Skill 工具共用目录与 `!` 命令的执行者。
        let commands = Arc::new(SkillCommands::new(skills.clone(), runner.clone()));
        let skill_tool: Arc<dyn Tool> =
            Arc::new(SkillTool::new(skills.clone(), ports.ids.clone(), runner));
        // 进程遥测的出口（两个 manager 共用一份：`mcpId` 的盐只算一次）。
        let telemetry = ports
            .mcp_telemetry
            .as_ref()
            .map(|setup| mcp::McpTelemetry::new(setup.sink.clone(), setup.id_salt.clone()));
        let mcp = Arc::new(McpManager::new(
            ports.mcp.clone(),
            ports.spawner.clone(),
            config.mcp.clone(),
            ports.clock.clone(),
        ));
        if let Some(telemetry) = telemetry.clone() {
            // 进程级配置的服务器跨会话复用（Node 的 workspace 隔离）。
            mcp.attach_telemetry(mcp::McpTelemetrySlot {
                telemetry,
                isolation: "workspace",
                session: None,
            });
        }
        if let Some(machines) = ports.machines.clone() {
            mcp.set_machines(machines);
        }
        // 会话级 MCP 用同一套传输/任务/时钟；每会话一个 manager（见 SessionMcp）。
        let session_mcp = Arc::new(SessionMcp::new(
            ports.mcp.clone(),
            ports.spawner.clone(),
            config.mcp.clone(),
            ports.clock.clone(),
            telemetry.clone(),
        ));
        // `mcp/list` 的状态检查（141 审计 §9 第 6 项）：每工作区一套独立连接，与上面两套都不混。
        let status_mcp = Arc::new(mcp::McpStatusRegistry::new(
            ports.mcp.clone(),
            ports.spawner.clone(),
            config.mcp.clone(),
            ports.clock.clone(),
            telemetry,
        ));
        let registry = Arc::new(ExtRegistry {
            base,
            skill: skill_tool,
            wait: Arc::new(mcp::WaitForMcpServers::new(Arc::downgrade(&mcp))),
            mcp: mcp.clone(),
            sessions: session_mcp.clone(),
        });
        Self {
            skills,
            commands,
            mcp,
            session_mcp,
            status_mcp,
            registry,
            files: ports.files,
            config,
        }
    }

    /// 主线程的工具注册表：基础工具、Skill、MCP 工具（ext.md §1）。
    /// 单次的 `-p`：内置 `/loop` 的 Monitor 超时随它（tools-more.md §17.1）。
    pub fn set_print_session(&self, print: bool) {
        self.skills.set_print_session(print);
        self.mcp.set_print_session(print);
    }

    pub fn registry(&self) -> Arc<dyn ToolRegistry> {
        self.registry.clone()
    }

    /// skill 清单与 MCP instructions 的来源。
    pub fn listings(&self) -> Arc<dyn ListingSource> {
        Arc::new(ExtListings {
            skills: self.skills.clone(),
            mcp: self.mcp.clone(),
        })
    }

    pub fn skills(&self) -> &Arc<SkillCatalog> {
        &self.skills
    }

    /// 用户调用 skill 的展开与斜杠补全（ext.md §2.7）。
    pub fn user_commands(&self) -> Arc<dyn rust_cli_kernel_api::user_command::UserCommands> {
        self.commands.clone()
    }

    pub fn mcp(&self) -> &Arc<McpManager> {
        &self.mcp
    }

    /// 全部仍在运行的 MCP 子进程（`process/childProcesses`）：进程级配置、会话级连接与状态页的连接都算，
    /// 同一 manager 被多个会话继承时只列一次。
    pub fn mcp_child_processes(&self) -> Vec<rust_cli_kernel_api::mcp_state::McpChildProcess> {
        use rust_cli_kernel_api::mcp_state::McpConnections;
        let mut all = self.mcp.processes();
        for manager in self.session_mcp.managers() {
            all.extend(manager.processes());
        }
        for manager in self.status_mcp.managers() {
            all.extend(manager.processes());
        }
        all
    }

    /// 五分钟资源采样的目标（`process/mcpResourceSamples`）：与上面同一份清单，另带遥测身份。
    pub fn mcp_resource_targets(&self) -> Vec<rust_cli_kernel_api::process_table::McpResourceTarget> {
        use rust_cli_kernel_api::mcp_state::McpConnections;
        let mut all = self.mcp.resource_targets();
        for manager in self.session_mcp.managers() {
            all.extend(manager.resource_targets());
        }
        for manager in self.status_mcp.managers() {
            all.extend(manager.resource_targets());
        }
        all
    }

    /// `mcp/list`（141 审计 §9 第 6 项）：`connect` 收敛状态页的连接集合并等连接落定，`status` 只读快照。
    /// 状态页的连接与会话级/进程级的连接都不混（Node 的 mcp/list 专用进程同语义）。
    pub async fn mcp_list(
        &self,
        request: rust_cli_kernel_api::mcp_status::McpListRequest,
    ) -> Vec<rust_cli_kernel_api::mcp_status::McpServerStatus> {
        self.status_mcp.list(request).await
    }

    /// 给会话装上创建期给的 MCP 服务器（NIBI `createSession.mcpServers`）：连接在后台建立，不改进程级配置。
    /// 这个会话的工具表从此就是这批服务器（与 Node 的 runtimeConfig.mcp 同语义）。
    pub fn start_session_mcp(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        servers: Vec<rust_cli_kernel_api::mcp_session::SessionMcpServer>,
    ) {
        self.session_mcp.start(session, workspace, servers);
    }

    /// 会话关闭：释放它的 MCP 连接与连接任务（在后台任务里关，不等 IO）。
    pub fn release_session(&self, session: &SessionId) {
        self.session_mcp.stop(session);
    }

    /// 加载插件、开始连接 MCP 服务器（每个服务器一个连接任务，不等待）。返回加载好的插件：其中的
    /// agent 文件与 hooks 由 runtime 交给 agents 与 hooks（ext.md §4）。
    pub async fn start(&self) -> Plugins {
        let Some(workspace) = self.config.workspace.clone() else {
            return Plugins::default();
        };
        let loaded = plugins::load_all(
            self.files.as_ref(),
            &workspace,
            &self.config.plugin_dirs,
            &self.config.plugins,
        )
        .await
        .plugins;
        self.skills.set_plugin_roots(loaded.skill_roots());
        let plugin_servers = loaded.mcp_servers();
        let mut servers = self.config.mcp.servers.clone();
        servers.extend(plugin_servers.iter().cloned());
        self.mcp.start(workspace.clone(), servers);
        self.mcp.register_disabled(self.config.mcp_disabled.clone());
        // `mcp/list` 的缺省集合（`mcpServers` 缺席时）与插件服务器：状态页的连接从这里起。
        self.status_mcp.seed(
            workspace.root.as_str(),
            self.config.mcp.servers.clone(),
            plugin_servers,
        );
        loaded
    }

    /// `-p` 在第一个请求前的等待（ext.md §3.3.1）：alwaysLoad 的服务器与第一条命令前的 prewait，到期就开跑。
    pub async fn wait_for_print(&self) {
        self.mcp.wait_for_print().await;
    }
}

/// 基础工具在前，Skill 其次（有连接中的服务器时再加 WaitForMcpServers），MCP 工具最后（MCP 工具是连接任务发布的
/// 快照）。发给模型前按名字排序（tools-more.md §3.3）。
struct ExtRegistry {
    base: Arc<dyn ToolRegistry>,
    skill: Arc<dyn Tool>,
    /// WaitForMcpServers（ext.md §3.8）：有 Pending 的服务器、或这个会话带过它（declared）时在工具表里。启用 ToolSearch
    /// 时由主循环去掉（tools-more.md §3.3 第 4 条）。进程级的那一个；会话带了自己的服务器时另按会话建。
    wait: Arc<dyn Tool>,
    mcp: Arc<McpManager>,
    /// 会话级的 MCP（NIBI `createSession.mcpServers`）。
    sessions: Arc<SessionMcp>,
}

impl ExtRegistry {
    fn assemble(&self, wait: Option<Arc<dyn Tool>>, mcp: Vec<Arc<dyn Tool>>) -> Vec<Arc<dyn Tool>> {
        let mut tools = self.base.tools();
        tools.push(self.skill.clone());
        if let Some(wait) = wait {
            tools.push(wait);
        }
        tools.extend(mcp);
        tools
    }

    /// 会话自己的 WaitForMcpServers：连接状态与 declared 都在这个会话的 manager 里。
    fn session_wait(manager: &Arc<McpManager>) -> Arc<dyn Tool> {
        Arc::new(mcp::WaitForMcpServers::new(Arc::downgrade(manager)))
    }
}

impl ToolRegistry for ExtRegistry {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let wait = self.mcp.has_pending().then(|| self.wait.clone());
        self.assemble(wait, self.mcp.tools())
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        if name == self.skill.name() {
            return Some(self.skill.clone());
        }
        // 快照里带过它、之后服务器连上了，这次调用照常执行（按请求时的工具表找）：有服务器就找得到。
        if name == WAIT_FOR_MCP_SERVERS && self.mcp.has_servers() {
            return Some(self.wait.clone());
        }
        self.base.find(name).or_else(|| self.mcp.find(name))
    }

    /// 会话带了自己的 MCP 服务器时，工具只在自己会话里可见（Node 的 lease 模型）。
    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        let Some(manager) = self.sessions.manager(session) else {
            return self.find(name);
        };
        if name == self.skill.name() {
            return Some(self.skill.clone());
        }
        if name == WAIT_FOR_MCP_SERVERS && manager.has_servers() {
            return Some(Self::session_wait(&manager));
        }
        self.base
            .find(name)
            .or_else(|| manager.find(name))
    }

    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.base.withheld(name)
    }

    /// MCP 工具、连接中的服务器与 instructions 在同一把锁里取（query.md §1.3，修复线 F36）。
    fn snapshot(&self, session: &SessionId) -> ToolSnapshot {
        if let Some(manager) = self.sessions.manager(session) {
            let (tools, view) = manager.snapshot();
            let wait =
                (!view.pending().is_empty() || manager.declared(session))
                    .then(|| Self::session_wait(&manager));
            return ToolSnapshot {
                tools: self.assemble(wait, tools),
                mcp: Some(view),
            };
        }
        let (tools, view) = self.mcp.snapshot();
        let wait = !view.pending().is_empty() || self.mcp.declared(session);
        ToolSnapshot {
            tools: self.assemble(wait.then(|| self.wait.clone()), tools),
            mcp: Some(view),
        }
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        Some(self.mcp.clone())
    }

    fn mcp_for(&self, session: &SessionId) -> Option<Arc<dyn McpConnections>> {
        match self.sessions.manager(session) {
            Some(manager) => Some(manager),
            None => Some(self.mcp.clone()),
        }
    }

    /// 会话级 MCP：主循环在首个模型请求前等它离开 Pending（连接在 createSession 里后台启动）。
    fn session_mcp(&self, session: &SessionId) -> Option<Arc<dyn McpConnections>> {
        self.sessions
            .manager(session)
            .map(|manager| manager as Arc<dyn McpConnections>)
    }

    /// 子代理会话继承父会话的会话级 MCP（Node 的子代理 app 继承父 `config.mcp`）。
    fn inherit_session_mcp(&self, parent: &SessionId, child: &SessionId) {
        self.sessions.inherit(parent, child);
    }
}

struct ExtListings {
    skills: Arc<SkillCatalog>,
    mcp: Arc<McpManager>,
}

#[async_trait]
impl ListingSource for ExtListings {
    async fn listings(&self, request: &ContextRequest) -> Result<Listings, OrchestrationError> {
        self.listings_for(request, &[]).await
    }

    async fn listings_for(
        &self,
        request: &ContextRequest,
        history: &[Message],
    ) -> Result<Listings, OrchestrationError> {
        let skills = self
            .skills
            .listing(&request.workspace, history, &request.selection.model)
            .await;
        Ok(Listings {
            skills,
            ..Listings::default()
        })
    }

    /// 调用过的 skill（compact.md §3.4）。
    async fn invoked_skills(
        &self,
        request: &ContextRequest,
        history: &[Message],
    ) -> Result<Vec<rust_cli_kernel_api::listing::InvokedSkill>, OrchestrationError> {
        Ok(self.skills.invoked(&request.workspace, history).await)
    }

    /// 输入中间的 skill 提及（ext.md §2.8）。
    async fn skill_mentions(
        &self,
        request: &ContextRequest,
        input: &str,
    ) -> Result<Vec<String>, OrchestrationError> {
        Ok(self.skills.mentions(&request.workspace, input).await)
    }

    /// 有工具快照时用快照里的（与工具同一时点，query.md §1.3）；否则取现在的。
    async fn mcp_instructions(
        &self,
        request: &ContextRequest,
    ) -> Result<Vec<ListingEntry>, OrchestrationError> {
        Ok(match &request.mcp {
            Some(view) => view.instructions.clone(),
            None => self.mcp.instructions(),
        })
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

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
pub mod commands;
pub mod mcp;
pub mod plugins;
pub mod skills;
#[cfg(test)]
mod test_support;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use nibi_kernel_base::Spawner;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use nibi_kernel_api::clock::{Clock, Ids};
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::listing::{ListingEntry, ListingSource, Listings};
use nibi_kernel_api::machine::{EnvInfo, Files};
use nibi_kernel_api::mcp::McpTransport;
use nibi_kernel_api::mcp_state::{McpConnections, WAIT_FOR_MCP_SERVERS};
use nibi_kernel_api::paid_plugin::PaidPluginGate;
use nibi_kernel_api::mcp_ui::{
    McpResourceContent, McpResourcePage, McpResourceTemplatePage, McpUiCallToolRequest,
    McpUiCancelCallRequest, McpUiError, McpUiInstanceRequest, McpUiListRequest, McpUiReadRequest,
    McpUiSubscriptionRequest, visible_to_app,
};
use nibi_kernel_api::message::Message;
use nibi_kernel_api::orchestration::{
    ContextRequest, OrchestrationError, ToolRegistry, ToolSnapshot,
};
use nibi_kernel_api::tool::Tool;
use nibi_kernel_policy::PolicyGate;

pub use commands::{CommandSet, CustomCommand, CustomCommands, PluginCommandRoot};
pub use mcp::{McpManager, McpScope, McpServer, McpServers, McpSettings};
pub use mcp::{McpTelemetry, McpTelemetrySetup, McpTelemetrySlot};
pub use plugins::{Plugin, PluginAgentFile, PluginSources, Plugins};
pub use skills::{Skill, SkillCatalog, SkillCommands, SkillSource, SkillTool};

use mcp::SessionMcp;

/// `mcp/uiOpenInstance` 首次签发时等目标服务器离开 Pending 的窗口：与默认 `MCP_TIMEOUT`
/// （连接与握手 30s）同一个量级；服务器失败或超时后这一行按“不可用”拒绝。
const MCP_UI_OPEN_WAIT_MS: u64 = 30_000;

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
    pub machines: Option<Arc<dyn nibi_kernel_api::env_registry::EnvironmentRegistry>>,
    /// MCP 的连接任务在这里启动。
    pub spawner: Spawner,
    /// MCP 等待的截止时刻（ext.md §3.3.1、§3.8）。
    pub clock: Arc<dyn Clock>,
    /// MCP 进程遥测（`process/mcpTelemetry`，141 审计 §9 F3）：入口给的通道与加盐用的设备标识。
    /// None 时什么都不发（TUI、测试）。
    pub mcp_telemetry: Option<mcp::McpTelemetrySetup>,
    /// MCP 的 OAuth 令牌端口（Node 的 `AuthProvider`）：入口用共享凭据文件与网络出口实现；
    /// None 时带 `oauth` 的服务器按 401 失败（测试、嵌入）。
    pub mcp_oauth: Option<Arc<dyn nibi_kernel_api::mcp::McpOAuthPort>>,
    /// MCP Apps 的 UI 事件出口（`pluginUi.*` 增量）：入口接给协议层；None 时什么都不发。
    pub mcp_ui_events: Option<
        tokio::sync::mpsc::UnboundedSender<nibi_kernel_api::mcp_ui::McpUiEvent>,
    >,
    /// 回合外的一次模型请求（MCP Apps 采样）：runtime 用会话当前的模型选择实现；None 时
    /// `mcp/uiSampling` 如实报不支持（TUI、测试）。
    pub sampling: Option<Arc<dyn nibi_kernel_api::mcp_ui::McpUiSamplingPort>>,
}

/// 入口层给出的配置快照。
#[derive(Debug, Clone, Default)]
pub struct ExtConfig {
    /// MCP 服务器、连接与调用的超时、输出上限（ext.md §3.1）。
    pub mcp: McpSettings,
    /// 插件目录（`--plugin-dir`，执行环境里的路径，ext.md §4）。
    pub plugin_dirs: Vec<EnvPath>,
    /// 随包内置 skill 的根目录（Node `bundledSkillRoots`）：`<root>/<名字>/SKILL.md`。
    /// 入口从 `NIBI_BUNDLED_SKILLS_DIR` 读（桌面 Host 指向 `resources/nibi/packages/bundled-skills/skills`）。
    pub skill_roots: Vec<EnvPath>,
    /// `features.skill` 或 `skills.enabled` 为假时停用 skill（Node `createNodeSkillAdapter`）。
    pub skills_disabled: bool,
    /// `skill` / `command` 配置里最终停用的 `.md` 路径（Node `collectDisabledPaths`）。
    pub disabled_skill_paths: Vec<String>,
    pub disabled_command_paths: Vec<String>,
    /// Node 配置与已安装插件给出的候选目录与启用设置（ext.md §4.1、config.md §2.1）。
    pub plugins: PluginSources,
    /// MCP 服务器与插件所在的工作区（stdio 服务器的 cwd）；None 时不连接 MCP、不加载插件。
    pub workspace: Option<WorkspaceRef>,
    /// 插件声明里的 MCP 服务器只在会话快照里连接（桌面 app-server：每个会话一套，避免启动时多一套）。
    /// 插件元数据（skill/命令/agent/hooks）仍然在 `start()` 加载，供工作区级命令目录与引用面板使用。
    pub plugin_mcp_per_session: bool,
    /// 配置里停用的 MCP 服务器（`enabled: false`）：登记为 disabled、不连接，`/mcp enable` 时才连
    /// （docs/specs/rust-cli/tui-manage.md §6.1）。
    pub mcp_disabled: Vec<McpServer>,
}

pub struct Ext {
    skills: Arc<SkillCatalog>,
    /// 模型侧 Skill 工具（需要保留具体类型，执行期门禁要装到它上面）。
    skill_tool: Arc<skills::SkillTool>,
    commands: Arc<CommandSet>,
    mcp: Arc<McpManager>,
    /// 会话级的 MCP（NIBI `createSession.mcpServers`）：每个会话一套连接，见 [`SessionMcp`]。
    session_mcp: Arc<SessionMcp>,
    /// `mcp/list` 的状态检查：每个工作区一套独立连接（141 审计 §9 第 6 项）。
    status_mcp: Arc<mcp::McpStatusRegistry>,
    /// MCP Apps 的实例凭证（`mcp/ui*`）：进程级一本账，按 token 查。
    app_instances: Arc<mcp::McpAppInstances>,
    /// App-Provided Tools 的登记表（按会话）：模型工具表与实例信箱共用这一份。
    app_tools: Arc<mcp::AppToolRegistry>,
    /// 采样的额度与终态账本；`sampling` 是模型请求的出口（runtime 注入）。
    sampling_calls: Arc<mcp::SamplingCalls>,
    sampling: Option<Arc<dyn nibi_kernel_api::mcp_ui::McpUiSamplingPort>>,
    registry: Arc<ExtRegistry>,
    /// 插件目录（`--plugin-dir` 与入口给的候选，都在本机）。
    files: Arc<dyn Files>,
    config: ExtConfig,
    /// Composer `@` 插件面板的数据：进程级快照 + 每会话冻结的一份（NIBI `plugins/referenceCatalog`
    /// 的 session authority）。快照只活在这个进程里，不落库。
    plugin_catalog: std::sync::RwLock<PluginCatalogState>,
    /// 付费插件执行期门禁（工具表冻结，调用时复核）；入口装上，None 时不检查。
    paid_gate: RwLock<Option<Arc<dyn PaidPluginGate>>>,
    /// 服务器名 → 插件名（插件加载时更新，各 MCP manager 共享）。
    paid_owners: Arc<RwLock<HashMap<String, String>>>,
    /// 已加载过的付费插件名：门禁晚于 `start()` 装上时用它补登记。
    loaded_paid: RwLock<std::collections::BTreeSet<String>>,
}

/// 插件引用目录的进程级与会话级快照。会话关闭时删掉它那份；子代理继承父会话（Node 子代理 app 继承父 app）。
#[derive(Default)]
struct PluginCatalogState {
    process: plugins::PluginCatalog,
    sessions: std::collections::HashMap<SessionId, plugins::PluginCatalog>,
}

impl Ext {
    /// `base` 是基础工具注册表（文件、Bash 等）；Skill 的 `!` 命令用其中的 `Bash`。
    pub fn new(ports: ExtPorts, base: Arc<dyn ToolRegistry>, config: ExtConfig) -> Self {
        let skills = Arc::new(SkillCatalog::new(ports.info.clone(), ports.files.clone()));
        // Node `createNodeSkillAdapter`：`features.skill`/`skills.enabled` 为假时整层 skill 关闭；
        // `skill`/`command` 配置里的 `enable: false` 在发现阶段剔除单个文件。
        skills.set_enabled(!config.skills_disabled);
        skills.set_disabled_paths(config.disabled_skill_paths.clone());
        let runner = base
            .find("Bash")
            .map(|bash| skills::runner(bash, ports.gate.clone(), ports.ids.clone()));
        // 用户调用（`/<名字>`，ext.md §2.7）与 Skill 工具共用目录；Skill 的 `!` 命令仍在这里执行，
        // 自定义斜杠命令（`.nibi/commands`、`.agents/commands`、插件 `commands/`）的 `!` 块只改写成
        // Bash 指令、交给模型确认（修复线 A3），所以不需要执行者。与 Node 的 input facade 一致：
        // 自定义命令先于同名 skill。
        let skills_commands = Arc::new(SkillCommands::new(skills.clone(), runner.clone()));
        let custom_commands = Arc::new(commands::CustomCommands::new(
            ports.info.clone(),
            ports.files.clone(),
        ));
        custom_commands.set_disabled_paths(config.disabled_command_paths.clone());
        let commands = Arc::new(CommandSet::new(skills_commands, custom_commands));
        let skill_tool = Arc::new(SkillTool::new(skills.clone(), ports.ids.clone(), runner));
        let skill: Arc<dyn Tool> = skill_tool.clone();
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
        if let Some(oauth) = ports.mcp_oauth.clone() {
            mcp.attach_oauth(oauth);
        }
        if let Some(machines) = ports.machines.clone() {
            mcp.set_machines(machines);
        }
        // MCP Apps 的资源通知（`pluginUi.*`）：进程级 manager 也装上（会话语义之外的配置服务器）。
        if let Some(events) = ports.mcp_ui_events.clone() {
            mcp.attach_ui_events(events);
        }
        // 会话级 MCP 用同一套传输/任务/时钟；每会话一个 manager（见 SessionMcp）。
        let session_mcp = Arc::new(SessionMcp::new(
            ports.mcp.clone(),
            ports.spawner.clone(),
            config.mcp.clone(),
            ports.clock.clone(),
            telemetry.clone(),
            ports.mcp_ui_events.clone(),
            ports.mcp_oauth.clone(),
        ));
        // `mcp/list` 的状态检查（141 审计 §9 第 6 项）：每工作区一套独立连接，与上面两套都不混。
        let status_mcp = Arc::new(mcp::McpStatusRegistry::new(
            ports.mcp.clone(),
            ports.spawner.clone(),
            config.mcp.clone(),
            ports.clock.clone(),
            telemetry,
            ports.mcp_oauth.clone(),
        ));
        // App-Provided Tools 的登记表（`app__<server>__<tool>`）：按会话记实例、待执行调用与模型工具表。
        let app_tools = Arc::new(mcp::AppToolRegistry::new(
            ports.ids.clone(),
            ports.mcp_ui_events.clone(),
        ));
        let registry = Arc::new(ExtRegistry {
            base,
            skill,
            wait: Arc::new(mcp::WaitForMcpServers::new(Arc::downgrade(&mcp))),
            mcp: mcp.clone(),
            sessions: session_mcp.clone(),
            app_tools: app_tools.clone(),
        });
        // MCP Apps 的凭证账本：进程级一个实例标识（Node 每个 agent 进程一个 `McpUiInstances`）。
        let app_instances = Arc::new(mcp::McpAppInstances::new(
            nibi_kernel_api::process_table::uuid_v4(),
        ));
        let sampling_calls = Arc::new(mcp::SamplingCalls::new());
        // 实例关闭 → `pluginUi.instanceClosed`（页面卸载）。凭证先移除、再取消令牌，这个回调在
        // 取消之后触发，迟到的结果拿不回执行权；进行中的采样一并取消（Node 的实例作用域 signal）。
        if let Some(events) = ports.mcp_ui_events.clone() {
            let sampling_calls = sampling_calls.clone();
            app_instances.set_on_closed(std::sync::Arc::new(move |binding, lease| {
                use nibi_kernel_api::mcp_ui::{McpUiEvent, McpUiSubscriber};
                sampling_calls.clear_instance(&lease.token);
                let plugin_id = nibi_kernel_api::mcp_telemetry::plugin_name(
                    &binding.server,
                    binding.server.starts_with("plugin:"),
                )
                .unwrap_or_else(|| binding.server.clone());
                let _ = events.send(McpUiEvent::InstanceClosed {
                    session: SessionId::new(binding.session.clone()),
                    plugin_id,
                    server: binding.server.clone(),
                    subscribers: vec![McpUiSubscriber {
                        scope_id: lease.token.clone(),
                        generation: lease.generation,
                        instance: lease.clone(),
                    }],
                });
            }));
        } else {
            let sampling_calls = sampling_calls.clone();
            app_instances.set_on_closed(std::sync::Arc::new(move |_binding, lease| {
                sampling_calls.clear_instance(&lease.token);
            }));
        }
        // 连接断了：进程级 manager 管到的页面实例按服务器作废（会话级 manager 在 SessionMcp 里各自接）。
        session_mcp.set_app_instances(app_instances.clone());
        {
            let instances = app_instances.clone();
            mcp.set_on_connection_lost(std::sync::Arc::new(move |server| {
                instances.close_server(None, server);
            }));
        }
        // 付费插件的服务器归属表：进程级、会话级与状态页的 manager 共用一份；插件快照变化时更新。
        let paid_owners = Arc::new(RwLock::new(HashMap::new()));
        mcp.attach_paid_owners(paid_owners.clone());
        session_mcp.attach_paid_owners(paid_owners.clone());
        status_mcp.attach_paid_owners(paid_owners.clone());
        Self {
            skills,
            skill_tool,
            commands,
            mcp,
            session_mcp,
            status_mcp,
            app_instances,
            app_tools,
            sampling_calls,
            sampling: ports.sampling,
            registry,
            files: ports.files,
            config,
            plugin_catalog: std::sync::RwLock::new(PluginCatalogState::default()),
            paid_gate: RwLock::new(None),
            paid_owners,
            loaded_paid: RwLock::new(std::collections::BTreeSet::new()),
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
    pub fn user_commands(&self) -> Arc<dyn nibi_kernel_api::user_command::UserCommands> {
        self.commands.clone()
    }

    pub fn mcp(&self) -> &Arc<McpManager> {
        &self.mcp
    }

    /// 全部仍在运行的 MCP 子进程（`process/childProcesses`）：进程级配置、会话级连接与状态页的连接都算，
    /// 同一 manager 被多个会话继承时只列一次。
    pub fn mcp_child_processes(&self) -> Vec<nibi_kernel_api::mcp_state::McpChildProcess> {
        use nibi_kernel_api::mcp_state::McpConnections;
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
    pub fn mcp_resource_targets(&self) -> Vec<nibi_kernel_api::process_table::McpResourceTarget> {
        use nibi_kernel_api::mcp_state::McpConnections;
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
        request: nibi_kernel_api::mcp_status::McpListRequest,
    ) -> Vec<nibi_kernel_api::mcp_status::McpServerStatus> {
        self.status_mcp.list(request).await
    }

    /// 一个会话的 MCP 连接：会话自己的那套，没带服务器时回落到进程级配置（Node 的 session → pool lease）。
    fn mcp_for_session(&self, session: &SessionId) -> Arc<mcp::SessionConnections> {
        self.session_mcp.manager_of(session).unwrap_or_else(|| {
            Arc::new(mcp::SessionConnections::single(self.mcp.clone()))
        })
    }

    /// `mcp/uiOpenInstance`：页面实例凭证（同一逻辑页面同连接代际幂等）。
    ///
    /// 首次签发要在服务器还在 `initialize` 时等它（Node `waitForAppConnection` 等 `connecting`
    /// 同一条）：桌面会在会话刚建、MCP 尚未 ready 时打开页面，立即回“不可用”会把等待态变成错误页。
    /// 已有凭证的校验路径仍然是同步拒绝（`mcp_ui_validate`）。
    /// MCP 服务器属于付费插件时，按当前 license 复核（资源、面板、App 工具共用）。
    fn check_paid_server(&self, server: &str) -> Result<(), String> {
        let plugin = self
            .paid_owners
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(server)
            .cloned();
        let Some(plugin) = plugin else {
            return Ok(());
        };
        let gate = self
            .paid_gate
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        match gate {
            Some(gate) => gate.check(&plugin),
            None => Ok(()),
        }
    }

    pub async fn mcp_ui_open(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiOpenRequest,
    ) -> Result<nibi_kernel_api::mcp_ui::McpAppInstance, nibi_kernel_api::mcp_ui::McpUiError>
    {
        self.check_paid_server(&request.scope.server_name)
            .map_err(nibi_kernel_api::mcp_ui::McpUiError::failed)?;
        let manager = self.mcp_for_session(&request.scope.session);
        if manager.app_connection(&request.scope.server_name).is_none() {
            // 与默认 `MCP_TIMEOUT`（连接与握手 30s）同一窗口；连不上时这一行之后仍是“不可用”。
            let server = request.scope.server_name.clone();
            manager
                .wait(
                    MCP_UI_OPEN_WAIT_MS,
                    &move |view: &nibi_kernel_api::mcp_state::McpView| {
                        !view
                            .servers
                            .iter()
                            .any(|row| {
                                row.name == server
                                    && row.state
                                        == nibi_kernel_api::manage::McpServerState::Pending
                            })
                    },
                )
                .await;
        }
        let connection = manager
            .app_connection(&request.scope.server_name)
            .ok_or_else(nibi_kernel_api::mcp_ui::McpUiError::app_unavailable)?;
        Ok(self.app_instances.open(request, connection))
    }

    /// `mcp/uiCloseInstance`：`only_if_idle` 时只关没有进行中调用的实例；未知凭证不报错（Node 幂等）。
    pub async fn mcp_ui_close(
        &self,
        request: McpUiInstanceRequest,
        only_if_idle: bool,
    ) -> Result<bool, McpUiError> {
        match self.app_instances.validate_bound(&request) {
            Ok(()) => {}
            // 凭证已经不在了：幂等，没有可关的东西（Node 只校验还在册的那些）。
            Err(_) if !self.app_instances.is_known(&request.instance.token) => return Ok(true),
            // 在册但作用域/代际对不上：不能用别的会话或来源的凭证撤销页面。
            Err(error) => return Err(error),
        }
        if only_if_idle && self.app_instances.is_busy(&request.instance) {
            return Ok(false);
        }
        self.app_instances.close(&request.instance);
        self.forget_instance(&request.scope.session, &request.instance.token)
            .await;
        Ok(true)
    }

    /// `mcp/uiValidateInstance`：凭证、作用域与当前连接三者都对上才算有效。
    pub async fn mcp_ui_validate(
        &self,
        request: McpUiInstanceRequest,
    ) -> Result<(), McpUiError> {
        self.check_instance(&request).await.map(|_| ())
    }

    /// 校验实例；不通过时（连接换代已经把凭证撤销）把它的资源订阅一并退掉。
    async fn check_instance(&self, request: &McpUiInstanceRequest) -> Result<String, McpUiError> {
        let manager = self.mcp_for_session(&request.scope.session);
        let current = manager.app_connection(&request.scope.server_name);
        match self.app_instances.validate(request, current) {
            Ok(bound) => Ok(bound),
            Err(error) => {
                self.forget_instance(&request.scope.session, &request.instance.token)
                    .await;
                Err(error)
            }
        }
    }

    /// 实例作废之后退掉它的资源订阅（`session|token|` 前缀；退订是尽力而为）。
    async fn forget_instance(&self, session: &SessionId, token: &str) {
        let prefix = format!("{}|{token}|", session.as_str());
        self.mcp_for_session(session)
            .unsubscribe_resources_for(&prefix)
            .await;
    }

    /// `mcp/readResource`：宿主取页面 HTML；`uri` 必须是实例绑定的那个资源。
    pub async fn mcp_ui_read_resource(
        &self,
        request: McpUiReadRequest,
    ) -> Result<Vec<McpResourceContent>, McpUiError> {
        self.check_paid_server(&request.instance.scope.server_name)
            .map_err(McpUiError::failed)?;
        let manager = self.mcp_for_session(&request.instance.scope.session);
        let bound = self.check_instance(&request.instance).await?;
        if bound != request.uri {
            return Err(McpUiError::binding_mismatch());
        }
        manager
            .read_resource(&request.instance.scope.server_name, &request.uri)
            .await
    }

    /// `mcp/uiReadResource`：页面发起的资源读取（`_meta` 与大小/MIME 的界在协议层）。
    pub async fn mcp_ui_read_resource_for_ui(
        &self,
        request: McpUiReadRequest,
    ) -> Result<Vec<McpResourceContent>, McpUiError> {
        self.check_paid_server(&request.instance.scope.server_name)
            .map_err(McpUiError::failed)?;
        let manager = self.mcp_for_session(&request.instance.scope.session);
        self.check_instance(&request.instance).await?;
        manager
            .read_resource(&request.instance.scope.server_name, &request.uri)
            .await
    }

    /// `mcp/uiListResources`：页面发起的 `resources/list`（一页，游标透传）。
    pub async fn mcp_ui_list_resources(
        &self,
        request: McpUiListRequest,
    ) -> Result<McpResourcePage, McpUiError> {
        self.check_paid_server(&request.instance.scope.server_name)
            .map_err(McpUiError::failed)?;
        let manager = self.mcp_for_session(&request.instance.scope.session);
        self.check_instance(&request.instance).await?;
        manager
            .list_resources(
                &request.instance.scope.server_name,
                request.cursor.as_deref(),
            )
            .await
    }

    /// `mcp/uiListResourceTemplates`：页面发起的 `resources/templates/list`（一页）。
    pub async fn mcp_ui_list_resource_templates(
        &self,
        request: McpUiListRequest,
    ) -> Result<McpResourceTemplatePage, McpUiError> {
        self.check_paid_server(&request.instance.scope.server_name)
            .map_err(McpUiError::failed)?;
        let manager = self.mcp_for_session(&request.instance.scope.session);
        self.check_instance(&request.instance).await?;
        manager
            .list_resource_templates(
                &request.instance.scope.server_name,
                request.cursor.as_deref(),
            )
            .await
    }

    /// `mcp/uiSubscribeResource`：页面订阅一个资源（引用计数与断线重放都在连接管理里）。
    pub async fn mcp_ui_subscribe(
        &self,
        request: McpUiSubscriptionRequest,
    ) -> Result<(), McpUiError> {
        self.check_paid_server(&request.instance.scope.server_name)
            .map_err(McpUiError::failed)?;
        let key = subscription_key(&request)?;
        self.check_instance(&request.instance).await?;
        self.mcp_for_session(&request.instance.scope.session)
            .subscribe_resource(
                &request.instance.scope.server_name,
                &request.uri,
                &key,
                &request.instance.instance,
            )
            .await
    }

    /// `mcp/uiUnsubscribeResource`：页面退订一个资源（最后一个订阅者退订时通知服务器）。
    pub async fn mcp_ui_unsubscribe(
        &self,
        request: McpUiSubscriptionRequest,
    ) -> Result<(), McpUiError> {
        let key = subscription_key(&request)?;
        self.check_instance(&request.instance).await?;
        self.mcp_for_session(&request.instance.scope.session)
            .unsubscribe_resource(
                &request.instance.scope.server_name,
                &request.uri,
                &key,
            )
            .await
    }

    /// `mcp/uiCallTool` 的审批目标：实例校验通过后给出服务器列出的那个工具（带 schema、只读标记与
    /// 可见性）。工具不存在与只给模型用是 Node 的两种 `-32602` 原因，这里分开报。
    pub async fn mcp_ui_app_tool(
        &self,
        request: &McpUiInstanceRequest,
        tool_name: &str,
    ) -> Result<Arc<dyn Tool>, McpUiError> {
        self.check_instance(request).await?;
        let server = &request.scope.server_name;
        let manager = self.mcp_for_session(&request.scope.session);
        let Some(visibility) = manager.app_tool_visibility(server, tool_name) else {
            return Err(McpUiError::tool_not_found(server, tool_name));
        };
        if !visible_to_app(&visibility) {
            return Err(McpUiError::tool_not_app_visible(server, tool_name));
        }
        manager
            .ui_tool(server, tool_name)
            .ok_or_else(|| McpUiError::tool_not_found(server, tool_name))
    }

    /// 接纳一个页面工具调用：去重、占住实例（`onlyIfIdle` 会看到它），并给出取消令牌。
    /// 审批与执行由 runtime 做（审批链只在它那里）；账本随返回的 [`CallGuard`](mcp::CallGuard) 释放。
    pub fn mcp_ui_begin_call(
        &self,
        request: &McpUiCallToolRequest,
    ) -> Result<mcp::CallGuard, McpUiError> {
        self.app_instances.begin_call(
            request.instance.scope.session.as_str(),
            &request.instance.instance,
            &request.call_id,
        )
    }

    /// `mcp/uiCallTool` 的后半：用审批后的输入发 `tools/call`，结果是 MCP 的原始 `CallToolResult`。
    pub async fn mcp_ui_call_tool(
        &self,
        request: &McpUiCallToolRequest,
        input: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, McpUiError> {
        self.check_paid_server(&request.instance.scope.server_name)
            .map_err(McpUiError::failed)?;
        self.mcp_for_session(&request.instance.scope.session)
            .call_tool_for_ui(
                &request.instance.scope.server_name,
                &request.tool_name,
                input,
                cancel,
            )
            .await
    }

    /// `mcp/uiCancelCall`：取消进行中的调用；没有时 `false`（幂等）。归属与实例校验同调用。
    pub async fn mcp_ui_cancel_call(
        &self,
        request: McpUiCancelCallRequest,
    ) -> Result<bool, McpUiError> {
        self.check_instance(&request.instance).await?;
        Ok(self.app_instances.cancel_call(
            request.instance.scope.session.as_str(),
            &request.instance.instance,
            &request.call_id,
        ))
    }

    /// `mcp/uiRegisterAppTools`：登记一个页面实例的工具（同作用域的新代际替换旧代际），返回曝光部分。
    pub async fn mcp_ui_register_app_tools(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiRegisterAppToolsRequest,
    ) -> Result<Vec<nibi_kernel_api::mcp_ui::McpUiAppToolRegistration>, McpUiError> {
        self.check_instance(&request.instance).await?;
        check_app_tool_binding(&request.instance, &request.scope_id, request.generation)?;
        let session = request.instance.scope.session.clone();
        Ok(self.app_tools.register(&session, request))
    }

    /// `mcp/uiUnregisterAppTools`：收回实例的工具（页面卸载时的尽力收尾）。
    pub fn mcp_ui_unregister_app_tools(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiUnregisterAppToolsRequest,
    ) -> Result<usize, McpUiError> {
        check_app_tool_binding(&request.instance, &request.scope_id, request.generation)?;
        Ok(self.app_tools.unregister(
            &request.instance.scope.session,
            &request.scope_id,
            request.generation,
        ))
    }

    /// `mcp/uiClaimAppToolCall`：渲染端认领一次待执行调用。
    pub async fn mcp_ui_claim_app_tool_call(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiClaimAppToolCallRequest,
    ) -> Result<bool, McpUiError> {
        self.check_instance(&request.instance).await?;
        check_app_tool_binding(&request.instance, &request.scope_id, request.generation)?;
        Ok(self.app_tools.claim(
            &request.instance.scope.session,
            &request.scope_id,
            request.generation,
            &request.call_id,
        ))
    }

    /// `mcp/uiResolveAppToolCall`：页面执行完回传结果或错误。
    pub async fn mcp_ui_resolve_app_tool_call(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiResolveAppToolCallRequest,
    ) -> Result<bool, McpUiError> {
        self.check_instance(&request.instance).await?;
        check_app_tool_binding(&request.instance, &request.scope_id, request.generation)?;
        let outcome = match (request.result, request.error) {
            (Some(result), None) => Ok(result),
            (None, Some(error)) => Err(if error.is_empty() {
                "App tool failed".to_owned()
            } else {
                error
            }),
            _ => {
                return Err(McpUiError::failed(
                    "exactly one of result or error is required",
                ));
            }
        };
        Ok(self.app_tools.resolve(
            &request.instance.scope.session,
            &request.scope_id,
            request.generation,
            &request.call_id,
            outcome,
        ))
    }

    /// `mcp/uiSampling`：页面请求宿主模型采样一次（60 秒、并发与操作账本在 [`SamplingCalls`]）。
    pub async fn mcp_ui_sampling(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiSamplingRequest,
        selection: Option<nibi_kernel_api::model::ModelSelection>,
    ) -> Result<nibi_kernel_api::mcp_ui::McpUiSamplingResult, McpUiError> {
        self.check_paid_server(&request.instance.scope.server_name)
            .map_err(McpUiError::failed)?;
        self.check_instance(&request.instance).await?;
        let Some(port) = self.sampling.clone() else {
            return Err(McpUiError::unsupported(
                &request.instance.scope.server_name,
                "sampling",
            ));
        };
        let lease = &request.instance.instance;
        let Some((instance_cancel, retain)) = self.app_instances.retain(&lease.token) else {
            return Err(McpUiError::not_authorized());
        };
        let input = nibi_kernel_api::mcp_ui::McpUiSamplingInput {
            messages: request.messages.clone(),
            system_prompt: request.system_prompt.clone(),
            max_tokens: request.max_tokens,
            selection,
            // 用量行挂在发起会话名下（Node `sampleModel` 是会话运行时的方法）。
            session: Some(request.instance.scope.session.clone()),
        };
        let result = self
            .sampling_calls
            .execute(
                &request.instance.scope.session,
                &lease.token,
                &instance_cancel,
                &request.operation_id,
                |cancel| async move { port.sample(input, cancel).await },
            )
            .await;
        drop(retain);
        let result = result?;
        // 采样期间连接可能换代：结果只属于原连接（Node 在 sampleModel 前后各 validate 一次）。
        self.check_instance(&request.instance).await?;
        Ok(result)
    }

    /// `mcp/uiCancelSampling`：取消进行中的采样；没有时 `false`（幂等）。
    pub async fn mcp_ui_cancel_sampling(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiCancelSamplingRequest,
    ) -> Result<bool, McpUiError> {
        self.check_instance(&request.instance).await?;
        self.sampling_calls
            .cancel(&request.instance.instance.token, &request.operation_id)
    }

    /// 给会话装上创建期给的 MCP 服务器（NIBI `createSession.mcpServers`）：连接在后台建立，不改进程级配置。
    /// 这个会话的工具表从此就是这批服务器（与 Node 的 runtimeConfig.mcp 同语义）。
    pub fn start_session_mcp(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        servers: Vec<nibi_kernel_api::mcp_session::SessionMcpServer>,
    ) {
        self.session_mcp.start(session, workspace, servers);
    }

    /// 会话关闭：释放它的 MCP 连接与连接任务（在后台任务里关，不等 IO），页面实例一并作废。
    pub fn release_session(&self, session: &SessionId) {
        self.session_mcp.stop(session);
        self.app_instances.close_session(session.as_str());
        // App-Provided Tools 的登记与待执行调用随会话结束（Node `clearMcpUiAppToolsForSession`）。
        self.app_tools.clear_session(session);
    }

    /// 加载插件、开始连接 MCP 服务器（每个服务器一个连接任务，不等待）。返回加载好的插件：其中的
    /// agent 文件与 hooks 由 runtime 交给 agents 与 hooks（ext.md §4）。
    pub async fn start(&self) -> Plugins {
        // 随包内置 skill 与用户/项目/插件根并列发现（Node `bundledSkillRoots` 追加在插件根之后）。
        self.skills.set_extra_roots(
            self.config
                .skill_roots
                .iter()
                .map(|root| root.as_str().to_owned())
                .collect(),
        );
        let Some(workspace) = self.config.workspace.clone() else {
            return Plugins::default();
        };
        let loaded = plugins::load_all(
            self.files.as_ref(),
            &workspace,
            &self.config.plugin_dirs,
            &self.config.plugins,
        )
        .await;
        // Composer 的 `@` 插件面板（CLI/TUI 没有会话级 loader，用这份进程级快照）。
        *self
            .plugin_catalog
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = PluginCatalogState {
            process: loaded.catalog.clone(),
            sessions: std::collections::HashMap::new(),
        };
        let loaded = loaded.plugins;
        self.register_plugins(&loaded);
        self.skills.set_plugin_roots(loaded.skill_roots());
        self.commands.set_plugin_roots(loaded.command_roots());
        // 桌面 app-server：插件的 MCP 连接按会话建立（会话快照），启动这里只留元数据。
        let plugin_servers = if self.config.plugin_mcp_per_session {
            Vec::new()
        } else {
            loaded.mcp_servers()
        };
        let mut servers = self.config.mcp.servers.clone();
        servers.extend(plugin_servers.iter().cloned());
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

    /// 装上付费插件执行期门禁：工具表不增删，MCP/Skill/命令在真正执行时按当前 license 复核。
    /// 可以在 `start()` 之前或之后调用；之后调用时用已加载的插件名补登记。
    pub fn set_paid_gate(&self, gate: Arc<dyn PaidPluginGate>) {
        *self
            .paid_gate
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(gate.clone());
        self.mcp.attach_paid_gate(gate.clone());
        self.session_mcp.attach_paid_gate(gate.clone());
        self.status_mcp.attach_paid_gate(gate.clone());
        self.skill_tool.set_paid_gate(gate.clone());
        self.commands.set_paid_gate(gate.clone());
        for plugin in self
            .loaded_paid
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
        {
            gate.register(plugin);
        }
    }

    /// 会话级插件快照应用前调用：把付费插件名与服务器归属登记到执行期门禁。
    pub fn note_plugin_snapshot(&self, plugins: &Plugins) {
        self.register_plugins(plugins);
    }

    /// 插件快照加载后：登记付费插件名，合并服务器 → 插件归属。
    fn register_plugins(&self, plugins: &Plugins) {        let paid = plugins.paid_names();
        {
            let mut known = self
                .loaded_paid
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for plugin in &paid {
                known.insert(plugin.clone());
            }
        }
        if let Some(gate) = self
            .paid_gate
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            for plugin in &paid {
                gate.register(plugin);
            }
        }
        let mut owners = self
            .paid_owners
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (server, plugin) in plugins.mcp_owners() {
            owners.insert(server, plugin);
        }
    }

    /// `-p` 在第一个请求前的等待（ext.md §3.3.1）：alwaysLoad 的服务器与第一条命令前的 prewait，到期就开跑。
    pub async fn wait_for_print(&self) {
        self.mcp.wait_for_print().await;
    }

    /// 进程级配置的 MCP 服务器（不含插件）；会话要自己建 manager 时把它并进去。
    pub fn base_mcp_servers(&self) -> Vec<McpServer> {
        self.config.mcp.servers.clone()
    }

    /// 按当前插件来源加载一份完整快照（插件 + 引用面板的两份数据），不改进程级状态
    /// （会话级插件用；入口可在启动时换来源）。
    pub async fn plugin_snapshot(&self, workspace: &WorkspaceRef) -> plugins::Loaded {
        let loaded = plugins::load_all(
            self.files.as_ref(),
            workspace,
            &self.config.plugin_dirs,
            &self.config.plugins,
        )
        .await;
        // 会话级快照也要登记付费插件名与 MCP 服务器归属；工具表仍由这份快照冻结。
        self.register_plugins(&loaded.plugins);
        loaded
    }

    /// 把会话的插件快照装进 skill 目录；会话关闭时由 [`Ext::release_session`] 清掉。
    pub fn set_session_skill_roots(
        &self,
        session: SessionId,
        plugins: &Plugins,
    ) {
        self.skills
            .set_session_plugin_roots(session.clone(), plugins.skill_roots());
        self.commands
            .set_session_plugin_roots(session, plugins.command_roots());
    }

    /// 把这份插件快照的 MCP 服务器放进 `mcp/list` 的状态页种子（工作区级，取最近一次会话快照）。
    pub fn refresh_status_servers(
        &self,
        workspace: &WorkspaceRef,
        plugins: &Plugins,
    ) {
        self.status_mcp.seed(
            workspace.root.as_str(),
            self.base_mcp_servers(),
            plugins.mcp_servers(),
        );
    }

    /// 会话关闭时清掉 skill/命令快照（hooks/agents 由 runtime 各自清），连同它的插件引用目录。
    pub fn clear_session_plugins(&self, session: &SessionId) {
        self.skills.clear_session(session);
        self.commands.clear_session(session);
        self.plugin_catalog
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sessions
            .remove(session);
    }

    /// 子代理继承父会话的 skill/命令根。
    pub fn copy_session_skill_roots(&self, from: &SessionId, to: SessionId) {
        self.skills.copy_session(from, to.clone());
        self.commands.copy_session(from, to);
    }

    /// 会话创建/冷恢复时冻结它的插件引用目录（NIBI `plugins/referenceCatalog` 的 session authority）。
    pub fn set_session_plugin_catalog(&self, session: SessionId, catalog: plugins::PluginCatalog) {
        self.plugin_catalog
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sessions
            .insert(session, catalog);
    }

    /// 子代理继承父会话的引用目录（父会话不在时不装，调用方按新快照处理）。
    pub fn copy_session_plugin_catalog(&self, from: &SessionId, to: SessionId) {
        let mut state = self
            .plugin_catalog
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(catalog) = state.sessions.get(from).cloned() {
            state.sessions.insert(to, catalog);
        }
    }

    /// 会话冻结的引用目录；没有这个会话（或入口没有 loader）时为 None。
    pub fn session_plugin_catalog(&self, session: &SessionId) -> Option<plugins::PluginCatalog> {
        self.plugin_catalog
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sessions
            .get(session)
            .cloned()
    }

    /// 进程级引用目录（CLI/TUI 的启动快照）。
    pub fn process_plugin_catalog(&self) -> plugins::PluginCatalog {
        self.plugin_catalog
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .process
            .clone()
    }
}

/// 订阅键 = 会话 | 沙箱作用域 | 代际（Node `buildMcpUiSubscriberKey`）；作用域必须是实例的 token，
/// 代际必须是凭证的代际——两者都对上才允许订阅/退订（Node 的 "Invalid MCP App subscription binding"）。
/// App-Provided Tools 的绑定：沙箱作用域必须等于实例 token，代际必须等于凭证的代际。
fn check_app_tool_binding(
    request: &McpUiInstanceRequest,
    scope_id: &str,
    generation: u64,
) -> Result<(), McpUiError> {
    if scope_id != request.instance.token || generation != request.instance.generation {
        return Err(McpUiError::failed("Invalid MCP App binding"));
    }
    Ok(())
}

fn subscription_key(request: &McpUiSubscriptionRequest) -> Result<String, McpUiError> {
    let instance = &request.instance.instance;
    if request.scope_id != instance.token || request.generation != instance.generation {
        return Err(McpUiError::failed("Invalid MCP App subscription binding"));
    }
    Ok(format!(
        "{}|{}|{}",
        request.instance.scope.session.as_str(),
        request.scope_id,
        request.generation
    ))
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
    /// App-Provided Tools（`app__<server>__<tool>`）：只按会话进模型工具表。
    app_tools: Arc<mcp::AppToolRegistry>,
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

    /// 会话自己的 WaitForMcpServers：连接状态与 declared 都在这个会话的连接面里（含工作区共享的那部分）。
    fn session_wait(manager: &Arc<mcp::SessionConnections>) -> Arc<dyn Tool> {
        Arc::new(mcp::WaitForMcpServers::for_session(Arc::downgrade(manager)))
    }

    /// 把会话的 App-Provided Tools 接到工具表末尾：模型侧名字与已有工具冲突时以已有工具为准
    /// （Node 注册时的 `silentDuplicateWarning` 同一条）。
    fn with_app_tools(
        &self,
        session: &SessionId,
        mut tools: Vec<Arc<dyn Tool>>,
    ) -> Vec<Arc<dyn Tool>> {
        let mut names: std::collections::BTreeSet<String> =
            tools.iter().map(|tool| tool.name().to_owned()).collect();
        for tool in self.app_tools.tools_for(session) {
            if names.insert(tool.name().to_owned()) {
                tools.push(tool);
            }
        }
        tools
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

    /// 会话带了自己的 MCP 服务器时，工具只在自己会话里可见（Node 的 lease 模型）；App 工具的
    /// 模型侧名字只在登记它的会话里找得到。
    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        let found = match self.sessions.manager_of(session) {
            None => self.find(name),
            Some(manager) => {
                if name == self.skill.name() {
                    Some(self.skill.clone())
                } else if name == WAIT_FOR_MCP_SERVERS && manager.has_servers() {
                    Some(Self::session_wait(&manager))
                } else {
                    self.base.find(name).or_else(|| manager.find(name))
                }
            }
        };
        found.or_else(|| self.app_tools.find(session, name))
    }

    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.base.withheld(name)
    }

    /// MCP 工具、连接中的服务器与 instructions 在同一把锁里取（query.md §1.3，修复线 F36）。
    fn snapshot(&self, session: &SessionId) -> ToolSnapshot {
        if let Some(manager) = self.sessions.manager_of(session) {
            let (tools, view) = manager.snapshot();
            let wait =
                (!view.pending().is_empty() || manager.declared(session))
                    .then(|| Self::session_wait(&manager));
            return ToolSnapshot {
                tools: self.with_app_tools(session, self.assemble(wait, tools)),
                mcp: Some(view),
            };
        }
        let (tools, view) = self.mcp.snapshot();
        let wait = !view.pending().is_empty() || self.mcp.declared(session);
        ToolSnapshot {
            tools: self.with_app_tools(
                session,
                self.assemble(wait.then(|| self.wait.clone()), tools),
            ),
            mcp: Some(view),
        }
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        Some(self.mcp.clone())
    }

    fn mcp_for(&self, session: &SessionId) -> Option<Arc<dyn McpConnections>> {
        match self.sessions.manager_of(session) {
            Some(manager) => Some(manager),
            None => Some(self.mcp.clone()),
        }
    }

    /// 会话级 MCP：主循环在首个模型请求前等它离开 Pending（连接在 createSession 里后台启动）。
    fn session_mcp(&self, session: &SessionId) -> Option<Arc<dyn McpConnections>> {
        self.sessions
            .manager_of(session)
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
            .listing_for(
                Some(&request.session),
                &request.workspace,
                history,
                &request.selection.model,
            )
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
    ) -> Result<Vec<nibi_kernel_api::listing::InvokedSkill>, OrchestrationError> {
        Ok(self
            .skills
            .invoked_for(Some(&request.session), &request.workspace, history)
            .await)
    }

    /// 输入中间的 skill 提及（ext.md §2.8）。
    async fn skill_mentions(
        &self,
        request: &ContextRequest,
        input: &str,
    ) -> Result<Vec<String>, OrchestrationError> {
        Ok(self
            .skills
            .mentions_for(Some(&request.session), &request.workspace, input)
            .await)
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

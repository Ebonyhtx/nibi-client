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
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use rust_cli_kernel_api::clock::{Clock, Ids};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::listing::{ListingEntry, ListingSource, Listings};
use rust_cli_kernel_api::machine::{EnvInfo, Files};
use rust_cli_kernel_api::mcp::McpTransport;
use rust_cli_kernel_api::mcp_state::{McpConnections, WAIT_FOR_MCP_SERVERS};
use rust_cli_kernel_api::mcp_ui::{
    McpResourceContent, McpResourcePage, McpResourceTemplatePage, McpUiCallToolRequest,
    McpUiCancelCallRequest, McpUiError, McpUiInstanceRequest, McpUiListRequest, McpUiReadRequest,
    McpUiSubscriptionRequest, visible_to_app,
};
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
    /// MCP Apps 的 UI 事件出口（`pluginUi.*` 增量）：入口接给协议层；None 时什么都不发。
    pub mcp_ui_events: Option<
        tokio::sync::mpsc::UnboundedSender<rust_cli_kernel_api::mcp_ui::McpUiEvent>,
    >,
    /// 回合外的一次模型请求（MCP Apps 采样）：runtime 用会话当前的模型选择实现；None 时
    /// `mcp/uiSampling` 如实报不支持（TUI、测试）。
    pub sampling: Option<Arc<dyn rust_cli_kernel_api::mcp_ui::McpUiSamplingPort>>,
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
    /// MCP Apps 的实例凭证（`mcp/ui*`）：进程级一本账，按 token 查。
    app_instances: Arc<mcp::McpAppInstances>,
    /// App-Provided Tools 的登记表（按会话）：模型工具表与实例信箱共用这一份。
    app_tools: Arc<mcp::AppToolRegistry>,
    /// 采样的额度与终态账本；`sampling` 是模型请求的出口（runtime 注入）。
    sampling_calls: Arc<mcp::SamplingCalls>,
    sampling: Option<Arc<dyn rust_cli_kernel_api::mcp_ui::McpUiSamplingPort>>,
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
        ));
        // `mcp/list` 的状态检查（141 审计 §9 第 6 项）：每工作区一套独立连接，与上面两套都不混。
        let status_mcp = Arc::new(mcp::McpStatusRegistry::new(
            ports.mcp.clone(),
            ports.spawner.clone(),
            config.mcp.clone(),
            ports.clock.clone(),
            telemetry,
        ));
        // App-Provided Tools 的登记表（`app__<server>__<tool>`）：按会话记实例、待执行调用与模型工具表。
        let app_tools = Arc::new(mcp::AppToolRegistry::new(
            ports.ids.clone(),
            ports.mcp_ui_events.clone(),
        ));
        let registry = Arc::new(ExtRegistry {
            base,
            skill: skill_tool,
            wait: Arc::new(mcp::WaitForMcpServers::new(Arc::downgrade(&mcp))),
            mcp: mcp.clone(),
            sessions: session_mcp.clone(),
            app_tools: app_tools.clone(),
        });
        // MCP Apps 的凭证账本：进程级一个实例标识（Node 每个 agent 进程一个 `McpUiInstances`）。
        let app_instances = Arc::new(mcp::McpAppInstances::new(
            rust_cli_kernel_api::process_table::uuid_v4(),
        ));
        let sampling_calls = Arc::new(mcp::SamplingCalls::new());
        // 实例关闭 → `pluginUi.instanceClosed`（页面卸载）。凭证先移除、再取消令牌，这个回调在
        // 取消之后触发，迟到的结果拿不回执行权；进行中的采样一并取消（Node 的实例作用域 signal）。
        if let Some(events) = ports.mcp_ui_events.clone() {
            let sampling_calls = sampling_calls.clone();
            app_instances.set_on_closed(std::sync::Arc::new(move |binding, lease| {
                use rust_cli_kernel_api::mcp_ui::{McpUiEvent, McpUiSubscriber};
                sampling_calls.clear_instance(&lease.token);
                let plugin_id = rust_cli_kernel_api::mcp_telemetry::plugin_name(
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
        Self {
            skills,
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

    /// 一个会话的 MCP 连接：会话自己的那套，没带服务器时回落到进程级配置（Node 的 session → pool lease）。
    fn mcp_for_session(&self, session: &SessionId) -> Arc<McpManager> {
        self.session_mcp
            .manager(session)
            .unwrap_or_else(|| self.mcp.clone())
    }

    /// `mcp/uiOpenInstance`：页面实例凭证（同一逻辑页面同连接代际幂等）。
    pub fn mcp_ui_open(
        &self,
        request: rust_cli_kernel_api::mcp_ui::McpUiOpenRequest,
    ) -> Result<rust_cli_kernel_api::mcp_ui::McpAppInstance, rust_cli_kernel_api::mcp_ui::McpUiError>
    {
        let manager = self.mcp_for_session(&request.scope.session);
        let connection = manager
            .app_connection(&request.scope.server_name)
            .ok_or_else(rust_cli_kernel_api::mcp_ui::McpUiError::app_unavailable)?;
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
        request: rust_cli_kernel_api::mcp_ui::McpUiRegisterAppToolsRequest,
    ) -> Result<Vec<rust_cli_kernel_api::mcp_ui::McpUiAppToolRegistration>, McpUiError> {
        self.check_instance(&request.instance).await?;
        check_app_tool_binding(&request.instance, &request.scope_id, request.generation)?;
        let session = request.instance.scope.session.clone();
        Ok(self.app_tools.register(&session, request))
    }

    /// `mcp/uiUnregisterAppTools`：收回实例的工具（页面卸载时的尽力收尾）。
    pub fn mcp_ui_unregister_app_tools(
        &self,
        request: rust_cli_kernel_api::mcp_ui::McpUiUnregisterAppToolsRequest,
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
        request: rust_cli_kernel_api::mcp_ui::McpUiClaimAppToolCallRequest,
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
        request: rust_cli_kernel_api::mcp_ui::McpUiResolveAppToolCallRequest,
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
        request: rust_cli_kernel_api::mcp_ui::McpUiSamplingRequest,
        selection: Option<rust_cli_kernel_api::model::ModelSelection>,
    ) -> Result<rust_cli_kernel_api::mcp_ui::McpUiSamplingResult, McpUiError> {
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
        let input = rust_cli_kernel_api::mcp_ui::McpUiSamplingInput {
            messages: request.messages.clone(),
            system_prompt: request.system_prompt.clone(),
            max_tokens: request.max_tokens,
            selection,
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
        request: rust_cli_kernel_api::mcp_ui::McpUiCancelSamplingRequest,
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
        servers: Vec<rust_cli_kernel_api::mcp_session::SessionMcpServer>,
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

    /// 会话自己的 WaitForMcpServers：连接状态与 declared 都在这个会话的 manager 里。
    fn session_wait(manager: &Arc<McpManager>) -> Arc<dyn Tool> {
        Arc::new(mcp::WaitForMcpServers::new(Arc::downgrade(manager)))
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
        let found = match self.sessions.manager(session) {
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
        if let Some(manager) = self.sessions.manager(session) {
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

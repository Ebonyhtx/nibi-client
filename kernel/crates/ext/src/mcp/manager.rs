//! MCP 连接管理（docs/specs/rust-cli/ext.md §3.3）：每个服务器一个连接任务，状态与工具快照只在这里，
//! 注册表每步读当前快照；`list_changed` 重新拉取；HTTP / SSE 断开后退避重连。

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use rust_cli_base::Spawner;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::env_registry::EnvironmentRegistry;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::listing::ListingEntry;
use rust_cli_kernel_api::mcp::{McpTransport, McpTransportConfig};
use rust_cli_kernel_api::mcp_status::{
    McpFailureKind, McpProtocolEra, McpServerStatus, McpServerStatusKind,
};
use rust_cli_kernel_api::mcp_ui::{
    McpAppConnection, McpAppInstance, McpResourceContent, McpResourceDescriptor, McpResourcePage,
    McpResourceSignal, McpResourceTemplate, McpResourceTemplatePage, McpUiError, McpUiEvent,
    McpUiSubscriber, tool_visibility, visible_to_model,
};
use rust_cli_kernel_api::mcp_telemetry::McpProcessIdentity;
use rust_cli_kernel_api::tool::Tool;
use serde_json::{Value, json};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

use super::config::{McpServer, McpServerOptions, McpSettings};
use super::connection::{self, OpenFailure, Session, has_capability};
use super::resources;
use super::rpc::{Client, Notice, RpcError};
use super::telemetry::McpTelemetrySlot;
use super::tool::{McpTool, name_too_long, note_long_names};

/// 断开后重连的次数与退避。
const MAX_RECONNECTS: u32 = 5;
const INITIAL_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 30_000;

/// 一个服务器的连接状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpStatus {
    Pending,
    Connected,
    /// 连接失败：给用户看的原因 + Host `mcp/list` 的失败分类（`failureKind`）。
    Failed {
        reason: String,
        kind: McpFailureKind,
    },
    /// 停用（配置里 `enabled: false`，或 `/mcp disable`，docs/specs/rust-cli/tui-manage.md §6）：不连接。
    Disabled,
}

/// 一个仍在运行的服务器进程（`process/childProcesses` / `process/mcpResourceSamples` /
/// `process/mcpTelemetry` 共用）：pid 与遥测身份。
#[derive(Debug, Clone)]
pub(crate) struct ServerProcess {
    pub pid: u32,
    pub identity: McpProcessIdentity,
    /// `workspace` / `session`（事件里的 `mcpIsolation`）。
    pub isolation: &'static str,
}

struct Server {
    config: McpServer,
    status: McpStatus,
    /// 状态最后一次变化的时刻（Unix 毫秒；`mcp/list` 的 `updatedAt`，141 审计 §9 第 6 项）。
    updated_at_ms: u64,
    client: Option<Arc<Client>>,
    /// 这个服务器当前那次进程启动的遥测身份；没有进程（HTTP / SSE、未连、已退出）时 `None`。
    process: Option<ServerProcess>,
    tools: Vec<Arc<dyn Tool>>,
    /// 进模型工具表的那些（`_meta.ui.visibility` 含 `model`）；`tools` 是服务器列出的全部。
    model_tools: Vec<Arc<dyn Tool>>,
    /// 工具的可见性（`_meta.ui.visibility`），按服务器给的原始工具名；缺省两者都有。
    /// 第一次拉清单时记下，`list_changed` 重拉时整表替换（MCP Apps 的模型工具表与页面调用都用它）。
    visibility: BTreeMap<String, Vec<String>>,
    instructions: Option<String>,
    /// 连上过、有 resources 能力的服务器（ext.md §3.3.3）：之后资源工具一直在。
    resources: bool,
    /// 服务器声明了 `resources.subscribe`（MCP Apps 的资源订阅）。
    resource_subscribe: bool,
    prompts: Vec<Value>,
    /// 最近一次断开是 HTTP 会话过期（工具调用据此重试一次）。
    expired: bool,
    /// 连上过、断开后在退避重连（HTTP / SSE）；状态是 Pending（直接调用时不等它，ext.md §3.8）。
    reconnecting: bool,
    /// `-p` 里连上过的 stdio 服务器断开了，工具留着、等下次调用再连（ext.md §3.3.3）；状态仍是 Connected。
    dormant: bool,
    /// 叫醒等下次调用的连接任务。
    wake: Arc<Notify>,
    /// 连接任务的代号：重连、停用时加一；旧任务的状态更新因代号不符被丢弃（tui-manage.md §6.1）。
    generation: u64,
    /// 停掉当前连接任务的取消消息。
    cancel: CancellationToken,
}

impl Server {
    fn new(config: McpServer, status: McpStatus, now: u64) -> Self {
        Self {
            config,
            status,
            updated_at_ms: now,
            client: None,
            process: None,
            tools: Vec::new(),
            model_tools: Vec::new(),
            visibility: BTreeMap::new(),
            instructions: None,
            resources: false,
            resource_subscribe: false,
            prompts: Vec::new(),
            expired: false,
            reconnecting: false,
            dormant: false,
            wake: Arc::new(Notify::new()),
            generation: 0,
            cancel: CancellationToken::new(),
        }
    }
}

pub(crate) struct Inner {
    transport: Arc<dyn McpTransport>,
    /// 远端机器的注册表（R5）：绑定到远端的服务器从这里取那台机器的 `mcp()`（remote-exec.md §22.6）。
    machines: OnceLock<Arc<dyn EnvironmentRegistry>>,
    spawner: Spawner,
    settings: McpSettings,
    servers: Mutex<BTreeMap<String, Server>>,
    /// 每次状态变化加一；等待方据此醒来重新检查。
    changed: watch::Sender<u64>,
    /// `start` 给的工作区（重连与启用时用）。
    workspace: Mutex<Option<WorkspaceRef>>,
    /// 等待的截止时刻用注入的时钟算（ext.md §3.3.1、§3.8）。
    clock: Arc<dyn Clock>,
    /// 主线程的请求带过 WaitForMcpServers 的会话（declared，ext.md §3.8）；会话关闭时去掉。
    declared: Mutex<HashSet<SessionId>>,
    /// 名字太长、记过日志的工具（每个名字只记一次，ext.md §3.4）。
    noted_names: Mutex<HashSet<String>>,
    /// print 会话（`-p`、stream-json）：连上过的 stdio 服务器断开时等下次调用再连（ext.md §3.3.3）。
    print: AtomicBool,
    /// 有 resources 能力的服务器连上过：之后三个资源工具一直在（ext.md §3.3.3）。
    resources_seen: AtomicBool,
    /// MCP 进程遥测的出口（`process/mcpTelemetry`，141 审计 §9 F3）：入口在连接开始之前装上；
    /// 没有时（TUI、测试）什么都不发。
    telemetry: OnceLock<McpTelemetrySlot>,
    /// 这个会话的 `session_startup` 已经发过（每个 manager 一次）。
    startup_reported: AtomicBool,
    /// MCP Apps 的资源订阅：（服务器, URI）→ 订阅键 → 页面凭证。第一个订阅者登记时向服务器发
    /// `resources/subscribe`，最后一个退订时发 `resources/unsubscribe`；重连后重放。
    subscriptions: Mutex<BTreeMap<(String, String), BTreeMap<String, McpAppInstance>>>,
    /// UI 事件出口（`pluginUi.*` 增量）：入口接上；None 时（TUI、测试）什么都不发。
    ui_events: OnceLock<tokio::sync::mpsc::UnboundedSender<McpUiEvent>>,
    /// 一个服务器的连接断了（含重连前的换代）：让 MCP Apps 的实例凭证失效并取消进行中的调用/采样。
    connection_lost: Mutex<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
}

impl Inner {
    fn servers(&self) -> MutexGuard<'_, BTreeMap<String, Server>> {
        self.servers.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 只改仍是这个代号的服务器：重连或停用之后，旧连接任务的更新不覆盖新的状态。
    fn update(&self, name: &str, generation: u64, change: impl FnOnce(&mut Server)) {
        if let Some(server) = self
            .servers()
            .get_mut(name)
            .filter(|server| server.generation == generation)
        {
            change(server);
            server.updated_at_ms = self.clock.now_ms();
        }
        self.changed.send_modify(|version| *version += 1);
    }

    /// 这个服务器的连接断了：通知装上的页面实例清理（连接换代让凭证失效）。
    fn notify_connection_lost(&self, name: &str) {
        let callback = self
            .connection_lost
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(callback) = callback {
            callback(name);
        }
    }

    pub(crate) fn settings(&self) -> &McpSettings {
        &self.settings
    }

    /// 这个服务器的选项（Node 配置的 `timeoutMs`、`alwaysLoad`，ext.md §3.1）；不认识的服务器用缺省值。
    pub(crate) fn options(&self, name: &str) -> McpServerOptions {
        self.servers()
            .get(name)
            .map(|server| server.config.options)
            .unwrap_or_default()
    }

    /// 已连接的服务器的客户端。
    pub(crate) fn client(&self, name: &str) -> Option<Arc<Client>> {
        self.servers()
            .get(name)
            .filter(|server| server.status == McpStatus::Connected)
            .and_then(|server| server.client.clone())
    }

    /// 服务器列出的某个工具（按服务器给的原始名）：页面调用用它拿 schema 与只读标记。
    pub(crate) fn ui_tool(&self, server: &str, tool: &str) -> Option<Arc<dyn Tool>> {
        let servers = self.servers();
        let found = servers
            .get(server)
            .filter(|server| server.status == McpStatus::Connected)?;
        found
            .tools
            .iter()
            .find(|candidate| {
                candidate
                    .mcp_info()
                    .is_some_and(|info| info.server == server && info.tool == tool)
            })
            .cloned()
    }

    /// 页面发起的 `tools/call`（`mcp/uiCallTool` 的后半）：原始 `CallToolResult`，不转成模型工具结果、
    /// 不落盘。超时、断开与重试的口径与模型调用相同（`McpTool::call`）。
    pub(crate) async fn call_tool_for_ui(
        &self,
        server: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, McpUiError> {
        let timeout = Duration::from_millis(self.settings.tool_timeout_for(self.options(server)));
        let params = json!({"name": tool, "arguments": arguments});
        let mut retried = false;
        loop {
            // `-p` 里断开、等下次调用的服务器在这里再连（ext.md §3.3.3）。
            let client = match self.client(server) {
                Some(client) => Some(client),
                None => self.reconnect_dormant(server).await,
            }
            .ok_or_else(|| McpUiError::not_connected(server))?;
            match client
                .request("tools/call", params.clone(), timeout, cancel)
                .await
            {
                Ok(value) => return Ok(value),
                Err(RpcError::Cancelled) => {
                    return Err(McpUiError::failed("MCP App tool call was cancelled"));
                }
                Err(RpcError::TimedOut) => {
                    return Err(McpUiError::failed(format!(
                        "MCP server \"{server}\" tool \"{tool}\" timed out after {}s",
                        timeout.as_millis() / 1000
                    )));
                }
                // 会话过期（HTTP 404）：等连接任务重连后重试一次。
                Err(RpcError::Closed(_)) if !retried && self.expired(server) => {
                    retried = true;
                    self.wait_reconnected(server, &client).await;
                }
                Err(error) => return Err(McpUiError::failed(error.to_string())),
            }
        }
    }

    /// `-p` 里断开、等下次调用的服务器：叫醒连接任务，等它重新连上（返回新的客户端）或失败（None）。不在等
    /// 下次调用时也是 None。
    pub(crate) async fn reconnect_dormant(&self, name: &str) -> Option<Arc<Client>> {
        let wake = {
            let servers = self.servers();
            let server = servers.get(name).filter(|server| server.dormant)?;
            server.wake.clone()
        };
        wake.notify_one();
        let mut changes = self.changed.subscribe();
        loop {
            match self.servers().get(name) {
                Some(server) if server.status == McpStatus::Connected && !server.dormant => {
                    if let Some(client) = &server.client {
                        return Some(client.clone());
                    }
                }
                Some(server) if server.status == McpStatus::Connected => {}
                _ => return None,
            }
            if changes.changed().await.is_err() {
                return None;
            }
        }
    }

    pub(crate) fn expired(&self, name: &str) -> bool {
        self.servers()
            .get(name)
            .is_some_and(|server| server.expired)
    }

    /// 等服务器换上新客户端（重连成功）或不再重连。
    pub(crate) async fn wait_reconnected(&self, name: &str, old: &Arc<Client>) {
        let mut changes = self.changed.subscribe();
        loop {
            let settled = match self.servers().get(name) {
                Some(server) => match &server.status {
                    McpStatus::Connected => server
                        .client
                        .as_ref()
                        .is_some_and(|client| !Arc::ptr_eq(client, old)),
                    McpStatus::Failed { .. } | McpStatus::Disabled => true,
                    McpStatus::Pending => false,
                },
                None => true,
            };
            if settled || changes.changed().await.is_err() {
                return;
            }
        }
    }

    async fn tools_of(
        self: &Arc<Self>,
        server: &str,
        client: &Client,
    ) -> (
        Vec<Arc<dyn Tool>>,
        Vec<Arc<dyn Tool>>,
        BTreeMap<String, Vec<String>>,
    ) {
        let options = self.options(server);
        let timeout = Duration::from_millis(self.settings.connect_timeout_for(options));
        match connection::list(client, "tools/list", "tools", timeout).await {
            Ok(listed) => {
                // 可见性按原始工具名记全（含 app-only），模型工具表只收 `model` 那一半。
                let mut visibility: BTreeMap<String, Vec<String>> = BTreeMap::new();
                let mut all: Vec<Arc<dyn Tool>> = Vec::new();
                let mut model: Vec<Arc<dyn Tool>> = Vec::new();
                for item in &listed {
                    let Some(tool) = McpTool::from_listed(
                        server,
                        item,
                        options.always_load,
                        Arc::downgrade(self),
                    ) else {
                        continue;
                    };
                    let visible = tool_visibility(item.get("_meta"));
                    if let Some(name) = item.get("name").and_then(Value::as_str) {
                        visibility.insert(name.to_owned(), visible.clone());
                    }
                    let tool: Arc<dyn Tool> = Arc::new(tool);
                    if visible_to_model(&visible) {
                        model.push(tool.clone());
                    }
                    all.push(tool);
                }
                note_long_names(server, &model, &self.noted_names);
                (all, model, visibility)
            }
            Err(error) => {
                tracing::warn!(server, %error, "MCP tools/list failed");
                (Vec::new(), Vec::new(), BTreeMap::new())
            }
        }
    }

    async fn prompts_of(&self, server: &str, client: &Client) -> Vec<Value> {
        let timeout =
            Duration::from_millis(self.settings.connect_timeout_for(self.options(server)));
        connection::list(client, "prompts/list", "prompts", timeout)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(server, %error, "MCP prompts/list failed");
                Vec::new()
            })
    }

    /// 连上之后：拉取清单、发布，处理通知直到连接关闭；返回关闭原因与是否会话过期。
    async fn serve(
        self: &Arc<Self>,
        name: &str,
        generation: u64,
        session: Session,
    ) -> (Option<String>, bool, bool) {
        let Session {
            client,
            mut notices,
            capabilities,
            instructions,
        } = session;
        let (tools, model_tools, visibility) = if has_capability(&capabilities, "tools") {
            self.tools_of(name, &client).await
        } else {
            (Vec::new(), Vec::new(), BTreeMap::new())
        };
        let prompts = if has_capability(&capabilities, "prompts") {
            self.prompts_of(name, &client).await
        } else {
            Vec::new()
        };
        let resources = has_capability(&capabilities, "resources");
        let resource_subscribe = resources
            && capabilities
                .pointer("/resources/subscribe")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        if resources {
            self.resources_seen.store(true, Ordering::Relaxed);
        }
        let published = client.clone();
        self.update(name, generation, move |server| {
            server.status = McpStatus::Connected;
            server.client = Some(published);
            server.tools = tools;
            server.model_tools = model_tools;
            server.visibility = visibility;
            server.prompts = prompts;
            server.instructions = instructions;
            server.resources = resources;
            server.resource_subscribe = resource_subscribe;
            server.expired = false;
            server.reconnecting = false;
            server.dormant = false;
        });
        tracing::info!(server = name, "MCP server connected");
        // 重连之后把订阅重放给新连接（Node 的 adapter 同一条）。
        self.replay_subscriptions(name, &client).await;
        while let Some(notice) = notices.recv().await {
            match notice {
                Notice::ListChanged(kind) if kind == "tools" => {
                    let (tools, model_tools, visibility) = self.tools_of(name, &client).await;
                    self.update(name, generation, |server| {
                        server.tools = tools;
                        server.model_tools = model_tools;
                        server.visibility = visibility;
                    });
                }
                Notice::ListChanged(kind) if kind == "prompts" => {
                    let prompts = self.prompts_of(name, &client).await;
                    self.update(name, generation, |server| server.prompts = prompts);
                }
                // 资源清单变了：告诉订阅者重新拉清单（清单本身仍不缓存）。
                Notice::ListChanged(kind) if kind == "resources" => {
                    self.resource_signal(name, McpResourceSignal::ListChanged);
                }
                Notice::ResourceUpdated(uri) => {
                    self.resource_signal(name, McpResourceSignal::Updated(uri));
                }
                // 其余 list_changed 不缓存清单：工具每次实时拉取。
                Notice::ListChanged(_) => {}
                Notice::Closed {
                    reason,
                    session_expired,
                    exited,
                } => return (reason, session_expired, exited),
            }
        }
        (None, false, false)
    }

    /// 一个服务器的连接任务：收到取消消息（重连、停用）时停下（tui-manage.md §6.1）。
    async fn run(
        self: Arc<Self>,
        workspace: WorkspaceRef,
        config: McpServer,
        generation: u64,
        cancel: CancellationToken,
    ) {
        tokio::select! {
            () = cancel.cancelled() => {}
            () = self.clone().connect(workspace, config, generation) => {}
        }
    }

    /// 记下一个服务器进程的遥测身份并发 `process_start`（没有 pid 的传输——HTTP / SSE——什么都不做）。
    fn record_process(
        &self,
        name: &str,
        config: &McpServer,
        generation: u64,
        pid: Option<u32>,
    ) {
        let Some(pid) = pid else {
            return;
        };
        let Some(slot) = self.telemetry.get() else {
            return;
        };
        let plugin_scope = config.scope == crate::McpScope::Plugin;
        let now = self.clock.now_ms();
        let identity = slot.telemetry.identity(name, plugin_scope, now);
        slot.telemetry
            .process_started(name, plugin_scope, slot.isolation, &identity, now);
        self.update(name, generation, |server| {
            server.process = Some(ServerProcess {
                pid,
                identity,
                isolation: slot.isolation,
            });
        });
    }

    /// 进程自己退出了：发一条 `process_crash` 并清掉记录（记录先取走，重连时不会报两次）。
    fn record_crash(&self, name: &str, config: &McpServer) {
        let Some(process) = self
            .servers()
            .get_mut(name)
            .and_then(|server| server.process.take())
        else {
            return;
        };
        let Some(slot) = self.telemetry.get() else {
            return;
        };
        let plugin_scope = config.scope == crate::McpScope::Plugin;
        let now = self.clock.now_ms();
        // 会话级连接只影响自己那一个会话；进程级连接不绑定会话。
        let affected = u32::from(slot.session.is_some());
        slot.telemetry.process_crashed(
            name,
            plugin_scope,
            process.isolation,
            &process.identity,
            affected,
            now,
        );
    }

    /// 主动关闭 / 重连之前清掉进程记录（没有进程记录时是空操作）。
    fn clear_process(&self, name: &str, generation: u64) {
        self.update(name, generation, |server| server.process = None);
    }

    /// 服务器绑定的插件 id：插件服务器取 `plugin:<name>:<key>` 的名字，其余用服务器名
    /// （Node 的 `pluginId` 只做展示；非插件 server 时调用方也用服务器名）。
    fn plugin_id_of(&self, server: &str) -> String {
        let plugin_scope = self
            .servers()
            .get(server)
            .is_some_and(|server| server.config.scope == crate::McpScope::Plugin);
        rust_cli_kernel_api::mcp_telemetry::plugin_name(server, plugin_scope)
            .unwrap_or_else(|| server.to_owned())
    }

    /// 资源通知 → 各会话一条 UI 事件（没有订阅者时直接丢弃）。
    fn resource_signal(&self, server: &str, signal: McpResourceSignal) {
        let Some(sender) = self.ui_events.get() else {
            return;
        };
        let mut grouped: BTreeMap<String, Vec<McpUiSubscriber>> = BTreeMap::new();
        {
            let subscriptions = self
                .subscriptions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let entries: Vec<&BTreeMap<String, McpAppInstance>> = match &signal {
                McpResourceSignal::Updated(uri) => subscriptions
                    .get(&(server.to_owned(), uri.clone()))
                    .into_iter()
                    .collect(),
                McpResourceSignal::ListChanged => subscriptions
                    .iter()
                    .filter(|((name, _), _)| name == server)
                    .map(|(_, entry)| entry)
                    .collect(),
            };
            for entry in entries {
                for (key, instance) in entry {
                    let Some(session) = key.split('|').next().filter(|session| !session.is_empty())
                    else {
                        continue;
                    };
                    grouped
                        .entry(session.to_owned())
                        .or_default()
                        .push(McpUiSubscriber {
                            scope_id: instance.token.clone(),
                            generation: instance.generation,
                            instance: instance.clone(),
                        });
                }
            }
        }
        if grouped.is_empty() {
            return;
        }
        let plugin_id = self.plugin_id_of(server);
        for (session, subscribers) in grouped {
            let event = match &signal {
                McpResourceSignal::Updated(uri) => McpUiEvent::ResourceUpdated {
                    session: SessionId::new(session),
                    plugin_id: plugin_id.clone(),
                    server: server.to_owned(),
                    uri: uri.clone(),
                    subscribers,
                },
                McpResourceSignal::ListChanged => McpUiEvent::ResourceListChanged {
                    session: SessionId::new(session),
                    plugin_id: plugin_id.clone(),
                    server: server.to_owned(),
                    subscribers,
                },
            };
            let _ = sender.send(event);
        }
    }

    /// 连上（或重连）之后把订阅重放给新连接；失败只记日志（下一次重连还会试）。
    async fn replay_subscriptions(&self, server: &str, client: &Client) {
        let uris: Vec<String> = {
            let subscriptions = self
                .subscriptions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            subscriptions
                .iter()
                .filter(|((name, _), entry)| name == server && !entry.is_empty())
                .map(|((_, uri), _)| uri.clone())
                .collect()
        };
        if uris.is_empty() {
            return;
        }
        let timeout = Duration::from_millis(self.settings.tool_timeout_for(self.options(server)));
        for uri in uris {
            if let Err(error) = client
                .request(
                    "resources/subscribe",
                    json!({"uri": uri}),
                    timeout,
                    &CancellationToken::new(),
                )
                .await
            {
                tracing::warn!(server, uri = %uri, %error, "could not replay an MCP resource subscription");
            }
        }
    }

    /// 连接与重连（ext.md §3.3）：首次连接失败即失败；连上后断开时 stdio 失败，HTTP / SSE 退避重连。
    async fn connect(self: Arc<Self>, workspace: WorkspaceRef, config: McpServer, generation: u64) {
        let remote = !matches!(config.transport, McpTransportConfig::Stdio { .. });
        let timeout = Duration::from_millis(self.settings.connect_timeout_for(config.options));
        let name = config.name.clone();
        let mut connected_once = false;
        let mut attempts = 0;
        loop {
            let pipe = connection::Pipe {
                local: &self.transport,
                machines: self.machines.get(),
                workspace: &workspace,
            };
            let failure = match connection::open(
                &pipe,
                &self.spawner,
                &config,
                timeout,
                &self.settings.client_version,
            )
            .await
            {
                Ok(session) => {
                    connected_once = true;
                    attempts = 0;
                    // 进程遥测（`process/mcpTelemetry`）：连上就拿 pid 记一次启动事实。
                    self.record_process(&name, &config, generation, session.client.pid());
                    let (reason, expired, exited) = self.serve(&name, generation, session).await;
                    // 连接断了：页面实例与进行中的页面调用/采样一起作废（Node 的连接换代）。
                    self.notify_connection_lost(&name);
                    // 进程自己退出了：报一条 crash（主动关闭、写失败都不算）。
                    if exited {
                        self.record_crash(&name, &config);
                    }
                    self.clear_process(&name, generation);
                    // `-p` 里 stdio 断开：工具留着，等下次调用再连（ext.md §3.3.3）。
                    if !remote && self.print.load(Ordering::Relaxed) {
                        let mut wake = None;
                        self.update(&name, generation, |server| {
                            server.client = None;
                            server.dormant = true;
                            wake = Some(server.wake.clone());
                        });
                        let Some(wake) = wake else { return };
                        tracing::info!(
                            server = name,
                            "MCP server closed; reconnecting on the next call"
                        );
                        wake.notified().await;
                        continue;
                    }
                    self.update(&name, generation, |server| {
                        server.status = McpStatus::Pending;
                        server.client = None;
                        server.tools.clear();
                        server.model_tools.clear();
                        server.expired = expired;
                        // stdio 不重连：下面马上记为失败。
                        server.reconnecting = remote;
                    });
                    // 连上之后断开：不是握手问题，归到 `unexpected_disconnect`。
                    OpenFailure {
                        message: reason.unwrap_or_else(|| "connection closed".to_owned()),
                        kind: McpFailureKind::UnexpectedDisconnect,
                    }
                }
                Err(failure) => failure,
            };
            if !remote || !connected_once || attempts >= MAX_RECONNECTS {
                tracing::warn!(
                    server = name,
                    reason = logged_reason(&failure.message),
                    "MCP server failed"
                );
                self.update(&name, generation, |server| {
                    server.status = McpStatus::Failed {
                        reason: failure.message,
                        kind: failure.kind,
                    };
                    server.client = None;
                    server.tools.clear();
                    server.model_tools.clear();
                    server.process = None;
                    server.reconnecting = false;
                    server.dormant = false;
                });
                return;
            }
            let backoff = (INITIAL_BACKOFF_MS << attempts).min(MAX_BACKOFF_MS);
            attempts += 1;
            tracing::info!(
                server = name,
                attempts,
                backoff,
                "reconnecting the MCP server"
            );
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }
    }
}

/// MCP 连接管理。
pub struct McpManager(Arc<Inner>);

impl McpManager {
    pub fn new(
        transport: Arc<dyn McpTransport>,
        spawner: Spawner,
        settings: McpSettings,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let (changed, _) = watch::channel(0);
        Self(Arc::new(Inner {
            transport,
            machines: OnceLock::new(),
            spawner,
            settings,
            servers: Mutex::default(),
            changed,
            workspace: Mutex::default(),
            clock,
            declared: Mutex::default(),
            noted_names: Mutex::default(),
            print: AtomicBool::new(false),
            resources_seen: AtomicBool::new(false),
            telemetry: OnceLock::new(),
            startup_reported: AtomicBool::new(false),
            subscriptions: Mutex::default(),
            ui_events: OnceLock::new(),
            connection_lost: Mutex::default(),
        }))
    }

    /// 装上 MCP 进程遥测的出口（`process/mcpTelemetry`，141 审计 §9 F3）：连接开始之前给一次。
    /// 第二次给无效（`OnceLock`），与 `set_machines` 同一姿态。
    pub(crate) fn attach_telemetry(&self, slot: McpTelemetrySlot) {
        let _ = self.0.telemetry.set(slot);
    }

    /// 装上 MCP Apps 的事件出口（`pluginUi.*` 增量）：连接开始之前给一次。
    pub(crate) fn attach_ui_events(
        &self,
        sender: tokio::sync::mpsc::UnboundedSender<McpUiEvent>,
    ) {
        let _ = self.0.ui_events.set(sender);
    }

    /// 装上“连接断了”的通知：MCP Apps 的实例凭证随连接作废（Node 连接换代同样关闭页面）。
    pub(crate) fn set_on_connection_lost(&self, callback: Arc<dyn Fn(&str) + Send + Sync>) {
        *self
            .0
            .connection_lost
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(callback);
    }

    /// 远端机器的注册表（R5，remote-exec.md §22.6）：`start` 之前给一次；绑定到远端机器的服务器从它取管道。F98（§25.5）：
    /// 同时跟着它的连接变化，机器进注册表时重连绑定到它的失败的服务器。
    pub fn set_machines(&self, machines: Arc<dyn EnvironmentRegistry>) {
        if self.0.machines.set(machines.clone()).is_err() {
            return;
        }
        let manager = McpManager(self.0.clone());
        self.0.spawner.spawn_resident("mcp-machines", async move {
            manager.follow_machines(machines).await;
        });
    }

    /// print 会话（`-p`、stream-json）：连上过的 stdio 服务器断开时不记失败，等下次调用再连（ext.md §3.3.3）。
    pub fn set_print_session(&self, print: bool) {
        self.0.print.store(print, Ordering::Relaxed);
    }

    /// 开始连接（每个服务器一个常驻任务，不等待）。同名的服务器只连一次。
    pub fn start(&self, workspace: WorkspaceRef, servers: Vec<McpServer>) {
        *self
            .0
            .workspace
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(workspace.clone());
        let now = self.0.clock.now_ms();
        for config in servers {
            let cancel = {
                let mut known = self.0.servers();
                if known.contains_key(&config.name) {
                    continue;
                }
                let server = Server::new(config.clone(), McpStatus::Pending, now);
                let cancel = server.cancel.clone();
                known.insert(config.name.clone(), server);
                cancel
            };
            let task = self.0.clone().run(workspace.clone(), config, 0, cancel);
            self.0.spawner.spawn_resident("mcp-connection", task);
        }
        self.0.changed.send_modify(|version| *version += 1);
    }

    /// 把连接集合收敛到 `servers`（Host `mcp/list` 的 `mode: "connect"`）。
    ///
    /// 这次给的是**完整集合**：缺席的断开并移出，新名字开始连，配置变了的换掉重连。同步返回，
    /// 连接在后台任务里进行（调用方随后 [`wait_ready`](Self::wait_ready)）。
    pub fn reconcile(&self, workspace: WorkspaceRef, servers: Vec<McpServer>) {
        *self
            .0
            .workspace
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(workspace.clone());
        let incoming: BTreeSet<String> = servers
            .iter()
            .map(|server| server.name.clone())
            .collect();
        let now = self.0.clock.now_ms();
        let mut closers: Vec<Arc<Client>> = Vec::new();
        let mut starts: Vec<(McpServer, u64, CancellationToken)> = Vec::new();
        {
            let mut known = self.0.servers();
            let stale: Vec<String> = known
                .keys()
                .filter(|name| !incoming.contains(*name))
                .cloned()
                .collect();
            for name in stale {
                if let Some(server) = known.remove(&name) {
                    server.cancel.cancel();
                    if let Some(client) = server.client {
                        closers.push(client);
                    }
                }
                // 服务器不在集合里了：它的资源订阅一并作废（不再有连接可投递）。
                self.0
                    .subscriptions
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .retain(|(server, _), _| server != &name);
            }
            for config in servers {
                match known.get_mut(&config.name) {
                    None => {
                        let server = Server::new(config.clone(), McpStatus::Pending, now);
                        let (generation, cancel) = (server.generation, server.cancel.clone());
                        known.insert(config.name.clone(), server);
                        starts.push((config, generation, cancel));
                    }
                    Some(server)
                        if server.config != config
                            // 同配置的失败也重试一次：`mcp/list` 的 `connect` 是「真实检查」，
                            // 手动刷新要能把上一次失败的服务器再连一遍。
                            || matches!(server.status, McpStatus::Failed { .. }) =>
                    {
                        server.cancel.cancel();
                        server.generation += 1;
                        server.cancel = CancellationToken::new();
                        if let Some(client) = server.client.take() {
                            closers.push(client);
                        }
                        server.config = config.clone();
                        server.status = McpStatus::Pending;
                        server.updated_at_ms = now;
                        server.tools.clear();
                        server.model_tools.clear();
                        server.prompts.clear();
                        server.instructions = None;
                        server.resources = false;
                        server.expired = false;
                        server.reconnecting = false;
                        server.dormant = false;
                        server.process = None;
                        starts.push((config, server.generation, server.cancel.clone()));
                    }
                    Some(_) => {}
                }
            }
        }
        self.0.changed.send_modify(|version| *version += 1);
        for client in closers {
            self.0
                .spawner
                .spawn_resident("mcp-close", async move { client.close().await });
        }
        for (config, generation, cancel) in starts {
            let task = self.0.clone().run(workspace.clone(), config, generation, cancel);
            self.0.spawner.spawn_resident("mcp-connection", task);
        }
    }

    /// 有 resources 能力的服务器时先是三个资源工具，然后是已连接的服务器的工具（按名字排序）。
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        tools_of(&self.0, &self.0.servers())
    }

    pub fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        // 旧名也能找到（资源工具的 `ListMcpResources` 等，与内置工具的查找相同）。
        self.tools()
            .into_iter()
            .find(|tool| tool.name() == name || tool.aliases().contains(&name))
    }

    /// 服务器列出的某个工具（服务器给的原始名，`mcp/uiCallTool` 的审批目标）。
    pub fn ui_tool(&self, server: &str, tool: &str) -> Option<Arc<dyn Tool>> {
        self.0.ui_tool(server, tool)
    }

    /// 页面发起的 `tools/call`：原始 `CallToolResult`（`mcp/uiCallTool` 的后半）。
    pub async fn call_tool_for_ui(
        &self,
        server: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, McpUiError> {
        self.0
            .call_tool_for_ui(server, tool, arguments, cancel)
            .await
    }

    /// 已连接、有 instructions 的服务器，按名字排序：`## <server>\n<instructions>`（ext.md §3.6）。
    pub fn instructions(&self) -> Vec<ListingEntry> {
        instructions_of(&self.0.servers())
    }

    /// 每个服务器的状态（按名字排序）。
    pub fn status(&self) -> Vec<(String, McpStatus)> {
        self.0
            .servers()
            .values()
            .map(|server| (server.config.name.clone(), server.status.clone()))
            .collect()
    }

    /// `/mcp` 与 `/status` 的快照（docs/specs/rust-cli/tui-display.md §3.4）：状态、失败原因、已连接时的工具数。
    pub fn server_infos(&self) -> Vec<rust_cli_kernel_api::manage::McpServerInfo> {
        use rust_cli_kernel_api::manage::{McpServerInfo, McpServerState};
        self.0
            .servers()
            .values()
            .map(|server| {
                let (state, reason) = match &server.status {
                    McpStatus::Pending => (McpServerState::Pending, None),
                    McpStatus::Connected => (McpServerState::Connected, None),
                    McpStatus::Failed { reason, .. } => {
                        (McpServerState::Failed, Some(reason.clone()))
                    }
                    McpStatus::Disabled => (McpServerState::Disabled, None),
                };
                McpServerInfo {
                    name: server.config.name.clone(),
                    state,
                    reason,
                    tools: server.tools.len(),
                    machine: remote_machine(&server.config),
                }
            })
            .collect()
    }

    /// `mcp/list` 的状态快照（Host `zcodeMcpServerStatusSnapshotSchema` 的内核侧字段）。
    ///
    /// 失败分类来自连接失败发生的地方（[`OpenFailure`]）；`updatedAt` 是这条服务器状态最后
    /// 一次变化的时刻。`serverRequestId` 与 `authorization` 内核没有事实源，留空。
    pub fn server_statuses(&self) -> Vec<McpServerStatus> {
        self.0
            .servers()
            .values()
            .map(|server| {
                let (status, error, failure_kind) = match &server.status {
                    McpStatus::Pending => (McpServerStatusKind::Connecting, None, None),
                    McpStatus::Connected => (McpServerStatusKind::Connected, None, None),
                    McpStatus::Failed { reason, kind } => (
                        McpServerStatusKind::Failed,
                        Some(reason.clone()),
                        Some(*kind),
                    ),
                    McpStatus::Disabled => (McpServerStatusKind::Disabled, None, None),
                };
                McpServerStatus {
                    name: server.config.name.clone(),
                    status,
                    transport: server.config.transport.kind(),
                    tool_count: server.tools.len(),
                    updated_at_ms: server.updated_at_ms,
                    error,
                    failure_kind,
                    server_request_id: None,
                    // 内核的客户端固定说 `2025-06-18`（`connection::PROTOCOL_VERSION`）：连上的是 legacy。
                    protocol_era: matches!(server.status, McpStatus::Connected)
                        .then_some(McpProtocolEra::Legacy),
                    authorization: None,
                }
            })
            .collect()
    }

    /// MCP Apps 的连接身份（Node `appConnectionSnapshot`）：只有已连接的服务器才有。
    /// `identity` 是平台、工作区、服务器名与配置的摘要；配置或工作区换了就换身份。
    pub fn app_connection(&self, server: &str) -> Option<McpAppConnection> {
        let servers = self.0.servers();
        let found = servers
            .get(server)
            .filter(|server| server.status == McpStatus::Connected)?;
        let workspace = self
            .0
            .workspace
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()?;
        Some(McpAppConnection {
            identity: connection_identity(&workspace, &found.config),
            generation: found.generation,
        })
    }

    /// 工具的可见性（`_meta.ui.visibility`）：服务器没给这个工具时 `None`。
    pub fn app_tool_visibility(&self, server: &str, tool: &str) -> Option<Vec<String>> {
        self.0.servers().get(server)?.visibility.get(tool).cloned()
    }

    /// 资源请求的连接与期限（只接受已连接、声明了 resources 能力的服务器）。
    fn resource_client(&self, server: &str) -> Result<(Arc<Client>, Duration), McpUiError> {
        let servers = self.0.servers();
        let found = servers
            .get(server)
            .ok_or_else(|| McpUiError::not_connected(server))?;
        if found.status != McpStatus::Connected {
            return Err(McpUiError::not_connected(server));
        }
        if !found.resources {
            return Err(McpUiError::unsupported(server, "resources"));
        }
        let client = found
            .client
            .clone()
            .ok_or_else(|| McpUiError::not_connected(server))?;
        let timeout = Duration::from_millis(self.0.settings.tool_timeout_for(found.config.options));
        Ok((client, timeout))
    }

    /// `resources/list` 的一页（游标原样透传；`None` 是最后一页）。
    pub async fn list_resources(
        &self,
        server: &str,
        cursor: Option<&str>,
    ) -> Result<McpResourcePage, McpUiError> {
        let (client, timeout) = self.resource_client(server)?;
        let params = cursor.map_or_else(|| json!({}), |cursor| json!({"cursor": cursor}));
        let result = client
            .request("resources/list", params, timeout, &CancellationToken::new())
            .await
            .map_err(|error| ui_error(server, "resources/list", error))?;
        Ok(McpResourcePage {
            resources: result
                .get("resources")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(resource_descriptor).collect())
                .unwrap_or_default(),
            next_cursor: next_cursor(&result),
        })
    }

    /// `resources/templates/list` 的一页。
    pub async fn list_resource_templates(
        &self,
        server: &str,
        cursor: Option<&str>,
    ) -> Result<McpResourceTemplatePage, McpUiError> {
        let (client, timeout) = self.resource_client(server)?;
        let params = cursor.map_or_else(|| json!({}), |cursor| json!({"cursor": cursor}));
        let result = client
            .request(
                "resources/templates/list",
                params,
                timeout,
                &CancellationToken::new(),
            )
            .await
            .map_err(|error| ui_error(server, "resources/templates/list", error))?;
        Ok(McpResourceTemplatePage {
            resource_templates: result
                .get("resourceTemplates")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(resource_template).collect())
                .unwrap_or_default(),
            next_cursor: next_cursor(&result),
        })
    }

    /// `resources/read`：内容原样交回（`_meta` 保留；面向页面的界在协议层）。
    pub async fn read_resource(
        &self,
        server: &str,
        uri: &str,
    ) -> Result<Vec<McpResourceContent>, McpUiError> {
        let (client, timeout) = self.resource_client(server)?;
        let result = client
            .request(
                "resources/read",
                json!({"uri": uri}),
                timeout,
                &CancellationToken::new(),
            )
            .await
            .map_err(|error| ui_error(server, "resources/read", error))?;
        Ok(result
            .get("contents")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(resource_content).collect())
            .unwrap_or_default())
    }

    /// 服务器的资源订阅能力（MCP Apps 的资源订阅只在声明了 `resources.subscribe` 时可用）。
    pub fn supports_resource_subscribe(&self, server: &str) -> bool {
        self.0
            .servers()
            .get(server)
            .is_some_and(|server| server.status == McpStatus::Connected && server.resource_subscribe)
    }

    /// 订阅一个资源：第一个订阅者向服务器发 `resources/subscribe`；失败时撤回这次登记。
    pub async fn subscribe_resource(
        &self,
        server: &str,
        uri: &str,
        key: &str,
        instance: &McpAppInstance,
    ) -> Result<(), McpUiError> {
        let (client, timeout) = self.resource_client(server)?;
        if !self.supports_resource_subscribe(server) {
            return Err(McpUiError::unsupported(server, "resources/subscribe"));
        }
        let first = {
            let mut subscriptions = self
                .0
                .subscriptions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let entry = subscriptions
                .entry((server.to_owned(), uri.to_owned()))
                .or_default();
            let first = entry.is_empty();
            entry.insert(key.to_owned(), instance.clone());
            first
        };
        if first
            && let Err(error) = client
                .request(
                    "resources/subscribe",
                    json!({"uri": uri}),
                    timeout,
                    &CancellationToken::new(),
                )
                .await
        {
            // 撤回这次的登记；期间若别的订阅者进来了，保留登记。
            let mut subscriptions = self
                .0
                .subscriptions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(entry) = subscriptions.get_mut(&(server.to_owned(), uri.to_owned())) {
                entry.remove(key);
                if entry.is_empty() {
                    subscriptions.remove(&(server.to_owned(), uri.to_owned()));
                }
            }
            return Err(ui_error(server, "resources/subscribe", error));
        }
        Ok(())
    }

    /// 退订一个资源：最后一个订阅者退订时向服务器发 `resources/unsubscribe`（尽力而为）。
    pub async fn unsubscribe_resource(
        &self,
        server: &str,
        uri: &str,
        key: &str,
    ) -> Result<(), McpUiError> {
        let last = {
            let mut subscriptions = self
                .0
                .subscriptions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let Some(entry) = subscriptions.get_mut(&(server.to_owned(), uri.to_owned())) else {
                return Ok(());
            };
            entry.remove(key);
            if !entry.is_empty() {
                return Ok(());
            }
            subscriptions.remove(&(server.to_owned(), uri.to_owned()));
            true
        };
        if last
            && let Ok((client, timeout)) = self.resource_client(server)
        {
            // 连接已经没了也不算错误：退订是收尾动作。
            let _ = client
                .request(
                    "resources/unsubscribe",
                    json!({"uri": uri}),
                    timeout,
                    &CancellationToken::new(),
                )
                .await;
        }
        Ok(())
    }

    /// 页面关闭：退掉它（`session|token|` 前缀）的全部订阅（Node `unsubscribeResourcesForUi`）。
    pub async fn unsubscribe_resources_for(&self, prefix: &str) {
        let emptied: Vec<(String, String)> = {
            let mut subscriptions = self
                .0
                .subscriptions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let mut emptied = Vec::new();
            for ((server, uri), entry) in subscriptions.iter_mut() {
                entry.retain(|key, _| !key.starts_with(prefix));
                if entry.is_empty() {
                    emptied.push((server.clone(), uri.clone()));
                }
            }
            for key in &emptied {
                subscriptions.remove(key);
            }
            emptied
        };
        for (server, uri) in emptied {
            if let Ok((client, timeout)) = self.resource_client(&server) {
                let _ = client
                    .request(
                        "resources/unsubscribe",
                        json!({"uri": uri}),
                        timeout,
                        &CancellationToken::new(),
                    )
                    .await;
            }
        }
    }

    /// 服务器的 prompts（`prompts/list` 的原样结果）。
    pub fn prompts(&self, server: &str) -> Vec<Value> {
        self.0
            .servers()
            .get(server)
            .map(|server| server.prompts.clone())
            .unwrap_or_default()
    }

    /// 等全部服务器离开 `Pending`（连上或失败）。
    pub async fn wait_ready(&self) {
        let mut changes = self.0.changed.subscribe();
        loop {
            let pending = self
                .0
                .servers()
                .values()
                .any(|server| server.status == McpStatus::Pending);
            if !pending || changes.changed().await.is_err() {
                return;
            }
        }
    }
}

/// 有 resources 能力的服务器时先是三个资源工具，然后是已连接的服务器的工具（按名字排序）。`servers` 是调用方
/// 持有的锁里的表：快照（manager_state.rs）与工具、状态在同一把锁里取。这是给模型的工具表：名字太长的工具不在里面
/// （主线程、子代理、ToolSearch 与直接调用都从这里取，ext.md §3.4）；`/mcp` 的工具数仍按服务器列出的全部工具。
fn tools_of(inner: &Arc<Inner>, servers: &BTreeMap<String, Server>) -> Vec<Arc<dyn Tool>> {
    let connected = || {
        servers
            .values()
            .filter(|server| server.status == McpStatus::Connected)
    };
    // 资源工具：有 resources 能力的服务器连上过一次之后一直在（服务器断开不撤回，ext.md §3.3.3）。
    let seen = inner.resources_seen.load(Ordering::Relaxed);
    let mut tools: Vec<Arc<dyn Tool>> = if seen || connected().any(|server| server.resources) {
        resources::tools(Arc::downgrade(inner))
    } else {
        Vec::new()
    };
    let mut own: Vec<Arc<dyn Tool>> = connected()
        .flat_map(|server| server.model_tools.iter())
        .filter(|tool| !name_too_long(tool.name()))
        .cloned()
        .collect();
    own.sort_by(|left, right| left.name().cmp(right.name()));
    tools.extend(own);
    tools
}

/// 服务器绑定的远端机器（`local` 与空串是本机）。
fn remote_machine(config: &McpServer) -> Option<String> {
    config
        .machine
        .clone()
        .filter(|name| !name.is_empty() && name != rust_cli_kernel_api::env_registry::LOCAL_MACHINE)
}

/// 已连接、有 instructions 的服务器，按名字排序：`## <server>\n<instructions>`（ext.md §3.6）。
fn instructions_of(servers: &BTreeMap<String, Server>) -> Vec<ListingEntry> {
    servers
        .values()
        .filter(|server| server.status == McpStatus::Connected)
        .filter_map(|server| {
            let text = server.instructions.as_ref()?;
            Some(ListingEntry {
                name: server.config.name.clone(),
                line: format!("## {}\n{text}", server.config.name),
            })
        })
        .collect()
}

// ———— MCP Apps 的资源面与连接身份（141 审计 §9 第 6 项）————

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn resource_descriptor(value: &Value) -> Option<McpResourceDescriptor> {
    let uri = value
        .get("uri")
        .and_then(Value::as_str)
        .filter(|uri| !uri.is_empty())?;
    Some(McpResourceDescriptor {
        uri: uri.to_owned(),
        name: string_field(value, "name"),
        title: string_field(value, "title"),
        description: string_field(value, "description"),
        mime_type: string_field(value, "mimeType"),
        meta: value.get("_meta").and_then(Value::as_object).cloned(),
    })
}

fn resource_template(value: &Value) -> Option<McpResourceTemplate> {
    let uri_template = value
        .get("uriTemplate")
        .and_then(Value::as_str)
        .filter(|uri| !uri.is_empty())?;
    Some(McpResourceTemplate {
        uri_template: uri_template.to_owned(),
        name: string_field(value, "name"),
        title: string_field(value, "title"),
        description: string_field(value, "description"),
        mime_type: string_field(value, "mimeType"),
    })
}

fn resource_content(value: &Value) -> Option<McpResourceContent> {
    let uri = value.get("uri").and_then(Value::as_str)?;
    Some(McpResourceContent {
        uri: uri.to_owned(),
        mime_type: string_field(value, "mimeType"),
        text: string_field(value, "text"),
        blob: string_field(value, "blob"),
        meta: value.get("_meta").and_then(Value::as_object).cloned(),
    })
}

fn next_cursor(value: &Value) -> Option<String> {
    value
        .get("nextCursor")
        .and_then(Value::as_str)
        .filter(|cursor| !cursor.is_empty())
        .map(str::to_owned)
}

/// RPC 错误 → MCP Apps 的错误：不认识的 method 是 `Unsupported`，连接没了是 `NotConnected`。
fn ui_error(server: &str, operation: &str, error: RpcError) -> McpUiError {
    match error {
        RpcError::Server { code: -32601, .. } => McpUiError::unsupported(server, operation),
        RpcError::Closed(_) | RpcError::Send(_) => McpUiError::not_connected(server),
        other => McpUiError::failed(other.to_string()),
    }
}

/// 连接身份（Node `appConnectionSnapshot` 的 `identity`）：平台、工作区、服务器名与配置的摘要。
///
/// 与 Node 的差异：Node 还混入 `process.execPath`；内核不混入可执行文件路径——升级内核不该让页面
/// 的持久状态（widgetState 的键）失效。配置里的凭据只进摘要，不输出。
fn connection_identity(workspace: &WorkspaceRef, config: &McpServer) -> String {
    use sha2::{Digest, Sha256};

    let fingerprint = match &config.transport {
        McpTransportConfig::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            let mut env: Vec<String> = env.iter().map(|(key, value)| format!("{key}\u{1f}{value}")).collect();
            env.sort();
            format!(
                "stdio\u{1e}{command}\u{1e}{}\u{1e}{}\u{1e}{}",
                args.join("\u{1f}"),
                env.join("\u{1e}"),
                cwd.as_deref().unwrap_or("")
            )
        }
        McpTransportConfig::Sse { url, headers } => {
            format!("sse\u{1e}{url}\u{1e}{}", header_fingerprint(headers))
        }
        McpTransportConfig::Http { url, headers } => {
            format!("http\u{1e}{url}\u{1e}{}", header_fingerprint(headers))
        }
    };
    let input = format!(
        "{}\u{1e}{}\u{1e}{}\u{1e}{fingerprint}\u{1e}{:?}\u{1e}{}",
        rust_cli_kernel_api::process_table::node_platform(),
        workspace.root.as_str(),
        config.name,
        config.options.timeout_ms,
        config.options.always_load
    );
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn header_fingerprint(headers: &BTreeMap<String, String>) -> String {
    headers
        .iter()
        .map(|(key, value)| format!("{key}\u{1f}{value}"))
        .collect::<Vec<_>>()
        .join("\u{1e}")
}

/// 已连接、有 resources 能力的服务器与它们的客户端（资源工具用）。
pub(crate) fn resource_servers(inner: &Inner) -> Vec<(String, Arc<Client>)> {
    inner
        .servers()
        .values()
        .filter(|server| server.status == McpStatus::Connected && server.resources)
        .filter_map(|server| Some((server.config.name.clone(), server.client.clone()?)))
        .collect()
}

#[path = "manager_control.rs"]
mod control;

#[path = "manager_state.rs"]
mod state;

/// 失败原因写进日志的部分：前 300 个字符（与 `tool.failed` 相同，logging.md §4）。
///
/// 缺陷修复 R2-14：原来整段按 warn 记日志；HTTP 错误的原因带最多 64 KiB 的响应体（env-local
/// `ERROR_BODY_LIMIT`）。界面上的原因（`McpStatus::Failed`）不截断。
///
/// 截取只定义在 base 的 `log_text::head`（F58：以前这里与 query 各写一份）。
pub(crate) fn logged_reason(reason: &str) -> String {
    rust_cli_base::log_text::head(reason)
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "manager_names_tests.rs"]
mod names_tests;

#[cfg(test)]
#[path = "manager_dormant_tests.rs"]
mod dormant_tests;

#[cfg(test)]
#[path = "manager_machines_tests.rs"]
mod machines_tests;

#[cfg(test)]
#[path = "manager_ui_tests.rs"]
mod ui_tests;

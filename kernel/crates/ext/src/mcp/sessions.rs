//! 会话级的 MCP（NIBI `createSession.mcpServers`）：每个会话一套连接，`isolation: "workspace"` 的
//! 服务器跨会话共享一条连接。
//!
//! Node 实现里 MCP 连接在进程级的 pool 里，会话经 lease 拿到自己那批服务器：缺省 `isolation: session`
//! 每个会话一条连接，`workspace` 才跨会话复用（`pool.ts` 的 `connectionKey()` 是
//! `[serverName, scope, stableStringify(config)]`，scope 是 workspace key）。
//!
//! 这里按同一判据实现：每个会话有一个自己的 [`McpManager`]（session 级服务器），会话集合里
//! `isolation: workspace` 的服务器按 `(工作区, 名字, 配置)` 进共享表，按会话数引用计数，最后一个会话
//! 关闭时释放。会话看到的连接面是两者的合并（[`SessionConnections`]）。
//!
//! 与会话无关的进程级配置（TUI、`-p`、配置文件里的 MCP）仍走 [`Ext`](crate::Ext) 上的那个 manager；
//! 两者不混：会话带了自己的服务器时，它的工具表就是自己那批（与 Node 的 runtimeConfig.mcp 相同）。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::clock::Clock;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::mcp::McpTransport;
use nibi_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};
use nibi_kernel_api::mcp_state::{McpChildProcess, McpConnections, McpView};
use nibi_kernel_api::process_table::McpResourceTarget;
use nibi_kernel_api::tool::Tool;
use nibi_kernel_base::Spawner;

use super::telemetry::{McpTelemetry, McpTelemetrySlot};
use super::{McpManager, McpScope, McpServer, McpServerOptions, McpSettings};

/// 一个会话看到的连接面：自己的连接 + 从工作区共享表借来的连接。
pub(crate) struct SessionConnections {
    session: Arc<McpManager>,
    shared: Vec<Arc<McpManager>>,
}

impl SessionConnections {
    /// 只包一套 manager（会话没有自己的服务器时回落到进程级配置）。
    pub(crate) fn single(manager: Arc<McpManager>) -> Self {
        Self {
            session: manager,
            shared: Vec::new(),
        }
    }

    fn managers(&self) -> impl Iterator<Item = &Arc<McpManager>> {
        std::iter::once(&self.session).chain(self.shared.iter())
    }

    /// 这一时点的工具表与连接状态（合并；服务器按名字排序，与单个 manager 的快照同形）。
    pub(crate) fn snapshot(&self) -> (Vec<Arc<dyn Tool>>, McpView) {
        let mut tools = Vec::new();
        let mut view = McpView::default();
        for manager in self.managers() {
            let (own_tools, own_view) = manager.snapshot();
            tools.extend(own_tools);
            view.servers.extend(own_view.servers);
            view.instructions.extend(own_view.instructions);
        }
        view.servers.sort_by(|left, right| left.name.cmp(&right.name));
        (tools, view)
    }

    pub(crate) fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.managers().find_map(|manager| manager.find(name))
    }

    pub(crate) fn has_servers(&self) -> bool {
        self.managers().any(|manager| manager.has_servers())
    }

    pub(crate) fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.snapshot().0
    }

    /// 等到每一套连接都离开 Pending（测试与 `-p` 的启动等待共用）。
    pub(crate) async fn wait_ready(&self) {
        for manager in self.managers() {
            manager.wait_ready().await;
        }
    }

    /// 知道这个服务器的那个 manager（按名字找；自己的与工作区共享的都算）。
    fn owner(&self, server: &str) -> Option<&Arc<McpManager>> {
        self.managers()
            .find(|manager| manager.view().servers.iter().any(|row| row.name == server))
    }

    /// 页面绑定的连接（`mcp/uiOpenInstance`）。
    pub(crate) fn app_connection(&self, server: &str) -> Option<nibi_kernel_api::mcp_ui::McpAppConnection> {
        self.owner(server)?.app_connection(server)
    }

    pub(crate) fn app_tool_visibility(&self, server: &str, tool: &str) -> Option<Vec<String>> {
        self.owner(server)?.app_tool_visibility(server, tool)
    }

    pub(crate) fn ui_tool(&self, server: &str, tool: &str) -> Option<Arc<dyn Tool>> {
        self.owner(server)?.ui_tool(server, tool)
    }

    pub(crate) async fn call_tool_for_ui(
        &self,
        server: &str,
        tool: &str,
        arguments: serde_json::Value,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<serde_json::Value, nibi_kernel_api::mcp_ui::McpUiError> {
        let manager = self
            .owner(server)
            .ok_or_else(nibi_kernel_api::mcp_ui::McpUiError::app_unavailable)?;
        manager.call_tool_for_ui(server, tool, arguments, cancel).await
    }

    pub(crate) async fn list_resources(
        &self,
        server: &str,
        cursor: Option<&str>,
    ) -> Result<nibi_kernel_api::mcp_ui::McpResourcePage, nibi_kernel_api::mcp_ui::McpUiError> {
        let manager = self
            .owner(server)
            .ok_or_else(nibi_kernel_api::mcp_ui::McpUiError::app_unavailable)?;
        manager.list_resources(server, cursor).await
    }

    pub(crate) async fn list_resource_templates(
        &self,
        server: &str,
        cursor: Option<&str>,
    ) -> Result<
        nibi_kernel_api::mcp_ui::McpResourceTemplatePage,
        nibi_kernel_api::mcp_ui::McpUiError,
    > {
        let manager = self
            .owner(server)
            .ok_or_else(nibi_kernel_api::mcp_ui::McpUiError::app_unavailable)?;
        manager.list_resource_templates(server, cursor).await
    }

    pub(crate) async fn read_resource(
        &self,
        server: &str,
        uri: &str,
    ) -> Result<
        Vec<nibi_kernel_api::mcp_ui::McpResourceContent>,
        nibi_kernel_api::mcp_ui::McpUiError,
    > {
        let manager = self
            .owner(server)
            .ok_or_else(nibi_kernel_api::mcp_ui::McpUiError::app_unavailable)?;
        manager.read_resource(server, uri).await
    }

    pub(crate) async fn subscribe_resource(
        &self,
        server: &str,
        uri: &str,
        key: &str,
        instance: &nibi_kernel_api::mcp_ui::McpAppInstance,
    ) -> Result<(), nibi_kernel_api::mcp_ui::McpUiError> {
        let manager = self
            .owner(server)
            .ok_or_else(nibi_kernel_api::mcp_ui::McpUiError::app_unavailable)?;
        manager.subscribe_resource(server, uri, key, instance).await
    }

    pub(crate) async fn unsubscribe_resource(
        &self,
        server: &str,
        uri: &str,
        key: &str,
    ) -> Result<(), nibi_kernel_api::mcp_ui::McpUiError> {
        let manager = self
            .owner(server)
            .ok_or_else(nibi_kernel_api::mcp_ui::McpUiError::app_unavailable)?;
        manager.unsubscribe_resource(server, uri, key).await
    }

    /// 退掉前缀匹配的资源订阅（前缀由会话与页面凭证组成：试每一套连接都安全）。
    pub(crate) async fn unsubscribe_resources_for(&self, prefix: &str) {
        for manager in self.managers() {
            manager.unsubscribe_resources_for(prefix).await;
        }
    }

    /// 这套连接面用到的 manager 指针（测试断言共享/独占用）。
    #[cfg(test)]
    pub(crate) fn identities(&self) -> Vec<*const ()> {
        self.managers()
            .map(|manager| Arc::as_ptr(manager) as *const ())
            .collect()
    }

    /// 只属于工作区共享表的那些 manager 指针。
    #[cfg(test)]
    pub(crate) fn shared_identities(&self) -> Vec<*const ()> {
        self.shared
            .iter()
            .map(|manager| Arc::as_ptr(manager) as *const ())
            .collect()
    }

    /// 这个会话的主线程请求带过 WaitForMcpServers（任一部分登记即算）。
    pub(crate) fn declared(&self, session: &SessionId) -> bool {
        self.managers().any(|manager| manager.declared(session))
    }
}

#[async_trait]
impl McpConnections for SessionConnections {
    fn view(&self) -> McpView {
        self.snapshot().1
    }

    async fn wait(
        &self,
        wait_ms: u64,
        done: &(dyn for<'v> Fn(&'v McpView) -> bool + Send + Sync),
    ) -> McpView {
        let started = std::time::Instant::now();
        let mut view = self.view();
        for manager in self.managers() {
            if done(&view) {
                break;
            }
            let elapsed = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            view = manager.wait(wait_ms.saturating_sub(elapsed), done).await;
        }
        view
    }

    fn declare_wait_tool(&self, session: &SessionId) {
        for manager in self.managers() {
            manager.declare_wait_tool(session);
        }
    }

    fn tool_wait_ms(&self) -> u64 {
        self.managers()
            .map(|manager| manager.tool_wait_ms())
            .min()
            .unwrap_or(0)
    }

    fn processes(&self) -> Vec<McpChildProcess> {
        self.managers()
            .flat_map(|manager| manager.processes())
            .collect()
    }

    fn resource_targets(&self) -> Vec<McpResourceTarget> {
        self.managers()
            .flat_map(|manager| manager.resource_targets())
            .collect()
    }
}

/// 一个会话的 MCP 连接：`owned` 表示这套连接是这个会话自己的（关闭时释放）；子代理继承的是父
/// 会话的连接（`owned: false`），关闭子会话不能把父会话的连接关掉。
struct Entry {
    connections: Arc<SessionConnections>,
    owned: bool,
    /// 这个会话当前这批服务器（插件快照 + Host `createSession.mcpServers` 合并后的完整集合）。
    servers: Vec<SessionMcpServer>,
    /// 从共享表借来的键（`owned` 时关闭要归还引用）。
    borrowed: Vec<SharedKey>,
}

/// 工作区共享连接的键：Node `connectionKey()` 的 `[serverName, scope, stableStringify(config)]`
/// （scope 是 workspace key）。
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SharedKey {
    workspace: String,
    name: String,
    config: String,
}

struct SharedEntry {
    manager: Arc<McpManager>,
    refs: usize,
}

/// 会话 → 这个会话的 MCP 连接。管理器本身很小，重活在各服务器的连接任务里。
pub(crate) struct SessionMcp {
    transport: Arc<dyn McpTransport>,
    spawner: Spawner,
    settings: McpSettings,
    clock: Arc<dyn Clock>,
    /// 进程遥测的出口（`process/mcpTelemetry`）：会话级是 `session`，共享的是 `workspace`。
    telemetry: Option<Arc<McpTelemetry>>,
    /// MCP Apps 的事件出口（`pluginUi.*` 增量）：每套 manager 装同一份。
    ui_events: Option<tokio::sync::mpsc::UnboundedSender<nibi_kernel_api::mcp_ui::McpUiEvent>>,
    /// MCP Apps 的实例账本：连接断了时按（会话, 服务器）作废页面凭证。`Ext::new` 建好之后装上。
    app_instances: std::sync::OnceLock<Arc<super::McpAppInstances>>,
    sessions: Mutex<BTreeMap<SessionId, Entry>>,
    /// 工作区共享的连接（`isolation: "workspace"`）。
    shared: Mutex<BTreeMap<SharedKey, SharedEntry>>,
}

impl SessionMcp {
    pub(crate) fn new(
        transport: Arc<dyn McpTransport>,
        spawner: Spawner,
        settings: McpSettings,
        clock: Arc<dyn Clock>,
        telemetry: Option<Arc<McpTelemetry>>,
        ui_events: Option<tokio::sync::mpsc::UnboundedSender<nibi_kernel_api::mcp_ui::McpUiEvent>>,
    ) -> Self {
        Self {
            transport,
            spawner,
            settings,
            clock,
            telemetry,
            ui_events,
            app_instances: std::sync::OnceLock::new(),
            sessions: Mutex::default(),
            shared: Mutex::default(),
        }
    }

    /// 装上 MCP Apps 的实例账本：连接断了时作废页面凭证。
    pub(crate) fn set_app_instances(&self, instances: Arc<super::McpAppInstances>) {
        let _ = self.app_instances.set(instances);
    }

    /// 当前所有会话级 manager（含工作区共享的；同一份只返回一次）。`process/childProcesses` 与
    /// 五分钟采样都要看到这条路径上的连接——NIBI 的桌面会话走的正是它。
    pub(crate) fn managers(&self) -> Vec<Arc<dyn McpConnections>> {
        let mut seen: Vec<*const ()> = Vec::new();
        let mut managers: Vec<Arc<dyn McpConnections>> = Vec::new();
        let mut push = |manager: &Arc<McpManager>, seen: &mut Vec<*const ()>| {
            let pointer = Arc::as_ptr(manager) as *const ();
            if seen.contains(&pointer) {
                return;
            }
            seen.push(pointer);
            managers.push(manager.clone());
        };
        for entry in self.sessions().values() {
            push(&entry.connections.session, &mut seen);
            for manager in &entry.connections.shared {
                push(manager, &mut seen);
            }
        }
        managers
    }

    fn sessions(&self) -> MutexGuard<'_, BTreeMap<SessionId, Entry>> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn shared(&self) -> MutexGuard<'_, BTreeMap<SharedKey, SharedEntry>> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 给会话装上这批服务器并开始连接（不等待）。同一会话再给一次时**合并**：
    /// 插件快照先装、Host 的 `createSession.mcpServers` 后装，同名覆盖、新名字追加；
    /// 最后仍是一套完整集合（Node 一次给全量，这里分两次给的是同一事实）。
    pub(crate) fn start(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        servers: Vec<SessionMcpServer>,
    ) -> Arc<SessionConnections> {
        self.install(session, workspace, servers, true)
    }

    /// 换掉这个会话的整套服务器（Node `connectConfiguredServers` 的“这次给的是完整集合”）。
    #[cfg(test)]
    pub(crate) fn replace(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        servers: Vec<SessionMcpServer>,
    ) -> Arc<SessionConnections> {
        self.install(session, workspace, servers, false)
    }

    fn install(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        servers: Vec<SessionMcpServer>,
        merge: bool,
    ) -> Arc<SessionConnections> {
        let previous = self.sessions().remove(session);
        // 继承来的条目不是自己的连接：不并进新集合，也不释放。
        let mut merged = if merge {
            previous
                .as_ref()
                .filter(|entry| entry.owned)
                .map(|entry| entry.servers.clone())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        for server in servers {
            match merged.iter_mut().find(|known| known.name == server.name) {
                Some(known) => *known = server,
                None => merged.push(server),
            }
        }
        let (workspace_servers, session_servers): (Vec<_>, Vec<_>) = merged
            .iter()
            .cloned()
            .partition(|server| server.isolation == McpIsolation::Workspace);
        let manager = self.manager(Some(session), "session");
        manager.start(workspace.clone(), to_servers(session_servers));
        let mut borrowed = Vec::new();
        let mut shared = Vec::new();
        for server in workspace_servers {
            let key = SharedKey {
                workspace: workspace.root.as_str().to_owned(),
                name: server.name.clone(),
                config: config_fingerprint(&server),
            };
            let manager = self.borrow_shared(key.clone(), workspace, &server);
            borrowed.push(key);
            shared.push(manager);
        }
        let connections = Arc::new(SessionConnections {
            session: manager,
            shared,
        });
        self.sessions().insert(
            session.clone(),
            Entry {
                connections: connections.clone(),
                owned: true,
                servers: merged,
                borrowed,
            },
        );
        if let Some(previous) = previous.filter(|entry| entry.owned) {
            self.release(previous);
        }
        connections
    }

    /// 共享表里拿一条连接（没有就建），引用数加一。
    fn borrow_shared(
        &self,
        key: SharedKey,
        workspace: &WorkspaceRef,
        server: &SessionMcpServer,
    ) -> Arc<McpManager> {
        let mut table = self.shared();
        if let Some(entry) = table.get_mut(&key) {
            entry.refs += 1;
            return entry.manager.clone();
        }
        let manager = self.manager(None, "workspace");
        manager.start(workspace.clone(), to_servers(vec![server.clone()]));
        table.insert(
            key,
            SharedEntry {
                manager: manager.clone(),
                refs: 1,
            },
        );
        manager
    }

    /// 新的一套连接（会话级或工作区级），遥测与页面账本的隔离口径跟着传。
    fn manager(&self, session: Option<&SessionId>, isolation: &'static str) -> Arc<McpManager> {
        let manager = Arc::new(McpManager::new(
            self.transport.clone(),
            self.spawner.clone(),
            self.settings.clone(),
            self.clock.clone(),
        ));
        if let Some(telemetry) = self.telemetry.clone() {
            manager.attach_telemetry(McpTelemetrySlot {
                telemetry,
                isolation,
                session: session.cloned(),
            });
        }
        if let Some(events) = self.ui_events.clone() {
            manager.attach_ui_events(events);
        }
        if let Some(instances) = self.app_instances.get().cloned() {
            // 共享服务器断线时，所有会话的页面凭证都要作废（server 维度，不按会话过滤）。
            let session = session.cloned();
            manager.set_on_connection_lost(Arc::new(move |server| {
                instances.close_server(session.as_ref().map(SessionId::as_str), server);
            }));
        }
        manager
    }

    /// 会话现在的连接面；没带过服务器（或已关闭）时为 None，工具表回落到进程级配置。
    pub(crate) fn manager_of(&self, session: &SessionId) -> Option<Arc<SessionConnections>> {
        self.sessions()
            .get(session)
            .map(|entry| entry.connections.clone())
    }

    /// 子代理会话继承父会话的连接（NIBI `createSession.mcpServers`）：Node 的子代理 app 直接拿父的
    /// `config.mcp`，工具可见性相同。共用同一个连接面，不另建连接；父会话没有时什么都不做。
    pub(crate) fn inherit(&self, parent: &SessionId, child: &SessionId) {
        let inherited = self.sessions().get(parent).map(|entry| Entry {
            connections: entry.connections.clone(),
            owned: false,
            servers: entry.servers.clone(),
            borrowed: Vec::new(),
        });
        if let Some(inherited) = inherited {
            self.sessions().insert(child.clone(), inherited);
        }
    }

    /// 会话关闭：取消连接任务、关掉客户端（在后台任务里做，关闭路径不等待 IO）。继承来的条目只是
    /// 从表里移掉，父会话的连接照常。
    pub(crate) fn stop(&self, session: &SessionId) {
        if let Some(entry) = self.sessions().remove(session)
            && entry.owned
        {
            self.release(entry);
        }
    }

    /// 释放一套连接：会话自己的 manager 停掉；共享的引用计数减一，减到 0 才停。
    fn release(&self, entry: Entry) {
        self.spawn_stop(entry.connections.session.clone());
        if entry.borrowed.is_empty() {
            return;
        }
        let mut stopping = Vec::new();
        {
            let mut table = self.shared();
            for key in entry.borrowed {
                let unused = match table.get_mut(&key) {
                    Some(shared) => {
                        shared.refs = shared.refs.saturating_sub(1);
                        shared.refs == 0
                    }
                    None => false,
                };
                if unused && let Some(shared) = table.remove(&key) {
                    stopping.push(shared.manager);
                }
            }
        }
        for manager in stopping {
            self.spawn_stop(manager);
        }
    }

    fn spawn_stop(&self, manager: Arc<McpManager>) {
        let task = async move { manager.stop_all().await };
        self.spawner.spawn_resident("mcp-session-stop", task);
    }
}

/// 协议的类型换成 ext 的配置快照：作用域是 `Dynamic`（`--mcp-config` 那一档），不绑定远端机器。
fn to_servers(servers: Vec<SessionMcpServer>) -> Vec<McpServer> {
    servers
        .into_iter()
        .map(|server| McpServer {
            name: server.name,
            scope: McpScope::Dynamic,
            transport: server.transport,
            options: McpServerOptions {
                timeout_ms: server.timeout_ms,
                always_load: server.always_load,
            },
            machine: None,
        })
        .collect()
}

/// 共享连接的配置指纹（Node `stableStringify(config)` 的同一用法）：配置变了就是另一条连接。
fn config_fingerprint(server: &SessionMcpServer) -> String {
    serde_json::json!({
        "transport": server.transport,
        "alwaysLoad": server.always_load,
        "timeoutMs": server.timeout_ms,
    })
    .to_string()
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;

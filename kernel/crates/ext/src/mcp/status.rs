//! 工作区级的 MCP 状态检查（Host `mcp/list`，141 审计 §9 第 6 项 F7 的第一条）。
//!
//! 桌面在设置页用一个**独立于会话**的连接集合做状态检查：`mode: "connect"` 把这次给的完整集合
//! 收敛进连接管理（新增、换配置重启、缺席的断开）并等连接落定；`mode: "status"` 只读快照
//! （OAuth 轮询走这一条，参数里的 `mcpServers` 可能只是 pending 子集，不能进 replace）。
//!
//! 这里每个工作区根一个 [`McpManager`]：与会话级的连接（`SessionMcp`）和进程级的配置连接
//! （`Ext::mcp`）都分开，语义与 Node 的「mcp/list 专用进程」一致——状态页的连接不改变任何会话的
//! 工具表，会话也不会因为这些连接多出工具。
//!
//! 集合的来源：Host 显式下发的 `mcpServers`（UI 解析出来的那一份）是权威；缺席时用进程自己
//! 从配置读到的集合（Node 的 `createConfig`）。插件提供的 MCP 服务器总是并入——设置页的插件
//! 分组按名字读同一份快照（`buildPluginMcpServerItems`）。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use nibi_kernel_base::Spawner;
use nibi_kernel_api::clock::Clock;
use nibi_kernel_api::mcp::McpTransport;
use nibi_kernel_api::mcp_session::SessionMcpServer;
use nibi_kernel_api::mcp_status::{McpListRequest, McpServerStatus};

use super::telemetry::{McpTelemetry, McpTelemetrySlot};
use super::{McpManager, McpScope, McpServer, McpServerOptions, McpSettings};

/// 连接落定之后再等一会儿的余量（连接任务的状态更新是异步的）。
const SETTLE_SLACK_MS: u64 = 5_000;

/// `Ext::start` 读到的那一份服务器（工作区对应）。
struct Seed {
    root: String,
    /// 配置里的服务器（`mcpServers` 缺席时的集合）。
    configured: Vec<McpServer>,
    /// 插件提供的服务器（总是并入）。
    plugin: Vec<McpServer>,
}

pub(crate) struct McpStatusRegistry {
    transport: Arc<dyn McpTransport>,
    spawner: Spawner,
    settings: McpSettings,
    clock: Arc<dyn Clock>,
    /// 进程遥测的出口（与进程级 manager 共用一份）。
    telemetry: Option<Arc<McpTelemetry>>,
    /// 令牌端口（与进程级 manager 共用一份）。
    oauth: Option<Arc<dyn nibi_kernel_api::mcp::McpOAuthPort>>,
    seed: Mutex<Option<Seed>>,
    /// 工作区根 → 这套连接。
    managers: Mutex<BTreeMap<String, Arc<McpManager>>>,
}

impl McpStatusRegistry {
    pub(crate) fn new(
        transport: Arc<dyn McpTransport>,
        spawner: Spawner,
        settings: McpSettings,
        clock: Arc<dyn Clock>,
        telemetry: Option<Arc<McpTelemetry>>,
        oauth: Option<Arc<dyn nibi_kernel_api::mcp::McpOAuthPort>>,
    ) -> Self {
        Self {
            transport,
            spawner,
            settings,
            clock,
            telemetry,
            oauth,
            seed: Mutex::new(None),
            managers: Mutex::new(BTreeMap::new()),
        }
    }

    /// `Ext::start` 记下配置与插件的服务器。
    pub(crate) fn seed(&self, root: &str, configured: Vec<McpServer>, plugin: Vec<McpServer>) {
        *self.seed.lock().unwrap_or_else(PoisonError::into_inner) = Some(Seed {
            root: root.to_owned(),
            configured,
            plugin,
        });
    }

    fn managers_mutex(&self) -> MutexGuard<'_, BTreeMap<String, Arc<McpManager>>> {
        self.managers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// 这些连接管理（`process/childProcesses` 与五分钟采样要把状态页的子进程也算上）。
    pub(crate) fn managers(&self) -> Vec<Arc<McpManager>> {
        self.managers_mutex().values().cloned().collect()
    }

    /// 这个工作区的连接管理；第一次要时建。
    fn manager(&self, root: &str) -> Arc<McpManager> {
        let mut managers = self.managers_mutex();
        managers
            .entry(root.to_owned())
            .or_insert_with(|| {
                let manager = Arc::new(McpManager::new(
                    self.transport.clone(),
                    self.spawner.clone(),
                    self.settings.clone(),
                    self.clock.clone(),
                ));
                if let Some(telemetry) = self.telemetry.clone() {
                    manager.attach_telemetry(McpTelemetrySlot {
                        telemetry,
                        isolation: "workspace",
                        session: None,
                    });
                }
                if let Some(oauth) = self.oauth.clone() {
                    manager.attach_oauth(oauth);
                }
                manager
            })
            .clone()
    }

    /// 这次请求要收敛到的集合：显式下发的（权威）或配置里的，再并入插件服务器。
    fn targets(&self, request: &McpListRequest) -> Vec<McpServer> {
        let root = request.workspace.root.as_str();
        let seed = self.seed.lock().unwrap_or_else(PoisonError::into_inner);
        let seed = seed.as_ref().filter(|seed| seed.root == root);
        let mut servers: Vec<McpServer> = match &request.servers {
            Some(explicit) => explicit.iter().map(to_server).collect(),
            None => seed.map(|seed| seed.configured.clone()).unwrap_or_default(),
        };
        let mut names: BTreeSet<String> = servers.iter().map(|server| server.name.clone()).collect();
        if let Some(seed) = seed {
            for plugin in &seed.plugin {
                if names.insert(plugin.name.clone()) {
                    servers.push(plugin.clone());
                }
            }
        }
        servers
    }

    /// `mcp/list` 的一次请求。`connect` 时收敛并等连接落定（有上限）；`status` 只读。
    pub(crate) async fn list(&self, request: McpListRequest) -> Vec<McpServerStatus> {
        let root = request.workspace.root.as_str().to_owned();
        let known = self.managers_mutex().contains_key(&root);
        if !request.connect {
            // 只读：没有连接管理时，显式下发的服务器就是「没连过」，如实报 disconnected。
            if !known {
                return request
                    .servers
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(|server| {
                        McpServerStatus::disconnected(
                            &server.name,
                            server.transport.kind(),
                            self.clock.now_ms(),
                        )
                    })
                    .collect();
            }
            let statuses = self.manager(&root).server_statuses();
            return self.with_missing(request.servers.as_deref(), statuses);
        }
        let manager = self.manager(&root);
        let targets = self.targets(&request);
        let wait_ms = targets
            .iter()
            .map(|server| {
                server
                    .options
                    .timeout_ms
                    .unwrap_or(self.settings.connect_timeout_ms)
            })
            .max()
            .unwrap_or(self.settings.connect_timeout_ms)
            .saturating_add(SETTLE_SLACK_MS);
        manager.reconcile(request.workspace.clone(), targets);
        // 有上限：连接任务自己的期限会成为 Failed，这里只是防止状态更新晚到一步。
        let _ = tokio::time::timeout(Duration::from_millis(wait_ms), manager.wait_ready()).await;
        let statuses = manager.server_statuses();
        self.with_missing(request.servers.as_deref(), statuses)
    }

    /// 显式下发、但连接管理里没有的服务器补一条 `disconnected`：Host 的 `mode: "status"` 只合并
    /// 返回的键，不补的话这些行会一直停在旧状态。
    fn with_missing(
        &self,
        explicit: Option<&[SessionMcpServer]>,
        mut statuses: Vec<McpServerStatus>,
    ) -> Vec<McpServerStatus> {
        let Some(explicit) = explicit else {
            return statuses;
        };
        let known: BTreeSet<String> = statuses
            .iter()
            .map(|status| status.name.clone())
            .collect();
        let now = self.clock.now_ms();
        for server in explicit {
            if !known.contains(&server.name) {
                statuses.push(McpServerStatus::disconnected(
                    &server.name,
                    server.transport.kind(),
                    now,
                ));
            }
        }
        statuses
    }
}

/// 协议的类型换成 ext 的配置快照：作用域是 `Dynamic`（与 `mcp_session` 的会话级服务器同一档），
/// 不绑定远端机器。
fn to_server(server: &SessionMcpServer) -> McpServer {
    McpServer {
        name: server.name.clone(),
        scope: McpScope::Dynamic,
        transport: server.transport.clone(),
        options: McpServerOptions {
            timeout_ms: server.timeout_ms,
            always_load: server.always_load,
        },
        machine: None,
        oauth: server.oauth.clone(),
        protocol: server.protocol_version,
    }
}

#[cfg(test)]
#[path = "status_tests.rs"]
mod tests;

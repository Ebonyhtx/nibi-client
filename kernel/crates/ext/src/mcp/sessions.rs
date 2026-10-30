//! 会话级的 MCP（NIBI `createSession.mcpServers`）：每个会话一套连接。
//!
//! Node 实现里 MCP 连接在进程级的 pool 里，会话经 lease 拿到自己那批服务器（缺省 `isolation: session`：
//! 每个会话一条连接；`workspace` 才跨会话复用）。这里用"每个会话一个 [`McpManager`]"表达同一语义：
//! 连接、工具快照与等待状态都在会话自己的 manager 里，会话关闭时一并释放。
//!
//! 与会话无关的进程级配置（TUI、`-p`、配置文件里的 MCP）仍走 [`Ext`](crate::Ext) 上的那个 manager；
//! 两者不混：会话带了自己的服务器时，它的工具表就是自己那批（与 Node 的 runtimeConfig.mcp 相同）。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rust_cli_base::Spawner;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp::McpTransport;
use rust_cli_kernel_api::mcp_session::SessionMcpServer;

use super::{McpManager, McpScope, McpServer, McpServerOptions, McpSettings};

/// 一个会话的 MCP 连接：`owned` 表示这套连接是这个会话自己的（关闭时释放）；子代理继承的是父
/// 会话的连接（`owned: false`），关闭子会话不能把父会话的连接关掉。
struct Entry {
    manager: Arc<McpManager>,
    owned: bool,
}

/// 会话 → 这个会话的 MCP 连接。管理器本身很小，重活在各服务器的连接任务里。
pub(crate) struct SessionMcp {
    transport: Arc<dyn McpTransport>,
    spawner: Spawner,
    settings: McpSettings,
    clock: Arc<dyn Clock>,
    sessions: Mutex<BTreeMap<SessionId, Entry>>,
}

impl SessionMcp {
    pub(crate) fn new(
        transport: Arc<dyn McpTransport>,
        spawner: Spawner,
        settings: McpSettings,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            transport,
            spawner,
            settings,
            clock,
            sessions: Mutex::default(),
        }
    }

    fn sessions(&self) -> MutexGuard<'_, BTreeMap<SessionId, Entry>> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// 给会话装上这批服务器并开始连接（不等待）。同一会话再给一次时换掉旧的一套：
    /// Node 的 `connectConfiguredServers` 也是"这次给的是完整集合"。
    pub(crate) fn start(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        servers: Vec<SessionMcpServer>,
    ) -> Arc<McpManager> {
        let manager = Arc::new(McpManager::new(
            self.transport.clone(),
            self.spawner.clone(),
            self.settings.clone(),
            self.clock.clone(),
        ));
        manager.start(workspace.clone(), to_servers(servers));
        let previous = self.sessions().insert(
            session.clone(),
            Entry {
                manager: manager.clone(),
                owned: true,
            },
        );
        // 继承来的条目不是自己的连接，不释放。
        if let Some(previous) = previous.filter(|entry| entry.owned) {
            self.spawn_stop(previous.manager);
        }
        manager
    }

    /// 会话现在的管理器；没带过服务器（或已关闭）时为 None，工具表回落到进程级配置。
    pub(crate) fn manager(&self, session: &SessionId) -> Option<Arc<McpManager>> {
        self.sessions().get(session).map(|entry| entry.manager.clone())
    }

    /// 子代理会话继承父会话的连接（NIBI `createSession.mcpServers`）：Node 的子代理 app 直接拿父的
    /// `config.mcp`，工具可见性相同。共用同一个 manager，不另建连接；父会话没有时什么都不做。
    pub(crate) fn inherit(&self, parent: &SessionId, child: &SessionId) {
        let manager = self.manager(parent);
        if let Some(manager) = manager {
            self.sessions().insert(
                child.clone(),
                Entry {
                    manager,
                    owned: false,
                },
            );
        }
    }

    /// 会话关闭：取消连接任务、关掉客户端（在后台任务里做，关闭路径不等待 IO）。继承来的条目只是
    /// 从表里移掉，父会话的连接照常。
    pub(crate) fn stop(&self, session: &SessionId) {
        if let Some(entry) = self.sessions().remove(session)
            && entry.owned
        {
            self.spawn_stop(entry.manager);
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

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;

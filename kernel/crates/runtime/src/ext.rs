//! skill、MCP 与插件的入口配置（docs/specs/rust-cli/ext.md §1、§6）；清单来源的合并见 listings.rs。
//! 插件的 agent 与 hooks 在这里转成 agents 与 hooks 的类型（ext.md §4）。

use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_agents::PluginAgentFile;
use nibi_kernel_ext::Plugins;
use nibi_kernel_hooks::PluginHooks;
use nibi_kernel_api::cron_store::CronStore;
use nibi_kernel_api::env::WorkspaceRef;

pub use nibi_kernel_ext::ExtConfig;

/// 会话创建时的插件快照来源（NIBI 一个 app-server 承载多个会话）。
///
/// 入口（CLI）负责重新读插件配置、安装清单与 license；每次 `session/create` 调一次，
/// 返回的快照只属于该会话，不写回进程级状态。返回空插件表示“当前没有可用插件”。
/// 快照里的 `catalog` 是 Composer `@` 插件面板的身份目录与商店条目（会话冻结）。
#[async_trait]
pub trait PluginSnapshotLoader: Send + Sync {
    async fn load(&self, workspace: &WorkspaceRef) -> nibi_kernel_ext::plugins::Loaded;
}

/// 入口层给内核的扩展配置：配置快照与持久定时任务的存储。MCP 传输在机器上（`MachineEnv::mcp()`，经 `Ports` 的注册表，
/// remote-exec.md §15.8.1）。
#[derive(Clone)]
pub struct Extensions {
    pub config: ExtConfig,
    /// 会话创建时重新读插件快照的入口；None 时用 `config.plugins` 的启动快照（CLI/TUI）。
    pub plugin_loader: Option<Arc<dyn PluginSnapshotLoader>>,
    /// 持久定时任务的存储（入口给本地的 `LocalCronStore`，第二阶段在 App 下换成 App 的实现；tools-more.md
    /// §16.2）。随任务表一起建好（F11，审查 R1-13：原来内核建好后再经 `with_cron_store` 装上）；None 时没有
    /// 持久任务（测试、嵌入）。`-p` 也给：CronCreate `durable: true` 照常写文件，只是不调度。
    pub cron_store: Option<Arc<dyn CronStore>>,
    /// 本机跨会话通信（docs/specs/rust-cli/cross-session.md §2.4）：入口给本地的 `LocalPeers`；缺省关闭。
    pub peers: nibi_kernel_session::PeerDeps,
    /// `-p` 的输入是 stream-json（不是单次的 print 会话，headless.md §6.1，修复线 F39）：Bash 后台命令的
    /// 缺省期限是 1800000。
    pub streaming_input: bool,
    /// Monitor 开着（工作线 F83，tools-more.md §19.1）：注册 Monitor，Bash 与 CronCreate 的描述随之变，Bash 拦前台的
    /// 长 `sleep`。产品缺省开，由入口给（只给测试用的变量关掉，Windows 上要有 Git Bash）；这里缺省关（测试与嵌入）。
    pub monitor: bool,
    /// MCP 进程遥测的出口（`process/mcpTelemetry`，141 审计 §9 F3）：入口在协议 server 建好之前接上；
    /// None 时（TUI、嵌入、测试）什么都不发。
    pub mcp_telemetry: Option<nibi_kernel_ext::McpTelemetrySetup>,
    /// MCP Apps 的 UI 事件出口（`pluginUi.*` 增量，141 审计 §9 第 6 项）：入口把另一头交给协议层；
    /// None 时（TUI、嵌入、测试）什么都不发。
    pub mcp_ui: Option<tokio::sync::mpsc::UnboundedSender<nibi_kernel_api::mcp_ui::McpUiEvent>>,
    /// MCP 的 OAuth 令牌端口（Node 的 `AuthProvider`）：入口用共享凭据文件与网络出口实现；
    /// None 时带 `oauth` 的服务器按 401 失败（测试、嵌入）。
    pub mcp_oauth: Option<Arc<dyn nibi_kernel_api::mcp::McpOAuthPort>>,
    /// 入口投影的进程环境：内置 `node_repl` 服务器要的 `NIBI_HOST_NODE_REPL` /
    /// `NIBI_NODE_EXEC_PATH` / `NIBI_CUA_*`。runtime 不直接读 `std::env`（spec §4：只有入口
    /// crate 读进程环境）；None 时不装配内置服务器（CLI/TUI、测试）。
    pub node_repl_env: Option<std::collections::BTreeMap<String, String>>,
    /// Host 的话题能力（`ReadSessionContext` 的话题附件与 `ReplyToChannel`）：入口在服务 Host
    /// 协议时装上；None 时两个工具按 Node 同一条错误失败。
    pub topic: Option<std::sync::Arc<dyn nibi_kernel_api::topic::TopicPort>>,
}

impl Extensions {
    /// 没有 MCP、没有插件；skill 照常从执行环境发现。
    pub fn none() -> Self {
        Self {
            config: ExtConfig::default(),
            plugin_loader: None,
            cron_store: None,
            peers: nibi_kernel_session::PeerDeps::off(),
            streaming_input: false,
            monitor: false,
            mcp_telemetry: None,
            mcp_ui: None,
            mcp_oauth: None,
            node_repl_env: None,
            topic: None,
        }
    }
}

/// 插件里的 agent 文件与 hooks（ext.md §4）；hooks 里的坏项跳过并记警告（hooks.md D1）。
pub(crate) fn plugin_parts(plugins: &Plugins) -> (Vec<PluginAgentFile>, Vec<PluginHooks>) {
    let agents = plugins
        .0
        .iter()
        .flat_map(|plugin| {
            plugin.agent_files.iter().map(|file| PluginAgentFile {
                plugin: plugin.name.clone(),
                root: plugin.dir.clone(),
                path: file.path.clone(),
                namespace: file.namespace.clone(),
            })
        })
        .collect();
    let hooks = plugins
        .0
        .iter()
        .filter(|plugin| !plugin.hooks.is_empty())
        .map(|plugin| {
            let (hooks, warnings) =
                PluginHooks::from_json(&plugin.name, &plugin.dir, &plugin.hooks);
            for warning in warnings {
                tracing::warn!(warning, "plugin hooks");
            }
            hooks
        })
        .collect();
    (agents, hooks)
}

#[cfg(test)]
#[path = "ext_tests.rs"]
mod tests;

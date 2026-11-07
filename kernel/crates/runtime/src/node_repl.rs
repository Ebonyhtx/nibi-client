//! 内置 `node_repl` MCP 服务器的装配（对齐 Node `resolveBuiltInNodeReplMcpServers`）。
//!
//! Browser Use 与 Computer Use 的模型面不是内核原生工具，而是同一个 `node_repl` MCP 服务器：
//! 模型调用 `mcp__node_repl__js`，插件只贡献 skill 与文档。Node 由 agent bootstrap 装配这个服务器；
//! Rust 内核没有那段 TS bootstrap，所以在会话插件快照里按同一形状补上：Host 只要给出
//! `NIBI_NODE_EXEC_PATH` 并声明 `NIBI_HOST_NODE_REPL=1`，内核就从官方缓存里的 `node-repl-host`
//! 目录启动它。
//!
//! 只装配可信路径：服务器必须来自官方缓存的 `node-repl-host` 插件目录；CUA 的 broker 凭据只按
//! 白名单复制给这一个子进程（MCP stdio 的子进程环境是白名单投影，不会自动继承）。

use std::collections::BTreeMap;
use std::path::Path;

use nibi_kernel_api::mcp::McpTransportConfig;
use nibi_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};
use nibi_kernel_ext::{Plugin, Plugins};

/// Node `node-repl-host` 的 MCP 入口（`dist/mcp/server.js`）。
const SERVER_BUNDLE: [&str; 3] = ["dist", "mcp", "server.js"];

/// Node 只把 CUA 凭据恢复给共享的 `node_repl` 宿主；这里同样只复制这一组（键名以
/// `packages/shared/src/runtimeEnv.ts` 为准）。不复制 `NIBI_API_KEY` 等账号凭据。
/// 浏览器 broker 的 socket/token（内核生成，入口放进 `node_repl_env`）。只在 Browser Use
/// 插件放行时复制；键名与 `packages/shared/src/browser-use/nodeReplBroker.ts` 一致。
const BROWSER_ENV: [&str; 2] = [
    "NIBI_NODE_REPL_BROWSER_BROKER_SOCKET",
    "NIBI_NODE_REPL_BROWSER_BROKER_TOKEN",
];

const CUA_ENV: [&str; 12] = [
    "NIBI_CUA_PERMISSION_BROKER_SOCKET",
    "NIBI_CUA_PLUGIN_AUTHORITY",
    "NIBI_CUA_PERMISSION_BROKER_REFRESH_MARKER",
    "NIBI_CUA_PERMISSION_BROKER_UNAVAILABLE",
    "NIBI_CUA_WIN_HELPER_RECIPE",
    "NIBI_CUA_DEV_ROOT",
    "NIBI_CUA_ENGINE_MODULE",
    "NIBI_CUA_HELPER_ADDON",
    "NIBI_CUA_BUNDLED_HELPER_APP_PATH",
    "NIBI_CUA_HELPER_VERSION",
    "NIBI_CUA_HELPER_INSTALL_VARIANT",
    "NIBI_CUA_HELPER_ALLOW_UNSIGNED_LOCAL",
];

fn plugin<'a>(plugins: &'a Plugins, name: &str) -> Option<&'a Plugin> {
    plugins.0.iter().find(|plugin| plugin.name == name)
}

/// 会话的内置 `node_repl` 服务器；Host 没有提供执行面时返回 None。
///
/// `plugins` 是本次会话的插件快照：只有 Host 声明 `NIBI_HOST_NODE_REPL=1` 时，选择器才会放行
/// `node-repl-host` / `computer-use`（以及有 broker 时的 `browser-use`）。`env` 是内核进程环境。
pub(crate) fn builtin_server(
    plugins: &Plugins,
    env: &BTreeMap<String, String>,
) -> Option<SessionMcpServer> {
    let host = plugin(plugins, "node-repl-host")?;
    let cua = plugin(plugins, "computer-use");
    let browser = plugin(plugins, "browser-use");
    if cua.is_none() && browser.is_none() {
        return None;
    }
    let node = env
        .get("NIBI_NODE_EXEC_PATH")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let server = SERVER_BUNDLE
        .iter()
        .fold(Path::new(&host.dir).to_path_buf(), |path, part| {
            path.join(part)
        });
    // 不在这里 stat 产物：runtime 不直接碰文件系统（spec §4）；bundle 缺失由 MCP 启动失败暴露，
    // 打包门禁（desktop-package-gates）负责在发布前断言它存在。
    let mut server_env = BTreeMap::from([("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned())]);
    if let Some(browser) = browser {
        server_env.insert("NIBI_PLUGIN_ROOT".to_owned(), browser.dir.clone());
        for key in BROWSER_ENV {
            if let Some(value) = env.get(key) {
                server_env.insert(key.to_owned(), value.clone());
            }
        }
    }
    if let Some(cua) = cua {
        server_env.insert("NIBI_CUA_PLUGIN_ROOT".to_owned(), cua.dir.clone());
        // 与 Node `injectCuaCredentialsIntoNodeRepl` 相同的 provenance 标记：声明这是共享宿主，
        // 而不是任意第三个 MCP 子进程。
        server_env.insert("NIBI_CUA_NODE_REPL_HOST_ENV".to_owned(), "1".to_owned());
        server_env.insert(
            "NIBI_PLUGIN_ID".to_owned(),
            "computer-use@nibi-official".to_owned(),
        );
        for key in CUA_ENV {
            if let Some(value) = env.get(key) {
                server_env.insert(key.to_owned(), value.clone());
            }
        }
    }
    Some(SessionMcpServer {
        name: "node_repl".to_owned(),
        transport: McpTransportConfig::Stdio {
            command: node.to_owned(),
            args: vec![server.to_string_lossy().into_owned()],
            env: server_env,
            cwd: None,
        },
        // Node 的 `js` 工具始终在模型工具表里；Rust 的 MCP 工具默认延迟，必须显式 alwaysLoad。
        always_load: true,
        timeout_ms: Some(600_000),
        isolation: McpIsolation::Workspace,
        oauth: None,
        protocol_version: Default::default(),
    })
}

#[cfg(test)]
#[path = "node_repl_tests.rs"]
mod tests;

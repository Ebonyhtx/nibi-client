//! 一个服务器的连接与握手、清单拉取（docs/specs/rust-cli/ext.md §3.3）：工具、资源与 prompt 命令。

use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::Spawner;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::env_registry::{EnvironmentRegistry, LOCAL_MACHINE};
use rust_cli_kernel_api::mcp::{McpConnect, McpError, McpTransport, McpTransportConfig};
use rust_cli_kernel_api::mcp_status::McpFailureKind;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::McpServer;
use super::rpc::{Client, RpcError};

/// 握手失败：给用户看的文本 + Host `mcp/list` 的失败分类（`failureKind`）。
///
/// 分类在失败发生的地方定（传输、进程、握手、超时各有各的语义），不靠解析错误文本——
/// 界面拿到的分类与日志里的原因来自同一处。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OpenFailure {
    pub message: String,
    pub kind: McpFailureKind,
}

impl OpenFailure {
    fn new(message: impl Into<String>, kind: McpFailureKind) -> Self {
        Self {
            message: message.into(),
            kind,
        }
    }
}

/// MCP 协议版本（Node 配置的警告文字也引用它，F55）。
pub(crate) const PROTOCOL_VERSION: &str = "2025-06-18";
/// 服务器 instructions 与工具描述的上限。
pub(crate) const MAX_DESCRIPTION: usize = 2048;
/// 清单翻页的上限（防止服务器一直给 cursor）。
const MAX_PAGES: usize = 100;

/// 握手的结果。
pub(crate) struct Session {
    pub client: Arc<Client>,
    pub notices: super::notices::NoticeReceiver,
    pub capabilities: Value,
    pub instructions: Option<String>,
}

/// 超过 2048 字符时截断加 `… [truncated]`。
pub(crate) fn truncate_description(text: &str) -> String {
    if text.chars().count() > MAX_DESCRIPTION {
        let mut cut: String = text.chars().take(MAX_DESCRIPTION).collect();
        cut.push_str("… [truncated]");
        cut
    } else {
        text.to_owned()
    }
}

/// 服务器的管道开在哪里（R5，remote-exec.md §22.6）：本机的传输与会话的工作区，或者服务器绑定的那台机器的。
pub(crate) struct Pipe<'a> {
    pub local: &'a Arc<dyn McpTransport>,
    /// 远端机器的注册表；没有时（只给测试的组装）绑定到远端的服务器都连不上。
    pub machines: Option<&'a Arc<dyn EnvironmentRegistry>>,
    pub workspace: &'a WorkspaceRef,
}

impl Pipe<'_> {
    /// 这个服务器的传输与工作区：本机；或者那台机器的 `mcp()` 与它的工作区（stdio 的相对 `cwd`、`roots/list` 都按它）。
    /// 那台机器正在连时等它连完（调用方的握手期限之内）；不在清单里、没在连或连不上时是 R3 的“没连上”。
    async fn resolve(
        &self,
        machine: Option<&str>,
    ) -> Result<(Arc<dyn McpTransport>, WorkspaceRef), String> {
        let Some(name) = machine.filter(|name| !name.is_empty() && *name != LOCAL_MACHINE) else {
            return Ok((self.local.clone(), self.workspace.clone()));
        };
        let found = match self.machines {
            Some(registry) => registry.wait_remote(name).await,
            None => None,
        };
        found
            .map(|(machine, workspace)| (machine.mcp().clone(), workspace))
            .ok_or_else(|| rust_cli_kernel_api::machine::not_connected(name))
    }
}

/// 连接并握手；整个过程受 `MCP_TIMEOUT` 限制（绑定到远端的服务器等它的机器连上也算在里面）。`client_version` 是入口
/// 给的本工程版本（`clientInfo`）。
pub(crate) async fn open(
    pipe: &Pipe<'_>,
    spawner: &Spawner,
    server: &McpServer,
    timeout: Duration,
    client_version: &str,
) -> Result<Session, OpenFailure> {
    let timed_out = || {
        OpenFailure::new(
            format!(
                "MCP server \"{}\" connection timed out after {}ms",
                server.name,
                timeout.as_millis()
            ),
            McpFailureKind::ConnectionTimeout,
        )
    };
    let handshake = async {
        let (transport, workspace) = pipe.resolve(server.machine.as_deref()).await.map_err(|message| {
            // 绑定的机器没连上（R3）：不是这个服务器自己的错。
            OpenFailure::new(message, McpFailureKind::RuntimeUnavailable)
        })?;
        let transport = &transport;
        let workspace = &workspace;
        let connection = transport
            .connect(
                workspace,
                McpConnect {
                    server: server.name.clone(),
                    transport: server.transport.clone(),
                    env: Default::default(),
                },
            )
            .await
            .map_err(|error| {
                // stdio 起不来是进程问题；HTTP / SSE 连不上是传输问题。
                let kind = match (&error, &server.transport) {
                    (McpError::Unsupported { .. }, _) => McpFailureKind::RuntimeUnavailable,
                    (McpError::Connect { .. }, McpTransportConfig::Stdio { .. }) => {
                        McpFailureKind::ProcessStartFailed
                    }
                    _ => McpFailureKind::ConnectionFailed,
                };
                OpenFailure::new(error.to_string(), kind)
            })?;
        let roots = vec![workspace.root.as_str().to_owned()];
        let (client, notices) = Client::start(transport.clone(), connection, spawner, roots);
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"roots": {}},
            "clientInfo": {"name": rust_cli_base::names::MCP_CLIENT_NAME, "version": client_version},
        });
        let never = CancellationToken::new();
        let result = match client.request("initialize", params, timeout, &never).await {
            Ok(result) => result,
            Err(error) => {
                client.close().await;
                // 缺陷修复：initialize 自己的期限与整个握手的期限相同，总是先到，原来报的是 RPC 的
                // `timed out`；按 spec（ext.md §3.3）报连接超时的文本。
                return Err(match error {
                    RpcError::TimedOut => timed_out(),
                    other => OpenFailure::new(
                        other.to_string(),
                        McpFailureKind::ProtocolNegotiationFailed,
                    ),
                });
            }
        };
        if let Err(error) = client.notify("notifications/initialized", None).await {
            client.close().await;
            return Err(OpenFailure::new(
                error.to_string(),
                McpFailureKind::ProtocolError,
            ));
        }
        let instructions = result
            .get("instructions")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(truncate_description);
        Ok(Session {
            client,
            notices,
            capabilities: result.get("capabilities").cloned().unwrap_or(Value::Null),
            instructions,
        })
    };
    match tokio::time::timeout(timeout, handshake).await {
        Ok(result) => result,
        Err(_) => Err(timed_out()),
    }
}

/// `tools/list` 一类的清单，按 `nextCursor` 翻页，取 `key` 下的数组。
pub(crate) async fn list(
    client: &Client,
    method: &str,
    key: &str,
    timeout: Duration,
) -> Result<Vec<Value>, RpcError> {
    let never = CancellationToken::new();
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let params = match &cursor {
            Some(cursor) => json!({"cursor": cursor}),
            None => json!({}),
        };
        let page = client.request(method, params, timeout, &never).await?;
        if let Some(found) = page.get(key).and_then(Value::as_array) {
            items.extend(found.iter().cloned());
        }
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok(items)
}

pub(crate) fn has_capability(capabilities: &Value, name: &str) -> bool {
    capabilities.get(name).is_some_and(|value| !value.is_null())
}

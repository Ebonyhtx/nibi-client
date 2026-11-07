//! 一个服务器的连接、协议协商与握手、清单拉取（docs/specs/rust-cli/ext.md §3.3）：工具、资源与 prompt 命令。
//!
//! 握手有两代（Node `versionNegotiation` 的同一套判定）：
//!
//! - **legacy**（2025 时代）：`initialize` + `notifications/initialized`，之后所有请求不带信封；
//! - **modern**（`2026-07-28` 起）：先发 `server/discover`，结果就是握手结果（不再有 `initialize`），
//!   之后每个请求与通知都带 `_meta` 信封（协议版本、客户端信息、客户端能力），服务器→客户端的请求通道
//!   不存在（收到就丢）。
//!
//! `protocolVersion` 是 `auto`（缺省）时先探现代，服务器没有现代证据（RPC 错误、结果形状不对、stdio
//! 探测期间关闭/超时）就回退 legacy；钉在 `2026-07-28` 时只认现代，协商不到就失败（Node 的 pin）。
//!
//! OAuth 由 [`McpOAuthPort`] 取令牌：连之前取一次、放进 `Authorization: Bearer`；服务器回 401 时刷新
//! 一次、换新令牌重连再试（Node 的 `AuthProvider` + 401 重试一次）。

use std::sync::Arc;
use std::time::Duration;

use nibi_kernel_base::Spawner;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::env_registry::{EnvironmentRegistry, LOCAL_MACHINE};
use nibi_kernel_api::mcp::{
    McpConnect, McpError, McpOAuthPort, McpOAuthRequest, McpProtocolVersion, McpTransport,
    McpTransportConfig,
};
use nibi_kernel_api::mcp_status::{McpFailureKind, McpProtocolEra};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::McpServer;
use super::rpc::{Client, Link, RpcError};

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

/// legacy 握手说的协议版本（Node 的 2025 时代最后一版）。
pub(crate) const PROTOCOL_VERSION: &str = "2025-06-18";
/// 现代协议的唯一版本（Node `SUPPORTED_MODERN_PROTOCOL_VERSIONS`）。
pub(crate) const MODERN_PROTOCOL_VERSION: &str = "2026-07-28";
/// `_meta` 信封的三个保留键（Node `PROTOCOL_VERSION_META_KEY` 等）。
const PROTOCOL_VERSION_META: &str = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META: &str = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META: &str = "io.modelcontextprotocol/clientCapabilities";
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
    /// 协商到的协议世代（`mcp/list` 的 `protocolEra`）。
    pub era: McpProtocolEra,
}

/// OAuth：令牌端口与这个服务器的请求上下文（`oauth` 配置不在这里，见 [`McpServer::oauth`]）。
pub(crate) struct OAuth<'a> {
    pub port: &'a dyn McpOAuthPort,
    pub request: McpOAuthRequest,
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
            .ok_or_else(|| nibi_kernel_api::machine::not_connected(name))
    }
}

impl McpServer {
    /// 这个服务器的 OAuth 请求上下文；没有 `oauth` 或不是 HTTP / SSE 时 None。
    pub(crate) fn oauth_request(&self) -> Option<McpOAuthRequest> {
        let config = self.oauth.clone()?;
        let url = match &self.transport {
            McpTransportConfig::Http { url, .. } | McpTransportConfig::Sse { url, .. } => url.clone(),
            McpTransportConfig::Stdio { .. } => return None,
        };
        Some(McpOAuthRequest {
            server: self.name.clone(),
            url,
            config,
        })
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
    oauth: Option<&OAuth<'_>>,
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
    // 连之前取一次令牌（没有凭据时照常连：401 再走刷新）。
    let mut token = match oauth {
        Some(oauth) => oauth.port.access_token(&oauth.request).await,
        None => None,
    };
    let mut refreshed = false;
    let attempt = async {
        loop {
            let transport = match &token {
                Some(token) => with_bearer(&server.transport, token),
                None => server.transport.clone(),
            };
            match handshake(pipe, spawner, server, &transport, timeout, client_version).await {
                Ok(session) => return Ok(session),
                Err(Attempt::Unauthorized) => {
                    let Some(oauth) = oauth else {
                        return Err(OpenFailure::new(
                            format!(
                                "MCP server \"{}\" requires OAuth authorization (HTTP 401)",
                                server.name
                            ),
                            McpFailureKind::OauthAuthorizationFailed,
                        ));
                    };
                    if refreshed {
                        return Err(OpenFailure::new(
                            format!(
                                "MCP server \"{}\" still answered HTTP 401 after the token was refreshed",
                                server.name
                            ),
                            McpFailureKind::OauthAuthorizationFailed,
                        ));
                    }
                    refreshed = true;
                    // Node `AuthProvider.onUnauthorized`：刷新一次，让下一轮拿到新令牌。
                    token = Some(oauth.port.refresh(&oauth.request, token.as_deref()).await.map_err(
                        |message| OpenFailure::new(message, McpFailureKind::OauthAuthorizationFailed),
                    )?);
                }
                Err(Attempt::Failed(failure)) => return Err(failure),
            }
        }
    };
    match tokio::time::timeout(timeout, attempt).await {
        Ok(result) => result,
        Err(_) => Err(timed_out()),
    }
}

/// 一次连接尝试的失败：401（要刷新）或其它。
enum Attempt {
    Unauthorized,
    Failed(OpenFailure),
}

/// 连上并握手（探测世代 + 两代之一）。
async fn handshake(
    pipe: &Pipe<'_>,
    spawner: &Spawner,
    server: &McpServer,
    transport: &McpTransportConfig,
    timeout: Duration,
    client_version: &str,
) -> Result<Session, Attempt> {
    let (transport_port, workspace) = pipe
        .resolve(server.machine.as_deref())
        .await
        .map_err(|message| {
            // 绑定的机器没连上（R3）：不是这个服务器自己的错。
            Attempt::Failed(OpenFailure::new(message, McpFailureKind::RuntimeUnavailable))
        })?;
    let transport_port = &transport_port;
    let workspace = &workspace;
    let connection = transport_port
        .connect(
            workspace,
            McpConnect {
                server: server.name.clone(),
                transport: transport.clone(),
                env: Default::default(),
            },
        )
        .await
        .map_err(|error| match http_status(&error.to_string()) {
            Some(401 | 403) => Attempt::Unauthorized,
            _ => {
                // stdio 起不来是进程问题；HTTP / SSE 连不上是传输问题。
                let kind = match (&error, transport) {
                    (McpError::Unsupported { .. }, _) => McpFailureKind::RuntimeUnavailable,
                    (McpError::Connect { .. }, McpTransportConfig::Stdio { .. }) => {
                        McpFailureKind::ProcessStartFailed
                    }
                    _ => McpFailureKind::ConnectionFailed,
                };
                Attempt::Failed(OpenFailure::new(error.to_string(), kind))
            }
        })?;
    let roots = vec![workspace.root.as_str().to_owned()];
    let stdio = matches!(transport, McpTransportConfig::Stdio { .. });
    let never = CancellationToken::new();

    // 世代协商：先按 legacy 起客户端（探测也是一个 JSON-RPC 请求），现代成立时换成带信封的连接。
    let (mut client, mut notices) =
        Client::start(transport_port.clone(), connection, spawner, roots.clone(), Link::legacy());
    let era = match server.protocol {
        McpProtocolVersion::Legacy => Probe::Legacy,
        McpProtocolVersion::Auto | McpProtocolVersion::Modern => {
            probe(&client, timeout, client_version, stdio).await
        }
    };
    let pinned = server.protocol == McpProtocolVersion::Modern;
    match era {
        Probe::Modern(result) => {
            // 同一条连接上升级成现代：之后每个请求与通知都带信封，服务器→客户端的请求丢掉。
            client.promote(Link::modern(client_version));
            return Ok(Session {
                client,
                notices,
                capabilities: result.get("capabilities").cloned().unwrap_or(Value::Null),
                instructions: result
                    .get("instructions")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(truncate_description),
                era: McpProtocolEra::Modern,
            });
        }
        // 探测期间就 401：这是授权问题，不是版本问题（Node `classifyHttpError`）。
        Probe::Unauthorized => {
            client.close().await;
            return Err(Attempt::Unauthorized);
        }
        Probe::Failed(message) => {
            client.close().await;
            return Err(Attempt::Failed(OpenFailure::new(
                message,
                McpFailureKind::ProtocolNegotiationFailed,
            )));
        }
        Probe::Legacy if pinned => {
            client.close().await;
            return Err(Attempt::Failed(OpenFailure::new(
                format!(
                    "MCP server \"{}\" does not offer protocol version {MODERN_PROTOCOL_VERSION} \
                     (server/discover gave no modern result)",
                    server.name
                ),
                McpFailureKind::ProtocolNegotiationFailed,
            )));
        }
        Probe::Legacy => {}
    }

    // stdio 的老服务器不认识 `server/discover`，可能就此退出（探测期间连接关闭）：换一条新连接走
    // legacy（Node 用一次性的兄弟进程做同一件事，结论一样）。
    if client.is_closed() {
        client.close().await;
        let connection = transport_port
            .connect(
                workspace,
                McpConnect {
                    server: server.name.clone(),
                    transport: transport.clone(),
                    env: Default::default(),
                },
            )
            .await
            .map_err(|error| {
                Attempt::Failed(OpenFailure::new(
                    error.to_string(),
                    McpFailureKind::ProcessStartFailed,
                ))
            })?;
        let started = Client::start(
            transport_port.clone(),
            connection,
            spawner,
            roots,
            Link::legacy(),
        );
        client = started.0;
        notices = started.1;
    }

    let params = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"roots": {}},
        "clientInfo": {"name": nibi_kernel_base::names::MCP_CLIENT_NAME, "version": client_version},
    });
    let result = match client.request("initialize", params, timeout, &never).await {
        Ok(result) => result,
        Err(error) => {
            client.close().await;
            return Err(match error {
                RpcError::Send(message) if http_status(&message) == Some(401) => {
                    Attempt::Unauthorized
                }
                // 缺陷修复：initialize 自己的期限与整个握手的期限相同，总是先到，原来报的是 RPC 的
                // `timed out`；按 spec（ext.md §3.3）报连接超时的文本。
                RpcError::TimedOut => Attempt::Failed(OpenFailure::new(
                    format!(
                        "MCP server \"{}\" connection timed out after {}ms",
                        server.name,
                        timeout.as_millis()
                    ),
                    McpFailureKind::ConnectionTimeout,
                )),
                other => Attempt::Failed(OpenFailure::new(
                    other.to_string(),
                    McpFailureKind::ProtocolNegotiationFailed,
                )),
            });
        }
    };
    if let Err(error) = client.notify("notifications/initialized", None).await {
        client.close().await;
        return Err(Attempt::Failed(OpenFailure::new(
            error.to_string(),
            McpFailureKind::ProtocolError,
        )));
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
        era: McpProtocolEra::Legacy,
    })
}

/// `server/discover` 的探测结果（Node `negotiateEra` 的两代 + 两种失败）。
enum Probe {
    Modern(Value),
    Legacy,
    Unauthorized,
    Failed(String),
}

/// 探一次现代协议（Node `negotiateEra` 的 probe 状态机，只保留这份客户端认得的版本）。
async fn probe(client: &Client, timeout: Duration, client_version: &str, stdio: bool) -> Probe {
    let params = json!({"_meta": envelope(client_version)});
    let never = CancellationToken::new();
    match client
        .request("server/discover", params, timeout, &never)
        .await
    {
        Ok(result) => match modern_result(&result) {
            Some(()) => Probe::Modern(result),
            // 形状不对：不是现代服务器（Node `classifyResult` 的 legacy 档）。
            None => Probe::Legacy,
        },
        // 任何 JSON-RPC 错误都是 legacy（Node `classifyRpcError` 除版本纠正外的所有分支）。
        Err(RpcError::Server { .. }) => Probe::Legacy,
        Err(RpcError::Send(message)) => match http_status(&message) {
            // 401 / 403：授权问题，不是版本问题。
            Some(401 | 403) => Probe::Unauthorized,
            Some(status) if status >= 500 => Probe::Failed(format!(
                "Version negotiation failed: the server answered the server/discover probe with HTTP {status}"
            )),
            // 其余 HTTP 状态：body 是 JSON-RPC 错误就是 legacy，否则 legacy（Node 同档）。
            _ => Probe::Legacy,
        },
        // stdio 在探测期间关闭或超时是 legacy（server/discover 是未知方法、旧服务器直接退出）；
        // HTTP 上同样的失败是硬错误（连接没通）。
        Err(RpcError::Closed(_) | RpcError::TimedOut) if stdio => Probe::Legacy,
        Err(RpcError::TimedOut) => Probe::Failed(format!(
            "Version negotiation probe timed out after {}ms",
            timeout.as_millis()
        )),
        Err(RpcError::Closed(reason)) => Probe::Failed(format!(
            "Version negotiation failed: {reason}"
        )),
        Err(RpcError::Cancelled) => Probe::Failed("Version negotiation was cancelled".to_owned()),
    }
}

/// `DiscoverResult` 的形状（Node `classifyResult` 的 `parsed.ok` 与版本重叠）：`supportedVersions`
/// 里有本客户端认得的现代版本、`capabilities` 是对象。
fn modern_result(result: &Value) -> Option<()> {
    let supported = result.get("supportedVersions")?.as_array()?;
    let overlap = supported
        .iter()
        .filter_map(Value::as_str)
        .any(|version| version == MODERN_PROTOCOL_VERSION);
    let capabilities = result.get("capabilities")?;
    (overlap && capabilities.is_object()).then_some(())
}

/// 现代连接的每个请求/通知都带的 `_meta` 信封（`server/discover` 的探测也用它）。
pub(crate) fn envelope(client_version: &str) -> Value {
    json!({
        PROTOCOL_VERSION_META: MODERN_PROTOCOL_VERSION,
        CLIENT_INFO_META: {"name": nibi_kernel_base::names::MCP_CLIENT_NAME, "version": client_version},
        CLIENT_CAPABILITIES_META: {"roots": {}},
    })
}

/// 令牌进 `Authorization: Bearer`（Node 的 SDK 在签名时加的同一个头）。
fn with_bearer(config: &McpTransportConfig, token: &str) -> McpTransportConfig {
    let mut config = config.clone();
    match &mut config {
        McpTransportConfig::Http { headers, .. } | McpTransportConfig::Sse { headers, .. } => {
            headers.insert("Authorization".to_owned(), format!("Bearer {token}"));
        }
        McpTransportConfig::Stdio { .. } => {}
    }
    config
}

/// 传输层错误文本里的 HTTP 状态（`env-local` 的 `HTTP {status}: {body}`；远端执行器同形状）。
fn http_status(message: &str) -> Option<u16> {
    let rest = message.strip_prefix("HTTP ")?;
    let digits = rest
        .split_once(':')
        .map_or(rest, |(code, _)| code)
        .trim();
    digits.parse().ok()
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

//! MCP 的 JSON-RPC 客户端（docs/specs/rust-cli/ext.md §3.3）：经传输端口发收消息，请求按 ID 配对，
//! 服务器发来的请求在这里回答，通知交给连接任务。
//!
//! 读者任务是这条连接上事件的唯一消费者；它结束（连接关闭）时让全部等待中的请求失败。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures_util::StreamExt;
use nibi_kernel_base::Spawner;
use nibi_kernel_api::env_files::PathStyle;
use nibi_kernel_api::mcp::{McpConnectionId, McpElicitation, McpTransport, McpTransportEvent};

use super::notices::{self, NoticeReceiver, NoticeSender};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// 一次请求的失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum RpcError {
    /// 服务器回了 JSON-RPC 错误。
    #[error("MCP error {code}: {message}")]
    Server { code: i64, message: String },
    #[error("{0}")]
    Closed(String),
    #[error("timed out")]
    TimedOut,
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Send(String),
}

/// 交给连接任务的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Notice {
    /// `notifications/<kind>/list_changed`：`tools`、`resources`、`prompts`。
    ListChanged(String),
    /// `notifications/resources/updated`：订阅的资源变了（按 URI 合并）。
    ResourceUpdated(String),
    Closed {
        reason: Option<String>,
        session_expired: bool,
        /// 服务器进程自己退出了（`process/mcpTelemetry` 的 crash 判据）。
        exited: bool,
    },
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;

/// 这条连接属于哪一代协议（Node `_outboundMetaEnvelope` / `_shouldDropInbound` 的两条开关）。
#[derive(Clone, Default)]
pub(crate) struct Link {
    /// 现代协议：每个请求与通知自动带的 `_meta` 信封（用户自己写的键优先）。
    envelope: Option<Value>,
    /// 现代协议没有服务器→客户端的请求通道：收到请求就丢。
    drops_requests: bool,
}

impl Link {
    /// legacy（2025 的 `initialize` 之后）：不带信封，服务器请求照常回答。
    pub(crate) fn legacy() -> Self {
        Self::default()
    }

    /// 现代（`2026-07-28` 起）：每个请求与通知带信封，服务器请求丢掉。
    pub(crate) fn modern(client_version: &str) -> Self {
        Self {
            envelope: Some(super::connection::envelope(client_version)),
            drops_requests: true,
        }
    }
}

pub(crate) struct Client {
    transport: Arc<dyn McpTransport>,
    connection: McpConnectionId,
    next: AtomicU64,
    pending: Arc<Mutex<Pending>>,
    closed: CancellationToken,
    envelope: Mutex<Option<Value>>,
    modern: Arc<AtomicBool>,
}

fn lock(pending: &Mutex<Pending>) -> std::sync::MutexGuard<'_, Pending> {
    pending.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 服务器发来的请求的回答：`ping`、`roots/list`；其余回 Method not found。
fn answer(method: &str, roots: &[String]) -> Result<Value, (i64, String)> {
    match method {
        "ping" => Ok(json!({})),
        "roots/list" => {
            // 按 href 去重，保留先后（F57）。
            let mut seen = std::collections::HashSet::new();
            let roots: Vec<Value> = roots
                .iter()
                .map(|root| file_uri(root))
                .filter(|uri| seen.insert(uri.clone()))
                .map(|uri| json!({"uri": uri}))
                .collect();
            Ok(json!({ "roots": roots }))
        }
        other => Err((-32601, format!("Method not found: {other}"))),
    }
}

/// 工作区根的 `file://` URI，同 `url.pathToFileURL(root).href`（docs/specs/rust-cli/ext.md §3.2）。风格按根的
/// 写法推断；Windows 的 `\\?\` 前缀去掉，UNC 的服务器名是主机（转小写）。
///
/// 缺陷修复（工作线 F57）：以前不做百分号编码（`/a b` 写成 `file:///a b`，含 `#`、`?`、`%` 的路径服务器解析不回来），
/// UNC 写成 `file:////server/share`。
fn file_uri(path: &str) -> String {
    if PathStyle::infer(path) == PathStyle::Posix {
        return file_url(&encode_file_path(path));
    }
    let unc = path.strip_prefix(r"\\?\UNC\").or_else(|| {
        path.strip_prefix(r"\\")
            .filter(|rest| !rest.starts_with(r"?\"))
    });
    if let Some(unc) = unc {
        let (host, rest) = unc.split_at(unc.find(['\\', '/']).unwrap_or(unc.len()));
        let rest = encode_file_path(&rest.replace('\\', "/"));
        return format!("file://{}{rest}", host.to_ascii_lowercase());
    }
    let local = path.strip_prefix(r"\\?\").unwrap_or(path);
    file_url(&encode_file_path(&local.replace('\\', "/")))
}

/// 编码后的路径接在 `file://` 后面：不以 `/` 开头时（Windows 的 `C:/…`）补一个。
fn file_url(encoded: &str) -> String {
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

/// `pathToFileURL` 的百分号编码（Bun 1.3 与 Node 24 实测）：C0 控制字符、空格、`"`、`#`、`%`、`<`、`>`、`?`、`[`、`\`、
/// `]`、`^`、`` ` ``、`{`、`|`、`}`、`~`、DEL 与非 ASCII 的 UTF-8 字节写成大写的 `%XX`。
fn encode_file_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        let escape = byte <= b' ' || byte >= 0x7f || b"\"#%<>?[\\]^`{|}~".contains(&byte);
        if escape {
            out.push_str(&format!("%{byte:02X}"));
        } else {
            out.push(char::from(byte));
        }
    }
    out
}

impl Client {
    /// 开始读这条连接的事件；`roots` 是 `roots/list` 的回答（工作区根）。
    pub(crate) fn start(
        transport: Arc<dyn McpTransport>,
        connection: McpConnectionId,
        spawner: &Spawner,
        roots: Vec<String>,
        link: Link,
        server: String,
        elicitation: Option<Arc<dyn McpElicitation>>,
    ) -> (Arc<Self>, NoticeReceiver) {
        let modern = Arc::new(AtomicBool::new(link.drops_requests));
        let client = Arc::new(Self {
            transport,
            connection,
            next: AtomicU64::new(0),
            pending: Arc::default(),
            closed: CancellationToken::new(),
            envelope: Mutex::new(link.envelope),
            modern: modern.clone(),
        });
        let (notices, receiver) = notices::channel();
        let reader = Reader {
            transport: client.transport.clone(),
            connection: client.connection.clone(),
            pending: client.pending.clone(),
            closed: client.closed.clone(),
            notices,
            roots,
            modern,
            server,
            elicitation,
        };
        spawner.spawn_resident("mcp-reader", reader.run());
        (client, receiver)
    }

    /// 协商到现代协议：之后的请求带信封，服务器请求丢掉（同一条连接，不重连）。
    pub(crate) fn promote(&self, link: Link) {
        *self.envelope.lock().unwrap_or_else(PoisonError::into_inner) = link.envelope;
        self.modern.store(link.drops_requests, Ordering::Relaxed);
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    /// 服务器进程的 pid（stdio 才有；`process/childProcesses` 的归属来源）。
    pub(crate) fn pid(&self) -> Option<u32> {
        self.transport.pid(&self.connection)
    }

    pub(crate) async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), RpcError> {
        let mut message = json!({"jsonrpc": "2.0", "method": method});
        if let Some(params) = params {
            message["params"] = self.with_envelope(params);
        }
        self.transport
            .send(&self.connection, message)
            .await
            .map_err(|error| RpcError::Send(error.to_string()))
    }

    /// 现代协议的信封（`_meta` 的三个保留键）：用户写了的键优先，没有被覆盖。
    fn with_envelope(&self, params: Value) -> Value {
        let envelope = self
            .envelope
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some(envelope) = envelope else {
            return params;
        };
        let Value::Object(mut object) = params else {
            return params;
        };
        let mut meta = match object.remove("_meta") {
            Some(Value::Object(user)) => user,
            _ => Map::new(),
        };
        if let Some(envelope) = envelope.as_object() {
            for (key, value) in envelope {
                meta.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
        object.insert("_meta".to_owned(), Value::Object(meta));
        Value::Object(object)
    }

    /// 发一个请求并等它的结果；超时或取消时发 `notifications/cancelled`。
    pub(crate) async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value, RpcError> {
        if self.is_closed() {
            return Err(RpcError::Closed("connection closed".to_owned()));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        lock(&self.pending).insert(id, sender);
        let params = self.with_envelope(params);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(error) = self.transport.send(&self.connection, message).await {
            lock(&self.pending).remove(&id);
            return Err(RpcError::Send(error.to_string()));
        }
        let outcome = tokio::select! {
            answered = receiver => answered.unwrap_or_else(|_| Err(RpcError::Closed("connection closed".to_owned()))),
            () = tokio::time::sleep(timeout) => Err(RpcError::TimedOut),
            () = cancel.cancelled() => Err(RpcError::Cancelled),
        };
        if matches!(outcome, Err(RpcError::TimedOut | RpcError::Cancelled)) {
            lock(&self.pending).remove(&id);
            let reason = if matches!(outcome, Err(RpcError::Cancelled)) {
                "User interrupted"
            } else {
                "Request timed out"
            };
            let params = json!({"requestId": id, "reason": reason});
            if let Err(error) = self.notify("notifications/cancelled", Some(params)).await {
                tracing::debug!(%error, "could not send notifications/cancelled");
            }
        }
        outcome
    }

    pub(crate) async fn close(&self) {
        if let Err(error) = self.transport.close(&self.connection).await {
            tracing::debug!(%error, "closing an MCP connection failed");
        }
    }
}

struct Reader {
    transport: Arc<dyn McpTransport>,
    connection: McpConnectionId,
    pending: Arc<Mutex<Pending>>,
    closed: CancellationToken,
    notices: NoticeSender,
    roots: Vec<String>,
    /// 现代协议：服务器→客户端的请求通道不存在，收到的请求丢掉（Node `_shouldDropInbound`）。
    modern: Arc<AtomicBool>,
    /// 这条连接属于哪个配置名（`elicitation/create` 的归属键）。
    server: String,
    /// `elicitation/create` 的宿主端口；没有时不宣告能力，请求回 Method not found。
    elicitation: Option<Arc<dyn McpElicitation>>,
}

impl Reader {
    async fn run(self) {
        let mut events = self.transport.events(&self.connection);
        let mut closing = Notice::Closed {
            reason: Some("event stream ended".to_owned()),
            session_expired: false,
            exited: false,
        };
        while let Some(event) = events.next().await {
            match event {
                McpTransportEvent::Message { message } => self.message(message).await,
                McpTransportEvent::Closed {
                    reason,
                    session_expired,
                    exited,
                } => {
                    closing = Notice::Closed {
                        reason,
                        session_expired,
                        exited,
                    };
                    break;
                }
            }
        }
        // 先标记关闭，再让等待方失败：之后的请求立即失败，不再登记。
        self.closed.cancel();
        let waiting: Vec<_> = lock(&self.pending).drain().collect();
        for (_, sender) in waiting {
            let _ = sender.send(Err(RpcError::Closed("connection closed".to_owned())));
        }
        self.notices.send(closing);
    }

    async fn message(&self, message: Value) {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned().filter(|id| !id.is_null());
        match (method, id) {
            (None, Some(id)) => self.response(&id, &message),
            // 现代协议没有服务器→客户端的请求通道：丢掉，不回答。
            (Some(method), Some(_)) if self.modern.load(Ordering::Relaxed) => {
                tracing::debug!(method, "dropped an MCP server request on a modern connection");
            }
            (Some(method), Some(id)) => self.server_request(method, id, &message).await,
            (Some(method), None) => self.notification(method, &message),
            (None, None) => tracing::debug!("ignored an MCP message without method or id"),
        }
    }

    fn response(&self, id: &Value, message: &Value) {
        let Some(sender) = id.as_u64().and_then(|id| lock(&self.pending).remove(&id)) else {
            tracing::debug!(%id, "MCP response for an unknown request");
            return;
        };
        let result = match message.get("error") {
            Some(error) => Err(RpcError::Server {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown error")
                    .to_owned(),
            }),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = sender.send(result);
    }

    async fn server_request(&self, method: &str, id: Value, message: &Value) {
        // `elicitation/create` 要等用户作答，绝不在这条读循环里 await：其余响应用同一条 stdin。
        if method == "elicitation/create" {
            let Some(port) = self.elicitation.clone() else {
                self.reply(id, Err((-32601, format!("Method not found: {method}"))))
                    .await;
                return;
            };
            let transport = self.transport.clone();
            let connection = self.connection.clone();
            let server = self.server.clone();
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            tokio::spawn(async move {
                let result = port.elicit(&server, params).await;
                let reply = json!({"jsonrpc": "2.0", "id": id, "result": result});
                if let Err(error) = transport.send(&connection, reply).await {
                    tracing::debug!(%error, "could not answer an MCP elicitation request");
                }
            });
            return;
        }
        self.reply(id, answer(method, &self.roots)).await;
    }

    async fn reply(&self, id: Value, answer: Result<Value, (i64, String)>) {
        let reply = match answer {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, message)) => {
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
            }
        };
        if let Err(error) = self.transport.send(&self.connection, reply).await {
            tracing::debug!(%error, "could not answer an MCP server request");
        }
    }

    fn notification(&self, method: &str, message: &Value) {
        if method == "notifications/resources/updated"
            && let Some(uri) = message
                .pointer("/params/uri")
                .and_then(Value::as_str)
                .filter(|uri| !uri.is_empty())
        {
            self.notices.send(Notice::ResourceUpdated(uri.to_owned()));
            return;
        }
        let kind = method
            .strip_prefix("notifications/")
            .and_then(|rest| rest.strip_suffix("/list_changed"));
        match kind {
            Some(kind) => self.notices.send(Notice::ListChanged(kind.to_owned())),
            None => tracing::debug!(method, "MCP notification"),
        }
    }
}

#[cfg(test)]
#[path = "rpc_tests.rs"]
mod tests;

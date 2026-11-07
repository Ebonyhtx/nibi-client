//! `node_repl` 的浏览器 broker（与 Node `node-repl-browser-broker.ts` 同协议）。
//!
//! Browser Use 的模型面是 `node_repl` MCP 的 `js` 工具；JS 侧的 `agent.browsers.*` 经本地 socket
//! 找到 agent 进程里的 broker，broker 把命令变成 `interaction/browserList` /
//! `interaction/browserExecute` 反向请求交给 Host 执行。Node 的 broker 在 agent 的 bootstrap 里；
//! Rust 内核没有那段 TS，所以在协议前端起一个等价的服务。
//!
//! 服务器只认 Host 注入的 token：socket 落在本机（Unix socket / Windows 命名管道），token 由内核
//! 生成并随 `node_repl` 子进程的环境传下去。收尾时按会话发 `closeSession`，避免标签页泄漏。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use nibi_kernel_base::Spawner;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::context::Context;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const BROWSER_LIST: &str = "interaction/browserList";
const BROWSER_EXECUTE: &str = "interaction/browserExecute";
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    token: String,
    op: String,
    session_id: String,
    turn_id: Option<String>,
    browser_id: Option<String>,
    browser_generation: Option<u64>,
    command: Option<Value>,
}

struct Inner {
    context: Arc<Context>,
    token: String,
    spawner: Spawner,
    connections: Mutex<BTreeMap<String, BTreeSet<(String, u64)>>>,
    cancel: CancellationToken,
}

/// 一个正在服务的浏览器 broker。持有它即保持 socket 与 accept 任务存活；Drop 会取消任务。
pub struct BrowserBroker {
    socket_path: String,
    token: String,
    inner: Arc<Inner>,
    cancel: CancellationToken,
}

impl BrowserBroker {
    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// 回合结束：对每条登记过的浏览器连接发 `turnEnded`（Node 的 `turnEnded` 生命周期；
    /// 不关闭标签页，交回 tab 归属）。
    pub(crate) async fn turn_ended(&self, session: &str) {
        let Some(workspace) = self.inner.context.workspace_of(session) else {
            return;
        };
        let connections = self
            .inner
            .connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .cloned()
            .unwrap_or_default();
        for (browser_id, generation) in connections {
            let params = json!({
                "requestId": self.inner.context.fresh("browser"),
                "sessionId": session,
                "workspaceKey": workspace.clone(),
                "workspacePath": workspace,
                "clientMode": "desktop-continuous",
                "sessionContext": "live",
                "browserId": browser_id,
                "browserGeneration": generation,
                "command": {"method": "turnEnded"},
            });
            let _ = tokio::time::timeout(
                CLOSE_TIMEOUT,
                self.inner.context.peer.request(BROWSER_EXECUTE, &params),
            )
            .await;
        }
    }

    /// 会话关闭：对每条登记过的浏览器连接发 `closeSession`（Node 的 `closeSession` 生命周期）。
    pub(crate) async fn close_session(&self, session: &str) {
        let Some(workspace) = self.inner.context.workspace_of(session) else {
            return;
        };
        let connections = self
            .inner
            .connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session)
            .unwrap_or_default();
        for (browser_id, generation) in connections {
            let params = json!({
                "requestId": self.inner.context.fresh("browser"),
                "sessionId": session,
                "workspaceKey": workspace.clone(),
                "workspacePath": workspace,
                "clientMode": "desktop-continuous",
                "sessionContext": "live",
                "browserId": browser_id,
                "browserGeneration": generation,
                "command": {"method": "closeSession"},
            });
            let _ = tokio::time::timeout(
                CLOSE_TIMEOUT,
                self.inner.context.peer.request(BROWSER_EXECUTE, &params),
            )
            .await;
        }
    }
}

impl Drop for BrowserBroker {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl Inner {
    async fn handle(&self, raw: &str) -> Value {
        let request: Request = match serde_json::from_str(raw) {
            Ok(request) => request,
            Err(error) => {
                return json!({
                    "id": "",
                    "ok": false,
                    "error": format!("invalid browser broker request: {error}"),
                });
            }
        };
        let id = request.id;
        if !authorized(&request.token, &self.token) {
            return json!({"id": id, "ok": false, "error": "browser broker request is not authorized"});
        }
        let Some(workspace) = self.context.workspace_of(&request.session_id) else {
            return json!({
                "id": id,
                "ok": false,
                "error": format!("session is not open: {}", request.session_id),
            });
        };
        let mut params = json!({
            "requestId": self.context.fresh("browser"),
            "sessionId": request.session_id.clone(),
            "workspaceKey": workspace.clone(),
            "workspacePath": workspace,
            "clientMode": "desktop-continuous",
            "sessionContext": "live",
        });
        if let Some(turn) = &request.turn_id {
            params["turnId"] = json!(turn);
        }
        match request.op.as_str() {
            "list" => match self.context.peer.request(BROWSER_LIST, &params).await {
                Ok(reply) => json!({"id": id, "ok": true, "browsers": reply["browsers"].clone()}),
                Err(error) => json!({"id": id, "ok": false, "error": error.message}),
            },
            "execute" => {
                let (Some(browser_id), Some(generation), Some(command)) =
                    (request.browser_id, request.browser_generation, request.command)
                else {
                    return json!({
                        "id": id,
                        "ok": false,
                        "error": "execute requires browserId, browserGeneration and command",
                    });
                };
                params["browserId"] = json!(browser_id);
                params["browserGeneration"] = json!(generation);
                params["command"] = command;
                self.record(&request.session_id, &browser_id, generation);
                match self.context.peer.request(BROWSER_EXECUTE, &params).await {
                    Ok(reply) => json!({"id": id, "ok": true, "result": reply}),
                    Err(error) => json!({"id": id, "ok": false, "error": error.message}),
                }
            }
            other => json!({
                "id": id,
                "ok": false,
                "error": format!("unsupported browser broker op: {other}"),
            }),
        }
    }

    fn record(&self, session: &str, browser_id: &str, generation: u64) {
        self.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(session.to_owned())
            .or_default()
            .insert((browser_id.to_owned(), generation));
    }
}

/// 常量时间比较：token 是本机 socket 的唯一凭据，不做长度之外的分支。
fn authorized(actual: &str, expected: &str) -> bool {
    let (actual, expected) = (actual.as_bytes(), expected.as_bytes());
    actual.len() == expected.len()
        && actual
            .iter()
            .zip(expected)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// 启动 broker 并返回 socket/token；accept 任务挂在入口的 `Spawner` 上。
pub fn start(
    context: Arc<Context>,
    socket_path: String,
    spawner: &Spawner,
) -> std::io::Result<BrowserBroker> {
    let token = format!(
        "{:016x}{:016x}{:016x}{:016x}",
        nibi_kernel_base::random::u64(),
        nibi_kernel_base::random::u64(),
        nibi_kernel_base::random::u64(),
        nibi_kernel_base::random::u64(),
    );
    let cancel = CancellationToken::new();
    let inner = Arc::new(Inner {
        context,
        token: token.clone(),
        spawner: spawner.clone(),
        connections: Mutex::default(),
        cancel: cancel.clone(),
    });

    let mut listener = nibi_kernel_net::local::LocalListener::bind(&socket_path)?;
    let task = inner.clone();
    drop(spawner.spawn("browser-broker", async move {
        loop {
            tokio::select! {
                _ = task.cancel.cancelled() => break,
                accepted = listener.accept() => match accepted {
                    Ok(stream) => {
                        drop(task.spawner.spawn(
                            "browser-connection",
                            serve_connection(stream, task.clone()),
                        ));
                    }
                    Err(error) => {
                        tracing::warn!(%error, "browser broker accept failed");
                        break;
                    }
                }
            }
        }
    }));

    Ok(BrowserBroker {
        socket_path,
        token,
        inner,
        cancel,
    })
}

async fn serve_connection<S>(mut stream: S, inner: Arc<Inner>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => return,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(_) => return,
        }
        if let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line = String::from_utf8_lossy(&buffer[..newline]).into_owned();
            let response = inner.handle(&line).await;
            let text = format!("{response}\n");
            let _ = stream.write_all(text.as_bytes()).await;
            let _ = stream.flush().await;
            return;
        }
        if buffer.len() > MAX_REQUEST_BYTES {
            return;
        }
    }
}

#[cfg(test)]
#[path = "browser_tests.rs"]
mod tests;

//! 浏览器 broker 的协议与生命周期。
//!
//! 判三件事：`list` / `execute` 转成正确的反向请求、token 不对不转发、会话关闭发 `closeSession`。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_api::testing::FixedClock;
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Reply, Service};
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};

use super::{BROWSER_EXECUTE, BROWSER_LIST, BrowserBroker, start};
use crate::context::Context;

struct Nothing;

#[async_trait]
impl Service for Nothing {
    async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
        Err(RpcError::method_not_found(method))
    }
}

struct Harness {
    broker: Arc<BrowserBroker>,
    host_out: DuplexStream,
    lines: Lines<BufReader<DuplexStream>>,
    _dir: Option<tempfile::TempDir>,
    _scope: TaskScope,
}

fn socket_path() -> (Option<tempfile::TempDir>, String) {
    #[cfg(unix)]
    {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("browser.sock")
            .to_string_lossy()
            .into_owned();
        (Some(dir), path)
    }
    #[cfg(windows)]
    {
        (
            None,
            format!(
                r"\\.\pipe\nibi-browser-test-{}",
                nibi_kernel_base::random::u64()
            ),
        )
    }
}

async fn connect(path: &str) -> nibi_kernel_net::local::LocalClientStream {
    nibi_kernel_net::local::connect(path).await.unwrap()
}

impl Harness {
    fn new() -> Self {
        let scope = TaskScope::root("browser-broker-test", |_| {});
        let (host_out, agent_in) = duplex(1 << 16);
        let (agent_out, host_in) = duplex(1 << 16);
        let (peer, _writer) = connection::start(agent_out, &scope.spawner(), Options::default());
        drop(scope.spawner().spawn(
            "serve",
            connection::serve(
                BufReader::new(agent_in),
                peer.clone(),
                Arc::new(Nothing),
                scope.spawner(),
                Options::default(),
            ),
        ));
        let context = Arc::new(Context::new(peer, Arc::new(FixedClock(1))));
        context.register("session_1", "/w");
        let (dir, path) = socket_path();
        let broker = Arc::new(start(context, path, &scope.spawner()).unwrap());
        Self {
            broker,
            host_out,
            lines: BufReader::new(host_in).lines(),
            _dir: dir,
            _scope: scope,
        }
    }

    async fn next_host_request(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
            .await
            .expect("the broker asked the host")
            .expect("the host stream is open")
            .expect("one line");
        serde_json::from_str(&line).expect("valid JSON")
    }

    async fn reply(&mut self, asked: &Value, result: Value) {
        let line = json!({"id": asked["id"], "result": result});
        self.host_out
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }
}

fn request(id: &str, token: &str, op: &str) -> Value {
    json!({
        "id": id,
        "token": token,
        "op": op,
        "runtimeScope": "main",
        "sessionId": "session_1",
    })
}

#[tokio::test]
async fn list_round_trips_through_the_host() {
    let mut harness = Harness::new();
    let client = connect(harness.broker.socket_path()).await;
    let (read, mut write) = tokio::io::split(client);
    let mut lines = BufReader::new(read).lines();
    let id = "00000000-0000-4000-8000-000000000001";
    let ask = request(id, harness.broker.token(), "list");
    write
        .write_all(format!("{ask}\n").as_bytes())
        .await
        .unwrap();

    let asked = harness.next_host_request().await;
    assert_eq!(asked["method"], BROWSER_LIST);
    assert_eq!(asked["params"]["sessionId"], "session_1");
    assert_eq!(asked["params"]["workspaceKey"], "/w");
    assert_eq!(asked["params"]["workspacePath"], "/w");
    harness.reply(&asked, json!({"browsers": []})).await;

    let line = lines.next_line().await.unwrap().unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], id);
    assert_eq!(response["ok"], true);
    assert_eq!(response["browsers"], json!([]));
}

#[tokio::test]
async fn a_wrong_token_is_rejected_without_asking_the_host() {
    let mut harness = Harness::new();
    let client = connect(harness.broker.socket_path()).await;
    let (read, mut write) = tokio::io::split(client);
    let mut lines = BufReader::new(read).lines();
    let wrong = "x".repeat(64);
    let ask = request(
        "00000000-0000-4000-8000-000000000002",
        &wrong,
        "list",
    );
    write
        .write_all(format!("{ask}\n").as_bytes())
        .await
        .unwrap();

    let line = lines.next_line().await.unwrap().unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["ok"], false);
    assert!(
        response["error"]
            .as_str()
            .unwrap()
            .contains("not authorized")
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(200), harness.lines.next_line())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn execute_records_the_connection_and_close_session_releases_it() {
    let mut harness = Harness::new();
    let client = connect(harness.broker.socket_path()).await;
    let (read, mut write) = tokio::io::split(client);
    let mut lines = BufReader::new(read).lines();
    let id = "00000000-0000-4000-8000-000000000003";
    let mut ask = request(id, harness.broker.token(), "execute");
    ask["browserId"] = json!("browser-1");
    ask["browserGeneration"] = json!(2);
    ask["command"] = json!({"method": "navigate", "url": "https://example.com"});
    write
        .write_all(format!("{ask}\n").as_bytes())
        .await
        .unwrap();

    let asked = harness.next_host_request().await;
    assert_eq!(asked["method"], BROWSER_EXECUTE);
    assert_eq!(asked["params"]["browserId"], "browser-1");
    assert_eq!(asked["params"]["browserGeneration"], 2);
    assert_eq!(asked["params"]["command"]["method"], "navigate");
    harness.reply(&asked, json!({"ok": true})).await;

    let line = lines.next_line().await.unwrap().unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["ok"], true);

    let broker = harness.broker.clone();
    let ended = tokio::spawn(async move { broker.turn_ended("session_1").await });
    let line = tokio::time::timeout(Duration::from_secs(5), harness.lines.next_line())
        .await
        .expect("turnEnded reached the host")
        .expect("the host stream is open")
        .expect("one line");
    let asked: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(asked["method"], BROWSER_EXECUTE);
    assert_eq!(asked["params"]["command"]["method"], "turnEnded");
    assert_eq!(asked["params"]["browserId"], "browser-1");
    let reply = json!({"id": asked["id"], "result": {}});
    harness
        .host_out
        .write_all(format!("{reply}\n").as_bytes())
        .await
        .unwrap();
    ended.await.unwrap();

    let broker = harness.broker.clone();
    let closing = tokio::spawn(async move { broker.close_session("session_1").await });
    let line = tokio::time::timeout(Duration::from_secs(5), harness.lines.next_line())
        .await
        .expect("closeSession reached the host")
        .expect("the host stream is open")
        .expect("one line");
    let asked: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(asked["method"], BROWSER_EXECUTE);
    assert_eq!(asked["params"]["command"]["method"], "closeSession");
    assert_eq!(asked["params"]["browserId"], "browser-1");
    let reply = json!({"id": asked["id"], "result": {}});
    harness
        .host_out
        .write_all(format!("{reply}\n").as_bytes())
        .await
        .unwrap();
    closing.await.unwrap();
}

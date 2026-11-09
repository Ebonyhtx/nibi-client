//! `session/requestRuntimePreferences`：冷打开时问 Host 的启动偏好。
//!
//! 判三件事：Host 的回答真的应用（附加目录下发到内核、AUQ 自动结束按回答起不起表）、
//! 没有 Host 时回退到内核缺省、字段解析只认本内核有开关的两项。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::StreamExt;
use nibi_kernel_api::clock::Clock;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, InteractionId, SessionId, ToolUseId, TraceId};
use nibi_kernel_api::orchestration::InteractionRequest;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{
    Ack, CommandEnvelope, Kernel, KernelError, KernelEvent, SequencedEvent, SessionHandle,
    SessionView,
};
use nibi_kernel_api::session_prefs::{
    AppToolSearchMode, IntegratedShell, SessionExecutionPreferences, ShellDialect,
};
use nibi_kernel_api::store::{SessionFilter, SessionKind, SessionMeta, SessionSummary};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Reply, Service};
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader, duplex};

use super::*;
use crate::context::Context;
use crate::server::{Defaults, Server};

struct Clock0(AtomicU64);

impl Clock for Clock0 {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

struct Handle(SessionView);

#[async_trait]
impl SessionHandle for Handle {
    fn id(&self) -> &SessionId {
        &self.0.meta.id
    }

    async fn send(&self, _command: CommandEnvelope) -> Ack {
        Ack::Accepted {
            result: Value::Null,
        }
    }

    fn subscribe(
        &self,
        _after: Option<u64>,
    ) -> futures_util::stream::BoxStream<'static, SequencedEvent> {
        futures_util::stream::pending().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.0.clone())
    }
}

#[derive(Default)]
struct Kernel0 {
    directories: Mutex<Vec<Vec<String>>>,
    execution: Mutex<Vec<(String, SessionExecutionPreferences)>>,
}

#[async_trait]
impl Kernel for Kernel0 {
    async fn create_session(
        &self,
        _request: nibi_kernel_api::session_api::CreateSession,
    ) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "session creation".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Err(KernelError::Unsupported {
            what: "sessions".to_owned(),
        })
    }

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        let mut view = view();
        view.meta.id = session.clone();
        Ok(Arc::new(Handle(view)))
    }

    async fn set_session_directories(
        &self,
        _session: &SessionId,
        directories: Vec<EnvPath>,
    ) -> Result<(), KernelError> {
        self.directories
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(
                directories
                    .into_iter()
                    .map(|path| path.as_str().to_owned())
                    .collect(),
            );
        Ok(())
    }

    async fn set_session_execution_preferences(
        &self,
        session: &SessionId,
        preferences: SessionExecutionPreferences,
    ) -> Result<(), KernelError> {
        self.execution
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((session.as_str().to_owned(), preferences));
        Ok(())
    }

    async fn session_execution_preferences(
        &self,
        _session: &SessionId,
    ) -> Option<SessionExecutionPreferences> {
        None
    }
}

fn view() -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: SessionId::new("sess_1"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            title: "t".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1_000,
        },
        messages: Vec::new(),
        selection: nibi_kernel_api::model::ModelSelection {
            provider: "p".to_owned(),
            model: "m".to_owned(),
            reasoning: None,
            connection: None,
        },
        mode: PermissionMode::Default,
        plan: false,
        pending: Vec::new(),
        queue: Vec::new(),
        last_seq: 0,
        revision: 0,
        running: false,
        background: Vec::new(),
        peer_held: Vec::new(),
        context_usage: None,
        context_notice: Default::default(),
        output_speed: None,
        launches: Vec::new(),
        model_turns: Vec::new(),
        input_intents: Vec::new(),
    }
}

/// `serve` 需要的一个 Service：测试里所有请求都由下面的假 Host 循环直接回包，走不到它。
struct Nothing;

#[async_trait]
impl Service for Nothing {
    async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
        Err(RpcError::method_not_found(method))
    }
}

struct Harness {
    server: Arc<Server>,
    kernel: Arc<Kernel0>,
    _scope: TaskScope,
    _writer: nibi_kernel_base::Task<()>,
    _serve: nibi_kernel_base::Task<Result<(), std::io::Error>>,
    _host: nibi_kernel_base::Task<()>,
}

/// `answer` 是 Host 对偏好请求的回答；`None` 表示不认识这个方法（纯 CLI/旧对端）。
fn harness(answer: Option<Value>) -> Harness {
    let scope = TaskScope::root("runtime-preferences-test", |_| {});
    let (host_out, agent_in) = duplex(1 << 16);
    let (agent_out, host_in) = duplex(1 << 16);
    let (peer, writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    let serve = scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(agent_in),
            peer.clone(),
            Arc::new(Nothing),
            scope.spawner(),
            Options::default(),
        ),
    );
    // 假 Host：读请求、按 `answer` 回包（与 browser_tests 里驱动 broker 的姿态相同）。
    let mut host_out = host_out;
    let host = scope.spawner().spawn("fake-host", async move {
        let mut lines = BufReader::new(host_in).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let asked: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let Some(id) = asked.get("id").cloned() else {
                continue;
            };
            let response = match &answer {
                Some(result) => json!({"id": id, "result": result}),
                None => json!({
                    "id": id,
                    "error": {"code": -32601, "message": "Method not found"},
                }),
            };
            let mut text = response.to_string();
            text.push_str("\n");
            if tokio::io::AsyncWriteExt::write_all(&mut host_out, text.as_bytes())
                .await
                .is_err()
            {
                return;
            }
        }
    });
    let clock: Arc<dyn Clock> = Arc::new(Clock0(AtomicU64::new(1_000)));
    let kernel = Arc::new(Kernel0::default());
    let server = Arc::new(Server::new(
        Arc::new(Context::new(peer, clock)),
        kernel.clone(),
        scope.spawner(),
        Defaults {
            selection: nibi_kernel_api::model::ModelSelection {
                provider: "p".into(),
                model: "m".into(),
                reasoning: None,
                connection: None,
            },
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));
    server.request_host_preferences();
    Harness {
        server,
        kernel,
        _scope: scope,
        _writer: writer,
        _serve: serve,
        _host: host,
    }
}

async fn ask(live: &Arc<nibi_kernel_protocol_core::sessions::Bridged<crate::live::Live>>) {
    live.sink
        .event_for_test(SequencedEvent {
            seq: 1,
            revision: 1,
            event: KernelEvent::InteractionAsked {
                interaction: InteractionId::new("q1"),
                request: InteractionRequest::Question {
                    tool_use: ToolUseId::new("toolu_1"),
                    questions: json!([]),
                },
            },
        })
        .await;
}

#[tokio::test]
async fn the_host_answer_is_applied_to_the_session() {
    let harness = harness(Some(json!({
        "askUserQuestionAutoResolutionEnabled": false,
        "additionalDirectories": ["/extra"],
        "toolSearchMode": "off",
        "nativeSearchEnhancementsEnabled": false,
        "integratedTerminalShell": {
            "mode": "shell",
            "dialect": "git-bash",
            "path": "C:\\Program Files\\Git\\bin\\bash.exe"
        }
    })));
    let live = harness
        .server
        .live(&SessionId::new("sess_1"))
        .await
        .expect("the session opens");
    // 附加目录交给内核。
    assert_eq!(
        harness
            .kernel
            .directories
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_slice(),
        [vec!["/extra".to_owned()]]
    );
    // 设置页的三项也按会话记下来（工具搜索关闭、增强搜索关闭、用户选的 Git Bash）。
    assert_eq!(
        harness
            .kernel
            .execution
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_slice(),
        [(
            "sess_1".to_owned(),
            SessionExecutionPreferences {
                tool_search: Some(AppToolSearchMode::Off),
                native_search_enhancements: Some(false),
                integrated_shell: Some(IntegratedShell {
                    dialect: ShellDialect::GitBash,
                    path: "C:\\Program Files\\Git\\bin\\bash.exe".to_owned(),
                }),
            }
        )]
    );
    // 自动结束关掉：新问题不起表（不出现 autoResolution）。
    ask(&live).await;
    let summary = live.sink.summary();
    assert!(
        summary["pendingInteraction"].get("autoResolution").is_none(),
        "the countdown must not start when the host disabled it: {summary}"
    );
}

#[tokio::test]
async fn without_an_answering_host_the_kernel_defaults_hold() {
    let harness = harness(None);
    let live = harness
        .server
        .live(&SessionId::new("sess_1"))
        .await
        .expect("the session opens");
    assert!(harness
        .kernel
        .directories
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_empty());
    // 缺省开启：问题进入 hiddenGrace 并带起始时间。
    ask(&live).await;
    let summary = live.sink.summary();
    assert_eq!(
        summary["pendingInteraction"]["autoResolution"]["state"],
        "hiddenGrace"
    );
}

#[test]
fn only_the_preferences_the_kernel_models_are_parsed() {
    let parsed = parse(&json!({
        "askUserQuestionAutoResolutionEnabled": true,
        "additionalDirectories": ["/a", "/b"],
        "memoryEnabled": true,
        "toolSearchMode": "off",
        "nativeSearchEnhancementsEnabled": false
    }));
    assert_eq!(parsed.auto_resolution, Some(true));
    assert_eq!(
        parsed
            .additional_directories
            .iter()
            .map(|path| path.as_str().to_owned())
            .collect::<Vec<_>>(),
        ["/a", "/b"]
    );
    assert_eq!(parsed.execution.tool_search, Some(AppToolSearchMode::Off));
    assert_eq!(parsed.execution.native_search_enhancements, Some(false));
    // 缺字段：都按「没说」处理（用内核缺省）。
    assert_eq!(parse(&json!({})), StartupPreferences::default());
    // 未知模式按没给，不让一个坏值把整份回答读坏。
    assert_eq!(
        parse(&json!({"toolSearchMode": "native"})).execution.tool_search,
        None
    );
}

#[test]
fn the_execution_shell_is_only_taken_when_the_user_picked_one() {
    let shell = parse_execution_shell(&json!({
        "integratedTerminalShell": {
            "mode": "shell",
            "dialect": "cmd",
            "path": "C:\\Windows\\System32\\cmd.exe"
        }
    }));
    assert_eq!(
        shell,
        Some(IntegratedShell {
            dialect: ShellDialect::Cmd,
            path: "C:\\Windows\\System32\\cmd.exe".to_owned(),
        })
    );
    // 自动选择 = 不覆盖；缺字段、空路径、不认识的方言都不覆盖。
    for value in [
        json!({"integratedTerminalShell": {"mode": "auto"}}),
        json!({"integratedTerminalShell": {"mode": "shell", "dialect": "cmd", "path": " "}}),
        json!({"integratedTerminalShell": {"mode": "shell", "dialect": "powershell", "path": "x"}}),
        json!({}),
    ] {
        assert_eq!(parse_execution_shell(&value), None, "{value}");
    }
}

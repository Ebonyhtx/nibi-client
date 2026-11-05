//! 子代理目录与调试面（`session/subagents`、`session/debug`、快照的 `subagents` 键）。
//!
//! 这一族的逻辑全在协议层（投影与累积），所以用最小 Kernel / SessionHandle 替身，经 `Handler`
//! 走真实分派断言 wire 形状（Host 的 zod 是 `.strict()`，多一个键都会被拒）。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::stream::{self, BoxStream};
use futures_util::StreamExt;
use nibi_kernel_base::TaskScope;
use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use nibi_kernel_api::message::Usage;
use nibi_kernel_api::model::{
    ModelRequestStatus, ModelRequestStatusKind, ModelSelection,
};
use nibi_kernel_api::panels::{SubagentActivity, SubagentEntry, SubagentStatus};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{
    Kernel, KernelError, SequencedEvent, SessionHandle, SessionView,
};
use nibi_kernel_api::store::{SessionFilter, SessionKind, SessionMeta, SessionSummary};
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

/// 固定时钟：`1_760_000_000_000` ms。
const NOW_MS: u64 = 1_760_000_000_000;

struct FixedClock;

impl nibi_kernel_api::clock::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        NOW_MS
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

fn selection() -> ModelSelection {
    ModelSelection {
        provider: "p".to_owned(),
        model: "m".to_owned(),
        reasoning: None,
        connection: None,
    }
}

fn view() -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: SessionId::new("sess_a"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("env"),
                root: EnvPath::new("/work"),
            },
            title: "Test".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: NOW_MS,
        },
        messages: Vec::new(),
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
        pending: Vec::new(),
        queue: Vec::new(),
        last_seq: 0,
        revision: 1,
        running: false,
        background: Vec::new(),
        peer_held: Vec::new(),
        context_usage: None,
        context_notice: Default::default(),
        output_speed: None,
        launches: Vec::new(),
        model_turns: Vec::new(),
    }
}

/// 子代理表的替身：测试直接改这一份。
type AgentTable = Arc<Mutex<Vec<SubagentEntry>>>;

struct FakeHandle {
    view: SessionView,
    agents: AgentTable,
}

#[async_trait]
impl SessionHandle for FakeHandle {
    fn id(&self) -> &SessionId {
        &self.view.meta.id
    }

    async fn send(
        &self,
        _command: nibi_kernel_api::session_api::CommandEnvelope,
    ) -> nibi_kernel_api::session_api::Ack {
        nibi_kernel_api::session_api::Ack::Accepted { result: Value::Null }
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.clone())
    }

    async fn subagents(&self) -> Result<Vec<SubagentEntry>, KernelError> {
        Ok(self.agents.lock().unwrap().clone())
    }
}

struct FakeKernel {
    agents: AgentTable,
}

#[async_trait]
impl Kernel for FakeKernel {
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
        Ok(Vec::new())
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Ok(Arc::new(FakeHandle {
            view: view(),
            agents: self.agents.clone(),
        }))
    }
}

fn server_for(agents: AgentTable) -> Arc<Server> {
    let scope = TaskScope::root("subagents-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> = Arc::new(FixedClock);
    let context = Arc::new(Context::new(peer, clock));
    Arc::new(Server::new(
        context,
        Arc::new(FakeKernel { agents }),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ))
}

fn running(child: &str, agent: &str, started_ago_ms: u64) -> SubagentEntry {
    SubagentEntry {
        agent: nibi_kernel_api::ids::AgentId::new(agent),
        child: SessionId::new(child),
        agent_type: "Explore".to_owned(),
        description: "look around".to_owned(),
        status: SubagentStatus::Running,
        background: false,
        waiting: false,
        elapsed_ms: started_ago_ms,
        ended_ago_ms: None,
        version: 1,
        owner: None,
        activity: Some(SubagentActivity::Tool {
            name: "Read".to_owned(),
        }),
        parked: false,
        machine: None,
    }
}

fn ended(child: &str, agent: &str, status: SubagentStatus, ended_ago_ms: u64) -> SubagentEntry {
    SubagentEntry {
        agent: nibi_kernel_api::ids::AgentId::new(agent),
        child: SessionId::new(child),
        agent_type: "general".to_owned(),
        description: "did a thing".to_owned(),
        status,
        background: false,
        waiting: false,
        elapsed_ms: 5_000,
        ended_ago_ms: Some(ended_ago_ms),
        version: 3,
        owner: None,
        activity: None,
        parked: false,
        machine: None,
    }
}

// ———— session/subagents ————

/// 在跑与已结束项都按 Host schema 出形状；`ended` 分页带 `nextCursor` 时它必须能续上。
#[tokio::test]
async fn session_subagents_projects_running_and_paginates_ended() {
    let agents: AgentTable = Arc::new(Mutex::new(vec![
        running("sess_c1", "agent_1", 2_000),
        ended("sess_e1", "agent_2", SubagentStatus::Completed, 10_000),
        ended("sess_e2", "agent_3", SubagentStatus::Failed, 20_000),
        ended("sess_e3", "agent_4", SubagentStatus::Killed, 30_000),
    ]));
    let server = server_for(agents);

    let reply = Handler(server.clone())
        .request(
            "session/subagents",
            json!({"sessionId": "sess_a", "endedLimit": 2}),
        )
        .await
        .unwrap();
    let result = &reply.result;
    assert_eq!(result["childSessionIds"].as_array().unwrap().len(), 4);
    assert_eq!(result["running"].as_array().unwrap().len(), 1);
    assert_eq!(result["running"][0]["status"], "running");
    // 用时反推启动时刻：`now - elapsed`。
    assert_eq!(result["running"][0]["startedAt"], NOW_MS - 2_000);
    // ended 从新到旧（结束得晚的在前），共 3 条、首页 2 条。
    assert_eq!(result["ended"]["total"], 3);
    let items = result["ended"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["childSessionId"], "sess_e1");
    assert_eq!(items[1]["childSessionId"], "sess_e2");
    // 被杀的子代理在 Host 的词表里是 cancelled。
    let cursor = result["ended"]["nextCursor"].as_str().unwrap();

    let next = Handler(server)
        .request(
            "session/subagents",
            json!({"sessionId": "sess_a", "endedLimit": 2, "endedCursor": cursor}),
        )
        .await
        .unwrap();
    let items = next.result["ended"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["childSessionId"], "sess_e3");
    assert_eq!(items[0]["status"], "cancelled");
    // 最后一页没有 nextCursor（schema 是 optional，不是 nullable：整个键不写）。
    assert!(next.result["ended"].get("nextCursor").is_none());
}

/// 等用户回答的子代理报 `waiting`（不是 `running`）：界面据此把行标成待输入。
#[tokio::test]
async fn session_subagents_marks_waiting_agents() {
    let mut waiting = running("sess_c1", "agent_1", 1_000);
    waiting.waiting = true;
    let agents: AgentTable = Arc::new(Mutex::new(vec![waiting]));
    let server = server_for(agents);

    let reply = Handler(server)
        .request("session/subagents", json!({"sessionId": "sess_a"}))
        .await
        .unwrap();
    assert_eq!(reply.result["running"][0]["status"], "waiting");
}

/// 没有子代理时回一份空表（不是错误）：目录侧栏显示空态。
#[tokio::test]
async fn session_subagents_is_empty_without_children() {
    let agents: AgentTable = Arc::new(Mutex::new(Vec::new()));
    let server = server_for(agents);

    let reply = Handler(server)
        .request("session/subagents", json!({"sessionId": "sess_a"}))
        .await
        .unwrap();
    assert_eq!(reply.result["childSessionIds"], json!([]));
    assert_eq!(reply.result["running"], json!([]));
    assert_eq!(reply.result["ended"]["total"], 0);
    assert_eq!(reply.result["ended"]["items"], json!([]));
}

// ———— 快照的 subagents 键 ————

/// 快照的 `subagents` 键与 `session/subagents` 同一事实源：冷打开（首帧之前）就带上在跑的子代理。
#[tokio::test]
async fn snapshot_carries_the_subagent_directory() {
    let agents: AgentTable = Arc::new(Mutex::new(vec![
        running("sess_c1", "agent_1", 1_500),
        ended("sess_e1", "agent_2", SubagentStatus::Completed, 9_000),
    ]));
    let server = server_for(agents);

    let live = server.live(&SessionId::new("sess_a")).await.unwrap();
    let subagents = live.sink.snapshot_for_test();
    assert_eq!(subagents["childSessionIds"], json!(["sess_c1", "sess_e1"]));
    assert_eq!(subagents["running"].as_array().unwrap().len(), 1);
    assert_eq!(subagents["endedTotal"], 1);
    // renderer 用 revision 0 区分「还没建立权威态」：有内容时必须 > 0。
    assert!(subagents["revision"].as_u64().unwrap() >= 1);
}

// ———— session/debug ————

/// 调试面：网络条目一条状态事实一条，轮次面一轮一条，用量累计成 cache 汇总。
#[tokio::test]
async fn session_debug_accumulates_network_and_rounds() {
    let agents: AgentTable = Arc::new(Mutex::new(Vec::new()));
    let server = server_for(agents);
    let live = server.live(&SessionId::new("sess_a")).await.unwrap();

    // 没跑过任何请求：空快照（不是错误），cache 为 null。
    let empty = Handler(server.clone())
        .request("session/debug", json!({"sessionId": "sess_a"}))
        .await
        .unwrap();
    assert_eq!(empty.result["rounds"], json!([]));
    assert_eq!(empty.result["networkEntries"], json!([]));
    assert_eq!(empty.result["cache"], Value::Null);

    // 一回合：模型请求 started → completed，回合结束带用量。
    let status = |kind: ModelRequestStatusKind, attempt: u32| ModelRequestStatus {
        kind,
        request_id: "req_1".to_owned(),
        provider_id: "p".to_owned(),
        model_id: "m".to_owned(),
        provider_hostname: None,
        transport: "sse".to_owned(),
        query_source: Some("main_turn".to_owned()),
        query_id: Some("q_1".to_owned()),
        attempt,
        max_attempts: 3,
        duration_ms: Some(1_200),
        reason: None,
        retryable: None,
        status_code: None,
        delay_ms: None,
        next_attempt: None,
        idle_ms: None,
        timeout_ms: None,
    };
    let events = vec![
        nibi_kernel_api::session_api::KernelEvent::ModelRequestStatus {
            status: status(ModelRequestStatusKind::ModelRequestStarted, 1),
        },
        nibi_kernel_api::session_api::KernelEvent::ModelRequestStatus {
            status: status(ModelRequestStatusKind::ModelRequestCompleted, 1),
        },
        nibi_kernel_api::session_api::KernelEvent::TurnFinished {
            turn: nibi_kernel_api::ids::TurnId::new("turn_1"),
            outcome: nibi_kernel_api::session_api::TurnOutcome::Success,
            usage: Some(Usage {
                input_tokens: 1_000,
                output_tokens: 200,
                cache_creation_input_tokens: 50,
                cache_read_input_tokens: 400,
            }),
        },
    ];
    for (seq, event) in events.into_iter().enumerate() {
        live.sink
            .event_for_test(SequencedEvent {
                seq: seq as u64 + 1,
                revision: 1,
                event,
            })
            .await;
    }

    let snapshot = live.sink.debug_snapshot();
    assert_eq!(snapshot["networkEntries"].as_array().unwrap().len(), 2);
    // 各状态只带该有的字段（Host schema 是 strict）。
    let entries = snapshot["networkEntries"].as_array().unwrap();
    assert_eq!(entries[0]["statusType"], "model_request_started");
    assert_eq!(entries[1]["statusType"], "model_request_completed");
    assert_eq!(entries[1]["durationMs"], 1_200);
    assert_eq!(entries[0]["attempt"], 1);
    assert_eq!(entries[0]["maxAttempts"], 3);
    // 头三件套：内核不带线上头，如实空对象与 0 计数。
    assert_eq!(entries[0]["requestHeaders"], json!({}));
    assert_eq!(entries[0]["requestHeaderCount"], 0);

    assert_eq!(snapshot["rounds"].as_array().unwrap().len(), 1);
    let round = &snapshot["rounds"][0];
    assert_eq!(round["usage"]["inputTokens"], 1_000);
    assert_eq!(round["usage"]["outputTokens"], 200);
    assert_eq!(round["usage"]["totalTokens"], 1_200);
    assert_eq!(round["usage"]["cachedInputTokens"], 400);
    assert_eq!(round["usage"]["cachedWriteInputTokens"], 50);
    assert_eq!(round["hitRate"], 0.4);
    assert_eq!(round["generationDurationMs"], Value::Null);
    assert_eq!(round["tokensPerSecond"], Value::Null);

    assert_eq!(snapshot["cache"]["hitRateRequestCount"], 1);
    assert_eq!(snapshot["cache"]["totalInputTokens"], 1_000);
    assert_eq!(snapshot["cache"]["totalCacheReadTokens"], 400);
    assert_eq!(snapshot["cache"]["hitRate"], 0.4);
}

/// 没打开的会话：`session/debug` 回空快照，不报错（UI 显示空态）。
#[tokio::test]
async fn session_debug_falls_back_to_an_empty_snapshot() {
    let agents: AgentTable = Arc::new(Mutex::new(Vec::new()));
    let server = server_for(agents);
    let reply = Handler(server)
        .request("session/debug", json!({"sessionId": "never_opened"}))
        .await
        .unwrap();
    assert_eq!(reply.result["sessionId"], "never_opened");
    assert_eq!(reply.result["rounds"], json!([]));
    assert_eq!(reply.result["cache"], Value::Null);
}

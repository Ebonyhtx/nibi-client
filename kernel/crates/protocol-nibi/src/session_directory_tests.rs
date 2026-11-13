//! `session/list`（Host 的任务列表、项目谱系校验与分享导入去重）。
//!
//! 逻辑全在协议层（归属校验与 wire 形状），所以用最小 Kernel 替身把会话目录喂进去，经
//! `Handler` 走真实分派断言：Host 的 `nibiSessionInfoSchema` 是 `.strict()`，多一个键、
//! 少一个必填键都会被拒，形状只能按 wire 断言。
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::stream::{self, BoxStream};
use futures_util::StreamExt;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Kernel, KernelError, SessionHandle, SessionView};
use nibi_kernel_api::store::{
    SessionDirectoryEntry, SessionDirectoryQuery, SessionFilter, SessionKind, SessionMeta,
    SessionSummary,
};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

struct FixedClock;

impl nibi_kernel_api::clock::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        1_760_000_000_000
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

fn selection() -> nibi_kernel_api::model::ModelSelection {
    nibi_kernel_api::model::ModelSelection {
        provider: "p".to_owned(),
        model: "m".to_owned(),
        reasoning: None,
        connection: None,
    }
}

/// 目录里的一行：只写调用方关心的列，其余给缺省值。
fn row(id: &str, task_type: &str) -> SessionDirectoryEntry {
    SessionDirectoryEntry {
        id: SessionId::new(id),
        parent: None,
        trace: Some(format!("trace_{id}")),
        task_type: task_type.to_owned(),
        title: format!("Title {id}"),
        title_source: Some("first_input".to_owned()),
        workspace_id: None,
        directory: "/w/app".to_owned(),
        path: Some("/w/app".to_owned()),
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
    }
}

struct FakeKernel {
    rows: Vec<SessionDirectoryEntry>,
    /// 每次收到的查询，供断言 limit / ids / directory 的下推。
    queries: Mutex<Vec<SessionDirectoryQuery>>,
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

    async fn session_directory(
        &self,
        query: SessionDirectoryQuery,
    ) -> Result<Vec<SessionDirectoryEntry>, KernelError> {
        self.queries.lock().unwrap().push(query.clone());
        // 模拟存储的两种读法：显式 ID 逐条取，否则按目录 + 任务类型白名单。
        let rows = match &query.ids {
            Some(ids) => self
                .rows
                .iter()
                .filter(|row| ids.contains(&row.id))
                .cloned()
                .collect(),
            None => {
                let mut rows: Vec<_> = self
                    .rows
                    .iter()
                    .filter(|row| {
                        matches!(row.task_type.as_str(), "interactive" | "fork" | "workflow_parent")
                    })
                    .filter(|row| {
                        query
                            .directory
                            .as_deref()
                            .is_none_or(|directory| row.directory == directory)
                    })
                    .cloned()
                    .collect();
                rows.truncate(query.limit);
                rows
            }
        };
        Ok(rows)
    }

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Ok(Arc::new(FakeHandle {
            view: SessionView {
                meta: SessionMeta {
                    id: session.clone(),
                    kind: SessionKind::Interactive,
                    parent: None,
                    workspace: WorkspaceRef {
                        environment: EnvironmentId::new("env"),
                        root: EnvPath::new("/w/app"),
                    },
                    title: String::new(),
                    trace: TraceId::new(session.as_str()),
                    created_at_ms: 0,
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
                input_intents: Vec::new(),
            },
        }))
    }
}

struct FakeHandle {
    view: SessionView,
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

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, nibi_kernel_api::session_api::SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.clone())
    }
}

fn server_for(rows: Vec<SessionDirectoryEntry>) -> (Arc<Server>, Arc<FakeKernel>) {
    let scope = TaskScope::root("session-directory-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> = Arc::new(FixedClock);
    let context = Arc::new(Context::new(peer, clock));
    let kernel = Arc::new(FakeKernel {
        rows,
        queries: Mutex::new(Vec::new()),
    });
    let server = Arc::new(Server::new(
        context,
        kernel.clone(),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));
    (server, kernel)
}

fn workspace() -> Value {
    json!({
        "workspacePath": "/w/app",
        "workspaceKey": "/w/app",
    })
}

/// 目录读法：任务列表口径的行原样出 `nibiSessionInfo`，workspace 回声，缺省字段按 Node
/// `mapSessionInfo` 给（`mode: "build"`、`status: "idle"`，不写 `model` / `target`）。
#[tokio::test]
async fn session_list_projects_the_directory_as_session_info() {
    let (server, _kernel) = server_for(vec![row("sess_a", "interactive")]);

    let reply = Handler(server)
        .request("session/list", json!({"workspace": workspace()}))
        .await
        .unwrap();
    let sessions = reply.result["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    let session = &sessions[0];
    assert_eq!(session["sessionId"], "sess_a");
    assert_eq!(session["workspace"], workspace());
    assert_eq!(session["sessionKind"], "interactive");
    assert_eq!(session["title"], "Title sess_a");
    assert_eq!(session["titleSource"], "first_input");
    assert_eq!(session["traceId"], "trace_sess_a");
    assert_eq!(session["mode"], "build");
    assert_eq!(session["status"], "idle");
    assert_eq!(session["createdAt"], 1_000);
    assert_eq!(session["updatedAt"], 2_000);
    // strict schema：可选字段缺席就不写键，多写的键会被 Host 拒收。
    assert!(session.get("model").is_none());
    assert!(session.get("target").is_none());
    assert!(session.get("parentSessionId").is_none());
}

/// 默认 50 条、`limit` 与 `workspacePath` 原样下推到存储：Host 的 zod 要求 `limit` 是正数，
/// 协议层不能把它丢掉或当字符串传。
#[tokio::test]
async fn session_list_forwards_the_limit_and_the_workspace_directory() {
    let (server, kernel) = server_for(vec![row("sess_a", "interactive")]);

    Handler(server.clone())
        .request("session/list", json!({"workspace": workspace()}))
        .await
        .unwrap();
    Handler(server)
        .request("session/list", json!({"workspace": workspace(), "limit": 7}))
        .await
        .unwrap();

    let queries = kernel.queries.lock().unwrap();
    assert_eq!(queries.len(), 2);
    assert_eq!(queries[0].limit, 50);
    assert_eq!(queries[0].directory.as_deref(), Some("/w/app"));
    assert!(queries[0].ids.is_none());
    assert_eq!(queries[1].limit, 7);
}

/// 归属校验：带了另一个远端身份的会话不能混进这个工作区（Node `scoped()` 的 key 比对）。
#[tokio::test]
async fn session_list_drops_sessions_of_another_workspace() {
    let mut other = row("sess_other", "interactive");
    other.workspace_id = Some("remote:wsl:/w/elsewhere".to_owned());
    other.directory = "/w/app".to_owned();
    other.path = Some("/w/elsewhere".to_owned());
    let (server, _kernel) = server_for(vec![row("sess_here", "interactive"), other]);

    let reply = Handler(server)
        .request("session/list", json!({"workspace": workspace()}))
        .await
        .unwrap();
    let ids: Vec<&str> = reply.result["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|session| session["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["sess_here"]);
}

/// 显式 ID 读法保留 `subagent_child`（主机靠它还原子代理索引），但同一道归属校验照跑。
#[tokio::test]
async fn session_list_by_ids_keeps_auxiliary_sessions() {
    let mut child = row("sess_child", "subagent_child");
    child.parent = Some(SessionId::new("sess_a"));
    let (server, _kernel) = server_for(vec![row("sess_a", "interactive"), child]);

    let reply = Handler(server)
        .request(
            "session/list",
            json!({"workspace": workspace(), "sessionIds": ["sess_child"]}),
        )
        .await
        .unwrap();
    let sessions = reply.result["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["sessionId"], "sess_child");
    assert_eq!(sessions[0]["sessionKind"], "subagent_child");
    assert_eq!(sessions[0]["parentSessionId"], "sess_a");
}

/// 子会话的 `path` 与工作区不符时不能靠父链洗白：Node 的第一个上溯条件就要求
/// `path === workspacePath`（父链遍历在现行条件下实际只走一圈，这条把它钉住）。
#[tokio::test]
async fn session_list_does_not_rescue_a_child_whose_path_is_outside_the_workspace() {
    let mut child = row("sess_child", "subagent_child");
    child.parent = Some(SessionId::new("sess_a"));
    child.path = Some("/w/app/pkg".to_owned());
    let (server, _kernel) = server_for(vec![row("sess_a", "interactive"), child]);

    let reply = Handler(server)
        .request(
            "session/list",
            json!({"workspace": workspace(), "sessionIds": ["sess_child"]}),
        )
        .await
        .unwrap();
    assert!(reply.result["sessions"].as_array().unwrap().is_empty());
}

/// `fork` 不是辅助会话：即使父会话在本工作区，也不能沿父链改写项目归属。
#[tokio::test]
async fn session_list_does_not_walk_the_parent_chain_for_forks() {
    let mut fork = row("sess_fork", "fork");
    fork.parent = Some(SessionId::new("sess_a"));
    fork.workspace_id = Some("remote:wsl:/w/elsewhere".to_owned());
    fork.path = Some("/w/elsewhere".to_owned());
    let (server, _kernel) = server_for(vec![row("sess_a", "interactive"), fork]);

    let reply = Handler(server)
        .request(
            "session/list",
            json!({"workspace": workspace(), "sessionIds": ["sess_fork"]}),
        )
        .await
        .unwrap();
    assert!(reply.result["sessions"].as_array().unwrap().is_empty());
}

/// 没有 workspace 参数：不设目录也不做归属校验（Node 同一分支），workspace 由行自身补出。
#[tokio::test]
async fn session_list_without_a_workspace_returns_rows_with_their_own_workspace() {
    let mut other = row("sess_other", "interactive");
    other.directory = "/w/lib".to_owned();
    other.path = None;
    let (server, _kernel) = server_for(vec![row("sess_a", "interactive"), other]);

    let reply = Handler(server)
        .request("session/list", json!({}))
        .await
        .unwrap();
    let sessions = reply.result["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    // Node `buildWorkspaceRef({workspacePath: session.path ?? session.directory})`：
    // 没有 path 时用 directory，workspaceKey 就是路径。
    assert_eq!(
        sessions[1]["workspace"],
        json!({"workspacePath": "/w/lib", "workspaceKey": "/w/lib"})
    );
}

/// 存储端口没有这条读面时退回空列表（不是错误）：Host 把错误当加载失败。
#[tokio::test]
async fn session_list_degrades_to_an_empty_list_when_the_store_cannot_answer() {
    struct NoDirectory;

    #[async_trait]
    impl Kernel for NoDirectory {
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
            session: &SessionId,
        ) -> Result<Arc<dyn SessionHandle>, KernelError> {
            Ok(Arc::new(FakeHandle {
                view: SessionView {
                    meta: SessionMeta {
                        id: session.clone(),
                        kind: SessionKind::Interactive,
                        parent: None,
                        workspace: WorkspaceRef {
                            environment: EnvironmentId::new("env"),
                            root: EnvPath::new("/w/app"),
                        },
                        title: String::new(),
                        trace: TraceId::new(session.as_str()),
                        created_at_ms: 0,
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
                    input_intents: Vec::new(),
                },
            }))
        }
    }

    let scope = TaskScope::root("session-directory-unsupported", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> = Arc::new(FixedClock);
    let server = Arc::new(Server::new(
        Arc::new(Context::new(peer, clock)),
        Arc::new(NoDirectory),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));

    let reply = Handler(server)
        .request("session/list", json!({"workspace": workspace()}))
        .await
        .unwrap();
    assert_eq!(reply.result["sessions"], json!([]));
}

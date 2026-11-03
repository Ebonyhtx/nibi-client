//! 行分页与计划目录（141 审计 §9 第 2 项余项）：`v4/conversation/rowsRange` 的游标语义与
//! `v4/conversation/plans` 的终态过滤。

use std::sync::Arc;

use async_trait::async_trait;
use futures_util::stream::{self, BoxStream, StreamExt};
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId, ToolUseId, TraceId};
use rust_cli_kernel_api::message::{AssistantMessage, ContentBlock, Message, ToolResultContent, UserMessage, UserOrigin};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, CommandEnvelope, Kernel, KernelError, SessionHandle, SessionView,
};
use rust_cli_kernel_api::store::{SessionFilter, SessionKind, SessionMeta, SessionSummary};
use rust_cli_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

fn selection() -> ModelSelection {
    ModelSelection {
        provider: "p".to_owned(),
        model: "m".to_owned(),
        reasoning: None,
        connection: None,
    }
}

/// 一段带计划工具调用的历史：user → assistant(ExitPlanMode) → tool_result → user。
fn plan_call(id: &str, plan: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::ToolUse {
            id: ToolUseId::new(format!("tool_{id}")),
            name: "ExitPlanMode".to_owned(),
            input: json!({"plan": plan}),
        }],
        model: "m".to_owned(),
        stop_reason: None,
        usage: None,
    })
}

fn plan_result(id: &str, is_error: bool) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(format!("r_{id}")),
        content: vec![ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new(format!("tool_{id}")),
            content: vec![ToolResultContent::Text {
                text: if is_error { "rejected" } else { "approved" }.to_owned(),
            }],
            is_error,
        }],
        origin: UserOrigin::ToolResult {
            assistant: MessageId::new(id),
        },
    })
}

fn view(id: &str) -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: SessionId::new(id),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("env"),
                root: EnvPath::new("/work"),
            },
            title: "Test".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1_000,
        },
        messages: vec![
            Message::User(UserMessage {
                id: MessageId::new("u1"),
                content: vec![ContentBlock::Text {
                    text: "do the thing".to_owned(),
                }],
                origin: UserOrigin::Human,
            }),
            plan_call("a1", "# First plan\n\n1. do it"),
            plan_result("a1", false),
            plan_call("a2", ""),
            plan_result("a2", false),
            plan_call("a3", "# Third plan"),
            plan_result("a3", true),
        ],
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
        pending: Vec::new(),
        queue: Vec::new(),
        last_seq: 1,
        revision: 7,
        running: false,
        background: Vec::new(),
        peer_held: Vec::new(),
        context_usage: None,
        context_notice: Default::default(),
        output_speed: None,
        launches: Vec::new(),
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

    async fn send(&self, _command: CommandEnvelope) -> KernelAck {
        KernelAck::Accepted {
            result: Value::Null,
        }
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, rust_cli_kernel_api::session_api::SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.clone())
    }

    async fn background_output(
        &self,
        task: &str,
        max_bytes: u64,
    ) -> Result<Option<rust_cli_kernel_api::manage::BackgroundOutput>, KernelError> {
        assert_eq!(max_bytes, 8_192, "the protocol layer passes the Host bound");
        match task {
            "work_ok" => Ok(Some(rust_cli_kernel_api::manage::BackgroundOutput {
                work_id: task.to_owned(),
                status: rust_cli_kernel_api::env_shell::BackgroundStatus::Completed,
                output: "done
".to_owned(),
                truncated: true,
                output_path: "/work/tasks/work_ok.output".to_owned(),
            })),
            "work_killed" => Ok(Some(rust_cli_kernel_api::manage::BackgroundOutput {
                work_id: task.to_owned(),
                status: rust_cli_kernel_api::env_shell::BackgroundStatus::Killed,
                output: String::new(),
                truncated: false,
                output_path: "/work/tasks/work_killed.output".to_owned(),
            })),
            "work_remote" => Err(KernelError::Unsupported {
                what: "background_output_tail".to_owned(),
            }),
            "work_broken" => Err(KernelError::Failed {
                message: "io error: permission denied".to_owned(),
            }),
            _ => Ok(None),
        }
    }
}

struct FakeKernel {
    view: SessionView,
}

#[async_trait]
impl Kernel for FakeKernel {
    async fn create_session(
        &self,
        _request: rust_cli_kernel_api::session_api::CreateSession,
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
            view: self.view.clone(),
        }))
    }
}

fn server(id: &str) -> Arc<Server> {
    let scope = TaskScope::root("v4-rows-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(
        peer,
        Arc::new(rust_cli_kernel_api::testing::FixedClock(5)),
    ));
    Arc::new(Server::new(
        context,
        Arc::new(FakeKernel { view: view(id) }),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ))
}

/// 一窗一窗往上翻：全序是 rowId 升序，`beforeRowId` 之前的最后 `limit` 行，`hasMore` 表示还有更早的；
/// 翻到底时把所有行拼起来是严格递减的 rowId 序列（不重不漏的方向性）。
#[tokio::test]
async fn rows_range_walks_backwards_by_row_id() {
    let server = server("sess_rows");
    let mut before: Option<u64> = None;
    let mut seen: Vec<u64> = Vec::new();
    let mut pages = 0;
    loop {
        let params = match before {
            None => json!({"sessionId": "sess_rows", "limit": 2}),
            Some(cursor) => json!({"sessionId": "sess_rows", "limit": 2, "beforeRowId": cursor}),
        };
        let reply = Handler(server.clone())
            .request("v4/conversation/rowsRange", params)
            .await
            .expect("a page");
        let rows = reply.result["rows"].as_array().expect("rows");
        assert!(!rows.is_empty(), "every page before the end has rows");
        assert!(rows.len() <= 2);
        // 页内是 rowId 升序。
        let ids: Vec<u64> = rows
            .iter()
            .map(|row| row["rowId"].as_u64().expect("a row id"))
            .collect();
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]), "{ids:?}");
        // 跨页严格递减（这一页的最后一行比上一页取到的最早一行更早）。
        if let Some(last) = seen.last() {
            assert!(ids.iter().all(|id| id < last), "page crosses the cursor");
        }
        seen.extend(ids.iter().copied());
        pages += 1;
        if reply.result["hasMore"] != true {
            assert_eq!(reply.result["atRevision"], 7);
            assert!(
                reply.result["atLogEpoch"]
                    .as_str()
                    .is_some_and(|epoch| !epoch.is_empty())
            );
            break;
        }
        before = ids.first().copied();
        assert!(pages < 50, "the walk terminates");
    }
    assert!(seen.len() > 2, "the fixture has several rows: {seen:?}");
}

/// 计划目录：终态、有 plan 正文的 ExitPlanMode，按 rowId 降序；正文为空的与失败的都算终态。
#[tokio::test]
async fn plans_lists_terminal_plan_calls_newest_first() {
    let server = server("sess_plans");
    let reply = Handler(server)
        .request(
            "v4/conversation/plans",
            json!({"sessionId": "sess_plans"}),
        )
        .await
        .expect("a directory");
    let plans = reply.result["plans"].as_array().expect("plans");
    // a1 有正文、成功；a2 正文为空；a3 有正文但被拒（error 也是终态）。
    assert_eq!(plans.len(), 2);
    let names: Vec<&str> = plans
        .iter()
        .map(|row| row["toolName"].as_str().expect("a tool name"))
        .collect();
    assert_eq!(names, ["ExitPlanMode", "ExitPlanMode"]);
    let ids: Vec<u64> = plans
        .iter()
        .map(|row| row["rowId"].as_u64().expect("a row id"))
        .collect();
    assert!(ids[0] > ids[1], "newest first");
    assert!(reply.result["atLogEpoch"].as_str().is_some_and(|epoch| !epoch.is_empty()));
}

/// 后台命令输出：四种结果形状与 Host 的联合类型逐一对应（成功 / 没有这个任务 / 机器不支持 / 读失败）。
#[tokio::test]
async fn background_bash_output_covers_all_result_shapes() {
    let server = server("sess_bg");

    let reply = Handler(server.clone())
        .request(
            "v4/conversation/backgroundBashOutput",
            json!({"sessionId": "sess_bg", "workId": "work_ok"}),
        )
        .await
        .expect("a result");
    assert_eq!(reply.result["kind"], "output");
    assert_eq!(reply.result["status"], "completed");
    assert_eq!(reply.result["output"], "done
");
    assert_eq!(reply.result["truncated"], true);
    assert_eq!(reply.result["outputPath"], "/work/tasks/work_ok.output");

    let reply = Handler(server.clone())
        .request(
            "v4/conversation/backgroundBashOutput",
            json!({"sessionId": "sess_bg", "workId": "work_killed"}),
        )
        .await
        .expect("a result");
    assert_eq!(reply.result["status"], "cancelled");

    for (work, kind) in [
        ("work_missing", "unavailable"),
        ("work_remote", "unsupported"),
        ("work_broken", "read_failed"),
    ] {
        let reply = Handler(server.clone())
            .request(
                "v4/conversation/backgroundBashOutput",
                json!({"sessionId": "sess_bg", "workId": work}),
            )
            .await
            .expect("a result");
        assert_eq!(reply.result["kind"], kind, "{work}");
        assert_eq!(reply.result["workId"], work);
    }
}

/// 参数契约：未知键、越界 `limit`、非法 `clientMode` 都是 `-32602`。
#[tokio::test]
async fn rows_range_validates_its_params() {
    let server = server("sess_bad");
    for params in [
        json!({"sessionId": "sess_bad", "limit": 2, "extra": 1}),
        json!({"sessionId": "sess_bad", "limit": 0}),
        json!({"sessionId": "sess_bad", "limit": 201}),
        json!({"sessionId": "sess_bad", "limit": 2, "clientMode": "nope"}),
        json!({"sessionId": 7, "limit": 2}),
        json!({"limit": 2}),
    ] {
        let error = match Handler(server.clone())
            .request("v4/conversation/rowsRange", params.clone())
            .await
        {
            Ok(_) => panic!("invalid params must be rejected: {params}"),
            Err(error) => error,
        };
        assert_eq!(error.code, -32602, "{params}");
    }
}

//! 行分页与计划目录（141 审计 §9 第 2 项余项）：`v4/conversation/rowsRange` 的游标语义与
//! `v4/conversation/plans` 的终态过滤。

use std::sync::Arc;

use async_trait::async_trait;
use futures_util::stream::{self, BoxStream, StreamExt};
use nibi_kernel_base::TaskScope;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, MessageId, SessionId, ToolUseId, TraceId};
use nibi_kernel_api::message::{AssistantMessage, ContentBlock, Message, ToolResultContent, UserMessage, UserOrigin};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{
    Ack as KernelAck, CommandEnvelope, Kernel, KernelError, SessionHandle, SessionView,
};
use nibi_kernel_api::store::{SessionFilter, SessionKind, SessionMeta, SessionSummary};
use nibi_kernel_protocol_core::connection::{self, Options, Service};
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
        model_turns: Vec::new(),
        input_intents: Vec::new(),
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

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, nibi_kernel_api::session_api::SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.clone())
    }

    async fn background_output(
        &self,
        task: &str,
        max_bytes: u64,
    ) -> Result<Option<nibi_kernel_api::manage::BackgroundOutput>, KernelError> {
        assert_eq!(max_bytes, 8_192, "the protocol layer passes the Host bound");
        match task {
            "work_ok" => Ok(Some(nibi_kernel_api::manage::BackgroundOutput {
                work_id: task.to_owned(),
                status: nibi_kernel_api::env_shell::BackgroundStatus::Completed,
                output: "done
".to_owned(),
                truncated: true,
                output_path: "/work/tasks/work_ok.output".to_owned(),
            })),
            "work_killed" => Ok(Some(nibi_kernel_api::manage::BackgroundOutput {
                work_id: task.to_owned(),
                status: nibi_kernel_api::env_shell::BackgroundStatus::Killed,
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

    async fn file_change_summaries(
        &self,
    ) -> Result<Vec<nibi_kernel_api::file_changes::TurnFileSummary>, KernelError> {
        Ok(vec![nibi_kernel_api::file_changes::TurnFileSummary {
            prompt: MessageId::new("u1"),
            files: 2,
            additions: 5,
            deletions: 1,
        }])
    }

    async fn file_changes(
        &self,
        messages: &[MessageId],
    ) -> Result<nibi_kernel_api::file_changes::FileChangesReport, KernelError> {
        assert_eq!(
            messages.iter().map(MessageId::as_str).collect::<Vec<_>>(),
            ["u1", "a1", "a2", "a3"],
            "the protocol layer resolves the turn's message ids"
        );
        Ok(nibi_kernel_api::file_changes::FileChangesReport {
            files: 1,
            additions: 5,
            deletions: 1,
            items: vec![nibi_kernel_api::file_changes::FileChangeItem {
                path: "/work/a.txt".to_owned(),
                additions: 5,
                deletions: 1,
                write_count: 1,
                tool_names: vec!["Edit".to_owned()],
                patches: Vec::new(),
            }],
        })
    }

    async fn file_rewind_preview(
        &self,
        messages: &[MessageId],
    ) -> Result<nibi_kernel_api::file_changes::RewindPreview, KernelError> {
        assert_eq!(messages.len(), 4);
        Ok(nibi_kernel_api::file_changes::RewindPreview {
            can_apply: true,
            safe_files: vec![nibi_kernel_api::file_changes::RewindSafeFile {
                action: nibi_kernel_api::file_changes::RewindAction::Restore,
                operation_count: 1,
                path: "/work/a.txt".to_owned(),
                tool_names: vec!["Edit".to_owned()],
            }],
            unsafe_files: Vec::new(),
            ignored_files: Vec::new(),
        })
    }
}

struct FakeKernel {
    view: SessionView,
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
        Arc::new(nibi_kernel_api::testing::FixedClock(5)),
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

/// 轮头行、`atRevision` 与 `atLogEpoch`（只读查询的 CAS 基线）。
async fn turn_header(server: &Arc<Server>, session: &str) -> (Value, u64, String) {
    let reply = Handler(server.clone())
        .request(
            "v4/conversation/rowsRange",
            json!({"sessionId": session, "limit": 200}),
        )
        .await
        .expect("a page");
    let rows = reply.result["rows"].as_array().expect("rows");
    let header = rows
        .iter()
        .find(|row| row["kind"] == "turnHeader")
        .expect("a turn header")
        .clone();
    let revision = reply.result["atRevision"].as_u64().expect("a revision");
    let epoch = reply.result["atLogEpoch"]
        .as_str()
        .expect("an epoch")
        .to_owned();
    (header, revision, epoch)
}

/// 失败的分支取错误（`Reply` 没有 Debug，不能用 `expect_err`）。
fn expect_error<T>(
    result: Result<T, nibi_kernel_protocol_core::rpc::RpcError>,
    what: &str,
) -> nibi_kernel_protocol_core::rpc::RpcError {
    match result {
        Ok(_) => panic!("{what}"),
        Err(error) => error,
    }
}

fn target_params(session: &str, header: &Value, revision: u64, epoch: &str) -> Value {
    json!({
        "sessionId": session,
        "target": {"rowId": header["rowId"], "entityId": header["entityId"]},
        "baseRevision": revision,
        "baseLogEpoch": epoch,
    })
}

/// 文件变更明细：轮头目标解析成这一轮的消息集，结果就是会话侧的汇总。
#[tokio::test]
async fn file_changes_answers_for_a_turn_header() {
    let server = server("sess_files");
    let (header, revision, epoch) = turn_header(&server, "sess_files").await;
    // 冷打开的摘要把撤销入口挂上了（set_file_summaries），这是 Host 的两道闸。
    assert_eq!(header["fileChanges"]["files"], 2);
    assert_eq!(header["actions"]["canRewindFiles"], true);
    let reply = Handler(server.clone())
        .request(
            "v4/conversation/fileChanges",
            target_params("sess_files", &header, revision, &epoch),
        )
        .await
        .expect("a report");
    assert_eq!(
        reply.result,
        json!({
            "files": 1,
            "additions": 5,
            "deletions": 1,
            "items": [{
                "path": "/work/a.txt",
                "additions": 5,
                "deletions": 1,
                "writeCount": 1,
                "toolNames": ["Edit"],
                "patches": [],
            }],
        })
    );
}

/// 回退预览：canApply 与三组文件的形状逐一对应 Host 的 schema。
#[tokio::test]
async fn file_rewind_preview_answers_for_a_turn_header() {
    let server = server("sess_preview");
    let (header, revision, epoch) = turn_header(&server, "sess_preview").await;
    let reply = Handler(server.clone())
        .request(
            "v4/conversation/fileRewindPreview",
            target_params("sess_preview", &header, revision, &epoch),
        )
        .await
        .expect("a preview");
    assert_eq!(
        reply.result,
        json!({
            "canApply": true,
            "safeFiles": [{
                "action": "restore",
                "operationCount": 1,
                "path": "/work/a.txt",
                "toolNames": ["Edit"],
            }],
            "unsafeFiles": [],
            "ignoredFiles": [],
        })
    );
}

/// 两道 CAS：revision 与 logEpoch 不符都拒绝（Host 的 `resolveQueryRowTarget` 同一对码）。
#[tokio::test]
async fn file_queries_reject_stale_bases() {
    let server = server("sess_stale");
    let (header, revision, epoch) = turn_header(&server, "sess_stale").await;
    let mut params = target_params("sess_stale", &header, revision, &epoch);
    params["baseRevision"] = json!(revision + 1);
    let error = expect_error(
        Handler(server.clone())
            .request("v4/conversation/fileChanges", params)
            .await,
        "a stale revision",
    );
    assert_eq!(error.message, "proto.staleRevision");
    let mut params = target_params("sess_stale", &header, revision, &epoch);
    params["baseLogEpoch"] = json!("another-epoch");
    let error = expect_error(
        Handler(server.clone())
            .request("v4/conversation/fileRewindPreview", params)
            .await,
        "a stale epoch",
    );
    assert_eq!(error.message, "proto.staleLogEpoch");
}

/// 目标不是轮头行（或 entity 换了）：`guard.actionUnavailable` / `proto.staleTarget`。
#[tokio::test]
async fn file_queries_only_accept_a_live_turn_header() {
    let server = server("sess_guard");
    let (_header, revision, epoch) = turn_header(&server, "sess_guard").await;
    let reply = Handler(server.clone())
        .request(
            "v4/conversation/rowsRange",
            json!({"sessionId": "sess_guard", "limit": 200}),
        )
        .await
        .expect("a page");
    let rows = reply.result["rows"].as_array().expect("rows");
    let user = rows
        .iter()
        .find(|row| row["kind"] == "userInput")
        .expect("a user row")
        .clone();
    let mut params = target_params("sess_guard", &user, revision, &epoch);
    let error = expect_error(
        Handler(server.clone())
            .request("v4/conversation/fileChanges", params.clone())
            .await,
        "a non-header row",
    );
    assert_eq!(error.message, "guard.actionUnavailable");
    // 同一个 rowId、换了 entityId：行已经动过。
    params["target"]["entityId"] = json!("someone-else");
    let error = expect_error(
        Handler(server.clone())
            .request("v4/conversation/fileRewindPreview", params)
            .await,
        "a moved row",
    );
    assert_eq!(error.message, "proto.staleTarget");
    // 「只有轮头可撤销」的两道闸：非轮头行也在 rewind 入口处被挡。
    let mut rewind = target_params("sess_guard", &user, revision, &epoch);
    rewind["target"]["entityId"] = json!(user["entityId"]);
    let error = expect_error(
        Handler(server)
            .request("v4/conversation/fileRewindPreview", rewind)
            .await,
        "a non-header rewind target",
    );
    assert_eq!(error.message, "guard.actionUnavailable");
}

/// 参数契约：未知键、缺 target、baseRevision 不是整数都是 `-32602`。
#[tokio::test]
async fn file_queries_validate_their_params() {
    let server = server("sess_bad_files");
    let (header, revision, epoch) = turn_header(&server, "sess_bad_files").await;
    let valid = target_params("sess_bad_files", &header, revision, &epoch);
    for params in [
        {
            let mut params = valid.clone();
            params["extra"] = json!(1);
            params
        },
        {
            let mut params = valid.clone();
            params.as_object_mut().unwrap().remove("target");
            params
        },
        {
            let mut params = valid.clone();
            params["target"] = json!({"rowId": 1});
            params
        },
        {
            let mut params = valid.clone();
            params["baseRevision"] = json!("7");
            params
        },
        {
            let mut params = valid.clone();
            params["baseLogEpoch"] = json!("");
            params
        },
    ] {
        let error = expect_error(
            Handler(server.clone())
                .request("v4/conversation/fileChanges", params.clone())
                .await,
            "invalid params",
        );
        assert_eq!(error.code, -32602, "{params}");
    }
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

/// `applyFileRewind` 的接线：轮头目标 → 这一轮的消息 → 预览 → `RestoreFiles`。ACK 是 Host 的
/// `{type, applied, preview, response}` 形状（此前这条命令回的是空 result，Host schema 解不出）。
#[tokio::test]
async fn apply_file_rewind_returns_the_host_result_shape() {
    let server = server("sess_apply");
    let (header, revision, epoch) = turn_header(&server, "sess_apply").await;
    let envelope = json!({
        "commandId": "c1",
        "clientId": "k",
        "sessionId": "sess_apply",
        "type": "applyFileRewind",
        "payload": {"target": {"rowId": header["rowId"], "entityId": header["entityId"]}},
        "baseRevision": revision,
        "baseLogEpoch": epoch,
        "issuedAt": 1,
    });
    let reply = Handler(server)
        .request("v4/command", envelope)
        .await
        .expect("an ack");
    assert_eq!(reply.result["status"], "accepted");
    let result = &reply.result["result"];
    assert_eq!(result["type"], "applyFileRewind");
    assert_eq!(result["applied"], true);
    assert_eq!(result["preview"]["canApply"], true);
    assert_eq!(
        result["response"],
        "Rewound 1 file from summary checkpoints."
    );
}

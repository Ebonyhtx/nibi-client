//! v4 查询面经 `Handler` 的真实分派（141 审计 §9 第 2 项）：参数契约（Host zod 的
//! `.strict()` 与区间钳制）、响应的键形状（含 `uri` 绝不外泄）、usage 快照的展示推导，
//! 以及产物字节的分块与 not found。
//!
//! 用最小 Kernel 替身：这一族的逻辑全在协议层（界、投影、拒绝姿态），存储的行为由
//! `node-store` 的 `run_queries_tests` / `usage_query_tests` 覆盖。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{Kernel, KernelError, SessionHandle};
use rust_cli_kernel_api::store::{SessionFilter, SessionSummary};
use rust_cli_kernel_api::usage::{
    AppUsage, AppUsageDayModelRow, AppUsageDayRow, AppUsageModelRow, AppUsageQuery,
    AppUsageToolRow, SessionUsage,
};
use rust_cli_kernel_api::workflow::{
    WorkflowRunArtifactDetail, WorkflowRunArtifactItem, WorkflowRunArtifactItemPage,
    WorkflowRunArtifactItemQuery, WorkflowRunArtifactVersion, WorkflowRunEventPage,
    WorkflowRunEventQuery, WorkflowRunEventRow, WorkflowRunNodeResult, WorkflowRunSummaryRow,
    WorkflowRunWorkspaceNode, WorkflowRunWorkspaceSummary,
};
use rust_cli_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

/// 固定时刻 + UTC+8 的注入时钟。
///
/// `kernel-api` 的 `FixedClock` 恒报 UTC，而这一族要断言「请求的 `range` 换成哪一段毫秒」
/// 与「按本地日归桶的偏移从哪来」，两者都取注入的 clock。所以这里自带一个：
/// `1760000000000` = 2025-10-09T08:53:20Z，本地（UTC+8）是同一天的 16:53。
struct ShanghaiClock;

impl rust_cli_kernel_api::clock::Clock for ShanghaiClock {
    fn now_ms(&self) -> u64 {
        NOW_MS
    }

    fn time_zone(&self) -> String {
        "Asia/Shanghai".to_owned()
    }

    fn utc_offset_minutes(&self, _at_ms: u64) -> i32 {
        480
    }
}

const NOW_MS: u64 = 1_760_000_000_000;

fn selection() -> ModelSelection {
    ModelSelection {
        provider: "p".to_owned(),
        model: "m".to_owned(),
        reasoning: None,
        connection: None,
    }
}

/// 记录到的查询入参（断言「协议层算出的界与时间窗」用）。
#[derive(Default)]
struct Seen {
    app_usage: Mutex<Vec<AppUsageQuery>>,
    events: Mutex<Vec<WorkflowRunEventQuery>>,
    artifact_items: Mutex<Vec<WorkflowRunArtifactItemQuery>>,
    summaries: Mutex<Vec<usize>>,
    artifact_reads: Mutex<Vec<(String, String, u64)>>,
    node_results: Mutex<Vec<(String, u64, u64)>>,
}

/// 替身 Kernel：所有 v4 读面都回一份固定数据（或按 `fail` 报错）。
#[derive(Default)]
struct FakeKernel {
    seen: Arc<Seen>,
    /// `usage` / `runs` 之外的一切都走这一条「不支持」的路径。
    unsupported: bool,
    /// 产物字节（`None` = 无此版本）。
    artifact_bytes: Option<Vec<u8>>,
    /// 节点正文（`None` = 无此节点）。
    node_result: Option<WorkflowRunNodeResult>,
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
        Err(KernelError::NotFound {
            session: SessionId::new("unused"),
        })
    }

    async fn workflow_run_summaries(
        &self,
        _session: &SessionId,
        limit: usize,
    ) -> Result<Vec<WorkflowRunSummaryRow>, KernelError> {
        self.seen.summaries.lock().unwrap().push(limit);
        if self.unsupported {
            return Err(KernelError::Unsupported {
                what: "runs".to_owned(),
            });
        }
        Ok(vec![
            WorkflowRunSummaryRow {
                run_id: "run_a".to_owned(),
                tool_call_id: Some("tool_a".to_owned()),
                label: "alpha".to_owned(),
                updated_at: Some(500),
                status: "stopped".to_owned(),
                stop_reason: Some("user".to_owned()),
                resumed_from: None,
                superseded_by: None,
                failure_code: None,
                failure_message: None,
                resumable: true,
            },
            WorkflowRunSummaryRow {
                run_id: "run_b".to_owned(),
                tool_call_id: None,
                label: "beta".to_owned(),
                updated_at: None,
                status: "errored".to_owned(),
                stop_reason: None,
                resumed_from: Some("run_a".to_owned()),
                superseded_by: None,
                failure_code: Some("ProviderStop".to_owned()),
                failure_message: Some("boom".to_owned()),
                resumable: false,
            },
        ])
    }

    async fn workflow_run_events(
        &self,
        _session: &SessionId,
        _run_id: &str,
        query: WorkflowRunEventQuery,
    ) -> Result<WorkflowRunEventPage, KernelError> {
        self.seen.events.lock().unwrap().push(query);
        Ok(WorkflowRunEventPage {
            events: vec![
                WorkflowRunEventRow {
                    sequence: 3,
                    r#type: "log".to_owned(),
                    payload: json!({"message": "hi"}),
                    truncated: false,
                },
                WorkflowRunEventRow {
                    sequence: 4,
                    r#type: "actor-created".to_owned(),
                    payload: json!({"persona": {"system": "x"}}),
                    truncated: true,
                },
            ],
            has_more: true,
        })
    }

    async fn workflow_run_artifacts(
        &self,
        _session: &SessionId,
        _run_id: &str,
    ) -> Result<Option<Vec<WorkflowRunArtifactDetail>>, KernelError> {
        Ok(Some(vec![WorkflowRunArtifactDetail {
            id: "doc".to_owned(),
            kind: "markdown".to_owned(),
            title: Some("Doc".to_owned()),
            description: Some("desc".to_owned()),
            content_type: Some("text/markdown".to_owned()),
            source_path: Some("out/doc.md".to_owned()),
            spec: None,
            version: 2,
            versions: vec![
                WorkflowRunArtifactVersion {
                    version: 1,
                    title: None,
                    description: None,
                    content_type: Some("text/markdown".to_owned()),
                    bytes: Some(5),
                    uri: Some("zcode-artifact://sess_1/doc-1".to_owned()),
                    source_path: None,
                    spec: None,
                    published_at: 1_000,
                    primary: None,
                },
                WorkflowRunArtifactVersion {
                    version: 2,
                    title: Some("Doc".to_owned()),
                    description: None,
                    content_type: Some("text/markdown".to_owned()),
                    bytes: Some(9),
                    uri: Some("zcode-artifact://sess_1/doc-2".to_owned()),
                    source_path: Some("out/doc.md".to_owned()),
                    spec: None,
                    published_at: 1_002,
                    primary: Some(true),
                },
            ],
            item_count: 0,
            primary: Some(true),
        }]))
    }

    async fn workflow_run_artifact_items(
        &self,
        _session: &SessionId,
        _run_id: &str,
        query: WorkflowRunArtifactItemQuery,
    ) -> Result<WorkflowRunArtifactItemPage, KernelError> {
        self.seen.artifact_items.lock().unwrap().push(query);
        Ok(WorkflowRunArtifactItemPage {
            items: vec![WorkflowRunArtifactItem {
                sequence: 9,
                site_id: "report#1".to_owned(),
                ordinal: 2,
                item: Some(json!({"x": 1})),
                fields: None,
            }],
            has_more: false,
        })
    }

    async fn workflow_run_artifact_bytes(
        &self,
        _session: &SessionId,
        _run_id: &str,
        artifact_id: &str,
        version: u64,
    ) -> Result<Option<(Vec<u8>, Option<String>)>, KernelError> {
        self.seen.artifact_reads.lock().unwrap().push((
            artifact_id.to_owned(),
            String::new(),
            version,
        ));
        Ok(self
            .artifact_bytes
            .as_ref()
            .map(|bytes| (bytes.clone(), Some("text/markdown".to_owned()))))
    }

    async fn workflow_run_workspace(
        &self,
        _session: &SessionId,
        _run_id: &str,
    ) -> Result<Option<Vec<WorkflowRunWorkspaceNode>>, KernelError> {
        Ok(Some(vec![WorkflowRunWorkspaceNode {
            site_id: "world.run#1".to_owned(),
            ordinal: 0,
            kind: "world-run".to_owned(),
            op: Some("world.run".to_owned()),
            args: Some(vec![json!("ls")]),
            input_truncated: None,
            status: "completed".to_owned(),
            error: None,
            summary: Some(WorkflowRunWorkspaceSummary {
                result_bytes: 20,
                result_count: None,
                exit_code: Some(0),
                stdout_bytes: Some(4),
                stderr_bytes: None,
            }),
            created_at: 100,
            updated_at: 101,
        }]))
    }

    async fn workflow_run_node_result(
        &self,
        _session: &SessionId,
        _run_id: &str,
        site_id: &str,
        ordinal: u64,
        max_bytes: u64,
    ) -> Result<Option<WorkflowRunNodeResult>, KernelError> {
        self.seen
            .node_results
            .lock()
            .unwrap()
            .push((site_id.to_owned(), ordinal, max_bytes));
        Ok(self.node_result.clone())
    }

    async fn app_usage(&self, query: AppUsageQuery) -> Result<AppUsage, KernelError> {
        self.seen.app_usage.lock().unwrap().push(query);
        if self.unsupported {
            return Err(KernelError::Unsupported {
                what: "app usage".to_owned(),
            });
        }
        Ok(AppUsage {
            total_tokens: 300,
            input_tokens: 200,
            output_tokens: 60,
            reasoning_tokens: 10,
            cache_creation_tokens: 20,
            cache_read_tokens: 100,
            model_request_count: 3,
            model_error_count: 1,
            avg_time_to_first_token_ms: Some(120.0),
            total_sessions: 2,
            total_turns: 4,
            avg_turn_duration_ms: Some(900.0),
            longest_session_ms: 5_000,
            tool_call_count: 6,
            tool_error_count: 1,
            models: vec![AppUsageModelRow {
                model_id: Some("opus".to_owned()),
                total_tokens: 300,
                input_tokens: 200,
                output_tokens: 60,
                request_count: 3,
            }],
            tools: vec![AppUsageToolRow {
                tool_name: "read".to_owned(),
                call_count: 6,
                error_count: 1,
                avg_duration_ms: Some(30.0),
            }],
            days: vec![
                // 夹具的两天必须落在请求的时间窗里：固定时钟的本地日索引是 20_370
                // （2025-10-09T16:53 +08:00），所以「昨天 + 今天」= 20_369 / 20_370。
                AppUsageDayRow {
                    day_index: 20_369,
                    total_tokens: 100,
                    turn_count: 1,
                    tool_call_count: 2,
                },
                AppUsageDayRow {
                    day_index: 20_370,
                    total_tokens: 200,
                    turn_count: 3,
                    tool_call_count: 4,
                },
            ],
            day_models: vec![AppUsageDayModelRow {
                day_index: 20_370,
                model_id: Some("opus".to_owned()),
                total_tokens: 200,
            }],
        })
    }

    async fn session_usage(&self, session: &SessionId) -> Result<SessionUsage, KernelError> {
        if session.as_str() == "sess_missing" {
            return Err(KernelError::NotFound {
                session: session.clone(),
            });
        }
        let mut usage = SessionUsage {
            total_tokens: 120,
            input_tokens: 100,
            output_tokens: 20,
            reasoning_tokens: 4,
            cache_creation_tokens: 5,
            cache_read_tokens: 50,
            model_request_count: 2,
            model_error_count: 0,
            ..Default::default()
        };
        usage
            .input_baseline_by_source
            .insert("main_turn".to_owned(), 100);
        Ok(usage)
    }
}

fn server(kernel: Arc<FakeKernel>) -> Arc<Server> {
    let scope = TaskScope::root("v4-queries-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    // 固定时钟：`now = 1_760_000_000_000`（2025-10-09T08:53:20Z），偏移 +480 分钟（UTC+8）。
    let clock: Arc<dyn rust_cli_kernel_api::clock::Clock> = Arc::new(ShanghaiClock);
    let context = Arc::new(Context::new(peer, clock));
    Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ))
}

/// `Reply` 没有 `Debug`（它是 Host 线上的那一帧），`unwrap_err` 用不了；这里手动取错误。
async fn request_error(
    server: Arc<Server>,
    method: &str,
    params: Value,
) -> rust_cli_protocol_core::rpc::RpcError {
    match Handler(server).request(method, params).await {
        Ok(_) => panic!("expected {method} to fail"),
        Err(error) => error,
    }
}

fn fake() -> (Arc<Server>, Arc<Seen>) {
    let kernel = Arc::new(FakeKernel::default());
    let seen = kernel.seen.clone();
    (server(kernel), seen)
}

fn fake_with(kernel: FakeKernel) -> (Arc<Server>, Arc<Seen>) {
    let seen = kernel.seen.clone();
    (server(Arc::new(kernel)), seen)
}

// ———— 能力探测（141 审计 F1 / F2）————

/// `runtime/capabilities` 按**真实能力**回报。
///
/// 两个 true 位各有一条消费方依赖它：
/// - `independentPlanState`：Host 的 `ensureIndependentPlanSupport` 在 false 时**抛错**
///   （`proto.independentPlanUnsupported`），所以恒 false 会让桌面任何带 plan 的命令在本地就被拒。
///   内核确实有 plan 模式（EnterPlanMode / ExitPlanMode 工具、`Command::SetPlan`、`planEnabled` 映射）。
/// - `historyFirst`：Host 据此选「先在 Host 读历史再起 runtime」的冷打开路径。Rust 内核的
///   `session_snapshot` 本身就是存储直读、`Live::new` 从 `SessionView` 建冷投影，历史恒为第一手。
#[tokio::test]
async fn capabilities_report_the_real_kernel_surface() {
    let (server, _seen) = fake();
    let reply = Handler(server)
        .request("runtime/capabilities", Value::Null)
        .await
        .unwrap();
    assert_eq!(reply.result["independentPlanState"], true);
    assert_eq!(reply.result["historyFirst"], true);
    // 内核没有这两个能力面（Host 侧也没有消费方）：如实回 false。
    assert_eq!(reply.result["sessionDirectorySource"], false);
    assert_eq!(reply.result["genUiContext"], false);
}

/// `workspace/updateDynamicWorkflowPolicy` 的回执按实况回 `enabled: true`。
///
/// 动态工作流已全链实现（34 个 CommandType 含 3 个工作流命令 + 8 个中枢方法 + 引擎 sidecar）。
/// Host 只验 schema 不消费这个值，所以这不是行为开关——它是「这条注释与这个默认值是否还成立」
/// 的问题（141 审计 F1：恒 false 是「动态工作流不移植」时代的残桩）。
#[tokio::test]
async fn the_dynamic_workflow_policy_reply_reflects_the_implemented_engine() {
    let (server, _seen) = fake();
    let reply = Handler(server)
        .request(
            "workspace/updateDynamicWorkflowPolicy",
            json!({"workspace": {"workspacePath": "/w", "workspaceKey": "k"}, "enabled": true}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["enabled"], true);
    assert_eq!(reply.result["workspace"]["workspacePath"], "/w");
}

// ———— 参数契约 ————

#[tokio::test]
async fn unknown_keys_are_rejected_like_the_host_zod_schema() {
    let (server, _seen) = fake();
    let error = request_error(
        server,
        "v4/conversation/workflowRuns",
        json!({"sessionId": "sess_1", "bogus": 1}),
    )
    .await;
    // `.strict()`：未知键 → -32602，message 与 Host 的 zod 同前缀。
    assert_eq!(error.code, -32602);
    assert!(
        error.message.contains("Unrecognized key `bogus`"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn run_list_limits_are_clamped_by_the_request_contract() {
    let (server, seen) = fake();
    // 缺省 16（Node `DEFAULT_LIST_RUNS_LIMIT`）。
    Handler(server.clone())
        .request(
            "v4/conversation/workflowRuns",
            json!({"sessionId": "sess_1"}),
        )
        .await
        .unwrap();
    assert_eq!(*seen.summaries.lock().unwrap().last().unwrap(), 16);

    Handler(server.clone())
        .request(
            "v4/conversation/workflowRuns",
            json!({"sessionId": "sess_1", "limit": 64}),
        )
        .await
        .unwrap();
    assert_eq!(*seen.summaries.lock().unwrap().last().unwrap(), 64);

    // 超过 64 被协议拒（不是静默钳到 64）。
    let error = request_error(
        server,
        "v4/conversation/workflowRuns",
        json!({"sessionId": "sess_1", "limit": 65}),
    )
    .await;
    assert_eq!(error.code, -32602);
}

#[tokio::test]
async fn event_pages_use_the_protocol_byte_ceiling() {
    let (server, seen) = fake();
    Handler(server)
        .request(
            "v4/conversation/workflowRunEvents",
            json!({"sessionId": "sess_1", "runId": "run_a", "limit": 3, "afterSequence": 7}),
        )
        .await
        .unwrap();
    let query = *seen.events.lock().unwrap().last().unwrap();
    assert_eq!(query.limit, 3);
    assert_eq!(query.after_sequence, Some(7));
    // 字节恒为协议上限（16 MiB 的四分之一），renderer 没有这个键。
    assert_eq!(query.max_bytes, 4 * 1024 * 1024);
}

#[tokio::test]
async fn artifact_item_limits_default_and_clamp_in_the_protocol_layer() {
    let (server, seen) = fake();
    Handler(server.clone())
        .request(
            "v4/conversation/workflowRunArtifactData",
            json!({"sessionId": "sess_1", "runId": "run_a", "artifactId": "board"}),
        )
        .await
        .unwrap();
    let query = seen.artifact_items.lock().unwrap().last().unwrap().clone();
    assert_eq!(query.limit, 200, "缺省 200");
    assert_eq!(query.max_bytes, 4 * 1024 * 1024);
    assert_eq!(query.max_field_value_bytes, 4_096);
    assert!(query.fields.is_none());

    Handler(server.clone())
        .request(
            "v4/conversation/workflowRunArtifactData",
            json!({
                "sessionId": "sess_1", "runId": "run_a", "artifactId": "board",
                "limit": 500, "fields": ["timing.after"]
            }),
        )
        .await
        .unwrap();
    let query = seen.artifact_items.lock().unwrap().last().unwrap().clone();
    assert_eq!(query.limit, 500);
    assert_eq!(
        query.fields.as_deref(),
        Some(&["timing.after".to_owned()][..])
    );

    // 501 条被拒（协议上限），不是静默钳。
    let error = request_error(
        server,
        "v4/conversation/workflowRunArtifactData",
        json!({"sessionId": "sess_1", "runId": "run_a", "artifactId": "board", "limit": 501}),
    )
    .await;
    assert_eq!(error.code, -32602);
}

// ———— 响应形状 ————

#[tokio::test]
async fn run_summaries_report_lineage_failure_and_resumable() {
    let (server, _seen) = fake();
    let reply = Handler(server)
        .request(
            "v4/conversation/workflowRuns",
            json!({"sessionId": "sess_1"}),
        )
        .await
        .unwrap();
    let runs = reply.result["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0]["runId"], "run_a");
    assert_eq!(runs[0]["label"], "alpha");
    assert_eq!(runs[0]["status"], "stopped");
    assert_eq!(runs[0]["stopReason"], "user");
    assert_eq!(runs[0]["resumable"], true);
    assert_eq!(runs[0]["updatedAt"], 500);
    // 缺席的键整键不出（不是 null）——schema 的 optional 语义。
    assert!(runs[0].get("failureCode").is_none());
    assert_eq!(runs[1]["resumedFrom"], "run_a");
    assert_eq!(runs[1]["failureCode"], "ProviderStop");
    assert_eq!(runs[1]["resumable"], false);
    assert!(runs[1].get("updatedAt").is_none());
}

#[tokio::test]
async fn event_rows_only_carry_truncated_when_it_happened() {
    let (server, _seen) = fake();
    let reply = Handler(server)
        .request(
            "v4/conversation/workflowRunEvents",
            json!({"sessionId": "sess_1", "runId": "run_a"}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["hasMore"], true);
    let events = reply.result["events"].as_array().unwrap();
    assert_eq!(events[0]["sequence"], 3);
    assert_eq!(events[0]["type"], "log");
    assert_eq!(events[0]["payload"]["message"], "hi");
    assert!(events[0].get("truncated").is_none(), "false 时不发这个键");
    assert_eq!(events[1]["truncated"], true);
}

#[tokio::test]
async fn artifact_lists_never_leak_the_store_uri() {
    let (server, _seen) = fake();
    let reply = Handler(server)
        .request(
            "v4/conversation/workflowRunArtifacts",
            json!({"sessionId": "sess_1", "runId": "run_a"}),
        )
        .await
        .unwrap();
    let artifact = &reply.result["artifacts"][0];
    assert_eq!(artifact["id"], "doc");
    assert_eq!(artifact["version"], 2);
    assert_eq!(artifact["itemCount"], 0);
    assert_eq!(artifact["primary"], true);
    assert_eq!(artifact["versions"].as_array().unwrap().len(), 2);
    assert_eq!(artifact["versions"][0]["publishedAt"], 1_000);
    // `uri` 是 store 的内部地址：模型与 renderer 都读不了它，协议层必须剥掉。
    assert!(artifact["versions"][0].get("uri").is_none());
    assert!(artifact.get("uri").is_none());
}

#[tokio::test]
async fn unknown_runs_get_empty_lists_rather_than_errors() {
    // 一个空 Kernel 替身：所有读面都回缺省（空）。与 Node 的「未知 runId 回空清单」同规。
    struct Empty;
    #[async_trait]
    impl Kernel for Empty {
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
            Err(KernelError::NotFound {
                session: SessionId::new("unused"),
            })
        }
    }
    let scope = TaskScope::root("v4-queries-empty", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(
        peer,
        Arc::new(rust_cli_kernel_api::testing::FixedClock(5)),
    ));
    let server = Arc::new(Server::new(
        context,
        Arc::new(Empty),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));
    let reply = Handler(server.clone())
        .request(
            "v4/conversation/workflowRunArtifacts",
            json!({"sessionId": "sess_1", "runId": "run_gone"}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["artifacts"], json!([]));
    let reply = Handler(server)
        .request(
            "v4/conversation/workflowRunWorkspace",
            json!({"sessionId": "sess_1", "runId": "run_gone"}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["nodes"], json!([]));
    assert!(reply.result.get("truncated").is_none());
}

// ———— 产物字节 ————

#[tokio::test]
async fn artifact_reads_chunk_and_stop_at_the_tail() {
    let bytes = b"hello world".to_vec();
    let (server, seen) = fake_with(FakeKernel {
        artifact_bytes: Some(bytes),
        ..Default::default()
    });
    let reply = Handler(server.clone())
        .request(
            "v4/conversation/workflowRunArtifactRead",
            json!({
                "sessionId": "sess_1", "runId": "run_a", "artifactId": "doc",
                "version": 1, "offset": 0, "limit": 5
            }),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["dataBase64"], "aGVsbG8=");
    assert_eq!(reply.result["mediaType"], "text/markdown");
    assert_eq!(reply.result["totalBytes"], 11);
    assert_eq!(reply.result["nextOffset"], 5);

    // 第二块读到尾：nextOffset 是 null。
    let reply = Handler(server.clone())
        .request(
            "v4/conversation/workflowRunArtifactRead",
            json!({
                "sessionId": "sess_1", "runId": "run_a", "artifactId": "doc",
                "version": 1, "offset": 5, "limit": 100
            }),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["dataBase64"], "IHdvcmxk");
    assert_eq!(reply.result["nextOffset"], Value::Null);

    // offset 越界不是错误：空块 + null（与读到尾同一形态）。
    let reply = Handler(server)
        .request(
            "v4/conversation/workflowRunArtifactRead",
            json!({
                "sessionId": "sess_1", "runId": "run_a", "artifactId": "doc",
                "version": 1, "offset": 99, "limit": 10
            }),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["dataBase64"], "");
    assert_eq!(reply.result["nextOffset"], Value::Null);
    assert_eq!(seen.artifact_reads.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn missing_artifact_versions_are_a_structured_not_found() {
    // `artifact_bytes: None` = 无此版本 / 不是你的 run / 是看板。
    let (server, _seen) = fake_with(FakeKernel {
        artifact_bytes: None,
        ..Default::default()
    });
    let error = request_error(
        server,
        "v4/conversation/workflowRunArtifactRead",
        json!({
            "sessionId": "sess_1", "runId": "run_a", "artifactId": "doc",
            "version": 2, "offset": 0, "limit": 10
        }),
    )
    .await;
    assert!(
        error
            .message
            .contains("fault.workflowRunArtifactRead.notFound: run_a/doc@2"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn artifact_read_limit_cannot_exceed_one_chunk() {
    let (server, _seen) = fake();
    let error = request_error(
        server,
        "v4/conversation/workflowRunArtifactRead",
        json!({
            "sessionId": "sess_1", "runId": "run_a", "artifactId": "doc",
            "version": 1, "offset": 0, "limit": 512 * 1024 + 1
        }),
    )
    .await;
    assert_eq!(error.code, -32602, "renderer 不能放宽分块上界");
}

// ———— 工作区 ————

#[tokio::test]
async fn workspace_nodes_keep_the_summary_but_not_the_body() {
    let (server, _seen) = fake();
    let reply = Handler(server)
        .request(
            "v4/conversation/workflowRunWorkspace",
            json!({"sessionId": "sess_1", "runId": "run_a"}),
        )
        .await
        .unwrap();
    let node = &reply.result["nodes"][0];
    assert_eq!(node["siteId"], "world.run#1");
    assert_eq!(node["kind"], "world-run");
    assert_eq!(node["op"], "world.run");
    assert_eq!(node["args"], json!(["ls"]));
    assert_eq!(node["summary"]["exitCode"], 0);
    assert_eq!(node["summary"]["stdoutBytes"], 4);
    assert!(node.get("result").is_none(), "清单绝不含正文");
}

#[tokio::test]
async fn node_result_max_bytes_defaults_to_the_protocol_ceiling() {
    let (server, seen) = fake_with(FakeKernel {
        node_result: Some(WorkflowRunNodeResult {
            status: "completed".to_owned(),
            result: Some(json!("body")),
            error: None,
            truncated: false,
            total_bytes: 6,
        }),
        ..Default::default()
    });
    let reply = Handler(server.clone())
        .request(
            "v4/conversation/workflowRunNodeResult",
            json!({"sessionId": "sess_1", "runId": "run_a", "siteId": "files.read#1", "ordinal": 2}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result["result"], "body");
    assert_eq!(reply.result["status"], "completed");
    assert_eq!(reply.result["truncated"], false);
    assert_eq!(reply.result["totalBytes"], 6);
    assert_eq!(
        seen.node_results.lock().unwrap().last().unwrap().2,
        32 * 1024,
        "缺省 resultMaxBytes"
    );

    // 超过上限被拒（renderer 只能钳小）。
    let error = request_error(
        server,
        "v4/conversation/workflowRunNodeResult",
        json!({
            "sessionId": "sess_1", "runId": "run_a", "siteId": "files.read#1",
            "ordinal": 2, "maxBytes": 32 * 1024 + 1
        }),
    )
    .await;
    assert_eq!(error.code, -32602);
}

#[tokio::test]
async fn missing_workspace_nodes_are_a_structured_not_found() {
    // `node_result: None` = 无此节点 / 不是你的 run / 不是 world 行。
    let (server, _seen) = fake_with(FakeKernel::default());
    let error = request_error(
        server,
        "v4/conversation/workflowRunNodeResult",
        json!({"sessionId": "sess_1", "runId": "run_a", "siteId": "agent#1", "ordinal": 0}),
    )
    .await;
    assert!(
        error
            .message
            .contains("fault.workflowRunNodeResult.notFound: run_a/agent#1@0"),
        "{}",
        error.message
    );
}

// ———— usage ————

#[tokio::test]
async fn usage_stats_project_the_snapshot_with_streaks_and_heatmap() {
    let (server, seen) = fake();
    let reply = Handler(server)
        .request("v4/usage/stats", json!({"range": "7d"}))
        .await
        .unwrap();
    let query = *seen.app_usage.lock().unwrap().last().unwrap();
    // 7 天窗口：until = 固定时钟，since = until − 7 天；偏移取自 clock（+480 分钟）。
    assert_eq!(query.until_ms, NOW_MS);
    assert_eq!(query.since_ms, NOW_MS - 7 * 86_400_000);
    assert_eq!(query.tz_offset_ms, 480 * 60_000);

    let snapshot = &reply.result;
    assert_eq!(snapshot["range"], "7d");
    assert_eq!(snapshot["source"], "agent-db");
    assert_eq!(snapshot["timeZone"], "Asia/Shanghai");
    assert_eq!(snapshot["generatedAt"], NOW_MS);
    let summary = &snapshot["summary"];
    assert_eq!(summary["totalTokens"], 300);
    // 命中率的分母是 inputTokens（已是总输入）：100 / 200。
    assert_eq!(summary["cacheHitRate"], 0.5);
    assert_eq!(summary["toolErrorRate"], 1.0 / 6.0);
    assert_eq!(summary["modelErrorRate"], 1.0 / 3.0);
    assert_eq!(summary["peakDayTokens"], 200);
    assert_eq!(summary["favoriteModel"]["modelId"], "opus");
    assert_eq!(summary["favoriteModel"]["share"], 1.0);
    // 昨天与今天都有 token、前天没有 → 当前连续 2 天，最长也是 2 天。
    assert_eq!(summary["activeDays"], 2);
    assert_eq!(summary["currentStreakDays"], 2);
    assert_eq!(summary["longestStreakDays"], 2);
    assert_eq!(snapshot["heatmap"]["endDate"], "2025-10-09");
    assert_eq!(snapshot["heatmap"]["maxTokens"], 200);
    assert_eq!(snapshot["models"][0]["share"], 1.0);
    assert_eq!(snapshot["tools"][0]["errorRate"], 1.0 / 6.0);
}

#[tokio::test]
async fn usage_stats_all_range_starts_at_zero_and_echoes_the_clock_zone() {
    let (server, seen) = fake();
    Handler(server)
        .request(
            "v4/usage/stats",
            json!({"range": "all", "timeZone": "Europe/Berlin"}),
        )
        .await
        .unwrap();
    let query = *seen.app_usage.lock().unwrap().last().unwrap();
    // `all` 传 since = 0（Node 同规），不是「从今天往前 N 天」。
    assert_eq!(query.since_ms, 0);
}

#[tokio::test]
async fn usage_stats_falls_back_to_an_empty_snapshot_when_the_store_says_unsupported() {
    let (server, _seen) = fake_with(FakeKernel {
        unsupported: true,
        ..Default::default()
    });
    let reply = Handler(server)
        .request("v4/usage/stats", json!({"range": "30d"}))
        .await
        .unwrap();
    // 空态而不是错误：没有 usage 的入口要能显示空白用量页。
    assert_eq!(reply.result["summary"]["totalTokens"], 0);
    assert_eq!(reply.result["models"], json!([]));
    assert_eq!(reply.result["source"], "agent-db");
}

#[tokio::test]
async fn usage_range_must_be_one_of_the_three_literals() {
    let (server, _seen) = fake();
    let error = request_error(server, "v4/usage/stats", json!({"range": "90d"})).await;
    assert_eq!(error.code, -32602);
}

#[tokio::test]
async fn conversation_usage_projects_the_task_token_shape() {
    let (server, _seen) = fake();
    let reply = Handler(server)
        .request("v4/conversation/usage", json!({"sessionId": "sess_1"}))
        .await
        .unwrap();
    assert_eq!(reply.result["sessionId"], "sess_1");
    assert_eq!(reply.result["totalTokens"], 120);
    assert_eq!(reply.result["inputBaselineBySource"]["main_turn"], 100);
}

#[tokio::test]
async fn conversation_usage_reports_session_unavailable_for_unknown_sessions() {
    let (server, _seen) = fake();
    let error = request_error(
        server,
        "v4/conversation/usage",
        json!({"sessionId": "sess_missing"}),
    )
    .await;
    // 会话不存在与其它会话方法同一条错误码（`sessionUnavailable`），Host 据此换会话。
    assert_eq!(error.code, -32004);
}

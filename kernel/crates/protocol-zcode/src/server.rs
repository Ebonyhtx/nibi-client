//! App 协议的方法表（docs/specs/rust-cli/app-protocol.md §3.4、§10.3）：P1 的方法；其余回 `-32601`。
//! 命令在 [`crate::commands`]，订阅在 [`crate::subscribe`]。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{Kernel, KernelError};
use rust_cli_protocol_core::connection::{Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use rust_cli_protocol_core::sessions::{Bridged, SessionBridge};
use serde_json::{Value, json};

use crate::context::Context;
use crate::inbound::Inbound;
use crate::inbox::Remembered;
use crate::index::Topics;
use crate::live::Live;
use crate::projection::state::Followup;

/// 会话不可用（`zcodeProtocolErrorCodes.sessionUnavailable`）。
pub const SESSION_UNAVAILABLE: i64 = -32004;

/// 新会话的缺省（入口给出）。
#[derive(Debug, Clone)]
pub struct Defaults {
    pub selection: ModelSelection,
    pub mode: PermissionMode,
    pub environment: EnvironmentId,
}

/// 工作区级的开关（Host 推来的偏好；P1 只保存与回声）。
#[derive(Debug, Clone, Default)]
struct Preferences {
    ask_auto_resolution: bool,
    full_retention: bool,
}

pub struct Server {
    pub(crate) context: Arc<Context>,
    pub(crate) kernel: Arc<dyn Kernel>,
    pub(crate) bridge: SessionBridge<Live>,
    pub(crate) topics: Arc<Topics>,
    pub(crate) remembered: Mutex<Remembered>,
    pub(crate) followups: Mutex<HashMap<SessionId, Followup>>,
    /// 工作区钩子评审的当前 flow（每个会话一份；generation 单调，见 [`crate::hook_review`]）。
    pub(crate) hook_reviews: Mutex<HashMap<SessionId, crate::hook_review::Flow>>,
    /// 已经上报过提示条的会话（第一次打开时算一次，之后由评审 / 授权 / 撤销刷新）。
    hook_admissions: Mutex<HashSet<SessionId>>,
    /// 评审截止的计时任务挂在它上面（任务跟着进程的作用域走）。
    pub(crate) spawner: rust_cli_base::Spawner,
    pub(crate) defaults: Defaults,
    /// 本进程的实例标识（时钟探测的 `clock.instanceId`）。
    pub(crate) instance: String,
    /// 首 token 时延观察（`v4/telemetry/local-ttft`，141 审计 §9 第 5 项余项）。
    pub(crate) local_ttft: Arc<crate::local_ttft::LocalTtftRecorder>,
    /// 附件事务的暂存表（`v4/attachment/begin|chunk|commit|abort`，见 [`crate::attachment_upload`]）。
    pub(crate) uploads: crate::attachment_upload::Registry,
    /// 网络捕获的开关与攒批（`process/networkCapture` → `process/networkRequests`，141 审计 §9 F3）。
    pub(crate) capture: Arc<crate::telemetry::Capture>,
    preferences: Mutex<Preferences>,
}

pub(crate) fn kernel_error(error: &KernelError) -> RpcError {
    match error {
        KernelError::NotFound { session } => RpcError::new(
            SESSION_UNAVAILABLE,
            format!("Session unavailable: {}", session.as_str()),
        ),
        other => RpcError::internal(other.to_string()),
    }
}

impl Server {
    /// `capture` 是网络捕获的运行时：入口要先把它的观察者装到 `Egress` 上，所以由调用方建好传进来
    /// （`None` 时自建一份——观察者没装，捕获就只会空转）。
    pub fn new(
        context: Arc<Context>,
        kernel: Arc<dyn Kernel>,
        spawner: rust_cli_base::Spawner,
        defaults: Defaults,
        capture: Option<Arc<crate::telemetry::Capture>>,
    ) -> Self {
        let topics = Arc::new(Topics::new(context.clone(), &spawner));
        let capture = capture
            .unwrap_or_else(|| crate::telemetry::Capture::new(context.clone(), &spawner));
        let instance = context.fresh("instance");
        Self {
            local_ttft: Arc::new(crate::local_ttft::LocalTtftRecorder::new(instance.clone())),
            instance,
            bridge: SessionBridge::new(
                kernel.clone(),
                spawner.clone(),
                std::time::Duration::from_millis(30),
            ),
            context,
            kernel,
            topics,
            remembered: Mutex::new(Remembered::default()),
            followups: Mutex::new(HashMap::new()),
            hook_reviews: Mutex::new(HashMap::new()),
            hook_admissions: Mutex::new(HashSet::new()),
            spawner,
            defaults,
            uploads: crate::attachment_upload::Registry::default(),
            capture,
            preferences: Mutex::new(Preferences::default()),
        }
    }

    pub(crate) fn workspace(&self, path: &str) -> WorkspaceRef {
        WorkspaceRef {
            environment: self.defaults.environment.clone(),
            root: EnvPath::new(path),
        }
    }

    /// 打开会话并接上投影（已经打开时直接给出）。
    pub(crate) async fn live(
        &self,
        session: &SessionId,
    ) -> Result<Arc<Bridged<Live>>, KernelError> {
        let followup = self
            .followups
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .copied()
            .unwrap_or(Followup::Queue);
        let (context, topics) = (self.context.clone(), self.topics.clone());
        let local_ttft = self.local_ttft.clone();
        let live = self
            .bridge
            .open(session, move |_, view| {
                Live::new(context, topics, view, followup, local_ttft)
            })
            .await?;
        // 冷打开的每轮文件摘要（轮头角标与撤销入口）：读不出 artifact 只少一个角标，不拦打开。
        // 只挂一次；之后的写入走 `FileChanges` 事件。先看旗标，别让每条命令都重读一遍 artifact。
        if live.sink.needs_file_summaries() {
            match live.handle.file_change_summaries().await {
                Ok(summaries) => live.sink.set_file_summaries(&summaries).await,
                Err(error) => tracing::debug!(%error, "file change summaries are unavailable"),
            }
        }
        // 会话第一次打开：按当前快照上报工作区钩子的提示条（Node 在 activate 时上报 admission）。
        self.announce_hook_admission(session, live.sink.clone()).await;
        Ok(live)
    }

    /// 提示条只算一次；评审 / 授权 / 撤销由命令处理刷新。
    async fn announce_hook_admission(&self, session: &SessionId, live: Arc<Live>) {
        let first = self
            .hook_admissions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.clone());
        if first {
            crate::hook_review::refresh_session_admission(self, &live).await;
        }
    }

    fn preferences(&self) -> std::sync::MutexGuard<'_, Preferences> {
        self.preferences
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    async fn read_presentation(&self, params: &Value) -> Value {
        let workspace = params["workspace"].clone();
        let path = workspace["workspacePath"].as_str().unwrap_or_default();
        let commands: Vec<Value> = self
            .kernel
            .user_commands(&self.workspace(path))
            .await
            .into_iter()
            .filter(|command| !command.hidden && !command.name.is_empty())
            .map(|command| {
                let mut value = json!({"name": command.name, "description": command.description,
                    "source": "custom"});
                if let Some(hint) = command.argument_hint {
                    value["inputHint"] = json!(hint);
                }
                value
            })
            .collect();
        json!({"workspace": workspace, "mode": self.defaults.mode.node_name(),
            "slashCommands": commands})
    }

    async fn close_session(&self, params: &Value) -> Value {
        let session = SessionId::new(params["sessionId"].as_str().unwrap_or_default());
        self.bridge.close(&session);
        self.hook_admissions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&session);
        self.hook_reviews
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&session);
        // 附件事务的暂存按会话隔离（Host `clearSession`）。
        self.uploads
            .with(|table| table.clear_session(session.as_str()));
        json!({"closed": true})
    }

    async fn dispatch(&self, method: &str, params: Value) -> Result<Reply, RpcError> {
        let reply = |value: Value| Ok(Reply::new(value));
        match method {
            // 能力探测（141 审计 F2）：按**真实能力**回报，恒 false 会让 Host 静默走降级路径。
            //
            // - `independentPlanState`：内核有完整的 plan 模式——`EnterPlanMode` / `ExitPlanMode`
            //   工具（`tools/src/plan_mode.rs`）、`Command::SetPlan`、createSession/sendText 的
            //   `planEnabled` 映射。Host 的 `ensureIndependentPlanSupport` 在 false 时**抛错**
            //   （`proto.independentPlanUnsupported`），所以这条只能是 true，否则桌面一发带 plan 的
            //   命令就被本地拒掉。
            // - `historyFirst`：Host 侧的语义是「先经反向 RPC `loadPersistedMessages` 在 Host 读历史，
            //   再起 runtime」。Rust 内核不走那条路——它自己的 `session_snapshot` 就是存储直读，
            //   `Live::new` 从 `SessionView` 建冷投影，历史永远是第一手。所以对 Host 而言「历史先行」
            //   在这里恒成立，回报 true 是准确的（Host 只是据此选一条更快的冷打开路径）。
            // - `sessionDirectorySource` / `genUiContext`：内核没有这两个能力面（Host 侧也没有消费方），
            //   如实回 false。
            "runtime/capabilities" => reply(json!({
                "independentPlanState": true,
                "historyFirst": true,
                "sessionDirectorySource": false,
                "genUiContext": false,
            })),
            // platform 自己读同一批文件；回执版本（app-protocol.md §5.1）。
            "provider/updateAccountConfig" => reply(json!({
                "receivedRevision": params["revision"],
                "providerCount": params["providers"].as_object().map_or(0, serde_json::Map::len),
                "status": "received",
            })),
            "provider/refreshRegistry" => reply(json!({"refreshed": true})),
            "workspace/updateInteractionPreferences" => {
                let enabled = params["preferences"]["askUserQuestionAutoResolutionEnabled"]
                    .as_bool()
                    .unwrap_or(false);
                self.preferences().ask_auto_resolution = enabled;
                reply(json!({"workspace": params["workspace"],
                    "askUserQuestionAutoResolutionEnabled": enabled, "snoozedInteractionCount": 0}))
            }
            "workspace/updateModelIoPreferences" => {
                let enabled = params["preferences"]["fullRetentionEnabled"]
                    .as_bool()
                    .unwrap_or(false);
                self.preferences().full_retention = enabled;
                reply(
                    json!({"workspace": params["workspace"], "fullRetentionEnabled": enabled,
                    "updatedSessionCount": 0}),
                )
            }
            // 动态工作流的灰度闸由 Host 自己判（它只在 `enabled:true` 时才注入引擎）；这里回执只是
            // 应答——Host 只验 schema 不消费值（zcodeAgentService.ts:3252）。
            //
            // 按**实况**回报：动态工作流已全链实现（34 个 CommandType 含 3 个工作流命令 + 8 个中枢
            // 方法 + 引擎 sidecar 路线 C），所以这里回 true 而不是恒 false。恒 false 曾是「动态工作流
            // 不移植（P4 决定）」时代的残桩，那条决定早已被推翻（141 审计 F1）。
            "workspace/updateDynamicWorkflowPolicy" => {
                reply(json!({"workspace": params["workspace"], "enabled": true}))
            }
            "workspace/readPresentation" => reply(self.read_presentation(&params).await),
            // 目录来源按 sessionIds 查父链：rust 的会话没有要报的父链（子代理不进列表），P1 回空列表。
            "session/list" => reply(json!({"sessions": []})),
            // 旧会话入口（141 F5）：Host 的任务适配器、时间线、设置面板仍在用；内部桥到 v4 语义。
            "session/create" => crate::legacy_session::create(self, &params)
                .await
                .map(Reply::new),
            "session/resume" => crate::legacy_session::resume(self, &params)
                .await
                .map(Reply::new),
            "session/messages" => crate::legacy_session::messages(self, &params)
                .await
                .map(Reply::new),
            "session/compact" => crate::legacy_session::compact(self, &params)
                .await
                .map(Reply::new),
            "session/goal" => crate::legacy_session::goal(self, &params)
                .await
                .map(Reply::new),
            "session/setModel" => crate::legacy_session::set_model(self, &params)
                .await
                .map(Reply::new),
            "session/setThoughtLevel" => crate::legacy_session::set_thought_level(self, &params)
                .await
                .map(Reply::new),
            "session/setMode" => crate::legacy_session::set_mode(self, &params)
                .await
                .map(Reply::new),
            "session/read" => crate::legacy::read(self, &params).await.map(Reply::new),
            "session/close" => reply(self.close_session(&params).await),
            "v4/conversation/subscribe" => crate::subscribe::subscribe(self, &params).await,
            "v4/conversation/unsubscribe" => crate::subscribe::unsubscribe(self, &params).await,
            "v4/conversation/resync" => crate::subscribe::resync(self, &params).await,
            "v4/connection/flow" => crate::subscribe::flow(self, &params).await,
            "v4/sessionsIndex/reconcile" => crate::subscribe::reconcile(self, &params).await,
            // NIBI 协议中枢（GUI）：运行历史页 + 已保存工作流读/写面（contract 见 nibi_workflows.rs）。
            "workflows/runs" => crate::nibi_workflows::runs(self, &params).await.map(Reply::new),
            "workflows/list" => crate::nibi_workflows::list_workflows(self, &params).await.map(Reply::new),
            "workflows/get" => crate::nibi_workflows::get_workflow(self, &params).await.map(Reply::new),
            "workflows/save" => crate::nibi_workflows::save_workflow(self, &params).await.map(Reply::new),
            "workflows/updateMeta" => crate::nibi_workflows::update_workflow_meta(self, &params).await.map(Reply::new),
            "workflows/delete" => crate::nibi_workflows::delete_workflow(self, &params).await.map(Reply::new),
            "workflows/move" => crate::nibi_workflows::move_workflow(self, &params).await.map(Reply::new),
            "workflows/forRun" => crate::nibi_workflows::for_run(self, &params).await.map(Reply::new),
            // v4 查询面（141 审计 §9 第 2 项）：usage 2 条 + run 详情 7 条。
            // 数据全在内核侧的会话库，纯投影与分页；参数契约从 Host 的 zod 逐字
            // （contract 见 v4_queries.rs 的文件头）。
            "v4/conversation/rowsRange" => {
                crate::v4_queries::rows_range(self, &params).await.map(Reply::new)
            }
            "v4/conversation/plans" => {
                crate::v4_queries::plans(self, &params).await.map(Reply::new)
            }
            "v4/conversation/backgroundBashOutput" => {
                crate::v4_queries::background_bash_output(self, &params)
                    .await
                    .map(Reply::new)
            }
            "v4/conversation/fileChanges" => {
                crate::v4_queries::file_changes(self, &params).await.map(Reply::new)
            }
            "v4/conversation/fileRewindPreview" => {
                crate::v4_queries::file_rewind_preview(self, &params)
                    .await
                    .map(Reply::new)
            }
            "v4/usage/stats" => crate::v4_queries::usage_stats(self, &params).await.map(Reply::new),
            "v4/conversation/usage" => crate::v4_queries::conversation_usage(self, &params)
                .await
                .map(Reply::new),
            "v4/conversation/workflowRuns" => crate::v4_queries::workflow_runs(self, &params)
                .await
                .map(Reply::new),
            "v4/conversation/workflowRunEvents" => {
                crate::v4_queries::workflow_run_events(self, &params).await.map(Reply::new)
            }
            "v4/conversation/workflowRunArtifacts" => {
                crate::v4_queries::workflow_run_artifacts(self, &params).await.map(Reply::new)
            }
            "v4/conversation/workflowRunArtifactData" => {
                crate::v4_queries::workflow_run_artifact_data(self, &params).await.map(Reply::new)
            }
            "v4/conversation/workflowRunArtifactRead" => {
                crate::v4_queries::workflow_run_artifact_read(self, &params).await.map(Reply::new)
            }
            "v4/conversation/workflowRunWorkspace" => {
                crate::v4_queries::workflow_run_workspace(self, &params).await.map(Reply::new)
            }
            "v4/conversation/workflowRunNodeResult" => {
                crate::v4_queries::workflow_run_node_result(self, &params).await.map(Reply::new)
            }
            // 附件事务与回读（141 审计 §9 第 4 项）：上行四条走进程内暂存表，回读四条按已授权行。
            "v4/attachment/begin" => crate::attachment_rpc::begin(self, &params).await.map(Reply::new),
            "v4/attachment/chunk" => crate::attachment_rpc::chunk(self, &params).await.map(Reply::new),
            "v4/attachment/commit" => crate::attachment_rpc::commit(self, &params).await.map(Reply::new),
            "v4/attachment/abort" => crate::attachment_rpc::abort(self, &params).await.map(Reply::new),
            "v4/attachment/read" => crate::attachment_rpc::read(self, &params).await.map(Reply::new),
            "v4/attachment/previewSource" => {
                crate::attachment_rpc::preview_source(self, &params).await.map(Reply::new)
            }
            "v4/conversation/attachmentRead" => {
                crate::attachment_rpc::conversation_read(self, &params).await.map(Reply::new)
            }
            "v4/conversation/attachmentStat" => {
                crate::attachment_rpc::conversation_stat(self, &params).await.map(Reply::new)
            }
            // 进程资源面（141 审计 §9 F3）：`process/childProcesses` 是 Host→CLI 的请求，其余四族是
            // CLI→Host 的通知（见 `telemetry.rs`）。这里只答请求的那一条；`process/networkCapture`
            // 是 Host→CLI 的通知，见 `Handler::notification`。
            "process/childProcesses" => reply(json!({
                "processes": self.kernel.mcp_child_processes().await
                    .iter()
                    .map(|process| {
                        let mut value = json!({
                            "pid": process.pid,
                            "serverName": process.server_name,
                            "mcpSource": process.mcp_source,
                        });
                        if let Some(plugin) = &process.plugin_name {
                            value["pluginName"] = json!(plugin);
                        }
                        value
                    })
                    .collect::<Vec<_>>(),
            })),
            // `mcp/list`（141 审计 §9 第 6 项 F7）：设置页的工作区 MCP 状态检查。`connect` 收敛
            // 状态页自己的连接集合并等连接落定；`status` 只读（OAuth 轮询）。
            "mcp/list" => crate::mcp_rpc::list(self, &params).await.map(Reply::new),
            // MCP Apps（141 审计 §9 第 6 项 F7）：实例凭证、资源、订阅与页面工具调用。采样与
            // AppTool 在后续切片接上。
            "mcp/uiOpenInstance" => crate::mcp_rpc::open_instance(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiCloseInstance" => crate::mcp_rpc::close_instance(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiValidateInstance" => crate::mcp_rpc::validate_instance(self, &params)
                .await
                .map(Reply::new),
            "mcp/readResource" => crate::mcp_rpc::read_resource(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiReadResource" => crate::mcp_rpc::read_resource_for_ui(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiListResources" => crate::mcp_rpc::list_resources(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiListResourceTemplates" => crate::mcp_rpc::list_resource_templates(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiSubscribeResource" => crate::mcp_rpc::subscribe_resource(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiUnsubscribeResource" => crate::mcp_rpc::unsubscribe_resource(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiCallTool" => crate::mcp_rpc::call_tool(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiCancelCall" => crate::mcp_rpc::cancel_call(self, &params)
                .await
                .map(Reply::new),
            "v4/command" => crate::commands::command(self, params).await.map(Reply::new),
            "v4/commands/query" => crate::commands::query(self, &params).await.map(Reply::new),
            other => Err(RpcError::method_not_found(other)),
        }
    }
}

/// [`Server`] 放在连接上的形状（读循环要 `'static`）。
pub struct Handler(pub Arc<Server>);

#[async_trait]
impl Service for Handler {
    async fn request(&self, method: &str, params: Value) -> Result<Reply, RpcError> {
        Inbound::get().method(method, &params)?;
        self.0.dispatch(method, params).await
    }

    /// Host 发来的通知。目前只有 `process/networkCapture`（开/关网络捕获）一条有语义，其余
    /// 与以前一样忽略——Rust 的入站通知面就是这一条（141 审计 §9 F3）。
    async fn notification(&self, method: &str, params: Value) {
        if method == crate::telemetry::NETWORK_CAPTURE {
            // 形状不对就当没收到（Node 的 `safeParse` 同一姿态）；不开捕获时这是零成本。
            self.0.capture.control(&params);
        }
    }
}

//! App 协议的方法表（docs/specs/rust-cli/app-protocol.md §3.4、§10.3）：P1 的方法；其余回 `-32601`。
//! 命令在 [`crate::commands`]，订阅在 [`crate::subscribe`]。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use futures_util::StreamExt;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{EndReason, Kernel, KernelError};
use nibi_kernel_protocol_core::connection::{Reply, Service};
use nibi_kernel_protocol_core::rpc::RpcError;
use nibi_kernel_protocol_core::sessions::{Bridged, SessionBridge};
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

/// 工作区级的开关（Host 推来的偏好）。
#[derive(Debug, Clone)]
struct Preferences {
    ask_auto_resolution: bool,
    full_retention: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        // Node 的交互注册表默认开启（`V4InteractionRegistry` 的初值 true）；Host 连上后会推权威值。
        Self {
            ask_auto_resolution: true,
            full_retention: false,
        }
    }
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
    pub(crate) spawner: nibi_kernel_base::Spawner,
    pub(crate) defaults: Defaults,
    /// 本进程的实例标识（时钟探测的 `clock.instanceId`）。
    pub(crate) instance: String,
    /// 首 token 时延观察（`v4/telemetry/local-ttft`，141 审计 §9 第 5 项余项）。
    pub(crate) local_ttft: Arc<crate::local_ttft::LocalTtftRecorder>,
    /// 附件事务的暂存表（`v4/attachment/begin|chunk|commit|abort`，见 [`crate::attachment_upload`]）。
    pub(crate) uploads: crate::attachment_upload::Registry,
    /// 网络捕获的开关与攒批（`process/networkCapture` → `process/networkRequests`，141 审计 §9 F3）。
    pub(crate) capture: Arc<crate::telemetry::Capture>,
    /// 工作区补全的进行中操作（`workspace/generateText` 的 `operationId` → 取消信号）。
    pub(crate) generate_operations: Mutex<HashMap<String, nibi_kernel_api::abort::Abort>>,
    preferences: Mutex<Preferences>,
    /// 会话第一次打开时问 Host 一轮启动偏好（`session/requestRuntimePreferences`）。
    /// 只有 Host 侧的 stdio 服务打开它：没有对端应答的入口（测试、纯 CLI）保持关闭，否则每次冷打开
    /// 都要等一次请求超时。
    host_preferences: std::sync::atomic::AtomicBool,
}

/// 未知会话的协议错误（Host 的 `requireSession`：fail closed，不回落到工作区）。
pub(crate) fn session_unavailable(session: &nibi_kernel_api::ids::SessionId) -> RpcError {
    RpcError::new(
        SESSION_UNAVAILABLE,
        format!("Session unavailable: {}", session.as_str()),
    )
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
        spawner: nibi_kernel_base::Spawner,
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
            generate_operations: Mutex::new(HashMap::new()),
            preferences: Mutex::new(Preferences::default()),
            host_preferences: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// 打开「冷打开时问 Host 启动偏好」（Host 侧的 stdio 服务在装配时调用一次）。
    pub(crate) fn request_host_preferences(&self) {
        self.host_preferences
            .store(true, std::sync::atomic::Ordering::Release);
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
        let spawner = self.spawner.clone();
        let auto_resolution_enabled = self.preferences().ask_auto_resolution;
        let cold = self.bridge.get(session).is_none();
        let live = self
            .bridge
            .open(session, move |handle, view| {
                Live::new(
                    context,
                    topics,
                    handle,
                    view,
                    followup,
                    local_ttft,
                    spawner,
                    auto_resolution_enabled,
                )
            })
            .await?;
        // 冷打开时问一次 Host 的启动偏好（Node 在会话物化时问）：先应用，再挂计时任务。
        if cold
            && self
                .host_preferences
                .load(std::sync::atomic::Ordering::Acquire)
        {
            self.apply_host_preferences(session, &live).await;
        }
        // 自动结束的计时任务：打开会话时装上（重复打开保留第一个）。
        live.sink
            .attach_auto_resolution_clock(Arc::downgrade(&live));
        // 冷打开的每轮文件摘要（轮头角标与撤销入口）：读不出 artifact 只少一个角标，不拦打开。
        // 只挂一次；之后的写入走 `FileChanges` 事件。先看旗标，别让每条命令都重读一遍 artifact。
        if live.sink.needs_file_summaries() {
            match live.handle.file_change_summaries().await {
                Ok(summaries) => live.sink.set_file_summaries(&summaries).await,
                Err(error) => tracing::debug!(%error, "file change summaries are unavailable"),
            }
        }
        // 冷打开的 `workflowRuns`（run 卡在重启后仍显示上次的终态）：索引行来自 `dwf_run`，
        // 节点/阶段仍由详情页的 journal 查询面提供。读不出只是少一张卡的头，不拦打开。
        match self.kernel.workflow_run_summaries(session, 8).await {
            Ok(rows) => live.sink.seed_workflow_runs(&rows).await,
            Err(error) => tracing::debug!(%error, "workflow run summaries are unavailable"),
        }
        // 会话第一次打开：按当前快照上报工作区钩子的提示条（Node 在 activate 时上报 admission）。
        self.announce_hook_admission(session, live.sink.clone()).await;
        // 子代理目录：`subagents` 键的事实源是内核的在跑子代理表，不是事件流（内核没有
        // `KernelEvent::Subagent` 的生产者）。首帧之前播种一次，之后跟着 agents 的变化通知刷新。
        self.seed_subagents(&live).await;
        self.watch_subagents(&live);
        Ok(live)
    }

    /// 冷打开时问 Host 两档启动偏好并应用：`runtime-materialization`（AUQ、附加目录、工具搜索、
    /// 增强搜索）与 `user-execution`（集成终端 Shell，Node 也只在这个档位给）。两档并发、各自超时；
    /// 请求失败/超时用内核缺省，不拦打开。
    async fn apply_host_preferences(&self, session: &SessionId, live: &Arc<Bridged<Live>>) {
        let (materialization, execution) = tokio::join!(
            crate::runtime_preferences::request_scope(
                &self.context,
                session,
                crate::runtime_preferences::MATERIALIZATION_SCOPE,
            ),
            crate::runtime_preferences::request_scope(
                &self.context,
                session,
                crate::runtime_preferences::USER_EXECUTION_SCOPE,
            ),
        );
        let mut preferences = materialization
            .as_ref()
            .map(crate::runtime_preferences::parse)
            .unwrap_or_default();
        if let Some(shell) = execution
            .as_ref()
            .and_then(crate::runtime_preferences::parse_execution_shell)
        {
            preferences.execution.integrated_shell = Some(shell);
        }
        if let Some(enabled) = preferences.auto_resolution {
            live.sink.set_auto_resolution_enabled(enabled).await;
        }
        if let Some(enabled) = preferences.memory_enabled
            && let Err(error) = self
                .kernel
                .set_session_memory_enabled(session, enabled)
                .await
        {
            tracing::warn!(
                event = "protocol.runtime_preferences.memory_failed",
                session = session.as_str(),
                error = %error,
                "the kernel refused the memory setting from the host"
            );
        }
        if !preferences.additional_directories.is_empty()
            && let Err(error) = self
                .kernel
                .set_session_directories(session, preferences.additional_directories)
                .await
        {
            tracing::warn!(
                event = "protocol.runtime_preferences.directories_failed",
                session = session.as_str(),
                error = %error,
                "the kernel refused the additional directories from the host"
            );
        }
        // 设置页的三项按会话固定：分叉/辅助对话在建会话时已从父会话继承，Host 的全局值不再覆盖；
        // 其余（新建、冷恢复）按物化这一刻的 Host 值。和 Node 一样，当前会话不受之后的设置变更影响。
        if !preferences.execution.is_empty() {
            let inherited = live.sink.has_parent()
                && self
                    .kernel
                    .session_execution_preferences(session)
                    .await
                    .is_some();
            if !inherited
                && let Err(error) = self
                    .kernel
                    .set_session_execution_preferences(session, preferences.execution)
                    .await
            {
                tracing::warn!(
                    event = "protocol.runtime_preferences.execution_failed",
                    session = session.as_str(),
                    error = %error,
                    "the kernel did not store the session execution preferences"
                );
            }
        }
    }

    /// 把自动结束偏好推给每个打开着的会话（Node 的注册表是进程级一份；Rust 的计时状态跟着
    /// 会话投影走，所以逐会话下发）。返回被换成 `snoozed` 的条数。
    async fn apply_auto_resolution_preference(&self, enabled: bool) -> usize {
        let mut snoozed = 0;
        for live in self.bridge.sessions() {
            let (done, finished) = tokio::sync::oneshot::channel();
            let bridged = live.clone();
            live.run(std::boxed::Box::pin(async move {
                let count = bridged.sink.set_auto_resolution_enabled(enabled).await;
                let _ = done.send(count);
            }));
            // 泵已经结束的会话不会跑这件工作：计数按 0 算，不影响回执。
            if let Ok(count) = finished.await {
                snoozed += count;
            }
        }
        snoozed
    }

    /// 冷播种 `subagents` 键。取不到只让这一项为空，不拦打开（与其它冷播种同一纪律）。
    async fn seed_subagents(&self, live: &Arc<Bridged<Live>>) {
        match live.handle.subagents().await {
            Ok(entries) => live.sink.publish_subagents(&entries).await,
            Err(error) => tracing::debug!(%error, "the subagent directory is unavailable"),
        }
    }

    /// 跟着 agents 的变化通知刷新 `subagents` 键。
    ///
    /// 不能只挂在事件窗口上：后台子代理结束时父会话可能正空闲，没有事件就没有窗口到期，
    /// 目录会停在旧值。`subagent_changes()` 正是为此存在的信号（TUI 的 L30 列表也用它）。
    /// 刷新走会话泵（`live.run`），与事件帧同序。
    fn watch_subagents(&self, live: &Arc<Bridged<Live>>) {
        let mut changes = live.handle.subagent_changes();
        let handle = live.handle.clone();
        let controller = Arc::downgrade(live);
        self.spawner.spawn("subagent-directory", async move {
            // 流结束（会话关了）就收尾。
            while changes.next().await.is_some() {
                // 泵已丢弃（会话关了或 Host 不再订阅）时没有接收方，直接收尾。
                let Some(live) = controller.upgrade() else {
                    return;
                };
                let Ok(entries) = handle.subagents().await else {
                    continue;
                };
                let sink = live.sink.clone();
                live.run(Box::pin(async move { sink.publish_subagents(&entries).await }));
            }
        });
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

    /// `session/debug` 的当前快照。会话没打开时回空快照（UI 显示空态，不报错）。
    fn debug_snapshot(&self, params: &Value) -> Value {
        let session = params["sessionId"].as_str().unwrap_or_default();
        self.bridge
            .get(&SessionId::new(session))
            .map_or_else(
                || crate::session_debug::DebugRecorder::default().snapshot(session),
                |live| live.sink.debug_snapshot(),
            )
    }

    fn preferences(&self) -> std::sync::MutexGuard<'_, Preferences> {
        self.preferences
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    async fn read_presentation(&self, params: &Value) -> Value {
        let workspace = params["workspace"].clone();
        let path = workspace["workspacePath"].as_str().unwrap_or_default();
        let workspace_ref = self.workspace(path);
        // Node `listProtocolSlashCommands`：内置段（goal/workflow/compact/init）在前，再是自定义命令。
        // skill 不进这份目录（它只属于 TUI 的 `/` 补全）；`/workflow` 按工作区动态工作流开关剔除。
        let workflow = self.kernel.dynamic_workflow_enabled(&workspace_ref).await;
        let mut commands = presentation_builtins(workflow);
        commands.extend(
            self.kernel
                .user_commands(&workspace_ref)
                .await
                .into_iter()
                .filter(|command| {
                    command.custom
                        && !command.hidden
                        && !command.non_interactive
                        && !command.name.is_empty()
                })
                .map(|command| {
                    let mut value = json!({"name": command.name, "description": command.description,
                        "source": "custom"});
                    if let Some(hint) = command.argument_hint {
                        value["inputHint"] = json!(hint);
                    }
                    value
                }),
        );
        json!({"workspace": workspace, "mode": self.defaults.mode.node_name(),
            "slashCommands": commands})
    }

    pub(crate) async fn close_session(&self, params: &Value) -> Value {
        let session = SessionId::new(params["sessionId"].as_str().unwrap_or_default());
        // 条件关闭（Node `shouldCloseSessionForExpectedPersistence`）：deferred 的草稿可能刚被首条输入
        // 提升，这时不能关一个已经变成真任务的会话。没有打开着的记录时按“不是这个持久化状态”回答
        // false（Host 保留会话；Node 在这种情况下 requireSession 报错）。
        if let Some(expected) = params["expectedPersistence"].as_str() {
            let current = self
                .bridge
                .get(&session)
                .map(|live| if live.handle.is_draft() { "deferred" } else { "immediate" });
            if current != Some(expected) {
                return json!({"closed": false});
            }
        }
        if let Some(broker) = self.context.browser_broker() {
            broker.close_session(session.as_str()).await;
        }
        // CUA 操作指示器的会话收尾（Node 的 `SessionEnded → session-closed`）。
        self.context
            .notify(
                "computer-use/operation-event",
                &json!({
                    "eventId": self.context.fresh("cua"),
                    "sequenceNumber": 0,
                    "sessionId": session.as_str(),
                    "timestamp": self.context.now(),
                    "kind": "session-closed",
                }),
            )
            .await;
        let live = self.bridge.close(&session);
        // 真正关闭内核里的会话（Node `record.app.close()`）：SessionEnd、后台任务收尾与按会话的表都走
        // 这条路径。之前只停止转发、actor 一直活着，关闭后再打开拿到的是旧 actor。
        if let Some(live) = live {
            for notice in live.handle.close(EndReason::Other).await {
                tracing::warn!(
                    session = %session,
                    %notice,
                    "a SessionEnd hook failed while closing the session"
                );
            }
        }
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
            // Host 设置页的「测试连通性」：一次 1 token 的无会话模型请求（Node
            // `testModelConnectivity`）。
            // Composer 的 `@` 技能引用面板（Host `skills/referenceCatalog`）。
            "skills/referenceCatalog" => crate::skill_catalog::skills(self, &params)
                .await
                .map(Reply::new),
            // Composer 的 `@` 插件引用面板（Host `plugins/referenceCatalog[WithCategory]`）。
            "plugins/referenceCatalog" => crate::plugin_catalog::reference(self, &params, false)
                .await
                .map(Reply::new),
            "plugins/referenceCatalogWithCategory" => {
                crate::plugin_catalog::reference(self, &params, true)
                    .await
                    .map(Reply::new)
            }
            // 推荐 Prompt 的安装前可信解析（Host `plugins/resolveSuggestedReference`）。
            "plugins/resolveSuggestedReference" => crate::plugin_catalog::suggested(self, &params)
                .await
                .map(Reply::new),
            "provider/testModelConnectivity" => crate::model_connectivity::test(self, &params)
                .await
                .map(Reply::new),
            "provider/updateAccountConfig" => reply(json!({
                "receivedRevision": params["revision"],
                "providerCount": params["providers"].as_object().map_or(0, serde_json::Map::len),
                "status": "received",
            })),
            "provider/refreshRegistry" => reply(json!({"refreshed": true})),
            "workspace/updateInteractionPreferences" => {
                let enabled = params["preferences"]["askUserQuestionAutoResolutionEnabled"]
                    .as_bool()
                    .unwrap_or(true);
                self.preferences().ask_auto_resolution = enabled;
                // 关掉时把每个打开会话里正在计时的 AskUserQuestion 换成 snoozed（Node 的注册表是
                // 全工作区一份，计数取所有会话之和）。打开只让之后的问题计时，不追溯。
                let snoozed = self.apply_auto_resolution_preference(enabled).await;
                reply(json!({"workspace": params["workspace"],
                    "askUserQuestionAutoResolutionEnabled": enabled,
                    "snoozedInteractionCount": snoozed}))
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
            // 动态工作流的灰度门由 Host 判定：它在 client 启动、任何 session 工作之前同步
            // workspace 级结论，**关闭时不发这条请求**（CLI 缺省即关闭）。这里落地并回实际值；
            // Host 只验 schema 不消费回执（zcodeAgentService.ts:3252）。mode 只在开启时有意义，
            // `onDemand` 是 Node 的作者工具按需激活——内核没有对应工具，记下供对齐。
            "workspace/updateDynamicWorkflowPolicy" => {
                let enabled = params["enabled"].as_bool().unwrap_or(false);
                let on_demand = enabled && params["mode"].as_str() == Some("onDemand");
                let path = params["workspace"]["workspacePath"]
                    .as_str()
                    .or_else(|| params["workspace"].as_str())
                    .unwrap_or_default();
                if let Err(error) = self
                    .kernel
                    .update_dynamic_workflow_policy(
                        &self.workspace(path),
                        nibi_kernel_api::session_api::DynamicWorkflowGate::new(enabled, on_demand),
                    )
                    .await
                {
                    // 策略只影响之后创建/恢复的会话（Node 同一语义），同步失败不阻断客户端就绪。
                    tracing::warn!(
                        event = "protocol.dynamic_workflow.policy_failed",
                        error = %error,
                        "the kernel did not store the dynamic workflow policy"
                    );
                }
                reply(json!({"workspace": params["workspace"], "enabled": enabled}))
            }
            "workspace/readPresentation" => reply(self.read_presentation(&params).await),
            // 旧入口（141 F5）：Settings 页无会话时的钩子预信任
            // （Node `grantWorkspaceHookTrust` → `workspace-hook-trust.ts`）。无会话也受理。
            "workspace/hooks/trustGrant" => crate::hook_review::trust_grant(self, &params)
                .await
                .map(Reply::new),
            // 旧入口（141 F5）：Host 的「生成提交信息」做一次无会话补全
            // （Node `workspace-generate-text.ts`）。取消按 `operationId` 单独一条。
            "workspace/generateText" => crate::generate_text::generate(self, &params)
                .await
                .map(Reply::new),
            "workspace/cancelGenerateText" => crate::generate_text::cancel(self, &params)
                .map(Reply::new),
            // Host 的任务列表、项目谱系校验与分享导入去重（Node `listSessions` 的两种读法）。
            "session/list" => crate::session_directory::list(self, &params)
                .await
                .map(Reply::new),
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
            // 旧输入入口：Host 的 Bot / 手机远控仍用它（桌面主输入走 v4 `sendText`）。
            "session/send" => crate::legacy_session::send_prompt(self, &params)
                .await
                .map(Reply::new),
            "session/compact" => crate::legacy_session::compact(self, &params)
                .await
                .map(Reply::new),
            "session/goal" => crate::legacy_session::goal(self, &params)
                .await
                .map(Reply::new),
            // 旧 usage 查询（Host 的 `getTaskTokenUsage` 与 v4 `conversation/usage` 同一份数据）。
            "session/usage" => crate::v4_queries::conversation_usage(self, &params)
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
            // 子代理目录的旧查询入口（Host 的 `SubagentDirectorySidePane`）：与快照的 `subagents`
            // 键同一事实源，另给已结束项的分页明细。
            "session/subagents" => crate::subagents_rpc::list(self, &params)
                .await
                .map(Reply::new),
            // 开发者工具的调试面（Host 的 `DeveloperToolsPane`）：网络面来自模型请求状态事实，
            // 轮次面来自结束回合的用量。
            "session/debug" => reply(self.debug_snapshot(&params)),
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
            "mcp/uiRegisterAppTools" => crate::mcp_rpc::register_app_tools(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiUnregisterAppTools" => crate::mcp_rpc::unregister_app_tools(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiClaimAppToolCall" => crate::mcp_rpc::claim_app_tool_call(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiResolveAppToolCall" => crate::mcp_rpc::resolve_app_tool_call(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiSampling" => crate::mcp_rpc::sample(self, &params)
                .await
                .map(Reply::new),
            "mcp/uiCancelSampling" => crate::mcp_rpc::cancel_sampling(self, &params)
                .await
                .map(Reply::new),
            "v4/command" => crate::commands::command(self, params).await.map(Reply::new),
            "v4/commands/query" => crate::commands::query(self, &params).await.map(Reply::new),
            other => Err(RpcError::method_not_found(other)),
        }
    }
}

/// Node `APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES` 与共享 help 表的同形投影。
fn presentation_builtins(workflow: bool) -> Vec<Value> {
    let mut commands = vec![json!({
        "name": "goal",
        "description": "Show or set the current session goal.",
        "inputHint": "/goal [pause|resume|clear|replace <objective>|<objective>]",
        "source": "builtin",
    })];
    if workflow {
        commands.push(json!({
            "name": "workflow",
            "description": "Design and launch a dynamic workflow for a task.",
            "inputHint": "/workflow [what the workflow should accomplish]",
            "source": "builtin",
        }));
    }
    commands.push(json!({
        "name": "compact",
        "description": "Compact the current conversation with optional instructions.",
        "inputHint": "/compact [instructions]",
        "source": "builtin",
    }));
    commands.push(json!({
        "name": "init",
        "description": "Create or update workspace AGENTS.md instructions.",
        "inputHint": "/init [notes]",
        "source": "builtin",
    }));
    commands
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

#[cfg(test)]
mod presentation_tests {
    use super::*;

    fn names(commands: &[Value]) -> Vec<&str> {
        commands
            .iter()
            .filter_map(|command| command["name"].as_str())
            .collect()
    }

    #[test]
    fn builtin_slash_commands_match_node_order() {
        let enabled = presentation_builtins(true);
        assert_eq!(names(&enabled), ["goal", "workflow", "compact", "init"]);
        assert!(enabled.iter().all(|command| command["source"] == "builtin"));
        let disabled = presentation_builtins(false);
        assert_eq!(names(&disabled), ["goal", "compact", "init"]);
    }
}

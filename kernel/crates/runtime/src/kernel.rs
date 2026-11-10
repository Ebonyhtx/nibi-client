//! 内核会话 API 的本地实现（[`Kernel`]）：建会话、打开会话（冷加载）、列出会话。

use super::*;
use nibi_kernel_api::permission::ExecutionState;

/// 引擎的业务拒绝 → `KernelError::Failed`，消息以 Node 的 fault 前缀开头（协议层原样上行 reasonCode）。
fn workflow_fault(
    prefix: &str,
    error: nibi_kernel_api::workflow::WorkflowEngineError,
) -> KernelError {
    let message = match error.message.filter(|message| !message.is_empty()) {
        Some(message) => format!("{prefix}{}: {message}", error.reason),
        None => format!("{prefix}{}", error.reason),
    };
    KernelError::Failed { message }
}

fn failed(error: &StoreError) -> KernelError {
    match error {
        StoreError::NotFound { session } => KernelError::NotFound {
            session: session.clone(),
        },
        other => KernelError::Failed {
            message: other.to_string(),
        },
    }
}

/// MCP Apps 的错误 → 内核错误：能力缺失是 `Unsupported`，其余（未授权、连接不可用、服务器错误）
/// 都是 `Failed`，协议层按消息映射错误码。
fn mcp_ui_error(error: nibi_kernel_api::mcp_ui::McpUiError) -> KernelError {
    use nibi_kernel_api::mcp_ui::McpUiError;
    match error {
        McpUiError::Unsupported { server, operation } => KernelError::Unsupported {
            what: format!("MCP server \"{server}\" {operation}"),
        },
        other => KernelError::Failed {
            message: other.to_string(),
        },
    }
}

/// 审批拒绝的文字：第一条文本内容（权限拒绝、hook 拒绝都在这里），没有时给固定文字。
fn tool_output_text(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .find_map(|content| match content {
            nibi_kernel_api::message::ToolResultContent::Text { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_else(|| "the tool call was rejected".to_owned())
}

/// 建会话的共同写入路径（`create_session_as` / `create_session_deferred`）：`draft` 时不写会话行与
/// 初始事实，等会话 actor 在第一条用户输入提交时按当时的选择与模式补写（草稿提升，`session` crate）。
impl LocalKernel {
    async fn create_session_inner(
        &self,
        request: CreateSession,
        start: StartSource,
        parent: Option<SessionId>,
        draft: bool,
    ) -> Result<SessionId, KernelError> {
        let id = request.id.unwrap_or_else(|| self.ports.ids.session());
        let workspace = request.workspace.clone();
        // 子会话继承父会话此刻的动态工作流门（Node 子代理 runtimeConfig 的结构性继承）：父显式打开
        // 而 workspace 策略缺席时，子会话不能退回关闭。父会话没登记（CLI/TUI）时不继承。
        let inherited_dynamic_workflow = parent
            .as_ref()
            .and_then(|parent| self.gate.dynamic_workflow_override(parent));
        let meta = SessionMeta {
            id: id.clone(),
            kind: SessionKind::Interactive,
            parent,
            workspace: request.workspace,
            title: String::new(),
            // 顶层会话的链路 ID 取会话 ID；子会话、子代理继承父会话的链路 ID。
            trace: TraceId::new(id.as_str()),
            created_at_ms: self.ports.clock.now_ms(),
        };
        // 执行状态（修复线 F20）：单值的 `plan` 是“plan 开、default”，另记的 `plan` 打开 plan。
        let execution = ExecutionState::from_parts(request.mode, request.plan);
        if !draft {
            self.ports
                .store
                .create(meta.clone())
                .await
                .map_err(|error| failed(&error))?;
            let batch = FactBatch {
                owner_epoch: OwnerEpoch::LOCAL,
                command: None,
                facts: vec![
                    Fact::ModelSelected {
                        selection: request.selection.clone(),
                    },
                    Fact::ExecutionChanged { state: execution },
                ],
                turn: None,
            };
            self.ports
                .store
                .commit(&id, batch)
                .await
                .map_err(|error| failed(&error))?;
        }
        // 会话级插件快照：NIBI 一个 app-server 承载多个会话，新装/启用的插件必须在
        // 新会话（以及冷恢复）里可见，而不改已有会话。快照只活在这个会话里，不落库。
        // CLI/TUI 没有 loader（单会话进程），继续用 `ext.start()` 的进程级快照。
        self.apply_session_plugin_snapshot(&id, &workspace, meta.parent.as_ref())
            .await;
        let parent_for_preferences = meta.parent.clone();
        self.start(
            SessionState {
                meta,
                messages: Vec::new(),
                earlier: Vec::new(),
                selection: request.selection,
                mode: execution,
                checkpoints: Vec::new(),
                start,
                turn: None,
                last_turn_failed: false,
                launches: Vec::new(),
                model_turns: Vec::new(),
                input_intents: Vec::new(),
                draft,
            },
            Opened::Created,
        );
        if let Some(gate) = inherited_dynamic_workflow {
            self.gate.set_dynamic_workflow(&id, gate);
        }
        // 分叉 / 辅助对话 / 导入历史继承父会话物化时的执行偏好（Node `source.kind === "inherit"`）：
        // 子会话不再问 Host，工具搜索、增强搜索与集成 Shell 与父会话一致。
        if let Some(parent) = &parent_for_preferences {
            self.machine
                .commands()
                .inherit_session_execution_preferences(parent, &id);
        }
        Ok(id)
    }

    /// 工作区权威的插件引用目录：入口给了 loader（NIBI app-server）就按当前配置与 license 现解析，
    /// 否则用启动快照（CLI/TUI）。
    async fn workspace_plugin_catalog(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
    ) -> nibi_kernel_ext::plugins::PluginCatalog {
        match &self.plugin_loader {
            Some(loader) => loader.load(workspace).await.catalog,
            None => self.ext.process_plugin_catalog(),
        }
    }

    /// 给一个会话装上当前的插件快照：skills、hooks、agents 与 MCP。
    ///
    /// 只在入口提供 `PluginSnapshotLoader`（NIBI app-server）时生效；CLI/TUI 继续用进程级快照。
    /// 冷恢复也走这里——会话 runtime 重建就重新解析，与 Node “冷恢复重建 App”一致。
    async fn apply_session_plugin_snapshot(
        &self,
        session: &SessionId,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
        parent: Option<&SessionId>,
    ) {
        let Some(loader) = &self.plugin_loader else {
            return;
        };
        // 子代理继承父会话的插件集（Node 子代理 app 继承父 app）；父会话不在时按新快照。
        if let Some(parent) = parent {
            self.ext
                .copy_session_skill_roots(parent, session.clone());
            self.ext
                .copy_session_plugin_catalog(parent, session.clone());
            self.agent_catalog
                .copy_session(parent, session.clone());
            self.hooks.copy_session(parent, session.clone());
            return;
        }
        let loaded = loader.load(workspace).await;
        let plugins = &loaded.plugins;
        // 执行期门禁：登记这份快照里的付费插件名与 MCP 服务器归属（工具表仍冻结在这份快照里）。
        self.ext.note_plugin_snapshot(plugins);
        let (agents, hooks) = crate::ext::plugin_parts(plugins);
        self.ext
            .set_session_skill_roots(session.clone(), plugins);
        // Composer `@` 插件面板的身份目录：会话创建时冻结（Node 的 session-owned catalog）。
        self.ext
            .set_session_plugin_catalog(session.clone(), loaded.catalog.clone());
        self.ext.refresh_status_servers(workspace, plugins);
        self.agent_catalog
            .set_session_plugins(session.clone(), agents);
        self.hooks
            .register_session_plugins(session.clone(), hooks);
        // 会话自己要一套 MCP 连接时，进程级配置的服务器也要在场（Node 的 App runtimeConfig.mcp
        // 同时含 CLI 配置与插件服务器）。
        let mut servers: Vec<nibi_kernel_api::mcp_session::SessionMcpServer> = self
            .ext
            .base_mcp_servers()
            .into_iter()
            .chain(plugins.mcp_servers())
            .map(|server| nibi_kernel_api::mcp_session::SessionMcpServer {
                name: server.name,
                transport: server.transport,
                always_load: server.options.always_load,
                timeout_ms: server.options.timeout_ms,
                isolation: Default::default(),
                oauth: server.oauth,
                protocol_version: server.protocol,
            })
            .collect();
        // Browser Use / Computer Use 的模型面是共享的 `node_repl` MCP 服务器，不是内核原生工具。
        // Host 声明提供执行面时按 Node bootstrap 的同一形状装上；插件快照里没有
        // `node-repl-host`（未声明或未启用）时这里是 None。
        if let Some(env) = &self.node_repl_env
            && let Some(server) = crate::node_repl::builtin_server(&plugins, env)
        {
            servers.push(server);
        }
        if servers.is_empty() {
            return;
        }
        self.ext.start_session_mcp(session, workspace, servers);
    }
}

#[async_trait]
impl Kernel for LocalKernel {
    async fn create_session(&self, request: CreateSession) -> Result<SessionId, KernelError> {
        self.create_session_as(request, StartSource::Startup).await
    }

    /// 后台通知中心（DWF run 的终态通知进父会话；升级提示同路）。
    fn workflow_notices(&self) -> Option<std::sync::Arc<dyn nibi_kernel_api::workflow::WorkflowNotices>> {
        Some(self.actors.clone())
    }

    /// 「run 还欠着决定、主代理闲着」提醒钟的会话侧边（actor 的忙闲沿 + 引擎客户端的开集沿）。
    fn workflow_blocked(
        &self,
    ) -> Option<std::sync::Arc<dyn nibi_kernel_api::workflow::WorkflowBlockedEdges>> {
        Some(self.blocked.clone())
    }

    /// DWF 引擎的归属事实写进父会话事件流（`v4/telemetry/event` 的 `workflow.lifecycle`）。
    /// 会话不在本进程（已关闭）时返回 false，引擎客户端只记日志。
    fn note_workflow_lifecycle(
        &self,
        session: &nibi_kernel_api::ids::SessionId,
        fact: nibi_kernel_api::session_api::WorkflowLifecycleFact,
    ) -> bool {
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match sessions.get(session).and_then(table::Slot::open) {
            Some(open) => {
                open.note_workflow_lifecycle(fact);
                true
            }
            None => false,
        }
    }

    /// DWF 引擎的实时进度写进父会话事件流（快照 `workflowRuns` 的实时来源）。
    fn note_workflow_run_progress(
        &self,
        session: &nibi_kernel_api::ids::SessionId,
        progress: nibi_kernel_api::workflow::WorkflowRunProgress,
    ) -> bool {
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match sessions.get(session).and_then(table::Slot::open) {
            Some(open) => {
                open.note_workflow_run_progress(progress);
                true
            }
            None => false,
        }
    }

    /// GUI 中枢的已保存工作流读面：frontmatter 解析器在 sidecar（@nibi/core），这里转发。
    /// 降级（没接 sidecar 的入口）在本层现做：home 取机器事实，协议层不读环境。
    async fn hub_list_saved_workflows(
        &self,
        workspace_path: &str,
        scope: &str,
    ) -> Result<serde_json::Value, KernelError> {
        let Some(engine) = self.workflow_engine.as_ref() else {
            // home 取机器事实（EnvFacts.home；协议层不读环境）。
            let home = self
                .machine
                .info()
                .facts(&nibi_kernel_api::env::WorkspaceRef {
                    environment: nibi_kernel_api::ids::EnvironmentId::new(
                        nibi_kernel_api::env_registry::LOCAL_MACHINE,
                    ),
                    root: nibi_kernel_api::env::EnvPath::new(workspace_path.to_owned()),
                })
                .await
                .ok()
                .and_then(|facts| facts.home)
                .map(|home| home.as_str().to_owned());
            return Ok(serde_json::json!({
                "workflows": [],
                "invalid": [],
                "dir": saved_workflow_dir(home, workspace_path, scope),
            }));
        };
        engine
            .hub_list_saved_workflows(workspace_path, scope)
            .await
            .map_err(workflow_engine_failure)
    }

    async fn hub_get_saved_workflow(
        &self,
        workspace_path: &str,
        name: &str,
        scope: &str,
    ) -> Result<serde_json::Value, KernelError> {
        let Some(engine) = self.workflow_engine.as_ref() else {
            // 降级：与「目录里没有这个文件」同形（GUI 显示未找到，不假装内核坏了）。
            return Ok(serde_json::json!({ "ok": false, "reason": "not_found" }));
        };
        engine
            .hub_get_saved_workflow(workspace_path, name, scope)
            .await
            .map_err(workflow_engine_failure)
    }

    /// GUI 中枢的已保存工作流写面（`workflows/save` / `updateMeta` / `delete` / `move`）：
    /// 解析器、序列化器与编译检查都在 sidecar。写面**没有降级**——没有 sidecar 就没有「照旧
    /// 空页」的诚实形状（删一个看不见的文件、写一个没人解析得了的文件都是谎），fail-closed。
    async fn hub_save_workflow_from_run(
        &self,
        workspace_path: &str,
        run_id: &str,
        name: &str,
        meta: serde_json::Value,
        scope: &str,
        overwrite: bool,
    ) -> Result<serde_json::Value, KernelError> {
        let Some(engine) = self.workflow_engine.as_ref() else {
            return Err(hub_write_unavailable());
        };
        engine
            .hub_save_workflow_from_run(workspace_path, run_id, name, meta, scope, overwrite)
            .await
            .map_err(workflow_engine_failure)
    }

    async fn hub_update_saved_workflow_meta(
        &self,
        workspace_path: &str,
        name: &str,
        meta: serde_json::Value,
        scope: &str,
    ) -> Result<serde_json::Value, KernelError> {
        let Some(engine) = self.workflow_engine.as_ref() else {
            return Err(hub_write_unavailable());
        };
        engine
            .hub_update_saved_workflow_meta(workspace_path, name, meta, scope)
            .await
            .map_err(workflow_engine_failure)
    }

    async fn hub_delete_saved_workflow(
        &self,
        workspace_path: &str,
        name: &str,
        scope: &str,
    ) -> Result<serde_json::Value, KernelError> {
        let Some(engine) = self.workflow_engine.as_ref() else {
            return Err(hub_write_unavailable());
        };
        engine
            .hub_delete_saved_workflow(workspace_path, name, scope)
            .await
            .map_err(workflow_engine_failure)
    }

    async fn hub_move_saved_workflow(
        &self,
        workspace_path: &str,
        name: &str,
    ) -> Result<serde_json::Value, KernelError> {
        let Some(engine) = self.workflow_engine.as_ref() else {
            return Err(hub_write_unavailable());
        };
        engine
            .hub_move_saved_workflow(workspace_path, name)
            .await
            .map_err(workflow_engine_failure)
    }

    /// `workflows/forRun`（完成卡的推导判定）：读面——降级与 Node 自己查不到 run 的原形同形
    /// （空对象：没有 entry、没有 match、没有 runArgs）。
    async fn hub_find_saved_workflow_for_run(
        &self,
        workspace_path: &str,
        run_id: &str,
        candidates: serde_json::Value,
    ) -> Result<serde_json::Value, KernelError> {
        let Some(engine) = self.workflow_engine.as_ref() else {
            return Ok(serde_json::json!({}));
        };
        engine
            .hub_find_saved_workflow_for_run(workspace_path, run_id, candidates)
            .await
            .map_err(workflow_engine_failure)
    }

    /// `workflows/runs`（NIBI 协议中枢）：journal 直读的运行历史页。
    async fn workflow_runs_page(
        &self,
        cwd: Option<String>,
        name: Option<String>,
        limit: usize,
    ) -> Result<Vec<nibi_kernel_api::workflow::WorkflowRunPageRow>, KernelError> {
        self.ports
        .store
        .workflow_runs_page(cwd, name, limit)
        .await
        .map_err(|error| KernelError::Failed { message: error.to_string() })
    }

    /// 旧会话的询问（agents.md §4.1.2，工作线 F72）。
    fn detached_asks(
        &self,
    ) -> futures_util::stream::BoxStream<'static, nibi_kernel_api::orchestration::DetachedEvent>
    {
        self.detached.subscribe()
    }

    async fn resolve_detached(
        &self,
        interaction: &nibi_kernel_api::ids::InteractionId,
        answer: serde_json::Value,
    ) -> Result<(), KernelError> {
        self.detached.resolve(interaction, answer).await
    }

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        self.open_session_as(session, StartSource::Resume).await
    }

    async fn create_session_as(
        &self,
        request: CreateSession,
        start: StartSource,
    ) -> Result<SessionId, KernelError> {
        self.create_session_inner(request, start, None, false).await
    }

    /// 草稿（legacy `session/create` 的 `persistence: "deferred"`）：这一刻不写会话行与初始事实，
    /// 会话只在内存里；第一条用户输入提交时由会话 actor 补写（`session` crate 的草稿提升）。
    async fn create_session_deferred(
        &self,
        request: CreateSession,
        parent: Option<SessionId>,
    ) -> Result<SessionId, KernelError> {
        self.create_session_inner(request, StartSource::Startup, parent, true)
            .await
    }

    /// 建会话时落父会话（legacy `session/create` 的 `parentSessionId`）：与导入历史的写入路径
    /// 共用（空标题、无历史、创建时刻取现在）。
    async fn create_session_with_parent(
        &self,
        request: CreateSession,
        parent: Option<SessionId>,
    ) -> Result<SessionId, KernelError> {
        self.create_session_with_history(request, None, None, parent, Vec::new())
            .await
    }

    /// 建会话并写入导入的历史（NIBI `createSession.importedHistory`）：标题、创建时间与父会话
    /// 一起落库，历史消息按提交顺序写进同一个会话。
    async fn create_session_with_history(
        &self,
        request: CreateSession,
        title: Option<String>,
        created_at_ms: Option<u64>,
        parent: Option<SessionId>,
        history: Vec<nibi_kernel_api::session_api::ImportedMessage>,
    ) -> Result<SessionId, KernelError> {
        use nibi_kernel_api::message::{
            AssistantMessage, ContentBlock, Message, UserMessage, UserOrigin,
        };

        let id = request
            .id
            .clone()
            .unwrap_or_else(|| self.ports.ids.session());
        // 内核建的子会话（带父链的 create / 导入）继承父会话此刻的门，与 `create_session_inner` 同一条。
        let inherited_dynamic_workflow = parent
            .as_ref()
            .and_then(|parent| self.gate.dynamic_workflow_override(parent));
        let meta = SessionMeta {
            id: id.clone(),
            kind: SessionKind::Interactive,
            parent,
            workspace: request.workspace.clone(),
            title: title.unwrap_or_default(),
            trace: TraceId::new(id.as_str()),
            created_at_ms: created_at_ms.unwrap_or_else(|| self.ports.clock.now_ms()),
        };
        self.ports
            .store
            .create(meta.clone())
            .await
            .map_err(|error| failed(&error))?;
        let execution = ExecutionState::from_parts(request.mode, request.plan);
        let mut facts = vec![
            Fact::ModelSelected {
                selection: request.selection.clone(),
            },
            Fact::ExecutionChanged { state: execution },
        ];
        let mut messages = Vec::new();
        for imported in history {
            let id = self.ports.ids.message();
            let content = vec![ContentBlock::Text {
                text: imported.content,
            }];
            let message = if imported.role == "assistant" {
                Message::Assistant(AssistantMessage {
                    id,
                    content,
                    model: "<imported>".to_owned(),
                    stop_reason: None,
                    usage: None,
                })
            } else {
                Message::User(UserMessage {
                    id,
                    content,
                    origin: UserOrigin::Human,
                })
            };
            facts.push(Fact::MessageAppended {
                message: message.clone(),
            });
            messages.push(message);
        }
        let batch = FactBatch {
            owner_epoch: OwnerEpoch::LOCAL,
            command: None,
            facts,
            turn: None,
        };
        self.ports
            .store
            .commit(&id, batch)
            .await
            .map_err(|error| failed(&error))?;
        let parent_for_preferences = meta.parent.clone();
        self.start(
            SessionState {
                meta,
                messages,
                earlier: Vec::new(),
                selection: request.selection,
                mode: execution,
                checkpoints: Vec::new(),
                start: StartSource::Startup,
                turn: None,
                last_turn_failed: false,
                launches: Vec::new(),
                model_turns: Vec::new(),
                input_intents: Vec::new(),
                draft: false,
            },
            Opened::Created,
        );
        if let Some(gate) = inherited_dynamic_workflow {
            self.gate.set_dynamic_workflow(&id, gate);
        }
        // 分叉 / 辅助对话 / 导入历史继承父会话物化时的执行偏好（Node `source.kind === "inherit"`）：
        // 子会话不再问 Host，工具搜索、增强搜索与集成 Shell 与父会话一致。
        if let Some(parent) = &parent_for_preferences {
            self.machine
                .commands()
                .inherit_session_execution_preferences(parent, &id);
        }
        Ok(id)
    }

    async fn open_session_as(
        &self,
        session: &SessionId,
        start: StartSource,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        // 修复（F33，session-lifecycle.md §3.3.1）：以前表里有这个会话就直接给出句柄，它正在关闭时（actor 已退出、
        // 还没移出表）打开拿到的是死句柄，`view()` 报 `the session is closed`；两个并发的打开还会各自冷加载。现在
        // 关闭中、加载中的等它换掉；没有条目时登记 Loading，由这个调用冷加载（失败或被丢下时守卫移出 Loading）。
        let _loading = match self.claim(session).await {
            table::Claim::Open(open) => return Ok(open),
            table::Claim::Load(loading) => loading,
        };
        let loaded = self
            .ports
            .store
            .load(session)
            .await
            .map_err(|error| failed(&error))?;
        // Node 群协作会话（`permission.scope = session`）的规则只在会话行里：这个会话的判决用它代替本机项目
        // 规则集（修复线 F2，shell-permissions.md §5）。“总是允许”与改模式由存储按同一作用域落库。条目是这个调用
        // 的 Loading，期间不会有同一个会话的关闭插进来 `release` 它。
        if let Some(rules) = self
            .ports
            .store
            .session_rules(session)
            .await
            .map_err(|error| failed(&error))?
        {
            self.gate.scope(session, &rules);
        }
        let state = SessionState {
            meta: loaded.meta,
            messages: loaded.messages,
            earlier: loaded.earlier,
            selection: loaded
                .model
                .unwrap_or_else(|| self.defaults.selection.clone()),
            mode: loaded.mode.map_or_else(
                || self.defaults.mode.into(),
                |mode| ExecutionState::from_parts(mode, loaded.plan),
            ),
            checkpoints: loaded.checkpoints,
            start,
            turn: loaded.turn,
            last_turn_failed: loaded.last_turn_failed,
            launches: loaded.launches,
            model_turns: loaded.model_turns,
            input_intents: loaded.input_intents,
            // 冷加载的会话一定已经落库（草稿没有行可加载）。
            draft: false,
        };
        // 冷恢复：会话 runtime 重建，插件快照重新解析（Node 冷恢复重建 App 的同一语义）。
        self.apply_session_plugin_snapshot(session, &state.meta.workspace, None)
            .await;
        Ok(self.start(state, Opened::Loaded))
    }

    async fn list_sessions(
        &self,
        filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        self.ports
            .store
            .list(filter)
            .await
            .map_err(|error| failed(&error))
    }

    /// legacy `session/list` 的目录读面：整行投影直接来自存储端口，这里不做二次筛选。
    async fn session_directory(
        &self,
        query: nibi_kernel_api::store::SessionDirectoryQuery,
    ) -> Result<Vec<nibi_kernel_api::store::SessionDirectoryEntry>, KernelError> {
        self.ports
            .store
            .session_directory(query)
            .await
            .map_err(|error| failed(&error))
    }

    /// `/context`（context-usage.md §2）：有会话时按会话 actor 的当前视图（历史、模型、模式），只读。
    async fn context_usage(
        &self,
        query: nibi_kernel_api::context_usage::ContextUsageQuery,
    ) -> Result<nibi_kernel_api::context_usage::ContextUsage, KernelError> {
        let Some(session) = &query.session else {
            return self.usage.analyze(query, &[]).await;
        };
        let view = self.open_session(session).await?.view().await?;
        let query = nibi_kernel_api::context_usage::ContextUsageQuery {
            selection: view.selection,
            // 判决用的模式（plan 开时是 plan，修复线 F20）。
            mode: ExecutionState::from_parts(view.mode, view.plan).effective(),
            ..query
        };
        self.usage.analyze(query, &view.messages).await
    }

    /// `@` 补全的文件清单（tui-input.md §1.2）：执行环境从工作区根遍历（遵守忽略规则）。
    async fn workspace_files(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
    ) -> Result<Vec<String>, KernelError> {
        let request = nibi_kernel_api::env_files::ListFiles {
            cwd: workspace.root.clone(),
        };
        self.machine
            .search()
            .list_files(workspace, request)
            .await
            .map(|list| list.files)
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })
    }

    /// `-p` 的 stream-json 的 system/init：会话可用的工具、agent 与 skill（headless.md §3.3）。
    async fn session_catalog(
        &self,
        query: nibi_kernel_api::catalog::CatalogQuery,
    ) -> Result<nibi_kernel_api::catalog::SessionCatalog, KernelError> {
        Ok(catalog::catalog(&self.usage, &query).await)
    }

    /// `/mcp`、`/status`：ext 的连接管理给出的状态（tui-display.md §3.4）。
    async fn mcp_servers(&self) -> Vec<nibi_kernel_api::manage::McpServerInfo> {
        self.ext.mcp().server_infos()
    }

    /// `mcp/list`（141 审计 §9 第 6 项）：状态页专属的连接集合，与会话级/进程级的连接分开。
    async fn mcp_list(
        &self,
        request: nibi_kernel_api::mcp_status::McpListRequest,
    ) -> Result<Vec<nibi_kernel_api::mcp_status::McpServerStatus>, KernelError> {
        Ok(self.ext.mcp_list(request).await)
    }

    /// `mcp/uiOpenInstance`（141 审计 §9 第 6 项 F7）：页面实例凭证。
    async fn mcp_ui_open(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiOpenRequest,
    ) -> Result<nibi_kernel_api::mcp_ui::McpAppInstance, KernelError> {
        self.ext.mcp_ui_open(request).await.map_err(mcp_ui_error)
    }

    /// `mcp/uiCloseInstance`：`only_if_idle` 时只关没有进行中调用的实例。
    async fn mcp_ui_close(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiInstanceRequest,
        only_if_idle: bool,
    ) -> Result<bool, KernelError> {
        self.ext
            .mcp_ui_close(request, only_if_idle)
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiValidateInstance`：凭证、作用域与当前连接三者都对上才算有效。
    async fn mcp_ui_validate(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiInstanceRequest,
    ) -> Result<(), KernelError> {
        self.ext.mcp_ui_validate(request).await.map_err(mcp_ui_error)
    }

    /// `mcp/readResource`：宿主取页面 HTML（必须等于实例绑定的资源）。
    async fn mcp_ui_read_resource(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiReadRequest,
    ) -> Result<Vec<nibi_kernel_api::mcp_ui::McpResourceContent>, KernelError> {
        self.ext.mcp_ui_read_resource(request).await.map_err(mcp_ui_error)
    }

    /// `mcp/uiReadResource`：页面发起的资源读取。
    async fn mcp_ui_read_resource_for_ui(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiReadRequest,
    ) -> Result<Vec<nibi_kernel_api::mcp_ui::McpResourceContent>, KernelError> {
        self.ext
            .mcp_ui_read_resource_for_ui(request)
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiListResources`：页面发起的 `resources/list`。
    async fn mcp_ui_list_resources(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiListRequest,
    ) -> Result<nibi_kernel_api::mcp_ui::McpResourcePage, KernelError> {
        self.ext
            .mcp_ui_list_resources(request)
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiListResourceTemplates`：页面发起的 `resources/templates/list`。
    async fn mcp_ui_list_resource_templates(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiListRequest,
    ) -> Result<nibi_kernel_api::mcp_ui::McpResourceTemplatePage, KernelError> {
        self.ext
            .mcp_ui_list_resource_templates(request)
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiSubscribeResource`：页面订阅一个资源。
    async fn mcp_ui_subscribe(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiSubscriptionRequest,
    ) -> Result<(), KernelError> {
        self.ext.mcp_ui_subscribe(request).await.map_err(mcp_ui_error)
    }

    /// `mcp/uiUnsubscribeResource`：页面退订一个资源。
    async fn mcp_ui_unsubscribe(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiSubscriptionRequest,
    ) -> Result<(), KernelError> {
        self.ext
            .mcp_ui_unsubscribe(request)
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiCallTool`：页面回调一个本服务器的工具。
    ///
    /// 与 Node `callMcpToolForUi` 同一条链：实例与可见性校验 → 宿主审批（schema、PreToolUse hooks、
    /// 权限判决，可能询问用户）→ 复核连接代际 → 发 `tools/call`。工具**不经**模型的执行管线，
    /// 结果也不落库：页面拿到的是 MCP 的原始 `CallToolResult`。
    async fn mcp_ui_call_tool(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiCallToolRequest,
    ) -> Result<serde_json::Value, KernelError> {
        let session_id = request.instance.scope.session.clone();
        // Node 的 `requireSession`：只认本进程里打开着的会话（不冷加载存储）。
        let session = self.settled(&session_id).await.ok_or_else(|| {
            KernelError::NotFound {
                session: session_id.clone(),
            }
        })?;
        // 先去重并占住实例（`onlyIfIdle` 的关页面看这个占位），再校验归属。
        let guard = self.ext.mcp_ui_begin_call(&request).map_err(mcp_ui_error)?;
        let tool = self
            .ext
            .mcp_ui_app_tool(&request.instance, &request.tool_name)
            .await
            .map_err(mcp_ui_error)?;
        // 会话当前的模式与工作目录：owner 是 actor（`/cd` 与模式切换之后立即生效）。
        let (mode, workspace) = session.out_of_turn_context().await?;
        let context = ToolUseContext {
            session: session_id.clone(),
            run: self.ports.ids.run(),
            tool_use: ToolUseId::new(format!("ui-{}", self.ports.ids.uuid())),
            agent: None,
            workspace: workspace.clone(),
            mode,
            cancel: guard.token(),
            machine: self.machine.clone(),
            local: self.local.clone(),
            artifacts: self.ports.artifacts.clone(),
            interactions: session.session_interactions(),
            operation: OperationContext {
                environment: workspace.environment.clone(),
                generation: self.generation.clone(),
                owner_epoch: OwnerEpoch::LOCAL,
                operation: self.ports.ids.operation(),
                origin: Origin::User {
                    session: Some(session_id.clone()),
                },
            },
        };
        // 审批链与回合内的工具调用同一条；hook 或判决链改过的输入由 `authorize` 返回。
        let input = self
            .executor
            .authorize(
                tool,
                serde_json::Value::Object(request.arguments.clone()),
                context,
            )
            .await
            .map_err(|output| KernelError::Failed {
                message: tool_output_text(&output),
            })?;
        // 审批期间连接可能被替换：批准只属于原连接，执行前必须再验证一次（Node 同一条）。
        self.ext
            .mcp_ui_validate(request.instance.clone())
            .await
            .map_err(mcp_ui_error)?;
        self.ext
            .mcp_ui_call_tool(&request, input, &guard.token())
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiCancelCall`：取消进行中的页面工具调用；没有时 `false`（幂等）。
    async fn mcp_ui_cancel_call(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiCancelCallRequest,
    ) -> Result<bool, KernelError> {
        let session_id = request.instance.scope.session.clone();
        if self.settled(&session_id).await.is_none() {
            return Err(KernelError::NotFound { session: session_id });
        }
        self.ext
            .mcp_ui_cancel_call(request)
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiRegisterAppTools`：登记页面实例的工具；模型工具表在下一步请求里看到它们。
    async fn mcp_ui_register_app_tools(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiRegisterAppToolsRequest,
    ) -> Result<Vec<nibi_kernel_api::mcp_ui::McpUiAppToolRegistration>, KernelError> {
        let session = request.instance.scope.session.clone();
        if self.settled(&session).await.is_none() {
            return Err(KernelError::NotFound { session });
        }
        self.ext
            .mcp_ui_register_app_tools(request)
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiUnregisterAppTools`：收回实例的工具。会话已经关闭时按幂等处理（`removed: 0`）。
    async fn mcp_ui_unregister_app_tools(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiUnregisterAppToolsRequest,
    ) -> Result<usize, KernelError> {
        let session = request.instance.scope.session.clone();
        if self.settled(&session).await.is_none() {
            return Ok(0);
        }
        self.ext
            .mcp_ui_unregister_app_tools(request)
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiClaimAppToolCall`：渲染端认领待执行调用。
    async fn mcp_ui_claim_app_tool_call(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiClaimAppToolCallRequest,
    ) -> Result<bool, KernelError> {
        let session = request.instance.scope.session.clone();
        if self.settled(&session).await.is_none() {
            return Err(KernelError::NotFound { session });
        }
        self.ext
            .mcp_ui_claim_app_tool_call(request)
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiResolveAppToolCall`：页面回传执行结果或错误。
    async fn mcp_ui_resolve_app_tool_call(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiResolveAppToolCallRequest,
    ) -> Result<bool, KernelError> {
        let session = request.instance.scope.session.clone();
        if self.settled(&session).await.is_none() {
            return Err(KernelError::NotFound { session });
        }
        self.ext
            .mcp_ui_resolve_app_tool_call(request)
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiSampling`：页面请求宿主模型采样一次（回合外的一次性模型请求）。
    async fn mcp_ui_sampling(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiSamplingRequest,
    ) -> Result<nibi_kernel_api::mcp_ui::McpUiSamplingResult, KernelError> {
        let session_id = request.instance.scope.session.clone();
        let Some(session) = self.settled(&session_id).await else {
            return Err(KernelError::NotFound { session: session_id });
        };
        // 采样用会话当前的模型选择（回合外请求不改变它）。
        let selection = session.out_of_turn_selection().await?;
        self.ext
            .mcp_ui_sampling(request, Some(selection))
            .await
            .map_err(mcp_ui_error)
    }

    /// `mcp/uiCancelSampling`：取消进行中的采样；没有时 `false`（幂等）。
    async fn mcp_ui_cancel_sampling(
        &self,
        request: nibi_kernel_api::mcp_ui::McpUiCancelSamplingRequest,
    ) -> Result<bool, KernelError> {
        let session = request.instance.scope.session.clone();
        if self.settled(&session).await.is_none() {
            return Err(KernelError::NotFound { session });
        }
        self.ext
            .mcp_ui_cancel_sampling(request)
            .await
            .map_err(mcp_ui_error)
    }

    /// NIBI `createSession.mcpServers`：会话级的 MCP 服务器（连接在后台建立，不等结果）。
    async fn start_session_mcp(
        &self,
        session: &SessionId,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
        servers: Vec<nibi_kernel_api::mcp_session::SessionMcpServer>,
    ) -> Result<(), KernelError> {
        self.ext.start_session_mcp(session, workspace, servers);
        Ok(())
    }

    /// 会话关闭：释放它的会话级 MCP 连接（`Closer` 的 `released` 也调一次，重复调用无副作用）。
    fn stop_session_mcp(&self, session: &SessionId) {
        self.ext.release_session(session);
        self.ext.clear_session_plugins(session);
        self.hooks.clear_session(session);
        self.agent_catalog.clear_session(session);
    }

    /// NIBI `createSession.additionalDirectories`：判决链把它们按"在工作区内"处理，环境段列出它们。
    async fn set_session_directories(
        &self,
        session: &SessionId,
        directories: Vec<nibi_kernel_api::env::EnvPath>,
    ) -> Result<(), KernelError> {
        self.directories.set(session, directories);
        Ok(())
    }

    /// Host 在会话物化时给的记忆开关：context 与会话 actor 共用的表。
    async fn set_session_memory_enabled(
        &self,
        session: &SessionId,
        enabled: bool,
    ) -> Result<(), KernelError> {
        self.memory.set_enabled(session, enabled);
        Ok(())
    }

    /// Host 在会话物化时给的三项执行偏好：存在本机执行环境的表里，查询（工具搜索）与 Bash
    /// （集成 Shell、增强 Find/Grep）各自按会话读。远端执行环境没有这张表时什么都不做。
    async fn set_session_execution_preferences(
        &self,
        session: &SessionId,
        preferences: nibi_kernel_api::session_prefs::SessionExecutionPreferences,
    ) -> Result<(), KernelError> {
        self.machine
            .commands()
            .set_session_execution_preferences(session, preferences);
        Ok(())
    }

    async fn session_execution_preferences(
        &self,
        session: &SessionId,
    ) -> Option<nibi_kernel_api::session_prefs::SessionExecutionPreferences> {
        self.machine
            .commands()
            .session_execution_preferences(session)
    }

    /// NIBI `createSession.permissionScope: "session"`：Node 在 v4-bridge 里 create 之后立刻
    /// `updateSession({permission})` 并 `setExecutionState(build)`。这里写同一列，并把已打开会话的
    /// 规则层换成会话自己的（gate 是进程级快照，打开时读到的是旧值）。
    async fn apply_session_permission_scope(
        &self,
        session: &SessionId,
        scope: &str,
    ) -> Result<(), KernelError> {
        if scope != "session" {
            return Ok(());
        }
        let permission = serde_json::json!({"version": 1, "scope": "session", "mode": "build"});
        self.ports
            .store
            .set_session_permission(session, permission)
            .await
            .map_err(|error| failed(&error))?;
        match self.ports.store.session_rules(session).await {
            Ok(Some(rules)) => self.gate.scope(session, &rules),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, session = %session.as_str(),
                    "the session permission rules could not be read after scope set")
            }
        }
        Ok(())
    }

    /// Host 同步的 workspace 级动态工作流策略（Node `appRuntimePreferences`）：只影响之后创建/
    /// 恢复的会话；键是工作区根，与 `create_session` 的 `WorkspaceRef` 对上。
    async fn update_dynamic_workflow_policy(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
        gate: nibi_kernel_api::session_api::DynamicWorkflowGate,
    ) -> Result<(), KernelError> {
        self.dynamic_workflow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(workspace.root.as_str().to_owned(), gate);
        Ok(())
    }

    /// `createSession.dynamicWorkflowEnabled/Mode`：Host 显式值覆盖 workspace 结论（Node 的取值是
    /// 「显式 true 或 workspace 开启」；显式 false 不否决 workspace，所以只有 true 走到这里）。
    async fn set_session_dynamic_workflow(
        &self,
        session: &SessionId,
        gate: nibi_kernel_api::session_api::DynamicWorkflowGate,
    ) -> Result<(), KernelError> {
        self.gate.set_dynamic_workflow(session, gate);
        Ok(())
    }

    /// NIBI `AttachmentRef`：artifact URI 经会话 artifact 存储，路径经会话所在机器的文件端口。
    async fn load_attachment(
        &self,
        session: &SessionId,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
        source: nibi_kernel_api::attachment::AttachmentSource,
    ) -> Result<nibi_kernel_api::attachment::LoadedAttachment, KernelError> {
        self.attachment_content(session, workspace, source).await
    }

    /// `v4/attachment/commit`：一次上传事务的完整内容写进会话 artifact（Node `writePromptAttachment` 同形）。
    async fn store_attachment(
        &self,
        session: &SessionId,
        _file_name: &str,
        media_type: &str,
        bytes: Vec<u8>,
    ) -> Result<nibi_kernel_api::attachment::StoredAttachment, KernelError> {
        self.store_attachment_content(session, media_type, bytes)
            .await
    }

    /// 已发送附件的回读（`v4/attachment/read` 与 share 的 attachmentRead/Stat）。
    async fn read_attachment(
        &self,
        session: &SessionId,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
        source: nibi_kernel_api::attachment::AttachmentSource,
        media_type: &str,
    ) -> Result<nibi_kernel_api::attachment::AttachmentPayload, KernelError> {
        self.read_attachment_content(session, workspace, source, media_type)
            .await
    }

    /// `process/childProcesses`：仍在运行的 MCP 子进程（pid 与归属）。
    async fn mcp_child_processes(&self) -> Vec<nibi_kernel_api::mcp_state::McpChildProcess> {
        // 进程级配置与会话级连接都算（NIBI 的桌面会话走会话级），同一 manager 被继承时只列一次。
        self.ext.mcp_child_processes()
    }

    async fn mcp_resource_targets(&self) -> Vec<nibi_kernel_api::process_table::McpResourceTarget> {
        self.ext.mcp_resource_targets()
    }

    /// NIBI `requestWorkspaceHookReview` 的数据来源：工作区钩子当前的信任快照（只读）。
    async fn workspace_hook_review(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
    ) -> Result<nibi_kernel_api::hook_review::WorkspaceHookReview, KernelError> {
        self.hook_review_snapshot(workspace).await
    }

    /// NIBI `respondWorkspaceHookReview`：按评审项授权持久信任，返回写入条数。
    async fn grant_workspace_hooks(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
        review_item_ids: &[String],
    ) -> Result<usize, KernelError> {
        self.grant_hooks(workspace, review_item_ids).await
    }

    /// NIBI `revokeWorkspaceHookTrust`：按声明摘要撤销持久信任，返回撤掉的条数。
    async fn revoke_workspace_hooks(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
        declaration_digests: &[String],
    ) -> Result<usize, KernelError> {
        self.revoke_hooks(workspace, declaration_digests).await
    }

    /// NIBI `toggleWorkspaceHookReviewItem`：在可编辑的项目配置里改一条钩子的 `enabled`。
    async fn set_workspace_hook_enabled(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
        review_item_id: &str,
        enabled: bool,
    ) -> Result<(), KernelError> {
        self.toggle_hook(workspace, review_item_id, enabled).await
    }

    /// NIBI `workspace/generateText`：无会话的一次性模型补全（Host 的「生成提交信息」）。
    /// Composer 的 `@` 技能引用面板（`skills/referenceCatalog`）：有会话时用该会话的插件快照，
    /// 没有时按当前工作区现扫。内置（bundled）skill 不进面板（Node 同口径）。
    async fn skill_reference_catalog(
        &self,
        session: Option<&nibi_kernel_api::ids::SessionId>,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
    ) -> Result<
        Vec<nibi_kernel_api::listing::SkillReference>,
        nibi_kernel_api::session_api::KernelError,
    > {
        use nibi_kernel_api::listing::{SkillReference, SkillReferenceScope};
        let skills = self.ext.skills().skills_for(session, workspace).await;
        Ok(skills
            .iter()
            .filter_map(|skill| {
                let (scope, plugin_name) = match &skill.source {
                    nibi_kernel_ext::SkillSource::Builtin => return None,
                    nibi_kernel_ext::SkillSource::Plugin { plugin } => {
                        (SkillReferenceScope::Plugin, Some(plugin.clone()))
                    }
                    nibi_kernel_ext::SkillSource::Project => (SkillReferenceScope::Workspace, None),
                    nibi_kernel_ext::SkillSource::Managed
                    | nibi_kernel_ext::SkillSource::User => (SkillReferenceScope::User, None),
                };
                Some(SkillReference {
                    id: format!("glm:{}:{}", scope.as_str(), skill.dir),
                    name: skill.name.clone(),
                    description: skill.description.clone(),
                    path: skill.dir.clone(),
                    scope,
                    enabled: true,
                    plugin_name,
                })
            })
            .collect())
    }

    /// Composer 的 `@` 插件面板（NIBI `plugins/referenceCatalog`）：带会话时用它创建时冻结的目录，
    /// 不带时按当前配置现扫工作区（Node 的 workspace authority）。
    async fn plugin_reference_catalog(
        &self,
        session: Option<&SessionId>,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
    ) -> Result<Vec<nibi_kernel_api::listing::PluginReference>, KernelError> {
        let catalog = match session {
            Some(session) => self.ext.session_plugin_catalog(session),
            None => Some(self.workspace_plugin_catalog(workspace).await),
        };
        Ok(catalog
            .map(|catalog| catalog.references)
            .unwrap_or_default())
    }

    /// 推荐插件的安装前解析：已发现的身份条目与官方市场目录里的条目（两者都可缺）。
    async fn suggested_plugin_facts(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
        stable_id: &str,
    ) -> Result<nibi_kernel_api::listing::SuggestedPluginFacts, KernelError> {
        let catalog = self.workspace_plugin_catalog(workspace).await;
        Ok(nibi_kernel_api::listing::SuggestedPluginFacts {
            entry: catalog
                .references
                .into_iter()
                .find(|entry| entry.plugin_id == stable_id),
            listing: catalog
                .listings
                .into_iter()
                .find(|listing| listing.plugin_id == stable_id),
        })
    }

    async fn generate_text(
        &self,
        request: nibi_kernel_api::generate_text::GenerateTextRequest,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<nibi_kernel_api::generate_text::GenerateTextReply, KernelError> {
        crate::generate_text::run(self, request, cancel).await
    }

    /// NIBI 快照的 `sharedContextImport`：冷打开时从 `session_entry` 读出。
    async fn shared_context_import(
        &self,
        session: &SessionId,
    ) -> Result<Option<nibi_kernel_api::shared_context::SharedContextImportState>, KernelError>
    {
        self.shared_context_state(session).await
    }

    /// NIBI `discardSharedContext`：`pending` → `discarded`。
    async fn discard_shared_context(
        &self,
        session: &SessionId,
        context_id: &str,
    ) -> Result<Option<nibi_kernel_api::shared_context::SharedContextImportState>, KernelError>
    {
        self.discard_import(session, context_id).await
    }

    /// 会话发起的 DWF run（只读，`dwf_run` 表；引擎在 Node 侧写）。
    async fn dynamic_workflow_runs(
        &self,
        session: &SessionId,
    ) -> Result<Vec<nibi_kernel_api::workflow::DynamicWorkflowRun>, KernelError> {
        self.ports
            .store
            .workflow_runs(session)
            .await
            .map_err(|error| failed(&error))
    }

    /// 本会话的 run 目录（`v4/conversation/workflowRuns`）。
    async fn workflow_run_summaries(
        &self,
        session: &SessionId,
        limit: usize,
    ) -> Result<Vec<nibi_kernel_api::workflow::WorkflowRunSummaryRow>, KernelError> {
        self.ports
            .store
            .workflow_run_summaries(session, limit)
            .await
            .map_err(|error| failed(&error))
    }

    /// 一个 run 的事件日志的一页（`v4/conversation/workflowRunEvents`）。
    async fn workflow_run_events(
        &self,
        session: &SessionId,
        run_id: &str,
        query: nibi_kernel_api::workflow::WorkflowRunEventQuery,
    ) -> Result<nibi_kernel_api::workflow::WorkflowRunEventPage, KernelError> {
        self.ports
            .store
            .workflow_run_events(session, run_id, query)
            .await
            .map_err(|error| failed(&error))
    }

    /// 一个 run 的用户面产物清单（`v4/conversation/workflowRunArtifacts`）。
    async fn workflow_run_artifacts(
        &self,
        session: &SessionId,
        run_id: &str,
    ) -> Result<Option<Vec<nibi_kernel_api::workflow::WorkflowRunArtifactDetail>>, KernelError>
    {
        self.ports
            .store
            .workflow_run_artifacts(session, run_id)
            .await
            .map_err(|error| failed(&error))
    }

    /// 看板取数的一页（`v4/conversation/workflowRunArtifactData`）。
    async fn workflow_run_artifact_items(
        &self,
        session: &SessionId,
        run_id: &str,
        query: nibi_kernel_api::workflow::WorkflowRunArtifactItemQuery,
    ) -> Result<nibi_kernel_api::workflow::WorkflowRunArtifactItemPage, KernelError> {
        self.ports
            .store
            .workflow_run_artifact_items(session, run_id, query)
            .await
            .map_err(|error| failed(&error))
    }

    /// 一个产物版本的字节（`v4/conversation/workflowRunArtifactRead`）。
    async fn workflow_run_artifact_bytes(
        &self,
        session: &SessionId,
        run_id: &str,
        artifact_id: &str,
        version: u64,
    ) -> Result<Option<(Vec<u8>, Option<String>)>, KernelError> {
        self.ports
            .store
            .workflow_run_artifact_bytes(session, run_id, artifact_id, version)
            .await
            .map_err(|error| failed(&error))
    }

    /// 工作区 transcript 清单（`v4/conversation/workflowRunWorkspace`）。
    async fn workflow_run_workspace(
        &self,
        session: &SessionId,
        run_id: &str,
    ) -> Result<Option<Vec<nibi_kernel_api::workflow::WorkflowRunWorkspaceNode>>, KernelError>
    {
        self.ports
            .store
            .workflow_run_workspace(session, run_id)
            .await
            .map_err(|error| failed(&error))
    }

    /// 一个工作区节点的正文（`v4/conversation/workflowRunNodeResult`）。
    async fn workflow_run_node_result(
        &self,
        session: &SessionId,
        run_id: &str,
        site_id: &str,
        ordinal: u64,
        max_bytes: u64,
    ) -> Result<Option<nibi_kernel_api::workflow::WorkflowRunNodeResult>, KernelError> {
        self.ports
            .store
            .workflow_run_node_result(session, run_id, site_id, ordinal, max_bytes)
            .await
            .map_err(|error| failed(&error))
    }

    /// 应用级用量聚合（`v4/usage/stats`）：SQL 在存储，`range` → `[since, until)` 的换算与
    /// 时区偏移在协议层（它才拿得到请求里的 `timeZone`）。
    async fn app_usage(
        &self,
        query: nibi_kernel_api::usage::AppUsageQuery,
    ) -> Result<nibi_kernel_api::usage::AppUsage, KernelError> {
        self.ports
            .store
            .app_usage(query)
            .await
            .map_err(|error| failed(&error))
    }

    /// 会话级 token 用量（`v4/conversation/usage`）。
    async fn session_usage(
        &self,
        session: &SessionId,
    ) -> Result<nibi_kernel_api::usage::SessionUsage, KernelError> {
        self.ports
            .store
            .session_usage(session)
            .await
            .map_err(|error| failed(&error))
    }

    /// NIBI `startSavedWorkflow`：引擎没接时报 Unsupported（与 Node 的 `V4CapabilityUnsupportedError` 同义）。
    async fn start_saved_workflow(
        &self,
        parent: &SessionId,
        request: nibi_kernel_api::workflow::WorkflowStart,
    ) -> Result<nibi_kernel_api::workflow::WorkflowRunStarted, KernelError> {
        let engine = self.workflow_engine.as_ref().ok_or_else(|| KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })?;
        engine
            .start_saved(parent, request)
            .await
            .map_err(|error| workflow_fault(nibi_kernel_api::workflow::SAVED_WORKFLOW_START_REJECTED, error))
    }

    /// NIBI `resumeWorkflowRun`。
    async fn resume_workflow_run(
        &self,
        run_id: &str,
        name: Option<&str>,
    ) -> Result<nibi_kernel_api::workflow::WorkflowRunStarted, KernelError> {
        let engine = self.workflow_engine.as_ref().ok_or_else(|| KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })?;
        engine
            .resume(run_id, name)
            .await
            .map_err(|error| workflow_fault(nibi_kernel_api::workflow::WORKFLOW_RUN_RESUME_REJECTED, error))
    }

    /// `cancelBackgroundWork` 落到 DWF run 上：`workId ≡ runId`。
    async fn cancel_workflow_run(&self, run_id: &str) -> Result<(), KernelError> {
        let engine = self.workflow_engine.as_ref().ok_or_else(|| KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })?;
        engine
            .cancel(run_id)
            .await
            .map_err(|error| workflow_fault(nibi_kernel_api::workflow::WORKFLOW_RUN_RESUME_REJECTED, error))
    }

    /// NIBI `amendWorkflowRunSettings`。
    async fn amend_workflow_run(
        &self,
        request: nibi_kernel_api::workflow::WorkflowAmend,
    ) -> Result<nibi_kernel_api::workflow::WorkflowRunStarted, KernelError> {
        let engine = self.workflow_engine.as_ref().ok_or_else(|| KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })?;
        engine
            .amend(request)
            .await
            .map_err(|error| workflow_fault(nibi_kernel_api::workflow::WORKFLOW_RUN_SETTINGS_REJECTED, error))
    }

    /// 一轮 DWF actor（路线 C：引擎 sidecar 通过它跑 actor 的模型轮）。
    async fn run_workflow_actor(
        &self,
        request: nibi_kernel_api::workflow::WorkflowActorRequest,
        cancel: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<nibi_kernel_api::workflow::WorkflowActorTurn, KernelError> {
        let spec = request.actor;
        // actor 子会话直接经存储建、不经过内核的会话启动路径：继承父会话此刻的动态工作流门，
        // 与 Node 子代理的结构性继承同一条（Host 关灰度时 actor 也看不到三件套）。
        if let Some(gate) = self
            .gate
            .dynamic_workflow_override(&SessionId::new(spec.parent.clone()))
        {
            self.gate
                .set_dynamic_workflow(&SessionId::new(spec.child.clone()), gate);
        }
        let root = spec.workspace.unwrap_or_default();
        let profile = nibi_kernel_agents::ActorProfile {
            parent: SessionId::new(spec.parent),
            child: SessionId::new(spec.child),
            workspace: nibi_kernel_api::env::WorkspaceRef {
                environment: nibi_kernel_api::ids::EnvironmentId::new(
                    nibi_kernel_api::env_registry::LOCAL_MACHINE,
                ),
                root: nibi_kernel_api::env::EnvPath::new(root),
            },
            selection: spec.selection.unwrap_or_else(|| self.defaults.selection.clone()),
            mode: spec.mode.unwrap_or(self.defaults.mode),
            prompt: spec.prompt,
            label: spec.label,
            allow: spec.allow,
            deny: spec.deny,
            max_turns: spec.max_turns,
            submit_schema: spec.submit_schema,
            run_id: spec.run_id,
            actor: spec.actor,
            actor_name: spec.actor_name,
            ask: spec.ask,
            // amend-resume 的转录种子：建会话时由 node-store 兑现（幂等）。
            seed: spec.seed,
            // Actor 侧的升级端口：注册表是内核自己的一份（与主持工具的答题入口共用）。
            escalation: Some(Arc::new(escalations::EscalationPort(
                self.escalations.clone(),
            ))),
        };
        tracing::debug!(
            event = "dwf.kernel.actor",
            parent = profile.parent.as_str(),
            child = profile.child.as_str(),
            label = %profile.label,
        );
        let outcome = self
            .actors
            .run_actor_turn(&profile, &request.message, request.first, cancel)
            .await
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })?;
        Ok(nibi_kernel_api::workflow::WorkflowActorTurn {
            child: outcome.child.as_str().to_owned(),
            text: outcome.text,
            tokens: outcome.tokens,
            tool_uses: outcome.tool_uses,
            stopped: outcome.stopped.to_owned(),
            error: outcome.error,
            submitted: outcome.submitted,
            message_count: outcome.message_count,
        })
    }

    /// 回答一个 actor 升级上来的阻塞问题（主会话的 `ResolveWorkflowQuestion` 工具）。
    async fn resolve_workflow_question(
        &self,
        session: &SessionId,
        qid: &str,
        answer: &str,
    ) -> Result<nibi_kernel_api::workflow::WorkflowQuestionResolved, KernelError> {
        Ok(self.escalations.resolve_question(session, qid, answer).await)
    }

    /// 一个会话名下的 run 还欠答案的问题（按提问顺序）。
    async fn pending_workflow_questions(
        &self,
        session: &SessionId,
    ) -> Result<Vec<nibi_kernel_api::workflow::WorkflowQuestion>, KernelError> {
        Ok(self.escalations.pending(session))
    }

    /// `/plan open`：计划文件的位置（与 ExitPlanMode 同一个来源）与它有没有内容（tui-manage.md §8）。
    async fn plan_file(
        &self,
        query: nibi_kernel_api::manage::PlanFileQuery,
    ) -> Result<nibi_kernel_api::manage::PlanFile, KernelError> {
        directory::plan_file(
            self.machine.info().as_ref(),
            self.machine.files().as_ref(),
            &query,
        )
        .await
    }

    /// `/cd <path>`：检查路径，有会话时经会话 actor 换工作目录（tui-manage.md §7.1）。
    async fn change_directory(
        &self,
        request: nibi_kernel_api::manage::ChangeDirectory,
    ) -> Result<nibi_kernel_api::manage::DirectoryChanged, KernelError> {
        directory::change(self, request).await
    }

    /// `/mcp reconnect|enable|disable`：经 ext 的连接管理（tui-manage.md §6.1）。
    async fn mcp_control(
        &self,
        control: nibi_kernel_api::manage::McpControl,
    ) -> Result<Vec<nibi_kernel_api::manage::McpServerInfo>, KernelError> {
        Ok(self
            .ext
            .mcp()
            .control(control.action, &control.servers)
            .await)
    }

    /// `/usage` 的 API 时长：存储的用量表是唯一来源（docs/specs/rust-cli/usage.md §4）。
    async fn session_metering(
        &self,
        session: &SessionId,
    ) -> Result<nibi_kernel_api::metering::SessionMetering, KernelError> {
        self.ports
            .store
            .metering(session)
            .await
            .map_err(|error| failed(&error))
    }

    /// footer 的请求统计（tui-display.md §2.6、usage.md §4.1，修复线 F27）：存储从用量表聚合。
    async fn request_stats(
        &self,
        session: &SessionId,
    ) -> Result<nibi_kernel_api::metering::RequestStats, KernelError> {
        self.ports
            .store
            .request_stats(session)
            .await
            .map_err(|error| failed(&error))
    }

    /// 活动统计（usage.md §5）：今天与本地日的偏移取自注入的时钟，聚合在存储。
    async fn activity(
        &self,
        range: nibi_kernel_api::metering::ActivityRange,
    ) -> Result<nibi_kernel_api::metering::ActivityStats, KernelError> {
        let clock = &self.ports.clock;
        let query = nibi_kernel_api::metering::ActivityQuery {
            range,
            today: clock.today(),
            utc_offset_minutes: clock.utc_offset_minutes(clock.now_ms()),
        };
        self.ports
            .store
            .activity(query)
            .await
            .map_err(|error| failed(&error))
    }

    /// ← 会话面板：库里的会话合并本进程里打开着的会话的实时状态（tui-panels.md §2.1）。
    async fn workspace_sessions(
        &self,
        filter: SessionFilter,
    ) -> Result<Vec<nibi_kernel_api::panels::WorkspaceSession>, KernelError> {
        self.overview(filter).await
    }

    /// ← 项目页与 `/resume` 页（修复线 F29，tui-panels.md §2.1）。
    async fn project_sessions(
        &self,
        query: nibi_kernel_api::store::SessionQuery,
    ) -> Result<nibi_kernel_api::panels::ProjectSessions, KernelError> {
        self.projects(query).await
    }

    async fn rename_session(&self, session: &SessionId, title: String) -> Result<(), KernelError> {
        self.rename(session, title).await
    }

    async fn close_open_session(&self, session: &SessionId) -> Result<bool, KernelError> {
        self.close_open(session).await
    }

    async fn delete_session(&self, session: &SessionId) -> Result<(), KernelError> {
        self.delete(session).await
    }

    async fn session_snapshot(
        &self,
        session: &SessionId,
    ) -> Result<nibi_kernel_api::session_api::SessionView, KernelError> {
        self.snapshot(session).await
    }

    async fn session_index_fact(
        &self,
        session: &SessionId,
    ) -> Result<Option<nibi_kernel_api::store::SessionIndexFact>, KernelError> {
        self.ports
            .store
            .session_index_fact(session)
            .await
            .map_err(|error| failed(&error))
    }

    /// 旧协议快照的逐条消息时间：node-store 从 `message` 行的 `time_created/time_updated` 读出。
    async fn session_message_times(
        &self,
        session: &SessionId,
    ) -> Result<
        std::collections::HashMap<
            nibi_kernel_api::ids::MessageId,
            nibi_kernel_api::store::MessageTime,
        >,
        KernelError,
    > {
        self.ports
            .store
            .message_times(session)
            .await
            .map_err(|error| failed(&error))
    }

    async fn set_session_tool_policy(
        &self,
        session: &SessionId,
        policy: nibi_kernel_api::permission::ToolPolicy,
    ) -> Result<(), KernelError> {
        self.gate.set_tool_policy(session, policy);
        Ok(())
    }

    /// 前端记录（缺口 G2）：经存储端口原样落库，不经会话 actor（记录不是会话状态）。
    async fn put_session_record(
        &self,
        session: &SessionId,
        record: nibi_kernel_api::store::FrontendRecord,
    ) -> Result<(), KernelError> {
        // 草稿（`persistence: "deferred"`）的外部活动：写前端记录（含 `v4/command_fact`）前先把会话行
        // 落下。Node 的 v4 admission 也在写 `session_input` 前持久化主记录——否则记录没有主行，首条
        // 命令事实会丢。
        if let Some(live) = self.settled(session).await
            && let Err(error) = live.persist_draft().await
        {
            tracing::warn!(%error, %session, "the draft session could not be persisted");
        }
        self.ports
            .store
            .put_record(session, &record)
            .await
            .map_err(|error| match error {
                StoreError::Unsupported { what } => KernelError::Unsupported { what },
                other => failed(&other),
            })
    }

    async fn session_records(
        &self,
        session: &SessionId,
        kind: &str,
    ) -> Result<Vec<nibi_kernel_api::store::FrontendRecord>, KernelError> {
        self.ports
            .store
            .records(session, kind)
            .await
            .map_err(|error| match error {
                StoreError::Unsupported { what } => KernelError::Unsupported { what },
                other => failed(&other),
            })
    }

    /// `/hooks`：hooks 引擎当前快照里的配置（tui-display.md §3.5）。
    async fn hooks(&self) -> Vec<nibi_kernel_api::manage::HookEntry> {
        self.hooks.entries()
    }

    /// `/diff` 的未提交改动：执行环境里 git 的原始输出（tui-manage.md §4.1）。
    async fn uncommitted_diff(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
    ) -> Result<nibi_kernel_api::env_git::GitDiff, KernelError> {
        let request = nibi_kernel_api::env_git::GitDiffRequest {
            cwd: workspace.root.clone(),
        };
        self.local
            .git()
            .git_diff(workspace, request)
            .await
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })
    }

    /// `/export <文件名>`：经执行环境写文件（tui-manage.md §3）。
    async fn write_export(
        &self,
        file: nibi_kernel_api::manage::ExportFile,
    ) -> Result<String, KernelError> {
        export::write(
            self.machine.info().as_ref(),
            self.machine.files().as_ref(),
            self.ports.ids.as_ref(),
            &self.generation,
            file,
        )
        .await
    }

    /// `/permissions` 的列表（tui-manage.md §1.1）。
    async fn permission_rules(
        &self,
        query: nibi_kernel_api::permission::PermissionRulesQuery,
    ) -> Result<Vec<nibi_kernel_api::permission::SourcedRule>, KernelError> {
        permissions::listing(&self.gate, self.ports.store.as_ref(), &query).await
    }

    /// `/permissions` 的修改：落库后换上新快照（tui-manage.md §1.1）。
    async fn change_permission_rules(
        &self,
        change: nibi_kernel_api::permission::PermissionRulesChange,
    ) -> Result<Vec<nibi_kernel_api::permission::SourcedRule>, KernelError> {
        permissions::change(&self.gate, self.ports.store.as_ref(), change).await
    }

    /// TUI 的斜杠补全：ext 给出的可调用 skill（ext.md §2.7）。
    async fn user_commands(
        &self,
        workspace: &nibi_kernel_api::env::WorkspaceRef,
    ) -> Vec<nibi_kernel_api::user_command::UserCommand> {
        self.ext.user_commands().commands(workspace).await
    }
}

/// 已保存工作流目录的降级现拼（Node `savedWorkflowRoot` 同一约定：项目档落
/// `<cwd>/.nibi/workflows/`、全局档落 `~/.nibi/workflows/`——home 取机器事实，协议层不读环境）。
fn saved_workflow_dir(home: Option<String>, workspace_path: &str, scope: &str) -> String {
    let trim = |value: &str| value.trim_end_matches(['/', '\\']).to_owned();
    match scope {
        "global" => home
            .map(|home| format!("{}/.nibi/workflows", trim(&home)))
            .unwrap_or_else(|| format!("{}/.nibi/workflows", trim(workspace_path))),
        _ => format!("{}/.nibi/workflows", trim(workspace_path)),
    }
}

/// sidecar 的失败 → 内核错误（`reason` 兜底、`message` 在场时优先——中枢读/写两面的同一条映射）。
fn workflow_engine_failure(
    error: nibi_kernel_api::workflow::WorkflowEngineError,
) -> KernelError {
    KernelError::Failed {
        message: match error.message {
            Some(message) => message,
            None => error.reason,
        },
    }
}

/// 写面在没有 sidecar 的入口上 fail-closed 的那句话（读面降级成空页，写面没有诚实的空写）。
fn hub_write_unavailable() -> KernelError {
    KernelError::Failed {
        message: "the saved-workflow hub writes need the workflow engine sidecar, which is not wired into this entry".to_owned(),
    }
}

//! 内核会话 API 的本地实现（[`Kernel`]）：建会话、打开会话（冷加载）、列出会话。

use super::*;
use rust_cli_kernel_api::permission::ExecutionState;

/// 引擎的业务拒绝 → `KernelError::Failed`，消息以 Node 的 fault 前缀开头（协议层原样上行 reasonCode）。
fn workflow_fault(
    prefix: &str,
    error: rust_cli_kernel_api::workflow::WorkflowEngineError,
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

#[async_trait]
impl Kernel for LocalKernel {
    async fn create_session(&self, request: CreateSession) -> Result<SessionId, KernelError> {
        self.create_session_as(request, StartSource::Startup).await
    }

    /// 旧会话的询问（agents.md §4.1.2，工作线 F72）。
    fn detached_asks(
        &self,
    ) -> futures_util::stream::BoxStream<'static, rust_cli_kernel_api::orchestration::DetachedEvent>
    {
        self.detached.subscribe()
    }

    async fn resolve_detached(
        &self,
        interaction: &rust_cli_kernel_api::ids::InteractionId,
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
        let id = request.id.unwrap_or_else(|| self.ports.ids.session());
        let meta = SessionMeta {
            id: id.clone(),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: request.workspace,
            title: String::new(),
            // 顶层会话的链路 ID 取会话 ID；子会话、子代理继承父会话的链路 ID。
            trace: TraceId::new(id.as_str()),
            created_at_ms: self.ports.clock.now_ms(),
        };
        self.ports
            .store
            .create(meta.clone())
            .await
            .map_err(|error| failed(&error))?;
        // 执行状态（修复线 F20）：单值的 `plan` 是“plan 开、default”，另记的 `plan` 打开 plan。
        let execution = ExecutionState::from_parts(request.mode, request.plan);
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
            },
            Opened::Created,
        );
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
        };
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

    /// `/context`（context-usage.md §2）：有会话时按会话 actor 的当前视图（历史、模型、模式），只读。
    async fn context_usage(
        &self,
        query: rust_cli_kernel_api::context_usage::ContextUsageQuery,
    ) -> Result<rust_cli_kernel_api::context_usage::ContextUsage, KernelError> {
        let Some(session) = &query.session else {
            return self.usage.analyze(query, &[]).await;
        };
        let view = self.open_session(session).await?.view().await?;
        let query = rust_cli_kernel_api::context_usage::ContextUsageQuery {
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
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
    ) -> Result<Vec<String>, KernelError> {
        let request = rust_cli_kernel_api::env_files::ListFiles {
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
        query: rust_cli_kernel_api::catalog::CatalogQuery,
    ) -> Result<rust_cli_kernel_api::catalog::SessionCatalog, KernelError> {
        Ok(catalog::catalog(&self.usage, &query).await)
    }

    /// `/mcp`、`/status`：ext 的连接管理给出的状态（tui-display.md §3.4）。
    async fn mcp_servers(&self) -> Vec<rust_cli_kernel_api::manage::McpServerInfo> {
        self.ext.mcp().server_infos()
    }

    /// NIBI `createSession.mcpServers`：会话级的 MCP 服务器（连接在后台建立，不等结果）。
    async fn start_session_mcp(
        &self,
        session: &SessionId,
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
        servers: Vec<rust_cli_kernel_api::mcp_session::SessionMcpServer>,
    ) -> Result<(), KernelError> {
        self.ext.start_session_mcp(session, workspace, servers);
        Ok(())
    }

    /// 会话关闭：释放它的会话级 MCP 连接（`Closer` 的 `released` 也调一次，重复调用无副作用）。
    fn stop_session_mcp(&self, session: &SessionId) {
        self.ext.release_session(session);
    }

    /// NIBI `createSession.additionalDirectories`：判决链把它们按"在工作区内"处理，环境段列出它们。
    async fn set_session_directories(
        &self,
        session: &SessionId,
        directories: Vec<rust_cli_kernel_api::env::EnvPath>,
    ) -> Result<(), KernelError> {
        self.directories.set(session, directories);
        Ok(())
    }

    /// NIBI `AttachmentRef`：artifact URI 经会话 artifact 存储，路径经会话所在机器的文件端口。
    async fn load_attachment(
        &self,
        session: &SessionId,
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
        source: rust_cli_kernel_api::attachment::AttachmentSource,
    ) -> Result<rust_cli_kernel_api::attachment::LoadedAttachment, KernelError> {
        self.attachment_content(session, workspace, source).await
    }

    /// NIBI `requestWorkspaceHookReview` 的数据来源：工作区钩子当前的信任快照（只读）。
    async fn workspace_hook_review(
        &self,
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
    ) -> Result<rust_cli_kernel_api::hook_review::WorkspaceHookReview, KernelError> {
        self.hook_review_snapshot(workspace).await
    }

    /// NIBI `respondWorkspaceHookReview`：按评审项授权持久信任，返回写入条数。
    async fn grant_workspace_hooks(
        &self,
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
        review_item_ids: &[String],
    ) -> Result<usize, KernelError> {
        self.grant_hooks(workspace, review_item_ids).await
    }

    /// NIBI `revokeWorkspaceHookTrust`：按声明摘要撤销持久信任，返回撤掉的条数。
    async fn revoke_workspace_hooks(
        &self,
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
        declaration_digests: &[String],
    ) -> Result<usize, KernelError> {
        self.revoke_hooks(workspace, declaration_digests).await
    }

    /// NIBI `toggleWorkspaceHookReviewItem`：在可编辑的项目配置里改一条钩子的 `enabled`。
    async fn set_workspace_hook_enabled(
        &self,
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
        review_item_id: &str,
        enabled: bool,
    ) -> Result<(), KernelError> {
        self.toggle_hook(workspace, review_item_id, enabled).await
    }

    /// NIBI 快照的 `sharedContextImport`：冷打开时从 `session_entry` 读出。
    async fn shared_context_import(
        &self,
        session: &SessionId,
    ) -> Result<Option<rust_cli_kernel_api::shared_context::SharedContextImportState>, KernelError>
    {
        self.shared_context_state(session).await
    }

    /// NIBI `discardSharedContext`：`pending` → `discarded`。
    async fn discard_shared_context(
        &self,
        session: &SessionId,
        context_id: &str,
    ) -> Result<Option<rust_cli_kernel_api::shared_context::SharedContextImportState>, KernelError>
    {
        self.discard_import(session, context_id).await
    }

    /// 会话发起的 DWF run（只读，`dwf_run` 表；引擎在 Node 侧写）。
    async fn dynamic_workflow_runs(
        &self,
        session: &SessionId,
    ) -> Result<Vec<rust_cli_kernel_api::workflow::DynamicWorkflowRun>, KernelError> {
        self.ports
            .store
            .workflow_runs(session)
            .await
            .map_err(|error| failed(&error))
    }

    /// NIBI `startSavedWorkflow`：引擎没接时报 Unsupported（与 Node 的 `V4CapabilityUnsupportedError` 同义）。
    async fn start_saved_workflow(
        &self,
        parent: &SessionId,
        request: rust_cli_kernel_api::workflow::WorkflowStart,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowRunStarted, KernelError> {
        let engine = self.workflow_engine.as_ref().ok_or_else(|| KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })?;
        engine
            .start_saved(parent, request)
            .await
            .map_err(|error| workflow_fault(rust_cli_kernel_api::workflow::SAVED_WORKFLOW_START_REJECTED, error))
    }

    /// NIBI `resumeWorkflowRun`。
    async fn resume_workflow_run(
        &self,
        run_id: &str,
        name: Option<&str>,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowRunStarted, KernelError> {
        let engine = self.workflow_engine.as_ref().ok_or_else(|| KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })?;
        engine
            .resume(run_id, name)
            .await
            .map_err(|error| workflow_fault(rust_cli_kernel_api::workflow::WORKFLOW_RUN_RESUME_REJECTED, error))
    }

    /// `cancelBackgroundWork` 落到 DWF run 上：`workId ≡ runId`。
    async fn cancel_workflow_run(&self, run_id: &str) -> Result<(), KernelError> {
        let engine = self.workflow_engine.as_ref().ok_or_else(|| KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })?;
        engine
            .cancel(run_id)
            .await
            .map_err(|error| workflow_fault(rust_cli_kernel_api::workflow::WORKFLOW_RUN_RESUME_REJECTED, error))
    }

    /// NIBI `amendWorkflowRunSettings`。
    async fn amend_workflow_run(
        &self,
        request: rust_cli_kernel_api::workflow::WorkflowAmend,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowRunStarted, KernelError> {
        let engine = self.workflow_engine.as_ref().ok_or_else(|| KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        })?;
        engine
            .amend(request)
            .await
            .map_err(|error| workflow_fault(rust_cli_kernel_api::workflow::WORKFLOW_RUN_SETTINGS_REJECTED, error))
    }

    /// 一轮 DWF actor（路线 C：引擎 sidecar 通过它跑 actor 的模型轮）。
    async fn run_workflow_actor(
        &self,
        request: rust_cli_kernel_api::workflow::WorkflowActorRequest,
        cancel: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowActorTurn, KernelError> {
        let spec = request.actor;
        let root = spec.workspace.unwrap_or_default();
        let profile = rust_cli_agents::ActorProfile {
            parent: SessionId::new(spec.parent),
            child: SessionId::new(spec.child),
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: rust_cli_kernel_api::ids::EnvironmentId::new(
                    rust_cli_kernel_api::env_registry::LOCAL_MACHINE,
                ),
                root: rust_cli_kernel_api::env::EnvPath::new(root),
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
        Ok(rust_cli_kernel_api::workflow::WorkflowActorTurn {
            child: outcome.child.as_str().to_owned(),
            text: outcome.text,
            tokens: outcome.tokens,
            tool_uses: outcome.tool_uses,
            stopped: outcome.stopped.to_owned(),
            error: outcome.error,
            submitted: outcome.submitted,
        })
    }

    /// 回答一个 actor 升级上来的阻塞问题（主会话的 `ResolveWorkflowQuestion` 工具）。
    async fn resolve_workflow_question(
        &self,
        session: &SessionId,
        qid: &str,
        answer: &str,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowQuestionResolved, KernelError> {
        Ok(self.escalations.resolve_question(session, qid, answer).await)
    }

    /// 一个会话名下的 run 还欠答案的问题（按提问顺序）。
    async fn pending_workflow_questions(
        &self,
        session: &SessionId,
    ) -> Result<Vec<rust_cli_kernel_api::workflow::WorkflowQuestion>, KernelError> {
        Ok(self.escalations.pending(session))
    }

    /// `/plan open`：计划文件的位置（与 ExitPlanMode 同一个来源）与它有没有内容（tui-manage.md §8）。
    async fn plan_file(
        &self,
        query: rust_cli_kernel_api::manage::PlanFileQuery,
    ) -> Result<rust_cli_kernel_api::manage::PlanFile, KernelError> {
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
        request: rust_cli_kernel_api::manage::ChangeDirectory,
    ) -> Result<rust_cli_kernel_api::manage::DirectoryChanged, KernelError> {
        directory::change(self, request).await
    }

    /// `/mcp reconnect|enable|disable`：经 ext 的连接管理（tui-manage.md §6.1）。
    async fn mcp_control(
        &self,
        control: rust_cli_kernel_api::manage::McpControl,
    ) -> Result<Vec<rust_cli_kernel_api::manage::McpServerInfo>, KernelError> {
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
    ) -> Result<rust_cli_kernel_api::metering::SessionMetering, KernelError> {
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
    ) -> Result<rust_cli_kernel_api::metering::RequestStats, KernelError> {
        self.ports
            .store
            .request_stats(session)
            .await
            .map_err(|error| failed(&error))
    }

    /// 活动统计（usage.md §5）：今天与本地日的偏移取自注入的时钟，聚合在存储。
    async fn activity(
        &self,
        range: rust_cli_kernel_api::metering::ActivityRange,
    ) -> Result<rust_cli_kernel_api::metering::ActivityStats, KernelError> {
        let clock = &self.ports.clock;
        let query = rust_cli_kernel_api::metering::ActivityQuery {
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
    ) -> Result<Vec<rust_cli_kernel_api::panels::WorkspaceSession>, KernelError> {
        self.overview(filter).await
    }

    /// ← 项目页与 `/resume` 页（修复线 F29，tui-panels.md §2.1）。
    async fn project_sessions(
        &self,
        query: rust_cli_kernel_api::store::SessionQuery,
    ) -> Result<rust_cli_kernel_api::panels::ProjectSessions, KernelError> {
        self.projects(query).await
    }

    async fn rename_session(&self, session: &SessionId, title: String) -> Result<(), KernelError> {
        self.rename(session, title).await
    }

    async fn delete_session(&self, session: &SessionId) -> Result<(), KernelError> {
        self.delete(session).await
    }

    async fn session_snapshot(
        &self,
        session: &SessionId,
    ) -> Result<rust_cli_kernel_api::session_api::SessionView, KernelError> {
        self.snapshot(session).await
    }

    /// 前端记录（缺口 G2）：经存储端口原样落库，不经会话 actor（记录不是会话状态）。
    async fn put_session_record(
        &self,
        session: &SessionId,
        record: rust_cli_kernel_api::store::FrontendRecord,
    ) -> Result<(), KernelError> {
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
    ) -> Result<Vec<rust_cli_kernel_api::store::FrontendRecord>, KernelError> {
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
    async fn hooks(&self) -> Vec<rust_cli_kernel_api::manage::HookEntry> {
        self.hooks.entries()
    }

    /// `/diff` 的未提交改动：执行环境里 git 的原始输出（tui-manage.md §4.1）。
    async fn uncommitted_diff(
        &self,
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
    ) -> Result<rust_cli_kernel_api::env_git::GitDiff, KernelError> {
        let request = rust_cli_kernel_api::env_git::GitDiffRequest {
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
        file: rust_cli_kernel_api::manage::ExportFile,
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
        query: rust_cli_kernel_api::permission::PermissionRulesQuery,
    ) -> Result<Vec<rust_cli_kernel_api::permission::SourcedRule>, KernelError> {
        permissions::listing(&self.gate, self.ports.store.as_ref(), &query).await
    }

    /// `/permissions` 的修改：落库后换上新快照（tui-manage.md §1.1）。
    async fn change_permission_rules(
        &self,
        change: rust_cli_kernel_api::permission::PermissionRulesChange,
    ) -> Result<Vec<rust_cli_kernel_api::permission::SourcedRule>, KernelError> {
        permissions::change(&self.gate, self.ports.store.as_ref(), change).await
    }

    /// TUI 的斜杠补全：ext 给出的可调用 skill（ext.md §2.7）。
    async fn user_commands(
        &self,
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
    ) -> Vec<rust_cli_kernel_api::user_command::UserCommand> {
        self.ext.user_commands().commands(workspace).await
    }
}

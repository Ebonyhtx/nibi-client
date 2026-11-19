//! 会话控制端口的拥有者实现：把 `WaitSessions` / `SendToSession` 等落到本进程的 `Kernel` 与
//! `SessionHandle` 上。
//!
//! 端口由入口在 `Arc<LocalKernel>` 建好之后经 [`LocalKernel::install_session_control_host`] 注入；没接的
//! 入口（嵌入、测试替身）保持槽为空，工具按 `unavailable` fail closed。这里持有 `Weak<LocalKernel>`
//! 而不是 `Arc`，避免「内核 → 槽 → 端口 → 内核」的引用环。

use std::sync::{Arc, Weak};

use async_trait::async_trait;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{CommandId, EnvironmentId, MessageId, SessionId};
use nibi_kernel_api::message::{ContentBlock, Message, ToolResultContent, UserOrigin};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{
    Ack, Command, CommandEnvelope, CreateSession, Kernel, KernelError, SessionHandle,
};
use nibi_kernel_api::session_control::{
    Admission, CreateSessionInput, CreateSessionResult, CreationStatus, Delivery, ForkSessionInput,
    ForkSessionResult, ForkStatus, InterruptSessionInput, LIST_LIMIT_MAX, ListSessionsInput,
    ListSessionsResult, MutationResult, MutationStatus, OperationRef, READ_LIMIT_DEFAULT,
    ReadSessionInput, ReadSessionResult, ReadView, RenameSessionInput, SendToSessionInput,
    SendToSessionResult, SessionControlActionName, SessionControlError, SessionControlFeed,
    SessionControlHost, SessionMessage, SessionRef, SessionRefKind, SessionStatus, SessionSummary,
    TrustedContext,
};
use nibi_kernel_api::store::{
    SessionDirectoryEntry, SessionDirectoryQuery, SessionFilter, SessionSummary as StoreSummary,
};
use serde_json::json;

use crate::LocalKernel;
use crate::table::{OpenSessions, Slot};

/// 本机会话库的 environment id（node-store 的 `LOCAL_ENVIRONMENT` 同一值；runtime 不依赖 node-store）。
const LOCAL_ENVIRONMENT: &str = "local";

/// 根会话父链的最大深度（防御损坏的父链）。
const MAX_PARENT_DEPTH: usize = 64;

pub(crate) struct KernelSessionControlHost {
    kernel: Weak<LocalKernel>,
    /// 创建/分叉出真实会话后通知 Host 补列表行；CLI/TUI 没有 Host 时为 None。
    created_notifier:
        Option<Arc<dyn nibi_kernel_api::session_control::SessionControlCreatedNotifier>>,
    /// App Host 任务索引的归档事实；独立 CLI/TUI 为 None。
    archive_reader: Option<Arc<dyn nibi_kernel_api::session_control::SessionArchiveReader>>,
}

impl KernelSessionControlHost {
    pub(crate) fn new(
        kernel: Weak<LocalKernel>,
        created_notifier: Option<
            Arc<dyn nibi_kernel_api::session_control::SessionControlCreatedNotifier>,
        >,
        archive_reader: Option<
            Arc<dyn nibi_kernel_api::session_control::SessionArchiveReader>,
        >,
    ) -> Self {
        Self {
            kernel,
            created_notifier,
            archive_reader,
        }
    }

    fn notify_created(&self, caller: &str, session: &str, workspace: &str) {
        if let Some(notifier) = self.created_notifier.as_ref() {
            notifier.session_created(caller, session, workspace);
        }
    }

    fn kernel(&self) -> Result<std::sync::Arc<LocalKernel>, SessionControlError> {
        self.kernel.upgrade().ok_or_else(|| {
            SessionControlError::unavailable("The NIBI kernel is no longer available")
        })
    }
}

fn unavailable(error: impl std::fmt::Display) -> SessionControlError {
    SessionControlError::unavailable(error.to_string())
}

fn forbidden_scope() -> SessionControlError {
    SessionControlError::forbidden("Target is outside the trusted scope")
}

fn session_ref(entry: &SessionDirectoryEntry) -> SessionRef {
    SessionRef {
        kind: SessionRefKind::Cli,
        workspace_path: entry.directory.clone(),
        workspace_identity: None,
        session_id: entry.id.as_str().to_owned(),
    }
}

fn workspace_ref(path: &str) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new(LOCAL_ENVIRONMENT),
        root: EnvPath::new(path),
    }
}

/// 打开着的会话句柄（不冷加载、不启动 actor）。
fn open_handle(
    kernel: &LocalKernel,
    session: &SessionId,
) -> Option<std::sync::Arc<dyn SessionHandle>> {
    let sessions: &OpenSessions = &kernel.sessions;
    let table = sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    table
        .get(session)
        .and_then(Slot::open)
        .cloned()
        .map(|handle| handle as std::sync::Arc<dyn SessionHandle>)
}

async fn directory_entry(
    kernel: &LocalKernel,
    session: &SessionId,
) -> Result<Option<SessionDirectoryEntry>, SessionControlError> {
    let entries = kernel
        .session_directory(SessionDirectoryQuery {
            directory: None,
            ids: Some(vec![session.clone()]),
            limit: 1,
        })
        .await;
    match entries {
        Ok(entries) => Ok(entries.into_iter().next()),
        // 目录读面缺席（精简存储、嵌入、测试替身）或失败时退回按 ID 冷读：身份与父链以会话行为准。
        Err(_) => match kernel.ports.store.load(session).await {
            Ok(loaded) => Ok(Some(directory_row(loaded.meta))),
            Err(nibi_kernel_api::store::StoreError::NotFound { .. }) => Ok(None),
            Err(error) => Err(unavailable(error)),
        },
    }
}

fn directory_row(meta: nibi_kernel_api::store::SessionMeta) -> SessionDirectoryEntry {
    let task_type = match meta.kind {
        nibi_kernel_api::store::SessionKind::Subagent => "subagent_child",
        nibi_kernel_api::store::SessionKind::Fork => "fork",
        nibi_kernel_api::store::SessionKind::SelectionSideChat => "selection_side_chat",
        nibi_kernel_api::store::SessionKind::Interactive => "interactive",
    };
    SessionDirectoryEntry {
        id: meta.id,
        parent: meta.parent,
        trace: Some(meta.trace.as_str().to_owned()),
        task_type: task_type.to_owned(),
        title: meta.title,
        title_source: None,
        workspace_id: None,
        directory: meta.workspace.root.as_str().to_owned(),
        path: None,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.created_at_ms,
    }
}

/// 只解析根会话：子代理会话不是会话控制的合法目标。
async fn resolve(
    kernel: &LocalKernel,
    session_id: &str,
) -> Result<Option<SessionRef>, SessionControlError> {
    let Some(entry) = directory_entry(kernel, &SessionId::new(session_id)).await? else {
        return Ok(None);
    };
    if entry.task_type == "subagent_child" {
        return Ok(None);
    }
    Ok(Some(session_ref(&entry)))
}

fn available_actions() -> Vec<SessionControlActionName> {
    vec![
        SessionControlActionName::ReadSession,
        SessionControlActionName::SendToSession,
        SessionControlActionName::ForkSession,
        SessionControlActionName::InterruptSession,
        SessionControlActionName::RenameSession,
        SessionControlActionName::WaitSessions,
    ]
}

async fn summary(kernel: &LocalKernel, session: SessionRef, title: String) -> SessionSummary {
    let id = SessionId::new(session.session_id.clone());
    let (status, execution_id) = match open_handle(kernel, &id) {
        Some(handle) if !handle.is_closed() => {
            let facts = handle.residency_facts().await.ok();
            let execution = handle.current_execution().await.ok().flatten();
            let status = match facts {
                Some(facts) if facts.pending_interactions > 0 => SessionStatus::NeedsAttention,
                Some(facts) if facts.running => SessionStatus::Running,
                Some(_) => SessionStatus::Idle,
                None => SessionStatus::Unknown,
            };
            (status, execution)
        }
        // 不在本进程打开：没有运行实例，按空闲读（本进程是唯一的执行者）。
        _ => (SessionStatus::Idle, None),
    };
    SessionSummary {
        session,
        title,
        status,
        available_actions: available_actions(),
        updated_at: None,
        execution_id,
        archived: None,
        pinned: None,
    }
}

fn parse_cursor(cursor: Option<&str>) -> Result<usize, SessionControlError> {
    match cursor {
        None => Ok(0),
        Some(text) => text
            .parse::<usize>()
            .map_err(|_| SessionControlError::invalid_input("cursor is not a valid page offset")),
    }
}

fn message_role(message: &Message) -> &'static str {
    match message {
        Message::User(user) => match user.origin {
            UserOrigin::ToolResult { .. } => "tool",
            _ => "user",
        },
        Message::Assistant(_) => "assistant",
        Message::System(_) => "system",
        Message::Attachment(_) => "system",
    }
}

fn message_text(message: &Message) -> String {
    let mut parts: Vec<String> = Vec::new();
    match message {
        Message::User(user) => {
            for block in &user.content {
                match block {
                    ContentBlock::Text { text } => parts.push(text.clone()),
                    ContentBlock::ToolResult { content, .. } => {
                        for result in content {
                            if let ToolResultContent::Text { text } = result {
                                parts.push(text.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        Message::Assistant(assistant) => {
            for block in &assistant.content {
                match block {
                    ContentBlock::Text { text } => parts.push(text.clone()),
                    ContentBlock::ToolUse { name, .. } => parts.push(format!("[tool: {name}]")),
                    _ => {}
                }
            }
        }
        Message::System(system) => parts.push(match system {
            nibi_kernel_api::message::SystemMessage::CompactBoundary(_) => {
                "[compaction boundary]".to_owned()
            }
            nibi_kernel_api::message::SystemMessage::Interrupted { .. } => {
                "[interrupted]".to_owned()
            }
        }),
        Message::Attachment(attachment) => parts.push(attachment.text.clone()),
    }
    parts.join("\n")
}

fn kernel_error(error: KernelError) -> SessionControlError {
    match error {
        KernelError::NotFound { .. } => forbidden_scope(),
        KernelError::Unsupported { what } => {
            SessionControlError::unavailable(format!("session control is unsupported: {what}"))
        }
        KernelError::Failed { message } => unavailable(message),
    }
}

/// 模型目录里按 id 解析一个模型：`modelId` 或 `providerId/modelId`，必须恰好命中一个。
async fn resolve_model(
    kernel: &LocalKernel,
    model: &str,
) -> Result<ModelSelection, SessionControlError> {
    let Some(directory) = kernel.model_directory() else {
        return Err(SessionControlError::invalid_input(
            "A model id cannot be resolved because no model directory is configured",
        ));
    };
    let catalog = directory.catalog().await;
    let matches: Vec<&nibi_kernel_api::provider::CatalogModel> = catalog
        .models
        .iter()
        .filter(|entry| {
            entry.model == model || format!("{}/{}", entry.provider, entry.model) == model
        })
        .collect();
    match matches.as_slice() {
        [entry] => Ok(ModelSelection {
            provider: entry.provider.clone(),
            model: entry.model.clone(),
            reasoning: None,
            connection: None,
        }),
        [] => Err(SessionControlError::invalid_input(format!(
            "No configured model matches {model:?}"
        ))),
        _ => Err(SessionControlError::invalid_input(format!(
            "More than one configured model matches {model:?}"
        ))),
    }
}

fn ack_admission(ack: Ack) -> (Admission, Delivery, Option<String>) {
    match ack {
        Ack::Accepted { .. } => (Admission::Accepted, Delivery::StartNow, None),
        Ack::Rejected { reason } => (Admission::Rejected, Delivery::None, Some(reason)),
        // 同一个 command id 已经提交过：已准入，但这一进程不知道投递阶段。
        Ack::Duplicate => (Admission::Accepted, Delivery::Unknown, None),
    }
}

fn ack_mutation(ack: Ack, request_id: &str) -> MutationResult {
    match ack {
        Ack::Accepted { .. } => MutationResult {
            status: MutationStatus::Applied,
            request_id: request_id.to_owned(),
            reason: None,
        },
        Ack::Rejected { reason } => MutationResult {
            status: MutationStatus::Rejected,
            request_id: request_id.to_owned(),
            reason: Some(reason),
        },
        Ack::Duplicate => MutationResult {
            status: MutationStatus::Unknown,
            request_id: request_id.to_owned(),
            reason: Some("a command with this requestId was already submitted".to_owned()),
        },
    }
}

fn envelope(request_id: &str, command: Command) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(request_id),
        command,
    }
}

/// 跨会话发送的 canonical intent：目标会话的行上显示来源会话（Node 的
/// `metadata.conversationInputIntent.source` 同一键）。标题故意不落库——它是会过期的
/// 派生展示字段，UI 按项目目录用 sessionId 解析。
fn session_source_intent(
    prompt: &str,
    request_id: &str,
    caller_session_id: &str,
) -> serde_json::Value {
    json!({
        "text": prompt,
        "sourceCommandId": request_id,
        "source": { "kind": "session", "sessionId": caller_session_id },
    })
}

/// 中断的精确执行校验：模型必须回传当前执行身份，否则拒绝（不猜、不停错执行）。
fn execution_mismatch(current: Option<&str>, expected: &str) -> Option<String> {
    match current {
        Some(current) if current == expected => None,
        Some(current) => Some(format!(
            "expectedExecutionId does not match the current execution ({current})"
        )),
        None => Some("The session is not executing".to_owned()),
    }
}

#[async_trait]
impl SessionControlHost for KernelSessionControlHost {
    async fn resolve_session(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionRef>, SessionControlError> {
        let kernel = self.kernel()?;
        resolve(&kernel, session_id).await
    }

    async fn is_session_archived(
        &self,
        session: &SessionRef,
    ) -> Result<bool, SessionControlError> {
        // 本机 CLI 存储没有归档字段；只有 App Host 注入 reader 时才有权威事实。
        // reader 返回 None 表示来源不可确认，保持既有 fork 语义而不是猜测。
        match self.archive_reader.as_ref() {
            Some(reader) => Ok(reader.is_session_archived(session).await?.unwrap_or(false)),
            None => Ok(false),
        }
    }

    async fn root_session(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionRef>, SessionControlError> {
        let kernel = self.kernel()?;
        let mut current = SessionId::new(session_id);
        let mut last: Option<SessionRef> = None;
        for _ in 0..MAX_PARENT_DEPTH {
            let Some(entry) = directory_entry(&kernel, &current).await? else {
                return Ok(last);
            };
            last = Some(session_ref(&entry));
            match entry.parent {
                Some(parent) => current = parent,
                None => break,
            }
        }
        Ok(last)
    }

    async fn list_sessions(
        &self,
        ctx: &TrustedContext,
        input: ListSessionsInput,
    ) -> Result<ListSessionsResult, SessionControlError> {
        let kernel = self.kernel()?;
        let workspace = workspace_ref(&ctx.root_session.workspace_path);
        let offset = parse_cursor(input.cursor.as_deref())?;
        let limit = input
            .limit
            .unwrap_or(READ_LIMIT_DEFAULT)
            .min(LIST_LIMIT_MAX) as usize;
        let query = input.query.map(|query| query.to_lowercase());
        // 有标题过滤时多取一些再过滤；没有时只取到本页末尾加一条（判断是否还有下一页）。
        let fetch = if query.is_some() {
            10_000
        } else {
            offset.saturating_add(limit).saturating_add(1)
        };
        let rows = kernel
            .list_sessions(SessionFilter {
                workspace,
                limit: fetch,
            })
            .await
            .map_err(kernel_error)?;
        let filtered: Vec<StoreSummary> = match &query {
            Some(query) => rows
                .into_iter()
                .filter(|row| row.title.to_lowercase().contains(query))
                .collect(),
            None => rows,
        };
        let total = filtered.len();
        let page: Vec<StoreSummary> = filtered.into_iter().skip(offset).take(limit).collect();
        let mut sessions = Vec::with_capacity(page.len());
        for row in page {
            let reference = SessionRef {
                kind: SessionRefKind::Cli,
                workspace_path: ctx.root_session.workspace_path.clone(),
                workspace_identity: None,
                session_id: row.id.as_str().to_owned(),
            };
            sessions.push(summary(&kernel, reference, row.title).await);
        }
        let next = offset.saturating_add(sessions.len()) < total;
        Ok(ListSessionsResult {
            sessions,
            next_cursor: next.then(|| offset.saturating_add(limit).to_string()),
        })
    }

    async fn read_session(
        &self,
        _ctx: &TrustedContext,
        input: ReadSessionInput,
    ) -> Result<ReadSessionResult, SessionControlError> {
        let kernel = self.kernel()?;
        let id = SessionId::new(input.session.session_id.clone());
        let view = kernel.session_snapshot(&id).await.map_err(kernel_error)?;
        if view.meta.id != id {
            return Err(SessionControlError::invalid_output(
                "Owner returned a different session",
            ));
        }
        let reference = SessionRef {
            kind: SessionRefKind::Cli,
            workspace_path: view.meta.workspace.root.as_str().to_owned(),
            workspace_identity: None,
            session_id: view.meta.id.as_str().to_owned(),
        };
        match input.view {
            ReadView::Summary => Ok(ReadSessionResult::Summary {
                summary: summary(&kernel, reference, view.meta.title).await,
            }),
            ReadView::Messages => {
                let offset = parse_cursor(input.cursor.as_deref())?;
                let limit = input
                    .limit
                    .unwrap_or(READ_LIMIT_DEFAULT)
                    .min(LIST_LIMIT_MAX) as usize;
                let total = view.messages.len();
                let messages: Vec<SessionMessage> = view
                    .messages
                    .iter()
                    .skip(offset)
                    .take(limit)
                    .map(|message| SessionMessage {
                        id: message.id().as_str().to_owned(),
                        role: message_role(message).to_owned(),
                        text: message_text(message),
                    })
                    .collect();
                let next = offset.saturating_add(messages.len()) < total;
                Ok(ReadSessionResult::Messages {
                    session: reference,
                    messages,
                    next_cursor: next.then(|| offset.saturating_add(limit).to_string()),
                })
            }
        }
    }

    async fn create_session(
        &self,
        ctx: &TrustedContext,
        input: CreateSessionInput,
    ) -> Result<CreateSessionResult, SessionControlError> {
        let kernel = self.kernel()?;
        let workspace = workspace_ref(&ctx.root_session.workspace_path);
        let selection = match input.model.as_deref() {
            Some(model) => resolve_model(&kernel, model).await?,
            None => kernel.defaults.selection.clone(),
        };
        let id = kernel
            .create_session(CreateSession {
                id: None,
                workspace: workspace.clone(),
                selection,
                mode: PermissionMode::Default,
                plan: false,
            })
            .await
            .map_err(kernel_error)?;
        let handle = kernel.open_session(&id).await.map_err(kernel_error)?;
        let session = SessionRef {
            kind: SessionRefKind::Cli,
            workspace_path: workspace.root.as_str().to_owned(),
            workspace_identity: None,
            session_id: id.as_str().to_owned(),
        };
        let ack = handle
            .send(envelope(
                &input.request_id,
                Command::Submit {
                    text: input.prompt,
                    attachments: Vec::new(),
                    delivery: nibi_kernel_api::session_api::Delivery::Queue,
                },
            ))
            .await;
        let (admission, delivery, reason) = ack_admission(ack);
        // 首条输入已提交后再通知 Host：回源摘要能看到真实会话，不会制造空占位行。
        self.notify_created(
            &ctx.root_session.session_id,
            id.as_str(),
            workspace.root.as_str(),
        );
        let operation = (admission == Admission::Accepted).then(|| OperationRef {
            session: session.clone(),
            session_id: session.session_id.clone(),
            command_id: input.request_id.clone(),
        });
        Ok(CreateSessionResult {
            request_id: input.request_id,
            creation: CreationStatus::Created,
            first_input: admission,
            delivery,
            session: Some(session),
            operation,
            reason,
        })
    }

    async fn fork_session(
        &self,
        _ctx: &TrustedContext,
        input: ForkSessionInput,
    ) -> Result<ForkSessionResult, SessionControlError> {
        let kernel = self.kernel()?;
        let handle = kernel
            .open_session(&SessionId::new(input.session.session_id.clone()))
            .await
            .map_err(kernel_error)?;
        let ack = handle
            .send(envelope(
                &input.request_id,
                Command::Fork {
                    at: Some(MessageId::new(input.at_message)),
                    child: None,
                    cwd: None,
                },
            ))
            .await;
        match ack {
            Ack::Accepted { result } => {
                let Some(id) = result.as_str() else {
                    return Err(SessionControlError::invalid_output(
                        "Fork did not return a session id",
                    ));
                };
                self.notify_created(
                    &input.session.session_id,
                    id,
                    &input.session.workspace_path,
                );
                Ok(ForkSessionResult {
                    status: ForkStatus::Created,
                    session: Some(SessionRef {
                        kind: SessionRefKind::Cli,
                        workspace_path: input.session.workspace_path.clone(),
                        workspace_identity: None,
                        session_id: id.to_owned(),
                    }),
                    request_id: input.request_id,
                    reason: None,
                })
            }
            Ack::Rejected { reason } => Ok(ForkSessionResult {
                status: ForkStatus::Rejected,
                session: None,
                request_id: input.request_id,
                reason: Some(reason),
            }),
            Ack::Duplicate => Ok(ForkSessionResult {
                status: ForkStatus::Unknown,
                session: None,
                request_id: input.request_id,
                reason: Some("a fork with this requestId was already submitted".to_owned()),
            }),
        }
    }

    async fn send_to_session(
        &self,
        ctx: &TrustedContext,
        input: SendToSessionInput,
    ) -> Result<SendToSessionResult, SessionControlError> {
        let kernel = self.kernel()?;
        let handle = kernel
            .open_session(&SessionId::new(input.session.session_id.clone()))
            .await
            .map_err(kernel_error)?;
        let busy = handle
            .view()
            .await
            .map(|view| view.running || !view.queue.is_empty())
            .unwrap_or(true);
        // 先记意图再提交（与协议层 `RecordInputIntent` 同一顺序）；消息落库时按开启
        // 本回合的 commandId 取走，投影据此在目标会话显示“来自会话 X”。
        let _ = handle
            .send(envelope(
                &format!("{}:intent", input.request_id),
                Command::RecordInputIntent {
                    command: CommandId::new(input.request_id.as_str()),
                    intent: session_source_intent(
                        &input.prompt,
                        &input.request_id,
                        &ctx.root_session.session_id,
                    ),
                },
            ))
            .await;
        let ack = handle
            .send(envelope(
                &input.request_id,
                Command::Submit {
                    text: input.prompt,
                    attachments: Vec::new(),
                    delivery: nibi_kernel_api::session_api::Delivery::Queue,
                },
            ))
            .await;
        let (admission, mut delivery, reason) = ack_admission(ack);
        if admission == Admission::Accepted && delivery == Delivery::StartNow && busy {
            delivery = Delivery::Queued;
        }
        let operation = OperationRef {
            session: input.session.clone(),
            session_id: input.session.session_id.clone(),
            command_id: input.request_id.clone(),
        };
        Ok(SendToSessionResult {
            request_id: input.request_id,
            session: input.session,
            operation,
            admission,
            delivery,
            reason,
        })
    }

    async fn interrupt_session(
        &self,
        _ctx: &TrustedContext,
        input: InterruptSessionInput,
    ) -> Result<MutationResult, SessionControlError> {
        let kernel = self.kernel()?;
        let handle = kernel
            .open_session(&SessionId::new(input.session.session_id.clone()))
            .await
            .map_err(kernel_error)?;
        let current = handle.current_execution().await.map_err(kernel_error)?;
        if let Some(reason) = execution_mismatch(current.as_deref(), &input.expected_execution_id) {
            return Ok(MutationResult {
                status: MutationStatus::Rejected,
                request_id: input.request_id.clone(),
                reason: Some(reason),
            });
        }
        let ack = handle
            .send(envelope(&input.request_id, Command::Interrupt))
            .await;
        Ok(ack_mutation(ack, &input.request_id))
    }

    async fn rename_session(
        &self,
        _ctx: &TrustedContext,
        input: RenameSessionInput,
    ) -> Result<MutationResult, SessionControlError> {
        let kernel = self.kernel()?;
        let handle = kernel
            .open_session(&SessionId::new(input.session.session_id.clone()))
            .await
            .map_err(kernel_error)?;
        let ack = handle
            .send(envelope(
                &input.request_id,
                Command::Rename { title: input.title },
            ))
            .await;
        Ok(ack_mutation(ack, &input.request_id))
    }

    async fn open_observation(
        &self,
        _ctx: &TrustedContext,
        operation: &OperationRef,
    ) -> Result<Box<dyn SessionControlFeed>, SessionControlError> {
        let kernel = self.kernel()?;
        crate::session_control_feed::open(&kernel, operation).await
    }
}
#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use nibi_kernel_api::permission::PermissionMode;
    use nibi_kernel_api::session_control::{
        Admission, CreateSessionInput, InterruptSessionInput, ListSessionsInput, MutationStatus,
        OperationStatus, OperationUpdate, ReadSessionInput, ReadSessionResult, ReadView,
        RenameSessionInput, Scope, SendToSessionInput, SessionRef, SessionRefKind, TrustedContext,
    };
    use nibi_kernel_api::testing::{
        FixedClock, MemoryStore, ScriptedModel, SequentialIds, UnusedEnvironment, environments,
        selection, text_response,
    };

    use super::{execution_mismatch, session_source_intent};
    use crate::{ContextConfig, Defaults, LocalKernel, Ports, Surface};

    #[test]
    fn send_to_session_records_the_callers_session_as_source() {
        let intent = session_source_intent("again", "req-2", "sess_root");
        assert_eq!(intent["text"], "again");
        assert_eq!(intent["sourceCommandId"], "req-2");
        assert_eq!(intent["source"]["kind"], "session");
        assert_eq!(intent["source"]["sessionId"], "sess_root");
        // 新数据不写标题快照：标题由 UI 按 sessionId 从项目目录解析。
        assert!(intent["source"].get("title").is_none());
    }

    #[test]
    fn interrupt_requires_the_exact_current_execution() {
        assert_eq!(execution_mismatch(Some("turn_1"), "turn_1"), None);
        assert!(
            execution_mismatch(Some("turn_2"), "turn_1")
                .unwrap_or_default()
                .contains("does not match")
        );
        assert!(
            execution_mismatch(None, "turn_1")
                .unwrap_or_default()
                .contains("not executing")
        );
    }

    fn trusted() -> TrustedContext {
        let root = SessionRef {
            kind: SessionRefKind::Cli,
            workspace_path: "/work".to_owned(),
            workspace_identity: None,
            session_id: "sess_root".to_owned(),
        };
        TrustedContext {
            caller_id: "sess_root".to_owned(),
            root_session: root.clone(),
            allowed_scopes: vec![Scope::from(&root)],
            trace_id: None,
            turn_id: None,
            tool_call_id: None,
        }
    }

    /// 端到端：真实的 `LocalKernel` + 内存存储，创建会话、读回、观察完成、改名与列表都走端口。
    #[tokio::test]
    async fn the_host_drives_a_real_kernel_session() {
        let store = Arc::new(MemoryStore::default());
        let kernel = Arc::new(LocalKernel::with_context(
            Ports {
                model: Arc::new(ScriptedModel::new(vec![
                    text_response(&["hi"]),
                    text_response(&["again"]),
                ])),
                environments: environments(Arc::new(UnusedEnvironment)),
                store: store.clone(),
                artifacts: store,
                clock: Arc::new(FixedClock(1_000)),
                ids: Arc::new(SequentialIds::default()),
            },
            Defaults {
                selection: selection(),
                mode: PermissionMode::Default,
                max_turns: None,
                search_tools: false,
                task_tools: None,
                limits: Default::default(),
            },
            ContextConfig::new(Surface::Interactive),
        ));
        kernel.install_session_control_host();
        let host = kernel
            .session_control_host
            .get()
            .cloned()
            .expect("the host slot is filled");
        let ctx = trusted();

        let created = host
            .create_session(
                &ctx,
                CreateSessionInput {
                    prompt: "hello".to_owned(),
                    model: None,
                    request_id: "req-1".to_owned(),
                },
            )
            .await
            .expect("create");
        let session = created.session.clone().expect("created session");
        let operation = created.operation.clone().expect("first-input operation");
        assert_eq!(
            host.resolve_session(&session.session_id)
                .await
                .expect("resolve")
                .map(|resolved| resolved.workspace_path),
            Some("/work".to_owned())
        );

        // 观察流：baseline 之后等它结算（模型脚本已经给出回复）。
        let mut feed = host
            .open_observation(&ctx, &operation)
            .await
            .expect("observation");
        let mut status = feed.initial().status;
        for _ in 0..200 {
            if status.is_settled() {
                break;
            }
            let update = tokio::time::timeout(std::time::Duration::from_secs(2), feed.recv())
                .await
                .expect("observation update");
            match update {
                Some(OperationUpdate::Snapshot { snapshot }) => status = snapshot.status,
                Some(OperationUpdate::Invalidated { .. }) | None => break,
            }
        }
        feed.close().await;
        assert_eq!(status, OperationStatus::Completed);

        let read = host
            .read_session(
                &ctx,
                ReadSessionInput {
                    session: session.clone(),
                    view: ReadView::Messages,
                    cursor: None,
                    limit: None,
                },
            )
            .await
            .expect("read");
        match read {
            ReadSessionResult::Messages { messages, .. } => {
                assert!(
                    messages
                        .iter()
                        .any(|message| message.text.contains("hello")),
                    "{messages:?}"
                );
            }
            ReadSessionResult::Summary { .. } => panic!("expected messages"),
        }

        let listed = host
            .list_sessions(
                &ctx,
                ListSessionsInput {
                    query: None,
                    cursor: None,
                    limit: Some(10),
                },
            )
            .await
            .expect("list");
        assert!(
            listed
                .sessions
                .iter()
                .any(|row| row.session.session_id == session.session_id),
            "{listed:?}"
        );

        // SendToSession + WaitSessions：第二次输入在空闲目标上直接开跑并结算。
        let sent = host
            .send_to_session(
                &ctx,
                SendToSessionInput {
                    session: session.clone(),
                    prompt: "again".to_owned(),
                    request_id: "req-2".to_owned(),
                },
            )
            .await
            .expect("send");
        assert_eq!(sent.admission, Admission::Accepted);
        let mut feed = host
            .open_observation(&ctx, &sent.operation)
            .await
            .expect("sent observation");
        let mut status = feed.initial().status;
        for _ in 0..200 {
            if status.is_settled() {
                break;
            }
            let update = tokio::time::timeout(std::time::Duration::from_secs(2), feed.recv())
                .await
                .expect("sent observation update");
            match update {
                Some(OperationUpdate::Snapshot { snapshot }) => status = snapshot.status,
                Some(OperationUpdate::Invalidated { .. }) | None => break,
            }
        }
        feed.close().await;
        assert_eq!(status, OperationStatus::Completed);

        // 空闲会话没有当前执行：任何 expectedExecutionId 都必须被拒绝。
        let interrupt = host
            .interrupt_session(
                &ctx,
                InterruptSessionInput {
                    session: session.clone(),
                    expected_execution_id: "exec-old".to_owned(),
                    request_id: "req-3".to_owned(),
                },
            )
            .await
            .expect("interrupt");
        assert_eq!(interrupt.status, MutationStatus::Rejected);

        let renamed = host
            .rename_session(
                &ctx,
                RenameSessionInput {
                    session,
                    title: "Renamed".to_owned(),
                    request_id: "req-4".to_owned(),
                },
            )
            .await
            .expect("rename");
        assert_eq!(renamed.status, MutationStatus::Applied);
    }
}

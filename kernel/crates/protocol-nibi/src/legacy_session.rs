//! 旧协议会话入口（141 审计 F5）：`session/create|resume|messages|send|compact|goal|setModel|
//! setThoughtLevel|setMode`。Host 仍走旧词表（任务适配器、时间线、设置面板），切默认后这些
//! 方法不能回 `-32601`；这里把参数映射到已收的 v4 语义（`CreateSession` / `Command`），响应
//! 统一用 [`crate::legacy_snapshot`] 的旧快照形状。

use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::message::ContentBlock;
use nibi_kernel_api::permission::ToolPolicy;
use nibi_kernel_api::session_api::ImportedMessage;
use nibi_kernel_api::session_api::{
    Ack as KernelAck, Command, CreateSession, Delivery, KernelError, SessionHandle, SessionView,
};
use nibi_kernel_api::store::SessionKind;
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::commands;
use crate::legacy_snapshot::{self, Profile};
use crate::server::{Server, kernel_error};

const REVISION_MISMATCH: i64 = -32009;
const REQUEST_REJECTED: i64 = -32010;

fn session_id(params: &Value) -> Result<SessionId, RpcError> {
    params["sessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(SessionId::new)
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))
}

fn check_revision(view: &SessionView, params: &Value) -> Result<(), RpcError> {
    let Some(expected) = params["expectedRevision"].as_u64() else {
        return Ok(());
    };
    if expected == view.revision {
        return Ok(());
    }
    Err(
        RpcError::new(REVISION_MISMATCH, "Session state revision mismatch").with_data(json!({
            "actualRevision": view.revision,
            "expectedRevision": expected,
        })),
    )
}

async fn open(
    server: &Server,
    session: &SessionId,
) -> Result<std::sync::Arc<nibi_kernel_protocol_core::sessions::Bridged<crate::live::Live>>, RpcError>
{
    server
        .live(session)
        .await
        .map_err(|error| kernel_error(&error))
}

async fn view(server: &Server, session: &SessionId) -> Result<SessionView, RpcError> {
    let live = open(server, session).await?;
    live.handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))
}

/// 历史里的 artifact 图片/PDF → data URL（旧协议没有 artifact 路由，只能内联）。
async fn media(server: &Server, session: &SessionId, view: &SessionView) -> legacy_snapshot::Media {
    let workspace = server.workspace(view.meta.workspace.root.as_str());
    legacy_snapshot::resolve_media(&server.kernel, session, &workspace, view).await
}

/// 逐条消息时间；存储不支持时回退到会话创建时间（快照层兜底）。
async fn times(server: &Server, session: &SessionId) -> legacy_snapshot::Times {
    server
        .kernel
        .session_message_times(session)
        .await
        .unwrap_or_default()
}

fn applied(ack: KernelAck) -> Result<Value, RpcError> {
    match ack {
        KernelAck::Accepted { result } => Ok(result),
        KernelAck::Duplicate => Ok(Value::Null),
        KernelAck::Rejected { reason } => Err(RpcError::new(REQUEST_REJECTED, reason)),
    }
}

async fn send(handle: &dyn SessionHandle, id: &str, command: Command) -> Result<Value, RpcError> {
    applied(commands::send(handle, id, command).await)
}

fn tool_policy(params: &Value) -> Option<ToolPolicy> {
    let list = |field: &str| {
        params[field]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let policy = ToolPolicy {
        allow: list("toolAllowlist"),
        deny: list("toolDenylist"),
    };
    (!policy.is_empty()).then_some(policy)
}

/// `importedHistory`（Claude Code 迁移 / 分享上下文）→ 标题、创建时间与消息。
fn imported_history(
    params: &Value,
) -> Option<(Option<String>, Option<u64>, Vec<ImportedMessage>)> {
    let imported = params.get("importedHistory").filter(|value| !value.is_null())?;
    let title = imported["title"].as_str().map(str::to_owned);
    let created_at = imported["createdAt"].as_u64();
    if let Some(messages) = imported["messages"].as_array() {
        let history = messages
            .iter()
            .filter_map(|message| {
                let content = message["content"].as_str()?.to_owned();
                if content.is_empty() {
                    return None;
                }
                Some(ImportedMessage {
                    role: message["role"].as_str().unwrap_or("user").to_owned(),
                    content,
                    timestamp_ms: message["timestamp"].as_u64(),
                })
            })
            .collect();
        return Some((title, created_at, history));
    }
    // sharedContext 变体没有 messages，正文是 markdown。
    imported["markdown"].as_str().map(|markdown| {
        (
            title,
            created_at,
            vec![ImportedMessage {
                role: "user".to_owned(),
                content: markdown.to_owned(),
                timestamp_ms: None,
            }],
        )
    })
}

async fn apply_tool_policy(
    server: &Server,
    session: &SessionId,
    params: &Value,
) -> Result<(), RpcError> {
    let Some(policy) = tool_policy(params) else {
        return Ok(());
    };
    server
        .kernel
        .set_session_tool_policy(session, policy)
        .await
        .map_err(|error| kernel_error(&error))
}

/// 旧协议的动态工作流灰度字段（Host 的 create/resume 只在开启时带 `true`）：显式值与 workspace
/// 策略取或，与 v4 createSession 同一条（Node `resolveDynamicWorkflowRuntimeGate` 同序）。
/// 必须在会话打开之后调——打开时按 workspace 策略定了缺省门（Host 进程缺席 = 关闭）。
async fn apply_dynamic_workflow(server: &Server, session: &SessionId, params: &Value) {
    if params["dynamicWorkflowEnabled"].as_bool() != Some(true) {
        return;
    }
    let on_demand = params["dynamicWorkflowMode"].as_str() == Some("onDemand");
    if let Err(error) = server
        .kernel
        .set_session_dynamic_workflow(
            session,
            nibi_kernel_api::session_api::DynamicWorkflowGate::new(true, on_demand),
        )
        .await
    {
        tracing::warn!(
            event = "protocol.legacy.dynamic_workflow_failed",
            session = %session,
            error = %error,
            "the kernel refused the explicit dynamic workflow gate"
        );
    }
}

fn apply_directories(params: &Value) -> Vec<EnvPath> {
    params["additionalDirectories"]
        .as_array()
        .map(|dirs| {
            dirs.iter()
                .filter_map(Value::as_str)
                .map(EnvPath::new)
                .collect()
        })
        .unwrap_or_default()
}

async fn apply_mcp(server: &Server, session: &SessionId, params: &Value, workspace: &str) {
    if params.get("mcpServers").is_none() {
        return;
    }
    let servers = commands::session_mcp_servers(params);
    if servers.is_empty() {
        return;
    }
    if let Err(error) = server
        .kernel
        .start_session_mcp(session, &server.workspace(workspace), servers)
        .await
    {
        tracing::warn!(
            event = "protocol.legacy.mcp_servers_failed",
            session = %session,
            error = %error,
            "the kernel refused the legacy session MCP servers"
        );
    }
}

/// 立即落库的建会话（没有草稿能力的嵌入内核的降级路径）。
async fn create_immediately(
    server: &Server,
    request: CreateSession,
    parent: Option<SessionId>,
) -> Result<SessionId, RpcError> {
    let created = match parent {
        Some(parent) => server.kernel.create_session_with_parent(request, Some(parent)).await,
        None => server.kernel.create_session(request).await,
    };
    created.map_err(|error| kernel_error(&error))
}

pub async fn create(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let workspace = params["workspace"]["workspacePath"]
        .as_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| RpcError::invalid_params("workspace.workspacePath is required"))?;
    // Host 的旧 create 还带一批内核没有承载面的字段；点名而不是静默丢。
    let ignored: Vec<&str> = [
        "toolAllowlist",
        "toolDenylist",
        "importedHistory",
        "titleGenerationEnabled",
    ]
    .into_iter()
    .filter(|field| params.get(*field).is_some())
    .collect();
    if !ignored.is_empty() {
        tracing::warn!(
            event = "protocol.legacy.create_fields_ignored",
            fields = ?ignored,
            "legacy session/create carries fields the kernel does not consume yet"
        );
    }
    // `persistence`：`deferred` 的会话在第一条输入之前不落库（Node `ensureSessionPersisted`），
    // 不进会话列表/sessions-index；`immediate` 或缺席照常立即落库。
    let persistence = params.get("persistence").and_then(Value::as_str);
    if let Some(value) = persistence
        && !matches!(value, "immediate" | "deferred")
    {
        return Err(RpcError::invalid_params(
            "persistence must be \"immediate\" or \"deferred\"",
        ));
    }
    let deferred = persistence == Some("deferred");
    let mut selection =
        commands::selection(&params["model"]).unwrap_or_else(|| server.defaults.selection.clone());
    if let Some(level) = params["thoughtLevel"].as_str() {
        selection.reasoning = Some(level.to_owned());
    }
    let (mode, plan) =
        commands::mode(&params["mode"], None).unwrap_or((server.defaults.mode, false));
    let request = CreateSession {
        id: params["sessionId"].as_str().map(SessionId::new),
        workspace: server.workspace(workspace),
        selection,
        mode,
        plan,
    };
    let parent = params["parentSessionId"].as_str().map(SessionId::new);
    let id = match (imported_history(params), deferred) {
        // 导入历史本身就要立刻写正文与标题，deferred 在这里没有意义（Host 的导入入口都用
        // immediate）；点名并立即落库，而不是假装能延后。
        (Some((title, created_at, history)), true) => {
            tracing::warn!(
                event = "protocol.legacy.deferred_with_imported_history",
                "legacy session/create asked for deferred persistence together with imported history; \
                 the history entry is persisted immediately"
            );
            server
                .kernel
                .create_session_with_history(request, title, created_at, parent, history)
                .await
                .map_err(|error| kernel_error(&error))?
        }
        (Some((title, created_at, history)), false) => server
            .kernel
            .create_session_with_history(request, title, created_at, parent, history)
            .await
            .map_err(|error| kernel_error(&error))?,
        (None, true) => {
            let fallback = request.clone();
            let fallback_parent = parent.clone();
            match server.kernel.create_session_deferred(request, parent).await {
                Ok(id) => id,
                // 没有草稿能力的嵌入内核（测试替身、旧实现）：退回立即落库，但点名，不静默改变语义。
                Err(KernelError::Unsupported { .. }) => {
                    tracing::warn!(
                        event = "protocol.legacy.deferred_unsupported",
                        "the kernel cannot defer session persistence; creating a stored session instead"
                    );
                    create_immediately(server, fallback, fallback_parent).await?
                }
                Err(error) => return Err(kernel_error(&error)),
            }
        }
        // 没有导入历史也要落父链（fork / 项目会话的父会话）。
        (None, false) if parent.is_some() => server
            .kernel
            .create_session_with_parent(request, parent)
            .await
            .map_err(|error| kernel_error(&error))?,
        (None, false) => server
            .kernel
            .create_session(request)
            .await
            .map_err(|error| kernel_error(&error))?,
    };
    let directories = apply_directories(params);
    if !directories.is_empty()
        && let Err(error) = server
            .kernel
            .set_session_directories(&id, directories)
            .await
    {
        tracing::warn!(event = "protocol.legacy.directories_failed", session = %id,
            error = %error, "the kernel refused the legacy additional directories");
    }
    apply_tool_policy(server, &id, params).await?;
    apply_mcp(server, &id, params, workspace).await;
    let live = open(server, &id).await?;
    // 打开之后才落显式灰度门（打开时按 workspace 策略定了缺省）。
    apply_dynamic_workflow(server, &id, params).await;
    crate::subscribe::announce(&live);
    let view = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    let times = times(server, &id).await;
    let media = media(server, &id, &view).await;
    Ok(legacy_snapshot::snapshot(&view, Profile::Full, &times, &media))
}

pub async fn resume(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = session_id(params)?;
    apply_tool_policy(server, &id, params).await?;
    let before = view(server, &id).await?;
    // 冷恢复时 runtime 重建、缺省门按 workspace 策略重算；Host 随 resume 带的显式 true 在这里覆盖。
    apply_dynamic_workflow(server, &id, params).await;
    if let Some(level) = params["thoughtLevel"].as_str()
        && before.selection.reasoning.as_deref() != Some(level)
    {
        let mut selection = before.selection.clone();
        selection.reasoning = Some(level.to_owned());
        let live = open(server, &id).await?;
        let _ = commands::send(
            live.handle.as_ref(),
            &server.context.fresh("legacy-resume-thought"),
            Command::SetModel { selection },
        )
        .await;
    }
    let workspace = before.meta.workspace.root.as_str();
    let directories = apply_directories(params);
    if !directories.is_empty()
        && let Err(error) = server
            .kernel
            .set_session_directories(&id, directories)
            .await
    {
        tracing::warn!(event = "protocol.legacy.directories_failed", session = %id,
            error = %error, "the kernel refused the legacy additional directories");
    }
    apply_mcp(server, &id, params, workspace).await;
    let view = view(server, &id).await?;
    let times = times(server, &id).await;
    let media = media(server, &id, &view).await;
    Ok(legacy_snapshot::snapshot(&view, Profile::Full, &times, &media))
}

pub async fn messages(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = session_id(params)?;
    let view = view(server, &id).await?;
    let times = times(server, &id).await;
    let media = media(server, &id, &view).await;
    let mut messages = legacy_snapshot::messages(&view, Profile::Full, &times, &media);
    if let Some(after) = params["afterMessageId"].as_str()
        && let Some(position) = messages
            .iter()
            .position(|message| message["info"]["messageId"] == after)
    {
        messages.drain(..=position);
    }
    if let Some(limit) = params["limit"].as_u64() {
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        if messages.len() > limit {
            messages = messages.split_off(messages.len() - limit);
        }
    }
    Ok(json!({"messages": messages}))
}

pub async fn compact(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = session_id(params)?;
    let live = open(server, &id).await?;
    let before = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    check_revision(&before, params)?;
    let instructions = params["instructions"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned);
    send(
        live.handle.as_ref(),
        &server.context.fresh("legacy-compact"),
        Command::Compact { instructions },
    )
    .await?;
    let after = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    let times = times(server, &id).await;
    let media = media(server, &id, &after).await;
    let mut compact = json!({"state": "accepted"});
    if let Some(input) = params["inputId"].as_str() {
        compact["inputId"] = json!(input);
    }
    Ok(json!({
        "response": "",
        "snapshot": legacy_snapshot::snapshot(&after, Profile::Full, &times, &media),
        "compact": compact,
    }))
}

fn goal_summary(view: &nibi_kernel_api::goal::GoalView) -> String {
    if let Some(active) = &view.active {
        return format!("Goal active\nObjective: {}", active.condition);
    }
    if let Some(achieved) = &view.achieved {
        let state = if achieved.failed {
            "failed"
        } else if achieved.met {
            "achieved"
        } else if achieved.paused {
            "paused"
        } else {
            "active"
        };
        return format!("Goal {state}\nObjective: {}", achieved.condition);
    }
    "No goal is set. Use /goal <objective> to set one.".to_owned()
}

pub async fn goal(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = session_id(params)?;
    let live = open(server, &id).await?;
    let before = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    check_revision(&before, params)?;
    let action = params["action"]
        .as_str()
        .ok_or_else(|| RpcError::invalid_params("action is required"))?;
    let (response, started_turn) = match action {
        "show" => match live.handle.goal().await {
            Ok(goal) => (goal_summary(&goal), false),
            Err(nibi_kernel_api::session_api::KernelError::Unsupported { .. }) => (
                "Goal management is not available in this client.".to_owned(),
                false,
            ),
            Err(error) => return Err(kernel_error(&error)),
        },
        "set" | "replace" => {
            let objective = params["objective"]
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .ok_or_else(|| RpcError::invalid_params("objective is required"))?;
            send(
                live.handle.as_ref(),
                &server.context.fresh("legacy-goal"),
                Command::Submit {
                    text: format!("/goal {objective}"),
                    attachments: Vec::new(),
                    delivery: Delivery::Queue,
                },
            )
            .await?;
            (String::new(), true)
        }
        "pause" | "resume" => {
            let paused = action == "pause";
            send(
                live.handle.as_ref(),
                &server.context.fresh("legacy-goal"),
                Command::SetGoalPaused { paused },
            )
            .await?;
            (String::new(), false)
        }
        "clear" => {
            send(
                live.handle.as_ref(),
                &server.context.fresh("legacy-goal"),
                Command::Submit {
                    text: "/goal clear".to_owned(),
                    attachments: Vec::new(),
                    delivery: Delivery::Queue,
                },
            )
            .await?;
            (String::new(), false)
        }
        other => {
            return Err(RpcError::invalid_params(format!(
                "unknown goal action: {other}"
            )));
        }
    };
    let after = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    let times = times(server, &id).await;
    let media = media(server, &id, &after).await;
    Ok(json!({
        "response": response,
        "snapshot": legacy_snapshot::snapshot(&after, Profile::Full, &times, &media),
        "startedTurn": started_turn,
    }))
}

async fn mutation_snapshot(
    server: &Server,
    params: &Value,
    command: impl FnOnce(&SessionView) -> Vec<Command>,
) -> Result<Value, RpcError> {
    let id = session_id(params)?;
    let live = open(server, &id).await?;
    let before = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    check_revision(&before, params)?;
    for (index, command) in command(&before).into_iter().enumerate() {
        send(
            live.handle.as_ref(),
            &server.context.fresh(&format!("legacy-set-{index}")),
            command,
        )
        .await?;
    }
    let after = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    let times = times(server, &id).await;
    let media = media(server, &id, &after).await;
    Ok(legacy_snapshot::snapshot(&after, Profile::Full, &times, &media))
}

/// 旧附件载荷（GUI `ZCodePromptAttachment`）→ 内容块。
///
/// 与 v4 的 `AttachmentRef` 不是同一种形状：这里读 `kind` / `mimeType` / `localPath` /
/// `dataBase64`。图片与 PDF 走同一条路（图片 `Image`、PDF `Document`）；其他类型（视频、
/// 任意文件）内核没有对应内容块，fail-closed 报错而不是静默丢掉内容。
async fn attachment_blocks(
    server: &Server,
    session: &SessionId,
    view: &SessionView,
    attachments: &[Value],
) -> Result<Vec<ContentBlock>, RpcError> {
    use base64::Engine;

    let mut blocks = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let mime = attachment["mimeType"].as_str().unwrap_or_default();
        let media = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        let kind = attachment["kind"].as_str().unwrap_or_default();
        let is_pdf = kind == "pdf" || media == "application/pdf";
        let is_image = kind == "image" || media.starts_with("image/");
        if !is_pdf && !is_image {
            return Err(RpcError::invalid_params(format!(
                "attachments of kind {kind:?} are not supported yet; only images and PDFs are"
            )));
        }
        // 路径由会话所在机器读（与 v4 附件同一条读取链）；内联 base64 直接落成块，不落盘。
        let (media_type, data) = match attachment["localPath"]
            .as_str()
            .filter(|path| !path.is_empty())
        {
            Some(path) => {
                let loaded = server
                    .kernel
                    .load_attachment(
                        session,
                        &view.meta.workspace,
                        nibi_kernel_api::attachment::AttachmentSource::Path {
                            path: path.to_owned(),
                        },
                    )
                    .await
                    .map_err(|error| kernel_error(&error))?;
                let media_type = loaded
                    .media_type
                    .map(|value| value.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        if is_pdf {
                            "application/pdf".to_owned()
                        } else if media.is_empty() || media == "image/*" {
                            "image/png".to_owned()
                        } else {
                            media.clone()
                        }
                    });
                (
                    media_type,
                    base64::engine::general_purpose::STANDARD.encode(loaded.bytes),
                )
            }
            None => {
                let Some(data) = attachment["dataBase64"]
                    .as_str()
                    .filter(|data| !data.is_empty())
                else {
                    // Node 对既没有 localPath 也没有 dataBase64 的附件直接跳过；这里报错，是因为
                    // 静默丢掉用户贴的内容比一次明确的拒绝更糟。
                    return Err(RpcError::invalid_params(
                        "an attachment without localPath or dataBase64 cannot be read",
                    ));
                };
                let media_type = if is_pdf {
                    "application/pdf".to_owned()
                } else if media.is_empty() || media == "image/*" {
                    "image/png".to_owned()
                } else {
                    media.clone()
                };
                (media_type, data.to_owned())
            }
        };
        blocks.push(if is_pdf {
            ContentBlock::Document {
                source: nibi_kernel_api::message::ImageSource::Base64 { media_type, data },
                name: attachment["filename"].as_str().map(str::to_owned),
            }
        } else {
            ContentBlock::Image {
                source: nibi_kernel_api::message::ImageSource::Base64 { media_type, data },
            }
        });
    }
    Ok(blocks)
}

/// 旧输入入口 `session/send`：Host 的 Bot / 手机远控仍走它（桌面主输入已收敛到 v4 `sendText`）。
///
/// 语义逐条对齐 Node `sendPrompt`：子代理会话只读、状态版本 CAS、已有回合在跑时拒绝；
/// 提交后立刻 ACK（`accepted: true` + 当前 revision），回合在后台跑。带附件时走
/// [`Command::SubmitContent`]（正文按 Node 的排法跟在附件后面）。
pub async fn send_prompt(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = session_id(params)?;
    let live = open(server, &id).await?;
    let before = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    // 子代理会话只读：旧入口也不能绕过 V4 的用户输入准入。
    if before.meta.kind == SessionKind::Subagent {
        return Err(
            RpcError::new(REQUEST_REJECTED, "Subagent sessions are read-only")
                .with_data(json!({"reasonCode": "guard.subagentReadOnly"})),
        );
    }
    check_revision(&before, params)?;
    // Node `record.activeAbortController` 的同一裁决：一轮还在跑时旧入口不再接受新输入。
    if before.running {
        return Err(RpcError::new(
            REQUEST_REJECTED,
            "A prompt is already running for this session",
        ));
    }
    // 本次输入带的模型先作用到会话（Node 把它钉在这一条输入上；内核只记会话选择）。
    if let Some(chosen) = commands::selection(&params["modelSelection"])
        && before.selection != chosen
    {
        send(
            live.handle.as_ref(),
            &format!("{}:legacy-model", id.as_str()),
            Command::SetModel { selection: chosen },
        )
        .await?;
    }
    let text = params["content"].as_str().unwrap_or_default().to_owned();
    let attachments: Vec<Value> = params["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut blocks = attachment_blocks(server, &id, &before, &attachments).await?;
    let submit = if blocks.is_empty() {
        Command::Submit {
            text,
            attachments: Vec::new(),
            delivery: Delivery::Queue,
        }
    } else {
        if !text.is_empty() {
            blocks.push(ContentBlock::Text { text });
        }
        Command::SubmitContent {
            content: blocks,
            delivery: Delivery::Queue,
        }
    };
    // `inputId` 是 Host 的幂等键：同一条输入重投时内核按同 id 去重。
    let command = params["inputId"]
        .as_str()
        .filter(|input| !input.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| server.context.fresh("legacy-send"));
    send(live.handle.as_ref(), &command, submit).await?;
    let after = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    Ok(json!({
        "sessionId": id.as_str(),
        "accepted": true,
        "stateRevision": after.revision,
    }))
}

pub async fn set_model(server: &Server, params: &Value) -> Result<Value, RpcError> {
    if params["persistAsWorkspaceLastUsed"]
        .as_bool()
        .unwrap_or(true)
    {
        tracing::warn!(
            event = "protocol.legacy.workspace_last_used_not_persisted",
            "the kernel updates the session model but not the workspace last-used model"
        );
    }
    let selection = commands::selection(&params["model"])
        .ok_or_else(|| RpcError::invalid_params("model requires providerId and modelId"))?;
    mutation_snapshot(server, params, |_| vec![Command::SetModel { selection }]).await
}

pub async fn set_thought_level(server: &Server, params: &Value) -> Result<Value, RpcError> {
    if params["persistAsWorkspaceLastUsed"]
        .as_bool()
        .unwrap_or(true)
    {
        tracing::warn!(
            event = "protocol.legacy.workspace_last_used_not_persisted",
            "the kernel updates the session thought level but not the workspace last-used model"
        );
    }
    let level = params["thoughtLevel"]
        .as_str()
        .filter(|level| !level.is_empty())
        .ok_or_else(|| RpcError::invalid_params("thoughtLevel is required"))?;
    mutation_snapshot(server, params, |view| {
        let mut selection = view.selection.clone();
        selection.reasoning = Some(level.to_owned());
        vec![Command::SetModel { selection }]
    })
    .await
}

pub async fn set_mode(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let Some((permission, plan)) = commands::mode(&params["mode"], None) else {
        return Err(RpcError::invalid_params("unknown mode"));
    };
    mutation_snapshot(server, params, |view| {
        let mut commands = Vec::new();
        if view.mode != permission {
            commands.push(Command::SetMode { mode: permission });
        }
        if view.plan != plan {
            commands.push(Command::SetPlan { enabled: plan });
        }
        commands
    })
    .await
}

#[cfg(test)]
#[path = "legacy_session_tests.rs"]
mod tests;

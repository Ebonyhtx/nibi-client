//! 旧协议会话入口（141 审计 F5）：`session/create|resume|messages|compact|goal|setModel|
//! setThoughtLevel|setMode`。Host 仍走旧词表（任务适配器、时间线、设置面板），切默认后这些
//! 方法不能回 `-32601`；这里把参数映射到已收的 v4 语义（`CreateSession` / `Command`），响应
//! 统一用 [`crate::legacy_snapshot`] 的旧快照形状。

use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::permission::ToolPolicy;
use rust_cli_kernel_api::session_api::ImportedMessage;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, CreateSession, Delivery, SessionHandle, SessionView,
};
use rust_cli_protocol_core::rpc::RpcError;
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
) -> Result<std::sync::Arc<rust_cli_protocol_core::sessions::Bridged<crate::live::Live>>, RpcError>
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

pub async fn create(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let workspace = params["workspace"]["workspacePath"]
        .as_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| RpcError::invalid_params("workspace.workspacePath is required"))?;
    // Host 的旧 create 还带一批内核没有承载面的字段；点名而不是静默丢。
    let ignored: Vec<&str> = [
        "persistence",
        "parentSessionId",
        "toolAllowlist",
        "toolDenylist",
        "importedHistory",
        "titleGenerationEnabled",
        "dynamicWorkflowEnabled",
        "dynamicWorkflowMode",
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
    let id = match imported_history(params) {
        Some((title, created_at, history)) => server
            .kernel
            .create_session_with_history(
                request,
                title,
                created_at,
                params["parentSessionId"].as_str().map(SessionId::new),
                history,
            )
            .await
            .map_err(|error| kernel_error(&error))?,
        None => server
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
    crate::subscribe::announce(&live);
    let view = live
        .handle
        .view()
        .await
        .map_err(|error| kernel_error(&error))?;
    let times = times(server, &id).await;
    Ok(legacy_snapshot::snapshot(&view, Profile::Full, &times))
}

pub async fn resume(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = session_id(params)?;
    apply_tool_policy(server, &id, params).await?;
    let before = view(server, &id).await?;
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
    Ok(legacy_snapshot::snapshot(&view, Profile::Full, &times))
}

pub async fn messages(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = session_id(params)?;
    let view = view(server, &id).await?;
    let times = times(server, &id).await;
    let mut messages = legacy_snapshot::messages(&view, Profile::Full, &times);
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
    let mut compact = json!({"state": "accepted"});
    if let Some(input) = params["inputId"].as_str() {
        compact["inputId"] = json!(input);
    }
    Ok(json!({
        "response": "",
        "snapshot": legacy_snapshot::snapshot(&after, Profile::Full, &times),
        "compact": compact,
    }))
}

fn goal_summary(view: &rust_cli_kernel_api::goal::GoalView) -> String {
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
            Err(rust_cli_kernel_api::session_api::KernelError::Unsupported { .. }) => (
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
    Ok(json!({
        "response": response,
        "snapshot": legacy_snapshot::snapshot(&after, Profile::Full, &times),
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
    Ok(legacy_snapshot::snapshot(&after, Profile::Full, &times))
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

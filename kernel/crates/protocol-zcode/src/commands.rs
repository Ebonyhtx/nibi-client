//! 命令的处理（[`crate::inbox`] 的裁决与转交）：P1 的五个命令。

use rust_cli_kernel_api::attachment::AttachmentSource;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{CommandId, InteractionId, SessionId};
use rust_cli_kernel_api::interaction::PermissionAnswer;
use rust_cli_kernel_api::message::{ContentBlock, ImageSource};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandEnvelope, CreateSession, Delivery, RewindScope, SessionHandle,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Map, Value, json};

use crate::inbound::Inbound;
use crate::inbox::{self, Ack, Envelope, Status};
use crate::projection::InputMeta;
use crate::projection::state::{Followup, Phase};
use crate::server::{Server, kernel_error};

/// App 的模型选择 → 内核的选择。
fn selection(value: &Value) -> Option<ModelSelection> {
    Some(ModelSelection {
        provider: value["providerId"].as_str()?.to_owned(),
        model: value["modelId"].as_str()?.to_owned(),
        reasoning: value["options"]["reasoningLevel"]
            .as_str()
            .map(str::to_owned),
        connection: None,
    })
}

/// App 的模式与 plan 开关 → 内核的权限模式与 plan（README §5 的映射；`plan` 是旧写法，读成 plan 开、build）。
fn mode(value: &Value, plan: Option<bool>) -> Option<(PermissionMode, bool)> {
    let name = value.as_str()?;
    if name == "plan" {
        return Some((PermissionMode::Default, true));
    }
    Some((PermissionMode::from_node_name(name)?, plan.unwrap_or(false)))
}

/// 首条输入的执行状态（Node 的 `resolveSubmittedExecutionState`）：`firstInput.mode/planEnabled` 给了就覆盖
/// `config.mode/planEnabled`（Node 的 `resolveExecutionState(payload, current)` 同义）；只给 planEnabled 时
/// 沿用 config 的模式。
fn first_input_execution(
    first: &Value,
    config: &Value,
    fallback: (PermissionMode, bool),
) -> (PermissionMode, bool) {
    let base = mode(&config["mode"], config["planEnabled"].as_bool()).unwrap_or(fallback);
    if let Some(found) = mode(&first["mode"], first["planEnabled"].as_bool()) {
        return found;
    }
    match first["planEnabled"].as_bool() {
        Some(plan) => (base.0, plan),
        None => base,
    }
}

/// 一条图片附件引用 → 读取来源与规范化 mime；不是图片时为 None（调用方拒绝）。
fn attachment_image_source(reference: &Value) -> Option<(AttachmentSource, String)> {
    let mime = reference["mime"].as_str().unwrap_or_default();
    let media = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !media.starts_with("image/") {
        return None;
    }
    let reference = reference["ref"].as_str().unwrap_or_default().to_owned();
    let source = if reference.starts_with(rust_cli_kernel_api::persisted_output::ARTIFACT_SCHEME) {
        AttachmentSource::Artifact { uri: reference }
    } else {
        AttachmentSource::Path { path: reference }
    };
    Some((source, media))
}

/// 命令里的附件（NIBI `AttachmentRef`）→ 模型内容块。
///
/// 只支持图片：Rust 的 user 消息内容块没有 PDF / 文本 / 视频形态（`ContentBlock` 只有 Text 与
/// Image），其他类型 fail-closed 拒绝并点名 mime，不静默丢掉内容。图片按 Node 的排法放在正文之前。
async fn attachment_blocks(
    kernel: &std::sync::Arc<dyn rust_cli_kernel_api::session_api::Kernel>,
    session: &SessionId,
    workspace: &WorkspaceRef,
    refs: &[Value],
) -> Result<Vec<ContentBlock>, (&'static str, String)> {
    use base64::Engine;

    let mut blocks = Vec::with_capacity(refs.len());
    for reference in refs {
        let Some((source, media)) = attachment_image_source(reference) else {
            let mime = reference["mime"].as_str().unwrap_or_default();
            let media = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            return Err((
                "fault.command.attachmentUnsupported",
                format!("attachments of type {media} are not supported yet; only images are"),
            ));
        };
        let loaded = kernel
            .load_attachment(session, workspace, source)
            .await
            .map_err(|error| {
                (
                    "fault.command.attachmentUnreadable",
                    error.to_string(),
                )
            })?;
        blocks.push(ContentBlock::Image {
            source: ImageSource::Base64 {
                media_type: loaded
                    .media_type
                    .unwrap_or_else(|| media.clone()),
                data: base64::engine::general_purpose::STANDARD.encode(loaded.bytes),
            },
        });
    }
    Ok(blocks)
}

/// 正文与附件内容块：图片在前、正文在后（Node `buildUserContentFromTurn` 的排法）。
fn with_text(text: String, mut blocks: Vec<ContentBlock>) -> Vec<ContentBlock> {
    if !text.is_empty() {
        blocks.push(ContentBlock::Text { text });
    }
    blocks
}

/// `createSession.mcpServers` → 会话级的 MCP 服务器（NIBI `nibiProtocolMcpServerSchema` 的两种形态）。
/// 形状已由契约层按同一 zod 生成的 schema 校验过，这里只做字段搬运；认不出的形态整条丢掉（不静默：
/// 调用方在数量不等时 warn）。
fn session_mcp_servers(payload: &Value) -> Vec<rust_cli_kernel_api::mcp_session::SessionMcpServer> {
    use std::collections::BTreeMap;

    use rust_cli_kernel_api::mcp::McpTransportConfig;
    use rust_cli_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};

    let entries = |value: &Value| -> BTreeMap<String, String> {
        value
            .as_array()
            .map(|pairs| {
                pairs
                    .iter()
                    .filter_map(|pair| {
                        Some((
                            pair["name"].as_str()?.to_owned(),
                            pair["value"].as_str()?.to_owned(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let isolation = |server: &Value| {
        match server["isolation"].as_str() {
            Some("workspace") => McpIsolation::Workspace,
            _ => McpIsolation::Session,
        }
    };
    payload["mcpServers"]
        .as_array()
        .map(|servers| {
            servers
                .iter()
                .filter_map(|server| {
                    let name = server["name"].as_str()?.to_owned();
                    let transport = match server["command"].as_str() {
                        Some(command) => McpTransportConfig::Stdio {
                            command: command.to_owned(),
                            args: server["args"]
                                .as_array()
                                .map(|args| {
                                    args.iter()
                                        .filter_map(|arg| arg.as_str().map(str::to_owned))
                                        .collect()
                                })
                                .unwrap_or_default(),
                            env: entries(&server["env"]),
                            cwd: None,
                        },
                        None => match server["type"].as_str()? {
                            "http" => McpTransportConfig::Http {
                                url: server["url"].as_str()?.to_owned(),
                                headers: entries(&server["headers"]),
                            },
                            "sse" => McpTransportConfig::Sse {
                                url: server["url"].as_str()?.to_owned(),
                                headers: entries(&server["headers"]),
                            },
                            _ => return None,
                        },
                    };
                    Some(SessionMcpServer {
                        name,
                        transport,
                        always_load: server["alwaysLoad"].as_bool().unwrap_or(false),
                        timeout_ms: server["timeoutMs"].as_u64(),
                        isolation: isolation(server),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// row-targeting 的 `target`（`conversationRowTargetSchema`：rowId + entityId）。
struct TargetRow {
    row_id: u64,
    entity: String,
}

fn target_row(payload: &Value) -> Option<TargetRow> {
    let target = &payload["target"];
    Some(TargetRow {
        row_id: target["rowId"].as_u64()?,
        entity: target["entityId"].as_str()?.to_owned(),
    })
}

/// CAS 命令共用的 revision + logEpoch 比较（Node command-inbox.ts:344-351）：
/// revision 不符 → `proto.staleRevision`；logEpoch 不符 → `proto.staleLogEpoch`。
/// row-targeting 命令两者都比；其余 CAS 命令只比 revision（`compare_epoch=false`）。
fn cas_check_with_epoch(
    command: &str,
    base_revision: Option<u64>,
    base_epoch: Option<&str>,
    current_revision: u64,
    current_epoch: &str,
    compare_epoch: bool,
) -> Option<Ack> {
    if base_revision != Some(current_revision) {
        return Some(Ack::refused(
            command,
            Status::Stale,
            "proto.staleRevision",
            "the session changed",
            current_revision,
        ));
    }
    if compare_epoch && base_epoch != Some(current_epoch) {
        return Some(Ack::refused(
            command,
            Status::Stale,
            "proto.staleLogEpoch",
            "the conversation log moved on",
            current_revision,
        ));
    }
    None
}

/// Human 用户消息的可见文本；合成消息与 INTERRUPT_TEXTS 撤回补条返回空。
fn user_text(message: &rust_cli_kernel_api::message::Message) -> String {
    let rust_cli_kernel_api::message::Message::User(user) = message else {
        return String::new();
    };
    if user.origin != rust_cli_kernel_api::message::UserOrigin::Human {
        return String::new();
    }
    let text = crate::projection::text_of(&user.content);
    if rust_cli_kernel_api::user_input::INTERRUPT_TEXTS.contains(&text.as_str()) {
        return String::new();
    }
    text
}

/// `guard.latestQueryEditOnly`：editUserQuery 只许改最后一条 real user query——
/// 历史编辑会回退 active branch。
fn edit_target_guard(
    messages: &[rust_cli_kernel_api::message::Message],
    entity: &str,
) -> Result<(), String> {
    let latest = messages
        .iter()
        .rev()
        .find(|message| !user_text(message).is_empty())
        .ok_or("no real user query in the conversation")?;
    if latest.id().as_str() == entity {
        return Ok(());
    }
    Err("guard.latestQueryEditOnly: editUserQuery only edits the latest real user query".to_owned())
}

/// row-targeting 的 target 解析：行存在、entityId 对得上、已结算出 assistant 消息。
fn row_message_id(row: &Map<String, Value>, entity: &str) -> Result<String, String> {
    if row.get("entityId").and_then(Value::as_str) != Some(entity) {
        return Err("the row moved on; refresh the conversation and retry".to_owned());
    }
    row.get("assistantResponseId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "the row has no settled assistant response yet".to_owned())
}

/// NIBI `switchModelConfig` 的扁平 payload → 内核选择（provider/model/thought）。
fn model_config_selection(payload: &Value) -> Option<ModelSelection> {
    Some(ModelSelection {
        provider: payload["provider"].as_str()?.to_owned(),
        model: payload["model"].as_str()?.to_owned(),
        reasoning: payload["thought"].as_str().map(str::to_owned),
        connection: None,
    })
}

/// NIBI `createSession.config` 的扁平 provider/model/thought（Host 的旧写法）→ 内核选择；
/// `config.modelSelection` 缺席时的回落。provider 与 model 必须同时给出。
fn flat_selection(config: &Value) -> Option<ModelSelection> {
    let provider = config["provider"].as_str()?;
    let model = config["model"].as_str()?;
    Some(ModelSelection {
        provider: provider.to_owned(),
        model: model.to_owned(),
        reasoning: config["thought"].as_str().map(str::to_owned),
        connection: None,
    })
}

/// NIBI `cancelBackgroundWork` 的拒绝 fault 前缀（Node `BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX`）：
/// core 明确回"没有取消任何东西"时上行 rejected 而不是假装成功。reason 是
/// `not_found` / `not_running` / `cancel_not_supported`。
pub const BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX: &str =
    "fault.command.backgroundWorkCancelRejected.";

/// 内核 `StopTask` 的拒绝文案是给人看的；这里按关键词归到 NIBI 的 fault 码。
/// 归不进三类的用 `unknown`——宁可暴露"码未知"，也不把拒绝伪装成 accepted。
/// TODO(kernel)：等 kernel 的 StopTask 回执带机器可读 reason 后删掉这个近似映射。
fn background_work_cancel_code(reason: &str) -> &'static str {
    let lower = reason.to_ascii_lowercase();
    if lower.contains("not running") {
        "not_running"
    } else if lower.contains("not found")
        || lower.contains("no task found")
        || lower.contains("unknown")
        || lower.contains("no such")
    {
        "not_found"
    } else if lower.contains("cancel") && lower.contains("support") {
        "cancel_not_supported"
    } else {
        "unknown"
    }
}

async fn send(handle: &dyn SessionHandle, id: &str, command: Command) -> KernelAck {
    handle
        .send(CommandEnvelope {
            id: CommandId::new(id),
            command,
        })
        .await
}

fn unsupported(envelope: &Envelope, revision: u64) -> Ack {
    // 明确列在 BLOCKED_COMMANDS 里的命令把"缺什么能力"一起说出来：切默认前要能看出这些是功能
    // 缺口，不是没接线。
    let missing = crate::nibi_commands::BLOCKED_COMMANDS
        .iter()
        .find(|(name, _)| *name == envelope.kind)
        .map(|(_, reason)| *reason);
    let message = match missing {
        Some(reason) => format!("{} is not supported by this kernel yet: {reason}", envelope.kind),
        None => format!("{} is not supported by this agent yet", envelope.kind),
    };
    Ack::refused(
        &envelope.command_id,
        Status::Rejected,
        "proto.unsupportedCommand",
        message,
        revision,
    )
}

pub async fn command(server: &Server, params: Value) -> Result<Value, RpcError> {
    let envelope: Envelope = serde_json::from_value(params.clone())
        .map_err(|error| RpcError::invalid_params(format!("Invalid command envelope: {error}")))?;
    let key = inbox::key(envelope.session_id.as_deref(), &envelope.command_id);
    let known = server
        .remembered
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&key)
        .cloned();
    if let Some(known) = known {
        return Ok(inbox::duplicate(&known).to_value());
    }
    let ack = match Inbound::get().command(&params) {
        Err(message) => Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            message,
            0,
        ),
        Ok(()) => decide(server, &envelope).await,
    };
    if ack.status != Status::Duplicate {
        server
            .remembered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .put(key, ack.clone());
    }
    // 命令事实（G2）：会话命令照 Node 的格式落库；写失败只记日志，ACK 照常回。
    if let Some(session) = &envelope.session_id
        && ack.is_fact()
        && let Err(error) = server
            .kernel
            .put_session_record(&SessionId::new(session), inbox::fact(&ack))
            .await
    {
        tracing::warn!(event = "protocol.command_fact.failed", error = %error, "writing the command fact failed");
    }
    Ok(ack.to_value())
}

async fn decide(server: &Server, envelope: &Envelope) -> Ack {
    if envelope.kind == "createSession" {
        return create_session(server, envelope).await;
    }
    let Some(session) = envelope.session_id.as_deref() else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.sessionRequired",
            "this command needs a sessionId",
            0,
        );
    };
    let live = match server.live(&SessionId::new(session)).await {
        Ok(live) => live,
        Err(error) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                "proto.sessionNotFound",
                kernel_error(&error).message,
                0,
            );
        }
    };
    let (phase, revision) = live.sink.status();
    let handle = live.handle.as_ref();
    match envelope.kind.as_str() {
        "sendText" => send_text(server, handle, &live.sink, envelope, phase, revision).await,
        "stop" => match send(handle, &envelope.command_id, Command::Interrupt).await {
            KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
            KernelAck::Duplicate => {
                inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None))
            }
            KernelAck::Rejected { reason } => Ack::refused(
                &envelope.command_id,
                Status::Noop,
                "proto.nothingToStop",
                reason,
                revision,
            ),
        },
        "resolveInteraction" => resolve(handle, &live.sink, envelope, revision).await,
        "setFollowupMode" => set_followup(server, handle, &live, envelope).await,
        "switchModelConfig" => switch_model_config(handle, &live.sink, envelope).await,
        "switchCollaborationMode" => switch_collaboration_mode(handle, &live.sink, envelope).await,
        "compact" => compact_session(handle, envelope, revision).await,
        "renameSession" => rename_session(handle, envelope, revision).await,
        "cancelBackgroundWork" => cancel_background_work(handle, envelope, revision).await,
        "forkAssistant" => fork_assistant(handle, &live.sink, envelope).await,
        "applyFileRewind" => apply_file_rewind(handle, &live.sink, envelope).await,
        "retryTurn" => retry_turn(handle, &live.sink, envelope).await,
        "editUserQuery" => edit_user_query(server, handle, &live.sink, envelope).await,
        "editQueueItem" => edit_queue_item(handle, envelope).await,
        "deleteQueueItem" => delete_queue_item(handle, envelope).await,
        "reorderQueueItem" => reorder_queue_item(handle, envelope).await,
        "setAutoDrain" => set_auto_drain(handle, envelope).await,
        "sendQueuedNow" => send_queued_now(handle, envelope, revision).await,
        "setAssistantFeedback" => set_assistant_feedback(server, handle, &live.sink, envelope).await,
        "createSelectionSideSession" => {
            create_selection_side_session(server, handle, envelope).await
        }
        "sendGoalCommand" => send_goal_command(handle, envelope).await,
        "pauseGoal" => set_goal_paused(handle, envelope, true).await,
        "resumeGoal" => set_goal_paused(handle, envelope, false).await,
        "snoozeInteractionAutoResolution" => snooze_interaction_auto_resolution(envelope).await,
        "deleteSession" => delete_session(server, envelope).await,
        _ => unsupported(envelope, revision),
    }
}

async fn create_session(server: &Server, envelope: &Envelope) -> Ack {
    let payload = &envelope.payload;
    // R12/R23：照上游实现会静默丢 NIBI 的 createSession 字段。契约层先点名上报，
    // 处理器逐项实现后从这里移出；不允许“ACK 成功但字段丢了”装作没事。
    let unsupported =
        crate::nibi_commands::NibiCommands::unsupported_create_session_fields(payload);
    if !unsupported.is_empty() {
        tracing::warn!(
            event = "protocol.create_session.fields_unsupported",
            fields = ?unsupported,
            "createSession carries fields the kernel does not consume yet"
        );
    }
    let config = &payload["config"];
    let first = &payload["firstInput"];
    let chosen = selection(&config["modelSelection"])
        .or_else(|| flat_selection(config))
        .or_else(|| selection(&first["modelSelection"]))
        .unwrap_or_else(|| server.defaults.selection.clone());
    let (permission, plan) =
        first_input_execution(first, config, (server.defaults.mode, false));
    // Host 没给 sessionId 时让 kernel 生成（注入的 Ids → `sess_<uuid>`，与 Node 同格式）；
    // 协议层不再自带 id 生成器。
    let requested = payload["sessionId"].as_str().map(SessionId::new);
    let workspace = payload["workspaceId"].as_str().unwrap_or_default();
    let created = server
        .kernel
        .create_session(CreateSession {
            id: requested,
            workspace: server.workspace(workspace),
            selection: chosen,
            mode: permission,
            plan,
        })
        .await;
    let refused = |message: String| {
        Ack::refused(
            &envelope.command_id,
            Status::Failed,
            "fault.command.createSessionFailed",
            message,
            0,
        )
    };
    let id = match created {
        Ok(id) => id,
        Err(error) => return refused(error.to_string()),
    };
    // MCP 是创建期配置（NIBI createSession.mcpServers）：会话的工具表从此就是这批服务器。
    // 连接在后台建立；给了列表但一条都没认出来时点名，不静默。
    if let Some(raw) = payload["mcpServers"].as_array() {
        let servers = session_mcp_servers(payload);
        if servers.len() != raw.len() {
            tracing::warn!(
                event = "protocol.create_session.mcp_servers_unparsed",
                given = raw.len(),
                parsed = servers.len(),
                "createSession.mcpServers has entries the kernel cannot map"
            );
        }
        // 内核的 MCP 连接没有 OAuth 授权、也不接受指定握手版本（ext 的 node_config 同样只 warn）：
        // 这两项在这里点名，不静默丢掉（Node 的 OAuth 有 15s 授权窗口，Rust 会连成 Failed）。
        let carrying = |field: &str| {
            raw.iter()
                .filter(|server| server.get(field).is_some_and(|value| !value.is_null()))
                .count()
        };
        let (oauth, versioned) = (carrying("oauth"), carrying("protocolVersion"));
        if oauth > 0 || versioned > 0 {
            tracing::warn!(
                event = "protocol.create_session.mcp_servers_unsupported_options",
                oauth,
                protocol_version = versioned,
                "createSession.mcpServers carries oauth/protocolVersion the kernel does not implement"
            );
        }
        let workspace = server.workspace(payload["workspaceId"].as_str().unwrap_or_default());
        if let Err(error) = server.kernel.start_session_mcp(&id, &workspace, servers).await {
            tracing::warn!(
                event = "protocol.create_session.mcp_servers_failed",
                session = %id,
                error = %error,
                "the kernel refused the session MCP servers"
            );
        }
    }
    // 附加工作目录（NIBI createSession.additionalDirectories）：判决链按"在工作区内"处理，
    // 环境段列出它们。空列表等于没有。
    if let Some(dirs) = payload["additionalDirectories"].as_array() {
        let directories: Vec<EnvPath> = dirs
            .iter()
            .filter_map(Value::as_str)
            .map(EnvPath::new)
            .collect();
        if directories.len() != dirs.len() {
            tracing::warn!(
                event = "protocol.create_session.additional_directories_unparsed",
                given = dirs.len(),
                parsed = directories.len(),
                "createSession.additionalDirectories has entries the kernel cannot map"
            );
        }
        if let Err(error) = server.kernel.set_session_directories(&id, directories).await {
            tracing::warn!(
                event = "protocol.create_session.additional_directories_failed",
                session = %id,
                error = %error,
                "the kernel refused the session additional directories"
            );
        }
    }
    if let Some(followup) = config["followupMode"].as_str().and_then(Followup::parse) {
        server
            .followups
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id.clone(), followup);
    }
    let live = match server.live(&id).await {
        Ok(live) => live,
        Err(error) => return refused(error.to_string()),
    };
    crate::subscribe::announce(&live);
    let mut result = json!({"type": "createSession", "sessionId": id.as_str()});
    let first = &payload["firstInput"];
    if let Some(text) = first["text"].as_str() {
        // 首条输入的附件（图片）与正文一起提交；解不出就拒绝（会话按 Node 的 draft 语义留下）。
        let refs = first["attachments"].as_array().cloned().unwrap_or_default();
        let submit = if refs.is_empty() {
            Command::Submit {
                text: text.to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            }
        } else {
            let workspace = server.workspace(payload["workspaceId"].as_str().unwrap_or_default());
            match attachment_blocks(&server.kernel, &id, &workspace, &refs).await {
                Ok(blocks) => Command::SubmitContent {
                    content: with_text(text.to_owned(), blocks),
                    delivery: Delivery::Queue,
                },
                Err((code, message)) => {
                    return Ack::refused(&envelope.command_id, Status::Rejected, code, message, 0);
                }
            }
        };
        live.sink.remember_input(
            &envelope.command_id,
            input_meta(envelope, first, "startNow", "startNow"),
        );
        if let KernelAck::Accepted { .. } =
            send(live.handle.as_ref(), &envelope.command_id, submit).await
        {
            result["input"] = json!({"delivery": "startNow", "inputId": envelope.command_id});
        }
    }
    Ack::accepted(&envelope.command_id, 0, Some(result))
}

fn input_meta(
    envelope: &Envelope,
    payload: &Value,
    requested: &'static str,
    admitted: &'static str,
) -> InputMeta {
    InputMeta {
        client: envelope.client_id.clone(),
        origin: envelope
            .input_origin
            .clone()
            .or_else(|| payload["inputOrigin"].as_str().map(str::to_owned)),
        text: payload["text"].as_str().unwrap_or_default().to_owned(),
        selection: payload.get("modelSelection").cloned(),
        mode: payload["mode"].as_str().map(str::to_owned),
        plan: payload["planEnabled"].as_bool(),
        admitted_at: 0,
        requested,
        admitted,
        attachments: payload
            .get("attachments")
            .filter(|value| value.as_array().is_some_and(|items| !items.is_empty()))
            .cloned(),
    }
}

async fn send_text(
    server: &Server,
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
    phase: Phase,
    revision: u64,
) -> Ack {
    let payload = &envelope.payload;
    let command = envelope.command_id.as_str();
    // 这次提交带的模型与模式先作用到会话（同 Node：Submission 带完整的选择）。
    let view = handle.view().await.ok();
    if let Some(chosen) = selection(&payload["modelSelection"])
        && view.as_ref().is_none_or(|view| view.selection != chosen)
    {
        send(
            handle,
            &format!("{command}:model"),
            Command::SetModel { selection: chosen },
        )
        .await;
    }
    if let Some((permission, plan)) = mode(&payload["mode"], payload["planEnabled"].as_bool()) {
        if view.as_ref().is_none_or(|view| view.mode != permission) {
            send(
                handle,
                &format!("{command}:mode"),
                Command::SetMode { mode: permission },
            )
            .await;
        }
        if view.as_ref().is_none_or(|view| view.plan != plan) {
            send(
                handle,
                &format!("{command}:plan"),
                Command::SetPlan { enabled: plan },
            )
            .await;
        }
    }
    let running = phase == Phase::Running;
    let requested = payload["requestedDelivery"].as_str();
    let followup = live.followup();
    let (delivery, admitted) = match requested {
        Some("guide") if running => (Delivery::Steer, "guide"),
        None if running && followup == Followup::Guide => (Delivery::Steer, "guide"),
        _ if running => (Delivery::Queue, "queue"),
        _ => (Delivery::Queue, "startNow"),
    };
    let requested = match requested {
        Some("guide") => "guide",
        Some("queue") => "queue",
        _ => "startNow",
    };
    let text = payload["text"].as_str().unwrap_or_default().to_owned();
    let refs = payload["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    // 附件：先解出内容（失败就拒绝这条命令，不静默丢内容），正文与图片一起提交。
    let submit = if refs.is_empty() {
        Command::Submit {
            text,
            attachments: Vec::new(),
            delivery,
        }
    } else {
        let workspace = view
            .as_ref()
            .map(|view| view.meta.workspace.clone())
            .unwrap_or_else(|| server.workspace(""));
        match attachment_blocks(&server.kernel, handle.id(), &workspace, &refs).await {
            Ok(blocks) => Command::SubmitContent {
                content: with_text(text, blocks),
                delivery,
            },
            Err((code, message)) => {
                return Ack::refused(command, Status::Rejected, code, message, revision);
            }
        }
    };
    live.remember_input(command, input_meta(envelope, payload, requested, admitted));
    let result = json!({"type": "inputAccepted", "delivery": admitted, "inputId": command});
    match send(handle, command, submit).await {
        KernelAck::Accepted { .. } => Ack::accepted(command, revision, Some(result)),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, revision, Some(result))),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "guard.inputRejected",
            reason,
            revision,
        ),
    }
}

async fn resolve(
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let payload = &envelope.payload;
    let interaction = payload["interactionId"].as_str().unwrap_or_default();
    let option = payload["answer"]["optionId"].as_str();
    let pending = handle.view().await.ok().and_then(|view| {
        view.pending
            .into_iter()
            .find(|(id, _)| id.as_str() == interaction)
            .map(|(_, request)| request)
    });
    let Some(InteractionRequest::Permission {
        suggestions,
        tool_use: tool,
        ..
    }) = pending
    else {
        return Ack::refused(
            &envelope.command_id,
            Status::Noop,
            "proto.alreadyResolved",
            "the interaction is no longer pending",
            revision,
        );
    };
    // “完全访问”：先把会话切到 yolo（之后不再询问），再放行这一次。
    if option == Some("fullAccess") {
        send(
            handle,
            &format!("{}:mode", envelope.command_id),
            Command::SetMode {
                mode: PermissionMode::BypassPermissions,
            },
        )
        .await;
    }
    let answer = match option {
        Some("allowOnce" | "fullAccess") => PermissionAnswer::Allow {
            remember: Vec::new(),
        },
        Some("allowAlways") => PermissionAnswer::Allow {
            remember: suggestions,
        },
        _ => PermissionAnswer::Deny {
            feedback: payload["answer"]["freeText"]
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
        },
    };
    if let PermissionAnswer::Deny { .. } = &answer {
        live.deny(&tool);
    }
    let command = Command::ResolveInteraction {
        interaction: InteractionId::new(interaction),
        answer: serde_json::to_value(answer).unwrap_or(Value::Null),
    };
    // 与 Node 相同：ACK 不带 result（答案已经进了会话，投影随事件更新）。
    match send(handle, &envelope.command_id, command).await {
        KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
        KernelAck::Duplicate => {
            inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None))
        }
        KernelAck::Rejected { reason } => Ack::refused(
            &envelope.command_id,
            Status::Noop,
            "proto.alreadyResolved",
            reason,
            revision,
        ),
    }
}

/// setFollowupMode（CAS）：跟进方式是协议保存的配置；裁决用会话 actor 的当前 revision（G1）。
async fn set_followup(
    server: &Server,
    handle: &dyn SessionHandle,
    live: &std::sync::Arc<rust_cli_protocol_core::sessions::Bridged<crate::live::Live>>,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let revision = match handle.view().await {
        Ok(view) => view.revision,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Failed,
                "fault.command.sessionUnavailable",
                error.to_string(),
                0,
            );
        }
    };
    let Some(wanted) = envelope.payload["mode"].as_str().and_then(Followup::parse) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "unknown followup mode",
            revision,
        );
    };
    // Node 的 setFollowupMode 无条件执行（幂等 accepted），没有同值 noop。
    if let Some(stale) = cas_check_with_epoch(
        command,
        envelope.base_revision,
        envelope.base_log_epoch.as_deref(),
        revision,
        &live.sink.epoch(),
        false,
    ) {
        return stale;
    }
    if let Some(session) = &envelope.session_id {
        server
            .followups
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(SessionId::new(session), wanted);
    }
    // 增量在会话的泵任务里发（与内核事件的帧同一个顺序）。
    let sink = live.sink.clone();
    live.run(Box::pin(async move { sink.set_followup(wanted).await }));
    Ack::accepted(command, revision, None)
}

/// NIBI `switchModelConfig`：CAS 命令，扁平 provider/model/thought → `Command::SetModel`。
async fn switch_model_config(
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let view = match handle.view().await {
        Ok(view) => view,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Failed,
                "fault.command.sessionUnavailable",
                error.to_string(),
                0,
            );
        }
    };
    let Some(chosen) = model_config_selection(&envelope.payload) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "switchModelConfig needs provider, model and thought",
            view.revision,
        );
    };
    if view.selection == chosen {
        return Ack::refused(
            command,
            Status::Noop,
            "config.unchanged",
            "the model is already set",
            view.revision,
        );
    }
    if let Some(stale) = cas_check_with_epoch(
        command,
        envelope.base_revision,
        envelope.base_log_epoch.as_deref(),
        view.revision,
        &live.epoch(),
        false,
    ) {
        return stale;
    }
    match send(handle, command, Command::SetModel { selection: chosen }).await {
        KernelAck::Accepted { .. } => Ack::accepted(command, view.revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, view.revision, None)),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "guard.modelRejected",
            reason,
            view.revision,
        ),
    }
}

/// NIBI `switchCollaborationMode`：CAS 命令，mode → `Command::SetMode`（plan 是旧写法，开 plan）。
async fn switch_collaboration_mode(
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let view = match handle.view().await {
        Ok(view) => view,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Failed,
                "fault.command.sessionUnavailable",
                error.to_string(),
                0,
            );
        }
    };
    let Some((permission, plan)) = mode(&envelope.payload["mode"], None) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "unknown collaboration mode",
            view.revision,
        );
    };
    // 与 Node 对拍：switchCollaborationMode 同值仍回 accepted（Node 无条件 setMode，
    // 没有同值 noop；同值 noop 只存在于 switchModelConfig）。
    if view.mode == permission && view.plan == plan {
        return Ack::accepted(command, view.revision, None);
    }
    if let Some(stale) = cas_check_with_epoch(
        command,
        envelope.base_revision,
        envelope.base_log_epoch.as_deref(),
        view.revision,
        &live.epoch(),
        false,
    ) {
        return stale;
    }
    if view.mode != permission {
        let mode_id = format!("{command}:mode");
        match send(handle, &mode_id, Command::SetMode { mode: permission }).await {
            KernelAck::Accepted { .. } | KernelAck::Duplicate => {}
            KernelAck::Rejected { reason } => {
                return Ack::refused(
                    command,
                    Status::Rejected,
                    "guard.modeRejected",
                    reason,
                    view.revision,
                );
            }
        }
    }
    if view.plan != plan {
        let plan_id = format!("{command}:plan");
        match send(handle, &plan_id, Command::SetPlan { enabled: plan }).await {
            KernelAck::Accepted { .. } | KernelAck::Duplicate => {}
            KernelAck::Rejected { reason } => {
                return Ack::refused(
                    command,
                    Status::Rejected,
                    "guard.planRejected",
                    reason,
                    view.revision,
                );
            }
        }
    }
    Ack::accepted(command, view.revision, None)
}

/// NIBI `compact`：非 CAS；idle 立即 / busy 由会话 actor 排队（kernel compaction 编排）。
async fn compact_session(handle: &dyn SessionHandle, envelope: &Envelope, revision: u64) -> Ack {
    let command = envelope.command_id.as_str();
    match send(handle, command, Command::Compact { instructions: None }).await {
        KernelAck::Accepted { .. } => Ack::accepted(command, revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, revision, None)),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "fault.command.compactFailed",
            reason,
            revision,
        ),
    }
}

/// NIBI `renameSession`：非 CAS；标题来源由会话 actor 记为 custom。
async fn rename_session(handle: &dyn SessionHandle, envelope: &Envelope, revision: u64) -> Ack {
    let command = envelope.command_id.as_str();
    let Some(title) = envelope.payload["title"].as_str().map(str::to_owned) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "renameSession needs a title",
            revision,
        );
    };
    match send(handle, command, Command::Rename { title }).await {
        KernelAck::Accepted { .. } => Ack::accepted(command, revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, revision, None)),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "fault.command.renameFailed",
            reason,
            revision,
        ),
    }
}

/// NIBI `cancelBackgroundWork`：workId（=runId/后台任务 id）→ `Command::StopTask`。
/// kernel 明确回"没取消任何东西"时按 NIBI 词表上行 rejected（§5.2.1 行 28）。
async fn cancel_background_work(
    handle: &dyn SessionHandle,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let command = envelope.command_id.as_str();
    let Some(work) = envelope.payload["workId"].as_str().map(str::to_owned) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "cancelBackgroundWork needs a workId",
            revision,
        );
    };
    match send(handle, command, Command::StopTask { task: work }).await {
        KernelAck::Accepted { .. } => Ack::accepted(command, revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, revision, None)),
        KernelAck::Rejected { reason } => {
            // 与 Node 对拍：明确"没取消任何东西"时是 failed（不是 rejected），
            // 码是 fault.command.backgroundWorkCancelRejected.<not_found|not_running|...>。
            let code = background_work_cancel_code(&reason);
            Ack::refused(
                command,
                Status::Failed,
                &format!("{BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX}{code}"),
                reason,
                revision,
            )
        }
    }
}

/// retryTurn 的行解析结果：该轮的 user 消息（rewind 锚点）与原文（rewind 前解析）。
#[derive(Debug, PartialEq)]
struct RetryTarget {
    user_message: String,
    text: String,
    /// 原始输入的内容块：重发时保留图片等非文本块（附件回放）。
    content: Vec<ContentBlock>,
}

/// assistant 行 → 该轮 user 消息：视图里定位 assistant 消息，向前找最近的 user 消息。
/// Node 的守护（`guard.latestAssistantRetryOnly`）：只许重试最后一轮 assistant 回复——
/// 历史回复 retry 会回退 active branch，直接拒绝；合成消息（Attachment/System）跳过。
fn retry_target(messages: &[rust_cli_kernel_api::message::Message]) -> Result<RetryTarget, String> {
    // latest 守卫：最后一条消息必须是 assistant（有回复才能重试）。
    let position = messages
        .len()
        .checked_sub(1)
        .ok_or("the conversation is empty")?;
    if !matches!(
        messages[position],
        rust_cli_kernel_api::message::Message::Assistant(_)
    ) {
        return Err(
            "guard.latestAssistantRetryOnly: retryTurn only retries the latest assistant reply"
                .to_owned(),
        );
    }
    let user = messages[..position]
        .iter()
        .rev()
        .find(|message| matches!(message, rust_cli_kernel_api::message::Message::User(_)))
        .ok_or("no user input before the assistant reply")?;
    let rust_cli_kernel_api::message::Message::User(user_message) = user else {
        return Err("no user input before the assistant reply".to_owned());
    };
    let text = user_message
        .content
        .iter()
        .filter_map(|block| match block {
            rust_cli_kernel_api::message::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(
            "
",
        );
    // 只有图片、没有正文的消息也能重发（Node 允许 attachment-only 的输入）。
    let has_media = user_message
        .content
        .iter()
        .any(|block| !matches!(block, ContentBlock::Text { .. }));
    if text.is_empty() && !has_media {
        return Err("the original user input has no text to resend".to_owned());
    }
    Ok(RetryTarget {
        user_message: user_message.id.as_str().to_owned(),
        text,
        content: user_message.content.clone(),
    })
}

/// NIBI `forkAssistant`：row-targeting CAS（revision+epoch）；稳定 assistant 行 → `Command::Fork`。
async fn fork_assistant(
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let revision = match handle.view().await {
        Ok(view) => view.revision,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Failed,
                "fault.command.sessionUnavailable",
                error.to_string(),
                0,
            );
        }
    };
    if let Some(stale) = cas_check_with_epoch(
        command,
        envelope.base_revision,
        envelope.base_log_epoch.as_deref(),
        revision,
        &live.epoch(),
        true,
    ) {
        return stale;
    }
    let Some(target) = target_row(&envelope.payload) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "forkAssistant needs a row target",
            revision,
        );
    };
    let Some(row) = live.row(target.row_id) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            format!("row {} does not exist", target.row_id),
            revision,
        );
    };
    let message = match row_message_id(&row, &target.entity) {
        Ok(message) => message,
        Err(reason) => {
            return Ack::refused(
                command,
                Status::Rejected,
                "proto.invalidPayload",
                reason,
                revision,
            );
        }
    };
    match send(
        handle,
        command,
        Command::Fork {
            at: Some(rust_cli_kernel_api::ids::MessageId::new(message)),
        },
    )
    .await
    {
        KernelAck::Accepted { result } => {
            let session = result.as_str().unwrap_or_default().to_owned();
            Ack::accepted(
                command,
                revision,
                Some(json!({"type": "forkAssistant", "sessionId": session})),
            )
        }
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, revision, None)),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "fault.command.forkFailed",
            reason,
            revision,
        ),
    }
}

/// NIBI `retryTurn`：row-targeting CAS；rewind 截断该轮（user+assistant 一起切）后
/// 重发原 user 文本。原文在 rewind 之前解析（截断后拿不到）；running 中同样先 CAS——
/// 最后一轮 retry 允许打断在跑的回合（与 Node 的 preempt 等价的原子性由 kernel 的
/// actor 串行保证：Rewind 与 Submit 顺序进队列，中途失败也不丢原文）。
async fn retry_turn(
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let view = match handle.view().await {
        Ok(view) => view,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Failed,
                "fault.command.sessionUnavailable",
                error.to_string(),
                0,
            );
        }
    };
    if let Some(stale) = cas_check_with_epoch(
        command,
        envelope.base_revision,
        envelope.base_log_epoch.as_deref(),
        view.revision,
        &live.epoch(),
        true,
    ) {
        return stale;
    }
    // target {rowId, entityId} 只是客户端的 UI 提示；latest 守卫保证只重试最后一轮。
    // 直接从 transcript 解析（不经投影行——rewind 后投影行可能还没重放）。
    let retry = match retry_target(&view.messages) {
        Ok(retry) => retry,
        Err(reason) => {
            let code = reason.split(':').next().unwrap_or_default().to_owned();
            let reason_code = if code.starts_with("guard.") {
                code
            } else {
                "proto.invalidPayload".to_owned()
            };
            return Ack::refused(
                command,
                Status::Rejected,
                &reason_code,
                reason,
                view.revision,
            );
        }
    };
    // 1) 截断：target 是该轮的 user 消息（kernel 语义：历史截到 target 之前）。
    match send(
        handle,
        &format!("{command}:rewind"),
        Command::Rewind {
            target: rust_cli_kernel_api::ids::MessageId::new(retry.user_message),
            scope: RewindScope::Conversation,
        },
    )
    .await
    {
        KernelAck::Accepted { .. } | KernelAck::Duplicate => {}
        KernelAck::Rejected { reason } => {
            return Ack::refused(
                command,
                Status::Rejected,
                "fault.command.retryFailed",
                reason,
                view.revision,
            );
        }
    }
    // 2) 重发原文（有图片时带原内容块）；idle 下 Queue 落成 startNow（与 sendText 的准入同判）。
    let submit = if retry
        .content
        .iter()
        .all(|block| matches!(block, ContentBlock::Text { .. }))
    {
        Command::Submit {
            text: retry.text,
            attachments: Vec::new(),
            delivery: Delivery::Queue,
        }
    } else {
        Command::SubmitContent {
            content: retry.content,
            delivery: Delivery::Queue,
        }
    };
    match send(handle, command, submit).await
    {
        KernelAck::Accepted { .. } => Ack::accepted(command, view.revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, view.revision, None)),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "guard.inputRejected",
            reason,
            view.revision,
        ),
    }
}

/// NIBI 投影里的 `queueItemId` 是 `queue_<commandId>`（`projection::queue_state`）；内核的队列项
/// 按命令 ID 认。剥掉前缀再交给内核。
fn queue_command(queue_item_id: &str) -> CommandId {
    CommandId::new(
        queue_item_id
            .strip_prefix("queue_")
            .unwrap_or(queue_item_id),
    )
}

/// 队列项缺失时的拒绝码（与 Node 的 `V4CommandNoopError("queue.itemMissing")` 同义）。
fn queue_missing(envelope: &Envelope, revision: u64) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Noop,
        "queue.itemMissing",
        "the queue item is no longer queued",
        revision,
    )
}

/// NIBI `editQueueItem`：同 id 原地更新正文。
async fn edit_queue_item(handle: &dyn SessionHandle, envelope: &Envelope) -> Ack {
    let revision = handle.view().await.map(|view| view.revision).unwrap_or(0);
    let Some(item) = envelope.payload["queueItemId"].as_str() else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "editQueueItem needs a queueItemId",
            revision,
        );
    };
    let text = envelope.payload["newText"].as_str().unwrap_or_default().to_owned();
    match send(
        handle,
        &envelope.command_id,
        Command::EditQueued {
            item: queue_command(item),
            text,
        },
    )
    .await
    {
        KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None)),
        // Node 的 editQueueItem 未命中只记 warn、按成功收口（并发 drain 的竞态）。
        KernelAck::Rejected { reason } => {
            tracing::warn!(event = "protocol.edit_queue_item.missed", reason = %reason);
            Ack::accepted(&envelope.command_id, revision, None)
        }
    }
}

/// NIBI `deleteQueueItem`：移除排队项；未命中是 noop（并发 drain 的竞态）。
async fn delete_queue_item(handle: &dyn SessionHandle, envelope: &Envelope) -> Ack {
    let revision = handle.view().await.map(|view| view.revision).unwrap_or(0);
    let Some(item) = envelope.payload["queueItemId"].as_str() else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "deleteQueueItem needs a queueItemId",
            revision,
        );
    };
    match send(
        handle,
        &envelope.command_id,
        Command::DeleteQueued {
            item: queue_command(item),
        },
    )
    .await
    {
        KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None)),
        KernelAck::Rejected { .. } => queue_missing(envelope, revision),
    }
}

/// NIBI `reorderQueueItem`：`beforeQueueItemId = null` 移到队尾。
async fn reorder_queue_item(handle: &dyn SessionHandle, envelope: &Envelope) -> Ack {
    let revision = handle.view().await.map(|view| view.revision).unwrap_or(0);
    let Some(item) = envelope.payload["queueItemId"].as_str() else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "reorderQueueItem needs a queueItemId",
            revision,
        );
    };
    let before = envelope.payload["beforeQueueItemId"]
        .as_str()
        .map(queue_command);
    match send(
        handle,
        &envelope.command_id,
        Command::ReorderQueued {
            item: queue_command(item),
            before,
        },
    )
    .await
    {
        KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None)),
        // Node 的 reorderQueueItem 未命中同样只 warn、按成功收口。
        KernelAck::Rejected { reason } => {
            tracing::warn!(event = "protocol.reorder_queue_item.missed", reason = %reason);
            Ack::accepted(&envelope.command_id, revision, None)
        }
    }
}

/// NIBI `setAutoDrain`：开关自动排空；打开时内核自己会把空闲的队首开起来。
async fn set_auto_drain(handle: &dyn SessionHandle, envelope: &Envelope) -> Ack {
    let revision = handle.view().await.map(|view| view.revision).unwrap_or(0);
    let enabled = envelope.payload["autoDrain"].as_bool().unwrap_or(false);
    match send(
        handle,
        &envelope.command_id,
        Command::SetAutoDrain { enabled },
    )
    .await
    {
        KernelAck::Accepted { .. } => Ack::accepted(
            &envelope.command_id,
            revision,
            Some(json!({"type": "setAutoDrain", "autoDrain": enabled})),
        ),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(
            &envelope.command_id,
            revision,
            Some(json!({"type": "setAutoDrain", "autoDrain": enabled})),
        )),
        KernelAck::Rejected { reason } => Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "fault.command.autoDrainFailed",
            reason,
            revision,
        ),
    }
}

/// NIBI `sendQueuedNow`：把一项立刻发出（忙时先中止当前回合）。带 `modelSelection` 时先作用到会话。
async fn send_queued_now(handle: &dyn SessionHandle, envelope: &Envelope, revision: u64) -> Ack {
    let Some(item) = envelope.payload["queueItemId"].as_str() else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "sendQueuedNow needs a queueItemId",
            revision,
        );
    };
    if let Some(chosen) = selection(&envelope.payload["modelSelection"]) {
        let _ = send(
            handle,
            &format!("{}:model", envelope.command_id),
            Command::SetModel { selection: chosen },
        )
        .await;
    }
    match send(
        handle,
        &envelope.command_id,
        Command::SendQueuedNow {
            item: queue_command(item),
        },
    )
    .await
    {
        KernelAck::Accepted { .. } => Ack::accepted(
            &envelope.command_id,
            revision,
            Some(json!({"type": "sendQueuedNow", "inputId": queue_command(item)})),
        ),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(
            &envelope.command_id,
            revision,
            Some(json!({"type": "sendQueuedNow", "inputId": queue_command(item)})),
        )),
        // Node 的 sendQueuedNow 未命中抛无 reasonCode 的领域错误 → failed + executionFailed。
        KernelAck::Rejected { reason } => Ack::refused(
            &envelope.command_id,
            Status::Failed,
            "fault.command.executionFailed",
            reason,
            revision,
        ),
    }
}

/// NIBI `createSelectionSideSession`：派生一个侧聊会话（复制整段对话，选择可覆盖），
/// 带 `firstInput` 时在**新会话**里提交首条输入。返回 `{type, sessionId}`。
async fn create_selection_side_session(
    server: &Server,
    handle: &dyn SessionHandle,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let revision = handle.view().await.map(|view| view.revision).unwrap_or(0);
    let first = &envelope.payload["firstInput"];
    // firstInput.modelSelection 是侧聊自己的选择（Node 的 createSelectionSideConversation 同义）；
    // 缺席时继承当前会话。
    let selection = selection(&first["modelSelection"]);
    let child = match send(
        handle,
        &format!("{command}:side"),
        Command::CreateSelectionSideSession {
            selection: selection.clone(),
        },
    )
    .await
    {
        KernelAck::Accepted { result } => match result["session"].as_str() {
            Some(session) => SessionId::new(session),
            None => {
                return Ack::refused(
                    command,
                    Status::Failed,
                    "fault.command.sideSessionFailed",
                    "the kernel returned no side session id",
                    revision,
                );
            }
        },
        KernelAck::Duplicate => {
            return inbox::duplicate(&Ack::accepted(command, revision, None));
        }
        KernelAck::Rejected { reason } => {
            return Ack::refused(
                command,
                Status::Rejected,
                "guard.sideSessionRejected",
                reason,
                revision,
            );
        }
    };
    if let Some(text) = first["text"].as_str() {
        match server.kernel.open_session(&child).await {
            Ok(child_handle) => {
                let submit = Command::Submit {
                    text: text.to_owned(),
                    attachments: Vec::new(),
                    delivery: Delivery::Queue,
                };
                if let KernelAck::Rejected { reason } =
                    send(child_handle.as_ref(), &format!("{command}:input"), submit).await
                {
                    tracing::warn!(
                        event = "protocol.side_session.first_input_rejected",
                        session = %child,
                        reason = %reason,
                        "the side session rejected the first input"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(
                    event = "protocol.side_session.open_failed",
                    session = %child,
                    error = %error,
                    "the side session could not be opened for the first input"
                );
            }
        }
    }
    Ack::accepted(
        command,
        revision,
        Some(json!({"type": "createSelectionSideSession", "sessionId": child.as_str()})),
    )
}

/// NIBI `sendGoalCommand`：设置/替换目标。Node 把 `/goal`、`/target` 前缀与 `replace` 一并归一，
/// 然后按一次真实的人类输入提交（设置目标并开始推进）。plan 模式与目标互斥（Node 的
/// `guard.planGoalMutuallyExclusive`）。
async fn send_goal_command(handle: &dyn SessionHandle, envelope: &Envelope) -> Ack {
    let command = envelope.command_id.as_str();
    let view = match handle.view().await {
        Ok(view) => view,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Failed,
                "fault.command.sessionUnavailable",
                error.to_string(),
                0,
            );
        }
    };
    if view.plan {
        return Ack::refused(
            command,
            Status::Rejected,
            "guard.planGoalMutuallyExclusive",
            "Plan and Goal cannot be active at the same time.",
            view.revision,
        );
    }
    let objective = goal_objective(envelope.payload["text"].as_str().unwrap_or_default());
    if objective.is_empty() {
        return Ack::refused(
            command,
            Status::Rejected,
            "fault.command.goalRejected.emptyObjective",
            "Usage: /goal <objective>",
            view.revision,
        );
    }
    // 与 sendText 同一条准入：先作用本次的模型与模式。
    if let Some(chosen) = selection(&envelope.payload["modelSelection"]) {
        let _ = send(
            handle,
            &format!("{command}:model"),
            Command::SetModel { selection: chosen },
        )
        .await;
    }
    if let Some((permission, plan)) = mode(&envelope.payload["mode"], envelope.payload["planEnabled"].as_bool())
        && (view.mode != permission || view.plan != plan)
    {
        let _ = send(
            handle,
            &format!("{command}:mode"),
            Command::SetMode { mode: permission },
        )
        .await;
        let _ = send(
            handle,
            &format!("{command}:plan"),
            Command::SetPlan { enabled: plan },
        )
        .await;
    }
    match send(
        handle,
        command,
        Command::Submit {
            text: format!("/goal {objective}"),
            attachments: Vec::new(),
            delivery: Delivery::Queue,
        },
    )
    .await
    {
        KernelAck::Accepted { .. } => Ack::accepted(
            command,
            view.revision,
            Some(json!({"type": "sendGoalCommand", "objective": objective})),
        ),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, view.revision, None)),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "guard.inputRejected",
            reason,
            view.revision,
        ),
    }
}

/// `/goal`、`/target` 前缀与开头的 `replace` 归一（Node 的 `parseGoalObjectiveFromCommandText`）。
fn goal_objective(text: &str) -> String {
    let trimmed = text.trim();
    let rest = match trimmed.get(..5).filter(|prefix| prefix.eq_ignore_ascii_case("/goal")) {
        Some(_) => &trimmed[5..],
        None => match trimmed.get(..7).filter(|prefix| prefix.eq_ignore_ascii_case("/target")) {
            Some(_) => &trimmed[7..],
            None => trimmed,
        },
    };
    let rest = rest.trim();
    match rest.get(..7).filter(|prefix| prefix.eq_ignore_ascii_case("replace")) {
        Some(_) if rest.len() == 7 || rest[7..].starts_with(char::is_whitespace) => rest[7..].trim(),
        _ => rest,
    }
    .to_owned()
}

/// NIBI `pauseGoal` / `resumeGoal`：暂停或恢复目标的续跑；没有目标时幂等成功。
async fn set_goal_paused(handle: &dyn SessionHandle, envelope: &Envelope, paused: bool) -> Ack {
    let command = envelope.command_id.as_str();
    let revision = handle.view().await.map(|view| view.revision).unwrap_or(0);
    match send(handle, command, Command::SetGoalPaused { paused }).await {
        KernelAck::Accepted { result } => Ack::accepted(
            command,
            revision,
            Some(json!({
                "type": if paused { "pauseGoal" } else { "resumeGoal" },
                "active": result["active"],
                "paused": result["paused"],
            })),
        ),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, revision, None)),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "fault.command.goalRejected.persistenceFailed",
            reason,
            revision,
        ),
    }
}

/// NIBI `setAssistantFeedback`：给一条 assistantText 行点/取消赞踩。反馈落成前端记录
/// （`assistant_feedback`，key 是 assistant 消息 id），同时在活投影里更新那一行。
async fn set_assistant_feedback(
    server: &Server,
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let revision = handle.view().await.map(|view| view.revision).unwrap_or(0);
    let Some(target) = target_row(&envelope.payload) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "setAssistantFeedback needs a row target",
            revision,
        );
    };
    let Some(row) = live.row(target.row_id) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            format!("row {} does not exist", target.row_id),
            revision,
        );
    };
    if row.get("kind").and_then(Value::as_str) != Some("assistantText")
        || row.get("entityId").and_then(Value::as_str) != Some(target.entity.as_str())
    {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "setAssistantFeedback targets an assistantText row",
            revision,
        );
    }
    let Some(message) = row.get("assistantResponseId").and_then(Value::as_str) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "the assistant row has no settled response id",
            revision,
        );
    };
    let feedback = match envelope.payload["feedback"].as_str() {
        Some("like") | Some("dislike") => {
            Some(envelope.payload["feedback"].as_str().unwrap_or_default().to_owned())
        }
        Some(other) => {
            return Ack::refused(
                command,
                Status::Rejected,
                "proto.invalidPayload",
                format!("unknown feedback {other}"),
                revision,
            );
        }
        // null = 取消反馈。
        None => None,
    };
    let record = rust_cli_kernel_api::store::FrontendRecord {
        kind: "assistant_feedback".to_owned(),
        key: message.to_owned(),
        data: json!({"feedback": feedback}),
    };
    if let Err(error) = server.kernel.put_session_record(handle.id(), record).await {
        return Ack::refused(
            command,
            Status::Failed,
            "fault.command.assistantFeedbackUnsupported",
            error.to_string(),
            revision,
        );
    }
    live.set_feedback(message, feedback).await;
    Ack::accepted(command, revision, Some(json!({"type": "setAssistantFeedback"})))
}

/// NIBI `snoozeInteractionAutoResolution`：永久暂停这条询问的自动结束。内核没有自动结束的倒计时
/// （`askUserQuestionAutoResolutionEnabled` 只记录偏好），所以这条命令在这里是幂等 noop——与 Node 在
/// "没有进行中的倒计时"时的行为一致。
async fn snooze_interaction_auto_resolution(envelope: &Envelope) -> Ack {
    let interaction = envelope.payload["interactionId"]
        .as_str()
        .unwrap_or_default();
    tracing::info!(
        event = "protocol.snooze_auto_resolution",
        interaction = %interaction,
        "the kernel does not schedule auto resolution; the snooze is already in effect"
    );
    Ack::accepted(&envelope.command_id, 0, Some(json!({"type": "snoozeInteractionAutoResolution"})))
}

/// NIBI `applyFileRewind`：row-targeting CAS；只回退文件（`RewindScope::Code`），不动聊天。
async fn apply_file_rewind(
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let revision = match handle.view().await {
        Ok(view) => view.revision,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Failed,
                "fault.command.sessionUnavailable",
                error.to_string(),
                0,
            );
        }
    };
    if let Some(stale) = cas_check_with_epoch(
        command,
        envelope.base_revision,
        envelope.base_log_epoch.as_deref(),
        revision,
        &live.epoch(),
        true,
    ) {
        return stale;
    }
    let Some(target) = target_row(&envelope.payload) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "applyFileRewind needs a row target",
            revision,
        );
    };
    let Some(row) = live.row(target.row_id) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            format!("row {} does not exist", target.row_id),
            revision,
        );
    };
    let message = match row_message_id(&row, &target.entity) {
        Ok(message) => message,
        Err(reason) => {
            return Ack::refused(
                command,
                Status::Rejected,
                "proto.invalidPayload",
                reason,
                revision,
            );
        }
    };
    match send(
        handle,
        command,
        Command::Rewind {
            target: rust_cli_kernel_api::ids::MessageId::new(message),
            scope: RewindScope::Code,
        },
    )
    .await
    {
        KernelAck::Accepted { .. } => Ack::accepted(command, revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, revision, None)),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "fault.command.fileRewindFailed",
            reason,
            revision,
        ),
    }
}

/// NIBI `editUserQuery`：换文本的 retryTurn。target 是 real user 行（entityId 即该
/// user 消息 id）→ `guard.latestQueryEditOnly` → rewind 截断该轮 → 重发 newText。
/// 附件（图片）与 newText 一起重发；其他类型 fail-closed 拒绝（`attachmentUnsupported`）。
/// 与 Node 的差异（记录在案）：
/// - workspaceMode=rewind 直接用 kernel `Rewind{scope: Both}`（文件+对话一次提交），
///   Node 的 preview/blocked UI 流（guard.workspaceRewind*）暂无对应 ACK 形状；
/// - conversationQuotes 暂不消费：出现时 warn（不静默）。
async fn edit_user_query(
    server: &Server,
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let view = match handle.view().await {
        Ok(view) => view,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Failed,
                "fault.command.sessionUnavailable",
                error.to_string(),
                0,
            );
        }
    };
    if let Some(stale) = cas_check_with_epoch(
        command,
        envelope.base_revision,
        envelope.base_log_epoch.as_deref(),
        view.revision,
        &live.epoch(),
        true,
    ) {
        return stale;
    }
    let Some(target) = target_row(&envelope.payload) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "editUserQuery needs a row target",
            view.revision,
        );
    };
    let Some(row) = live.row(target.row_id) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            format!("row {} does not exist", target.row_id),
            view.revision,
        );
    };
    // user 行：kind=userInput、origin=realUser、entityId 即 user 消息 id。
    if row.get("kind").and_then(Value::as_str) != Some("userInput")
        || row.get("origin").and_then(Value::as_str) != Some("realUser")
        || row.get("entityId").and_then(Value::as_str) != Some(target.entity.as_str())
    {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "editUserQuery targets a real user query row",
            view.revision,
        );
    }
    // 附件随改写一起重发（Node 允许 attachment-only 的改写）。
    let refs = envelope.payload["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if envelope
        .payload
        .get("conversationQuotes")
        .is_some_and(|quotes| quotes.as_array().is_some_and(|items| !items.is_empty()))
    {
        tracing::warn!(
            event = "protocol.edit_user_query.quotes_unsupported",
            "editUserQuery carries conversation quotes; they are not replayed yet"
        );
    }
    let Some(new_text) = envelope.payload["newText"].as_str().map(str::to_owned) else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "editUserQuery needs newText",
            view.revision,
        );
    };
    if new_text.trim().is_empty() && refs.is_empty() {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            "input must not be empty",
            view.revision,
        );
    }
    if let Err(reason) = edit_target_guard(&view.messages, &target.entity) {
        let code = reason.split(':').next().unwrap_or_default().to_owned();
        let reason_code = if code.starts_with("guard.") {
            code
        } else {
            "proto.invalidPayload".to_owned()
        };
        return Ack::refused(
            command,
            Status::Rejected,
            &reason_code,
            reason,
            view.revision,
        );
    }
    // 本次执行带的标准 Selection 先作用到会话（与 sendText 同判）。
    if let Some(chosen) = selection(&envelope.payload["modelSelection"])
        && view.selection != chosen
    {
        match send(
            handle,
            &format!("{command}:model"),
            Command::SetModel { selection: chosen },
        )
        .await
        {
            KernelAck::Accepted { .. } | KernelAck::Duplicate => {}
            KernelAck::Rejected { reason } => {
                return Ack::refused(
                    command,
                    Status::Rejected,
                    "guard.modelRejected",
                    reason,
                    view.revision,
                );
            }
        }
    }
    let scope = if envelope.payload["workspaceMode"].as_str() == Some("rewind") {
        RewindScope::Both
    } else {
        RewindScope::Conversation
    };
    match send(
        handle,
        &format!("{command}:rewind"),
        Command::Rewind {
            target: rust_cli_kernel_api::ids::MessageId::new(target.entity.clone()),
            scope,
        },
    )
    .await
    {
        KernelAck::Accepted { .. } | KernelAck::Duplicate => {}
        KernelAck::Rejected { reason } => {
            return Ack::refused(
                command,
                Status::Rejected,
                "fault.command.editFailed",
                reason,
                view.revision,
            );
        }
    }
    // 带附件时连同图片内容块重发（attachment-only 的改写也在这里落成同一条写路径）。
    let submit = if refs.is_empty() {
        Command::Submit {
            text: new_text,
            attachments: Vec::new(),
            delivery: Delivery::Queue,
        }
    } else {
        let blocks =
            match attachment_blocks(&server.kernel, handle.id(), &view.meta.workspace, &refs).await {
                Ok(blocks) => blocks,
                Err((code, message)) => {
                    return Ack::refused(command, Status::Rejected, code, message, view.revision);
                }
            };
        Command::SubmitContent {
            content: with_text(new_text, blocks),
            delivery: Delivery::Queue,
        }
    };
    match send(handle, command, submit).await {
        KernelAck::Accepted { .. } => Ack::accepted(
            command,
            view.revision,
            Some(json!({"type": "editUserQuery", "disposition": "rewind"})),
        ),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, view.revision, None)),
        KernelAck::Rejected { reason } => Ack::refused(
            command,
            Status::Rejected,
            "guard.inputRejected",
            reason,
            view.revision,
        ),
    }
}

/// NIBI `deleteSession`：存储软删除（migration 0023 的 `time_deleted`）。
/// 打开着的会话先关（kernel `delete_session` 对打开着的返回 Failed——与 Node 同判）。
async fn delete_session(server: &Server, envelope: &Envelope) -> Ack {
    let command = envelope.command_id.as_str();
    let Some(session) = envelope.session_id.as_deref() else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.sessionRequired",
            "deleteSession needs a sessionId",
            0,
        );
    };
    let session_id = SessionId::new(session);
    match server.kernel.delete_session(&session_id).await {
        Ok(()) => {
            // bridge 的打开会话由 kernel 的 delete 处理（下次 open 同 id 会 NotFound）。
            Ack::accepted(command, 0, Some(json!({"type": "deleteSession"})))
        }
        Err(error) => {
            let text = error.to_string();
            Ack::refused(
                command,
                Status::Rejected,
                "fault.command.deleteFailed",
                text,
                0,
            )
        }
    }
}

/// `v4/commands/query`：内存表，然后命令事实（G2）；都没有时 unknown。时钟探测带 `clock`。
pub async fn query(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let received = server.context.now();
    let mut results = Vec::new();
    for key in params["commands"].as_array().into_iter().flatten() {
        let session = key["sessionId"].as_str();
        let command = key["commandId"].as_str().unwrap_or_default();
        let known = server
            .remembered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&inbox::key(session, command))
            .cloned();
        let known = match (known, session) {
            (Some(ack), _) => Some(ack),
            (None, Some(session)) => server
                .kernel
                .session_records(&SessionId::new(session), inbox::COMMAND_FACT)
                .await
                .ok()
                .and_then(|records| inbox::find_fact(&records, command)),
            (None, None) => None,
        };
        results.push(json!({
            "key": {"sessionId": session, "commandId": command},
            "result": known.map_or(json!("unknown"), |ack| ack.to_value()),
        }));
    }
    let mut reply = json!({"results": results});
    if params["clock"] == true {
        reply["clock"] = json!({
            "instanceId": server.instance,
            "receivedAt": received,
            "sentAt": server.context.now(),
        });
    }
    Ok(reply)
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;

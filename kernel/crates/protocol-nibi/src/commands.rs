//! 命令的处理（[`crate::inbox`] 的裁决与转交）：P1 的五个命令。

use nibi_kernel_api::attachment::AttachmentSource;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{CommandId, InteractionId, SessionId};
use nibi_kernel_api::interaction::{
    PermissionAnswer, PlanApprovalAnswer, QuestionAnnotation, QuestionAnswer,
};
use nibi_kernel_api::message::{ContentBlock, ImageSource};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::orchestration::InteractionRequest;
use nibi_kernel_api::permission::{PermissionMode, PermissionRule};
use nibi_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandEnvelope, CreateSession, Delivery, KernelError, RewindScope,
    SessionHandle,
};
use nibi_kernel_api::store::SessionFilter;
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Map, Value, json};

use crate::conversation_intent;
use crate::inbound::Inbound;
use crate::inbox::{self, Ack, Envelope, Status};
use crate::projection::InputMeta;
use crate::projection::state::{Followup, Phase};
use crate::server::{Server, kernel_error};

/// App 的模型选择 → 内核的选择。
pub(crate) fn selection(value: &Value) -> Option<ModelSelection> {
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
pub(crate) fn mode(value: &Value, plan: Option<bool>) -> Option<(PermissionMode, bool)> {
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

/// 一条附件引用 → 读取来源：`nibi-artifact://` 走 artifact 存储，其余按本机路径。
///
/// 类型不在这里过滤：认不出的类型也要先判一次（`attachment_blocks` 决定读内容还是只留一行说明）。
fn attachment_source(reference: &Value) -> Option<AttachmentSource> {
    let reference = reference["ref"].as_str().unwrap_or_default();
    if reference.is_empty() {
        return None;
    }
    Some(
        if reference.starts_with(nibi_kernel_api::persisted_output::ARTIFACT_SCHEME) {
            AttachmentSource::Artifact {
                uri: reference.to_owned(),
            }
        } else {
            AttachmentSource::Path {
                path: reference.to_owned(),
            }
        },
    )
}

/// 文本附件最多内联的字节数（Node `INLINE_TEXT_ATTACHMENT_MAX_BYTES`）。
pub(crate) const TEXT_ATTACHMENT_MAX_BYTES: usize = 64 * 1024;

/// 模型看不到内容的附件留一行说明（Node `filePartToContentBlock` 的 `[Attached …]` 兜底）。
pub(crate) fn attachment_note(mime: &str, label: &str) -> ContentBlock {
    ContentBlock::Text {
        text: format!("[Attached {mime}: {label}]"),
    }
}

/// 附件的 mime → 内容块的分法（Node `file-part-hydration.ts` 的同一顺序）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaKind {
    /// `image/*` → [`ContentBlock::Image`]。
    Image,
    /// `application/pdf` → [`ContentBlock::Document`]。
    Document,
    /// `video/*` → [`ContentBlock::Video`]。
    Video,
    /// `text/*` → 文本块（≤64 KiB），超了留说明。
    Text,
    /// 其余（音频、任意二进制）：没有内容块，留一行说明。
    Note,
}

/// mime 的分法；`;` 之后的参数先剥掉，不分大小写。
pub(crate) fn media_kind(mime: &str) -> MediaKind {
    let media = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if media == "application/pdf" {
        MediaKind::Document
    } else if media.starts_with("video/") {
        MediaKind::Video
    } else if media.starts_with("image/") {
        MediaKind::Image
    } else if media.starts_with("text/") {
        MediaKind::Text
    } else {
        MediaKind::Note
    }
}

/// 命令里的附件（NIBI `AttachmentRef`）→ 模型内容块。
///
/// 与 Node 同一条分法（`file-part-hydration.ts`）：图片进 `Image`、PDF 进 `Document`、视频进 `Video`、
/// `text/*` 读成文本块（≤64 KiB）、其余（音频、任意二进制）留一行 `[Attached …]` 说明。
/// **没有一种类型会让整次发送失败**。附件按 Node 的排法放在正文之前。
///
/// 视频进 `Video` 块是 2026-11-08 补上的：端点没声明 `supportsVideo` 时由 `model::media` 在发送前换成
/// Node 的占位文字，与图片/PDF 同一条规则（不发出去不代表拒绝接收）。
///
/// 与 Node 的已知差异：引用读不出来时这里报 `attachmentUnreadable`，Node 会静默降级成占位文本。
/// 报错是有意的——用户贴的截图不见了比一次明确的失败更难发现。
async fn attachment_blocks(
    kernel: &std::sync::Arc<dyn nibi_kernel_api::session_api::Kernel>,
    session: &SessionId,
    workspace: &WorkspaceRef,
    refs: &[Value],
) -> Result<Vec<ContentBlock>, (&'static str, String)> {
    use base64::Engine;

    let mut blocks = Vec::with_capacity(refs.len());
    for reference in refs {
        let mime = reference["mime"].as_str().unwrap_or_default();
        let media = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        let label = reference["fileName"]
            .as_str()
            .filter(|name| !name.is_empty())
            .or_else(|| reference["ref"].as_str().filter(|path| !path.is_empty()))
            .unwrap_or(mime);
        let kind = media_kind(mime);
        // 音频与任意二进制没有可用的内容块：不读内容，只留说明。
        let Some(source) = attachment_source(reference).filter(|_| kind != MediaKind::Note) else {
            blocks.push(attachment_note(mime, label));
            continue;
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
        // 借用而不是移动：文本分支还要原字节（`String::from_utf8_lossy`）。
        let source = ImageSource::Base64 {
            media_type: loaded.media_type.unwrap_or_else(|| media.clone()),
            data: base64::engine::general_purpose::STANDARD.encode(&loaded.bytes),
        };
        match kind {
            MediaKind::Document => blocks.push(ContentBlock::Document {
                source,
                name: reference["fileName"].as_str().map(str::to_owned),
            }),
            MediaKind::Video => blocks.push(ContentBlock::Video {
                source,
                name: reference["fileName"].as_str().map(str::to_owned),
            }),
            MediaKind::Image => blocks.push(ContentBlock::Image { source }),
            MediaKind::Text if loaded.bytes.len() <= TEXT_ATTACHMENT_MAX_BYTES => {
                blocks.push(ContentBlock::Text {
                    text: String::from_utf8_lossy(&loaded.bytes).into_owned(),
                });
            }
            // 超长文本与 Note 一样只留说明。
            MediaKind::Text | MediaKind::Note => blocks.push(attachment_note(mime, label)),
        }
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
/// 调用方在数量不等时 warn）。`oauth` 与 `protocolVersion` 原样带上：令牌由入口的令牌端口取，
/// 现代握手在 `ext::mcp::connection` 里协商。
pub(crate) fn session_mcp_servers(payload: &Value) -> Vec<nibi_kernel_api::mcp_session::SessionMcpServer> {
    use std::collections::BTreeMap;

    use nibi_kernel_api::mcp::{McpOAuthConfig, McpProtocolVersion, McpTransportConfig};
    use nibi_kernel_api::mcp_session::{McpIsolation, SessionMcpServer};

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
                        // 形状已由契约层校验过；认不出的 OAuth 配置按「没有」处理（连接会得到 401）。
                        oauth: server
                            .get("oauth")
                            .filter(|value| !value.is_null())
                            .and_then(|value| McpOAuthConfig::from_value(value).ok()),
                        protocol_version: match server["protocolVersion"].as_str() {
                            Some("legacy") => McpProtocolVersion::Legacy,
                            Some("2026-07-28") => McpProtocolVersion::Modern,
                            _ => McpProtocolVersion::Auto,
                        },
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
fn user_text(message: &nibi_kernel_api::message::Message) -> String {
    let nibi_kernel_api::message::Message::User(user) = message else {
        return String::new();
    };
    if user.origin != nibi_kernel_api::message::UserOrigin::Human {
        return String::new();
    }
    let text = crate::projection::text_of(&user.content);
    if nibi_kernel_api::user_input::INTERRUPT_TEXTS.contains(&text.as_str()) {
        return String::new();
    }
    text
}

/// `guard.latestQueryEditOnly`：editUserQuery 只许改最后一条 real user query——
/// 历史编辑会回退 active branch。
fn edit_target_guard(
    messages: &[nibi_kernel_api::message::Message],
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

pub(crate) async fn send(handle: &dyn SessionHandle, id: &str, command: Command) -> KernelAck {
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
    // 首 token 观察：命令到达就记（重复与满容量不记；与 Node 的 receive 同一时机）。
    observe_received(server, &envelope).await;
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
    observe_settled(server, &envelope, &ack).await;
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

/// 命令到达：renderer 带了 `ttft` 就建一条观察记录并发第一份快照。
async fn observe_received(server: &Server, envelope: &Envelope) {
    let Some(context) = envelope.ttft.as_ref().and_then(|value| {
        serde_json::from_value::<nibi_kernel_api::local_ttft::LocalTtftContext>(value.clone()).ok()
    }) else {
        return;
    };
    let now = server.context.now();
    // 忙闲（`sendMode`）要读投影；命令入口不为埋点开会话，未知即不写。
    if let Some(fact) = server.local_ttft.receive(
        &context,
        &envelope.command_id,
        envelope.session_id.as_deref(),
        now,
        None,
    ) && let Ok(payload) = serde_json::to_value(fact)
    {
        server.context.notify(crate::local_ttft::METHOD, &payload).await;
    }
}

/// 命令结算：accepted 记受理时刻，rejected/failed/noop 记终态。
async fn observe_settled(server: &Server, envelope: &Envelope, ack: &Ack) {
    let now = server.context.now();
    let fact = match ack.status {
        Status::Accepted | Status::Duplicate => server.local_ttft.admitted(&envelope.command_id, now),
        Status::Rejected | Status::Failed | Status::Noop => {
            server.local_ttft.rejected(&envelope.command_id, now)
        }
        Status::Stale => None,
    };
    if let Some(fact) = fact
        && let Ok(payload) = serde_json::to_value(fact)
    {
        server.context.notify(crate::local_ttft::METHOD, &payload).await;
    }
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
        "cancelBackgroundWork" => cancel_background_work(server, handle, envelope, revision).await,
        "forkAssistant" => fork_assistant(server, handle, &live.sink, envelope).await,
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
        "snoozeInteractionAutoResolution" => {
            snooze_interaction_auto_resolution(&live, envelope, revision).await
        }
        "discardSharedContext" => discard_shared_context(server, &live.sink, envelope, revision).await,
        "startSavedWorkflow" => start_saved_workflow(server, Some(handle), envelope, revision).await,
        "resumeWorkflowRun" => resume_workflow_run(server, envelope, revision).await,
        "amendWorkflowRunSettings" => {
            amend_workflow_run_settings(server, Some(handle), envelope, revision).await
        }
        "requestWorkspaceHookReview" => {
            crate::hook_review::request(server, &live.sink, envelope, revision).await
        }
        "respondWorkspaceHookReview" => {
            crate::hook_review::respond(server, &live.sink, envelope, revision).await
        }
        "toggleWorkspaceHookReviewItem" => {
            crate::hook_review::toggle(server, &live.sink, envelope, revision).await
        }
        "revokeWorkspaceHookTrust" => {
            crate::hook_review::revoke(server, &live.sink, envelope, revision).await
        }
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
    let (mut permission, mut plan) =
        first_input_execution(first, config, (server.defaults.mode, false));
    // 群协作会话（`permissionScope: "session"`）：Node 的 v4-bridge 在 record 建好后
    // `setExecutionState({mode:"build"})`，与这里创建期就落 build 等价；授权行在创建后写（见下）。
    let scoped = payload["permissionScope"].as_str() == Some("session");
    if scoped {
        permission = PermissionMode::Default;
        plan = false;
    }
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
    // 群协作授权：Node 在 createSessionRecord 之后立即 updateSession({permission})；写不进去时整条
    // 创建失败（Host 的群任务不能带着项目级授权开跑）。
    if scoped
        && let Err(error) = server
            .kernel
            .apply_session_permission_scope(&id, "session")
            .await
    {
        return refused(error.to_string());
    }
    // MCP 是创建期配置（NIBI createSession.mcpServers）：会话的工具表从此就是这批服务器。
    // 连接在后台建立；给了列表但一条都没认出来时点名，不静默。
    if let Some(raw) = payload["mcpServers"].as_array() {
        let servers = session_mcp_servers(&Value::Object(
            std::iter::once(("mcpServers".to_owned(), Value::Array(raw.clone()))).collect(),
        ));
        if servers.len() != raw.len() {
            tracing::warn!(
                event = "protocol.create_session.mcp_servers_unparsed",
                given = raw.len(),
                parsed = servers.len(),
                "createSession.mcpServers has entries the kernel cannot map"
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
    // 动态工作流灰度的显式值（Host 只在开启时带）：Host 关闭时什么都不发，所以这里只认 `true`；
    // 与 workspace 策略取或（Node `resolveDynamicWorkflowRuntimeGate` 同序）。必须在会话打开之后落：
    // 打开时按 workspace 策略定了缺省门（Host 进程缺席 = 关闭）。
    if payload["dynamicWorkflowEnabled"].as_bool() == Some(true) {
        let on_demand = payload["dynamicWorkflowMode"].as_str() == Some("onDemand");
        if let Err(error) = server
            .kernel
            .set_session_dynamic_workflow(
                &id,
                nibi_kernel_api::session_api::DynamicWorkflowGate::new(true, on_demand),
            )
            .await
        {
            tracing::warn!(
                event = "protocol.create_session.dynamic_workflow_failed",
                session = %id,
                error = %error,
                "the kernel refused the explicit dynamic workflow gate"
            );
        }
    }
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
            input_meta(envelope, first, "startNow", "startNow", None),
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
    intent: Option<Value>,
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
        intent,
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
    // 规范意图（原文 + 机器人来源 + 引用 + 插件来源）：模型文本按 Node `withConversationQuotes`
    // 注入，行上仍显示原文。没有意图时不发那条命令（普通输入不写这个键）。
    let source = payload.get("botGroupSource").filter(|value| value.is_object());
    let quotes = payload
        .get("conversationQuotes")
        .filter(|value| value.as_array().is_some_and(|items| !items.is_empty()));
    let input_source = payload.get("source").filter(|value| !value.is_null());
    let intent = conversation_intent::canonical(&text, command, source, quotes, input_source);
    let model_text = conversation_intent::model_text(&text, quotes, source);
    if intent.is_some() {
        // 先记意图再提交：消息落库时按开启本回合的命令取走（同一事务写进消息元数据）。
        send(
            handle,
            &format!("{command}:intent"),
            Command::RecordInputIntent {
                command: CommandId::new(command),
                intent: intent.clone().unwrap_or(Value::Null),
            },
        )
        .await;
    }
    // 附件：先解出内容（失败就拒绝这条命令，不静默丢内容），正文与图片一起提交。
    let submit = if refs.is_empty() {
        Command::Submit {
            text: model_text,
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
                content: with_text(model_text, blocks),
                delivery,
            },
            Err((code, message)) => {
                return Ack::refused(command, Status::Rejected, code, message, revision);
            }
        }
    };
    live.remember_input(
        command,
        input_meta(envelope, payload, requested, admitted, intent),
    );
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

/// v4 的提问应答 → 内核的 `QuestionAnswer`（Node `v4AnswerToUserInputResponse` 的镜像）：
/// `action: accept` 的 `content` 带多题 `answers`/`annotations`；旧单题路径读 `content.answer`
/// 或 `freeText`。decline/cancel 都是“不回答”。
fn question_answer(answer: &Value, questions: &Value) -> QuestionAnswer {
    if matches!(answer["action"].as_str(), Some("decline" | "cancel")) {
        return QuestionAnswer::Declined;
    }
    let content = &answer["content"];
    let mut answers = std::collections::BTreeMap::new();
    if let Some(entries) = content["answers"].as_object() {
        for (question, value) in entries {
            if let Some(text) = value.as_str() {
                answers.insert(question.clone(), text.to_owned());
            }
        }
    }
    // 旧单题路径（V4UserInputDialog 的 freeText / 旧客户端的 content.answer）：落到第一题。
    if answers.is_empty()
        && let Some(text) = content["answer"]
            .as_str()
            .or_else(|| answer["freeText"].as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
        && let Some(question) = questions
            .as_array()
            .and_then(|list| list.first())
            .and_then(|question| question["question"].as_str())
    {
        answers.insert(question.to_owned(), text.to_owned());
    }
    let annotations: std::collections::BTreeMap<String, QuestionAnnotation> =
        serde_json::from_value(content["annotations"].clone()).unwrap_or_default();
    QuestionAnswer::Answered {
        answers,
        annotations,
        response: content["response"].as_str().map(str::to_owned),
        follow_up: content["followUp"].as_bool() == Some(true),
        afk_timeout_ms: content["afkTimeoutMs"].as_u64(),
    }
}

/// “总是允许”的记忆规则：判决链给了建议就用建议；没有时按 Node 的
/// `buildDefaultPermissionUpdates`（permission-suggestions.ts）造一条默认规则——工具名 + 输入里
/// 第一个 `command`/`url`/`file_path`/`path`/`pattern`。没有这条，非 Bash 工具（Write/Edit/
/// WebFetch…）选“始终允许”等于没点（规则集不会变，下一次还会问）。
fn remember_rules(tool: &str, input: &Value, suggestions: &[PermissionRule]) -> Vec<PermissionRule> {
    if !suggestions.is_empty() {
        return suggestions.to_vec();
    }
    let content = ["command", "url", "file_path", "path", "pattern"]
        .iter()
        .find_map(|key| {
            input
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
        });
    vec![PermissionRule {
        tool: tool.to_owned(),
        content: content.map(str::to_owned),
    }]
}

/// v4 的计划审批应答 → 内核的 `PlanApprovalAnswer`（Node `v4AnswerToPlanApprovalResponse` 与
/// `planApprovalResponseToBrokerResult` 的镜像）：批准 = `content.answer == "approve"`（Host 的
/// Approve 选项）或 allowOnce；其余文字是“继续计划”的反馈；decline/cancel 是不批准。
/// `mode` 只作记录（修复线 F20：批准只关掉 plan，权限模式不变）。
fn plan_approval_answer(answer: &Value, mode: PermissionMode) -> PlanApprovalAnswer {
    if matches!(answer["action"].as_str(), Some("decline" | "cancel")) {
        return PlanApprovalAnswer::KeepPlanning { feedback: None };
    }
    if matches!(
        answer["optionId"].as_str(),
        Some("allowOnce" | "allowAlways")
    ) {
        return PlanApprovalAnswer::Approve { mode };
    }
    let content = &answer["content"];
    let text = content["answer"]
        .as_str()
        .or_else(|| {
            content["answers"]
                .as_object()
                .and_then(|answers| answers.values().find_map(Value::as_str))
        })
        .or_else(|| answer["freeText"].as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty());
    match text {
        Some(text) if text.eq_ignore_ascii_case("approve") => PlanApprovalAnswer::Approve { mode },
        Some(text) => PlanApprovalAnswer::KeepPlanning {
            feedback: Some(text.to_owned()),
        },
        None => PlanApprovalAnswer::KeepPlanning { feedback: None },
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
    let answer = &payload["answer"];
    let option = answer["optionId"].as_str();
    let pending = handle.view().await.ok().and_then(|view| {
        view.pending
            .into_iter()
            .find(|(id, _)| id.as_str() == interaction)
            .map(|(_, request)| (request, view.mode))
    });
    let Some((request, session_mode)) = pending else {
        return Ack::refused(
            &envelope.command_id,
            Status::Noop,
            "proto.alreadyResolved",
            "the interaction is no longer pending",
            revision,
        );
    };
    let resolved = match &request {
        InteractionRequest::Permission {
            suggestions,
            tool,
            input,
            tool_use,
            ..
        } => {
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
                    remember: remember_rules(tool, input, suggestions),
                },
                _ => PermissionAnswer::Deny {
                    feedback: answer["freeText"]
                        .as_str()
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .map(str::to_owned),
                },
            };
            if let PermissionAnswer::Deny { .. } = &answer {
                live.deny(tool_use);
            }
            serde_json::to_value(answer).unwrap_or(Value::Null)
        }
        // AskUserQuestion：v4 的 action/content（Host 的 ElicitationDialog）映射回内核的回答形状。
        InteractionRequest::Question { questions, .. } => {
            serde_json::to_value(question_answer(answer, questions)).unwrap_or(Value::Null)
        }
        // ExitPlanMode：action=accept + content.answer=approve（或 allowOnce）为批准，其余文字为
        // “继续计划”的反馈。
        InteractionRequest::PlanApproval { .. } => {
            serde_json::to_value(plan_approval_answer(answer, session_mode))
                .unwrap_or(Value::Null)
        }
    };
    let command = Command::ResolveInteraction {
        interaction: InteractionId::new(interaction),
        answer: resolved,
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
    live: &std::sync::Arc<nibi_kernel_protocol_core::sessions::Bridged<crate::live::Live>>,
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
    server: &Server,
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
    match send(handle, command, Command::StopTask { task: work.clone() }).await {
        KernelAck::Accepted { .. } => Ack::accepted(command, revision, None),
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, revision, None)),
        KernelAck::Rejected { reason } => {
            // workId 也可能是一个 DWF run（Node 的 cancelBackgroundTask 同时管后台任务与 run）。
            if server.kernel.cancel_workflow_run(&work).await.is_ok() {
                return Ack::accepted(command, revision, None);
            }
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
fn retry_target(messages: &[nibi_kernel_api::message::Message]) -> Result<RetryTarget, String> {
    // latest 守卫：最后一条消息必须是 assistant（有回复才能重试）。
    let position = messages
        .len()
        .checked_sub(1)
        .ok_or("the conversation is empty")?;
    if !matches!(
        messages[position],
        nibi_kernel_api::message::Message::Assistant(_)
    ) {
        return Err(
            "guard.latestAssistantRetryOnly: retryTurn only retries the latest assistant reply"
                .to_owned(),
        );
    }
    let user = messages[..position]
        .iter()
        .rev()
        .find(|message| matches!(message, nibi_kernel_api::message::Message::User(_)))
        .ok_or("no user input before the assistant reply")?;
    let nibi_kernel_api::message::Message::User(user_message) = user else {
        return Err("no user input before the assistant reply".to_owned());
    };
    let text = user_message
        .content
        .iter()
        .filter_map(|block| match block {
            nibi_kernel_api::message::ContentBlock::Text { text } => Some(text.as_str()),
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

/// fork 出来的子会话不会自动打开，sessions-index 的实时行就缺这一条；从存储里读回它的
/// 摘要补发一次，Host 的任务列表和 fork 后的原地跳转立刻能看到（否则要等重启的快照）。
async fn publish_forked_session(server: &Server, live: &crate::live::Live, session: &str) {
    if session.is_empty() {
        return;
    }
    let filter = SessionFilter {
        workspace: server.workspace(live.workspace_root()),
        limit: 200,
    };
    match server.kernel.workspace_sessions(filter).await {
        Ok(sessions) => {
            if let Some(found) = sessions
                .iter()
                .find(|entry| entry.summary.id.as_str() == session)
            {
                live.publish_stored_session(
                    session,
                    &found.summary.title,
                    found.summary.updated_at_ms,
                    found.last_reply.as_deref(),
                );
            }
        }
        Err(error) => tracing::warn!(session, %error, "reading the forked session summary failed"),
    }
}

/// NIBI `forkAssistant`：row-targeting CAS（revision+epoch）；稳定 assistant 行 → `Command::Fork`。
async fn fork_assistant(
    server: &Server,
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
            at: Some(nibi_kernel_api::ids::MessageId::new(message)),
        },
    )
    .await
    {
        KernelAck::Accepted { result } => {
            let session = result.as_str().unwrap_or_default().to_owned();
            publish_forked_session(server, live, &session).await;
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
            target: nibi_kernel_api::ids::MessageId::new(retry.user_message),
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
) -> Ack {    let command = envelope.command_id.as_str();
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
    let record = nibi_kernel_api::store::FrontendRecord {
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
/// `snoozeInteractionAutoResolution`：用户第一次操作这个问题，倒计时永久停止。
///
/// 与 Node 一样幂等成功：没有活动倒计时（已经 snoozed、不是 AskUserQuestion、交互已经不在了）
/// 也回 accepted，回执里 `snoozed` 说明这次是否真的改了状态。
async fn snooze_interaction_auto_resolution(
    live: &std::sync::Arc<nibi_kernel_protocol_core::sessions::Bridged<crate::live::Live>>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let interaction = envelope.payload["interactionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (done, finished) = tokio::sync::oneshot::channel();
    let bridged = live.clone();
    // 在会话的泵任务里改投影：与事件帧同序。
    live.run(std::boxed::Box::pin(async move {
        let snoozed = bridged.sink.snooze_auto_resolution(&interaction).await;
        let _ = done.send(snoozed);
    }));
    let snoozed = finished.await.unwrap_or(false);
    tracing::info!(
        event = "protocol.snooze_auto_resolution",
        interaction = %envelope.payload["interactionId"].as_str().unwrap_or_default(),
        snoozed,
        "auto resolution snoozed"
    );
    Ack::accepted(
        &envelope.command_id,
        revision,
        Some(json!({"snoozed": snoozed})),
    )
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
    // Host 的入口是轮头行（`resolveRowActionTarget`）：内核把同一行解析成这一轮的消息集合，
    // 按 checkpoint 的 prompt / assistant 精确回退，不连带撤掉后面的轮。
    let row_target = crate::row_target::Target {
        row_id: target.row_id,
        entity_id: target.entity.clone(),
    };
    let messages = match crate::row_target::rewind_message_ids(live, &row_target) {
        Ok(messages) => messages,
        Err(reason) => {
            return Ack::refused(command, Status::Rejected, &reason, reason.clone(), revision);
        }
    };
    let turn = live
        .row(row_target.row_id)
        .and_then(|row| row.get("turnId").and_then(Value::as_str).map(str::to_owned));
    // 先预览：不安全的文件一个都不写（Node 的 `buildWorkspaceFileRewindPlan` + `canApply`）。
    let preview = match handle.file_rewind_preview(&messages).await {
        Ok(preview) => preview,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Rejected,
                "fault.command.fileRewindFailed",
                error.to_string(),
                revision,
            );
        }
    };
    let unsafe_response = "File rewind was not applied because at least one file is unsafe.";
    if !preview.can_apply {
        return Ack::accepted(
            command,
            revision,
            Some(json!({
                "type": "applyFileRewind",
                "applied": false,
                "preview": preview,
                "response": unsafe_response,
            })),
        );
    }
    let safe_files = preview.safe_files.len();
    match send(
        handle,
        command,
        Command::RestoreFiles {
            messages,
            turn: turn.map(nibi_kernel_api::ids::TurnId::new),
        },
    )
    .await
    {
        KernelAck::Accepted { .. } => {
            let noun = if safe_files == 1 { "file" } else { "files" };
            Ack::accepted(
                command,
                revision,
                Some(json!({
                    "type": "applyFileRewind",
                    "applied": true,
                    "preview": preview,
                    "response": format!("Rewound {safe_files} {noun} from summary checkpoints."),
                })),
            )
        }
        KernelAck::Duplicate => inbox::duplicate(&Ack::accepted(command, revision, None)),
        // 预览之后文件又变了（或机器掉线）：如实回「没有应用」与原因，不冒充成功。
        KernelAck::Rejected { reason } => {
            let mut preview = preview;
            preview.can_apply = false;
            preview.unsafe_files.push(nibi_kernel_api::file_changes::RewindUnsafeFile {
                path: "workspace".to_owned(),
                reason: nibi_kernel_api::file_changes::RewindUnsafeReason::FileReadFailed,
                operation_count: 1,
                tool_names: Vec::new(),
                current_hash: None,
                expected_hash: None,
                message: Some(reason.clone()),
            });
            Ack::accepted(
                command,
                revision,
                Some(json!({
                    "type": "applyFileRewind",
                    "applied": false,
                    "preview": preview,
                    "response": reason,
                })),
            )
        }
    }
}

/// NIBI `editUserQuery`：换文本的 retryTurn。target 是 real user 行（entityId 即该
/// user 消息 id）→ `guard.latestQueryEditOnly` → rewind 截断该轮 → 重发 newText。
/// 附件与 newText 一起重发（图片 / PDF / 文本按内容块，其余留一行说明，见 `attachment_blocks`）。
/// 与 Node 的差异（记录在案）：
/// - workspaceMode=rewind 直接用 kernel `Rewind{scope: Both}`（文件+对话一次提交），
///   Node 的 preview/blocked UI 流（guard.workspaceRewind*）暂无对应 ACK 形状；
/// - conversationQuotes 与首次输入同样注入模型文本（行上仍显示原文）。
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
    // 改写带的引用照常注入模型文本（与首次输入同一处 `withConversationQuotes`）。
    let quotes = envelope
        .payload
        .get("conversationQuotes")
        .filter(|quotes| quotes.as_array().is_some_and(|items| !items.is_empty()));
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
            target: nibi_kernel_api::ids::MessageId::new(target.entity.clone()),
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
    // 行上仍是原文，模型拿注入后的文本。
    let model_text = conversation_intent::model_text(&new_text, quotes, None);
    let submit = if refs.is_empty() {
        Command::Submit {
            text: model_text,
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
            content: with_text(model_text, blocks),
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

/// DWF 命令的失败 ACK：引擎拒绝的 reasonCode 就是消息里的 fault 前缀，能力缺席时按 Node 的
/// `V4CapabilityUnsupportedError` 回 `fault.command.capabilityUnsupported`。
fn workflow_ack(command: &str, revision: u64, error: KernelError, capability: &str) -> Ack {
    match error {
        KernelError::Unsupported { .. } => Ack::refused(
            command,
            Status::Failed,
            "fault.command.capabilityUnsupported",
            format!("capability not supported by this session runtime: {capability}"),
            revision,
        ),
        KernelError::Failed { message } => {
            let (reason, detail) = match message.split_once(':') {
                Some((reason, detail)) => (reason.trim(), detail.trim()),
                None => (message.trim(), message.trim()),
            };
            Ack::refused(command, Status::Failed, reason, detail, revision)
        }
        other => Ack::refused(command, Status::Failed, "proto.internal", other.to_string(), revision),
    }
}

fn workflow_session<'a>(
    envelope: &'a Envelope,
    command: &str,
    name: &str,
    revision: u64,
) -> Result<&'a str, Box<Ack>> {
    envelope.session_id.as_deref().ok_or_else(|| {
        Box::new(Ack::refused(
            command,
            Status::Rejected,
            "proto.sessionRequired",
            format!("{name} needs a sessionId"),
            revision,
        ))
    })
}

/// NIBI `startSavedWorkflow`：中枢的「运行」直接请引擎启动一个已保存的工作流（不经模型轮）。
async fn start_saved_workflow(
    server: &Server,
    handle: Option<&dyn SessionHandle>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let command = envelope.command_id.as_str();
    let session = match workflow_session(envelope, command, "startSavedWorkflow", revision) {
        Ok(session) => session,
        Err(ack) => return *ack,
    };
    let request = nibi_kernel_api::workflow::WorkflowStart {
        name: envelope.payload["name"].as_str().unwrap_or_default().to_owned(),
        scope: envelope.payload["scope"].as_str().map(str::to_owned),
        args: envelope.payload.get("args").cloned().filter(|args| !args.is_null()),
    };
    match server
        .kernel
        .start_saved_workflow(&SessionId::new(session), request)
        .await
    {
        Ok(started) => {
            // 启动轮（launch.md「The launch turn」）：用户在中枢里点的「运行」就是他的真实动作，
            // 以一条 controlOnly 的合成输入落进会话（模型直到通知到来才第一次听说这次 run）。
            // 失败只记日志不回滚——run 已在飞（Node 的同一条规矩）。
            let session_id = SessionId::new(session);
            if let Some((owner, turn)) =
                crate::workflow_settings_turn::launch_turn(&session_id, &started)
            {
                match handle {
                    Some(handle) => {
                        if let KernelAck::Rejected { reason } = send(handle, command, turn).await {
                            tracing::warn!(
                                event = "workflow.launch.turn.failed",
                                session = %owner.as_str(),
                                %reason,
                                "the launch turn could not be stored",
                            );
                        }
                    }
                    None => tracing::warn!(
                        event = "workflow.launch.turn.no_session",
                        session = %owner.as_str(),
                        "the launch turn had no open session to record in",
                    ),
                }
            }
            Ack::accepted(
                command,
                revision,
                Some(json!({
                    "type": "startSavedWorkflow",
                    "runId": started.run_id,
                    "toolCallId": started.tool_call_id,
                })),
            )
        }
        Err(error) => workflow_ack(command, revision, error, "startSavedWorkflow"),
    }
}

/// NIBI `resumeWorkflowRun`：`workId ≡ runId`，门（可恢复集）在引擎侧。
async fn resume_workflow_run(server: &Server, envelope: &Envelope, revision: u64) -> Ack {
    let command = envelope.command_id.as_str();
    if let Err(ack) = workflow_session(envelope, command, "resumeWorkflowRun", revision) {
        return *ack;
    }
    let work = envelope.payload["workId"].as_str().unwrap_or_default();
    match server
        .kernel
        .resume_workflow_run(work, envelope.payload["name"].as_str())
        .await
    {
        Ok(_) => Ack::accepted(command, revision, None),
        Err(error) => workflow_ack(command, revision, error, "resumeWorkflowRun"),
    }
}

/// NIBI `amendWorkflowRunSettings`：两项设置的三态（省略 = 沿用，`null` = 回默认，值 = 设定）。
async fn amend_workflow_run_settings(
    server: &Server,
    handle: Option<&dyn SessionHandle>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let command = envelope.command_id.as_str();
    let session = match workflow_session(envelope, command, "amendWorkflowRunSettings", revision) {
        Ok(session) => session,
        Err(ack) => return *ack,
    };
    let payload = &envelope.payload;
    let subagent_model = payload
        .get("subagentModel")
        .map(|value| value.as_str().map(str::to_owned));
    let max_concurrency = payload
        .get("maxConcurrency")
        .map(serde_json::Value::as_u64);
    let request = nibi_kernel_api::workflow::WorkflowAmend {
        run_id: payload["workId"].as_str().unwrap_or_default().to_owned(),
        subagent_model,
        max_concurrency,
    };
    let predecessor = request.run_id.clone();
    match server.kernel.amend_workflow_run(request).await {
        Ok(started) => {
            // 设置轮（launch.md「The settings turn」）：成功后的 controlOnly 会话记录。失败只记
            // 日志不回滚——新 run 已在飞，撤回它反而制造孤儿（Node 的同一条规矩）。
            let session_id = SessionId::new(session);
            if let Some((owner, turn)) =
                crate::workflow_settings_turn::settings_turn(&session_id, &predecessor, &started)
            {
                match handle {
                    Some(handle) => {
                        if let KernelAck::Rejected { reason } = send(handle, command, turn).await {
                            tracing::warn!(
                                event = "workflow.settings.turn.failed",
                                session = %owner.as_str(),
                                %reason,
                                "the settings turn could not be stored",
                            );
                        }
                    }
                    None => tracing::warn!(
                        event = "workflow.settings.turn.no_session",
                        session = %owner.as_str(),
                        "the settings turn had no open session to record in",
                    ),
                }
            }
            let mut result = json!({
                "type": "amendWorkflowRunSettings",
                "runId": started.run_id,
                "toolCallId": started.tool_call_id,
            });
            if let Some(superseded) = started.superseded_run_id {
                result["supersededRunId"] = json!(superseded);
            }
            Ack::accepted(command, revision, Some(result))
        }
        Err(error) => workflow_ack(command, revision, error, "amendWorkflowRunSettings"),
    }
}

/// NIBI `discardSharedContext`：把还没附加（`pending`）的分享导入标成 `discarded`，
/// 并把新状态写进投影（快照的 `sharedContextImport`）。不是 pending 时按 Node 的
/// `fault.command.inputRejected` 拒绝。
async fn discard_shared_context(
    server: &Server,
    live: &crate::live::Live,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let command = envelope.command_id.as_str();
    let Some(session) = envelope.session_id.as_deref() else {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.sessionRequired",
            "discardSharedContext needs a sessionId",
            revision,
        );
    };
    let context_id = envelope.payload["contextId"].as_str().unwrap_or_default();
    match server
        .kernel
        .discard_shared_context(&SessionId::new(session), context_id)
        .await
    {
        Ok(state) => {
            if let Some(state) = state
                && let Ok(value) = serde_json::to_value(state)
            {
                live.set_shared_context_import(Some(value)).await;
            }
            Ack::accepted(command, revision, None)
        }
        Err(nibi_kernel_api::session_api::KernelError::Unsupported { what }) => Ack::refused(
            command,
            Status::Failed,
            "proto.unsupportedCommand",
            what,
            revision,
        ),
        Err(error) => {
            let message = error.to_string();
            let reason = if message.starts_with("fault.command.inputRejected") {
                "fault.command.inputRejected"
            } else {
                "proto.internal"
            };
            Ack::refused(command, Status::Failed, reason, message, revision)
        }
    }
}

/// `v4/commands/query`：内存表，然后命令事实（G2）；都没有时 unknown。时钟探测带 `clock`。
pub async fn query(server: &Server, params: &Value) -> Result<Value, RpcError> {    let received = server.context.now();
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

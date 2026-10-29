//! 命令的处理（[`crate::inbox`] 的裁决与转交）：P1 的五个命令。

use rust_cli_kernel_api::ids::{CommandId, InteractionId, SessionId};
use rust_cli_kernel_api::interaction::PermissionAnswer;
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
    } else if lower.contains("not found") || lower.contains("unknown") || lower.contains("no such")
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
    Ack::refused(
        &envelope.command_id,
        Status::Rejected,
        "proto.unsupportedCommand",
        format!("{} is not supported by this agent yet", envelope.kind),
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
        "sendText" => send_text(handle, &live.sink, envelope, phase, revision).await,
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
    let chosen = selection(&config["modelSelection"])
        .or_else(|| flat_selection(config))
        .or_else(|| selection(&payload["firstInput"]["modelSelection"]))
        .unwrap_or_else(|| server.defaults.selection.clone());
    let (permission, plan) = mode(&config["mode"], config["planEnabled"].as_bool())
        .unwrap_or((server.defaults.mode, false));
    let id = payload["sessionId"]
        .as_str()
        .map_or_else(inbox::new_session_id, SessionId::new);
    if let Some(followup) = config["followupMode"].as_str().and_then(Followup::parse) {
        server
            .followups
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id.clone(), followup);
    }
    let workspace = payload["workspaceId"].as_str().unwrap_or_default();
    let created = server
        .kernel
        .create_session(CreateSession {
            id: Some(id.clone()),
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
    let live = match server.live(&id).await {
        Ok(live) => live,
        Err(error) => return refused(error.to_string()),
    };
    crate::subscribe::announce(&live);
    let mut result = json!({"type": "createSession", "sessionId": id.as_str()});
    let first = &payload["firstInput"];
    if let Some(text) = first["text"].as_str() {
        live.sink.remember_input(
            &envelope.command_id,
            input_meta(envelope, first, "startNow", "startNow"),
        );
        let submit = Command::Submit {
            text: text.to_owned(),
            attachments: Vec::new(),
            delivery: Delivery::Queue,
        };
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
    }
}

async fn send_text(
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
    live.remember_input(command, input_meta(envelope, payload, requested, admitted));
    let submit = Command::Submit {
        text: payload["text"].as_str().unwrap_or_default().to_owned(),
        attachments: Vec::new(),
        delivery,
    };
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
    if live.sink.followup() == wanted {
        return Ack::refused(
            command,
            Status::Noop,
            "proto.unchanged",
            "the followup mode is already set",
            revision,
        );
    }
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
            "proto.unchanged",
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
    if view.mode == permission && view.plan == plan {
        return Ack::refused(
            command,
            Status::Noop,
            "proto.unchanged",
            "the collaboration mode is already set",
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
            let code = background_work_cancel_code(&reason);
            Ack::refused(
                command,
                Status::Rejected,
                &format!("{BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX}{code}"),
                reason,
                revision,
            )
        }
    }
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

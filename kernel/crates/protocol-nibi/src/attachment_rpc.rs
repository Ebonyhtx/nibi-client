//! 附件事务与回读的协议面（141 审计 §9 第 4 项）：8 条方法。
//!
//! 上行四条（`begin|chunk|commit|abort`）走 [`crate::attachment_upload`] 的暂存表；回读四条
//! （`attachmentRead|previewSource` + `conversation/attachmentRead|attachmentStat`）按**已授权行**
//! 找到引用，再交给内核的 [`Kernel::read_attachment`]。
//!
//! 授权链与 Host 的 `resolveReadableMediaAttachment` 同一条：
//!
//! 1. `target`（`rowId` + `entityId`）必须命中当前会话投影里的一行，且这一行是 `userInput`；
//! 2. `attachmentIndex` 必须落在该行的 `attachments` 里；
//! 3. 那一项的 `ref`（或 `previewRef`）必须等于请求里的 `ref`。
//!
//! 三条都过才允许读。没有 `target` 的老 renderer 只认「当前投影里出现过这个 ref」——它不能定位到
//! 具体消息，所以 `previewRef` 一旦存在就只授权那个 durable 引用，不放行可变的原始路径。
//!
//! 拒绝一律是结构化的 `fault.attachment.*`（Host 的 `NIBI_ATTACHMENT_FAULT_CODES`）：share 预检按
//! 码分类，靠错误文本匹配会在包装、本地化之后立刻失效。

use nibi_kernel_api::attachment::AttachmentSource;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::attachment_upload::{
    ATTACHMENT_CHUNK_MAX_BYTES, ATTACHMENT_MAX_BYTES, ATTACHMENT_UPLOAD_MAX_CHUNKS, BeginRequest,
    UploadFault, valid_checksum, valid_upload_id,
};
use crate::server::{SESSION_UNAVAILABLE, Server};

/// `PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes`（= `VIDEO_INPUT_MAX_BYTES`）：video 与 share 的
/// 通用读取上限。
const ATTACHMENT_PREVIEW_MAX_BYTES: u64 = 30 * 1024 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentStatMaxBytes`：metadata-only 探测能表达的真实大小上限。
const ATTACHMENT_STAT_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn invalid(message: impl std::fmt::Display) -> RpcError {
    RpcError::invalid_params(format!("Invalid params — {message}"))
}

/// 结构化附件 fault（Host 从 `error.data.code` 读；同进程时读 `error.code`）。
fn fault(code: &str) -> RpcError {
    RpcError::invalid_params(code).with_data(json!({"code": code}))
}

fn upload_fault(error: UploadFault) -> RpcError {
    fault(error.code())
}

fn object(params: &Value) -> Result<&serde_json::Map<String, Value>, RpcError> {
    params
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))
}

fn strict_keys(params: &serde_json::Map<String, Value>, known: &[&str]) -> Result<(), RpcError> {
    for key in params.keys() {
        if !known.contains(&key.as_str()) {
            return Err(invalid(format!("Unrecognized key `{key}`")));
        }
    }
    Ok(())
}

fn required_string(params: &serde_json::Map<String, Value>, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("`{key}` must be a non-empty string")))
}

fn required_u64(params: &serde_json::Map<String, Value>, key: &str) -> Result<u64, RpcError> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid(format!("`{key}` must be a non-negative integer")))
}

// ———— 上行事务 ————

/// `v4/attachment/begin`：登记一次上传。
pub(crate) async fn begin(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "connectionId",
            "uploadId",
            "sessionId",
            "fileName",
            "mime",
            "totalBytes",
            "totalChunks",
            "checksum",
        ],
    )?;
    let upload = required_string(params, "uploadId")?;
    if !valid_upload_id(&upload) {
        return Err(invalid("`uploadId` must match [A-Za-z0-9][A-Za-z0-9._:-]* (max 128)"));
    }
    let checksum = required_string(params, "checksum")?;
    if !valid_checksum(&checksum) {
        return Err(invalid("`checksum` must be sha256:<64 lowercase hex>"));
    }
    let total_bytes = required_u64(params, "totalBytes")?;
    if total_bytes > ATTACHMENT_MAX_BYTES {
        return Err(invalid(format!(
            "`totalBytes` must be at most {ATTACHMENT_MAX_BYTES}"
        )));
    }
    let total_chunks = required_u64(params, "totalChunks")?;
    if total_chunks > ATTACHMENT_UPLOAD_MAX_CHUNKS {
        return Err(invalid(format!(
            "`totalChunks` must be at most {ATTACHMENT_UPLOAD_MAX_CHUNKS}"
        )));
    }
    // Host 的 superRefine：零字节上传必须声明零片，反之亦然。
    if (total_bytes == 0) != (total_chunks == 0) {
        return Err(invalid("zero-byte upload must declare zero chunks"));
    }
    let request = BeginRequest {
        connection: required_string(params, "connectionId")?,
        upload: upload.clone(),
        session: required_string(params, "sessionId")?,
        file_name: required_string(params, "fileName")?,
        media_type: required_string(params, "mime")?,
        total_bytes,
        total_chunks,
        checksum,
    };
    let now = server.context.clock.now_ms();
    let state = server
        .uploads
        .with(|table| table.begin(&request, now))
        .map_err(upload_fault)?;
    Ok(state.to_json(&upload))
}

/// `v4/attachment/chunk`：收一片。
pub(crate) async fn chunk(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "connectionId",
            "uploadId",
            "sessionId",
            "chunkIndex",
            "dataBase64",
        ],
    )?;
    let upload = required_string(params, "uploadId")?;
    let index = usize::try_from(required_u64(params, "chunkIndex")?)
        .map_err(|_| invalid("`chunkIndex` is too large"))?;
    let encoded = params
        .get("dataBase64")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("`dataBase64` must be a string"))?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid("`dataBase64` is not valid base64"))?;
    if bytes.len() > ATTACHMENT_CHUNK_MAX_BYTES {
        return Err(invalid(format!(
            "attachment chunk exceeds {ATTACHMENT_CHUNK_MAX_BYTES} decoded bytes"
        )));
    }
    let connection = required_string(params, "connectionId")?;
    let session = required_string(params, "sessionId")?;
    let now = server.context.clock.now_ms();
    let next = server
        .uploads
        .with(|table| table.chunk(&connection, &session, &upload, index, bytes, now))
        .map_err(upload_fault)?;
    Ok(json!({"uploadId": upload, "nextChunkIndex": next}))
}

/// `v4/attachment/commit`：校验完整事实并落 artifact。
pub(crate) async fn commit(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["connectionId", "uploadId", "sessionId"])?;
    let connection = required_string(params, "connectionId")?;
    let upload = required_string(params, "uploadId")?;
    let session = required_string(params, "sessionId")?;
    let now = server.context.clock.now_ms();

    // 已经提交过：直接回同一个 ref（Host 的 committed 表）。
    if let Some(reference) = server
        .uploads
        .with(|table| table.committed_ref(&connection, &session, &upload, now))
    {
        return Ok(json!({"ref": reference}));
    }

    let ready = server
        .uploads
        .with(|table| table.take_ready(&connection, &session, &upload, now))
        .map_err(upload_fault)?;
    let stored = server
        .kernel
        .store_attachment(
            &SessionId::new(ready.session.clone()),
            &ready.file_name,
            &ready.media_type,
            ready.bytes,
        )
        .await;
    let stored = match stored {
        Ok(stored) => stored,
        Err(error) => {
            // 落盘失败：解除 committing，暂存内容留着，调用方可以重试 commit。
            server
                .uploads
                .with(|table| table.fail(&connection, &session, &upload));
            return Err(match error {
                nibi_kernel_api::session_api::KernelError::Unsupported { .. } => {
                    fault("fault.attachment.putUnsupported")
                }
                nibi_kernel_api::session_api::KernelError::NotFound { .. } => RpcError::new(
                    SESSION_UNAVAILABLE,
                    format!("Session unavailable: {session}"),
                ),
                other => RpcError::internal(other.to_string()),
            });
        }
    };
    server
        .uploads
        .with(|table| table.finish(&connection, &session, &upload, &stored.uri, now));
    Ok(json!({"ref": stored.uri}))
}

/// `v4/attachment/abort`：放弃一次上传（结果形状是空对象）。
pub(crate) async fn abort(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["connectionId", "uploadId", "sessionId"])?;
    let connection = required_string(params, "connectionId")?;
    let upload = required_string(params, "uploadId")?;
    let session = required_string(params, "sessionId")?;
    let now = server.context.clock.now_ms();
    server
        .uploads
        .with(|table| table.abort(&connection, &session, &upload, now));
    Ok(json!({}))
}

// ———— 回读 ————

/// 已授权的一条附件（`resolveReadableMediaAttachment` 的返回值）。
struct Authorized {
    reference: String,
    media_type: String,
}

/// 按当前会话投影做行/序号/引用三重授权。
fn authorize(
    rows: &[serde_json::Map<String, Value>],
    params: &serde_json::Map<String, Value>,
) -> Option<Authorized> {
    let reference = params["ref"].as_str()?.to_owned();
    let target = params.get("target").filter(|value| !value.is_null());
    let index = params.get("attachmentIndex").and_then(Value::as_u64);
    let projection = rows;
    let previewable = |attachment: &Value| {
        let mime = attachment["mime"]
            .as_str()
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        mime.starts_with("image/")
            || mime.starts_with("video/")
            || mime == "application/pdf"
            || (mime == "text/plain"
                && matches!(
                    attachment["sourceKind"].as_str(),
                    Some("topic-history" | "clipboard-text")
                ))
    };
    let matches_ref =
        |attachment: &Value| attachment["ref"].as_str() == Some(reference.as_str())
            || attachment["previewRef"].as_str() == Some(reference.as_str());

    if let (Some(target), Some(index)) = (target, index) {
        let row_id = target["rowId"].as_u64()?;
        let entity = target["entityId"].as_str()?;
        let row = projection
            .iter()
            .find(|row| row.get("rowId").and_then(Value::as_u64) == Some(row_id))?;
        if row.get("kind").and_then(Value::as_str) != Some("userInput") {
            return None;
        }
        if row.get("entityId").and_then(Value::as_str) != Some(entity) {
            return None;
        }
        let attachment = row.get("attachments")?.as_array()?.get(usize::try_from(index).ok()?)?;
        if !previewable(attachment) || !matches_ref(attachment) {
            return None;
        }
        return Some(Authorized {
            reference,
            media_type: attachment["mime"].as_str().unwrap_or_default().to_owned(),
        });
    }

    // 老 renderer 没有 row target：只认当前投影里出现过的引用。
    for row in projection {
        if row.get("kind").and_then(Value::as_str) != Some("userInput") {
            continue;
        }
        let Some(attachments) = row.get("attachments").and_then(Value::as_array) else {
            continue;
        };
        for attachment in attachments {
            if !previewable(attachment) {
                continue;
            }
            // 有 previewRef 时只授权那个 durable 引用，不放行可变的原始路径。
            let durable = attachment["previewRef"]
                .as_str()
                .or_else(|| attachment["ref"].as_str());
            if durable == Some(reference.as_str()) {
                return Some(Authorized {
                    reference,
                    media_type: attachment["mime"].as_str().unwrap_or_default().to_owned(),
                });
            }
        }
    }
    None
}

/// 当前会话投影里的授权结果；会话没打开时没有投影可查，按未授权处理。
fn authorized_row(
    server: &Server,
    session: &str,
    params: &serde_json::Map<String, Value>,
) -> Option<Authorized> {
    let live = server.bridge.get(&SessionId::new(session))?;
    authorize(&live.sink.rows(), params)
}

fn attachment_source(reference: &str) -> AttachmentSource {
    if reference.starts_with(nibi_kernel_api::persisted_output::ARTIFACT_SCHEME) {
        AttachmentSource::Artifact {
            uri: reference.to_owned(),
        }
    } else {
        AttachmentSource::Path {
            path: reference.to_owned(),
        }
    }
}

/// 一条已授权附件的完整内容（读一次，切片在调用方）。
async fn payload(
    server: &Server,
    session: &str,
    authorized: &Authorized,
    workspace: &str,
) -> Result<nibi_kernel_api::attachment::AttachmentPayload, RpcError> {
    server
        .kernel
        .read_attachment(
            &SessionId::new(session),
            &server.workspace(workspace),
            attachment_source(&authorized.reference),
            &authorized.media_type,
        )
        .await
        .map_err(|error| match error {
            nibi_kernel_api::session_api::KernelError::Unsupported { .. } => {
                fault("fault.attachment.readUnsupported")
            }
            nibi_kernel_api::session_api::KernelError::NotFound { .. } => {
                fault("fault.attachment.shareStatNotFound")
            }
            other => RpcError::internal(other.to_string()),
        })
}

/// `v4/attachment/read`：已发送图片/视频/PDF 预览，按 512 KiB 分块。
pub(crate) async fn read(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "sessionId",
            "ref",
            "target",
            "attachmentIndex",
            "offset",
            "limit",
        ],
    )?;
    let session = required_string(params, "sessionId")?;
    let offset = required_u64(params, "offset")?;
    let limit = required_u64(params, "limit")?;
    if !(1..=ATTACHMENT_CHUNK_MAX_BYTES as u64).contains(&limit) {
        return Err(invalid(format!(
            "`limit` must be an integer between 1 and {ATTACHMENT_CHUNK_MAX_BYTES}"
        )));
    }
    // target 与 attachmentIndex 必须成对出现（Host 的 superRefine）。
    let has_target = params.get("target").is_some_and(|value| !value.is_null());
    let has_index = params.get("attachmentIndex").is_some_and(|value| !value.is_null());
    if has_target != has_index {
        return Err(invalid(
            "target and attachmentIndex must be provided together",
        ));
    }
    let Some(authorized) = authorized_row(server, &session, params) else {
        return Err(fault("fault.attachment.previewRefNotAuthorized"));
    };
    let workspace = server.context.workspace_of(&session).unwrap_or_default();
    let payload = payload(server, &session, &authorized, &workspace).await?;
    let total = u64::try_from(payload.bytes.len()).unwrap_or(u64::MAX);
    if total > ATTACHMENT_PREVIEW_MAX_BYTES {
        return Err(fault("fault.attachment.previewTooLarge"));
    }
    let media_type = payload.media_type.to_ascii_lowercase();
    let base = media_type.split(';').next().unwrap_or("").trim();
    if !base.starts_with("image/")
        && !base.starts_with("video/")
        && base != "application/pdf"
        && base != "text/plain"
    {
        return Err(fault("fault.attachment.previewNotMedia"));
    }
    if offset > total {
        return Err(fault("fault.attachment.previewRangeInvalid"));
    }
    let start = usize::try_from(offset).unwrap_or(usize::MAX);
    let end = usize::try_from(offset.saturating_add(limit).min(total)).unwrap_or(payload.bytes.len());
    use base64::Engine;
    Ok(json!({
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(&payload.bytes[start..end]),
        "mediaType": payload.media_type,
        "totalBytes": total,
        "nextOffset": ((end as u64) < total).then_some(end as u64),
    }))
}

/// `v4/attachment/previewSource`：桌面本地视频的播放源；其余一律回 `chunked`。
///
/// 内核没有「派生媒体缓存路径」这一面（Host 的 `ensureMediaAttachmentPath` 把 artifact 解成缓存
/// 文件给 `<video src>` 用）。远端与 Web 本来就必须走 chunked，桌面在此退回同一条路——语义正确，
/// 只是少了本地直读的优化。
pub(crate) async fn preview_source(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "sessionId",
            "ref",
            "target",
            "attachmentIndex",
            "clientMode",
        ],
    )?;
    let session = required_string(params, "sessionId")?;
    let mode = required_string(params, "clientMode")?;
    if !matches!(mode.as_str(), "desktop-continuous" | "web-remote-replayable") {
        return Err(invalid(
            "`clientMode` must be desktop-continuous or web-remote-replayable",
        ));
    }
    let has_target = params.get("target").is_some_and(|value| !value.is_null());
    let has_index = params.get("attachmentIndex").is_some_and(|value| !value.is_null());
    if has_target != has_index {
        return Err(invalid(
            "target and attachmentIndex must be provided together",
        ));
    }
    if authorized_row(server, &session, params).is_none() {
        return Err(fault("fault.attachment.previewRefNotAuthorized"));
    }
    Ok(json!({"kind": "chunked"}))
}

/// `v4/conversation/attachmentRead`：share 读取 userInput 附件（允许任意已授权 MIME）。
pub(crate) async fn conversation_read(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "sessionId",
            "ref",
            "target",
            "attachmentIndex",
            "offset",
            "limit",
        ],
    )?;
    let session = required_string(params, "sessionId")?;
    // 这条的 target 与 attachmentIndex 都是必填（Host 的 schema 没有 optional）。
    if params.get("target").is_none_or(Value::is_null)
        || params.get("attachmentIndex").is_none_or(Value::is_null)
    {
        return Err(invalid("`target` and `attachmentIndex` are required"));
    }
    let offset = required_u64(params, "offset")?;
    let limit = required_u64(params, "limit")?;
    if !(1..=ATTACHMENT_CHUNK_MAX_BYTES as u64).contains(&limit) {
        return Err(invalid(format!(
            "`limit` must be an integer between 1 and {ATTACHMENT_CHUNK_MAX_BYTES}"
        )));
    }
    let Some(authorized) = authorized_row(server, &session, params) else {
        return Err(fault("fault.attachment.shareReadNotAuthorized"));
    };
    let workspace = server.context.workspace_of(&session).unwrap_or_default();
    let payload = match payload(server, &session, &authorized, &workspace).await {
        Ok(payload) => payload,
        Err(error) => {
            // share 预检只认「确实不在了」这一类；其余保持原样让它按未知处理。
            return Err(error);
        }
    };
    let total = u64::try_from(payload.bytes.len()).unwrap_or(u64::MAX);
    if total > ATTACHMENT_STAT_MAX_BYTES {
        return Err(fault("fault.attachment.shareStatTooLarge"));
    }
    if offset > total {
        return Err(fault("fault.attachment.previewRangeInvalid"));
    }
    let start = usize::try_from(offset).unwrap_or(usize::MAX);
    let end = usize::try_from(offset.saturating_add(limit).min(total)).unwrap_or(payload.bytes.len());
    use base64::Engine;
    Ok(json!({
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(&payload.bytes[start..end]),
        "mediaType": payload.media_type,
        "totalBytes": total,
        "nextOffset": ((end as u64) < total).then_some(end as u64),
    }))
}

/// `v4/conversation/attachmentStat`：share 选择阶段的 metadata-only 探测。
pub(crate) async fn conversation_stat(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &["sessionId", "ref", "target", "attachmentIndex"],
    )?;
    let session = required_string(params, "sessionId")?;
    if params.get("target").is_none_or(Value::is_null)
        || params.get("attachmentIndex").is_none_or(Value::is_null)
    {
        return Err(invalid("`target` and `attachmentIndex` are required"));
    }
    let Some(authorized) = authorized_row(server, &session, params) else {
        return Err(fault("fault.attachment.shareStatNotAuthorized"));
    };
    let workspace = server.context.workspace_of(&session).unwrap_or_default();
    let payload = payload(server, &session, &authorized, &workspace).await?;
    let total = u64::try_from(payload.bytes.len()).unwrap_or(u64::MAX);
    if total > ATTACHMENT_STAT_MAX_BYTES {
        return Err(fault("fault.attachment.shareStatTooLarge"));
    }
    let mut value = json!({"mediaType": payload.media_type, "totalBytes": total});
    if let Some(mtime) = payload.mtime_ms {
        value["mtimeMs"] = json!(mtime);
    }
    Ok(value)
}

#[cfg(test)]
#[path = "attachment_rpc_tests.rs"]
mod tests;

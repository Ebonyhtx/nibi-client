//! 会话附件的读写（[`Kernel::load_attachment`](rust_cli_kernel_api::session_api::Kernel::load_attachment) /
//! [`Kernel::store_attachment`] / [`Kernel::read_attachment`]）：`zcode-artifact://` 经会话的 artifact
//! 存储，路径经会话所在机器的文件端口。
//!
//! Node 的 chunk 上传把完整内容写成 `data:<mime>;base64,…` 的 artifact 文本（`writePromptAttachment`）；
//! 工具产物则是别的形态。这里两种都认：data URL 解出字节与 mime，否则原样给字节（mime 由引用决定）。
//!
//! 写入侧照 Node 的同一形态（`data:<mime>;base64,…` 文本，`text/plain` 的内容类型），因为桌面切回 Node
//! 内核后还要按那条路径读回同一批 artifact——两边必须写同一种东西。

use rust_cli_kernel_api::attachment::{
    AttachmentPayload, AttachmentSource, LoadedAttachment, StoredAttachment,
};
use rust_cli_kernel_api::env::{EnvPath, ReadFile, WorkspaceRef};
use rust_cli_kernel_api::env_files::{FileKind, StatFile};
use rust_cli_kernel_api::ids::{ArtifactId, SessionId};
use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_kernel_api::store::{ArtifactPurpose, StoreError};

use super::*;

/// 解出来的附件上限（与协议 `attachmentMaxBytes` 的 20 MiB 同量级，data URL 解码后在原值附近）。
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

impl LocalKernel {
    pub(crate) async fn attachment_content(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        source: AttachmentSource,
    ) -> Result<LoadedAttachment, KernelError> {
        let payload = self.read_attachment_source(session, workspace, source, "").await?;
        Ok(LoadedAttachment {
            bytes: payload.bytes,
            media_type: (!payload.media_type.is_empty()).then_some(payload.media_type),
        })
    }

    /// 一次上传事务的完整内容 → 会话 artifact（Node `writePromptAttachment` 同形）。
    pub(crate) async fn store_attachment_content(
        &self,
        session: &SessionId,
        media_type: &str,
        bytes: Vec<u8>,
    ) -> Result<StoredAttachment, KernelError> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(KernelError::Failed {
                message: format!("attachment is larger than {MAX_ATTACHMENT_BYTES} bytes"),
            });
        }
        // 会话必须存在：artifact 目录按会话分，写进一个不存在的会话等于制造孤儿文件。
        self.ports
            .store
            .load(session)
            .await
            .map_err(store_error)?;
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        use base64::Engine;
        let content = format!(
            "data:{media_type};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        let artifact = self
            .ports
            .artifacts
            .put(
                session,
                ArtifactPurpose::Attachment,
                "text/plain".to_owned(),
                content.into_bytes(),
            )
            .await
            .map_err(store_error)?;
        Ok(StoredAttachment {
            uri: artifact_uri(&artifact),
            media_type: media_type.to_owned(),
            bytes: size,
        })
    }

    /// 已发送附件的内容与元数据（UI 回读与 share 预检）。
    pub(crate) async fn read_attachment_content(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        source: AttachmentSource,
        media_type: &str,
    ) -> Result<AttachmentPayload, KernelError> {
        self.read_attachment_source(session, workspace, source, media_type)
            .await
    }

    async fn read_attachment_source(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        source: AttachmentSource,
        declared: &str,
    ) -> Result<AttachmentPayload, KernelError> {
        match source {
            AttachmentSource::Artifact { uri } => {
                let (owner, id) = parse_artifact_uri(&uri).ok_or_else(|| KernelError::Failed {
                    message: format!("not an artifact URI: {uri}"),
                })?;
                // 引用属于命令的会话；跨会话读别人的 artifact 直接拒绝（隔离）。
                if owner != session.as_str() {
                    return Err(KernelError::Failed {
                        message: "attachment belongs to another session".to_owned(),
                    });
                }
                let artifact = self
                    .ports
                    .artifacts
                    .find(session, &ArtifactId::new(id))
                    .await
                    .map_err(store_error)?
                    .ok_or_else(|| KernelError::Failed {
                        message: format!("attachment artifact is missing: {uri}"),
                    })?;
                let bytes = self
                    .ports
                    .artifacts
                    .get(&artifact)
                    .await
                    .map_err(store_error)?;
                let loaded = decode(bytes)?;
                Ok(AttachmentPayload {
                    media_type: loaded
                        .media_type
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| declared.to_owned()),
                    bytes: loaded.bytes,
                    // artifact 没有可比的修改时间：share 预检的「选中之后被改过」只对路径引用成立。
                    mtime_ms: None,
                })
            }
            AttachmentSource::Path { path } => {
                let files = self.machine.files();
                let stat = files
                    .stat(
                        workspace,
                        StatFile {
                            path: EnvPath::new(path.clone()),
                        },
                    )
                    .await
                    .map_err(|error| KernelError::Failed {
                        message: error.to_string(),
                    })?;
                let Some(stat) = stat else {
                    return Err(KernelError::NotFound {
                        session: SessionId::new(path),
                    });
                };
                if stat.kind != FileKind::File {
                    return Err(KernelError::Failed {
                        message: format!("attachment is not a regular file: {path}"),
                    });
                }
                let bytes = files
                    .read_file(
                        workspace,
                        ReadFile {
                            path: EnvPath::new(path),
                        },
                    )
                    .await
                    .map_err(|error| KernelError::Failed {
                        message: error.to_string(),
                    })?
                    .bytes;
                Ok(AttachmentPayload {
                    bytes: capped(bytes)?.bytes,
                    media_type: declared.to_owned(),
                    mtime_ms: Some(stat.mtime_ms),
                })
            }
        }
    }
}

fn store_error(error: StoreError) -> KernelError {
    match error {
        StoreError::NotFound { session } => KernelError::NotFound { session },
        StoreError::Unsupported { what } => KernelError::Unsupported { what },
        other => KernelError::Failed {
            message: other.to_string(),
        },
    }
}

/// `zcode-artifact://<会话>/<artifact>`（百分号编码，与 Node 的 `encodeURIComponent` 同形）。
fn artifact_uri(artifact: &rust_cli_kernel_api::store::ArtifactRef) -> String {
    format!(
        "{}{}/{}",
        rust_cli_kernel_api::persisted_output::ARTIFACT_SCHEME,
        encode_component(artifact.session.as_str()),
        encode_component(artifact.id.as_str())
    )
}

/// `encodeURIComponent` 的保留集之外全部百分号编码（UTF-8 字节）。
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `zcode-artifact://<会话>/<artifact>` 的两段（百分号解码）。形状不对时为 None。
fn parse_artifact_uri(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix(rust_cli_kernel_api::persisted_output::ARTIFACT_SCHEME)?;
    let (owner, id) = rest.split_once('/')?;
    if owner.is_empty() || id.is_empty() || id.contains('/') {
        return None;
    }
    Some((percent_decode(owner)?, percent_decode(id)?))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn capped(bytes: Vec<u8>) -> Result<LoadedAttachment, KernelError> {
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(KernelError::Failed {
            message: format!("attachment is larger than {MAX_ATTACHMENT_BYTES} bytes"),
        });
    }
    Ok(LoadedAttachment {
        bytes,
        media_type: None,
    })
}

/// `data:<mime>;base64,<payload>` 解出字节与 mime；非 data URL 原样返回（mime 由引用决定）。
fn decode(bytes: Vec<u8>) -> Result<LoadedAttachment, KernelError> {
    let Some(text) = std::str::from_utf8(&bytes).ok() else {
        return capped(bytes);
    };
    let Some(rest) = text.strip_prefix("data:") else {
        return capped(bytes);
    };
    let Some((header, payload)) = rest.split_once(',') else {
        return capped(bytes);
    };
    let (media_type, encoded) = match header.split_once(';') {
        Some((media_type, flags)) => (
            media_type,
            flags.split(';').any(|flag| flag.eq_ignore_ascii_case("base64")),
        ),
        None => (header, false),
    };
    let decoded = if encoded {
        base64_decode(payload).ok_or_else(|| KernelError::Failed {
            message: "attachment content is not valid base64".to_owned(),
        })?
    } else {
        payload.as_bytes().to_vec()
    };
    if decoded.len() > MAX_ATTACHMENT_BYTES {
        return Err(KernelError::Failed {
            message: format!("attachment is larger than {MAX_ATTACHMENT_BYTES} bytes"),
        });
    }
    Ok(LoadedAttachment {
        bytes: decoded,
        media_type: (!media_type.is_empty()).then(|| media_type.to_owned()),
    })
}

/// 标准 base64（忽略空白）。
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (index, byte) in TABLE.iter().enumerate() {
        lookup[*byte as usize] = index as u8;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    let mut padding = 0usize;
    for byte in text.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            padding += 1;
            continue;
        }
        if padding > 0 {
            return None;
        }
        let value = lookup[byte as usize];
        if value == 255 {
            return None;
        }
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

#[cfg(test)]
#[path = "attachment_tests.rs"]
mod tests;

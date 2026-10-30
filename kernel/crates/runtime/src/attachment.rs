//! 会话附件的读取（[`Kernel::load_attachment`](rust_cli_kernel_api::session_api::Kernel::load_attachment)）：
//! `zcode-artifact://` 经会话的 artifact 存储，路径经会话所在机器的文件端口。
//!
//! Node 的 chunk 上传把完整内容写成 `data:<mime>;base64,…` 的 artifact 文本（`writePromptAttachment`）；
//! 工具产物则是别的形态。这里两种都认：data URL 解出字节与 mime，否则原样给字节（mime 由引用决定）。

use rust_cli_kernel_api::attachment::{AttachmentSource, LoadedAttachment};
use rust_cli_kernel_api::env::{EnvPath, ReadFile, WorkspaceRef};
use rust_cli_kernel_api::ids::{ArtifactId, SessionId};
use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_kernel_api::store::StoreError;

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
                decode(bytes)
            }
            AttachmentSource::Path { path } => {
                let bytes = self
                    .machine
                    .files()
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
                capped(bytes)
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

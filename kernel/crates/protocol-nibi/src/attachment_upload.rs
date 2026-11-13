//! 附件事务（141 审计 §9 第 4 项）：`v4/attachment/begin|chunk|commit|abort` 的暂存表。
//!
//! Host 的 `AttachmentUploadRegistry`（`apps/nibi-cli/packages/bootstrap/src/nibi-protocol-v4/
//! attachment-upload-registry.ts`）是这份实现的逐条对照。为什么不直接收整份内容：旧的
//! `attachment/put` 会把 20 MiB 的字节扩成约 26.7 MiB 的 NDJSON 单行，移动端外层再膨胀一次；
//! 所以 wire 上只有 ≤512 KiB 的片，逐片解码后计账，只有 commit 时校验完整事实才落 artifact。
//!
//! 三条不变量（照抄 Host，任何一条破了都会让桌面与 CLI 的语义分叉）：
//!
//! - **幂等**：同一个 `(connectionId, sessionId, uploadId)` 重复 `begin` 回同一个状态；重复 `chunk`
//!   在字节相同时是 no-op、不同时 `chunkConflict`；重复 `commit` 回同一个 ref。
//! - **顺序**：`chunkIndex` 必须正好等于已收片数（跳号 `chunkGap`、重发旧片按字节比对）。Host 的
//!   上传器按序发，乱序说明调用方在并发写同一个 uploadId。
//! - **有界**：单次 ≤20 MiB / ≤64 片、同时最多 16 个暂存、全进程暂存 ≤64 MiB、5 分钟 TTL。
//!
//! 暂存只在内存里：进程重启等于全部作废（Host 同样如此，`putSessionAttachment` 之前没有任何持久
//! 事实）。`committed` 表保留到 TTL，让「commit 之后重发 begin」能拿回同一个 ref 而不是重新写一份。

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use serde_json::{Value, json};

/// `PROTOCOL_V4_LIMITS.attachmentMaxBytes`：单次上传的内容上限。
pub(crate) const ATTACHMENT_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes`：一片解码后的上限。
pub(crate) const ATTACHMENT_CHUNK_MAX_BYTES: usize = 512 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks`。
pub(crate) const ATTACHMENT_UPLOAD_MAX_CHUNKS: u64 = 64;
/// `PROTOCOL_V4_LIMITS.attachmentUploadMaxConcurrent`。
pub(crate) const ATTACHMENT_UPLOAD_MAX_CONCURRENT: usize = 16;
/// `PROTOCOL_V4_LIMITS.attachmentUploadMaxStagedBytes`。
pub(crate) const ATTACHMENT_UPLOAD_MAX_STAGED_BYTES: usize = 64 * 1024 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentUploadTtlMs`。
pub(crate) const ATTACHMENT_UPLOAD_TTL_MS: u64 = 5 * 60_000;

/// 一次上传的声明（`v4/attachment/begin` 的参数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BeginRequest {
    pub connection: String,
    pub upload: String,
    pub session: String,
    pub file_name: String,
    pub media_type: String,
    pub total_bytes: u64,
    pub total_chunks: u64,
    pub checksum: String,
}

/// `begin` 的结果：还在收片，或者这个 uploadId 已经提交过。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BeginState {
    Staging { next_chunk: usize },
    Committed { next_chunk: usize, reference: String },
}

impl BeginState {
    pub(crate) fn to_json(&self, upload: &str) -> Value {
        match self {
            Self::Staging { next_chunk } => json!({
                "uploadId": upload,
                "state": "staging",
                "nextChunkIndex": next_chunk,
            }),
            Self::Committed {
                next_chunk,
                reference,
            } => json!({
                "uploadId": upload,
                "state": "committed",
                "nextChunkIndex": next_chunk,
                "ref": reference,
            }),
        }
    }
}

/// 事务的拒绝原因。每个都对应 Host 的 `fault.attachment.*` 码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UploadFault {
    BeginConflict,
    TooManyUploads,
    ChunkCountInsufficient,
    UploadNotFound,
    CommitInProgress,
    ChunkConflict,
    ChunkGap,
    TooManyChunks,
    EmptyChunk,
    TotalBytesExceeded,
    StagingCapacityExceeded,
    UploadIncomplete,
    ChecksumMismatch,
}

impl UploadFault {
    /// 线上的稳定码（Host `fault.attachment.<name>`）。
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::BeginConflict => "fault.attachment.beginConflict",
            Self::TooManyUploads => "fault.attachment.tooManyUploads",
            Self::ChunkCountInsufficient => "fault.attachment.chunkCountInsufficient",
            Self::UploadNotFound => "fault.attachment.uploadNotFound",
            Self::CommitInProgress => "fault.attachment.commitInProgress",
            Self::ChunkConflict => "fault.attachment.chunkConflict",
            Self::ChunkGap => "fault.attachment.chunkGap",
            Self::TooManyChunks => "fault.attachment.tooManyChunks",
            Self::EmptyChunk => "fault.attachment.emptyChunk",
            Self::TotalBytesExceeded => "fault.attachment.totalBytesExceeded",
            Self::StagingCapacityExceeded => "fault.attachment.stagingCapacityExceeded",
            Self::UploadIncomplete => "fault.attachment.uploadIncomplete",
            Self::ChecksumMismatch => "fault.attachment.checksumMismatch",
        }
    }
}

/// 已经通过 checksum 与总量校验、等调用方落 artifact 的一份内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadyUpload {
    pub session: String,
    pub file_name: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

struct Metadata {
    file_name: String,
    media_type: String,
    total_bytes: u64,
    total_chunks: u64,
    checksum: String,
}

impl Metadata {
    fn same_as(&self, request: &BeginRequest) -> bool {
        self.file_name == request.file_name
            && self.media_type == request.media_type
            && self.total_bytes == request.total_bytes
            && self.total_chunks == request.total_chunks
            && self.checksum == request.checksum
    }
}

struct Staged {
    connection: String,
    session: String,
    metadata: Metadata,
    chunks: Vec<Vec<u8>>,
    received: usize,
    expires_at: u64,
    /// 正在落 artifact：这一份的 `commit` 已经交出去了，别的 `chunk` / `abort` 要等它。
    committing: bool,
}

struct Committed {
    metadata: Metadata,
    next_chunk: usize,
    reference: String,
    expires_at: u64,
}

fn key(connection: &str, session: &str, upload: &str) -> String {
    format!("{connection}\u{0}{session}\u{0}{upload}")
}

/// 进程内的暂存表（Host `AttachmentUploadRegistry` 的同构实现）。
#[derive(Default)]
pub(crate) struct AttachmentUploads {
    staged: HashMap<String, Staged>,
    committed: HashMap<String, Committed>,
    staged_bytes: usize,
}

impl AttachmentUploads {
    /// 登记一次上传；同一个 key 重复登记回同一状态。
    pub(crate) fn begin(&mut self, request: &BeginRequest, now: u64) -> Result<BeginState, UploadFault> {
        self.prune(now);
        let key = key(&request.connection, &request.session, &request.upload);
        if let Some(committed) = self.committed.get(&key) {
            if !committed.metadata.same_as(request) {
                return Err(UploadFault::BeginConflict);
            }
            return Ok(BeginState::Committed {
                next_chunk: committed.next_chunk,
                reference: committed.reference.clone(),
            });
        }
        if let Some(staged) = self.staged.get_mut(&key) {
            if !staged.metadata.same_as(request) {
                return Err(UploadFault::BeginConflict);
            }
            staged.expires_at = now.saturating_add(ATTACHMENT_UPLOAD_TTL_MS);
            return Ok(BeginState::Staging {
                next_chunk: staged.chunks.len(),
            });
        }
        if self.staged.len() >= ATTACHMENT_UPLOAD_MAX_CONCURRENT {
            return Err(UploadFault::TooManyUploads);
        }
        // 片数与总量要自洽：`totalChunks` 片、每片最多 512 KiB，装不下 `totalBytes` 就永远提交不了。
        if request.total_chunks > 0
            && request.total_bytes
                > request
                    .total_chunks
                    .saturating_mul(ATTACHMENT_CHUNK_MAX_BYTES as u64)
        {
            return Err(UploadFault::ChunkCountInsufficient);
        }
        self.staged.insert(
            key,
            Staged {
                connection: request.connection.clone(),
                session: request.session.clone(),
                metadata: Metadata {
                    file_name: request.file_name.clone(),
                    media_type: request.media_type.clone(),
                    total_bytes: request.total_bytes,
                    total_chunks: request.total_chunks,
                    checksum: request.checksum.clone(),
                },
                chunks: Vec::new(),
                received: 0,
                expires_at: now.saturating_add(ATTACHMENT_UPLOAD_TTL_MS),
                committing: false,
            },
        );
        Ok(BeginState::Staging { next_chunk: 0 })
    }

    /// 这个 uploadId 已经提交过的引用（重复 commit 回同一个 ref；不碰暂存表）。
    pub(crate) fn committed_ref(&mut self, connection: &str, session: &str, upload: &str, now: u64) -> Option<String> {
        self.prune(now);
        self.committed
            .get(&key(connection, session, upload))
            .map(|committed| committed.reference.clone())
    }

    /// 收一片；返回下一片的序号。
    pub(crate) fn chunk(
        &mut self,
        connection: &str,
        session: &str,
        upload: &str,
        index: usize,
        bytes: Vec<u8>,
        now: u64,
    ) -> Result<usize, UploadFault> {
        self.prune(now);
        let key = key(connection, session, upload);
        let staged = self.staged.get_mut(&key).ok_or(UploadFault::UploadNotFound)?;
        if staged.committing {
            return Err(UploadFault::CommitInProgress);
        }
        // 重发旧片：字节相同是幂等，不同就是调用方在同一序号上换了内容。
        if index < staged.chunks.len() {
            return if staged.chunks[index] == bytes {
                Ok(staged.chunks.len())
            } else {
                Err(UploadFault::ChunkConflict)
            };
        }
        if index > staged.chunks.len() {
            return Err(UploadFault::ChunkGap);
        }
        if index as u64 >= staged.metadata.total_chunks {
            return Err(UploadFault::TooManyChunks);
        }
        if bytes.is_empty() {
            return Err(UploadFault::EmptyChunk);
        }
        if (staged.received + bytes.len()) as u64 > staged.metadata.total_bytes {
            return Err(UploadFault::TotalBytesExceeded);
        }
        if self.staged_bytes + bytes.len() > ATTACHMENT_UPLOAD_MAX_STAGED_BYTES {
            return Err(UploadFault::StagingCapacityExceeded);
        }
        self.staged_bytes += bytes.len();
        staged.received += bytes.len();
        staged.chunks.push(bytes);
        staged.expires_at = now.saturating_add(ATTACHMENT_UPLOAD_TTL_MS);
        Ok(staged.chunks.len())
    }

    /// 收尾校验：片数、总字节、sha256 全对才交出内容；不对时**保留**暂存（调用方可以补片重试）。
    pub(crate) fn take_ready(
        &mut self,
        connection: &str,
        session: &str,
        upload: &str,
        now: u64,
    ) -> Result<ReadyUpload, UploadFault> {
        self.prune(now);
        let key = key(connection, session, upload);
        let staged = self.staged.get_mut(&key).ok_or(UploadFault::UploadNotFound)?;
        if staged.committing {
            return Err(UploadFault::CommitInProgress);
        }
        if staged.chunks.len() as u64 != staged.metadata.total_chunks
            || staged.received as u64 != staged.metadata.total_bytes
        {
            return Err(UploadFault::UploadIncomplete);
        }
        let mut bytes = Vec::with_capacity(staged.received);
        for chunk in &staged.chunks {
            bytes.extend_from_slice(chunk);
        }
        let digest = sha256_hex(&bytes);
        if format!("sha256:{digest}") != staged.metadata.checksum {
            return Err(UploadFault::ChecksumMismatch);
        }
        staged.committing = true;
        Ok(ReadyUpload {
            session: staged.session.clone(),
            file_name: staged.metadata.file_name.clone(),
            media_type: staged.metadata.media_type.clone(),
            bytes,
        })
    }

    /// 落 artifact 之后登记结果：暂存转成 committed（同 key 的 `begin` 从此回同一个 ref）。
    pub(crate) fn finish(
        &mut self,
        connection: &str,
        session: &str,
        upload: &str,
        reference: &str,
        now: u64,
    ) {
        let key = key(connection, session, upload);
        let Some(staged) = self.staged.remove(&key) else {
            return;
        };
        self.staged_bytes = self.staged_bytes.saturating_sub(staged.received);
        self.committed.insert(
            key,
            Committed {
                metadata: staged.metadata,
                next_chunk: staged.chunks.len(),
                reference: reference.to_owned(),
                expires_at: now.saturating_add(ATTACHMENT_UPLOAD_TTL_MS),
            },
        );
    }

    /// 落 artifact 失败：解除 committing，让调用方可以重试 commit（暂存内容还在）。
    pub(crate) fn fail(&mut self, connection: &str, session: &str, upload: &str) {
        if let Some(staged) = self
            .staged
            .get_mut(&key(connection, session, upload))
        {
            staged.committing = false;
        }
    }

    /// 放弃一次上传。已经交出去的 commit 先等它落完（Host 同样等 `commitPromise`）。
    pub(crate) fn abort(&mut self, connection: &str, session: &str, upload: &str, now: u64) {
        self.prune(now);
        let key = key(connection, session, upload);
        if let Some(staged) = self.staged.get(&key)
            && staged.committing
        {
            return;
        }
        if let Some(staged) = self.staged.remove(&key) {
            self.staged_bytes = self.staged_bytes.saturating_sub(staged.received);
        }
    }

    /// 连接断开：这个连接名下的暂存与已提交记录全部作废。
    pub(crate) fn clear_connection(&mut self, connection: &str) {
        let keys: Vec<String> = self
            .staged
            .iter()
            .filter(|(_, staged)| staged.connection == connection)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(staged) = self.staged.remove(&key) {
                self.staged_bytes = self.staged_bytes.saturating_sub(staged.received);
            }
        }
        // key 是 `connection\0session\0upload`：按第一段筛。
        let marker = format!("{connection}\u{0}");
        self.committed.retain(|key, _| !key.starts_with(&marker));
    }

    /// 会话被删：这个会话名下的暂存与已提交记录全部作废。
    pub(crate) fn clear_session(&mut self, session: &str) {
        let keys: Vec<String> = self
            .staged
            .iter()
            .filter(|(_, staged)| staged.session == session)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(staged) = self.staged.remove(&key) {
                self.staged_bytes = self.staged_bytes.saturating_sub(staged.received);
            }
        }
        // key 是 `connection\0session\0upload`：按第二段筛。
        let marker = format!("\u{0}{session}\u{0}");
        self.committed.retain(|key, _| !key.contains(&marker));
    }

    fn prune(&mut self, now: u64) {
        let expired: Vec<String> = self
            .staged
            .iter()
            .filter(|(_, staged)| staged.expires_at <= now && !staged.committing)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            if let Some(staged) = self.staged.remove(&key) {
                self.staged_bytes = self.staged_bytes.saturating_sub(staged.received);
            }
        }
        self.committed
            .retain(|_, committed| committed.expires_at > now);
    }
}

/// sha256 的小写十六进制（Host 的 `createHash("sha256").digest("hex")`）。
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 暂存表挂在 [`Server`](crate::server::Server) 上的形状：一把锁包着整张表。
///
/// 锁只在同步的计账段里持有；落 artifact 的 await 在锁外（`take_ready` 先把这一份标成 committing，
/// 别的片与 abort 会被拒，但不会阻塞整个进程的上传）。
#[derive(Default)]
pub(crate) struct Registry {
    inner: Mutex<AttachmentUploads>,
}

impl Registry {
    pub(crate) fn with<R>(&self, f: impl FnOnce(&mut AttachmentUploads) -> R) -> R {
        let mut table = self
            .inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        f(&mut table)
    }
}

/// 参数里的 uploadId 形状（Host `v4AttachmentUploadIdSchema`：1..=128，`[A-Za-z0-9][A-Za-z0-9._:-]*`）。
pub(crate) fn valid_upload_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 128
        && first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// 参数里的 checksum 形状（`sha256:<64 位小写十六进制>`）。
pub(crate) fn valid_checksum(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
}

#[cfg(test)]
#[path = "attachment_upload_tests.rs"]
mod tests;

//! 附件事务的暂存表（141 审计 §9 第 4 项）：幂等、顺序、有界，以及 commit 的完整事实校验。
//!
//! 对照 Host 的 `AttachmentUploadRegistry`（`apps/zcode-cli/packages/bootstrap/src/nibi-protocol-v4/
//! attachment-upload-registry.ts`）与它的 `v4-native-attachments.test.ts`：同一组用例，同一组
//! `fault.attachment.*` 码。

use super::*;

fn begin_request(upload: &str, bytes: &[u8], chunks: u64) -> BeginRequest {
    BeginRequest {
        connection: "connection-1".to_owned(),
        upload: upload.to_owned(),
        session: "s1".to_owned(),
        file_name: "shot.png".to_owned(),
        media_type: "image/png".to_owned(),
        total_bytes: bytes.len() as u64,
        total_chunks: chunks,
        checksum: format!("sha256:{}", sha256_hex(bytes)),
    }
}

#[test]
fn begin_is_idempotent_and_conflicts_on_different_metadata() {
    let mut table = AttachmentUploads::default();
    let bytes = b"abcdef";
    let request = begin_request("upload-1", bytes, 1);
    assert_eq!(
        table.begin(&request, 0).unwrap(),
        BeginState::Staging { next_chunk: 0 }
    );
    // 同一份声明重复登记：还是 staging，从第 0 片开始。
    assert_eq!(
        table.begin(&request, 0).unwrap(),
        BeginState::Staging { next_chunk: 0 }
    );
    // 元数据变了：beginConflict（Host 同一判据）。
    let mut changed = request.clone();
    changed.file_name = "other.png".to_owned();
    assert_eq!(
        table.begin(&changed, 0).unwrap_err(),
        UploadFault::BeginConflict
    );
}

#[test]
fn chunks_must_arrive_in_order_and_are_idempotent() {
    let mut table = AttachmentUploads::default();
    let bytes = b"abcdef";
    let request = begin_request("upload-1", bytes, 2);
    table.begin(&request, 0).unwrap();
    assert_eq!(table.chunk("connection-1", "s1", "upload-1", 0, b"abc".to_vec(), 0).unwrap(), 1);
    // 同一片重发：字节相同是 no-op。
    assert_eq!(table.chunk("connection-1", "s1", "upload-1", 0, b"abc".to_vec(), 0).unwrap(), 1);
    // 同一序号换了内容：chunkConflict。
    assert_eq!(
        table
            .chunk("connection-1", "s1", "upload-1", 0, b"xxx".to_vec(), 0)
            .unwrap_err(),
        UploadFault::ChunkConflict
    );
    // 跳号：chunkGap。
    assert_eq!(
        table
            .chunk("connection-1", "s1", "upload-1", 2, b"def".to_vec(), 0)
            .unwrap_err(),
        UploadFault::ChunkGap
    );
    assert_eq!(table.chunk("connection-1", "s1", "upload-1", 1, b"def".to_vec(), 0).unwrap(), 2);
}

#[test]
fn commit_checks_the_complete_facts() {
    let mut table = AttachmentUploads::default();
    let bytes = b"abcdef";
    let request = begin_request("upload-1", bytes, 2);
    table.begin(&request, 0).unwrap();
    table.chunk("connection-1", "s1", "upload-1", 0, b"abc".to_vec(), 0).unwrap();
    // 片数不够：uploadIncomplete（暂存保留，调用方可以补片）。
    assert_eq!(
        table
            .take_ready("connection-1", "s1", "upload-1", 0)
            .unwrap_err(),
        UploadFault::UploadIncomplete
    );
    table.chunk("connection-1", "s1", "upload-1", 1, b"def".to_vec(), 0).unwrap();
    let ready = table.take_ready("connection-1", "s1", "upload-1", 0).unwrap();
    assert_eq!(ready.bytes, bytes);
    assert_eq!(ready.session, "s1");
    assert_eq!(ready.media_type, "image/png");
    // 收尾之后同一份不能再被取一次（committing 挡住并发 commit）。
    assert_eq!(
        table
            .take_ready("connection-1", "s1", "upload-1", 0)
            .unwrap_err(),
        UploadFault::CommitInProgress
    );
}

#[test]
fn a_wrong_checksum_is_rejected() {
    let mut table = AttachmentUploads::default();
    let mut request = begin_request("upload-1", b"abcdef", 1);
    request.checksum = format!("sha256:{}", "0".repeat(64));
    table.begin(&request, 0).unwrap();
    table.chunk("connection-1", "s1", "upload-1", 0, b"abcdef".to_vec(), 0).unwrap();
    assert_eq!(
        table
            .take_ready("connection-1", "s1", "upload-1", 0)
            .unwrap_err(),
        UploadFault::ChecksumMismatch
    );
}

#[test]
fn finishing_turns_the_upload_into_a_committed_reference() {
    let mut table = AttachmentUploads::default();
    let request = begin_request("upload-1", b"abcdef", 1);
    table.begin(&request, 0).unwrap();
    table.chunk("connection-1", "s1", "upload-1", 0, b"abcdef".to_vec(), 0).unwrap();
    table.take_ready("connection-1", "s1", "upload-1", 0).unwrap();
    table.finish("connection-1", "s1", "upload-1", "nibi-artifact://s1/a1", 0);
    // 再 begin 回 committed + 同一个 ref（Host 的 committed 表）。
    assert_eq!(
        table.begin(&request, 0).unwrap(),
        BeginState::Committed {
            next_chunk: 1,
            reference: "nibi-artifact://s1/a1".to_owned()
        }
    );
}

#[test]
fn limits_are_enforced_before_any_bytes_are_staged() {
    let mut table = AttachmentUploads::default();
    // 片数装不下总量：chunkCountInsufficient。
    let mut request = begin_request("upload-1", b"abcdef", 1);
    request.total_bytes = (ATTACHMENT_CHUNK_MAX_BYTES as u64) + 1;
    assert_eq!(
        table.begin(&request, 0).unwrap_err(),
        UploadFault::ChunkCountInsufficient
    );
    // 并发上限：第 17 个 begin 被拒。
    for index in 0..ATTACHMENT_UPLOAD_MAX_CONCURRENT {
        table
            .begin(&begin_request(&format!("upload-{index}"), b"a", 1), 0)
            .unwrap();
    }
    assert_eq!(
        table.begin(&begin_request("upload-x", b"a", 1), 0).unwrap_err(),
        UploadFault::TooManyUploads
    );
}

#[test]
fn a_chunk_past_the_declared_count_is_rejected() {
    let mut table = AttachmentUploads::default();
    let request = begin_request("upload-1", b"ab", 1);
    table.begin(&request, 0).unwrap();
    table.chunk("connection-1", "s1", "upload-1", 0, b"ab".to_vec(), 0).unwrap();
    assert_eq!(
        table
            .chunk("connection-1", "s1", "upload-1", 1, b"c".to_vec(), 0)
            .unwrap_err(),
        UploadFault::TooManyChunks
    );
    // 空片（序号本身合法时才是 emptyChunk；Host 同样先查片数）。
    let empty = begin_request("upload-2", b"ab", 2);
    table.begin(&empty, 0).unwrap();
    assert_eq!(
        table
            .chunk("connection-1", "s1", "upload-2", 0, Vec::new(), 0)
            .unwrap_err(),
        UploadFault::EmptyChunk
    );
}

#[test]
fn expired_uploads_are_pruned() {
    let mut table = AttachmentUploads::default();
    let request = begin_request("upload-1", b"abcdef", 1);
    table.begin(&request, 0).unwrap();
    table.chunk("connection-1", "s1", "upload-1", 0, b"abc".to_vec(), 0).unwrap();
    // TTL 之后：暂存没了，chunk 回 uploadNotFound。
    let later = ATTACHMENT_UPLOAD_TTL_MS + 1;
    assert_eq!(
        table
            .chunk("connection-1", "s1", "upload-1", 1, b"def".to_vec(), later)
            .unwrap_err(),
        UploadFault::UploadNotFound
    );
}

#[test]
fn abort_drops_the_staged_bytes() {
    let mut table = AttachmentUploads::default();
    let request = begin_request("upload-1", b"abcdef", 1);
    table.begin(&request, 0).unwrap();
    table.chunk("connection-1", "s1", "upload-1", 0, b"abcdef".to_vec(), 0).unwrap();
    table.abort("connection-1", "s1", "upload-1", 0);
    assert_eq!(table.staged_bytes, 0);
    assert_eq!(
        table
            .take_ready("connection-1", "s1", "upload-1", 0)
            .unwrap_err(),
        UploadFault::UploadNotFound
    );
}

#[test]
fn clearing_a_connection_or_session_drops_its_uploads() {
    let mut table = AttachmentUploads::default();
    let request = begin_request("upload-1", b"abcdef", 1);
    table.begin(&request, 0).unwrap();
    table.chunk("connection-1", "s1", "upload-1", 0, b"abcdef".to_vec(), 0).unwrap();
    table.clear_connection("connection-1");
    assert_eq!(table.staged_bytes, 0);
    assert_eq!(
        table
            .take_ready("connection-1", "s1", "upload-1", 0)
            .unwrap_err(),
        UploadFault::UploadNotFound
    );

    let request = begin_request("upload-2", b"abcdef", 1);
    table.begin(&request, 0).unwrap();
    table.clear_session("s1");
    assert_eq!(
        table
            .take_ready("connection-1", "s1", "upload-2", 0)
            .unwrap_err(),
        UploadFault::UploadNotFound
    );
}

#[test]
fn upload_ids_and_checksums_follow_the_host_shape() {
    for value in ["u", "upload-1", "a.b_c:d-e", &"a".repeat(128)] {
        assert!(valid_upload_id(value), "{value}");
    }
    for value in ["", "-leading", "has space", &"a".repeat(129)] {
        assert!(!valid_upload_id(value), "{value}");
    }
    assert!(valid_checksum(&format!("sha256:{}", "0".repeat(64))));
    assert!(!valid_checksum(&format!("sha256:{}", "A".repeat(64))));
    assert!(!valid_checksum(&format!("sha256:{}", "0".repeat(63))));
    assert!(!valid_checksum("md5:abc"));
}

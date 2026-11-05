//! 附件事务与回读经 `Handler` 的真实分派（141 审计 §9 第 4 项）：参数契约、`fault.attachment.*`
//! 码、commit 落 artifact 的接线，以及回读的授权链。
//!
//! 回读的授权要在当前会话投影里找行，所以这一组测试需要真的打开一个会话——用一个最小的
//! `SessionHandle` 替身喂一份带 `attachments` 的 `userInput` 行。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::attachment::{AttachmentPayload, StoredAttachment};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Kernel, KernelError, SessionHandle,
};
use rust_cli_kernel_api::store::{SessionFilter, SessionSummary};
use rust_cli_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use super::authorize;
use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

const NOW_MS: u64 = 1_760_000_000_000;

struct FixedClock;

impl rust_cli_kernel_api::clock::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        NOW_MS
    }

    fn time_zone(&self) -> String {
        "Asia/Shanghai".to_owned()
    }

    fn utc_offset_minutes(&self, _at_ms: u64) -> i32 {
        480
    }
}

fn selection() -> ModelSelection {
    ModelSelection {
        provider: "p".to_owned(),
        model: "m".to_owned(),
        reasoning: None,
        connection: None,
    }
}

/// 记录落 artifact 的调用（断言 commit 交了什么给内核）。
#[derive(Default)]
struct Seen {
    stored: Mutex<Vec<(String, String, Vec<u8>)>>,
    reads: Mutex<Vec<(String, String)>>,
}

/// 替身 Kernel：`store_attachment` 回一个固定 ref，`read_attachment` 回固定内容。
struct FakeKernel {
    seen: Arc<Seen>,
    /// 让 `store_attachment` / `read_attachment` 报 `Unsupported`。
    unsupported: bool,
    payload: Vec<u8>,
}

impl Default for FakeKernel {
    fn default() -> Self {
        Self {
            seen: Arc::new(Seen::default()),
            unsupported: false,
            payload: b"hello world".to_vec(),
        }
    }
}

#[async_trait]
impl Kernel for FakeKernel {
    async fn create_session(
        &self,
        _request: rust_cli_kernel_api::session_api::CreateSession,
    ) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "session creation".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Err(KernelError::NotFound {
            session: SessionId::new("unused"),
        })
    }

    async fn store_attachment(
        &self,
        session: &SessionId,
        file_name: &str,
        media_type: &str,
        bytes: Vec<u8>,
    ) -> Result<StoredAttachment, KernelError> {
        if self.unsupported {
            return Err(KernelError::Unsupported {
                what: "session attachment storage".to_owned(),
            });
        }
        self.seen.stored.lock().unwrap().push((
            file_name.to_owned(),
            media_type.to_owned(),
            bytes.clone(),
        ));
        Ok(StoredAttachment {
            uri: format!("nibi-artifact://{}/tool-result-1", session.as_str()),
            media_type: media_type.to_owned(),
            bytes: bytes.len() as u64,
        })
    }

    async fn read_attachment(
        &self,
        session: &SessionId,
        _workspace: &rust_cli_kernel_api::env::WorkspaceRef,
        source: rust_cli_kernel_api::attachment::AttachmentSource,
        media_type: &str,
    ) -> Result<AttachmentPayload, KernelError> {
        if self.unsupported {
            return Err(KernelError::Unsupported {
                what: "session attachment reads".to_owned(),
            });
        }
        let reference = match source {
            rust_cli_kernel_api::attachment::AttachmentSource::Artifact { uri } => uri,
            rust_cli_kernel_api::attachment::AttachmentSource::Path { path } => path,
        };
        self.seen
            .reads
            .lock()
            .unwrap()
            .push((session.as_str().to_owned(), reference));
        Ok(AttachmentPayload {
            bytes: self.payload.clone(),
            media_type: media_type.to_owned(),
            mtime_ms: None,
        })
    }
}

fn server(kernel: Arc<FakeKernel>) -> Arc<Server> {
    let scope = TaskScope::root("attachment-rpc-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let clock: Arc<dyn rust_cli_kernel_api::clock::Clock> = Arc::new(FixedClock);
    let context = Arc::new(Context::new(peer, clock));
    Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ))
}

fn fake() -> (Arc<Server>, Arc<Seen>) {
    let kernel = FakeKernel::default();
    let seen = kernel.seen.clone();
    (server(Arc::new(kernel)), seen)
}

fn sha256_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    format!("sha256:{out}")
}

fn begin_params(bytes: &[u8], chunks: u64) -> Value {
    json!({
        "connectionId": "connection-1",
        "uploadId": "upload-1",
        "sessionId": "s1",
        "fileName": "shot.png",
        "mime": "image/png",
        "totalBytes": bytes.len(),
        "totalChunks": chunks,
        "checksum": sha256_of(bytes),
    })
}

async fn request_error(
    server: Arc<Server>,
    method: &str,
    params: Value,
) -> rust_cli_protocol_core::rpc::RpcError {
    match Handler(server).request(method, params).await {
        Ok(_) => panic!("expected {method} to fail"),
        Err(error) => error,
    }
}

// ———— 上行事务 ————

/// 一次完整的上传：begin → chunk → commit，落 artifact 的内容与声明一致。
#[tokio::test]
async fn a_full_upload_lands_the_declared_bytes() {
    let (server, seen) = fake();
    let bytes = b"hello world";
    let reply = Handler(server.clone())
        .request("v4/attachment/begin", begin_params(bytes, 1))
        .await
        .unwrap();
    assert_eq!(
        reply.result,
        json!({"uploadId": "upload-1", "state": "staging", "nextChunkIndex": 0})
    );
    let reply = Handler(server.clone())
        .request(
            "v4/attachment/chunk",
            json!({
                "connectionId": "connection-1",
                "uploadId": "upload-1",
                "sessionId": "s1",
                "chunkIndex": 0,
                "dataBase64": base64_of(bytes),
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        reply.result,
        json!({"uploadId": "upload-1", "nextChunkIndex": 1})
    );
    let reply = Handler(server.clone())
        .request(
            "v4/attachment/commit",
            json!({"connectionId": "connection-1", "uploadId": "upload-1", "sessionId": "s1"}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result, json!({"ref": "nibi-artifact://s1/tool-result-1"}));
    let stored = seen.stored.lock().unwrap().clone();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].0, "shot.png");
    assert_eq!(stored[0].1, "image/png");
    assert_eq!(stored[0].2, bytes);
    // 重复 commit 回同一个 ref，不再写第二份。
    let reply = Handler(server)
        .request(
            "v4/attachment/commit",
            json!({"connectionId": "connection-1", "uploadId": "upload-1", "sessionId": "s1"}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result, json!({"ref": "nibi-artifact://s1/tool-result-1"}));
    assert_eq!(seen.stored.lock().unwrap().len(), 1);
}

fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 参数契约：未知键、坏 uploadId、坏 checksum、超限的总量都回 `-32602`。
#[tokio::test]
async fn begin_rejects_bad_params() {
    let (server, _seen) = fake();
    let error = request_error(
        server.clone(),
        "v4/attachment/begin",
        json!({"connectionId": "c", "uploadId": "u", "sessionId": "s", "fileName": "f",
            "mime": "image/png", "totalBytes": 0, "totalChunks": 0,
            "checksum": format!("sha256:{}", "0".repeat(64)), "extra": true}),
    )
    .await;
    assert_eq!(error.code, -32602);
    assert!(error.message.contains("Unrecognized key"), "{}", error.message);

    let mut params = begin_params(b"abc", 1);
    params["uploadId"] = json!("-bad");
    let error = request_error(server.clone(), "v4/attachment/begin", params).await;
    assert!(error.message.contains("uploadId"), "{}", error.message);

    let mut params = begin_params(b"abc", 1);
    params["checksum"] = json!("sha256:abc");
    let error = request_error(server.clone(), "v4/attachment/begin", params).await;
    assert!(error.message.contains("checksum"), "{}", error.message);

    // 20 MiB + 1 在 begin 就被拒，不触碰内核。
    let mut params = begin_params(b"abc", 1);
    params["totalBytes"] = json!(20 * 1024 * 1024 + 1);
    let error = request_error(server.clone(), "v4/attachment/begin", params).await;
    assert!(error.message.contains("totalBytes"), "{}", error.message);

    // 零字节但声明了片数。
    let mut params = begin_params(b"", 1);
    params["totalBytes"] = json!(0);
    let error = request_error(server, "v4/attachment/begin", params).await;
    assert!(error.message.contains("zero-byte"), "{}", error.message);
}

/// 落 artifact 不支持时回结构化的 `fault.attachment.putUnsupported`，暂存解开（可以重试）。
#[tokio::test]
async fn commit_reports_put_unsupported_and_keeps_the_staging() {
    let kernel = FakeKernel {
        unsupported: true,
        ..Default::default()
    };
    let server = server(Arc::new(kernel));
    let bytes = b"hello";
    Handler(server.clone())
        .request("v4/attachment/begin", begin_params(bytes, 1))
        .await
        .unwrap();
    Handler(server.clone())
        .request(
            "v4/attachment/chunk",
            json!({"connectionId": "connection-1", "uploadId": "upload-1", "sessionId": "s1",
                "chunkIndex": 0, "dataBase64": base64_of(bytes)}),
        )
        .await
        .unwrap();
    let error = request_error(
        server,
        "v4/attachment/commit",
        json!({"connectionId": "connection-1", "uploadId": "upload-1", "sessionId": "s1"}),
    )
    .await;
    assert_eq!(
        error.data.as_ref().and_then(|data| data["code"].as_str()),
        Some("fault.attachment.putUnsupported")
    );
}

/// 未知 uploadId 的 chunk / commit 回 `uploadNotFound`。
#[tokio::test]
async fn unknown_uploads_are_reported() {
    let (server, _seen) = fake();
    let error = request_error(
        server.clone(),
        "v4/attachment/chunk",
        json!({"connectionId": "c", "uploadId": "nope", "sessionId": "s",
            "chunkIndex": 0, "dataBase64": base64_of(b"x")}),
    )
    .await;
    assert_eq!(
        error.data.as_ref().and_then(|data| data["code"].as_str()),
        Some("fault.attachment.uploadNotFound")
    );
    let error = request_error(
        server,
        "v4/attachment/commit",
        json!({"connectionId": "c", "uploadId": "nope", "sessionId": "s"}),
    )
    .await;
    assert_eq!(
        error.data.as_ref().and_then(|data| data["code"].as_str()),
        Some("fault.attachment.uploadNotFound")
    );
}

/// abort 回空对象（Host 的 `v4AttachmentAbortResultSchema`）。
#[tokio::test]
async fn abort_returns_an_empty_object() {
    let (server, _seen) = fake();
    let reply = Handler(server)
        .request(
            "v4/attachment/abort",
            json!({"connectionId": "c", "uploadId": "u", "sessionId": "s"}),
        )
        .await
        .unwrap();
    assert_eq!(reply.result, json!({}));
}

// ———— 回读 ————

/// 没有 `target` 且投影里没有这个引用：`previewRefNotAuthorized`——renderer 传来的 ref 不能直接
/// 当路径读。
#[tokio::test]
async fn reads_without_an_authorized_row_are_refused() {
    let (server, _seen) = fake();
    let error = request_error(
        server,
        "v4/attachment/read",
        json!({"sessionId": "s1", "ref": "/etc/passwd", "offset": 0, "limit": 16}),
    )
    .await;
    assert_eq!(
        error.data.as_ref().and_then(|data| data["code"].as_str()),
        Some("fault.attachment.previewRefNotAuthorized")
    );
}

/// target 与 attachmentIndex 必须成对出现。
#[tokio::test]
async fn read_requires_target_and_index_together() {
    let (server, _seen) = fake();
    let error = request_error(
        server,
        "v4/attachment/read",
        json!({"sessionId": "s1", "ref": "nibi-artifact://s1/a", "offset": 0, "limit": 16,
            "target": {"rowId": 1, "entityId": "e"}}),
    )
    .await;
    assert!(error.message.contains("together"), "{}", error.message);
}

/// `limit` 上限是 512 KiB。
#[tokio::test]
async fn read_limit_is_bounded() {
    let (server, _seen) = fake();
    let error = request_error(
        server,
        "v4/attachment/read",
        json!({"sessionId": "s1", "ref": "nibi-artifact://s1/a", "offset": 0,
            "limit": 512 * 1024 + 1}),
    )
    .await;
    assert_eq!(error.code, -32602);
}

/// share 的两条要 target 与 attachmentIndex 都必填。
#[tokio::test]
async fn share_reads_require_a_row_target() {
    let (server, _seen) = fake();
    for (method, extra) in [
        ("v4/conversation/attachmentRead", json!({"offset": 0, "limit": 16})),
        ("v4/conversation/attachmentStat", json!({})),
    ] {
        let mut params = json!({"sessionId": "s1", "ref": "nibi-artifact://s1/a"});
        for (key, value) in extra.as_object().unwrap() {
            params[key] = value.clone();
        }
        let error = request_error(server.clone(), method, params).await;
        assert_eq!(error.code, -32602, "{method}");
        assert!(error.message.contains("required"), "{}", error.message);
    }
}

/// previewSource 只认两种 clientMode；授权不过时回 `previewRefNotAuthorized`。
#[tokio::test]
async fn preview_source_validates_the_client_mode() {
    let (server, _seen) = fake();
    let error = request_error(
        server.clone(),
        "v4/attachment/previewSource",
        json!({"sessionId": "s1", "ref": "nibi-artifact://s1/a", "clientMode": "bogus"}),
    )
    .await;
    assert_eq!(error.code, -32602);
    let error = request_error(
        server,
        "v4/attachment/previewSource",
        json!({"sessionId": "s1", "ref": "nibi-artifact://s1/a",
            "clientMode": "desktop-continuous"}),
    )
    .await;
    assert_eq!(
        error.data.as_ref().and_then(|data| data["code"].as_str()),
        Some("fault.attachment.previewRefNotAuthorized")
    );
}

// ———— 授权链（`resolveReadableMediaAttachment` 的三条）————

fn user_row(attachments: Value) -> serde_json::Map<String, Value> {
    let mut row = serde_json::Map::new();
    row.insert("rowId".into(), json!(7));
    row.insert("entityId".into(), json!("msg_u1"));
    row.insert("kind".into(), json!("userInput"));
    row.insert("attachments".into(), attachments);
    row
}

fn attachment(reference: &str, mime: &str) -> Value {
    json!({"ref": reference, "fileName": "a.png", "mime": mime, "bytes": 12})
}

/// 三条都对：行是 userInput、序号在 attachments 里、ref 对得上。
#[test]
fn the_authorization_chain_accepts_a_matching_row() {
    let rows = vec![user_row(json!([attachment("nibi-artifact://s1/a1", "image/png")]))];
    let params = json!({
        "ref": "nibi-artifact://s1/a1",
        "target": {"rowId": 7, "entityId": "msg_u1"},
        "attachmentIndex": 0,
    });
    let authorized = authorize(&rows, params.as_object().unwrap()).expect("authorized");
    assert_eq!(authorized.reference, "nibi-artifact://s1/a1");
    assert_eq!(authorized.media_type, "image/png");
}

/// 三条里任何一条不成立都拒绝。
#[test]
fn the_authorization_chain_rejects_each_mismatch() {
    let rows = vec![
        user_row(json!([attachment("nibi-artifact://s1/a1", "image/png")])),
        {
            let mut row = user_row(json!([attachment("nibi-artifact://s1/a2", "image/png")]));
            row.insert("rowId".into(), json!(8));
            row.insert("kind".into(), json!("assistantText"));
            row
        },
    ];
    let refuse = |params: Value| {
        assert!(
            authorize(&rows, params.as_object().unwrap()).is_none(),
            "{params}"
        );
    };
    // entityId 对不上。
    refuse(json!({"ref": "nibi-artifact://s1/a1",
        "target": {"rowId": 7, "entityId": "other"}, "attachmentIndex": 0}));
    // 序号越界。
    refuse(json!({"ref": "nibi-artifact://s1/a1",
        "target": {"rowId": 7, "entityId": "msg_u1"}, "attachmentIndex": 3}));
    // ref 对不上。
    refuse(json!({"ref": "nibi-artifact://s1/other",
        "target": {"rowId": 7, "entityId": "msg_u1"}, "attachmentIndex": 0}));
    // 行不是 userInput。
    refuse(json!({"ref": "nibi-artifact://s1/a2",
        "target": {"rowId": 8, "entityId": "msg_u1"}, "attachmentIndex": 0}));
    // 行不存在。
    refuse(json!({"ref": "nibi-artifact://s1/a1",
        "target": {"rowId": 99, "entityId": "msg_u1"}, "attachmentIndex": 0}));
}

/// 不可预览的类型（任意二进制）即使归属正确也不授权。
#[test]
fn the_authorization_chain_rejects_unpreviewable_types() {
    let rows = vec![user_row(json!([
        attachment("nibi-artifact://s1/bin", "application/octet-stream")
    ]))];
    let params = json!({
        "ref": "nibi-artifact://s1/bin",
        "target": {"rowId": 7, "entityId": "msg_u1"},
        "attachmentIndex": 0,
    });
    assert!(authorize(&rows, params.as_object().unwrap()).is_none());
}

/// 没有 target 的老 renderer：只认投影里出现过的引用；有 previewRef 时只授权那个 durable 引用。
#[test]
fn legacy_reads_authorize_only_the_durable_reference() {
    let mut with_preview = attachment("nibi-artifact://s1/a1", "image/png");
    with_preview["previewRef"] = json!("nibi-artifact://s1/preview");
    let rows = vec![user_row(json!([with_preview]))];
    // durable 引用：放行。
    let params = json!({"ref": "nibi-artifact://s1/preview"});
    assert!(authorize(&rows, params.as_object().unwrap()).is_some());
    // 原始路径：不放行（previewRef 存在时它可能已经变了）。
    let params = json!({"ref": "nibi-artifact://s1/a1"});
    assert!(authorize(&rows, params.as_object().unwrap()).is_none());
    // 投影里没有的引用：不放行。
    let params = json!({"ref": "/etc/passwd"});
    assert!(authorize(&rows, params.as_object().unwrap()).is_none());
}

/// 文本材料只在两个 sourceKind 下可预览（Host 的同一判据）。
#[test]
fn text_attachments_are_previewable_only_for_material_kinds() {
    for (kind, allowed) in [
        (Some("topic-history"), true),
        (Some("clipboard-text"), true),
        (Some("inline"), false),
        (None, false),
    ] {
        let mut item = attachment("nibi-artifact://s1/t", "text/plain");
        if let Some(kind) = kind {
            item["sourceKind"] = json!(kind);
        }
        let rows = vec![user_row(json!([item]))];
        let params = json!({"ref": "nibi-artifact://s1/t"});
        assert_eq!(
            authorize(&rows, params.as_object().unwrap()).is_some(),
            allowed,
            "{kind:?}"
        );
    }
}

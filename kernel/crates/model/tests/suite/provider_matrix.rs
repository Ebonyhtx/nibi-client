//! R31 的 provider 错误/重试矩阵（docs/specs/rust-cli/provider-errors.md，141 审计之外的切流门禁）。
//!
//! 每个协议至少覆盖「429 / 配额 / 5xx / 流断 / 超长 / 内容拦截 / 取消」的**内核侧**行为：请求次数
//! （不重复扣费）、是否重试、最终错误类型与文案。真实端点上的请求次数/时延/成本对照仍需运营者凭据，
//! 本文件的用例是可在本地与 CI 复跑的确定性半边；已有覆盖（429 退避、流断、取消、过载 fallback）
//! 分别在 `scenarios.rs` / `stream_retry.rs` / `stall.rs` / `failover.rs`，这里只补矩阵里缺的格子。
//!
//! 矩阵（✓ = 本文件，↗ = 既有用例）：
//!
//! | 错误类 | Anthropic | OpenAI-compatible | 智谱 |
//! |---|---|---|---|
//! | 429 限流 | ↗ `scenarios` | ↗ `openai` | ↗ `zhipu` |
//! | 配额用尽 | ✓ | ✓（含流内） | ↗ `zhipu` |
//! | 5xx/过载 | ↗ `stream_retry`/`failover` | ↗ `openai` | ✓ |
//! | 流断（边界前/后） | ↗ `stream_retry`/`scenarios` | ↗ `openai` | ↗ `zhipu` |
//! | 上下文超长 | ↗ `scenarios` | ↗ `openai` | ✓ |
//! | 内容拦截 | ✓ | ✓ | ✓（OpenAI 协议 ↗ `zhipu`） |
//! | 取消 | ↗ `scenarios`（传输层共用） | ↗ 同左 | ↗ 同左 |

#![allow(
    clippy::unwrap_used,
    reason = "辅助函数不在 #[test] 函数里，clippy 的测试放行不覆盖它；失败即测试失败"
)]

use rust_cli_kernel_api::model::{ModelError, QuerySource};
use serde_json::json;

use super::common::{collect, fast_retry, model_at, request, text_response};
use super::fixture::{Fixture, Reply};
use super::openai;
use super::zhipu;

/// Anthropic：配额用尽不重试（402 + `insufficient_quota`），只发一次请求。
#[tokio::test]
async fn anthropic_quota_is_not_retried() {
    let server = Fixture::start(vec![Reply::new(402).send(
        json!({"type": "error", "error": {
            "type": "billing_error", "code": "insufficient_quota", "message": "credit balance too low"
        }})
        .to_string(),
    )])
    .await;
    let model = model_at(server.url(), fast_retry(3)).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::QuotaExhausted {
            message: "credit balance too low".to_owned()
        })]
    );
    assert_eq!(server.requests().len(), 1);
}

/// Anthropic：内容拦截不静默成功、不重试。
#[tokio::test]
async fn anthropic_content_filter_is_not_retried() {
    let server = Fixture::start(vec![Reply::new(400).send(
        json!({"type": "error", "error": {
            "type": "invalid_request_error", "code": "content_filter", "message": "blocked input"
        }})
        .to_string(),
    )])
    .await;
    let model = model_at(server.url(), fast_retry(3)).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::ContentBlocked {
            message: "blocked input".to_owned()
        })]
    );
    assert_eq!(server.requests().len(), 1);
}

/// OpenAI Chat：`insufficient_quota` 在 429 上也按配额用尽处理（F113 D4：以前重试十次）。
#[tokio::test]
async fn openai_quota_is_not_retried() {
    let reply = Reply::new(429)
        .header("retry-after-ms", "1")
        .send(
            json!({"error": {"message": "quota exhausted", "type": "insufficient_quota"}})
                .to_string(),
        );
    let server = Fixture::start(vec![reply]).await;
    let model = openai::model(openai::endpoint(
        rust_cli_kernel_api::provider::WireProtocol::OpenAiChatCompletions,
        server.url(),
    ))
    .await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::QuotaExhausted {
            message: "quota exhausted".to_owned()
        })]
    );
    assert_eq!(server.requests().len(), 1);
}

/// OpenAI Chat：流里带的配额错误（HTTP 200）同样不重试（F113 D4 的流内分支）。
#[tokio::test]
async fn openai_stream_quota_is_not_retried() {
    let reply = openai::sse(
        &[json!({"error": {"message": "quota exhausted", "type": "insufficient_quota"}})],
        false,
    );
    let server = Fixture::start(vec![reply]).await;
    let model = openai::model(openai::endpoint(
        rust_cli_kernel_api::provider::WireProtocol::OpenAiChatCompletions,
        server.url(),
    ))
    .await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::QuotaExhausted {
            message: "quota exhausted".to_owned()
        })]
    );
    assert_eq!(server.requests().len(), 1);
}

/// OpenAI Chat：内容拦截码不重试。
#[tokio::test]
async fn openai_content_filter_is_not_retried() {
    let reply = Reply::new(400).send(
        json!({"error": {"message": "blocked output", "code": "content_filter"}}).to_string(),
    );
    let server = Fixture::start(vec![reply]).await;
    let model = openai::model(openai::endpoint(
        rust_cli_kernel_api::provider::WireProtocol::OpenAiChatCompletions,
        server.url(),
    ))
    .await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::ContentBlocked {
            message: "blocked output".to_owned()
        })]
    );
    assert_eq!(server.requests().len(), 1);
}

/// 智谱：`1261` 是上下文超长，不重试（映射成与 Anthropic 同一个 `PromptTooLong`）。
#[tokio::test]
async fn zhipu_context_overflow_is_not_retried() {
    let server = Fixture::start(vec![zhipu::coded(400, "1261", "输入过长")]).await;
    let model = zhipu::zhipu(&server).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::PromptTooLong {
            message: "输入过长".to_owned()
        })]
    );
    assert_eq!(server.requests().len(), 1);
}

/// 智谱：`1301` 是内容拦截，不重试。
#[tokio::test]
async fn zhipu_content_blocked_code_is_not_retried() {
    let server = Fixture::start(vec![zhipu::coded(400, "1301", "内容不合规")]).await;
    let model = zhipu::zhipu(&server).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::ContentBlocked {
            message: "内容不合规".to_owned()
        })]
    );
    assert_eq!(server.requests().len(), 1);
}

/// 智谱：`500` 是服务端错误，有界重试一次后成功（两次请求，正文只交出一份）。
#[tokio::test]
async fn zhipu_server_error_is_retried_then_completes() {
    let server = Fixture::start(vec![
        zhipu::coded(500, "500", "internal error"),
        Reply::new(200)
            .header("content-type", "text/event-stream")
            .send(text_response(&["ok"])),
    ])
    .await;
    let model = zhipu::zhipu(&server).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    assert_eq!(server.requests().len(), 2);
}

/// Anthropic：401 静态 API key 只发一次（Node 的分类器标 `retryable: false`；以前这里按
/// `AuthRejected` 的处置表重试到上限，白白发了三次）。
#[tokio::test]
async fn anthropic_authentication_is_not_retried() {
    let server = Fixture::start(vec![Reply::new(401).send(
        json!({"type": "error", "error": {
            "type": "authentication_error", "message": "invalid x-api-key"
        }})
        .to_string(),
    )])
    .await;
    let model = model_at(server.url(), fast_retry(3)).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::Authentication {
            message: "invalid x-api-key".to_owned()
        })]
    );
    assert_eq!(server.requests().len(), 1);
}

/// OpenAI Chat：401 静态 API key 同样只发一次。
#[tokio::test]
async fn openai_authentication_is_not_retried() {
    let reply = Reply::new(401).send(
        json!({"error": {"message": "bad key", "type": "authentication_error"}}).to_string(),
    );
    let server = Fixture::start(vec![reply]).await;
    let model = openai::model(openai::endpoint(
        rust_cli_kernel_api::provider::WireProtocol::OpenAiChatCompletions,
        server.url(),
    ))
    .await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::Authentication {
            message: "bad key".to_owned()
        })]
    );
    assert_eq!(server.requests().len(), 1);
}

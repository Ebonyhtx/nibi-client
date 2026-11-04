//! R31 的真实端点半边（DeepSeek 官方 API，三种线协议各一条）：
//! `anthropic-messages`、`openai-chat-completions`、`openai-responses`。
//!
//! 这是运营者手跑的测试（不进 CI）：先导出 key，再执行
//!
//! ```text
//! NIBI_LIVE_DEEPSEEK_KEY=... cargo test -p rust-cli-model --test live_deepseek -- --ignored --nocapture
//! ```
//!
//! 记录每次 HTTP 发送（请求条数、耗时、状态与错误分类），与内核侧矩阵
//! `crates/model/tests/suite/provider_matrix.rs` 合起来覆盖 R31 的两半。

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "运营者手跑的测试：失败即测试失败，错误信息要给足"
)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use rust_cli_base::secret::RedactedString;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::message::ContentBlock;
use rust_cli_kernel_api::model::{
    ApiContent, ApiMessage, ApiRole, BlockDelta, ModelError, ModelEvent, ModelPort, ModelRequest,
    ModelSelection, QuerySource, RequestOptions,
};
use rust_cli_kernel_api::provider::{Credential, ModelEndpoint, WireProtocol};
use rust_cli_model::{FixedEndpoint, ModelIoRecord, ModelIoSink, ProviderModel, RetryPolicy};
use rust_cli_net::{Egress, NetworkPolicy};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

const ANTHROPIC_BASE: &str = "https://api.deepseek.com/anthropic";
const OPENAI_BASE: &str = "https://api.deepseek.com/v1";
const DEFAULT_MODEL: &str = "deepseek-flash";

struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

#[derive(Default)]
struct Recorder(Mutex<Vec<Value>>);

impl Recorder {
    fn records(&self) -> Vec<Value> {
        self.0.lock().unwrap().clone()
    }
}

impl ModelIoSink for Recorder {
    fn record(&self, record: ModelIoRecord) {
        self.0
            .lock()
            .unwrap()
            .push(Value::Object(record.into_json()));
    }
}

async fn model(protocol: WireProtocol) -> (ProviderModel, Arc<Recorder>) {
    let key = std::env::var("NIBI_LIVE_DEEPSEEK_KEY")
        .expect("export NIBI_LIVE_DEEPSEEK_KEY before running the live test");
    model_with_key(protocol, key).await
}

async fn model_with_key(protocol: WireProtocol, key: String) -> (ProviderModel, Arc<Recorder>) {
    let model =
        std::env::var("NIBI_LIVE_DEEPSEEK_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned());
    let base_url = match protocol {
        WireProtocol::AnthropicMessages => ANTHROPIC_BASE,
        WireProtocol::OpenAiChatCompletions | WireProtocol::OpenAiResponses => OPENAI_BASE,
    };
    let endpoint = ModelEndpoint {
        protocol,
        base_url: base_url.to_owned(),
        model,
        credential: Credential::ApiKey(RedactedString::new(key)),
        headers: Vec::new(),
        body_patches: Vec::new(),
        mid_conversation_system: false,
        supports_image: true,
        supports_pdf: false,
        supports_video: false,
        supports_audio: false,
        renewable: false,
    };
    let recorder = Arc::new(Recorder::default());
    // 重试策略放到最长两次：真实端点的 4xx 必须是一次就失败，不能因为本地测试把 429/5xx 的重试藏起来。
    let model = ProviderModel::new(
        Arc::new(Egress::new(NetworkPolicy::default()).await.unwrap()),
        Arc::new(FixedEndpoint::new(endpoint)),
        Arc::new(SystemClock),
    )
    .with_retry(RetryPolicy {
        max_retries: 2,
        base_delay: Duration::from_millis(200),
        max_backoff: Duration::from_secs(2),
        jitter_ratio: 0.0,
        ..RetryPolicy::default()
    })
    .with_model_io(recorder.clone());
    (model, recorder)
}

fn request(prompt: &str, model: &str) -> ModelRequest {
    ModelRequest {
        selection: ModelSelection {
            provider: "deepseek".to_owned(),
            model: model.to_owned(),
            reasoning: None,
            connection: None,
        },
        system: Vec::new(),
        messages: vec![ApiMessage {
            role: ApiRole::User,
            content: vec![ApiContent {
                block: ContentBlock::Text {
                    text: prompt.to_owned(),
                },
                cache_control: None,
            }],
            output_config: None,
        }],
        tools: Vec::new(),
        tool_choice: None,
        max_tokens: 64,
        thinking: None,
        temperature: None,
        betas: Vec::new(),
        source: QuerySource::MainThread,
        options: RequestOptions::default(),
    }
}

fn text(events: &[Result<ModelEvent, ModelError>]) -> String {
    let mut out = String::new();
    for event in events {
        if let Ok(ModelEvent::BlockDelta {
            delta: BlockDelta::Text(part),
            ..
        }) = event
        {
            out.push_str(part);
        }
    }
    out
}

fn summarize(records: &[Value]) -> String {
    records
        .iter()
        .map(|record| {
            let status = record
                .get("response")
                .and_then(|response| response.get("status"))
                .and_then(Value::as_u64)
                .map_or_else(|| "-".to_owned(), |status| status.to_string());
            let outcome = record.get("outcome").and_then(Value::as_str).unwrap_or("?");
            let duration = record
                .get("durationMs")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            format!("{status}/{outcome}/{duration}ms")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

async fn run(
    protocol: WireProtocol,
    prompt: &str,
) -> (Vec<Result<ModelEvent, ModelError>>, Duration, Vec<Value>) {
    let (model, recorder) = model(protocol).await;
    let selected =
        std::env::var("NIBI_LIVE_DEEPSEEK_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned());
    let started = Instant::now();
    let events = model
        .stream(request(prompt, &selected), CancellationToken::new())
        .collect()
        .await;
    let elapsed = started.elapsed();
    (events, elapsed, recorder.records())
}

#[tokio::test]
#[ignore = "live provider test; export NIBI_LIVE_DEEPSEEK_KEY first"]
async fn deepseek_chat_completions_streams_text() {
    let (events, elapsed, records) = run(
        WireProtocol::OpenAiChatCompletions,
        "Reply with the single word: hello",
    )
    .await;
    let body = text(&events);
    println!(
        "chat-completions: elapsed={elapsed:?} requests=[{}] text={body:?}",
        summarize(&records)
    );
    assert!(!body.trim().is_empty(), "{events:?}");
    assert_eq!(records.len(), 1, "a normal request is sent once");
}

#[tokio::test]
#[ignore = "live provider test; export NIBI_LIVE_DEEPSEEK_KEY first"]
async fn deepseek_anthropic_messages_streams_text() {
    let (events, elapsed, records) = run(
        WireProtocol::AnthropicMessages,
        "Reply with the single word: hello",
    )
    .await;
    let body = text(&events);
    println!(
        "anthropic-messages: elapsed={elapsed:?} requests=[{}] text={body:?}",
        summarize(&records)
    );
    assert!(!body.trim().is_empty(), "{events:?}");
    assert_eq!(records.len(), 1, "a normal request is sent once");
}

#[tokio::test]
#[ignore = "live provider test; export NIBI_LIVE_DEEPSEEK_KEY first"]
async fn deepseek_responses_streams_text() {
    let (events, elapsed, records) = run(
        WireProtocol::OpenAiResponses,
        "Reply with the single word: hello",
    )
    .await;
    let body = text(&events);
    println!(
        "responses: elapsed={elapsed:?} requests=[{}] text={body:?}",
        summarize(&records)
    );
    assert!(!body.trim().is_empty(), "{events:?}");
    assert_eq!(records.len(), 1, "a normal request is sent once");
}

#[tokio::test]
#[ignore = "live provider test; export NIBI_LIVE_DEEPSEEK_KEY first"]
async fn deepseek_context_overflow_is_not_retried() {
    let (model, recorder) = model(WireProtocol::OpenAiChatCompletions).await;
    let selected =
        std::env::var("NIBI_LIVE_DEEPSEEK_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned());
    // 9 MB ASCII 约 112 万 token，超过 deepseek-flash 的 1,048,576 上下文。
    let prompt = "a".repeat(9_000_000);
    let events = model
        .stream(request(&prompt, &selected), CancellationToken::new())
        .collect::<Vec<_>>()
        .await;
    let error = events
        .iter()
        .find_map(|event| event.as_ref().err())
        .expect("an over-long prompt must fail");
    println!(
        "context-overflow: error={error:?} requests=[{}]",
        summarize(&recorder.records())
    );
    assert!(
        matches!(error, ModelError::PromptTooLong { .. }),
        "expected PromptTooLong, got {error:?}"
    );
    assert_eq!(
        recorder.records().len(),
        1,
        "context overflow is not retried"
    );
}

#[tokio::test]
#[ignore = "live provider test; export NIBI_LIVE_DEEPSEEK_KEY first"]
async fn deepseek_invalid_key_is_not_retried() {
    let (model, recorder) = model_with_key(
        WireProtocol::OpenAiChatCompletions,
        "sk-deepseek-live-invalid-000000".to_owned(),
    )
    .await;
    let events = model
        .stream(
            request("Reply with the single word: hello", DEFAULT_MODEL),
            CancellationToken::new(),
        )
        .collect::<Vec<_>>()
        .await;
    let error = events
        .iter()
        .find_map(|event| event.as_ref().err())
        .expect("an invalid key must fail");
    println!(
        "invalid-key: error={error:?} requests=[{}]",
        summarize(&recorder.records())
    );
    assert!(
        matches!(error, ModelError::Authentication { .. }),
        "expected Authentication, got {error:?}"
    );
    assert_eq!(recorder.records().len(), 1, "auth errors are not retried");
}

#[tokio::test]
#[ignore = "live provider test; export NIBI_LIVE_DEEPSEEK_KEY first"]
async fn deepseek_invalid_model_is_not_retried() {
    let (model, recorder) = model(WireProtocol::OpenAiChatCompletions).await;
    let events = model
        .stream(
            request("Reply with the single word: hello", "no-such-model"),
            CancellationToken::new(),
        )
        .collect::<Vec<_>>()
        .await;
    let error = events
        .iter()
        .find_map(|event| event.as_ref().err())
        .expect("an unknown model must fail");
    println!(
        "invalid-model: error={error:?} requests=[{}]",
        summarize(&recorder.records())
    );
    assert_eq!(
        recorder.records().len(),
        1,
        "non-retryable errors are sent once"
    );
}

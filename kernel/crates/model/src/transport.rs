//! 取端点、连接、重试、取消与读流（docs/specs/rust-cli/model.md §5）。与协议无关。
//!
//! 流是惰性的状态机（`stream::unfold`）：不轮询就不发请求，丢弃流即关闭连接，没有后台任务。
//!
//! ```text
//! Resolve（取端点与凭据，按协议编码）──▶ Connect ──2xx──▶ Read ──流结束事件──▶ 结束
//!                                          │ 失败且可重试：产出 Retrying 通知 ─▶ Wait（Retry-After / 退避）─▶ Connect
//!                                          │ 连续过载 3 次且有 fallback 模型 ─▶ Err(FallbackTriggered)
//!                                          └ 失败且不可重试 ──▶ Err ──▶ 结束      任一处取消 ──▶ Err(Cancelled)
//!   Read 在交出边界之前失败（P1）：同样按处置表决定重发（丢掉扣住的事件）还是交给调用方
//! ```
//!
//! 失败先经厂商分类器（`errors`）得到中性分类，再按处置表（`errors::dispose`）决定动作；计数都在 [`Connect`]
//! （docs/specs/rust-cli/provider-errors.md §2.4、§4，修复线 F113）。修改（F113）：以前只重试拿到响应头之前的失败，
//! 流开始之后的错误直接交给调用方（唯一的例外是看门狗的静默重发）；现在交出边界之前的流内失败也在这里重发
//! （§3.2：边界之前的事件扣在 `Events` 里，调用方一个内容事件都没收到），越过边界之后才交给主循环。
//! 流空闲看门狗见 docs/specs/rust-cli/stall-visibility.md §2.3。
//!
//! 通知：等待重试前产出 `Retrying`；重发拿到 2xx、或停顿之后又收到事件时产出 `Resumed`；读流时 20 s 没有
//! 字节产出 `Stalled`（读流与看门狗在 `transport_read.rs`）。

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::stream::{self, BoxStream, StreamExt};
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::model::{
    ModelError, ModelNotice, ModelRequest, ModelRequestStatus, ModelRequestStatusKind,
    ModelSelection, ModelStreamItem, QuerySource,
};
use rust_cli_kernel_api::provider::{EndpointContext, ModelEndpoint, ModelEndpoints, WireProtocol};
use rust_cli_net::retry::RetryPolicy;
use rust_cli_net::{Egress, HttpRequest};
use tokio_util::sync::CancellationToken;

use crate::attribution::Origin;
use crate::errors::dispose::Phase;
use crate::errors::{self, Vendor};
use crate::idle::{Limits, StreamIdle};
use crate::model_io::ModelIoSink;
use crate::model_io_tape::{End, Trail, end};
use crate::profiles::{self, ANTHROPIC_OFFICIAL_BASE_URL, Profile};
use crate::protocol::{self, Protocol};
use crate::transport_read::{Next, Read};

/// 错误响应正文最多读这么多字节（只用于分类与提示）。
const ERROR_BODY_LIMIT: usize = 64 * 1024;

/// 连续过载这么多次后，有 fallback 模型就换模型。
const MAX_OVERLOADED_BEFORE_FALLBACK: u32 = 3;

/// opus / fable / mythos 系列的主模型没有 fallback 时，连续过载后的错误文字。
pub(crate) const REPEATED_OVERLOAD: &str = "Repeated 529 Overloaded errors";

/// 哪些模型在连续过载后不再重试（模型目录里的系列是 opus、fable、
/// mythos）。本工程没有 Anthropic 的模型目录，按模型 ID 里的系列名判断（`claude-opus-5-5`、Bedrock 的
/// `us.anthropic.claude-opus-…` 等），其他模型照常按重试上限重试（model.md §5.2）。
fn stops_on_repeated_overload(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    ["claude-opus", "claude-fable", "claude-mythos"]
        .iter()
        .any(|family| model.contains(family))
}

/// 前台的旁路请求：用户在等结果，过载时也重试。
///
/// 修改（F113，provider-errors.md D10 暂定）：集合照对齐目标换过（出处见 spec）。以前是 5 项，含 `verification_agent`、没有
/// `web_search_tool` 与 `web_fetch_apply`，本工程的 WebSearch、WebFetch 旁路请求遇过载立即失败。
const FOREGROUND_SIDE_SOURCES: [&str; 11] = [
    "hook_agent",
    "hook_prompt",
    "side_question",
    "web_search_tool",
    "web_fetch_apply",
    "auto_mode",
    "compact_fab_check",
    "auto_mode_critique",
    "auto_mode_setup_propose",
    "chrome_mcp",
    "artifact_comment_reply",
];

/// 网络出口、端点来源、重试策略、流空闲看门狗与时钟（Retry-After 的日期，F7）。
#[derive(Clone)]
pub(crate) struct Route {
    pub egress: Arc<Egress>,
    pub endpoints: Arc<dyn ModelEndpoints>,
    pub retry: RetryPolicy,
    pub idle: StreamIdle,
    pub clock: Arc<dyn Clock>,
    /// 入口声明“按 Anthropic 官方端点处理”（只给测试用，model.md §6）：按 Node 配置里官方 API 的地址查方案表。
    pub assume_first_party: bool,
    /// 入口声明“按这个地址查方案表与厂商”（只给测试用，provider-errors.md D13）；`assume_first_party` 优先。
    pub assume_base_url: Option<String>,
    /// 设了 `IS_SANDBOX`（cli-args.md §9）：连续过载时不报 `Repeated 529 Overloaded errors`，照常重试。
    pub sandbox: bool,
    /// `ZCODE_MAX_OUTPUT_TOKENS`（cli-args.md §9.1，修复线 F42）：每个请求的 `max_tokens` 不超过它。
    pub max_output_tokens: Option<u32>,
    /// 设备身份的来源（工作线 F52）：`metadata.user_id` 的 `device_id`。
    pub device: Option<crate::metadata::DeviceIdSource>,
    /// 来源头与每请求头的 ID（工作线 F64，model.md §2.4；`user-agent` 是来源头的一项）；None 时这两层都不发。
    pub headers: Option<Arc<crate::request_headers::RequestHeaders>>,
    /// 模型轨迹的记录方（工作线 F91，model-io.md §6）；None 时不记。
    pub model_io: Option<Arc<dyn ModelIoSink>>,
}

impl Route {
    /// 查方案表与厂商用的 base URL：入口的测试声明优先，否则是端点自己的。
    fn table_base_url<'a>(&'a self, endpoint: &'a ModelEndpoint) -> &'a str {
        if self.assume_first_party {
            ANTHROPIC_OFFICIAL_BASE_URL
        } else if let Some(base_url) = &self.assume_base_url {
            base_url
        } else {
            &endpoint.base_url
        }
    }

    /// 这个端点的请求方案（model.md §3.2）。修复线 F23：原来按 `is_first_party`（只看主机名）分两种。
    pub(crate) fn profile(&self, endpoint: &ModelEndpoint) -> &'static Profile {
        profiles::select(
            endpoint.protocol,
            self.table_base_url(endpoint),
            &endpoint.model,
        )
    }

    /// 这个端点的错误码表（provider-errors.md §2.2）：只看端点。
    pub(crate) fn vendor(&self, endpoint: &ModelEndpoint) -> Vendor {
        profiles::vendor(self.table_base_url(endpoint))
    }

    /// 记录方与时钟（没有记录方时 None）。
    pub(crate) fn recorder(&self) -> Option<(Arc<dyn ModelIoSink>, Arc<dyn Clock>)> {
        let sink = self.model_io.clone()?;
        Some((sink, self.clock.clone()))
    }

    /// 进程的 trace ID（每请求头的 `x-zcode-trace-id`）。
    pub(crate) fn trace(&self) -> Option<&str> {
        self.headers
            .as_deref()
            .map(|headers| headers.trace_id.as_str())
    }
}

/// 时长的毫秒数（记录与通知用）。
fn millis(delay: Duration) -> u64 {
    u64::try_from(delay.as_millis()).unwrap_or(u64::MAX)
}

/// 注入的时钟的当前时间（`SystemTime`，给 Retry-After 的 HTTP 日期换算）。
pub(crate) fn now(clock: &dyn Clock) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(clock.now_ms())
}

fn retries_overload(source: &QuerySource) -> bool {
    match source {
        QuerySource::MainThread | QuerySource::Subagent(_) | QuerySource::Compact => true,
        QuerySource::Side(name) => FOREGROUND_SIDE_SOURCES.contains(&name.as_str()),
    }
}

pub(crate) fn stream(
    route: &Route,
    request: ModelRequest,
    cancel: CancellationToken,
) -> BoxStream<'static, Result<ModelStreamItem, ModelError>> {
    let start = Start {
        route: route.clone(),
        request,
        cancel,
    };
    stream::unfold(State::Resolve(Box::new(start)), step).boxed()
}

enum State {
    Resolve(Box<Start>),
    /// 一次尝试之前：取这次发送的请求 id、记开始时刻，先交出 `model_request_started`。
    Begin(Box<Connect>),
    Attempt(Box<Connect>),
    Wait(Box<Connect>, Duration),
    Read(Box<Read>),
    /// 先交出一项，再继续内层状态（重试一次要交出 failed / retry_scheduled / notice 三项）。
    Emit(Box<Result<ModelStreamItem, ModelError>>, Box<State>),
    /// 交出这个错误之后结束。
    Failing(ModelError),
    Done,
}

/// 依次交出 `items`，最后进入 `tail`。
fn before(items: Vec<Result<ModelStreamItem, ModelError>>, tail: State) -> State {
    let mut state = tail;
    for item in items.into_iter().rev() {
        state = State::Emit(Box::new(item), Box::new(state));
    }
    state
}

fn started(status: ModelRequestStatus) -> Result<ModelStreamItem, ModelError> {
    Ok(ModelStreamItem::Status(status))
}

fn retry_state(plan: Box<RetryPlan>) -> State {
    before(
        vec![
            started(plan.failed),
            started(plan.scheduled),
            Ok(ModelStreamItem::Notice(plan.notice)),
        ],
        State::Wait(plan.connect, plan.delay),
    )
}

fn failure_state(plan: Box<FailurePlan>) -> State {
    before(vec![started(plan.status)], State::Failing(plan.error))
}

async fn step(mut state: State) -> Option<(Result<ModelStreamItem, ModelError>, State)> {
    loop {
        state = match state {
            State::Done => return None,
            State::Resolve(start) => match start.resolve().await {
                Ok(connect) => State::Begin(Box::new(connect)),
                Err(error) => return Some((Err(error), State::Done)),
            },
            State::Begin(mut connect) => {
                let status = connect.begin_attempt();
                return Some((started(status), State::Attempt(connect)));
            }
            State::Attempt(connect) => match connect.attempt().await {
                Outcome::Opened(read) => State::Read(read),
                Outcome::Retry(plan) => retry_state(plan),
                Outcome::Failed(plan) => failure_state(plan),
            },
            State::Wait(connect, delay) => {
                match connect
                    .cancel
                    .run_until_cancelled(tokio::time::sleep(delay))
                    .await
                {
                    Some(()) => State::Begin(connect),
                    None => {
                        // 等待重试时被取消：这次尝试以 cancelled 收口（Node 同一条 failed 事件）。
                        let status = connect.failure_status(&ModelError::Cancelled);
                        before(
                            vec![started(status)],
                            State::Failing(ModelError::Cancelled),
                        )
                    }
                }
            }
            State::Emit(item, next) => return Some((*item, *next)),
            State::Failing(error) => return Some((Err(error), State::Done)),
            State::Read(mut read) => match read.next().await {
                None => {
                    let status = read.completed_status();
                    before(vec![started(status)], State::Done)
                }
                Some(Next::Item(item)) => {
                    return match item {
                        Ok(item) => Some((Ok(item), State::Read(read))),
                        Err(error) => {
                            let status = read.failure_status(&error);
                            Some((started(status), State::Failing(error)))
                        }
                    };
                }
                // 交出边界之前失败（P1，provider-errors.md §3.2）：扣住的事件随响应丢掉，按处置表重发或交给调用方。
                Some(Next::Early(verdict)) => {
                    let (connect, tape) = read.into_parts();
                    return Some(match connect.fail(verdict, Phase::Stream, tape).await {
                        Ok(plan) => {
                            let failed = plan.failed.clone();
                            (started(failed), retry_state(plan))
                        }
                        Err(plan) => {
                            let status = plan.status.clone();
                            (started(status), failure_state(plan))
                        }
                    });
                }
                Some(Next::Idle(limit)) => {
                    // 丢掉这次响应（关闭连接），按进度决定静默重发、G 还是报错（stall-visibility.md §2.3）。
                    let progress = read.progress();
                    let (connect, tape) = read.into_parts();
                    let idle = ModelError::StreamIdle {
                        idle_ms: millis(limit),
                    };
                    let stalled = connect.stalled_status(millis(limit), millis(limit));
                    return Some(match connect.idle(limit, progress) {
                        Ok(mut plan) => {
                            end(tape, End::Idle(idle, Some(0)));
                            // 看门狗的静默重发是立即的：retry_scheduled 的等待是 0。
                            plan.scheduled.reason = Some("stream_idle_timeout".to_owned());
                            (
                                started(stalled),
                                before(
                                    vec![
                                        started(plan.failed),
                                        started(plan.scheduled),
                                        Ok(ModelStreamItem::Notice(plan.notice)),
                                    ],
                                    State::Begin(plan.connect),
                                ),
                            )
                        }
                        Err(plan) => {
                            end(tape, End::Idle(idle, None));
                            (
                                started(stalled),
                                before(vec![started(plan.status)], State::Failing(plan.error)),
                            )
                        }
                    });
                }
            },
        };
    }
}

/// 还没取端点的请求。
struct Start {
    route: Route,
    request: ModelRequest,
    cancel: CancellationToken,
}

impl Start {
    /// 取这次请求的端点（每请求鉴权），再按它的协议编码。
    async fn resolve(self) -> Result<Connect, ModelError> {
        let Start {
            route,
            mut request,
            cancel,
        } = self;
        if cancel.is_cancelled() {
            return Err(ModelError::Cancelled);
        }
        // 工作线 F95（model.md §9）：请求交给 Provider 补丁的输出上限随取端点交给平台层（目录模型的 `maxOutputTokens`
        // 补丁以它与配置的上限的较小值为输入）；没有时同 `endpoint`。
        let output_limit = request.options.provider_max_output_tokens.map(u64::from);
        // 缺口 G8（app-protocol.md §5.2）：取端点时带上发请求的会话，前端提供的请求头来源按它找会话。
        let context = EndpointContext {
            session: request.options.session_id.clone(),
        };
        let endpoint = cancel
            .run_until_cancelled(route.endpoints.endpoint_in(
                &request.selection,
                None,
                output_limit,
                &context,
            ))
            .await
            .ok_or(ModelError::Cancelled)??;
        // 工作线 F52（model.md §3.3）：每个请求都带 `metadata.user_id`。修 bug：以前只在调用方给了 user_id 时写，没有调用方
        // 给，请求里一直没有 metadata（Node 每个请求都写）。设备身份只在第一次请求时读文件。
        // 工作线 F52b（用户决定）：只给 Anthropic 协议。F52 三种协议都写，OpenAI 官方的 Chat Completions 在没有
        // `store: true` 时报 400；现在 OpenAI 两种协议不算 user_id、不读设备身份（Node 的 `providerKind` 判断相同）。
        if endpoint.protocol == WireProtocol::AnthropicMessages
            && request.options.user_id.is_none()
            && let Some(device) = &route.device
        {
            let device_id = cancel
                .run_until_cancelled(device())
                .await
                .ok_or(ModelError::Cancelled)?;
            let session = request
                .options
                .session_id
                .as_ref()
                .map(rust_cli_kernel_api::ids::SessionId::as_str);
            request.options.user_id = Some(crate::metadata::user_id(&device_id, session));
        }
        let protocol = protocol::for_wire(endpoint.protocol);
        // 每请求头要的会话、回合与来源在编码前取出（请求体只编码一次，重试复用；F64）。
        let origin = Origin::of(&request);
        let selection = request.selection.clone();
        let fallback = request.options.fallback_model.clone();
        let overload_retry = retries_overload(&request.source);
        // 状态事实要的来源与回合 id（编码会消费请求）。
        let source = request.source.clone();
        let query_id = request
            .options
            .run
            .as_ref()
            .map(|run| run.as_str().to_owned());
        // 模型不接受图片时换成占位文字（model.md §10.5），三种协议共用。
        crate::media::project(&mut request.messages, &endpoint);
        let profile = route.profile(&endpoint);
        let vendor = route.vendor(&endpoint);
        tracing::debug!(
            event = "model.profile",
            model = %endpoint.model,
            profile = profile.name,
            vendor = ?vendor,
            "request profile selected"
        );
        // 模型轨迹（model-io.md §6）：请求的共用信息在编码之前取（编码会消费请求）。
        let trail = route.recorder().map(|recorder| {
            Trail::for_request(recorder, &request, &endpoint, profile.name, route.trace())
        });
        let encoded = protocol.encode(&endpoint, request, profile)?;
        let limits = route.idle.limits(profile.byte_idle);
        Ok(Connect {
            route,
            protocol,
            encoded,
            endpoint,
            origin,
            selection,
            context,
            output_limit,
            fallback,
            overload_retry,
            vendor,
            attempt: 1,
            overloaded: 0,
            stalls: 0,
            capacity: 0,
            truncations: 0,
            resent: false,
            notified: false,
            limits,
            cancel,
            trail,
            source,
            query_id,
            started_ms: 0,
            request_id: None,
        })
    }
}

/// 已编码的请求与重试计数。请求体只编码一次；凭据 header 每次发送前按当前端点写入。
pub(crate) struct Connect {
    route: Route,
    protocol: &'static dyn Protocol,
    encoded: HttpRequest,
    endpoint: ModelEndpoint,
    /// 发请求的一方（每请求头）。
    origin: Origin,
    selection: ModelSelection,
    /// 取端点的上下文（G8）：401 后重取凭据时同样带上。
    context: EndpointContext,
    /// 交给 Provider 补丁的输出上限（与第一次取端点相同）。
    output_limit: Option<u64>,
    fallback: Option<String>,
    overload_retry: bool,
    /// 错误码表的厂商（provider-errors.md §2.2）：分类 HTTP 失败、给解码器。
    vendor: Vendor,
    attempt: u32,
    /// 这次请求累计的过载次数（一次重试循环内只增不减；响应头之前与流内共用，F113）。
    overloaded: u32,
    /// 看门狗静默重发过几次（上限 1）。
    stalls: u32,
    /// 账号或套餐的并发上限重试过几次（上限 2，provider-errors.md D5，F113）。
    capacity: u32,
    /// 交出边界之前的截断重试过几次（上限 1，D17，F113）。
    truncations: u32,
    /// 用过 G 没有（一次流式重发代替非流式重发，D3 (b)，F113）。
    resent: bool,
    /// 发过 `Retrying` 通知、还没有产出 `Resumed`。
    notified: bool,
    /// 这个端点上的看门狗上限。
    limits: Limits,
    cancel: CancellationToken,
    /// 模型轨迹：每次发送开一个录音（model-io.md §6）。
    trail: Option<Trail>,
    /// 这次请求的来源（`v4/telemetry/event` 的 `querySource`）。
    source: QuerySource,
    /// 回合 ID（`v4/telemetry/event` 的 `queryId`）：请求没带时缺席。
    query_id: Option<String>,
    /// 这次尝试的开始时刻（`model_request_*` 的 `durationMs` 起点）。
    started_ms: u64,
    /// 这次发送的 `x-request-id`（同一枚用于请求头与 `requestId` 事实）。
    request_id: Option<String>,
}

/// 重试一次要交出的全部东西（状态事实、给界面的通知与下一次发送）。
pub(crate) struct RetryPlan {
    pub notice: ModelNotice,
    pub connect: Box<Connect>,
    pub delay: Duration,
    /// `model_request_failed`（这次尝试的失败）。
    pub failed: ModelRequestStatus,
    /// `model_retry_scheduled`（下一次尝试与等待）。
    pub scheduled: ModelRequestStatus,
}

/// 终态失败：错误本身与 `model_request_failed` 事实。
pub(crate) struct FailurePlan {
    pub error: ModelError,
    pub status: ModelRequestStatus,
}

enum Outcome {
    Opened(Box<Read>),
    Retry(Box<RetryPlan>),
    Failed(Box<FailurePlan>),
}

impl Connect {
    /// 发一次请求。失败时决定结束、换 fallback 模型，还是等待后重发。每次发送记一条模型轨迹（model-io.md §6）。
    async fn attempt(mut self: Box<Self>) -> Outcome {
        // 每次发送都按当前端点合并各层的头：凭据续期之后换新，`x-request-id` 每次换新（F64）。
        let http = crate::request_headers::outbound(
            self.protocol,
            &self.encoded,
            &self.endpoint,
            self.route.headers.as_deref(),
            &self.origin,
            self.request_id.as_deref(),
        );
        let mut tape = self
            .trail
            .as_ref()
            .map(|trail| trail.tape(self.attempt, &http));
        let Some(sent) = self
            .cancel
            .run_until_cancelled(self.route.egress.send(http))
            .await
        else {
            end(tape, End::Cancelled);
            let error = ModelError::Cancelled;
            let status = self.failure_status(&error);
            return Outcome::Failed(Box::new(FailurePlan { error, status }));
        };
        let verdict = match sent {
            Ok(response) if response.is_success() => {
                // 前面发过重试通知：拿到响应头就清掉它（重试循环结束时清掉重试状态）。
                let resumed = std::mem::replace(&mut self.notified, false);
                let mut decoder = self.protocol.decoder(self.vendor);
                if let Some(tape) = &mut tape {
                    decoder = tape.stream(response.status(), response.headers(), decoder);
                }
                let read = Read::new(response, decoder, self.limits, resumed, self, tape);
                return Outcome::Opened(Box::new(read));
            }
            Ok(response) => {
                let status = response.status();
                let headers = response.headers().clone();
                match self
                    .cancel
                    .run_until_cancelled(response.text(ERROR_BODY_LIMIT))
                    .await
                {
                    None => {
                        end(tape, End::Cancelled);
                        let error = ModelError::Cancelled;
                        let status = self.failure_status(&error);
                        return Outcome::Failed(Box::new(FailurePlan { error, status }));
                    }
                    Some(Ok(body)) => {
                        if let Some(tape) = &mut tape {
                            tape.text(status, &headers, &body);
                        }
                        errors::classify_response(
                            self.vendor,
                            self.endpoint.protocol,
                            (status, &headers),
                            &body,
                            now(self.route.clock.as_ref()),
                        )
                    }
                    Some(Err(error)) => errors::classify_transport(&error),
                }
            }
            Err(error) => errors::classify_transport(&error),
        };
        match self.fail(verdict, Phase::Head, tape).await {
            Ok(plan) => Outcome::Retry(plan),
            Err(plan) => Outcome::Failed(plan),
        }
    }

    pub(crate) fn cancel(&self) -> &CancellationToken {
        &self.cancel
    }

    /// 含首次尝试的总尝试数（`v4/telemetry/event` 的 `maxAttempts`）。
    fn max_attempts(&self) -> u32 {
        self.route.retry.max_retries.saturating_add(1)
    }

    /// 这次尝试已经过去多久（用注入的时钟，测试在暂停的时钟上也是准的）。
    fn elapsed_ms(&self) -> u64 {
        self.route
            .clock
            .now_ms()
            .saturating_sub(self.started_ms)
    }

    fn status(&self, kind: ModelRequestStatusKind) -> ModelRequestStatus {
        ModelRequestStatus {
            kind,
            request_id: self.request_id.clone().unwrap_or_default(),
            provider_id: self.selection.provider.clone(),
            model_id: self.endpoint.model.clone(),
            provider_hostname: host_of(&self.endpoint.base_url),
            transport: "sse".to_owned(),
            query_source: Some(self.source.node_name()),
            query_id: self.query_id.clone(),
            attempt: self.attempt,
            max_attempts: self.max_attempts(),
            duration_ms: None,
            reason: None,
            retryable: None,
            status_code: None,
            delay_ms: None,
            next_attempt: None,
            idle_ms: None,
            timeout_ms: None,
        }
    }

    /// 开始一次尝试：取这次发送的请求 id（与 `x-request-id` 同一枚）、记开始时刻。
    pub(crate) fn begin_attempt(&mut self) -> ModelRequestStatus {
        self.started_ms = self.route.clock.now_ms();
        self.request_id = Some(match self.route.headers.as_deref() {
            Some(headers) => (headers.request_id)(),
            None => fallback_request_id(self.route.clock.as_ref()),
        });
        self.status(ModelRequestStatusKind::ModelRequestStarted)
    }

    /// 一次成功读流的终态（`model_request_completed`）。
    pub(crate) fn completed_status(&self) -> ModelRequestStatus {
        let mut status = self.status(ModelRequestStatusKind::ModelRequestCompleted);
        status.duration_ms = Some(self.elapsed_ms());
        status
    }

    /// 一次失败的终态（没有可选的状态码 / 可重试标记）。
    pub(crate) fn failure_status(&self, error: &ModelError) -> ModelRequestStatus {
        self.failed_status(error, false, None)
    }

    fn failed_status(
        &self,
        error: &ModelError,
        retryable: bool,
        status_code: Option<u16>,
    ) -> ModelRequestStatus {
        let mut status = self.status(ModelRequestStatusKind::ModelRequestFailed);
        status.duration_ms = Some(self.elapsed_ms());
        status.reason = Some(failure_reason(error).to_owned());
        status.retryable = Some(retryable);
        status.status_code = status_code;
        status
    }

    /// 一次看门狗中止（`model_stream_stalled`）。
    pub(crate) fn stalled_status(&self, idle_ms: u64, timeout_ms: u64) -> ModelRequestStatus {
        let mut status = self.status(ModelRequestStatusKind::ModelStreamStalled);
        status.idle_ms = Some(idle_ms);
        status.timeout_ms = Some(timeout_ms);
        status
    }

    /// 决定重发之后的 `model_retry_scheduled`（`attempt` 还没有加一）。
    fn retry_status(&self, error: &ModelError, status_code: Option<u16>, delay: Duration) -> ModelRequestStatus {
        let mut status = self.status(ModelRequestStatusKind::ModelRequestRetryScheduled);
        status.delay_ms = Some(millis(delay));
        status.next_attempt = Some(self.attempt.saturating_add(1));
        status.reason = Some(failure_reason(error).to_owned());
        status.status_code = status_code;
        status
    }

    /// 看门狗中止了这次流（stall-visibility.md §2.3）。`progress` 是（解码出过事件，越过了交出边界）。越过了边界：报
    /// `StreamIdle`，由主循环按进度收尾。没有越过时：一个事件都没收到、也还没静默重发过时回到发送（计入重试次数，不等待）；
    /// 否则走 G（修复线 F113，provider-errors.md D3 暂定 (b)：以前直接报 `StreamIdle`），G 用过之后才报错。
    fn idle(
        mut self: Box<Self>,
        limit: Duration,
        (received, crossed): (bool, bool),
    ) -> Result<Box<RetryPlan>, Box<FailurePlan>> {
        let error = ModelError::StreamIdle {
            idle_ms: millis(limit),
        };
        if crossed {
            let status = self.failure_status(&error);
            return Err(Box::new(FailurePlan { error, status }));
        }
        let max_retries = self.route.retry.max_retries;
        if !received && self.stalls == 0 && self.attempt <= max_retries {
            self.stalls += 1;
        } else if self.resend().is_none() {
            let status = self.failure_status(&error);
            return Err(Box::new(FailurePlan { error, status }));
        }
        tracing::debug!(
            event = "model.attempt.failed",
            model = %self.selection.model,
            attempt = self.attempt,
            max_retries,
            delay_ms = 0_u64,
            error = %error,
            "model stream idle; retrying"
        );
        let failed = self.failed_status(&error, true, None);
        let scheduled = self.retry_status(&error, None, Duration::ZERO);
        let notice = ModelNotice::Retrying {
            attempt: self.attempt,
            max_retries,
            delay_ms: 0,
            error,
        };
        self.attempt += 1;
        self.notified = true;
        Ok(Box::new(RetryPlan {
            notice,
            connect: self,
            delay: Duration::ZERO,
            failed,
            scheduled,
        }))
    }
}

/// `v4/telemetry/event` 的 `reason` 词表（Node `ModelFailureReason` 的拼写；内核没有对应词的
/// 用自己的词，Host schema 收任意字符串）。
fn failure_reason(error: &ModelError) -> &'static str {
    match error {
        ModelError::Cancelled => "cancelled",
        ModelError::RateLimited { .. } => "rate_limited",
        ModelError::Overloaded { .. } => "provider_overloaded",
        ModelError::PromptTooLong { .. } => "context_exceeded",
        ModelError::Authentication { .. } => "auth_failed",
        ModelError::InvalidRequest { .. } => "invalid_request",
        ModelError::Network { .. } => "network_error",
        ModelError::Server { .. } => "server_error",
        ModelError::Protocol { .. }
        | ModelError::FallbackTriggered { .. }
        | ModelError::Unsupported { .. } => "unknown",
        ModelError::StreamIdle { .. } => "timeout",
        ModelError::QuotaExhausted { .. } => "quota_exhausted",
        ModelError::ContentBlocked { .. } => "content_blocked",
        ModelError::RequestTooLarge { .. } => "request_too_large",
    }
}

/// 端点地址里的主机名（Host `providerHostname`：不带 scheme、端口、路径；IPv6 保留方括号）。
fn host_of(base_url: &str) -> Option<String> {
    let rest = base_url
        .split_once("://")
        .map_or(base_url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    if authority.is_empty() {
        return None;
    }
    if let Some(after) = authority.strip_prefix('[') {
        let host = after.split_once(']')?.0;
        return (!host.is_empty()).then(|| format!("[{host}]"));
    }
    let host = authority.split(':').next().unwrap_or(authority);
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// 没有每请求头来源（测试、嵌入）时的请求 id：进程内唯一，够关联同一进程的日志与事实。
fn fallback_request_id(clock: &dyn Clock) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!(
        "req_{}_{}",
        clock.now_ms(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

#[path = "transport_retry.rs"]
mod retry;

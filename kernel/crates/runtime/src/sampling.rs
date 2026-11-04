//! MCP Apps 采样的模型端（`mcp/uiSampling`）：一次性的回合外模型请求。
//!
//! 输入是页面给的消息（text / image）、系统提示与 `maxTokens`；输出是文本与停止原因。
//! 用注入的模型端口与会话的缺省模型选择（页面的 `modelPreferences` 不参与选择——Node 只把它
//! 原样交给模型适配器，本工程没有按偏好选模型的入口，如实不用而不是假装按偏好挑）。

use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use rust_cli_kernel_api::clock::{Clock, Ids};
use rust_cli_kernel_api::ids::{OwnerEpoch, SessionId};
use rust_cli_kernel_api::mcp_ui::{
    McpUiSamplingInput, McpUiSamplingPort, McpUiSamplingResult, SAMPLING_CANCELLED,
};
use rust_cli_kernel_api::message::{ContentBlock, ImageSource, StopReason, Usage};
use rust_cli_kernel_api::metering::{CallStatus, ModelCall};
use rust_cli_kernel_api::model::{
    ApiContent, ApiMessage, ApiRole, BlockDelta, ModelError, ModelEvent, ModelNotice, ModelPort,
    ModelRequest, ModelSelection, ModelStreamItem, QuerySource, RequestOptions, SystemBlock,
};
use rust_cli_kernel_api::store::{Fact, FactBatch, SessionStore};
use tokio_util::sync::CancellationToken;

use crate::table::OpenSessions;

/// 旁路请求的来源名（用量表与请求头用它；Node 的采样请求同属旁路）。
const SIDE_MCP_APP_SAMPLING: &str = "mcp_app_sampling";

pub(crate) struct KernelSampling {
    model: Arc<dyn ModelPort>,
    selection: ModelSelection,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    /// 会话表：回合外请求的用量行交给发起会话的 actor 提交（与主回合的 `model_usage` 同一条路径）。
    sessions: OpenSessions,
    /// 会话 actor 不在了（关闭收尾）时直接落库：Node 的 usage store 在关闭路径里仍可写。
    store: Arc<dyn SessionStore>,
}

impl KernelSampling {
    pub(crate) fn new(
        model: Arc<dyn ModelPort>,
        selection: ModelSelection,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn Ids>,
        sessions: OpenSessions,
        store: Arc<dyn SessionStore>,
    ) -> Self {
        Self {
            model,
            selection,
            clock,
            ids,
            sessions,
            store,
        }
    }

    /// 采样结束后的用量行（Node `sample-model.ts` 的 `finally` + `recordModelUsageFact`）：成功、失败与
    /// 取消都记。会话不在了（已关闭）时只记日志，不影响这次采样的结果。
    async fn record_usage(&self, session: &SessionId, call: ModelCall) {
        store_usage(&self.sessions, &self.store, session, call).await;
    }
}

/// 把一条采样用量行交给会话 actor（会话不在时只记日志）。
async fn store_usage(
    sessions: &OpenSessions,
    store: &Arc<dyn SessionStore>,
    session: &SessionId,
    call: ModelCall,
) {
    let handle = {
        let sessions = sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions.get(session).and_then(|slot| slot.open().cloned())
    };
    if let Some(handle) = handle {
        if let Err(error) = handle.record_usage(call).await {
            tracing::warn!(
                event = "usage.model.write.failed",
                session = session.as_str(),
                reason = %error,
                "the sampling usage was not stored"
            );
        }
        return;
    }
    // 会话在关（关闭路径先标记 Closing、actor 已经退出）或已不在本进程：Node 的 usage store 不属于
    // 会话 actor，关闭收尾里仍能写这一行。用量是观测，直接一批提交（没有消息、沿用库里的当前轮）。
    let batch = FactBatch {
        owner_epoch: OwnerEpoch::LOCAL,
        command: None,
        facts: vec![Fact::ModelCalled { call }],
        turn: None,
    };
    if let Err(error) = store.commit(session, batch).await {
        tracing::warn!(
            event = "usage.model.write.failed",
            session = session.as_str(),
            reason = %error,
            "the sampling usage was not stored"
        );
    }
}

/// 取消时补记用量行：`SamplingCalls::execute` 的 `tokio::select!` 在取消（页面取消、实例关闭、
/// 超时）时直接丢掉采样的 future，`sample()` 的收尾代码不会执行。这个守卫在 drop 时补记一条
/// `cancelled` 行，与 Node 的 `finally`（`signal.aborted` → `status: "cancelled"`）同义。
///
/// 取消时没有结果用量（Node 的 `result` 未定义，行里 token 列为空），所以守卫只需要请求前的快照。
struct CancelledUsage {
    sessions: OpenSessions,
    store: Arc<dyn SessionStore>,
    session: Option<SessionId>,
    clock: Arc<dyn Clock>,
    call: ModelCall,
    armed: bool,
}

impl CancelledUsage {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelledUsage {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let Some(session) = self.session.take() else {
            return;
        };
        let mut call = self.call.clone();
        call.completed_at_ms = self.clock.now_ms();
        call.status = CallStatus::Cancelled;
        let sessions = self.sessions.clone();
        let store = self.store.clone();
        // 收尾代码不能 await（future 正在被丢弃）；记账本身是观测，后台写，失败只记日志。
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        tokio::spawn(async move {
            store_usage(&sessions, &store, &session, call).await;
        });
    }
}

#[async_trait]
impl McpUiSamplingPort for KernelSampling {
    async fn sample(
        &self,
        request: McpUiSamplingInput,
        cancel: CancellationToken,
    ) -> Result<McpUiSamplingResult, String> {
        let mut messages = Vec::with_capacity(request.messages.len());
        for message in &request.messages {
            let role = match message.role.as_str() {
                "assistant" => ApiRole::Assistant,
                _ => ApiRole::User,
            };
            let content = message
                .content
                .iter()
                .map(|block| ApiContent {
                    block: match block {
                        rust_cli_kernel_api::mcp_ui::McpUiSamplingContent::Text { text } => {
                            ContentBlock::Text { text: text.clone() }
                        }
                        rust_cli_kernel_api::mcp_ui::McpUiSamplingContent::Image {
                            mime_type,
                            data,
                        } => ContentBlock::Image {
                            source: ImageSource::Base64 {
                                media_type: mime_type.clone(),
                                data: data.clone(),
                            },
                        },
                    },
                    cache_control: None,
                })
                .collect();
            messages.push(ApiMessage {
                role,
                content,
                output_config: None,
            });
        }
        // 采样前固定会话与选择：这次请求的用量行要挂到发起它的会话上，选择按请求时的快照
        // （Node 在第一个 await 前 `getSessionModelSelection()`，页面 hints 不改它）。
        let session = request.session.clone();
        let selection = request
            .selection
            .clone()
            .unwrap_or_else(|| self.selection.clone());
        let started_at_ms = self.clock.now_ms();
        let message = self.ids.message();
        let source = QuerySource::Side(SIDE_MCP_APP_SAMPLING.to_owned());
        let call_selection = selection.clone();
        let request = ModelRequest {
            selection,
            system: request
                .system_prompt
                .map(|text| {
                    vec![SystemBlock {
                        text,
                        cache_control: None,
                    }]
                })
                .unwrap_or_default(),
            messages,
            tools: Vec::new(),
            tool_choice: None,
            max_tokens: request.max_tokens,
            thinking: None,
            temperature: None,
            betas: Vec::new(),
            source: source.clone(),
            // Provider 补丁的输出上限要跟随页面给的 `maxTokens`；不给时目录模型会按自己的上限
            // 改写 `max_tokens`（Node 是 `Math.min(params.maxTokens, model.max)`）。
            options: RequestOptions {
                provider_max_output_tokens: Some(request.max_tokens),
                ..Default::default()
            },
        };
        // 取消时补记：`SamplingCalls` 的 select 会直接丢掉这个 future（见 [`CancelledUsage`]）。
        let mut cancelled = CancelledUsage {
            sessions: self.sessions.clone(),
            store: self.store.clone(),
            session: session.clone(),
            clock: self.clock.clone(),
            call: ModelCall {
                message: message.clone(),
                source: source.clone(),
                selection: call_selection.clone(),
                started_at_ms,
                first_token_at_ms: None,
                first_content_at_ms: None,
                completed_at_ms: started_at_ms,
                status: CallStatus::Cancelled,
                stop_reason: None,
                tool_calls: 0,
                usage: None,
                retries: 0,
                error: None,
            },
            armed: true,
        };
        let mut stream = self.model.stream_with_notices(request, cancel.clone());
        let mut model = String::new();
        let mut text = String::new();
        let mut stop_reason = None;
        let mut usage = Usage::default();
        let mut first_token_at_ms = None;
        let mut retries = 0;
        let mut status = CallStatus::Completed;
        let mut error = None;
        while let Some(item) = stream.next().await {
            match item {
                Ok(ModelStreamItem::Event(ModelEvent::MessageStart {
                    model: name,
                    usage: reported,
                    ..
                })) => {
                    model = name;
                    usage = reported;
                }
                Ok(ModelStreamItem::Event(ModelEvent::BlockDelta {
                    delta: BlockDelta::Text(chunk),
                    ..
                })) => {
                    // 用量表的首字（Node `firstModelTokenAt`）：第一个非空的文本增量。
                    if first_token_at_ms.is_none() && !chunk.is_empty() {
                        first_token_at_ms = Some(self.clock.now_ms());
                    }
                    text.push_str(&chunk);
                }
                Ok(ModelStreamItem::Event(ModelEvent::MessageDelta {
                    stop_reason: reason,
                    usage: reported,
                })) => {
                    if reason.is_some() {
                        stop_reason = reason;
                    }
                    // 与主循环的组装器同一口径（query.md §1.10）：适配器合并好的累计用量整体采用。
                    usage = reported;
                }
                Ok(ModelStreamItem::Event(_)) => {}
                // 适配器内部的重试算在这次调用里（Node `retry_count`）。
                Ok(ModelStreamItem::Notice(ModelNotice::Retrying { .. })) => retries += 1,
                Ok(ModelStreamItem::Notice(_) | ModelStreamItem::Status(_)) => {}
                Err(ModelError::Cancelled) => {
                    status = CallStatus::Cancelled;
                    break;
                }
                Err(caught) => {
                    // 失败与中断时只有已经报告的用量（Node 用失败事件里的用量）。
                    status = CallStatus::Error;
                    error = Some(caught);
                    break;
                }
            }
        }
        // 取消令牌已经拉下的（实例关闭、连接断开）按取消记，即使流正常收尾。
        if status == CallStatus::Completed && cancel.is_cancelled() {
            status = CallStatus::Cancelled;
        }
        // 回合外请求的用量行（Node `recordModelUsageFact`）：与主回合同一条 `model_usage` 路径，
        // 会话 actor 是唯一写者。签名里没有会话（模型端单测）时只做请求。
        cancelled.disarm();
        if let Some(session) = session {
            let call = ModelCall {
                message,
                source,
                selection: call_selection,
                started_at_ms,
                first_token_at_ms,
                first_content_at_ms: first_token_at_ms,
                completed_at_ms: self.clock.now_ms(),
                status,
                stop_reason,
                tool_calls: 0,
                usage: Some(usage).filter(|usage| *usage != Usage::default()),
                retries,
                error: error.clone(),
            };
            self.record_usage(&session, call).await;
        }
        // MCP Apps 的 `stopReason` 是 camelCase（Node 的 finishReason 映射：stop→endTurn、
        // length→maxTokens）；`StopReason` 的 serde 是 snake_case，不能直接透传。
        let stop_reason = match stop_reason.unwrap_or(StopReason::EndTurn) {
            StopReason::EndTurn => "endTurn",
            StopReason::MaxTokens | StopReason::ModelContextWindowExceeded => "maxTokens",
            StopReason::StopSequence => "stopSequence",
            StopReason::ToolUse => "toolUse",
            StopReason::PauseTurn => "pauseTurn",
            StopReason::Refusal => "refusal",
            StopReason::Unknown => "endTurn",
        };
        match status {
            CallStatus::Completed => Ok(McpUiSamplingResult {
                model,
                text,
                stop_reason: stop_reason.to_owned(),
            }),
            CallStatus::Cancelled => Err(SAMPLING_CANCELLED.to_owned()),
            CallStatus::Error => Err(error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "model request failed".to_owned())),
        }
    }
}

#[cfg(test)]
#[path = "sampling_tests.rs"]
mod tests;

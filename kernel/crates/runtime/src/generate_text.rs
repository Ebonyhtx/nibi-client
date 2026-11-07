//! 无会话的一次性模型补全（NIBI `workspace/generateText`）的运行时实现。
//!
//! 语义见 [`nibi_kernel_api::generate_text`]；这里只做三件事：按用途解析「辅助档」的选择与预算、
//! 把请求交给模型端口、把流组装成正文/工具调用/用量。取消令牌由协议层按 `operationId` 持有。

use std::time::Duration;

use futures_util::StreamExt;
use nibi_kernel_api::generate_text::{GenerateTextReply, GenerateTextRequest, GeneratedToolCall};
use nibi_kernel_api::message::{ContentBlock, StopReason, Usage};
use nibi_kernel_api::model::{
    BlockDelta, ModelError, ModelEvent, ModelRequest, ModelSelection, ModelStreamItem,
    RequestOptions,
};
use nibi_kernel_api::session_api::KernelError;
use tokio_util::sync::CancellationToken;

use crate::LocalKernel;

/// Node `WORKSPACE_GENERATE_TEXT_TIMEOUT_MS`。
const TIMEOUT: Duration = Duration::from_secs(60);
/// Node `AUXILIARY_MAX_OUTPUT_TOKENS`。
const AUXILIARY_MAX_OUTPUT_TOKENS: u32 = 5_000;
/// Node 的 git 提交信息用途名（`GIT_COMMIT_MESSAGE_QUERY_SOURCE`）。
const GIT_COMMIT_MESSAGE: &str = "git_commit_message";

pub(crate) async fn run(
    kernel: &LocalKernel,
    request: GenerateTextRequest,
    cancel: CancellationToken,
) -> Result<GenerateTextReply, KernelError> {
    let (selection, max_tokens) = resolve_options(kernel, &request).await;
    let model_request = ModelRequest {
        selection: selection.clone(),
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        tool_choice: request.tool_choice,
        max_tokens,
        thinking: None,
        temperature: None,
        betas: Vec::new(),
        source: request.source,
        // Provider 补丁以请求自己的上限改写 max_tokens：把同一个值交给它（与标题请求同一条纪律）。
        options: RequestOptions {
            provider_max_output_tokens: Some(max_tokens),
            ..RequestOptions::default()
        },
    };
    let mut reply = Reply::default();
    let collect = async {
        let mut stream = kernel
            .ports()
            .model
            .stream_with_notices(model_request, cancel.clone());
        while let Some(item) = stream.next().await {
            reply.push(item?)?;
        }
        Ok::<(), ModelError>(())
    };
    match tokio::time::timeout(TIMEOUT, collect).await {
        Ok(Ok(())) => Ok(GenerateTextReply {
            text: reply.text,
            tool_calls: reply.tool_calls,
            stop_reason: reply.stop_reason,
            usage: reply.usage,
            selection,
        }),
        Ok(Err(error)) => Err(KernelError::Failed {
            message: error.to_string(),
        }),
        // 超时不是模型错误：取消请求，回一个稳定的失败文案（Node 侧是 AbortError）。
        Err(_) => {
            cancel.cancel();
            Err(KernelError::Failed {
                message: "workspace generate text timed out".to_owned(),
            })
        }
    }
}

/// 生效的选择与预算。
///
/// `git_commit_message` 走辅助档（Node `auxiliaryModelOptions`）：推理档位取目录里的第一档、
/// 输出上限 `min(5000, 模型上限)`，**忽略**调用方给的上限；其它用途用调用方的值，缺省回落到
/// 模型卡片的输出上限、再退 5000。
async fn resolve_options(
    kernel: &LocalKernel,
    request: &GenerateTextRequest,
) -> (ModelSelection, u32) {
    let card = match kernel.model_directory() {
        Some(directory) => {
            let catalog = directory.catalog().await;
            catalog
                .models
                .iter()
                .find(|card| card.provider == request.selection.provider && card.model == request.selection.model)
                .map(|card| (card.reasoning_levels.first().cloned(), card.max_output_tokens))
        }
        None => None,
    };
    resolve_from_card(
        request.selection.clone(),
        request.source.node_name().as_str(),
        request.max_tokens,
        card,
    )
}

/// 纯规则部分（可单测）：`git_commit_message` 走辅助档——最低推理档 + `min(5000, 模型上限)`，
/// 忽略调用方预算；其它用途用调用方预算，缺省回落到模型上限、再退 5000。
fn resolve_from_card(
    mut selection: ModelSelection,
    query_source: &str,
    requested_max_tokens: Option<u32>,
    card: Option<(Option<String>, u64)>,
) -> (ModelSelection, u32) {
    let (lowest_level, card_max) = card.unwrap_or((None, 0));
    let card_max = if card_max > 0 {
        Some(u32::try_from(card_max).unwrap_or(u32::MAX))
    } else {
        None
    };
    if query_source == GIT_COMMIT_MESSAGE {
        if let Some(level) = lowest_level {
            selection.reasoning = Some(level);
        }
        let max_tokens = card_max
            .map(|limit| limit.min(AUXILIARY_MAX_OUTPUT_TOKENS))
            .unwrap_or(AUXILIARY_MAX_OUTPUT_TOKENS);
        (selection, max_tokens)
    } else {
        (
            selection,
            requested_max_tokens
                .or(card_max)
                .unwrap_or(AUXILIARY_MAX_OUTPUT_TOKENS),
        )
    }
}

/// 流里收集到的回复。
#[derive(Default)]
struct Reply {
    text: String,
    tool_calls: Vec<GeneratedToolCall>,
    stop_reason: Option<StopReason>,
    usage: Usage,
    /// 正在生成的 tool_use 块（`input_json_delta` 在结束时才拼成 JSON）。
    pending: Option<PendingToolCall>,
}

struct PendingToolCall {
    index: usize,
    id: String,
    name: String,
    input: serde_json::Value,
    json: String,
}

impl Reply {
    fn push(&mut self, item: ModelStreamItem) -> Result<(), ModelError> {
        let ModelStreamItem::Event(event) = item else {
            // 重试等通知不改变结果。
            return Ok(());
        };
        match event {
            ModelEvent::MessageStart { usage, .. } => self.usage = usage,
            ModelEvent::BlockStart { index, block } => match block {
                ContentBlock::Text { text } => self.text.push_str(&text),
                ContentBlock::ToolUse { id, name, input } => {
                    self.pending = Some(PendingToolCall {
                        index,
                        id: id.as_str().to_owned(),
                        name,
                        input,
                        json: String::new(),
                    });
                }
                _ => {}
            },
            ModelEvent::BlockDelta { index, delta } => match delta {
                BlockDelta::Text(text) => self.text.push_str(&text),
                BlockDelta::InputJson(more) => {
                    if let Some(pending) = self.pending.as_mut().filter(|p| p.index == index) {
                        pending.json.push_str(&more);
                    }
                }
                BlockDelta::Thinking(_) | BlockDelta::Signature(_) => {}
            },
            ModelEvent::BlockStop { index } => {
                if let Some(pending) = self.pending.take().filter(|p| p.index == index) {
                    let input = if pending.json.is_empty() {
                        // 适配器可能直接在 BlockStart 里给完整 input（非流式片段）。
                        pending.input
                    } else {
                        serde_json::from_str(&pending.json).map_err(|error| ModelError::Protocol {
                            message: format!("tool input is not valid json: {error}"),
                        })?
                    };
                    self.tool_calls.push(GeneratedToolCall {
                        id: pending.id,
                        name: pending.name,
                        input,
                    });
                }
            }
            ModelEvent::MessageDelta { stop_reason, usage } => {
                self.stop_reason = stop_reason.or(self.stop_reason);
                // `message_delta` 的用量是适配器合并好的累计值，整体采用（同主循环的组装器）。
                self.usage = usage;
            }
            ModelEvent::MessageStop => {}
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "generate_text_tests.rs"]
mod tests;

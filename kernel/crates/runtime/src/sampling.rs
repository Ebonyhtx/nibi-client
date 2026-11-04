//! MCP Apps 采样的模型端（`mcp/uiSampling`）：一次性的回合外模型请求。
//!
//! 输入是页面给的消息（text / image）、系统提示与 `maxTokens`；输出是文本与停止原因。
//! 用注入的模型端口与会话的缺省模型选择（页面的 `modelPreferences` 不参与选择——Node 只把它
//! 原样交给模型适配器，本工程没有按偏好选模型的入口，如实不用而不是假装按偏好挑）。

use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use rust_cli_kernel_api::mcp_ui::{
    McpUiSamplingInput, McpUiSamplingPort, McpUiSamplingResult, SAMPLING_CANCELLED,
};
use rust_cli_kernel_api::message::{ContentBlock, ImageSource, StopReason};
use rust_cli_kernel_api::model::{
    ApiContent, ApiMessage, ApiRole, BlockDelta, ModelError, ModelEvent, ModelPort, ModelRequest,
    ModelSelection, QuerySource, SystemBlock,
};
use tokio_util::sync::CancellationToken;

/// 旁路请求的来源名（用量表与请求头用它；Node 的采样请求同属旁路）。
const SIDE_MCP_APP_SAMPLING: &str = "mcp_app_sampling";

pub(crate) struct KernelSampling {
    model: Arc<dyn ModelPort>,
    selection: ModelSelection,
}

impl KernelSampling {
    pub(crate) fn new(model: Arc<dyn ModelPort>, selection: ModelSelection) -> Self {
        Self { model, selection }
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
        let request = ModelRequest {
            selection: request.selection.unwrap_or_else(|| self.selection.clone()),
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
            source: QuerySource::Side(SIDE_MCP_APP_SAMPLING.to_owned()),
            options: Default::default(),
        };
        let mut stream = self.model.stream(request, cancel);
        let mut model = String::new();
        let mut text = String::new();
        let mut stop_reason = None;
        while let Some(item) = stream.next().await {
            match item {
                Ok(ModelEvent::MessageStart { model: name, .. }) => model = name,
                Ok(ModelEvent::BlockDelta {
                    delta: BlockDelta::Text(chunk),
                    ..
                }) => text.push_str(&chunk),
                Ok(ModelEvent::MessageDelta {
                    stop_reason: reason,
                    ..
                }) => {
                    if reason.is_some() {
                        stop_reason = reason;
                    }
                }
                Ok(_) => {}
                Err(ModelError::Cancelled) => return Err(SAMPLING_CANCELLED.to_owned()),
                Err(error) => return Err(error.to_string()),
            }
        }
        let stop_reason = stop_reason.unwrap_or(StopReason::EndTurn);
        let stop_reason = serde_json::to_value(stop_reason)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "end_turn".to_owned());
        Ok(McpUiSamplingResult {
            model,
            text,
            stop_reason,
        })
    }
}

#[cfg(test)]
#[path = "sampling_tests.rs"]
mod tests;

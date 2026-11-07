//! `provider/testModelConnectivity`（Host 设置页的「测试连通性」，Node
//! `testModelConnectivity`）。
//!
//! 一次最小的模型请求：固定 prompt、`maxOutputTokens: 1`、用途名 `provider_settings_connectivity`。
//! 成功回 `{success: true}`，失败按内核错误回报（Host 直接显示原因）。探测不带会话、不写用量。

use nibi_kernel_api::abort::Abort;
use nibi_kernel_api::generate_text::GenerateTextRequest;
use nibi_kernel_api::message::ContentBlock;
use nibi_kernel_api::model::{ApiContent, ApiMessage, ApiRole, QuerySource, SystemBlock};
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::commands;
use crate::server::{Server, kernel_error};

/// Node 的固定探测内容（不可改写角色、文本或混入会话历史）。
const PROBE_SYSTEM: &str = "You are NIBI connectivity probe.";
const PROBE_USER: &str = "hi";
const QUERY_SOURCE: &str = "provider_settings_connectivity";

pub async fn test(server: &Server, params: &Value) -> Result<Value, RpcError> {
    // `workspace` 是 Host 的必填项（`zcodeProviderTestModelConnectivityParamsSchema`），
    // 探测本身不带会话，这里只校验形状。
    if params["workspace"].as_object().is_none() {
        return Err(RpcError::invalid_params("workspace is required"));
    }
    let selection = commands::selection(&params["selection"])
        .ok_or_else(|| RpcError::invalid_params("selection requires providerId and modelId"))?;
    let request = GenerateTextRequest {
        selection,
        system: vec![SystemBlock {
            text: PROBE_SYSTEM.to_owned(),
            cache_control: None,
        }],
        messages: vec![ApiMessage {
            role: ApiRole::User,
            content: vec![ApiContent {
                block: ContentBlock::Text {
                    text: PROBE_USER.to_owned(),
                },
                cache_control: None,
            }],
            output_config: None,
        }],
        tools: Vec::new(),
        tool_choice: None,
        max_tokens: Some(1),
        source: QuerySource::Side(QUERY_SOURCE.to_owned()),
    };
    let cancel = Abort::new();
    server
        .kernel
        .generate_text(request, cancel.token().clone())
        .await
        .map_err(|error| kernel_error(&error))?;
    Ok(json!({"success": true}))
}

#[cfg(test)]
#[path = "model_connectivity_tests.rs"]
mod tests;

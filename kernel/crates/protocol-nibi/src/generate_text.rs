//! `workspace/generateText` / `workspace/cancelGenerateText`（旧入口 141 F5）。
//!
//! Host 的「生成提交信息」（`GitActionMenu` → `gitCommitMessageGenerator` → `zcodeAgentService`）
//! 用它做一次无会话补全。这里只做协议面：参数 → [`GenerateTextRequest`]，结果 → NIBI 的形状；
//! 选择与预算的「辅助档」规则在内核（`runtime::generate_text`）。
//!
//! 容器语义对齐 Node `nibi-protocol/server.ts` 的 `withWorkspaceGenerateTextSignal`：
//! `operationId` 在活跃期间必须唯一（重复 → `-32600`），`cancelGenerateText` 只中止对应那条链路，
//! 未知或已结束的 id 回 `{cancelled:false}`。

use nibi_kernel_api::generate_text::GenerateTextRequest;
use nibi_kernel_api::ids::ToolUseId;
use nibi_kernel_api::message::{ContentBlock, ToolResultContent, Usage};
use nibi_kernel_api::model::{ApiContent, ApiMessage, ApiRole, SystemBlock, ToolDefinition};
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use nibi_kernel_api::abort::{Abort, AbortReason};

use crate::commands;
use crate::server::{Server, kernel_error};

/// Node `zcodeWorkspaceGenerateTextParamsSchema` 的必填项之一。
fn require_non_empty<'a>(params: &'a Value, field: &'a str) -> Result<&'a str, RpcError> {
    params[field]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| RpcError::invalid_params(format!("{field} is required")))
}

fn optional_non_empty<'a>(params: &'a Value, field: &str) -> Option<&'a str> {
    params[field]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

pub async fn generate(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let request = request_from_params(params)?;
    let operation_id = optional_non_empty(params, "operationId").map(str::to_owned);
    let cancel = Abort::new();
    if let Some(id) = &operation_id {
        let mut active = server
            .generate_operations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if active.contains_key(id) {
            // 重复 operationId 会覆盖首个请求的令牌，首个请求就失去取消能力（Node 同一判据）。
            return Err(RpcError::new(
                -32600,
                format!("Workspace generate operation is already active: {id}"),
            ));
        }
        active.insert(id.clone(), cancel.clone());
    }
    let outcome = server
        .kernel
        .generate_text(request, cancel.token().clone())
        .await;
    if let Some(id) = &operation_id {
        let mut active = server
            .generate_operations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // 同 id 的下一次请求只可能在本条移除之后才登记（重复登记会被上面挡下），所以这里直接移除
        // 不会误删别人的令牌。
        active.remove(id);
    }
    let reply = outcome.map_err(|error| kernel_error(&error))?;
    // NIBI 的选择形状（`modelSelectionSchema`）：把内核的 provider/model/reasoning 映射回去。
    let mut selection = json!({
        "providerId": reply.selection.provider,
        "modelId": reply.selection.model,
    });
    if let Some(level) = &reply.selection.reasoning {
        selection["options"] = json!({"reasoningLevel": level});
    }
    let mut result = json!({"text": reply.text, "selection": selection});
    if let Some(reason) = reply.stop_reason {
        result["finishReason"] = serde_json::to_value(reason).unwrap_or(Value::Null);
    }
    if reply.usage != Usage::default() {
        result["usage"] = usage_json(reply.usage);
    }
    if !reply.tool_calls.is_empty() {
        result["toolCalls"] = Value::Array(
            reply
                .tool_calls
                .into_iter()
                .map(|call| json!({"id": call.id, "name": call.name, "input": call.input}))
                .collect(),
        );
    }
    Ok(result)
}

pub fn cancel(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let operation_id = require_non_empty(params, "operationId")?.to_owned();
    let token = server
        .generate_operations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&operation_id);
    let cancelled = token.is_some();
    if let Some(token) = token {
        token.abort(AbortReason::User);
    }
    Ok(json!({"operationId": operation_id, "cancelled": cancelled}))
}

fn request_from_params(params: &Value) -> Result<GenerateTextRequest, RpcError> {
    let selection = commands::selection(&params["selection"])
        .ok_or_else(|| RpcError::invalid_params("selection requires providerId and modelId"))?;
    let query_source = require_non_empty(params, "querySource")?;
    let prompt = params["prompt"].as_str().unwrap_or_default().trim();
    let messages = params["messages"].as_array();
    if prompt.is_empty() && messages.is_none_or(Vec::is_empty) {
        return Err(RpcError::invalid_params(
            "prompt or messages is required",
        ));
    }
    let mut system = Vec::new();
    let mut api_messages = Vec::new();
    match messages {
        Some(list) => {
            for message in list {
                match message["role"].as_str().unwrap_or_default() {
                    "system" => system.push(SystemBlock {
                        text: message["content"].as_str().unwrap_or_default().to_owned(),
                        cache_control: None,
                    }),
                    "user" => api_messages.push(text_message(
                        ApiRole::User,
                        message["content"].as_str().unwrap_or_default(),
                    )),
                    "assistant" => {
                        let mut content = vec![text_block(message["content"].as_str().unwrap_or_default())];
                        for call in message["toolCalls"].as_array().into_iter().flatten() {
                            let id = call["id"].as_str().unwrap_or_default();
                            let name = call["name"].as_str().unwrap_or_default();
                            if id.is_empty() || name.is_empty() {
                                return Err(RpcError::invalid_params(
                                    "assistant toolCalls require id and name",
                                ));
                            }
                            content.push(ApiContent {
                                block: ContentBlock::ToolUse {
                                    id: ToolUseId::new(id),
                                    name: name.to_owned(),
                                    input: call["input"].clone(),
                                },
                                cache_control: None,
                            });
                        }
                        api_messages.push(ApiMessage {
                            role: ApiRole::Assistant,
                            content,
                            output_config: None,
                        });
                    }
                    "tool" => {
                        let tool_use_id = require_str(message, "toolCallId")?;
                        let _ = require_str(message, "toolName")?; // 形状校验：Node schema 里是必填。
                        api_messages.push(ApiMessage {
                            role: ApiRole::User,
                            content: vec![ApiContent {
                                block: ContentBlock::ToolResult {
                                    tool_use_id: ToolUseId::new(tool_use_id),
                                    content: vec![ToolResultContent::Text {
                                        text: message["content"]
                                            .as_str()
                                            .unwrap_or_default()
                                            .to_owned(),
                                    }],
                                    is_error: message["isError"].as_bool().unwrap_or(false),
                                },
                                cache_control: None,
                            }],
                            output_config: None,
                        });
                    }
                    other => {
                        return Err(RpcError::invalid_params(format!(
                            "unsupported message role: {other}"
                        )));
                    }
                }
            }
        }
        None => api_messages.push(text_message(ApiRole::User, prompt)),
    }
    let tools = params["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| {
            let name = tool["name"]
                .as_str()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| RpcError::invalid_params("tool requires name"))?;
            Ok(ToolDefinition {
                name: name.to_owned(),
                description: tool["description"].as_str().unwrap_or_default().to_owned(),
                input_schema: tool["inputSchema"].clone(),
                cache_control: None,
            })
        })
        .collect::<Result<Vec<_>, RpcError>>()?;
    Ok(GenerateTextRequest {
        selection,
        system,
        messages: api_messages,
        tools,
        tool_choice: None,
        max_tokens: params["maxOutputTokens"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok()),
        // NIBI 的用途名（`git_commit_message` 等）走进内核的旁路来源；`node_name()` 原样带回。
        source: nibi_kernel_api::model::QuerySource::Side(query_source.to_owned()),
    })
}

fn require_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, RpcError> {
    value[field]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| RpcError::invalid_params(format!("{field} is required")))
}

fn text_block(text: &str) -> ApiContent {
    ApiContent {
        block: ContentBlock::Text {
            text: text.to_owned(),
        },
        cache_control: None,
    }
}

fn text_message(role: ApiRole, text: &str) -> ApiMessage {
    ApiMessage {
        role,
        content: vec![text_block(text)],
        output_config: None,
    }
}

fn usage_json(usage: Usage) -> Value {
    json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "totalTokens": usage.input_tokens + usage.output_tokens,
        "cacheReadTokens": usage.cache_read_input_tokens,
        "cacheWriteTokens": usage.cache_creation_input_tokens,
    })
}

#[cfg(test)]
#[path = "generate_text_tests.rs"]
mod generate_text_tests;

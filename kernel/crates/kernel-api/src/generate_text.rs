//! 无会话的一次性模型补全（NIBI `workspace/generateText` / `workspace/cancelGenerateText`）。
//!
//! Host 目前只在「生成提交信息」时用它（`GitActionMenu` → `gitService.generateCommitMessage`
//! → `nibiAgentService.ts` 的 `workspace/generateText`）。语义对齐 Node
//! `core/src/runtime/methods/workspace-generate-text.ts`：
//!
//! - `querySource == "git_commit_message"` 走**辅助档**：推理档位取模型目录的第一档，输出上限
//!   `min(5000, 模型上限)`，并忽略调用方给的 `maxOutputTokens`（Node 那里也丢弃它）；
//! - 其它来源用调用方给的预算（没给时同样回落到 5000）；
//! - 请求期限 60 秒（Node `WORKSPACE_GENERATE_TEXT_TIMEOUT_MS`）；
//! - 取消按 `operationId`：协议层持有取消令牌，`cancelGenerateText` 触发它。
//!
//! 与 Node 的一个已知差异：这一笔**不进会话用量**——Node 记的是 detached workspace 事实，
//! 内核没有对应的表；影响仅限「提交信息生成的 token 不计入统计」。

use serde_json::Value;

use crate::message::{StopReason, Usage};
use crate::model::{ApiMessage, ModelSelection, QuerySource, SystemBlock, ToolChoice, ToolDefinition};

/// 一次补全请求。`system` 与 `messages` 已经由协议层从 NIBI 的 role/content 形状映射好。
#[derive(Debug, Clone)]
pub struct GenerateTextRequest {
    pub selection: ModelSelection,
    /// Node 的 messages 里可以带 system：协议层把 role=system 的消息提升到这里。
    pub system: Vec<SystemBlock>,
    pub messages: Vec<ApiMessage>,
    pub tools: Vec<ToolDefinition>,
    pub tool_choice: Option<ToolChoice>,
    /// 调用方给的上限；None 时按辅助档的 5000。
    pub max_tokens: Option<u32>,
    pub source: QuerySource,
}

/// 补全结果：正文、工具调用、结束原因、用量，以及**实际生效**的选择（辅助档可能改过推理档位）。
#[derive(Debug, Clone)]
pub struct GenerateTextReply {
    pub text: String,
    pub tool_calls: Vec<GeneratedToolCall>,
    pub stop_reason: Option<StopReason>,
    pub usage: Usage,
    pub selection: ModelSelection,
}

/// 模型发起的一次工具调用（NIBI `nibiWorkspaceModelToolCallSchema` 的形状）。
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

//! 话题（bot 群）资源与跨会话读面的端口（Node `topic-resource.port.ts` 与 `sessionStore` 的镜像）。
//!
//! Node 的 `ReadSessionContext` / `ReplyToChannel` 两个工具都读一份「会话的持久化消息 + 每条输入的规范
//! 意图」：前者取上下文与话题里被引用的附件，后者把回复绑定到发起这次工具调用的那条输入。
//! Rust 里这两件事都由端口提供：
//!
//! - [`SessionReads`]：读某个会话的消息与意图（实现是会话存储，冷读，不启动 actor）；
//! - [`TopicPort`]：Host 才有的两件事——按消息/资源序号取回话题附件（`topic/resource/read`），
//!   以及带原生 @ 的回复（`bot/channel/reply`）。
//!
//! 端口都返回 `String` 错误：它们的失败文本会原样进工具结果（Node 同样把 Host 的错误文字交给模型）。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{MessageId, SessionId};
use crate::message::Message;

/// 一次话题附件读取（Node `zcodeTopicResourceReadParamsSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicResourceRead {
    /// Host 侧的取消键（`topic/resource/cancel` 用同一个）。
    pub request_id: String,
    pub task_id: String,
    /// 发起这条输入的命令 id（Node 的 `inputId`：只允许读已准入的那条输入）。
    pub input_id: String,
    pub authorization_id: String,
    pub message_id: String,
    pub resource_index: u64,
}

/// Host 取回的附件（Node `zcodeTopicResourceReadResultSchema` + 工具后续把它写成本地文件）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicResource {
    /// 可读的 artifact 引用（`nibi-artifact://…`）。
    pub reference: String,
    pub file_name: String,
    pub mime: String,
    pub bytes: u64,
}

/// 一个会话的冷读面：消息与每条输入的规范意图。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub messages: Vec<Message>,
    /// user 消息 id → 那条输入的 canonical intent（`conversation_intent::canonical` 的形状）。
    #[serde(default)]
    pub intents: Vec<(MessageId, Value)>,
}

/// 读其他（或当前）会话的持久化历史。工具拿不到会话 actor，统一走它。
#[async_trait]
pub trait SessionReads: Send + Sync {
    async fn snapshot(&self, session: &SessionId) -> Result<SessionSnapshot, String>;
}

/// Host 提供的话题能力。缺席时 `ReplyToChannel` 与话题附件读取按 Node 的
/// "Channel reply is unavailable" / "Topic attachment retrieval is unavailable" 失败。
#[async_trait]
pub trait TopicPort: Send + Sync {
    /// `topic/resource/read`：授权并按消息/资源序号取附件。调用方放弃时用 [`Self::cancel`]。
    async fn read(&self, request: &TopicResourceRead) -> Result<TopicResource, String>;

    /// `topic/resource/cancel`：读取被放弃（模型请求被取消）时告诉 Host 释放队列。
    async fn cancel(&self, request_id: &str, task_id: &str);

    /// `bot/channel/reply`：带原生 @ 的回复。请求是 Node `channelReplyRequestSchema` 的形状
    /// （`taskId` / `inputId` / `toolCallId` / `parts`），结果原样交回工具。
    async fn reply(&self, request: Value) -> Result<Value, String>;
}

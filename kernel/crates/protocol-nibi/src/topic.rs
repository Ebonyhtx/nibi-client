//! Host 提供的话题能力（端口实现在 `kernel-api::topic`）。
//!
//! - `topic/resource/read`：按消息/资源序号取回话题附件，Host 负责授权与下载，返回可读的
//!   artifact 引用；模型请求被放弃时用 `topic/resource/cancel` 告诉 Host 释放队列。
//! - `bot/channel/reply`：带原生 @ 的回复（Host 解析候选与送达）。
//!
//! 两条都是反向请求，与 Node 的 `topic-resource.port.ts` 同一个方法名与同一个超时
//! （读取 120 s、回复 60 s）。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_api::topic::{TopicPort, TopicResource, TopicResourceRead};
use serde_json::{Value, json};

use crate::context::Context;

pub const TOPIC_READ: &str = "topic/resource/read";
pub const TOPIC_CANCEL: &str = "topic/resource/cancel";
pub const CHANNEL_REPLY: &str = "bot/channel/reply";

/// Node `RESOURCE_TIMEOUT_MS`：Host 的授权、下载与上传都在这一段里。
const READ_LIMIT: Duration = Duration::from_secs(120);
/// Node `reply` 的 `timeoutMs`。
const REPLY_LIMIT: Duration = Duration::from_secs(60);

pub struct HostTopic {
    context: Arc<Context>,
}

impl HostTopic {
    pub fn new(context: Arc<Context>) -> Self {
        Self { context }
    }
}

#[async_trait]
impl TopicPort for HostTopic {
    async fn read(&self, request: &TopicResourceRead) -> Result<TopicResource, String> {
        let params = json!({
            "requestId": request.request_id,
            "taskId": request.task_id,
            "inputId": request.input_id,
            "authorizationId": request.authorization_id,
            "messageId": request.message_id,
            "resourceIndex": request.resource_index,
        });
        let answer =
            match tokio::time::timeout(READ_LIMIT, self.context.peer.request(TOPIC_READ, &params))
                .await
            {
                Err(_) => return Err("Topic resource request timed out".to_owned()),
                Ok(result) => result.map_err(|error| error.message)?,
            };
        let reference = answer["ref"]
            .as_str()
            .ok_or_else(|| "Topic resource reply has no reference".to_owned())?;
        Ok(TopicResource {
            reference: reference.to_owned(),
            file_name: answer["fileName"]
                .as_str()
                .unwrap_or("attachment")
                .to_owned(),
            mime: answer["mime"]
                .as_str()
                .unwrap_or("application/octet-stream")
                .to_owned(),
            bytes: answer["bytes"].as_u64().unwrap_or_default(),
        })
    }

    async fn cancel(&self, request_id: &str, task_id: &str) {
        // 尽力而为：连接断了也照样放弃这次读取（Node 的 cancel 同一姿态）。
        let _ = self
            .context
            .notify(
                TOPIC_CANCEL,
                &json!({"requestId": request_id, "taskId": task_id}),
            )
            .await;
    }

    async fn reply(&self, request: Value) -> Result<Value, String> {
        match tokio::time::timeout(
            REPLY_LIMIT,
            self.context.peer.request(CHANNEL_REPLY, &request),
        )
        .await
        {
            Err(_) => Err("Channel reply timed out".to_owned()),
            Ok(result) => result.map_err(|error| error.message),
        }
    }
}

//! 话题（bot 群）的两个工具：`ReadTopicResource` 与 `ReplyToChannel`（Node 同名工具）。
//!
//! 两者都读「持久化消息 + 每条输入的规范意图」：
//! - `ReadTopicResource`：只读当前会话已接纳话题快照里的资源（Node 的 `ReadTopicResource`，
//!   原 `ReadSessionContext(topic, attachment)` 的唯一后继），把 Host 取回的附件物化成会话 artifact
//!   （模型随后用 Read 读 `nibi-artifact://…`）；
//! - `ReplyToChannel`：把一次带原生 @ 的回复绑定到发起这次工具调用的那条输入，交给 Host 发送。
//!
//! 跨会话历史读取不再是本模块的职责：会话工具 `ReadSession(view=messages)` 是唯一入口。

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::ids::{MessageId, SessionId};
use nibi_kernel_api::message::{ContentBlock, Message, ToolResultContent, UserOrigin};
use nibi_kernel_api::store::ArtifactPurpose;
use nibi_kernel_api::tool::{Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext};
use nibi_kernel_api::topic::{SessionReads, SessionSnapshot, TopicPort, TopicResourceRead};
use serde_json::{Value, json};
use tokio::sync::mpsc;

pub const READ_TOPIC_RESOURCE: &str = "ReadTopicResource";
pub const REPLY_TO_CHANNEL: &str = "ReplyToChannel";

/// Node `MAX_MODEL_BYTES`：ReadTopicResource 的模型侧结果预算。
const READ_TOPIC_RESOURCE_MAX_CHARS: usize = 4_096;
/// Node `PROTOCOL_V4_LIMITS.attachmentMaxBytes`：单个话题附件的上限。
const TOPIC_ATTACHMENT_MAX_BYTES: u64 = 20 * 1024 * 1024;

fn text(output: &str) -> ToolOutput {
    ToolOutput {
        content: vec![ToolResultContent::Text {
            text: output.to_owned(),
        }],
        is_error: false,
        display: Value::Null,
    }
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed {
        message: message.into(),
    }
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::InvalidInput {
        message: message.into(),
    }
}

/// Node `z.string().min(1).max(256)` 的同一条边界（按字符计，足够覆盖 wire 上的 id）。
fn bounded_id(
    value: Option<&Value>,
    field: &str,
    required: bool,
) -> Result<Option<String>, ToolError> {
    let Some(value) = value else {
        return if required {
            Err(invalid(format!("{field} is required")))
        } else {
            Ok(None)
        };
    };
    let Some(text) = value.as_str() else {
        return Err(invalid(format!("{field} must be a string")));
    };
    if text.is_empty() || text.chars().count() > 256 {
        return Err(invalid(format!("{field} must be 1 to 256 characters")));
    }
    Ok(Some(text.to_owned()))
}

/// 当前会话里可用的规范意图：只认真人输入（Node 过滤 synthetic）。
fn human_intents(snapshot: &SessionSnapshot) -> HashSet<&MessageId> {
    snapshot
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::User(user) if user.origin == UserOrigin::Human => Some(&user.id),
            _ => None,
        })
        .collect()
}

/// 一条已接纳输入的话题身份：Node `identitySchema` 的同一组必填事实。
struct TopicIdentity {
    command: String,
    source: Value,
}

fn admitted_identity(snapshot: &SessionSnapshot, input_id: Option<&str>) -> Option<TopicIdentity> {
    let human = human_intents(snapshot);
    for (message, intent) in snapshot.intents.iter().rev() {
        if !human.contains(message) {
            continue;
        }
        // 没有 botGroupSource 的普通输入不构成话题授权，继续看更早的输入（Node 同一判据）。
        let Some(source) = intent.get("botGroupSource") else {
            continue;
        };
        let command = intent["sourceCommandId"].as_str()?.trim();
        if command.is_empty() {
            return None;
        }
        // Node `identitySchema` 要求四项来源事实都非空；坏数据不得降级成空授权。
        for field in ["botId", "chatId", "threadId", "authorizationId"] {
            if source[field].as_str().is_none_or(str::is_empty) {
                return None;
            }
        }
        if input_id.is_some_and(|wanted| wanted != command) {
            continue;
        }
        return Some(TopicIdentity {
            command: command.to_owned(),
            source: source.clone(),
        });
    }
    None
}

fn resource_is_indexed(source: &Value, message_id: &str, index: u64) -> bool {
    // canonical `topicHistory` 存在时它是唯一索引，不得回退 topicContext（Node 同一判据）。
    if source.get("topicHistory").is_some() {
        return source["topicHistory"]["resourceMessages"]
            .as_array()
            .is_some_and(|records| {
                records.iter().any(|record| {
                    record["messageId"].as_str() == Some(message_id)
                        && index < record["count"].as_u64().unwrap_or(0)
                })
            });
    }
    source["topicContext"]["messages"]
        .as_array()
        .and_then(|messages| {
            messages
                .iter()
                .find(|record| record["id"].as_str() == Some(message_id))
        })
        .and_then(|record| record["attachments"].as_array())
        .is_some_and(|attachments| index < attachments.len() as u64)
}

pub struct ReadTopicResourceTool {
    reads: Arc<dyn SessionReads>,
    topic: Option<Arc<dyn TopicPort>>,
}

impl ReadTopicResourceTool {
    pub fn new(reads: Arc<dyn SessionReads>, topic: Option<Arc<dyn TopicPort>>) -> Self {
        Self { reads, topic }
    }
}

#[async_trait]
impl Tool for ReadTopicResourceTool {
    fn name(&self) -> &str {
        READ_TOPIC_RESOURCE
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["messageId"],
            "properties": {
                "inputId": {"type": "string", "minLength": 1, "maxLength": 256},
                "messageId": {"type": "string", "minLength": 1, "maxLength": 256},
                "index": {"type": "integer", "minimum": 0}
            }
        })
    }

    fn description(&self, _context: &nibi_kernel_api::tool::PromptContext) -> String {
        "Download a file or image listed in the current task's topic history resource index to a managed local file.".to_owned()
    }

    fn should_defer(&self) -> bool {
        true
    }

    /// Node 的 `readOnly: false`：读取会在会话里物化一份 artifact。
    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    /// Node 的 `needsApproval: false`（会话本身已授权），不进询问；Host 仍会校验授权。
    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> nibi_kernel_api::permission::PermissionDecision {
        nibi_kernel_api::permission::PermissionDecision::Allow {
            updated_input: None,
        }
    }

    fn search_hint(&self) -> Option<&str> {
        Some("download a resource listed in the current task's topic history")
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(READ_TOPIC_RESOURCE_MAX_CHARS)
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let message_id = bounded_id(input.get("messageId"), "messageId", true)?.unwrap_or_default();
        let input_id = bounded_id(input.get("inputId"), "inputId", false)?;
        let index = match input.get("index") {
            None => 0,
            Some(value) => value
                .as_u64()
                .ok_or_else(|| invalid("index must be a nonnegative integer"))?,
        };
        if context.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let snapshot = self
            .reads
            .snapshot(&context.session)
            .await
            .map_err(failed)?;
        let Some(identity) = admitted_identity(&snapshot, input_id.as_deref()) else {
            return Err(failed(
                "No admitted topic authorization is available for this input",
            ));
        };
        // A1 只属于所选快照：带 inputId 时消息与资源序号必须仍在该快照的索引里。
        if input_id.is_some() && !resource_is_indexed(&identity.source, &message_id, index) {
            return Err(failed(
                "Resource is not indexed in the selected history snapshot",
            ));
        }
        let Some(topic) = &self.topic else {
            return Err(failed(
                "Topic attachment retrieval is unavailable on this runtime",
            ));
        };
        let authorization = identity.source["authorizationId"]
            .as_str()
            .unwrap_or_default();
        let request = TopicResourceRead {
            request_id: format!(
                "{}:topic:{}",
                context.session.as_str(),
                context.tool_use.as_str()
            ),
            task_id: context.session.as_str().to_owned(),
            input_id: identity.command,
            authorization_id: authorization.to_owned(),
            message_id: message_id.clone(),
            resource_index: index,
        };
        let attachment = topic.read(&request).await.map_err(failed)?;
        if attachment.bytes > TOPIC_ATTACHMENT_MAX_BYTES {
            return Err(failed("Invalid topic attachment size"));
        }
        if context.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let Some((artifact_session, artifact_id)) = parse_artifact(&attachment.reference) else {
            return Err(failed("Invalid topic attachment artifact"));
        };
        let reference = context
            .artifacts
            .find(&artifact_session, &artifact_id)
            .await
            .map_err(|error| failed(format!("Topic attachment could not be read: {error}")))?
            .ok_or_else(|| failed("Invalid topic attachment artifact"))?;
        let bytes = context
            .artifacts
            .get(&reference)
            .await
            .map_err(|error| failed(format!("Topic attachment could not be read: {error}")))?;
        if bytes.len() as u64 != attachment.bytes {
            return Err(failed("Topic attachment size or encoding mismatch"));
        }
        if context.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let stored = context
            .artifacts
            .put(
                &context.session,
                ArtifactPurpose::ToolOutput,
                attachment.mime.clone(),
                bytes,
            )
            .await
            .map_err(|error| {
                failed(format!(
                    "Topic attachment could not be materialized: {error}"
                ))
            })?;
        if context.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let path = format!(
            "nibi-artifact://{}/{}",
            stored.session.as_str(),
            stored.id.as_str()
        );
        let output = json!({
            "status": "success",
            "path": path,
            "fileName": attachment.file_name,
            "mime": attachment.mime,
            "bytes": attachment.bytes,
            "messageId": message_id,
            "index": index,
        });
        Ok(text(&output.to_string()))
    }
}

pub struct ReplyToChannelTool {
    reads: Arc<dyn SessionReads>,
    topic: Option<Arc<dyn TopicPort>>,
}

impl ReplyToChannelTool {
    pub fn new(reads: Arc<dyn SessionReads>, topic: Option<Arc<dyn TopicPort>>) -> Self {
        Self { reads, topic }
    }
}

#[async_trait]
impl Tool for ReplyToChannelTool {
    fn name(&self) -> &str {
        REPLY_TO_CHANNEL
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["parts"],
            "properties": {
                "parts": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 50,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["type"],
                        "properties": {
                            "type": {"type": "string", "enum": ["text", "mention", "mentionName"]},
                            "text": {"type": "string", "maxLength": 2000},
                            "refId": {"type": "string", "minLength": 1, "maxLength": 200},
                            "name": {"type": "string", "minLength": 1, "maxLength": 200},
                            "candidateRef": {"type": "string", "minLength": 1, "maxLength": 200}
                        }
                    }
                }
            }
        })
    }

    fn description(&self, _context: &nibi_kernel_api::tool::PromptContext) -> String {
        "Send an additional reply to the current Feishu/Lark conversation ONLY when the user explicitly asks you to send or mention someone.".to_owned()
    }

    fn should_defer(&self) -> bool {
        true
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }

    /// Node 的这个工具是 `needsApproval: false`（会话本身已授权），不进询问；Host 仍会校验授权。
    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> nibi_kernel_api::permission::PermissionDecision {
        nibi_kernel_api::permission::PermissionDecision::Allow {
            updated_input: None,
        }
    }

    fn search_hint(&self) -> Option<&str> {
        Some("reply in the current bot conversation with native mentions")
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        // 最多 50 个名字各 10 个候选（Node `OUTPUT_BYTES`）。
        Some(2 * 1024 * 1024)
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let parts = input["parts"]
            .as_array()
            .filter(|parts| !parts.is_empty() && parts.len() <= 50)
            .ok_or_else(|| ToolError::InvalidInput {
                message: "parts must be 1 to 50 channel parts".to_owned(),
            })?;
        let Some(topic) = &self.topic else {
            return Err(failed("Channel reply is unavailable"));
        };
        let snapshot = self
            .reads
            .snapshot(&context.session)
            .await
            .map_err(|error| {
                failed(format!(
                    "Channel reply execution input unavailable: {error}"
                ))
            })?;
        // 这条工具调用属于哪条 assistant 消息：它前面最近的一条真人输入才是这次回复的授权输入。
        let tool_use = context.tool_use.as_str();
        let owner = snapshot.messages.iter().position(|message| {
            matches!(
                message,
                Message::Assistant(assistant)
                    if assistant.content.iter().any(|block| matches!(
                        block,
                        ContentBlock::ToolUse { id, .. } if id.as_str() == tool_use
                    ))
            )
        });
        let Some(owner) = owner else {
            return Err(failed("Channel reply execution input unavailable"));
        };
        let parent = snapshot.messages[..owner]
            .iter()
            .rev()
            .find_map(|message| match message {
                Message::User(user) if user.origin == UserOrigin::Human => Some(user.id.clone()),
                _ => None,
            });
        let Some(parent) = parent else {
            return Err(failed(
                "Channel reply execution input unavailable; retrying will not restore it",
            ));
        };
        let input_id = snapshot
            .intents
            .iter()
            .find(|(message, _)| *message == parent)
            .and_then(|(_, intent)| intent["sourceCommandId"].as_str())
            .ok_or_else(|| {
                failed("Channel reply execution input unavailable; retrying will not restore it")
            })?;
        let request = json!({
            "taskId": context.session.as_str(),
            "inputId": input_id,
            "toolCallId": context.tool_use.as_str(),
            "parts": parts,
        });
        let result = topic.reply(request).await.map_err(failed)?;
        Ok(text(&result.to_string()))
    }
}

/// 两个工具（Node 都 `shouldDefer`）。`ReadTopicResource` 只在 Host 话题端口在场时注册
/// （Node `includeTopicResource` 同门）；`ReplyToChannel` 保持原行为，端口缺席时按同一条错误失败。
pub fn topic_tools(reads: Arc<dyn SessionReads>, topic: Option<Arc<dyn TopicPort>>) -> Vec<Arc<dyn Tool>> {
    let reply = Arc::new(ReplyToChannelTool::new(reads.clone(), topic.clone()));
    let Some(topic) = topic else {
        return vec![reply];
    };
    vec![
        Arc::new(ReadTopicResourceTool::new(reads, Some(topic))),
        reply,
    ]
}

/// `nibi-artifact://<会话>/<artifact>` → 会话与 id（Host 返回的引用就是这一种）。
fn parse_artifact(uri: &str) -> Option<(SessionId, nibi_kernel_api::ids::ArtifactId)> {
    let rest = uri.strip_prefix("nibi-artifact://")?;
    let (session, id) = rest.split_once('/')?;
    (!session.is_empty() && !id.is_empty()).then(|| {
        (
            SessionId::new(session),
            nibi_kernel_api::ids::ArtifactId::new(id),
        )
    })
}

#[cfg(test)]
#[path = "topic_tools_tests.rs"]
mod tests;

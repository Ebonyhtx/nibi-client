//! 话题（bot 群）的两个工具：`ReadSessionContext` 与 `ReplyToChannel`（Node 同名工具）。
//!
//! 两者都只读「持久化历史 + 每条输入的规范意图」：
//! - `ReadSessionContext`：按 `strategy` 读某个会话的上下文；`topic` 策略还能把话题里被引用的附件
//!   物化成会话 artifact（模型随后用 Read 读它），或者翻已归档的话题消息；
//! - `ReplyToChannel`：把一次带原生 @ 的回复绑定到发起这次工具调用的那条输入，交给 Host 发送。
//!
//! 与 Node 的已知差异（记录在 `docs/rust-kernel-function-parity.md`）：
//! 1. `relevant` / `handoff` 只给按时间序的尾部窗口（Node 会按 query 打分并可选地经 lite 模型抽取）；
//! 2. 话题附件物化成会话 artifact（`nibi-artifact://…`），Node 物化成受管的本机路径。

use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::message::{ContentBlock, Message, ToolResultContent, UserOrigin};
use nibi_kernel_api::store::ArtifactPurpose;
use nibi_kernel_api::tool::{Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext};
use nibi_kernel_api::topic::{SessionReads, SessionSnapshot, TopicPort, TopicResourceRead};
use serde_json::{Value, json};
use tokio::sync::mpsc;

pub const READ_SESSION_CONTEXT: &str = "ReadSessionContext";
pub const REPLY_TO_CHANNEL: &str = "ReplyToChannel";

/// 读面的上限（Node `READ_SESSION_CONTEXT_MAX_TOKENS` × 4 的同一量级）。
const CONTEXT_MAX_CHARS: usize = 32_000;
const TOPIC_DEFAULT_TOKENS: u64 = 6_000;
const TOPIC_MAX_TOKENS: u64 = 12_000;

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

/// 一条消息给模型看的文本（文本块按行拼接；工具调用只留名字）。
fn message_text(message: &Message) -> Option<(&'static str, String)> {
    match message {
        Message::User(user) => {
            let body: String = user
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!body.trim().is_empty()).then_some(("user", body))
        }
        Message::Assistant(assistant) => {
            let body: String = assistant
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.clone()),
                    ContentBlock::ToolUse { name, .. } => Some(format!("[tool: {name}]")),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!body.trim().is_empty()).then_some(("assistant", body))
        }
        _ => None,
    }
}

/// 尾部窗口：从最后一条往前取，直到预算用尽（Node 按打分选块，Rust 只给时间序的尾部）。
fn tail_transcript(snapshot: &SessionSnapshot, budget: usize) -> (String, usize, usize, bool) {
    let mut pieces: Vec<String> = Vec::new();
    let mut used = 0;
    let mut selected = 0;
    let readable: Vec<(String, &'static str, String)> = snapshot
        .messages
        .iter()
        .filter_map(|message| {
            let (role, body) = message_text(message)?;
            Some((message.id().as_str().to_owned(), role, body))
        })
        .collect();
    for (id, role, body) in readable.iter().rev() {
        let piece = format!("## {role} ({id})\n{body}");
        if used + piece.len() > budget {
            break;
        }
        used += piece.len() + 2;
        pieces.push(piece);
        selected += 1;
    }
    pieces.reverse();
    let truncated = selected < readable.len();
    (pieces.join("\n\n"), readable.len(), selected, truncated)
}

/// 话题归档（Node `readTopicArchive`）：只读运行时保存的可信输入事实，按 scope 去重后翻页。
fn topic_archive(snapshot: &SessionSnapshot, query: &str, cursor: u64, max_tokens: u64) -> Value {
    // 每条输入的 `botGroupSource.topicContext`：作用域取最后一条（Node 的 `sources.at(-1)`）。
    let sources: Vec<Value> = snapshot
        .intents
        .iter()
        .filter_map(|(_, intent)| {
            let source = intent.get("botGroupSource")?;
            let context = source.get("topicContext")?;
            let _ = context.get("messages")?.as_array()?;
            Some(source.clone())
        })
        .collect();
    let scope = sources.last().cloned().unwrap_or(Value::Null);
    let scope_of = |source: &Value| {
        (
            source["botId"].as_str().unwrap_or_default().to_owned(),
            source["chatId"].as_str().unwrap_or_default().to_owned(),
            source["threadId"].as_str().unwrap_or_default().to_owned(),
        )
    };
    let scope_key = scope_of(&scope);
    let mut records: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut has_gap = false;
    for source in &sources {
        if scope_of(source) != scope_key {
            continue;
        }
        has_gap |= source["topicContext"]["hasGap"].as_bool() == Some(true);
        let Some(messages) = source["topicContext"]["messages"].as_array() else {
            continue;
        };
        for record in messages {
            if record["chatId"].as_str() != Some(scope_key.1.as_str())
                || record["threadId"].as_str() != Some(scope_key.2.as_str())
                || record["senderType"].as_str() != Some("user")
            {
                continue;
            }
            let Some(id) = record["id"].as_str() else {
                continue;
            };
            if seen.insert(id.to_owned()) {
                records.push(record.clone());
            }
        }
    }
    let needle = query.to_lowercase();
    let matches: Vec<&Value> = records
        .iter()
        .filter(|record| {
            record["id"].as_str() == Some(query)
                || record["text"]
                    .as_str()
                    .is_some_and(|text| text.to_lowercase().contains(&needle))
        })
        .collect();
    let budget = max_tokens.clamp(256, TOPIC_MAX_TOKENS);
    let mut selected: Vec<Value> = Vec::new();
    let mut consumed = 0u64;
    let mut clipped = false;
    for record in matches.iter().skip(cursor as usize).take(20) {
        let cost = estimate_tokens(&record.to_string());
        if consumed + cost > budget.saturating_sub(100) {
            if selected.is_empty() {
                // 超长单条保留可辨认的预览并声明截断（Node 同一处理）。
                let mut record = (*record).clone();
                if let Some(text) = record["text"].as_str() {
                    let keep = text.chars().take(400).collect::<String>();
                    record["text"] = json!(keep);
                }
                selected.push(record);
                clipped = true;
            }
            break;
        }
        selected.push((*record).clone());
        consumed += cost;
    }
    let next = cursor + selected.len() as u64;
    let next_cursor = (next < matches.len() as u64).then_some(next);
    json!({
        "status": if scope.is_null() { "not_found" } else { "success" },
        "strategy": "topic",
        "query": query,
        "source": "local",
        "content": json!({
            "coverage": "Previously archived messages only; unread history is not available.",
            "records": selected,
        }).to_string(),
        "messageCount": records.len(),
        "selectedMessageCount": selected.len(),
        "truncated": has_gap || clipped || next_cursor.is_some(),
        "nextCursor": next_cursor,
        "references": selected
            .iter()
            .filter_map(|record| record["id"].as_str())
            .map(|id| json!({"messageId": id}))
            .collect::<Vec<_>>(),
    })
}

/// `estimateTokens` 的同一量级（字符数 / 4，向上取整）。
fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4)
}

/// 模型看到的文案（Node `formatReadSessionContextModelContent`）。
fn model_content(output: &Value) -> String {
    match output["status"].as_str() {
        Some("not_found") => format!(
            "Session {} was not found.",
            output["sessionId"].as_str().unwrap_or_default()
        ),
        Some("failed") => [
            Some(format!(
                "ReadSessionContext failed for {}.",
                output["sessionId"].as_str().unwrap_or_default()
            )),
            output["error"]
                .as_str()
                .map(|error| format!("Error: {error}")),
            output["content"].as_str().map(str::to_owned),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n"),
        _ => [
            Some(format!(
                "ReadSessionContext returned {} context for {}.",
                output["source"].as_str().unwrap_or("local"),
                output["sessionId"].as_str().unwrap_or_default()
            )),
            output["title"]
                .as_str()
                .map(|title| format!("Title: {title}")),
            (output["truncated"] == json!(true))
                .then(|| "The returned context is truncated.".to_owned()),
            output["nextCursor"]
                .as_u64()
                .map(|cursor| format!("More matches: call again with cursor={cursor}.")),
            Some(String::new()),
            output["content"].as_str().map(str::to_owned),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n"),
    }
}

pub struct ReadSessionContextTool {
    reads: Arc<dyn SessionReads>,
    topic: Option<Arc<dyn TopicPort>>,
}

impl ReadSessionContextTool {
    pub fn new(reads: Arc<dyn SessionReads>, topic: Option<Arc<dyn TopicPort>>) -> Self {
        Self { reads, topic }
    }

    /// 话题附件：按消息/资源序号取回，物化成会话 artifact（Node 物化成受管本机路径）。
    async fn topic_attachment(
        &self,
        snapshot: &SessionSnapshot,
        input: &Value,
        context: &ToolUseContext,
    ) -> Result<ToolOutput, ToolError> {
        let attachment = &input["attachment"];
        let Some(message_id) = attachment["messageId"].as_str() else {
            return Err(ToolError::InvalidInput {
                message: "attachment needs a messageId".to_owned(),
            });
        };
        let input_id = attachment["inputId"].as_str();
        let index = attachment["index"].as_u64().unwrap_or(0);
        // 只认这条会话已准入输入的规范意图（Node 同一判据）；旧字段不回退。
        let identity = snapshot.intents.iter().rev().find_map(|(_, intent)| {
            let source = intent.get("botGroupSource")?;
            let command = intent["sourceCommandId"].as_str()?;
            let source_message = source["messageId"].as_str().unwrap_or_default();
            // 话题批量输入：只认最后一条消息（Node 的 `messages.at(-1)`）。
            let last = source["messages"]
                .as_array()
                .and_then(|messages| messages.last())
                .and_then(|message| message["messageId"].as_str())
                .unwrap_or(source_message);
            if input_id.is_some_and(|wanted| wanted != command) || last.is_empty() {
                return None;
            }
            Some((command.to_owned(), source.clone()))
        });
        let Some((command, source)) = identity else {
            return Err(failed(
                "No admitted topic authorization is available for this input",
            ));
        };
        // 索引必须落在所选快照里（Node 的 `topicHistory` / `topicContext` 两条判据）。
        let indexed = source["topicHistory"]["resourceMessages"]
            .as_array()
            .is_some_and(|records| {
                records.iter().any(|record| {
                    record["messageId"].as_str() == Some(message_id)
                        && index < record["count"].as_u64().unwrap_or(0)
                })
            })
            || source["topicContext"]["messages"]
                .as_array()
                .and_then(|messages| {
                    messages
                        .iter()
                        .find(|record| record["id"].as_str() == Some(message_id))
                })
                .and_then(|record| record["attachments"].as_array())
                .is_some_and(|attachments| index < attachments.len() as u64);
        if !indexed {
            return Err(failed(
                "Resource is not indexed in the selected history snapshot",
            ));
        }
        let Some(topic) = &self.topic else {
            return Err(failed(
                "Topic attachment retrieval is unavailable on this runtime",
            ));
        };
        let authorization = source["authorizationId"].as_str().unwrap_or_default();
        let request = TopicResourceRead {
            request_id: format!(
                "{}:topic:{}",
                context.session.as_str(),
                context.tool_use.as_str()
            ),
            task_id: context.session.as_str().to_owned(),
            input_id: command,
            authorization_id: authorization.to_owned(),
            message_id: message_id.to_owned(),
            resource_index: index,
        };
        let attachment = topic.read(&request).await.map_err(failed)?;
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
        let path = format!(
            "nibi-artifact://{}/{}",
            stored.session.as_str(),
            stored.id.as_str()
        );
        let output = json!({
            "status": "success",
            "sessionId": context.session.as_str(),
            "strategy": "topic",
            "query": input["query"],
            "source": "local",
            "path": path,
            "content": json!({
                "fileName": attachment.file_name,
                "mime": attachment.mime,
                "bytes": attachment.bytes,
                "path": path,
            }).to_string(),
            "messageCount": 1,
            "selectedMessageCount": 1,
            "truncated": false,
            "references": [{"messageId": message_id, "index": index}],
        });
        Ok(text(&model_content(&output)))
    }
}

#[async_trait]
impl Tool for ReadSessionContextTool {
    fn name(&self) -> &str {
        READ_SESSION_CONTEXT
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["query"],
            "properties": {
                "sessionId": {"type": "string"},
                "query": {"type": "string", "minLength": 1, "maxLength": 4000},
                "strategy": {"type": "string", "enum": ["relevant", "handoff", "topic"]},
                "cursor": {"type": "integer", "minimum": 0},
                "attachment": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["messageId"],
                    "properties": {
                        "inputId": {"type": "string"},
                        "messageId": {"type": "string"},
                        "index": {"type": "integer", "minimum": 0}
                    }
                },
                "maxTokens": {"type": "integer", "minimum": 1, "maximum": TOPIC_MAX_TOKENS}
            }
        })
    }

    fn description(&self, _context: &nibi_kernel_api::tool::PromptContext) -> String {
        "Read relevant or handoff context from a persisted NIBI session, or use topic to look up original archived discussion in the current session.".to_owned()
    }

    fn should_defer(&self) -> bool {
        true
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("read context from another session or this topic's archived discussion")
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(80_000)
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let Some(query) = input["query"]
            .as_str()
            .filter(|query| !query.trim().is_empty())
        else {
            return Err(ToolError::InvalidInput {
                message: "query is required".to_owned(),
            });
        };
        let strategy = input["strategy"].as_str().unwrap_or("relevant");
        let requested = input["sessionId"].as_str().unwrap_or("current");
        if strategy == "topic" && requested != "current" {
            return Err(ToolError::InvalidInput {
                message: "Topic history can only be read from the current session".to_owned(),
            });
        }
        if strategy != "topic" && requested == "current" {
            return Err(ToolError::InvalidInput {
                message: "Non-topic strategies require an explicit session id".to_owned(),
            });
        }
        if input.get("attachment").is_some() && strategy != "topic" {
            return Err(ToolError::InvalidInput {
                message: "Attachments require topic strategy".to_owned(),
            });
        }
        let target = if requested == "current" {
            context.session.clone()
        } else {
            SessionId::new(requested)
        };
        let snapshot = match self.reads.snapshot(&target).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let output = json!({
                    "status": "failed",
                    "sessionId": target.as_str(),
                    "strategy": strategy,
                    "query": query,
                    "source": "none",
                    "content": "Failed to read persisted session history.",
                    "messageCount": 0,
                    "selectedMessageCount": 0,
                    "truncated": false,
                    "error": error,
                });
                return Ok(text(&model_content(&output)));
            }
        };
        if strategy == "topic" && input.get("attachment").is_some() {
            return self.topic_attachment(&snapshot, &input, &context).await;
        }
        if strategy == "topic" {
            let cursor = input["cursor"].as_u64().unwrap_or(0);
            let max_tokens = input["maxTokens"].as_u64().unwrap_or(TOPIC_DEFAULT_TOKENS);
            let mut output = topic_archive(&snapshot, query, cursor, max_tokens);
            output["sessionId"] = json!(target.as_str());
            return Ok(text(&model_content(&output)));
        }
        // relevant / handoff：时间序的尾部窗口（见文件头第 1 条差异）。
        let budget = input["maxTokens"]
            .as_u64()
            .map(|tokens| (tokens.saturating_mul(4) as usize).min(CONTEXT_MAX_CHARS))
            .unwrap_or(CONTEXT_MAX_CHARS);
        let (content, readable, selected, truncated) = tail_transcript(&snapshot, budget);
        let output = json!({
            "status": "success",
            "sessionId": target.as_str(),
            "strategy": strategy,
            "query": query,
            "source": "local",
            "content": if content.is_empty() { "No readable messages.".to_owned() } else { content },
            "messageCount": snapshot.messages.len(),
            "selectedMessageCount": selected,
            "truncated": truncated || readable > selected,
        });
        Ok(text(&model_content(&output)))
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

/// 两个工具（Node 都 `shouldDefer`；没有 Host 能力时 `ReplyToChannel` 按 Node 的同一条错误失败）。
pub fn topic_tools(
    reads: Arc<dyn SessionReads>,
    topic: Option<Arc<dyn TopicPort>>,
) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(ReadSessionContextTool::new(reads.clone(), topic.clone())),
        Arc::new(ReplyToChannelTool::new(reads, topic)),
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

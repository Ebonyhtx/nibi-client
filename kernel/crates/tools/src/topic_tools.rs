//! 话题（bot 群）的两个工具：`ReadSessionContext` 与 `ReplyToChannel`（Node 同名工具）。
//!
//! 两者都只读「持久化历史 + 每条输入的规范意图」：
//! - `ReadSessionContext`：按 `strategy` 读某个会话的上下文；`topic` 策略还能把话题里被引用的附件
//!   物化成会话 artifact（模型随后用 Read 读它），或者翻已归档的话题消息；
//! - `ReplyToChannel`：把一次带原生 @ 的回复绑定到发起这次工具调用的那条输入，交给 Host 发送。
//!
//! 与 Node 的已知差异（记录在 `docs/rust-kernel-function-parity.md`）：
//! 1. `relevant` / `handoff` 的选片按 Node 的本地口径实现（query 断词、`scoreSearchText` 的权重、
//!    `handoff` 取尾部、`relevant` 取命中、全不命中退最后 12 条），有辅助模型时再按 Node
//!    `extractWithLite` 做 lite 抽取（`topic_lite.rs`；`source` 是 `lite`/`local`/`fallback`）；
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

use crate::topic_lite::{self, Snippet};

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

/// Node `tokenizeQuery`：小写后取 `[a-z0-9_./-]+` 与连续的汉字串；长度 < 2 的丢掉，汉字串再补所有二字切片。
///
/// 没有用正则：Rust 的 `regex` 不认 JS 的 `\p{Script=Han}`，这里是纯字符分类，不需要正则引擎。
fn tokenize_query(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut push = |term: &str| {
        if term.chars().count() >= 2 && !terms.iter().any(|existing| existing == term) {
            terms.push(term.to_owned());
        }
    };
    let mut word = String::new();
    let mut han = String::new();
    let flush_word = |word: &mut String, push: &mut dyn FnMut(&str)| {
        if !word.is_empty() {
            push(word);
            word.clear();
        }
    };
    let flush_han = |han: &mut String, push: &mut dyn FnMut(&str)| {
        if !han.is_empty() {
            let chars: Vec<char> = han.chars().collect();
            push(han);
            if chars.len() > 2 {
                // 二字切片（Node：`match.slice(i, i + 2)`）。
                for pair in chars.windows(2) {
                    push(&pair.iter().collect::<String>());
                }
            }
            han.clear();
        }
    };
    for c in query.to_lowercase().chars() {
        let word_char = c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-');
        if word_char {
            flush_han(&mut han, &mut push);
            word.push(c);
            continue;
        }
        flush_word(&mut word, &mut push);
        // `\p{Script=Han}` 的近似：CJK 统一表意文字的四个常用区（不含扩展 B 以后的生僻字量级）。
        if is_han(c) {
            han.push(c);
        } else {
            flush_han(&mut han, &mut push);
        }
    }
    flush_word(&mut word, &mut push);
    flush_han(&mut han, &mut push);
    terms
}

/// 是不是汉字（CJK 统一表意文字的基本区与扩展 A，加兼容区）。
fn is_han(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

/// Node `countOccurrences`：不重叠地数子串出现次数。
fn count_occurrences(text: &str, term: &str) -> usize {
    if term.is_empty() {
        return 0;
    }
    text.matches(term).count()
}

/// Node `scoreSearchText`：整句命中加 20；每个词命中加 `3 + min(出现次数, 5)`。
fn score_search_text(search_text: &str, normalized_query: &str, terms: &[String]) -> f64 {
    let mut score = 0.0;
    if !normalized_query.is_empty() && search_text.contains(normalized_query) {
        score += 20.0;
    }
    for term in terms {
        if !search_text.contains(term.as_str()) {
            continue;
        }
        score += 3.0 + count_occurrences(search_text, term).min(5) as f64;
    }
    score
}

/// Node `formatMessageSnippet` 里的 `searchText`：角色与正文（大小写不敏感的打分靠先转小写）。
fn search_text(role: &str, body: &str) -> String {
    format!("{role} {body}").to_lowercase()
}

/// 按 Node 的打分选出要放进上下文的片段。
///
/// - `handoff`：从最后一条往前取满预算（Node `selectTailWithinBudget`）；
/// - `relevant`：命中（分数 ≥ 3）的按分数降序取满预算，一个都没命中时退化成最后 12 条
///   （Node `selectSnippets`）。返回的片段按时间序。
fn select_snippets(snippets: Vec<Snippet>, strategy: &str, budget: usize) -> Vec<Snippet> {
    if snippets.is_empty() {
        return Vec::new();
    }
    if strategy == "handoff" {
        return tail_within_budget(snippets, budget);
    }
    let positives: Vec<Snippet> = snippets
        .iter()
        .filter(|snippet| snippet.score >= 3.0)
        .cloned()
        .collect();
    let mut ranked = if positives.is_empty() {
        snippets[snippets.len().saturating_sub(12)..].to_vec()
    } else {
        positives
    };
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.index.cmp(&a.index))
    });
    let mut selected = Vec::new();
    let mut used = 0;
    for snippet in ranked {
        if used > budget {
            break;
        }
        used += snippet.body.len();
        selected.push(snippet);
    }
    selected.sort_by_key(|snippet| snippet.index);
    selected
}

/// Node `selectTailWithinBudget`：至少保留最后一条，之后按预算往前取。
fn tail_within_budget(snippets: Vec<Snippet>, budget: usize) -> Vec<Snippet> {
    let mut selected: Vec<Snippet> = Vec::new();
    let mut used = 0;
    for snippet in snippets.into_iter().rev() {
        if !selected.is_empty() && used + snippet.body.len() > budget {
            break;
        }
        used += snippet.body.len();
        selected.push(snippet);
    }
    selected.reverse();
    selected
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
        Some("not_found") if output["strategy"].as_str() == Some("topic") => format!(
            // topic 只读当前会话的归档话题：会话存在，not_found 只表示没有可读的归档原文。
            "No archived topic discussion was found for session {}. The session exists, but it has no archived group-topic messages (or none have been admitted yet).",
            output["sessionId"].as_str().unwrap_or_default()
        ),
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

    /// 只读：与 Node 的 `readOnly` 工具同一姿态，不进询问。
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
        // relevant / handoff：本地按 query 打分（Node `selectSnippets`：`handoff` 从尾部取满预算，
        // `relevant` 取命中的片段）；有辅助模型时再走 lite 抽取（Node `extractWithLite`）。
        let max_tokens = input["maxTokens"]
            .as_u64()
            .unwrap_or(topic_lite::DEFAULT_MAX_TOKENS)
            .min(topic_lite::MAX_TOKENS);
        let budget = ((max_tokens.saturating_mul(4)) as usize).min(CONTEXT_MAX_CHARS);
        let terms = tokenize_query(query);
        let normalized = query.trim().to_lowercase();
        let readable: Vec<Snippet> = snapshot
            .messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| {
                let (role, body) = message_text(message)?;
                let score = score_search_text(&search_text(role, &body), &normalized, &terms)
                    // Node 用 `index / 10000` 做同分时的稳定顺序。
                    + index as f64 / 10_000.0;
                Some(Snippet {
                    index,
                    id: message.id().as_str().to_owned(),
                    role,
                    body,
                    score,
                })
            })
            .collect();
        let total = readable.len();
        let selected = select_snippets(readable.clone(), strategy, budget);
        let content = selected
            .iter()
            .map(|snippet| format!("## {} ({})\n{}", snippet.role, snippet.id, snippet.body))
            .collect::<Vec<_>>()
            .join("\n\n");
        let count = selected.len();
        let target_info = topic_lite::Target {
            title: &snapshot.title,
            directory: snapshot.directory.as_deref(),
            session: &target,
            strategy,
            query,
            output_char_budget: budget,
        };
        let all_chars = if readable.is_empty() {
            0
        } else {
            topic_lite::material(&target_info, &readable).chars().count()
        };
        // Node `material.truncated` 的两条：选片少于可读条数，或整份记录超出输出预算。
        let truncated = count < total || all_chars > budget;
        let mut source = "local";
        let mut lite_error = None;
        let mut body = if content.is_empty() {
            "No readable messages.".to_owned()
        } else {
            content
        };
        if !readable.is_empty() {
            match topic_lite::extract(&context, &target_info, &readable, max_tokens).await {
                topic_lite::Outcome::Lite(text) => {
                    source = "lite";
                    body = text;
                }
                topic_lite::Outcome::NoModel => {}
                // Node：空结果与请求失败都退回本地结果并强制 `truncated`；失败时附错误。
                topic_lite::Outcome::Empty => source = "fallback",
                topic_lite::Outcome::Failed(error) => {
                    source = "fallback";
                    lite_error = Some(error);
                }
            }
        }
        let output = json!({
            "status": "success",
            "sessionId": target.as_str(),
            "strategy": strategy,
            "query": query,
            "source": source,
            "content": body,
            "messageCount": snapshot.messages.len(),
            "selectedMessageCount": count,
            "truncated": truncated || source == "fallback",
            "error": lite_error,
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

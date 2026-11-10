//! MCP `elicitation/create` → 内核的用户提问通道（Node `mcp-elicitation.ts` 与
//! `interaction-broker.ts#requestMcpElicitation` 的镜像）。
//!
//! 服务器只能在**一次工具调用执行期间**提问：`McpTool::call` 在 `tools/call` 之前登记会话与
//! 取消令牌，Reader 收到 `elicitation/create` 时按服务器名找回它。没有在执行的调用（服务器空闲
//! 时主动提问）回 `decline`，绝不猜一个会话。
//!
//! 模式只支持 `form`（缺省、`form`、兼容别名 `openai/form` / `openaiForm`）；其余（`url` 等）
//! 回 decline。问题从扁平的 `requestedSchema.properties` 派生：boolean → Yes/No，enum → 枚举值，
//! string/number/integer → 自由文本（问题的自定义输入框）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::ids::ToolUseId;
use nibi_kernel_api::interaction::QuestionAnswer;
use nibi_kernel_api::mcp::McpElicitation;
use nibi_kernel_api::orchestration::{InteractionRequest, Interactions};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// 一次在执行的工具调用的会话上下文。
struct CallContext {
    interactions: Arc<dyn Interactions>,
    session: SessionId,
    tool_use: ToolUseId,
    cancel: CancellationToken,
}

/// 当前工具调用 → 服务器名。键是服务器名（同一服务器同时只有一个在执行的调用，Node 的
/// `activeCallTraces` 同一条）。
#[derive(Default)]
pub struct ElicitationHub {
    calls: Mutex<HashMap<String, (u64, Arc<CallContext>)>>,
    next: AtomicU64,
}

/// 登记的作用域：工具调用结束时（含提前返回与取消）撤下。
pub struct ElicitationGuard {
    hub: Arc<ElicitationHub>,
    server: String,
    generation: u64,
}

impl Drop for ElicitationGuard {
    fn drop(&mut self) {
        let mut calls = self
            .hub
            .calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // 期间同一服务器又起了一次调用：只撤自己那一条。
        if calls
            .get(&self.server)
            .is_some_and(|(generation, _)| *generation == self.generation)
        {
            calls.remove(&self.server);
        }
    }
}

impl ElicitationHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 工具调用开始时登记；返回的作用域在 `tools/call` 结束（成功、失败或取消）时撤下。
    pub fn enter(
        self: &Arc<Self>,
        server: &str,
        interactions: Arc<dyn Interactions>,
        session: SessionId,
        tool_use: ToolUseId,
        cancel: CancellationToken,
    ) -> ElicitationGuard {
        let generation = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                server.to_owned(),
                (
                    generation,
                    Arc::new(CallContext {
                        interactions,
                        session,
                        tool_use,
                        cancel,
                    }),
                ),
            );
        ElicitationGuard {
            hub: self.clone(),
            server: server.to_owned(),
            generation,
        }
    }
}

fn decline() -> Value {
    json!({"action": "decline"})
}

fn supported_mode(mode: Option<&str>) -> bool {
    matches!(mode, None | Some("form" | "openai/form" | "openaiForm"))
}

/// `requestedSchema` 的一个字段（Node `readMcpElicitationFields` 同形）。
struct Field {
    name: String,
    kind: FieldKind,
    header: String,
    question: String,
    enum_values: Vec<String>,
    enum_names: Vec<String>,
}

enum FieldKind {
    String,
    Number,
    Integer,
    Boolean,
    Enum,
}

fn read_fields(requested: &Value, message: &str) -> Vec<Field> {
    let Some(properties) = requested.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut fields = Vec::new();
    for (name, raw) in properties {
        let Some(raw) = raw.as_object() else {
            continue;
        };
        let enum_values: Vec<String> = raw
            .get("enum")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let kind = if !enum_values.is_empty() {
            FieldKind::Enum
        } else {
            match raw.get("type").and_then(Value::as_str) {
                Some("boolean") => FieldKind::Boolean,
                Some("integer") => FieldKind::Integer,
                Some("number") => FieldKind::Number,
                Some("string") => FieldKind::String,
                _ => continue,
            }
        };
        let header = raw
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(name)
            .to_owned();
        let question = raw
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{message}\n\n{header}"));
        let enum_names = raw
            .get("enumNames")
            .and_then(Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        fields.push(Field {
            name: name.clone(),
            kind,
            header,
            question,
            enum_values,
            enum_names,
        });
    }
    fields
}

/// 字段 → 问题（Node `mcpElicitationQuestions` 同形）。自由文本题没有选项：界面显示自定义输入框。
fn questions(fields: &[Field], message: &str) -> Value {
    if fields.is_empty() {
        return json!([{
            "header": "Answer",
            "question": message,
            "options": [],
        }]);
    }
    let questions: Vec<Value> = fields
        .iter()
        .map(|field| {
            let options = match field.kind {
                FieldKind::Boolean => json!([
                    {"value": "true", "label": "Yes"},
                    {"value": "false", "label": "No"},
                ]),
                FieldKind::Enum => {
                    let values: Vec<Value> = field
                        .enum_values
                        .iter()
                        .enumerate()
                        .map(|(index, value)| {
                            let label = field.enum_names.get(index).unwrap_or(value);
                            json!({"value": value, "label": label})
                        })
                        .collect();
                    Value::Array(values)
                }
                FieldKind::String | FieldKind::Number | FieldKind::Integer => json!([]),
            };
            json!({
                "header": field.header,
                "question": field.question,
                "options": options,
            })
        })
        .collect();
    Value::Array(questions)
}

fn answer_for<'a>(
    field: &Field,
    answers: &'a std::collections::BTreeMap<String, String>,
) -> Option<&'a str> {
    answers.get(&field.question).map(String::as_str)
}

/// 用户答案 → MCP `ElicitResult.content`（Node `mcpElicitationContentFromAnswers` 同形）。
fn content(
    fields: &[Field],
    answers: &std::collections::BTreeMap<String, String>,
    message: &str,
) -> Value {
    if fields.is_empty() {
        return answers
            .get(message)
            .map(|answer| json!({ "answer": answer }))
            .unwrap_or_else(|| json!({}));
    }
    let mut content = serde_json::Map::new();
    for field in fields {
        let Some(raw) = answer_for(field, answers) else {
            continue;
        };
        match field.kind {
            FieldKind::Boolean => {
                let value = raw.eq_ignore_ascii_case("yes") || raw.eq_ignore_ascii_case("true");
                content.insert(field.name.clone(), json!(value));
            }
            FieldKind::Number | FieldKind::Integer => {
                if let Ok(number) = raw.parse::<f64>()
                    && number.is_finite()
                {
                    content.insert(
                        field.name.clone(),
                        if matches!(field.kind, FieldKind::Integer) {
                            json!(number.trunc() as i64)
                        } else {
                            json!(number)
                        },
                    );
                }
            }
            FieldKind::Enum => {
                let index = field
                    .enum_names
                    .iter()
                    .position(|name| name == raw)
                    .or_else(|| field.enum_values.iter().position(|value| value == raw));
                if let Some(index) = index
                    && let Some(value) = field.enum_values.get(index)
                {
                    content.insert(field.name.clone(), json!(value));
                }
            }
            FieldKind::String => {
                content.insert(field.name.clone(), json!(raw));
            }
        }
    }
    Value::Object(content)
}

#[async_trait::async_trait]
impl McpElicitation for ElicitationHub {
    async fn elicit(&self, server: &str, request: Value) -> Value {
        let Some(context) = self
            .calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(server)
            .map(|(_, context)| context.clone())
        else {
            return decline();
        };
        let mode = request.get("mode").and_then(Value::as_str);
        if !supported_mode(mode) {
            tracing::warn!(
                event = "mcp.elicitation.unsupported_mode",
                mcpServerName = server,
                mode = mode.unwrap_or(""),
                "MCP elicitation mode not supported, declining"
            );
            return decline();
        }
        let message = request
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let requested = request
            .get("requestedSchema")
            .cloned()
            .unwrap_or(Value::Null);
        let fields = read_fields(&requested, message);
        let interaction = InteractionRequest::Question {
            tool_use: context.tool_use.clone(),
            questions: json!({"questions": questions(&fields, message)}),
        };
        let answer = tokio::select! {
            answer = context.interactions.ask(&context.session, interaction) => answer,
            () = context.cancel.cancelled() => {
                context
                    .interactions
                    .cancel_ask(&context.session, &context.tool_use)
                    .await;
                return json!({"action": "cancel"});
            }
        };
        let Ok(answer) = answer else {
            return decline();
        };
        let Ok(answer) = serde_json::from_value::<QuestionAnswer>(answer.answer) else {
            return decline();
        };
        match answer {
            QuestionAnswer::Answered { answers, .. } => json!({
                "action": "accept",
                "content": content(&fields, &answers, message),
            }),
            QuestionAnswer::Declined => decline(),
        }
    }
}

#[cfg(test)]
#[path = "elicitation_tests.rs"]
mod tests;

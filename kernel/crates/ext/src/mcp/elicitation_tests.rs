//! `elicitation/create` 的映射测试（真实提问通道在集成层）。

use serde_json::json;

use super::{content, read_fields, supported_mode};

#[test]
fn only_the_form_mode_is_accepted() {
    assert!(supported_mode(None));
    assert!(supported_mode(Some("form")));
    assert!(supported_mode(Some("openai/form")));
    assert!(supported_mode(Some("openaiForm")));
    assert!(!supported_mode(Some("url")));
    assert!(!supported_mode(Some("other")));
}

#[test]
fn fields_become_questions_and_answers_become_content() {
    let schema = json!({
        "type": "object",
        "properties": {
            "name": {"type": "string", "title": "Name", "description": "What is your name?"},
            "age": {"type": "integer"},
            "loud": {"type": "boolean"},
            "color": {"type": "string", "enum": ["red", "blue"], "enumNames": ["Red", "Blue"]}
        }
    });
    let fields = read_fields(&schema, "Tell me");
    assert_eq!(fields.len(), 4);
    let answers = [
        ("What is your name?".to_owned(), "Ada".to_owned()),
        ("Tell me\n\nage".to_owned(), "36".to_owned()),
        ("Tell me\n\nloud".to_owned(), "Yes".to_owned()),
        ("Tell me\n\ncolor".to_owned(), "Blue".to_owned()),
    ]
    .into_iter()
    .collect();
    let mapped = content(&fields, &answers, "Tell me");
    assert_eq!(mapped["name"], json!("Ada"));
    assert_eq!(mapped["age"], json!(36));
    assert_eq!(mapped["loud"], json!(true));
    assert_eq!(mapped["color"], json!("blue"));
}

#[test]
fn a_schema_without_fields_returns_the_free_text_answer() {
    let fields = read_fields(&json!({}), "How many?");
    assert!(fields.is_empty());
    let answers = [("How many?".to_owned(), "7".to_owned())]
        .into_iter()
        .collect();
    assert_eq!(
        content(&fields, &answers, "How many?"),
        json!({"answer": "7"})
    );
}

struct Ask(serde_json::Value);

#[async_trait::async_trait]
impl nibi_kernel_api::orchestration::Interactions for Ask {
    async fn ask(
        &self,
        _session: &nibi_kernel_api::ids::SessionId,
        _request: nibi_kernel_api::orchestration::InteractionRequest,
    ) -> Result<
        nibi_kernel_api::interaction::InteractionAnswer,
        nibi_kernel_api::orchestration::OrchestrationError,
    > {
        Ok(nibi_kernel_api::interaction::InteractionAnswer {
            interaction: nibi_kernel_api::ids::InteractionId::new("ia_1"),
            answer: self.0.clone(),
        })
    }
}

/// 工具调用期间服务器提问 → 用户回答 → MCP `ElicitResult`（accept + content）。
#[tokio::test]
async fn an_elicitation_during_a_tool_call_reaches_the_question_channel() {
    use std::sync::Arc;

    let hub = super::ElicitationHub::new();
    let answers = json!({
        "decision": "answered",
        "answers": {"What is your name?": "Ada"},
    });
    let _guard = hub.enter(
        "srv",
        Arc::new(Ask(answers)),
        nibi_kernel_api::ids::SessionId::new("s1"),
        nibi_kernel_api::ids::ToolUseId::new("t1"),
        tokio_util::sync::CancellationToken::new(),
    );
    let result = <super::ElicitationHub as nibi_kernel_api::mcp::McpElicitation>::elicit(
        &hub,
        "srv",
        json!({
            "message": "Tell me about you",
            "requestedSchema": {
                "type": "object",
                "properties": {"name": {"type": "string", "title": "Name", "description": "What is your name?"}}
            }
        }),
    )
    .await;
    assert_eq!(result["action"], "accept");
    assert_eq!(result["content"]["name"], "Ada");
}

/// 没有正在执行的工具调用：不猜会话，回 decline。
#[tokio::test]
async fn an_elicitation_without_an_active_call_is_declined() {
    let hub = super::ElicitationHub::new();
    let result = <super::ElicitationHub as nibi_kernel_api::mcp::McpElicitation>::elicit(
        &hub,
        "srv",
        json!({"message": "hi"}),
    )
    .await;
    assert_eq!(result, json!({"action": "decline"}));
}

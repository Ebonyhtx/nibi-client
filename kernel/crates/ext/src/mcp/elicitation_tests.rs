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
    let _guard = enter(&hub, Arc::new(Ask(answers)), None);
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

fn enter(
    hub: &std::sync::Arc<super::ElicitationHub>,
    interactions: std::sync::Arc<dyn nibi_kernel_api::orchestration::Interactions>,
    hooks: Option<std::sync::Arc<dyn nibi_kernel_api::hooks::HookRunner>>,
) -> super::ElicitationGuard {
    hub.enter(
        "srv",
        super::CallContext {
            interactions,
            session: nibi_kernel_api::ids::SessionId::new("s1"),
            tool_use: nibi_kernel_api::ids::ToolUseId::new("t1"),
            cancel: tokio_util::sync::CancellationToken::new(),
            workspace: nibi_kernel_api::env::WorkspaceRef {
                environment: nibi_kernel_api::ids::EnvironmentId::new("local"),
                root: nibi_kernel_api::env::EnvPath::new("/work"),
            },
            hooks,
            hook_context: nibi_kernel_api::hooks::HookContext::default(),
        },
    )
}

/// 按事件名回固定结果的 hooks，并记录输入。
#[derive(Default)]
struct Hooks {
    outcomes: std::collections::HashMap<
        nibi_kernel_api::hooks::HookEventName,
        nibi_kernel_api::hooks::HookOutcome,
    >,
    seen: std::sync::Mutex<Vec<(nibi_kernel_api::hooks::HookEventName, serde_json::Value)>>,
}

#[async_trait::async_trait]
impl nibi_kernel_api::hooks::HookRunner for Hooks {
    async fn run(
        &self,
        event: nibi_kernel_api::hooks::HookEvent,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> nibi_kernel_api::hooks::HookOutcome {
        self.seen
            .lock()
            .unwrap()
            .push((event.name, event.payload.clone()));
        self.outcomes.get(&event.name).cloned().unwrap_or_default()
    }
}

/// Elicitation hook 的结论替用户回答：不问用户，回给服务器，不跑结果 hook。
#[tokio::test]
async fn an_elicitation_hook_answers_before_the_user() {
    use std::sync::Arc;

    let mut outcomes = std::collections::HashMap::new();
    outcomes.insert(
        nibi_kernel_api::hooks::HookEventName::Elicitation,
        nibi_kernel_api::hooks::HookOutcome {
            elicitation: Some(nibi_kernel_api::hooks::ElicitationVerdict {
                action: nibi_kernel_api::mcp_ask::ElicitationAction::Accept,
                content: Some([("name".to_owned(), json!("Ada"))].into_iter().collect()),
            }),
            ..nibi_kernel_api::hooks::HookOutcome::default()
        },
    );
    let hooks = Arc::new(Hooks {
        outcomes,
        ..Hooks::default()
    });
    let hub = super::ElicitationHub::new();
    // 用户回答不会被用到：这个替身会 panic 之外什么也不做（我们只检查没有 Ask 事件）。
    let _guard = enter(
        &hub,
        Arc::new(Ask(json!({"decision": "declined"}))),
        Some(hooks.clone()),
    );
    let result = <super::ElicitationHub as nibi_kernel_api::mcp::McpElicitation>::elicit(
        &hub,
        "srv",
        json!({"message": "Your name?"}),
    )
    .await;
    assert_eq!(
        result,
        json!({"action": "accept", "content": {"name": "Ada"}})
    );
    let seen = hooks.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0].0,
        nibi_kernel_api::hooks::HookEventName::Elicitation
    );
    assert_eq!(seen[0].1["mcp_server_name"], "srv");
    assert_eq!(seen[0].1["mode"], "form");
}

/// ElicitationResult hook 换掉用户的回答（没给 content 时沿用用户的）；阻塞回 decline。
#[tokio::test]
async fn an_elicitation_result_hook_replaces_the_answer() {
    use std::sync::Arc;

    let mut outcomes = std::collections::HashMap::new();
    outcomes.insert(
        nibi_kernel_api::hooks::HookEventName::ElicitationResult,
        nibi_kernel_api::hooks::HookOutcome {
            elicitation: Some(nibi_kernel_api::hooks::ElicitationVerdict {
                action: nibi_kernel_api::mcp_ask::ElicitationAction::Accept,
                content: None,
            }),
            ..nibi_kernel_api::hooks::HookOutcome::default()
        },
    );
    let hooks = Arc::new(Hooks {
        outcomes,
        ..Hooks::default()
    });
    let hub = super::ElicitationHub::new();
    let answers = json!({"decision": "answered", "answers": {"Your name?": "Ada"}});
    let _guard = enter(&hub, Arc::new(Ask(answers)), Some(hooks.clone()));
    let result = <super::ElicitationHub as nibi_kernel_api::mcp::McpElicitation>::elicit(
        &hub,
        "srv",
        json!({"message": "Your name?"}),
    )
    .await;
    assert_eq!(
        result,
        json!({"action": "accept", "content": {"answer": "Ada"}})
    );
    let seen = hooks.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "{seen:?}");
    let (name, payload) = seen
        .iter()
        .find(|(name, _)| *name == nibi_kernel_api::hooks::HookEventName::ElicitationResult)
        .expect("the result hook ran");
    assert_eq!(
        *name,
        nibi_kernel_api::hooks::HookEventName::ElicitationResult
    );
    assert_eq!(payload["action"], "accept");
    assert_eq!(payload["content"]["answer"], "Ada");
}

/// 阻塞（退出码 2 / `decision: block`）回 decline。
#[tokio::test]
async fn a_blocking_elicitation_hook_declines() {
    use std::sync::Arc;

    let mut outcomes = std::collections::HashMap::new();
    outcomes.insert(
        nibi_kernel_api::hooks::HookEventName::Elicitation,
        nibi_kernel_api::hooks::HookOutcome {
            blocking_error: Some("no".to_owned()),
            ..nibi_kernel_api::hooks::HookOutcome::default()
        },
    );
    let hooks = Arc::new(Hooks {
        outcomes,
        ..Hooks::default()
    });
    let hub = super::ElicitationHub::new();
    let _guard = enter(
        &hub,
        Arc::new(Ask(json!({"decision": "declined"}))),
        Some(hooks),
    );
    let result = <super::ElicitationHub as nibi_kernel_api::mcp::McpElicitation>::elicit(
        &hub,
        "srv",
        json!({"message": "Your name?"}),
    )
    .await;
    assert_eq!(result, json!({"action": "decline"}));
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

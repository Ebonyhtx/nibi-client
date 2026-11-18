//! TodoRead / TodoWrite：结果 JSON、整体替换、校验、会话隔离与权限标记。
use std::sync::Arc;

use nibi_kernel_api::ids::{RunId, SessionId};
use nibi_kernel_api::permission::PermissionDecision;
use nibi_kernel_api::tool::{Tool, ToolError, ToolOutput};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::MemoryTodos;
use crate::test_support::{harness, text, tool_context};

fn tool_set() -> (Vec<Arc<dyn Tool>>, Arc<MemoryTodos>) {
    let store = Arc::new(MemoryTodos::default());
    let tools = crate::todo::tools(store.clone());
    (tools, store)
}

fn find<'a>(tools: &'a [Arc<dyn Tool>], name: &str) -> &'a Arc<dyn Tool> {
    tools
        .iter()
        .find(|tool| tool.name() == name)
        .unwrap_or_else(|| panic!("missing {name}"))
}

async fn call(tool: &Arc<dyn Tool>, session: &str, input: Value) -> Result<ToolOutput, ToolError> {
    let context = tool_context(&SessionId::new(session), &RunId::new("run_todo"));
    let (progress, _updates) = mpsc::channel(4);
    tool.call(input, context, progress).await
}

fn parse(output: &ToolOutput) -> Value {
    serde_json::from_str(&text(output)).expect("todo results are JSON")
}

#[tokio::test]
async fn read_returns_the_empty_list_as_json() {
    let (tools, _store) = tool_set();
    let output = call(find(&tools, "TodoRead"), "sess_a", json!({}))
        .await
        .unwrap();
    assert!(!output.is_error);
    assert_eq!(parse(&output), json!({"todos": []}));
}

#[tokio::test]
async fn write_replaces_the_list_and_returns_old_todos_and_summary() {
    let (tools, _store) = tool_set();
    let read = find(&tools, "TodoRead");
    let write = find(&tools, "TodoWrite");
    let first = json!({"todos": [
        {"content": "Inspect", "status": "pending", "priority": "high"},
        {"content": "Implement", "status": "in_progress", "priority": "medium"},
        {"content": "Verify", "status": "completed", "priority": "low"}
    ]});
    let output = call(write, "sess_a", first.clone()).await.unwrap();
    assert_eq!(
        parse(&output),
        json!({
            "oldTodos": [],
            "todos": first["todos"],
            "summary": {"total": 3, "pending": 1, "inProgress": 1, "completed": 1}
        })
    );
    // 读回保持输入顺序。
    assert_eq!(
        parse(&call(read, "sess_a", json!({})).await.unwrap()),
        json!({"todos": first["todos"]})
    );
    // 第二次整体替换：oldTodos 是上一版，新清单可以同时有多个 in_progress（Node 已放开这条限制）。
    let second = json!({"todos": [
        {"content": "A", "status": "in_progress", "priority": "high"},
        {"content": "B", "status": "in_progress", "priority": "low"}
    ]});
    let output = call(write, "sess_a", second.clone()).await.unwrap();
    assert_eq!(
        parse(&output),
        json!({
            "oldTodos": first["todos"],
            "todos": second["todos"],
            "summary": {"total": 2, "pending": 0, "inProgress": 2, "completed": 0}
        })
    );
    assert_eq!(
        parse(&call(read, "sess_a", json!({})).await.unwrap()),
        json!({"todos": second["todos"]})
    );
}

#[tokio::test]
async fn invalid_inputs_are_rejected() {
    let (tools, _store) = tool_set();
    let read = find(&tools, "TodoRead");
    let write = find(&tools, "TodoWrite");
    for (tool, input) in [
        (read, json!({"unexpected": true})),
        (
            write,
            json!({"todos": [{"content": "", "status": "pending", "priority": "high"}]}),
        ),
        (
            write,
            json!({"todos": [{"content": "x", "status": "blocked", "priority": "high"}]}),
        ),
        (
            write,
            json!({"todos": [{"content": "x", "priority": "high"}]}),
        ),
        (
            write,
            json!({"todos": [{"content": "x", "status": "pending", "priority": "urgent"}]}),
        ),
        (
            write,
            json!({"todos": [{"content": "x", "status": "pending", "priority": "high"}], "extra": 1}),
        ),
    ] {
        match call(tool, "sess_a", input).await {
            Err(ToolError::InvalidInput { .. }) => {}
            other => panic!("expected invalid input, got {other:?}"),
        }
    }
    // 拒绝的调用没有写入任何 todo。
    assert_eq!(
        parse(&call(read, "sess_a", json!({})).await.unwrap()),
        json!({"todos": []})
    );
}

#[tokio::test]
async fn sessions_have_their_own_lists() {
    let (tools, _store) = tool_set();
    let read = find(&tools, "TodoRead");
    let write = find(&tools, "TodoWrite");
    let todos = json!([{"content": "Only me", "status": "pending", "priority": "high"}]);
    call(write, "sess_a", json!({"todos": todos}))
        .await
        .unwrap();
    assert_eq!(
        parse(&call(read, "sess_a", json!({})).await.unwrap()),
        json!({"todos": todos})
    );
    assert_eq!(
        parse(&call(read, "sess_b", json!({})).await.unwrap()),
        json!({"todos": []})
    );
}

#[tokio::test]
async fn metadata_and_permissions_match_node() {
    let (tools, _store) = tool_set();
    let context = tool_context(&SessionId::new("sess_a"), &RunId::new("run_todo"));
    for name in ["TodoRead", "TodoWrite"] {
        let tool = find(&tools, name);
        assert!(tool.should_defer(), "{name}");
        assert!(tool.is_read_only(&json!({})), "{name}");
        assert_eq!(tool.max_result_size_chars(), Some(100_000), "{name}");
        assert_eq!(
            tool.check_permissions(&json!({}), &context).await,
            PermissionDecision::Allow {
                updated_input: None
            },
            "{name}"
        );
    }
    assert!(find(&tools, "TodoRead").is_concurrency_safe(&json!({})));
    assert!(!find(&tools, "TodoWrite").is_concurrency_safe(&json!({})));
    assert!(
        find(&tools, "TodoWrite")
            .description(&nibi_kernel_api::tool::PromptContext {
                tool_names: Vec::new(),
                mode: nibi_kernel_api::permission::PermissionMode::Default,
            })
            .contains("Send the full list each call")
    );
}

#[tokio::test]
async fn the_agents_registry_lists_both_tools_by_default() {
    let harness = harness(None);
    let names: Vec<String> = harness
        .agents
        .registry()
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert!(names.iter().any(|name| name == "TodoRead"), "{names:?}");
    assert!(names.iter().any(|name| name == "TodoWrite"), "{names:?}");
    assert!(crate::AgentsConfig::default().todo_tools);
}

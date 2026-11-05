//! App-Provided Tools（Node `mcp-ui/appTools.ts`）：登记、曝光、信箱、认领、回传与时限。

use std::sync::Arc;

use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::mcp_ui::{
    McpAppInstance, McpUiAppToolAnnotations, McpUiAppToolDescriptor, McpUiInstanceRequest,
    McpUiRegisterAppToolsRequest, McpUiScope,
};
use nibi_kernel_api::testing::SequentialIds;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::*;

fn session() -> SessionId {
    SessionId::new("sess_1")
}

fn scope(server: &str) -> McpUiScope {
    McpUiScope {
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        workspace_identity: "/w".to_owned(),
        session: session(),
        plugin_id: "toolkit".to_owned(),
        server_name: server.to_owned(),
    }
}

fn instance(token: &str, generation: u64) -> McpAppInstance {
    McpAppInstance {
        runtime_id: "runtime-1".to_owned(),
        generation,
        app_identity: "a".repeat(64),
        token: token.to_owned(),
    }
}

fn definition(name: &str) -> McpUiAppToolDescriptor {
    McpUiAppToolDescriptor {
        name: name.to_owned(),
        title: None,
        description: Some(format!("{name} tool")),
        input_schema: json!({"type": "object", "properties": {}}),
        output_schema: None,
        annotations: None,
    }
}

fn register_request(
    server: &str,
    token: &str,
    generation: u64,
    tools: Vec<McpUiAppToolDescriptor>,
) -> McpUiRegisterAppToolsRequest {
    McpUiRegisterAppToolsRequest {
        instance: McpUiInstanceRequest {
            scope: scope(server),
            instance: instance(token, generation),
        },
        scope_id: token.to_owned(),
        generation,
        tools,
    }
}

fn registry() -> (Arc<AppToolRegistry>, mpsc::UnboundedReceiver<McpUiEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let ids: Arc<dyn Ids> = Arc::new(SequentialIds::default());
    (Arc::new(AppToolRegistry::new(ids, Some(tx))), rx)
}

fn call_context(server: &str, tool: &str, token: &str, generation: u64) -> AppToolCallContext {
    AppToolCallContext {
        session: session(),
        scope_id: token.to_owned(),
        generation,
        server_name: server.to_owned(),
        tool_name: tool.to_owned(),
    }
}

/// 登记：模型名是 `app__<server>__<tool>`；同 server 只曝光最近登记的实例。
#[test]
fn registering_exposes_the_latest_instance_per_server() {
    let (registry, _events) = registry();
    let first = registry.register(
        &session(),
        register_request("plugin:tk:panel", "scope-1", 1, vec![definition("echo")]),
    );
    assert_eq!(
        first,
        vec![McpUiAppToolRegistration {
            name: "echo".to_owned(),
            model_name: "app__plugin_tk_panel__echo".to_owned(),
        }]
    );
    assert!(
        registry
            .find(&session(), "app__plugin_tk_panel__echo")
            .is_some()
    );

    // 同一 scope 的新代际替换旧代际：旧实例的模型名不再暴露。
    let second = registry.register(
        &session(),
        register_request("plugin:tk:panel", "scope-1", 2, vec![definition("echo")]),
    );
    assert_eq!(second.len(), 1);
    // 另一个实例（同 server，后登记）成为唯一曝光者。
    let other = registry.register(
        &session(),
        register_request("plugin:tk:panel", "scope-2", 1, vec![definition("ping")]),
    );
    assert_eq!(other[0].model_name, "app__plugin_tk_panel__ping");
    let tools = registry.tools_for(&session());
    let names: Vec<&str> = tools.iter().map(|tool| tool.name()).collect();
    assert_eq!(names, vec!["app__plugin_tk_panel__ping"]);
}

/// 认领 → 回传：模型调用拿到页面回的结果；认领前回传无效。
#[tokio::test]
async fn claim_then_resolve_returns_the_page_result() {
    let (registry, mut events) = registry();
    registry.register(
        &session(),
        register_request("plugin:tk:panel", "scope-1", 1, vec![definition("echo")]),
    );
    let task = tokio::spawn({
        let registry = registry.clone();
        async move {
            registry
                .execute(
                    call_context("plugin:tk:panel", "echo", "scope-1", 1),
                    json!({"text": "hi"}),
                    CancellationToken::new(),
                )
                .await
        }
    });
    let call_id = match events.recv().await.expect("mailbox event") {
        McpUiEvent::AppToolCall {
            call_id,
            tool_name,
            arguments,
            cancelled,
            ..
        } => {
            assert_eq!(tool_name, "echo");
            assert_eq!(arguments.get("text"), Some(&json!("hi")));
            assert!(!cancelled);
            call_id
        }
        other => panic!("{other:?}"),
    };
    assert!(
        !registry.resolve(
            &session(),
            "scope-1",
            1,
            &call_id,
            Ok(json!({"content": []}))
        ),
        "认领之前不能回传"
    );
    assert!(registry.claim(&session(), "scope-1", 1, &call_id));
    assert!(
        registry.claim(&session(), "scope-1", 1, &call_id),
        "重复认领仍为 true"
    );
    let result = json!({"content": [{"type": "text", "text": "done"}]});
    assert!(registry.resolve(&session(), "scope-1", 1, &call_id, Ok(result.clone())));
    assert_eq!(task.await.unwrap().unwrap(), result);
}

/// 页面回错误：模型拿到错误文字，信箱收到 cancelled 收尾通知。
#[tokio::test]
async fn resolving_with_an_error_notifies_the_mailbox() {
    let (registry, mut events) = registry();
    registry.register(
        &session(),
        register_request("plugin:tk:panel", "scope-1", 1, vec![definition("echo")]),
    );
    let task = tokio::spawn({
        let registry = registry.clone();
        async move {
            registry
                .execute(
                    call_context("plugin:tk:panel", "echo", "scope-1", 1),
                    json!({}),
                    CancellationToken::new(),
                )
                .await
        }
    });
    let call_id = match events.recv().await.expect("mailbox event") {
        McpUiEvent::AppToolCall {
            call_id, cancelled, ..
        } => {
            assert!(!cancelled);
            call_id
        }
        other => panic!("{other:?}"),
    };
    assert!(registry.claim(&session(), "scope-1", 1, &call_id));
    assert!(registry.resolve(
        &session(),
        "scope-1",
        1,
        &call_id,
        Err("page failed".to_owned())
    ));
    let error = task.await.unwrap().expect_err("error");
    assert_eq!(error.to_string(), "page failed");
    match events.recv().await.expect("cancelled event") {
        McpUiEvent::AppToolCall {
            call_id: cancelled_id,
            cancelled,
            arguments,
            ..
        } => {
            assert_eq!(cancelled_id, call_id);
            assert!(cancelled);
            assert!(arguments.is_empty());
        }
        other => panic!("{other:?}"),
    }
}

/// 没有人认领：5 秒后按「页面没在运行」结束并注销实例（虚拟时间，不真等）。
#[tokio::test(start_paused = true)]
async fn an_unclaimed_call_times_out_and_drops_the_instance() {
    let (registry, mut events) = registry();
    registry.register(
        &session(),
        register_request("plugin:tk:panel", "scope-1", 1, vec![definition("echo")]),
    );
    let task = tokio::spawn({
        let registry = registry.clone();
        async move {
            registry
                .execute(
                    call_context("plugin:tk:panel", "echo", "scope-1", 1),
                    json!({}),
                    CancellationToken::new(),
                )
                .await
        }
    });
    let _ = events.recv().await.expect("mailbox event");
    let error = task.await.unwrap().expect_err("page not running");
    assert_eq!(
        error.to_string(),
        "The plugin:tk:panel app page is not running"
    );
    assert!(
        registry
            .find(&session(), "app__plugin_tk_panel__echo")
            .is_none(),
        "实例被注销"
    );
}

/// 收回：移除实例、结束待执行调用并回登记数。
#[tokio::test]
async fn unregister_settles_pending_calls() {
    let (registry, mut events) = registry();
    registry.register(
        &session(),
        register_request("plugin:tk:panel", "scope-1", 1, vec![definition("echo")]),
    );
    let task = tokio::spawn({
        let registry = registry.clone();
        async move {
            registry
                .execute(
                    call_context("plugin:tk:panel", "echo", "scope-1", 1),
                    json!({}),
                    CancellationToken::new(),
                )
                .await
        }
    });
    let _ = events.recv().await.expect("mailbox event");
    assert_eq!(registry.unregister(&session(), "scope-1", 1), 1);
    let error = task.await.unwrap().expect_err("closed");
    assert_eq!(error.to_string(), "App page was closed");
    assert!(registry.tools_for(&session()).is_empty());
}

/// 会话关闭：登记与待执行调用一起结束。
#[tokio::test]
async fn clearing_a_session_settles_everything() {
    let (registry, mut events) = registry();
    registry.register(
        &session(),
        register_request("plugin:tk:panel", "scope-1", 1, vec![definition("echo")]),
    );
    let task = tokio::spawn({
        let registry = registry.clone();
        async move {
            registry
                .execute(
                    call_context("plugin:tk:panel", "echo", "scope-1", 1),
                    json!({}),
                    CancellationToken::new(),
                )
                .await
        }
    });
    let _ = events.recv().await.expect("mailbox event");
    registry.clear_session(&session());
    let error = task.await.unwrap().expect_err("closed");
    assert_eq!(error.to_string(), "Session was closed");
    assert!(registry.tools_for(&session()).is_empty());
}

/// 模型名清洗与只读标记。
#[test]
fn model_names_are_sanitized_and_read_only_tools_are_marked() {
    assert_eq!(
        nibi_kernel_api::mcp_ui::app_tool_model_name("plugin:tk:panel", "do/it"),
        "app__plugin_tk_panel__do_it"
    );
    assert_eq!(
        nibi_kernel_api::mcp_ui::sanitize_app_tool_model_part("a//b"),
        "a_b"
    );
    // 与 Node 同一条清洗规则：`!` → `_` 后合并仍是单个 `_`。
    assert_eq!(
        nibi_kernel_api::mcp_ui::sanitize_app_tool_model_part("!!!"),
        "_"
    );
    let (registry, _events) = registry();
    let mut read_only = definition("look");
    read_only.annotations = Some(McpUiAppToolAnnotations {
        read_only_hint: Some(true),
        ..Default::default()
    });
    registry.register(
        &session(),
        register_request("plugin:tk:panel", "scope-1", 1, vec![read_only]),
    );
    let tool = registry
        .find(&session(), "app__plugin_tk_panel__look")
        .expect("exposed");
    assert!(tool.is_read_only(&json!({})));
    assert!(tool.is_concurrency_safe(&json!({})));
}

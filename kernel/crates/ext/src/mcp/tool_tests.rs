//! 工具自己的不延迟标记（docs/specs/rust-cli/ext.md §3.1、D35）：`_meta` 里新旧两个键任一为 true 就不延迟。
use std::sync::{Arc, Weak};

use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::testing::MemoryEnvironment;
use nibi_kernel_api::tool::{Tool, ToolError};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::McpTool;
use crate::test_support::{facts, tool_context};

struct Expired;

impl nibi_kernel_api::paid_plugin::PaidPluginGate for Expired {
    fn is_paid(&self, _plugin: &str) -> bool {
        true
    }

    fn check(&self, _plugin: &str) -> Result<(), String> {
        Err("会员已到期，续费后重试".to_owned())
    }
}

/// 工具表冻结：付费 MCP 工具仍然在表里，执行时门禁拒绝；续费后同一工具直接可用。
#[tokio::test]
async fn a_paid_mcp_tool_stays_in_the_table_but_denies_the_call() {
    let tool = McpTool::from_listed(
        "paid-server",
        &json!({"name": "x", "inputSchema": {"type": "object"}}),
        false,
        Weak::new(),
        Some("math-modeling".to_owned()),
        Some(Arc::new(Expired)),
    )
    .unwrap();
    // 工具仍在注册表里（名字没变），不是“到期就删”。
    assert_eq!(tool.name(), "mcp__paid-server__x");
    let env = Arc::new(MemoryEnvironment::new(facts()));
    let (progress, _ignored) = mpsc::channel(4);
    let error = tool
        .call(
            json!({}),
            tool_context(env, PermissionMode::DontAsk),
            progress,
        )
        .await
        .unwrap_err();
    match error {
        ToolError::Failed { message } => assert!(message.contains("到期"), "{message}"),
        other => panic!("unexpected error {other:?}"),
    }
}

fn always_load(listed: &Value, server_always_load: bool) -> bool {
    McpTool::from_listed("files", listed, server_always_load, Weak::new(), None, None)
        .unwrap()
        .info
        .always_load
}

fn with_meta(meta: Value) -> Value {
    json!({"name": "read", "inputSchema": {"type": "object"}, "_meta": meta})
}

#[test]
fn either_meta_key_keeps_the_tool_loaded() {
    assert!(always_load(
        &with_meta(json!({"zcode/alwaysLoad": true})),
        false
    ));
    // 旧键：Node 与已有的 MCP 服务器用它。
    assert!(always_load(
        &with_meta(json!({"anthropic/alwaysLoad": true})),
        false
    ));
}

#[test]
fn other_values_and_keys_leave_the_tool_deferred() {
    for meta in [
        json!({"anthropic/alwaysLoad": false}),
        json!({"anthropic/alwaysLoad": "true"}),
        json!({"zcode/alwaysLoad": 1}),
        json!({"other/alwaysLoad": true}),
        json!({"alwaysLoad": true}),
        json!(null),
    ] {
        assert!(!always_load(&with_meta(meta.clone()), false), "{meta}");
    }
    assert!(!always_load(&json!({"name": "read"}), false));
}

#[test]
fn the_server_option_does_not_look_at_the_tool() {
    assert!(always_load(&json!({"name": "read"}), true));
    assert!(always_load(
        &with_meta(json!({"anthropic/alwaysLoad": false})),
        true
    ));
}

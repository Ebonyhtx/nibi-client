//! MCP Apps 资源面与可见性的共享类型（141 审计 §9 第 6 项）。

use serde_json::json;

use super::*;

/// 可见性：缺省两者都有；非数组、空数组、非法项都回缺省（Node `readVisibility`）。
#[test]
fn the_tool_visibility_defaults_to_both_audiences() {
    assert_eq!(tool_visibility(None), vec!["model", "app"]);
    assert_eq!(tool_visibility(Some(&json!({}))), vec!["model", "app"]);
    assert_eq!(
        tool_visibility(Some(&json!({"ui": {"visibility": []}}))),
        vec!["model", "app"]
    );
    assert_eq!(
        tool_visibility(Some(&json!({"ui": {"visibility": ["nobody"]}}))),
        vec!["model", "app"]
    );
    assert_eq!(
        tool_visibility(Some(&json!({"ui": {"visibility": ["app"]}}))),
        vec!["app"]
    );
    assert_eq!(
        tool_visibility(Some(&json!({"ui": {"visibility": ["app", "model", "app", 7]}}))),
        vec!["app", "model"]
    );
    assert!(visible_to_model(&["model".to_owned()]));
    assert!(!visible_to_model(&["app".to_owned()]));
    assert!(visible_to_app(&["app".to_owned()]));
    assert!(!visible_to_app(&["model".to_owned()]));
}

/// 资源描述符与内容的 JSON 形状（camelCase；可选字段缺席不写，`_meta` → `meta`）。
#[test]
fn resource_types_serialize_with_camel_case() {
    let descriptor = McpResourceDescriptor {
        uri: "ui://panel.html".to_owned(),
        name: Some("panel".to_owned()),
        title: None,
        description: None,
        mime_type: Some("text/html;profile=mcp-app".to_owned()),
        meta: Some(serde_json::Map::from_iter([("ui".to_owned(), json!({"prefersBorder": true}))])),
    };
    assert_eq!(
        serde_json::to_value(&descriptor).unwrap(),
        json!({
            "uri": "ui://panel.html",
            "name": "panel",
            "mimeType": "text/html;profile=mcp-app",
            "meta": {"ui": {"prefersBorder": true}},
        })
    );
    let content = McpResourceContent {
        uri: "ui://panel.html".to_owned(),
        mime_type: Some("text/html".to_owned()),
        text: Some("<html></html>".to_owned()),
        blob: None,
        meta: None,
    };
    assert_eq!(
        serde_json::to_value(&content).unwrap(),
        json!({"uri": "ui://panel.html", "mimeType": "text/html", "text": "<html></html>"})
    );
}

/// 连接快照的类型（identity 是摘要，generation 是代际）。
#[test]
fn a_connection_snapshot_round_trips() {
    let connection = McpAppConnection {
        identity: "a".repeat(64),
        generation: 3,
    };
    let value = serde_json::to_value(&connection).unwrap();
    assert_eq!(value, json!({"identity": "a".repeat(64), "generation": 3}));
    let back: McpAppConnection = serde_json::from_value(value).unwrap();
    assert_eq!(back, connection);
}

/// 错误文本给用户看（协议层再映射错误码）。
#[test]
fn errors_say_what_failed() {
    assert_eq!(
        McpUiError::not_connected("files").to_string(),
        "MCP server \"files\" is not connected"
    );
    assert_eq!(
        McpUiError::unsupported("files", "resources/subscribe").to_string(),
        "MCP server \"files\" does not support resources/subscribe"
    );
}

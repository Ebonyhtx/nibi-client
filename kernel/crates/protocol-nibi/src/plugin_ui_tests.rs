//! `pluginUi.*` 增量的形状（141 审计 §9 第 6 项）：与 Host `conversationDeltaSchema` 的四个 op 一致。

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::mcp_ui::{McpAppInstance, McpUiEvent, McpUiSubscriber};

use super::*;

fn instance() -> McpAppInstance {
    McpAppInstance {
        runtime_id: "runtime-1".to_owned(),
        generation: 3,
        app_identity: "a".repeat(64),
        token: "token-1".to_owned(),
    }
}

fn subscribers() -> Vec<McpUiSubscriber> {
    vec![McpUiSubscriber {
        scope_id: "token-1".to_owned(),
        generation: 3,
        instance: instance(),
    }]
}

fn subscriber_json() -> Value {
    json!({
        "scopeId": "token-1",
        "generation": 3,
        "instance": {
            "runtimeId": "runtime-1",
            "generation": 3,
            "appIdentity": "a".repeat(64),
            "token": "token-1",
        },
    })
}

/// 资源更新带 `uri`；清单变化与实例关闭不带。
#[test]
fn plugin_ui_events_become_live_deltas() {
    let (session, delta) = split(McpUiEvent::ResourceUpdated {
        session: SessionId::new("s1"),
        plugin_id: "toolkit".to_owned(),
        server: "plugin:toolkit:panel".to_owned(),
        uri: "ui://panel.html".to_owned(),
        subscribers: subscribers(),
    });
    assert_eq!(session.as_str(), "s1");
    assert_eq!(
        delta,
        json!({
            "op": "pluginUi.resourceUpdated",
            "pluginId": "toolkit",
            "serverName": "plugin:toolkit:panel",
            "uri": "ui://panel.html",
            "subscribers": [subscriber_json()],
        })
    );

    let (_, delta) = split(McpUiEvent::ResourceListChanged {
        session: SessionId::new("s1"),
        plugin_id: "toolkit".to_owned(),
        server: "plugin:toolkit:panel".to_owned(),
        subscribers: subscribers(),
    });
    assert_eq!(
        delta,
        json!({
            "op": "pluginUi.resourceListChanged",
            "pluginId": "toolkit",
            "serverName": "plugin:toolkit:panel",
            "subscribers": [subscriber_json()],
        })
    );

    let (_, delta) = split(McpUiEvent::InstanceClosed {
        session: SessionId::new("s1"),
        plugin_id: "toolkit".to_owned(),
        server: "plugin:toolkit:panel".to_owned(),
        subscribers: subscribers(),
    });
    assert_eq!(
        delta,
        json!({
            "op": "pluginUi.instanceClosed",
            "pluginId": "toolkit",
            "serverName": "plugin:toolkit:panel",
            "subscribers": [subscriber_json()],
        })
    );
}

/// AppTool 信箱：待执行调用带 callId/toolName/arguments；收尾通知带 `cancelled` 与空参数。
#[test]
fn app_tool_calls_become_mailbox_deltas() {
    let arguments = json!({"text": "hi"});
    let (_, delta) = split(McpUiEvent::AppToolCall {
        session: SessionId::new("s1"),
        plugin_id: "toolkit".to_owned(),
        server: "plugin:toolkit:panel".to_owned(),
        subscribers: subscribers(),
        call_id: "call-1".to_owned(),
        tool_name: "echo".to_owned(),
        arguments: arguments.as_object().unwrap().clone(),
        cancelled: false,
    });
    assert_eq!(
        delta,
        json!({
            "op": "pluginUi.appToolCall",
            "pluginId": "toolkit",
            "serverName": "plugin:toolkit:panel",
            "subscribers": [subscriber_json()],
            "callId": "call-1",
            "toolName": "echo",
            "arguments": {"text": "hi"},
        })
    );

    let (_, delta) = split(McpUiEvent::AppToolCall {
        session: SessionId::new("s1"),
        plugin_id: "toolkit".to_owned(),
        server: "plugin:toolkit:panel".to_owned(),
        subscribers: subscribers(),
        call_id: "call-1".to_owned(),
        tool_name: "echo".to_owned(),
        arguments: serde_json::Map::new(),
        cancelled: true,
    });
    assert_eq!(delta["cancelled"], json!(true));
    assert_eq!(delta["arguments"], json!({}));
}

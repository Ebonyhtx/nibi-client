//! `pluginUi.*` 增量（MCP Apps，141 审计 §9 第 6 项 F7）。
//!
//! ext 的连接任务把资源通知与实例关闭写成 [`McpUiEvent`]；这里按会话投进它的 live 投影。这些增量
//! **只进 live 帧**：不改快照、不进冷恢复（Host 的 apply 对它们是 no-op），与 Node 的
//! `v4Gateway.ingest` + `sequenceNumber: 0` 同一条路。

use std::sync::Arc;

use nibi_kernel_base::Spawner;
use nibi_kernel_api::mcp_ui::{McpUiEvent, McpUiSubscriber};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::server::Server;

/// 转投任务：通道关闭（ext 释放）时结束。
pub(crate) fn forward(
    server: Arc<Server>,
    spawner: &Spawner,
    mut events: UnboundedReceiver<McpUiEvent>,
) {
    std::mem::drop(spawner.spawn("mcp-ui-events", async move {
        while let Some(event) = events.recv().await {
            let (session, delta) = split(event);
            let Ok(live) = server.live(&session).await else {
                continue;
            };
            live.sink.emit_delta(delta).await;
        }
    }));
}

/// 事件 → （会话, 一条 `pluginUi.*` 增量）。
fn split(event: McpUiEvent) -> (nibi_kernel_api::ids::SessionId, Value) {
    match event {
        McpUiEvent::ResourceUpdated {
            session,
            plugin_id,
            server,
            uri,
            subscribers,
        } => (
            session,
            json!({
                "op": "pluginUi.resourceUpdated",
                "pluginId": plugin_id,
                "serverName": server,
                "uri": uri,
                "subscribers": subscribers.iter().map(subscriber).collect::<Vec<_>>(),
            }),
        ),
        McpUiEvent::ResourceListChanged {
            session,
            plugin_id,
            server,
            subscribers,
        } => (
            session,
            json!({
                "op": "pluginUi.resourceListChanged",
                "pluginId": plugin_id,
                "serverName": server,
                "subscribers": subscribers.iter().map(subscriber).collect::<Vec<_>>(),
            }),
        ),
        McpUiEvent::InstanceClosed {
            session,
            plugin_id,
            server,
            subscribers,
        } => (
            session,
            json!({
                "op": "pluginUi.instanceClosed",
                "pluginId": plugin_id,
                "serverName": server,
                "subscribers": subscribers.iter().map(subscriber).collect::<Vec<_>>(),
            }),
        ),
        McpUiEvent::AppToolCall {
            session,
            plugin_id,
            server,
            subscribers,
            call_id,
            tool_name,
            arguments,
            cancelled,
        } => {
            let mut delta = json!({
                "op": "pluginUi.appToolCall",
                "pluginId": plugin_id,
                "serverName": server,
                "subscribers": subscribers.iter().map(subscriber).collect::<Vec<_>>(),
                "callId": call_id,
                "toolName": tool_name,
                "arguments": arguments,
            });
            if cancelled {
                delta["cancelled"] = json!(true);
            }
            (session, delta)
        }
    }
}

fn subscriber(subscriber: &McpUiSubscriber) -> Value {
    let instance = &subscriber.instance;
    json!({
        "scopeId": subscriber.scope_id,
        "generation": subscriber.generation,
        "instance": {
            "runtimeId": instance.runtime_id,
            "generation": instance.generation,
            "appIdentity": instance.app_identity,
            "token": instance.token,
        },
    })
}

#[cfg(test)]
#[path = "plugin_ui_tests.rs"]
mod tests;

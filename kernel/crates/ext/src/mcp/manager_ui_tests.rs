//! MCP Apps 的数据面（141 审计 §9 第 6 项）：连接身份、资源读取与工具可见性。

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::mcp_ui::{McpUiError, visible_to_app};
use serde_json::json;

use super::*;
use crate::mcp::McpScope;
use crate::test_support::{FakeMcp, Handler, server, workspace};

fn stdio(name: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::Plugin,
        transport: McpTransportConfig::Stdio {
            command: "node".to_owned(),
            args: Vec::new(),
            env: Default::default(),
            cwd: None,
        },
        options: Default::default(),
        machine: None,
    }
}

fn http(name: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::Plugin,
        transport: McpTransportConfig::Http {
            url: "https://mcp.example.invalid/mcp".to_owned(),
            headers: Default::default(),
        },
        options: Default::default(),
        machine: None,
    }
}

fn new_manager(fake: Arc<FakeMcp>, scope: &TaskScope) -> McpManager {
    McpManager::new(
        fake,
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::TokioClock::new(),
    )
}

/// 一个声明了 resources 能力的服务器：列表分页、模板、读取都按 MCP 的形状回答。
fn resources() -> Arc<Handler> {
    server(json!({"resources": {}}), None, |method, params| match method {
        "resources/list" => Some(Ok(if params.get("cursor").is_some() {
            json!({"resources": [{"uri": "file:///b", "name": "b"}]})
        } else {
            json!({
                "resources": [
                    {
                        "uri": "ui://panel.html",
                        "name": "panel",
                        "mimeType": "text/html;profile=mcp-app",
                        "_meta": {"ui": {"prefersBorder": true}},
                    },
                    {"name": "no uri"}
                ],
                "nextCursor": "page-2",
            })
        })),
        "resources/templates/list" => Some(Ok(json!({
            "resourceTemplates": [{"uriTemplate": "file:///{path}", "name": "file"}],
        }))),
        "resources/read" => Some(Ok(json!({
            "contents": [{
                "uri": params["uri"],
                "mimeType": "text/html",
                "text": "<html></html>",
                "_meta": {"ui": {"prefersBorder": false}},
            }],
        }))),
        _ => None,
    })
}

/// 连接身份：配置不变时稳定，换配置时代际加一、身份变；只有已连接的服务器才有。
#[tokio::test]
async fn the_app_connection_tracks_identity_and_generation() {
    let fake = Arc::new(FakeMcp::default().with("files", resources()));
    let scope = TaskScope::root("ui", |_| {});
    let manager = new_manager(fake, &scope);
    assert!(manager.app_connection("files").is_none(), "没连上时没有身份");

    manager.start(workspace(), vec![stdio("files")]);
    manager.wait_ready().await;
    let first = manager.app_connection("files").expect("connected");
    assert_eq!(first.generation, 0);
    assert_eq!(first.identity.len(), 64);

    // 同名同配置再收敛：不换代际、不换身份。
    manager.reconcile(workspace(), vec![stdio("files")]);
    manager.wait_ready().await;
    let same = manager.app_connection("files").expect("connected");
    assert_eq!(same.generation, first.generation);
    assert_eq!(same.identity, first.identity);

    // 换配置（args 变了）：代际加一、身份变。
    let mut changed = stdio("files");
    if let McpTransportConfig::Stdio { args, .. } = &mut changed.transport {
        args.push("--changed".to_owned());
    }
    manager.reconcile(workspace(), vec![changed]);
    manager.wait_ready().await;
    let second = manager.app_connection("files").expect("reconnected");
    assert_eq!(second.generation, first.generation + 1);
    assert_ne!(second.identity, first.identity);

    // 换工作区也换身份。
    let mut elsewhere = workspace();
    elsewhere.root = rust_cli_kernel_api::env::EnvPath::new("/Users/dev/other");
    manager.reconcile(elsewhere, vec![stdio("files")]);
    manager.wait_ready().await;
    assert_ne!(
        manager.app_connection("files").expect("connected").identity,
        second.identity
    );
}

/// 资源读取：列表分页、模板、读取内容（`_meta` 原样保留）。
#[tokio::test]
async fn resources_are_read_with_cursors_and_meta() {
    let fake = Arc::new(FakeMcp::default().with("files", resources()));
    let scope = TaskScope::root("ui", |_| {});
    let manager = new_manager(fake, &scope);
    manager.start(workspace(), vec![stdio("files")]);
    manager.wait_ready().await;

    let page = manager
        .list_resources("files", None)
        .await
        .expect("resources/list");
    assert_eq!(page.resources.len(), 1, "没有 uri 的项丢掉");
    assert_eq!(page.resources[0].uri, "ui://panel.html");
    assert_eq!(
        page.resources[0].mime_type.as_deref(),
        Some("text/html;profile=mcp-app")
    );
    assert_eq!(
        page.resources[0].meta.as_ref().unwrap()["ui"]["prefersBorder"],
        json!(true)
    );
    assert_eq!(page.next_cursor.as_deref(), Some("page-2"));

    let next = manager
        .list_resources("files", Some("page-2"))
        .await
        .expect("resources/list page 2");
    assert_eq!(next.resources[0].uri, "file:///b");
    assert!(next.next_cursor.is_none());

    let templates = manager
        .list_resource_templates("files", None)
        .await
        .expect("templates");
    assert_eq!(templates.resource_templates[0].uri_template, "file:///{path}");

    let contents = manager
        .read_resource("files", "ui://panel.html")
        .await
        .expect("resources/read");
    assert_eq!(contents.len(), 1);
    assert_eq!(contents[0].text.as_deref(), Some("<html></html>"));
    assert_eq!(
        contents[0].meta.as_ref().unwrap()["ui"]["prefersBorder"],
        json!(false)
    );
}

/// 没连上、没有 resources 能力、服务器不认 resources/list：三种错误分开说。
#[tokio::test]
async fn resource_errors_say_which_kind_they_are() {
    let fake = Arc::new(FakeMcp::default());
    let scope = TaskScope::root("ui", |_| {});
    let manager = new_manager(fake.clone(), &scope);
    assert!(matches!(
        manager.list_resources("files", None).await,
        Err(McpUiError::NotConnected { .. })
    ));

    // 只声明了 tools：资源面不可用。
    let tools_only = Arc::new(FakeMcp::default().with(
        "files",
        server(json!({"tools": {}}), None, |method, _| {
            (method == "tools/list").then(|| Ok(json!({"tools": []})))
        }),
    ));
    let manager = new_manager(tools_only, &scope);
    manager.start(workspace(), vec![stdio("files")]);
    manager.wait_ready().await;
    assert!(matches!(
        manager.list_resources("files", None).await,
        Err(McpUiError::Unsupported { .. })
    ));

    // 声明了 resources 但方法不存在（-32601）。
    let stub = Arc::new(FakeMcp::default().with(
        "files",
        server(json!({"resources": {}}), None, |method, _| {
            (method == "resources/list").then(|| Err((-32601, "Method not found".to_owned())))
        }),
    ));
    let manager = new_manager(stub, &scope);
    manager.start(workspace(), vec![http("files")]);
    manager.wait_ready().await;
    assert!(matches!(
        manager.list_resources("files", None).await,
        Err(McpUiError::Unsupported { .. })
    ));
}

/// 可见性：`_meta.ui.visibility` 含 model 的才进模型工具表；app-only 的工具仍记着可见性。
#[tokio::test]
async fn app_only_tools_stay_out_of_the_model_table() {
    let fake = Arc::new(FakeMcp::default().with(
        "files",
        server(json!({"tools": {}}), None, |method, _| match method {
            "tools/list" => Some(Ok(json!({"tools": [
                {"name": "visible", "inputSchema": {"type": "object"}},
                {
                    "name": "app_only",
                    "inputSchema": {"type": "object"},
                    "_meta": {"ui": {"visibility": ["app"]}},
                }
            ]}))),
            _ => None,
        }),
    ));
    let scope = TaskScope::root("ui", |_| {});
    let manager = new_manager(fake, &scope);
    manager.start(workspace(), vec![stdio("files")]);
    manager.wait_ready().await;

    let names: Vec<String> = manager.tools().iter().map(|tool| tool.name().to_owned()).collect();
    assert_eq!(names, vec!["mcp__files__visible"]);
    assert!(manager.find("mcp__files__app_only").is_none());
    // 服务器列出的工具数仍算全部（`/mcp` 的口径）。
    assert_eq!(manager.server_infos()[0].tools, 2);
    assert_eq!(
        manager.app_tool_visibility("files", "app_only"),
        Some(vec!["app".to_owned()])
    );
    assert!(visible_to_app(
        &manager.app_tool_visibility("files", "app_only").unwrap()
    ));
    assert_eq!(
        manager.app_tool_visibility("files", "visible"),
        Some(vec!["model".to_owned(), "app".to_owned()])
    );
    assert!(manager.app_tool_visibility("files", "missing").is_none());
}

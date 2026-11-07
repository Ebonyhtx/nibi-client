//! `workspace/generateText` / `workspace/cancelGenerateText` 的协议面。
//!
//! 断言三件事：参数 → 内核请求的映射（role/content/toolCalls/tools 逐项）、结果 → NIBI 的
//! `modelSelectionSchema` 形状、以及 Node 的容器语义（`operationId` 唯一、取消按 id 只命中一条）。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::generate_text::{GenerateTextReply, GenerateTextRequest, GeneratedToolCall};
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::message::{ContentBlock, StopReason, ToolResultContent, Usage};
use nibi_kernel_api::model::{ApiRole, ModelSelection};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Kernel, KernelError};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

struct FakeKernel {
    reply: Mutex<Option<GenerateTextReply>>,
    requests: Mutex<Vec<GenerateTextRequest>>,
    /// true：请求一直挂着等取消（`operationId` / cancel 用例）。
    wait_for_cancel: bool,
}

impl FakeKernel {
    fn new(reply: Option<GenerateTextReply>) -> Self {
        Self {
            reply: Mutex::new(reply),
            requests: Mutex::new(Vec::new()),
            wait_for_cancel: false,
        }
    }

    fn waiting(mut self) -> Self {
        self.wait_for_cancel = true;
        self
    }

    fn requests(&self) -> Vec<GenerateTextRequest> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[async_trait]
impl Kernel for FakeKernel {
    async fn create_session(
        &self,
        _request: nibi_kernel_api::session_api::CreateSession,
    ) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "session creation".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn nibi_kernel_api::session_api::SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "session".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: nibi_kernel_api::store::SessionFilter,
    ) -> Result<Vec<nibi_kernel_api::store::SessionSummary>, KernelError> {
        Err(KernelError::Unsupported {
            what: "sessions".to_owned(),
        })
    }

    async fn generate_text(
        &self,
        request: GenerateTextRequest,
        cancel: CancellationToken,
    ) -> Result<GenerateTextReply, KernelError> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(request);
        if self.wait_for_cancel {
            cancel.cancelled().await;
            return Err(KernelError::Failed {
                message: "cancelled".to_owned(),
            });
        }
        let reply = self
            .reply
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .expect("the fake kernel has one reply per call");
        Ok(reply)
    }
}

fn server_for(kernel: Arc<FakeKernel>) -> Arc<Server> {
    let scope = TaskScope::root("workspace-generate-text-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> = Arc::new(FixedClock);
    Arc::new(Server::new(
        Arc::new(Context::new(peer, clock)),
        kernel,
        scope.spawner(),
        Defaults {
            selection: ModelSelection {
                provider: "p".into(),
                model: "m".into(),
                reasoning: None,
                connection: None,
            },
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ))
}

struct FixedClock;

impl nibi_kernel_api::clock::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        1_760_000_000_000
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

fn reply() -> GenerateTextReply {
    GenerateTextReply {
        text: "feat: add the thing".into(),
        tool_calls: Vec::new(),
        stop_reason: Some(StopReason::EndTurn),
        usage: Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Usage::default()
        },
        selection: ModelSelection {
            provider: "p".into(),
            model: "m".into(),
            reasoning: Some("low".into()),
            connection: None,
        },
    }
}

fn base_params() -> Value {
    json!({
        "workspace": {"workspacePath": "/w/app", "workspaceKey": "/w/app"},
        "selection": {"providerId": "p", "modelId": "m", "options": {"reasoningLevel": "high"}},
        "querySource": "git_commit_message",
    })
}

async fn generate(server: &Arc<Server>, params: Value) -> Result<Value, RpcError> {
    Handler(server.clone())
        .request("workspace/generateText", params)
        .await
        .map(|reply| reply.result)
}

use nibi_kernel_protocol_core::rpc::RpcError;

#[tokio::test]
async fn a_prompt_becomes_one_user_message_and_the_result_keeps_the_wire_shape() {
    let kernel = Arc::new(FakeKernel::new(Some(reply())));
    let server = server_for(kernel.clone());
    let mut params = base_params();
    params["prompt"] = json!("write a commit message");

    let result = generate(&server, params).await.unwrap();

    assert_eq!(result["text"], "feat: add the thing");
    assert_eq!(result["selection"]["providerId"], "p");
    assert_eq!(result["selection"]["modelId"], "m");
    // 内核返回的生效档位（辅助档换成最低档）要带回给 Host。
    assert_eq!(result["selection"]["options"]["reasoningLevel"], "low");
    assert_eq!(result["finishReason"], "end_turn");
    assert_eq!(result["usage"]["inputTokens"], 10);
    assert_eq!(result["usage"]["totalTokens"], 15);

    let requests = kernel.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].source.node_name(), "git_commit_message");
    assert_eq!(requests[0].messages.len(), 1);
    assert_eq!(requests[0].messages[0].role, ApiRole::User);
    assert_eq!(
        requests[0].messages[0].content[0].block,
        ContentBlock::Text {
            text: "write a commit message".into()
        }
    );
    assert!(requests[0].tools.is_empty());
}

#[tokio::test]
async fn messages_and_tools_map_onto_the_kernel_request() {
    let kernel = Arc::new(FakeKernel::new(Some(reply())));
    let server = server_for(kernel.clone());
    let mut params = base_params();
    params["messages"] = json!([
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "diff follows"},
        {"role": "assistant", "content": "checking", "toolCalls": [
            {"id": "toolu_1", "name": "Bash", "input": {"command": "git diff"}}
        ]},
        {"role": "tool", "content": "diff --git a/x b/x", "toolCallId": "toolu_1", "toolName": "Bash"}
    ]);
    params["tools"] = json!([
        {"name": "Bash", "description": "run a command", "inputSchema": {"type": "object"}}
    ]);
    params["maxOutputTokens"] = json!(2048);

    generate(&server, params).await.unwrap();

    let requests = kernel.requests();
    let request = &requests[0];
    assert_eq!(request.system.len(), 1);
    assert_eq!(request.system[0].text, "be brief");
    assert_eq!(request.messages.len(), 3);
    assert_eq!(request.messages[1].role, ApiRole::Assistant);
    assert!(matches!(
        request.messages[1].content[1].block,
        ContentBlock::ToolUse { .. }
    ));
    // 工具结果在 Anthropic 形状里挂在 user 消息上。
    assert_eq!(request.messages[2].role, ApiRole::User);
    assert!(matches!(
        &request.messages[2].content[0].block,
        ContentBlock::ToolResult { content, .. }
            if content == &vec![ToolResultContent::Text {
                text: "diff --git a/x b/x".into()
            }]
    ));
    assert_eq!(request.tools[0].name, "Bash");
    assert_eq!(request.tools[0].description, "run a command");
    assert_eq!(request.max_tokens, Some(2048));
}

#[tokio::test]
async fn tool_calls_in_the_reply_are_projected_back() {
    let mut reply = reply();
    reply.tool_calls = vec![GeneratedToolCall {
        id: "toolu_1".into(),
        name: "Bash".into(),
        input: json!({"command": "git diff"}),
    }];
    let kernel = Arc::new(FakeKernel::new(Some(reply)));
    let server = server_for(kernel);
    let mut params = base_params();
    params["prompt"] = json!("hi");

    let result = generate(&server, params).await.unwrap();

    assert_eq!(result["toolCalls"][0]["id"], "toolu_1");
    assert_eq!(result["toolCalls"][0]["name"], "Bash");
    assert_eq!(result["toolCalls"][0]["input"]["command"], "git diff");
}

#[tokio::test]
async fn an_active_operation_id_cannot_be_reused() {
    let kernel = Arc::new(FakeKernel::new(None).waiting());
    let server = server_for(kernel);
    let mut params = base_params();
    params["prompt"] = json!("hi");
    params["operationId"] = json!("op-1");

    let first = {
        let server = server.clone();
        let params = params.clone();
        tokio::spawn(async move { generate(&server, params).await })
    };
    wait_until_active(&server, "op-1").await;

    let error = generate(&server, params.clone()).await.unwrap_err();
    assert_eq!(error.code, -32600);
    assert!(error.message.contains("already active"));

    // 收尾：取消第一条，避免测试里的任务一直悬着。
    let cancelled = Handler(server.clone())
        .request(
            "workspace/cancelGenerateText",
            json!({"operationId": "op-1"}),
        )
        .await
        .unwrap();
    assert_eq!(cancelled.result["cancelled"], true);
    assert!(first.await.unwrap().is_err());
}

#[tokio::test]
async fn cancel_reports_whether_the_operation_was_active() {
    let kernel = Arc::new(FakeKernel::new(None).waiting());
    let server = server_for(kernel);

    let unknown = Handler(server.clone())
        .request(
            "workspace/cancelGenerateText",
            json!({"operationId": "missing"}),
        )
        .await
        .unwrap();
    assert_eq!(unknown.result, json!({"operationId": "missing", "cancelled": false}));

    let mut params = base_params();
    params["prompt"] = json!("hi");
    params["operationId"] = json!("op-2");
    let pending = {
        let server = server.clone();
        let params = params.clone();
        tokio::spawn(async move { generate(&server, params).await })
    };
    wait_until_active(&server, "op-2").await;

    let active = Handler(server.clone())
        .request(
            "workspace/cancelGenerateText",
            json!({"operationId": "op-2"}),
        )
        .await
        .unwrap();
    assert_eq!(active.result["cancelled"], true);
    assert!(pending.await.unwrap().is_err());
}

/// 等第一条请求登记进注册表（避免用固定 sleep 猜时序）。
async fn wait_until_active(server: &Arc<Server>, operation_id: &str) {
    for _ in 0..200 {
        let active = server
            .generate_operations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(operation_id);
        if active {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("operation {operation_id} never became active");
}

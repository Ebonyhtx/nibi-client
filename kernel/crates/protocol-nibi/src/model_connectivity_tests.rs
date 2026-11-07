//! `provider/testModelConnectivity`：一次 1 token 的探测请求、成功形状、失败原因原样回报。
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nibi_kernel_api::generate_text::{GenerateTextReply, GenerateTextRequest};
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Kernel, KernelError};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};
use nibi_kernel_protocol_core::rpc::RpcError;

struct FakeKernel {
    requests: Mutex<Vec<GenerateTextRequest>>,
    failure: Option<String>,
}

impl FakeKernel {
    fn new(failure: Option<&str>) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            failure: failure.map(str::to_owned),
        })
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
    ) -> Result<nibi_kernel_api::ids::SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "session creation".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &nibi_kernel_api::ids::SessionId,
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
        _cancel: CancellationToken,
    ) -> Result<GenerateTextReply, KernelError> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(request);
        if let Some(message) = &self.failure {
            return Err(KernelError::Failed {
                message: message.clone(),
            });
        }
        Ok(GenerateTextReply {
            text: String::new(),
            tool_calls: Vec::new(),
            stop_reason: None,
            usage: Default::default(),
            selection: ModelSelection {
                provider: "p".into(),
                model: "m".into(),
                reasoning: None,
                connection: None,
            },
        })
    }
}

fn server_for(kernel: Arc<FakeKernel>) -> Arc<Server> {
    let scope = TaskScope::root("model-connectivity-test", |_| {});
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

fn params() -> Value {
    json!({
        "workspace": {"workspacePath": "/w/app", "workspaceKey": "/w/app"},
        "selection": {"providerId": "p", "modelId": "m", "options": {"reasoningLevel": "high"}},
    })
}

async fn call(server: &Arc<Server>, params: Value) -> Result<Value, RpcError> {
    Handler(server.clone())
        .request("provider/testModelConnectivity", params)
        .await
        .map(|reply| reply.result)
}

#[tokio::test]
async fn the_probe_is_one_minimal_token() {
    let kernel = FakeKernel::new(None);
    let server = server_for(kernel.clone());
    let result = call(&server, params()).await.unwrap();
    assert_eq!(result, json!({"success": true}));
    let requests = kernel.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.max_tokens, Some(1));
    assert_eq!(request.system[0].text, "You are NIBI connectivity probe.");
    assert_eq!(request.selection.provider, "p");
    assert_eq!(request.selection.model, "m");
    match &request.source {
        nibi_kernel_api::model::QuerySource::Side(name) => {
            assert_eq!(name, "provider_settings_connectivity")
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_failure_is_reported_as_the_kernel_error() {
    let kernel = FakeKernel::new(Some("401 invalid api key"));
    let server = server_for(kernel);
    let error = call(&server, params()).await.unwrap_err();
    assert!(error.to_string().contains("401"), "{error}");
}

#[tokio::test]
async fn a_missing_selection_is_invalid_params() {
    let kernel = FakeKernel::new(None);
    let server = server_for(kernel.clone());
    let error = call(&server, json!({"workspace": {"workspacePath": "/w"}}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("selection"), "{error}");
    assert!(kernel.requests().is_empty());
}

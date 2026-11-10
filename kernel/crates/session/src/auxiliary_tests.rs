//! 旁路辅助补全的请求形状（kernel-api `auxiliary`；Node `generateLiteExtraction`）。
use async_trait::async_trait;
use nibi_kernel_api::provider::{CatalogModel, ModelCatalog, WireProtocol};
use nibi_kernel_api::testing::{selection, text_response, ScriptedModel};
use tokio_util::sync::CancellationToken;

use super::*;

/// 只有会话模型一项的目录；字段是这个模型配置的输出上限。
struct Directory(u64);

#[async_trait]
impl ModelDirectory for Directory {
    async fn catalog(&self) -> ModelCatalog {
        let main = selection();
        ModelCatalog {
            revision: 1,
            models: vec![CatalogModel {
                capabilities: Default::default(),
                provider: main.provider.clone(),
                provider_name: "Test".to_owned(),
                model: main.model,
                protocol: WireProtocol::AnthropicMessages,
                reasoning_levels: vec!["off".to_owned(), "high".to_owned()],
                context_window: 200_000,
                max_output_tokens: self.0,
                connection: None,
            }],
            default: None,
        }
    }
}

fn request() -> AuxiliaryTextRequest {
    AuxiliaryTextRequest {
        system: "extract".to_owned(),
        user: "material".to_owned(),
        max_tokens: 6_000,
        source: "read_session_context_extract".to_owned(),
        cancel: CancellationToken::new(),
    }
}

#[tokio::test]
async fn the_request_uses_the_session_model_and_the_auxiliary_options() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&[
        "note one, ",
        "note two",
    ])]));
    let text = generate(
        model.clone(),
        Some(Arc::new(Directory(4_096))),
        selection(),
        request(),
        &SessionId::new("sess_1"),
    )
    .await
    .unwrap();
    assert_eq!(text, "note one, note two");
    let request = &model.requests()[0];
    // 辅助档：推理档位取目录的第一个，输出上限按目录收窄（Node `auxiliaryModelOptions`）。
    assert_eq!(request.selection.reasoning.as_deref(), Some("off"));
    assert_eq!(request.max_tokens, 4_096);
    assert_eq!(request.options.provider_max_output_tokens, Some(4_096));
    assert_eq!(
        request.source,
        QuerySource::Side("read_session_context_extract".to_owned())
    );
    assert_eq!(request.options.session_id, Some(SessionId::new("sess_1")));
    assert_eq!(request.system[0].text, "extract");
    let ContentBlock::Text { text } = &request.messages[0].content[0].block else {
        panic!("text expected");
    };
    assert_eq!(text, "material");
    assert!(request.tools.is_empty());
}

/// 没有目录（`-p`）时不改推理档位与预算。
#[tokio::test]
async fn without_a_directory_the_request_keeps_its_budget() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let text = generate(
        model.clone(),
        None,
        selection(),
        request(),
        &SessionId::new("sess_1"),
    )
    .await
    .unwrap();
    assert_eq!(text, "ok");
    let request = &model.requests()[0];
    assert_eq!(request.max_tokens, 6_000);
    assert_eq!(request.selection, selection());
}

// ---- 会话内的整条链路：工具经 sink 请 actor 起辅助补全，结果回到工具 ----

use std::time::Duration;

use futures_util::StreamExt;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{CommandId, EnvironmentId, Generation, TraceId};
use nibi_kernel_api::message::ToolResultContent;
use nibi_kernel_api::session_api::{
    Command, CommandEnvelope, Delivery, KernelEvent, SessionHandle, StartSource,
};
use nibi_kernel_api::store::{SessionKind, SessionMeta, SessionStore};
use nibi_kernel_api::testing::{
    local_services, machine, tool_use_response, DirectExecutor, FixedClock, FixedContext,
    ListTools, MemoryArtifacts, MemoryStore, NeverCompact, NoHooks, SequentialIds,
    UnusedEnvironment,
};
use nibi_kernel_api::tool::{PromptContext, Tool, ToolError, ToolOutput, ToolProgress};
use nibi_kernel_base::TaskScope;
use nibi_kernel_query::{QueryLoop, QueryParts};
use serde_json::{json, Value};

use crate::{Opened, Session, SessionDeps, SessionState, TitleModel};

/// 工具里发一次辅助补全，把结果原样放进 tool_result。
struct AuxTool;

#[async_trait]
impl Tool for AuxTool {
    fn name(&self) -> &str {
        "Aux"
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }

    fn description(&self, _context: &PromptContext) -> String {
        String::new()
    }

    async fn call(
        &self,
        _input: Value,
        context: nibi_kernel_api::tool::ToolUseContext,
        _progress: tokio::sync::mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let answer = context
            .interactions
            .auxiliary_text(&context.session, request())
            .await
            .map_err(|error| ToolError::Failed {
                message: error.to_string(),
            })?;
        Ok(ToolOutput {
            content: vec![ToolResultContent::Text {
                text: format!("{answer:?}"),
            }],
            is_error: false,
            display: Value::Null,
        })
    }
}

fn meta() -> SessionMeta {
    SessionMeta {
        id: SessionId::new("sess_1"),
        kind: SessionKind::Interactive,
        parent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/work"),
        },
        title: String::new(),
        trace: TraceId::new("trace_1"),
        created_at_ms: 0,
    }
}

fn spawn(
    scope: &TaskScope,
    store: &Arc<MemoryStore>,
    main: Arc<dyn ModelPort>,
    aux: Arc<ScriptedModel>,
) -> Session {
    let ids = Arc::new(SequentialIds::default());
    let env = Arc::new(UnusedEnvironment);
    let runner = Arc::new(QueryLoop::new(QueryParts {
        model: main,
        context: Arc::new(FixedContext(Vec::new())),
        tools: Arc::new(ListTools(vec![Arc::new(AuxTool)])),
        executor: Arc::new(DirectExecutor),
        compactor: Arc::new(NeverCompact),
        hooks: Arc::new(NoHooks),
        ids: ids.clone(),
        clock: Arc::new(FixedClock(0)),
        machines: nibi_kernel_api::testing::environments(env.clone()),
        machine: machine(env.clone()),
        local: local_services(env),
        artifacts: store.clone(),
        generation: Generation::new("g1"),
        non_interactive: false,
        limits: nibi_kernel_query::RequestLimits::default(),
    }));
    let env = Arc::new(UnusedEnvironment);
    Session::spawn(
        SessionDeps {
            agents: Arc::new(nibi_kernel_api::agents::NoAgentSignals),
            cron: Arc::new(nibi_kernel_api::cron::NoCron),
            store: store.clone(),
            ids,
            runner,
            compactor: Arc::new(NeverCompact),
            machines: nibi_kernel_api::testing::environments(env.clone()),
            machine: machine(env.clone()),
            local: local_services(env),
            max_turns: None,
            hooks: Arc::new(NoHooks),
            commands: Arc::new(nibi_kernel_api::user_command::NoUserCommands),
            inputs: Arc::new(nibi_kernel_api::user_input::NoUserInputs),
            artifacts: Arc::new(MemoryArtifacts::default()),
            clock: Arc::new(FixedClock(0)),
            generation: Generation::new("g1"),
            spawner: scope.spawner(),
            closing: scope.spawner(),
            titles: Some(TitleModel {
                model: aux.clone(),
                directory: Some(Arc::new(Directory(4_096))),
            }),
            side_model: aux,
            released: Arc::new(crate::NothingToRelease),
            directory_rules: Arc::new(nibi_kernel_api::orchestration::NoDirectoryRules),
            peers: crate::PeerDeps::off(),
            detached: None,
            blocked: None,
            context_usage: None,
            memory: None,
            workflow_activation: None,
        },
        SessionState {
            meta: meta(),
            messages: Vec::new(),
            earlier: Vec::new(),
            selection: selection(),
            mode: Default::default(),
            checkpoints: Vec::new(),
            start: StartSource::Startup,
            turn: None,
            last_turn_failed: false,
            launches: Vec::new(),
            model_turns: Vec::new(),
            input_intents: Vec::new(),
            draft: false,
        },
        Opened::Created,
    )
}

#[tokio::test]
async fn a_tool_gets_the_auxiliary_text_from_the_session_actor() {
    let scope = TaskScope::root("test", |_| {});
    let store = Arc::new(MemoryStore::default());
    store.create(meta()).await.unwrap();
    let main = Arc::new(ScriptedModel::new(vec![
        tool_use_response("toolu_aux", "Aux", &json!({})),
        text_response(&["done"]),
    ]));
    let aux = Arc::new(ScriptedModel::new(vec![text_response(&[
        "extracted ",
        "notes",
    ])]));
    let session = spawn(&scope, &store, main, aux.clone());
    let mut events = session.subscribe(Some(0));
    session
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::Submit {
                text: "go".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
            .unwrap()
            .event;
        if matches!(event, KernelEvent::TurnFinished { .. }) {
            break;
        }
    }
    // 辅助模型收到一次请求，选择与会话主模型一致、预算按目录收窄。
    let requests = aux.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].selection.provider, selection().provider);
    assert_eq!(requests[0].selection.model, selection().model);
    assert_eq!(requests[0].selection.reasoning.as_deref(), Some("off"));
    assert_eq!(requests[0].max_tokens, 4_096);
    assert_eq!(
        requests[0].source,
        QuerySource::Side("read_session_context_extract".to_owned())
    );
    // 工具结果拿到的是辅助模型的正文（不是本地结果）。
    let view = session.view().await.unwrap();
    let messages = format!("{:?}", view.messages);
    assert!(messages.contains("extracted notes"), "{messages}");
}

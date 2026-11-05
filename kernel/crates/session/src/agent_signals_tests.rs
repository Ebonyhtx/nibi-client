//! 子代理的信号：后台子代理的通知空闲时开新回合、提交后才 ack、重复送达只 ack；任务清单变化变成
//! `TasksChanged`；后台子代理算在 `view.background` 里（docs/specs/rust-cli/agents.md §5）。

use std::sync::Mutex;

use async_trait::async_trait;
use nibi_kernel_api::agents::{AgentNotice, AgentSignal, AgentSignals};
use nibi_kernel_api::ids::{AgentId, ShellTaskId, ToolUseId};
use nibi_kernel_api::message::{ContentBlock, Message, UserOrigin};
use nibi_kernel_api::testing::{local_services, machine};
use serde_json::json;
use tokio::sync::mpsc;

use super::*;

/// 信号由测试推送；记下 ack；后台子代理列表由测试设定。
struct FakeSignals {
    receiver: Mutex<Option<mpsc::UnboundedReceiver<AgentSignal>>>,
    acked: Mutex<Vec<u64>>,
    background: Mutex<Vec<AgentId>>,
}

#[async_trait]
impl AgentSignals for FakeSignals {
    fn signals(&self, _session: &SessionId) -> BoxStream<'static, AgentSignal> {
        let receiver = self.receiver.lock().unwrap().take().unwrap();
        stream::unfold(receiver, |mut receiver| async move {
            receiver.recv().await.map(|signal| (signal, receiver))
        })
        .boxed()
    }

    async fn ack(&self, _session: &SessionId, seq: u64) {
        self.acked.lock().unwrap().push(seq);
        self.background.lock().unwrap().clear();
    }

    async fn background(&self, _session: &SessionId) -> Vec<AgentId> {
        self.background.lock().unwrap().clone()
    }
}

fn notice(seq: u64) -> AgentSignal {
    AgentSignal::Notice(AgentNotice {
        seq,
        agent: AgentId::new("agent_1"),
        status: "completed".to_owned(),
        text: "<system-reminder>\nagent done\n</system-reminder>".to_owned(),
        origin_meta: None,
    })
}

#[tokio::test]
async fn an_agent_notice_starts_a_turn_and_is_acked_after_the_commit() {
    let scope = TaskScope::root("test", |_| {});
    let (sender, receiver) = mpsc::unbounded_channel();
    let signals = Arc::new(FakeSignals {
        receiver: Mutex::new(Some(receiver)),
        acked: Mutex::default(),
        background: Mutex::new(vec![AgentId::new("agent_1")]),
    });
    let store = Arc::new(MemoryStore::default());
    store.create(meta()).await.unwrap();
    let ids = Arc::new(SequentialIds::default());
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["noted"])]));
    let env = Arc::new(UnusedEnvironment);
    let runner = Arc::new(QueryLoop::new(QueryParts {
        model,
        context: Arc::new(FixedContext(Vec::new())),
        tools: Arc::new(NoTools),
        executor: Arc::new(FailingExecutor),
        compactor: Arc::new(NeverCompact),
        hooks: Arc::new(NoHooks),
        ids: ids.clone(),
        clock: Arc::new(nibi_kernel_api::testing::FixedClock(0)),
        machines: nibi_kernel_api::testing::environments(env.clone()),
        machine: machine(env.clone()),
        local: local_services(env),
        artifacts: store.clone(),
        generation: Generation::new("g1"),
        non_interactive: false,
        limits: nibi_kernel_query::RequestLimits::default(),
    }));
    let env = Arc::new(UnusedEnvironment);
    let session = Session::spawn(
        SessionDeps {
            agents: signals.clone(),
            cron: Arc::new(nibi_kernel_api::cron::NoCron),
            store,
            ids,
            runner,
            compactor: Arc::new(nibi_kernel_api::testing::NeverCompact),
            machines: nibi_kernel_api::testing::environments(env.clone()),
            machine: machine(env.clone()),
            local: local_services(env),
            max_turns: None,
            hooks: Arc::new(nibi_kernel_api::testing::NoHooks),
            commands: Arc::new(nibi_kernel_api::user_command::NoUserCommands),
            inputs: Arc::new(nibi_kernel_api::user_input::NoUserInputs),
            artifacts: Arc::new(nibi_kernel_api::testing::MemoryArtifacts::default()),
            clock: Arc::new(nibi_kernel_api::testing::FixedClock(0)),
            generation: nibi_kernel_api::ids::Generation::new("g1"),
            spawner: scope.spawner(),
            closing: scope.spawner(),
            titles: None,
            side_model: Arc::new(nibi_kernel_api::testing::ScriptedModel::new(Vec::new())),
            released: Arc::new(crate::NothingToRelease),
            directory_rules: Arc::new(nibi_kernel_api::orchestration::NoDirectoryRules),
            peers: crate::PeerDeps::off(),
            detached: None,
            blocked: None,
        },
        SessionState {
            meta: meta(),
            messages: Vec::new(),
            earlier: Vec::new(),
            selection: selection(),
            mode: PermissionMode::Default.into(),
            checkpoints: Vec::new(),
            start: nibi_kernel_api::session_api::StartSource::Startup,
            turn: None,
            last_turn_failed: false,
            launches: Vec::new(),
            model_turns: Vec::new(),
            draft: false,
        },
        Opened::Loaded,
    );
    let view = session.view().await.unwrap();
    assert_eq!(view.background, [ShellTaskId::new("agent_1")]);
    let mut events = session.subscribe(Some(0));
    sender
        .send(AgentSignal::TasksChanged {
            tasks: json!([{"id": "1"}]),
        })
        .unwrap();
    sender.send(notice(1)).unwrap();
    let seen = until_finished(&mut events, 1).await;
    assert!(seen.iter().any(
        |event| matches!(event, KernelEvent::TasksChanged { tasks } if tasks[0]["id"] == "1")
    ));
    assert!(seen.iter().any(|event| matches!(
        event,
        KernelEvent::BackgroundWork { work, status } if work == "agent_1" && status == "completed"
    )));
    assert_eq!(*signals.acked.lock().unwrap(), [1]);
    // 重复送达：对话里已有同文本的 meta 消息，只 ack，不开回合。
    sender.send(notice(1)).unwrap();
    let view = loop {
        let view = session.view().await.unwrap();
        if signals.acked.lock().unwrap().len() == 2 {
            break view;
        }
        tokio::task::yield_now().await;
    };
    let notices: Vec<&Message> = view
        .messages
        .iter()
        .filter(|message| matches!(message, Message::User(user) if user.origin == UserOrigin::Meta { origin_meta: None, source: "task-notification".to_owned() }))
        .collect();
    assert_eq!(notices.len(), 1);
    assert!(
        matches!(notices[0], Message::User(user) if matches!(user.content.as_slice(), [ContentBlock::Text { text }] if text.contains("agent done")))
    );
    assert!(view.background.is_empty());
}

/// 子代理的生命周期信号 → `KernelEvent::Subagent`。
///
/// 这是 `v4/telemetry/event` 的 `subagent.lifecycle` 事实的唯一来源：那条映射代码一直在，但在接上
/// 这个生产者之前，运行期一次都没触发过（内核里没有任何地方发 `KernelEvent::Subagent`）。
#[tokio::test]
async fn a_subagent_lifecycle_signal_becomes_a_kernel_event() {
    let scope = TaskScope::root("test", |_| {});
    let (sender, receiver) = mpsc::unbounded_channel();
    let signals = Arc::new(FakeSignals {
        receiver: Mutex::new(Some(receiver)),
        acked: Mutex::default(),
        background: Mutex::default(),
    });
    let store = Arc::new(MemoryStore::default());
    store.create(meta()).await.unwrap();
    let ids = Arc::new(SequentialIds::default());
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["noted"])]));
    let env = Arc::new(UnusedEnvironment);
    let runner = Arc::new(QueryLoop::new(QueryParts {
        model,
        context: Arc::new(FixedContext(Vec::new())),
        tools: Arc::new(NoTools),
        executor: Arc::new(FailingExecutor),
        compactor: Arc::new(NeverCompact),
        hooks: Arc::new(NoHooks),
        ids: ids.clone(),
        clock: Arc::new(nibi_kernel_api::testing::FixedClock(0)),
        machines: nibi_kernel_api::testing::environments(env.clone()),
        machine: machine(env.clone()),
        local: local_services(env),
        artifacts: store.clone(),
        generation: Generation::new("g1"),
        non_interactive: false,
        limits: nibi_kernel_query::RequestLimits::default(),
    }));
    let env = Arc::new(UnusedEnvironment);
    let session = Session::spawn(
        SessionDeps {
            agents: signals.clone(),
            cron: Arc::new(nibi_kernel_api::cron::NoCron),
            store,
            ids,
            runner,
            compactor: Arc::new(nibi_kernel_api::testing::NeverCompact),
            machines: nibi_kernel_api::testing::environments(env.clone()),
            machine: machine(env.clone()),
            local: local_services(env),
            max_turns: None,
            hooks: Arc::new(nibi_kernel_api::testing::NoHooks),
            commands: Arc::new(nibi_kernel_api::user_command::NoUserCommands),
            inputs: Arc::new(nibi_kernel_api::user_input::NoUserInputs),
            artifacts: Arc::new(nibi_kernel_api::testing::MemoryArtifacts::default()),
            clock: Arc::new(nibi_kernel_api::testing::FixedClock(0)),
            generation: nibi_kernel_api::ids::Generation::new("g1"),
            spawner: scope.spawner(),
            closing: scope.spawner(),
            titles: None,
            side_model: Arc::new(nibi_kernel_api::testing::ScriptedModel::new(Vec::new())),
            released: Arc::new(crate::NothingToRelease),
            directory_rules: Arc::new(nibi_kernel_api::orchestration::NoDirectoryRules),
            peers: crate::PeerDeps::off(),
            detached: None,
            blocked: None,
        },
        SessionState {
            meta: meta(),
            messages: Vec::new(),
            earlier: Vec::new(),
            selection: selection(),
            mode: PermissionMode::Default.into(),
            checkpoints: Vec::new(),
            start: nibi_kernel_api::session_api::StartSource::Startup,
            turn: None,
            last_turn_failed: false,
            launches: Vec::new(),
            model_turns: Vec::new(),
            draft: false,
        },
        Opened::Loaded,
    );
    let mut events = session.subscribe(Some(0));
    for (tool_use, phase) in [
        (
            Some(ToolUseId::new("toolu_1")),
            nibi_kernel_api::agents::SubagentLifecyclePhase::Spawned,
        ),
        (None, nibi_kernel_api::agents::SubagentLifecyclePhase::Done),
    ] {
        sender
            .send(AgentSignal::Subagent {
                agent: AgentId::new("agent_1"),
                child: SessionId::new("sess_child"),
                tool_use,
                phase,
            })
            .unwrap();
    }
    // 收到两条 Subagent 事件为止（其余事件不关心）。
    let mut spawned = Vec::new();
    while spawned.len() < 2 {
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), events.next())
            .await
            .expect("the session event stream stalled")
            .expect("the session event stream ended");
        if let KernelEvent::Subagent {
            agent,
            phase,
            child,
            parent_tool_use,
        } = event.event
        {
            spawned.push((
                agent.as_str().to_owned(),
                phase,
                child.as_str().to_owned(),
                parent_tool_use.as_str().to_owned(),
            ));
        }
    }
    assert_eq!(
        spawned[0],
        (
            "agent_1".to_owned(),
            nibi_kernel_api::session_api::SubagentPhase::Spawned,
            "sess_child".to_owned(),
            "toolu_1".to_owned()
        )
    );
    assert_eq!(
        spawned[1],
        (
            "agent_1".to_owned(),
            nibi_kernel_api::session_api::SubagentPhase::Done,
            "sess_child".to_owned(),
            // 续跑没有对应工具调用：用它自己的 agent id 占位，不发明一个工具调用。
            "agent_1".to_owned()
        )
    );
}

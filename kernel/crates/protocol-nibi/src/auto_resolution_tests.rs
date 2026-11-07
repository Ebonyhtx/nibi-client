//! AskUserQuestion 自动结束的会话层行为：冷种子、到点自动应答、snooze 与偏好开关。
//!
//! 纯状态机的边界（队首、两段计时、幂等）在 `projection::auto_resolution` 的单测里；这里判的是
//! `Live` 的接线：状态写进 `pendingInteractions`、到期真的向内核发 `ResolveInteraction`、会话列表
//! 的侧栏摘要带同一份 `autoResolution`。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::StreamExt;
use nibi_kernel_api::clock::Clock;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, InteractionId, SessionId, ToolUseId, TraceId};
use nibi_kernel_api::interaction::QuestionAnswer;
use nibi_kernel_api::orchestration::InteractionRequest;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{
    Ack, Command, CommandEnvelope, KernelError, KernelEvent, SequencedEvent, SessionHandle,
    SessionView,
};
use nibi_kernel_api::store::{SessionKind, SessionMeta};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options};
use serde_json::{Value, json};
use tokio::io::duplex;

use crate::context::Context;
use crate::index::Topics;
use crate::live::Live;
use crate::projection::state::Followup;

/// 可调的测试时钟（`FixedClock` 不能让时间往前走）。
struct TestClock(AtomicU64);

impl TestClock {
    fn new(now: u64) -> Self {
        Self(AtomicU64::new(now))
    }

    fn set(&self, now: u64) {
        self.0.store(now, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

/// 记录内核收到的命令（自动应答要能看出来）。
struct FakeHandle {
    id: SessionId,
    sent: Mutex<Vec<Command>>,
}

impl FakeHandle {
    fn new() -> Self {
        Self {
            id: SessionId::new("session-1"),
            sent: Mutex::new(Vec::new()),
        }
    }

    fn sent(&self) -> Vec<Command> {
        self.sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[async_trait]
impl SessionHandle for FakeHandle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(&self, command: CommandEnvelope) -> Ack {
        self.sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(command.command);
        Ack::Accepted {
            result: Value::Null,
        }
    }

    fn subscribe(
        &self,
        _after: Option<u64>,
    ) -> futures_util::stream::BoxStream<'static, SequencedEvent> {
        futures_util::stream::pending().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Err(KernelError::Unsupported {
            what: "view".to_owned(),
        })
    }
}

struct Harness {
    live: Live,
    handle: Arc<FakeHandle>,
    _scope: TaskScope,
    _host: tokio::io::DuplexStream,
}

impl Harness {
    fn new(clock: Arc<TestClock>, pending: Vec<(InteractionId, InteractionRequest)>) -> Self {
        let scope = TaskScope::root("auto-resolution-test", |_| {});
        let (out, host) = duplex(1 << 16);
        let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
        let context = Arc::new(Context::new(peer, clock.clone()));
        let topics = Arc::new(Topics::new(context.clone(), &scope.spawner()));
        let view = SessionView {
            meta: SessionMeta {
                id: SessionId::new("session-1"),
                kind: SessionKind::Interactive,
                parent: None,
                workspace: WorkspaceRef {
                    environment: EnvironmentId::new("local"),
                    root: EnvPath::new("/w"),
                },
                title: "t".to_owned(),
                trace: TraceId::new("session-1"),
                created_at_ms: clock.now_ms(),
            },
            messages: Vec::new(),
            selection: nibi_kernel_api::model::ModelSelection {
                provider: "p".to_owned(),
                model: "m".to_owned(),
                reasoning: None,
                connection: None,
            },
            mode: PermissionMode::Default,
            plan: false,
            pending,
            queue: Vec::new(),
            last_seq: 0,
            revision: 0,
            running: true,
            background: Vec::new(),
            peer_held: Vec::new(),
            context_usage: None,
            context_notice: Default::default(),
            output_speed: None,
            launches: Vec::new(),
            model_turns: Vec::new(),
            input_intents: Vec::new(),
        };
        let live = Live::new(
            context,
            topics,
            &view,
            Followup::Queue,
            Arc::new(crate::local_ttft::LocalTtftRecorder::new(
                "cli-1".to_owned(),
            )),
            scope.spawner(),
            true,
        );
        Self {
            live,
            handle: Arc::new(FakeHandle::new()),
            _scope: scope,
            _host: host,
        }
    }

    async fn ask(&self, seq: u64, interaction: &str) {
        self.live
            .event_for_test(SequencedEvent {
                seq,
                revision: seq,
                event: KernelEvent::InteractionAsked {
                    interaction: InteractionId::new(interaction),
                    request: InteractionRequest::Question {
                        tool_use: ToolUseId::new("toolu-1"),
                        questions: json!([]),
                    },
                },
            })
            .await;
    }

    fn auto_resolution(&self) -> Value {
        self.live.summary()["pendingInteraction"]["autoResolution"].clone()
    }
}

#[tokio::test]
async fn a_question_starts_the_hidden_grace_and_shows_in_the_sidebar_summary() {
    let clock = Arc::new(TestClock::new(1_000));
    let harness = Harness::new(clock, Vec::new());
    harness.ask(1, "ia_1").await;

    let summary = harness.live.summary();
    assert_eq!(summary["pendingInteraction"]["interactionId"], "ia_1");
    assert_eq!(summary["pendingInteraction"]["kind"], "userInput");
    assert_eq!(summary["pendingInteraction"]["toolName"], "AskUserQuestion");
    assert_eq!(summary["pendingInteractionSummary"]["userInputCount"], 1);
    let auto = harness.auto_resolution();
    assert_eq!(auto["state"], "hiddenGrace");
    assert_eq!(auto["startedAt"], 1_000);
    assert_eq!(auto["visibleAt"], 61_000);
    assert_eq!(auto["deadlineAt"], 301_000);
    assert_eq!(harness.live.next_auto_resolution_at(), Some(61_000));
}

#[tokio::test]
async fn a_cold_open_pending_question_starts_the_clock() {
    let clock = Arc::new(TestClock::new(2_000));
    let harness = Harness::new(
        clock,
        vec![(
            InteractionId::new("ia_cold"),
            InteractionRequest::Question {
                tool_use: ToolUseId::new("toolu-cold"),
                questions: json!([]),
            },
        )],
    );
    let auto = harness.auto_resolution();
    assert_eq!(auto["state"], "hiddenGrace");
    assert_eq!(auto["startedAt"], 2_000);
    assert_eq!(harness.live.next_auto_resolution_at(), Some(62_000));
}

#[tokio::test]
async fn the_visible_transition_rewrites_the_summary_state() {
    let clock = Arc::new(TestClock::new(1_000));
    let harness = Harness::new(clock.clone(), Vec::new());
    harness.ask(1, "ia_1").await;

    clock.set(61_000);
    harness
        .live
        .advance_auto_resolution(harness.handle.as_ref())
        .await;

    let auto = harness.auto_resolution();
    assert_eq!(auto["state"], "visibleCountdown");
    // 绝对时间不动（与 Node 的 visibleTimer 一致）。
    assert_eq!(auto["visibleAt"], 61_000);
    assert_eq!(auto["deadlineAt"], 301_000);
    assert_eq!(harness.live.next_auto_resolution_at(), Some(301_000));
}

#[tokio::test]
async fn the_deadline_sends_the_accept_with_empty_answers() {
    let clock = Arc::new(TestClock::new(1_000));
    let harness = Harness::new(clock.clone(), Vec::new());
    harness.ask(1, "ia_1").await;

    clock.set(301_000);
    harness
        .live
        .advance_auto_resolution(harness.handle.as_ref())
        .await;

    let sent = harness.handle.sent();
    assert_eq!(sent.len(), 1);
    match &sent[0] {
        Command::ResolveInteraction {
            interaction,
            answer,
        } => {
            assert_eq!(interaction.as_str(), "ia_1");
            let expected = serde_json::to_value(QuestionAnswer::Answered {
                answers: std::collections::BTreeMap::new(),
                annotations: std::collections::BTreeMap::new(),
                response: None,
                follow_up: false,
                afk_timeout_ms: None,
            })
            .unwrap();
            assert_eq!(answer, &expected);
        }
        other => panic!("unexpected command: {other:?}"),
    }
    // 已经发出、等内核收口：不再排下一次唤醒，也不会重复发。
    assert_eq!(harness.live.next_auto_resolution_at(), None);
    harness
        .live
        .advance_auto_resolution(harness.handle.as_ref())
        .await;
    assert_eq!(harness.handle.sent().len(), 1);
}

#[tokio::test]
async fn snooze_stops_the_countdown_permanently() {
    let clock = Arc::new(TestClock::new(1_000));
    let harness = Harness::new(clock, Vec::new());
    harness.ask(1, "ia_1").await;

    assert!(harness.live.snooze_auto_resolution("ia_1").await);
    let auto = harness.auto_resolution();
    assert_eq!(auto["state"], "snoozed");
    assert_eq!(auto["snoozedAt"], 1_000);
    assert_eq!(harness.live.next_auto_resolution_at(), None);
    // 再来一次是幂等 noop。
    assert!(!harness.live.snooze_auto_resolution("ia_1").await);
}

#[tokio::test]
async fn disabling_the_preference_snoozes_the_active_countdown() {
    let clock = Arc::new(TestClock::new(1_000));
    let harness = Harness::new(clock, Vec::new());
    harness.ask(1, "ia_1").await;

    assert_eq!(harness.live.set_auto_resolution_enabled(false).await, 1);
    assert_eq!(harness.auto_resolution()["state"], "snoozed");
    assert_eq!(harness.live.next_auto_resolution_at(), None);
    // 重新打开不追溯旧问题。
    assert_eq!(harness.live.set_auto_resolution_enabled(true).await, 0);
    assert_eq!(harness.auto_resolution()["state"], "snoozed");
}

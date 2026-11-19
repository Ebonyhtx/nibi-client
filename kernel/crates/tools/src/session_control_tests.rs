//! 会话控制工具的单元测试：假 `SessionControlHost` 覆盖范围拒绝、self-wait、重复 operation、
//! 等待语义（timeout=0 / any / all / 截止 / 取消）、幂等回执与 32 KiB 落盘。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_api::session_control::{
    Admission, CreateSessionInput, CreateSessionResult, Delivery, ForkSessionInput,
    ForkSessionResult, InterruptSessionInput, ListSessionsInput, ListSessionsResult,
    MutationResult, MutationStatus, OperationRef, OperationSnapshot, OperationStatus,
    OperationUpdate, ReadSessionInput, ReadSessionResult, RenameSessionInput, SendToSessionInput,
    SendToSessionResult, SessionControlActionName, SessionControlError, SessionControlFeed,
    SessionControlHost, SessionMessage, SessionRef, SessionRefKind, SessionStatus, SessionSummary,
    TrustedContext,
};
use nibi_kernel_api::testing::MemoryArtifacts;
use nibi_kernel_api::tool::Tool;
use serde_json::{Value, json};

use super::{Begin, Receipts, SessionControlTool, session_control_tools};
use crate::test_more::{Ctx, output_text};

const WORKSPACE: &str = "/Users/dev/work";

fn session(id: &str) -> SessionRef {
    SessionRef {
        kind: SessionRefKind::Cli,
        workspace_path: WORKSPACE.to_owned(),
        workspace_identity: None,
        session_id: id.to_owned(),
    }
}

fn operation(id: &str, command: &str) -> OperationRef {
    OperationRef {
        session: session(id),
        session_id: id.to_owned(),
        command_id: command.to_owned(),
    }
}

fn snapshot(id: &str, command: &str, status: OperationStatus) -> OperationSnapshot {
    OperationSnapshot {
        operation: operation(id, command),
        epoch: "epoch-1".to_owned(),
        revision: 0,
        status,
        execution_id: None,
        reason: None,
        attention: None,
    }
}

struct TestFeed {
    initial: OperationSnapshot,
    updates: tokio::sync::mpsc::UnboundedReceiver<OperationUpdate>,
    closed: Arc<AtomicUsize>,
}

impl TestFeed {
    fn pair(
        initial: OperationSnapshot,
    ) -> (Self, tokio::sync::mpsc::UnboundedSender<OperationUpdate>) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        (
            Self {
                initial,
                updates: receiver,
                closed: Arc::new(AtomicUsize::default()),
            },
            sender,
        )
    }
}

#[async_trait]
impl SessionControlFeed for TestFeed {
    fn initial(&self) -> OperationSnapshot {
        self.initial.clone()
    }

    async fn recv(&mut self) -> Option<OperationUpdate> {
        self.updates.recv().await
    }

    async fn close(&mut self) {
        self.closed.fetch_add(1, Ordering::SeqCst);
        self.updates.close();
    }
}

#[derive(Default)]
struct FakeHost {
    sessions: Mutex<HashMap<String, SessionRef>>,
    calls: Mutex<Vec<String>>,
    list: Mutex<Option<ListSessionsResult>>,
    read: Mutex<Option<ReadSessionResult>>,
    create: Mutex<Option<CreateSessionResult>>,
    fork: Mutex<Option<ForkSessionResult>>,
    send: Mutex<Option<SendToSessionResult>>,
    interrupt: Mutex<Option<MutationResult>>,
    feeds: Mutex<HashMap<String, Box<dyn SessionControlFeed>>>,
    delays: Mutex<HashMap<String, Duration>>,
    send_count: AtomicUsize,
    archived: Mutex<HashSet<String>>,
}

impl FakeHost {
    fn with_session(id: &str) -> Self {
        let host = Self::default();
        host.sessions
            .lock()
            .unwrap()
            .insert(id.to_owned(), session(id));
        host
    }

    fn with_archived_session(id: &str) -> Self {
        let host = Self::with_session(id);
        host.archived.lock().unwrap().insert(id.to_owned());
        host
    }

    fn with_session_at(id: &str, workspace: &str) -> Self {
        let host = Self::default();
        host.sessions.lock().unwrap().insert(
            id.to_owned(),
            SessionRef {
                kind: SessionRefKind::Cli,
                workspace_path: workspace.to_owned(),
                workspace_identity: None,
                session_id: id.to_owned(),
            },
        );
        host
    }

    fn feed(&self, session_id: &str, command_id: &str, feed: TestFeed) {
        self.feeds
            .lock()
            .unwrap()
            .insert(format!("{session_id}:{command_id}"), Box::new(feed));
    }

    fn delay_open(&self, command_id: &str, delay: Duration) {
        self.delays
            .lock()
            .unwrap()
            .insert(command_id.to_owned(), delay);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn note(&self, call: &str) {
        self.calls.lock().unwrap().push(call.to_owned());
    }

    fn send_calls(&self) -> usize {
        self.send_count.load(Ordering::SeqCst)
    }
}

fn missing() -> SessionControlError {
    SessionControlError::unavailable("not configured in this fake")
}

#[async_trait]
impl SessionControlHost for FakeHost {
    async fn resolve_session(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionRef>, SessionControlError> {
        Ok(self.sessions.lock().unwrap().get(session_id).cloned())
    }

    async fn is_session_archived(
        &self,
        session: &SessionRef,
    ) -> Result<bool, SessionControlError> {
        Ok(self.archived.lock().unwrap().contains(&session.session_id))
    }

    async fn list_sessions(
        &self,
        _ctx: &TrustedContext,
        _input: ListSessionsInput,
    ) -> Result<ListSessionsResult, SessionControlError> {
        self.note("listSessions");
        self.list.lock().unwrap().clone().ok_or_else(missing)
    }

    async fn read_session(
        &self,
        _ctx: &TrustedContext,
        _input: ReadSessionInput,
    ) -> Result<ReadSessionResult, SessionControlError> {
        self.note("readSession");
        self.read.lock().unwrap().clone().ok_or_else(missing)
    }

    async fn create_session(
        &self,
        _ctx: &TrustedContext,
        _input: CreateSessionInput,
    ) -> Result<CreateSessionResult, SessionControlError> {
        self.note("createSession");
        self.create.lock().unwrap().clone().ok_or_else(missing)
    }

    async fn fork_session(
        &self,
        _ctx: &TrustedContext,
        _input: ForkSessionInput,
    ) -> Result<ForkSessionResult, SessionControlError> {
        self.note("forkSession");
        self.fork.lock().unwrap().clone().ok_or_else(missing)
    }

    async fn send_to_session(
        &self,
        _ctx: &TrustedContext,
        input: SendToSessionInput,
    ) -> Result<SendToSessionResult, SessionControlError> {
        self.note("sendToSession");
        self.send_count.fetch_add(1, Ordering::SeqCst);
        if let Some(result) = self.send.lock().unwrap().clone() {
            return Ok(result);
        }
        Ok(SendToSessionResult {
            request_id: input.request_id.clone(),
            session: input.session.clone(),
            operation: operation(&input.session.session_id, &input.request_id),
            admission: Admission::Accepted,
            delivery: Delivery::StartNow,
            reason: None,
        })
    }

    async fn interrupt_session(
        &self,
        _ctx: &TrustedContext,
        input: InterruptSessionInput,
    ) -> Result<MutationResult, SessionControlError> {
        self.note("interruptSession");
        if let Some(result) = self.interrupt.lock().unwrap().clone() {
            return Ok(result);
        }
        Ok(MutationResult {
            status: MutationStatus::Applied,
            request_id: input.request_id,
            reason: None,
        })
    }

    async fn rename_session(
        &self,
        _ctx: &TrustedContext,
        input: RenameSessionInput,
    ) -> Result<MutationResult, SessionControlError> {
        self.note("renameSession");
        self.note(&format!("title={}", input.title));
        Ok(MutationResult {
            status: MutationStatus::Applied,
            request_id: input.request_id,
            reason: None,
        })
    }

    async fn open_observation(
        &self,
        _ctx: &TrustedContext,
        operation: &OperationRef,
    ) -> Result<Box<dyn SessionControlFeed>, SessionControlError> {
        let delay = self
            .delays
            .lock()
            .unwrap()
            .get(&operation.command_id)
            .copied();
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
        }
        let key = format!("{}:{}", operation.session.session_id, operation.command_id);
        self.feeds.lock().unwrap().remove(&key).ok_or_else(|| {
            SessionControlError::new(
                nibi_kernel_api::session_control::SessionControlErrorCode::ObservationInvalid,
                "no feed configured",
            )
        })
    }
}

fn tool(action: SessionControlActionName, host: Arc<FakeHost>) -> Arc<dyn Tool> {
    let slot = Arc::new(std::sync::OnceLock::new());
    let _ = slot.set(host as Arc<dyn SessionControlHost>);
    let receipts = Arc::new(Receipts::default());
    Arc::new(SessionControlTool::new(action, slot, receipts))
}

fn context() -> nibi_kernel_api::tool::ToolUseContext {
    Ctx::new(Arc::new(
        nibi_kernel_api::testing::ScriptedInteractions::default(),
    ))
    .build()
}

fn result_text(output: &nibi_kernel_api::tool::ToolOutput) -> String {
    output_text(output)
}

fn failure(error: &nibi_kernel_api::tool::ToolError) -> String {
    error.to_string()
}

#[tokio::test]
async fn a_target_in_another_workspace_is_rejected_before_the_owner_call() {
    let host = Arc::new(FakeHost::with_session_at("sess_target", "/other"));
    let read = tool(SessionControlActionName::ReadSession, host.clone());
    let error = read
        .call(
            json!({"sessionId": "sess_target", "view": "summary"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("cross-workspace target must be forbidden");
    assert!(failure(&error).contains("forbidden"), "{error:?}");
    assert!(host.calls().is_empty(), "{:?}", host.calls());
}

#[tokio::test]
async fn cross_workspace_fork_send_and_wait_are_forbidden_before_owner_calls() {
    for action in [
        SessionControlActionName::ForkSession,
        SessionControlActionName::SendToSession,
        SessionControlActionName::WaitSessions,
    ] {
        let host = Arc::new(FakeHost::with_session_at("sess_target", "/other"));
        let tool = tool(action, host.clone());
        let input = match action {
            SessionControlActionName::ForkSession => {
                json!({"sessionId": "sess_target", "atMessage": "msg_1"})
            }
            SessionControlActionName::SendToSession => {
                json!({"sessionId": "sess_target", "prompt": "go"})
            }
            SessionControlActionName::WaitSessions => json!({
                "operations": [{"sessionId": "sess_target", "commandId": "c"}],
                "mode": "any",
                "timeoutMs": 0,
            }),
            _ => unreachable!(),
        };
        let error = tool
            .call(input, context(), tokio::sync::mpsc::channel(1).0)
            .await
            .expect_err("a cross-source target must be rejected");
        assert!(failure(&error).contains("forbidden"), "{action:?}: {error:?}");
        assert!(host.calls().is_empty(), "{action:?}: {:?}", host.calls());
    }
}

#[tokio::test]
async fn archived_targets_are_rejected_before_the_fork_owner_call() {
    let host = Arc::new(FakeHost::with_archived_session("sess_target"));
    let fork = tool(SessionControlActionName::ForkSession, host.clone());
    let error = fork
        .call(
            json!({"sessionId": "sess_target", "atMessage": "msg_1"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("an archived target must not be forked");
    let failure = failure(&error);
    assert!(failure.contains("unavailable"), "{error:?}");
    assert!(failure.contains("archived"), "{error:?}");
    // 没有调用 owner：不会创建半个子会话。
    assert!(host.calls().is_empty(), "{:?}", host.calls());
}

#[tokio::test]
async fn archived_targets_still_accept_reads_and_sends() {
    let host = Arc::new(FakeHost::with_archived_session("sess_target"));
    let send = tool(SessionControlActionName::SendToSession, host.clone());
    let output = send
        .call(
            json!({"sessionId": "sess_target", "prompt": "continue"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("archive is organizational and must not stop execution");
    assert!(result_text(&output).contains("accepted"));
    assert_eq!(host.send_calls(), 1);
}

#[tokio::test]
async fn unknown_session_ids_are_forbidden_without_owner_calls() {
    let host = Arc::new(FakeHost::default());
    let read = tool(SessionControlActionName::ReadSession, host.clone());
    let error = read
        .call(
            json!({"sessionId": "sess_missing", "view": "summary"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("unknown id must be forbidden");
    assert!(failure(&error).contains("forbidden"), "{error:?}");
}

#[tokio::test]
async fn placeholder_session_ids_are_invalid_input() {
    let host = Arc::new(FakeHost::default());
    let read = tool(SessionControlActionName::ReadSession, host.clone());
    for placeholder in ["dummy", "sess_", "sess_../escape", "159c9866-62b8"] {
        let error = read
            .call(
                json!({"sessionId": placeholder, "view": "summary"}),
                context(),
                tokio::sync::mpsc::channel(1).0,
            )
            .await
            .expect_err("placeholder must be invalid");
        assert!(
            failure(&error).contains("Expected a session id"),
            "{error:?}"
        );
    }
}

#[tokio::test]
async fn read_session_rejects_a_different_session_from_the_owner() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    *host.read.lock().unwrap() = Some(ReadSessionResult::Summary {
        summary: SessionSummary {
            session: session("sess_other"),
            title: "other".to_owned(),
            status: SessionStatus::Idle,
            available_actions: Vec::new(),
            updated_at: None,
            execution_id: None,
            archived: None,
            pinned: None,
        },
    });
    let read = tool(SessionControlActionName::ReadSession, host);
    let error = read
        .call(
            json!({"sessionId": "sess_target", "view": "summary"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("wrong receipt must fail");
    assert!(failure(&error).contains("invalid_output"), "{error:?}");
}

#[tokio::test]
async fn list_sessions_rejects_rows_outside_the_trusted_workspace() {
    let host = Arc::new(FakeHost::default());
    *host.list.lock().unwrap() = Some(ListSessionsResult {
        sessions: vec![SessionSummary {
            session: SessionRef {
                workspace_path: "/other".to_owned(),
                ..session("sess_other")
            },
            title: "private".to_owned(),
            status: SessionStatus::Idle,
            available_actions: Vec::new(),
            updated_at: None,
            execution_id: None,
            archived: None,
            pinned: None,
        }],
        next_cursor: None,
    });
    let list = tool(SessionControlActionName::ListSessions, host);
    let error = list
        .call(json!({}), context(), tokio::sync::mpsc::channel(1).0)
        .await
        .expect_err("cross-workspace row must fail");
    assert!(failure(&error).contains("invalid_output"), "{error:?}");
}

#[tokio::test]
async fn self_wait_is_rejected_without_opening_a_feed() {
    let host = Arc::new(FakeHost::with_session("sess_1"));
    let wait = tool(SessionControlActionName::WaitSessions, host.clone());
    let error = wait
        .call(
            json!({"operations": [{"sessionId": "sess_1", "commandId": "c1"}], "mode": "all"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("self wait must fail");
    assert!(failure(&error).contains("self_wait"), "{error:?}");
    assert!(host.calls().is_empty());
}

#[tokio::test]
async fn duplicate_operations_are_invalid_input() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    let wait = tool(SessionControlActionName::WaitSessions, host.clone());
    let error = wait
        .call(
            json!({
                "operations": [
                    {"sessionId": "sess_target", "commandId": "c1"},
                    {"sessionId": "sess_target", "commandId": "c1"}
                ],
                "mode": "any",
            }),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("duplicate must fail");
    assert!(failure(&error).contains("duplicate operation"), "{error:?}");
    assert!(host.calls().is_empty());
}

#[tokio::test]
async fn wait_zero_reads_baselines_and_closes_feeds() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    let (feed, _updates) = TestFeed::pair(snapshot("sess_target", "c1", OperationStatus::Running));
    let closed = feed.closed.clone();
    host.feed("sess_target", "c1", feed);
    let wait = tool(SessionControlActionName::WaitSessions, host);
    let output = wait
        .call(
            json!({"operations": [{"sessionId": "sess_target", "commandId": "c1"}], "mode": "all", "timeoutMs": 0}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("wait must return");
    let value: Value = serde_json::from_str(&result_text(&output)).unwrap();
    assert_eq!(value["status"], json!("timed_out"), "{value}");
    assert_eq!(
        value["operations"][0]["status"],
        json!("running"),
        "{value}"
    );
    assert_eq!(closed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn wait_any_returns_when_one_target_settles_and_closes_both_feeds() {
    let host = Arc::new(FakeHost::with_session("sess_a"));
    host.sessions
        .lock()
        .unwrap()
        .insert("sess_b".to_owned(), session("sess_b"));
    let (feed_a, updates_a) = TestFeed::pair(snapshot("sess_a", "a", OperationStatus::Running));
    let (feed_b, updates_b) = TestFeed::pair(snapshot("sess_b", "b", OperationStatus::Running));
    let closed_a = feed_a.closed.clone();
    let closed_b = feed_b.closed.clone();
    host.feed("sess_a", "a", feed_a);
    host.feed("sess_b", "b", feed_b);
    let wait = tool(SessionControlActionName::WaitSessions, host);
    let call = tokio::spawn(async move {
        wait.call(
            json!({
                "operations": [
                    {"sessionId": "sess_a", "commandId": "a"},
                    {"sessionId": "sess_b", "commandId": "b"}
                ],
                "mode": "any",
                "timeoutMs": 2000,
            }),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut failed = snapshot("sess_b", "b", OperationStatus::Failed);
    failed.revision = 1;
    updates_b
        .send(OperationUpdate::Snapshot { snapshot: failed })
        .unwrap();
    let output = call.await.unwrap().expect("wait must return");
    let value: Value = serde_json::from_str(&result_text(&output)).unwrap();
    assert_eq!(value["status"], json!("completed"), "{value}");
    assert_eq!(value["operations"][1]["status"], json!("failed"), "{value}");
    assert_eq!(closed_a.load(Ordering::SeqCst), 1);
    assert_eq!(closed_b.load(Ordering::SeqCst), 1);
    let _ = updates_a;
}

#[tokio::test]
async fn wait_all_requires_every_target_and_accepts_interrupted() {
    let host = Arc::new(FakeHost::with_session("sess_a"));
    host.sessions
        .lock()
        .unwrap()
        .insert("sess_b".to_owned(), session("sess_b"));
    let (feed_a, updates_a) = TestFeed::pair(snapshot("sess_a", "a", OperationStatus::Running));
    let (feed_b, updates_b) = TestFeed::pair(snapshot("sess_b", "b", OperationStatus::Running));
    host.feed("sess_a", "a", feed_a);
    host.feed("sess_b", "b", feed_b);
    let wait = tool(SessionControlActionName::WaitSessions, host);
    let call = tokio::spawn(async move {
        wait.call(
            json!({
                "operations": [
                    {"sessionId": "sess_a", "commandId": "a"},
                    {"sessionId": "sess_b", "commandId": "b"}
                ],
                "mode": "all",
                "timeoutMs": 2000,
            }),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut interrupted = snapshot("sess_a", "a", OperationStatus::Interrupted);
    interrupted.revision = 1;
    updates_a
        .send(OperationUpdate::Snapshot {
            snapshot: interrupted,
        })
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!call.is_finished(), "all must wait for the second target");
    let mut completed = snapshot("sess_b", "b", OperationStatus::Completed);
    completed.revision = 1;
    updates_b
        .send(OperationUpdate::Snapshot {
            snapshot: completed,
        })
        .unwrap();
    let output = call.await.unwrap().expect("wait must return");
    let value: Value = serde_json::from_str(&result_text(&output)).unwrap();
    assert_eq!(value["status"], json!("completed"), "{value}");
    assert_eq!(value["operations"][0]["status"], json!("interrupted"));
}

#[tokio::test]
async fn wait_timeout_returns_the_latest_snapshots_without_stopping_targets() {
    let host = Arc::new(FakeHost::with_session("sess_a"));
    let (feed, updates) = TestFeed::pair(snapshot("sess_a", "a", OperationStatus::Running));
    let closed = feed.closed.clone();
    host.feed("sess_a", "a", feed);
    let wait = tool(SessionControlActionName::WaitSessions, host);
    let call = tokio::spawn(async move {
        wait.call(
            json!({"operations": [{"sessionId": "sess_a", "commandId": "a"}], "mode": "all", "timeoutMs": 50}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let mut queued = snapshot("sess_a", "a", OperationStatus::Queued);
    queued.revision = 1;
    updates
        .send(OperationUpdate::Snapshot { snapshot: queued })
        .unwrap();
    let output = call.await.unwrap().expect("wait must return");
    let value: Value = serde_json::from_str(&result_text(&output)).unwrap();
    assert_eq!(value["status"], json!("timed_out"), "{value}");
    assert_eq!(value["operations"][0]["status"], json!("queued"), "{value}");
    assert_eq!(closed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn wait_cancellation_closes_feeds_and_returns_cancelled() {
    let host = Arc::new(FakeHost::with_session("sess_a"));
    let (feed, _updates) = TestFeed::pair(snapshot("sess_a", "a", OperationStatus::Running));
    let closed = feed.closed.clone();
    host.feed("sess_a", "a", feed);
    let wait = tool(SessionControlActionName::WaitSessions, host);
    let context = context();
    let cancel = context.cancel.clone();
    let call = tokio::spawn(async move {
        wait.call(
            json!({"operations": [{"sessionId": "sess_a", "commandId": "a"}], "mode": "all", "timeoutMs": 2000}),
            context,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    cancel.cancel();
    let output = call.await.unwrap().expect("wait must return");
    let value: Value = serde_json::from_str(&result_text(&output)).unwrap();
    assert_eq!(value["status"], json!("cancelled"), "{value}");
    assert_eq!(closed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn wait_observation_that_ends_before_settling_is_unknown() {
    let host = Arc::new(FakeHost::with_session("sess_a"));
    let (feed, updates) = TestFeed::pair(snapshot("sess_a", "a", OperationStatus::Running));
    host.feed("sess_a", "a", feed);
    drop(updates);
    let wait = tool(SessionControlActionName::WaitSessions, host);
    let output = wait
        .call(
            json!({"operations": [{"sessionId": "sess_a", "commandId": "a"}], "mode": "all", "timeoutMs": 2000}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("wait must return");
    let value: Value = serde_json::from_str(&result_text(&output)).unwrap();
    assert_eq!(value["status"], json!("unknown"), "{value}");
    assert_eq!(
        value["operations"][0]["status"],
        json!("unknown"),
        "{value}"
    );
}

#[tokio::test]
async fn wait_rejects_out_of_order_updates_as_unknown() {
    let host = Arc::new(FakeHost::with_session("sess_a"));
    let (feed, updates) = TestFeed::pair(snapshot("sess_a", "a", OperationStatus::Running));
    host.feed("sess_a", "a", feed);
    let wait = tool(SessionControlActionName::WaitSessions, host);
    let call = tokio::spawn(async move {
        wait.call(
            json!({"operations": [{"sessionId": "sess_a", "commandId": "a"}], "mode": "all", "timeoutMs": 2000}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // 同 epoch、revision 没有递增：不能当作完成。
    let mut stale = snapshot("sess_a", "a", OperationStatus::Completed);
    stale.revision = 0;
    updates
        .send(OperationUpdate::Snapshot { snapshot: stale })
        .unwrap();
    let output = call.await.unwrap().expect("wait must return");
    let value: Value = serde_json::from_str(&result_text(&output)).unwrap();
    assert_eq!(value["status"], json!("unknown"), "{value}");
}

#[tokio::test]
async fn write_tools_ask_and_read_tools_allow() {
    for (action, read) in [
        (SessionControlActionName::ListSessions, true),
        (SessionControlActionName::ReadSession, true),
        (SessionControlActionName::WaitSessions, true),
        (SessionControlActionName::CreateSession, false),
        (SessionControlActionName::ForkSession, false),
        (SessionControlActionName::SendToSession, false),
        (SessionControlActionName::InterruptSession, false),
        (SessionControlActionName::RenameSession, false),
    ] {
        let host = Arc::new(FakeHost::default());
        let slot = Arc::new(std::sync::OnceLock::new());
        let _ = slot.set(host as Arc<dyn SessionControlHost>);
        let tool = SessionControlTool::new(action, slot, Arc::new(Receipts::default()));
        let decision = tool.check_permissions(&json!({}), &context()).await;
        match (read, decision) {
            (true, nibi_kernel_api::permission::PermissionDecision::Allow { .. }) => {}
            (false, nibi_kernel_api::permission::PermissionDecision::Ask { message, .. }) => {
                assert!(message.contains("Session control"), "{message}");
            }
            (_, other) => panic!("unexpected decision for {action:?}: {other:?}"),
        }
    }
}

#[tokio::test]
async fn send_is_idempotent_for_the_same_request_and_conflicts_on_a_different_one() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    let send = tool(SessionControlActionName::SendToSession, host.clone());
    let first = send
        .call(
            json!({"sessionId": "sess_target", "prompt": "go"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("first send");
    let first_value: Value = serde_json::from_str(&result_text(&first)).unwrap();
    assert_eq!(first_value["requestId"], json!("toolu_1"));
    assert_eq!(first_value["admission"], json!("accepted"));
    assert_eq!(host.send_calls(), 1);

    let replay = send
        .call(
            json!({"sessionId": "sess_target", "prompt": "go"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("replay");
    assert_eq!(
        serde_json::from_str::<Value>(&result_text(&replay)).unwrap(),
        first_value
    );
    assert_eq!(host.send_calls(), 1, "replay must not reach the owner");

    let conflict = send
        .call(
            json!({"sessionId": "sess_target", "prompt": "different"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("different fingerprint must conflict");
    assert!(failure(&conflict).contains("conflict"), "{conflict:?}");
    assert_eq!(host.send_calls(), 1);
}

#[tokio::test]
async fn retry_of_replays_the_receipt_without_a_new_tool_call_id() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    let send = tool(SessionControlActionName::SendToSession, host.clone());
    let first = send
        .call(
            json!({"sessionId": "sess_target", "prompt": "go", "retryOf": "request-1"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("first send");
    let first_value: Value = serde_json::from_str(&result_text(&first)).unwrap();
    assert_eq!(first_value["requestId"], json!("request-1"));
    // 另一个 toolCallId 的「重试」用 retryOf 回放同一份回执。
    let mut retry_context = context();
    retry_context.tool_use = nibi_kernel_api::ids::ToolUseId::new("toolu_2");
    let replay = send
        .call(
            json!({"sessionId": "sess_target", "prompt": "go", "retryOf": "request-1"}),
            retry_context,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("replay");
    assert_eq!(
        serde_json::from_str::<Value>(&result_text(&replay)).unwrap(),
        first_value
    );
    assert_eq!(host.send_calls(), 1);
}

#[tokio::test]
async fn rename_trims_the_title_before_the_owner_call() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    let rename = tool(SessionControlActionName::RenameSession, host.clone());
    let output = rename
        .call(
            json!({"sessionId": "sess_target", "title": "  Renamed  "}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("rename");
    assert_eq!(
        serde_json::from_str::<Value>(&result_text(&output)).unwrap()["status"],
        json!("applied")
    );
    assert!(
        host.calls().contains(&"title=Renamed".to_owned()),
        "{:?}",
        host.calls()
    );
}

#[tokio::test]
async fn interrupt_passes_the_expected_execution_id_and_surfaces_a_rejection() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    *host.interrupt.lock().unwrap() = Some(MutationResult {
        status: MutationStatus::Rejected,
        request_id: "toolu_1".to_owned(),
        reason: Some("expectedExecutionId does not match".to_owned()),
    });
    let interrupt = tool(SessionControlActionName::InterruptSession, host.clone());
    let output = interrupt
        .call(
            json!({"sessionId": "sess_target", "expectedExecutionId": "exec-old"}),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("interrupt returns a result");
    let value: Value = serde_json::from_str(&result_text(&output)).unwrap();
    assert_eq!(value["status"], json!("rejected"), "{value}");
    assert_eq!(value["requestId"], json!("toolu_1"));
    assert!(host.calls().contains(&"interruptSession".to_owned()));
}

#[tokio::test]
async fn oversized_results_are_persisted_as_a_tool_output_artifact() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    let big = "x".repeat(40_000);
    *host.read.lock().unwrap() = Some(ReadSessionResult::Messages {
        session: session("sess_target"),
        messages: vec![SessionMessage {
            id: "msg_1".to_owned(),
            role: "user".to_owned(),
            text: big,
        }],
        next_cursor: None,
    });
    let read = tool(SessionControlActionName::ReadSession, host);
    let mut context = context();
    let artifacts = Arc::new(MemoryArtifacts::default());
    context.artifacts = artifacts.clone();
    let output = read
        .call(
            json!({"sessionId": "sess_target", "view": "messages"}),
            context,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("read");
    let text = result_text(&output);
    assert!(text.starts_with("<persisted-output>"), "{text}");
    assert!(text.contains("nibi-artifact://sess_1/"), "{text}");
    assert_eq!(artifacts.count(), 1);
}

#[tokio::test]
async fn missing_host_slot_fails_closed_with_unavailable() {
    let tool = SessionControlTool::new(
        SessionControlActionName::ListSessions,
        Arc::new(std::sync::OnceLock::new()),
        Arc::new(Receipts::default()),
    );
    let error = tool
        .call(json!({}), context(), tokio::sync::mpsc::channel(1).0)
        .await
        .expect_err("no host must fail closed");
    assert!(failure(&error).contains("unavailable"), "{error:?}");
}

#[tokio::test]
async fn the_factory_exposes_the_eight_exact_tool_names() {
    let tools = session_control_tools(Arc::new(std::sync::OnceLock::new()));
    let names: Vec<&str> = tools.iter().map(|tool| tool.name()).collect();
    assert_eq!(
        names,
        [
            "ListSessions",
            "ReadSession",
            "CreateSession",
            "ForkSession",
            "SendToSession",
            "WaitSessions",
            "InterruptSession",
            "RenameSession",
        ]
    );
}

#[test]
fn target_schemas_expose_session_id_only_and_are_strict() {
    let tools = session_control_tools(Arc::new(std::sync::OnceLock::new()));
    for tool in &tools {
        let schema = tool.input_schema();
        assert_eq!(
            schema["additionalProperties"],
            json!(false),
            "{}",
            tool.name()
        );
        if matches!(
            tool.name(),
            "ReadSession" | "ForkSession" | "SendToSession" | "InterruptSession" | "RenameSession"
        ) {
            let properties = &schema["properties"];
            assert!(properties.get("sessionId").is_some(), "{}", tool.name());
            assert!(properties.get("session").is_none(), "{}", tool.name());
        }
    }
    let wait = tools
        .iter()
        .find(|tool| tool.name() == "WaitSessions")
        .unwrap();
    let schema = wait.input_schema();
    assert_eq!(schema["properties"]["operations"]["maxItems"], json!(100));
    assert_eq!(schema["properties"]["timeoutMs"]["maximum"], json!(300_000));
}

#[test]
fn the_operation_snapshot_revision_strictly_advances() {
    // 保底：wait 的更新规则（同 epoch、递增 revision）在 session_control_wait 里；这里核对快照
    // 的默认 revision 与终态集合，避免状态枚举漂移。
    assert!(OperationStatus::Completed.is_settled());
    assert!(OperationStatus::Interrupted.is_settled());
    assert!(OperationStatus::Failed.is_settled());
    assert!(OperationStatus::NeedsAttention.is_settled());
    assert!(!OperationStatus::Accepted.is_settled());
    assert!(!OperationStatus::Queued.is_settled());
    assert!(!OperationStatus::Running.is_settled());
    let initial = snapshot("sess_a", "a", OperationStatus::Unknown);
    assert_eq!(initial.revision, 0);
}
#[tokio::test]
async fn a_pre_cancelled_call_fails_with_the_cancelled_code() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    let send = tool(SessionControlActionName::SendToSession, host);
    let context = context();
    context.cancel.cancel();
    let error = send
        .call(
            json!({"sessionId": "sess_target", "prompt": "go"}),
            context,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("a cancelled call must not reach the owner");
    assert!(failure(&error).contains("cancelled"), "{error:?}");
}

#[tokio::test]
async fn a_full_session_reference_is_not_a_model_field() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    let read = tool(SessionControlActionName::ReadSession, host);
    let context = context();
    let validation = read
        .validate_input(
            &json!({
                "sessionId": "sess_target",
                "view": "summary",
                "session": {"kind": "cli", "workspacePath": "/Users/dev/work", "sessionId": "dummy"}
            }),
            &context,
        )
        .await;
    assert!(matches!(
        validation,
        nibi_kernel_api::tool::Validation::Invalid { .. }
    ));
    let error = read
        .call(
            json!({
                "sessionId": "sess_target",
                "view": "summary",
                "session": {"kind": "cli", "workspacePath": "/Users/dev/work", "sessionId": "dummy"}
            }),
            context,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("unknown field must be rejected");
    assert!(failure(&error).contains("unknown field"), "{error:?}");
}

#[test]
fn receipts_keep_existing_receipts_and_reject_new_ones_at_capacity() {
    let receipts = Receipts::default();
    for index in 0..4_096 {
        let request = format!("req-{index}");
        assert!(matches!(
            receipts.begin("caller", "root", &request, "fp"),
            Begin::Execute
        ));
        receipts.record("caller", "root", &request, "fp", json!({"n": index}));
    }
    assert!(matches!(
        receipts.begin("caller", "root", "one-more", "fp"),
        Begin::Capacity(_)
    ));
    assert!(matches!(
        receipts.begin("caller", "root", "req-0", "fp"),
        Begin::Replay(_)
    ));
    assert!(matches!(
        receipts.begin("caller", "root", "req-0", "different"),
        Begin::Conflict(_)
    ));
}

#[test]
fn receipts_limit_distinct_caller_roots_to_128() {
    let receipts = Receipts::default();
    for index in 0..128 {
        assert!(matches!(
            receipts.begin(&format!("caller-{index}"), "root", "req", "fp"),
            Begin::Execute
        ));
    }
    assert!(matches!(
        receipts.begin("caller-new", "root", "req", "fp"),
        Begin::Capacity(_)
    ));
    assert!(matches!(
        receipts.begin("caller-0", "root", "req-2", "fp"),
        Begin::Execute
    ));
}

#[tokio::test]
async fn subagent_executions_are_refused() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    let send = tool(SessionControlActionName::SendToSession, host);
    let mut context = context();
    context.agent = Some(nibi_kernel_api::ids::AgentId::new("agent_1"));
    let error = send
        .call(
            json!({"sessionId": "sess_target", "prompt": "go"}),
            context,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect_err("subagents have no session-control binding");
    assert!(failure(&error).contains("forbidden"), "{error:?}");
}

#[tokio::test]
async fn wait_zero_collects_every_baseline_before_any_returns() {
    let host = Arc::new(FakeHost::with_session("sess_a"));
    host.sessions
        .lock()
        .unwrap()
        .insert("sess_b".to_owned(), session("sess_b"));
    let (feed_a, _updates_a) = TestFeed::pair(snapshot("sess_a", "a", OperationStatus::Completed));
    let (feed_b, _updates_b) = TestFeed::pair(snapshot("sess_b", "b", OperationStatus::Running));
    host.feed("sess_a", "a", feed_a);
    // 第二个目标晚一点才交回 baseline：任何时刻提前返回都会拿到未观察的占位快照。
    host.delay_open("b", Duration::from_millis(80));
    host.feed("sess_b", "b", feed_b);
    let wait = tool(SessionControlActionName::WaitSessions, host);
    let output = wait
        .call(
            json!({
                "operations": [
                    {"sessionId": "sess_a", "commandId": "a"},
                    {"sessionId": "sess_b", "commandId": "b"}
                ],
                "mode": "any",
                "timeoutMs": 0,
            }),
            context(),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("wait must return");
    let value: Value = serde_json::from_str(&result_text(&output)).unwrap();
    assert_eq!(value["status"], json!("completed"), "{value}");
    assert_eq!(
        value["operations"][0]["status"],
        json!("completed"),
        "{value}"
    );
    assert_eq!(
        value["operations"][1]["status"],
        json!("running"),
        "{value}"
    );
}

struct FailingArtifacts;

#[async_trait]
impl nibi_kernel_api::store::ArtifactStore for FailingArtifacts {
    async fn put(
        &self,
        _session: &nibi_kernel_api::ids::SessionId,
        _purpose: nibi_kernel_api::store::ArtifactPurpose,
        _media_type: String,
        _bytes: Vec<u8>,
    ) -> Result<nibi_kernel_api::store::ArtifactRef, nibi_kernel_api::store::StoreError> {
        Err(nibi_kernel_api::store::StoreError::Unsupported {
            what: "test artifact store".to_owned(),
        })
    }

    async fn get(
        &self,
        _artifact: &nibi_kernel_api::store::ArtifactRef,
    ) -> Result<Vec<u8>, nibi_kernel_api::store::StoreError> {
        Err(nibi_kernel_api::store::StoreError::Unsupported {
            what: "test artifact store".to_owned(),
        })
    }
}

#[tokio::test]
async fn a_failed_artifact_write_falls_back_to_a_bounded_preview() {
    let host = Arc::new(FakeHost::with_session("sess_target"));
    *host.read.lock().unwrap() = Some(ReadSessionResult::Messages {
        session: session("sess_target"),
        messages: vec![SessionMessage {
            id: "msg_1".to_owned(),
            role: "user".to_owned(),
            text: "x".repeat(40_000),
        }],
        next_cursor: None,
    });
    let read = tool(SessionControlActionName::ReadSession, host);
    let mut context = context();
    context.artifacts = Arc::new(FailingArtifacts);
    let output = read
        .call(
            json!({"sessionId": "sess_target", "view": "messages"}),
            context,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("read");
    let text = result_text(&output);
    assert!(text.starts_with("<persisted-output>"), "{text}");
    assert!(text.contains("could not be saved to an artifact"), "{text}");
    assert!(text.ends_with("</persisted-output>"), "{text}");
}

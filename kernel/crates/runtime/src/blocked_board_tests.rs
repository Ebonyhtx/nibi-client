//! 钟板的接线测试：忙闲沿与开集沿驱动纯件、开集的现读合成（注册表的问答 ∪ 引擎等待表的
//! 留白 ∪ journal 的到达时刻）、投递的 originMeta 形状、会话关闭的停钟。定时器用 tokio 的
//! 暂停时钟（注入短档），store / 引擎 / 通知中心都是假件。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{
    CommitReceipt, FactBatch, LoadedSession, SessionFilter, SessionMeta, SessionStore,
    SessionSummary, StoreError,
};
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_kernel_api::workflow::{
    DynamicWorkflowRun, WorkflowEngine, WorkflowEngineError, WorkflowEscalation as _,
    WorkflowFillTarget, WorkflowFillTargetHole, WorkflowNotices, WorkflowRunActor,
    WorkflowRunDetail, WorkflowRunHealth, WorkflowRunHole, WorkflowRunNodeCounts,
};

use super::*;
use crate::escalations::{EscalationPort, WorkflowEscalations};

const SESSION: &str = "sess_blocked";

// ============================================================
// 假件
// ============================================================

/// store 假件：在飞的 run 行（`workflow_runs`）与 journal 的留白行（`workflow_run_detail`
/// 只取 since 用）。其余方法都是 `Unsupported`——钟板不碰它们。
struct FakeStore {
    runs: Mutex<Vec<DynamicWorkflowRun>>,
    details: Mutex<HashMap<String, WorkflowRunDetail>>,
}

impl FakeStore {
    fn new(runs: Vec<DynamicWorkflowRun>) -> Arc<Self> {
        Arc::new(Self {
            runs: Mutex::new(runs),
            details: Mutex::new(HashMap::new()),
        })
    }

    fn with_detail(self: &Arc<Self>, run_id: &str, detail: WorkflowRunDetail) -> Arc<Self> {
        self.details
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(run_id.to_owned(), detail);
        self.clone()
    }
}

#[async_trait::async_trait]
impl SessionStore for FakeStore {
    async fn create(&self, _meta: SessionMeta) -> Result<(), StoreError> {
        Err(StoreError::Unsupported {
            what: "test store".to_owned(),
        })
    }

    async fn commit(
        &self,
        _session: &SessionId,
        _batch: FactBatch,
    ) -> Result<CommitReceipt, StoreError> {
        Err(StoreError::Unsupported {
            what: "test store".to_owned(),
        })
    }

    async fn load(&self, _session: &SessionId) -> Result<LoadedSession, StoreError> {
        Err(StoreError::Unsupported {
            what: "test store".to_owned(),
        })
    }

    async fn list(&self, _filter: SessionFilter) -> Result<Vec<SessionSummary>, StoreError> {
        Err(StoreError::Unsupported {
            what: "test store".to_owned(),
        })
    }

    async fn workflow_runs(
        &self,
        session: &SessionId,
    ) -> Result<Vec<DynamicWorkflowRun>, StoreError> {
        // 板按会话查；假件把行都挂在测试会话名下，别会话一律空。
        if session.as_str() != SESSION {
            return Ok(Vec::new());
        }
        Ok(self
            .runs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone())
    }

    async fn workflow_run_detail(
        &self,
        _session: &SessionId,
        run_id: &str,
    ) -> Result<Option<WorkflowRunDetail>, StoreError> {
        Ok(self
            .details
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(run_id)
            .cloned())
    }
}

/// 引擎假件：`fill_target` 按配置回（等待的留白 + 草稿路径），或按 run 拒绝。其余方法一概
/// `run_not_found`——钟板只读等待表。
struct FakeEngine {
    targets: Mutex<HashMap<String, WorkflowFillTarget>>,
}

impl FakeEngine {
    fn with_target(self: &Arc<Self>, run_id: &str, target: WorkflowFillTarget) -> Arc<Self> {
        self.targets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(run_id.to_owned(), target);
        self.clone()
    }
}

fn not_found() -> WorkflowEngineError {
    WorkflowEngineError {
        reason: "run_not_found".to_owned(),
        message: None,
    }
}

#[async_trait::async_trait]
impl WorkflowEngine for FakeEngine {
    async fn fill_target(&self, run_id: &str) -> Result<WorkflowFillTarget, WorkflowEngineError> {
        match self
            .targets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(run_id)
        {
            Some(target) => Ok(target.clone()),
            None => Err(not_found()),
        }
    }

    async fn start_saved(
        &self,
        _parent: &rust_cli_kernel_api::ids::SessionId,
        _request: rust_cli_kernel_api::workflow::WorkflowStart,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowRunStarted, WorkflowEngineError> {
        Err(not_found())
    }

    async fn resume(
        &self,
        _run_id: &str,
        _name: Option<&str>,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowRunStarted, WorkflowEngineError> {
        Err(not_found())
    }

    async fn amend(
        &self,
        _request: rust_cli_kernel_api::workflow::WorkflowAmend,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowRunStarted, WorkflowEngineError> {
        Err(not_found())
    }

    async fn cancel(&self, _run_id: &str) -> Result<(), WorkflowEngineError> {
        Err(not_found())
    }

    async fn fill_hole(
        &self,
        _session: &rust_cli_kernel_api::ids::SessionId,
        _run_id: &str,
        _hole_id: &str,
        _body: &str,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowFillOutcome, WorkflowEngineError> {
        Err(not_found())
    }

    async fn hub_list_saved_workflows(
        &self,
        _workspace_path: &str,
        _scope: &str,
    ) -> Result<serde_json::Value, WorkflowEngineError> {
        Err(not_found())
    }

    async fn hub_get_saved_workflow(
        &self,
        _workspace_path: &str,
        _name: &str,
        _scope: &str,
    ) -> Result<serde_json::Value, WorkflowEngineError> {
        Err(not_found())
    }

    async fn hub_save_workflow_from_run(
        &self,
        _workspace_path: &str,
        _run_id: &str,
        _name: &str,
        _meta: serde_json::Value,
        _scope: &str,
        _overwrite: bool,
    ) -> Result<serde_json::Value, WorkflowEngineError> {
        Err(not_found())
    }

    async fn hub_update_saved_workflow_meta(
        &self,
        _workspace_path: &str,
        _name: &str,
        _meta: serde_json::Value,
        _scope: &str,
    ) -> Result<serde_json::Value, WorkflowEngineError> {
        Err(not_found())
    }

    async fn hub_delete_saved_workflow(
        &self,
        _workspace_path: &str,
        _name: &str,
        _scope: &str,
    ) -> Result<serde_json::Value, WorkflowEngineError> {
        Err(not_found())
    }

    async fn hub_move_saved_workflow(
        &self,
        _workspace_path: &str,
        _name: &str,
    ) -> Result<serde_json::Value, WorkflowEngineError> {
        Err(not_found())
    }

    async fn hub_find_saved_workflow_for_run(
        &self,
        _workspace_path: &str,
        _run_id: &str,
        _candidates: serde_json::Value,
    ) -> Result<serde_json::Value, WorkflowEngineError> {
        Err(not_found())
    }
}

/// 通知中心假件（与升级注册表测试同一个形状）：记 (session, text, originMeta)。
#[derive(Default)]
struct Recording {
    sent: Mutex<Vec<(String, String, Option<serde_json::Value>)>>,
}

impl WorkflowNotices for Recording {
    fn notify(&self, session: &SessionId, text: String) {
        self.sent
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((session.as_str().to_owned(), text, None));
    }

    fn notify_with(
        &self,
        session: &SessionId,
        text: String,
        origin_meta: Option<serde_json::Value>,
    ) {
        self.sent
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((session.as_str().to_owned(), text, origin_meta));
    }
}

// ============================================================
// 夹具
// ============================================================

const RUN: &str = "dwfrun-0123456789abcdef";

fn running_run(id: &str, name: Option<&str>) -> DynamicWorkflowRun {
    DynamicWorkflowRun {
        id: id.to_owned(),
        name: name.map(str::to_owned),
        status: "running".to_owned(),
        session_id: Some(SESSION.to_owned()),
        cwd: "/work".to_owned(),
        resumed_from: None,
        tool_call_id: None,
        spent_tokens: 0,
        created_at: 1,
        updated_at: 1,
    }
}

fn empty_detail(run_id: &str) -> WorkflowRunDetail {
    WorkflowRunDetail {
        run_id: run_id.to_owned(),
        label: run_id.to_owned(),
        label_source: "script",
        status: "running".to_owned(),
        stop_reason: None,
        resumed_from: None,
        superseded_by: None,
        owned_by_this_session: true,
        created_at: 1,
        updated_at: 1,
        spent_tokens: 0,
        nodes: WorkflowRunNodeCounts {
            observed: 0,
            running: 0,
            completed: 0,
            failed: 0,
        },
        actors: vec![WorkflowRunActor {
            site_id: "worker".to_owned(),
            ordinal: 1,
            name: Some("worker".to_owned()),
        }],
        log_tail: Vec::new(),
        pending_questions: Vec::new(),
        result_text: None,
        error: None,
        max_concurrency: None,
        subagent_model: None,
        model_bindings: None,
        phases: None,
        subagents: Vec::new(),
        health: WorkflowRunHealth {
            last_progress_at: None,
            stalled_since: None,
            concurrency: None,
            consecutive_failures: 0,
            cached_steps: 0,
            leftover_running: None,
            pending_questions_known: true,
        },
        holes: None,
        artifacts: None,
    }
}

fn detail_with_hole(run_id: &str, hole: WorkflowRunHole) -> WorkflowRunDetail {
    let mut detail = empty_detail(run_id);
    detail.holes = Some(vec![hole]);
    detail
}

fn fill_target(waiting: &[&str], draft: Option<&str>) -> WorkflowFillTarget {
    WorkflowFillTarget {
        name: None,
        draft_path: draft.map(str::to_owned),
        status: "running".to_owned(),
        stop_reason: None,
        holes: waiting
            .iter()
            .map(|site| WorkflowFillTargetHole {
                site_id: (*site).to_owned(),
                name: format!("{site} hole"),
                hole_type: "Verdict".to_owned(),
                line: Some(12),
                waiting: true,
            })
            .collect(),
    }
}

/// 板 + 通知假件；延迟档注入（暂停时钟下走虚拟毫秒）。
fn board(
    store: Arc<FakeStore>,
    engine: Option<Arc<FakeEngine>>,
    escalations: Arc<WorkflowEscalations>,
    delays: Vec<u64>,
) -> (Arc<WorkflowBlockedBoard>, Arc<Recording>, TaskHandleGuard) {
    let engine_slot: rust_cli_tools::WorkflowEngineSlot = Arc::new(std::sync::Mutex::new(
        engine.map(|engine| engine as Arc<dyn WorkflowEngine>),
    ));
    let scope = std::boxed::Box::leak(Box::new(rust_cli_base::TaskScope::root(
        "blocked-board-test",
        |_| {},
    )));
    let board = Arc::new(WorkflowBlockedBoard::with_delays(
        store,
        escalations,
        engine_slot,
        Arc::new(FixedClock(1_000_000)),
        scope.spawner(),
        delays,
    ));
    let recording = Arc::new(Recording::default());
    board.attach_notifier(recording.clone());
    (board, recording, TaskHandleGuard)
}

/// 作用域的守卫占位：root 作用域随进程结束；测试任务都在暂停时钟下很快落定。
struct TaskHandleGuard;

/// 停一个升级问答（测试里 park 在 spawn 的任务里等答案，与升级注册表测试同一做法）。
fn park_question(escalations: &Arc<WorkflowEscalations>, run_id: &str) {
    let port = Arc::new(EscalationPort(escalations.clone()));
    let run_id = run_id.to_owned();
    tokio::spawn(async move {
        let _ = port
            .escalate(rust_cli_kernel_api::workflow::WorkflowEscalationRequest {
                parent: SESSION.to_owned(),
                run_id,
                actor: "worker#1@1".to_owned(),
                actor_name: Some("worker".to_owned()),
                ask: "worker#1@1".to_owned(),
                question: "Which way?".to_owned(),
                context: Some("tried both".to_owned()),
            })
            .await;
    });
}

async fn wait_parked(escalations: &Arc<WorkflowEscalations>) {
    for _ in 0..500 {
        if !escalations.pending(&SessionId::new(SESSION)).is_empty() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the escalation was never parked");
}

fn sent(recording: &Recording) -> Vec<(String, String, Option<serde_json::Value>)> {
    recording
        .sent
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// 暂停时钟走一大步（60s ≫ 测试档）。注意：在某一步的轮询里排下的定时器，驱动要到再
/// 往后的步子里才触发（tokio 的 advance 先跳时再轮询）；测试因此不断言「第几拍」，
/// 只用 [`ticks_until`] 轮询到预期状态。
async fn tick() {
    tokio::time::advance(std::time::Duration::from_secs(60)).await;
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
}

/// 一步步推进，直到第 `want` 条提醒出现（或拍数用尽——失败）。
async fn ticks_until(recording: &Recording, want: usize, what: &str) {
    for _ in 0..8 {
        tick().await;
        if sent(recording).len() >= want {
            return;
        }
    }
    panic!("reminders never reached {want}: {what}");
}

// ============================================================
// 测试
// ============================================================

#[tokio::test(start_paused = true)]
async fn an_idle_session_with_an_open_question_is_reminded_once_per_delay() {
    let escalations = Arc::new(WorkflowEscalations::new(Arc::new(FixedClock(1_000_000))));
    park_question(&escalations, RUN);
    wait_parked(&escalations).await;
    let store = FakeStore::new(vec![running_run(RUN, Some("deploy"))]);
    let (board, recording, _guard) = board(store, None, escalations.clone(), vec![50, 100]);

    board.session_idle(&SessionId::new(SESSION));
    ticks_until(&recording, 1, "the first reminder").await;
    let rows = sent(&recording);
    assert_eq!(rows[0].0, SESSION);
    assert!(
        rows[0].1.contains("<workflow-blocked>"),
        "text:\n{}",
        rows[0].1
    );
    assert!(rows[0].1.contains(&format!("<run-id>{RUN}</run-id>")));
    assert!(rows[0].1.contains("<run>deploy</run>"));
    assert!(rows[0].1.contains("Which way?"));
    assert!(rows[0].1.contains("ResolveWorkflowQuestion"));
    let meta = rows[0].2.as_ref().expect("structured origin meta");
    assert_eq!(meta["backgroundSource"], "workflow");
    assert_eq!(meta["title"], "deploy");
    assert_eq!(meta["workId"], RUN);
    assert_eq!(meta["workflowBlocked"]["questions"], 1);
    assert_eq!(meta["workflowBlocked"]["holes"], 0);

    // 第二次提醒在再空闲 100ms 之后（这一轮没有真正开始——通知假件不唤醒会话）。
    ticks_until(&recording, 2, "the second reminder").await;
    // 之后再无（上限两对）。
    for _ in 0..4 {
        tick().await;
    }
    assert_eq!(sent(&recording).len(), 2, "no third reminder");
}

#[tokio::test(start_paused = true)]
async fn a_busy_session_is_not_reminded() {
    let escalations = Arc::new(WorkflowEscalations::new(Arc::new(FixedClock(1_000_000))));
    park_question(&escalations, RUN);
    wait_parked(&escalations).await;
    let store = FakeStore::new(vec![running_run(RUN, None)]);
    let (board, recording, _guard) = board(store, None, escalations.clone(), vec![50, 100]);

    board.session_idle(&SessionId::new(SESSION));
    board.session_busy(&SessionId::new(SESSION));
    for _ in 0..4 {
        tick().await;
    }
    assert!(
        sent(&recording).is_empty(),
        "busy sessions are not reminded"
    );
}

#[tokio::test(start_paused = true)]
async fn a_user_message_restores_the_full_pair() {
    let escalations = Arc::new(WorkflowEscalations::new(Arc::new(FixedClock(1_000_000))));
    park_question(&escalations, RUN);
    wait_parked(&escalations).await;
    let store = FakeStore::new(vec![running_run(RUN, None)]);
    let (board, recording, _guard) = board(store, None, escalations.clone(), vec![50, 100]);

    board.session_idle(&SessionId::new(SESSION));
    ticks_until(&recording, 1, "the first reminder").await;

    // 用户发话：次数清零，下一轮从第 1 次重算（间隔也从发话后的空闲起算）。
    board.session_busy(&SessionId::new(SESSION));
    board.user_spoke(&SessionId::new(SESSION));
    board.session_idle(&SessionId::new(SESSION));
    ticks_until(&recording, 2, "the restarted pair").await;
    let rows = sent(&recording);
    assert_eq!(rows.len(), 2);
    assert!(
        rows[1].1.contains("<reminder>1 of 2</reminder>"),
        "the pair restarts at ordinal 1:\n{}",
        rows[1].1
    );
}

#[tokio::test(start_paused = true)]
async fn an_open_set_change_rearms_an_already_idle_clock() {
    let escalations = Arc::new(WorkflowEscalations::new(Arc::new(FixedClock(1_000_000))));
    park_question(&escalations, RUN);
    wait_parked(&escalations).await;
    let store = FakeStore::new(vec![running_run(RUN, None)]);
    let (board, recording, _guard) = board(store, None, escalations.clone(), vec![50, 100]);

    // 空闲已久（两次提醒都已发过）。
    board.session_idle(&SessionId::new(SESSION));
    ticks_until(&recording, 1, "the first reminder").await;
    ticks_until(&recording, 2, "the second reminder").await;

    // 新的决定到来：这一对重算，空闲钟从此刻重起（Node openSetChanged 的「闲了三小时的新
    // 一对不能因为早就过点而永远排不上」）。
    park_question(&escalations, RUN);
    wait_parked(&escalations).await;
    board.open_set_changed(&SessionId::new(SESSION), RUN);
    ticks_until(&recording, 3, "the fresh pair's first").await;
    let rows = sent(&recording);
    assert!(
        rows[2].1.contains("<reminder>1 of 2</reminder>"),
        "the new decision gets a fresh pair:\n{}",
        rows[2].1
    );
}

#[tokio::test(start_paused = true)]
async fn a_waiting_hole_is_read_from_the_engine_and_scheduled() {
    let escalations = Arc::new(WorkflowEscalations::new(Arc::new(FixedClock(1_000_000))));
    let store = FakeStore::new(vec![running_run(RUN, Some("fix"))]).with_detail(
        RUN,
        detail_with_hole(
            RUN,
            WorkflowRunHole {
                site_id: "decide".to_owned(),
                ordinal: 1,
                name: "decide hole".to_owned(),
                hole_type: "Verdict".to_owned(),
                state: "reached".to_owned(),
                since: Some(1_000_000 - 90_000),
                filled_at: None,
                filled_by: None,
            },
        ),
    );
    let engine = Arc::new(FakeEngine {
        targets: Mutex::new(HashMap::new()),
    })
    .with_target(RUN, fill_target(&["decide"], Some("/work/draft.ts")));
    let (board, recording, _guard) = board(store, Some(engine), escalations, vec![50, 100]);

    board.session_idle(&SessionId::new(SESSION));
    ticks_until(&recording, 1, "the hole reminder").await;
    let rows = sent(&recording);
    assert!(
        rows[0].1.contains("<open-holes count=\"1\" shown=\"1\">"),
        "text:\n{}",
        rows[0].1
    );
    assert!(rows[0].1.contains("read the draft at /work/draft.ts"));
    assert!(rows[0].1.contains("FillWorkflowHole"));
    assert_eq!(rows[0].2.as_ref().unwrap()["workflowBlocked"]["holes"], 1);
}

#[tokio::test(start_paused = true)]
async fn a_zombie_run_row_is_never_reminded() {
    // 上一世的 run 行：store 还说 running，引擎不认识它、注册表空——没有开着的决定，不提醒。
    let escalations = Arc::new(WorkflowEscalations::new(Arc::new(FixedClock(1_000_000))));
    let store = FakeStore::new(vec![running_run(RUN, None)]);
    let engine = Arc::new(FakeEngine {
        targets: Mutex::new(HashMap::new()),
    }); // fill_target 一律 run_not_found
    let (board, recording, _guard) = board(store, Some(engine), escalations, vec![50, 100]);

    board.session_idle(&SessionId::new(SESSION));
    for _ in 0..4 {
        tick().await;
    }
    assert!(sent(&recording).is_empty(), "zombie rows stay quiet");
}

#[tokio::test(start_paused = true)]
async fn a_closed_session_stops_reminding() {
    let escalations = Arc::new(WorkflowEscalations::new(Arc::new(FixedClock(1_000_000))));
    park_question(&escalations, RUN);
    wait_parked(&escalations).await;
    let store = FakeStore::new(vec![running_run(RUN, None)]);
    let (board, recording, _guard) = board(store, None, escalations.clone(), vec![50, 100]);

    board.session_closed(&SessionId::new(SESSION));
    for _ in 0..4 {
        tick().await;
    }
    assert!(sent(&recording).is_empty(), "closed sessions stay quiet");
}

#[tokio::test(start_paused = true)]
async fn a_late_refresh_catches_runs_that_started_while_busy() {
    // run 在忙段里启动、留白在忙段里到达（同步半用旧快照——空表——排不了钟），刷新落定后
    // 的重放把它补上。
    let escalations = Arc::new(WorkflowEscalations::new(Arc::new(FixedClock(1_000_000))));
    let store = FakeStore::new(Vec::new());
    let engine = Arc::new(FakeEngine {
        targets: Mutex::new(HashMap::new()),
    })
    .with_target(RUN, fill_target(&["decide"], None));
    let (board, recording, _guard) = board(store.clone(), Some(engine), escalations, vec![50, 100]);

    board.session_idle(&SessionId::new(SESSION));
    // run 此时才出现（store 现在才返回它）+ 开集沿到达。
    *store.runs.lock().unwrap_or_else(PoisonError::into_inner) =
        vec![running_run(RUN, Some("late"))];
    board.open_set_changed(&SessionId::new(SESSION), RUN);
    // 一大步（60s）足以把两档都走完，这里只断言「新 run 被排上并发出」，不数条数。
    ticks_until(&recording, 1, "the late run's reminder").await;
    let rows = sent(&recording);
    assert!(!rows.is_empty(), "the refreshed snapshot arms the new run");
    assert_eq!(rows[0].2.as_ref().unwrap()["title"], "late");
}

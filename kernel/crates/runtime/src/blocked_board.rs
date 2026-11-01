//! 「run 还欠着决定、主代理闲着」提醒钟的宿主装配（docs/dynamic-workflow/
//! transcript-and-notifications.md「Reminding an idle main agent」）。钟本体是
//! [`crate::blocked`] 的纯件（Node 同名机制逐字移植）；本模块把它接到内核的各端口上：
//!
//!   - 忙闲沿来自会话 actor（kernel-api [`WorkflowBlockedEdges`]），开集沿来自引擎客户端
//!     （`Kernel::workflow_blocked`）；「在飞的 run」与「开着的决定」到点现读——run 行读会话
//!     库（`dwf_run`，`running` 才算在飞），留白的等待态读引擎（`fill_target` 的 `waiting`
//!     才是停驻表的真相；journal 只到「到达过」），停驻的升级问答读注册表
//!     （[`WorkflowEscalations::pending`]，进程内的真相——冷回放的问题不提醒，与 Node 读
//!     活快照同一口径）；
//!   - 发出走 [`WorkflowNotices`]（升级提示同一条 `task-notification` 路，空闲时开通知轮）。
//!
//! 与 Node 的接线差一处：store 的 live-run 查询是异步的，而钟的边缘与排钟是同步的。每个
//! 边缘先做同步的那半（停钟 / 清次数 / 按现有快照排钟），再后台刷新一次快照、对开集沿重放
//! 同一个入口。两次调用都幂等；同步半用旧快照漏排的 run，由刷新后的重放或到点复核补上
//! （`expire` 对 `delay <= reached` 的 run 现读现判）。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use futures_util::future::BoxFuture;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::SessionStore;
use rust_cli_kernel_api::workflow::{WorkflowBlockedEdges, WorkflowEngineSlot, WorkflowNotices};
use tokio_util::sync::CancellationToken;

use crate::blocked::{
    BoxedFire, WORKFLOW_BLOCKED_REMINDER_DELAYS_MS, WorkflowBlockedHole,
    WorkflowBlockedNoticeInput, WorkflowBlockedQuestion, WorkflowBlockedReminder,
    WorkflowBlockedReminderClock, WorkflowBlockedReminderHost, WorkflowOpenDecisions,
    format_workflow_blocked_notification,
};
use crate::escalations::WorkflowEscalations;

/// 快照里的一行在飞 run（提醒的展示名从这取：run 行的名字缺席落 runId——与升级通知同一条
/// 兜底链的起点；标签链的「脚本首行」段要扫事件，刷新太频繁，这里不用）。
struct LiveRun {
    id: String,
    name: Option<String>,
}

/// 一个会话的宿主（[`WorkflowBlockedReminderHost`] 的实现）。
struct SessionHost {
    session: SessionId,
    shared: Arc<BoardShared>,
    /// actor 最近一次报的忙闲（到点复核的最后一道核对）。
    busy: std::sync::atomic::AtomicBool,
    /// 在飞的 run 快照（store 查询是异步的，排钟是同步的——后台刷新写这里，排钟与到点读它）。
    /// 只增不改地留着退出视野的 run 无害：到点现读的开集会对它返回空。
    live: Mutex<Vec<LiveRun>>,
    /// 边缘代际：每个边缘自增；后台刷新捕获铸造时的代际，对不上（期间又有边缘进来）就丢弃
    /// ——只有最新一次刷新值得落库，旧的抢跑只会用更旧的输入覆盖。
    edge_epoch: AtomicU64,
    /// 自引用（[`Self::read_open`] 的 future 要 `'static`）：板铸宿主后立刻塞进弱引用。
    self_ref: std::sync::OnceLock<std::sync::Weak<SessionHost>>,
    timers: Mutex<HashMap<u64, CancellationToken>>,
    next_timer: AtomicU64,
}

/// 装配层共用的端口（进程级一份；宿主按会话拿走引用）。
struct BoardShared {
    store: Arc<dyn SessionStore>,
    escalations: Arc<WorkflowEscalations>,
    /// 通知中心（`Agents` 建好之后接上；接上之前提醒静默——与升级注册表同一条时序）。
    notifier: Mutex<Option<Arc<dyn WorkflowNotices>>>,
    /// DWF 引擎槽（sidecar 在入口最后才接上；留白的等待态与草稿路径到点现读）。
    engine: WorkflowEngineSlot,
    clock: Arc<dyn Clock>,
    spawner: rust_cli_base::Spawner,
    /// 两次提醒的空闲档（测试注入更短的档；生产是 [`WORKFLOW_BLOCKED_REMINDER_DELAYS_MS`]）。
    delays: Vec<u64>,
}

impl SessionHost {
    fn lock_timers(&self) -> MutexGuard<'_, HashMap<u64, CancellationToken>> {
        self.timers.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_live(&self) -> MutexGuard<'_, Vec<LiveRun>> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 后台刷新在飞的 run 快照（`dwf_run.parent_session_id`，`running` 才算在飞）。查询失败
    /// 保留旧快照（下一次边缘再试），记一条 warn。
    async fn refresh_live(&self) {
        match self.shared.store.workflow_runs(&self.session).await {
            Ok(runs) => {
                let live = runs
                    .into_iter()
                    .filter(|run| run.status == "running")
                    .map(|run| LiveRun {
                        id: run.id,
                        name: run.name,
                    })
                    .collect::<Vec<_>>();
                *self.lock_live() = live;
            }
            Err(error) => {
                tracing::warn!(
                    event = "dwf.blocked.live_query_failed",
                    session = %self.session,
                    %error,
                    "the live workflow run query failed; keeping the previous snapshot"
                );
            }
        }
    }

    /// 会话名下这个 run 此刻开着的决定。升级问答读停驻注册表，留白读引擎的等待表（`waiting`
    /// 才算还欠着；等待时长从 journal 的到达行补，读不到按 0 算——文案退化为不带时长）。
    async fn read_open_inner(&self, run_id: &str) -> Result<Option<WorkflowOpenDecisions>, String> {
        let questions = self
            .shared
            .escalations
            .pending(&self.session)
            .into_iter()
            .filter(|question| question.run_id == run_id)
            .map(|question| WorkflowBlockedQuestion {
                qid: question.qid,
                actor: question.actor,
                actor_name: question.actor_name,
                question: question.question,
                context: question.context,
                asked_at: Some(question.asked_at),
            })
            .collect::<Vec<_>>();

        let engine = self
            .shared
            .engine
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let (holes, draft_path) = match &engine {
            Some(engine) => match engine.fill_target(run_id).await {
                Ok(target) => {
                    // 引擎只说「谁在等」；到达时刻在 journal 的留白行上（未补过的才有）。
                    let since = match self
                        .shared
                        .store
                        .workflow_run_detail(&self.session, run_id)
                        .await
                    {
                        Ok(Some(detail)) => detail
                            .holes
                            .unwrap_or_default()
                            .into_iter()
                            .filter(|hole| hole.filled_at.is_none())
                            .map(|hole| (hole.site_id, hole.since))
                            .collect::<HashMap<_, _>>(),
                        _ => HashMap::new(),
                    };
                    let holes = target
                        .holes
                        .into_iter()
                        .filter(|hole| hole.waiting)
                        .map(|hole| WorkflowBlockedHole {
                            site_id: hole.site_id.clone(),
                            name: hole.name,
                            hole_type: hole.hole_type,
                            line: hole.line,
                            since: since.get(&hole.site_id).copied().flatten(),
                        })
                        .collect::<Vec<_>>();
                    (holes, target.draft_path)
                }
                // 引擎不认识这个 run（上一世的，或刚结算完）：没有等待的留白。
                Err(_) => (Vec::new(), None),
            },
            None => (Vec::new(), None),
        };

        if questions.is_empty() && holes.is_empty() {
            return Ok(None);
        }
        Ok(Some(WorkflowOpenDecisions {
            questions,
            holes,
            draft_path,
        }))
    }

    /// 发出一条提醒（Node `enqueueBlockedReminder` 同形）：文案用纯件的逐字移植；结构化
    /// originMeta 走自己的 `workflowBlocked` 键——`workflowNotification` 的 union 在线上是
    /// 闭集，多一个成员会让不认识它的客户端拒掉整帧。展示名从快照的名字取（缺席落 runId）。
    fn remind(&self, reminder: WorkflowBlockedReminder) {
        let notifier = self
            .shared
            .notifier
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some(notifier) = notifier else {
            tracing::warn!(event = "dwf.blocked.no_notices", run = %reminder.run_id);
            return;
        };
        let run_label = self
            .lock_live()
            .iter()
            .find(|run| run.id == reminder.run_id)
            .and_then(|run| run.name.clone())
            .unwrap_or_else(|| reminder.run_id.clone());
        let since_ms =
            reminder
                .open
                .questions
                .iter()
                .filter_map(|question| question.asked_at.map(|at| reminder.now.saturating_sub(at)))
                .chain(
                    reminder.open.holes.iter().filter_map(|hole| {
                        hole.since.map(|since| reminder.now.saturating_sub(since))
                    }),
                )
                .max()
                .unwrap_or(0);
        tracing::info!(
            event = "dynamic_workflow.blocked.reminder_sent",
            run = %reminder.run_id,
            ordinal = reminder.ordinal,
            questions = reminder.open.questions.len(),
            holes = reminder.open.holes.len(),
            since_ms,
            "Dynamic workflow blocked reminder sent"
        );
        let origin_meta = serde_json::json!({
            "backgroundSource": "workflow",
            "title": run_label,
            "workId": reminder.run_id,
            "workflowBlocked": {
                "questions": reminder.open.questions.len(),
                "holes": reminder.open.holes.len(),
                "sinceMs": since_ms,
            },
        });
        let text = format_workflow_blocked_notification(&WorkflowBlockedNoticeInput {
            run_label,
            run_id: reminder.run_id.clone(),
            ordinal: reminder.ordinal,
            total: reminder.total,
            now: reminder.now,
            questions: reminder.open.questions,
            holes: reminder.open.holes,
            draft_path: reminder.open.draft_path,
        });
        notifier.notify_with(&self.session, text, Some(origin_meta));
    }
}

impl WorkflowBlockedReminderHost for SessionHost {
    fn now_ms(&self) -> u64 {
        self.shared.clock.now_ms()
    }

    fn is_idle(&self) -> bool {
        !self.busy.load(Ordering::SeqCst)
    }

    fn live_run_ids(&self) -> Vec<String> {
        self.lock_live().iter().map(|run| run.id.clone()).collect()
    }

    fn read_open(
        &self,
        run_id: &str,
    ) -> BoxFuture<'static, Result<Option<WorkflowOpenDecisions>, String>> {
        // future 要 'static：拿自引用升级成强引用（读的期间宿主活着；会话已关时宿主将亡，
        // 读的结果随作废的钟一起被丢）。
        let this = self.self_ref.get().and_then(std::sync::Weak::upgrade);
        let run_id = run_id.to_owned();
        Box::pin(async move {
            match this {
                Some(host) => host.read_open_inner(&run_id).await,
                None => Ok(None),
            }
        })
    }

    fn remind(&self, reminder: WorkflowBlockedReminder) {
        self.remind(reminder);
    }

    fn schedule(&self, delay_ms: u64, fire: BoxedFire) -> u64 {
        let token = CancellationToken::new();
        let timer = self.next_timer.fetch_add(1, Ordering::SeqCst);
        self.lock_timers().insert(timer, token.clone());
        let spawner = self.shared.spawner.clone();
        spawner.spawn("dwf-blocked-timer", async move {
            tokio::select! {
                () = token.cancelled() => {}
                () = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => {
                    fire().await
                }
            }
        });
        timer
    }

    fn cancel_timer(&self, timer: u64) {
        if let Some(token) = self.lock_timers().remove(&timer) {
            token.cancel();
        }
    }
}

/// 后台刷新的载荷：刷新快照后（代际还对得上才）重排。开集沿重放同一个入口（漏掉的新 run
/// 重新得到一对）；空闲沿走 [`WorkflowBlockedReminderClock::rearm`]（同步半按旧快照可能
/// 漏排——到点复核只在有定时器时发生，漏排要靠这里补）。
enum MoveEdge {
    Idle,
    OpenSet(String),
}

fn refresh_later(
    clock: WorkflowBlockedReminderClock<SessionHost>,
    host: Arc<SessionHost>,
    epoch: u64,
    edge: MoveEdge,
) {
    let spawner = host.shared.spawner.clone();
    spawner.spawn("dwf-blocked-refresh", async move {
        host.refresh_live().await;
        if host.edge_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        match edge {
            MoveEdge::Idle => clock.rearm(),
            MoveEdge::OpenSet(run_id) => clock.open_set_changed(&run_id),
        }
    });
}

/// 「run 还欠着决定、主代理闲着」的提醒钟板（进程级一份；每个会话一尊钟）。
pub struct WorkflowBlockedBoard {
    shared: Arc<BoardShared>,
    sessions: Mutex<HashMap<SessionId, SessionEntry>>,
}

struct SessionEntry {
    clock: WorkflowBlockedReminderClock<SessionHost>,
    host: Arc<SessionHost>,
}

impl WorkflowBlockedBoard {
    pub fn new(
        store: Arc<dyn SessionStore>,
        escalations: Arc<WorkflowEscalations>,
        engine: WorkflowEngineSlot,
        clock: Arc<dyn Clock>,
        spawner: rust_cli_base::Spawner,
    ) -> Self {
        Self::with_delays(
            store,
            escalations,
            engine,
            clock,
            spawner,
            WORKFLOW_BLOCKED_REMINDER_DELAYS_MS.to_vec(),
        )
    }

    /// 测试注入更短的空闲档（Node 构造函数第二参的同一缝）。
    pub fn with_delays(
        store: Arc<dyn SessionStore>,
        escalations: Arc<WorkflowEscalations>,
        engine: WorkflowEngineSlot,
        clock: Arc<dyn Clock>,
        spawner: rust_cli_base::Spawner,
        delays: Vec<u64>,
    ) -> Self {
        Self {
            shared: Arc::new(BoardShared {
                store,
                escalations,
                notifier: Mutex::new(None),
                engine,
                clock,
                spawner,
                delays,
            }),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 接上通知中心（`Agents` 建好之后；接上之前提醒静默）。
    pub fn attach_notifier(&self, notifier: Arc<dyn WorkflowNotices>) {
        *self
            .shared
            .notifier
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(notifier);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, SessionEntry>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 拿到（或铸出）这个会话的钟与宿主。边缘入口的第一个调用者付铸造成本；之后都拿现成的。
    fn parts(
        &self,
        session: &SessionId,
    ) -> (WorkflowBlockedReminderClock<SessionHost>, Arc<SessionHost>) {
        let mut sessions = self.lock();
        let entry = sessions.entry(session.clone()).or_insert_with(|| {
            let host = Arc::new(SessionHost {
                session: session.clone(),
                shared: self.shared.clone(),
                busy: std::sync::atomic::AtomicBool::new(false),
                live: Mutex::new(Vec::new()),
                edge_epoch: AtomicU64::new(0),
                self_ref: std::sync::OnceLock::new(),
                timers: Mutex::new(HashMap::new()),
                next_timer: AtomicU64::new(0),
            });
            // read_open 的 future 从弱引用升级：宿主在这里正式成形后立刻记下。
            let _ = host.self_ref.set(Arc::downgrade(&host));
            SessionEntry {
                clock: WorkflowBlockedReminderClock::with_delays(
                    host.clone(),
                    self.shared.delays.clone(),
                ),
                host,
            }
        });
        (entry.clock.clone(), entry.host.clone())
    }
}

impl WorkflowBlockedEdges for WorkflowBlockedBoard {
    fn session_busy(&self, session: &SessionId) {
        let (clock, host) = self.parts(session);
        host.busy.store(true, Ordering::SeqCst);
        host.edge_epoch.fetch_add(1, Ordering::SeqCst);
        // 钟停（状态入口，纯同步）；在飞快照不清——下一次空闲沿的排钟还要用它，到点复核
        // 会现读开集把已结算的 run 筛掉。
        clock.session_busy();
    }

    fn session_idle(&self, session: &SessionId) {
        let (clock, host) = self.parts(session);
        host.busy.store(false, Ordering::SeqCst);
        let epoch = host.edge_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        // 排钟需要在飞的 run（异步查询）：先按现有快照排，再后台刷新一次。
        clock.session_idle();
        refresh_later(clock, host, epoch, MoveEdge::Idle);
    }

    fn user_spoke(&self, session: &SessionId) {
        self.parts(session).0.user_spoke();
    }

    fn open_set_changed(&self, session: &SessionId, run_id: &str) {
        let (clock, host) = self.parts(session);
        let epoch = host.edge_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        clock.open_set_changed(run_id);
        refresh_later(clock, host, epoch, MoveEdge::OpenSet(run_id.to_owned()));
    }

    fn session_closed(&self, session: &SessionId) {
        if let Some(entry) = self.lock().remove(session) {
            entry.clock.stop();
            for (_, token) in entry.host.lock_timers().drain() {
                token.cancel();
            }
        }
    }
}

#[cfg(test)]
#[path = "blocked_board_tests.rs"]
mod tests;

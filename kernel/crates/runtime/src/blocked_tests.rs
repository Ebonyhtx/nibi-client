//! 提醒钟与文案的钉子。钟的 15 个行为场景从 Node 的
//! `tests/workflow-blocked-reminder-clock.test.ts` 逐条移植（手动时钟 + 手动定时器，
//! 一毫秒不真等；期望值从规格算出，不从实现读回）；文案的三案与 Node
//! `formatWorkflowBlockedNotification` 的实测输出逐字节对拍。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;

use super::*;

const MIN: u64 = 60_000;
// 规格时间推进钟；不从实现读取期望值。
const FIRST: u64 = 15 * MIN;
const SECOND: u64 = 30 * MIN;

fn question(qid: &str) -> WorkflowBlockedQuestion {
    WorkflowBlockedQuestion {
        qid: qid.to_owned(),
        actor: "actor#1@1".to_owned(),
        actor_name: None,
        question: format!("q {qid}"),
        context: None,
        asked_at: Some(0),
    }
}

fn hole(site_id: &str) -> WorkflowBlockedHole {
    WorkflowBlockedHole {
        site_id: site_id.to_owned(),
        name: site_id.to_owned(),
        hole_type: "Plan".to_owned(),
        line: None,
        since: Some(0),
    }
}

/// 一条已发提醒的观察面（runId / ordinal / now / 开集内容）。
#[derive(Clone, Debug, PartialEq)]
struct SentRecord {
    run_id: String,
    ordinal: usize,
    now: u64,
    question_ids: Vec<String>,
    hole_ids: Vec<String>,
}

fn state_of(state: &Arc<Mutex<ManualState>>) -> std::sync::MutexGuard<'_, ManualState> {
    state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct ManualState {
    now: u64,
    next_timer: u64,
    /// (id, at, fire)
    timers: Vec<(u64, u64, BoxedFire)>,
    open: HashMap<String, Option<WorkflowOpenDecisions>>,
    live: Vec<String>,
    sent: Vec<SentRecord>,
    reads: Vec<String>,
    idle: bool,
}

#[derive(Clone)]
struct ManualHost {
    state: Arc<Mutex<ManualState>>,
}

impl ManualHost {
    fn lock(&self) -> std::sync::MutexGuard<'_, ManualState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl WorkflowBlockedReminderHost for ManualHost {
    fn now_ms(&self) -> u64 {
        self.lock().now
    }

    fn is_idle(&self) -> bool {
        self.lock().idle
    }

    fn live_run_ids(&self) -> Vec<String> {
        self.lock().live.clone()
    }

    fn read_open(
        &self,
        run_id: &str,
    ) -> BoxFuture<'static, Result<Option<WorkflowOpenDecisions>, String>> {
        let open = self.lock().open.get(run_id).cloned().flatten();
        self.lock().reads.push(run_id.to_owned());
        Box::pin(async move { Ok(open) })
    }

    fn remind(&self, reminder: WorkflowBlockedReminder) {
        self.lock().sent.push(SentRecord {
            run_id: reminder.run_id,
            ordinal: reminder.ordinal,
            now: reminder.now,
            question_ids: reminder.open.questions.iter().map(|q| q.qid.clone()).collect(),
            hole_ids: reminder.open.holes.iter().map(|h| h.site_id.clone()).collect(),
        });
    }

    fn schedule(&self, delay_ms: u64, fire: BoxedFire) -> u64 {
        let mut state = self.lock();
        let id = state.next_timer;
        state.next_timer += 1;
        let at = state.now + delay_ms;
        state.timers.push((id, at, fire));
        id
    }

    fn cancel_timer(&self, timer: u64) {
        self.lock().timers.retain(|(id, _, _)| *id != timer);
    }
}

/// Node harness 的 `turn`：一轮开始又结束——钟先停、空闲沿再起。
async fn turn(clock: &WorkflowBlockedReminderClock<ManualHost>, host: &ManualHost, duration_ms: u64) {
    host.lock().idle = false;
    clock.session_busy();
    advance(host, duration_ms).await;
    host.lock().idle = true;
    clock.session_idle();
}

/// 推进手动时钟并触发到点的定时器（含回调里新排的）。
async fn advance(host: &ManualHost, ms: u64) {
    let target = host.lock().now + ms;
    loop {
        let due = {
            let mut state = host.lock();
            let due = state
                .timers
                .iter()
                .enumerate()
                .filter(|(_, (_, at, _))| *at <= target)
                .min_by_key(|(_, (_, at, _))| *at)
                .map(|(index, _)| index);
            due.map(|index| state.timers.remove(index))
        };
        let Some((_, at, fire)) = due else {
            break;
        };
        host.lock().now = at;
        fire().await;
    }
    host.lock().now = target;
}

fn pending_timers(host: &ManualHost) -> usize {
    host.lock().timers.len()
}

/// 造钟 + 手动宿主；`open` 由测试随手改来模拟作答 / 补全。
fn harness() -> (
    WorkflowBlockedReminderClock<ManualHost>,
    Arc<Mutex<ManualState>>,
    ManualHost,
) {
    let state = Arc::new(Mutex::new(ManualState {
        now: 0,
        next_timer: 0,
        timers: Vec::new(),
        open: HashMap::new(),
        live: Vec::new(),
        sent: Vec::new(),
        reads: Vec::new(),
        idle: true,
    }));
    let host = ManualHost {
        state: state.clone(),
    };
    (WorkflowBlockedReminderClock::new(Arc::new(host.clone())), state, host)
}

fn sent_of(host: &ManualHost) -> Vec<SentRecord> {
    host.lock().sent.clone()
}

// ============================================================
// 钟的行为（15 场景，Node 测试逐条移植）
// ============================================================

#[tokio::test]
async fn no_live_run_schedules_nothing() {
    let (clock, _, host) = harness();
    clock.session_idle();
    assert_eq!(pending_timers(&host), 0);
    advance(&host, 2 * 60 * MIN).await;
    assert!(sent_of(&host).is_empty());
    assert!(host.lock().reads.is_empty());
}

#[tokio::test]
async fn first_reminder_fires_at_fifteen_minutes_with_the_open_set_read_at_that_moment() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: vec![hole("hole#1")],
            draft_path: None,
        }),
    );
    clock.session_idle();

    advance(&host, FIRST - 1).await;
    assert!(sent_of(&host).is_empty());
    // 到点之前不读快照：钟不是轮询。
    assert!(host.lock().reads.is_empty());

    advance(&host, 1).await;
    let sent = sent_of(&host);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].run_id, "run-a");
    assert_eq!(sent[0].ordinal, 1);
    assert_eq!(sent[0].now, FIRST);
    assert_eq!(sent[0].question_ids, vec!["q1"]);
    assert_eq!(sent[0].hole_ids, vec!["hole#1"]);
}

#[tokio::test]
async fn no_open_decisions_at_due_time_neither_reminds_nor_burns_the_count() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    clock.session_idle();
    advance(&host, FIRST).await;
    assert_eq!(host.lock().reads, vec!["run-a"]);
    assert!(sent_of(&host).is_empty());

    // 之后它真的停住了（经一轮通知），下一个空闲沿起仍是第 1 次。
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    turn(&clock, &host, 0).await;
    advance(&host, FIRST).await;
    assert_eq!(sent_of(&host).iter().map(|r| r.ordinal).collect::<Vec<_>>(), vec![1]);
}

#[tokio::test]
async fn the_clock_measures_idle_time_not_decision_age() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();

    advance(&host, FIRST - MIN).await;
    // 第 14 分钟来了一轮（跑了 40 分钟）：钟停着，这 40 分钟里一条提醒都没有。
    turn(&clock, &host, 40 * MIN).await;
    assert!(sent_of(&host).is_empty());

    advance(&host, FIRST - 1).await;
    assert!(sent_of(&host).is_empty());
    advance(&host, 1).await;
    assert_eq!(sent_of(&host).len(), 1);
}

#[tokio::test]
async fn second_reminder_after_thirty_more_minutes_then_silence() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();
    advance(&host, FIRST).await;
    assert_eq!(sent_of(&host).iter().map(|r| r.ordinal).collect::<Vec<_>>(), vec![1]);

    // 提醒自己唤起一轮（模型没作答就收了尾）。
    turn(&clock, &host, MIN).await;
    advance(&host, SECOND - 1).await;
    assert_eq!(sent_of(&host).len(), 1);
    advance(&host, 1).await;
    assert_eq!(sent_of(&host).iter().map(|r| r.ordinal).collect::<Vec<_>>(), vec![1, 2]);

    turn(&clock, &host, MIN).await;
    advance(&host, 24 * 60 * MIN).await;
    assert_eq!(sent_of(&host).len(), 2);
    // 两次用完后连钟都不排：没有在后台空转的定时器。
    assert_eq!(pending_timers(&host), 0);
}

#[tokio::test]
async fn background_notification_turns_do_not_reset_the_counts() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();
    advance(&host, FIRST).await;
    turn(&clock, &host, 0).await;
    advance(&host, SECOND).await;
    assert_eq!(sent_of(&host).len(), 2);

    for _ in 0..5 {
        turn(&clock, &host, MIN).await;
        advance(&host, SECOND).await;
    }
    assert_eq!(sent_of(&host).len(), 2);
}

#[tokio::test]
async fn the_user_speaking_grants_every_run_a_fresh_pair() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();
    advance(&host, FIRST).await;
    turn(&clock, &host, 0).await;
    advance(&host, SECOND).await;
    assert_eq!(sent_of(&host).len(), 2);

    clock.user_spoke();
    turn(&clock, &host, MIN).await;
    advance(&host, FIRST).await;
    assert_eq!(
        sent_of(&host).iter().map(|r| r.ordinal).collect::<Vec<_>>(),
        vec![1, 2, 1]
    );
}

#[tokio::test]
async fn an_open_set_change_re_arms_only_that_run() {
    let (clock, state, host) = harness();
    state_of(&state).live = vec!["run-a".to_owned(), "run-b".to_owned()];
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("a1"), question("a2")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    state_of(&state).open.insert(
        "run-b".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: Vec::new(),
            holes: vec![hole("hole#b")],
            draft_path: None,
        }),
    );
    clock.session_idle();
    advance(&host, FIRST).await;
    turn(&clock, &host, 0).await;
    advance(&host, SECOND).await;
    assert_eq!(
        sent_of(&host)
            .iter()
            .map(|r| format!("{}:{}", r.run_id, r.ordinal))
            .collect::<Vec<_>>(),
        vec!["run-a:1", "run-b:1", "run-a:2", "run-b:2"]
    );

    // 主代理在一轮里答掉了 run-a 的一个问题（escalation-resolved）。
    host.lock().idle = false;
    clock.session_busy();
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("a2")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.open_set_changed("run-a");
    host.lock().idle = true;
    clock.session_idle();

    advance(&host, FIRST).await;
    assert_eq!(
        sent_of(&host)
            .iter()
            .skip(4)
            .map(|r| format!("{}:{}", r.run_id, r.ordinal))
            .collect::<Vec<_>>(),
        vec!["run-a:1"]
    );
}

#[tokio::test]
async fn an_open_set_change_while_idle_restarts_the_idle_clock() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();
    advance(&host, FIRST).await;
    turn(&clock, &host, 0).await;
    advance(&host, SECOND).await;
    assert_eq!(sent_of(&host).len(), 2);
    turn(&clock, &host, 0).await;

    // 空闲了 3 小时之后，这个 run 的开集变了（没有经过任何一轮）。
    advance(&host, 180 * MIN).await;
    clock.open_set_changed("run-a");
    advance(&host, FIRST - 1).await;
    assert_eq!(sent_of(&host).len(), 2);
    advance(&host, 1).await;
    assert_eq!(
        sent_of(&host).iter().map(|r| r.ordinal).collect::<Vec<_>>(),
        vec![1, 2, 1]
    );
}

#[tokio::test]
async fn counts_are_per_run() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("a1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();
    advance(&host, FIRST).await;
    assert_eq!(
        sent_of(&host)
            .iter()
            .map(|r| format!("{}:{}", r.run_id, r.ordinal))
            .collect::<Vec<_>>(),
        vec!["run-a:1"]
    );

    // run-b 在提醒那一轮里起来并停在一处留白上。
    host.lock().idle = false;
    clock.session_busy();
    state_of(&state).live.push("run-b".to_owned());
    state_of(&state).open.insert(
        "run-b".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: Vec::new(),
            holes: vec![hole("hole#b")],
            draft_path: None,
        }),
    );
    clock.open_set_changed("run-b");
    host.lock().idle = true;
    clock.session_idle();

    advance(&host, FIRST).await;
    assert_eq!(
        sent_of(&host)
            .iter()
            .skip(1)
            .map(|r| format!("{}:{}", r.run_id, r.ordinal))
            .collect::<Vec<_>>(),
        vec!["run-b:1"]
    );
}

#[tokio::test]
async fn a_busy_session_at_due_time_neither_reads_nor_sends() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();
    host.lock().idle = false;
    advance(&host, FIRST).await;
    assert!(host.lock().reads.is_empty());
    assert!(sent_of(&host).is_empty());
}

#[tokio::test]
async fn a_turn_arriving_while_reading_the_snapshot_voids_this_expiry() {
    use std::task::{Context, Poll};

    let now = Arc::new(Mutex::new(0u64));
    let timers: Arc<Mutex<Vec<(u64, BoxedFire)>>> = Arc::default();
    let sent: Arc<Mutex<Vec<String>>> = Arc::default();
    // read_open 挂在一扇手动放行的门上：expire 到点后停在快照读取里，作废发生在读的**中途**
    // （Node 测试的 release 同一时刻）。
    let released = Arc::new(Mutex::new(false));
    struct PendingHost {
        now: Arc<Mutex<u64>>,
        timers: Arc<Mutex<Vec<(u64, BoxedFire)>>>,
        sent: Arc<Mutex<Vec<String>>>,
        released: Arc<Mutex<bool>>,
    }
    impl WorkflowBlockedReminderHost for PendingHost {
        fn now_ms(&self) -> u64 {
            *self.now.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        }
        fn is_idle(&self) -> bool {
            true
        }
        fn live_run_ids(&self) -> Vec<String> {
            vec!["run-a".to_owned()]
        }
        fn read_open(
            &self,
            _run_id: &str,
        ) -> BoxFuture<'static, Result<Option<WorkflowOpenDecisions>, String>> {
            let released = self.released.clone();
            Box::pin(async move {
                std::future::poll_fn(|_| {
                    if *released.lock().unwrap_or_else(std::sync::PoisonError::into_inner) {
                        Poll::Ready(())
                    } else {
                        Poll::Pending
                    }
                })
                .await;
                Ok(Some(WorkflowOpenDecisions {
                    questions: vec![question("q1")],
                    holes: Vec::new(),
                    draft_path: None,
                }))
            })
        }
        fn remind(&self, reminder: WorkflowBlockedReminder) {
            self.sent
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(reminder.run_id);
        }
        fn schedule(&self, delay_ms: u64, fire: BoxedFire) -> u64 {
            let at = self.now_ms() + delay_ms;
            self.timers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((at, fire));
            at
        }
        fn cancel_timer(&self, timer: u64) {
            self.timers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .retain(|(at, _)| *at != timer);
        }
    }
    let host = Arc::new(PendingHost {
        now: now.clone(),
        timers: timers.clone(),
        sent: sent.clone(),
        released: released.clone(),
    });
    let clock = WorkflowBlockedReminderClock::new(host);
    clock.session_idle();
    *now.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = FIRST;
    let (_, fire) = timers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(0);
    // expire 开始，停在 read_open 的门上（noop waker 手动轮询——到点不是真等来的）。
    let mut expiry = Box::pin(fire());
    let waker = futures_util::task::noop_waker_ref();
    let mut context = Context::from_waker(waker);
    assert!(expiry.as_mut().poll(&mut context).is_pending());
    // 读快照期间来了一轮：这次到点作废，不在那一轮旁边再塞一条。
    clock.session_busy();
    *released.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    assert!(matches!(expiry.as_mut().poll(&mut context), Poll::Ready(())));
    assert!(sent
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_empty());
}

#[tokio::test]
async fn a_failing_snapshot_read_skips_that_run_and_reminds_the_others() {
    struct FailingHost;
    impl WorkflowBlockedReminderHost for FailingHost {
        fn now_ms(&self) -> u64 {
            FIRST
        }
        fn is_idle(&self) -> bool {
            true
        }
        fn live_run_ids(&self) -> Vec<String> {
            vec!["run-bad".to_owned(), "run-ok".to_owned()]
        }
        fn read_open(
            &self,
            run_id: &str,
        ) -> BoxFuture<'static, Result<Option<WorkflowOpenDecisions>, String>> {
            let bad = run_id == "run-bad";
            Box::pin(async move {
                if bad {
                    Err("journal closed".to_owned())
                } else {
                    Ok(Some(WorkflowOpenDecisions {
                        questions: vec![question("q1")],
                        holes: Vec::new(),
                        draft_path: None,
                    }))
                }
            })
        }
        fn remind(&self, reminder: WorkflowBlockedReminder) {
            SENT.with(|sent| sent.borrow_mut().push(reminder.run_id));
        }
        fn schedule(&self, _delay_ms: u64, fire: BoxedFire) -> u64 {
            FIRED.with(|slot| *slot.borrow_mut() = Some(fire));
            0
        }
        fn cancel_timer(&self, _timer: u64) {}
    }
    thread_local! {
        static SENT: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
        static FIRED: std::cell::RefCell<Option<BoxedFire>> = const { std::cell::RefCell::new(None) };
    }
    let clock = WorkflowBlockedReminderClock::new(Arc::new(FailingHost));
    clock.session_idle();
    let fire = FIRED.with(|slot| slot.borrow_mut().take());
    if let Some(fire) = fire {
        fire().await;
    }
    assert_eq!(
        SENT.with(|sent| sent.borrow().clone()),
        vec!["run-ok".to_owned()]
    );
}

#[tokio::test]
async fn a_run_that_is_no_longer_live_is_skipped_and_forgotten() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();
    advance(&host, FIRST).await;
    assert_eq!(sent_of(&host).len(), 1);

    // run 结算了；同一个 id 之后被 resume 重臂，应当从第 1 次算起。
    state_of(&state).live.clear();
    turn(&clock, &host, 0).await;
    advance(&host, SECOND).await;
    assert_eq!(sent_of(&host).len(), 1);

    state_of(&state).live.push("run-a".to_owned());
    turn(&clock, &host, 0).await;
    advance(&host, FIRST).await;
    assert_eq!(
        sent_of(&host).iter().map(|r| r.ordinal).collect::<Vec<_>>(),
        vec![1, 1]
    );
}

#[tokio::test]
async fn after_stop_everything_stays_silent() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();
    clock.stop();
    assert_eq!(pending_timers(&host), 0);
    advance(&host, FIRST).await;
    clock.session_busy();
    clock.session_idle();
    advance(&host, FIRST).await;
    assert!(sent_of(&host).is_empty());
}

#[tokio::test]
async fn repeated_idle_edges_do_not_reset_the_idle_duration() {
    let (clock, state, host) = harness();
    state_of(&state).live.push("run-a".to_owned());
    state_of(&state).open.insert(
        "run-a".to_owned(),
        Some(WorkflowOpenDecisions {
            questions: vec![question("q1")],
            holes: Vec::new(),
            draft_path: None,
        }),
    );
    clock.session_idle();
    advance(&host, FIRST - MIN).await;
    clock.session_idle();
    advance(&host, MIN).await;
    assert_eq!(sent_of(&host).len(), 1);
}

// ============================================================
// 文案（Node formatWorkflowBlockedNotification 实测输出逐字节对拍）
// ============================================================

fn blocked_input(
    run_label: &str,
    run_id: &str,
    ordinal: usize,
    now: u64,
    questions: Vec<WorkflowBlockedQuestion>,
    holes: Vec<WorkflowBlockedHole>,
) -> WorkflowBlockedNoticeInput {
    WorkflowBlockedNoticeInput {
        run_label: run_label.to_owned(),
        run_id: run_id.to_owned(),
        ordinal,
        total: 2,
        now,
        questions,
        holes,
        draft_path: None,
    }
}

#[test]
fn a_blocked_notice_with_question_and_hole_matches_node_byte_for_byte() {
    let text = format_workflow_blocked_notification(&blocked_input(
        "holeprobe",
        "dwfrun_b1",
        1,
        15 * 60_000,
        vec![question("q1")],
        vec![WorkflowBlockedHole { since: Some(5 * 60_000), ..hole("hole#1") }],
    ));
    assert_eq!(
        text,
        "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\
         This is an automated workflow event, NOT a message from the user.\n\
         Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\
         \n\
         <workflow-blocked>\n  \
         <run-id>dwfrun_b1</run-id>\n  \
         <run>holeprobe</run>\n  \
         <reminder>1 of 2</reminder>\n  \
         <open-questions count=\"1\" shown=\"1\">\n    \
         <question id=\"q1\" subagent=\"actor#1@1\" waited-ms=\"900000\">\n      \
         <text>q q1</text>\n    \
         </question>\n  \
         </open-questions>\n  \
         <open-holes count=\"1\" shown=\"1\">\n    \
         <hole id=\"hole#1\" name=\"hole#1\" type=\"Plan\" waited-ms=\"600000\"/>\n  \
         </open-holes>\n\
         </workflow-blocked>\n\
         \n\
         Workflow run holeprobe (dwfrun_b1) is still waiting on you: 1 question and 1 hole are open, the oldest for 15 minutes, and you have not acted on them since your last turn ended.\n\
         Next step for each question: call ResolveWorkflowQuestion with its id as question_id and your answer.\n\
         Next step for each hole: read the run's script with GetWorkflowRun (run_id=\"dwfrun_b1\") for the context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id=\"dwfrun_b1\" and its id as hole_id and the body as `script`.\n\
         If a decision needs the user, tell the user exactly what you need from them and end your turn; do not guess an answer to make the reminders stop.\n\
         One more reminder follows if nothing changes.\n\
         Either way the parked branches keep waiting; nothing times out on their behalf."
    );
}

#[test]
fn the_last_reminder_with_a_draft_and_hole_line_matches_node() {
    let input = WorkflowBlockedNoticeInput {
        run_label: "run2".to_owned(),
        run_id: "dwfrun_b2".to_owned(),
        ordinal: 2,
        total: 2,
        now: 45 * 60_000,
        questions: Vec::new(),
        holes: vec![WorkflowBlockedHole {
            line: Some(12),
            since: Some(30 * 60_000),
            ..hole("h")
        }],
        draft_path: Some("D:/proj/.nibi/workflow-drafts/run2.dwf.ts".to_owned()),
    };
    let text = format_workflow_blocked_notification(&input);
    assert_eq!(
        text,
        "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\
         This is an automated workflow event, NOT a message from the user.\n\
         Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\
         \n\
         <workflow-blocked>\n  \
         <run-id>dwfrun_b2</run-id>\n  \
         <run>run2</run>\n  \
         <reminder>2 of 2</reminder>\n  \
         <open-holes count=\"1\" shown=\"1\">\n    \
         <hole id=\"h\" name=\"h\" type=\"Plan\" line=\"12\" waited-ms=\"900000\"/>\n  \
         </open-holes>\n  \
         <draft>D:/proj/.nibi/workflow-drafts/run2.dwf.ts</draft>\n\
         </workflow-blocked>\n\
         \n\
         Workflow run run2 (dwfrun_b2) is still waiting on you: 1 hole is open, for 15 minutes, and you have not acted on it since your last turn ended.\n\
         Next step for each hole: read the draft at D:/proj/.nibi/workflow-drafts/run2.dwf.ts for the context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id=\"dwfrun_b2\" and its id as hole_id and the body as `script`.\n\
         If a decision needs the user, tell the user exactly what you need from them and end your turn; do not guess an answer to make the reminders stop.\n\
         This is the last reminder: nothing further is sent until the user writes or this run's open decisions change.\n\
         Either way the parked branches keep waiting; nothing times out on their behalf."
    );
}

#[test]
fn the_listing_overflow_says_where_the_rest_are() {
    let questions: Vec<WorkflowBlockedQuestion> = (0..9)
        .map(|index| WorkflowBlockedQuestion {
            context: Some("some context".to_owned()),
            asked_at: Some(index as u64 * 1_000),
            ..question(&format!("q{index}"))
        })
        .collect();
    let text = format_workflow_blocked_notification(&blocked_input(
        "run3",
        "dwfrun_b3",
        1,
        16 * 60_000,
        questions,
        Vec::new(),
    ));
    assert!(text.contains("<open-questions count=\"9\" shown=\"8\">"), "{text}");
    assert!(
        text.contains("GetWorkflowRun lists the ones not shown here (run_id=\"dwfrun_b3\")."),
        "{text}"
    );
    // 汇总行的复数与最旧等待（q0 的 waited 960_000ms = 16 分钟）。
    assert!(
        text.contains(
            "Workflow run run3 (dwfrun_b3) is still waiting on you: 9 questions are open, the oldest for 16 minutes, and you have not acted on them since your last turn ended."
        ),
        "{text}"
    );
}

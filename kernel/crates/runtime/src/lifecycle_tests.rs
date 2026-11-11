//! 生命周期状态机（`lifecycle.rs`）的单测：所有权、幂等、faulted 隔离与失败映射。
//!
//! 宿主是内存假件：`activate`/`release` 可以被闸门停住，测试在停住的时候发起并发操作，竞态因此确定地发生，
//! 不靠睡眠。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::residency::{
    SessionLifecycleOperation, SessionLifecycleSnapshot, SessionLifecycleState,
};
use nibi_kernel_api::session_api::KernelError;
use tokio::sync::Semaphore;

use super::lifecycle::{LifecycleController, LifecycleError, LifecycleHost};

const WAIT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Inner {
    exists: bool,
    runtime: bool,
    activations: usize,
    releases: usize,
    fail_activate: bool,
    fail_release: bool,
    changes: Vec<SessionLifecycleSnapshot>,
}

struct FakeHost {
    inner: Mutex<Inner>,
    /// 每次激活/释放开始放一个通行证（测试等“已经进到宿主里”）。
    activation_started: Semaphore,
    release_started: Semaphore,
    hold_activation: AtomicBool,
    activation_gate: tokio::sync::Notify,
    hold_release: AtomicBool,
    release_gate: tokio::sync::Notify,
}

impl FakeHost {
    fn new(exists: bool, runtime: bool) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                exists,
                runtime,
                ..Inner::default()
            }),
            activation_started: Semaphore::new(0),
            release_started: Semaphore::new(0),
            hold_activation: AtomicBool::new(false),
            activation_gate: tokio::sync::Notify::new(),
            hold_release: AtomicBool::new(false),
            release_gate: tokio::sync::Notify::new(),
        })
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn hold_activation(&self) {
        self.hold_activation.store(true, Ordering::SeqCst);
    }

    fn release_activation(&self) {
        self.hold_activation.store(false, Ordering::SeqCst);
        self.activation_gate.notify_waiters();
    }

    fn hold_release(&self) {
        self.hold_release.store(true, Ordering::SeqCst);
    }

    fn release_release(&self) {
        self.hold_release.store(false, Ordering::SeqCst);
        self.release_gate.notify_waiters();
    }

    fn fail_activation(&self) {
        self.inner().fail_activate = true;
    }

    fn fail_release(&self) {
        self.inner().fail_release = true;
    }

    fn counts(&self) -> (usize, usize) {
        let inner = self.inner();
        (inner.activations, inner.releases)
    }

    fn changes(&self) -> Vec<SessionLifecycleSnapshot> {
        self.inner().changes.clone()
    }

    fn states(&self) -> Vec<SessionLifecycleState> {
        self.changes().into_iter().map(|snapshot| snapshot.state).collect()
    }

    fn last_change(&self) -> SessionLifecycleSnapshot {
        self.inner()
            .changes
            .last()
            .cloned()
            .expect("no lifecycle change was published")
    }
}

#[async_trait]
impl LifecycleHost for FakeHost {
    async fn exists(&self, _session: &SessionId) -> Result<bool, KernelError> {
        Ok(self.inner().exists)
    }

    fn has_runtime(&self, _session: &SessionId) -> bool {
        self.inner().runtime
    }

    async fn validate_activation(
        &self,
        _session: &SessionId,
        _workspace: Option<&WorkspaceRef>,
    ) -> Result<(), KernelError> {
        Ok(())
    }

    async fn activate(
        &self,
        _session: &SessionId,
        _workspace: Option<&WorkspaceRef>,
    ) -> Result<(), KernelError> {
        self.activation_started.add_permits(1);
        if self.hold_activation.load(Ordering::SeqCst) {
            self.activation_gate.notified().await;
        }
        let mut inner = self.inner();
        inner.activations += 1;
        if inner.fail_activate {
            return Err(KernelError::Failed {
                message: "activation failed".to_owned(),
            });
        }
        inner.runtime = true;
        Ok(())
    }

    fn assert_can_stop(&self, _session: &SessionId) -> Result<(), KernelError> {
        Ok(())
    }

    async fn release(&self, _session: &SessionId) -> Result<(), KernelError> {
        self.release_started.add_permits(1);
        if self.hold_release.load(Ordering::SeqCst) {
            self.release_gate.notified().await;
        }
        let mut inner = self.inner();
        inner.releases += 1;
        if inner.fail_release {
            return Err(KernelError::Failed {
                message: "release failed".to_owned(),
            });
        }
        inner.runtime = false;
        Ok(())
    }

    fn on_change(&self, snapshot: &SessionLifecycleSnapshot) {
        self.inner().changes.push(snapshot.clone());
    }
}

fn session() -> SessionId {
    SessionId::new("sess_lifecycle")
}

fn code(result: &Result<(), LifecycleError>) -> &str {
    match result {
        Err(error) => &error.code,
        Ok(()) => "",
    }
}

/// `stop` 幂等：已经 unloaded 时再停一次仍然成功（会再走一遍释放/状态发布，不 faulted）。
#[tokio::test]
async fn stop_is_idempotent() {
    let host = FakeHost::new(true, true);
    let controller = LifecycleController::default();
    controller.stop(host.as_ref(), &session()).await.unwrap();
    assert!(!host.inner().runtime);
    let first = host.counts();

    controller.stop(host.as_ref(), &session()).await.unwrap();
    assert_eq!(host.counts().0, first.0);
    let snapshot = controller
        .get_state(host.as_ref(), &session())
        .await
        .unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Unloaded);
    assert!(snapshot.last_error.is_none());
}

/// `restart` 幂等且每次换新实例：generation 递增，stop → start 都跑一次。
#[tokio::test]
async fn restart_replaces_the_instance() {
    let host = FakeHost::new(true, true);
    let controller = LifecycleController::default();
    controller.restart(host.as_ref(), &session(), None).await.unwrap();
    assert_eq!(host.counts(), (1, 1));

    controller.restart(host.as_ref(), &session(), None).await.unwrap();
    assert_eq!(host.counts(), (2, 2));
    let snapshot = controller
        .get_state(host.as_ref(), &session())
        .await
        .unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Ready);
    assert_eq!(snapshot.generation, 2);
    assert!(snapshot.revision > 0);
}

/// 释放失败进 faulted；之后 ensureReady / stop / restart 都拒绝，不自动重建。
#[tokio::test]
async fn faulted_is_isolated_and_never_rebuilt() {
    let host = FakeHost::new(true, true);
    host.fail_release();
    let controller = LifecycleController::default();
    let result = controller.stop(host.as_ref(), &session()).await;
    assert!(result.is_err());
    let snapshot = controller
        .get_state(host.as_ref(), &session())
        .await
        .unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Faulted);
    assert_eq!(
        snapshot.last_error.as_ref().map(|error| error.code.as_str()),
        Some("resourceReleaseFailed")
    );
    assert_eq!(
        snapshot.last_error.as_ref().map(|error| error.operation),
        Some(SessionLifecycleOperation::Stop)
    );
    let counts = host.counts();

    let ready = controller.ensure_ready(host.as_ref(), &session(), None).await;
    assert_eq!(code(&ready), "recoveryRequired");
    let stop = controller.stop(host.as_ref(), &session()).await;
    assert_eq!(code(&stop), "recoveryRequired");
    let restart = controller
        .restart(host.as_ref(), &session(), None)
        .await;
    assert_eq!(code(&restart), "recoveryRequired");
    assert_eq!(host.counts(), counts, "faulted 不再调用宿主");
}

/// 启动失败：先清理回 unloaded（可再次尝试），lastError 是 operationFailed。
#[tokio::test]
async fn a_failed_activation_cleans_up_to_unloaded() {
    let host = FakeHost::new(true, false);
    host.fail_activation();
    let controller = LifecycleController::default();
    let result = controller.ensure_ready(host.as_ref(), &session(), None).await;
    assert!(result.is_err());
    assert_eq!(host.counts(), (1, 1), "失败后跑一次清理释放");
    let snapshot = controller
        .get_state(host.as_ref(), &session())
        .await
        .unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Unloaded);
    assert_eq!(
        snapshot.last_error.as_ref().map(|error| error.code.as_str()),
        Some("operationFailed")
    );
}

/// `restart` 在启动在途时关闭 ready 准入，等启动收口后整体重启；期间 `stop` 冲突。
#[tokio::test]
async fn restart_owns_the_whole_stop_and_start_interval() {
    let host = FakeHost::new(true, false);
    host.hold_activation();
    let controller = Arc::new(LifecycleController::default());
    let id = session();

    let starting = {
        let (host, controller, id) = (host.clone(), controller.clone(), id.clone());
        tokio::spawn(async move { controller.ensure_ready(host.as_ref(), &id, None).await })
    };
    host.activation_started.acquire().await.unwrap().forget();

    let restarting = {
        let (host, controller, id) = (host.clone(), controller.clone(), id.clone());
        tokio::spawn(async move { controller.restart(host.as_ref(), &id, None).await })
    };
    // 等 restart 登记成 restart_pending（启动还在闸门上）。
    let pending = tokio::time::timeout(WAIT, async {
        while !controller.has_restart_pending(&id) {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(pending.is_ok());
    let stop = controller.stop(host.as_ref(), &id).await;
    assert_eq!(code(&stop), "conflict");

    host.release_activation();
    let started = tokio::time::timeout(WAIT, starting).await.unwrap().unwrap();
    assert!(started.is_ok(), "{started:?}");
    let restarted = tokio::time::timeout(WAIT, restarting).await.unwrap().unwrap();
    assert!(restarted.is_ok(), "{restarted:?}");
    assert_eq!(host.counts(), (2, 1), "启动一次，重启再释放+启动一次");
    let snapshot = controller.get_state(host.as_ref(), &id).await.unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Ready);
    assert_eq!(snapshot.generation, 2);
}

/// `ensureReady` 遇到在途 `stop` 等它收口后重试。
#[tokio::test]
async fn ensure_ready_waits_for_a_stop() {
    let host = FakeHost::new(true, true);
    host.hold_release();
    let controller = Arc::new(LifecycleController::default());
    let id = session();

    let stopping = {
        let (host, controller, id) = (host.clone(), controller.clone(), id.clone());
        tokio::spawn(async move { controller.stop(host.as_ref(), &id).await })
    };
    host.release_started.acquire().await.unwrap().forget();
    let ready = {
        let (host, controller, id) = (host.clone(), controller.clone(), id.clone());
        tokio::spawn(async move { controller.ensure_ready(host.as_ref(), &id, None).await })
    };
    // 释放还没放行：ensureReady 必须等它。
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!ready.is_finished(), "ensureReady must wait for the stop");
    assert_eq!(host.inner().activations, 0);

    host.release_release();
    assert!(tokio::time::timeout(WAIT, stopping)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    assert!(tokio::time::timeout(WAIT, ready)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    let snapshot = controller.get_state(host.as_ref(), &id).await.unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Ready);
}

/// 同一个在途操作加入（共享一次冷加载），完成时两个调用都成功。
#[tokio::test]
async fn concurrent_ensure_ready_shares_one_activation() {
    let host = FakeHost::new(true, false);
    host.hold_activation();
    let controller = Arc::new(LifecycleController::default());
    let id = session();
    let one = {
        let (host, controller, id) = (host.clone(), controller.clone(), id.clone());
        tokio::spawn(async move { controller.ensure_ready(host.as_ref(), &id, None).await })
    };
    host.activation_started.acquire().await.unwrap().forget();
    let two = {
        let (host, controller, id) = (host.clone(), controller.clone(), id.clone());
        tokio::spawn(async move { controller.ensure_ready(host.as_ref(), &id, None).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    host.release_activation();
    assert!(tokio::time::timeout(WAIT, one).await.unwrap().unwrap().is_ok());
    assert!(tokio::time::timeout(WAIT, two).await.unwrap().unwrap().is_ok());
    assert_eq!(host.counts(), (1, 0), "只冷加载一次");
}

/// 不存在的会话：getState / ensureReady 报 sessionNotFound，不激活。
#[tokio::test]
async fn a_missing_session_is_not_activated() {
    let host = FakeHost::new(false, false);
    let controller = LifecycleController::default();
    let state = controller.get_state(host.as_ref(), &session()).await;
    assert_eq!(
        state.as_ref().err().map(|error| error.code.as_str()),
        Some("sessionNotFound")
    );
    let ready = controller.ensure_ready(host.as_ref(), &session(), None).await;
    assert_eq!(code(&ready), "sessionNotFound");
    assert_eq!(host.counts(), (0, 0));
}

/// 旧协议的 `session/open|close` 不经过状态机：读取快照时按会话表对齐（ready ↔ unloaded）。
#[tokio::test]
async fn the_snapshot_reconciles_with_the_session_table() {
    let host = FakeHost::new(true, true);
    let controller = LifecycleController::default();
    let snapshot = controller.get_state(host.as_ref(), &session()).await.unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Ready);

    host.inner().runtime = false;
    let snapshot = controller.get_state(host.as_ref(), &session()).await.unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Unloaded);

    host.inner().runtime = true;
    assert!(controller.is_ready(host.as_ref(), &session()));
    let snapshot = controller.get_state(host.as_ref(), &session()).await.unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Ready);
}

/// 每次状态发布恰好一条 `on_change`，且最后一条与 `getState` 的快照逐字段一致；
/// revision 严格递增（客户端据此丢弃落后的观察）。
#[tokio::test]
async fn every_transition_publishes_one_snapshot_matching_get_state() {
    let host = FakeHost::new(true, false);
    let controller = LifecycleController::default();
    let id = session();

    controller
        .ensure_ready(host.as_ref(), &id, None)
        .await
        .unwrap();
    assert_eq!(
        host.states(),
        [
            SessionLifecycleState::Starting,
            SessionLifecycleState::Ready
        ]
    );
    let state = controller.get_state(host.as_ref(), &id).await.unwrap();
    assert_eq!(host.last_change(), state);
    assert_eq!(state.generation, 1);

    controller.stop(host.as_ref(), &id).await.unwrap();
    assert_eq!(
        host.states(),
        [
            SessionLifecycleState::Starting,
            SessionLifecycleState::Ready,
            SessionLifecycleState::Stopping,
            SessionLifecycleState::Unloaded,
        ]
    );
    let state = controller.get_state(host.as_ref(), &id).await.unwrap();
    assert_eq!(host.last_change(), state);
    assert!(state.last_error.is_none());

    controller.restart(host.as_ref(), &id, None).await.unwrap();
    assert_eq!(
        host.states(),
        [
            SessionLifecycleState::Starting,
            SessionLifecycleState::Ready,
            SessionLifecycleState::Stopping,
            SessionLifecycleState::Unloaded,
            SessionLifecycleState::Stopping,
            SessionLifecycleState::Unloaded,
            SessionLifecycleState::Starting,
            SessionLifecycleState::Ready,
        ]
    );
    let state = controller.get_state(host.as_ref(), &id).await.unwrap();
    assert_eq!(host.last_change(), state);
    assert_eq!(state.generation, 2);

    let revisions: Vec<u64> = host
        .changes()
        .iter()
        .map(|snapshot| snapshot.revision)
        .collect();
    assert!(
        revisions.windows(2).all(|pair| pair[0] < pair[1]),
        "revisions must increase: {revisions:?}"
    );
}

/// 释放失败：状态发布 faulted，随后失败事实再发布一条带 `lastError` 的快照（上游
/// `resourceReleaseFailed` 的同一走向）；最终快照与 `getState` 一致。
#[tokio::test]
async fn a_failed_release_publishes_faulted_with_the_failure_fact() {
    let host = FakeHost::new(true, true);
    host.fail_release();
    let controller = LifecycleController::default();
    let result = controller.stop(host.as_ref(), &session()).await;
    assert!(result.is_err());
    assert_eq!(
        host.states(),
        [
            SessionLifecycleState::Stopping,
            SessionLifecycleState::Faulted,
            SessionLifecycleState::Faulted,
        ]
    );
    let state = controller
        .get_state(host.as_ref(), &session())
        .await
        .unwrap();
    assert_eq!(host.last_change(), state);
    let failure = state.last_error.expect("the failure fact is published");
    assert_eq!(failure.operation, SessionLifecycleOperation::Stop);
    assert_eq!(failure.code, "resourceReleaseFailed");
}

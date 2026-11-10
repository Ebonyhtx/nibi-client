//! 运行实例的生命周期状态机（NIBI 3.17.2 `session-lifecycle/controller.ts` 的 Rust 版）。
//!
//! `unloaded → starting → ready → stopping → unloaded`；初始化/释放失败进 `faulted`（不自动重建，
//! 进程重启是上层出口）。这里是这些状态的**唯一写者**：常驻池的回收、协议的 `session/lifecycle/*`
//! 都走同一个入口，不会有两个调用各自关闭/启动同一个会话。
//!
//! 所有权（与上游一致的几条）：
//!
//! - 每个会话至多一个在途操作（flight）。同操作加入它；不同操作按 [`Operation`] 的规则冲突或等待。
//! - `restart` 跨整个 stop + start 区间持有所有权：启动在途时它先关闭 ready 准入
//!   （`restart_pending`），等启动收口后整体重启；这期间 `stop` 冲突。
//! - `ensureReady` 遇到在途的 `stop` 等待它收口后重试。
//! - 登记先于调用宿主：同步重入和 `unloaded` 间隙不能抢走操作。
//! - 状态机不读写存储、不发通知、不碰协议；存在性、激活、释放由 [`LifecycleHost`] 注入。

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::residency::{
    SessionLifecycleFailure, SessionLifecycleOperation, SessionLifecycleSnapshot,
    SessionLifecycleState,
};
use nibi_kernel_api::session_api::KernelError;
use tokio::sync::watch;

/// 宿主给状态机的副作用。停止预检同步（拒绝不能有副作用）；激活预检可异步读归属。
#[async_trait]
pub(crate) trait LifecycleHost: Send + Sync {
    /// 会话在存储里存在（含内存里的草稿），软删除的不算。
    async fn exists(&self, session: &SessionId) -> Result<bool, KernelError>;

    /// 本进程里此刻有运行实例（会话表 `Open`）。
    fn has_runtime(&self, session: &SessionId) -> bool;

    /// 激活前的归属校验（工作区与持久记录一致）。
    async fn validate_activation(
        &self,
        session: &SessionId,
        workspace: Option<&WorkspaceRef>,
    ) -> Result<(), KernelError>;

    /// 冷加载/新建运行实例（复用现有打开路径）。
    async fn activate(
        &self,
        session: &SessionId,
        workspace: Option<&WorkspaceRef>,
    ) -> Result<(), KernelError>;

    /// 同步停止预检。缺省允许（常驻池的 busy 保护在池自己那边）。
    fn assert_can_stop(&self, session: &SessionId) -> Result<(), KernelError>;

    /// 释放运行实例（关闭 actor，不删持久事实）。
    async fn release(&self, session: &SessionId) -> Result<(), KernelError>;

    /// 状态或失败事实变化（观察/日志；通知连接失败不改变已完成的生命周期事实）。
    fn on_change(&self, snapshot: &SessionLifecycleSnapshot);
}

/// 状态机的错误。`code` 为空表示宿主错误：`run` 按当时状态补 `operationFailed` /
/// `resourceReleaseFailed`（上游的同一条映射）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LifecycleError {
    pub code: String,
    pub message: String,
}

impl LifecycleError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    fn host(error: KernelError) -> Self {
        Self {
            code: String::new(),
            message: error.to_string(),
        }
    }

    fn combined(original: KernelError, cleanup: KernelError) -> Self {
        Self {
            code: String::new(),
            message: format!(
                "Session initialization and cleanup failed: {original}; {cleanup}"
            ),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new("conflict", message)
    }

    fn not_found(session: &SessionId) -> Self {
        Self::new("sessionNotFound", format!("Session not found: {}", session.as_str()))
    }

    fn recovery_required() -> Self {
        Self::new(
            "recoveryRequired",
            "Session runtime requires workspace process recovery",
        )
    }

    fn cancelled() -> Self {
        Self::new(
            "operationCancelled",
            "Session lifecycle operation was cancelled",
        )
    }

    pub(crate) fn into_kernel(self) -> KernelError {
        KernelError::Failed {
            message: self.message,
        }
    }
}

/// 一个在途操作。
struct Flight {
    id: u64,
    operation: SessionLifecycleOperation,
    workspace: Option<WorkspaceRef>,
    /// 结果（`None` = 未完成）。加入者订阅它；关闭说明操作被丢下/中止。
    result: watch::Sender<Option<Result<(), LifecycleError>>>,
}

struct Entry {
    snapshot: SessionLifecycleSnapshot,
    flight: Option<Flight>,
    /// `restart` 在启动在途时登记的重启（跨 stop + start 持有所有权）。
    restart_pending: bool,
    restart_workspace: Option<WorkspaceRef>,
}

impl Entry {
    fn new(session: &SessionId, has_runtime: bool) -> Self {
        Self {
            snapshot: SessionLifecycleSnapshot {
                session_id: session.clone(),
                state: if has_runtime {
                    SessionLifecycleState::Ready
                } else {
                    SessionLifecycleState::Unloaded
                },
                generation: 0,
                revision: 0,
                last_error: None,
            },
            flight: None,
            restart_pending: false,
            restart_workspace: None,
        }
    }

    /// 没有在途操作/待重启时，把快照对齐会话表的真实事实：`session/open|close` 是旧协议的路径，
    /// 它们不经过本状态机；读取时对齐，旧 Host 的行为不变。
    fn reconcile(&mut self, has_runtime: bool) {
        if self.flight.is_some() || self.restart_pending {
            return;
        }
        match self.snapshot.state {
            SessionLifecycleState::Unloaded if has_runtime => {
                self.snapshot.state = SessionLifecycleState::Ready;
            }
            SessionLifecycleState::Ready if !has_runtime => {
                self.snapshot.state = SessionLifecycleState::Unloaded;
            }
            _ => {}
        }
    }
}

/// 操作被丢下（调用方 future 被丢弃/中止）时的收口。
struct FlightGuard<'a> {
    controller: &'a LifecycleController,
    session: SessionId,
    flight: u64,
}

impl Drop for FlightGuard<'_> {
    fn drop(&mut self) {
        let mut entries = self.controller.entries();
        let Some(entry) = entries.get_mut(&self.session) else {
            return;
        };
        if entry
            .flight
            .as_ref()
            .is_none_or(|flight| flight.id != self.flight)
        {
            return;
        }
        let Some(flight) = entry.flight.take() else {
            return;
        };
        let _ = flight.result.send(Some(Err(LifecycleError::cancelled())));
        // 启动被丢下：表里的 Loading 守卫会清掉条目，状态回到 unloaded。
        // 释放被丢下：释放可能已经做了一半，隔离为 faulted（不自动重建）。
        match entry.snapshot.state {
            SessionLifecycleState::Starting => {
                entry.snapshot.state = SessionLifecycleState::Unloaded;
            }
            SessionLifecycleState::Stopping => {
                entry.snapshot.state = SessionLifecycleState::Faulted;
            }
            _ => {}
        }
        entry.snapshot.last_error = Some(SessionLifecycleFailure {
            operation: flight.operation,
            code: "operationCancelled".to_owned(),
            message: "Session lifecycle operation was cancelled".to_owned(),
        });
        entry.snapshot.revision += 1;
    }
}

/// 每个会话一条状态与在途操作。
pub(crate) struct LifecycleController {
    entries: Mutex<HashMap<SessionId, Entry>>,
    next_id: AtomicU64,
}

impl Default for LifecycleController {
    fn default() -> Self {
        Self {
            entries: Mutex::default(),
            next_id: AtomicU64::new(1),
        }
    }
}

/// 等待在途操作结果。
async fn wait(
    mut result: watch::Receiver<Option<Result<(), LifecycleError>>>,
) -> Result<(), LifecycleError> {
    loop {
        if let Some(verdict) = result.borrow_and_update().clone() {
            return verdict;
        }
        if result.changed().await.is_err() {
            return Err(LifecycleError::cancelled());
        }
    }
}

/// `ensure_ready` / `restart` 的下一动作（锁外执行）。
enum Next {
    Run,
    /// 登记的重启轮到这一轮执行（锁外调用）。
    RestartNow,
    Join(watch::Receiver<Option<Result<(), LifecycleError>>>),
    /// 等启动收口后，由这一轮把登记的重启完成。
    RestartAfter(watch::Receiver<Option<Result<(), LifecycleError>>>),
}

impl LifecycleController {
    fn entries(&self) -> MutexGuard<'_, HashMap<SessionId, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn entry<'a>(
        entries: &'a mut HashMap<SessionId, Entry>,
        session: &SessionId,
        host: &dyn LifecycleHost,
    ) -> &'a mut Entry {
        entries
            .entry(session.clone())
            .or_insert_with(|| Entry::new(session, host.has_runtime(session)))
    }

    /// 正在释放（`stopping`）：协议层据此拒绝业务命令/订阅。
    pub(crate) fn is_stopping(&self, host: &dyn LifecycleHost, session: &SessionId) -> bool {
        let mut entries = self.entries();
        let Some(entry) = entries.get_mut(session) else {
            return false;
        };
        entry.reconcile(host.has_runtime(session));
        entry.snapshot.state == SessionLifecycleState::Stopping
    }

    /// 同步准入事实（常驻池/协议用）：不在 restart_pending 里的 ready。
    pub(crate) fn is_ready(&self, host: &dyn LifecycleHost, session: &SessionId) -> bool {
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, session, host);
        entry.reconcile(host.has_runtime(session));
        !entry.restart_pending && entry.snapshot.state == SessionLifecycleState::Ready
    }

    /// 有登记待完成的重启（启动在途时到达的 `restart`）。诊断/测试用。
    #[cfg(test)]
    pub(crate) fn has_restart_pending(&self, session: &SessionId) -> bool {
        self.entries()
            .get(session)
            .is_some_and(|entry| entry.restart_pending)
    }

    /// `session/lifecycle/getState`：只读；会话不存在时报错，不隐式启动。
    pub(crate) async fn get_state(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
    ) -> Result<SessionLifecycleSnapshot, LifecycleError> {
        self.assert_exists(host, session).await?;
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, session, host);
        entry.reconcile(host.has_runtime(session));
        Ok(entry.snapshot.clone())
    }

    /// 幂等恢复：完成时实例 ready。在途 stop 等它收口后重试；在途 ensureReady/restart 加入。
    pub(crate) async fn ensure_ready(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
        workspace: Option<WorkspaceRef>,
    ) -> Result<(), LifecycleError> {
        loop {
            let next = {
                let mut entries = self.entries();
                let entry = Self::entry(&mut entries, session, host);
                Self::check_workspace(entry, workspace.as_ref())?;
                if entry.restart_pending {
                    match entry.flight.as_ref() {
                        Some(flight) => Next::RestartAfter(flight.result.subscribe()),
                        // 登记了重启但上一段已经收口：由这一轮完成它（锁外调用）。
                        None => Next::RestartNow,
                    }
                } else if let Some(flight) = &entry.flight {
                    match flight.operation {
                        // 停止收口后重新走一遍（状态可能是 unloaded 或 faulted）。
                        SessionLifecycleOperation::Stop => {
                            Next::Join(flight.result.subscribe())
                        }
                        SessionLifecycleOperation::EnsureReady
                        | SessionLifecycleOperation::Restart => {
                            Next::Join(flight.result.subscribe())
                        }
                    }
                } else {
                    entry.reconcile(host.has_runtime(session));
                    if entry.snapshot.state == SessionLifecycleState::Faulted {
                        return Err(LifecycleError::recovery_required());
                    }
                    if entry.snapshot.state == SessionLifecycleState::Ready {
                        return Ok(());
                    }
                    Next::Run
                }
            };
            match next {
                Next::Run => {
                    return self.run_ensure_ready(host, session, workspace).await;
                }
                Next::RestartNow => return self.restart(host, session, workspace).await,
                Next::Join(result) => {
                    wait(result).await?;
                    continue;
                }
                Next::RestartAfter(result) => {
                    // 启动的失败不阻止重启（上游 `then(afterStartup, afterStartup)`）。
                    let _ = wait(result).await;
                    return self.restart(host, session, workspace).await;
                }
            }
        }
    }

    /// 幂等释放：完成时 unloaded。预检拒绝没有副作用。
    pub(crate) async fn stop(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
    ) -> Result<(), LifecycleError> {
        let next = {
            let mut entries = self.entries();
            let entry = Self::entry(&mut entries, session, host);
            if entry.restart_pending {
                return Err(LifecycleError::conflict(
                    "Session lifecycle restart is pending",
                ));
            }
            match &entry.flight {
                Some(flight) if flight.operation == SessionLifecycleOperation::Stop => {
                    Some(Next::Join(flight.result.subscribe()))
                }
                Some(flight) => {
                    return Err(LifecycleError::conflict(format!(
                        "Session lifecycle {} is in progress",
                        flight.operation.as_str()
                    )));
                }
                None => {
                    entry.reconcile(host.has_runtime(session));
                    if entry.snapshot.state == SessionLifecycleState::Faulted {
                        return Err(LifecycleError::recovery_required());
                    }
                    Some(Next::Run)
                }
            }
        };
        match next {
            Some(Next::Join(result)) => wait(result).await,
            _ => {
                self.run(
                    host,
                    session,
                    SessionLifecycleOperation::Stop,
                    None,
                    async {
                        self.assert_exists(host, session).await?;
                        host.assert_can_stop(session)
                            .map_err(LifecycleError::host)?;
                        self.release(host, session).await
                    },
                )
                .await
            }
        }
    }

    /// 原子占有整个 stop → ensureReady；完成时 ready。
    pub(crate) async fn restart(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
        workspace: Option<WorkspaceRef>,
    ) -> Result<(), LifecycleError> {
        loop {
            let next = {
                let mut entries = self.entries();
                let entry = Self::entry(&mut entries, session, host);
                Self::check_workspace(entry, workspace.as_ref())?;
                if entry.restart_pending {
                    match entry.flight.as_ref() {
                        Some(flight) => Next::RestartAfter(flight.result.subscribe()),
                        None => {
                            entry.restart_pending = false;
                            entry.restart_workspace = None;
                            Next::Run
                        }
                    }
                } else if let Some(flight) = &entry.flight {
                    match flight.operation {
                        // 启动在途：关闭 ready 准入，等它安全收口后整体重启（不能并行创建实例）。
                        SessionLifecycleOperation::EnsureReady => {
                            entry.restart_pending = true;
                            entry.restart_workspace = workspace.clone();
                            Next::RestartAfter(flight.result.subscribe())
                        }
                        SessionLifecycleOperation::Restart => {
                            Next::Join(flight.result.subscribe())
                        }
                        SessionLifecycleOperation::Stop => {
                            return Err(LifecycleError::conflict(
                                "Session lifecycle stop is in progress",
                            ));
                        }
                    }
                } else {
                    entry.reconcile(host.has_runtime(session));
                    if entry.snapshot.state == SessionLifecycleState::Faulted {
                        return Err(LifecycleError::recovery_required());
                    }
                    Next::Run
                }
            };
            match next {
                Next::Run => {
                    return self.run_restart(host, session, workspace).await;
                }
                Next::RestartAfter(result) => {
                    let _ = wait(result).await;
                    continue;
                }
                Next::Join(result) => return wait(result).await,
                // 只有 ensureReady 会产出这个动作；防御性重走一轮。
                Next::RestartNow => continue,
            }
        }
    }

    /// 常驻池的回收入口：已经 unloaded 且没有实例时直接返回（上游 `dispose` 的早退）；
    /// 其余与 `stop` 同一状态机。
    pub(crate) async fn dispose(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
    ) -> Result<(), LifecycleError> {
        let skip = {
            let mut entries = self.entries();
            let entry = Self::entry(&mut entries, session, host);
            entry.reconcile(host.has_runtime(session));
            entry.flight.is_none()
                && !entry.restart_pending
                && entry.snapshot.state == SessionLifecycleState::Unloaded
        };
        if skip {
            return Ok(());
        }
        self.stop(host, session).await
    }

    async fn run_ensure_ready(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
        workspace: Option<WorkspaceRef>,
    ) -> Result<(), LifecycleError> {
        self.run(
            host,
            session,
            SessionLifecycleOperation::EnsureReady,
            workspace.clone(),
            async {
                self.assert_exists(host, session).await?;
                host.validate_activation(session, workspace.as_ref())
                    .await
                    .map_err(LifecycleError::host)?;
                let needs_activation = {
                    let mut entries = self.entries();
                    let entry = Self::entry(&mut entries, session, host);
                    entry.snapshot.state != SessionLifecycleState::Ready
                };
                if needs_activation {
                    self.activate(host, session, workspace.as_ref()).await?;
                }
                Ok(())
            },
        )
        .await
    }

    async fn run_restart(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
        workspace: Option<WorkspaceRef>,
    ) -> Result<(), LifecycleError> {
        self.run(
            host,
            session,
            SessionLifecycleOperation::Restart,
            workspace.clone(),
            async {
                self.assert_exists(host, session).await?;
                host.validate_activation(session, workspace.as_ref())
                    .await
                    .map_err(LifecycleError::host)?;
                host.assert_can_stop(session)
                    .map_err(LifecycleError::host)?;
                // history-first 可以只有投影没有实例；重启仍要完整失效旧链路。
                self.release(host, session).await?;
                self.activate(host, session, workspace.as_ref()).await
            },
        )
        .await
    }

    /// 注册在途操作，再跑 work。登记先于调用宿主：同步重入与 unloaded 间隙不能抢走操作。
    async fn run<F>(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
        operation: SessionLifecycleOperation,
        workspace: Option<WorkspaceRef>,
        work: F,
    ) -> Result<(), LifecycleError>
    where
        F: Future<Output = Result<(), LifecycleError>>,
    {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (result, _) = watch::channel(None);
        {
            let mut entries = self.entries();
            let entry = Self::entry(&mut entries, session, host);
            entry.snapshot.last_error = None;
            entry.flight = Some(Flight {
                id,
                operation,
                workspace,
                result: result.clone(),
            });
        }
        let guard = FlightGuard {
            controller: self,
            session: session.clone(),
            flight: id,
        };
        let verdict = work.await;
        if let Err(error) = &verdict {
            self.note_failure(host, session, operation, error);
        }
        let _ = result.send(Some(verdict.clone()));
        self.clear_flight(session, id);
        drop(guard);
        verdict
    }

    fn clear_flight(&self, session: &SessionId, id: u64) {
        let mut entries = self.entries();
        if let Some(entry) = entries.get_mut(session)
            && entry.flight.as_ref().is_some_and(|flight| flight.id == id)
        {
            entry.flight = None;
        }
    }

    fn note_failure(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
        operation: SessionLifecycleOperation,
        error: &LifecycleError,
    ) {
        let snapshot = {
            let mut entries = self.entries();
            let Some(entry) = entries.get_mut(session) else {
                return;
            };
            let code = if error.code.is_empty() {
                if entry.snapshot.state == SessionLifecycleState::Faulted {
                    "resourceReleaseFailed".to_owned()
                } else {
                    "operationFailed".to_owned()
                }
            } else {
                error.code.clone()
            };
            entry.snapshot.last_error = Some(SessionLifecycleFailure {
                operation,
                code,
                message: error.message.clone(),
            });
            entry.snapshot.revision += 1;
            entry.snapshot.clone()
        };
        host.on_change(&snapshot);
    }

    /// 启动：generation + 1、starting → ready；初始化失败先清理（staying unloaded），清理也失败则 faulted。
    async fn activate(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
        workspace: Option<&WorkspaceRef>,
    ) -> Result<(), LifecycleError> {
        {
            let mut entries = self.entries();
            if let Some(entry) = entries.get_mut(session) {
                entry.snapshot.generation += 1;
            }
        }
        self.transition(host, session, SessionLifecycleState::Starting);
        match host.activate(session, workspace).await {
            Ok(()) => {
                self.transition(host, session, SessionLifecycleState::Ready);
                Ok(())
            }
            Err(error) => match self.release(host, session).await {
                Ok(()) => Err(LifecycleError::host(error)),
                Err(cleanup) => {
                    // 清理失败已经进 faulted；错误里带两段原因（上游的 AggregateError）。
                    Err(LifecycleError {
                        code: cleanup.code,
                        message: LifecycleError::combined(error, KernelError::Failed {
                            message: cleanup.message,
                        })
                        .message,
                    })
                }
            },
        }
    }

    /// 释放：stopping → unloaded；失败进 faulted（迟到回调不能复活下一实例）。
    async fn release(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
    ) -> Result<(), LifecycleError> {
        self.transition(host, session, SessionLifecycleState::Stopping);
        match host.release(session).await {
            Ok(()) => {
                self.transition(host, session, SessionLifecycleState::Unloaded);
                Ok(())
            }
            Err(error) => {
                self.transition(host, session, SessionLifecycleState::Faulted);
                Err(LifecycleError::host(error))
            }
        }
    }

    fn transition(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
        state: SessionLifecycleState,
    ) {
        let snapshot = {
            let mut entries = self.entries();
            let Some(entry) = entries.get_mut(session) else {
                return;
            };
            entry.snapshot.state = state;
            entry.snapshot.revision += 1;
            entry.snapshot.clone()
        };
        host.on_change(&snapshot);
    }

    fn check_workspace(
        entry: &Entry,
        workspace: Option<&WorkspaceRef>,
    ) -> Result<(), LifecycleError> {
        let Some(workspace) = workspace else {
            return Ok(());
        };
        let active = entry
            .flight
            .as_ref()
            .and_then(|flight| flight.workspace.as_ref())
            .into_iter()
            .chain(entry.restart_workspace.as_ref());
        for candidate in active {
            if candidate != workspace {
                return Err(LifecycleError::conflict(
                    "Session activation workspace conflicts with the current operation",
                ));
            }
        }
        Ok(())
    }

    async fn assert_exists(
        &self,
        host: &dyn LifecycleHost,
        session: &SessionId,
    ) -> Result<(), LifecycleError> {
        match host.exists(session).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(LifecycleError::not_found(session)),
            Err(error) => Err(LifecycleError::host(error)),
        }
    }
}

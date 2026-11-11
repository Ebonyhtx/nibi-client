//! 常驻池在内核上的装配：会话事实、回收执行、请求租约与 60 s 采样（NIBI `session-resident-pool.ts` 的宿主侧）。
//!
//! 事实来源（任一命中就不回收）：
//!
//! | 阻止项 | 来源 |
//! | --- | --- |
//! | 草稿/持久化未完成 | `SessionHandle::is_draft` |
//! | 运行实例不在 ready（启动/重启中/失败） | `LifecycleController::is_ready` |
//! | 正在跑的回合、actor 的回合级后台工作 | `SessionHandle::residency_facts().running` |
//! | 排队输入（queue + next 通道 + 已取走的到点任务 + 待提升） | 同上 `queued_commands` |
//! | 待回答交互（AUQ/权限/计划审批/会话级询问） | 同上 `pending_interactions` |
//! | 后台 shell / 后台子代理 | 同上 `background_shells/subagents` |
//! | cron 到点任务 | [`nibi_kernel_api::cron::CronSignals::has_due`] |
//! | 协议订阅（Live/分享） | 协议层注入的 [`SessionResidencyWatch`] |
//! | DWF run 在飞（`dwf_run.status == "running"`） | 会话存储；到回收候选时才查（`宁可少淘汰`） |
//! | 正在别的请求里（操作租约）、正在被回收 | 池自己的计数 |
//!
//! 回收 = 生命周期状态机的 `stop`（关闭 actor，不删持久事实、不发 `session.removed`）；之后
//! `ensureReady`/普通打开会走现有冷加载。

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::residency::{SessionResidencyWatch, SessionLifecycleSnapshot};
use nibi_kernel_api::session_api::{Kernel, KernelError, SessionHandle, StartSource};
use nibi_kernel_api::store::StoreError;

use crate::lifecycle::LifecycleHost;
use crate::resident::{DeactivationDecision, DeactivationReason};
use crate::table::Slot;
use crate::LocalKernel;

/// 一轮收敛里的会话事实。
struct Facts {
    persisted: bool,
    ready: bool,
    running: bool,
    queued: bool,
    pending: bool,
    background: bool,
    cron_due: bool,
    protocol_blocked: bool,
    created_at_ms: u64,
}

impl Facts {
    /// 没有任何阻止项（上游 `isEligible`）。
    fn eligible(&self) -> bool {
        self.persisted
            && self.ready
            && !self.running
            && !self.queued
            && !self.pending
            && !self.background
            && !self.cron_due
            && !self.protocol_blocked
    }
}

impl LocalKernel {
    /// 会话表里此刻有运行实例的会话（`Open`；加载中/关闭中不算常驻）。
    fn resident_ids(&self) -> Vec<SessionId> {
        let sessions = self.sessions();
        let mut ids: Vec<SessionId> = sessions
            .iter()
            .filter(|(_, slot)| matches!(slot, Slot::Open(_)))
            .map(|(session, _)| session.clone())
            .collect();
        ids.sort();
        ids
    }

    fn residency_watch(&self) -> Option<Arc<dyn SessionResidencyWatch>> {
        self.residency_watch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// 一个常驻会话的安全事实。读不出（句柄消失、事实 Unsupported）时 `None`：按“未知 = 不回收”。
    async fn resident_facts(&self, session: &SessionId) -> Option<Facts> {
        let handle = {
            let sessions = self.sessions();
            match sessions.get(session) {
                Some(Slot::Open(open)) => open.session.clone(),
                Some(Slot::Loading(_) | Slot::Closing { .. }) | None => return None,
            }
        };
        let facts = match handle.residency_facts().await {
            Ok(facts) => facts,
            Err(error) => {
                tracing::debug!(%error, session = %session, "resident facts are unavailable");
                return None;
            }
        };
        let watch = self.residency_watch();
        Some(Facts {
            persisted: !handle.is_draft(),
            ready: self.lifecycle.is_ready(self, session),
            running: facts.running,
            queued: facts.queued_commands > 0,
            pending: facts.pending_interactions > 0,
            background: facts.background_shells > 0 || facts.background_subagents > 0,
            cron_due: self.cron.has_due(session),
            protocol_blocked: watch.is_some_and(|watch| watch.has_protocol_blockers(session)),
            created_at_ms: facts.created_at_ms,
        })
    }

    /// 这个会话名下有没有在飞的 DWF run。查询失败按“有”处理（宁可少淘汰）。
    async fn has_live_workflow_run(&self, session: &SessionId) -> bool {
        match self.ports.store.workflow_runs(session).await {
            Ok(runs) => runs.iter().any(|run| run.status == "running"),
            Err(error) => {
                tracing::warn!(
                    event = "session.resident.workflow_runs_failed",
                    session = %session,
                    %error,
                    "the live workflow run query failed; keeping the session resident"
                );
                true
            }
        }
    }

    fn last_used(&self, session: &SessionId, facts: &Facts) -> u64 {
        self.resident
            .last_touched(session)
            .unwrap_or(0)
            .max(facts.created_at_ms)
    }

    fn decision(
        &self,
        reason: DeactivationReason,
        resident_count_before: usize,
        idle_ms: u64,
    ) -> DeactivationDecision {
        let config = self.resident.config();
        DeactivationDecision {
            reason,
            resident_count_before,
            idle_ms,
            target_count: config.target_count,
            high_water_count: config.high_water_count,
            idle_timeout_ms: config.idle_timeout_ms,
        }
    }

    /// 候选收集后再验一次：订阅/后台任务可能刚出现，TTL 到期也不能绕过 fresh facts。
    async fn can_deactivate(&self, session: &SessionId) -> bool {
        if self.resident.lease_count(session) > 0 || self.resident.in_flight(session) {
            return false;
        }
        let Some(facts) = self.resident_facts(session).await else {
            return false;
        };
        facts.eligible() && !self.has_live_workflow_run(session).await
    }

    async fn evict_resident(
        &self,
        session: &SessionId,
        decision: DeactivationDecision,
    ) -> bool {
        self.resident.mark_in_flight(session);
        let result = self.lifecycle.dispose(self, session).await;
        match &result {
            Ok(()) => {
                self.resident.forget(session);
                tracing::info!(
                    event = "session.resident.deactivated",
                    session = %session,
                    reason = decision.reason.as_str(),
                    idle_ms = decision.idle_ms,
                    resident_count_before = decision.resident_count_before,
                    target_count = decision.target_count,
                    high_water_count = decision.high_water_count,
                    idle_timeout_ms = decision.idle_timeout_ms,
                    "session resident runtime deactivated"
                );
            }
            Err(error) => {
                tracing::warn!(
                    event = "session.resident.deactivation_failed",
                    session = %session,
                    reason = decision.reason.as_str(),
                    code = %error.code,
                    message = %error.message,
                    "session resident deactivation failed"
                );
            }
        }
        self.resident.clear_in_flight(session);
        result.is_ok()
    }

    /// 容量与 TTL 的一次收敛（驱动器在请求释放后与 60 s 采样时调用）。
    pub async fn rebalance_resident_sessions(&self) {
        if !self.resident.begin_rebalance() {
            return;
        }
        struct Reset<'a>(&'a crate::resident::ResidentPool);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                self.0.end_rebalance();
            }
        }
        let _reset = Reset(&self.resident);

        let now = self.resident.now_ms();
        let initial = self.resident_ids();
        let resident: HashSet<SessionId> = initial.iter().cloned().collect();
        self.resident.prune(&resident);
        if initial.is_empty() {
            return;
        }

        // 1) 空闲 TTL：首次观察到可回收开始计时（touch 或出现阻塞事实重新计时）。
        let mut candidates = Vec::new();
        for session in &initial {
            let Some(facts) = self.resident_facts(session).await else {
                self.resident.clear_eligible(session);
                continue;
            };
            if !facts.eligible() {
                self.resident.clear_eligible(session);
                continue;
            }
            let eligible_since = self.resident.eligible_since(session, now);
            candidates.push((eligible_since, self.last_used(session, &facts), session.clone()));
        }
        candidates.sort();
        let idle_timeout = self.resident.config().idle_timeout_ms;
        let mut resident_count = initial.len();
        for (eligible_since, _, session) in &candidates {
            if self.resident.active_operations() > 0 {
                return;
            }
            let idle_ms = now.saturating_sub(*eligible_since);
            if idle_ms < idle_timeout {
                continue;
            }
            if !self.can_deactivate(session).await {
                self.resident.clear_eligible(session);
                continue;
            }
            let decision = self.decision(DeactivationReason::IdleTimeout, resident_count, idle_ms);
            if self.evict_resident(session, decision).await {
                resident_count = resident_count.saturating_sub(1);
            }
        }

        // 2) 高水位 LRU：回收到 target（只有超过高水位才动手）。
        let remaining = self.resident_ids();
        resident_count = remaining.len();
        let config = self.resident.config();
        if resident_count <= config.high_water_count {
            return;
        }
        let mut lru = Vec::new();
        for session in &remaining {
            let Some(facts) = self.resident_facts(session).await else {
                continue;
            };
            if !facts.eligible() {
                continue;
            }
            lru.push((self.last_used(session, &facts), session.clone()));
        }
        lru.sort();
        for (_, session) in lru {
            if resident_count <= config.target_count || self.resident.active_operations() > 0 {
                break;
            }
            if !self.can_deactivate(&session).await {
                continue;
            }
            let decision = self.decision(DeactivationReason::HighWaterLru, resident_count, 0);
            if self.evict_resident(&session, decision).await {
                resident_count = resident_count.saturating_sub(1);
            }
        }
    }

    /// 起 60 s sampler 兜底（正常收敛由每个协议 request 的租约释放触发）。只起一次。
    pub fn start_resident_pool(self: &Arc<Self>) {
        if !self.resident.mark_started() {
            return;
        }
        let weak = Arc::downgrade(self);
        let pool = self.resident.clone();
        let interval = pool.config().sampler_interval;
        self.scope.spawner().spawn_resident(
            "session-resident-pool",
            async move {
                loop {
                    tokio::select! {
                        () = pool.wake().notified() => {}
                        () = tokio::time::sleep(interval) => {}
                    }
                    let Some(kernel) = weak.upgrade() else {
                        return;
                    };
                    kernel.rebalance_resident_sessions().await;
                }
            },
        );
    }

    /// 会话是否存在（软删除的不算）：先看本进程的会话表（草稿没有存储行），再读索引事实
    /// （便宜），没有这份读面时退回加载会话。
    pub(crate) async fn session_exists(&self, session: &SessionId) -> Result<bool, KernelError> {
        if self.sessions().contains_key(session) {
            return Ok(true);
        }
        match self.ports.store.session_index_fact(session).await {
            Ok(Some(fact)) => return Ok(!fact.deleted),
            Ok(None) | Err(StoreError::Unsupported { .. }) => {}
            Err(error) => return Err(store_failure(&error)),
        }
        match self.ports.store.load(session).await {
            Ok(_) => Ok(true),
            Err(StoreError::NotFound { .. }) => Ok(false),
            Err(error) => Err(store_failure(&error)),
        }
    }
}

#[async_trait]
impl LifecycleHost for LocalKernel {
    async fn exists(&self, session: &SessionId) -> Result<bool, KernelError> {
        self.session_exists(session).await
    }

    fn has_runtime(&self, session: &SessionId) -> bool {
        matches!(self.sessions().get(session), Some(Slot::Open(_)))
    }

    async fn validate_activation(
        &self,
        session: &SessionId,
        workspace: Option<&WorkspaceRef>,
    ) -> Result<(), KernelError> {
        let Some(workspace) = workspace else {
            return Ok(());
        };
        let root = match self.settled(session).await {
            Some(open) => open.view().await?.meta.workspace.root,
            None => self
                .ports
                .store
                .load(session)
                .await
                .map_err(|error| store_failure(&error))?
                .meta
                .workspace
                .root,
        };
        if !same_workspace_path(root.as_str(), workspace.root.as_str()) {
            return Err(KernelError::Failed {
                message: "project.session-lineage-invalid".to_owned(),
            });
        }
        Ok(())
    }

    async fn activate(
        &self,
        session: &SessionId,
        _workspace: Option<&WorkspaceRef>,
    ) -> Result<(), KernelError> {
        // 复用现有冷加载：与 `session/open` 同一条路径（插件快照、Loading 去重、SessionStart(resume)）。
        self.open_session_as(session, StartSource::Resume)
            .await
            .map(|_| ())
    }

    fn assert_can_stop(&self, _session: &SessionId) -> Result<(), KernelError> {
        // 主动停止不继承 TTL/LRU 的 busy 保护；回收的预检在池那一侧。
        Ok(())
    }

    async fn release(&self, session: &SessionId) -> Result<(), KernelError> {
        // 关闭 actor、跑 SessionEnd、释放按会话的表；不删持久事实、不发 `session.removed`。
        self.close_open(session).await.map(|_| ())
    }

    fn on_change(&self, snapshot: &SessionLifecycleSnapshot) {
        tracing::info!(
            event = "session.lifecycle.changed",
            session = %snapshot.session_id,
            state = snapshot.state.as_str(),
            generation = snapshot.generation,
            revision = snapshot.revision,
            last_error = snapshot.last_error.as_ref().map(|error| error.code.as_str()),
            "session runtime lifecycle changed"
        );
        // 协议层注入的观察者（`session/lifecycle/changed`）。同步、失败只记在观察者那边：
        // 通知不改变已经完成的生命周期事实。
        let observer = self
            .lifecycle_observer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(observer) = observer {
            observer.lifecycle_changed(snapshot);
        }
    }
}

fn store_failure(error: &StoreError) -> KernelError {
    match error {
        StoreError::NotFound { session } => KernelError::NotFound {
            session: session.clone(),
        },
        other => KernelError::Failed {
            message: other.to_string(),
        },
    }
}

/// 工作区路径的归属比较：Windows 下分隔符与大小写不敏感（Host 可能给 `/`，本地记录是 `\`）。
fn same_workspace_path(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        let normalize = |path: &str| {
            path.replace('\\', "/")
                .trim_end_matches('/')
                .to_lowercase()
        };
        normalize(left) == normalize(right)
    }
    #[cfg(not(windows))]
    {
        left.trim_end_matches('/') == right.trim_end_matches('/')
    }
}

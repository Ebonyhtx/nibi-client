//! 常驻会话池（NIBI 3.17.2 `session-resident-pool.ts` 的 Rust 版）：容量、LRU、空闲 TTL 与操作租约。
//!
//! 池不拥有会话内容，只决定**何时回收本进程里的运行实例**。真正的释放走 [`crate::lifecycle`]
//! 的状态机（唯一写者），回收原因只有两种：`high_water_lru` / `idle_timeout`。
//!
//! 两条触发路径（与上游一致）：
//!
//! - 每个协议 request 持一个 [`ResidencyLease`](nibi_kernel_api::residency::ResidencyLease)，`Drop`
//!   释放并唤醒驱动器；释放后没有别的在途请求时收敛一次。
//! - 60 s sampler 兜底：请求路径没触发（例如后台通知把会话从阻塞变成可回收）时也能收敛。
//!
//! 事实来源见 [`LocalKernel::resident_facts`]：会话 actor 的轻量事实（在跑回合、排队输入、待回答交互、
//! 后台 shell/子代理）、`CronSignals::has_due`、协议层注入的订阅事实（[`SessionResidencyWatch`]）、
//! `dwf_run` 的 `running` 行与草稿/持久化状态。任一命中就不淘汰（宁可少淘汰）。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use nibi_kernel_api::clock::Clock;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::residency::{ResidencyLease, SessionResidencyWatch};
use tokio::sync::Notify;

/// 常驻池参数（上游默认 8 / 16 / 10 分钟；sampler 60 s）。
#[derive(Debug, Clone, Copy)]
pub struct ResidentPoolConfig {
    /// 高于高水位时回收到这个数量。
    pub target_count: usize,
    /// 超过这个数量才按 LRU 回收。
    pub high_water_count: usize,
    /// 连续空闲多久后回收（从第一次观察到可回收起算，与上游 `eligibleSinceAt` 一致）。
    pub idle_timeout_ms: u64,
    /// 兜底采样间隔。
    pub sampler_interval: Duration,
}

impl Default for ResidentPoolConfig {
    fn default() -> Self {
        Self {
            target_count: 8,
            high_water_count: 16,
            idle_timeout_ms: 10 * 60 * 1_000,
            sampler_interval: Duration::from_secs(60),
        }
    }
}

/// 回收原因（日志/决策里的 `reason`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeactivationReason {
    HighWaterLru,
    IdleTimeout,
}

impl DeactivationReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::HighWaterLru => "high_water_lru",
            Self::IdleTimeout => "idle_timeout",
        }
    }
}

/// 一次回收的决策依据（写日志；字段与上游 `SessionDeactivationDecision` 同义）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct DeactivationDecision {
    pub reason: DeactivationReason,
    pub resident_count_before: usize,
    pub idle_ms: u64,
    pub target_count: usize,
    pub high_water_count: usize,
    pub idle_timeout_ms: u64,
}

#[derive(Default)]
struct PoolState {
    /// 进程级在途请求数：> 0 时不收敛（跨会话的异步操作与 sampler 不能并发回收）。
    active_operations: usize,
    /// 按会话的租约数（精确所有权；参与 eligibility）。
    leases: HashMap<SessionId, usize>,
    /// 最后一次使用（协议请求的 acquire/release）。
    touched: HashMap<SessionId, u64>,
    /// 第一次观察到「可回收」的时刻；touch 或出现阻塞事实时清掉（上游 `eligibleSinceAt`）。
    eligible_since: HashMap<SessionId, u64>,
    /// 正在回收的会话：新的请求要等它结束（再打开会自动冷加载）。
    in_flight: HashSet<SessionId>,
    rebalancing: bool,
}

pub(crate) struct ResidentPool {
    config: ResidentPoolConfig,
    clock: Arc<dyn Clock>,
    state: Mutex<PoolState>,
    /// 请求释放/回收结束的唤醒信号（驱动器等它）。
    wake: Notify,
    started: AtomicBool,
}

impl ResidentPool {
    pub(crate) fn new(config: ResidentPoolConfig, clock: Arc<dyn Clock>) -> Self {
        Self {
            config,
            clock,
            state: Mutex::default(),
            wake: Notify::new(),
            started: AtomicBool::new(false),
        }
    }

    pub(crate) fn config(&self) -> ResidentPoolConfig {
        self.config
    }

    pub(crate) fn wake(&self) -> &Notify {
        &self.wake
    }

    /// 驱动器只起一次（`start_resident_pool` 可能被入口与测试各调一次）。
    pub(crate) fn mark_started(&self) -> bool {
        !self.started.swap(true, Ordering::SeqCst)
    }

    fn state(&self) -> MutexGuard<'_, PoolState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn now_ms(&self) -> u64 {
        self.clock.now_ms()
    }

    /// 取一个操作租约。若目标会话正在回收，等到它结束再返回（打开会随之冷加载）。
    pub(crate) async fn acquire(self: &Arc<Self>, sessions: &[SessionId]) -> ResidencyLease {
        let unique: Vec<SessionId> = {
            let mut seen = HashSet::new();
            sessions
                .iter()
                .filter(|session| !session.as_str().is_empty() && seen.insert((*session).clone()))
                .cloned()
                .collect()
        };
        loop {
            // 先登记等待再检查：回收在两者之间结束也不会丢唤醒（`notify_waiters` 不存许可，
            // `enable` 先把 future 登记到等待队列）。
            let mut notified = std::pin::pin!(self.wake.notified());
            notified.as_mut().enable();
            {
                let mut state = self.state();
                if unique
                    .iter()
                    .all(|session| !state.in_flight.contains(session))
                {
                    let now = self.clock.now_ms();
                    state.active_operations += 1;
                    for session in &unique {
                        *state.leases.entry(session.clone()).or_insert(0) += 1;
                        touch(&mut state, session, now);
                    }
                    break;
                }
            }
            notified.await;
        }
        let pool = self.clone();
        ResidencyLease::new(move || pool.release(&unique))
    }

    fn release(&self, sessions: &[SessionId]) {
        let now = self.clock.now_ms();
        {
            let mut state = self.state();
            for session in sessions {
                touch(&mut state, session, now);
                if let Some(count) = state.leases.get_mut(session) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        state.leases.remove(session);
                    }
                }
            }
            state.active_operations = state.active_operations.saturating_sub(1);
        }
        self.wake.notify_one();
    }

    pub(crate) fn active_operations(&self) -> usize {
        self.state().active_operations
    }

    pub(crate) fn lease_count(&self, session: &SessionId) -> usize {
        self.state().leases.get(session).copied().unwrap_or(0)
    }

    /// 进入一轮收敛（进程里没有在途请求且没有别的收敛在跑）。返回 false 时调用方直接返回。
    pub(crate) fn begin_rebalance(&self) -> bool {
        let mut state = self.state();
        if state.active_operations > 0 || state.rebalancing {
            return false;
        }
        state.rebalancing = true;
        true
    }

    pub(crate) fn end_rebalance(&self) {
        self.state().rebalancing = false;
    }

    /// 清理已经不在表里的会话的元数据（仍被租约/回收持有的除外）。
    pub(crate) fn prune(&self, resident: &HashSet<SessionId>) {
        let mut state = self.state();
        let PoolState {
            touched,
            eligible_since,
            in_flight,
            leases,
            ..
        } = &mut *state;
        touched.retain(|session, _| {
            resident.contains(session) || in_flight.contains(session) || leases.contains_key(session)
        });
        eligible_since
            .retain(|session, _| resident.contains(session) || in_flight.contains(session));
    }

    pub(crate) fn clear_eligible(&self, session: &SessionId) {
        self.state().eligible_since.remove(session);
    }

    /// 第一次观察到可回收的时刻（没有时以此刻开始计时）。
    pub(crate) fn eligible_since(&self, session: &SessionId, now: u64) -> u64 {
        *self.state().eligible_since.entry(session.clone()).or_insert(now)
    }

    pub(crate) fn last_touched(&self, session: &SessionId) -> Option<u64> {
        self.state().touched.get(session).copied()
    }

    pub(crate) fn mark_in_flight(&self, session: &SessionId) {
        self.state().in_flight.insert(session.clone());
    }

    pub(crate) fn clear_in_flight(&self, session: &SessionId) {
        self.state().in_flight.remove(session);
        // 等这个会话回收完的 acquire 醒来（重新冷加载）。
        self.wake.notify_waiters();
    }

    pub(crate) fn in_flight(&self, session: &SessionId) -> bool {
        self.state().in_flight.contains(session)
    }

    /// 回收成功后丢掉这个会话的 LRU 元数据。
    pub(crate) fn forget(&self, session: &SessionId) {
        let mut state = self.state();
        state.touched.remove(session);
        state.eligible_since.remove(session);
    }
}

fn touch(state: &mut PoolState, session: &SessionId, now: u64) {
    let previous = state.touched.get(session).copied();
    if previous.is_none_or(|previous| now > previous) {
        state.touched.insert(session.clone(), now);
    }
    // 协议请求重新使用会话后必须重新计时，不能沿用 touch 前接近到期的 eligible 窗口。
    state.eligible_since.remove(session);
}

/// 协议层注入的订阅事实（Live/分享）。池只读。
pub(crate) type ResidencyWatchSlot = Mutex<Option<Arc<dyn SessionResidencyWatch>>>;

/// 协议层注入的生命周期观察者（`session/lifecycle/changed` 的推送来源）。
pub(crate) type LifecycleObserverSlot =
    Mutex<Option<Arc<dyn nibi_kernel_api::residency::SessionLifecycleObserver>>>;

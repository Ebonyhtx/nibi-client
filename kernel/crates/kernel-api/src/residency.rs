//! 常驻会话池与运行实例生命周期（NIBI 3.17.2 `session-resident-pool.ts` / `session-lifecycle/`）。
//!
//! 这里的类型只描述**本进程里的运行实例**：不创建、不删除持久会话，也不拥有会话内容。池只决定何时回收；
//! 生命周期状态机的唯一写者在内核（runtime 的 `lifecycle.rs`）。协议层（app-server）按请求提供常驻事实与
//! 操作租约（[`ResidencyLease`]），宿主契约见 [`SessionResidencyWatch`]。
//!
//! 与 Node 的对应：
//!
//! - `SessionResidencyFacts` ← 会话 actor 给出的轻量事实（在跑回合、排队输入、待回答交互、后台工作）。不读
//!   `SessionView`：视图要复制整段历史，池的每次收敛都读它会把长会话的切换拖慢。
//! - `SessionLifecycleSnapshot` ← `sessionLifecycleSnapshotSchema`（`session/lifecycle/getState` 的回包）。
//! - `ResidencyLease` ← 每个协议 request 持有的 operation lease；`Drop` 时释放并触发收敛。

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::ids::SessionId;

/// 运行实例的状态（`sessionLifecycleStateSchema`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionLifecycleState {
    /// 没有运行实例（持久事实仍在）。
    Unloaded,
    /// 正在初始化（冷加载）。
    Starting,
    /// 实例可用。
    Ready,
    /// 正在释放。
    Stopping,
    /// 释放/初始化失败，实例状态不确定；不自动重建（进程重启是上层出口）。
    Faulted,
}

impl SessionLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unloaded => "unloaded",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Stopping => "stopping",
            Self::Faulted => "faulted",
        }
    }
}

/// 生命周期操作（`sessionLifecycleOperationSchema`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionLifecycleOperation {
    EnsureReady,
    Stop,
    Restart,
}

impl SessionLifecycleOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EnsureReady => "ensureReady",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}

/// 最近一次失败（`sessionLifecycleFailureSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLifecycleFailure {
    pub operation: SessionLifecycleOperation,
    pub code: String,
    pub message: String,
}

/// `session/lifecycle/getState` 的快照（`sessionLifecycleSnapshotSchema`，`.strict()`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLifecycleSnapshot {
    pub session_id: SessionId,
    pub state: SessionLifecycleState,
    /// 每成功初始化一次加一。
    pub generation: u64,
    /// 每次状态发布加一（客户端据此丢弃落后的观察）。
    pub revision: u64,
    /// 没有失败时为 `null`（schema 要求字段在场）。
    pub last_error: Option<SessionLifecycleFailure>,
}

/// 会话 actor 给出的常驻事实（只读、轻量）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionResidencyFacts {
    /// 有回合在跑，或 actor 里有回合级后台工作（SessionStart、代码回退）没结束。
    pub running: bool,
    /// 排队等待的输入（含 next 通道、已取走的到点定时任务与待提升输入）。
    pub queued_commands: usize,
    /// 待回答的交互（权限、提问、计划审批；含回合外会话级询问）。
    pub pending_interactions: usize,
    /// 执行环境里还在跑的后台命令。
    pub background_shells: usize,
    /// 本会话还有在跑的后台子代理。
    pub background_subagents: usize,
    /// 会话创建时刻（LRU 在协议从未 touch 过时的兜底）。
    pub created_at_ms: u64,
}

/// 协议侧的常驻事实：订阅（Live / 分享）等只有协议层知道、但会让回收破坏用户链路的阻塞项。
///
/// 入口/协议层在装配时注入（[`crate::session_api::Kernel::set_session_residency_watch`]）；没有接入的入口
/// （TUI、测试）没有阻塞项。实现必须同步、便宜——池在每次收敛时对每个常驻会话问一次。
pub trait SessionResidencyWatch: Send + Sync {
    fn has_protocol_blockers(&self, _session: &SessionId) -> bool {
        false
    }
}

/// 没有协议侧事实（TUI / 嵌入）。
pub struct NoResidencyBlockers;

impl SessionResidencyWatch for NoResidencyBlockers {}

/// 生命周期快照的观察者（协议层注入，`session/lifecycle/changed` 的推送来源）。
///
/// 状态机在每次发布状态/失败事实时同步调用；实现必须便宜、不阻塞，也不能把失败（连接已关、
/// 写队列满）传回状态机——通知失败不改变已经完成的生命周期事实，客户端重连后用
/// `session/lifecycle/getState` 对账。
pub trait SessionLifecycleObserver: Send + Sync {
    fn lifecycle_changed(&self, snapshot: &SessionLifecycleSnapshot);
}

/// 一次协议请求持有的常驻租约：持有期间池不回收这些会话，`Drop` 时释放并触发收敛。
///
/// 只做同步计数与唤醒（收敛由内核的池驱动器异步跑）：request future 被丢下时 `Drop` 照样执行，
/// 不会留下永远不释放的租约。
pub struct ResidencyLease {
    release: Option<Box<dyn FnOnce() + Send>>,
}

impl ResidencyLease {
    pub fn new(release: impl FnOnce() + Send + 'static) -> Self {
        Self {
            release: Some(Box::new(release)),
        }
    }
}

impl Drop for ResidencyLease {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            release();
        }
    }
}

impl fmt::Debug for ResidencyLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResidencyLease")
            .field("released", &self.release.is_none())
            .finish()
    }
}

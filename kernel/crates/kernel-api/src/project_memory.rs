//! 项目记忆的端口：会话开关与回合结束后的抽取调度。
//!
//! 记忆目录与文件格式见 Node `@nibi/core` 的 `memory/`；这里只给能力之间的接口。
//! runtime 实现 [`ProjectMemoryScheduler`]；context 只读 [`ProjectMemorySettings`] 决定是否注入
//! `MEMORY.md`。

use std::sync::Arc;

use crate::env::WorkspaceRef;
use crate::ids::SessionId;
use crate::message::Message;
use crate::model::ModelSelection;
use crate::permission::PermissionMode;

/// 按会话的记忆开关（Host 的 `memoryEnabled`）。没有记录时按开启（CLI/TUI 与旧 Host）。
pub trait ProjectMemorySettings: Send + Sync {
    fn enabled(&self, session: &SessionId) -> bool;
}

/// 一次成功回合之后交给抽取的只读快照。
#[derive(Debug, Clone)]
pub struct ProjectMemoryTurn {
    pub session: SessionId,
    pub workspace: WorkspaceRef,
    pub selection: ModelSelection,
    pub mode: PermissionMode,
    /// 回合结束时的活动历史（含本轮刚提交的 assistant / tool_result）。
    pub messages: Arc<[Message]>,
}

/// 回合结束后的项目记忆抽取。实现方负责跳过条件、后台执行与串行化；不阻塞会话的下一回合。
pub trait ProjectMemoryScheduler: Send + Sync {
    fn schedule(&self, turn: ProjectMemoryTurn);

    /// 会话关闭：取消它的在跑抽取并清掉游标（Node 关闭时 abort 抽取，不推进 cursor）。
    fn session_closed(&self, _session: &SessionId) {}
}

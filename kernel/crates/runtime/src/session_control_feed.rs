//! `WaitSessions` 的观察流：把会话 actor 的事件流投影成 operation 快照。
//!
//! baseline 来自 `SessionView`（队列 + 事件日志回放）；实时更新从 `last_seq` 之后订阅。同一
//! operation 的快照用事件 `seq` 作 revision，严格递增；断流由工具的「观察提前结束」按 unknown
//! 收尾。feed 的 close 幂等并终止待取更新。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::orchestration::InteractionRequest;
use nibi_kernel_api::session_api::{
    Kernel, KernelError, KernelEvent, SessionHandle, SessionView, TurnOutcome,
};
use nibi_kernel_api::session_control::{
    OperationAttention, OperationRef, OperationSnapshot, OperationStatus, OperationUpdate,
    SessionControlError, SessionControlFeed,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::LocalKernel;

/// 观察流的 epoch：本进程内一个会话的 actor 换代会结束旧流，工具按 unknown 收尾。
const EPOCH: &str = "kernel";
/// 回放事件日志的上限：只需要找到目标 command 的最近一次开始/结束。
const REPLAY_BUDGET: Duration = Duration::from_millis(250);

fn map_error(error: KernelError) -> SessionControlError {
    match error {
        KernelError::NotFound { .. } => {
            SessionControlError::forbidden("Target is outside the trusted scope")
        }
        KernelError::Unsupported { what } => {
            SessionControlError::unavailable(format!("session observation is unsupported: {what}"))
        }
        KernelError::Failed { message } => SessionControlError::unavailable(message),
    }
}

fn attention(request: &InteractionRequest) -> OperationAttention {
    match request {
        InteractionRequest::Permission { message, .. } => OperationAttention {
            kind: "approval".to_owned(),
            message: Some(message.clone()),
            url: None,
        },
        InteractionRequest::Question { .. } | InteractionRequest::PlanApproval { .. } => {
            OperationAttention {
                kind: "question".to_owned(),
                message: None,
                url: None,
            }
        }
    }
}

fn outcome_status(outcome: &TurnOutcome) -> (OperationStatus, Option<String>) {
    match outcome {
        TurnOutcome::Success => (OperationStatus::Completed, None),
        TurnOutcome::Interrupted => (OperationStatus::Interrupted, None),
        TurnOutcome::Failed { message } => (OperationStatus::Failed, Some(message.clone())),
    }
}

#[derive(Default)]
struct History {
    started: bool,
    running: Option<String>,
    done: Option<(OperationStatus, Option<String>)>,
}

/// 从事件日志回放目标 command 的最近一次开始与结束。
async fn scan(handle: &Arc<dyn SessionHandle>, last_seq: u64, command_id: &str) -> History {
    let mut history = History::default();
    if last_seq == 0 {
        return history;
    }
    let mut stream = handle.subscribe(Some(0));
    let deadline = tokio::time::Instant::now() + REPLAY_BUDGET;
    loop {
        let next = tokio::time::timeout_at(deadline, stream.next()).await;
        let Ok(Some(event)) = next else {
            break;
        };
        match &event.event {
            KernelEvent::TurnStarted {
                turn,
                command: Some(command),
                ..
            } if command.as_str() == command_id => {
                history.started = true;
                history.running = Some(turn.to_string());
                history.done = None;
            }
            KernelEvent::TurnFinished { turn, outcome, .. }
                if history.running.as_deref() == Some(turn.as_str()) =>
            {
                history.done = Some(outcome_status(outcome));
                history.running = None;
            }
            _ => {}
        }
        if event.seq >= last_seq {
            break;
        }
    }
    history
}

async fn baseline(
    handle: &Arc<dyn SessionHandle>,
    view: &SessionView,
    operation: &OperationRef,
) -> OperationSnapshot {
    let mut snapshot = OperationSnapshot {
        operation: operation.clone(),
        epoch: EPOCH.to_owned(),
        revision: view.last_seq,
        status: OperationStatus::Unknown,
        execution_id: None,
        reason: None,
        attention: None,
    };
    if view
        .queue
        .iter()
        .any(|queued| queued.command.as_str() == operation.command_id)
    {
        snapshot.status = OperationStatus::Queued;
        return snapshot;
    }
    let history = scan(handle, view.last_seq, &operation.command_id).await;
    if let Some((status, reason)) = history.done {
        snapshot.status = status;
        snapshot.reason = reason;
        return snapshot;
    }
    if let Some(turn) = history.running {
        snapshot.execution_id = Some(turn);
        match view.pending.first() {
            Some((_, request)) => {
                snapshot.status = OperationStatus::NeedsAttention;
                snapshot.attention = Some(attention(request));
            }
            None => snapshot.status = OperationStatus::Running,
        }
        return snapshot;
    }
    if history.started {
        snapshot.status = OperationStatus::Idle;
        return snapshot;
    }
    snapshot.reason = Some("This process cannot observe the operation".to_owned());
    snapshot
}

struct KernelFeed {
    initial: OperationSnapshot,
    updates: mpsc::UnboundedReceiver<OperationUpdate>,
    task: Option<JoinHandle<()>>,
    closed: bool,
}

#[async_trait]
impl SessionControlFeed for KernelFeed {
    fn initial(&self) -> OperationSnapshot {
        self.initial.clone()
    }

    async fn recv(&mut self) -> Option<OperationUpdate> {
        if self.closed {
            return None;
        }
        self.updates.recv().await
    }

    /// 幂等；中止订阅任务并丢弃接收端，之后 `recv` 立即结束。
    async fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn live(
    handle: Arc<dyn SessionHandle>,
    after: u64,
    operation: OperationRef,
    initial: OperationSnapshot,
    sender: mpsc::UnboundedSender<OperationUpdate>,
) {
    let mut snapshot = initial;
    let mut turn = snapshot.execution_id.clone();
    let mut stream = handle.subscribe(Some(after));
    while let Some(event) = stream.next().await {
        let mut changed = false;
        match &event.event {
            KernelEvent::TurnStarted {
                turn: started,
                command: Some(command),
                ..
            } if command.as_str() == operation.command_id => {
                turn = Some(started.to_string());
                snapshot.status = OperationStatus::Running;
                snapshot.execution_id = Some(started.to_string());
                snapshot.attention = None;
                changed = true;
            }
            KernelEvent::TurnFinished {
                turn: finished,
                outcome,
                ..
            } if turn.as_deref() == Some(finished.as_str()) => {
                let (status, reason) = outcome_status(outcome);
                snapshot.status = status;
                snapshot.reason = reason;
                snapshot.execution_id = None;
                snapshot.attention = None;
                snapshot.revision = event.seq;
                let _ = sender.send(OperationUpdate::Snapshot {
                    snapshot: snapshot.clone(),
                });
                break;
            }
            KernelEvent::QueueChanged { items } => {
                let queued = items
                    .iter()
                    .any(|queued| queued.command.as_str() == operation.command_id);
                if queued && snapshot.status == OperationStatus::Unknown {
                    snapshot.status = OperationStatus::Queued;
                    changed = true;
                } else if !queued && snapshot.status == OperationStatus::Queued {
                    snapshot.status = OperationStatus::Idle;
                    changed = true;
                }
            }
            KernelEvent::InteractionAsked { request, .. }
                if snapshot.status == OperationStatus::Running =>
            {
                snapshot.status = OperationStatus::NeedsAttention;
                snapshot.attention = Some(attention(request));
                changed = true;
            }
            KernelEvent::InteractionResolved { .. }
                if snapshot.status == OperationStatus::NeedsAttention =>
            {
                snapshot.status = OperationStatus::Running;
                snapshot.attention = None;
                changed = true;
            }
            _ => {}
        }
        if changed {
            snapshot.revision = event.seq;
            if sender
                .send(OperationUpdate::Snapshot {
                    snapshot: snapshot.clone(),
                })
                .is_err()
            {
                break;
            }
        }
    }
}

pub(crate) async fn open(
    kernel: &LocalKernel,
    operation: &OperationRef,
) -> Result<Box<dyn SessionControlFeed>, SessionControlError> {
    let id = SessionId::new(operation.session.session_id.clone());
    let handle = kernel.open_session(&id).await.map_err(map_error)?;
    let view = handle.view().await.map_err(map_error)?;
    if view.meta.id != id {
        return Err(SessionControlError::invalid_output(
            "Owner returned a different session",
        ));
    }
    let initial = baseline(&handle, &view, operation).await;
    let (sender, updates) = mpsc::unbounded_channel();
    let task = tokio::spawn(live(
        handle,
        view.last_seq,
        operation.clone(),
        initial.clone(),
        sender,
    ));
    Ok(Box::new(KernelFeed {
        initial,
        updates,
        task: Some(task),
        closed: false,
    }))
}

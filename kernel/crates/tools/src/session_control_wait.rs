//! `WaitSessions` 的有界等待编排（上游 `application/common/wait.ts`）。
//!
//! 先拒绝 self-wait 与重复 operation（在打开任何观察之前，见上层），再授权全部目标，然后并发打开
//! 观察流。`timeoutMs=0` 只读 baseline 并收齐全部目标后判断 any/all；其余情况等到满足条件、失效、
//! 截止或取消。取消与截止只关闭观察，不停目标会话。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use nibi_kernel_api::session_control::{
    DEFAULT_WAIT_TIMEOUT_MS, OperationRef, OperationSnapshot, OperationStatus, OperationUpdate,
    SessionControlError, SessionControlHost, TrustedContext, WaitMode, WaitSessionsResult,
    WaitStatus,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// 关闭已打开观察时的等待上限：feed 的 close 必须及时；超过这个时间就不再阻塞工具返回。
const CLOSE_GRACE: Duration = Duration::from_secs(1);

enum Message {
    Opened(usize, OperationSnapshot),
    Update(usize, OperationSnapshot),
    Invalid(usize, String),
    Ended(usize),
    Closed(usize),
    Failed(SessionControlError),
}

/// 同一个 operation 的身份：commandId + 同一会话。
fn same_operation(a: &OperationRef, b: &OperationRef) -> bool {
    a.command_id == b.command_id
        && a.session.session_id == b.session.session_id
        && a.session.workspace_key() == b.session.workspace_key()
}

/// 一个目标快照是不是同一次观察（身份、epoch 与严格递增的 revision）。
fn valid_update(previous: &OperationSnapshot, next: &OperationSnapshot) -> Result<(), String> {
    if !same_operation(&next.operation, &previous.operation) {
        return Err("Observation identity changed".to_owned());
    }
    if next.epoch.is_empty() || next.epoch != previous.epoch {
        return Err("Observation epoch changed".to_owned());
    }
    if next.revision <= previous.revision {
        return Err("Observation revision did not advance".to_owned());
    }
    if next.operation.session_id != next.operation.session.session_id {
        return Err("Observation session id disagrees with its reference".to_owned());
    }
    Ok(())
}

/// baseline：身份一致、epoch 非空、sessionId 与完整引用一致。
fn valid_baseline(expected: &OperationRef, snapshot: &OperationSnapshot) -> Result<(), String> {
    if !same_operation(&snapshot.operation, expected) {
        return Err("Invalid observation baseline".to_owned());
    }
    if snapshot.epoch.is_empty() {
        return Err("Invalid observation baseline".to_owned());
    }
    if snapshot.operation.session_id != snapshot.operation.session.session_id {
        return Err("Invalid observation baseline".to_owned());
    }
    Ok(())
}

fn satisfied(snapshots: &[OperationSnapshot], mode: WaitMode) -> bool {
    !snapshots.is_empty()
        && match mode {
            WaitMode::Any => snapshots.iter().any(|value| value.status.is_settled()),
            WaitMode::All => snapshots.iter().all(|value| value.status.is_settled()),
        }
}

fn decided(
    snapshots: &[OperationSnapshot],
    opened: usize,
    mode: WaitMode,
    timeout_zero: bool,
) -> Option<WaitStatus> {
    // 零等待是全量快照查询：any 也必须收齐各目标的 baseline 后再判断。
    if timeout_zero && opened != snapshots.len() {
        return None;
    }
    if satisfied(snapshots, mode) {
        return Some(WaitStatus::Completed);
    }
    if opened == snapshots.len()
        && snapshots
            .iter()
            .any(|value| value.status == OperationStatus::Unknown)
    {
        return Some(WaitStatus::Unknown);
    }
    if opened == snapshots.len() && timeout_zero {
        return Some(WaitStatus::TimedOut);
    }
    None
}

fn unknown(snapshot: &mut OperationSnapshot, reason: impl Into<String>) {
    snapshot.status = OperationStatus::Unknown;
    snapshot.reason = Some(reason.into());
}

/// 有界等待。调用方已拒绝 self-wait、重复 operation，并校验过全部目标的范围。
pub(crate) async fn wait_for_operations(
    host: Arc<dyn SessionControlHost>,
    ctx: TrustedContext,
    operations: Vec<OperationRef>,
    mode: WaitMode,
    timeout_ms: u64,
    cancel: CancellationToken,
) -> Result<WaitSessionsResult, SessionControlError> {
    let mut snapshots: Vec<OperationSnapshot> = operations
        .iter()
        .cloned()
        .map(OperationSnapshot::unobserved)
        .collect();
    if cancel.is_cancelled() {
        return Ok(WaitSessionsResult {
            status: WaitStatus::Cancelled,
            operations: snapshots,
        });
    }

    let timeout_zero = timeout_ms == 0;
    // timeout=0 不订阅未来变化，但授权与 baseline 获取仍有界（上游同一 30 s 获取上限）。
    let deadline = Duration::from_millis(if timeout_zero {
        DEFAULT_WAIT_TIMEOUT_MS
    } else {
        timeout_ms
    });
    let (sender, mut receiver) = mpsc::channel::<Message>(64);
    let stop = CancellationToken::new();
    for (index, operation) in operations.iter().cloned().enumerate() {
        let host = host.clone();
        let ctx = ctx.clone();
        let sender = sender.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            observe(host, ctx, index, operation, sender, stop, timeout_zero).await;
        });
    }
    drop(sender);
    let mut opened = HashSet::new();
    let mut status: Option<WaitStatus> = None;
    let sleep = tokio::time::sleep(deadline);
    tokio::pin!(sleep);
    loop {
        if status.is_some() {
            break;
        }
        tokio::select! {
            () = cancel.cancelled() => {
                status = Some(WaitStatus::Cancelled);
            }
            () = &mut sleep => {
                status = Some(WaitStatus::TimedOut);
            }
            message = receiver.recv() => match message {
                Some(Message::Opened(index, snapshot)) => {
                    opened.insert(index);
                    if let Err(reason) = valid_baseline(&operations[index], &snapshot) {
                        unknown(&mut snapshots[index], reason);
                        status = Some(WaitStatus::Unknown);
                        continue;
                    }
                    snapshots[index] = snapshot;
                    if let Some(next) = decided(&snapshots, opened.len(), mode, timeout_zero) {
                        status = Some(next);
                    }
                }
                Some(Message::Update(index, snapshot)) => {
                    if let Err(reason) = valid_update(&snapshots[index], &snapshot) {
                        unknown(&mut snapshots[index], reason);
                        status = Some(WaitStatus::Unknown);
                        continue;
                    }
                    snapshots[index] = snapshot;
                    if let Some(next) = decided(&snapshots, opened.len(), mode, timeout_zero) {
                        status = Some(next);
                    }
                }
                Some(Message::Invalid(index, reason)) => {
                    unknown(&mut snapshots[index], reason);
                    status = Some(WaitStatus::Unknown);
                }
                Some(Message::Ended(index)) => {
                    // 已确认的终态不能因流正常结束退回 unknown；未结就结束是观察失效。
                    if !snapshots[index].status.is_settled() {
                        unknown(&mut snapshots[index], "Observation ended before operation settled");
                        status = Some(WaitStatus::Unknown);
                    }
                }
                Some(Message::Failed(error)) => {
                    stop.cancel();
                    return Err(error);
                }
                Some(Message::Closed(_)) => {}
                None => {
                    // 全部观察任务已退出：终态齐全算完成，否则按未知收尾。
                    status = Some(if snapshots.iter().all(|value| value.status.is_settled()) {
                        WaitStatus::Completed
                    } else {
                        WaitStatus::Unknown
                    });
                }
            },
        }
    }
    // 关闭已建立的观察；迟到 open 由它自己的任务在拿到 feed 后立即关闭。
    stop.cancel();
    close_opened(&mut receiver, &opened).await;
    Ok(WaitSessionsResult {
        status: status.unwrap_or(WaitStatus::Unknown),
        operations: snapshots,
    })
}

/// 等已打开的观察确认关闭（有界；discard 未打开任务的清理由任务自己完成）。
async fn close_opened(receiver: &mut mpsc::Receiver<Message>, opened: &HashSet<usize>) {
    let mut remaining: HashSet<usize> = opened.clone();
    while !remaining.is_empty() {
        match tokio::time::timeout(CLOSE_GRACE, receiver.recv()).await {
            Ok(Some(Message::Closed(index))) => {
                remaining.remove(&index);
            }
            // 其它消息在收尾阶段不再影响结果。
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }
}

async fn observe(
    host: Arc<dyn SessionControlHost>,
    ctx: TrustedContext,
    index: usize,
    operation: OperationRef,
    sender: mpsc::Sender<Message>,
    stop: CancellationToken,
    timeout_zero: bool,
) {
    let mut feed = match host.open_observation(&ctx, &operation).await {
        Ok(feed) => feed,
        Err(error) => {
            let _ = sender.send(Message::Failed(error)).await;
            return;
        }
    };
    if stop.is_cancelled() {
        feed.close().await;
        let _ = sender.send(Message::Closed(index)).await;
        return;
    }
    if sender
        .send(Message::Opened(index, feed.initial()))
        .await
        .is_err()
    {
        feed.close().await;
        return;
    }
    if timeout_zero {
        feed.close().await;
        let _ = sender.send(Message::Closed(index)).await;
        return;
    }
    loop {
        tokio::select! {
            () = stop.cancelled() => break,
            update = feed.recv() => match update {
                Some(OperationUpdate::Snapshot { snapshot }) => {
                    if sender.send(Message::Update(index, snapshot)).await.is_err() {
                        break;
                    }
                }
                Some(OperationUpdate::Invalidated { operation: reported, reason }) => {
                    let reason = if same_operation(&reported, &operation) {
                        reason
                    } else {
                        "Observation identity changed".to_owned()
                    };
                    let _ = sender.send(Message::Invalid(index, reason)).await;
                    break;
                }
                None => {
                    let _ = sender.send(Message::Ended(index)).await;
                    break;
                }
            },
        }
    }
    feed.close().await;
    let _ = sender.send(Message::Closed(index)).await;
}

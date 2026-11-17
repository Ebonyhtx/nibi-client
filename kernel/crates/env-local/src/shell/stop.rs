//! TaskStop 停后台命令（docs/specs/rust-cli/shell-permissions.md §2.6）。
//!
//! 后台命令的登记只在这里的账本（会话的 `SessionShell`）里，是唯一事实源；内核不另记任务表。查与
//! 停都在一把锁里完成：命令自己结束与被停止只按拿到锁的先后决定，不靠超时。

use nibi_kernel_api::env::{EnvError, OperationContext};
use nibi_kernel_api::env_shell::{
    BackgroundInfo, BackgroundStatus, BackgroundStop, BackgroundTask,
};
use nibi_kernel_api::ids::OperationId;

use super::{Shells, State};

/// 在跑的、已结束但通知还没 ack 的，或不认识（含已被停止、通知已 ack）。
fn lookup(state: &State, request: &BackgroundTask) -> Option<BackgroundInfo> {
    let shell = state.sessions.get(&request.session)?;
    let command = |operation| {
        state
            .commands
            .get(operation)
            .map(|running| running.command.clone())
    };
    if let Some(operation) = shell.background.get(&request.task) {
        return Some(BackgroundInfo {
            command: command(operation)?,
            status: BackgroundStatus::Running,
        });
    }
    let notice = shell
        .notices
        .iter()
        .find(|notice| notice.task == request.task)?;
    Some(BackgroundInfo {
        command: command(&notice.operation)?,
        status: BackgroundStatus::ended(&notice.outcome, notice.exit_code),
    })
}

/// 任务对应的执行身份：在跑时是登记表里的 operationId，已结束但通知还没 ack 时是那条通知的 operationId。
/// 这是停止请求的 `expectedExecutionId` 比较的对象。
fn task_operation(state: &State, request: &BackgroundTask) -> Option<OperationId> {
    let shell = state.sessions.get(&request.session)?;
    if let Some(operation) = shell.background.get(&request.task) {
        return Some(operation.clone());
    }
    shell
        .notices
        .iter()
        .find(|notice| notice.task == request.task)
        .map(|notice| notice.operation.clone())
}

impl Shells {
    pub(crate) fn background_command(&self, request: &BackgroundTask) -> Option<BackgroundInfo> {
        lookup(&self.shared.state(), request)
    }

    /// 后台命令输出文件的末尾 `max_bytes` 字节（`v4/conversation/backgroundBashOutput`）。
    ///
    /// 任务不认识时 `None`。命令的 `Running` 即使在结束后也留在 `commands` 里（快照与任务列表
    /// 同源），所以终态命令的输出照样读得到。
    pub(crate) async fn background_output(
        &self,
        request: &BackgroundTask,
        max_bytes: u64,
    ) -> Option<nibi_kernel_api::env_shell::BackgroundOutputTail> {
        let operation = {
            let state = self.shared.state();
            let shell = state.sessions.get(&request.session)?;
            shell
                .background
                .get(&request.task)
                .or_else(|| {
                    shell
                        .notices
                        .iter()
                        .find(|notice| notice.task == request.task)
                        .map(|notice| &notice.operation)
                })?
                .clone()
        };
        let output = {
            let state = self.shared.state();
            state.commands.get(&operation)?.output.clone()
        };
        let (bytes, total_bytes) = read_tail(&output, max_bytes).await.ok()?;
        Some(nibi_kernel_api::env_shell::BackgroundOutputTail {
            bytes,
            total_bytes,
            truncated: total_bytes > max_bytes,
            path: nibi_kernel_api::env::EnvPath::new(output.to_string_lossy()),
        })
    }

    /// 还在跑的后台命令从开始到现在的毫秒数；已结束、已停止或不认识时为 None（tui-panels.md §3.3）。
    pub(crate) fn background_elapsed(&self, request: &BackgroundTask) -> Option<u64> {
        let state = self.shared.state();
        let operation = state
            .sessions
            .get(&request.session)?
            .background
            .get(&request.task)?;
        let running = state.commands.get(operation)?;
        Some(u64::try_from(running.started.elapsed().as_millis()).unwrap_or(u64::MAX))
    }

    /// 在跑：移出后台登记、记进 `stopped`（收尾时不记通知）、发出取消；终态照常经回执给出。
    ///
    /// `expected_execution_id` 是调用方认为的这次执行身份（启动命令的 operationId）。对不上时**不停**：
    /// 任务存在但当前执行不是期望的那次（已结束，或任务 ID 被新执行复用）就回 [`BackgroundStop::NotRunning`]
    /// （`status` 是任务此刻的状态，可能是 `Running`）；根本不认识就回 [`BackgroundStop::NotFound`]。
    /// 两者都是“没有在跑”的既有拒绝码，迟到的停止不会杀掉新执行。
    /// `None` 是旧客户端的兼容写法，照旧按任务 ID 停。
    pub(crate) fn stop(
        &self,
        context: &OperationContext,
        request: &BackgroundTask,
        expected_execution_id: Option<&str>,
    ) -> Result<BackgroundStop, EnvError> {
        let mut state = self.shared.state();
        if let Some((known, known_expected, result)) = state.stops.get(&context.operation) {
            return if known == request && known_expected.as_deref() == expected_execution_id {
                Ok(result.clone())
            } else {
                Err(EnvError::OperationConflict {
                    operation: context.operation.clone(),
                })
            };
        }
        let identity_matches = expected_execution_id.is_none_or(|expected| {
            task_operation(&state, request).is_some_and(|operation| operation.as_str() == expected)
        });
        let result = if !identity_matches {
            match lookup(&state, request) {
                // 任务存在，但它的当前执行不是期望的那次：拒绝，且不碰新执行（不清登记、不发取消）。
                // 用与“已经结束”相同的 `NotRunning`；`status` 是任务此刻的状态，可能是 `Running`（新执行在跑）。
                Some(BackgroundInfo { status, .. }) => BackgroundStop::NotRunning { status },
                None => BackgroundStop::NotFound,
            }
        } else {
            match lookup(&state, request) {
                None => BackgroundStop::NotFound,
                Some(BackgroundInfo {
                    command,
                    status: BackgroundStatus::Running,
                }) => {
                    let shell = state.sessions.entry(request.session.clone()).or_default();
                    let operation = shell.background.remove(&request.task);
                    shell.stopped.insert(request.task.clone());
                    if let Some(running) = operation.and_then(|op| state.commands.get(&op)) {
                        running.cancel.cancel();
                    }
                    BackgroundStop::Stopped { command }
                }
                Some(BackgroundInfo { status, .. }) => BackgroundStop::NotRunning { status },
            }
        };
        state.stops.insert(
            context.operation.clone(),
            (
                request.clone(),
                expected_execution_id.map(str::to_owned),
                result.clone(),
            ),
        );
        Ok(result)
    }

    /// 这个会话在跑、能转的前台命令都转到后台（修复线 L-A，tui-input.md §11）：记下原因，监督任务看到后转、看输出的
    /// 一方说明原因。已经在后台的、已结束的、不能转的（hook 命令）不动。同一把锁里判断，与命令自己结束只按先后。
    pub(crate) fn background_foreground(
        &self,
        session: &nibi_kernel_api::ids::SessionId,
        reason: nibi_kernel_api::env::BackgroundReason,
    ) -> Vec<nibi_kernel_api::ids::ShellTaskId> {
        let state = self.shared.state();
        let background = state.sessions.get(session).map(|shell| &shell.background);
        state
            .commands
            .values()
            .filter(|running| {
                running.session == *session
                    && running.movable
                    && running.finished.borrow().is_none()
                    && !*running.backgrounded.borrow()
                    && running.moved_by.borrow().is_none()
                    && !background.is_some_and(|tasks| tasks.contains_key(&running.task))
            })
            .map(|running| {
                running.moved_by.send_replace(Some(reason));
                running.task.clone()
            })
            .collect()
    }
}

/// 文件末尾最多 `max_bytes` 字节与总字节数。读不到（文件已删、权限）时错误。
#[expect(
    clippy::disallowed_methods,
    reason = "env-local 是进程 IO 的入口：后台命令的输出文件在本地（README §4）"
)]
async fn read_tail(path: &std::path::Path, max_bytes: u64) -> std::io::Result<(Vec<u8>, u64)> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut file = tokio::fs::File::open(path).await?;
    let total = file.metadata().await?.len();
    if total > max_bytes {
        let offset = i64::try_from(max_bytes).unwrap_or(i64::MAX);
        file.seek(std::io::SeekFrom::End(-offset)).await?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    Ok((bytes, total))
}

#[cfg(test)]
#[expect(clippy::disallowed_methods, reason = "测试准备输出文件并同步读回")]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;

    use nibi_kernel_api::env::{EnvPath, Origin, Outcome};
    use nibi_kernel_api::env_shell::{BackgroundKind, ShellNotice};
    use nibi_kernel_api::ids::{EnvironmentId, Generation, OwnerEpoch, SessionId, ShellTaskId};
    use tokio::sync::watch as signal;
    use tokio_util::sync::CancellationToken;

    use crate::shell::{Running, ShellConfig};

    fn fixture() -> (tempfile::TempDir, Shells) {
        let dir = tempfile::tempdir().unwrap();
        let shells = Shells::new(ShellConfig {
            scratch: dir.path().join("scratch"),
            ledger: dir.path().join("ledger"),
            ..ShellConfig::default()
        });
        (dir, shells)
    }

    fn context(operation: &str) -> OperationContext {
        OperationContext {
            environment: EnvironmentId::new("local"),
            generation: Generation::new("g"),
            owner_epoch: OwnerEpoch::LOCAL,
            operation: OperationId::new(operation),
            origin: Origin::User {
                session: Some(SessionId::new("s1")),
            },
        }
    }

    fn key(task: &ShellTaskId) -> BackgroundTask {
        BackgroundTask {
            session: SessionId::new("s1"),
            task: task.clone(),
        }
    }

    fn running(task: &ShellTaskId, cancel: &CancellationToken) -> Arc<Running> {
        Arc::new(Running {
            fingerprint: String::new(),
            session: SessionId::new("s1"),
            command: "sleep 9".to_owned(),
            output: PathBuf::from("/tmp/task.output"),
            errors: None,
            events: None,
            cancel: cancel.clone(),
            finished: signal::channel(None).0,
            backgrounded: signal::channel(false).0,
            moved_by: signal::channel(None).0,
            task: task.clone(),
            movable: false,
            started: std::time::Instant::now(),
        })
    }

    /// 登记一条在跑的后台命令（任务 → 启动它的 operationId）。
    fn register(shells: &Shells, operation: &str, task: &ShellTaskId, cancel: &CancellationToken) {
        let mut state = shells.shared.state();
        state
            .commands
            .insert(OperationId::new(operation), running(task, cancel));
        state
            .sessions
            .entry(SessionId::new("s1"))
            .or_default()
            .background
            .insert(task.clone(), OperationId::new(operation));
    }

    fn notice(shells: &Shells, operation: &str, task: &ShellTaskId) {
        let mut state = shells.shared.state();
        // 结束后的命令记录仍留在 `commands` 里（快照与任务列表同源），`lookup` 用它取命令原文与终态。
        let cancel = CancellationToken::new();
        state
            .commands
            .entry(OperationId::new(operation))
            .or_insert_with(|| running(task, &cancel));
        state
            .sessions
            .entry(SessionId::new("s1"))
            .or_default()
            .notices
            .push(ShellNotice {
                seq: 1,
                operation: OperationId::new(operation),
                task: task.clone(),
                tool_use: None,
                description: "done".to_owned(),
                output: EnvPath::new("/tmp/task.output"),
                outcome: Outcome::Completed,
                exit_code: Some(0),
                kind: BackgroundKind::Bash,
                output_bytes: 0,
            });
    }

    /// 期望的身份就是当前执行：照常停掉。
    #[test]
    fn the_matching_expected_execution_id_stops() {
        let (_dir, shells) = fixture();
        let task = ShellTaskId::new("b1");
        let cancel = CancellationToken::new();
        register(&shells, "op_new", &task, &cancel);
        let stop = shells
            .stop(&context("op_stop"), &key(&task), Some("op_new"))
            .unwrap();
        assert_eq!(
            stop,
            BackgroundStop::Stopped {
                command: "sleep 9".to_owned()
            }
        );
        assert!(cancel.is_cancelled());
    }

    /// 旧执行的身份：拒绝（与“没有在跑”同一个错误码），并且不碰同名任务上的新执行
    /// （不清登记、不发取消）。
    #[test]
    fn a_stale_expected_execution_id_does_not_stop_the_new_execution() {
        let (_dir, shells) = fixture();
        let task = ShellTaskId::new("b1");
        let cancel = CancellationToken::new();
        register(&shells, "op_new", &task, &cancel);
        let stale = shells
            .stop(&context("op_stop"), &key(&task), Some("op_old"))
            .unwrap();
        assert_eq!(
            stale,
            BackgroundStop::NotRunning {
                status: BackgroundStatus::Running
            }
        );
        assert!(!cancel.is_cancelled());
        assert!(
            shells.shared.state().sessions[&SessionId::new("s1")]
                .background
                .contains_key(&task)
        );
        // 新执行仍可被正常停止（不带期望身份的老写法）。
        let stop = shells
            .stop(&context("op_stop_2"), &key(&task), None)
            .unwrap();
        assert!(matches!(stop, BackgroundStop::Stopped { .. }));
        assert!(cancel.is_cancelled());
    }

    /// 旧执行的终态通知还没 ack、同名任务已经被新执行复用时：旧身份只拒绝，不杀新执行。
    #[test]
    fn a_stale_id_from_a_finished_execution_does_not_stop_its_successor() {
        let (_dir, shells) = fixture();
        let task = ShellTaskId::new("b1");
        notice(&shells, "op_old", &task);
        let cancel = CancellationToken::new();
        register(&shells, "op_new", &task, &cancel);
        let stale = shells
            .stop(&context("op_stop"), &key(&task), Some("op_old"))
            .unwrap();
        assert_eq!(
            stale,
            BackgroundStop::NotRunning {
                status: BackgroundStatus::Running
            }
        );
        assert!(!cancel.is_cancelled());
        assert!(
            shells.shared.state().sessions[&SessionId::new("s1")]
                .background
                .contains_key(&task)
        );
    }

    /// 根本不认识这个任务：回 NotFound（既有“没有在跑”的另一半）。
    #[test]
    fn a_stop_for_an_unknown_task_is_not_found() {
        let (_dir, shells) = fixture();
        let task = ShellTaskId::new("b404");
        let stop = shells
            .stop(&context("op_stop"), &key(&task), Some("op_old"))
            .unwrap();
        assert_eq!(stop, BackgroundStop::NotFound);
    }

    /// 不带期望身份（老客户端）：照旧按任务 ID 停。
    #[test]
    fn a_stop_without_an_expected_execution_id_is_compatible() {
        let (_dir, shells) = fixture();
        let task = ShellTaskId::new("b1");
        let cancel = CancellationToken::new();
        register(&shells, "op_new", &task, &cancel);
        let stop = shells.stop(&context("op_stop"), &key(&task), None).unwrap();
        assert!(matches!(stop, BackgroundStop::Stopped { .. }));
        assert!(cancel.is_cancelled());
    }

    /// 已终态：回 NotRunning（既有错误码），即使期望身份对得上也不会有可停的执行。
    #[test]
    fn a_terminal_task_is_not_running() {
        let (_dir, shells) = fixture();
        let task = ShellTaskId::new("b1");
        notice(&shells, "op_done", &task);
        let stop = shells
            .stop(&context("op_stop"), &key(&task), Some("op_done"))
            .unwrap();
        assert_eq!(
            stop,
            BackgroundStop::NotRunning {
                status: BackgroundStatus::Completed
            }
        );
    }

    /// 同一个停止 operationId 重放：身份相同返回缓存结果，身份不同按 OperationConflict 拒绝。
    #[test]
    fn a_replayed_stop_with_a_different_expected_id_is_a_conflict() {
        let (_dir, shells) = fixture();
        let task = ShellTaskId::new("b1");
        let cancel = CancellationToken::new();
        register(&shells, "op_new", &task, &cancel);
        let first = shells.stop(&context("op_stop"), &key(&task), None).unwrap();
        assert!(matches!(first, BackgroundStop::Stopped { .. }));
        let replay = shells.stop(&context("op_stop"), &key(&task), None).unwrap();
        assert_eq!(replay, first);
        assert!(matches!(
            shells.stop(&context("op_stop"), &key(&task), Some("op_new")),
            Err(EnvError::OperationConflict { .. })
        ));
    }

    /// 尾窗只回文件末尾的 `max_bytes` 字节，`total_bytes` 仍是整份文件的大小。
    #[tokio::test]
    async fn the_tail_keeps_the_last_bytes_and_reports_the_total() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("task.output");
        tokio::fs::write(&path, b"0123456789").await.unwrap();
        let (bytes, total) = read_tail(&path, 4).await.unwrap();
        assert_eq!(bytes, b"6789");
        assert_eq!(total, 10);
    }

    /// 文件比界短时整份返回，不加填充也不报错。
    #[tokio::test]
    async fn a_short_file_is_returned_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("task.output");
        tokio::fs::write(&path, b"hi").await.unwrap();
        let (bytes, total) = read_tail(&path, 4_096).await.unwrap();
        assert_eq!(bytes, b"hi");
        assert_eq!(total, 2);
    }

    /// 文件不存在时是错误（协议层据此回 `read_failed`）。
    #[tokio::test]
    async fn a_missing_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_tail(&dir.path().join("nope.output"), 16).await.is_err());
    }
}

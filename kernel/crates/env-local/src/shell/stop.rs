//! TaskStop 停后台命令（docs/specs/rust-cli/shell-permissions.md §2.6）。
//!
//! 后台命令的登记只在这里的账本（会话的 `SessionShell`）里，是唯一事实源；内核不另记任务表。查与
//! 停都在一把锁里完成：命令自己结束与被停止只按拿到锁的先后决定，不靠超时。

use nibi_kernel_api::env::{EnvError, OperationContext};
use nibi_kernel_api::env_shell::{
    BackgroundInfo, BackgroundStatus, BackgroundStop, BackgroundTask,
};

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
    pub(crate) fn stop(
        &self,
        context: &OperationContext,
        request: &BackgroundTask,
    ) -> Result<BackgroundStop, EnvError> {
        let mut state = self.shared.state();
        if let Some((known, result)) = state.stops.get(&context.operation) {
            return if known == request {
                Ok(result.clone())
            } else {
                Err(EnvError::OperationConflict {
                    operation: context.operation.clone(),
                })
            };
        }
        let result = match lookup(&state, request) {
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
        };
        state
            .stops
            .insert(context.operation.clone(), (request.clone(), result.clone()));
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
mod tests {
    use super::*;

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

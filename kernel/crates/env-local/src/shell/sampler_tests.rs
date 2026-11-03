//! `process/toolExecResource` 的退出类别与「短命令不发事实」（141 审计 §9 F3）。

use std::sync::Arc;

use rust_cli_kernel_api::env::Outcome;

use super::*;
use crate::shell::{Finish, Running};

fn finish(outcome: Outcome, timed_out: bool) -> Finish {
    Finish {
        outcome,
        exit_code: Some(0),
        timed_out,
        cwd_reset: None,
        output_bytes: 0,
        output_limit: None,
    }
}

/// 四种退出类别与 Node 的映射一致：超时优先于其他；取消算 killed，失败算 error。
#[test]
fn the_exit_kind_matches_the_node_mapping() {
    assert_eq!(
        exit_kind(&finish(Outcome::Completed, false)),
        ToolExitKind::Completed
    );
    assert_eq!(
        exit_kind(&finish(Outcome::Completed, true)),
        ToolExitKind::Timeout
    );
    assert_eq!(
        exit_kind(&finish(Outcome::Cancelled, false)),
        ToolExitKind::Killed
    );
    assert_eq!(
        exit_kind(&finish(Outcome::Interrupted, false)),
        ToolExitKind::Killed
    );
    assert_eq!(
        exit_kind(&finish(
            Outcome::Failed {
                code: Some("wait".to_owned()),
                message: "boom".to_owned()
            },
            false
        )),
        ToolExitKind::Error
    );
}

fn running() -> Arc<Running> {
    use tokio::sync::watch as signal;
    Arc::new(Running {
        fingerprint: "fp".to_owned(),
        session: rust_cli_kernel_api::ids::SessionId::new("s"),
        command: "sleep 1".to_owned(),
        output: std::path::PathBuf::from("/tmp/out"),
        errors: None,
        events: None,
        cancel: tokio_util::sync::CancellationToken::new(),
        finished: signal::channel(None).0,
        backgrounded: signal::channel(false).0,
        moved_by: signal::channel(None).0,
        task: rust_cli_kernel_api::ids::ShellTaskId::new("t"),
        movable: false,
        started: std::time::Instant::now(),
    })
}

/// 任务起来之前命令就结束了、且时长不到 15 秒：一条事实都不发。
#[tokio::test]
async fn a_command_that_ends_before_the_sampler_starts_emits_nothing() {
    let running = running();
    // `send` 在没有接收者时会失败；`send_replace` 直接换掉当前值。
    running
        .finished
        .send_replace(Some(finish(Outcome::Completed, false)));
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    // pid 1 在 Windows 与 Unix 上都不可采（允许失败）；这个测试只关心不发事实。
    tokio::time::timeout(std::time::Duration::from_secs(5), watch(1, running, sender))
        .await
        .expect("the sampler returns instead of waiting for a change");
    assert!(receiver.try_recv().is_err());
}

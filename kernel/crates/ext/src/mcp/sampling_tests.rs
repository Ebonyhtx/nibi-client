//! 采样的额度与终态账本（Node `mcp-ui/samplingCalls.ts`）。

use std::future::pending;

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::mcp_ui::{
    SAMPLING_CANCELLED, SAMPLING_DUPLICATE, SAMPLING_LIMIT, SAMPLING_MAX_OPERATIONS,
    SAMPLING_MAX_PER_SESSION, SAMPLING_TIMED_OUT,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;

fn session() -> SessionId {
    SessionId::new("sess_1")
}

fn success() -> impl FnOnce(CancellationToken) -> std::future::Ready<Result<Value, String>> {
    |_cancel| std::future::ready(Ok(json!({"ok": true})))
}

/// 一次成功采样；结束后同一个 operationId 不能重放。
#[tokio::test]
async fn sampling_tracks_terminal_operations() {
    let calls = SamplingCalls::new();
    let cancel = CancellationToken::new();
    let result = calls
        .execute(&session(), "token-1", &cancel, "op-1", success())
        .await
        .expect("sampled");
    assert_eq!(result, json!({"ok": true}));
    let error = calls
        .execute(&session(), "token-1", &cancel, "op-1", success())
        .await
        .expect_err("duplicate");
    assert_eq!(error.to_string(), SAMPLING_DUPLICATE);
}

/// 同一实例同时只允许一个进行中的采样；别的实例不受影响。
#[tokio::test]
async fn one_active_call_per_instance() {
    let calls = std::sync::Arc::new(SamplingCalls::new());
    let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn({
        let calls = calls.clone();
        async move {
            calls
                .execute(
                    &session(),
                    "token-1",
                    &CancellationToken::new(),
                    "op-1",
                    move |token| async move {
                        let _ = entered.send(());
                        token.cancelled().await;
                        Err::<Value, String>(SAMPLING_CANCELLED.to_owned())
                    },
                )
                .await
        }
    });
    entered_rx.recv().await.expect("entered");
    let busy = calls
        .execute(
            &session(),
            "token-1",
            &CancellationToken::new(),
            "op-2",
            success(),
        )
        .await
        .expect_err("busy");
    assert_eq!(busy.to_string(), "Sampling busy");
    // 另一个实例可以同时采样。
    let other = calls
        .execute(
            &session(),
            "token-2",
            &CancellationToken::new(),
            "op-3",
            success(),
        )
        .await
        .expect("other instance");
    assert_eq!(other, json!({"ok": true}));
    calls.cancel("token-1", "op-1").expect("cancelled");
    let _ = task.await;
}

/// 取消先于采样到达：留下终态，后来的同 operationId 不会执行；取消本身回 false（没有进行中的）。
#[tokio::test]
async fn cancelling_before_arrival_leaves_a_tombstone() {
    let calls = SamplingCalls::new();
    assert!(!calls.cancel("token-1", "op-1").expect("cancel"));
    let error = calls
        .execute(
            &session(),
            "token-1",
            &CancellationToken::new(),
            "op-1",
            success(),
        )
        .await
        .expect_err("duplicate");
    assert_eq!(error.to_string(), SAMPLING_DUPLICATE);
}

/// 进行中的采样被取消：等待方拿到取消错误。
#[tokio::test]
async fn cancelling_a_running_sample_ends_it() {
    let calls = std::sync::Arc::new(SamplingCalls::new());
    let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn({
        let calls = calls.clone();
        async move {
            calls
                .execute(
                    &session(),
                    "token-1",
                    &CancellationToken::new(),
                    "op-1",
                    move |token| async move {
                        let _ = entered.send(());
                        token.cancelled().await;
                        Err::<Value, String>(SAMPLING_CANCELLED.to_owned())
                    },
                )
                .await
        }
    });
    entered_rx.recv().await.expect("entered");
    assert!(
        calls.cancel("token-1", "op-1").expect("cancel"),
        "进行中的调用"
    );
    let error = task.await.unwrap().expect_err("cancelled");
    assert_eq!(error.to_string(), SAMPLING_CANCELLED);
}

/// 60 秒没有结果：超时并留下终态（虚拟时间，不真等）。
#[tokio::test(start_paused = true)]
async fn sampling_times_out() {
    let calls = SamplingCalls::new();
    let error = calls
        .execute(
            &session(),
            "token-1",
            &CancellationToken::new(),
            "op-1",
            |_token| async { pending::<Result<Value, String>>().await },
        )
        .await
        .expect_err("timeout");
    assert_eq!(error.to_string(), SAMPLING_TIMED_OUT);
}

/// 每会话 4 个的额度。
#[tokio::test]
async fn the_session_limit_is_enforced() {
    let calls = std::sync::Arc::new(SamplingCalls::new());
    let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut handles = Vec::new();
    for index in 0..SAMPLING_MAX_PER_SESSION {
        handles.push(tokio::spawn({
            let calls = calls.clone();
            let entered = entered.clone();
            async move {
                calls
                    .execute(
                        &session(),
                        &format!("token-{index}"),
                        &CancellationToken::new(),
                        "op-1",
                        move |token| async move {
                            let _ = entered.send(());
                            token.cancelled().await;
                            Err::<Value, String>(SAMPLING_CANCELLED.to_owned())
                        },
                    )
                    .await
            }
        }));
    }
    for _ in 0..SAMPLING_MAX_PER_SESSION {
        entered_rx.recv().await.expect("entered");
    }
    let error = calls
        .execute(
            &session(),
            "token-extra",
            &CancellationToken::new(),
            "op-extra",
            success(),
        )
        .await
        .expect_err("session busy");
    assert_eq!(error.to_string(), "Sampling busy");
    for index in 0..SAMPLING_MAX_PER_SESSION {
        calls
            .cancel(&format!("token-{index}"), "op-1")
            .expect("cancelled");
    }
    for handle in handles {
        let _ = handle.await;
    }
}

/// 实例账本 4096 条上限与实例清理。
#[tokio::test]
async fn the_ledger_limit_and_instance_clear() {
    let calls = SamplingCalls::new();
    for index in 0..SAMPLING_MAX_OPERATIONS {
        let _ = calls.cancel("token-1", &format!("op-{index}"));
    }
    let error = calls.cancel("token-1", "op-extra").expect_err("limit");
    assert_eq!(error.to_string(), SAMPLING_LIMIT);
    calls.clear_instance("token-1");
    assert!(
        !calls.cancel("token-1", "op-0").expect("cleared"),
        "账本已清"
    );
}

//! MCP Apps 采样（`mcp/uiSampling`，Node `mcp-ui/samplingCalls.ts`）。
//!
//! 终态账本与并发额度的唯一 owner：同一个 `operationId` 不能重放（结束后留一个 tombstone），
//! 每个实例同时只允许一个进行中的采样，全局 8、每会话 4、每实例账本 4096 条；单次 60 秒。
//! 取消先于采样到达时也留终态——旧请求之后到达不会执行。

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_ui::{
    McpUiError, SAMPLING_CANCELLED, SAMPLING_MAX_OPERATIONS, SAMPLING_MAX_PER_AGENT,
    SAMPLING_MAX_PER_SESSION, SAMPLING_TIMEOUT_MS,
};
use tokio_util::sync::CancellationToken;

/// 每个实例的账本：operationId → 进行中的取消令牌（`None` 是已结束的 tombstone）。
type Ledger = BTreeMap<String, Option<CancellationToken>>;

#[derive(Default)]
struct State {
    instances: BTreeMap<String, Ledger>,
    sessions: BTreeMap<String, usize>,
    active: usize,
}

pub(crate) struct SamplingCalls {
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl SamplingCalls {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
        }
    }

    /// 执行一次采样：额度与去重在这里，模型请求在 `run` 里；实例关闭、协议取消与 60 秒超时
    /// 都会结束它。
    pub(crate) async fn execute<T, F, Fut>(
        &self,
        session: &SessionId,
        instance: &str,
        instance_cancel: &CancellationToken,
        operation_id: &str,
        run: F,
    ) -> Result<T, McpUiError>
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        let token = {
            let mut state = lock(&self.state);
            let active = state.active;
            let session_count = state.sessions.get(session.as_str()).copied().unwrap_or(0);
            let calls = state.instances.entry(instance.to_owned()).or_default();
            if calls.contains_key(operation_id) {
                return Err(McpUiError::SamplingDuplicate);
            }
            if calls.len() >= SAMPLING_MAX_OPERATIONS {
                return Err(McpUiError::SamplingLimit);
            }
            let busy = active >= SAMPLING_MAX_PER_AGENT
                || session_count >= SAMPLING_MAX_PER_SESSION
                || calls.values().any(Option::is_some);
            if busy {
                return Err(McpUiError::SamplingBusy);
            }
            let token = CancellationToken::new();
            calls.insert(operation_id.to_owned(), Some(token.clone()));
            state.active += 1;
            *state
                .sessions
                .entry(session.as_str().to_owned())
                .or_insert(0) += 1;
            token
        };
        let outcome = tokio::select! {
            _ = instance_cancel.cancelled() => Err(McpUiError::SamplingCancelled),
            _ = token.cancelled() => Err(McpUiError::SamplingCancelled),
            result = tokio::time::timeout(
                Duration::from_millis(SAMPLING_TIMEOUT_MS),
                run(token.clone()),
            ) => match result {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(message)) if message == SAMPLING_CANCELLED => {
                    Err(McpUiError::SamplingCancelled)
                }
                Ok(Err(message)) => Err(McpUiError::failed(message)),
                Err(_) => {
                    token.cancel();
                    Err(McpUiError::SamplingTimedOut)
                }
            },
        };
        self.finish(session, instance, operation_id, instance_cancel);
        outcome
    }

    /// 取消一次采样；没有进行中的调用时回 `false`（幂等），并留下终态。
    pub(crate) fn cancel(&self, instance: &str, operation_id: &str) -> Result<bool, McpUiError> {
        let mut state = lock(&self.state);
        let calls = state.instances.entry(instance.to_owned()).or_default();
        if !calls.contains_key(operation_id) && calls.len() >= SAMPLING_MAX_OPERATIONS {
            return Err(McpUiError::SamplingLimit);
        }
        match calls.insert(operation_id.to_owned(), None) {
            Some(Some(token)) => {
                token.cancel();
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// 实例的凭证终结：取消它的全部进行中采样并丢掉账本（Node 的实例作用域 signal）。
    pub(crate) fn clear_instance(&self, instance: &str) {
        let mut state = lock(&self.state);
        if let Some(calls) = state.instances.remove(instance) {
            for token in calls.into_values().flatten() {
                token.cancel();
            }
        }
    }

    fn finish(
        &self,
        session: &SessionId,
        instance: &str,
        operation_id: &str,
        instance_cancel: &CancellationToken,
    ) {
        let mut state = lock(&self.state);
        state.active = state.active.saturating_sub(1);
        let count = state
            .sessions
            .get(session.as_str())
            .copied()
            .unwrap_or(1)
            .saturating_sub(1);
        if count > 0 {
            state.sessions.insert(session.as_str().to_owned(), count);
        } else {
            state.sessions.remove(session.as_str());
        }
        if let Some(calls) = state.instances.get_mut(instance)
            && calls.contains_key(operation_id)
        {
            // 迟到清理不重新创建已被 close 删除的实例账本。
            calls.insert(operation_id.to_owned(), None);
        }
        if instance_cancel.is_cancelled() {
            state.instances.remove(instance);
        }
    }
}

#[cfg(test)]
#[path = "sampling_tests.rs"]
mod tests;

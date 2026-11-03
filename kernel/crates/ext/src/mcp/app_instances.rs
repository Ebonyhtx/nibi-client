//! MCP Apps 的实例凭证（Node `mcp-ui/instances.ts`，141 审计 §9 第 6 项）。
//!
//! 单一凭证 owner：Agent `runtimeId`、单调 `generation`、不可猜 `token`、稳定 `appIdentity`。
//! 绑定工作区身份、会话、插件、服务器、资源、沙箱作用域与窗口归属，以及 Host 给的账号上下文。
//!
//! 规则逐条照 Node：
//!
//! - 同一个逻辑页面（绑定键相同）在同一个连接代际上并发 open 是幂等的：返回同一个凭证。
//! - 连接换了代际（或配置/账号上下文变了）：旧实例先关（取消令牌），再发新凭证。
//! - `validate` 先比凭证四元组与作用域，再比**当前**连接快照与开实例时的那一对；对不上就关掉它并
//!   拒绝——错 server / 旧代际的请求不能关闭一个合法页面。
//! - `close` 先从登记表移除，再取消令牌；迟到的结果拿不回执行权。
//! - 进行中的调用（工具调用与采样）用 [`Retain`] 占住实例；`onlyIfIdle` 看它。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rust_cli_kernel_api::mcp_ui::{
    McpAppConnection, McpAppInstance, McpUiError, McpUiInstanceRequest, McpUiOpenRequest,
};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

/// 一个实例绑定的全部身份（Node `McpUiInstanceBinding`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Binding {
    pub workspace: String,
    pub account_context: Option<String>,
    pub session: String,
    pub plugin_id: String,
    pub server: String,
    pub scope_id: String,
    pub resource_uri: String,
    pub owner_web_contents_id: i64,
}

impl Binding {
    fn key(&self) -> String {
        // 与 Node 的 JSON.stringify([...]) 同一条键；分隔符用 NUL 以免名字里出现同样的串。
        [
            self.workspace.as_str(),
            self.session.as_str(),
            self.plugin_id.as_str(),
            self.server.as_str(),
            self.scope_id.as_str(),
            self.resource_uri.as_str(),
            &self.owner_web_contents_id.to_string(),
        ]
        .join("\u{0}")
    }
}

struct Record {
    lease: McpAppInstance,
    binding: Binding,
    source: McpAppConnection,
    cancel: CancellationToken,
    pins: usize,
}

pub(crate) struct McpAppInstances {
    runtime_id: String,
    generation: Mutex<u64>,
    records: Mutex<BTreeMap<String, Record>>,
    logical: Mutex<BTreeMap<String, String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl McpAppInstances {
    pub(crate) fn new(runtime_id: String) -> Self {
        Self {
            runtime_id,
            generation: Mutex::new(0),
            records: Mutex::new(BTreeMap::new()),
            logical: Mutex::new(BTreeMap::new()),
        }
    }

    /// 开实例（同一逻辑页面同连接代际幂等）。
    pub(crate) fn open(
        &self,
        request: McpUiOpenRequest,
        source: McpAppConnection,
    ) -> McpAppInstance {
        let binding = Binding {
            workspace: request.scope.workspace_identity.clone(),
            account_context: request.account_context.clone(),
            session: request.scope.session.as_str().to_owned(),
            plugin_id: request.scope.plugin_id.clone(),
            server: request.scope.server_name.clone(),
            scope_id: request.scope_id.clone(),
            resource_uri: request.resource_uri.clone(),
            owner_web_contents_id: request.owner_web_contents_id,
        };
        let key = binding.key();
        let previous = lock(&self.logical).get(&key).cloned();
        if let Some(token) = previous {
            let existing = lock(&self.records).get(&token).map(|record| {
                (
                    record.lease.clone(),
                    record.source.clone(),
                    record.binding.account_context.clone(),
                )
            });
            if let Some((lease, bound, account)) = existing {
                if bound == source && account == binding.account_context {
                    return lease;
                }
                self.close(&lease);
            }
        }
        let generation = {
            let mut generation = lock(&self.generation);
            *generation += 1;
            *generation
        };
        let lease = McpAppInstance {
            runtime_id: self.runtime_id.clone(),
            generation,
            token: rust_cli_kernel_api::process_table::uuid_v4(),
            app_identity: app_identity(&binding, &source),
        };
        lock(&self.records).insert(
            lease.token.clone(),
            Record {
                lease: lease.clone(),
                binding,
                source,
                cancel: CancellationToken::new(),
                pins: 0,
            },
        );
        lock(&self.logical).insert(key, lease.token.clone());
        lease
    }

    /// 校验凭证、作用域与当前连接；返回实例绑定的资源 URI。
    pub(crate) fn validate(
        &self,
        request: &McpUiInstanceRequest,
        current: Option<McpAppConnection>,
    ) -> Result<String, McpUiError> {
        let (bound, resource_uri) = self.check(request)?;
        // 先确认请求确属本实例，再用当前连接快照判定；对不上就撤销凭证（迟到的请求不能继续用）。
        if current.as_ref() != Some(&bound) {
            self.close(&request.instance);
            return Err(McpUiError::not_authorized());
        }
        Ok(resource_uri)
    }

    /// 只校验凭证与作用域（`close` 用它：关一个实例不该受当前连接影响）。
    pub(crate) fn validate_bound(
        &self,
        request: &McpUiInstanceRequest,
    ) -> Result<(), McpUiError> {
        self.check(request).map(|_| ())
    }

    fn check(
        &self,
        request: &McpUiInstanceRequest,
    ) -> Result<(McpAppConnection, String), McpUiError> {
        let lease = &request.instance;
        let records = lock(&self.records);
        let Some(record) = records.get(&lease.token) else {
            return Err(McpUiError::not_authorized());
        };
        let matches = record.lease.runtime_id == lease.runtime_id
            && record.lease.generation == lease.generation
            && record.lease.app_identity == lease.app_identity
            && record.binding.workspace == request.scope.workspace_identity
            && record.binding.session == request.scope.session.as_str()
            && record.binding.plugin_id == request.scope.plugin_id
            && record.binding.server == request.scope.server_name;
        if !matches {
            return Err(McpUiError::not_authorized());
        }
        Ok((record.source.clone(), record.binding.resource_uri.clone()))
    }

    /// 关实例：先移除登记，再取消令牌；凭证对不上时什么都不做。
    pub(crate) fn close(&self, lease: &McpAppInstance) -> bool {
        let record = {
            let mut records = lock(&self.records);
            let Some(record) = records.get(&lease.token) else {
                return false;
            };
            if record.lease.runtime_id != lease.runtime_id
                || record.lease.generation != lease.generation
                || record.lease.app_identity != lease.app_identity
            {
                return false;
            }
            records.remove(&lease.token)
        };
        let Some(record) = record else {
            return false;
        };
        let key = record.binding.key();
        let mut logical = lock(&self.logical);
        if logical.get(&key) == Some(&lease.token) {
            logical.remove(&key);
        }
        drop(logical);
        record.cancel.cancel();
        true
    }

    /// 会话关闭：它的全部实例作废（Node `closeSession`）。
    pub(crate) fn close_session(&self, session: &str) {
        let leases: Vec<McpAppInstance> = lock(&self.records)
            .values()
            .filter(|record| record.binding.session == session)
            .map(|record| record.lease.clone())
            .collect();
        for lease in leases {
            self.close(&lease);
        }
    }

    /// 有没有这个 token 的记录（`close` 用它区分「已经关了」与「凭证不对」）。
    pub(crate) fn is_known(&self, token: &str) -> bool {
        lock(&self.records).contains_key(token)
    }

    /// 有没有进行中的调用（`onlyIfIdle`）。
    pub(crate) fn is_busy(&self, lease: &McpAppInstance) -> bool {
        lock(&self.records)
            .get(&lease.token)
            .is_some_and(|record| record.pins > 0)
    }

    /// 占住实例（工具调用、采样）：拿到取消令牌与一个离开作用域就释放的占位。
    ///
    /// 切片 2 还没有调用方（`mcp/uiCallTool` 与采样在切片 3）；测试已经用上，先留接口。
    #[allow(dead_code, reason = "切片 3 的 uiCallTool / sampling 使用")]
    pub(crate) fn retain(self: &Arc<Self>, token: &str) -> Option<(CancellationToken, Retain)> {
        let mut records = lock(&self.records);
        let record = records.get_mut(token)?;
        record.pins += 1;
        let signal = record.cancel.clone();
        Some((
            signal,
            Retain {
                registry: self.clone(),
                token: token.to_owned(),
            },
        ))
    }

    fn release(&self, token: &str) {
        if let Some(record) = lock(&self.records).get_mut(token) {
            record.pins = record.pins.saturating_sub(1);
        }
    }

    /// 实例的取消令牌（关实例时触发）。
    #[allow(dead_code, reason = "切片 3 的 uiCallTool / sampling 使用")]
    pub(crate) fn cancellation(&self, token: &str) -> Option<CancellationToken> {
        lock(&self.records)
            .get(token)
            .map(|record| record.cancel.clone())
    }
}

/// 一次占用；离开作用域时自动释放。
#[allow(dead_code, reason = "切片 3 的 uiCallTool / sampling 使用")]
pub(crate) struct Retain {
    registry: Arc<McpAppInstances>,
    token: String,
}

impl Drop for Retain {
    fn drop(&mut self) {
        self.registry.release(&self.token);
    }
}

/// 稳定应用身份：工作区身份、服务器、连接身份与账号上下文的摘要。
fn app_identity(binding: &Binding, source: &McpAppConnection) -> String {
    let input = format!(
        "{}\u{1e}{}\u{1e}{}\u{1e}{}",
        binding.workspace,
        binding.server,
        source.identity,
        binding.account_context.as_deref().unwrap_or("")
    );
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
#[path = "app_instances_tests.rs"]
mod tests;

//! App-Provided Tools（Node `mcp-ui/appTools.ts` + `core/src/mcp/app-tools.ts`）。
//!
//! 页面在 `ui/initialize` 声明 tools 能力后把工具登记给模型（`app__<server>__<tool>`）；模型调用不直接
//! 执行，而是经**实例信箱**投递一次待执行调用（live-only 的 `pluginUi.appToolCall`），渲染端认领
//! （`claim`）后页面执行 `tools/call`，结果经 `resolve` 回传。登记表只在内存，会话关闭即清空。
//!
//! 时限（Node 同值）：认领 5 秒（超时视为页面未运行，并注销该实例）、认领后执行 30 秒；参数上限
//! 1 MiB、结果上限 10 MiB，超限直接以错误结束。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_kernel_api::clock::Ids;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_ui::{
    APP_TOOL_ARGUMENTS_MAX_BYTES, APP_TOOL_CALL_TIMEOUT_MS, APP_TOOL_CLAIM_TIMEOUT_MS,
    APP_TOOL_RESULT_MAX_BYTES, McpAppInstance, McpUiAppToolDescriptor, McpUiAppToolRegistration,
    McpUiEvent, McpUiRegisterAppToolsRequest, McpUiSubscriber, app_tool_model_name, json_bytes,
};
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext,
};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use super::result;

/// 模型侧结果的 token 上限（Node 的 `maxModelBytes: 50_000`，按 4 字节一个 token 估算）。
const MAX_RESULT_TOKENS: u64 = 12_500;

/// 一个已登记的页面实例。
struct InstanceRecord {
    credential: McpAppInstance,
    scope_id: String,
    generation: u64,
    plugin_id: String,
    server_name: String,
    /// 首次登记序号：同 server 只暴露序号最大的实例；重新登记不变。
    seq: u64,
    tools: Vec<McpUiAppToolDescriptor>,
}

/// 一次待执行的调用：认领信号与结果通道。
struct PendingCall {
    instance_key: String,
    tool_name: String,
    claimed: watch::Sender<bool>,
    outcome: Option<oneshot::Sender<Result<Value, String>>>,
}

struct SessionState {
    instances: BTreeMap<String, InstanceRecord>,
    /// 第一个实例的序号是 1（Node `nextSeq: 1`）。
    next_seq: u64,
    pending: BTreeMap<String, PendingCall>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            instances: BTreeMap::new(),
            next_seq: 1,
            pending: BTreeMap::new(),
        }
    }
}

/// 曝光的一条定义（某个实例的某个工具）。
struct Exposed<'a> {
    record: &'a InstanceRecord,
    tool: &'a McpUiAppToolDescriptor,
    model_name: String,
}

/// 投递目标（信箱要的实例身份）。
#[derive(Clone)]
struct Target {
    plugin_id: String,
    server_name: String,
    scope_id: String,
    generation: u64,
    credential: McpAppInstance,
}

pub(crate) struct AppToolRegistry {
    ids: Arc<dyn Ids>,
    events: Option<tokio::sync::mpsc::UnboundedSender<McpUiEvent>>,
    sessions: Mutex<BTreeMap<String, SessionState>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 实例键 = 沙箱作用域 + 代际（Node `buildMcpUiAppToolInstanceKey`）。
fn instance_key(scope_id: &str, generation: u64) -> String {
    format!("{scope_id}|{generation}")
}

fn not_running(server: &str) -> ToolError {
    ToolError::Failed {
        message: format!("The {server} app page is not running"),
    }
}

/// 结果通道的一次结果（页面回传、卸载、会话关闭都走这里）。
fn finished(
    settled: Result<Result<Value, String>, oneshot::error::RecvError>,
    server: &str,
) -> Result<Value, ToolError> {
    match settled {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => Err(ToolError::Failed { message }),
        Err(_) => Err(ToolError::Failed {
            message: format!("The {server} app page did not return a result"),
        }),
    }
}

/// 执行端要的定义快照（`AppTool` 持有，调用时克隆）。
#[derive(Clone)]
struct AppToolCallContext {
    session: SessionId,
    scope_id: String,
    generation: u64,
    server_name: String,
    tool_name: String,
}

impl AppToolRegistry {
    pub(crate) fn new(
        ids: Arc<dyn Ids>,
        events: Option<tokio::sync::mpsc::UnboundedSender<McpUiEvent>>,
    ) -> Self {
        Self {
            ids,
            events,
            sessions: Mutex::new(BTreeMap::new()),
        }
    }

    /// 登记一个实例的工具（同作用域的新代际替换旧代际）；返回这个实例被曝光的那部分。
    pub(crate) fn register(
        &self,
        session: &SessionId,
        request: McpUiRegisterAppToolsRequest,
    ) -> Vec<McpUiAppToolRegistration> {
        let key = instance_key(&request.scope_id, request.generation);
        let mut sessions = lock(&self.sessions);
        let state = sessions.entry(session.as_str().to_owned()).or_default();
        let stale: Vec<String> = state
            .instances
            .iter()
            .filter(|(existing, record)| **existing != key && record.scope_id == request.scope_id)
            .map(|(existing, _)| existing.clone())
            .collect();
        for stale_key in stale {
            Self::drop_instance_locked(state, &stale_key, "App page was reloaded", session, self);
        }
        let seq = match state.instances.get(&key) {
            Some(record) => record.seq,
            None => {
                let seq = state.next_seq;
                state.next_seq += 1;
                seq
            }
        };
        let record = InstanceRecord {
            credential: request.instance.instance.clone(),
            scope_id: request.scope_id.clone(),
            generation: request.generation,
            plugin_id: request.instance.scope.plugin_id.clone(),
            server_name: request.instance.scope.server_name.clone(),
            seq,
            tools: request.tools,
        };
        state.instances.insert(key, record);
        Self::exposed(state)
            .into_iter()
            .filter(|exposed| {
                exposed.record.scope_id == request.scope_id
                    && exposed.record.generation == request.generation
            })
            .map(|exposed| McpUiAppToolRegistration {
                name: exposed.tool.name.clone(),
                model_name: exposed.model_name,
            })
            .collect()
    }

    /// 收回一个实例的工具；返回它登记时声明的工具数（Node 的 `removed`）。
    pub(crate) fn unregister(&self, session: &SessionId, scope_id: &str, generation: u64) -> usize {
        let key = instance_key(scope_id, generation);
        let mut sessions = lock(&self.sessions);
        let Some(state) = sessions.get_mut(session.as_str()) else {
            return 0;
        };
        let Some(record) = state.instances.get(&key) else {
            return 0;
        };
        let removed = record.tools.len();
        Self::drop_instance_locked(state, &key, "App page was closed", session, self);
        removed
    }

    /// 渲染端认领一次待执行调用：同一实例重放仍回 true，不重置执行计时。
    pub(crate) fn claim(
        &self,
        session: &SessionId,
        scope_id: &str,
        generation: u64,
        call_id: &str,
    ) -> bool {
        let key = instance_key(scope_id, generation);
        let sessions = lock(&self.sessions);
        let Some(state) = sessions.get(session.as_str()) else {
            return false;
        };
        let Some(pending) = state.pending.get(call_id) else {
            return false;
        };
        if pending.instance_key != key {
            return false;
        }
        if *pending.claimed.borrow() {
            return true;
        }
        pending.claimed.send_replace(true);
        true
    }

    /// 页面回传结果或错误；只有已认领且实例对得上的待执行调用能解决。
    pub(crate) fn resolve(
        &self,
        session: &SessionId,
        scope_id: &str,
        generation: u64,
        call_id: &str,
        result: Result<Value, String>,
    ) -> bool {
        let key = instance_key(scope_id, generation);
        let (pending, target) = {
            let mut sessions = lock(&self.sessions);
            let Some(state) = sessions.get_mut(session.as_str()) else {
                return false;
            };
            let Some(pending) = state.pending.get(call_id) else {
                return false;
            };
            if pending.instance_key != key || !*pending.claimed.borrow() {
                return false;
            }
            let target = state.instances.get(&key).map(Self::target_of);
            (state.pending.remove(call_id), target)
        };
        let Some(mut pending) = pending else {
            return false;
        };
        let outcome = match result {
            Ok(value) if json_bytes(&value) > APP_TOOL_RESULT_MAX_BYTES => Err(format!(
                "App tool result exceeds {APP_TOOL_RESULT_MAX_BYTES} bytes"
            )),
            other => other,
        };
        let failed = outcome.is_err();
        if let Some(sender) = pending.outcome.take() {
            let _ = sender.send(outcome);
        }
        if failed && let Some(target) = target {
            // 页面按 cancelled 通知清理（Node `settle` 的错误分支同形）。
            self.publish(
                session,
                &target,
                call_id.to_owned(),
                &pending.tool_name,
                Map::new(),
                true,
            );
        }
        true
    }

    /// 会话关闭：结束全部待执行调用并丢弃登记（Node `clearSession`）。
    pub(crate) fn clear_session(&self, session: &SessionId) {
        let mut sessions = lock(&self.sessions);
        let Some(mut state) = sessions.remove(session.as_str()) else {
            return;
        };
        for (_, pending) in std::mem::take(&mut state.pending) {
            if let Some(sender) = pending.outcome {
                let _ = sender.send(Err("Session was closed".to_owned()));
            }
        }
    }

    /// 这个会话当前暴露给模型的工具（同 server 只取最近登记的实例，模型名去重）。
    pub(crate) fn tools_for(self: &Arc<Self>, session: &SessionId) -> Vec<Arc<dyn Tool>> {
        let sessions = lock(&self.sessions);
        let Some(state) = sessions.get(session.as_str()) else {
            return Vec::new();
        };
        Self::exposed(state)
            .into_iter()
            .map(|exposed| {
                Arc::new(AppTool {
                    registry: Arc::downgrade(self),
                    call: AppToolCallContext {
                        session: session.clone(),
                        scope_id: exposed.record.scope_id.clone(),
                        generation: exposed.record.generation,
                        server_name: exposed.record.server_name.clone(),
                        tool_name: exposed.tool.name.clone(),
                    },
                    plugin_id: exposed.record.plugin_id.clone(),
                    model_name: exposed.model_name,
                    description: description_of(exposed.record, exposed.tool),
                    input_schema: normalize_schema(&exposed.tool.input_schema),
                    read_only: read_only(exposed.tool),
                    concurrency_safe: read_only(exposed.tool)
                        || exposed
                            .tool
                            .annotations
                            .as_ref()
                            .and_then(|annotations| annotations.idempotent_hint)
                            == Some(true),
                }) as Arc<dyn Tool>
            })
            .collect()
    }

    pub(crate) fn find(self: &Arc<Self>, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools_for(session)
            .into_iter()
            .find(|tool| tool.name() == name)
    }

    /// 计算曝光集合：每个 server 只取序号最大的实例，再按模型名去重（按 server 名字排序）。
    fn exposed(state: &SessionState) -> Vec<Exposed<'_>> {
        let mut latest: BTreeMap<&str, &InstanceRecord> = BTreeMap::new();
        for record in state.instances.values() {
            match latest.get(record.server_name.as_str()) {
                Some(current) if current.seq >= record.seq => {}
                _ => {
                    latest.insert(record.server_name.as_str(), record);
                }
            }
        }
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for record in latest.values() {
            for tool in &record.tools {
                let model_name = app_tool_model_name(&record.server_name, &tool.name);
                if !seen.insert(model_name.clone()) {
                    continue;
                }
                out.push(Exposed {
                    record,
                    tool,
                    model_name,
                });
            }
        }
        out
    }

    fn target_of(record: &InstanceRecord) -> Target {
        Target {
            plugin_id: record.plugin_id.clone(),
            server_name: record.server_name.clone(),
            scope_id: record.scope_id.clone(),
            generation: record.generation,
            credential: record.credential.clone(),
        }
    }

    /// 移除一个实例并结束它的待执行调用（Node `dropInstance`）。
    fn drop_instance_locked(
        state: &mut SessionState,
        key: &str,
        reason: &str,
        session: &SessionId,
        registry: &AppToolRegistry,
    ) {
        let Some(record) = state.instances.remove(key) else {
            return;
        };
        let target = Self::target_of(&record);
        let calls: Vec<String> = state
            .pending
            .iter()
            .filter(|(_, pending)| pending.instance_key == key)
            .map(|(call_id, _)| call_id.clone())
            .collect();
        for call_id in calls {
            if let Some(mut pending) = state.pending.remove(&call_id) {
                if let Some(sender) = pending.outcome.take() {
                    let _ = sender.send(Err(reason.to_owned()));
                }
                registry.publish(
                    session,
                    &target,
                    call_id,
                    &pending.tool_name,
                    Map::new(),
                    true,
                );
            }
        }
    }

    /// 一次待执行调用的执行端（模型的 `tools/call` → 信箱 → 认领 → 结果）。
    async fn execute(
        self: Arc<Self>,
        definition: AppToolCallContext,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        if json_bytes(&input) > APP_TOOL_ARGUMENTS_MAX_BYTES {
            return Err(ToolError::Failed {
                message: "App tool arguments are too large".to_owned(),
            });
        }
        if cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let session = definition.session.clone();
        let key = instance_key(&definition.scope_id, definition.generation);
        let server = definition.server_name.clone();
        let call_id = self.ids.uuid();
        let (claimed, mut claimed_rx) = watch::channel(false);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let target = {
            let mut sessions = lock(&self.sessions);
            let Some(state) = sessions.get_mut(session.as_str()) else {
                return Err(not_running(&server));
            };
            let Some(record) = state.instances.get(&key) else {
                return Err(not_running(&server));
            };
            let target = Self::target_of(record);
            state.pending.insert(
                call_id.clone(),
                PendingCall {
                    instance_key: key.clone(),
                    tool_name: definition.tool_name.clone(),
                    claimed,
                    outcome: Some(outcome_tx),
                },
            );
            target
        };
        let arguments: Map<String, Value> = match input {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        self.publish(
            &session,
            &target,
            call_id.clone(),
            &definition.tool_name,
            arguments,
            false,
        );
        let mut outcome_rx = outcome_rx;
        // 认领期限：没有渲染端认领视为页面未运行，注销该实例（Node 同一条）。认领期间也可能被
        // 直接结束（页面卸载、会话关闭、调用方取消）：那时 outcome 通道先到，原样返回。
        let mut early: Option<Result<Result<Value, String>, oneshot::error::RecvError>> = None;
        let claimed = tokio::select! {
            _ = cancel.cancelled() => false,
            settled = &mut outcome_rx => {
                early = Some(settled);
                true
            }
            waited = tokio::time::timeout(
                Duration::from_millis(APP_TOOL_CLAIM_TIMEOUT_MS),
                claimed_rx.changed(),
            ) => matches!(waited, Ok(Ok(()))),
        };
        if let Some(settled) = early {
            return finished(settled, &server);
        }
        // 认领信号先结束（实例被卸载、会话关闭：watch 的发送端随待执行调用一起丢下）时，结果
        // 可能已经排在通道里；先取它，不要误判成认领超时。
        if let Ok(settled) = outcome_rx.try_recv() {
            return finished(Ok(settled), &server);
        }
        if !claimed {
            if cancel.is_cancelled() {
                self.fail_call(&session, &call_id, &target, "App tool call was cancelled");
                return Err(ToolError::Cancelled);
            }
            let message = format!("The {server} app page is not running");
            self.fail_call(&session, &call_id, &target, &message);
            self.drop_instance(&session, &key, &message);
            return Err(not_running(&server));
        }
        // 认领之后：页面执行 tools/call 的期限。
        let waited = tokio::select! {
            _ = cancel.cancelled() => None,
            outcome = tokio::time::timeout(
                Duration::from_millis(APP_TOOL_CALL_TIMEOUT_MS),
                outcome_rx,
            ) => Some(outcome),
        };
        match waited {
            None => {
                self.fail_call(&session, &call_id, &target, "App tool call was cancelled");
                Err(ToolError::Cancelled)
            }
            Some(Ok(settled)) => finished(settled, &server),
            Some(Err(_)) => {
                let message = format!(
                    "App tool {} timed out after {APP_TOOL_CALL_TIMEOUT_MS} ms",
                    definition.tool_name
                );
                self.fail_call(&session, &call_id, &target, &message);
                Err(ToolError::Failed { message })
            }
        }
    }

    /// 结束一次待执行调用（错误 + 信箱里的 cancelled 通知）；已经解决时什么都不做。
    fn fail_call(&self, session: &SessionId, call_id: &str, target: &Target, message: &str) {
        let pending = lock(&self.sessions)
            .get_mut(session.as_str())
            .and_then(|state| state.pending.remove(call_id));
        let Some(mut pending) = pending else {
            return;
        };
        if let Some(sender) = pending.outcome.take() {
            let _ = sender.send(Err(message.to_owned()));
        }
        self.publish(
            session,
            target,
            call_id.to_owned(),
            &pending.tool_name,
            Map::new(),
            true,
        );
    }

    fn drop_instance(&self, session: &SessionId, key: &str, reason: &str) {
        let mut sessions = lock(&self.sessions);
        let Some(state) = sessions.get_mut(session.as_str()) else {
            return;
        };
        Self::drop_instance_locked(state, key, reason, session, self);
    }

    fn publish(
        &self,
        session: &SessionId,
        target: &Target,
        call_id: String,
        tool_name: &str,
        arguments: Map<String, Value>,
        cancelled: bool,
    ) {
        let Some(events) = &self.events else {
            return;
        };
        let _ = events.send(McpUiEvent::AppToolCall {
            session: session.clone(),
            plugin_id: target.plugin_id.clone(),
            server: target.server_name.clone(),
            subscribers: vec![McpUiSubscriber {
                scope_id: target.scope_id.clone(),
                generation: target.generation,
                instance: target.credential.clone(),
            }],
            call_id,
            tool_name: tool_name.to_owned(),
            arguments,
            cancelled,
        });
    }
}

/// 一个暴露给模型的 App 工具（Node `createMcpAppProvidedToolEntry`）。
struct AppTool {
    registry: Weak<AppToolRegistry>,
    call: AppToolCallContext,
    plugin_id: String,
    model_name: String,
    description: String,
    input_schema: Value,
    read_only: bool,
    concurrency_safe: bool,
}

fn read_only(tool: &McpUiAppToolDescriptor) -> bool {
    tool.annotations
        .as_ref()
        .and_then(|annotations| annotations.read_only_hint)
        == Some(true)
}

fn description_of(record: &InstanceRecord, tool: &McpUiAppToolDescriptor) -> String {
    let title = tool
        .title
        .as_deref()
        .filter(|title| *title != tool.name.as_str());
    let source = format!("the {} app page", record.server_name);
    [
        title,
        tool.description.as_deref(),
        Some(
            &format!("(Tool provided by {source}; available only while the app is open.)") as &str,
        ),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n")
}

/// 发给模型的 schema 必须是对象（Node `normalizeObjectSchema`）。
fn normalize_schema(schema: &Value) -> Value {
    let mut normalized = match schema {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    normalized.insert("type".to_owned(), json!("object"));
    let properties = normalized
        .get("properties")
        .filter(|properties| properties.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    normalized.insert("properties".to_owned(), properties);
    Value::Object(normalized)
}

#[async_trait]
impl Tool for AppTool {
    fn name(&self) -> &str {
        &self.model_name
    }

    fn input_schema(&self) -> Value {
        self.input_schema.clone()
    }

    fn description(&self, _context: &PromptContext) -> String {
        self.description.clone()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        self.read_only
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        self.concurrency_safe
    }

    /// 只读自动放行，其余询问；页面是不可信的沙箱代码，「总是允许」不提供（模型侧名字跨会话会被
    /// 别的页面复用，Node 的 `allowAlways: "session"` 在这里收紧成不允许记住）。
    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        if self.read_only {
            PermissionDecision::Allow {
                updated_input: None,
            }
        } else {
            PermissionDecision::Ask {
                message: format!(
                    "ZCode requested permissions to use {}, provided by {}",
                    self.model_name, self.plugin_id
                ),
                suggestions: Vec::new(),
            }
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let registry = self.registry.upgrade().ok_or_else(|| ToolError::Failed {
            message: "MCP is shut down".to_owned(),
        })?;
        let value = registry
            .execute(self.call.clone(), input, context.cancel)
            .await?;
        // 服务器报告的错误（`isError`）：结果是原文、标记为错误（与 MCP 工具同一口径）。
        if let Some(message) = result::error_text(&value) {
            return Ok(ToolOutput {
                content: vec![ToolResultContent::Text { text: message }],
                is_error: true,
                display: Value::Null,
            });
        }
        let content =
            result::transform(&value, &self.call.server_name).ok_or_else(|| ToolError::Failed {
                message: format!(
                    "The {} app page returned an unexpected result",
                    self.call.server_name
                ),
            })?;
        Ok(ToolOutput {
            content: result::truncate(content, MAX_RESULT_TOKENS),
            is_error: false,
            display: Value::Null,
        })
    }
}

#[cfg(test)]
#[path = "app_tools_tests.rs"]
mod tests;

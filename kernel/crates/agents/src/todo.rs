//! TodoRead / TodoWrite（Node `tool/handlers/todo.ts` 的同名工具）。
//!
//! 语义与 Node 一致：TodoRead 返回 `{todos}`；TodoWrite 先读旧清单、整体替换、返回
//! `{oldTodos, todos, summary}`（`summary` 是 `{total,pending,inProgress,completed}`）。会话口径是
//! `context.session`（子代理有自己的 todo），不是顶层会话。
//!
//! 结果文本是紧凑 JSON：Node 的 App 从工具结果内容里解析 `todos`（`todoItemsFromToolResultContent`），
//! 因此不能改成散文。描述与输入 schema 在 `prompts/tools/Todo*.json`。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::agents::{TodoItem, TodoStore};
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::permission::PermissionDecision;
use nibi_kernel_api::store::StoreError;
use nibi_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::agent_tool::text_output;

/// Node `TodoRead` / `TodoWrite` 的结果预算（`MAX_TODO_MODEL_BYTES`）。
const MAX_TODO_BYTES: usize = 100_000;

pub fn tools(store: Arc<dyn TodoStore>) -> Vec<Arc<dyn Tool>> {
    [Kind::Read, Kind::Write]
        .into_iter()
        .map(|kind| {
            Arc::new(TodoTool {
                store: store.clone(),
                kind,
            }) as Arc<dyn Tool>
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Read,
    Write,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Read => "TodoRead",
            Self::Write => "TodoWrite",
        }
    }
}

struct TodoTool {
    store: Arc<dyn TodoStore>,
    kind: Kind,
}

/// TodoRead 的输入是严格的空对象（Node `TodoReadInputSchema.strict()`）。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {}

/// TodoWrite 的输入也是严格对象；每条 todo 的多余键按 Node 的 zod `strip` 忽略。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteInput {
    todos: Vec<TodoItem>,
}

#[derive(Debug, Serialize)]
struct ReadResult {
    todos: Vec<TodoItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteResult {
    old_todos: Vec<TodoItem>,
    todos: Vec<TodoItem>,
    summary: Summary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    total: usize,
    pending: usize,
    in_progress: usize,
    completed: usize,
}

impl Summary {
    fn of(todos: &[TodoItem]) -> Self {
        use nibi_kernel_api::agents::TodoStatus;
        Self {
            total: todos.len(),
            pending: todos
                .iter()
                .filter(|todo| todo.status == TodoStatus::Pending)
                .count(),
            in_progress: todos
                .iter()
                .filter(|todo| todo.status == TodoStatus::InProgress)
                .count(),
            completed: todos
                .iter()
                .filter(|todo| todo.status == TodoStatus::Completed)
                .count(),
        }
    }
}

fn input<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, ToolError> {
    serde_json::from_value(value).map_err(|error| ToolError::InvalidInput {
        message: error.to_string(),
    })
}

fn failed(error: StoreError) -> ToolError {
    match error {
        StoreError::Storage { message } => ToolError::Failed { message },
        other => ToolError::Failed {
            message: other.to_string(),
        },
    }
}

/// Node `TodoItemSchema.content` 是 `z.string().min(1)`：只拒绝空串，空白串仍然合法。
/// `in_progress` 的数量不限制（Node 已注释掉 superRefine；描述里的 "At most one" 只是旧的文案）。
fn validate(todos: &[TodoItem]) -> Result<(), ToolError> {
    if let Some(index) = todos.iter().position(|todo| todo.content.is_empty()) {
        return Err(ToolError::InvalidInput {
            message: format!("todos[{index}].content must not be empty"),
        });
    }
    Ok(())
}

fn json_output<T: Serialize>(value: &T) -> Result<ToolOutput, ToolError> {
    let text = serde_json::to_string(value).map_err(|error| ToolError::Failed {
        message: error.to_string(),
    })?;
    Ok(text_output(text, false))
}

#[async_trait]
impl Tool for TodoTool {
    fn name(&self) -> &str {
        self.kind.name()
    }

    /// 延迟加载（Node `metadata.shouldDefer`）。
    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        match self.kind {
            Kind::Read => None,
            Kind::Write => Some("manage the session task checklist"),
        }
    }

    fn input_schema(&self) -> Value {
        nibi_kernel_prompts::tool(self.kind.name())
            .map_or(Value::Null, |prompt| prompt.input_schema.clone())
    }

    fn description(&self, _context: &PromptContext) -> String {
        nibi_kernel_prompts::tool(self.kind.name())
            .map_or_else(String::new, |prompt| prompt.description.clone())
    }

    /// Node 两个工具的 `metadata.readOnly` 都是 true（TodoWrite 只改会话内状态）。
    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        matches!(self.kind, Kind::Read)
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(MAX_TODO_BYTES)
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        // Node `needsApproval: false` 且 denyPriority 在 ask 之前：todo 不经权限询问。
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        value: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        match self.kind {
            Kind::Read => {
                let _: ReadInput = input(value)?;
                let todos = self.store.read(&context.session).await.map_err(failed)?;
                json_output(&ReadResult { todos })
            }
            Kind::Write => {
                let WriteInput { todos } = input(value)?;
                validate(&todos)?;
                let old_todos = self.store.read(&context.session).await.map_err(failed)?;
                self.store
                    .replace(&context.session, &todos)
                    .await
                    .map_err(failed)?;
                let summary = Summary::of(&todos);
                json_output(&WriteResult {
                    old_todos,
                    todos,
                    summary,
                })
            }
        }
    }
}

/// 没有本地存储时（测试、嵌入）用的内存 todo。它不区分 Task v2 归属：生产互斥在 node-store 的
/// `TodoStore` 实现里（与 `todo` 表投影共用会话状态）。
#[derive(Default)]
pub struct MemoryTodos(Mutex<HashMap<SessionId, Vec<TodoItem>>>);

#[async_trait]
impl TodoStore for MemoryTodos {
    async fn read(&self, session: &SessionId) -> Result<Vec<TodoItem>, StoreError> {
        let todos = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(todos.get(session).cloned().unwrap_or_default())
    }

    async fn replace(&self, session: &SessionId, todos: &[TodoItem]) -> Result<(), StoreError> {
        let mut stored = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        stored.insert(session.clone(), todos.to_vec());
        Ok(())
    }
}

#[cfg(test)]
#[path = "todo_tests.rs"]
mod tests;

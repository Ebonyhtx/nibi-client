//! 会话 todo（TodoRead / TodoWrite）在 Node `todo` 表上的实现。
//!
//! 读法、写法与 Node `repositories/todos.ts` 一致：按 `position` 升序读；整体替换时 `begin immediate`、
//! 先删会话行、再按位置插入（`time_created`/`time_updated` 同 now）、`touchSession`。
//!
//! 与 Task v2 的关系（docs/specs/rust-cli/agents.md §7）：Task v2 的清单文件是事实源，写成功后把清单投影到
//! 同一张 `todo` 表。只要本会话存在 Task v2 清单文件，或 `todo_state` 已把归属记为 `task`，TodoWrite 就拒绝
//! 整体替换，避免下一次投影把刚写的 todo 静默覆盖；Task v2 反过来可以在没有文件时从 `todo` 表导入，第一次
//! 保存后由文件接管。
//!
//! 归属与修订记在 `session_entry` 的 `nibi-kernel/todo_state`（`{writer, revision}`）：Node 不认识这个类型，
//! 会原样忽略，因此不需要新增表或迁移；`revision` 每次 TodoWrite / Task v2 投影都加一，便于诊断谁最后写了
//! 这张表。

use async_trait::async_trait;
use rusqlite::Connection;
use serde_json::{Value, json};

use nibi_kernel_api::agents::{TodoItem, TodoPriority, TodoStatus, TodoStore};
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::store::StoreError;

use crate::repo::entries;
use crate::{NodeStore, OrStorage, storage};

/// 任务表归属的 `session_entry` 类型（Node 不认识，忽略）。
const TODO_STATE_ENTRY: &str = "nibi-kernel/todo_state";
const TODO_WRITER: &str = "todo";
const TASK_WRITER: &str = "task";

/// 归属与修订：`writer` 是 `todo` / `task`，`revision` 每次写入加一。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct State {
    writer: Option<&'static str>,
    revision: u64,
}

fn read_state(conn: &Connection, session: &str) -> Result<State, StoreError> {
    let entries = entries::list(conn, session, Some(TODO_STATE_ENTRY)).storage()?;
    let Some(entry) = entries.last() else {
        return Ok(State::default());
    };
    let writer = entry.data.get("writer").and_then(Value::as_str);
    let writer = if writer == Some(TODO_WRITER) {
        Some(TODO_WRITER)
    } else if writer == Some(TASK_WRITER) {
        Some(TASK_WRITER)
    } else {
        None
    };
    Ok(State {
        writer,
        revision: entry
            .data
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

fn write_state(
    conn: &Connection,
    session: &str,
    writer: &'static str,
    now: i64,
) -> Result<u64, StoreError> {
    let previous = read_state(conn, session)?;
    let revision = previous.revision.saturating_add(1);
    entries::save(
        conn,
        &entries::Entry {
            id: format!("{session}:{TODO_STATE_ENTRY}"),
            session_id: session.to_owned(),
            kind: TODO_STATE_ENTRY.to_owned(),
            time_created: now,
            time_updated: now,
            data: json!({"writer": writer, "revision": revision}),
            touch_session: false,
        },
    )
    .storage()?;
    Ok(revision)
}

/// Task v2 投影成功后把表交给任务清单（写文件之后的同一次数据库操作）。
pub(crate) fn mark_task_owned(
    conn: &Connection,
    session: &str,
    now: i64,
) -> Result<(), StoreError> {
    write_state(conn, session, TASK_WRITER, now).map(|_| ())
}

fn status(value: &str) -> Result<TodoStatus, StoreError> {
    match value {
        "pending" => Ok(TodoStatus::Pending),
        "in_progress" => Ok(TodoStatus::InProgress),
        "completed" => Ok(TodoStatus::Completed),
        other => Err(storage(format!("unknown todo status {other:?}"))),
    }
}

fn priority(value: &str) -> Result<TodoPriority, StoreError> {
    match value {
        "high" => Ok(TodoPriority::High),
        "medium" => Ok(TodoPriority::Medium),
        "low" => Ok(TodoPriority::Low),
        other => Err(storage(format!("unknown todo priority {other:?}"))),
    }
}

fn read_rows(conn: &Connection, session: &str) -> Result<Vec<TodoItem>, StoreError> {
    let mut statement = conn
        .prepare(
            "select content, status, priority from todo where session_id = ? order by position asc",
        )
        .storage()?;
    let rows = statement
        .query_map([session], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .storage()?
        .collect::<rusqlite::Result<Vec<_>>>()
        .storage()?;
    rows.into_iter()
        .map(|(content, status_value, priority_value)| {
            Ok(TodoItem {
                content,
                status: status(&status_value)?,
                priority: priority(&priority_value)?,
            })
        })
        .collect()
}

fn replace_rows(
    conn: &mut Connection,
    session: &str,
    todos: &[TodoItem],
    now: i64,
    task_list_exists: bool,
) -> Result<(), StoreError> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .storage()?;
    // 清单文件存在，或归属已经交给 Task v2：这张表是任务清单的投影，TodoWrite 不能覆盖。
    // 在同一个 immediate 事务里复查，避免与 Task v2 的投影交错。
    if task_list_exists || read_state(&tx, session)?.writer == Some(TASK_WRITER) {
        return Err(storage(
            "this session's todo list is owned by a Task v2 task list; use TaskList/TaskUpdate instead of TodoWrite",
        ));
    }
    tx.execute("delete from todo where session_id = ?", [session])
        .storage()?;
    {
        let mut insert = tx
            .prepare(
                "insert into todo (session_id, content, status, priority, position, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)",
            )
            .storage()?;
        for (position, todo) in todos.iter().enumerate() {
            let position = i64::try_from(position).unwrap_or(i64::MAX);
            insert
                .execute(rusqlite::params![
                    session,
                    todo.content,
                    todo.status.as_str(),
                    todo.priority.as_str(),
                    position,
                    now,
                    now
                ])
                .storage()?;
        }
    }
    write_state(&tx, session, TODO_WRITER, now)?;
    tx.execute(
        "update session set time_updated = max(time_updated, ?) where id = ?",
        rusqlite::params![now, session],
    )
    .storage()?;
    tx.commit().storage()
}

#[async_trait]
impl TodoStore for NodeStore {
    async fn read(&self, session: &SessionId) -> Result<Vec<TodoItem>, StoreError> {
        let session = session.as_str().to_owned();
        self.with_db(move |conn, _| read_rows(conn, &session)).await
    }

    async fn replace(&self, session: &SessionId, todos: &[TodoItem]) -> Result<(), StoreError> {
        // Task v2 的清单文件属于本会话时，`todo` 表是它的投影；TodoWrite 不能覆盖。
        let path = self.paths.task_list(session.as_str());
        let task_list_exists = nibi_kernel_fs::read_optional(path.as_path())
            .await
            .map_err(storage)?
            .is_some();
        let session = session.as_str().to_owned();
        let todos = todos.to_vec();
        self.with_db(move |conn, ids| {
            let now = i64::try_from(ids.now_ms()).unwrap_or(i64::MAX);
            replace_rows(conn, &session, &todos, now, task_list_exists)
        })
        .await
    }
}

#[cfg(test)]
#[path = "todos_tests.rs"]
mod tests;

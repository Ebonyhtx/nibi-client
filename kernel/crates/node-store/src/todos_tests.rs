//! 会话 todo（TodoStore）：Node `todo` 表的读写、与 Task v2 投影的互斥（`nibi-kernel/todo_state`）。
use nibi_kernel_api::agents::{TaskListStore, TodoItem, TodoPriority, TodoStatus, TodoStore};
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::store::SessionStore;
use serde_json::json;

use crate::tests::{TestStore, meta};

fn todo(content: &str, status: TodoStatus, priority: TodoPriority) -> TodoItem {
    TodoItem {
        content: content.to_owned(),
        status,
        priority,
    }
}

fn state(test: &TestStore) -> serde_json::Value {
    let rows = test.rows(
        "select data from session_entry where type = 'nibi-kernel/todo_state' order by rowid desc limit 1",
    );
    serde_json::from_str(rows[0][0].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn an_empty_session_reads_an_empty_list() {
    let test = TestStore::new();
    test.store
        .create(meta("sess_1", "/work", ""))
        .await
        .unwrap();
    assert_eq!(
        TodoStore::read(&test.store, &SessionId::new("sess_1"))
            .await
            .unwrap(),
        Vec::new()
    );
}

#[tokio::test]
async fn replacing_writes_ordered_rows_and_touches_the_session() {
    let test = TestStore::new();
    let session = SessionId::new("sess_1");
    test.store
        .create(meta("sess_1", "/work", ""))
        .await
        .unwrap();
    let todos = vec![
        todo("Inspect", TodoStatus::Pending, TodoPriority::High),
        todo("Implement", TodoStatus::InProgress, TodoPriority::Medium),
        todo("Verify", TodoStatus::Completed, TodoPriority::Low),
    ];
    test.source.at(5_000);
    TodoStore::replace(&test.store, &session, &todos)
        .await
        .unwrap();
    assert_eq!(
        test.rows("select content, status, priority, position, time_created, time_updated from todo order by position"),
        vec![
            vec![json!("Inspect"), json!("pending"), json!("high"), json!(0), json!(5000), json!(5000)],
            vec![json!("Implement"), json!("in_progress"), json!("medium"), json!(1), json!(5000), json!(5000)],
            vec![json!("Verify"), json!("completed"), json!("low"), json!(2), json!(5000), json!(5000)],
        ]
    );
    assert_eq!(
        test.rows("select time_updated from session"),
        vec![vec![json!(5000)]]
    );
    assert_eq!(TodoStore::read(&test.store, &session).await.unwrap(), todos);
    // 整体替换：第二次写入只留新清单，位置从 0 重新编号。
    let next = vec![todo("Verify", TodoStatus::InProgress, TodoPriority::Low)];
    TodoStore::replace(&test.store, &session, &next)
        .await
        .unwrap();
    assert_eq!(
        test.rows("select content, position from todo order by position"),
        vec![vec![json!("Verify"), json!(0)]]
    );
    assert_eq!(state(&test), json!({"writer": "todo", "revision": 2}));
}

#[tokio::test]
async fn sessions_are_isolated() {
    let test = TestStore::new();
    test.store
        .create(meta("sess_1", "/work", ""))
        .await
        .unwrap();
    test.store
        .create(meta("sess_2", "/work", ""))
        .await
        .unwrap();
    let first = vec![todo("Only mine", TodoStatus::Pending, TodoPriority::High)];
    TodoStore::replace(&test.store, &SessionId::new("sess_1"), &first)
        .await
        .unwrap();
    assert_eq!(
        TodoStore::read(&test.store, &SessionId::new("sess_2"))
            .await
            .unwrap(),
        Vec::new()
    );
    assert_eq!(
        test.rows("select session_id, content from todo"),
        vec![vec![json!("sess_1"), json!("Only mine")]]
    );
}

/// Task v2 第一次保存从 `todo` 表导入，之后清单文件是事实源：TodoWrite 不能再整体替换投影。
#[tokio::test]
async fn a_task_list_owns_the_table_and_blocks_todo_write() {
    let test = TestStore::new();
    let session = SessionId::new("sess_1");
    test.store
        .create(meta("sess_1", "/work", ""))
        .await
        .unwrap();
    let imported = vec![
        todo("First", TodoStatus::Pending, TodoPriority::High),
        todo("Second", TodoStatus::Completed, TodoPriority::Medium),
    ];
    test.source.at(1_000);
    TodoStore::replace(&test.store, &session, &imported)
        .await
        .unwrap();
    let mut list = TaskListStore::load(&test.store, &session).await.unwrap();
    assert_eq!(list.tasks.len(), 2);
    list.tasks[0].status = nibi_kernel_api::agents::TaskStatus::InProgress;
    test.source.at(2_000);
    TaskListStore::save(&test.store, &session, &list)
        .await
        .unwrap();
    let file = test.dir.path().join("tasks/sess_1.json");
    assert!(
        nibi_kernel_fs::read_optional(file.as_path())
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(state(&test), json!({"writer": "task", "revision": 2}));
    // 投影仍然可读（App 的 todo 视图就是这张表）。
    let projected = TodoStore::read(&test.store, &session).await.unwrap();
    assert_eq!(
        projected
            .iter()
            .map(|todo| (todo.content.as_str(), todo.status))
            .collect::<Vec<_>>(),
        vec![
            ("First", TodoStatus::InProgress),
            ("Second", TodoStatus::Completed)
        ]
    );
    let error = TodoStore::replace(
        &test.store,
        &session,
        &[todo("Clobber", TodoStatus::Pending, TodoPriority::Low)],
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("owned by a Task v2"), "{error}");
    assert_eq!(
        test.rows("select content from todo order by position"),
        vec![vec![json!("First")], vec![json!("Second")]]
    );
    // 被拒绝的写入不推进修订。
    assert_eq!(state(&test), json!({"writer": "task", "revision": 2}));
}

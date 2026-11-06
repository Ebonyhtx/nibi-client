//! 会话目录读面（legacy `session/list`，Node `listSessions` / `getSession`）。
//!
//! 这里只钉**存储口径**：任务类型白名单、目录分支的排序与 limit、软删除、显式 ID 读法。
//! 归属校验（父链、`workspace_id`）在协议层，见 `protocol-nibi/src/session_directory.rs`。
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::store::{SessionDirectoryQuery, SessionStore};

use crate::tests::{TestStore, meta};

fn query(directory: Option<&str>, limit: usize) -> SessionDirectoryQuery {
    SessionDirectoryQuery {
        directory: directory.map(str::to_owned),
        ids: None,
        limit,
    }
}

fn ids(entries: &[nibi_kernel_api::store::SessionDirectoryEntry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.id.as_str()).collect()
}

/// 把会话行改成 Node 侧写法：任务类型、父链、远端身份与 `path`。
///
/// 走另一条连接（模拟 Node 进程写库）而不是 `store.create`：`SessionMeta` 不带这些列，
/// 而这项判据要读的正是它们。
fn shape(test: &TestStore, id: &str, sql: &str) {
    test.connection().execute(sql, [id]).unwrap();
}

async fn seeded() -> TestStore {
    let test = TestStore::new();
    for (index, (id, root)) in [
        ("sess_root", "/w/app"),
        ("sess_fork", "/w/app"),
        ("sess_wf", "/w/app"),
        ("sess_child", "/w/app"),
        ("sess_other", "/w/lib"),
        ("sess_gone", "/w/app"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut session = meta(id, root, "");
        session.created_at_ms = 1000 + index as u64;
        test.store.create(session).await.unwrap();
        test.source.at(5000 + index as u64 * 100);
        // 用一次提交推进 time_updated，排序才有多样的活动时间。
        test.store
            .commit(
                &SessionId::new(id),
                crate::tests::batch(
                    None,
                    vec![crate::tests::user(&format!("m_{id}"), "hi")],
                ),
            )
            .await
            .unwrap();
    }
    // 有父的 workflow_parent：Node 的任务列表口径按 task_type 收，不看 parent_id 层级。
    shape(
        &test,
        "sess_wf",
        "update session set task_type = 'workflow_parent', parent_id = 'sess_root' where id = ?",
    );
    shape(
        &test,
        "sess_fork",
        "update session set task_type = 'fork', parent_id = 'sess_root' where id = ?",
    );
    // 子代理子会话：目录读法**不**列它（由 session/subagents 承载）。
    shape(
        &test,
        "sess_child",
        "update session set task_type = 'subagent_child', parent_id = 'sess_root' where id = ?",
    );
    // 远端身份与 path：Node 的归属校验读这两列。
    shape(
        &test,
        "sess_root",
        "update session set path = '/w/app/pkg' where id = ?",
    );
    shape(
        &test,
        "sess_other",
        "update session set workspace_id = 'remote:wsl:/w/lib' where id = ?",
    );
    shape(
        &test,
        "sess_gone",
        "update session set time_deleted = 9000 where id = ?",
    );
    test
}

/// 目录分支照 Node `TASK_LIST_SESSION_TYPES` 收：`interactive` / `fork` / `workflow_parent`
/// 都出现（有父的也算），`subagent_child` 与软删除的、别的目录的都不出现。
///
/// 这条判据挡的是「用 `sessions::list` 的层级口径代替任务列表口径」：那条
/// `parent_id is null or task_type = 'fork'` 会把有父的 `workflow_parent` 漏掉。
#[tokio::test]
async fn the_directory_lists_task_list_kinds_including_parented_workflow_sessions() {
    let test = seeded().await;
    let entries = test
        .store
        .session_directory(query(Some("/w/app"), 50))
        .await
        .unwrap();
    let mut listed = ids(&entries);
    listed.sort_unstable();
    assert_eq!(listed, ["sess_fork", "sess_root", "sess_wf"]);
}

/// 排序同 Node：`time_updated desc, id desc`，limit 在 SQL 里生效。
#[tokio::test]
async fn the_directory_orders_by_activity_and_honours_the_limit() {
    let test = seeded().await;
    let entries = test
        .store
        .session_directory(query(Some("/w/app"), 50))
        .await
        .unwrap();
    // sess_gone 的活动时间最晚，但它被软删除了；剩下按活动时间从新到旧。
    assert_eq!(ids(&entries), ["sess_wf", "sess_fork", "sess_root"]);

    let limited = test
        .store
        .session_directory(query(Some("/w/app"), 2))
        .await
        .unwrap();
    assert_eq!(ids(&limited), ["sess_wf", "sess_fork"]);
}

/// 不限目录时列出所有工作区的任务（Node `listSessions` 不带 `directory`）。
#[tokio::test]
async fn the_directory_without_a_directory_spans_workspaces() {
    let test = seeded().await;
    let entries = test
        .store
        .session_directory(query(None, 50))
        .await
        .unwrap();
    let mut listed = ids(&entries);
    listed.sort_unstable();
    assert_eq!(
        listed,
        ["sess_fork", "sess_other", "sess_root", "sess_wf"]
    );
}

/// 显式 ID 读法：不看目录与任务类型（Host 靠它查子会话的身份），软删除仍不返回。
#[tokio::test]
async fn explicit_ids_ignore_directory_and_kind_but_not_deletion() {
    let test = seeded().await;
    let entries = test
        .store
        .session_directory(SessionDirectoryQuery {
            directory: Some("/w/nowhere".to_owned()),
            ids: Some(vec![
                SessionId::new("sess_child"),
                SessionId::new("sess_other"),
                SessionId::new("sess_gone"),
                SessionId::new("missing"),
            ]),
            limit: 50,
        })
        .await
        .unwrap();
    assert_eq!(ids(&entries), ["sess_child", "sess_other"]);
}

/// 读出来的列要够 Host 用：`task_type` 原值、父链、标题来源、`path` 与 `workspace_id`。
#[tokio::test]
async fn the_directory_carries_the_columns_the_host_reads() {
    let test = seeded().await;
    let entries = test
        .store
        .session_directory(query(Some("/w/app"), 50))
        .await
        .unwrap();
    let root = entries
        .iter()
        .find(|entry| entry.id.as_str() == "sess_root")
        .unwrap();
    assert_eq!(root.task_type, "interactive");
    assert_eq!(root.directory, "/w/app");
    // path 与 directory 是两列：Node 的归属键优先读 path。
    assert_eq!(root.path.as_deref(), Some("/w/app/pkg"));
    assert!(root.parent.is_none());
    let wf = entries
        .iter()
        .find(|entry| entry.id.as_str() == "sess_wf")
        .unwrap();
    assert_eq!(wf.task_type, "workflow_parent");
    assert_eq!(wf.parent.as_ref().map(|p| p.as_str()), Some("sess_root"));
    // 首条输入会写标题来源（Node `first_input`）。
    assert_eq!(root.title_source.as_deref(), Some("first_input"));
}

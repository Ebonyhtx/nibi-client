//! `dwf_run` 的只读视图：只取本会话的 run，字段按 NIBI 的 camelCase；状态原样透出。

use super::*;
use rust_cli_kernel_api::workflow::DynamicWorkflowRun;

fn insert(conn: &Connection, id: &str, session: &str, status: &str, created: i64) {
    conn.execute(
        "insert into dwf_run (
            id, parent_session_id, cwd, name, script_text, script_hash, args_json, tool_call_id,
            resumed_from, caps_max_concurrency, spent_tokens, status, result_json, failure_json,
            time_created, time_updated
         ) values (?, ?, '/w', ?, 'script', 'hash', null, ?, null, 4, 7, ?, null, null, ?, ?)",
        params![
            id,
            session,
            format!("run {id}"),
            format!("tool_{id}"),
            status,
            created,
            created + 5
        ],
    )
    .unwrap();
}

#[test]
fn runs_are_scoped_to_the_session_and_keep_the_journal_status() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let (conn, _) = crate::repo::open::open(&path, crate::repo::open::MIGRATION_LOCK_WAIT, 1).unwrap();
    insert(&conn, "run_a", "sess_1", "running", 100);
    insert(&conn, "run_b", "sess_1", "completed", 200);
    insert(&conn, "run_c", "sess_2", "failed", 50);

    let runs = list(&conn, "sess_1").unwrap();
    assert_eq!(
        runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
        ["run_a", "run_b"]
    );
    let first: &DynamicWorkflowRun = &runs[0];
    assert_eq!(first.name.as_deref(), Some("run run_a"));
    assert_eq!(first.status, "running");
    assert_eq!(first.session_id.as_deref(), Some("sess_1"));
    assert_eq!(first.tool_call_id.as_deref(), Some("tool_run_a"));
    assert_eq!(first.cwd, "/w");
    assert_eq!(first.spent_tokens, 7);
    assert_eq!((first.created_at, first.updated_at), (100, 105));
    assert!(first.resumed_from.is_none());
    assert!(list(&conn, "sess_missing").unwrap().is_empty());
}

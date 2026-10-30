//! `dwf_run` 的只读视图：只取本会话的 run，字段按 NIBI 的 camelCase；状态原样透出。
//! 事件流（`dwf_event`）的追加与升级问答重放也在本文件（`append_event` / `pending_questions`）。

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

fn raised_json(qid: &str, question: &str) -> String {
    serde_json::json!({
        "type": "escalation-raised",
        "qid": qid,
        "actor": "reviewer@1",
        "actorName": "Reviewer",
        "question": question,
        "askedAt": 1_000,
    })
    .to_string()
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

/// 序号在同一条 INSERT 里按 run 分配（Node `appendEvent` 的同一条语句）：从 0 起单调、
/// 各 run 互不占号；宿主与 sidecar 共写同一个库时也不会撞号（这里的并发竞争由 unique 约束兜底）。
#[test]
fn appended_events_get_per_run_sequences() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let (conn, _) = crate::repo::open::open(&path, crate::repo::open::MIGRATION_LOCK_WAIT, 1).unwrap();
    insert(&conn, "run_a", "sess_1", "running", 100);
    insert(&conn, "run_b", "sess_1", "running", 200);

    assert_eq!(
        append_event(&conn, "run_a", "escalation-raised", &raised_json("dwfq-a-1", "q1"), 500).unwrap(),
        0
    );
    assert_eq!(
        append_event(&conn, "run_a", "escalation-resolved", &format!(r#"{{"type":"escalation-resolved","qid":"dwfq-a-1","answer":"that way"}}"#), 600).unwrap(),
        1
    );
    // 另一个 run 的序号独立计数。
    assert_eq!(
        append_event(&conn, "run_b", "escalation-raised", &raised_json("dwfq-b-1", "q2"), 700).unwrap(),
        0
    );
    let rows = events(&conn, "run_a").unwrap();
    assert_eq!(
        rows.iter().map(|row| row.event_type.as_str()).collect::<Vec<_>>(),
        ["escalation-raised", "escalation-resolved"]
    );
    assert_eq!(rows[0].time_created, 500);
    // payload 原样存取（整个 RunEvent 的 JSON，含 type）。
    let back: serde_json::Value = serde_json::from_str(&rows[0].payload_json).unwrap();
    assert_eq!(back["type"], "escalation-raised");
    assert_eq!(back["qid"], "dwfq-a-1");
    // 没有的 run：外键拒绝（事件必须挂在已存在的 run 行上）。
    assert!(append_event(&conn, "run_missing", "escalation-raised", "{}", 800).is_err());
}

/// 冷回放：raised 减 resolved 就是「谁还在等」；提问顺序、可选字段与 askedAt（事件载荷里的
/// 提问时刻，不是落库时刻）都从事件里来。
#[test]
fn pending_questions_replay_the_event_stream() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let (conn, _) = crate::repo::open::open(&path, crate::repo::open::MIGRATION_LOCK_WAIT, 1).unwrap();
    insert(&conn, "run_a", "sess_1", "running", 100);
    append_event(&conn, "run_a", "escalation-raised", &raised_json("dwfq-a-1", "first?"), 500).unwrap();
    append_event(&conn, "run_a", "escalation-raised", &raised_json("dwfq-a-2", "second?"), 600).unwrap();
    append_event(&conn, "run_a", "escalation-raised", &serde_json::json!({
        "type": "escalation-raised", "qid": "dwfq-a-3", "actor": "runner@2",
        "question": "third?", "askedAt": 700,
    }).to_string(), 700).unwrap();

    let pending = pending_questions(&conn, "run_a").unwrap();
    assert_eq!(
        pending.iter().map(|question| question.qid.as_str()).collect::<Vec<_>>(),
        ["dwfq-a-1", "dwfq-a-2", "dwfq-a-3"]
    );
    assert_eq!(pending[0].actor, "reviewer@1");
    assert_eq!(pending[0].actor_name.as_deref(), Some("Reviewer"));
    assert_eq!(pending[2].actor_name, None);
    assert_eq!(pending[0].asked_at, 1_000);

    // 答掉中间那个：只剩两侧的（重放按事件序，不按 qid 排序）。
    append_event(&conn, "run_a", "escalation-resolved", &serde_json::json!({
        "type": "escalation-resolved", "qid": "dwfq-a-2", "answer": "that way",
    }).to_string(), 800).unwrap();
    let pending = pending_questions(&conn, "run_a").unwrap();
    assert_eq!(
        pending.iter().map(|question| question.qid.as_str()).collect::<Vec<_>>(),
        ["dwfq-a-1", "dwfq-a-3"]
    );
}

//! 会话视角的 run 读面（`repo::run_queries`）：授权链、目录排序与 `resumable` 谓词、
//! 事件页的两道界与载荷裁剪、产物归并（只收 completed、版本升序、交付物带头）、
//! 看板游标分页、工作区清单与正文的保形有界化、以及产物版本的 uri 定位。
//!
//! 夹具走真实的 `repo::open::open`：这几条查询的 SQL 全是 SQLite JSON 函数与窗口函数，
//! 用假件测不到它们。

use super::*;
use nibi_kernel_api::workflow::{WorkflowRunArtifactItemQuery, WorkflowRunEventQuery};

fn database() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let (conn, _) =
        crate::repo::open::open(&path, crate::repo::open::MIGRATION_LOCK_WAIT, 1).unwrap();
    (dir, conn)
}

fn insert_run(
    conn: &Connection,
    id: &str,
    session: Option<&str>,
    name: Option<&str>,
    status: &str,
    failure_json: Option<&str>,
    updated: i64,
) {
    conn.execute(
        "insert into dwf_run (
            id, parent_session_id, cwd, name, script_text, script_hash, args_json, tool_call_id,
            resumed_from, caps_max_concurrency, spent_tokens, status, result_json, failure_json,
            time_created, time_updated
         ) values (?, ?, '/w', ?, '// first line', 'hash', null, ?, null, 4, 7, ?, null, ?, ?, ?)",
        params![
            id,
            session,
            name,
            format!("tool_{id}"),
            status,
            failure_json,
            updated - 10,
            updated
        ],
    )
    .unwrap();
}

fn insert_node(
    conn: &Connection,
    run: &str,
    site: &str,
    ordinal: i64,
    kind: &str,
    status: &str,
    input_json: Option<&str>,
    result_json: Option<&str>,
    error_json: Option<&str>,
    artifact_id: Option<&str>,
    at: i64,
) {
    conn.execute(
        "insert into dwf_node (
            run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash,
            input_json, status, result_json, error_json, stats_json, message_boundary, artifact_id,
            time_created, time_updated
         ) values (?, ?, ?, ?, null, null, null, 'hash', ?, ?, ?, ?, null, null, ?, ?, ?)",
        params![
            run,
            site,
            ordinal,
            kind,
            input_json,
            status,
            result_json,
            error_json,
            artifact_id,
            at,
            at + 1
        ],
    )
    .unwrap();
}

fn insert_event(conn: &Connection, run: &str, sequence: i64, kind: &str, payload: &str) {
    conn.execute(
        "insert into dwf_event (run_id, sequence, type, payload_json, time_created)
         values (?, ?, ?, ?, 1000)",
        params![run, sequence, kind, payload],
    )
    .unwrap();
}

fn artifact_record(id: &str, kind: &str, version: u64, extra: &str) -> String {
    format!(
        r#"{{"id":"{id}","kind":"{kind}","version":{version},"contentType":"text/markdown","bytes":12,"uri":"nibi-artifact://sess_1/{id}-{version}","publishedAt":{}{extra}}}"#,
        1_000 + version
    )
}

// ———— 授权链 ————

#[test]
fn runs_of_another_session_are_not_readable() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("sess_1"), None, "running", None, 100);
    insert_run(&conn, "run_b", Some("sess_2"), None, "running", None, 100);
    // parent_session_id 为 NULL 的老行不放行：「无从判定」不是「判定通过」。
    insert_run(&conn, "run_orphan", None, None, "running", None, 100);
    insert_event(
        &conn,
        "run_a",
        0,
        "run-started",
        r#"{"type":"run-started"}"#,
    );
    insert_event(
        &conn,
        "run_b",
        0,
        "run-started",
        r#"{"type":"run-started"}"#,
    );

    let query = WorkflowRunEventQuery {
        after_sequence: None,
        limit: 10,
        max_bytes: 1_000_000,
    };
    assert_eq!(
        events(&conn, "sess_1", "run_a", query)
            .unwrap()
            .events
            .len(),
        1
    );
    // 越权的三个入口都回空：事件页、产物清单、工作区清单。
    assert!(
        events(&conn, "sess_1", "run_b", query)
            .unwrap()
            .events
            .is_empty()
    );
    assert!(
        events(&conn, "sess_1", "run_orphan", query)
            .unwrap()
            .events
            .is_empty()
    );
    assert!(
        events(&conn, "sess_1", "run_missing", query)
            .unwrap()
            .events
            .is_empty()
    );
    assert_eq!(artifacts(&conn, "sess_1", "run_b").unwrap(), None);
    assert_eq!(workspace_nodes(&conn, "sess_1", "run_b").unwrap(), None);
    assert_eq!(
        node_result(&conn, "sess_1", "run_b", "files.read", 0, 1024).unwrap(),
        None
    );
    assert_eq!(
        artifact_version_uri(&conn, "sess_1", "run_b", "a", 1).unwrap(),
        None
    );
}

// ———— 目录 ————

#[test]
fn summaries_are_newest_first_and_carry_the_resume_predicate() {
    let (_dir, conn) = database();
    insert_run(
        &conn,
        "run_old",
        Some("sess_1"),
        Some("beta"),
        "completed",
        None,
        100,
    );
    insert_run(
        &conn,
        "run_new",
        Some("sess_1"),
        Some("alpha"),
        "cancelled",
        Some(r#"{"stopReason":"user"}"#),
        300,
    );
    insert_run(
        &conn,
        "run_superseded",
        Some("sess_1"),
        None,
        "cancelled",
        Some(r#"{"stopReason":"superseded","supersededBy":"run_new"}"#),
        200,
    );
    insert_run(
        &conn,
        "run_other",
        Some("sess_2"),
        None,
        "running",
        None,
        400,
    );

    let rows = summaries(&conn, "sess_1", 10).unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row.run_id.as_str())
            .collect::<Vec<_>>(),
        ["run_new", "run_superseded", "run_old"]
    );
    // stopped(user) 可恢复；stopped(superseded) 不可（未完结工作已归后继）。
    assert!(rows[0].resumable);
    assert_eq!(rows[0].stop_reason.as_deref(), Some("user"));
    assert!(!rows[1].resumable);
    assert_eq!(rows[1].superseded_by.as_deref(), Some("run_new"));
    // 没起名字的 run 用脚本首行派生标签。
    assert_eq!(rows[1].label, "// first line");
    assert!(!rows[2].resumable);
    // 越权与零上限都回空。
    assert!(summaries(&conn, "sess_missing", 10).unwrap().is_empty());
    assert!(summaries(&conn, "sess_1", 0).unwrap().is_empty());
    assert_eq!(summaries(&conn, "sess_1", 2).unwrap().len(), 2);
}

// ———— 事件页 ————

#[test]
fn event_pages_hide_the_type_key_and_paginate_by_cursor() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("sess_1"), None, "running", None, 100);
    insert_event(
        &conn,
        "run_a",
        0,
        "run-started",
        r#"{"type":"run-started","script":"x"}"#,
    );
    insert_event(
        &conn,
        "run_a",
        1,
        "log",
        r#"{"type":"log","message":"hi","sequence":1}"#,
    );
    insert_event(
        &conn,
        "run_a",
        2,
        "log",
        r#"{"type":"log","message":"bye"}"#,
    );

    let page = events(
        &conn,
        "sess_1",
        "run_a",
        WorkflowRunEventQuery {
            after_sequence: None,
            limit: 2,
            max_bytes: 1_000_000,
        },
    )
    .unwrap();
    assert_eq!(page.events.len(), 2);
    assert!(page.has_more);
    assert_eq!(page.events[0].r#type, "run-started");
    // payload 里不再有 `type`（它已经提升成行上的键）；其余字段原样。
    assert!(page.events[0].payload.get("type").is_none());
    assert_eq!(page.events[0].payload["script"], "x");
    assert_eq!(page.events[1].payload["message"], "hi");

    let rest = events(
        &conn,
        "sess_1",
        "run_a",
        WorkflowRunEventQuery {
            after_sequence: Some(1),
            limit: 2,
            max_bytes: 1_000_000,
        },
    )
    .unwrap();
    assert_eq!(rest.events.len(), 1);
    assert!(!rest.has_more);
    assert_eq!(rest.events[0].sequence, 2);
}

#[test]
fn event_pages_stop_at_the_byte_bound_but_always_keep_one_row() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("sess_1"), None, "running", None, 100);
    let big = "x".repeat(2_000);
    insert_event(
        &conn,
        "run_a",
        0,
        "log",
        &format!(r#"{{"type":"log","message":"{big}"}}"#),
    );
    insert_event(
        &conn,
        "run_a",
        1,
        "log",
        &format!(r#"{{"type":"log","message":"{big}"}}"#),
    );

    // 一页 100 字节：第一行总是带上（否则翻页永远卡住），第二行进不来 → has_more。
    let page = events(
        &conn,
        "sess_1",
        "run_a",
        WorkflowRunEventQuery {
            after_sequence: None,
            limit: 10,
            max_bytes: 100,
        },
    )
    .unwrap();
    assert_eq!(page.events.len(), 1);
    assert!(page.has_more);
}

#[test]
fn event_payloads_are_bounded_structurally() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("sess_1"), None, "running", None, 100);
    let long = "y".repeat(5_000);
    let deep = serde_json::json!({"a": {"b": {"c": {"d": {"e": {"f": {"g": 1}}}}}}});
    let payload = serde_json::json!({
        "type": "actor-created",
        "persona": {"system": long},
        "items": (0..50).collect::<Vec<_>>(),
        "deep": deep,
    })
    .to_string();
    insert_event(&conn, "run_a", 0, "actor-created", &payload);

    let page = events(
        &conn,
        "sess_1",
        "run_a",
        WorkflowRunEventQuery {
            after_sequence: None,
            limit: 10,
            max_bytes: 10_000_000,
        },
    )
    .unwrap();
    let row = &page.events[0];
    assert!(row.truncated);
    // 长字符串截到 2048 个字符；超长数组只留 32 条。
    assert_eq!(
        row.payload["persona"]["system"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        2_048
    );
    assert_eq!(row.payload["items"].as_array().unwrap().len(), 32);
    // 超过深度 6 的那一层被折成 null（形状保不住时宁可少给）。
    assert_eq!(
        row.payload["deep"]["a"]["b"]["c"]["d"]["e"]["f"],
        serde_json::Value::Null
    );
}

// ———— 产物 ————

#[test]
fn artifacts_merge_versions_and_put_the_deliverable_first() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("sess_1"), None, "completed", None, 100);
    insert_node(
        &conn,
        "run_a",
        "artifact.file#1",
        0,
        "artifact",
        "completed",
        None,
        Some(&artifact_record("report", "file", 1, "")),
        None,
        Some("report"),
        100,
    );
    insert_node(
        &conn,
        "run_a",
        "artifact.file#1",
        1,
        "artifact",
        "completed",
        None,
        Some(
            &r#"{"id":"report","kind":"file","version":2,"title":"v2","uri":"nibi-artifact://sess_1/report-2","publishedAt":1002}"#,
        ),
        None,
        Some("report"),
        101,
    );
    // 失败的发布不占 id、不占版本号。
    insert_node(
        &conn,
        "run_a",
        "artifact.file#2",
        0,
        "artifact",
        "failed",
        None,
        None,
        Some(r#"{"code":"ArtifactTooLarge","message":"too big"}"#),
        Some("broken"),
        102,
    );
    insert_node(
        &conn,
        "run_a",
        "artifact.chart#1",
        0,
        "artifact",
        "completed",
        None,
        Some(&artifact_record(
            "board",
            "chart",
            1,
            r#","spec":{"kind":"line"}"#,
        )),
        None,
        Some("board"),
        103,
    );
    // 两条打标的 report 喂给看板（itemCount 的来源）。
    insert_node(
        &conn,
        "run_a",
        "report#1",
        0,
        "report",
        "completed",
        None,
        Some(r#"{"x":1}"#),
        None,
        Some("board"),
        104,
    );
    insert_node(
        &conn,
        "run_a",
        "report#1",
        1,
        "report",
        "completed",
        None,
        Some(r#"{"x":2}"#),
        None,
        Some("board"),
        105,
    );

    let rows = artifacts(&conn, "sess_1", "run_a").unwrap().unwrap();
    assert_eq!(
        rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["report", "board"]
    );
    assert_eq!(rows[0].versions.len(), 2);
    assert_eq!(rows[0].version, 2);
    assert_eq!(rows[0].title.as_deref(), Some("v2"));
    assert_eq!(
        rows[0].item_count, 0,
        "content artifacts never count reports"
    );
    assert!(
        rows[0].versions[0].uri.is_some(),
        "uri 留在内核侧，协议层剥掉"
    );
    assert_eq!(rows[1].item_count, 2);
    assert_eq!(rows[1].spec.as_ref().unwrap()["kind"], "line");
}

#[test]
fn artifact_pages_follow_the_report_cursor_and_honour_fields() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("sess_1"), None, "running", None, 100);
    for index in 0..3 {
        insert_event(
            &conn,
            "run_a",
            index,
            "report",
            &format!(
                r#"{{"type":"report","instance":{{"siteId":"report#1","ordinal":{index}}},"item":{{"timing":{{"after":{index}}},"noise":"{noise}"}},"artifactId":"board"}}"#,
                noise = "z".repeat(1_000)
            ),
        );
    }
    // 未打标的 report 不进任何看板的数据流。
    insert_event(
        &conn,
        "run_a",
        3,
        "report",
        r#"{"type":"report","instance":{"siteId":"report#2","ordinal":0},"item":{"x":1}}"#,
    );

    let full = artifact_items(
        &conn,
        "sess_1",
        "run_a",
        &WorkflowRunArtifactItemQuery {
            artifact_id: "board".to_owned(),
            after_sequence: None,
            limit: 2,
            max_bytes: 10_000_000,
            fields: None,
            max_field_value_bytes: 4_096,
        },
    )
    .unwrap();
    assert_eq!(full.items.len(), 2);
    assert!(full.has_more);
    assert_eq!(full.items[0].site_id, "report#1");
    assert_eq!(full.items[0].ordinal, 0);
    assert!(full.items[0].item.is_some());

    let rest = artifact_items(
        &conn,
        "sess_1",
        "run_a",
        &WorkflowRunArtifactItemQuery {
            artifact_id: "board".to_owned(),
            after_sequence: Some(1),
            limit: 2,
            max_bytes: 10_000_000,
            fields: Some(vec!["timing.after".to_owned(), "missing.path".to_owned()]),
            max_field_value_bytes: 4_096,
        },
    )
    .unwrap();
    assert_eq!(rest.items.len(), 1);
    assert!(!rest.has_more);
    // 只取字段：整条 item 缺席，`fields` 里只有走得通的那条路径。
    assert!(rest.items[0].item.is_none());
    let fields = rest.items[0].fields.as_ref().unwrap();
    assert_eq!(fields["timing.after"], 2);
    assert!(fields.get("missing.path").is_none());
}

#[test]
fn artifact_version_uri_only_answers_for_completed_versions_with_a_uri() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("sess_1"), None, "running", None, 100);
    insert_node(
        &conn,
        "run_a",
        "artifact.file#1",
        0,
        "artifact",
        "completed",
        None,
        Some(&artifact_record("doc", "markdown", 1, "")),
        None,
        Some("doc"),
        100,
    );
    insert_node(
        &conn,
        "run_a",
        "artifact.file#1",
        1,
        "artifact",
        "completed",
        None,
        Some(r#"{"id":"doc","kind":"markdown","version":2,"contentType":"text/markdown"}"#),
        None,
        Some("doc"),
        101,
    );

    let (uri, content_type) = artifact_version_uri(&conn, "sess_1", "run_a", "doc", 1)
        .unwrap()
        .unwrap();
    assert_eq!(uri, "nibi-artifact://sess_1/doc-1");
    assert_eq!(content_type.as_deref(), Some("text/markdown"));
    // 第 2 版没有 uri（块看板 / 老行的形态）→ 不放行。
    assert_eq!(
        artifact_version_uri(&conn, "sess_1", "run_a", "doc", 2).unwrap(),
        None
    );
    // 无此版本。
    assert_eq!(
        artifact_version_uri(&conn, "sess_1", "run_a", "doc", 9).unwrap(),
        None
    );
}

// ———— 工作区 transcript ————

#[test]
fn workspace_lists_world_rows_without_their_bodies() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("sess_1"), None, "running", None, 100);
    insert_node(
        &conn,
        "run_a",
        "files.read#1",
        0,
        "world-read",
        "completed",
        Some(r#"{"op":"files.read","args":["a.ts"],"truncated":true}"#),
        Some(r#"[{"path":"a.ts"},{"path":"b.ts"}]"#),
        None,
        None,
        100,
    );
    insert_node(
        &conn,
        "run_a",
        "world.run#1",
        0,
        "world-run",
        "completed",
        Some(r#"{"op":"world.run","args":["ls"]}"#),
        Some(r#"{"exitCode":0,"stdout":"a\nb\n","stderr":""}"#),
        None,
        None,
        102,
    );
    insert_node(
        &conn,
        "run_a",
        "world.run#1",
        1,
        "world-run",
        "failed",
        Some(r#"{"op":"world.run","args":["rm"]}"#),
        None,
        Some(r#"{"code":"WorldCommandFailed","message":"denied"}"#),
        None,
        104,
    );
    // ask 行不进工作区清单（它不是 files.* / world.run）。
    insert_node(
        &conn,
        "run_a",
        "agent#1",
        0,
        "ask",
        "completed",
        None,
        Some("{}"),
        None,
        None,
        106,
    );

    let nodes = workspace_nodes(&conn, "sess_1", "run_a").unwrap().unwrap();
    assert_eq!(nodes.len(), 3);
    assert_eq!(nodes[0].kind, "world-read");
    assert_eq!(nodes[0].op.as_deref(), Some("files.read"));
    assert_eq!(nodes[0].args.as_ref().unwrap().len(), 1);
    assert_eq!(nodes[0].input_truncated, Some(true));
    // 摘要只在结算成功时在场；数组正文报条数。
    let summary = nodes[0].summary.as_ref().unwrap();
    assert_eq!(summary.result_count, Some(2));
    assert_eq!(nodes[1].summary.as_ref().unwrap().exit_code, Some(0));
    assert_eq!(nodes[1].summary.as_ref().unwrap().stdout_bytes, Some(4));
    // 失败行没有摘要，但有结构化错误。
    assert!(nodes[2].summary.is_none());
    assert_eq!(nodes[2].error.as_ref().unwrap().code, "WorldCommandFailed");
}

#[test]
fn node_results_are_bounded_by_shape() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("sess_1"), None, "running", None, 100);
    let stdout = "a".repeat(1_000);
    insert_node(
        &conn,
        "run_a",
        "world.run#1",
        0,
        "world-run",
        "completed",
        Some(r#"{"op":"world.run","args":["x"]}"#),
        Some(&format!(
            r#"{{"exitCode":3,"stdout":"{stdout}","stderr":""}}"#
        )),
        None,
        None,
        100,
    );
    insert_node(
        &conn,
        "run_a",
        "files.read#1",
        0,
        "world-read",
        "completed",
        Some(r#"{"op":"files.read","args":["a"]}"#),
        Some(&format!(r#""{stdout}""#)),
        None,
        None,
        102,
    );

    // 字符串正文切尾。
    let text = node_result(&conn, "sess_1", "run_a", "files.read#1", 0, 100)
        .unwrap()
        .unwrap();
    assert!(text.truncated);
    assert_eq!(text.result.as_ref().unwrap().as_str().unwrap().len(), 100);
    assert!(text.total_bytes > 100);

    // world.run 的 exitCode 恒保留，两路输出共用剩余预算。
    let run = node_result(&conn, "sess_1", "run_a", "world.run#1", 0, 200)
        .unwrap()
        .unwrap();
    assert!(run.truncated);
    let body = run.result.as_ref().unwrap();
    assert_eq!(body["exitCode"], 3);
    assert!(body["stdout"].as_str().unwrap().len() < 1_000);

    // 未截断时原样返回。
    let whole = node_result(&conn, "sess_1", "run_a", "files.read#1", 0, 100_000)
        .unwrap()
        .unwrap();
    assert!(!whole.truncated);

    // 非 world 行 → 无此节点。
    assert_eq!(
        node_result(&conn, "sess_1", "run_a", "agent#1", 0, 100).unwrap(),
        None
    );
}

/// `read_workflow_artifact_field` 的路径规则：按 `.` 切段、数组按数字下标、对象按键；
/// 走不通一律 `None`。这条规则与 Node 的 `readWorkflowArtifactField` 是**协议契约**，
/// 渲染器拿到的值必须与它自己从整条 item 里取出来的逐字相同。
#[test]
fn artifact_field_paths_follow_the_shared_rule() {
    let item = serde_json::json!({
        "timing": {"after": 7},
        "rounds": [{"ms": 1}, {"ms": 2}],
        "scalar": 3,
        "nulled": null,
    });
    let read =
        |path: &str| nibi_kernel_api::workflow::read_workflow_artifact_field(&item, path);
    assert_eq!(read("timing.after"), Some(serde_json::json!(7)));
    assert_eq!(read("rounds.1.ms"), Some(serde_json::json!(2)));
    assert_eq!(read("timing"), Some(serde_json::json!({"after": 7})));
    assert_eq!(read("nulled"), Some(serde_json::Value::Null));
    assert_eq!(read("timing.missing"), None);
    assert_eq!(read("rounds.9.ms"), None);
    assert_eq!(read("scalar.deeper"), None);
    assert_eq!(read("rounds.notanumber"), None);
}

/// `ListWorkflowRuns` 的取数面：按项目 cwd 跨会话、最近更新在前、状态过滤下推、
/// 标签原料（name / script_text）随行交出。
#[test]
fn list_by_cwd_enumerates_the_project_across_sessions() {
    let (_dir, conn) = database();
    insert_run(&conn, "run_a", Some("s1"), Some("named"), "completed", None, 300);
    insert_run(&conn, "run_b", Some("s2"), None, "running", None, 200);
    insert_run(&conn, "run_c", Some("s1"), Some("old"), "failed", Some(r#"{"code":"Boom","message":"x"}"#), 100);
    conn.execute(
        "insert into dwf_run (
            id, parent_session_id, cwd, name, script_text, script_hash, args_json, tool_call_id,
            resumed_from, caps_max_concurrency, spent_tokens, status, result_json, failure_json,
            time_created, time_updated
         ) values ('run_other', 's1', '/other', null, '// x', 'hash', null, null, null, 4, 0,
                   'completed', null, null, 1, 9)",
        [],
    )
    .unwrap();
    let rows = super::list_by_cwd(&conn, "/w", 10, None).unwrap();
    assert_eq!(
        rows.iter().map(|row| row.run_id.as_str()).collect::<Vec<_>>(),
        ["run_a", "run_b", "run_c"]
    );
    assert_eq!(rows[0].name.as_deref(), Some("named"));
    assert_eq!(rows[0].script_text.as_deref(), Some("// first line"));
    assert_eq!(rows[0].parent_session_id.as_deref(), Some("s1"));
    assert_eq!(rows[0].status, "completed");
    assert_eq!(rows[0].spent_tokens, 7);
    assert_eq!(rows[2].status, "errored");
    assert_eq!(rows[2].stop_reason, None);

    let running = super::list_by_cwd(&conn, "/w", 10, Some(&["running".to_owned()])).unwrap();
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].run_id, "run_b");
    assert!(super::list_by_cwd(&conn, "/w", 10, Some(&[])).unwrap().is_empty());
    assert_eq!(super::list_by_cwd(&conn, "/w", 2, None).unwrap().len(), 2);
}

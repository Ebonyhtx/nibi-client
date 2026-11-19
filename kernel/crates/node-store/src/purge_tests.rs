//! 永久删除的存储面：自有后代与 fork、树外的附件引用、文件的清单与保留、删除凭据与一个事务删行。
#![expect(
    clippy::disallowed_methods,
    reason = "测试直接写会话的文件、查它们还在不在（模拟 Node 与 rust 写下的会话数据）"
)]

use nibi_kernel_api::deletion::{BeginOutcome, DeletionBegin, Receipt};
use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::store::{SessionOrder, SessionQuery, SessionStore};
use rusqlite::params;
use serde_json::{Value, json};

use crate::tests::{TestStore, meta};

fn insert(test: &TestStore, id: &str, parent: Option<&str>, task_type: &str, updated: i64) {
    test.connection()
        .execute(
            "insert into session(id, project_id, slug, directory, title, version, time_created, time_updated, parent_id, task_type) \
             values (?1, 'p', ?1, '/w', ?1, '1', 1, ?2, ?3, ?4)",
            params![id, updated, parent, task_type],
        )
        .unwrap();
}

/// 根 beta、它的子代理 child、从 beta 分出的 fork（fork 的 part 引用 beta 的附件 shared）、无关的 other；
/// beta 的附件目录里两个文件，另有它的模型轨迹与任务清单。
async fn seeded() -> TestStore {
    let test = TestStore::new();
    // 第一次调用打开库、补迁移
    test.store.create(meta("other", "/w", "")).await.unwrap();
    insert(&test, "beta", None, "interactive", 10);
    insert(&test, "child", Some("beta"), "subagent_child", 2);
    insert(&test, "fork", Some("beta"), "interactive", 3);
    let conn = test.connection();
    conn.execute(
        "insert into message(id, session_id, time_created, time_updated, data) values ('m', 'fork', 1, 1, '{\"role\":\"user\"}')",
        [],
    )
    .unwrap();
    conn.execute(
        "insert into part(id, message_id, session_id, time_created, time_updated, data) values ('p', 'm', 'fork', 1, 1, ?)",
        [r#"{"type":"file","url":"nibi-artifact://beta/shared"}"#],
    )
    .unwrap();
    conn.execute(
        "insert into input_history(id, project_id, session_id, text, kind, time_created) values ('h', 'p', 'child', 'x', 'prompt', 1)",
        [],
    )
    .unwrap();
    let root = test.store.paths().cli_root().as_path().to_path_buf();
    for (path, body) in [
        ("artifacts/beta/shared.png", "shared"),
        ("artifacts/beta/private.png", "private"),
        ("rollout/model-io-beta.jsonl", "{}"),
        ("artifacts/fork/own.png", "fork"),
    ] {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, body).unwrap();
    }
    test
}

/// 范围照 Node：子代理是自有后代，交互类的子会话是 fork；fork 对 beta 附件的引用列出来，引用方带标题。
#[tokio::test]
async fn the_scope_follows_node() {
    let test = seeded().await;
    let scope = test
        .store
        .deletion_scope(&SessionId::new("beta"))
        .await
        .unwrap();
    assert_eq!(
        scope.sessions,
        [SessionId::new("beta"), SessionId::new("child")]
    );
    assert_eq!(scope.workspace.unwrap().root, EnvPath::new("/w"));
    assert_eq!(scope.forks.len(), 1);
    assert_eq!(scope.forks[0].session.as_str(), "fork");
    assert_eq!(scope.references.len(), 1);
    assert_eq!(scope.references[0].session.as_str(), "beta");
    assert_eq!(scope.references[0].artifact, "shared");
    assert_eq!(scope.references[0].referrers[0].session.as_str(), "fork");
    assert_eq!(scope.stamps[0].updated_ms, 10);
    assert!(!scope.pending_work);
    assert_eq!(scope.receipt, None);

    let missing = test
        .store
        .deletion_scope(&SessionId::new("gone"))
        .await
        .unwrap();
    assert!(missing.sessions.is_empty());
    assert!(missing.workspace.is_none());
    assert_eq!(missing.receipt, None);
}

/// 旧记录里的 `zcode-artifact://` 也认（迁移 0026 的触发器两个 scheme 都挡）。
#[tokio::test]
async fn legacy_artifact_scheme_is_a_reference_too() {
    let test = seeded().await;
    test.connection()
        .execute(
            "update part set data = '{\"type\":\"file\",\"url\":\"zcode-artifact://beta/shared\"}' where id = 'p'",
            [],
        )
        .unwrap();
    let scope = test
        .store
        .deletion_scope(&SessionId::new("beta"))
        .await
        .unwrap();
    assert_eq!(scope.references.len(), 1);
    assert_eq!(scope.references[0].artifact, "shared");
}

/// Node 写下的待处理输入算在用。
#[tokio::test]
async fn a_pending_node_input_counts_as_work() {
    let test = seeded().await;
    test.connection()
        .execute(
            "insert into session_input(id, session_id, kind, delivery, payload, admitted_sequence, status, time_created, time_updated) \
             values ('q', 'child', 'prompt', 'queue', '{}', 1, 'admitted', 1, 1)",
            [],
        )
        .unwrap();
    let scope = test
        .store
        .deletion_scope(&SessionId::new("beta"))
        .await
        .unwrap();
    assert!(scope.pending_work);
}

/// 文件的清单与删除：被引用的附件留下，别的会话的文件不动；删行之后子代理与它的输入历史也没了，fork 与它的 part 还在。
#[tokio::test]
async fn files_and_rows_go_and_the_referenced_attachment_stays() {
    let test = seeded().await;
    let beta = SessionId::new("beta");
    let files = test.store.deletion_files(&beta).await.unwrap();
    let listed: Vec<(String, bool)> = files
        .iter()
        .map(|file| (file.relative_path.replace('\\', "/"), file.artifact))
        .collect();
    assert_eq!(
        listed,
        [
            ("artifacts/beta/private.png".to_owned(), true),
            ("artifacts/beta/shared.png".to_owned(), true),
            ("rollout/model-io-beta.jsonl".to_owned(), false),
        ]
    );

    test.store
        .remove_deletion_files(&beta, &["shared".to_owned()])
        .await
        .unwrap();
    let root = test.store.paths().cli_root().as_path().to_path_buf();
    assert!(root.join("artifacts/beta/shared.png").exists());
    assert!(!root.join("artifacts/beta/private.png").exists());
    assert!(!root.join("rollout/model-io-beta.jsonl").exists());
    assert!(root.join("artifacts/fork/own.png").exists());

    // 开删：每个会话一行 deleting 的凭据（照 Node `beginSessionDeletion`），列表不列它们
    let scope = test.store.deletion_scope(&beta).await.unwrap();
    let begin = DeletionBegin {
        operation: "op-1".to_owned(),
        stamps: scope.stamps.clone(),
        retained: vec![(beta.clone(), "shared".to_owned())],
    };
    assert_eq!(
        test.store.begin_deletion(&beta, &begin).await.unwrap(),
        BeginOutcome::Admitted
    );
    assert_eq!(
        test.rows("select session_id, root_id, operation_id, retained_artifacts, workspace_path, workspace_identity, state from session_purge order by session_id"),
        [
            vec![json!("beta"), json!("beta"), json!("op-1"), json!(r#"["shared"]"#), json!("/w"), Value::Null, json!("deleting")],
            vec![json!("child"), json!("beta"), json!("op-1"), json!("[]"), json!("/w"), Value::Null, json!("deleting")],
        ]
    );
    let listed: Vec<String> = test
        .store
        .query_sessions(SessionQuery {
            environment: EnvironmentId::new(crate::LOCAL_ENVIRONMENT),
            root: Some(EnvPath::new("/w")),
            order: SessionOrder::Updated,
            limit: 10,
        })
        .await
        .unwrap()
        .sessions
        .iter()
        .map(|session| session.id.as_str().to_owned())
        .collect();
    assert!(!listed.contains(&"beta".to_owned()), "{listed:?}");
    let resumed = test.store.deletion_scope(&beta).await.unwrap();
    assert_eq!(resumed.receipt, Some(Receipt::Deleting));
    assert!(!resumed.pending_work);
    // 0026 的触发器：写进删除中的会话失败（session 行与它的消息都挡）
    let blocked = test
        .connection()
        .execute("update session set title = 'again' where id = 'beta'", []);
    assert!(
        blocked
            .unwrap_err()
            .to_string()
            .contains("session-data.deleting")
    );
    let blocked = test.connection().execute(
        "insert into message(id, session_id, time_created, time_updated, data) values ('m2', 'child', 1, 1, '{}')",
        [],
    );
    assert!(
        blocked
            .unwrap_err()
            .to_string()
            .contains("session-data.deleting")
    );
    // 删除中的会话不能再开一次（已有凭据时接着删）
    let again = test.store.begin_deletion(&beta, &begin).await.unwrap();
    assert_eq!(again, BeginOutcome::Admitted);

    test.store.complete_deletion(&beta).await.unwrap();
    let ids: Vec<String> = test
        .rows("select id from session order by id")
        .into_iter()
        .map(|row| row[0].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["fork", "other"]);
    assert_eq!(test.rows("select id from part where id = 'p'").len(), 1);
    assert!(
        test.rows("select id from input_history where session_id = 'child'")
            .is_empty()
    );
    assert_eq!(
        test.rows("select state from session_purge order by session_id"),
        [vec![json!("deleted")], vec![json!("deleted")]]
    );
    // 删完：凭据说已经删完，范围是凭据里的会话，工作区取凭据记的；同一个 id 不能再建会话
    let done = test.store.deletion_scope(&beta).await.unwrap();
    assert_eq!(done.receipt, Some(Receipt::Deleted));
    assert_eq!(done.sessions, [beta.clone(), SessionId::new("child")]);
    assert_eq!(done.workspace.unwrap().root, EnvPath::new("/w"));
    assert!(test.store.create(meta("beta", "/w", "")).await.is_err());
    // 删完是幂等的
    test.store.complete_deletion(&beta).await.unwrap();
}

/// 确认之后会话变了：开删的事务里核对版本事实，不插凭据（同 Node）。
#[tokio::test]
async fn a_changed_session_is_not_admitted() {
    let test = seeded().await;
    let beta = SessionId::new("beta");
    let scope = test.store.deletion_scope(&beta).await.unwrap();
    test.connection()
        .execute("update session set time_updated = 99 where id = 'beta'", [])
        .unwrap();
    let begin = DeletionBegin {
        operation: "op".to_owned(),
        stamps: scope.stamps,
        retained: Vec::new(),
    };
    assert_eq!(
        test.store.begin_deletion(&beta, &begin).await.unwrap(),
        BeginOutcome::Changed
    );
    assert!(test.rows("select * from session_purge").is_empty());
}

/// 有 Node 写下的待处理工作时开删回 Running，不插凭据。
#[tokio::test]
async fn pending_work_refuses_to_begin() {
    let test = seeded().await;
    test.connection()
        .execute(
            "insert into session_input(id, session_id, kind, delivery, payload, admitted_sequence, status, time_created, time_updated) \
             values ('q', 'beta', 'prompt', 'queue', '{}', 1, 'admitted', 1, 1)",
            [],
        )
        .unwrap();
    let beta = SessionId::new("beta");
    let scope = test.store.deletion_scope(&beta).await.unwrap();
    let begin = DeletionBegin {
        operation: "op".to_owned(),
        stamps: scope.stamps,
        retained: Vec::new(),
    };
    assert_eq!(
        test.store.begin_deletion(&beta, &begin).await.unwrap(),
        BeginOutcome::Running
    );
    assert!(test.rows("select * from session_purge").is_empty());
}

/// 没有要留的附件时整个附件目录删掉。
#[tokio::test]
async fn without_references_the_attachment_directory_goes() {
    let test = seeded().await;
    test.store
        .remove_deletion_files(&SessionId::new("beta"), &[])
        .await
        .unwrap();
    let cli = test.store.paths().cli_root().as_path().to_path_buf();
    assert!(!cli.join("artifacts/beta").exists());
    assert!(cli.join("artifacts/fork/own.png").exists());
}

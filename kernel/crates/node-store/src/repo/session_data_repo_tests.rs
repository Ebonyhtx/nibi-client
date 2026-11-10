//! `v4/storage/sessionData/*` 的 SQL 面：附属树、引用方、分享钉住与彻底删除的行。
#![allow(
    clippy::disallowed_methods,
    reason = "测试直接检查会话库的表与会话文件"
)]

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::store::{SessionKind, SessionStore};

use crate::tests::{TestStore, batch, meta, user};

fn sid(id: &str) -> SessionId {
    SessionId::new(id)
}

async fn create(t: &TestStore, id: &str, kind: SessionKind, parent: Option<&str>) {
    let mut session = meta(id, "/w/app", "");
    session.kind = kind;
    session.parent = parent.map(SessionId::new);
    t.store.create(session).await.unwrap();
}

#[tokio::test]
async fn owned_trees_follow_auxiliary_children_but_not_forks() {
    let t = TestStore::new();
    create(&t, "sess_root", SessionKind::Interactive, None).await;
    create(&t, "sess_sub", SessionKind::Subagent, Some("sess_root")).await;
    create(&t, "sess_nested", SessionKind::Subagent, Some("sess_sub")).await;
    create(&t, "sess_fork", SessionKind::Fork, Some("sess_root")).await;
    create(
        &t,
        "sess_side",
        SessionKind::SelectionSideChat,
        Some("sess_root"),
    )
    .await;
    create(&t, "sess_other", SessionKind::Interactive, None).await;
    // workflow 子会话经 session_task_link 关联（不是 parent_id）。
    create(&t, "sess_flow", SessionKind::Subagent, None).await;
    t.connection()
        .execute(
            "insert into session_task_link (
                id, parent_session_id, child_session_id, role, depth, path, status,
                time_created, time_updated
             ) values ('link_1', 'sess_root', 'sess_flow', 'child', 1, '/flow', 'running', 1, 1)",
            [],
        )
        .unwrap();

    let trees = t
        .store
        .owned_session_trees(&[sid("sess_root"), sid("sess_missing")])
        .await
        .unwrap();
    let mut root = trees[&sid("sess_root")].clone();
    root.sort_by(|left, right| left.as_str().cmp(right.as_str()));
    assert_eq!(
        root,
        [
            "sess_flow",
            "sess_nested",
            "sess_root",
            "sess_side",
            "sess_sub"
        ]
        .map(SessionId::new)
    );
    // fork 是独立任务，不展开；别的根不串进来。
    assert!(!root.contains(&sid("sess_fork")));
    assert!(!root.contains(&sid("sess_other")));
    // 库里不存在的根回空数组：调用方按根自身清理残留文件。
    assert!(trees[&sid("sess_missing")].is_empty());
}

#[tokio::test]
async fn referrers_cover_artifacts_parents_and_task_links_but_not_deleted_sessions() {
    let t = TestStore::new();
    create(&t, "sess_a", SessionKind::Interactive, None).await;
    create(&t, "sess_b", SessionKind::Fork, Some("sess_a")).await;
    create(&t, "sess_child", SessionKind::Subagent, Some("sess_a")).await;
    create(&t, "sess_gone", SessionKind::Interactive, None).await;
    // B 的 part 里仍指向 A 的附件（fork 按值复制，URI 不改写）。
    t.store
        .commit(
            &sid("sess_b"),
            batch(
                None,
                vec![user(
                    "msg_b1",
                    "image: nibi-artifact://sess_a/tool-result-1",
                )],
            ),
        )
        .await
        .unwrap();
    // 已软删除的会话不算引用方。
    t.store
        .commit(
            &sid("sess_gone"),
            batch(None, vec![user("msg_g1", "nibi-artifact://sess_a/x")]),
        )
        .await
        .unwrap();
    t.store.delete(&sid("sess_gone")).await.unwrap();
    // 工作流链接：flow 是 A 的子会话，A 也经链接被 flow 引用。
    create(&t, "sess_flow", SessionKind::Subagent, None).await;
    t.connection()
        .execute(
            "insert into session_task_link (
                id, parent_session_id, child_session_id, role, depth, path, status,
                time_created, time_updated
             ) values ('link_1', 'sess_a', 'sess_flow', 'child', 1, '/flow', 'running', 1, 1)",
            [],
        )
        .unwrap();

    let refs = t
        .store
        .session_data_referrers(&[sid("sess_a"), sid("sess_b"), sid("sess_child")])
        .await
        .unwrap();
    let mut a: Vec<String> = refs[&sid("sess_a")]
        .iter()
        .map(|id| id.as_str().to_owned())
        .collect();
    a.sort();
    assert_eq!(a, ["sess_b", "sess_child", "sess_flow"]);
    // fork 子会话也被父会话引用（两侧都保护）。
    assert_eq!(refs[&sid("sess_b")], [sid("sess_a")]);
    assert_eq!(refs[&sid("sess_child")], [sid("sess_a")]);
    // 已软删除的引用方不在清单里。
    assert!(
        !refs[&sid("sess_a")]
            .iter()
            .any(|id| id == &sid("sess_gone"))
    );
}

#[tokio::test]
async fn shared_sessions_are_pinned() {
    let t = TestStore::new();
    create(&t, "sess_shared", SessionKind::Interactive, None).await;
    create(&t, "sess_plain", SessionKind::Interactive, None).await;
    t.connection()
        .execute(
            "update session set share_url = 'https://example.test/s/1' where id = 'sess_shared'",
            [],
        )
        .unwrap();
    assert_eq!(
        t.store
            .session_data_pinned(&[sid("sess_shared"), sid("sess_plain")])
            .await
            .unwrap(),
        [sid("sess_shared")]
    );
}

#[tokio::test]
async fn purge_removes_rows_and_explicit_tables_but_keeps_other_sessions() {
    let t = TestStore::new();
    create(&t, "sess_a", SessionKind::Interactive, None).await;
    create(&t, "sess_sub", SessionKind::Subagent, Some("sess_a")).await;
    create(&t, "sess_other", SessionKind::Interactive, None).await;
    t.store
        .commit(&sid("sess_a"), batch(None, vec![user("msg_a1", "hello")]))
        .await
        .unwrap();
    t.store
        .commit(&sid("sess_sub"), batch(None, vec![user("msg_s1", "sub")]))
        .await
        .unwrap();
    t.store
        .commit(
            &sid("sess_other"),
            batch(None, vec![user("msg_o1", "other")]),
        )
        .await
        .unwrap();
    let conn = t.connection();
    conn.execute_batch(
        "insert into input_history (id, project_id, session_id, text, kind, time_created)
           values ('h1', 'p', 'sess_a', 'x', 'prompt', 1), ('h2', 'p', 'sess_other', 'y', 'prompt', 1);
         insert into workflow_run (
           id, name, parent_session_id, cwd, script_hash, status, time_created, time_updated
         ) values ('run_1', 'r', 'sess_a', '/w', 'sha', 'completed', 1, 1);
         insert into dwf_run (
           id, parent_session_id, caps_max_concurrency, status, time_created, time_updated
         ) values ('dwf_1', 'sess_a', 1, 'completed', 1, 1);",
    )
    .unwrap();

    t.store.purge_session_rows(&[sid("sess_a")]).await.unwrap();

    let remaining: Vec<String> = t
        .rows("select id from session order by id")
        .into_iter()
        .map(|row| row[0].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(remaining, ["sess_other"]);
    assert_eq!(
        t.rows("select id from message order by id")
            .into_iter()
            .map(|row| row[0].as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ["msg_o1"]
    );
    assert_eq!(t.rows("select id from part").len(), 1);
    assert_eq!(
        t.rows("select id from input_history")
            .into_iter()
            .map(|row| row[0].as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ["h2"]
    );
    assert!(t.rows("select id from workflow_run").is_empty());
    assert!(t.rows("select id from dwf_run").is_empty());
    // 幂等：再删一次不报错。
    t.store.purge_session_rows(&[sid("sess_a")]).await.unwrap();
    assert_eq!(
        t.store.owned_session_trees(&[sid("sess_a")]).await.unwrap()[&sid("sess_a")],
        Vec::<SessionId>::new()
    );
}

#[tokio::test]
async fn a_soft_deleted_session_is_still_found_and_purged() {
    let t = TestStore::new();
    create(&t, "sess_deleted", SessionKind::Interactive, None).await;
    t.store
        .commit(
            &sid("sess_deleted"),
            batch(None, vec![user("msg_d1", "gone")]),
        )
        .await
        .unwrap();
    t.store.delete(&sid("sess_deleted")).await.unwrap();
    // 软删除的行仍展开（根存在），整棵删除时行与消息一起消失。
    assert_eq!(
        t.store
            .owned_session_trees(&[sid("sess_deleted")])
            .await
            .unwrap()[&sid("sess_deleted")],
        [sid("sess_deleted")]
    );
    t.store
        .purge_session_rows(&[sid("sess_deleted")])
        .await
        .unwrap();
    assert!(t.rows("select id from session").is_empty());
    assert!(t.rows("select id from message").is_empty());
}

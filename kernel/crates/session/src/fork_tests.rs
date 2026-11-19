use std::sync::Arc;

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::message::{Message, UserOrigin};
use nibi_kernel_api::session_api::{Ack, Command, SessionHandle};
use nibi_kernel_api::store::{Fact, SessionKind, SessionMeta, SessionStore};
use nibi_kernel_api::testing::{ScriptedModel, text_response};

use crate::test_support::{Setup, envelope, finished, submit, until};

/// fork：新会话（kind Fork、parent 原会话、Node 的 `Fork of <标题>`），消息换新 ID 复制。
#[tokio::test]
async fn forks_copy_the_active_branch_with_new_ids() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["hi"])]));
    let built = Setup::new(model).build().await;
    // 原会话标题取库里的会话行（Node `getSession`），不取 actor 内存里的空标题。
    let titled = SessionMeta {
        title: "Fix the login bug".to_owned(),
        ..crate::test_support::meta()
    };
    built.store.create(titled).await.unwrap();
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "  hello\n  world ")).await;
    until(&mut events, finished).await;
    let ack = built
        .session
        .send(envelope("f1", Command::Fork { at: None, child: None, cwd: None }))
        .await;
    let Ack::Accepted { result } = ack else {
        panic!("{ack:?}")
    };
    let child = SessionId::new(result.as_str().unwrap());
    let loaded = built.store.load(&child).await.unwrap();
    assert_eq!(loaded.meta.kind, SessionKind::Fork);
    assert_eq!(loaded.meta.parent, Some(crate::test_support::meta().id));
    assert_eq!(loaded.meta.title, "Fork of Fix the login bug");
    let original = built.session.view().await.unwrap().messages;
    assert_eq!(loaded.messages.len(), original.len());
    for (copy, source) in loaded.messages.iter().zip(&original) {
        assert_ne!(copy.id(), source.id());
    }
    assert!(matches!(&loaded.messages[0], Message::User(user) if user.origin == UserOrigin::Human));
    let facts = built.store.facts(&child);
    assert!(matches!(facts[0], Fact::ModelSelected { .. }));
}

/// 原会话行还没有标题（还没有人类输入）时用 Node `titleFromInput` 的缺省值。
#[tokio::test]
async fn a_fork_of_an_untitled_session_is_named_like_node() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let built = Setup::new(model).build().await;
    let ack = built
        .session
        .send(envelope("f1", Command::Fork { at: None, child: None, cwd: None }))
        .await;
    let Ack::Accepted { result } = ack else {
        panic!("{ack:?}")
    };
    let child = SessionId::new(result.as_str().unwrap());
    let loaded = built.store.load(&child).await.unwrap();
    assert_eq!(loaded.meta.title, "Fork of Untitled session");
}

/// K6：主回合记录 system 快照（模型身份 + system 段），fork 的子会话沿用同一份字节。
#[tokio::test]
async fn a_main_turn_records_the_prompt_snapshot_and_a_fork_copies_it() {
    use nibi_kernel_api::prompt_snapshot::{
        PROMPT_SNAPSHOT_KIND, load_prompt_snapshot, parse_prompt_snapshot,
    };
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["hi"])]));
    let built = Setup::new(model).build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "hello")).await;
    until(&mut events, finished).await;
    let session = crate::test_support::meta().id;
    let records = built
        .store
        .records(&session, PROMPT_SNAPSHOT_KIND)
        .await
        .unwrap();
    assert_eq!(records.len(), 1, "one snapshot row per session");
    let state = parse_prompt_snapshot(&records[0].data).expect("a recorded snapshot");
    let snapshot = state.present().expect("not a tombstone");
    assert!(!snapshot.system.is_empty(), "system blocks are recorded");
    assert!(!snapshot.model.model_id.is_empty());

    let ack = built
        .session
        .send(envelope("f1", Command::Fork { at: None, child: None, cwd: None }))
        .await;
    let Ack::Accepted { result } = ack else {
        panic!("{ack:?}")
    };
    let child = SessionId::new(result.as_str().unwrap());
    let copied = load_prompt_snapshot(built.store.as_ref(), &child)
        .await
        .unwrap();
    assert_eq!(
        copied,
        Some(state),
        "the fork keeps the parent system bytes"
    );
}

/// 续写时补的 assistant（session-lifecycle.md §6.3.1）：复制到新会话时不带它（新会话打开时再补）。
#[test]
fn the_resume_reply_is_not_copied() {    use nibi_kernel_api::ids::MessageId;
    use nibi_kernel_api::message::{ContentBlock, UserMessage};
    use nibi_kernel_api::testing::SequentialIds;
    let input = |id: &str| {
        Message::User(UserMessage {
            id: MessageId::new(id),
            content: vec![ContentBlock::Text {
                text: "hi".to_owned(),
            }],
            origin: UserOrigin::Human,
        })
    };
    let messages = vec![
        input("u1"),
        crate::resume_sentinel::sentinel(MessageId::new("a0")),
        input("u2"),
    ];
    let copied = super::copy(&messages, &SequentialIds::default());
    assert_eq!(copied.len(), 2, "{copied:?}");
    assert!(
        copied
            .iter()
            .all(|message| matches!(message, Message::User(_)))
    );
}

/// Host 预分配 child ID + 目标 cwd（受管 worktree）：child 留在同一父链，执行根换成目标目录。
#[tokio::test]
async fn fork_with_target_cwd_uses_the_host_child_id_and_directory() {
    use nibi_kernel_api::env::EnvPath;

    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let built = Setup::new(model).build().await;
    let child = SessionId::new("sess_worktree_child");
    let ack = built
        .session
        .send(envelope(
            "f1",
            Command::Fork {
                at: None,
                child: Some(child.clone()),
                cwd: Some(EnvPath::new("/worktrees/3f2a/repo/packages/ui")),
            },
        ))
        .await;
    let Ack::Accepted { result } = ack else {
        panic!("{ack:?}")
    };
    assert_eq!(result.as_str(), Some(child.as_str()));
    let loaded = built.store.load(&child).await.unwrap();
    assert_eq!(
        loaded.meta.workspace.root,
        EnvPath::new("/worktrees/3f2a/repo/packages/ui")
    );
    assert_eq!(loaded.meta.parent, Some(crate::test_support::meta().id));
    assert_eq!(loaded.meta.kind, SessionKind::Fork);
}

/// 预分配 child ID 已存在时显式拒绝（不能覆盖既有会话）。
#[tokio::test]
async fn fork_rejects_an_existing_host_child_id() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let built = Setup::new(model).build().await;
    let child = SessionId::new("sess_duplicate_child");
    let first = built
        .session
        .send(envelope(
            "f1",
            Command::Fork {
                at: None,
                child: Some(child.clone()),
                cwd: None,
            },
        ))
        .await;
    assert!(matches!(first, Ack::Accepted { .. }));
    let second = built
        .session
        .send(envelope(
            "f2",
            Command::Fork {
                at: None,
                child: Some(child),
                cwd: None,
            },
        ))
        .await;
    let Ack::Rejected { reason } = second else {
        panic!("{second:?}")
    };
    assert!(reason.contains("already exists"), "{reason}");
}

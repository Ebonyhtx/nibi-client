//! 队列编辑（NIBI queue 命令组）：编辑、删除、重排、自动排空、立刻发送。

use nibi_kernel_base::TaskScope;
use nibi_kernel_api::ids::CommandId;
use nibi_kernel_api::session_api::{Command, Delivery, KernelEvent};

use super::tests::{answer, asked, asking_session, until_finished};
use super::*;

fn submit(id: &str, text: &str) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::Submit {
            text: text.to_owned(),
            attachments: Vec::new(),
            delivery: Delivery::Queue,
        },
    }
}

fn queue_op(id: &str, command: Command) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command,
    }
}

/// 读队列（`view()` 是 async）：测试本身在 tokio 运行时里，直接 await。
async fn view_queue(session: &Session) -> Vec<String> {
    session
        .view()
        .await
        .unwrap()
        .queue
        .into_iter()
        .map(|item| item.text)
        .collect()
}

async fn view_edit_locks(session: &Session) -> Vec<(String, Option<String>)> {
    session
        .view()
        .await
        .unwrap()
        .queue
        .into_iter()
        .map(|item| {
            (
                item.command.as_str().to_owned(),
                item.edit_lock.map(|lock| lock.editor_id),
            )
        })
        .collect()
}

fn rejected_with(ack: &nibi_kernel_api::session_api::Ack, code: &str) -> bool {
    matches!(ack, nibi_kernel_api::session_api::Ack::Rejected { reason } if reason.starts_with(code))
}

#[tokio::test]
async fn queued_items_can_be_edited_reordered_and_deleted() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, _model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    // 等第一轮开跑（工具在等回答）后把两项排进队列。
    let asked = asked(&mut events).await;
    session.send(submit("c2", "second")).await;
    session.send(submit("c3", "third")).await;
    assert_eq!(view_queue(&session).await, ["second", "third"]);

    // 编辑：原文替换，位置不变。
    let ack = session
        .send(queue_op(
            "c4",
            Command::EditQueued {
                item: CommandId::new("c2"),
                text: "second edited".to_owned(),
                editor_id: None,
            },
        ))
        .await;
    assert!(matches!(ack, nibi_kernel_api::session_api::Ack::Accepted { .. }));
    assert_eq!(view_queue(&session).await, ["second edited", "third"]);

    // 重排：把 c3 移到 c2 之前。
    session
        .send(queue_op(
            "c5",
            Command::ReorderQueued {
                item: CommandId::new("c3"),
                before: Some(CommandId::new("c2")),
            },
        ))
        .await;
    assert_eq!(view_queue(&session).await, ["third", "second edited"]);

    // 队列项不存在：拒绝（协议层按 noop 上行）。
    let missing = session
        .send(queue_op(
            "c6",
            Command::DeleteQueued {
                item: CommandId::new("nope"),
            },
        ))
        .await;
    assert!(matches!(
        missing,
        nibi_kernel_api::session_api::Ack::Rejected { .. }
    ));

    // 删除。
    session
        .send(queue_op(
            "c7",
            Command::DeleteQueued {
                item: CommandId::new("c3"),
            },
        ))
        .await;
    assert_eq!(view_queue(&session).await, ["second edited"]);

    // 收尾：回答交互，回合结束。
    session.send(answer("c8", asked)).await;
    until_finished(&mut events, 1).await;
}

#[tokio::test]
async fn auto_drain_off_holds_the_queue_until_resumed() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let asked = asked(&mut events).await;
    session.send(submit("c2", "held back")).await;
    session
        .send(queue_op("c3", Command::SetAutoDrain { enabled: false }))
        .await;
    let _ = &model;
    session.send(answer("c4", asked)).await;
    let seen = until_finished(&mut events, 1).await;
    // 回合结束后队列不自动开：没有为排队项开回合，项还在。
    assert!(!seen.iter().any(|event| matches!(
        event,
        KernelEvent::TurnStarted { command: Some(command), .. } if command.as_str() == "c2"
    )));
    assert_eq!(view_queue(&session).await, ["held back"]);
    // 打开自动排空：空闲时立刻开队首。
    session
        .send(queue_op("c5", Command::SetAutoDrain { enabled: true }))
        .await;
    // `until_finished` 从当前位置数：这里只要再等一个回合收尾。
    let seen = until_finished(&mut events, 1).await;
    assert!(seen.iter().any(|event| matches!(
        event,
        KernelEvent::TurnStarted { command: Some(command), .. } if command.as_str() == "c2"
    )));
    assert!(view_queue(&session).await.is_empty());
}

#[tokio::test]
async fn send_queued_now_preempts_the_running_turn() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let _asked = asked(&mut events).await;
    session.send(submit("c2", "send me now")).await;
    let ack = session
        .send(queue_op(
            "c3",
            Command::SendQueuedNow {
                item: CommandId::new("c2"),
            },
        ))
        .await;
    assert!(matches!(ack, nibi_kernel_api::session_api::Ack::Accepted { .. }));
    // 抢占的回合收尾后，被提升的输入开新回合（脚本模型的第二条回复），队列清空。
    let seen = until_finished(&mut events, 2).await;
    assert!(seen.iter().any(|event| matches!(
        event,
        KernelEvent::TurnStarted { command: Some(command), .. } if command.as_str() == "c2"
    )));
    assert!(view_queue(&session).await.is_empty());
    assert!(model
        .requests()
        .iter()
        .any(|request| format!("{:?}", request.messages).contains("send me now")));
}

/// U36：加锁只允许 queued + 未加锁；有锁时删除/重排/立即发送/无匹配 editor 的编辑都拒绝；
/// 成功编辑自动释放；释放幂等。
#[tokio::test]
async fn queue_edit_lock_guards_mutations_and_releases_on_edit() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, _model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let asked = asked(&mut events).await;
    session.send(submit("c2", "second")).await;
    session.send(submit("c3", "third")).await;
    assert_eq!(view_queue(&session).await, ["second", "third"]);

    // 加锁：editor-a 成功；editor-b 撞锁。
    let locked = session
        .send(queue_op(
            "c4",
            Command::LockQueueItemEdit {
                item: CommandId::new("c2"),
                editor_id: "editor-a".to_owned(),
                client_id: "desktop".to_owned(),
                input_origin: Some("desktop".to_owned()),
            },
        ))
        .await;
    assert!(matches!(locked, nibi_kernel_api::session_api::Ack::Accepted { .. }));
    assert_eq!(
        view_edit_locks(&session).await,
        [
            ("c2".to_owned(), Some("editor-a".to_owned())),
            ("c3".to_owned(), None),
        ]
    );
    let second_lock = session
        .send(queue_op(
            "c5",
            Command::LockQueueItemEdit {
                item: CommandId::new("c2"),
                editor_id: "editor-b".to_owned(),
                client_id: "mobile".to_owned(),
                input_origin: Some("mobile".to_owned()),
            },
        ))
        .await;
    assert!(rejected_with(&second_lock, "guard.queueItemEditLocked"));

    // 有锁时删除/重排/立即发送都拒绝。
    for (id, command) in [
        (
            "c6",
            Command::DeleteQueued {
                item: CommandId::new("c2"),
            },
        ),
        (
            "c7",
            Command::ReorderQueued {
                item: CommandId::new("c2"),
                before: Some(CommandId::new("c3")),
            },
        ),
        (
            "c8",
            Command::SendQueuedNow {
                item: CommandId::new("c2"),
            },
        ),
    ] {
        let ack = session.send(queue_op(id, command)).await;
        assert!(rejected_with(&ack, "guard.queueItemEditLocked"), "{id}");
    }
    assert_eq!(view_queue(&session).await, ["second", "third"]);

    // 无 editor 的旧路径不能覆盖锁；错误 editor 是锁已丢失；正确 editor 编辑成功并释放。
    let legacy = session
        .send(queue_op(
            "c9",
            Command::EditQueued {
                item: CommandId::new("c2"),
                text: "legacy edit".to_owned(),
                editor_id: None,
            },
        ))
        .await;
    assert!(rejected_with(&legacy, "guard.queueItemEditLocked"));
    let stolen = session
        .send(queue_op(
            "c10",
            Command::EditQueued {
                item: CommandId::new("c2"),
                text: "not mine".to_owned(),
                editor_id: Some("editor-b".to_owned()),
            },
        ))
        .await;
    assert!(rejected_with(&stolen, "guard.queueEditLockLost"));
    let edited = session
        .send(queue_op(
            "c11",
            Command::EditQueued {
                item: CommandId::new("c2"),
                text: "second edited".to_owned(),
                editor_id: Some("editor-a".to_owned()),
            },
        ))
        .await;
    assert!(matches!(edited, nibi_kernel_api::session_api::Ack::Accepted { .. }));
    assert_eq!(view_queue(&session).await, ["second edited", "third"]);
    assert_eq!(view_edit_locks(&session).await[0], ("c2".to_owned(), None));
    // 编辑成功后锁已释放：同一个 editor 再编辑找不到锁。
    let lost = session
        .send(queue_op(
            "c12",
            Command::EditQueued {
                item: CommandId::new("c2"),
                text: "again".to_owned(),
                editor_id: Some("editor-a".to_owned()),
            },
        ))
        .await;
    assert!(rejected_with(&lost, "queue.editLockMissing"));

    // 释放：任意端都可以；锁不存在时幂等成功。
    session
        .send(queue_op(
            "c13",
            Command::LockQueueItemEdit {
                item: CommandId::new("c3"),
                editor_id: "editor-b".to_owned(),
                client_id: "mobile".to_owned(),
                input_origin: None,
            },
        ))
        .await;
    let released = session
        .send(queue_op(
            "c14",
            Command::ReleaseQueueItemEdit {
                item: CommandId::new("c3"),
            },
        ))
        .await;
    assert!(matches!(released, nibi_kernel_api::session_api::Ack::Accepted { .. }));
    let released_again = session
        .send(queue_op(
            "c15",
            Command::ReleaseQueueItemEdit {
                item: CommandId::new("c3"),
            },
        ))
        .await;
    assert!(matches!(released_again, nibi_kernel_api::session_api::Ack::Accepted { .. }));
    assert_eq!(view_edit_locks(&session).await[1], ("c3".to_owned(), None));

    // 收尾：回答交互，回合结束。
    session.send(answer("c16", asked)).await;
    until_finished(&mut events, 1).await;
}

/// U36：自动排空不开加锁的队首；锁释放后由命令处理完的 settle 立即接着开。
#[tokio::test]
async fn auto_drain_skips_a_locked_queue_head_until_released() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, _model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let asked = asked(&mut events).await;
    session.send(submit("c2", "locked head")).await;
    session
        .send(queue_op(
            "c3",
            Command::LockQueueItemEdit {
                item: CommandId::new("c2"),
                editor_id: "editor-a".to_owned(),
                client_id: "desktop".to_owned(),
                input_origin: None,
            },
        ))
        .await;
    session.send(answer("c4", asked)).await;
    let seen = until_finished(&mut events, 1).await;
    assert!(!seen.iter().any(|event| matches!(
        event,
        KernelEvent::TurnStarted { command: Some(command), .. } if command.as_str() == "c2"
    )));
    assert_eq!(view_queue(&session).await, ["locked head"]);

    // 释放后 autoDrain 仍是开的：命令处理完的 settle 直接开队首。
    session
        .send(queue_op(
            "c5",
            Command::ReleaseQueueItemEdit {
                item: CommandId::new("c2"),
            },
        ))
        .await;
    let seen = until_finished(&mut events, 1).await;
    assert!(seen.iter().any(|event| matches!(
        event,
        KernelEvent::TurnStarted { command: Some(command), .. } if command.as_str() == "c2"
    )));
    assert!(view_queue(&session).await.is_empty());
}

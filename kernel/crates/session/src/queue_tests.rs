//! 队列编辑（NIBI queue 命令组）：编辑、删除、重排、自动排空、立刻发送。

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::CommandId;
use rust_cli_kernel_api::session_api::{Command, Delivery, KernelEvent};

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
            },
        ))
        .await;
    assert!(matches!(ack, rust_cli_kernel_api::session_api::Ack::Accepted { .. }));
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
        rust_cli_kernel_api::session_api::Ack::Rejected { .. }
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
    assert!(matches!(ack, rust_cli_kernel_api::session_api::Ack::Accepted { .. }));
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

//! 升级停驻表：park/notify/resolve、per-ask 预算、取消撤下与跨会话作答。

use std::sync::{Arc, Mutex, PoisonError};

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_kernel_api::workflow::{
    WorkflowEscalation, WorkflowEscalationOutcome, WorkflowEscalationRequest, WorkflowNotices,
    WorkflowQuestionResolved,
};

use super::*;

#[derive(Default)]
struct Recording {
    sent: Mutex<Vec<(String, String)>>,
}

impl WorkflowNotices for Recording {
    fn notify(&self, session: &SessionId, text: String) {
        self.sent
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((session.as_str().to_owned(), text));
    }
}

fn registry() -> (Arc<WorkflowEscalations>, Arc<Recording>) {
    let registry = Arc::new(WorkflowEscalations::new(Arc::new(FixedClock(1_000))));
    let notifier = Arc::new(Recording::default());
    registry.attach_notifier(notifier.clone());
    (registry, notifier)
}

fn request(parent: &str) -> WorkflowEscalationRequest {
    WorkflowEscalationRequest {
        parent: parent.to_owned(),
        run_id: "dwfrun-0123456789abcdef".to_owned(),
        actor: "worker#1@1".to_owned(),
        actor_name: Some("worker".to_owned()),
        ask: "worker#1@1".to_owned(),
        question: "Which way?".to_owned(),
        context: Some("tried both".to_owned()),
    }
}

/// 等到停驻表里出现第一个问题，返回它的 qid。
async fn wait_parked(registry: &Arc<WorkflowEscalations>) -> String {
    for _ in 0..500 {
        if let Some(question) = registry.pending(&SessionId::new("sess_parent")).first() {
            return question.qid.clone();
        }
        tokio::task::yield_now().await;
    }
    panic!("the escalation was never parked");
}

#[tokio::test]
async fn an_escalation_parks_notifies_and_is_answered() {
    let (registry, notifier) = registry();
    let port = Arc::new(EscalationPort(registry.clone()));
    let waiter = tokio::spawn(async move { port.escalate(request("sess_parent")).await });

    let qid = wait_parked(&registry).await;
    assert!(qid.starts_with("dwfq-"), "qid={qid}");
    {
        let sent = notifier.sent.lock().unwrap_or_else(PoisonError::into_inner);
        let (session, text) = sent.first().expect("one notification");
        assert_eq!(session, "sess_parent");
        assert!(text.contains(&qid), "notification carries the qid");
        assert!(text.contains("Which way?"));
        assert!(text.contains("ResolveWorkflowQuestion"));
    }

    let answered = registry.resolve_question(&SessionId::new("sess_parent"), &qid, "that way");
    assert_eq!(
        answered,
        WorkflowQuestionResolved::Answered { qid: qid.clone() }
    );
    match waiter.await.unwrap() {
        WorkflowEscalationOutcome::Answered { answer, qid: answered } => {
            assert_eq!(answer, "that way");
            assert_eq!(answered, qid);
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
    assert!(registry.pending(&SessionId::new("sess_parent")).is_empty());
    match registry.resolve_question(&SessionId::new("sess_parent"), &qid, "again") {
        WorkflowQuestionResolved::Rejected { reason, .. } => {
            assert_eq!(reason, "already_resolved");
        }
        other => panic!("unexpected resolve: {other:?}"),
    }
}

#[tokio::test]
async fn the_fourth_escalation_in_one_ask_is_refused_without_parking() {
    let (registry, _) = registry();
    for _ in 0..3 {
        let port = Arc::new(EscalationPort(registry.clone()));
        let waiter = tokio::spawn(async move { port.escalate(request("sess_parent")).await });
        let qid = wait_parked(&registry).await;
        let _ = registry.resolve_question(&SessionId::new("sess_parent"), &qid, "ok");
        assert!(matches!(
            waiter.await.unwrap(),
            WorkflowEscalationOutcome::Answered { .. }
        ));
    }
    let port = Arc::new(EscalationPort(registry.clone()));
    match port.escalate(request("sess_parent")).await {
        WorkflowEscalationOutcome::Refused { reason, message } => {
            assert_eq!(reason, "budget_exhausted");
            assert!(message.contains("Proceed on your best judgement"));
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
    assert!(registry.pending(&SessionId::new("sess_parent")).is_empty());

    // 另一个 ask 重新计数：预算按 (run, ask) 而不是按 run。
    let mut other = request("sess_parent");
    other.ask = "worker#1@2".to_owned();
    let port = Arc::new(EscalationPort(registry.clone()));
    let waiter = tokio::spawn(async move { port.escalate(other).await });
    let qid = wait_parked(&registry).await;
    let _ = registry.resolve_question(&SessionId::new("sess_parent"), &qid, "fine");
    assert!(matches!(
        waiter.await.unwrap(),
        WorkflowEscalationOutcome::Answered { .. }
    ));
}

#[tokio::test]
async fn dropping_the_escalation_withdraws_it_and_later_answers_are_rejected() {
    let (registry, _) = registry();
    let port = Arc::new(EscalationPort(registry.clone()));
    let waiter = tokio::spawn(async move { port.escalate(request("sess_parent")).await });
    let qid = wait_parked(&registry).await;
    waiter.abort();
    for _ in 0..500 {
        if registry.pending(&SessionId::new("sess_parent")).is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(registry.pending(&SessionId::new("sess_parent")).is_empty());
    match registry.resolve_question(&SessionId::new("sess_parent"), &qid, "late") {
        WorkflowQuestionResolved::Rejected { reason, .. } => {
            assert_eq!(reason, "run_not_in_flight");
        }
        other => panic!("unexpected resolve: {other:?}"),
    }
}

#[tokio::test]
async fn another_session_cannot_answer_a_question_it_does_not_own() {
    let (registry, _) = registry();
    let port = Arc::new(EscalationPort(registry.clone()));
    let waiter = tokio::spawn(async move { port.escalate(request("sess_parent")).await });
    let qid = wait_parked(&registry).await;
    match registry.resolve_question(&SessionId::new("sess_other"), &qid, "not mine") {
        WorkflowQuestionResolved::Rejected { reason, .. } => {
            assert_eq!(reason, "unknown_question");
        }
        other => panic!("unexpected resolve: {other:?}"),
    }
    // 原问题仍在等：它的父会话仍然答得上。
    assert_eq!(registry.pending(&SessionId::new("sess_parent")).len(), 1);
    let _ = registry.resolve_question(&SessionId::new("sess_parent"), &qid, "mine");
    assert!(matches!(
        waiter.await.unwrap(),
        WorkflowEscalationOutcome::Answered { .. }
    ));
}

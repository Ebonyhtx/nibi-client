//! 升级停驻表：park/notify/resolve、per-ask 预算、取消撤下与跨会话作答；
//! journal 双轨（durable 轨的事件载荷与两条拒绝路径的取舍）。

use std::sync::{Arc, Mutex, PoisonError};

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::StoreError;
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_kernel_api::workflow::{
    WorkflowEscalation, WorkflowEscalationOutcome, WorkflowEscalationRequest, WorkflowEventJournal,
    WorkflowNotices, WorkflowQuestionResolved,
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

/// journal 假件：记下 (run, type, payload)；`fail_types` 里的类型 append 返回 Unsupported
/// （按类型失败——raise 失败会直接拒绝不停驻，resolve 失败才走到「warn 后照送」）。
#[derive(Default)]
struct FakeJournal {
    appended: Mutex<Vec<(String, String, String)>>,
    fail_types: Mutex<Vec<String>>,
}

impl FakeJournal {
    fn failing(types: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            appended: Mutex::new(Vec::new()),
            fail_types: Mutex::new(types.iter().map(|name| (*name).to_owned()).collect()),
        })
    }
}

#[async_trait::async_trait]
impl WorkflowEventJournal for FakeJournal {
    async fn append_event(
        &self,
        run_id: &str,
        event_type: &str,
        payload_json: String,
    ) -> Result<(), StoreError> {
        if self
            .fail_types
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .any(|name| name == event_type)
        {
            // 真故障（SQLite/IO），不是「没有能力」——后者要走内存回退（park 照常）。
            return Err(StoreError::Storage {
                message: "journal unavailable".to_owned(),
            });
        }
        self.appended
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((run_id.to_owned(), event_type.to_owned(), payload_json));
        Ok(())
    }
}

/// 「没有 journal 能力」的存储（`SessionStore` 缺省实现的形状）。
struct UnsupportedJournal;

#[async_trait::async_trait]
impl WorkflowEventJournal for UnsupportedJournal {
    async fn append_event(
        &self,
        _run_id: &str,
        _event_type: &str,
        _payload_json: String,
    ) -> Result<(), StoreError> {
        Err(StoreError::Unsupported {
            what: "workflow event journal".to_owned(),
        })
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

    let answered = registry
        .resolve_question(&SessionId::new("sess_parent"), &qid, "that way")
        .await;
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
    match registry
        .resolve_question(&SessionId::new("sess_parent"), &qid, "again")
        .await
    {
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
        let _ = registry
            .resolve_question(&SessionId::new("sess_parent"), &qid, "ok")
            .await;
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
    let _ = registry
            .resolve_question(&SessionId::new("sess_parent"), &qid, "fine")
            .await;
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
    match registry
        .resolve_question(&SessionId::new("sess_parent"), &qid, "late")
        .await
    {
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
    match registry
        .resolve_question(&SessionId::new("sess_other"), &qid, "not mine")
        .await
    {
        WorkflowQuestionResolved::Rejected { reason, .. } => {
            assert_eq!(reason, "unknown_question");
        }
        other => panic!("unexpected resolve: {other:?}"),
    }
    // 原问题仍在等：它的父会话仍然答得上。
    assert_eq!(registry.pending(&SessionId::new("sess_parent")).len(), 1);
    let _ = registry
            .resolve_question(&SessionId::new("sess_parent"), &qid, "mine")
            .await;
    assert!(matches!(
        waiter.await.unwrap(),
        WorkflowEscalationOutcome::Answered { .. }
    ));
}

/// 双轨 record（Node driver 的 journal + emit）：raise 与 resolve 各落一条 `dwf_event` 载荷
/// （整个 RunEvent 的 JSON，含 type、camelCase、askedAt 用停驻的同一瞬间）；journal 写不进时
/// 两条路径的取舍与 Node 相反相成——raise 撤回并拒绝，resolve 记账后答案照送。
#[tokio::test]
async fn escalations_are_journaled_on_both_tracks() {
    let (journaled, _) = registry();
    let journal = Arc::new(FakeJournal::default());
    journaled.attach_journal(journal.clone());
    let port = Arc::new(EscalationPort(journaled.clone()));
    let waiter = tokio::spawn(async move { port.escalate(request("sess_parent")).await });
    let qid = wait_parked(&journaled).await;
    let _ = journaled
        .resolve_question(&SessionId::new("sess_parent"), &qid, "that way")
        .await;
    assert!(matches!(
        waiter.await.unwrap(),
        WorkflowEscalationOutcome::Answered { .. }
    ));

    let appended = journal
        .appended
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let types: Vec<&str> = appended.iter().map(|(_, event_type, _)| event_type.as_str()).collect();
    assert_eq!(types, ["escalation-raised", "escalation-resolved"]);
    let raised: serde_json::Value =
        serde_json::from_str(&appended[0].2).expect("raised payload is JSON");
    assert_eq!(raised["type"], "escalation-raised");
    assert_eq!(raised["qid"], qid);
    // Node 的事件带结构化 ActorRef（`{siteId, ordinal}`），不是 `site@ordinal` 字符串。
    assert_eq!(raised["actor"]["siteId"], "worker#1");
    assert_eq!(raised["actor"]["ordinal"], 1);
    assert_eq!(raised["actorName"], "worker");
    assert_eq!(raised["question"], "Which way?");
    assert_eq!(raised["context"], "tried both");
    assert_eq!(raised["askedAt"], 1_000);
    let resolved: serde_json::Value =
        serde_json::from_str(&appended[1].2).expect("resolved payload is JSON");
    assert_eq!(resolved["type"], "escalation-resolved");
    assert_eq!(resolved["qid"], qid);
    assert_eq!(resolved["answer"], "that way");

    // raise 路径写不进去：撤回登记、按拒绝收口、问题不进停驻表（谁也看不见的停驻不诚实）。
    let (refused_registry, _) = registry();
    refused_registry.attach_journal(FakeJournal::failing(&["escalation-raised"]));
    match EscalationPort(refused_registry.clone())
        .escalate(request("sess_parent"))
        .await
    {
        WorkflowEscalationOutcome::Refused { reason, message } => {
            assert_eq!(reason, "journal_write_failed");
            assert!(message.contains("could not be recorded"));
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
    assert!(refused_registry
        .pending(&SessionId::new("sess_parent"))
        .is_empty());

    // 「没有 journal 能力」不是故障（Node 引擎自带内存回退的同义）：停驻照常、只剩通知轨。
    let (memory_registry, _) = registry();
    memory_registry.attach_journal(Arc::new(UnsupportedJournal));
    let port = Arc::new(EscalationPort(memory_registry.clone()));
    let waiter = tokio::spawn(async move { port.escalate(request("sess_parent")).await });
    let qid = wait_parked(&memory_registry).await;
    assert_eq!(
        memory_registry
            .resolve_question(&SessionId::new("sess_parent"), &qid, "still answered")
            .await,
        WorkflowQuestionResolved::Answered { qid }
    );
    assert!(matches!(
        waiter.await.unwrap(),
        WorkflowEscalationOutcome::Answered { answer, .. } if answer == "still answered"
    ));

    // resolve 路径写不进去：warn 之后答案照送（actor 已经在等，为一条观察事件把它挂住更坏）。
    let (warned_registry, _) = registry();
    warned_registry.attach_journal(FakeJournal::failing(&["escalation-resolved"]));
    let port = Arc::new(EscalationPort(warned_registry.clone()));
    let waiter = tokio::spawn(async move { port.escalate(request("sess_parent")).await });
    let qid = wait_parked(&warned_registry).await;
    assert_eq!(
        warned_registry
            .resolve_question(&SessionId::new("sess_parent"), &qid, "still delivered")
            .await,
        WorkflowQuestionResolved::Answered { qid }
    );
    assert!(matches!(
        waiter.await.unwrap(),
        WorkflowEscalationOutcome::Answered { answer, .. } if answer == "still delivered"
    ));
}

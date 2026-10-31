//! DWF 升级问答的停驻注册表（Node 的 `workflow-escalation-registry` 同义）。
//!
//! actor 的 `escalate` 停在这里（它持有 ask 轮的上下文），作答入口是主会话的
//! `ResolveWorkflowQuestion` 工具——两者之间需要一张按 qid 查的表。本模块就是那张表：
//! 无 I/O、无持久化、无引擎知识。
//!
//! **纯内存，与停驻的 future 同命**。进程亡故后没有人在等，一张持久化的表只会说谎；自愈靠
//! resume——那个 ask 会 live 重跑，actor 重新提问并得到一个新 qid，而陈旧 id 拿到结构化拒绝。
//!
//! 作用域是整个内核（app-server 里多个会话共用一张表），所以：qid 铸造成全局唯一；作答按
//! **父会话**收口（跨会话的 qid 一律按 `unknown_question` 拒绝，与 Node 的「每个 app 实例
//! 一张表」同一条纪律）；`pending` 只列出本会话名下的问题。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::json;
use tokio::sync::oneshot;

use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{SessionStore, StoreError};
use rust_cli_kernel_api::workflow::{
    WorkflowEscalation, WorkflowEscalationOutcome, WorkflowEscalationRequest, WorkflowEventJournal,
    WorkflowNotices, WorkflowQuestion, WorkflowQuestionResolved, WorkflowQuestions,
    WorkflowRunDetail, WorkflowRunIntrospection, WorkflowRunPendingQuestion,
};

/// 一次 ask 内的升级次数上限（与 Node 的 `MAX_ESCALATIONS_PER_ASK` 同值）。
const MAX_ESCALATIONS_PER_ASK: u32 = 3;

/// 已退场 qid 的记忆条数：**有界**。长跑的会话可以问答任意多次，无界的历史表就是一处静默
/// 增长的内存；被逐出之后作答只会得到 `unknown_question`——诚实的退化。
const RETIRED_HISTORY_LIMIT: usize = 256;

/// 预算耗尽时回给模型的工具结果文案（普通结果，不是错误；与 Node 逐字相同）。
const BUDGET_EXHAUSTED: &str = "Escalation budget exhausted: at most 3 escalations per task. \
Do not call escalate again. Proceed on your best judgement with the information you have, \
and state in your final result the assumptions you relied on and the doubts that remain.";

/// 无在飞 ask：问题无处停驻（不应发生，但绝不悬挂）。
const NO_ACTIVE_ASK: &str =
    "No ask is in flight, so there is nowhere to park this question and nobody would answer it. \
Escalate only while working on an ask.";

#[derive(Clone, Copy, PartialEq, Eq)]
enum RetiredReason {
    Resolved,
    Withdrawn,
}

struct Parked {
    question: WorkflowQuestion,
    tx: oneshot::Sender<String>,
}

#[derive(Default)]
struct Inner {
    /// qid → 停驻项。
    parked: HashMap<String, Parked>,
    /// 提问顺序（`pending` 直接依赖它，不另存序号）；只含停驻中的 qid。
    order: Vec<String>,
    /// 已退场 qid → (原因, 父会话)。
    retired: HashMap<String, (RetiredReason, SessionId)>,
    retired_order: Vec<String>,
    /// 每个 run 的 qid 序号（qid 的第二段）。
    next_seq: HashMap<String, u64>,
    /// per-ask 的升级计数：`(runId, ask)` → 已用次数。
    budget: HashMap<(String, String), u32>,
}

/// 停驻注册表（`escalate` 与 `ResolveWorkflowQuestion` 的唯一连线）。
pub struct WorkflowEscalations {
    inner: Mutex<Inner>,
    /// 把升级提示送进父会话的通知通道；`Agents` 建好之后接上。
    notifier: Mutex<Option<Arc<dyn WorkflowNotices>>>,
    /// run 事件 journal（`dwf_event`）：升级问答双轨 record 的 durable 轨（Node driver 的
    /// `record`）。缺席时只剩通知轨——注册表本身仍然工作，只是冷回放看不到这段问答。
    journal: Mutex<Option<Arc<dyn WorkflowEventJournal>>>,
    /// run 行的只读面（`workflow_run_detail` 的标签链：name → 脚本首行 → runId）——通知的
    /// originMeta 展示名按它兜底（Node registry.description 同源）。缺席落 runId。
    store: Mutex<Option<Arc<dyn SessionStore>>>,
    clock: Arc<dyn Clock>,
}

impl WorkflowEscalations {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            notifier: Mutex::new(None),
            journal: Mutex::new(None),
            store: Mutex::new(None),
            clock,
        }
    }

    /// 接上通知通道（`Agents` 是唯一的生产者：走子代理通知同一条 `task-notification` 路）。
    pub fn attach_notifier(&self, notifier: Arc<dyn WorkflowNotices>) {
        *self
            .notifier
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(notifier);
    }

    /// 接上事件 journal（`SessionStore::append_workflow_event` 的本机实现）。
    pub fn attach_journal(&self, journal: Arc<dyn WorkflowEventJournal>) {
        *self.journal.lock().unwrap_or_else(PoisonError::into_inner) = Some(journal);
    }

    fn journal(&self) -> Option<Arc<dyn WorkflowEventJournal>> {
        self.journal
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 接上 run 行的只读面（originMeta 展示名的兜底链）。
    pub fn attach_store(&self, store: Arc<dyn SessionStore>) {
        *self.store.lock().unwrap_or_else(PoisonError::into_inner) = Some(store);
    }

    fn store(&self) -> Option<Arc<dyn SessionStore>> {
        self.store.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 本会话名下还欠答案的问题（按提问顺序）。
    pub fn pending(&self, session: &SessionId) -> Vec<WorkflowQuestion> {
        let inner = self.lock();
        inner
            .order
            .iter()
            .filter_map(|qid| inner.parked.get(qid))
            .filter(|parked| parked.question.parent == session.as_str())
            .map(|parked| parked.question.clone())
            .collect()
    }

    /// 结算一个停驻项（三类结构化拒绝各自陈述现状与下一步；文案与 Node 逐字相同）。
    ///
    /// 拆成两半：[`Self::detach`] 校验并摘下（退场记录当场写），journal 落库之后调用方把
    /// 答案经 [`Self::deliver`] 送进停驻的 future——Node `respondToParkedEscalation` 的
    /// 「先 record 再 resolve」同一顺序，写不进去也只是观察事件缺失，答案照送。
    pub async fn resolve_question(
        &self,
        session: &SessionId,
        qid: &str,
        answer: &str,
    ) -> WorkflowQuestionResolved {
        let (question, tx) = match self.detach(session, qid) {
            Ok(pair) => pair,
            Err(rejected) => return rejected,
        };
        if let Some(journal) = self.journal()
            && let Err(error) = journal
                .append_event(
                    &question.run_id,
                    "escalation-resolved",
                    resolved_payload(&question.qid, answer),
                )
                .await
            && !matches!(error, StoreError::Unsupported { .. })
        {
            // 真故障才记 warn；没有 journal 能力的存储（TUI / 内存）安静跳过。
            tracing::warn!(
                event = "dynamic_workflow.escalation.resolved_journal_failed",
                %error,
                qid,
                run = %question.run_id,
                "Dynamic workflow escalation resolved event not journaled"
            );
        }
        self.deliver(tx, answer);
        WorkflowQuestionResolved::Answered {
            qid: qid.to_owned(),
        }
    }

    /// 校验并摘下一个停驻项（三类拒绝在这里发生；退场记录当场写）。答案由
    /// [`Self::deliver`] 在 journal 落库后送出。
    fn detach(
        &self,
        session: &SessionId,
        qid: &str,
    ) -> Result<(WorkflowQuestion, oneshot::Sender<String>), WorkflowQuestionResolved> {
        let mut inner = self.lock();
        let Some(parked) = inner.parked.get(qid) else {
            let retired = inner
                .retired
                .get(qid)
                .filter(|(_, parent)| parent == session);
            return match retired {
                Some((RetiredReason::Resolved, _)) => Err(WorkflowQuestionResolved::Rejected {
                    reason: "already_resolved".to_owned(),
                    message: format!(
                        "Question {qid} was already answered and the subagent has moved on with that \
answer. No need to answer again; if you have more to add, wait for its next escalation."
                    ),
                }),
                Some((RetiredReason::Withdrawn, _)) => Err(WorkflowQuestionResolved::Rejected {
                    reason: "run_not_in_flight".to_owned(),
                    message: format!(
                        "The ask that raised question {qid} is no longer in flight (the run was \
cancelled, or that ask already failed), so nobody is waiting for this answer. Use GetWorkflowRun \
to see the run's current state before deciding what to do next."
                    ),
                }),
                None => Err(WorkflowQuestionResolved::Rejected {
                    reason: "unknown_question".to_owned(),
                    message: format!(
                        "Unknown question id {qid}. It may be misspelled, or it may come from a \
process that is gone: parked questions are not persisted, so they vanish on restart (a resume \
makes the subagent ask again under a new id). Use GetWorkflowRun to read the run's \
pendingQuestions for the ids that are actually awaiting an answer."
                    ),
                }),
            };
        };
        // 作答只属于 run 的父会话：别的会话拿到的 qid 与「不存在」是同一个事实。
        if parked.question.parent != session.as_str() {
            return Err(WorkflowQuestionResolved::Rejected {
                reason: "unknown_question".to_owned(),
                message: format!("Unknown question id {qid}."),
            });
        }
        let Some(parked) = inner.parked.remove(qid) else {
            return Err(WorkflowQuestionResolved::Rejected {
                reason: "unknown_question".to_owned(),
                message: format!("Unknown question id {qid}."),
            });
        };
        inner.order.retain(|candidate| candidate != qid);
        // 先退场再解开停驻的 future：再入（同一轮里紧接着又一次 escalate）必须看到一张已经
        // 不含本 qid 的表。
        retire(&mut inner, qid, RetiredReason::Resolved, session);
        Ok((parked.question, parked.tx))
    }

    /// 把答案送进停驻的 future（journal 落库之后的最后一跳）。
    fn deliver(&self, tx: oneshot::Sender<String>, answer: &str) {
        let _ = tx.send(answer.to_owned());
    }

    /// 撤下一个停驻项而**不作答**（ask 被取消 / 回合失败）。之后对该 qid 的作答得到
    /// `run_not_in_flight`。
    fn withdraw(&self, qid: &str) {
        let mut inner = self.lock();
        let Some(parked) = inner.parked.remove(qid) else {
            return;
        };
        inner.order.retain(|candidate| candidate != qid);
        let parent = SessionId::new(parked.question.parent);
        retire(&mut inner, qid, RetiredReason::Withdrawn, &parent);
    }

    /// 登记一次升级并给出等待端；两条拒绝都在这里发生（预算与无在飞 ask）。返回
    /// `(qid, question, 等待端, 通知全文)`——journal 的载荷由调用方在确认落库意图时组装。
    fn park(
        &self,
        request: WorkflowEscalationRequest,
    ) -> Result<(String, WorkflowQuestion, oneshot::Receiver<String>, String), WorkflowEscalationOutcome>
    {
        let WorkflowEscalationRequest {
            parent,
            run_id,
            actor,
            actor_name,
            ask,
            question,
            context,
        } = request;
        if ask.is_empty() {
            return Err(WorkflowEscalationOutcome::Refused {
                reason: "no_active_ask".to_owned(),
                message: NO_ACTIVE_ASK.to_owned(),
            });
        }
        let asked_at = self.clock.now_ms();
        let mut inner = self.lock();
        let used = inner
            .budget
            .entry((run_id.clone(), ask))
            .or_default();
        if *used >= MAX_ESCALATIONS_PER_ASK {
            return Err(WorkflowEscalationOutcome::Refused {
                reason: "budget_exhausted".to_owned(),
                message: BUDGET_EXHAUSTED.to_owned(),
            });
        }
        *used += 1;
        let qid = mint(&mut inner, &run_id);
        let question = WorkflowQuestion {
            qid: qid.clone(),
            run_id,
            parent,
            actor,
            actor_name,
            question,
            context,
            asked_at,
        };
        let (tx, rx) = oneshot::channel();
        inner.parked.insert(
            qid.clone(),
            Parked {
                question: question.clone(),
                tx,
            },
        );
        inner.order.push(qid.clone());
        let text = notification_text(&question);
        Ok((qid, question, rx, text))
    }

    fn notifier(&self) -> Option<Arc<dyn WorkflowNotices>> {
        self.notifier
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

fn retire(inner: &mut Inner, qid: &str, reason: RetiredReason, parent: &SessionId) {
    inner.retired.insert(qid.to_owned(), (reason, parent.clone()));
    inner.retired_order.push(qid.to_owned());
    while inner.retired_order.len() > RETIRED_HISTORY_LIMIT {
        let oldest = inner.retired_order.remove(0);
        inner.retired.remove(&oldest);
    }
}

/// 铸一个全局唯一的问题 id：`dwfq-<runId 片段>-<seq>`（候选由短到长，最后一个候选是完整 runId，
/// 因而按构造必有一个未占用的）。
fn mint(inner: &mut Inner, run_id: &str) -> String {
    let seq = {
        let next = inner.next_seq.entry(run_id.to_owned()).or_default();
        *next += 1;
        *next
    };
    for fragment in fragments(run_id) {
        let candidate = format!("dwfq-{fragment}-{seq}");
        if !inner.parked.contains_key(&candidate) && !inner.retired.contains_key(&candidate) {
            return candidate;
        }
    }
    // 只可能意味着两个 run 共用了同一个 runId（装配错误）：大声失败而不是发一个会错配答案的 id。
    format!("dwfq-{run_id}-{seq}")
}

fn fragments(run_id: &str) -> Vec<String> {
    let body = run_id.strip_prefix("dwfrun-").unwrap_or(run_id);
    let full = sanitize(body);
    let mut candidates = vec![full.chars().take(8).collect::<String>()];
    let long = full.chars().take(16).collect::<String>();
    if !candidates.contains(&long) {
        candidates.push(long);
    }
    if !candidates.contains(&full) {
        candidates.push(full);
    }
    candidates
}

fn sanitize(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '_' => out.push_str("__"),
            'A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '-' => out.push(character),
            _ => out.push('_'),
        }
    }
    out
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 升级提示的全文（`<workflow-escalation>` 块 + 下一步；与 Node 的
/// `formatWorkflowEscalationNotification` 逐句相同）。run 的展示名这里没有——runId 兜底。
fn notification_text(question: &WorkflowQuestion) -> String {
    let actor = question
        .actor_name
        .as_deref()
        .unwrap_or(question.actor.as_str());
    let mut lines = vec![
        "[SYSTEM NOTIFICATION - NOT USER INPUT]".to_owned(),
        "This is an automated workflow event, NOT a message from the user.".to_owned(),
        "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question."
            .to_owned(),
        String::new(),
        "<workflow-escalation>".to_owned(),
        format!("  <run-id>{}</run-id>", escape_xml(&question.run_id)),
        format!("  <run>{}</run>", escape_xml(&question.run_id)),
        format!("  <question-id>{}</question-id>", escape_xml(&question.qid)),
        format!("  <subagent>{}</subagent>", escape_xml(actor)),
        format!("  <question>{}</question>", escape_xml(&question.question)),
    ];
    if let Some(context) = &question.context {
        lines.push(format!("  <context>{}</context>", escape_xml(context)));
    }
    lines.push("</workflow-escalation>".to_owned());
    lines.push(String::new());
    lines.push(format!(
        "Subagent {actor} in workflow run {} ({}) escalated a blocking question and is parked on \
that call waiting for your answer.",
        question.run_id, question.run_id
    ));
    lines.push(format!(
        "Next step: call ResolveWorkflowQuestion with question_id=\"{}\" and your answer.",
        question.qid
    ));
    lines.push(
        "The run is still running: only the subagent that asked is parked — every other subagent \
and the script's control flow keep going. So do not drop what you are doing, but do not leave it \
unanswered either: nothing times out on its behalf."
            .to_owned(),
    );
    lines.push(
        "If this notification is ever lost, GetWorkflowRun lists the questions this run still owes \
an answer to."
            .to_owned(),
    );
    lines.join("\n")
}

/// journal 的两条事件载荷（与 Node `RunEvent` 的 `escalation-raised` / `escalation-resolved`
/// 同形，camelCase 字段、整个事件含 `type`——`dwf_event.payload_json` 存的就是它）。
/// `actor` 是**结构化** ActorRef（Node 事件里 `actor: ActorRef`，注册表/port 的 `site@ordinal`
/// 字符串只在 park 与通知里用）。
fn actor_ref_json(actor: &str) -> serde_json::Value {
    match actor.rsplit_once('@') {
        Some((site, ordinal)) => json!({
            "siteId": site,
            "ordinal": ordinal.parse::<u64>().unwrap_or(0),
        }),
        // 拆不开的身份不编造序号：siteId 原样、ordinal 兜底 0（journal 的重放按数字读）。
        None => json!({"siteId": actor, "ordinal": 0}),
    }
}

/// run 的展示名（run 行的标签链：name → 脚本首行 → runId，`run_detail` 同一条读法）。
/// store 缺席（TUI / 内存存储）或读不出时落 runId——通知是同步产出，这里允许一次 I/O。
/// 详情查询按 (session, run) 双键：question.parent 就是发起会话。
async fn run_label(escalations: &WorkflowEscalations, parent: &SessionId, run_id: &str) -> String {
    let Some(store) = escalations.store() else {
        return run_id.to_owned();
    };
    match store.workflow_run_detail(parent, run_id).await {
        Ok(Some(detail)) => detail.label,
        _ => run_id.to_owned(),
    }
}

/// escalation 通知的 originMeta（base 三键 + `kind: "escalation"` 的 manifest 载荷）。
/// question / context 发射侧就地截断（shared schema 限 4000 字符——超界会让轮头行落库时
/// zod 拒收）。actor 兜底链与通知文本同一条（actorName 缺席落结构化 ref）。
/// 展示名走 run 行的标签链（name → runId），与终态通知的 title 同一条兜底。
fn escalation_origin_meta(question: &WorkflowQuestion, label: &str) -> serde_json::Value {
    const TEXT_MAX: usize = 4_000;
    let clip = |text: &str| {
        if text.chars().count() <= TEXT_MAX {
            text.to_owned()
        } else {
            let head: String = text.chars().take(TEXT_MAX - 1).collect();
            format!("{head}\u{2026}")
        }
    };
    let actor = question
        .actor_name
        .as_deref()
        .unwrap_or(question.actor.as_str());
    let mut manifest = serde_json::Map::new();
    manifest.insert("kind".into(), json!("escalation"));
    manifest.insert("qid".into(), json!(question.qid));
    manifest.insert("actor".into(), json!(actor));
    manifest.insert("question".into(), json!(clip(&question.question)));
    if let Some(context) = question
        .context
        .as_deref()
        .filter(|context| !context.is_empty())
    {
        manifest.insert("context".into(), json!(clip(context)));
    }
    manifest.insert("askedAt".into(), json!(question.asked_at));
    serde_json::json!({
        "backgroundSource": "workflow",
        "title": label,
        "workId": question.run_id,
        "workflowNotification": serde_json::Value::Object(manifest),
    })
}

fn raised_payload(question: &WorkflowQuestion) -> String {
    let mut object = serde_json::Map::new();
    object.insert("type".into(), json!("escalation-raised"));
    object.insert("qid".into(), json!(question.qid));
    object.insert("actor".into(), actor_ref_json(&question.actor));
    if let Some(name) = &question.actor_name {
        object.insert("actorName".into(), json!(name));
    }
    object.insert("question".into(), json!(question.question));
    if let Some(context) = &question.context {
        object.insert("context".into(), json!(context));
    }
    object.insert("askedAt".into(), json!(question.asked_at));
    serde_json::Value::Object(object).to_string()
}

fn resolved_payload(qid: &str, answer: &str) -> String {
    json!({
        "type": "escalation-resolved",
        "qid": qid,
        "answer": answer,
    })
    .to_string()
}

/// 停驻 future 的撤销守卫：future 被丢弃（ask 取消 / run 取消）时把 qid 按 `withdrawn` 退场。
struct ParkGuard {
    owner: Arc<WorkflowEscalations>,
    qid: String,
}

impl Drop for ParkGuard {
    fn drop(&mut self) {
        self.owner.withdraw(&self.qid);
    }
}

/// journal 的本机实现（孤儿规则：会话存储是外部 trait 对象，套一层——与
/// [`EscalationPort`] 同一先例）。升级问答的事件落 `dwf_event`，与引擎 sidecar 同一个库。
pub struct SessionJournalSink(pub Arc<dyn SessionStore>);

#[async_trait::async_trait]
impl WorkflowEventJournal for SessionJournalSink {
    async fn append_event(
        &self,
        run_id: &str,
        event_type: &str,
        payload_json: String,
    ) -> Result<(), StoreError> {
        self.0
            .append_workflow_event(run_id, event_type, payload_json)
            .await
    }
}

/// `GetWorkflowRun` 的合成读面：journal 的全部事实（`workflow_run_detail`）∪ 停驻注册表的
/// 活项（journal 没记到的——`Unsupported` 存储或写入失败之外的路径）。
pub struct WorkflowRunDetailReader {
    pub store: Arc<dyn SessionStore>,
    pub escalations: Arc<WorkflowEscalations>,
}

#[async_trait::async_trait]
impl WorkflowRunIntrospection for WorkflowRunDetailReader {
    async fn run_detail(
        &self,
        session: &SessionId,
        run_id: &str,
    ) -> Result<Option<WorkflowRunDetail>, StoreError> {
        let mut detail = self.store.workflow_run_detail(session, run_id).await?;
        if let Some(detail) = &mut detail {
            for question in self.escalations.pending(session) {
                if question.run_id != run_id
                    || detail
                        .pending_questions
                        .iter()
                        .any(|pending| pending.qid == question.qid)
                {
                    continue;
                }
                detail.pending_questions.push(WorkflowRunPendingQuestion {
                    qid: question.qid,
                    actor: question.actor,
                    actor_name: question.actor_name,
                    question: question.question,
                    context: question.context,
                    asked_at: question.asked_at,
                });
            }
        }
        Ok(detail)
    }
}

/// actor 侧的升级端口（`Arc<WorkflowEscalations>` 的薄包装：守卫需要一个可 clone 的 Arc，
/// 而孤儿规则不允许直接给 `Arc<本地类型>` 实现外部 trait）。
pub struct EscalationPort(pub Arc<WorkflowEscalations>);

#[async_trait::async_trait]
impl WorkflowEscalation for EscalationPort {
    async fn escalate(&self, request: WorkflowEscalationRequest) -> WorkflowEscalationOutcome {
        let parent = SessionId::new(request.parent.clone());
        let (qid, question, rx, text) = match self.0.park(request) {
            Ok(parked) => parked,
            Err(refused) => return refused,
        };
        // 双轨 record 的 durable 轨（Node `makeSessionEscalatePort` 的 `host.record`，顺序同——
        // park 在前、record 在后）。真写不进去（SQLite/IO 故障）就没有 durable 的问答记录，而
        // 停驻会让 actor 无限期阻塞在一个谁也看不见的问题上：撤回登记并按拒绝收口，比悄悄
        // 停驻诚实。存储「没有这个能力」（`Unsupported`：TUI、内存存储）不是故障——与 Node
        // 引擎自带内存 journal 回退同一语义，只剩通知轨，停驻照常。
        if let Some(journal) = self.0.journal()
            && let Err(error) = journal
                .append_event(&question.run_id, "escalation-raised", raised_payload(&question))
                .await
            && !matches!(error, StoreError::Unsupported { .. })
        {
            self.0.withdraw(&qid);
            return WorkflowEscalationOutcome::Refused {
                reason: "journal_write_failed".to_owned(),
                message: format!(
                    "Escalation {qid} could not be recorded in the run journal, so nobody \
would be able to see or answer it: {error}"
                ),
            };
        }
        if let Some(notifier) = self.0.notifier() {
            // 结构化 originMeta（Node `notifyEscalationRaised` 同形）：base 三键 + escalation
            // manifest 载荷（GUI 折叠成「Subagent X has a question」，展开显示问题全文）。
            // 展示名的兜底链与 Node 同源：run 行的 name（registry.description）缺席落 runId。
            let label = run_label(&self.0, &parent, &question.run_id).await;
            notifier.notify_with(&parent, text, Some(escalation_origin_meta(&question, &label)));
        }
        let guard = ParkGuard {
            owner: self.0.clone(),
            qid: qid.clone(),
        };
        let answer = rx.await;
        drop(guard);
        match answer {
            Ok(answer) => WorkflowEscalationOutcome::Answered { answer, qid },
            // 注册表随内核释放：没有人再回答，按「ask 已不在飞」如实收口（绝不悬挂）。
            Err(_) => WorkflowEscalationOutcome::Refused {
                reason: "run_not_in_flight".to_owned(),
                message: format!(
                    "The ask that raised question {qid} is no longer in flight, so nobody is \
waiting for this answer."
                ),
            },
        }
    }
}

#[async_trait::async_trait]
impl WorkflowQuestions for WorkflowEscalations {
    async fn resolve(
        &self,
        session: &SessionId,
        qid: &str,
        answer: &str,
    ) -> WorkflowQuestionResolved {
        self.resolve_question(session, qid, answer).await
    }
}

#[cfg(test)]
#[path = "escalations_tests.rs"]
mod tests;

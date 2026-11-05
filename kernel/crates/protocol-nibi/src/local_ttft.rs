//! `v4/telemetry/local-ttft` 的采集（141 审计 §9 第 5 项余项）。
//!
//! renderer 在命令信封上带 `ttft: {version, observationId}`；这里按命令记一条记录，在命令受理、
//! 回合开始、首个输出与终态各发一份快照（与 Node 的 `LocalTtftRecorder` 同一组里程碑）。
//!
//! `requestAt`/`requestId`/`queryId`/`provider`/`model` 由模型传输层的
//! `ModelRequestStatus`（`model_request_started`，只认 `query_source == "main_turn"`）填充。
//!
//! 如实缺席：`details`（回合准备阶段没有分段计时）、`logicalCallId`（模型端口没有逻辑调用
//! 标识）、`clockInvalid`（时钟探测面未实现）、容量拒绝的 ACK 标记（`ttftExcluded: "capacity"`
//! 尚未加到 ACK——超过 128 条在途时新观察静默不记，与 Node 的「不记事实」一致，但少一个给前端
//! 的原因字段）。

use std::sync::{Mutex, MutexGuard, PoisonError};

use nibi_kernel_api::local_ttft::{LocalTtftContext, LocalTtftFacts};
use nibi_kernel_api::session_api::{KernelEvent, TurnOutcome};

/// 通知方法名（Host `V4_NOTIFICATIONS.localTtftFacts`）。
pub const METHOD: &str = "v4/telemetry/local-ttft";

/// 在途观察的上限与过期时间（Host 同一组常数：`LOCAL_TTFT_MAX_PENDING` / `LOCAL_TTFT_TTL_MS`）。
const MAX_PENDING: usize = 128;
const TTL_MS: u64 = 300_000;

/// 进程级的一本账：命令 → 观察记录。
pub struct LocalTtftRecorder {
    instance: String,
    records: Mutex<Vec<LocalTtftFacts>>,
}

impl LocalTtftRecorder {
    pub fn new(instance: String) -> Self {
        Self {
            instance,
            records: Mutex::new(Vec::new()),
        }
    }

    fn records(&self) -> MutexGuard<'_, Vec<LocalTtftFacts>> {
        self.records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// 过期的在途记录（没有终态、超过 TTL）直接丢掉。
    fn prune(&self, records: &mut Vec<LocalTtftFacts>, now: u64) {
        records.retain(|record| {
            record.terminal.is_some() || now.saturating_sub(record.received_at) <= TTL_MS
        });
    }

    fn bump(record: &mut LocalTtftFacts) -> LocalTtftFacts {
        record.revision = Some(record.revision.unwrap_or(0) + 1);
        record.clone()
    }

    /// 一条命令到达：建记录并发出第一份快照。重复的 commandId 与满容量的新观察都不记。
    pub fn receive(
        &self,
        context: &LocalTtftContext,
        command: &str,
        session: Option<&str>,
        now: u64,
        busy: Option<bool>,
    ) -> Option<LocalTtftFacts> {
        let mut records = self.records();
        self.prune(&mut records, now);
        if records
            .iter()
            .any(|record| record.command_id == command)
            || records.len() >= MAX_PENDING
        {
            return None;
        }
        let record = LocalTtftFacts {
            version: 1,
            observation_id: context.observation_id.clone(),
            instance_id: self.instance.clone(),
            command_id: command.to_owned(),
            session_id: session.map(str::to_owned),
            turn_id: None,
            product_turn_id: None,
            query_id: None,
            request_id: None,
            logical_call_id: None,
            cli_version: None,
            provider: None,
            model: None,
            revision: Some(1),
            send_mode: busy.map(|busy| if busy { "queued" } else { "idle" }.to_owned()),
            received_at: now,
            admitted_at: None,
            execution_at: None,
            request_at: None,
            output_at: None,
            output_kind: None,
            terminal: None,
            excluded: None,
            truncated: None,
            clock_invalid: None,
        };
        records.push(record.clone());
        Some(record)
    }

    /// 命令受理（ACK accepted）：补 `admittedAt` 并发一份。
    pub fn admitted(&self, command: &str, now: u64) -> Option<LocalTtftFacts> {
        let mut records = self.records();
        let record = records
            .iter_mut()
            .find(|record| record.command_id == command && record.terminal.is_none())?;
        record.admitted_at.get_or_insert(now);
        Some(Self::bump(record))
    }

    /// 命令被拒：记终态并结束观察（不再等回合事件）。
    pub fn rejected(&self, command: &str, now: u64) -> Option<LocalTtftFacts> {
        let mut records = self.records();
        let index = records
            .iter()
            .position(|record| record.command_id == command && record.terminal.is_none())?;
        let mut record = records.remove(index);
        record.terminal = Some("rejected".to_owned());
        record.admitted_at.get_or_insert(now);
        Some(Self::bump(&mut record))
    }

    /// 会话事件推进记录：回合开始、首个输出、终态。
    pub fn event(&self, session: &str, event: &KernelEvent, now: u64) -> Vec<LocalTtftFacts> {
        let mut out = Vec::new();
        let mut records = self.records();
        self.prune(&mut records, now);
        match event {
            KernelEvent::TurnStarted { turn, command, .. } => {
                let Some(command) = command else {
                    return out;
                };
                if let Some(record) = records.iter_mut().find(|record| {
                    record.command_id == command.as_str()
                        && record.terminal.is_none()
                        && record.session_id.as_deref().is_none_or(|id| id == session)
                }) {
                    record.session_id.get_or_insert_with(|| session.to_owned());
                    record.turn_id = Some(turn.as_str().to_owned());
                    record.product_turn_id = Some(turn.as_str().to_owned());
                    record.execution_at.get_or_insert(now);
                    out.push(Self::bump(record));
                }
            }
            KernelEvent::StreamDelta { turn, delta, .. } => {
                let kind = match delta {
                    nibi_kernel_api::model::BlockDelta::Text(_) => "text",
                    nibi_kernel_api::model::BlockDelta::Thinking(_) => "reasoning",
                    _ => return out,
                };
                if let Some(record) = records.iter_mut().find(|record| {
                    record.turn_id.as_deref() == Some(turn.as_str())
                        && record.session_id.as_deref() == Some(session)
                        && record.output_at.is_none()
                        && record.terminal.is_none()
                }) {
                    record.output_at = Some(now);
                    record.output_kind = Some(kind.to_owned());
                    out.push(Self::bump(record));
                }
            }
            KernelEvent::ToolStarted { .. } => {
                // 工具先于正文出现也算首个输出（Node 的 `outputKind: "tool"`）。
                if let Some(record) = records.iter_mut().find(|record| {
                    record.session_id.as_deref() == Some(session)
                        && record.execution_at.is_some()
                        && record.output_at.is_none()
                        && record.terminal.is_none()
                }) {
                    record.output_at = Some(now);
                    record.output_kind = Some("tool".to_owned());
                    out.push(Self::bump(record));
                }
            }
            KernelEvent::ModelRequestStatus { status } => {
                // 首次主回合请求：补 `requestAt` 与请求标识（Node 在请求开始时记这一段）。
                if status.kind
                    != nibi_kernel_api::model::ModelRequestStatusKind::ModelRequestStarted
                    || status.query_source.as_deref() != Some("main_turn")
                {
                    return out;
                }
                if let Some(record) = records.iter_mut().find(|record| {
                    record.session_id.as_deref() == Some(session)
                        && record.execution_at.is_some()
                        && record.terminal.is_none()
                }) {
                    record.request_at.get_or_insert(now);
                    record.request_id.get_or_insert_with(|| status.request_id.clone());
                    if record.query_id.is_none() {
                        record.query_id = status.query_id.clone();
                    }
                    if record.provider.is_none() {
                        record.provider = Some(status.provider_id.clone());
                    }
                    if record.model.is_none() {
                        record.model = Some(status.model_id.clone());
                    }
                    out.push(Self::bump(record));
                }
            }
            KernelEvent::TurnFinished { turn, outcome, .. } => {
                let terminal = match outcome {
                    TurnOutcome::Success => "completed",
                    TurnOutcome::Interrupted => "interrupted",
                    TurnOutcome::Failed { .. } => "failed",
                };
                if let Some(index) = records.iter().position(|record| {
                    record.turn_id.as_deref() == Some(turn.as_str())
                        && record.session_id.as_deref() == Some(session)
                        && record.terminal.is_none()
                }) {
                    let mut record = records.remove(index);
                    record.terminal = Some(terminal.to_owned());
                    out.push(Self::bump(&mut record));
                }
            }
            _ => {}
        }
        out
    }
}

#[cfg(test)]
#[path = "local_ttft_tests.rs"]
mod tests;

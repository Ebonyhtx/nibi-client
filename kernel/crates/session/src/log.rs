//! 会话事件日志：给事件分配 seq，并让订阅方先补发再接实时事件，不丢不重。
//!
//! 追加与订阅都在同一把锁里完成：订阅方拿到“seq ≤ N 的补发 + seq > N 的实时”，追加方在锁内
//! 分配 seq 并广播，二者之间没有空隙。锁只保护内存操作，不跨 await。
//!
//! 只存补发需要的形状（docs/specs/rust-cli/session-lifecycle.md §2.1）：同一块连续的流增量合成一段，
//! 带 `output` 的工具进度只留每个工具最新的一条，子代理进度里的工具进度不存。实时广播不变。
//!
//! 修复（R1-4）：以前保存全部事件（含每个 StreamDelta / ToolProgress），长会话里内存只增不减。

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use futures_util::stream::{self, BoxStream, StreamExt};
use nibi_kernel_api::ids::{ToolUseId, TurnId};
use nibi_kernel_api::model::BlockDelta;
use nibi_kernel_api::orchestration::QueryEvent;
use nibi_kernel_api::session_api::{KernelEvent, SequencedEvent};
use nibi_kernel_api::tool::ToolProgress;
use serde_json::{Value, json};
use tokio::sync::broadcast;

/// 实时广播的缓冲；订阅方落后超过它时，流结束，订阅方按最后的 seq 重新订阅。
const LIVE_CAPACITY: usize = 1024;
/// 被取代的空位至少这么多、且占到三分之一时整理一次（每个空位后面通常跟着一段被它隔开的增量，空位到不了一半）。
const COMPACT_AFTER: usize = 64;
/// 会话事件日志保留上界（长会话/大输出时防止条目数、增量字节与片索引无限增长）。
const MAX_RETAINED_ENTRIES: usize = 4096;
const MAX_RETAINED_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_RETAINED_PIECES: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeltaKind {
    Text,
    Thinking,
    Signature,
    InputJson,
}

impl DeltaKind {
    fn split(delta: &BlockDelta) -> (Self, &str) {
        match delta {
            BlockDelta::Text(text) => (Self::Text, text),
            BlockDelta::Thinking(text) => (Self::Thinking, text),
            BlockDelta::Signature(text) => (Self::Signature, text),
            BlockDelta::InputJson(text) => (Self::InputJson, text),
        }
    }

    fn join(self, text: String) -> BlockDelta {
        match self {
            Self::Text => BlockDelta::Text(text),
            Self::Thinking => BlockDelta::Thinking(text),
            Self::Signature => BlockDelta::Signature(text),
            Self::InputJson => BlockDelta::InputJson(text),
        }
    }
}

/// 可以合段的一块：主循环的流增量，或 Agent 工具进度里子代理的流增量。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Block {
    Stream {
        turn: TurnId,
        response: u32,
        index: usize,
        kind: DeltaKind,
    },
    Agent {
        tool_use: ToolUseId,
        agent: String,
        message: usize,
        index: usize,
        kind: DeltaKind,
    },
}

impl Block {
    /// 还原成一个增量事件（文字是合起来的）。
    fn event(&self, text: String) -> KernelEvent {
        match self {
            Self::Stream {
                turn,
                response,
                index,
                kind,
            } => KernelEvent::StreamDelta {
                turn: turn.clone(),
                response: *response,
                index: *index,
                delta: kind.join(text),
            },
            Self::Agent {
                tool_use,
                agent,
                message,
                index,
                kind,
            } => {
                let event = QueryEvent::Delta {
                    message: *message,
                    index: *index,
                    delta: kind.join(text),
                };
                KernelEvent::ToolProgress {
                    tool_use: tool_use.clone(),
                    progress: ToolProgress {
                        data: json!({"agentId": agent, "event": event}),
                    },
                }
            }
        }
    }
}

/// 同一块连续的增量：文字接起来，记每片的 seq 与它在 `text` 里的结束位置。
struct Run {
    block: Block,
    text: String,
    pieces: Vec<(u64, usize)>,
    /// 最后一片时的状态 revision（增量不改 revision，整段同一个值）。
    revision: u64,
}

impl Run {
    /// `after` 之后的部分：一个增量，seq 取最后一片。
    fn replay(&self, after: u64) -> Option<SequencedEvent> {
        let first = self.pieces.partition_point(|(seq, _)| *seq <= after);
        let (last, _) = *self.pieces.last()?;
        if first == self.pieces.len() {
            return None;
        }
        let start = first.checked_sub(1).map_or(0, |at| self.pieces[at].1);
        Some(SequencedEvent {
            seq: last,
            event: self.block.event(self.text[start..].to_owned()),
            revision: self.revision,
        })
    }
}

enum Entry {
    Event(SequencedEvent),
    Run(Run),
    /// 被同一个工具后来的进度取代；整理时去掉。
    Superseded,
}

/// 这个事件是否改变会话的可见状态（缺口 G1，[`SequencedEvent::revision`] 的规则）：会话 actor 是 revision 的唯一
/// owner，前端（例如 App 协议的条件命令）只读它。新加的事件默认算状态变化。
fn changes_state(event: &KernelEvent) -> bool {
    !matches!(
        event,
        KernelEvent::SessionCreated { .. }
            | KernelEvent::StreamDelta { .. }
            | KernelEvent::ToolProgress { .. }
            | KernelEvent::ContextUsage { .. }
            | KernelEvent::ContextNotice { .. }
            | KernelEvent::OutputSpeed { .. }
            | KernelEvent::ScheduledFire { .. }
            | KernelEvent::SystemNotice { .. }
            | KernelEvent::ModelNotice { .. }
            | KernelEvent::ModelRequestStatus { .. }
            | KernelEvent::WorkflowLifecycle { .. }
            | KernelEvent::WorkflowRunProgress { .. }
    )
}

/// 一个事件怎么存。
enum Shape<'a> {
    Delta(Block, &'a str),
    /// 带 `output` 的工具进度：取代这个工具之前的一条。
    Output(&'a ToolUseId),
    /// 只广播（折叠忽略它）。
    LiveOnly,
    Plain,
}

fn shape(event: &KernelEvent) -> Shape<'_> {
    match event {
        KernelEvent::StreamDelta {
            turn,
            response,
            index,
            delta,
        } => {
            let (kind, text) = DeltaKind::split(delta);
            let block = Block::Stream {
                turn: turn.clone(),
                response: *response,
                index: *index,
                kind,
            };
            Shape::Delta(block, text)
        }
        KernelEvent::ToolProgress { tool_use, progress } => {
            progress_shape(tool_use, &progress.data)
        }
        _ => Shape::Plain,
    }
}

fn progress_shape<'a>(tool_use: &'a ToolUseId, data: &'a Value) -> Shape<'a> {
    let Some(object) = data.as_object() else {
        return Shape::Plain;
    };
    let Some(agent) = object.get("agentId").and_then(Value::as_str) else {
        return match object.get("output") {
            Some(Value::String(_)) => Shape::Output(tool_use),
            _ => Shape::Plain,
        };
    };
    // 只认 child.rs 的形状 `{agentId, event}`；别的字段在时原样存。
    let Some(event) = object.get("event").filter(|_| object.len() == 2) else {
        return Shape::Plain;
    };
    match event.get("type").and_then(Value::as_str) {
        Some("tool_progress") => Shape::LiveOnly,
        Some("delta") => match serde_json::from_value::<QueryEvent>(event.clone()) {
            Ok(QueryEvent::Delta {
                message,
                index,
                delta,
            }) => {
                let kind = DeltaKind::split(&delta).0;
                let text = match event.pointer("/delta/value").and_then(Value::as_str) {
                    Some(text) => text,
                    None => return Shape::Plain,
                };
                let block = Block::Agent {
                    tool_use: tool_use.clone(),
                    agent: agent.to_owned(),
                    message,
                    index,
                    kind,
                };
                Shape::Delta(block, text)
            }
            _ => Shape::Plain,
        },
        _ => Shape::Plain,
    }
}

struct Inner {
    entries: VecDeque<Entry>,
    /// 已从队列头部逐出的逻辑下标偏移量，用于校验 `outputs` 映射是否仍落在当前窗口内。
    base_index: usize,
    /// 每个工具最新一条带 `output` 的进度在 `entries` 里的逻辑位置。
    outputs: HashMap<ToolUseId, usize>,
    /// 窗口内留存的流式文字字节数与片索引数（O(1) 预算判定）。
    text_bytes: usize,
    piece_count: usize,
    /// 已被逐出的最大序号。
    floor: u64,
    superseded: usize,
    next: u64,
    /// 当前的状态 revision（缺口 G1）。
    revision: u64,
}

impl Inner {
    fn store(&mut self, sequenced: &SequencedEvent) {
        match shape(&sequenced.event) {
            Shape::Delta(block, text) => {
                if let Some(Entry::Run(run)) = self.entries.back_mut()
                    && run.block == block
                {
                    run.text.push_str(text);
                    run.pieces.push((sequenced.seq, run.text.len()));
                    run.revision = sequenced.revision;
                    self.text_bytes += text.len();
                    self.piece_count += 1;
                } else {
                    self.text_bytes += text.len();
                    self.piece_count += 1;
                    self.entries.push_back(Entry::Run(Run {
                        block,
                        text: text.to_owned(),
                        pieces: vec![(sequenced.seq, text.len())],
                        revision: sequenced.revision,
                    }));
                }
            }
            Shape::Output(tool_use) => {
                let logical_at = self.base_index + self.entries.len();
                if let Some(prev_at) = self.outputs.insert(tool_use.clone(), logical_at)
                    && let Some(rel) = prev_at.checked_sub(self.base_index)
                    && let Some(slot) = self.entries.get_mut(rel)
                {
                    *slot = Entry::Superseded;
                    self.superseded += 1;
                }
                self.entries.push_back(Entry::Event(sequenced.clone()));
                if self.superseded >= COMPACT_AFTER && self.superseded * 3 >= self.entries.len() {
                    self.compact();
                }
            }
            Shape::LiveOnly => return,
            Shape::Plain => {
                if let KernelEvent::ToolDone { tool_use, .. } = &sequenced.event {
                    // 工具完成后不再产生新的输出进度，立即移除对应下标条目
                    self.outputs.remove(tool_use);
                }
                self.entries.push_back(Entry::Event(sequenced.clone()));
            }
        }
        self.evict_to_budget();
    }

    /// 去掉空位；去掉之后相邻的同一块的段合成一段。
    fn compact(&mut self) {
        let mut kept: VecDeque<Entry> =
            VecDeque::with_capacity(self.entries.len().saturating_sub(self.superseded));
        for entry in std::mem::take(&mut self.entries) {
            match (entry, kept.back_mut()) {
                (Entry::Superseded, _) => {}
                (Entry::Run(run), Some(Entry::Run(previous))) if previous.block == run.block => {
                    let offset = previous.text.len();
                    previous.text.push_str(&run.text);
                    previous
                        .pieces
                        .extend(run.pieces.into_iter().map(|(seq, end)| (seq, offset + end)));
                    previous.revision = run.revision;
                }
                (entry, _) => kept.push_back(entry),
            }
        }
        self.entries = kept;
        self.base_index = 0;
        self.superseded = 0;
        self.outputs = self
            .entries
            .iter()
            .enumerate()
            .filter_map(|(at, entry)| match entry {
                Entry::Event(SequencedEvent {
                    event: KernelEvent::ToolProgress { tool_use, progress },
                    ..
                }) if matches!(progress_shape(tool_use, &progress.data), Shape::Output(_)) => {
                    Some((tool_use.clone(), at))
                }
                _ => None,
            })
            .collect();
    }

    /// 裁剪超出保留上界的头部条目或单段超长流式片，避免长会话内存无界膨胀。
    fn evict_to_budget(&mut self) {
        while self.entries.len() > MAX_RETAINED_ENTRIES
            || (self.entries.len() > 1
                && (self.text_bytes > MAX_RETAINED_TEXT_BYTES
                    || self.piece_count > MAX_RETAINED_PIECES))
        {
            let Some(front) = self.entries.pop_front() else {
                break;
            };
            self.base_index += 1;
            match front {
                Entry::Superseded => {
                    self.superseded = self.superseded.saturating_sub(1);
                }
                Entry::Event(event) => {
                    self.floor = self.floor.max(event.seq);
                    if let KernelEvent::ToolProgress { tool_use, .. } = &event.event
                        && self
                            .outputs
                            .get(tool_use)
                            .is_some_and(|at| *at < self.base_index)
                    {
                        self.outputs.remove(tool_use);
                    }
                }
                Entry::Run(run) => {
                    self.text_bytes = self.text_bytes.saturating_sub(run.text.len());
                    self.piece_count = self.piece_count.saturating_sub(run.pieces.len());
                    if let Some((last_seq, _)) = run.pieces.last() {
                        self.floor = self.floor.max(*last_seq);
                    }
                }
            }
        }
        if self.entries.len() == 1
            && (self.text_bytes > MAX_RETAINED_TEXT_BYTES
                || self.piece_count > MAX_RETAINED_PIECES)
            && let Some(Entry::Run(run)) = self.entries.front_mut()
        {
            trim_run_front(
                run,
                &mut self.text_bytes,
                &mut self.piece_count,
                &mut self.floor,
            );
        }
    }
}

fn trim_run_front(
    run: &mut Run,
    text_bytes: &mut usize,
    piece_count: &mut usize,
    floor: &mut u64,
) {
    let total_pieces = run.pieces.len();
    if total_pieces <= 1 {
        return;
    }
    let total_len = run.text.len();
    let mut cut_index = None;
    for (idx, &(seq, end)) in run.pieces.iter().enumerate() {
        if idx + 1 >= total_pieces {
            break;
        }
        let rem_bytes = total_len - end;
        let rem_pieces = total_pieces - (idx + 1);
        if rem_bytes <= MAX_RETAINED_TEXT_BYTES && rem_pieces <= MAX_RETAINED_PIECES {
            cut_index = Some((idx + 1, end, seq));
            break;
        }
    }
    let (drop_n, cut_bytes, evicted_seq) = cut_index.unwrap_or_else(|| {
        let (seq, end) = run.pieces[total_pieces - 2];
        (total_pieces - 1, end, seq)
    });
    run.pieces.drain(..drop_n);
    run.text.drain(..cut_bytes);
    for (_, end) in &mut run.pieces {
        *end -= cut_bytes;
    }
    *text_bytes = text_bytes.saturating_sub(cut_bytes);
    *piece_count = piece_count.saturating_sub(drop_n);
    *floor = (*floor).max(evicted_seq);
}

/// 存着的条目数与流式文字的字节数（测试看内存上界）。
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(crate) struct Retained {
    pub(crate) entries: usize,
    pub(crate) text_bytes: usize,
}

pub(crate) struct EventLog {
    inner: Mutex<Inner>,
    live: broadcast::Sender<SequencedEvent>,
}

impl EventLog {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: VecDeque::new(),
                base_index: 0,
                outputs: HashMap::new(),
                text_bytes: 0,
                piece_count: 0,
                floor: 0,
                superseded: 0,
                next: 1,
                revision: 0,
            }),
            live: broadcast::channel(LIVE_CAPACITY).0,
        }
    }

    pub(crate) fn append(&self, event: KernelEvent) -> u64 {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if changes_state(&event) {
            inner.revision += 1;
        }
        let sequenced = SequencedEvent {
            seq: inner.next,
            event,
            revision: inner.revision,
        };
        inner.next += 1;
        inner.store(&sequenced);
        let seq = sequenced.seq;
        // 没有订阅方时发送失败，不影响日志。
        let _ = self.live.send(sequenced);
        seq
    }

    /// 当前的状态 revision（缺口 G1）：与 `last_seq` 同一时刻（视图在 actor 里取，二者之间没有追加）。
    pub(crate) fn revision(&self) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .revision
    }

    pub(crate) fn last_seq(&self) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .next
            - 1
    }

    /// `after` 为空时只接收之后的新事件。
    pub(crate) fn subscribe(&self, after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        let inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let replay: Vec<SequencedEvent> = match after {
            Some(after) => inner
                .entries
                .iter()
                .filter_map(|entry| match entry {
                    Entry::Event(event) => (event.seq > after).then(|| event.clone()),
                    Entry::Run(run) => run.replay(after),
                    Entry::Superseded => None,
                })
                .collect(),
            None => Vec::new(),
        };
        let receiver = self.live.subscribe();
        drop(inner);
        let live = stream::unfold(receiver, |mut receiver| async move {
            match receiver.recv().await {
                Ok(event) => Some((event, receiver)),
                // 落后或关闭：结束这个流，由订阅方按最后收到的 seq 重新订阅。
                Err(_) => None,
            }
        });
        stream::iter(replay).chain(live).boxed()
    }

    #[cfg(test)]
    pub(crate) fn retained(&self) -> Retained {
        let inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let live = inner
            .entries
            .iter()
            .filter(|entry| !matches!(entry, Entry::Superseded));
        Retained {
            entries: live.clone().count(),
            text_bytes: live
                .filter_map(|entry| match entry {
                    Entry::Run(run) => Some(run.text.len()),
                    _ => None,
                })
                .sum(),
        }
    }
}

#[cfg(test)]
#[path = "log_tests.rs"]
mod tests;

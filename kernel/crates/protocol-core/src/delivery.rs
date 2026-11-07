//! 投递的通用机制（docs/specs/rust-cli/app-protocol.md §3.3、§6）：一个主题的日志（本进程的代际标识、帧序号、
//! 保留下来的增量）与它的订阅者（订阅 ID、连接 ID、已经交给它的位置）。
//!
//! 帧的形状与批的窗口由协议 crate 决定；这里只管“谁该收到哪一段”：
//!
//! - 每记一次（一个内核事件产生的一组增量）序号加一；快照总是取当前序号。
//! - 日志按 [`DEFAULT_RETENTION`]（Node `eventRetentionPerSession`）保留最近若干个序号的事件；淘汰的最老
//!   序号进 `floor`。`base.seq` 在 `[floor, seq]` 内才可无损续传（[`TopicLog::resume`]），更早的只能回快照。
//! - 订阅者先登记（还没有首帧，`acked` 为空）；首帧（快照）发出时 [`TopicLog::start`] 记下当时的序号。之后的
//!   [`TopicLog::flush`] 只给已经开始的订阅者它们没收到的那一段，所以首帧与增量不会交错或重复。
//! - 同一个连接对同一个主题再订阅，替换原来的订阅。
//! - `saturated` 的连接暂停投递：位置不动、增量留在日志里，`drained` 后下一次 flush 补上（Node
//!   `setConnectionFlowState`）。

use std::collections::HashSet;

/// Node `PROTOCOL_V4_LIMITS.eventRetentionPerSession`。
pub const DEFAULT_RETENTION: usize = 2000;

/// 一个订阅者。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscriber {
    pub subscription: String,
    pub connection: String,
    /// 已经交给它的位置；首帧之前为 None。
    acked: Option<u64>,
}

/// 发给一个订阅者的一段增量：`(from, to]`。
#[derive(Debug, Clone, PartialEq)]
pub struct Batch<D> {
    pub subscription: String,
    pub from: u64,
    pub to: u64,
    pub deltas: Vec<D>,
}

/// 一个主题的日志与订阅者。
#[derive(Debug)]
pub struct TopicLog<D> {
    epoch: String,
    seq: u64,
    /// 保留窗：`(seq, 这一组增量)`，序号升序。
    log: Vec<(u64, Vec<D>)>,
    /// 已经被淘汰的最大序号；`base.seq < floor` 的续传请求已无法无损重放。
    floor: u64,
    retention: usize,
    subscribers: Vec<Subscriber>,
}

impl<D: Clone> TopicLog<D> {
    pub fn new(epoch: impl Into<String>) -> Self {
        Self::with_retention(epoch, DEFAULT_RETENTION)
    }

    /// 保留窗大小（事件数，不是增量条数）。`0` 与 `1` 等价：至少留最近一次。
    pub fn with_retention(epoch: impl Into<String>, retention: usize) -> Self {
        Self {
            epoch: epoch.into(),
            seq: 0,
            log: Vec::new(),
            floor: 0,
            retention: retention.max(1),
            subscribers: Vec::new(),
        }
    }

    /// 本进程里这个主题的代际标识（进程重启后换新的，客户端的位置随之失效）。
    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// 保留窗下界：`base.seq < floor()` 的续传请求只能回快照。
    pub fn floor(&self) -> u64 {
        self.floor
    }

    /// 记一组增量（一个事件产生的）；空的不占序号。返回记下之后的序号。
    pub fn record(&mut self, deltas: Vec<D>) -> u64 {
        if deltas.is_empty() {
            return self.seq;
        }
        self.seq += 1;
        let seq = self.seq;
        self.log.push((seq, deltas));
        while self.log.len() > self.retention {
            let (evicted, _) = self.log.remove(0);
            self.floor = evicted;
        }
        seq
    }

    /// 登记一个订阅者（还没有首帧）。同一个连接原来的订阅被替换，返回被替换的订阅 ID。
    pub fn subscribe(
        &mut self,
        subscription: impl Into<String>,
        connection: impl Into<String>,
    ) -> Option<String> {
        let connection = connection.into();
        let replaced = self
            .subscribers
            .iter()
            .position(|known| known.connection == connection)
            .map(|at| self.subscribers.remove(at).subscription);
        self.subscribers.push(Subscriber {
            subscription: subscription.into(),
            connection,
            acked: None,
        });
        replaced
    }

    /// 首帧发出：从当前序号开始给它增量。订阅已经不在时返回 None。
    pub fn start(&mut self, subscription: &str) -> Option<u64> {
        let seq = self.seq;
        let subscriber = self
            .subscribers
            .iter_mut()
            .find(|known| known.subscription == subscription)?;
        subscriber.acked = Some(seq);
        Some(seq)
    }

    /// 续传（Node `subscribeReserved` 的 resumable 分支）：`base` 是本进程这一代、且在保留窗内时，
    /// 订阅者位置回到 `base`，返回当前序号；否则 None（调用方回快照）。
    pub fn resume(&mut self, subscription: &str, epoch: &str, base: u64) -> Option<u64> {
        if epoch != self.epoch || base < self.floor || base > self.seq {
            return None;
        }
        let seq = self.seq;
        let subscriber = self
            .subscribers
            .iter_mut()
            .find(|known| known.subscription == subscription)?;
        subscriber.acked = Some(base);
        Some(seq)
    }

    /// `(base, 当前]` 的增量（保留窗内的全部；`base == seq` 时为空）。
    pub fn deltas_after(&self, base: u64) -> Vec<D> {
        self.log
            .iter()
            .filter(|(at, _)| *at > base)
            .flat_map(|(_, deltas)| deltas.iter().cloned())
            .collect()
    }

    /// 重新同步：订阅回到“还没有首帧”，下一次首帧重新取快照。订阅不在时返回假。
    pub fn restart(&mut self, subscription: &str) -> bool {
        match self
            .subscribers
            .iter_mut()
            .find(|known| known.subscription == subscription)
        {
            Some(subscriber) => {
                subscriber.acked = None;
                true
            }
            None => false,
        }
    }

    pub fn unsubscribe(&mut self, subscription: &str) -> bool {
        let before = self.subscribers.len();
        self.subscribers
            .retain(|known| known.subscription != subscription);
        before != self.subscribers.len()
    }

    /// 这个连接的全部订阅都去掉，返回去掉的订阅 ID。
    pub fn drop_connection(&mut self, connection: &str) -> Vec<String> {
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.subscribers)
            .into_iter()
            .partition(|known| known.connection == connection);
        self.subscribers = kept;
        gone.into_iter().map(|known| known.subscription).collect()
    }

    pub fn subscribers(&self) -> &[Subscriber] {
        &self.subscribers
    }

    pub fn has_subscription(&self, subscription: &str) -> bool {
        self.subscribers
            .iter()
            .any(|known| known.subscription == subscription)
    }

    /// 给每个已经开始、落后于当前序号的订阅者一段增量。`paused` 的连接跳过（位置不动，
    /// 恢复后下一次 flush 补上）。日志本身按保留窗留着，供续传重放。
    ///
    /// 落后超出保留窗（`acked < floor`）时只能给空增量 + `from < to`：调用方据此改发快照。
    pub fn flush(&mut self, paused: &HashSet<String>) -> Vec<Batch<D>> {
        let seq = self.seq;
        let mut batches = Vec::new();
        for subscriber in &mut self.subscribers {
            let Some(acked) = subscriber.acked else {
                continue;
            };
            if acked >= seq || paused.contains(&subscriber.connection) {
                continue;
            }
            let deltas = if acked < self.floor {
                // 落后到保留窗之外：补齐不了，给空增量让调用方回快照。
                Vec::new()
            } else {
                self.log
                    .iter()
                    .filter(|(at, _)| *at > acked)
                    .flat_map(|(_, deltas)| deltas.iter().cloned())
                    .collect()
            };
            batches.push(Batch {
                subscription: subscriber.subscription.clone(),
                from: acked,
                to: seq,
                deltas,
            });
            subscriber.acked = Some(seq);
        }
        batches
    }
}

#[cfg(test)]
#[path = "delivery_tests.rs"]
mod tests;

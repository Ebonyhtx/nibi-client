//! 队列编辑（NIBI 的 queue 命令组：`editQueueItem` / `deleteQueueItem` / `reorderQueueItem` /
//! `lockQueueItemEdit` / `releaseQueueItemEdit` / `setAutoDrain` / `sendQueuedNow`）。
//!
//! 队列与通道只由 actor 持有（lane.rs）：这里只改队列状态，不开回合——`sendQueuedNow` 与
//! `setAutoDrain` 的"立刻开"例外，它们按 `sendQueuedNow` 的语义走同一条开回合路径。命令 ID 就是
//! 协议里的 `queueItemId`（协议层在投影里加了 `queue_` 前缀，处理器剥掉）。
//!
//! 编辑锁（U36）：锁的并发守卫取代 `editQueueItem` 的 CAS —— `editQueueItem` 不再要求
//! `baseRevision`。锁只允许加在 queued + 未加锁的项上；有锁时删除/重排/立即发送都拒绝，
//! 自动排空也不开加锁的队首（lane.rs）。释放是幂等的，任意端、任意状态都可调用。
//! 内核拒绝的 `reason` 以 reason code 前缀开头（`guard.queueItemEditLocked: ...`），协议层
//! 据此映射 ACK 的 `reasonCode`；未知前缀仍按原来的通用失败处理。
//!
//! v1 是 text-only：`EditQueued` 只改正文，附件/引用/模型选择等字段由协议投影保留队列项
//! 原值；内核没有 queued-intent store，不假装支持这些字段的改写。

use nibi_kernel_api::ids::CommandId;
use nibi_kernel_api::message::ContentBlock;
use nibi_kernel_api::session_api::{QueueEditLock, QueuedInput};

use crate::actor::{Actor, accepted, rejected};
use crate::bash::QueuedKind;
use crate::lane::Lane;
use crate::turn::TurnInput;

/// 队列项不在队列里（UI 按 noop 处理）。
pub(crate) const QUEUE_ITEM_MISSING: &str = "queue.itemMissing";
/// 项已被其他/本端加锁：加锁、编辑、删除、重排、立即发送都拒绝。
pub(crate) const QUEUE_ITEM_EDIT_LOCKED: &str = "guard.queueItemEditLocked";
/// 带 editorId 的编辑找不到锁（锁已丢失/被释放）。
pub(crate) const QUEUE_EDIT_LOCK_MISSING: &str = "queue.editLockMissing";
/// 带 editorId 的编辑发现锁属于另一个 editor（编辑权已转移）。
pub(crate) const QUEUE_EDIT_LOCK_LOST: &str = "guard.queueEditLockLost";
/// 项存在但不可编辑（typed maintenance 项等）。
#[allow(dead_code)]
pub(crate) const QUEUE_ITEM_NOT_EDITABLE: &str = "guard.queueItemNotEditable";

fn queue_rejected(code: &str, detail: impl std::fmt::Display) -> nibi_kernel_api::session_api::Ack {
    rejected(format!("{code}: {detail}"))
}

impl Actor {
    /// NIBI `editQueueItem`：同 id 原地更新正文（种类与位置不变）。不在队列里时拒绝（调用方按 noop）。
    /// 带内容块的输入改写文字块；bash 模式的输入改写命令原文。
    ///
    /// 编辑锁：`editor_id` 有值时必须与锁持有者一致，成功后锁自动释放；缺省时只允许无锁项。
    pub(crate) fn edit_queued(
        &mut self,
        item: CommandId,
        text: String,
        editor_id: Option<String>,
    ) -> nibi_kernel_api::session_api::Ack {
        let Some(index) = self.queue.iter().position(|input| input.command == item) else {
            return queue_rejected(QUEUE_ITEM_MISSING, format!("queue item {item} is no longer queued"));
        };
        if let Some(lock) = &self.queue[index].edit_lock {
            match editor_id.as_deref() {
                Some(editor) if editor == lock.editor_id => {}
                Some(_) => {
                    return queue_rejected(
                        QUEUE_EDIT_LOCK_LOST,
                        format!("the edit lock for {item} belongs to another editor"),
                    );
                }
                None => {
                    return queue_rejected(
                        QUEUE_ITEM_EDIT_LOCKED,
                        format!("queue item {item} is locked for editing"),
                    );
                }
            }
        } else if editor_id.is_some() {
            return queue_rejected(
                QUEUE_EDIT_LOCK_MISSING,
                format!("queue item {item} has no edit lock"),
            );
        }
        self.queue[index].text = text.clone();
        // 编辑成功即释放：锁只覆盖“选中到提交”这一段。
        self.queue[index].edit_lock = None;
        match self.queued_kinds.get_mut(&item) {
            Some(QueuedKind::Bash(line)) => *line = text,
            Some(QueuedKind::Content(content)) => {
                let mut replaced = false;
                for block in content.iter_mut() {
                    if let ContentBlock::Text { text: existing } = block {
                        *existing = text.clone();
                        replaced = true;
                        break;
                    }
                }
                // 纯图片输入没有文字块：补一条，改写的正文才算数。
                if !replaced {
                    content.push(ContentBlock::Text { text });
                }
            }
            None => {}
        }
        self.emit_queue();
        accepted()
    }

    /// NIBI `lockQueueItemEdit`：只允许 queued + 未加锁的项。锁的持有者由 `editor_id` 标识
    /// （客户端会话级 editorId），`client_id` 与 `input_origin` 只用于其他端的显示。
    pub(crate) fn lock_queued_edit(
        &mut self,
        item: CommandId,
        editor_id: String,
        client_id: String,
        input_origin: Option<String>,
    ) -> nibi_kernel_api::session_api::Ack {
        let Some(index) = self.queue.iter().position(|input| input.command == item) else {
            return queue_rejected(QUEUE_ITEM_MISSING, format!("queue item {item} is no longer queued"));
        };
        if self.queue[index].edit_lock.is_some() {
            return queue_rejected(
                QUEUE_ITEM_EDIT_LOCKED,
                format!("queue item {item} is already locked for editing"),
            );
        }
        self.queue[index].edit_lock = Some(QueueEditLock {
            editor_id,
            client_id,
            input_origin,
        });
        self.emit_queue();
        accepted()
    }

    /// NIBI `releaseQueueItemEdit`：任意端、任意状态都可释放；锁不存在或项已出队时幂等成功。
    pub(crate) fn release_queued_edit(&mut self, item: CommandId) -> nibi_kernel_api::session_api::Ack {
        let Some(index) = self.queue.iter().position(|input| input.command == item) else {
            return accepted();
        };
        if self.queue[index].edit_lock.take().is_some() {
            self.emit_queue();
        }
        accepted()
    }

    /// NIBI `deleteQueueItem`：从队列、通道与种类表里移除。不在队列里时拒绝；加锁时拒绝。
    pub(crate) fn delete_queued(&mut self, item: CommandId) -> nibi_kernel_api::session_api::Ack {
        let Some(index) = self.queue.iter().position(|input| input.command == item) else {
            return queue_rejected(QUEUE_ITEM_MISSING, format!("queue item {item} is no longer queued"));
        };
        if self.queue[index].edit_lock.is_some() {
            return queue_rejected(
                QUEUE_ITEM_EDIT_LOCKED,
                format!("queue item {item} is locked for editing"),
            );
        }
        self.remove_input(&item);
        self.queued_kinds.remove(&item);
        self.screened.remove(&item);
        self.emit_queue();
        accepted()
    }

    /// NIBI `reorderQueueItem`：把一项移到 `before` 之前（None = 队尾）。通道里同一项的位置跟着走。
    pub(crate) fn reorder_queued(
        &mut self,
        item: CommandId,
        before: Option<CommandId>,
    ) -> nibi_kernel_api::session_api::Ack {
        if before.as_ref() == Some(&item) {
            return accepted();
        }
        let Some(from) = self.queue.iter().position(|input| input.command == item) else {
            return queue_rejected(QUEUE_ITEM_MISSING, format!("queue item {item} is no longer queued"));
        };
        if self.queue[from].edit_lock.is_some() {
            return queue_rejected(
                QUEUE_ITEM_EDIT_LOCKED,
                format!("queue item {item} is locked for editing"),
            );
        }
        let input = self
            .queue
            .remove(from)
            .unwrap_or_else(|| unreachable!("the item was found above"));
        let to = match &before {
            Some(target) => match self.queue.iter().position(|queued| queued.command == *target) {
                Some(position) => position,
                // 目标项不在：拒绝，原项放回原位。
                None => {
                    self.queue.insert(from.min(self.queue.len()), input);
                    return queue_rejected(
                        QUEUE_ITEM_MISSING,
                        format!("queue item {target} is no longer queued"),
                    );
                }
            },
            None => self.queue.len(),
        };
        self.queue.insert(to, input);
        self.reorder_lane_like_queue();
        self.emit_queue();
        accepted()
    }

    /// NIBI `setAutoDrain`：关掉后回合结束不再自动开队首；打开且空闲时立刻按队列开回合
    /// （Node 的 `queue_auto_drain_resumed` 走同一个"立即提升队首"的语义）。
    pub(crate) async fn set_auto_drain(
        &mut self,
        enabled: bool,
    ) -> nibi_kernel_api::session_api::Ack {
        self.auto_drain = enabled;
        if enabled && !self.busy() {
            self.start_next().await;
        }
        accepted()
    }

    /// NIBI `sendQueuedNow`：把一项从队列取出。忙时记为 `promote` 并中止当前回合（回合收尾的
    /// `start_next` 先开它）；空闲时直接开。
    pub(crate) async fn send_queued_now(
        &mut self,
        item: CommandId,
    ) -> nibi_kernel_api::session_api::Ack {
        let Some(index) = self.queue.iter().position(|input| input.command == item) else {
            return queue_rejected(QUEUE_ITEM_MISSING, format!("queue item {item} is no longer queued"));
        };
        if self.queue[index].edit_lock.is_some() {
            return queue_rejected(
                QUEUE_ITEM_EDIT_LOCKED,
                format!("queue item {item} is locked for editing"),
            );
        }
        let input = self
            .queue
            .remove(index)
            .unwrap_or_else(|| unreachable!("the item was found above"));
        // 通道里可能已经领取过它（UPS 已跑）：出队并丢掉筛查结果，按新回合重跑。
        self.lane
            .retain(|lane| !matches!(lane, Lane::Input(queued) if *queued == item));
        self.screened.remove(&item);
        let kind = self.queued_kinds.remove(&item);
        self.emit_queue();
        if self.busy() {
            self.promote = Some((input, kind));
            let _ = self.interrupt().await;
            return accepted();
        }
        self.start_promoted(input, kind).await;
        accepted()
    }

    /// 被提升的输入开回合（与 `next_turn_input` 的排法一致：bash / 内容块 / 普通文字）。
    pub(crate) async fn start_promoted(
        &mut self,
        input: QueuedInput,
        kind: Option<QueuedKind>,
    ) {
        let turn = self.promoted_input(input, kind);
        if let Err(reason) = self.start_turn(turn).await {
            tracing::warn!(%reason, "the promoted queued input could not start a turn");
        }
    }

    /// 提升项的回合输入（`start_next` 与空闲时的 `sendQueuedNow` 共用）。
    pub(crate) fn promoted_input(
        &mut self,
        input: QueuedInput,
        kind: Option<QueuedKind>,
    ) -> TurnInput {
        match kind {
            Some(QueuedKind::Bash(line)) => TurnInput::Bash {
                command: input.command,
                line,
            },
            Some(QueuedKind::Content(content)) => TurnInput::Content {
                command: input.command,
                content,
            },
            None => {
                let screened = self.screened.remove(&input.command).flatten();
                let more = self.take_batch(&input.command, &input.text);
                TurnInput::Human {
                    screened,
                    command: input.command,
                    text: input.text,
                    more,
                }
            }
        }
    }

    /// 通道里 `Lane::Input` 的相对顺序跟着队列走（通知的位置不动）。
    fn reorder_lane_like_queue(&mut self) {
        let order: Vec<CommandId> = self.queue.iter().map(|input| input.command.clone()).collect();
        let mut inputs: Vec<CommandId> = self
            .lane
            .iter()
            .filter_map(|lane| match lane {
                Lane::Input(command) => Some(command.clone()),
                Lane::Notice(_) => None,
            })
            .collect();
        inputs.sort_by_key(|command| {
            order
                .iter()
                .position(|queued| queued == command)
                .unwrap_or(usize::MAX)
        });
        let mut inputs = inputs.into_iter();
        for lane in self.lane.iter_mut() {
            if matches!(lane, Lane::Input(_))
                && let Some(command) = inputs.next()
            {
                *lane = Lane::Input(command);
            }
        }
    }
}

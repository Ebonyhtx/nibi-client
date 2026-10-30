//! 队列编辑（NIBI 的 queue 命令组：`editQueueItem` / `deleteQueueItem` / `reorderQueueItem` /
//! `setAutoDrain` / `sendQueuedNow`）。
//!
//! 队列与通道只由 actor 持有（lane.rs）：这里只改队列状态，不开回合——`sendQueuedNow` 与
//! `setAutoDrain` 的"立刻开"例外，它们按 `sendQueuedNow` 的语义走同一条开回合路径。命令 ID 就是
//! 协议里的 `queueItemId`（协议层在投影里加了 `queue_` 前缀，处理器剥掉）。

use rust_cli_kernel_api::ids::CommandId;
use rust_cli_kernel_api::session_api::QueuedInput;
use rust_cli_kernel_api::message::ContentBlock;

use crate::actor::{Actor, accepted, rejected};
use crate::bash::QueuedKind;
use crate::lane::Lane;
use crate::turn::TurnInput;

impl Actor {
    /// NIBI `editQueueItem`：同 id 原地更新正文（种类与位置不变）。不在队列里时拒绝（调用方按 noop）。
    /// 带内容块的输入改写文字块；bash 模式的输入改写命令原文。
    pub(crate) fn edit_queued(&mut self, item: CommandId, text: String) -> rust_cli_kernel_api::session_api::Ack {
        let Some(index) = self.queue.iter().position(|input| input.command == item) else {
            return rejected(format!("queue item {item} is no longer queued"));
        };
        self.queue[index].text = text.clone();
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

    /// NIBI `deleteQueueItem`：从队列、通道与种类表里移除。不在队列里时拒绝。
    pub(crate) fn delete_queued(&mut self, item: CommandId) -> rust_cli_kernel_api::session_api::Ack {
        if !self.queue.iter().any(|input| input.command == item) {
            return rejected(format!("queue item {item} is no longer queued"));
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
    ) -> rust_cli_kernel_api::session_api::Ack {
        if before.as_ref() == Some(&item) {
            return accepted();
        }
        let Some(from) = self.queue.iter().position(|input| input.command == item) else {
            return rejected(format!("queue item {item} is no longer queued"));
        };
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
                    return rejected(format!("queue item {target} is no longer queued"));
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
    ) -> rust_cli_kernel_api::session_api::Ack {
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
    ) -> rust_cli_kernel_api::session_api::Ack {
        let Some(index) = self.queue.iter().position(|input| input.command == item) else {
            return rejected(format!("queue item {item} is no longer queued"));
        };
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

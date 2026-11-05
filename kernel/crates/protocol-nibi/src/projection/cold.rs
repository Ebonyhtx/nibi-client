//! 冷投影：从会话视图（已提交的消息）重建行。没有事件的时间，行的时间取会话的创建时间；回合以真人输入为界。

use nibi_kernel_api::message::{ContentBlock, Message, SystemMessage, UserOrigin};
use nibi_kernel_api::session_api::{
    SequencedEvent, SessionView, TurnExecutionKind, TurnInputSource,
};
use nibi_kernel_api::user_input::INTERRUPT_TEXTS;

use super::{Projection, state::Phase, tool_key};

/// 通知轮的来源标签集合：内核自己的（`task-notification`）与 Node 记录上的两个拼写
/// （跨库读时 hydrate 原样保留 `background_task` / `task_notification`）。
const NOTICE_TURN_SOURCES: [&str; 3] = [
    "task-notification",
    "background_task",
    "task_notification",
];

/// 从视图的消息建行；阶段按最后一个回合与 `running` 定。
pub(super) fn rows(projection: &mut Projection, view: &SessionView) {
    let at = view.meta.created_at_ms;
    let mut out = Vec::new();
    let mut turns = 0u64;
    let mut interrupted = false;
    // 每轮用户输入时刻的模型选择：与上一轮不同才画 `modelChange` 分隔线（Node transcript hydration 同判据）。
    let selections: std::collections::HashMap<&str, &nibi_kernel_api::model::ModelSelection> =
        view.model_turns
            .iter()
            .map(|turn| (turn.message.as_str(), &turn.selection))
            .collect();
    let mut previous_selection = None;
    for message in &view.messages {
        match message {
            Message::User(user)
                if user.origin == UserOrigin::Human
                    && !INTERRUPT_TEXTS.contains(&super::text_of(&user.content).as_str()) =>
            {
                if projection.turn.is_some() {
                    projection.close_cold_turn(interrupted, at, &mut out);
                }
                interrupted = false;
                turns += 1;
                let turn = format!("{}:turn:{turns}", user.id.as_str());
                model_change(
                    projection,
                    &selections,
                    &mut previous_selection,
                    &user.id,
                    &turn,
                    at,
                    &mut out,
                );
                // 工作流控制轮（NIBI 中枢启动/设置轮，launch.md）：消息记录带 `source: "workflow_launch"`
                // 的 user 消息按 controlOnly 重建（Node transcript-hydration 的 workflowLaunchOfMessage
                // 同一判据）；清单里没有或元数据缺席时退回普通 agent 轮。
                let launch = view
                    .launches
                    .iter()
                    .find(|entry| entry.message == user.id)
                    .map(|entry| &entry.launch)
                    .filter(|launch| !launch.is_null());
                projection.start_turn(
                    &turn,
                    None,
                    launch.map(|_| TurnExecutionKind::ControlOnly),
                    launch,
                    None,
                    None,
                    at,
                    0,
                    &mut out,
                );
                projection.message(message, at, 0, &mut out);
            }
            // 后台通知开的 model-only 轮（`<task-notification>` 信封的 meta 消息）：自己是一轮、
            // 无可见气泡，其后的 assistant 归本轮（Node transcript-hydration 的 model-only
            // trigger 同构，`turnHeaderOrigin("background_task") = "backgroundResult"`）。同伴
            // 消息在 Node 的表里落默认 userInput，不在这里开轮。
            Message::User(user)
                if matches!(
                    &user.origin,
                    UserOrigin::Meta { source, .. } if NOTICE_TURN_SOURCES.contains(&source.as_str())
                ) =>
            {
                if projection.turn.is_some() {
                    projection.close_cold_turn(interrupted, at, &mut out);
                }
                interrupted = false;
                turns += 1;
                let turn = format!("{}:turn:{turns}", user.id.as_str());
                model_change(
                    projection,
                    &selections,
                    &mut previous_selection,
                    &user.id,
                    &turn,
                    at,
                    &mut out,
                );
                let origin_meta = match &user.origin {
                    UserOrigin::Meta { origin_meta, .. } => origin_meta.clone(),
                    _ => None,
                };
                projection.start_turn(
                    &turn,
                    None,
                    None,
                    None,
                    Some(TurnInputSource::BackgroundTask),
                    origin_meta.as_ref(),
                    at,
                    0,
                    &mut out,
                );
            }
            Message::User(user) => {
                if INTERRUPT_TEXTS.contains(&super::text_of(&user.content).as_str()) {
                    interrupted = true;
                }
                // 工具结果：给对应的工具行结果。
                for block in &user.content {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } = block
                    {
                        let output = nibi_kernel_api::tool::ToolOutput {
                            content: content.clone(),
                            is_error: *is_error,
                            display: serde_json::Value::Null,
                        };
                        let event = SequencedEvent {
                            seq: 0,
                            event: nibi_kernel_api::session_api::KernelEvent::ToolDone {
                                tool_use: tool_use_id.clone(),
                                output,
                            },
                            revision: projection.revision,
                        };
                        if projection
                            .index
                            .contains_key(&tool_key(tool_use_id.as_str()))
                        {
                            projection.apply(&event, at);
                        }
                    }
                }
            }
            Message::Assistant(_) => projection.message(message, at, 0, &mut out),
            Message::System(SystemMessage::CompactBoundary(boundary)) => {
                projection.compact_boundary(boundary, at, 0, &mut out);
            }
            Message::System(SystemMessage::Interrupted { .. }) => interrupted = true,
            _ => {}
        }
    }
    if projection.turn.is_some() {
        if view.running {
            projection.phase = Phase::Running;
        } else {
            projection.close_cold_turn(interrupted, at, &mut out);
        }
    }
}

/// 这一轮的用户输入换了 provider/model：在轮头之前补一行 `modelChange` 分隔线。
/// 第一轮没有「上一轮」可比，不画（Node 的 source-less 情形不落行）。
fn model_change(
    projection: &mut Projection,
    selections: &std::collections::HashMap<&str, &nibi_kernel_api::model::ModelSelection>,
    previous: &mut Option<nibi_kernel_api::model::ModelSelection>,
    message: &nibi_kernel_api::ids::MessageId,
    turn: &str,
    at: u64,
    out: &mut Vec<serde_json::Value>,
) {
    let Some(selection) = selections.get(message.as_str()) else {
        return;
    };
    if let Some(from) = previous.as_ref()
        && (from.provider != selection.provider || from.model != selection.model)
    {
        projection.append_model_change(turn, from, selection, at, 0, out);
    }
    *previous = Some((*selection).clone());
}

impl Projection {
    fn close_cold_turn(&mut self, interrupted: bool, at: u64, out: &mut Vec<serde_json::Value>) {
        let Some(turn) = self.turn.as_ref().map(|turn| turn.id.clone()) else {
            return;
        };
        let control_only = self.turn.as_ref().is_some_and(|turn| {
            turn.execution_kind == Some(TurnExecutionKind::ControlOnly)
        });
        let outcome = if interrupted {
            nibi_kernel_api::session_api::TurnOutcome::Interrupted
        } else {
            nibi_kernel_api::session_api::TurnOutcome::Success
        };
        self.finish_turn(&turn, &outcome, None, control_only, at, out);
    }
}

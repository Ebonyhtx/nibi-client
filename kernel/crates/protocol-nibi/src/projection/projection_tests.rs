//! 投影的纯函数测试：合成的内核事件 → App 的行与状态。

use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{
    CommandId, EnvironmentId, InteractionId, MessageId, SessionId, ToolUseId, TraceId, TurnId,
};
use nibi_kernel_api::message::{
    AssistantMessage, Message, UserMessage, UserOrigin, TASK_NOTIFICATION_SOURCE,
};
use nibi_kernel_api::model::BlockDelta;
use nibi_kernel_api::orchestration::InteractionRequest;
use nibi_kernel_api::store::{SessionKind, SessionLaunchTurn, SessionMeta};
use nibi_kernel_api::testing::selection;
use serde_json::json;

use super::*;

fn view(messages: Vec<Message>) -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: SessionId::new("session_1"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
        },
        messages,
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
        pending: Vec::new(),
        queue: Vec::new(),
        last_seq: 0,
        revision: 0,
        running: false,
        background: Vec::new(),
        peer_held: Vec::new(),
        context_usage: None,
        context_notice: Default::default(),
        output_speed: None,
        launches: Vec::new(),
        model_turns: Vec::new(),
        input_intents: Vec::new(),
    }
}

fn user(id: &str, text: &str) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text { text: text.into() }],
        origin: UserOrigin::Human,
    })
}

fn assistant(id: &str, content: Vec<ContentBlock>) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content,
        model: "m".into(),
        stop_reason: None,
        usage: None,
    })
}

/// 按顺序喂事件（seq 从 1 起，revision 照会话 actor 的规则：状态变化加一）。
struct Feed {
    projection: Projection,
    seq: u64,
    revision: u64,
}

impl Feed {
    fn new() -> Self {
        Self {
            projection: Projection::from_view(
                &view(Vec::new()),
                Followup::Queue,
                vec!["high".into()],
            ),
            seq: 0,
            revision: 0,
        }
    }

    fn apply(&mut self, event: KernelEvent) -> Vec<Value> {
        self.seq += 1;
        if !matches!(
            event,
            KernelEvent::StreamDelta { .. } | KernelEvent::ContextUsage { .. }
        ) {
            self.revision += 1;
        }
        self.projection.apply(
            &SequencedEvent {
                seq: self.seq,
                event,
                revision: self.revision,
            },
            2000 + self.seq,
        )
    }
}

fn ops(deltas: &[Value]) -> Vec<String> {
    deltas
        .iter()
        .map(|delta| match delta["op"].as_str().unwrap() {
            "state.updated" => {
                let mut keys: Vec<&str> = delta["patch"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect();
                keys.sort_unstable();
                format!("state({})", keys.join(","))
            }
            op if delta.get("row").is_some() => {
                format!("{op}({})", delta["row"]["kind"].as_str().unwrap())
            }
            op => op.to_owned(),
        })
        .collect()
}

#[test]
fn a_text_turn_becomes_rows_and_control_states() {
    let mut feed = Feed::new();
    let started = feed.apply(KernelEvent::TurnStarted {
        execution_kind: None,
        input_source: None,
        origin_meta: None,
        workflow_launch: None,
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    assert_eq!(
        ops(&started),
        [
            "row.appended(turnHeader)",
            "state(availability,control,inputRouting,revision)"
        ]
    );
    let patch = &started[1]["patch"];
    assert_eq!(patch["control"]["phase"], "running");
    assert_eq!(patch["control"]["canStop"], true);
    assert_eq!(
        patch["control"]["activeWorks"][0]["foregroundExecutionId"],
        "runtime_command_1"
    );
    assert_eq!(patch["inputRouting"]["mode"], "enqueue");
    let input = feed.apply(KernelEvent::MessageDone {
        message: user("msg_u1", "hello"),
    });
    assert_eq!(input[0]["row"]["text"], "hello");
    assert_eq!(input[0]["row"]["sourceCommandId"], "c1");
    let delta = |text: &str| KernelEvent::StreamDelta {
        turn: TurnId::new("turn_1"),
        response: 0,
        index: 0,
        delta: BlockDelta::Text(text.into()),
    };
    assert_eq!(
        ops(&feed.apply(delta("hi "))),
        ["row.appended(assistantText)", "row.delta"]
    );
    assert_eq!(ops(&feed.apply(delta("there"))), ["row.delta"]);
    let done = feed.apply(KernelEvent::MessageDone {
        message: assistant(
            "msg_a1",
            vec![ContentBlock::Text {
                text: "hi there".into(),
            }],
        ),
    });
    assert_eq!(done[0]["row"]["state"], "complete");
    assert_eq!(done[0]["row"]["text"], "hi there");
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: Some(Usage {
            input_tokens: 10,
            output_tokens: 3,
            ..Usage::default()
        }),
    });
    // 收口后行级动作一起来：输入可编辑、回复可重试/分叉（141 审计行级 actions）。
    assert_eq!(
        ops(&finished),
        [
            "row.upserted(turnHeader)",
            "row.upserted(userInput)",
            "row.upserted(assistantText)",
            "state(availability,control,inputRouting,revision,usage)"
        ]
    );
    assert_eq!(finished[0]["row"]["state"], "completedSuccess");
    assert_eq!(finished[1]["row"]["actions"]["canEdit"], true);
    assert_eq!(finished[2]["row"]["actions"]["canRetry"], true);
    assert_eq!(finished[2]["row"]["actions"]["canFork"], true);
    assert_eq!(finished[3]["patch"]["control"]["phase"], "completedSuccess");
    assert_eq!(
        finished[3]["patch"]["usage"]["cumulative"]["outputTokens"],
        3
    );
    let snapshot = feed.projection.snapshot(9, "epoch-1");
    let kinds: Vec<&str> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["turnHeader", "userInput", "assistantText"]);
    assert_eq!(snapshot["rows"]["firstRowId"], 1);
    assert_eq!(snapshot["seq"], 9);
    assert_eq!(snapshot["revision"], feed.revision);
    assert_eq!(snapshot["config"]["followupMode"], "queue");
    assert_eq!(feed.projection.last_reply().as_deref(), Some("hi there"));
}

#[test]
fn a_permission_ask_marks_the_tool_and_lists_the_interaction() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        execution_kind: None,
        input_source: None,
        origin_meta: None,
        workflow_launch: None,
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let tool = ToolUseId::new("toolu_1");
    feed.apply(KernelEvent::MessageDone {
        message: assistant(
            "msg_a1",
            vec![ContentBlock::ToolUse {
                id: tool.clone(),
                name: "Write".into(),
                input: json!({"file_path": "/w/a.txt"}),
            }],
        ),
    });
    let asked = feed.apply(KernelEvent::InteractionAsked {
        interaction: InteractionId::new("int_1"),
        request: InteractionRequest::Permission {
            tool_use: tool.clone(),
            tool: "Write".into(),
            input: json!({"file_path": "/w/a.txt"}),
            message: "Write a.txt?".into(),
            suggestions: Vec::new(),
            asked_by: None,
            machine: None,
        },
    });
    assert_eq!(asked[0]["row"]["status"], "pendingApproval");
    assert_eq!(asked[0]["row"]["approvalInteractionId"], "int_1");
    let pending = &asked[1]["patch"]["pendingInteractions"][0];
    assert_eq!(pending["interactionId"], "int_1");
    assert_eq!(pending["anchorRowId"], asked[0]["row"]["rowId"]);
    assert_eq!(pending["payload"]["toolCallId"], "toolu_1");
    assert_eq!(
        pending["payload"]["fullAccessOption"]["optionId"],
        "fullAccess"
    );
    assert_eq!(pending["payload"]["options"].as_array().unwrap().len(), 3);
    assert_eq!(feed.projection.pending_permissions(), 1);
    let resolved = feed.apply(KernelEvent::InteractionResolved {
        interaction: InteractionId::new("int_1"),
    });
    assert_eq!(resolved[0]["row"]["status"], "running");
    assert_eq!(resolved[1]["patch"]["pendingInteractions"], json!([]));
    let done = feed.apply(KernelEvent::ToolDone {
        tool_use: tool,
        output: nibi_kernel_api::tool::ToolOutput {
            content: vec![ToolResultContent::Text { text: "ok".into() }],
            is_error: false,
            display: Value::Null,
        },
    });
    assert_eq!(done[0]["row"]["status"], "success");
    assert_eq!(done[0]["row"]["output"]["text"], "ok");
}

#[test]
fn an_interrupted_turn_cancels_running_tools() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        execution_kind: None,
        input_source: None,
        origin_meta: None,
        workflow_launch: None,
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::ToolStarted {
        tool_use: ToolUseId::new("toolu_1"),
        name: "Bash".into(),
        input: json!({"command": "sleep 60"}),
    });
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Interrupted,
        usage: None,
    });
    let rows: Vec<(&str, &str)> = finished
        .iter()
        .filter_map(|delta| {
            let row = delta.get("row")?;
            Some((
                row["kind"].as_str()?,
                row["status"].as_str().or(row["state"].as_str())?,
            ))
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("toolCall", "cancelled"),
            ("turnHeader", "completedInterrupted")
        ]
    );
    assert_eq!(feed.projection.phase(), Phase::CompletedInterrupted);
}

#[test]
fn a_cold_view_rebuilds_the_rows_of_finished_turns() {
    let projection = Projection::from_view(
        &view(vec![
            user("msg_u1", "first"),
            assistant("msg_a1", vec![ContentBlock::Text { text: "one".into() }]),
            user("msg_u2", "second"),
            assistant("msg_a2", vec![ContentBlock::Text { text: "two".into() }]),
        ]),
        Followup::Guide,
        Vec::new(),
    );
    let snapshot = projection.snapshot(0, "epoch");
    let rows: Vec<String> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "{}:{}",
                row["kind"].as_str().unwrap(),
                row["text"].as_str().or(row["state"].as_str()).unwrap_or("")
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            "turnHeader:completedSuccess",
            "userInput:first",
            "assistantText:one",
            "turnHeader:completedSuccess",
            "userInput:second",
            "assistantText:two",
        ]
    );
    assert_eq!(snapshot["control"]["phase"], "completedSuccess");
    assert_eq!(snapshot["inputRouting"]["mode"], "startNow");
    assert_eq!(snapshot["config"]["followupMode"], "guide");
}

/// revision 只在事件带来的值变了时才进 patch；流式增量不带 patch。
#[test]
fn the_revision_comes_from_the_events_only() {
    let mut projection = Projection::from_view(&view(Vec::new()), Followup::Queue, Vec::new());
    let event = |seq, revision, event| SequencedEvent {
        seq,
        event,
        revision,
    };
    let deltas = projection.apply(
        &event(1, 4, KernelEvent::TitleChanged { title: "t".into() }),
        0,
    );
    assert_eq!(deltas[0]["patch"]["revision"], 4);
    assert_eq!(deltas[0]["patch"]["meta"]["title"], "t");
    let deltas = projection.apply(
        &event(
            2,
            4,
            KernelEvent::ContextUsage {
                used_tokens: 5,
                max_tokens: 10,
                window_tokens: None,
            },
        ),
        0,
    );
    assert!(deltas[0]["patch"].get("revision").is_none());
    assert_eq!(projection.revision(), 4);
    let changed = projection.set_followup(Followup::Guide);
    assert_eq!(changed["patch"]["config"]["followupMode"], "guide");
}

/// 对拍找到的三处（与 Node 相同）：拒绝了的工具调用投成 cancelled；中断后补的那条消息不出行；空闲时提交的输入不投成排队项。
#[test]
fn denied_tools_interrupt_markers_and_immediate_inputs_follow_node() {
    let mut feed = Feed::new();
    feed.projection.remember_input(
        "c1",
        InputMeta {
            client: "k".into(),
            origin: None,
            text: "hi".into(),
            selection: None,
            mode: None,
            plan: None,
            admitted_at: 0,
            requested: "startNow",
            admitted: "startNow",
            attachments: None,
            intent: None,
        },
    );
    let queued = feed.apply(KernelEvent::QueueChanged {
        items: vec![QueuedInput {
            command: CommandId::new("c1"),
            text: "hi".into(),
            delivery: nibi_kernel_api::session_api::Delivery::Queue,
        }],
    });
    assert!(
        queued
            .iter()
            .all(|delta| delta["patch"].get("queue").is_none())
    );
    feed.apply(KernelEvent::TurnStarted {
        execution_kind: None,
        input_source: None,
        origin_meta: None,
        workflow_launch: None,
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    feed.apply(KernelEvent::ToolStarted {
        tool_use: ToolUseId::new("toolu_1"),
        name: "Bash".into(),
        input: json!({"command": "rm -rf x"}),
    });
    feed.projection.deny("toolu_1");
    let done = feed.apply(KernelEvent::ToolDone {
        tool_use: ToolUseId::new("toolu_1"),
        output: nibi_kernel_api::tool::ToolOutput {
            content: vec![ToolResultContent::Text {
                text: "denied".into(),
            }],
            is_error: true,
            display: Value::Null,
        },
    });
    assert_eq!(done[0]["row"]["status"], "cancelled");
    let marker = feed.apply(KernelEvent::MessageDone {
        message: user("msg_i", nibi_kernel_api::user_input::INTERRUPT_TEXTS[0]),
    });
    assert!(marker.iter().all(|delta| delta.get("row").is_none()));
}

#[test]
fn assistant_feedback_marks_the_settled_row() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        execution_kind: None,
        input_source: None,
        origin_meta: None,
        workflow_launch: None,
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    feed.apply(KernelEvent::MessageDone {
        message: assistant(
            "msg_a1",
            vec![ContentBlock::Text {
                text: "an answer".into(),
            }],
        ),
    });
    // 点赞：已落定的 assistantText 行原地更新。
    let liked = feed.projection.set_feedback("msg_a1", Some("like".to_owned()));
    assert_eq!(liked.len(), 1, "{liked:?}");
    assert_eq!(liked[0]["op"], "row.upserted");
    assert_eq!(liked[0]["row"]["kind"], "assistantText");
    assert_eq!(liked[0]["row"]["feedback"], "like");
    // 取消：字段被去掉。
    let cleared = feed.projection.set_feedback("msg_a1", None);
    assert_eq!(cleared[0]["row"].get("feedback"), None);
    // 同值再点一次：不发增量。
    assert!(feed.projection.set_feedback("msg_a1", None).is_empty());
    // 行还没落定时先记：落定后带上（这里只验证不 panic 与空增量）。
    assert!(feed.projection.set_feedback("msg_none", Some("dislike".to_owned())).is_empty());
}

/// 中枢直接启动的启动轮（launch.md）：controlOnly 的轮头与输入行——workflowLaunch origin、
/// 元数据上行、不推进 running、收口不带 activeMs；draft 会话照 leaveDraft 推进终态。
#[test]
fn the_hub_launch_turn_renders_as_a_control_only_row() {
    let mut feed = Feed::new();
    let launch = json!({
        "runId": "dwfrun_1", "toolCallId": "launch-1",
        "name": "amend", "scope": "project",
    });
    let started = feed.apply(KernelEvent::TurnStarted {
        execution_kind: Some(TurnExecutionKind::ControlOnly),
        input_source: None,
        origin_meta: None,
        workflow_launch: Some(launch.clone()),
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    // control 不进 running（Node 的 onTurnStarted 只在 agent 分支动 control）：除了行与
    // revision 没有别的状态增量。
    assert_eq!(
        ops(&started),
        ["row.appended(turnHeader)", "state(revision)"],
        "{started:?}",
    );
    let header = &started[0]["row"];
    assert_eq!(header["origin"], "workflowLaunch");
    assert_eq!(header["executionKind"], "controlOnly");
    assert_eq!(header["workflowLaunch"], launch);
    assert_eq!(header["sourceCommandId"], "c1");
    assert_eq!(header["state"], "running");
    let input = feed.apply(KernelEvent::MessageDone {
        message: user("msg_u1", "Started the saved workflow \"amend\" (project) from the workflows hub as run dwfrun_1."),
    });
    assert_eq!(
        ops(&input),
        ["row.appended(userInput)", "state(revision)"],
        "{input:?}",
    );
    assert_eq!(input[0]["row"]["origin"], "workflowLaunch");
    assert_eq!(input[0]["row"]["workflowLaunch"], launch);
    assert_eq!(input[0]["row"]["sourceCommandId"], "c1");
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    // draft 会话推进终态（leaveDraftAfterControlOnlyTurn），但不补 usage，轮头不带 activeMs。
    assert_eq!(
        ops(&finished),
        ["row.upserted(turnHeader)", "state(availability,control,inputRouting,revision)"],
        "{finished:?}",
    );
    assert_eq!(finished[0]["row"]["state"], "completedSuccess");
    assert_eq!(finished[0]["row"].get("activeMs"), None);
    assert_eq!(finished[1]["patch"]["control"]["phase"], "completedSuccess");
    assert_eq!(finished[1]["patch"].get("usage"), None);
}

/// 已经开过的会话上的控制轮（设置轮）：照旧不碰 session control（Node：非 draft 会话上的
/// 控制轮不伪造 running / 工时）。
#[test]
fn a_control_turn_on_a_started_session_leaves_control_alone() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        execution_kind: None,
        input_source: None,
        origin_meta: None,
        workflow_launch: None,
        turn: TurnId::new("turn_0"),
        command: Some(CommandId::new("c0")),
    });
    feed.apply(KernelEvent::MessageDone {
        message: user("msg_u0", "hello"),
    });
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_0"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    let started = feed.apply(KernelEvent::TurnStarted {
        execution_kind: Some(TurnExecutionKind::ControlOnly),
        input_source: None,
        origin_meta: None,
        workflow_launch: Some(json!({"runId": "dwfrun_2"})),
        turn: TurnId::new("turn_1"),
        command: None,
    });
    assert_eq!(
        ops(&started),
        ["row.appended(turnHeader)", "state(revision)"],
        "{started:?}",
    );
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    // 只收口轮头；control 与 usage 都不动。
    assert_eq!(
        ops(&finished),
        ["row.upserted(turnHeader)", "state(revision)"],
        "{finished:?}",
    );
    assert_eq!(finished[0]["row"]["state"], "completedSuccess");
}

/// 冷投影：视图带工作流控制轮清单时，启动/设置轮按 controlOnly 重建（Node transcript-hydration
/// 的 workflowLaunchOfMessage）；清单没有的真人输入照旧是 agent 轮。
#[test]
fn the_cold_projection_rebuilds_launch_turns_as_control_only() {
    let launch = json!({"runId": "dwfrun_1", "toolCallId": "launch-1", "name": "amend"});
    let mut view = view(vec![
        user("msg_launch", "Started the saved workflow \"amend\" (project)."),
        user("msg_real", "hello"),
    ]);
    view.launches = vec![SessionLaunchTurn {
        message: MessageId::new("msg_launch"),
        launch: launch.clone(),
    }];
    let projection = Projection::from_view(&view, Followup::Queue, Vec::new());
    let snapshot = projection.snapshot(9, "epoch-1");
    let rows = snapshot["rows"]["window"].as_array().unwrap();
    let headers: Vec<_> = rows
        .iter()
        .filter(|row| row["kind"] == "turnHeader")
        .collect();
    assert_eq!(headers.len(), 2, "{rows:?}");
    assert_eq!(headers[0]["origin"], "workflowLaunch");
    assert_eq!(headers[0]["executionKind"], "controlOnly");
    assert_eq!(headers[0]["workflowLaunch"], launch);
    // 收口在消息末尾：控制轮没有 activeMs；后面那条真人输入还是普通 agent 轮。
    assert_eq!(headers[0]["state"], "completedSuccess");
    assert_eq!(headers[0].get("activeMs"), None);
    assert_eq!(headers[1]["origin"], "userInput");
    assert_eq!(headers[1]["executionKind"], "agent");
    let inputs: Vec<_> = rows
        .iter()
        .filter(|row| row["kind"] == "userInput")
        .collect();
    assert_eq!(inputs[0]["origin"], "workflowLaunch");
    assert_eq!(inputs[0]["workflowLaunch"], launch);
    assert_eq!(inputs[1]["origin"], "realUser");
}

/// 后台通知开的 model-only 轮：轮头 origin backgroundResult、无用户气泡、照常是 agent 轮
/// （有工时、control 推进 running）。
#[test]
fn a_background_notification_turn_reads_as_a_background_result_header() {
    let mut feed = Feed::new();
    let started = feed.apply(KernelEvent::TurnStarted {
        input_source: Some(TurnInputSource::BackgroundTask),
        origin_meta: None,
        execution_kind: None,
        workflow_launch: None,
        turn: TurnId::new("turn_1"),
        command: None,
    });
    // 真实 agent 轮：control 照常推进 running，只是 origin 不同。
    assert_eq!(
        ops(&started),
        [
            "row.appended(turnHeader)",
            "state(availability,control,inputRouting,revision)",
        ],
        "{started:?}",
    );
    assert_eq!(started[0]["row"]["origin"], "backgroundResult");
    assert_eq!(started[0]["row"]["executionKind"], "agent");
    let input = feed.apply(KernelEvent::MessageDone {
        message: Message::User(UserMessage {
            id: MessageId::new("msg_notice"),
            content: vec![ContentBlock::Text {
                text: "<task-notification>done</task-notification>".into(),
            }],
            origin: UserOrigin::Meta {
                source: TASK_NOTIFICATION_SOURCE.into(),
                origin_meta: None,
            },
        }),
    });
    // model-only：没有用户气泡行。
    assert_eq!(ops(&input), ["state(revision)"], "{input:?}");
    let done = feed.apply(KernelEvent::MessageDone {
        message: assistant(
            "msg_a1",
            vec![ContentBlock::Text {
                text: "the background task finished".into(),
            }],
        ),
    });
    assert_eq!(done[0]["row"]["kind"], "assistantText");
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    assert_eq!(finished[0]["row"]["state"], "completedSuccess");
    // 有 Agent 工时（区别于 controlOnly 轮）。
    assert_eq!(finished[0]["row"]["activeMs"], 3);
}

/// 冷投影：task-notification 的 meta 消息开自己的 backgroundResult 轮，其后的 assistant
/// 归本轮；它不产生用户气泡行。
#[test]
fn the_cold_projection_opens_a_turn_for_task_notification_messages() {
    let view = view(vec![
        Message::User(UserMessage {
            id: MessageId::new("msg_notice"),
            content: vec![ContentBlock::Text {
                text: "<task-notification>done</task-notification>".into(),
            }],
            origin: UserOrigin::Meta {
                source: TASK_NOTIFICATION_SOURCE.into(),
                origin_meta: None,
            },
        }),
        assistant(
            "msg_a1",
            vec![ContentBlock::Text {
                text: "the background task finished".into(),
            }],
        ),
    ]);
    let projection = Projection::from_view(&view, Followup::Queue, Vec::new());
    let snapshot = projection.snapshot(9, "epoch-1");
    let rows = snapshot["rows"]["window"].as_array().unwrap();
    let kinds: Vec<&str> = rows
        .iter()
        .filter_map(|row| row["kind"].as_str())
        .collect();
    assert_eq!(kinds, ["turnHeader", "assistantText"], "{rows:?}");
    let header = &rows[0];
    assert_eq!(header["origin"], "backgroundResult");
    assert_eq!(header["executionKind"], "agent");
    assert_eq!(header["state"], "completedSuccess");
}

/// 跨库读：Node 写的通知记录 hydrate 成 `background_task` 拼写的 Meta 消息，冷投影认它开
/// 同一个 backgroundResult 轮。
#[test]
fn the_cold_projection_reads_node_written_notification_records() {
    let view = view(vec![
        Message::User(UserMessage {
            id: MessageId::new("msg_notice_node"),
            content: vec![ContentBlock::Text {
                text: "<task-notification>done</task-notification>".into(),
            }],
            origin: UserOrigin::Meta {
                source: "background_task".into(),
                origin_meta: None,
            },
        }),
        assistant(
            "msg_a2",
            vec![ContentBlock::Text {
                text: "the background task finished".into(),
            }],
        ),
    ]);
    let projection = Projection::from_view(&view, Followup::Queue, Vec::new());
    let snapshot = projection.snapshot(9, "epoch-1");
    let rows = snapshot["rows"]["window"].as_array().unwrap();
    let headers: Vec<_> = rows
        .iter()
        .filter(|row| row["kind"] == "turnHeader")
        .collect();
    assert_eq!(headers.len(), 1, "{rows:?}");
    assert_eq!(headers[0]["origin"], "backgroundResult");
    assert_eq!(headers[0]["executionKind"], "agent");
}

/// `sharedContextImport` 是 optional、不是 nullable：没有分享导入时快照必须**不写**这个键
/// （写 null 会被 Host 的 `sharedContextImportSchema` 拒整帧，客户端显示
/// `fault.subscription.contentRejected`）。
#[test]
fn a_snapshot_omits_shared_context_import_until_one_is_seeded() {
    let mut feed = Feed::new();
    let snapshot = feed.projection.snapshot(0, "epoch");
    assert!(snapshot.get("sharedContextImport").is_none(), "{snapshot}");

    feed.projection
        .seed_shared_context_import(Some(json!({"title": "Shared", "status": "pending"})));
    let snapshot = feed.projection.snapshot(0, "epoch");
    assert_eq!(snapshot["sharedContextImport"]["title"], "Shared");
}

fn pick(
    provider: &str,
    model: &str,
    thought: Option<&str>,
) -> nibi_kernel_api::model::ModelSelection {
    nibi_kernel_api::model::ModelSelection {
        provider: provider.into(),
        model: model.into(),
        reasoning: thought.map(str::to_owned),
        connection: None,
    }
}

/// 模型切换在「下一轮真正开跑」时落一行 lightBoundary，排在轮头之前；只切思考档不落行
/// （Node 的 `modelChange` 分隔线同判据）。
#[test]
fn a_model_change_marks_the_next_turn_before_its_header() {
    let mut feed = Feed::new();
    let thought_only = feed.apply(KernelEvent::ModelChanged {
        selection: pick("fixture", "scripted", Some("low")),
    });
    assert!(
        thought_only.iter().all(|delta| delta.get("row").is_none()),
        "{thought_only:?}"
    );
    let switched = feed.apply(KernelEvent::ModelChanged {
        selection: pick("other", "next", Some("high")),
    });
    assert!(
        switched.iter().all(|delta| delta["op"] != "row.appended"),
        "切换本身不落行：{switched:?}"
    );
    let started = feed.apply(KernelEvent::TurnStarted {
        execution_kind: None,
        input_source: None,
        origin_meta: None,
        workflow_launch: None,
        turn: TurnId::new("turn_1"),
        command: None,
    });
    assert_eq!(
        ops(&started),
        [
            "row.appended(timelineMarker)",
            "row.appended(turnHeader)",
            "state(availability,control,inputRouting,revision)",
        ]
    );
    let marker = &started[0]["row"];
    assert_eq!(marker["lane"], "lightBoundary");
    assert_eq!(marker["turnId"], "turn_1");
    assert_eq!(marker["marker"]["type"], "modelChange");
    assert_eq!(marker["marker"]["fromProvider"], "fixture");
    assert_eq!(marker["marker"]["fromModel"], "scripted");
    assert_eq!(marker["marker"]["toProvider"], "other");
    assert_eq!(marker["marker"]["toModel"], "next");
    assert_eq!(marker["marker"]["toThought"], "high");
    assert_eq!(
        marker["entityId"],
        "model-change:turn_1:fixture/scripted->other/next"
    );
    assert!(marker["rowId"].as_u64() < started[1]["row"]["rowId"].as_u64());
}

/// 冷打开：每轮用户消息带着当时的选择，与上一轮不同才补分隔线（第一轮不画）。
#[test]
fn a_cold_open_restores_model_change_markers_from_message_selections() {
    use nibi_kernel_api::store::SessionModelTurn;

    let messages = vec![
        user("u1", "first"),
        assistant("a1", vec![ContentBlock::Text { text: "one".into() }]),
        user("u2", "second"),
        assistant("a2", vec![ContentBlock::Text { text: "two".into() }]),
    ];
    let mut cold = view(messages);
    cold.model_turns = vec![
        SessionModelTurn {
            message: MessageId::new("u1"),
            selection: pick("fixture", "scripted", Some("high")),
        },
        SessionModelTurn {
            message: MessageId::new("u2"),
            selection: pick("other", "next", None),
        },
    ];
    let projection = Projection::from_view(&cold, Followup::Queue, Vec::new());
    let rows = projection.rows();
    let markers: Vec<_> = rows
        .iter()
        .filter(|row| row["kind"] == "timelineMarker")
        .collect();
    assert_eq!(markers.len(), 1, "{rows:?}");
    let marker = &markers[0];
    assert_eq!(marker["turnId"], "u2:turn:2");
    assert_eq!(marker["marker"]["type"], "modelChange");
    assert_eq!(marker["marker"]["fromProvider"], "fixture");
    assert_eq!(marker["marker"]["toProvider"], "other");
    assert_eq!(marker["marker"]["toThought"], "");
    // 分隔线在第二个轮头之前。
    let marker_at = rows
        .iter()
        .position(|row| row["kind"] == "timelineMarker")
        .unwrap();
    let header_at = rows
        .iter()
        .position(|row| row["kind"] == "turnHeader" && row["turnId"] == "u2:turn:2")
        .unwrap();
    assert!(marker_at < header_at, "{rows:?}");
}

/// App 的「总量」用模型原始窗口（`window_tokens`），没有时退回有效窗口；冷视图同一口径。
#[test]
fn the_context_window_display_prefers_the_raw_window() {
    let mut feed = Feed::new();
    let deltas = feed.apply(KernelEvent::ContextUsage {
        used_tokens: 1_020,
        max_tokens: 127_000,
        window_tokens: Some(128_000),
    });
    let usage = &deltas[0]["patch"]["usage"]["contextWindow"];
    assert_eq!(usage["usedTokens"], 1_020);
    assert_eq!(usage["maxTokens"], 128_000);

    use nibi_kernel_api::compaction::ContextOccupancy;
    let mut cold = view(Vec::new());
    cold.context_usage = Some(ContextOccupancy {
        used_tokens: 1_020,
        max_tokens: 127_000,
        window_tokens: Some(128_000),
    });
    let projection = Projection::from_view(&cold, Followup::Queue, Vec::new());
    let snapshot = projection.snapshot(0, "epoch");
    assert_eq!(
        snapshot["usage"]["contextWindow"]["maxTokens"],
        serde_json::json!(128_000)
    );
}

/// AskUserQuestion 与 ExitPlanMode 也进 pendingInteractions：Node 把两者投影成 `userInput`
/// （结构化 questions / `schema.interaction = plan_approval`），不是允许/拒绝弹窗。
#[test]
fn questions_and_plan_approval_project_user_input_pendings() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        execution_kind: None,
        input_source: None,
        origin_meta: None,
        workflow_launch: None,
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let questions = json!([{
        "question": "Which color?",
        "header": "Color",
        "options": [
            {"label": "Blue", "description": "Use blue."},
            {"label": "Green"}
        ],
    }]);
    let question_tool = ToolUseId::new("toolu_q");
    feed.apply(KernelEvent::ToolStarted {
        tool_use: question_tool.clone(),
        name: "AskUserQuestion".into(),
        input: json!({"questions": questions}),
    });
    let asked = feed.apply(KernelEvent::InteractionAsked {
        interaction: InteractionId::new("int_q"),
        request: InteractionRequest::Question {
            tool_use: question_tool,
            questions: questions.clone(),
        },
    });
    assert_eq!(asked[0]["row"]["status"], "pendingApproval");
    let pending = &asked[1]["patch"]["pendingInteractions"][0];
    assert_eq!(pending["kind"], "userInput");
    assert_eq!(pending["payload"]["kind"], "userInput");
    assert_eq!(pending["payload"]["toolName"], "AskUserQuestion");
    assert_eq!(pending["payload"]["schema"]["toolName"], "AskUserQuestion");
    assert_eq!(pending["payload"]["questions"][0]["question"], "Which color?");
    // 模型输入没有 value：投影按 Node 的规则补成 label。
    assert_eq!(pending["payload"]["questions"][0]["options"][0]["value"], "Blue");
    assert_eq!(
        pending["payload"]["questions"][0]["options"][0]["description"],
        "Use blue."
    );
    assert_eq!(pending["payload"]["questions"][0]["options"][1]["value"], "Green");
    assert_eq!(feed.projection.pending_permissions(), 1);
    feed.apply(KernelEvent::InteractionResolved {
        interaction: InteractionId::new("int_q"),
    });
    assert_eq!(feed.projection.pending_permissions(), 0);

    let plan_tool = ToolUseId::new("toolu_p");
    feed.apply(KernelEvent::ToolStarted {
        tool_use: plan_tool.clone(),
        name: "ExitPlanMode".into(),
        input: json!({}),
    });
    let asked = feed.apply(KernelEvent::InteractionAsked {
        interaction: InteractionId::new("int_p"),
        request: InteractionRequest::PlanApproval {
            tool_use: plan_tool,
            plan: "# plan".into(),
        },
    });
    let pending = &asked[1]["patch"]["pendingInteractions"][0];
    assert_eq!(pending["kind"], "userInput");
    assert_eq!(pending["payload"]["toolName"], "ExitPlanMode");
    assert_eq!(pending["payload"]["schema"]["interaction"], "plan_approval");
    assert_eq!(pending["payload"]["questions"][0]["header"], "Plan");
    assert_eq!(pending["payload"]["questions"][0]["options"][0]["value"], "approve");
    assert_eq!(feed.projection.pending_permissions(), 1);
}

/// 辅助对话：边界提醒之前的父会话历史不进界面（Node transcript-hydration 把复制来的消息标成
/// `uiVisibility: hidden`），边界提醒自己也不显示；边界之后的新输入照常开一轮。
#[test]
fn a_selection_side_chat_starts_after_its_boundary() {
    let boundary = Message::User(UserMessage {
        id: MessageId::new("msg_boundary"),
        content: vec![ContentBlock::Text {
            text: "The preceding conversation was inherited from the parent task for reference only."
                .into(),
        }],
        origin: UserOrigin::Meta {
            source: "selection_side_chat".into(),
            origin_meta: None,
        },
    });
    let mut side_chat = view(vec![
        user("msg_u1", "parent work"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "parent done".into() }]),
        boundary,
        user("msg_u2", "side question"),
        assistant("msg_a2", vec![ContentBlock::Text { text: "side answer".into() }]),
    ]);
    side_chat.meta.kind = SessionKind::SelectionSideChat;
    let projection = Projection::from_view(&side_chat, Followup::Queue, Vec::new());
    let rows = projection.rows();
    fn text_of<'a>(row: &'a serde_json::Map<String, serde_json::Value>) -> &'a str {
        row.get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
    }
    assert!(
        rows.iter().all(|row| text_of(row) != "parent work"),
        "inherited user turns stay out of the side pane: {rows:?}"
    );
    assert!(
        rows.iter().all(|row| text_of(row) != "parent done"),
        "inherited assistant turns stay out too"
    );
    assert!(
        rows.iter()
            .all(|row| !text_of(row).contains("inherited from the parent")),
        "the boundary reminder is model-only"
    );
    assert!(rows.iter().any(|row| text_of(row) == "side question"));
    assert_eq!(
        rows.iter().filter(|row| row["kind"] == "turnHeader").count(),
        1
    );
}

/// 会话级缓存命中率：输入总量 = 未缓存 + 缓存读 + 缓存写；`contextWindow.cache` 是 contextUsage 面板的口径。
#[test]
fn the_context_window_carries_the_session_cache_hit_rate() {
    use nibi_kernel_api::message::Usage;

    let usage = super::state::usage(
        Some((500, 1_000)),
        &Usage {
            input_tokens: 100,
            output_tokens: 10,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 350,
        },
    );
    let cache = &usage["contextWindow"]["cache"];
    assert_eq!(cache["inputTokens"], 500);
    assert_eq!(cache["cacheReadTokens"], 350);
    assert_eq!(cache["cacheWriteTokens"], 50);
    assert_eq!(cache["hitRate"], 0.7);
    // 没有输入时命中率是 null，不写 0（避免把「没有数据」说成 0 命中）。
    let empty = super::state::usage(Some((1, 1)), &Usage::default());
    assert!(empty["contextWindow"]["cache"]["hitRate"].is_null());
}

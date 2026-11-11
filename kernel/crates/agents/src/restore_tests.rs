//! 重启后的子代理恢复（docs/subagent-restart-resume.md）：entry 写入、结果补发、续跑、上限与跳过。

use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use nibi_kernel_api::agents::{AgentNotice, AgentSignal};
use nibi_kernel_api::ids::{AgentId, MessageId, OwnerEpoch, SessionId, ToolUseId, TraceId};
use nibi_kernel_api::message::{
    AssistantMessage, ContentBlock, INTERRUPTED_CALL, Message, StopReason, ToolResultContent,
    UserMessage, UserOrigin,
};
use nibi_kernel_api::orchestration::QueryStop;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::store::{Fact, FactBatch, SessionKind, SessionMeta, SessionStore};
use nibi_kernel_api::testing::MemoryStore;
use serde_json::{Value, json};

use super::{
    ATTEMPT_ENTRY, DELIVERED_ENTRY, RESULT_ENTRY, RUN_ENTRY, SPAWN_ENTRY, SpawnData,
    blocked_report,
    interrupted_results,
};
use crate::live::AgentState;
use crate::report::Ending;
use crate::spawn::ending_of;
use crate::test_support::{Gates, Seen, harness, held, text, workspace};

const ROOT: &str = "sess_parent";
const CHILD: &str = "sess_subagent_agent_worker";
const AGENT: &str = "agent_worker";

fn meta(id: &str, kind: SessionKind, parent: Option<&str>) -> SessionMeta {
    SessionMeta {
        id: SessionId::new(id),
        kind,
        parent: parent.map(SessionId::new),
        workspace: workspace(),
        title: String::new(),
        trace: TraceId::new("trace_root"),
        created_at_ms: 0,
    }
}

async fn seed_root(store: &MemoryStore, root: &str) {
    store
        .create(meta(root, SessionKind::Interactive, None))
        .await
        .unwrap();
}

async fn seed_child(store: &MemoryStore, child: &str, parent: &str) {
    store
        .create(meta(child, SessionKind::Subagent, Some(parent)))
        .await
        .unwrap();
}

async fn commit(store: &MemoryStore, session: &str, facts: Vec<Fact>) {
    store
        .commit(
            &SessionId::new(session),
            FactBatch {
                owner_epoch: OwnerEpoch::LOCAL,
                command: None,
                facts,
                turn: None,
            },
        )
        .await
        .unwrap();
}

fn user(text: &str) -> Message {
    Message::User(UserMessage {
        id: MessageId::new("msg_prompt"),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin: UserOrigin::Human,
    })
}

fn assistant_tool_use(id: &str, call: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::ToolUse {
            id: ToolUseId::new(call),
            name: "Bash".to_owned(),
            input: json!({"command": "ls"}),
        }],
        model: "claude-opus-5-5".to_owned(),
        stop_reason: Some(StopReason::ToolUse),
        usage: None,
    })
}

fn assistant_text(id: &str, text: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        model: "claude-opus-5-5".to_owned(),
        stop_reason: Some(StopReason::EndTurn),
        usage: None,
    })
}

fn spawn_json(agent: &str, child: &str, parent: &str, root: &str, fork: bool) -> Value {
    json!({
        "agentId": agent,
        "childSessionId": child,
        "parentSession": parent,
        "rootSession": root,
        "ownerAgentId": null,
        "depth": 1,
        "toolUseId": "toolu_1",
        "description": "Worker",
        "agentType": "general-purpose",
        "workspace": workspace(),
        "machine": null,
        "selection": nibi_kernel_api::testing::selection(),
        "execution": nibi_kernel_api::permission::ExecutionState::from(PermissionMode::Default),
        "background": true,
        "fork": fork,
        "createdAtMs": 1_000,
    })
}

fn result_json(ending: &str, text: &str, finished_at_ms: u64) -> Value {
    json!({
        "ending": ending,
        "text": text,
        "tokens": 42,
        "toolUses": 2,
        "durationMs": 900,
        "toolUseId": "toolu_1",
        "finishedAtMs": finished_at_ms,
    })
}

fn spawn_entry(agent: &str, data: Value) -> Fact {
    Fact::Entry {
        kind: SPAWN_ENTRY.to_owned(),
        id: agent.to_owned(),
        data,
    }
}

fn result_entry(agent: &str, data: Value) -> Fact {
    Fact::Entry {
        kind: RESULT_ENTRY.to_owned(),
        id: agent.to_owned(),
        data,
    }
}

/// “已启动”结果里的 agentId（测试的 ID 生成器与消息共用一个计数器，不能猜）。
fn spawned_id(output: &str) -> String {
    output
        .split("agentId: ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap()
        .to_owned()
}

async fn wait_entry(store: &MemoryStore, session: &str, kind: &str, id: &str) -> Value {
    for _ in 0..10_000 {
        if let Ok(entries) = store.entries(&SessionId::new(session), kind).await
            && let Some((_, data)) = entries.iter().rev().find(|(entry, _)| entry == id)
        {
            return data.clone();
        }
        tokio::task::yield_now().await;
    }
    panic!("the {kind} entry for {id} did not appear");
}

async fn next_notice(stream: &mut BoxStream<'static, AgentSignal>) -> AgentNotice {
    loop {
        if let Some(AgentSignal::Notice(notice)) = stream.next().await {
            return notice;
        }
    }
}

fn quiet(seen: &Arc<std::sync::Mutex<Vec<Seen>>>) -> bool {
    seen.lock().unwrap().is_empty()
}

/// 等到子循环至少开始一次（后台任务在自己的任务里推进）。
async fn started(seen: &Arc<std::sync::Mutex<Vec<Seen>>>) -> Vec<Seen> {
    for _ in 0..10_000 {
        let seen = seen.lock().unwrap().clone();
        if !seen.is_empty() {
            return seen;
        }
        tokio::task::yield_now().await;
    }
    panic!("the interrupted subagent was not resumed");
}

/// `spawn::create` 在同一批里写 `subagent_spawn`；`spawn::drive` 结束时写 `subagent_result`。
#[tokio::test]
async fn create_writes_the_spawn_entry_and_drive_writes_the_result() {
    let gates = Gates::default();
    let harness = held(&gates, false);
    let launched = harness
        .call(
            ROOT,
            "Agent",
            json!({"description": "Worker", "prompt": "Go."}),
        )
        .await;
    let agent = spawned_id(&text(&launched));
    let child = format!("sess_subagent_{agent}");

    let entries = harness
        .store
        .entries(&SessionId::new(&child), SPAWN_ENTRY)
        .await
        .unwrap();
    assert_eq!(entries.len(), 1, "{entries:?}");
    let (id, data) = &entries[0];
    assert_eq!(id, &agent);
    assert_eq!(data["agentId"], agent.as_str());
    assert_eq!(data["childSessionId"], child.as_str());
    assert_eq!(data["parentSession"], ROOT);
    assert_eq!(data["rootSession"], ROOT);
    assert_eq!(data["agentType"], "general-purpose");
    assert_eq!(data["description"], "Worker");
    assert_eq!(data["depth"], 1);
    assert_eq!(data["background"], true);
    assert_eq!(data["fork"], false);
    assert_eq!(data["toolUseId"], "toolu_1");
    assert_eq!(data["workspace"]["root"], workspace().root.as_str());
    assert_eq!(data["workspace"]["environment"], "local");
    assert!(data["selection"]["model"].is_string());
    assert!(data["execution"]["mode"].is_string());
    assert_eq!(data["createdAtMs"], 1_000);

    gates.release(&child);
    harness.started(1).await;
    let result = wait_entry(&harness.store, &child, RESULT_ENTRY, &agent).await;
    assert_eq!(result["ending"], "completed");
    assert_eq!(result["text"], "Hello from the subagent.");
    assert_eq!(result["toolUses"], 0);
    assert!(result["tokens"].as_u64().unwrap() > 0);
    assert_eq!(result["toolUseId"], "toolu_1");
    assert_eq!(result["finishedAtMs"], 1_000);
}

/// 有结果：只重建条目并补发通知，不重跑；第二个进程读得到投递标记，不再补发。
#[tokio::test]
async fn a_stored_result_is_restored_and_the_lost_notification_is_sent_once() {
    let harness = harness(None);
    seed_root(&harness.store, ROOT).await;
    seed_child(&harness.store, CHILD, ROOT).await;
    commit(
        &harness.store,
        CHILD,
        vec![
            spawn_entry(AGENT, spawn_json(AGENT, CHILD, ROOT, ROOT, false)),
            Fact::MessageAppended {
                message: user("Do it."),
            },
            Fact::MessageAppended {
                message: assistant_text("msg_done", "All done."),
            },
            result_entry(AGENT, result_json("completed", "All done.", 777)),
        ],
    )
    .await;

    let (agents, seen) = harness.reboot();
    agents.restore_session(&SessionId::new(ROOT)).await;

    assert!(quiet(&seen), "the finished subagent must not be resumed");
    let live = agents
        .core
        .live
        .get(&AgentId::new(AGENT))
        .expect("the finished subagent is visible");
    assert!(matches!(
        live.state,
        AgentState::Finished(Ending::Completed)
    ));
    assert_eq!(live.shown.ended_ms, Some(777));
    assert_eq!(
        live.tool_use.as_ref().map(ToolUseId::as_str),
        Some("toolu_1")
    );

    let signals = agents.signals();
    let mut root = signals.signals(&SessionId::new(ROOT));
    let notice = next_notice(&mut root).await;
    assert_eq!(notice.agent.as_str(), AGENT);
    assert_eq!(notice.status, "completed");
    assert!(
        notice
            .text
            .contains("<summary>Agent \"Worker\" finished</summary>")
    );
    assert!(notice.text.contains("<result>All done.</result>"));
    signals.ack(&SessionId::new(ROOT), notice.seq).await;

    let delivered = harness
        .store
        .entries(&SessionId::new(ROOT), DELIVERED_ENTRY)
        .await
        .unwrap();
    assert_eq!(delivered.len(), 1, "{delivered:?}");
    assert_eq!(delivered[0].0, AGENT);
    assert!(delivered[0].1["deliveredAtMs"].is_u64());

    // 再重启一次：标记在父会话里，同一份结果不再补发。
    let (agents, seen) = harness.reboot();
    agents.restore_session(&SessionId::new(ROOT)).await;
    assert!(quiet(&seen));
    assert!(
        agents
            .signals()
            .background(&SessionId::new(ROOT))
            .await
            .is_empty()
    );
}

/// 上一轮已完成、之后又被 SendMessage/续跑拉起，崩溃在新一轮里：旧的 `subagent_result` 还在，
/// 但 `subagent_run` 比它新，必须按“跑到一半”恢复，不能当成已完成跳过。
#[tokio::test]
async fn a_newer_run_marker_resumes_instead_of_trusting_the_old_result() {
    let harness = harness(None);
    seed_root(&harness.store, ROOT).await;
    seed_child(&harness.store, CHILD, ROOT).await;
    commit(
        &harness.store,
        CHILD,
        vec![
            spawn_entry(AGENT, spawn_json(AGENT, CHILD, ROOT, ROOT, false)),
            Fact::MessageAppended {
                message: user("Do it."),
            },
            Fact::MessageAppended {
                message: assistant_text("msg_done", "First turn done."),
            },
            result_entry(AGENT, result_json("completed", "First turn done.", 777)),
            Fact::Entry {
                kind: RUN_ENTRY.to_owned(),
                id: AGENT.to_owned(),
                data: json!({ "startedAtMs": 1_000 }),
            },
        ],
    )
    .await;

    let (agents, seen) = harness.reboot();
    agents.restore_session(&SessionId::new(ROOT)).await;

    let started = started(&seen).await;
    assert_eq!(started[0].request.session.as_str(), CHILD);
    assert!(
        matches!(
            started[0].request.messages.last(),
            Some(Message::User(user))
                if user.origin
                    == UserOrigin::Meta {
                        source: "process-restart".to_owned(),
                        origin_meta: None,
                    }
        ),
        "the stale result must not suppress the continuation"
    );
}

/// 无结果 + spawn：补中断结果、追加续跑消息、进入 Live 并在同一个子会话里重跑。
#[tokio::test]
async fn an_interrupted_subagent_is_resumed_in_the_same_child_session() {
    let harness = harness(None);
    seed_root(&harness.store, ROOT).await;
    seed_child(&harness.store, CHILD, ROOT).await;
    commit(
        &harness.store,
        CHILD,
        vec![
            spawn_entry(AGENT, spawn_json(AGENT, CHILD, ROOT, ROOT, false)),
            Fact::MessageAppended {
                message: user("Do it."),
            },
            Fact::MessageAppended {
                message: assistant_tool_use("msg_raw", "toolu_x"),
            },
        ],
    )
    .await;

    let (agents, seen) = harness.reboot();
    agents.restore_session(&SessionId::new(ROOT)).await;

    // 同一个子会话被重新驱动（不是新会话）。
    let started = started(&seen).await;
    assert_eq!(started[0].request.session.as_str(), CHILD);

    // 续跑消息：meta、来源 process-restart，文案固定。
    let Some(Message::User(prompt)) = started[0].request.messages.last() else {
        panic!("expected the continuation message");
    };
    assert_eq!(
        prompt.origin,
        UserOrigin::Meta {
            source: "process-restart".to_owned(),
            origin_meta: None,
        }
    );
    let [ContentBlock::Text { text: prompt_text }] = prompt.content.as_slice() else {
        panic!("expected one text block");
    };
    assert!(prompt_text.starts_with("Continue the previous task from where it left off."));

    // 崩溃瞬间的未结调用补成 is_error 的中断结果（已有结果的调用不动）。
    let loaded = harness.store.load(&SessionId::new(CHILD)).await.unwrap();
    let interrupted = loaded
        .messages
        .iter()
        .find_map(|message| match message {
            Message::User(user)
                if user.content.iter().any(|block| {
                    matches!(
                        block,
                        ContentBlock::ToolResult { tool_use_id, .. }
                            if tool_use_id.as_str() == "toolu_x"
                    )
                }) =>
            {
                Some(user.clone())
            }
            _ => None,
        })
        .expect("the unresolved call gets an interrupted result");
    assert_eq!(
        interrupted.origin,
        UserOrigin::ToolResult {
            assistant: MessageId::new("msg_raw"),
        }
    );
    assert!(matches!(
        interrupted.content.as_slice(),
        [ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error: true,
        }] if tool_use_id.as_str() == "toolu_x"
            && matches!(content.as_slice(),
                [ToolResultContent::Text { text }] if text == INTERRUPTED_CALL)
    ));
    assert!(
        loaded.messages.iter().any(|message| matches!(
            message,
            Message::User(user)
                if user.origin
                    == UserOrigin::Meta {
                        source: "process-restart".to_owned(),
                        origin_meta: None,
                    }
        )),
        "the continuation message is stored in the child session"
    );

    // 尝试计数（续跑前写）。
    let attempts = harness
        .store
        .entries(&SessionId::new(CHILD), ATTEMPT_ENTRY)
        .await
        .unwrap();
    assert_eq!(attempts.len(), 1, "{attempts:?}");
    assert_eq!(attempts[0].0, AGENT);
    assert_eq!(attempts[0].1["count"], 1);
    assert_eq!(attempts[0].1["reason"], "process_restart");

    // 重跑结束：结果落库、条目结束、父会话收到通知。
    let result = wait_entry(&harness.store, CHILD, RESULT_ENTRY, AGENT).await;
    assert_eq!(result["ending"], "completed");
    let live = agents.core.live.get(&AgentId::new(AGENT)).unwrap();
    assert!(matches!(
        live.state,
        AgentState::Finished(Ending::Completed)
    ));
    let mut root = agents.signals().signals(&SessionId::new(ROOT));
    let notice = next_notice(&mut root).await;
    assert_eq!(notice.agent.as_str(), AGENT);
    assert_eq!(notice.status, "completed");
}

/// killed：补通知但不续跑。
#[tokio::test]
async fn a_killed_subagent_is_not_resumed() {
    let harness = harness(None);
    seed_root(&harness.store, ROOT).await;
    seed_child(&harness.store, CHILD, ROOT).await;
    commit(
        &harness.store,
        CHILD,
        vec![
            spawn_entry(AGENT, spawn_json(AGENT, CHILD, ROOT, ROOT, false)),
            Fact::MessageAppended {
                message: assistant_text("msg_done", "Stopped."),
            },
            result_entry(AGENT, result_json("killed", "Stopped.", 555)),
        ],
    )
    .await;

    let (agents, seen) = harness.reboot();
    agents.restore_session(&SessionId::new(ROOT)).await;
    assert!(quiet(&seen), "a stopped subagent must not be resumed");
    let live = agents.core.live.get(&AgentId::new(AGENT)).unwrap();
    assert!(matches!(live.state, AgentState::Finished(Ending::Killed)));
    let mut root = agents.signals().signals(&SessionId::new(ROOT));
    let notice = next_notice(&mut root).await;
    assert_eq!(notice.status, "killed");
    assert!(
        notice
            .text
            .contains("<summary>Agent \"Worker\" was stopped by NIBI</summary>")
    );
}

/// 续跑次数到上限（2 次）：只标记失败，不循环。
#[tokio::test]
async fn a_subagent_at_the_resume_limit_is_marked_failed() {
    let harness = harness(None);
    seed_root(&harness.store, ROOT).await;
    seed_child(&harness.store, CHILD, ROOT).await;
    commit(
        &harness.store,
        CHILD,
        vec![
            spawn_entry(AGENT, spawn_json(AGENT, CHILD, ROOT, ROOT, false)),
            Fact::Entry {
                kind: ATTEMPT_ENTRY.to_owned(),
                id: AGENT.to_owned(),
                data: json!({"count": 2, "lastAtMs": 10, "reason": "process_restart"}),
            },
        ],
    )
    .await;

    let (agents, seen) = harness.reboot();
    agents.restore_session(&SessionId::new(ROOT)).await;
    assert!(quiet(&seen), "the resume limit must stop the loop");
    let live = agents.core.live.get(&AgentId::new(AGENT)).unwrap();
    assert!(matches!(live.state, AgentState::Finished(Ending::Failed)));
    assert_eq!(live.status(), "failed");
    let attempts = harness
        .store
        .entries(&SessionId::new(CHILD), ATTEMPT_ENTRY)
        .await
        .unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].1["count"], 2);
}

/// fork：前缀不落库，不自动续跑，报告里说明原因。
#[tokio::test]
async fn a_fork_subagent_is_not_resumed() {
    let harness = harness(None);
    seed_root(&harness.store, ROOT).await;
    seed_child(&harness.store, CHILD, ROOT).await;
    commit(
        &harness.store,
        CHILD,
        vec![spawn_entry(
            AGENT,
            spawn_json(AGENT, CHILD, ROOT, ROOT, true),
        )],
    )
    .await;

    let (agents, seen) = harness.reboot();
    agents.restore_session(&SessionId::new(ROOT)).await;
    assert!(quiet(&seen), "a fork subagent must not be resumed");
    let live = agents.core.live.get(&AgentId::new(AGENT)).unwrap();
    assert!(matches!(live.state, AgentState::Finished(Ending::Failed)));
    assert!(
        harness
            .store
            .entries(&SessionId::new(CHILD), ATTEMPT_ENTRY)
            .await
            .unwrap()
            .is_empty()
    );

    let data: SpawnData =
        serde_json::from_value(spawn_json(AGENT, CHILD, ROOT, ROOT, true)).unwrap();
    let report = blocked_report(&data, 0).unwrap();
    assert!(report.text.contains("fork"), "{}", report.text);
}

/// agent 定义已不存在：只标记失败并说明原因，不续跑。
#[tokio::test]
async fn a_subagent_whose_definition_is_gone_is_marked_failed() {
    let harness = harness(None);
    seed_root(&harness.store, ROOT).await;
    seed_child(&harness.store, CHILD, ROOT).await;
    let mut data = spawn_json(AGENT, CHILD, ROOT, ROOT, false);
    data["agentType"] = json!("ghost-agent");
    commit(&harness.store, CHILD, vec![spawn_entry(AGENT, data)]).await;

    let (agents, seen) = harness.reboot();
    agents.restore_session(&SessionId::new(ROOT)).await;
    assert!(quiet(&seen), "a subagent without a definition cannot run");
    let live = agents.core.live.get(&AgentId::new(AGENT)).unwrap();
    assert!(matches!(live.state, AgentState::Finished(Ending::Failed)));
    assert_eq!(live.definition.agent_type, "ghost-agent");
    assert!(
        harness
            .store
            .entries(&SessionId::new(CHILD), ATTEMPT_ENTRY)
            .await
            .unwrap()
            .is_empty()
    );
}

/// 没有 `subagent_spawn` 的会话（DWF actor 等）不恢复；子会话也不直接恢复。
#[tokio::test]
async fn a_session_without_a_spawn_entry_is_left_alone() {
    let harness = harness(None);
    seed_root(&harness.store, ROOT).await;
    seed_child(&harness.store, CHILD, ROOT).await;
    commit(
        &harness.store,
        CHILD,
        vec![Fact::MessageAppended {
            message: assistant_text("msg_actor", "DWF actor output."),
        }],
    )
    .await;

    let (agents, seen) = harness.reboot();
    agents.restore_session(&SessionId::new(ROOT)).await;
    assert!(quiet(&seen));
    assert!(
        agents
            .core
            .live
            .snapshot_in(&SessionId::new(ROOT))
            .0
            .is_empty()
    );

    // 子会话自己冷加载时不进入恢复流程。
    agents.restore_session(&SessionId::new(CHILD)).await;
    assert!(
        agents
            .core
            .live
            .snapshot_in(&SessionId::new(ROOT))
            .0
            .is_empty()
    );
}

/// 末尾未结的调用补结果；更早的未结调用（最后一条人类输入之前）不补。
#[test]
fn only_trailing_unresolved_calls_get_interrupted_results() {
    let mut next = 0_u64;
    let mut id = || {
        next += 1;
        MessageId::new(format!("msg_interrupted_{next}"))
    };
    let messages = vec![
        user("Start."),
        assistant_tool_use("msg_old", "toolu_old"),
        Message::User(UserMessage {
            id: MessageId::new("msg_old_result"),
            content: vec![ContentBlock::ToolResult {
                tool_use_id: ToolUseId::new("toolu_old"),
                content: vec![ToolResultContent::Text {
                    text: "done".to_owned(),
                }],
                is_error: false,
            }],
            origin: UserOrigin::ToolResult {
                assistant: MessageId::new("msg_old"),
            },
        }),
        user("Again."),
        assistant_tool_use("msg_new", "toolu_new"),
    ];
    let added = interrupted_results(&messages, &mut id);
    assert_eq!(added.len(), 1, "{added:?}");
    assert!(matches!(
        &added[0],
        Message::User(UserMessage {
            content,
            origin: UserOrigin::ToolResult { assistant },
            ..
        }) if assistant.as_str() == "msg_new"
            && matches!(content.as_slice(),
                [ContentBlock::ToolResult { tool_use_id, is_error: true, .. }]
                    if tool_use_id.as_str() == "toolu_new")
    ));
    // 没有未结调用时不产生消息。
    let done = vec![user("Start."), assistant_text("msg_done", "Done.")];
    assert!(interrupted_results(&done, &mut id).is_empty());
}

/// API 错误与 stop hook 阻塞都以失败结束（以前算完成，恢复逻辑无法区分）。
#[test]
fn api_errors_end_as_failed() {
    let mut text = String::new();
    let (ending, error) = ending_of(
        Ok(QueryStop::ApiError {
            message: "API Error: overloaded".to_owned(),
        }),
        &mut text,
    );
    assert_eq!(ending, Ending::Failed);
    assert_eq!(text, "API Error: overloaded");
    assert!(
        error
            .map(|error| error.to_string())
            .unwrap_or_default()
            .contains("API Error: overloaded")
    );

    // 已有部分文本时保留它，错误只进 summary。
    let mut text = "partial result".to_owned();
    let (ending, error) = ending_of(
        Ok(QueryStop::Blocked {
            message: "the stop hook blocked".to_owned(),
        }),
        &mut text,
    );
    assert_eq!(ending, Ending::Failed);
    assert_eq!(text, "partial result");
    assert!(error.is_some());
}

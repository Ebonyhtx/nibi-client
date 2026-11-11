use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{CommandId, EnvironmentId};
use nibi_kernel_api::message::Message;
use nibi_kernel_api::session_api::{
    Command, CommandEnvelope, CreateSession, Delivery, KernelEvent, TurnOutcome,
};
use nibi_kernel_api::testing::{
    FixedClock, MemoryStore, ScriptedModel, SequentialIds, UnusedEnvironment, environments,
    selection, text_response,
};

use super::*;

fn kernel(store: Arc<MemoryStore>, model: Arc<ScriptedModel>) -> LocalKernel {
    LocalKernel::new(
        Ports {
            model,
            environments: environments(Arc::new(UnusedEnvironment)),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    )
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/work"),
    }
}

#[tokio::test]
async fn imported_history_is_persisted_with_title_and_created_at() {
    use nibi_kernel_api::session_api::ImportedMessage;

    let store = Arc::new(MemoryStore::default());
    let first = kernel(
        store.clone(),
        Arc::new(ScriptedModel::new(Vec::new())),
    );
    let id = first
        .create_session_with_history(
            CreateSession {
                id: None,
                workspace: workspace(),
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
            },
            Some("Migrated".to_owned()),
            Some(42),
            None,
            vec![
                ImportedMessage {
                    role: "user".to_owned(),
                    content: "hi".to_owned(),
                    timestamp_ms: Some(1),
                },
                ImportedMessage {
                    role: "assistant".to_owned(),
                    content: "yo".to_owned(),
                    timestamp_ms: None,
                },
            ],
        )
        .await
        .unwrap();
    drop(first);

    let reopened = kernel(store, Arc::new(ScriptedModel::new(Vec::new())));
    let view = reopened.session_snapshot(&id).await.unwrap();
    assert_eq!(view.meta.title, "Migrated");
    assert_eq!(view.meta.created_at_ms, 42);
    assert_eq!(view.messages.len(), 2);
}

#[tokio::test]
async fn a_session_can_be_created_below_a_parent() {
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store, Arc::new(ScriptedModel::new(Vec::new())));
    let parent = nibi_kernel_api::ids::SessionId::new("sess_parent");
    let id = kernel
        .create_session_with_parent(
            CreateSession {
                id: None,
                workspace: workspace(),
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
            },
            Some(parent.clone()),
        )
        .await
        .unwrap();
    let view = kernel.session_snapshot(&id).await.unwrap();
    assert_eq!(view.meta.parent, Some(parent));
}

#[tokio::test]
async fn a_deferred_session_is_not_listed_until_the_first_input() {
    use nibi_kernel_api::store::{SessionFilter, SessionStore};

    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(
        store.clone(),
        Arc::new(ScriptedModel::new(vec![text_response(&["hi"])])),
    );
    let id = kernel
        .create_session_deferred(
            CreateSession {
                id: None,
                workspace: workspace(),
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
            },
            None,
        )
        .await
        .unwrap();
    let filter = SessionFilter {
        workspace: workspace(),
        limit: 10,
    };
    assert!(
        store.load(&id).await.is_err(),
        "a draft must not have a session row"
    );
    assert!(
        kernel
            .list_sessions(filter.clone())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        kernel
            .workspace_sessions(filter.clone())
            .await
            .unwrap()
            .is_empty(),
        "a draft must not leak into the workspace panel"
    );

    // 草稿能在同一进程里打开；第一条输入提交时才出现会话行。
    let session = kernel.open_session(&id).await.unwrap();
    let mut events = session.subscribe(Some(0));
    session
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::Submit {
                text: "hello".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
            .unwrap();
        if let KernelEvent::TurnFinished { outcome, .. } = event.event {
            assert_eq!(outcome, TurnOutcome::Success);
            break;
        }
    }
    assert!(store.load(&id).await.is_ok(), "the draft was promoted");
    assert!(
        kernel
            .list_sessions(filter.clone())
            .await
            .unwrap()
            .iter()
            .any(|session| session.id == id)
    );
    assert!(
        kernel
            .workspace_sessions(filter)
            .await
            .unwrap()
            .iter()
            .any(|session| session.summary.id == id),
        "the promoted session is a normal workspace session"
    );
}

#[tokio::test]
async fn a_frontend_record_persists_a_draft() {
    use nibi_kernel_api::store::{FrontendRecord, SessionStore};

    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store.clone(), Arc::new(ScriptedModel::new(Vec::new())));
    let id = kernel
        .create_session_deferred(
            CreateSession {
                id: None,
                workspace: workspace(),
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
            },
            None,
        )
        .await
        .unwrap();
    assert!(store.load(&id).await.is_err());
    // v4 的首条命令事实在输入提交之前写：草稿必须先落主记录，否则记录表没有主行。
    kernel
        .put_session_record(
            &id,
            FrontendRecord {
                kind: "v4/command_fact".to_owned(),
                key: "v4_command_fact:test:c1".to_owned(),
                data: serde_json::json!({"status": "accepted"}),
            },
        )
        .await
        .unwrap();
    assert!(store.load(&id).await.is_ok(), "the draft was promoted");
    assert!(
        !kernel
            .session_records(&id, "v4/command_fact")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_created_session_runs_a_turn_and_reloads_after_restart() {
    let store = Arc::new(MemoryStore::default());
    let first = kernel(
        store.clone(),
        Arc::new(ScriptedModel::new(vec![text_response(&["hi"])])),
    );
    let id = first
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .unwrap();
    let session = first.open_session(&id).await.unwrap();
    let again = first.open_session(&id).await.unwrap();
    assert!(Arc::ptr_eq(&session, &again));
    let mut events = session.subscribe(Some(0));
    session
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::Submit {
                text: "hello".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
            .unwrap();
        if let KernelEvent::TurnFinished { outcome, .. } = event.event {
            assert_eq!(outcome, TurnOutcome::Success);
            break;
        }
    }
    drop(first);

    let second = kernel(store, Arc::new(ScriptedModel::new(Vec::new())));
    let reopened = second.open_session(&id).await.unwrap();
    // 一问一答之外，还有上下文这一步宣布的 attachment（模型身份、延迟工具清单（本地 ToolSearch，工作线 F84：
    // 测试替身答不出能力、模型没有卡片）、agent 清单（有 Agent 工具）、剩余 token、日期；内置工具里有 Bash，所以也宣布
    // 署名），它们与对话一起落库、resume 后重放。
    let messages = reopened.view().await.unwrap().messages;
    let dialogue = messages
        .iter()
        .filter(|message| matches!(message, Message::User(_) | Message::Assistant(_)))
        .count();
    assert_eq!(dialogue, 2);
    let sources: Vec<&str> = messages
        .iter()
        .filter_map(|message| match message {
            Message::Attachment(attachment) => Some(attachment.source.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        sources,
        [
            "model",
            "deferred_tools_delta",
            "agent_listing_delta",
            "total_tokens_reminder",
            "date",
            "remote_session_change"
        ]
    );
}

/// 复现（R1-1）：以前关闭后会话还留在 `sessions` 表里（actor 活着），再打开拿到的是旧 actor——不跑
/// SessionStart(resume)，按会话的表也不释放。关闭之后它离开内核，再打开是新的 actor。
#[tokio::test]
async fn a_closed_session_leaves_the_kernel_and_reopens_with_a_new_actor() {
    use nibi_kernel_api::session_api::{EndReason, StartSource};
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store, Arc::new(ScriptedModel::new(Vec::new())));
    let id = kernel
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .unwrap();
    let first = kernel.open_session(&id).await.unwrap();
    first.close(EndReason::Resume).await;
    assert!(
        !kernel.sessions().contains_key(&id),
        "a closed session must leave the kernel"
    );
    assert!(first.view().await.is_err(), "the old actor has stopped");
    let again = kernel
        .open_session_as(&id, StartSource::Resume)
        .await
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &again));
    again.view().await.unwrap();
}

/// 重启后的子代理恢复（docs/subagent-restart-resume.md）：同一个 store 上新建内核（进程重启），
/// 打开父会话时把已完成、但通知丢了的后台子代理恢复进 Live，并补发结果。
#[tokio::test]
async fn opening_a_session_restores_a_finished_subagent_and_delivers_its_result() {
    use nibi_kernel_api::agents::AgentSignals;
    use nibi_kernel_api::ids::{AgentId, OwnerEpoch, SessionId, TraceId};
    use nibi_kernel_api::permission::ExecutionState;
    use nibi_kernel_api::store::{Fact, FactBatch, SessionKind, SessionMeta};

    let store = Arc::new(MemoryStore::default());
    let first = kernel(store.clone(), Arc::new(ScriptedModel::new(Vec::new())));
    let parent = first
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .unwrap();
    let child = SessionId::new("sess_subagent_agent_restored");
    let agent = "agent_restored";
    store
        .create(SessionMeta {
            id: child.clone(),
            kind: SessionKind::Subagent,
            parent: Some(parent.clone()),
            workspace: workspace(),
            title: "restored".to_owned(),
            trace: TraceId::new(parent.as_str()),
            created_at_ms: 2,
        })
        .await
        .unwrap();
    let spawn = serde_json::json!({
        "agentId": agent,
        "childSessionId": child.as_str(),
        "parentSession": parent.as_str(),
        "rootSession": parent.as_str(),
        "ownerAgentId": null,
        "depth": 1,
        "toolUseId": "toolu_restored",
        "description": "restored subagent",
        "agentType": "general-purpose",
        "workspace": workspace(),
        "machine": null,
        "selection": selection(),
        "execution": serde_json::to_value(ExecutionState::from(PermissionMode::Default)).unwrap(),
        "background": true,
        "fork": false,
        "createdAtMs": 2
    });
    let result = serde_json::json!({
        "ending": "completed",
        "text": "the subagent finished before the crash",
        "tokens": 12,
        "toolUses": 1,
        "durationMs": 34,
        "toolUseId": "toolu_restored",
        "finishedAtMs": 3
    });
    store
        .commit(
            &child,
            FactBatch {
                owner_epoch: OwnerEpoch::LOCAL,
                command: None,
                facts: vec![
                    Fact::Entry {
                        kind: "subagent_spawn".to_owned(),
                        id: agent.to_owned(),
                        data: spawn,
                    },
                    Fact::Entry {
                        kind: "subagent_result".to_owned(),
                        id: agent.to_owned(),
                        data: result,
                    },
                ],
                turn: None,
            },
        )
        .await
        .unwrap();
    drop(first);

    // 新内核 = 进程重启；打开父会话触发 restore。
    let reopened = kernel(store, Arc::new(ScriptedModel::new(Vec::new())));
    reopened
        .open_session_as(&parent, StartSource::Resume)
        .await
        .unwrap();
    let entries = reopened
        .actors
        .signals()
        .subagents(&parent)
        .await;
    assert_eq!(entries.len(), 1, "the subagent must be restored into Live");
    assert_eq!(entries[0].agent, AgentId::new(agent));
    assert_eq!(
        entries[0].status,
        nibi_kernel_api::panels::SubagentStatus::Completed
    );
    assert_eq!(entries[0].child, child);
    // 结果通知补发：父会话里出现一条带 task-id 的 meta 消息（Hub 投递后由 actor 落库）。
    let mut found = false;
    for _ in 0..50 {
        let loaded = reopened.ports.store.load(&parent).await.unwrap();
        found = loaded.messages.iter().any(|message| {
            matches!(
                message,
                Message::User(user)
                    if user.content.iter().any(|block| matches!(
                        block,
                        nibi_kernel_api::message::ContentBlock::Text { text }
                            if text.contains("<task-id>") && text.contains(agent)
                    ))
            )
        });
        if found {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(found, "the missing result notification must be delivered");
}

//! RespondToCoordinator（docs/subagent-respond-to-coordinator.md）：子代理工具面、carrier 与投递去向。

use futures_util::StreamExt;
use nibi_kernel_api::agents::{AgentNoticeKind, AgentSignal};
use nibi_kernel_api::ids::{AgentId, RunId, SessionId};
use nibi_kernel_api::tool::Tool;
use serde_json::json;

use super::{RespondToCoordinator, escape};
use crate::definitions::builtins;
use crate::live::AgentState;
use crate::test_support::{harness, held, text, tool_context};
use crate::test_support::Gates;
use crate::toolset::ToolRule;

const ROOT: &str = "sess_parent";

/// `Agent` 工具结果里的 agentId。
fn spawned(output: &str) -> String {
    output
        .split("agentId: ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .expect("the Agent result carries agentId")
        .to_owned()
}

fn general_purpose() -> crate::definitions::AgentDefinition {
    builtins()
        .into_iter()
        .find(|definition| definition.agent_type == "general-purpose")
        .expect("general-purpose")
}

#[tokio::test]
async fn every_subagent_sees_the_coordinator_reply_tool() {
    let harness = harness(None);
    harness
        .call(ROOT, "Agent", json!({"description": "Worker", "prompt": "Go."}))
        .await;
    let seen = harness.started(1).await;
    // 后台的 general-purpose 工具面：定义清单里没有它，也照样给（Node `appendChildControlTool`）。
    assert!(
        seen[0].tools.contains(&"RespondToCoordinator".to_owned()),
        "{:?}",
        seen[0].tools
    );
}

#[test]
fn the_definition_deny_list_still_hides_the_reply_tool() {
    let mut definition = general_purpose();
    definition.disallowed_tools = vec!["RespondToCoordinator".to_owned()];
    let rule = ToolRule::new(&definition, true, 1);
    assert!(!rule.allows("RespondToCoordinator"));
}

#[test]
fn the_carrier_escapes_the_five_node_characters() {
    assert_eq!(
        escape("a & b <c> \"d\" 'e'"),
        "a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"
    );
}

#[tokio::test]
async fn a_running_coordinator_takes_the_reply_at_its_next_tool_boundary() {
    let gates = Gates::default();
    let harness = held(&gates, true);
    // 主线程派生 P，P 里再派生 C：C 的 coordinator 是 P（在跑），回复进 P 的邮箱。
    let launched = harness
        .call(ROOT, "Agent", json!({"description": "Outer", "prompt": "Go."}))
        .await;
    let outer = spawned(&text(&launched));
    harness.started(1).await;
    let launched = harness
        .call(
            &format!("sess_subagent_{outer}"),
            "Agent",
            json!({"description": "Inner", "prompt": "Dig."}),
        )
        .await;
    let inner = spawned(&text(&launched));
    harness.started(2).await;
    let agent = harness
        .agents
        .core
        .live
        .get(&AgentId::new(&inner))
        .expect("the child is live");
    let tool = RespondToCoordinator::new(harness.agents.core.clone(), &agent);
    let (progress, _receiver) = tokio::sync::mpsc::channel(1);
    let output = tool
        .call(
            json!({"summary": "Progress", "message": "half <done> & \"quoted\""}),
            tool_context(&agent.child, &RunId::new("run_reply")),
            progress,
        )
        .await
        .expect("the reply is queued");
    assert_eq!(output.display["kind"], "respond_to_coordinator");
    assert_eq!(output.display["status"], "success");
    let body = text(&output);
    assert!(body.contains("was queued for the coordinator"), "{body}");
    assert!(
        body.contains("Continue the current task unless the coordinator explicitly changed or ended it."),
        "{body}"
    );
    let mailbox = harness
        .agents
        .core
        .live
        .with(|agents| match &agents.get(&AgentId::new(&outer)).unwrap().state {
            AgentState::Running { mailbox, .. } => mailbox.clone(),
            other => panic!("expected a running coordinator: {other:?}"),
        });
    let [crate::live::Mail::Notice(notice)] = mailbox.as_slice() else {
        panic!("expected one queued notice: {mailbox:?}");
    };
    assert_eq!(notice.kind, AgentNoticeKind::SubagentMessage);
    assert_eq!(notice.status, "running");
    assert!(notice.envelope.contains(&format!("<agent-id>{inner}</agent-id>")));
    assert!(notice.envelope.contains("<agent-type>general-purpose</agent-type>"));
    assert!(notice.envelope.contains("<summary>Progress</summary>"));
    assert!(
        notice
            .envelope
            .contains("<message>half &lt;done&gt; &amp; &quot;quoted&quot;</message>")
    );
    gates.release(&format!("sess_subagent_{inner}"));
    gates.release(&format!("sess_subagent_{outer}"));
}

#[tokio::test]
async fn a_finished_child_sends_the_reply_to_the_root_session() {
    let harness = harness(None);
    let launched = harness
        .call(ROOT, "Agent", json!({"description": "Worker", "prompt": "Go."}))
        .await;
    let id = spawned(&text(&launched));
    harness.started(1).await;
    let mut root = harness.agents.signals().signals(&SessionId::new(ROOT));
    // 等子代理跑完（harness 的假子循环立刻返回），它的终态通知先到。
    let mut agent = harness.agents.core.live.get(&AgentId::new(&id)).unwrap();
    for _ in 0..10_000 {
        if !agent.is_live() {
            break;
        }
        tokio::task::yield_now().await;
        agent = harness.agents.core.live.get(&AgentId::new(&id)).unwrap();
    }
    let tool = RespondToCoordinator::new(harness.agents.core.clone(), &agent);
    let (progress, _receiver) = tokio::sync::mpsc::channel(1);
    tool.call(
        json!({"summary": "Done-ish", "message": "still working"}),
        tool_context(&agent.child, &RunId::new("run_reply")),
        progress,
    )
    .await
    .unwrap();
    // 顶层会话的流里拿到这条（跳过终态通知）：来源是 subagent_message，正文是 carrier。
    for _ in 0..4 {
        let Some(AgentSignal::Notice(notice)) = root.next().await else {
            continue;
        };
        if notice.kind != AgentNoticeKind::SubagentMessage {
            continue;
        }
        assert!(notice.text.starts_with("<subagent-message>\n"));
        assert!(notice.text.contains("<summary>Done-ish</summary>"));
        assert!(notice.text.contains("<message>still working</message>"));
        return;
    }
    panic!("the coordinator reply never reached the root session");
}

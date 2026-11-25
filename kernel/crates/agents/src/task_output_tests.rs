//! TaskOutput：后台子代理的状态与结果（本地 agent 分支）。

use nibi_kernel_api::ids::AgentId;
use serde_json::json;

use crate::test_support::{Gates, harness, held, text};

const ROOT: &str = "sess_parent";

fn spawned(output: &str) -> String {
    output
        .split("agentId: ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .expect("the Agent result carries agentId")
        .to_owned()
}

/// 等子代理离开在跑状态（假子循环马上返回）。
async fn finished(harness: &crate::test_support::Harness, id: &str) {
    for _ in 0..10_000 {
        if let Some(agent) = harness.agents.core.live.get(&AgentId::new(id))
            && !agent.is_live()
        {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the agent did not finish");
}

#[tokio::test]
async fn a_completed_agent_reports_its_stored_result() {
    let harness = harness(None);
    let launched = harness
        .call(ROOT, "Agent", json!({"description": "Worker", "prompt": "Go."}))
        .await;
    let id = spawned(&text(&launched));
    harness.started(1).await;
    finished(&harness, &id).await;
    let output = harness
        .call(ROOT, "TaskOutput", json!({"task_id": id, "block": false, "timeout": 0}))
        .await;
    assert!(!output.is_error);
    let body = text(&output);
    assert!(
        body.starts_with("<retrieval_status>success</retrieval_status>"),
        "{body}"
    );
    assert!(body.contains(&format!("<task_id>{id}</task_id>")), "{body}");
    assert!(body.contains("<task_type>local_agent</task_type>"), "{body}");
    assert!(body.contains("<status>completed</status>"), "{body}");
    assert!(body.contains("<output>\nHello from the subagent.\n</output>"), "{body}");
    assert_eq!(output.display["kind"], "task_output");
    assert_eq!(output.display["retrievalStatus"], "success");
    assert_eq!(output.display["taskStatus"], "completed");
    assert_eq!(output.display["output"], "Hello from the subagent.");
    assert!(output.display.get("truncated").is_none());
}

#[tokio::test]
async fn a_running_agent_is_not_ready_and_waits_when_asked_to_block() {
    let gates = Gates::default();
    let harness = held(&gates, true);
    let launched = harness
        .call(ROOT, "Agent", json!({"description": "Worker", "prompt": "Go."}))
        .await;
    let id = spawned(&text(&launched));
    harness.started(1).await;
    let output = harness
        .call(ROOT, "TaskOutput", json!({"task_id": id, "block": false, "timeout": 0}))
        .await;
    assert!(!output.is_error);
    let body = text(&output);
    assert!(
        body.starts_with("<retrieval_status>not_ready</retrieval_status>"),
        "{body}"
    );
    assert!(body.contains("<status>running</status>"), "{body}");
    assert_eq!(output.display["retrievalStatus"], "not_ready");
    // block=true：等它跑完。稍后放行，轮询期间让出执行权，拿到 success。
    let release = gates.clone();
    let child = format!("sess_subagent_{id}");
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        release.release(&child);
    });
    let output = harness
        .call(
            ROOT,
            "TaskOutput",
            json!({"task_id": id, "block": true, "timeout": 5_000}),
        )
        .await;
    let body = text(&output);
    assert!(
        body.starts_with("<retrieval_status>success</retrieval_status>"),
        "{body}"
    );
    assert!(body.contains("<status>completed</status>"), "{body}");
}

#[tokio::test]
async fn an_unknown_task_is_a_tool_error() {
    let harness = harness(None);
    let output = harness
        .call(
            ROOT,
            "TaskOutput",
            json!({"task_id": "task_missing", "block": false, "timeout": 0}),
        )
        .await;
    assert!(output.is_error);
    assert_eq!(
        text(&output),
        "<tool_use_error>No task found with ID: task_missing</tool_use_error>"
    );
}

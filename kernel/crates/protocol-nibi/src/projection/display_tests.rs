//! 冷恢复的卡片载荷重建（`display.rs`）：只认能从结果正文确定得到的两种。

use serde_json::json;

use super::cold;

const RESPOND_OK: &str = "Response response_123 was queued for the coordinator. Continue the current task unless the coordinator explicitly changed or ended it.";

#[test]
fn the_coordinator_reply_rebuilds_its_success_display() {
    assert_eq!(
        cold("RespondToCoordinator", RESPOND_OK),
        Some(json!({"kind": "respond_to_coordinator", "status": "success"}))
    );
    assert_eq!(cold("RespondToCoordinator", "Response response_1 failed."), None);
    assert_eq!(cold("Read", RESPOND_OK), None);
}

#[test]
fn the_task_output_rebuilds_status_and_output() {
    let text = "<retrieval_status>success</retrieval_status>\n\n<task_id>agent_1</task_id>\n\n<task_type>local_agent</task_type>\n\n<status>completed</status>\n\n<output>\nHello from the subagent.\n</output>";
    assert_eq!(
        cold("TaskOutput", text),
        Some(json!({
            "kind": "task_output",
            "retrievalStatus": "success",
            "taskStatus": "completed",
            "output": "Hello from the subagent.",
        }))
    );
    // 没有输出（运行中）时只带状态；未知任务（工具错误）不会走到这里（is_error）。
    let not_ready = "<retrieval_status>not_ready</retrieval_status>\n\n<task_id>agent_1</task_id>\n\n<status>running</status>";
    assert_eq!(
        cold("TaskOutput", not_ready),
        Some(json!({
            "kind": "task_output",
            "retrievalStatus": "not_ready",
            "taskStatus": "running",
        }))
    );
}

#[test]
fn the_task_output_caps_its_display_fields() {
    let output = "x".repeat(2_100);
    let text = format!(
        "<retrieval_status>success</retrieval_status>\n\n<status>completed</status>\n\n<output>\n{output}\n</output>"
    );
    let display = cold("TaskOutput", &text).expect("task output display");
    assert_eq!(display["output"].as_str().unwrap().len(), 2_000);
    assert_eq!(display["truncated"], json!(true));
}

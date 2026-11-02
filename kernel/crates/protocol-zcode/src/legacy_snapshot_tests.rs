//! `legacy_snapshot` 的形状：旧协议快照必须是 Host 严格 schema 能解析的 JSON，消息要保留
//! 正文/思考/工具调用，index profile 只留正文。

use rust_cli_kernel_api::compaction::{ContextNotice, ContextOccupancy};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId, ToolUseId, TraceId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, StopReason, ToolResultContent, Usage, UserMessage,
    UserOrigin,
};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::SessionView;
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use serde_json::json;

use super::*;

fn user(id: &str, text: &str) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin: UserOrigin::Human,
    })
}

fn assistant() -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new("a1"),
        content: vec![
            ContentBlock::Thinking {
                thinking: "think".to_owned(),
                signature: None,
            },
            ContentBlock::Text {
                text: "hi".to_owned(),
            },
            ContentBlock::ToolUse {
                id: ToolUseId::new("tu1"),
                name: "Bash".to_owned(),
                input: json!({"command": "echo"}),
            },
        ],
        model: "m".to_owned(),
        stop_reason: Some(StopReason::ToolUse),
        usage: Some(Usage {
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
        }),
    })
}

fn tool_result() -> Message {
    Message::User(UserMessage {
        id: MessageId::new("u2"),
        content: vec![ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new("tu1"),
            content: vec![ToolResultContent::Text {
                text: "out".to_owned(),
            }],
            is_error: false,
        }],
        origin: UserOrigin::ToolResult {
            assistant: MessageId::new("a1"),
        },
    })
}

fn view() -> SessionView {
    SessionView {
        meta: SessionMeta {
            id: SessionId::new("sess_1"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("env"),
                root: EnvPath::new("/work"),
            },
            title: "Test".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
        },
        messages: vec![
            user("u1", "hello"),
            assistant(),
            tool_result(),
            user("u3", "next"),
        ],
        selection: ModelSelection {
            provider: "p".to_owned(),
            model: "m".to_owned(),
            reasoning: Some("high".to_owned()),
            connection: None,
        },
        mode: PermissionMode::Default,
        plan: false,
        pending: Vec::new(),
        queue: Vec::new(),
        last_seq: 7,
        revision: 3,
        running: false,
        background: Vec::new(),
        peer_held: Vec::new(),
        context_usage: Some(ContextOccupancy {
            used_tokens: 12,
            max_tokens: 100,
        }),
        context_notice: ContextNotice::Hidden,
        output_speed: None,
        launches: Vec::new(),
    }
}

#[test]
fn full_profile_keeps_text_reasoning_and_a_settled_tool_call() {
    let messages = messages(&view(), Profile::Full);
    assert_eq!(
        messages.len(),
        3,
        "tool-result user rows are fused into the part"
    );
    let assistant = &messages[1];
    assert_eq!(assistant["info"]["role"], "assistant");
    assert_eq!(assistant["info"]["parentMessageId"], "u1");
    assert_eq!(assistant["info"]["tokens"]["input"], 10);
    assert_eq!(assistant["info"]["tokens"]["cache"]["read"], 3);
    assert_eq!(assistant["info"]["path"]["root"], "/work");
    let parts = assistant["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0]["type"], "reasoning");
    assert_eq!(parts[1]["type"], "text");
    assert_eq!(parts[2]["type"], "tool");
    assert_eq!(parts[2]["callId"], "tu1");
    assert_eq!(parts[2]["state"]["status"], "completed");
    assert_eq!(parts[2]["state"]["output"], "out");
    assert_eq!(parts[2]["state"]["input"]["command"], "echo");
}

#[test]
fn index_profile_drops_reasoning_and_tools() {
    let messages = messages(&view(), Profile::Index);
    let assistant = &messages[1];
    let parts = assistant["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["type"], "text");
    assert_eq!(parts[0]["text"], "hi");
}

#[test]
fn snapshot_carries_the_host_required_sections() {
    let snapshot = snapshot(&view(), Profile::Full);
    assert_eq!(snapshot["protocol"]["name"], "ZCode Protocol");
    assert_eq!(snapshot["session"]["sessionId"], "sess_1");
    assert_eq!(snapshot["session"]["sessionKind"], "interactive");
    assert_eq!(snapshot["session"]["mode"], "build");
    assert_eq!(
        snapshot["settings"]["thoughtLevel"]["current"],
        json!("high")
    );
    assert_eq!(snapshot["projection"]["turnCount"], 2);
    assert_eq!(snapshot["projection"]["contextUsed"], 12);
    assert_eq!(snapshot["projection"]["contextWindow"], 100);
    assert_eq!(snapshot["runtime"]["eventSeq"], 7);
    assert_eq!(snapshot["runtime"]["stateRevision"], 3);
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 3);
}

#[test]
fn no_reasoning_omits_the_thought_level_current_field() {
    let mut view = view();
    view.selection.reasoning = None;
    let snapshot = snapshot(&view, Profile::Full);
    assert_eq!(snapshot["settings"]["thoughtLevel"]["enabled"], false);
    assert!(
        snapshot["settings"]["thoughtLevel"]
            .get("current")
            .is_none()
    );
}

#[test]
fn plan_mode_is_reported_as_plan() {
    let mut view = view();
    view.plan = true;
    let snapshot = snapshot(&view, Profile::Full);
    assert_eq!(snapshot["session"]["mode"], "plan");
    assert_eq!(snapshot["projection"]["mode"], "plan");
}

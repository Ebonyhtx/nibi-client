//! 子代理的模型选择（工作线 F49）与权限模式收紧（修复线 A2）。

use nibi_kernel_api::model::{ModelConnection, ModelSelection};
use nibi_kernel_api::permission::{ExecutionState, PermissionMode};

use super::{execution, mode, restrict, selection};

#[test]
fn a_child_keeps_the_team_project_of_the_parent() {
    let parent = ModelSelection {
        provider: "account:bigmodel-team-coding-plan".to_owned(),
        model: "GLM-5.3".to_owned(),
        reasoning: Some("high".to_owned()),
        connection: Some(Box::new(ModelConnection {
            product_id: "prod-1".to_owned(),
            organization_id: "org-t".to_owned(),
            project_id: "p-t".to_owned(),
        })),
    };
    assert_eq!(selection(&parent, Some("inherit"), None), parent);
    let child = selection(&parent, Some("GLM-5.3-Flash"), Some("low".to_owned()));
    assert_eq!(child.model, "GLM-5.3-Flash");
    assert_eq!(child.reasoning.as_deref(), Some("low"));
    assert_eq!(child.connection, parent.connection);
}

/// Node 3.17.2 `restrictPermissionMode` 的整张表（从严到宽 plan < build < edit < guarded < yolo；auto 不参与）。
#[test]
fn a_declared_mode_only_restricts_the_parent() {
    use PermissionMode as P;
    let cases = [
        (P::Default, P::BypassPermissions, P::Default),
        (P::Default, P::Guarded, P::Default),
        (P::Default, P::AcceptEdits, P::Default),
        (P::Default, P::Default, P::Default),
        (P::Default, P::Plan, P::Plan),
        (P::Default, P::Auto, P::Default),
        (P::Plan, P::AcceptEdits, P::Plan),
        (P::Plan, P::BypassPermissions, P::Plan),
        (P::AcceptEdits, P::BypassPermissions, P::AcceptEdits),
        (P::AcceptEdits, P::Default, P::Default),
        (P::AcceptEdits, P::Plan, P::Plan),
        (P::Guarded, P::BypassPermissions, P::Guarded),
        (P::Guarded, P::AcceptEdits, P::AcceptEdits),
        (P::Guarded, P::Plan, P::Plan),
        (P::BypassPermissions, P::BypassPermissions, P::BypassPermissions),
        (P::BypassPermissions, P::Guarded, P::Guarded),
        (P::BypassPermissions, P::Plan, P::Plan),
        (P::BypassPermissions, P::Auto, P::BypassPermissions),
        (P::Auto, P::Plan, P::Auto),
        (P::Auto, P::BypassPermissions, P::Auto),
    ];
    for (parent, child, expected) in cases {
        assert_eq!(restrict(parent, child), expected, "{parent:?} + {child:?}");
    }
}

/// 没有声明时继承父运行（含 plan）；declared 的 `bypassPermissions` 在父不是 yolo 时不会生效
/// （修复线 A2 的原契约，现在由整张收紧表覆盖）。
#[test]
fn a_child_without_a_declared_mode_inherits_the_parent() {
    use PermissionMode as P;
    for parent in [
        P::Default,
        P::AcceptEdits,
        P::Plan,
        P::Guarded,
        P::BypassPermissions,
        P::DontAsk,
        P::Auto,
    ] {
        assert_eq!(mode(parent, None), parent, "{parent:?}");
    }
    assert_eq!(mode(P::Default, Some(P::BypassPermissions)), P::Default);
    assert_eq!(mode(P::Guarded, Some(P::AcceptEdits)), P::AcceptEdits);
    assert_eq!(mode(P::Plan, Some(P::Default)), P::Plan);
}

/// plan + guarded 的父会话：子代理保留 plan 开关与基础模式（修复线 A1/A2）；声明只能收紧。
#[test]
fn a_child_carries_the_parent_base_mode_and_plan() {
    let parent = ExecutionState::from(PermissionMode::Guarded).with_plan(true);
    assert_eq!(execution(parent, None), parent);
    // 声明 build/edit 不会把 plan 父会话变宽：仍是 plan，基础模式仍是 guarded。
    for declared in [PermissionMode::Default, PermissionMode::AcceptEdits] {
        assert_eq!(execution(parent, Some(declared)), parent, "{declared:?}");
    }
    // 其它基础模式下声明取更严格的一个，plan 关着。
    let parent = ExecutionState::from(PermissionMode::Default);
    assert_eq!(
        execution(parent, Some(PermissionMode::Guarded)),
        ExecutionState::from(PermissionMode::Default)
    );
    assert_eq!(
        execution(parent, Some(PermissionMode::Plan)),
        ExecutionState::from(PermissionMode::Plan)
    );
    // plan 是最严格的：yolo + plan 的父会话里声明 guarded 也还是 plan（基础模式仍是 yolo）。
    let parent = ExecutionState::from(PermissionMode::BypassPermissions).with_plan(true);
    assert_eq!(execution(parent, Some(PermissionMode::Guarded)), parent);
    // 没有 plan 时 yolo 可以收紧成 guarded。
    let parent = ExecutionState::from(PermissionMode::BypassPermissions);
    assert_eq!(
        execution(parent, Some(PermissionMode::Guarded)),
        ExecutionState::from(PermissionMode::Guarded)
    );
}

// ── K4：子代理失败回传部分报告 + agentId + usage ─────────────────────────────

use std::sync::Arc;

use futures_util::StreamExt;
use nibi_kernel_api::agents::{AgentSignal, DISPLAY_KEY};
use nibi_kernel_api::ids::SessionId;
use serde_json::json;
use tokio::sync::Notify;

use crate::test_support::{failing_harness, text};

/// 取下一条通知，跳过子代理的生命周期信号（与 lib_tests 的同名 helper 同语义）。
async fn next_notice(
    stream: &mut futures_util::stream::BoxStream<'static, AgentSignal>,
) -> nibi_kernel_api::agents::AgentNotice {
    while let Some(signal) = stream.next().await {
        if let AgentSignal::Notice(notice) = signal {
            return notice;
        }
    }
    panic!("expected a notice");
}

/// 前台失败：结果带 `<subagent_failure>` JSON（ok:false + error/agentId/usage/partialReport，
/// 字段名与 Node 的 `AgentFailedOutput` 一致）、SendMessage 续接提示，`is_error` 且 display 为 failed。
#[tokio::test]
async fn a_failed_foreground_agent_reports_partial_result_usage_and_agent_id() {
    let harness = failing_harness(None);
    let output = harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Find", "prompt": "List.", "subagent_type": "Explore", "run_in_background": false}),
        )
        .await;
    assert!(output.is_error, "{output:?}");
    let text = text(&output);
    assert!(text.contains("<subagent_failure>"), "{text}");
    assert!(text.contains("\"ok\":false"), "{text}");
    assert!(text.contains("\"status\":\"failed\""), "{text}");
    assert!(text.contains("\"error\":\"simulated model failure\""), "{text}");
    assert!(text.contains("\"agentId\":\"agent_1\""), "{text}");
    // 用量是最后一次响应的明细（test_support::report_message 的 usage）。
    assert!(text.contains("\"inputTokens\":10"), "{text}");
    assert!(text.contains("\"outputTokens\":3"), "{text}");
    assert!(text.contains("\"totalTokens\":13"), "{text}");
    assert!(
        text.contains("\"partialReport\":\"Hello from the subagent.\""),
        "{text}"
    );
    assert!(
        text.contains("agentId: agent_1 (use SendMessage with to: 'agent_1'"),
        "{text}"
    );
    assert_eq!(output.display[DISPLAY_KEY]["status"], json!("failed"));
}

/// 后台失败：通知带 `<result>`（部分文本）与 `<usage>`，不能只有 error/agentId/duration。
#[tokio::test]
async fn a_failed_background_agent_notifies_with_partial_result_and_usage() {
    let gate = Arc::new(Notify::new());
    let harness = failing_harness(Some(gate.clone()));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    let output = harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Find files", "prompt": "List the files.", "subagent_type": "Explore"}),
        )
        .await;
    assert!(text(&output).starts_with("Async agent launched successfully."));
    gate.notify_one();
    let notice = next_notice(&mut stream).await;
    assert_eq!(notice.status, "failed");
    assert!(
        notice.text.contains("<status>failed</status>"),
        "{}",
        notice.text
    );
    assert!(
        notice
            .text
            .contains("<result>Hello from the subagent.</result>"),
        "{}",
        notice.text
    );
    assert!(
        notice
            .text
            .contains("<subagent_tokens>13</subagent_tokens>"),
        "{}",
        notice.text
    );
    assert!(
        notice
            .text
            .contains("failed: simulated model failure"),
        "{}",
        notice.text
    );
}

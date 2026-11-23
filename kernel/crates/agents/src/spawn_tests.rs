//! 子代理的模型选择（工作线 F49）与权限模式收紧（修复线 A2）。

use nibi_kernel_api::model::{ModelConnection, ModelSelection};
use nibi_kernel_api::permission::{ExecutionState, PermissionMode};

use super::{execution, mode, restrict, selection};
use crate::selection::AgentModelSelection;

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
    assert_eq!(selection(&parent, None, None, None), parent);
    // 同一个 provider 内换模型：沿用父会话的团队项目连接；Agent 参数档位压过 pin 的档位。
    let pin = AgentModelSelection::parse("account:bigmodel-team-coding-plan/GLM-5.3-Flash", None)
        .expect("pin");
    let child = selection(&parent, Some(&pin), None, Some("low".to_owned()));
    assert_eq!(child.model, "GLM-5.3-Flash");
    assert_eq!(child.reasoning.as_deref(), Some("low"));
    assert_eq!(child.connection, parent.connection);
}

/// 设置页覆盖 > 定义 pin > 继承；覆盖与 pin 的 Provider 不同时连接不跟父会话（换供应商）。
#[test]
fn the_override_replaces_the_whole_selection_of_the_pin() {
    let parent = ModelSelection {
        provider: "e2e-upstream".to_owned(),
        model: "deepseek-v4-flash".to_owned(),
        reasoning: Some("max".to_owned()),
        connection: None,
    };
    let pin = AgentModelSelection::parse("other-provider/other-model", Some("max")).expect("pin");
    let over =
        AgentModelSelection::parse("e2e-upstream-alt/deepseek-v4-pro", Some("high")).expect("over");
    let child = selection(&parent, Some(&pin), Some(&over), None);
    assert_eq!(child.provider, "e2e-upstream-alt");
    assert_eq!(child.model, "deepseek-v4-pro");
    assert_eq!(child.reasoning.as_deref(), Some("high"));

    // 没有覆盖时 pin 自己带 Provider；档位来自 pin 的 thoughtLevel。
    let child = selection(&parent, Some(&pin), None, None);
    assert_eq!(child.provider, "other-provider");
    assert_eq!(child.model, "other-model");
    assert_eq!(child.reasoning.as_deref(), Some("max"));
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
            .contains("failed. simulated model failure"),
        "{}",
        notice.text
    );
}

// ── 建子会话的原子性：写入失败不登记 ─────────────────────────────────────────

use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::ids::AgentId;

use crate::live::{AgentState, LiveAgent, Shown};
use crate::report::Ending;
use crate::runs::RunInfo;
use crate::test_support::{harness, workspace};

/// 一次 `spawn::create` 的入参（`Agent` 工具里组装的那一份）。
fn spawn_agent(agent: &AgentId, child: &SessionId, parent: &SessionId) -> LiveAgent {
    LiveAgent {
        agent: agent.clone(),
        child: child.clone(),
        parent: parent.clone(),
        root: parent.clone(),
        owner: None,
        depth: 1,
        tool_use: None,
        description: "Find".to_owned(),
        definition: Arc::new(
            crate::definitions::builtins()
                .into_iter()
                .find(|definition| definition.agent_type == "Explore")
                .unwrap(),
        ),
        workspace: workspace(),
        selection: nibi_kernel_api::testing::selection(),
        execution: ExecutionState::default(),
        background: false,
        asks: None,
        state: AgentState::Finished(Ending::Completed),
        shown: Shown::default(),
        fork_prefix: None,
        machine: None,
    }
}

fn run_info(parent: &SessionId) -> RunInfo {
    RunInfo {
        session: parent.clone(),
        workspace: workspace(),
        selection: nibi_kernel_api::testing::selection(),
    }
}

/// 子会话的写入失败（`create_and_commit` 报错）时：库里没有会话行，`live` 与继承的附加目录里也
/// 没有它——登记全部放在写成功之后（以前先建行、再登记、最后提交，提交失败会同时留下孤儿行与登记）。
/// 前一半是成功对照：同样的调用在写成功时确实继承了目录。
#[tokio::test]
async fn a_failed_child_session_write_registers_nothing() {
    let harness = harness(None);
    let core = &*harness.agents.core;
    let parent = SessionId::new("sess_parent");
    harness
        .directories
        .set(&parent, vec![EnvPath::new("/extra")]);

    // 对照：写成功时子会话继承父会话的附加目录。
    let (agent_id, child) = super::ids(core);
    super::create(
        core,
        spawn_agent(&agent_id, &child, &parent),
        &run_info(&parent),
        "List.",
    )
    .await
    .unwrap();
    assert_eq!(
        harness.directories.get(&child),
        vec![EnvPath::new("/extra")]
    );

    // 写入失败：没有行、没有继承、没有 `live` 条目。
    harness.store.fail_next_create_and_commit();
    let (agent_id, failed) = super::ids(core);
    let error = super::create(
        core,
        spawn_agent(&agent_id, &failed, &parent),
        &run_info(&parent),
        "List.",
    )
    .await
    .err()
    .expect("the injected store failure must fail the spawn");
    assert!(
        error.to_string().contains("injected create_and_commit failure"),
        "{error}"
    );
    assert!(!harness.store.contains(&failed), "no session row");
    assert!(
        harness.directories.get(&failed).is_empty(),
        "the inheritance must run only after the write succeeds"
    );
    let (live, _) = core.live.snapshot_in(&parent);
    assert_eq!(live.len(), 1, "only the first child is live");
    assert_eq!(live[0].child, child);
}

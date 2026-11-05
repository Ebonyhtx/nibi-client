use std::sync::Arc;

use nibi_kernel_api::permission::{PermissionRules, RuleBehavior, RuleSource, SourcedRule};
use nibi_kernel_api::testing::FakeTool;
use nibi_kernel_policy::rules::parse_rule;

use super::*;
use crate::registry::BuiltinTools;

fn rules(denied: &[&str]) -> PermissionRules {
    PermissionRules {
        rules: denied
            .iter()
            .map(|text| SourcedRule {
                source: RuleSource::CliArg,
                behavior: RuleBehavior::Deny,
                rule: parse_rule(text),
            })
            .collect(),
        ..PermissionRules::default()
    }
}

/// 基础工具：Bash、Read、Edit、Write 与被 Bash 藏起来的 Glob / Grep，另有一个 MCP 工具。
fn registry(denied: &[&str]) -> (PolicyFiltered, Arc<PolicyGate>) {
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(FakeTool::new("Bash", false, "ok")),
        Arc::new(FakeTool::new("Read", true, "ok")),
        Arc::new(FakeTool::new("Edit", false, "ok")),
        Arc::new(FakeTool::new("Write", false, "ok")),
        Arc::new(crate::glob::GlobTool::new()),
        Arc::new(crate::grep::GrepTool::new()),
        Arc::new(FakeTool::new("mcp__srv__lookup", true, "ok")),
    ];
    let gate = Arc::new(PolicyGate::new(rules(denied)));
    let inner: Arc<dyn ToolRegistry> = Arc::new(BuiltinTools::new(tools));
    (PolicyFiltered::new(inner, gate.clone()), gate)
}

fn names(tools: &[Arc<dyn Tool>]) -> Vec<&str> {
    tools.iter().map(|tool| tool.name()).collect()
}

/// 没有 deny 规则：与里面的注册表相同（Glob / Grep 仍被 Bash 藏着）。
#[test]
fn without_deny_rules_nothing_changes() {
    let (tools, _) = registry(&[]);
    assert_eq!(
        names(&tools.tools()),
        ["Bash", "Read", "Edit", "Write", "mcp__srv__lookup"]
    );
    assert!(tools.find("Glob").is_none());
    assert!(tools.withheld("Grep").is_some());
}

/// 整个 Bash 被 deny：清单与 `find` 都没有它，原来被它藏起来的 Glob / Grep 补回；Glob 也被 deny 时只补 Grep。
#[test]
fn denying_bash_removes_it_and_restores_the_search_tools() {
    let (tools, _) = registry(&["Bash"]);
    let listed = tools.tools();
    assert_eq!(
        names(&listed),
        ["Read", "Edit", "Write", "mcp__srv__lookup", "Glob", "Grep"]
    );
    assert!(tools.find("Bash").is_none());
    assert_eq!(
        tools
            .find("Grep")
            .map(|tool| tool.name().to_owned())
            .as_deref(),
        Some("Grep")
    );
    // 已经在清单里，不再算“藏起来的”。
    assert!(tools.withheld("Grep").is_none());
    let (tools, _) = registry(&["Bash", "Glob"]);
    assert_eq!(
        names(&tools.tools()),
        ["Read", "Edit", "Write", "mcp__srv__lookup", "Grep"]
    );
    assert!(tools.find("Glob").is_none());
    assert!(tools.withheld("Glob").is_none());
}

/// Edit、Write 与 MCP 服务器的规则去掉对应的工具；带 content 的规则不影响清单。
#[test]
fn only_whole_tool_denials_remove_tools() {
    let (tools, _) = registry(&["Edit", "Write", "mcp__srv"]);
    assert_eq!(names(&tools.tools()), ["Bash", "Read"]);
    assert!(tools.find("Edit").is_none());
    assert!(tools.find("mcp__srv__lookup").is_none());
    assert!(tools.hides("Write"));
    assert!(!tools.hides("Read"));
    let (tools, _) = registry(&["Bash(rm:*)", "Read(/secret/**)"]);
    assert_eq!(
        names(&tools.tools()),
        ["Bash", "Read", "Edit", "Write", "mcp__srv__lookup"]
    );
}

/// 规则快照换了（`/permissions` 改了规则）：下一次取清单就按新规则。
#[test]
fn replaced_rules_apply_on_the_next_listing() {
    let (tools, gate) = registry(&[]);
    assert!(tools.find("Edit").is_some());
    gate.replace_rules(rules(&["Edit"]));
    assert!(tools.find("Edit").is_none());
    assert!(!names(&tools.tools()).contains(&"Edit"));
    let snapshot = tools.snapshot(&nibi_kernel_api::ids::SessionId::new("s"));
    assert!(!names(&snapshot.tools).contains(&"Edit"));
}

/// 会话级 toolDenylist 只影响这个会话的清单与查找；另一个会话不变。
#[test]
fn a_session_denylist_hides_tools_only_for_that_session() {
    use nibi_kernel_api::permission::ToolPolicy;

    let (tools, gate) = registry(&[]);
    let session = SessionId::new("sess_1");
    gate.set_tool_policy(
        &session,
        ToolPolicy {
            allow: Vec::new(),
            deny: vec!["Bash".to_owned()],
        },
    );
    let snapshot = tools.snapshot(&session);
    let listed = names(&snapshot.tools);
    assert!(!listed.contains(&"Bash"));
    assert!(listed.contains(&"Read"));
    assert!(tools.find_for(&session, "Bash").is_none());
    assert!(tools.find_for(&SessionId::new("sess_2"), "Bash").is_some());
    assert!(tools.hides_for(&session, "Bash"));
    assert!(!tools.hides_for(&session, "Read"));
}

/// 会话级 toolAllowlist 只留名单里的工具（搜索补回也受它约束）。
#[test]
fn a_session_allowlist_keeps_only_the_named_tools() {
    use nibi_kernel_api::permission::ToolPolicy;

    let (tools, gate) = registry(&[]);
    let session = SessionId::new("sess_1");
    gate.set_tool_policy(
        &session,
        ToolPolicy {
            allow: vec!["Read".to_owned()],
            deny: Vec::new(),
        },
    );
    let snapshot = tools.snapshot(&session);
    assert_eq!(names(&snapshot.tools), ["Read"]);
    assert!(tools.find_for(&session, "Read").is_some());
    assert!(tools.find_for(&session, "Edit").is_none());
}

/// 动态工作流灰度门关闭：三件套只在这个会话的清单与查找里消失；没登记的会话（CLI/TUI）与进程级
/// 清单不受影响，重新打开后恢复。
#[test]
fn a_closed_dynamic_workflow_gate_hides_the_three_tools_for_that_session() {
    use nibi_kernel_api::session_api::DynamicWorkflowGate;

    let wf = [
        "FillWorkflowHole",
        "GetWorkflowRun",
        "ResolveWorkflowQuestion",
    ];
    let tools: Vec<Arc<dyn Tool>> = std::iter::once("Bash")
        .chain(wf)
        .map(|name| Arc::new(FakeTool::new(name, true, "ok")) as Arc<dyn Tool>)
        .collect();
    let gate = Arc::new(PolicyGate::new(rules(&[])));
    let inner: Arc<dyn ToolRegistry> = Arc::new(BuiltinTools::new(tools));
    let tools = PolicyFiltered::new(inner, gate.clone());

    let host = SessionId::new("host");
    gate.set_dynamic_workflow(&host, DynamicWorkflowGate::new(false, false));
    let closed = tools.snapshot(&host);
    assert_eq!(names(&closed.tools), ["Bash"]);
    for name in wf {
        assert!(tools.find_for(&host, name).is_none(), "{name}");
        assert!(tools.hides_for(&host, name), "{name}");
    }
    // 没登记的会话不参加灰度（CLI/TUI）：三件套照常。
    let cli = SessionId::new("cli");
    assert!(names(&tools.snapshot(&cli).tools).contains(&"FillWorkflowHole"));
    assert!(tools.find_for(&cli, "GetWorkflowRun").is_some());
    // 进程级清单不按会话门过滤。
    assert!(names(&tools.tools()).contains(&"ResolveWorkflowQuestion"));
    // 打开后恢复。
    gate.set_dynamic_workflow(&host, DynamicWorkflowGate::new(true, true));
    assert!(names(&tools.snapshot(&host).tools).contains(&"FillWorkflowHole"));
    assert!(tools.find_for(&host, "FillWorkflowHole").is_some());
}

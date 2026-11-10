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

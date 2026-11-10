//! guarded 模式与 plan 下的判决（修复线 F20 / A1，shell-permissions.md §4.6）：危险命令询问一次、没有建议规则，
//! allow 规则与 hook 放行都不盖过它，deny 规则仍然优先；plan 是独立开关，plan 的闸门拒绝先于 guarded 的
//! 单次确认，所以 plan 下的危险命令是拒绝而不是询问（Node 3.17.2 `checkPermission` 的顺序）。

use super::*;

const DANGER: &str = "Dangerous command requires your approval for this execution";

#[tokio::test]
async fn guarded_asks_once_for_dangerous_commands_and_allows_the_rest() {
    let gate = PolicyGate::default();
    let asked = bash(&gate, PermissionMode::Guarded, "rm -rf build").await;
    assert_eq!(
        asked,
        PermissionDecision::Ask {
            message: DANGER.to_owned(),
            suggestions: Vec::new(),
        }
    );
    // 其余命令同 yolo：不询问。
    assert_eq!(
        bash(&gate, PermissionMode::Guarded, "touch x").await,
        allow()
    );
    assert_eq!(
        bash(&gate, PermissionMode::Guarded, "git push origin main").await,
        allow()
    );
    // yolo 不识别危险命令。
    assert_eq!(
        bash(&gate, PermissionMode::BypassPermissions, "rm -rf build").await,
        allow()
    );
    let input = json!({"command": "git reset --hard"});
    let bash_tool = Named("Bash", PermissionDecision::Passthrough);
    assert!(
        gate.ask_once(&bash_tool, &input, &context(PermissionMode::Guarded))
            .await
    );
    assert!(
        !gate
            .ask_once(
                &bash_tool,
                &input,
                &context(PermissionMode::BypassPermissions)
            )
            .await
    );
}

#[tokio::test]
async fn allow_rules_do_not_skip_the_guarded_question_but_deny_rules_win() {
    let gate = PolicyGate::new(rules(&[
        (RuleBehavior::Allow, "Bash(rm:*)"),
        (RuleBehavior::Deny, "Bash(git reset:*)"),
    ]));
    assert_eq!(
        ask_message(&bash(&gate, PermissionMode::Guarded, "rm -rf build").await),
        DANGER
    );
    assert!(matches!(
        bash(&gate, PermissionMode::Guarded, "git reset --hard").await,
        PermissionDecision::Deny { .. }
    ));
    // hook 放行时仍然生效的检查也按 guarded 跑（Node user-once 不让 hook 替用户批准）。
    let input = json!({"command": "rm -rf build"});
    let tool = Named("Bash", PermissionDecision::Passthrough);
    assert_eq!(
        gate.check_rules(&tool, &input, &context(PermissionMode::Guarded))
            .await,
        Some(PermissionDecision::Ask {
            message: DANGER.to_owned(),
            suggestions: Vec::new(),
        })
    );
    assert_eq!(
        gate.check_rules(&tool, &input, &context(PermissionMode::BypassPermissions))
            .await,
        None
    );
}

/// plan 开着的上下文：判决用的模式是 plan，`execution` 另带基础模式（actor 的完整快照）。
fn planned(base: PermissionMode) -> ToolUseContext {
    use nibi_kernel_api::permission::ExecutionState;
    let execution = ExecutionState::from(base).with_plan(true);
    let mut context = context(execution.effective());
    context.execution = execution;
    context
}

async fn bash_planned(
    gate: &PolicyGate,
    base: PermissionMode,
    command: &str,
) -> PermissionDecision {
    gate.decide(
        &Named("Bash", PermissionDecision::Passthrough),
        &json!({"command": command}),
        &planned(base),
    )
    .await
}

/// 修复线 A1（Node 3.17.2）：plan 的闸门对危险命令直接拒绝，guarded 的单次确认只发生在 plan 之外。
/// plan 仍按自己的语义处理非危险命令（没有分类器时按拒绝）。
#[tokio::test]
async fn plan_denies_dangerous_commands_before_the_guarded_ask() {
    let gate = PolicyGate::default();
    assert_eq!(
        bash_planned(&gate, PermissionMode::Guarded, "rm -rf build").await,
        deny(texts::PLAN_NON_READ_ONLY)
    );
    // 危险命令以外 plan 照旧（没有分类器时 plan 的询问按拒绝处理）。
    assert_eq!(
        bash_planned(&gate, PermissionMode::Guarded, "touch x").await,
        deny(texts::CLASSIFIER_UNAVAILABLE)
    );
    // 基础模式 yolo 不识别 guarded 的危险命令：plan 分支照旧拒绝。
    assert_eq!(
        bash_planned(&gate, PermissionMode::BypassPermissions, "rm -rf build").await,
        deny(texts::CLASSIFIER_UNAVAILABLE)
    );
    // 关掉 plan 回到原来的权限模式：guarded 的危险命令仍要一次单次确认。
    assert_eq!(
        bash(&gate, PermissionMode::Guarded, "rm -rf build").await,
        PermissionDecision::Ask {
            message: DANGER.to_owned(),
            suggestions: Vec::new(),
        }
    );
    // 单次批准的判定按基础模式识别（plan 开着时上下文里的 mode 是 plan）；决策是拒绝时管线不会询问。
    let tool = Named("Bash", PermissionDecision::Passthrough);
    let input = json!({"command": "rm -rf build"});
    assert!(
        gate.ask_once(&tool, &input, &planned(PermissionMode::Guarded))
            .await
    );
    assert!(
        !gate
            .ask_once(&tool, &input, &planned(PermissionMode::BypassPermissions))
            .await
    );
    // auto_in_plan 关掉时 plan 下其他询问照旧，但危险命令仍是 plan 的拒绝。
    let asking = PolicyGate::default().with_options(PolicyOptions {
        auto_in_plan: false,
    });
    assert!(matches!(
        bash_planned(&asking, PermissionMode::BypassPermissions, "touch x").await,
        PermissionDecision::Ask { .. }
    ));
    assert_eq!(
        bash_planned(&asking, PermissionMode::Guarded, "rm -rf build").await,
        deny(texts::PLAN_NON_READ_ONLY)
    );
}

/// plan 的拒绝最优先：deny 规则与工具自身的拒绝在 guarded 的单次确认之前。
#[tokio::test]
async fn plan_denies_before_the_guarded_single_use_ask() {
    let denied = PolicyGate::new(rules(&[(RuleBehavior::Deny, "Bash(rm:*)")]));
    assert!(matches!(
        bash_planned(&denied, PermissionMode::Guarded, "rm -rf build").await,
        PermissionDecision::Deny { .. }
    ));
    let whole = PolicyGate::new(rules(&[(RuleBehavior::Deny, "Bash")]));
    assert!(matches!(
        bash_planned(&whole, PermissionMode::Guarded, "rm -rf build").await,
        PermissionDecision::Deny { .. }
    ));
    let tool = Named(
        "Bash",
        PermissionDecision::Deny {
            message: "denied by the tool".to_owned(),
        },
    );
    let outcome = PolicyGate::default()
        .decide(
            &tool,
            &json!({"command": "rm -rf build"}),
            &planned(PermissionMode::Guarded),
        )
        .await;
    assert_eq!(outcome, deny("denied by the tool"));
}

/// hook 放行不能代替 plan 的拒绝，也不能代替 plan 之外 guarded 的单次批准；plan 本身不被 hook 放行跳过。
#[tokio::test]
async fn hook_allow_cannot_replace_plan_or_the_single_use_ask() {
    let gate = PolicyGate::default();
    let tool = Named("Bash", PermissionDecision::Passthrough);
    let dangerous = json!({"command": "rm -rf build"});
    // plan 开着时危险命令是 plan 的拒绝（先于 guarded 的单次确认），hook 放行也盖不过。
    assert_eq!(
        gate.check_rules(&tool, &dangerous, &planned(PermissionMode::Guarded))
            .await,
        Some(deny(texts::PLAN_NON_READ_ONLY))
    );
    // plan 会询问的调用（这里 guarded 的非危险写入）也不能被 hook 放行；只读命令照常放行。
    assert!(matches!(
        gate.check_rules(
            &tool,
            &json!({"command": "touch x"}),
            &planned(PermissionMode::Guarded)
        )
        .await,
        Some(PermissionDecision::Ask { .. })
    ));
    assert_eq!(
        gate.check_rules(
            &tool,
            &json!({"command": "echo hi"}),
            &planned(PermissionMode::Guarded)
        )
        .await,
        None
    );
    // plan 本身也不被 hook 放行跳过：yolo 基础模式的非只读命令同样交给完整判决链。
    assert!(matches!(
        gate.check_rules(
            &tool,
            &json!({"command": "touch x"}),
            &planned(PermissionMode::BypassPermissions)
        )
        .await,
        Some(PermissionDecision::Ask { .. })
    ));
    assert_eq!(
        gate.check_rules(
            &tool,
            &json!({"command": "echo hi"}),
            &planned(PermissionMode::BypassPermissions)
        )
        .await,
        None
    );
    // 没有 plan 时行为不变：guarded 危险命令仍然要问，普通命令 hook 放行。
    assert_eq!(
        gate.check_rules(&tool, &dangerous, &context(PermissionMode::Guarded))
            .await,
        Some(PermissionDecision::Ask {
            message: DANGER.to_owned(),
            suggestions: Vec::new(),
        })
    );
    assert_eq!(
        gate.check_rules(
            &tool,
            &json!({"command": "touch x"}),
            &context(PermissionMode::Guarded)
        )
        .await,
        None
    );
}

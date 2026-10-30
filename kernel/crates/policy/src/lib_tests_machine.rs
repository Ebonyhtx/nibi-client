//! 远端机器上的调用（remote-exec.md §20.8）：相对路径规则按那台机器的工作目录，本机的附加目录不带过去，只读判定看那台
//! 机器的路径风格。

use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_kernel_api::machine::MachineEnv;

use super::*;
use crate::readonly::is_read_only_on;

/// 路由后的上下文：dev-a 上，工作区是它的工作目录。
fn remote(mode: PermissionMode) -> ToolUseContext {
    let mut context = context(mode);
    context.machine = MachineEnv::new(
        Arc::new(UnusedEnvironment),
        Arc::new(rust_cli_kernel_api::mcp::NoMcpTransport),
    )
    .named("dev-a");
    context.workspace = WorkspaceRef {
        environment: EnvironmentId::new("dev-a"),
        root: EnvPath::new("/home/dev/proj"),
    };
    context
}

async fn edit(gate: &PolicyGate, context: &ToolUseContext, path: &str) -> PermissionDecision {
    gate.decide(
        &Named("Edit", PermissionDecision::Passthrough),
        &json!({"file_path": path, "old_string": "a", "new_string": "b"}),
        context,
    )
    .await
}

#[tokio::test]
async fn relative_rules_follow_the_machine_working_directory() {
    let gate = PolicyGate::new(rules(&[(RuleBehavior::Allow, "Edit(src/**)")]));
    let mode = PermissionMode::Default;
    // dev-a 上：`src/**` 锚在 /home/dev/proj。
    assert_eq!(
        edit(&gate, &remote(mode), "/home/dev/proj/src/a.rs").await,
        allow()
    );
    // 同一个路径在本机（工作区 /w）不在规则里。
    assert!(matches!(
        edit(&gate, &context(mode), "/home/dev/proj/src/a.rs").await,
        PermissionDecision::Ask { .. }
    ));
}

#[tokio::test]
async fn local_additional_directories_do_not_reach_a_remote_machine() {
    let mut base = rules(&[]);
    base.additional_directories = vec![EnvPath::new("/extra")];
    let gate = PolicyGate::new(base);
    let mode = PermissionMode::AcceptEdits;
    assert_eq!(edit(&gate, &context(mode), "/extra/a.txt").await, allow());
    assert!(matches!(
        edit(&gate, &remote(mode), "/extra/a.txt").await,
        PermissionDecision::Ask { .. }
    ));
    // 远端自己的工作目录里照常放行。
    assert_eq!(
        edit(&gate, &remote(mode), "/home/dev/proj/a.txt").await,
        allow()
    );
}

#[test]
fn the_read_only_check_uses_the_machine_path_style() {
    // xargs：Windows 的路径风格下不判只读（原来是本机的 `cfg!(windows)`）。
    assert!(is_read_only_on("xargs echo", false, PathStyle::Posix));
    assert!(!is_read_only_on("xargs echo", false, PathStyle::Windows));
}

#[tokio::test]
async fn session_additional_directories_are_allowed_per_session() {
    use rust_cli_kernel_api::ids::SessionId;
    use rust_cli_kernel_api::session_paths::SessionDirectories;

    let directories = Arc::new(SessionDirectories::new());
    let gate = PolicyGate::new(rules(&[])).with_session_directories(directories.clone());
    let mode = PermissionMode::AcceptEdits;
    let mut first = context(mode);
    first.session = SessionId::new("sess_first");
    let mut second = context(mode);
    second.session = SessionId::new("sess_second");
    // 没有附加目录时，工作区之外要问。
    assert!(matches!(
        edit(&gate, &first, "/extra/scoped.txt").await,
        PermissionDecision::Ask { .. }
    ));
    directories.set(&first.session, vec![EnvPath::new("/extra")]);
    assert_eq!(edit(&gate, &first, "/extra/scoped.txt").await, allow());
    // 另一个会话不受影响（按会话取，不是进程级）。
    assert!(matches!(
        edit(&gate, &second, "/extra/scoped.txt").await,
        PermissionDecision::Ask { .. }
    ));
    // 子代理继承父会话的附加目录。
    directories.inherit(&first.session, &second.session);
    assert_eq!(edit(&gate, &second, "/extra/scoped.txt").await, allow());
    // 远端机器上同样不带过去。
    assert!(matches!(
        edit(&gate, &remote(mode), "/extra/scoped.txt").await,
        PermissionDecision::Ask { .. }
    ));
    directories.release(&first.session);
    assert!(matches!(
        edit(&gate, &first, "/extra/scoped.txt").await,
        PermissionDecision::Ask { .. }
    ));
}

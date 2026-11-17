// 复制自 apps/nibi-cli-rust/crates/bash/src/lib.rs（07ab266d4b），只保留只读判定。
//! Bash 命令的只读判定（docs/specs/rust-cli/shell-permissions.md §4.3）。
//!
//! 表与回调来自 Node 版（`bash-readonly-policy-*.ts`：命令白名单、每个命令的安全参数、危险参数回调、
//! git 只读子命令）。Node 版的“总是允许”建议与规则求值没有复制：规则匹配在 [`crate::shell_rules`]。
mod argv;
mod callbacks;
mod callbacks_net;
mod flags;
mod git;
mod git_callbacks;
mod js;
mod printf;
mod tables;

pub(crate) use argv::strip_wrappers;
pub use git::invokes_git;

use crate::guarded::Dialect;
use crate::parse::{Analysis, analyze, is_permission_safe};
use nibi_kernel_api::env_files::PathStyle;
use nibi_kernel_api::env_shell::ShellKind;

/// Bash 工具实际起的 shell：只读表只覆盖 Bash（Windows 上是 Git Bash）。`tools::bash` 的 `SHELL` 与
/// 判决链的只读放行共用这一条前提；换 shell 时两处一起失效（非 Bash 不算只读），不能只改一边。
pub const BASH_TOOL_SHELL: ShellKind = ShellKind::Bash;

/// 本机构建平台的路径风格。
fn platform_style() -> PathStyle {
    if cfg!(windows) {
        PathStyle::Windows
    } else {
        PathStyle::Posix
    }
}

/// 只读证明对这个 shell 与这台机器的路径风格是否成立：只有 Bash 方言（Posix / Git Bash）。
///
/// 只读表来自 Node 的 Bash 判定，只覆盖这两种方言。PowerShell（以及将来的 CMD）没有这张表，一律不算只读；
/// 新增 [`ShellKind`] 变体时这个 `match` 不再完整，编译失败，强制重新评估只读证明之后再放行。
pub fn readonly_dialect_for(shell: ShellKind, style: PathStyle) -> Option<Dialect> {
    match shell {
        // Bash 工具在 Unix 上是 POSIX shell，在 Windows 上是 Git Bash；两者的命令表相同。
        ShellKind::Bash => Some(Dialect::of(style)),
        ShellKind::PowerShell => None,
    }
}

/// 本机执行环境的只读方言。[`readonly_dialect_for`] 按本机构建平台的路径风格。
pub fn readonly_dialect(shell: ShellKind) -> Option<Dialect> {
    readonly_dialect_for(shell, platform_style())
}

/// 只读证明的有效前提：
/// - shell 是 Bash 方言（[`readonly_dialect`] 给出方言；非 Bash 一律不成立）；
/// - `git_unsafe` 如实反映工作区 git 配置是否可信（true 时含 git 的命令不算只读）；
/// - 路径风格与执行命令的机器一致（[`is_read_only_analysis_on`]）。
///
/// 调用方不能只凭“命令文本看起来只读”放行：shell 换掉之后，同一段文本可能由另一种语法执行
/// （PowerShell 的重定向、别名、cmd 的 `&` 等），证明不再成立。
pub fn is_read_only_analysis_for_shell_on(
    analysis: &Analysis,
    git_unsafe: bool,
    shell: ShellKind,
    style: PathStyle,
) -> bool {
    readonly_dialect_for(shell, style)
        .is_some_and(|dialect| is_read_only_analysis_in(analysis, git_unsafe, dialect))
}

/// [`is_read_only_analysis_for_shell_on`] 按本机构建平台的路径风格。
pub fn is_read_only_analysis_for_shell(
    analysis: &Analysis,
    git_unsafe: bool,
    shell: ShellKind,
) -> bool {
    is_read_only_analysis_for_shell_on(analysis, git_unsafe, shell, platform_style())
}

/// [`is_read_only_analysis_for_shell_on`] 的字符串版本。
pub fn is_read_only_for_shell_on(
    command: &str,
    git_unsafe: bool,
    shell: ShellKind,
    style: PathStyle,
) -> bool {
    is_read_only_analysis_for_shell_on(&analyze(command), git_unsafe, shell, style)
}

/// [`is_read_only_analysis_for_shell`] 的字符串版本。
pub fn is_read_only_for_shell(command: &str, git_unsafe: bool, shell: ShellKind) -> bool {
    is_read_only_analysis_for_shell(&analyze(command), git_unsafe, shell)
}

/// Node `isRuntimeReadOnlyBashCommand`：每个子命令都只读，且没有改目录的 git、没有动态内容。
/// `git_unsafe` 为 true 时（工作目录里的 git 配置不可信）含 git 的命令一律不算只读。按本机构建平台的路径风格。
pub fn is_read_only_analysis(analysis: &Analysis, git_unsafe: bool) -> bool {
    is_read_only_analysis_in(analysis, git_unsafe, Dialect::of(platform_style()))
}

/// 同 [`is_read_only_analysis`]，显式给出 Bash 方言（Posix / GitBash）。
pub fn is_read_only_analysis_in(
    analysis: &Analysis,
    git_unsafe: bool,
    dialect: Dialect,
) -> bool {
    is_read_only_analysis_on(analysis, git_unsafe, dialect.path_style())
}

/// 按给定路径风格判定，**不含 shell 前提**：调用方必须先经 [`readonly_dialect_for`] 确认是 Bash 方言
/// （[`is_read_only_analysis_for_shell_on`] 就是这么做的）。直接用它会把非 Bash shell 的文本按 Bash 表判定。
/// 路径风格按命令所在机器（R3，remote-exec.md §20.8）。
pub fn is_read_only_analysis_on(analysis: &Analysis, git_unsafe: bool, style: PathStyle) -> bool {
    if !is_permission_safe(analysis) || analysis.commands.is_empty() {
        return false;
    }
    if git::git_with_directory_change(&analysis.commands) {
        return false;
    }
    if git_unsafe && invokes_git(&analysis.commands) {
        return false;
    }
    analysis.commands.iter().all(|part| {
        !argv::has_known_write_option(part) && argv::evaluate(part, style) == Some(true)
    })
}

/// [`is_read_only_analysis`] 的字符串版本。
pub fn is_read_only(command: &str, git_unsafe: bool) -> bool {
    is_read_only_analysis(&analyze(command), git_unsafe)
}

/// [`is_read_only_analysis_in`] 的字符串版本。
pub fn is_read_only_in(command: &str, git_unsafe: bool, dialect: Dialect) -> bool {
    is_read_only_analysis_in(&analyze(command), git_unsafe, dialect)
}

/// [`is_read_only_analysis_on`] 的字符串版本。
pub fn is_read_only_on(command: &str, git_unsafe: bool, style: PathStyle) -> bool {
    is_read_only_analysis_on(&analyze(command), git_unsafe, style)
}

#[cfg(test)]
#[path = "readonly_tests.rs"]
mod tests;

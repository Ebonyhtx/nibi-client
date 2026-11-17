//! 只读判定的代表样例（完整的对照表在 apps/nibi-cli-rust 的 Node 夹具里，未复制）。

use super::*;
use crate::guarded::Dialect;
use nibi_kernel_api::env_shell::ShellKind;

#[test]
fn tables_are_loaded() {
    assert!(tables::tables().commands.len() >= 60);
}

/// 只读证明的有效前提是 Bash 方言：Posix / GitBash 按各自路径风格判定，非 Bash shell 一律不是只读。
/// 新增 ShellKind 变体时 `readonly_dialect` 的 match 会编译失败，提醒重新评估这张表。
#[test]
fn the_read_only_proof_requires_a_bash_dialect() {
    // `xargs` 只在 POSIX 的只读表里；Git Bash 下不认（与 lib_tests_machine 的对照一致）。
    assert!(is_read_only_in("xargs echo", false, Dialect::Posix));
    assert!(!is_read_only_in("xargs echo", false, Dialect::GitBash));
    assert!(is_read_only_for_shell_on(
        "xargs echo",
        false,
        ShellKind::Bash,
        PathStyle::Posix
    ));
    assert!(!is_read_only_for_shell_on(
        "xargs echo",
        false,
        ShellKind::Bash,
        PathStyle::Windows
    ));
    assert!(!is_read_only_for_shell_on(
        "echo hi",
        false,
        ShellKind::PowerShell,
        PathStyle::Posix
    ));
    assert_eq!(BASH_TOOL_SHELL, ShellKind::Bash);
    assert_eq!(
        readonly_dialect_for(ShellKind::Bash, PathStyle::Windows),
        Some(Dialect::GitBash)
    );
    assert_eq!(
        readonly_dialect_for(ShellKind::PowerShell, PathStyle::Posix),
        None
    );
    assert_eq!(Dialect::Posix.path_style(), PathStyle::Posix);
    assert_eq!(Dialect::GitBash.path_style(), PathStyle::Windows);
    assert!(readonly_dialect(ShellKind::Bash).is_some());
    assert_eq!(readonly_dialect(ShellKind::PowerShell), None);
    // 非 Bash 方言没有只读表：连 `echo` / `git status` 这种在 Bash 下只读的命令也不算只读。
    for command in ["echo hello", "ls -la", "git status"] {
        assert!(
            !is_read_only_for_shell(command, false, ShellKind::PowerShell),
            "{command}"
        );
    }
    // 同一段文本在 Bash 方言下仍按本机平台风格判定。
    assert!(is_read_only_for_shell("git status", false, ShellKind::Bash));
    assert_eq!(
        is_read_only_for_shell("xargs echo", false, ShellKind::Bash),
        is_read_only("xargs echo", false)
    );
}

#[test]
fn read_only_and_not() {
    for command in [
        "echo hello",
        "ls -la",
        "cat a.txt | head -1",
        "git status",
        "git log --oneline -5",
        "pwd",
        "wc -l a.txt",
        "grep -rn foo .",
    ] {
        assert!(is_read_only(command, false), "{command}");
    }
    for command in [
        "touch x",
        "rm -rf x",
        "echo hi > out.txt",
        "git push",
        "npm install",
        "sed -i s/a/b/ f",
        "find . -delete",
        "echo $(rm x)",
    ] {
        assert!(!is_read_only(command, false), "{command}");
    }
    assert!(!is_read_only("git status", true), "untrusted git config");
}

/// 工作线 F53 阶段 0（shell-permissions.md §4.5.1 第 1 条）：find 换成 bfs 之后，bfs 的 `-rm` 等同 `-delete`；
/// find 的只读判定按写操作表、bfs 标志组与带值谓词。
#[test]
fn bfs_actions_and_flag_groups_follow_the_find_rules() {
    for command in [
        "find . -rm",
        "find . -name '*.log' -rm",
        "find . -type f -o -rm",
        // `-f` 的值仍查写操作表。
        "find -f -rm",
        // `/^-[dsx]+f$/`：BSD find 的 getopt 写法（`-s -f PATH`），不算只读。
        "find -sf /tmp",
        "find -xf . -name x",
        "find . -fprint out.txt",
        "find . -files0-from list",
        // 同 `-delete`：任何位置出现 `-rm` 都按写操作（Node `hasKnownBashWriteOption`，保守）。
        "find . -name -rm",
    ] {
        assert!(!is_read_only(command, false), "{command}");
    }
    for command in [
        "find . -name '*.rs'",
        "find -f . -name x",
        "find -Hf . -type f",
        "find -L . -maxdepth 2",
        // 带值谓词的值跳过。
        "find . -newermt 2026-01-01",
        "find . -path '*/-delete'",
    ] {
        assert!(is_read_only(command, false), "{command}");
    }
}

//! argv0 分派的名字规则（embedded-search.md §3）。

use std::ffi::OsStr;

use super::*;

fn os(text: &str) -> Option<&OsStr> {
    Some(OsStr::new(text))
}

#[test]
fn the_file_name_of_argv0_comes_first() {
    assert_eq!(choose(os("rg"), None), Some(Tool::Rg));
    assert_eq!(choose(os("/usr/local/bin/rg"), None), Some(Tool::Rg));
    assert_eq!(choose(os("./rg"), os("nibi")), Some(Tool::Rg));
    // 名字要完全相同。
    for name in ["rgx", "xrg", "nibi", "/opt/rg/nibi", "RG-1"] {
        assert_eq!(choose(os(name), None), None, "{name}");
    }
}

/// 可执行文件名 `nibi-rs` 与命令名 `nibi` 都不是工具名，走正常入口（cli-args.md §13，工作线 F59）。
#[test]
fn the_executable_and_command_names_are_not_tools() {
    for name in [
        "nibi-rs",
        "nibi",
        "/opt/nibi/bin/nibi-rs",
        "node_modules/@scope/nibi-darwin-arm64/bin/nibi-rs",
        "nibi-rs.exe",
        "nibi.exe",
        "node_modules/@scope/nibi-win32-x64/bin/nibi.exe",
    ] {
        assert_eq!(choose(os(name), None), None, "{name}");
    }
    // prelude 在 msys 的 bash 下只设 `ARGV0`，argv[0] 是可执行文件的路径。
    assert_eq!(
        choose(os("/c/Users/dev/nibi-rs"), os("ugrep")),
        Some(Tool::Ugrep)
    );
    assert_eq!(choose(os("nibi-rs"), os("nibi-rs")), None);
}

#[test]
fn ugrep_is_on_every_platform() {
    assert_eq!(choose(os("ugrep"), None), Some(Tool::Ugrep));
    assert_eq!(choose(os("nibi"), os("ugrep")), Some(Tool::Ugrep));
    // grep 本身不分派：prelude 的 grep 函数用 argv0 `ugrep`。
    assert_eq!(choose(os("grep"), None), None);
}

#[test]
fn the_argv0_variable_is_the_fallback() {
    // msys 的 bash：`ARGV0=rg "$_nibi_bin"` 只把变量放进环境，argv[0] 是二进制的路径。
    assert_eq!(choose(os("/c/Users/dev/nibi"), os("rg")), Some(Tool::Rg));
    assert_eq!(choose(None, os("rg")), Some(Tool::Rg));
    assert_eq!(choose(os("nibi"), os("bash")), None);
    assert_eq!(choose(os("nibi"), os("")), None);
    assert_eq!(choose(None, None), None);
}

#[cfg(unix)]
#[test]
fn bfs_is_a_unix_tool() {
    assert_eq!(choose(os("bfs"), None), Some(Tool::Bfs));
    assert_eq!(choose(os("nibi"), os("bfs")), Some(Tool::Bfs));
    assert_eq!(choose(os("bfsx"), None), None);
}

/// Windows 没有 bfs（embedded-search.md §6.4）：这个名字按 nibi 处理。平台包里的 `nibi.exe`（工作线 F71）与 cargo 产物
/// `nibi-rs.exe` 相同。
#[cfg(windows)]
#[test]
fn windows_has_no_bfs() {
    assert_eq!(choose(os("bfs.exe"), None), None);
    assert_eq!(choose(os("nibi-rs.exe"), os("bfs")), None);
    assert_eq!(choose(os("nibi.exe"), os("bfs")), None);
}

#[cfg(windows)]
#[test]
fn windows_names_drop_exe_and_case() {
    assert_eq!(choose(os(r"C:\tools\RG.EXE"), None), Some(Tool::Rg));
    assert_eq!(
        choose(os(r"C:\tools\nibi-rs.exe"), os("rg.exe")),
        Some(Tool::Rg)
    );
    assert_eq!(choose(os(r"C:\tools\NIBI-RS.EXE"), None), None);
    // Windows 平台包里的名字（工作线 F71）：同样走正常入口，`ARGV0` 照样分派。
    let installed =
        r"C:\Users\dev\AppData\Roaming\npm\node_modules\@scope\nibi-win32-x64\bin\nibi.exe";
    assert_eq!(choose(os(installed), None), None);
    assert_eq!(choose(os(r"C:\tools\NIBI.EXE"), None), None);
    assert_eq!(choose(os(installed), os("ugrep")), Some(Tool::Ugrep));
}

/// 工作线 F57：Windows 的 `canonicalize` 给出 `\\?\C:\…`，进 prelude 时成了 `//?/C:/…`，Git Bash 不认，内嵌工具退回
/// 系统命令。这里去掉这个前缀。
#[test]
fn the_verbatim_prefix_is_dropped() {
    for (path, expected) in [
        (r"\\?\C:\Users\dev\nibi.exe", r"C:\Users\dev\nibi.exe"),
        (
            r"\\?\UNC\server\share\nibi.exe",
            r"\\server\share\nibi.exe",
        ),
        (r"\\?\C:\", r"C:\"),
        // 不是盘符的 `\\?\` 形式（卷 GUID）与太短的原样（要求长度至少 7、第 6 个字符是 `:`）。
        (r"\\?\Volume{0b1c}\nibi.exe", r"\\?\Volume{0b1c}\nibi.exe"),
        (r"\\?\C:", r"\\?\C:"),
        (r"C:\Users\dev\nibi.exe", r"C:\Users\dev\nibi.exe"),
        ("/usr/local/bin/nibi", "/usr/local/bin/nibi"),
    ] {
        assert_eq!(
            without_verbatim_prefix(PathBuf::from(path)),
            PathBuf::from(expected),
            "{path}"
        );
    }
}

/// 只在 Windows 上跑（CI）：入口取到的二进制路径没有 `\\?\` 前缀，进 prelude 时是 Git Bash 认得的 `/c/…`。
#[cfg(windows)]
#[test]
fn the_executable_has_no_verbatim_prefix_on_windows() {
    let path = executable().expect("current_exe");
    let text = path.to_string_lossy();
    assert!(!text.starts_with(r"\\?\"), "{text}");
    assert!(path.is_absolute(), "{text}");
}

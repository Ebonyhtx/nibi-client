//! 环境事实（`EnvInfo::facts`，docs/specs/rust-cli/context.md §12）：平台、系统版本、shell 与
//! git 仓库判断。写法见 context.md §12 的环境段。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use nibi_kernel_api::env_git::marks_git_root;

/// Node `process.platform` 的写法（定义在 base，F55）。
pub(crate) use nibi_kernel_base::js::node_platform as platform;

/// shell 名：`$SHELL` 含 zsh 为 `zsh`，含 bash 为 `bash`，否则原样，没有为 `unknown`；
/// Windows 上没有 Git Bash（Bash 工具不可用）时为 `PowerShell`。
pub(crate) fn describe_shell(shell: Option<&str>, bash: bool) -> String {
    let shell = shell.filter(|value| !value.is_empty()).unwrap_or("unknown");
    if cfg!(windows) && !bash {
        return "PowerShell".to_owned();
    }
    if shell.contains("zsh") {
        "zsh".to_owned()
    } else if shell.contains("bash") {
        "bash".to_owned()
    } else {
        shell.to_owned()
    }
}

/// `path`（某一层的 `.git`）是不是 git 根的标记：本机 `metadata`，种类按 kernel-api 的 `marks_git_root`（与经端口的
/// 判定同一条规则，F58）。
#[expect(
    clippy::disallowed_methods,
    reason = "env-local 是工作区文件 IO 的入口（docs/specs/rust-cli/README.md §4）"
)]
fn git_marker(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| marks_git_root(crate::meta::kind(&metadata)))
}

/// 最近的含 `.git`（目录或文件）的祖先目录。阻塞调用。
pub(crate) fn git_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| git_marker(&dir.join(".git")))
        .map(Path::to_path_buf)
}

/// Node 的 `${process.platform} ${os.release()} ${os.arch()}`（`adapters/src/context/index.ts`）。
///
/// Unix 上的 `os.release()` 就是 `uname -r`（`uname -sr` 一起拿到 `type` 与 `release`）。
/// Windows 的 `os.release()` 是 `RtlGetVersion` 的 `major.minor.build`（`10.0.19045`）；
/// 以前这里返回空串，环境段因此少一行（Node 一直有）。
pub(crate) async fn os_version(env: &[(String, String)]) -> String {
    let release = if cfg!(windows) {
        windows_release().unwrap_or_default()
    } else {
        let mut command = nibi_kernel_proc::command("uname");
        command
            .arg("-sr")
            .env_clear()
            .envs(env.iter().filter(|(name, _)| name == "PATH").cloned())
            .stdin(Stdio::null())
            .kill_on_drop(true);
        match command.output().await {
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                // `uname -sr` 是 `Darwin 24.6.0`；Node 的 `os.release()` 只要后半段。
                text.split_once(' ').map_or(text.clone(), |(_, rest)| rest.to_owned())
            }
            Ok(_) | Err(_) => String::new(),
        }
    };
    if release.is_empty() {
        return String::new();
    }
    format!("{} {release} {}", platform(), nibi_kernel_base::js::node_arch())
}

/// Windows 的系统版本号（`major.minor.build`），取不到时 None。
#[cfg(windows)]
#[expect(
    unsafe_code,
    reason = "RtlGetVersion 是 ntdll 的版本查询，没有安全封装；结构由调用方清零后传入"
)]
fn windows_release() -> Option<String> {
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;

    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: u32::try_from(std::mem::size_of::<OSVERSIONINFOW>()).ok()?,
        ..Default::default()
    };
    // STATUS_SUCCESS 是 0；失败时保持空串。
    if unsafe { RtlGetVersion(&mut info) } != 0 {
        return None;
    }
    Some(format!(
        "{}.{}.{}",
        info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
    ))
}

#[cfg(not(windows))]
fn windows_release() -> Option<String> {
    None
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;

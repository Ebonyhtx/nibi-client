//! Windows 上 MCP stdio 启动前的程序解析（docs/design/v2/mcp-node-fallback.md）。
//!
//! Host 在 Windows 上把 `<appConfigDir>/node-fallback/v1` 追加到 agent PATH 末尾，并在环境里放
//! `NIBI_NODE_FALLBACK_EXEC_PATH` / `NIBI_NODE_FALLBACK_NPM_ROOT`。Node 内核走 cross-spawn，`.cmd` 由
//! `cmd.exe` 执行；这里给 Rust 内核补同样的语义：`CreateProcess` 只认 `.exe`，所以要么先按
//! PATH + PATHEXT 找到真正要执行的程序，要么直接换成 Electron 可执行文件加随包 npm 的 JS 入口。
//!
//! 顺序与 shim 一致——**用户自己的 node/npm/npx 永远优先**：
//!
//! 1. `command` 带路径分隔符或扩展名：按原样使用（扩展名是 `.cmd`/`.bat` 时仍经 `cmd.exe`）。
//! 2. 否则按子进程的实际 PATH（Windows 环境名不区分大小写）与 PATHEXT 查找。
//! 3. 找不到、且命令名是 `node`/`npm`/`npx`、且环境里有 `NIBI_NODE_FALLBACK_EXEC_PATH`：
//!    `node` 直接交给 Electron；`npm`/`npx` 交给 `<NPM_ROOT>\bin\{npm,npx}-cli.js`。这条路径给子进程
//!    加 `ELECTRON_RUN_AS_NODE=1`（Electron 必须以 Node 模式运行脚本）。
//! 4. 最终程序是 `.cmd`/`.bat`：命令文本按 cross-spawn 的规则转义后交给 `cmd.exe /d /s /c`。
//!
//! 非 Windows 不做任何改写：`stdio::start` 只在 `cfg(windows)` 下调用这里。

use std::collections::BTreeMap;
use std::path::Path;

/// Host 下发的 Electron 可执行文件（agent 的 `process.execPath`）。
pub(crate) const EXEC_PATH_ENV: &str = "NIBI_NODE_FALLBACK_EXEC_PATH";
/// Host 下发的随包 npm 根目录（没有随包 npm 时不设）。
pub(crate) const NPM_ROOT_ENV: &str = "NIBI_NODE_FALLBACK_NPM_ROOT";
/// 让 Electron 以 Node 模式运行脚本；只在回退路径设置，子进程树继续继承。
pub(crate) const ELECTRON_RUN_AS_NODE_ENV: &str = "ELECTRON_RUN_AS_NODE";
/// 随包 npm 不是用户的全局 npm，不能提示升级（与 shim 一致）。
pub(crate) const NPM_UPDATE_NOTIFIER_ENV: &str = "npm_config_update_notifier";

const PATH_ENV: &str = "PATH";
const PATHEXT_ENV: &str = "PATHEXT";
const COMSPEC_ENV: &str = "ComSpec";
const CMD_EXE: &str = "cmd.exe";
/// Windows 的 PATH/PATHEXT 分隔符。本模块只描述 Windows 语义，测试在任意平台用同一份规则。
const LIST_SEPARATOR: char = ';';
/// `PATHEXT` 没设时的缺省值（Windows 自己的缺省）。
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";
const NPM_CLI_ENTRY: &str = "npm-cli.js";
const NPX_CLI_ENTRY: &str = "npx-cli.js";

/// 解析结果：真正要创建的进程与它的参数。
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Resolved {
    /// 真正创建的程序。通常就是解析到的命令；批处理是 `cmd.exe`。
    pub program: String,
    /// 交给 `Command::args` 的参数。批处理时为空，全部在 [`Self::raw_arguments`] 里。
    pub args: Vec<String>,
    /// 批处理：`cmd.exe /d /s /c "..."` 的完整参数。必须经 `raw_arg` 原样传入，不能再让 CRT 加引号。
    pub raw_arguments: Option<String>,
    /// 只在这一条回退路径加进子进程环境的变量（空表示不改环境）。
    pub env: Vec<(String, String)>,
}

/// 命令名属于 node 回退的哪一类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fallback {
    Node,
    Npm,
    Npx,
}

/// 按 Windows 语义解析 `command`：`PATH` 与 `PATHEXT` 都从子进程环境读，不再看进程环境（`.env_clear()` 之后
/// 子进程只见到这张表）。
///
/// 返回的错误是给人看的诊断（调用方补上 `MCP server "…" failed to start: ` 前缀），列出查过的 PATH、
/// PATHEXT 与回退状态。
#[cfg(windows)]
pub(crate) fn resolve(
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> Result<Resolved, String> {
    resolve_with(command, args, env, exists)
}

/// PATH 查找只看文件是否存在（目录不算命中）。
#[cfg(windows)]
#[expect(
    clippy::disallowed_methods,
    reason = "env-local 是进程的入口：在启动 MCP 子进程前按 PATH/PATHEXT 找到可执行文件（README §4）"
)]
fn exists(path: &Path) -> bool {
    path.is_file()
}

/// 可注入文件存在判断的版本：单测用虚拟文件系统，避免依赖真实 PATH。
fn resolve_with(
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    exists: impl Fn(&Path) -> bool,
) -> Result<Resolved, String> {
    let path = env_value(env, PATH_ENV).unwrap_or_default();
    let configured_pathext = env_value(env, PATHEXT_ENV).filter(|value| !value.trim().is_empty());
    let extensions = extensions(configured_pathext.unwrap_or(DEFAULT_PATHEXT));

    // 1. 显式路径或带扩展名：用户写明了要跑什么，按原样使用（批处理仍按第 4 步经 cmd.exe）。
    if has_separator(command) || Path::new(command).extension().is_some() {
        return Ok(plan(command, args, Vec::new(), env));
    }

    // 2. PATH 顺序 + PATHEXT：用户自己装的 node/npm/npx 优先（包括 PATH 末尾的 shim 目录里的 `.cmd`）。
    if let Some(found) = lookup(command, path, &extensions, &exists) {
        return Ok(plan(&found, args, Vec::new(), env));
    }

    // 3. 回退到 Electron Node + 随包 npm。只认 node/npm/npx。
    let Some(fallback) = fallback_kind(command) else {
        return Err(failure(
            command,
            path,
            configured_pathext,
            "node fallback does not apply to this command",
        ));
    };
    let Some(exec_path) = env_value(env, EXEC_PATH_ENV).filter(|value| !value.is_empty()) else {
        return Err(failure(
            command,
            path,
            configured_pathext,
            "node fallback unavailable: NIBI_NODE_FALLBACK_EXEC_PATH is not set",
        ));
    };
    let mut env_additions = vec![(ELECTRON_RUN_AS_NODE_ENV.to_owned(), "1".to_owned())];
    let resolved = match fallback {
        Fallback::Node => plan(exec_path, args, env_additions, env),
        Fallback::Npm | Fallback::Npx => {
            let Some(npm_root) = env_value(env, NPM_ROOT_ENV).filter(|value| !value.is_empty())
            else {
                return Err(failure(
                    command,
                    path,
                    configured_pathext,
                    "node fallback unavailable: NIBI_NODE_FALLBACK_EXEC_PATH is set but \
                     NIBI_NODE_FALLBACK_NPM_ROOT is not set",
                ));
            };
            let entry = if fallback == Fallback::Npm {
                NPM_CLI_ENTRY
            } else {
                NPX_CLI_ENTRY
            };
            let script = Path::new(npm_root)
                .join("bin")
                .join(entry)
                .to_string_lossy()
                .into_owned();
            let mut forwarded = Vec::with_capacity(args.len() + 1);
            forwarded.push(script);
            forwarded.extend(args.iter().cloned());
            // Node 内核的 npm/npx shim 在用户没设时关掉升级提示；直接回退时同样保持安静。
            if env_value(env, NPM_UPDATE_NOTIFIER_ENV).is_none() {
                env_additions.push((NPM_UPDATE_NOTIFIER_ENV.to_owned(), "false".to_owned()));
            }
            plan(exec_path, &forwarded, env_additions, env)
        }
    };
    Ok(resolved)
}

/// 把最终程序变成 [`Resolved`]：`.cmd`/`.bat` 经 `cmd.exe /d /s /c` 启动，其余直接创建。
fn plan(
    program: &str,
    args: &[String],
    env: Vec<(String, String)>,
    child_env: &BTreeMap<String, String>,
) -> Resolved {
    if is_batch(program) {
        let text = batch_command_line(program, args);
        let shell = env_value(child_env, COMSPEC_ENV)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(CMD_EXE);
        Resolved {
            program: shell.to_owned(),
            args: Vec::new(),
            raw_arguments: Some(nibi_kernel_proc::shell::cmd_exe_arguments(&text)),
            env,
        }
    } else {
        Resolved {
            program: program.to_owned(),
            args: args.to_vec(),
            raw_arguments: None,
            env,
        }
    }
}

/// 命令里有路径分隔符（`/` 或 `\`）：不再查 PATH。
fn has_separator(command: &str) -> bool {
    command.contains('/') || command.contains('\\')
}

fn is_batch(program: &str) -> bool {
    Path::new(program).extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    })
}

/// `PATHEXT` 的值拆成扩展名列表；缺前导点的项补一个点（真实值都带点，这里只是容错）。
fn extensions(pathext: &str) -> Vec<String> {
    pathext
        .split(LIST_SEPARATOR)
        .filter_map(|entry| {
            let entry = entry.trim();
            if entry.is_empty() {
                return None;
            }
            Some(if entry.starts_with('.') {
                entry.to_owned()
            } else {
                format!(".{entry}")
            })
        })
        .collect()
}

/// 按 PATH 顺序、每个目录按 PATHEXT 顺序找第一个存在的文件。
///
/// 边界：相对 PATH 项按 agent 进程的当前目录判断是否存在（真实 PATH 都是绝对路径；子进程的 cwd 由 MCP 配置
/// 指定，与这里不同，不据此改变查找顺序）。
fn lookup(
    command: &str,
    path: &str,
    extensions: &[String],
    exists: &impl Fn(&Path) -> bool,
) -> Option<String> {
    for entry in path.split(LIST_SEPARATOR) {
        // PATH 项偶尔带一对引号（`"C:\Program Files\nodejs"` 这种写法）；去掉后再拼。
        let entry = entry.trim();
        let entry = entry
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or(entry);
        if entry.is_empty() {
            // Windows 把空项当成当前目录（工作区）。这里跳过：不应因为打开某个工作区就执行它里面的
            // node.exe/npm.cmd，用户 PATH 里的项照常按顺序查找。
            continue;
        }
        let directory = Path::new(entry);
        for extension in extensions {
            let candidate = directory.join(format!("{command}{extension}"));
            if exists(&candidate) {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// `command` 的 basename 是否 node/npm/npx（大小写不敏感，可带 `.cmd`/`.exe`）。走到这里时 `command`
/// 已经没有路径分隔符（第 1 步拦下了），所以直接比较整个名字。
fn fallback_kind(command: &str) -> Option<Fallback> {
    let name = command.to_ascii_lowercase();
    let name = name
        .strip_suffix(".cmd")
        .or_else(|| name.strip_suffix(".exe"))
        .unwrap_or(&name);
    match name {
        "node" => Some(Fallback::Node),
        "npm" => Some(Fallback::Npm),
        "npx" => Some(Fallback::Npx),
        _ => None,
    }
}

/// 读一个环境变量（Windows 名字不区分大小写）。`Command::envs` 在 Windows 上把大小写变体当成同一个
/// 变量、后遍历到的覆盖先遍历到的（BTreeMap 里 `Path` 排在 `PATH` 之后），所以取最后一个匹配——
/// 解析用的值就是子进程实际看到的值。
fn env_value<'a>(env: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    env.iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
        .next_back()
}

/// 查不到时的诊断：命令、PATH、PATHEXT、回退状态。保持 `spawn_error` 的“failed to start”口径由调用方加。
///
/// 这里不用 `{:?}` 打 PATH：Debug 会把 Windows 的反斜杠再转义一遍（`C:\\tools`），诊断信息反而难以阅读。
fn failure(command: &str, path: &str, pathext: Option<&str>, detail: &str) -> String {
    let path = if path.is_empty() { "<empty>" } else { path };
    let pathext = match pathext {
        Some(pathext) => format!("[{pathext}]"),
        None => format!("[{DEFAULT_PATHEXT}] (default)"),
    };
    format!(
        "could not resolve \"{command}\": not found on PATH [{path}] with PATHEXT {pathext}; {detail}"
    )
}

/// 批处理的一条完整命令行（不含 `/d /s /c` 包装）：命令按 cmd 元字符转义，参数按 CRT 规则加引号后
/// 再转义。与 cross-spawn `lib/parse.js` 的 `parseNonShell` 一致。
fn batch_command_line(program: &str, args: &[String]) -> String {
    let double_escape_meta_chars = is_cmd_shim(program);
    let mut text = escape_meta(program);
    for argument in args {
        text.push(' ');
        text.push_str(&escape_argument(argument, double_escape_meta_chars));
    }
    text
}

/// cross-spawn 只对 `node_modules/.bin/` 下的 `.cmd` shim 做二次元字符转义：shim 会把参数再交给
/// `cmd.exe`，第一次的 `^` 已经被吃掉。用户的 npm/npx 通常不在这里，我们的 shim 也不在。
fn is_cmd_shim(program: &str) -> bool {
    let normalized = program.replace('/', "\\").to_ascii_lowercase();
    normalized.contains("\\node_modules\\.bin\\") && normalized.ends_with(".cmd")
}

/// cmd.exe 的元字符（cross-spawn `escape.js` 的字符类，空格也在内）。
const META_CHARS: &[char] = &[
    '(', ')', '[', ']', '%', '!', '^', '"', '`', '<', '>', '&', '|', ';', ',', ' ', '*', '?',
];

/// 每个元字符前加 `^`。
fn escape_meta(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if META_CHARS.contains(&character) {
            escaped.push('^');
        }
        escaped.push(character);
    }
    escaped
}

/// 一个参数：先按 CRT（`CommandLineToArgvW`）规则处理反斜杠与引号并整段加引号，再按 cmd.exe 规则转义
/// 元字符——与 cross-spawn 相同。
///
/// 边界（只覆盖常见参数形态）：`%NAME%` 仍可能被 cmd.exe 展开、换行与 NUL 不支持（cross-spawn 也一样）。
/// 参数里出现这些形态的服务器应当用自己的脚本入口，而不是把整段命令塞进一个参数。
fn escape_argument(argument: &str, double_escape_meta_chars: bool) -> String {
    let mut quoted = String::with_capacity(argument.len() + 2);
    quoted.push('"');
    let mut backslashes: usize = 0;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                // 2n+1 个反斜杠 + 引号 → n 个字面反斜杠 + 一个字面引号.
                for _ in 0..(backslashes * 2 + 1) {
                    quoted.push('\\');
                }
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                for _ in 0..backslashes {
                    quoted.push('\\');
                }
                backslashes = 0;
                quoted.push(character);
            }
        }
    }
    // 末尾反斜杠加倍，避免和收尾引号组成转义.
    for _ in 0..(backslashes * 2) {
        quoted.push('\\');
    }
    quoted.push('"');
    let escaped = escape_meta(&quoted);
    if double_escape_meta_chars {
        escape_meta(&escaped)
    } else {
        escaped
    }
}

#[cfg(test)]
#[path = "node_fallback_tests.rs"]
mod tests;

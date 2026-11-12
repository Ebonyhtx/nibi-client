//! Windows 上 MCP stdio 的程序解析：PATH/PATHEXT 命中、Electron 回退、`.cmd` 经 cmd.exe（设计见
//! docs/design/v2/mcp-node-fallback.md）。

use std::collections::BTreeMap;
use std::path::Path;

use super::*;

fn environment(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

/// 与解析逻辑相同的拼接方式，测试在任意平台上都能用同一份 Windows 形态的路径。
fn join(directory: &str, name: &str) -> String {
    Path::new(directory)
        .join(name)
        .to_string_lossy()
        .into_owned()
}

/// 虚拟文件系统：Windows 上路径不区分大小写，这里用同样口径比较。
fn existing(paths: &[&str]) -> impl Fn(&Path) -> bool {
    let paths: Vec<String> = paths.iter().map(|path| path.to_ascii_lowercase()).collect();
    move |candidate: &Path| {
        let candidate = candidate.to_string_lossy().to_ascii_lowercase();
        paths.iter().any(|path| path == &candidate)
    }
}

fn resolve(
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    paths: &[&str],
) -> Result<Resolved, String> {
    resolve_with(command, args, env, existing(paths))
}

fn additions(resolved: &Resolved) -> BTreeMap<String, String> {
    resolved.env.iter().cloned().collect()
}

/// PATH 上用户自己的 node 优先，原样使用，不加回退环境变量。
#[test]
fn a_user_node_on_path_is_used_as_found() {
    let user_node = join(r"C:\Program Files\nodejs", "node.exe");
    let env = environment(&[
        (PATH_ENV, r"C:\Windows\System32;C:\Program Files\nodejs"),
        (EXEC_PATH_ENV, r"C:\Program Files\NIBI\nibi.exe"),
    ]);
    let resolved = resolve("node", &args(&["server.js"]), &env, &[&user_node]).unwrap();
    assert_eq!(
        resolved.program,
        join(r"C:\Program Files\nodejs", "node.EXE")
    );
    assert_eq!(resolved.args, args(&["server.js"]));
    assert_eq!(resolved.raw_arguments, None);
    assert!(resolved.env.is_empty(), "{:?}", resolved.env);
}

/// PATH 顺序优先于回退：即使环境里同时有 fallback 变量，前面的用户 node 仍然赢。
#[test]
fn path_order_beats_the_fallback() {
    let shim = join(
        r"C:\Users\me\AppData\Roaming\NIBI\node-fallback\v1",
        "node.cmd",
    );
    let user_node = join(r"C:\Program Files\nodejs", "node.exe");
    let env = environment(&[
        (
            PATH_ENV,
            r"C:\Program Files\nodejs;C:\Users\me\AppData\Roaming\NIBI\node-fallback\v1",
        ),
        (EXEC_PATH_ENV, r"C:\Program Files\NIBI\nibi.exe"),
    ]);
    let resolved = resolve("node", &[], &env, &[&user_node, &shim]).unwrap();
    assert_eq!(
        resolved.program,
        join(r"C:\Program Files\nodejs", "node.EXE")
    );
    assert_eq!(resolved.raw_arguments, None);
    assert!(resolved.env.is_empty(), "{:?}", resolved.env);
}

/// PATH 末尾的 shim（`.cmd`）命中时经 cmd.exe 启动，参数按 cross-spawn 规则转义。
#[test]
fn a_cmd_shim_on_path_runs_through_cmd_exe() {
    let shim = join(
        r"C:\Users\me\AppData\Roaming\NIBI\node-fallback\v1",
        "npx.cmd",
    );
    let found = join(
        r"C:\Users\me\AppData\Roaming\NIBI\node-fallback\v1",
        "npx.CMD",
    );
    let env = environment(&[
        (
            PATH_ENV,
            r"C:\Windows\System32;C:\Users\me\AppData\Roaming\NIBI\node-fallback\v1",
        ),
        (EXEC_PATH_ENV, r"C:\Program Files\NIBI\nibi.exe"),
    ]);
    let resolved = resolve("npx", &args(&["-y", "some package"]), &env, &[&shim]).unwrap();
    assert_eq!(resolved.program, CMD_EXE);
    assert!(resolved.args.is_empty(), "{:?}", resolved.args);
    let expected = format!("/d /s /c \"{found} ^\"-y^\" ^\"some^ package^\"\"");
    assert_eq!(resolved.raw_arguments.as_deref(), Some(expected.as_str()));
    // shim 自己设置 ELECTRON_RUN_AS_NODE：解析层不重复加。
    assert!(resolved.env.is_empty(), "{:?}", resolved.env);
}

/// 用户的 npm.cmd（自己装的 Node）也经 cmd.exe，不被回退抢走。
#[test]
fn a_user_npm_cmd_is_used_as_found() {
    let npm = join(r"C:\Program Files\nodejs", "npm.cmd");
    let found = join(r"C:\Program Files\nodejs", "npm.CMD");
    let env = environment(&[
        (PATH_ENV, r"C:\Program Files\nodejs"),
        (EXEC_PATH_ENV, r"C:\Program Files\NIBI\nibi.exe"),
        (
            NPM_ROOT_ENV,
            r"C:\Program Files\NIBI\resources\glm\node-runtime\npm",
        ),
    ]);
    let resolved = resolve("npm", &args(&["--version"]), &env, &[&npm]).unwrap();
    assert_eq!(resolved.program, CMD_EXE);
    let expected = format!("/d /s /c \"{} ^\"--version^\"\"", escape_meta(&found));
    assert_eq!(resolved.raw_arguments.as_deref(), Some(expected.as_str()));
    assert!(resolved.env.is_empty(), "{:?}", resolved.env);
}

/// 没装 Node：node 直接换成 Host 下发的 Electron 可执行文件。
#[test]
fn a_missing_node_falls_back_to_the_electron_executable() {
    let exec = r"C:\Program Files\NIBI\nibi.exe";
    let env = environment(&[(PATH_ENV, r"C:\Windows\System32"), (EXEC_PATH_ENV, exec)]);
    let resolved = resolve("node", &args(&["server.js", "--port", "0"]), &env, &[]).unwrap();
    assert_eq!(resolved.program, exec);
    assert_eq!(resolved.args, args(&["server.js", "--port", "0"]));
    assert_eq!(resolved.raw_arguments, None);
    assert_eq!(
        additions(&resolved),
        BTreeMap::from([(ELECTRON_RUN_AS_NODE_ENV.to_owned(), "1".to_owned())])
    );
}

/// 没装 Node：npm 换成随包 npm 的 JS 入口，原参数跟在后面。
#[test]
fn a_missing_npm_uses_the_bundled_npm_cli() {
    let exec = r"C:\Program Files\NIBI\nibi.exe";
    let npm_root = r"C:\Program Files\NIBI\resources\glm\node-runtime\npm";
    let env = environment(&[
        (PATH_ENV, r"C:\Windows\System32"),
        (EXEC_PATH_ENV, exec),
        (NPM_ROOT_ENV, npm_root),
    ]);
    let resolved = resolve("npm", &args(&["install", "--no-audit"]), &env, &[]).unwrap();
    assert_eq!(resolved.program, exec);
    assert_eq!(
        resolved.args,
        vec![
            join(npm_root, r"bin\npm-cli.js"),
            "install".to_owned(),
            "--no-audit".to_owned(),
        ]
    );
    let additions = additions(&resolved);
    assert_eq!(
        additions.get(ELECTRON_RUN_AS_NODE_ENV).map(String::as_str),
        Some("1")
    );
    // 随包 npm 不提示用户升级（与 shim 一致）。
    assert_eq!(
        additions.get(NPM_UPDATE_NOTIFIER_ENV).map(String::as_str),
        Some("false")
    );
}

/// npx 用 npx-cli.js；用户显式设置了 update notifier 时保持原值。
#[test]
fn a_missing_npx_uses_the_bundled_npx_cli() {
    let exec = r"C:\Program Files\NIBI\nibi.exe";
    let npm_root = r"C:\Program Files\NIBI\resources\glm\node-runtime\npm";
    let env = environment(&[
        (PATH_ENV, ""),
        (EXEC_PATH_ENV, exec),
        (NPM_ROOT_ENV, npm_root),
        (NPM_UPDATE_NOTIFIER_ENV, "true"),
    ]);
    let resolved = resolve("npx", &args(&["-y", "pkg@1"]), &env, &[]).unwrap();
    assert_eq!(resolved.program, exec);
    assert_eq!(
        resolved.args,
        vec![
            join(npm_root, r"bin\npx-cli.js"),
            "-y".to_owned(),
            "pkg@1".to_owned(),
        ]
    );
    assert_eq!(
        additions(&resolved),
        BTreeMap::from([(ELECTRON_RUN_AS_NODE_ENV.to_owned(), "1".to_owned())])
    );
}

/// 没有 fallback 变量：保持原样的失败口径，并列出 PATH 查过的地方。
#[test]
fn no_fallback_variables_reports_what_was_tried() {
    let path = r"C:\Windows\System32;C:\tools";
    let env = environment(&[(PATH_ENV, path)]);
    let error = resolve("npx", &args(&["-y", "pkg"]), &env, &[]).unwrap_err();
    assert!(error.contains(r#""npx""#), "{error}");
    assert!(error.contains(path), "{error}");
    assert!(error.contains(DEFAULT_PATHEXT), "{error}");
    assert!(
        error.contains("NIBI_NODE_FALLBACK_EXEC_PATH is not set"),
        "{error}"
    );
}

/// 有 EXEC_PATH 但没有随包 npm：npm/npx 给出清晰错误，而不是悄悄把 npm-cli.js 当成参数。
#[test]
fn a_missing_npm_root_is_reported() {
    let env = environment(&[
        (PATH_ENV, r"C:\Windows\System32"),
        (EXEC_PATH_ENV, r"C:\Program Files\NIBI\nibi.exe"),
    ]);
    let error = resolve("npm", &args(&["install"]), &env, &[]).unwrap_err();
    assert!(
        error.contains("NIBI_NODE_FALLBACK_NPM_ROOT is not set"),
        "{error}"
    );
}

/// 不是 node/npm/npx：不猜，直接报错并说明回退不适用。
#[test]
fn other_commands_are_not_resolved() {
    let env = environment(&[
        (PATH_ENV, r"C:\Windows\System32"),
        (EXEC_PATH_ENV, r"C:\Program Files\NIBI\nibi.exe"),
    ]);
    let error = resolve("uvx", &[], &env, &[]).unwrap_err();
    assert!(
        error.contains("node fallback does not apply to this command"),
        "{error}"
    );
}

/// 显式路径（带分隔符）不查 PATH，即使 PATH 上有同名程序、也有 fallback 变量。
#[test]
fn an_explicit_path_is_used_as_written() {
    let env = environment(&[
        (PATH_ENV, r"C:\Program Files\nodejs"),
        (EXEC_PATH_ENV, r"C:\Program Files\NIBI\nibi.exe"),
    ]);
    let resolved = resolve(
        r"D:\tools\node.exe",
        &args(&["server.js"]),
        &env,
        &[&join(r"C:\Program Files\nodejs", "node.exe")],
    )
    .unwrap();
    assert_eq!(resolved.program, r"D:\tools\node.exe");
    assert_eq!(resolved.args, args(&["server.js"]));
    assert!(resolved.env.is_empty(), "{:?}", resolved.env);
}

/// 带扩展名的裸命令同样按原样使用（不查 PATH、不回退）。
#[test]
fn an_explicit_extension_is_not_looked_up() {
    let env = environment(&[
        (PATH_ENV, r"C:\Program Files\nodejs"),
        (EXEC_PATH_ENV, r"C:\Program Files\NIBI\nibi.exe"),
    ]);
    let resolved = resolve(
        "node.exe",
        &[],
        &env,
        &[&join(r"C:\Program Files\nodejs", "node.exe")],
    )
    .unwrap();
    assert_eq!(resolved.program, "node.exe");
    assert_eq!(resolved.raw_arguments, None);
    assert!(resolved.env.is_empty(), "{:?}", resolved.env);
}

/// 显式写了带空格的 .cmd 路径：命令本身按 cmd 元字符转义（空格写成 `^ `）。
#[test]
fn an_explicit_batch_path_is_quoted_for_cmd() {
    let env = environment(&[(PATH_ENV, r"C:\Windows\System32")]);
    let script = r"C:\Program Files\Me\my tool.cmd";
    let resolved = resolve(script, &args(&["a b"]), &env, &[]).unwrap();
    assert_eq!(resolved.program, CMD_EXE);
    assert_eq!(
        resolved.raw_arguments.as_deref(),
        Some("/d /s /c \"C:\\Program^ Files\\Me\\my^ tool.cmd ^\"a^ b^\"\"")
    );
}

/// PATHEXT 的顺序决定先命中哪个（环境里的值优先于缺省值）。
#[test]
fn pathext_order_from_the_environment_is_honoured() {
    let directory = r"C:\tools";
    let cmd = join(directory, "node.cmd");
    let exe = join(directory, "node.exe");
    let env = environment(&[(PATH_ENV, directory), (PATHEXT_ENV, ".CMD;.EXE")]);
    let resolved = resolve("node", &[], &env, &[&cmd, &exe]).unwrap();
    assert_eq!(resolved.program, CMD_EXE);
    assert!(
        resolved
            .raw_arguments
            .as_deref()
            .is_some_and(|raw| raw.contains("node.CMD")),
        "{:?}",
        resolved.raw_arguments
    );

    let env = environment(&[(PATH_ENV, directory), (PATHEXT_ENV, ".EXE;.CMD")]);
    let resolved = resolve("node", &[], &env, &[&cmd, &exe]).unwrap();
    assert_eq!(resolved.program, join(directory, "node.EXE"));
    assert_eq!(resolved.raw_arguments, None);
}

/// PATH 项带引号（老式写法）时去掉引号再拼；空项跳过，不从工作区意外加载程序。
#[test]
fn quoted_and_empty_path_entries_are_handled() {
    let directory = r"C:\Program Files\nodejs";
    let node = join(directory, "node.exe");
    let quoted = format!(";\"{directory}\";");
    let env = environment(&[(PATH_ENV, quoted.as_str())]);
    let resolved = resolve("node", &[], &env, &[&node]).unwrap();
    assert_eq!(resolved.program, join(directory, "node.EXE"));
}

/// Windows 环境名不区分大小写；`Path` 与 `PATH` 同时存在时取后遍历到的那个（与 `Command::envs` 一致）。
#[test]
fn environment_names_are_case_insensitive() {
    let user_node = join(r"C:\lower", "node.exe");
    let env = BTreeMap::from([
        ("Path".to_owned(), r"C:\lower".to_owned()),
        ("PATH".to_owned(), r"C:\upper".to_owned()),
        (
            "nibi_node_fallback_exec_path".to_owned(),
            r"C:\tools\nibi.exe".to_owned(),
        ),
    ]);
    let resolved = resolve("node", &[], &env, &[&user_node]).unwrap();
    assert_eq!(resolved.program, join(r"C:\lower", "node.EXE"));
}

/// `ComSpec` 指向的 cmd.exe 被使用；没有时退回 `cmd.exe`。
#[test]
fn the_configured_comspec_is_used() {
    let directory = r"C:\tools";
    let curl = join(directory, "curl.cmd");
    let comspec = r"C:\Windows\System32\cmd.exe";
    let env = environment(&[(PATH_ENV, directory), (COMSPEC_ENV, comspec)]);
    let resolved = resolve("curl", &[], &env, &[&curl]).unwrap();
    assert_eq!(resolved.program, comspec);

    let env = environment(&[(PATH_ENV, directory)]);
    let resolved = resolve("curl", &[], &env, &[&curl]).unwrap();
    assert_eq!(resolved.program, CMD_EXE);
}

/// 常见参数形态的转义：空格、引号、末尾反斜杠、百分号。
#[test]
fn common_argument_shapes_are_escaped() {
    assert_eq!(escape_argument("plain", false), r#"^"plain^""#);
    assert_eq!(escape_argument("a b", false), r#"^"a^ b^""#);
    assert_eq!(escape_argument(r#"a"b"#, false), r#"^"a\^"b^""#);
    assert_eq!(escape_argument(r"C:\dir\", false), r#"^"C:\dir\\^""#);
    assert_eq!(escape_argument("%PATH%", false), r#"^"^%PATH^%^""#);
}

/// `node_modules/.bin` 下的 cmd shim 要二次转义（cross-spawn 的规则）。
#[test]
fn only_node_modules_bin_cmd_shims_are_double_escaped() {
    assert!(is_cmd_shim(r"C:\proj\node_modules\.bin\pkg.cmd"));
    assert!(is_cmd_shim("C:/proj/node_modules/.bin/pkg.CMD"));
    assert!(!is_cmd_shim(
        r"C:\Users\me\AppData\Roaming\NIBI\node-fallback\v1\npx.cmd"
    ));
    assert!(!is_cmd_shim(r"C:\proj\node_modules\.bin\pkg.exe"));
    assert_eq!(
        escape_argument("a b", true),
        escape_meta(&escape_argument("a b", false))
    );
}

/// PATHEXT 缺省值与容错（缺前导点的项补点）。
#[test]
fn pathext_entries_are_normalized() {
    assert_eq!(
        extensions(DEFAULT_PATHEXT),
        vec![".COM", ".EXE", ".BAT", ".CMD"]
    );
    assert_eq!(extensions("EXE; .CMD ;"), vec![".EXE", ".CMD"]);
}

/// 真实文件系统上走一遍：PATH 里的 `.cmd` 被找到，经 cmd.exe 启动后参数原样到达脚本。
#[cfg(windows)]
#[test]
#[expect(
    clippy::disallowed_methods,
    reason = "测试夹具：在临时目录里写一个 .cmd 脚本（不是产品的存储 IO）"
)]
fn a_real_cmd_on_path_is_resolved_and_runs() {
    use std::os::windows::process::CommandExt;

    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("reply.cmd");
    std::fs::write(&script, "@echo off\r\necho got:%~1\r\n").unwrap();
    let env = environment(&[(PATH_ENV, directory.path().to_str().unwrap())]);
    let resolved = super::resolve("reply", &args(&["hello world"]), &env).unwrap();
    assert_eq!(resolved.program, CMD_EXE);
    let raw = resolved.raw_arguments.unwrap();
    let output = nibi_kernel_proc::std_command(&resolved.program)
        .raw_arg(&raw)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "got:hello world"
    );
}

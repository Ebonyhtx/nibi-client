//! `nibi doctor` / `nibi skills` / `nibi commands` 的真实进程（spec §3–§5、§8）：临时 HOME、不联网、
//! 不进入 TUI。验证 `--help` 退出码 0、JSON 只写 stdout、未知名字退出码 1。
#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "集成测试：准备临时 HOME 与 SKILL.md / commands 夹具"
)]

mod system_env;
use std::path::Path;
use std::process::{Output, Stdio};
use system_env::KeepSystem as _;

use serde_json::Value;

fn nibi(home: &Path, args: &[&str]) -> Output {
    let mut command = nibi_kernel_proc::std_command(env!("CARGO_BIN_EXE_nibi-rs"));
    command
        .args(args)
        .current_dir(home)
        .env_clear()
        .keep_system()
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("NIBI_DATA_BASE_DIR", home)
        .env("PATH", "")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn every_command_help_exits_zero_and_writes_usage_to_stdout() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        ["doctor", "--help"],
        ["skills", "--help"],
        ["commands", "--help"],
        ["update", "--help"],
        ["login", "--help"],
        ["hooks", "--help"],
    ] {
        let output = nibi(home.path(), &args);
        assert_eq!(output.status.code(), Some(0), "{args:?}: {output:?}");
        let stdout = text(&output.stdout);
        assert!(stdout.contains("Usage"), "{args:?}: {stdout}");
        assert!(output.stderr.is_empty(), "{args:?}: {output:?}");
    }
}

#[test]
fn doctor_json_is_one_object_on_stdout_and_a_clean_machine_is_ok() {
    let home = tempfile::tempdir().unwrap();
    let output = nibi(home.path(), &["doctor", "--json"]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["ok"], true);
    assert_eq!(value["packaging"]["default"], "standalone");
    let ids: Vec<&str> = value["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|check| check["id"].as_str().unwrap())
        .collect();
    for id in ["cli", "runtime", "storage", "provider", "auth", "node", "plugins", "mcp"] {
        assert!(ids.contains(&id), "{id}: {ids:?}");
    }
    // 干净机器上 provider / auth / storage 只提醒，不失败。
    assert!(value["checks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|check| check["status"] != "fail"));
}

#[test]
fn skills_list_and_inspect_read_the_same_files_and_unknown_names_fail() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join(".nibi").join("skills").join("review");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: Review\ndescription: Review the current diff\nallowed-tools: Read\n---\n\n# Review\n",
    )
    .unwrap();

    let output = nibi(home.path(), &["skills", "list", "--json"]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    let skill = value["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|skill| skill["name"] == "review")
        .expect("the fixture skill is listed");
    assert_eq!(skill["source"], "user");
    assert_eq!(skill["description"], "Review the current diff");

    let output = nibi(home.path(), &["skills", "inspect", "review", "--json"]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["skill"]["name"], "review");
    assert!(value["skill"]["frontmatter"]
        .as_str()
        .unwrap()
        .contains("description: Review the current diff"));
    assert_eq!(value["skill"]["metadata"]["allowedTools"][0], "Read");

    let output = nibi(home.path(), &["skills", "inspect", "missing"]);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert_eq!(text(&output.stderr), "unknown skill: missing\n");
    assert!(output.stdout.is_empty());
}

#[test]
fn commands_builtin_has_33_entries_and_custom_commands_come_from_the_project() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join(".nibi").join("commands");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("deploy.md"),
        "---\ndescription: Deploy the app\n---\n\nDeploy it.\n",
    )
    .unwrap();

    let output = nibi(home.path(), &["commands", "builtin", "--json"]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["commands"].as_array().unwrap().len(), 33);

    let output = nibi(home.path(), &["commands", "list", "--json"]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    let command = value["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|command| command["name"] == "deploy")
        .expect("the fixture command is listed");
    assert_eq!(command["source"], "nibi");
    assert_eq!(command["description"], "Deploy the app");

    let output = nibi(home.path(), &["commands", "inspect", "missing"]);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert_eq!(text(&output.stderr), "Error: unknown command: missing\n");
}

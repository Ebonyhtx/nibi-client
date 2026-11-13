#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "tests write temporary config files and use fake probes (README §4)"
)]

use std::path::Path;

use async_trait::async_trait;
use nibi_kernel_base::secret::EnvSnapshot;
use nibi_kernel_paths::{StoragePaths, StorageSettings};

use super::*;

struct FakeProbes {
    node: Result<String, String>,
    http: Result<u16, String>,
}

#[async_trait]
impl Probes for FakeProbes {
    async fn node_version(&self) -> Result<String, String> {
        self.node.clone()
    }

    async fn http_status(&self, _url: &str) -> Result<u16, String> {
        self.http.clone()
    }
}

fn ok_probes() -> FakeProbes {
    FakeProbes {
        node: Ok("v22.0.0".to_owned()),
        http: Ok(200),
    }
}

fn paths(root: &Path) -> StoragePaths {
    StoragePaths::resolve(&StorageSettings::default(), root, root)
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

#[test]
fn the_flags_are_parsed_and_help_wins() {
    assert_eq!(
        parse(&args(&["doctor"])),
        Some(Ok(Command::Run {
            json: false,
            network: false,
            verbose: false,
        }))
    );
    assert_eq!(
        parse(&args(&["doctor", "--json", "--network", "--verbose"])),
        Some(Ok(Command::Run {
            json: true,
            network: true,
            verbose: true,
        }))
    );
    assert_eq!(
        parse(&args(&["doctor", "--nope", "--help"])),
        Some(Ok(Command::Help))
    );
    assert_eq!(
        parse(&args(&["doctor", "--nope"])),
        Some(Err(
            "unknown option '--nope'\nUsage: nibi doctor [--json] [--network] [--verbose]\n"
                .to_owned()
        ))
    );
    assert_eq!(parse(&args(&["login"])), None);
}

#[tokio::test]
async fn storage_is_ok_when_the_data_root_is_writable() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".nibi")).unwrap();
    let checks = check_storage(&paths(dir.path())).await;
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0].id, "storage");
    assert_eq!(checks[0].status, Status::Ok);
    assert!(checks[0].summary.contains("writable"));
}

/// 全新安装还没有 data root：只提醒，不是故障（干净机器上医生仍然 exit 0）。
#[tokio::test]
async fn a_missing_data_root_is_only_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing");
    let checks = check_storage(&paths(&missing)).await;
    assert_eq!(checks[0].status, Status::Warn);
    assert_eq!(checks[0].id, "storage");
    assert!(checks[0].summary.contains("does not exist"));
}

#[tokio::test]
async fn a_missing_provider_is_only_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let check = check_provider(&paths(dir.path())).await;
    assert_eq!(check.status, Status::Warn);
    assert_eq!(check.id, "provider");
}

#[tokio::test]
async fn a_valid_provider_with_a_default_model_is_ok() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let file = paths.provider_config();
    nibi_kernel_fs::atomic_write(
        file.as_path(),
        br#"{
          "schemaVersion": 1,
          "config": {
            "providerConfigRules": {"providerRules": [
              {"providerName": "Gateway", "enabled": true},
              {"providerName": "Off", "enabled": false}
            ]},
            "defaultModelSelection": {"providerId": "personal:gateway", "modelId": "glm-5"}
          }
        }"#,
        nibi_kernel_fs::WriteOptions {
            mode: nibi_kernel_fs::FileMode::Default,
            temp_name: nibi_kernel_fs::TempName::Visible,
            parent: nibi_kernel_fs::ParentDir::Create,
            rename_retry: &[],
        },
    )
    .await
    .unwrap();
    let check = check_provider(&paths).await;
    assert_eq!(check.status, Status::Ok);
    assert!(check.summary.contains("1 provider"));
    assert!(check.detail.unwrap().contains("personal:gateway/glm-5"));
}

#[tokio::test]
async fn invalid_provider_json_is_a_warning_with_the_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    std::fs::create_dir_all(paths.provider_config().as_path().parent().unwrap()).unwrap();
    std::fs::write(paths.provider_config().as_path(), b"{not json").unwrap();
    let check = check_provider(&paths).await;
    assert_eq!(check.status, Status::Warn);
    assert!(check.summary.contains("not valid JSON"));
    assert!(check.detail.unwrap().contains("line"));
}

#[tokio::test]
async fn auth_without_credentials_is_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let check = check_auth(&paths(dir.path()), &EnvSnapshot::default()).await;
    assert_eq!(check.status, Status::Warn);
    assert!(check.summary.contains("not signed in"));
}

#[tokio::test]
async fn a_plaintext_local_token_counts_as_signed_in() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    std::fs::create_dir_all(paths.credentials().as_path().parent().unwrap()).unwrap();
    std::fs::write(
        paths.credentials().as_path(),
        br#"{"nibi:license:token": "token", "nibi:device:id": "device"}"#,
    )
    .unwrap();
    let check = check_auth(&paths, &EnvSnapshot::default()).await;
    assert_eq!(check.status, Status::Ok);
    assert_eq!(check.summary, "signed in");
}

#[tokio::test]
async fn the_node_probe_is_a_warning_when_node_is_missing() {
    let check = check_node(&FakeProbes {
        node: Err("node is not on PATH".to_owned()),
        http: Ok(200),
    })
    .await;
    assert_eq!(check.status, Status::Warn);
    assert!(check.detail.unwrap().contains("PATH"));
}

#[tokio::test]
async fn network_successes_and_failures_map_to_ok_and_warn() {
    let env = EnvSnapshot::default();
    let ok = check_network(&ok_probes(), &env).await;
    assert_eq!(ok.status, Status::Ok);
    assert!(ok.detail.unwrap().contains("auth 200"));
    let failed = check_network(
        &FakeProbes {
            node: Ok("v22".to_owned()),
            http: Err("DNS failure".to_owned()),
        },
        &env,
    )
    .await;
    assert_eq!(failed.status, Status::Warn);
    assert!(failed.detail.unwrap().contains("DNS failure"));
}

#[test]
fn the_report_has_the_schema_and_a_fail_makes_it_not_ok() {
    let cli = cli_facts();
    let runtime = RuntimeFacts {
        platform: "linux",
        arch: "x64",
        cwd: "/tmp".to_owned(),
        data_root: "/tmp/.nibi".to_owned(),
        config_path: "/tmp/.nibi/v2/provider_config.json".to_owned(),
    };
    let checks = vec![
        Check::ok("cli", "fine"),
        Check::fail("storage", "broken").detail("/root"),
    ];
    let report = report_json(&cli, &runtime, &checks, false);
    assert_eq!(report["schemaVersion"], 1);
    assert_eq!(report["ok"], false);
    assert_eq!(report["cli"]["name"], "nibi");
    assert_eq!(report["packaging"]["default"], "standalone");
    assert_eq!(report["checks"][1]["status"], "fail");
    assert_eq!(report["checks"][1]["detail"], "/root");
}

#[test]
fn the_human_report_uses_three_symbols_and_only_shows_detail_when_verbose() {
    let cli = cli_facts();
    let runtime = RuntimeFacts {
        platform: "linux",
        arch: "x64",
        cwd: "/tmp".to_owned(),
        data_root: "/tmp/.nibi".to_owned(),
        config_path: "/tmp/.nibi/v2/provider_config.json".to_owned(),
    };
    let checks = vec![
        Check::ok("cli", "fine"),
        Check::warn("provider", "none").hint("nibi login"),
        Check::fail("storage", "broken"),
    ];
    let brief = human(&cli, &runtime, &checks, false);
    assert!(brief.contains("✓ cli"));
    assert!(brief.contains("! provider"));
    assert!(brief.contains("✗ storage"));
    assert!(!brief.contains("nibi login"));
    let verbose = human(&cli, &runtime, &checks, true);
    assert!(verbose.contains("hint: nibi login"));
}

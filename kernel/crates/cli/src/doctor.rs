//! `nibi doctor`（docs/specs/rust-cli/rust-cli-noninteractive-commands.md §3）：不进入 TUI、不启动会话，
//! 判断这次安装是否健康。
//!
//! 顶层键保持 Node `doctor` 的 `cli` / `runtime` / `packaging`，新增 `checks` 数组。`ok` 为 `checks` 里没有
//! `fail`：`cli` / `runtime` / `storage` 失败算 `fail`，`provider` / `auth` / `node` / `plugins` / `mcp`
//! 与 `--network` 只算 `warn`（离线可用仍是合法场景）。只读：唯一的写入是检查可写性的临时文件，检查后删除。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_env_local::LocalEnvironment;
use nibi_kernel_net::{Egress, HttpRequest};
use nibi_kernel_paths::{StorageSettings, expand_home};
use nibi_kernel_platform::ConfigFile;
use serde_json::{Map, Value, json};

use crate::config::{self, ConfigInputs};
use crate::{Startup, VERSION, output};

pub(crate) const USAGE: &str = "Usage: nibi doctor [--json] [--network] [--verbose]
";

/// 网络与 Node 探测的时限（spec §3.1：3 s）。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// 解析出的命令。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Command {
    Help,
    Run {
        json: bool,
        network: bool,
        verbose: bool,
    },
}

/// `nibi doctor …`：不是 doctor 命令时为 None；错误是写到 stderr 的完整文本。
pub(crate) fn parse(args: &[String]) -> Option<Result<Command, String>> {
    let (first, rest) = args.split_first()?;
    if first != "doctor" {
        return None;
    }
    if rest.iter().any(|arg| arg == "-h" || arg == "--help") {
        return Some(Ok(Command::Help));
    }
    let (mut json, mut network, mut verbose) = (false, false, false);
    for arg in rest {
        match arg.as_str() {
            "--json" => json = true,
            "--network" => network = true,
            "--verbose" => verbose = true,
            other => return Some(Err(format!("unknown option '{other}'\n{USAGE}"))),
        }
    }
    Some(Ok(Command::Run {
        json,
        network,
        verbose,
    }))
}

/// 检查结果的三态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Ok,
    Warn,
    Fail,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Fail => "fail",
        }
    }

    fn symbol(self) -> &'static str {
        match self {
            Self::Ok => "✓",
            Self::Warn => "!",
            Self::Fail => "✗",
        }
    }
}

/// 一项检查。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Check {
    id: &'static str,
    status: Status,
    summary: String,
    detail: Option<String>,
    hint: Option<String>,
}

impl Check {
    fn ok(id: &'static str, summary: impl Into<String>) -> Self {
        Self {
            id,
            status: Status::Ok,
            summary: summary.into(),
            detail: None,
            hint: None,
        }
    }

    fn warn(id: &'static str, summary: impl Into<String>) -> Self {
        Self {
            id,
            status: Status::Warn,
            summary: summary.into(),
            detail: None,
            hint: None,
        }
    }

    fn fail(id: &'static str, summary: impl Into<String>) -> Self {
        Self {
            id,
            status: Status::Fail,
            summary: summary.into(),
            detail: None,
            hint: None,
        }
    }

    fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    fn json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".to_owned(), json!(self.id));
        object.insert("status".to_owned(), json!(self.status.as_str()));
        object.insert("summary".to_owned(), json!(self.summary));
        if let Some(detail) = &self.detail {
            object.insert("detail".to_owned(), json!(detail));
        }
        if let Some(hint) = &self.hint {
            object.insert("hint".to_owned(), json!(hint));
        }
        Value::Object(object)
    }
}

/// 进程事实（`cli` 检查）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct CliFacts {
    version: &'static str,
    build_number: &'static str,
    target: &'static str,
    exec_path: Option<String>,
    argv0: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeFacts {
    platform: &'static str,
    arch: &'static str,
    cwd: String,
    data_root: String,
    config_path: String,
}

/// 可注入的探测：测试里换成不联网、不起进程的假实现。
#[async_trait]
pub(crate) trait Probes: Send + Sync {
    async fn node_version(&self) -> Result<String, String>;
    async fn http_status(&self, url: &str) -> Result<u16, String>;
}

/// 产品里的探测：Node 经 [`nibi_kernel_proc`]，HTTP 经 [`Egress`]。
struct SystemProbes {
    /// `None`：这次没有 `--network`，网络探测不该被调用。
    egress: Option<Result<Arc<Egress>, String>>,
}

#[async_trait]
impl Probes for SystemProbes {
    async fn node_version(&self) -> Result<String, String> {
        let mut command = nibi_kernel_proc::command("node");
        command
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
            .await
            .map_err(|_| "node --version timed out".to_owned())?
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => "node is not on PATH".to_owned(),
                _ => format!("cannot run node: {error}"),
            })?;
        if !output.status.success() {
            return Err(format!("node --version exited with {}", output.status));
        }
        let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if version.is_empty() {
            return Err("node --version printed nothing".to_owned());
        }
        Ok(version)
    }

    async fn http_status(&self, url: &str) -> Result<u16, String> {
        let egress = self
            .egress
            .as_ref()
            .ok_or_else(|| "network probe is not enabled".to_owned())?;
        let egress = egress.as_ref().map_err(Clone::clone)?;
        let mut request = HttpRequest::get(url);
        request.timeout = Some(PROBE_TIMEOUT);
        let response = tokio::time::timeout(PROBE_TIMEOUT, egress.send(request))
            .await
            .map_err(|_| format!("GET {url}: timed out"))?
            .map_err(|error| format!("GET {url}: {error:#}"))?;
        Ok(response.status())
    }
}

/// `--help`：写用法、退出码 0（不需要读配置或探测）。
pub(crate) fn help() -> u8 {
    output::print_raw(USAGE);
    0
}

/// 执行命令，返回退出码（0 健康、1 有 `fail`）。
pub(crate) async fn run(command: Command, startup: &Startup) -> u8 {
    match command {
        Command::Help => help(),
        Command::Run {
            json,
            network,
            verbose,
        } => {
            let egress = if network {
                Some(crate::setup::egress(startup).await)
            } else {
                None
            };
            let probes = SystemProbes {
                egress: egress.map(|result| result.map_err(|error| format!("{error:#}"))),
            };
            run_with(
                &ReportOptions {
                    json,
                    network,
                    verbose,
                },
                startup,
                &probes,
            )
            .await
        }
    }
}

async fn run_with(options: &ReportOptions, startup: &Startup, probes: &dyn Probes) -> u8 {
    let cwd = startup.cwd.clone();
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new(crate::LOCAL_ENVIRONMENT),
        root: EnvPath::new(cwd.to_string_lossy()),
    };
    let default_paths = crate::setup::storage_paths(startup, &StorageSettings::default());
    let env = Arc::new(LocalEnvironment::new(Some(startup.home.clone())));
    let config = config::assemble(&ConfigInputs {
        files: env.as_ref(),
        workspace: &workspace,
        paths: &default_paths,
        process_env: &startup.env,
        flag: None,
        paid_license: Some(crate::read_paid_license(startup)),
    })
    .await;
    let paths = crate::setup::storage_paths(startup, &config.storage.settings());
    let cli = cli_facts();
    let runtime = runtime_facts(startup, &paths);
    let mut checks = Vec::new();
    checks.push(check_cli(&cli));
    checks.push(check_runtime(&runtime));
    checks.extend(check_storage(&paths).await);
    checks.push(check_provider(&paths).await);
    checks.push(check_auth(&paths, &startup.env).await);
    checks.push(check_node(probes).await);
    checks.push(check_plugins(&paths, &config, &startup.env, &startup.home, &cwd).await);
    checks.push(
        check_mcp(
            &default_paths,
            &workspace,
            env.as_ref(),
            &startup.env,
            &config,
        )
        .await,
    );
    if options.network {
        checks.push(check_network(probes, &startup.env).await);
    }
    let ok = checks.iter().all(|check| check.status != Status::Fail);
    let payload = report_json(&cli, &runtime, &checks, ok);
    if options.json {
        output::print_raw(&json_text(&payload));
    } else {
        output::print_raw(&human(&cli, &runtime, &checks, options.verbose));
    }
    u8::from(!ok)
}

struct ReportOptions {
    json: bool,
    network: bool,
    verbose: bool,
}

fn cli_facts() -> CliFacts {
    CliFacts {
        version: VERSION,
        build_number: VERSION,
        target: option_env!("NIBI_BUILD_TARGET").unwrap_or("unknown"),
        exec_path: executable_path(),
        argv0: argv0(),
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "entry crate reads process facts (README §4)"
)]
fn executable_path() -> Option<String> {
    std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

#[expect(
    clippy::disallowed_methods,
    reason = "entry crate reads process facts (README §4)"
)]
fn argv0() -> String {
    std::env::args_os()
        .next()
        .map(|arg| arg.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Node `process.platform` 的名字。
fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Node `process.arch` 的名字（`x86_64` → `x64`）。
fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn runtime_facts(startup: &Startup, paths: &nibi_kernel_paths::StoragePaths) -> RuntimeFacts {
    RuntimeFacts {
        platform: platform_name(),
        arch: arch_name(),
        cwd: startup.cwd.to_string_lossy().into_owned(),
        data_root: paths.root().as_path().to_string_lossy().into_owned(),
        config_path: paths
            .provider_config()
            .as_path()
            .to_string_lossy()
            .into_owned(),
    }
}

fn check_cli(cli: &CliFacts) -> Check {
    let detail = format!(
        "target {} · exec {} · argv0 {}",
        cli.target,
        cli.exec_path.as_deref().unwrap_or("unknown"),
        cli.argv0
    );
    if cli.exec_path.is_none() {
        return Check::fail("cli", "the executable path cannot be resolved").detail(detail);
    }
    Check::ok(
        "cli",
        format!("nibi {} ({})", cli.version, cli.build_number),
    )
    .detail(detail)
}

fn check_runtime(runtime: &RuntimeFacts) -> Check {
    Check::ok("runtime", format!("{}/{}", runtime.platform, runtime.arch)).detail(format!(
        "cwd {} · data root {} · config {}",
        runtime.cwd, runtime.data_root, runtime.config_path
    ))
}

async fn check_storage(paths: &nibi_kernel_paths::StoragePaths) -> Vec<Check> {
    let root = paths.root().as_path();
    // 全新安装还没有 `~/.nibi`：缺目录不是故障（第一次运行时创建），只提醒。
    if !nibi_kernel_fs::exists(root).await {
        return vec![
            Check::warn("storage", "data root does not exist yet")
                .detail(root.to_string_lossy())
                .hint("it is created on first use; NIBI_STORAGE_DIR overrides the location"),
        ];
    }
    let probe = root.join(format!(".nibi-doctor-{}.tmp", std::process::id()));
    let write = nibi_kernel_fs::atomic_write(
        &probe,
        b"",
        nibi_kernel_fs::WriteOptions {
            mode: nibi_kernel_fs::FileMode::Default,
            temp_name: nibi_kernel_fs::TempName::Hidden,
            parent: nibi_kernel_fs::ParentDir::Existing,
            rename_retry: &[],
        },
    )
    .await;
    let removed = nibi_kernel_fs::remove_optional(&probe).await;
    if let Err(error) = write {
        let mut check = Check::fail("storage", "data root is not writable")
            .detail(format!("{}: {error}", root.display()));
        check = check.hint("check the directory permissions or NIBI_STORAGE_DIR");
        return vec![check];
    }
    if let Err(error) = removed {
        let mut check = Check::warn("storage", "the writability test file could not be removed")
            .detail(format!("{}: {error}", probe.display()));
        check = check.hint("remove the leftover .nibi-doctor-*.tmp file");
        return vec![check];
    }
    let database = paths.database().as_path().to_path_buf();
    if !nibi_kernel_fs::exists(&database).await {
        return vec![
            Check::ok("storage", "data root writable; no session database yet")
                .detail(root.to_string_lossy()),
        ];
    }
    let facts = {
        let database = database.clone();
        nibi_kernel_base::blocking(move || nibi_kernel_node_store::inspect_schema(&database)).await
    };
    match facts {
        Ok(Ok(facts)) => {
            let applied = facts.applied.len();
            let pending = facts.pending.len();
            let last = facts
                .applied
                .last()
                .map_or_else(|| "none".to_owned(), |id| id.clone());
            let summary = format!("data root writable; schema {applied} applied");
            let detail = format!(
                "{} · last migration {last} · {pending} pending",
                database.display()
            );
            vec![if pending > 0 {
                Check::warn("storage", summary)
                    .detail(detail)
                    .hint("the pending migrations run the next time a session database is opened")
            } else {
                Check::ok("storage", summary).detail(detail)
            }]
        }
        Ok(Err(error)) => vec![
            Check::fail("storage", "the session database cannot be read")
                .detail(format!("{}: {error}", database.display()))
                .hint("move the database aside or restore it from a backup"),
        ],
        Err(error) => vec![
            Check::fail("storage", "the session database check failed")
                .detail(format!("{}: {error}", database.display())),
        ],
    }
}

async fn check_provider(paths: &nibi_kernel_paths::StoragePaths) -> Check {
    let file = paths.provider_config();
    let path = file.as_path();
    let bytes = match nibi_kernel_fs::read_optional(path).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => {
            return Check::warn("provider", "no provider configured")
                .detail(format!("{} does not exist", path.display()))
                .hint("nibi provider add ... or nibi login");
        }
        Err(error) => {
            return Check::warn("provider", "the provider config cannot be read")
                .detail(format!("{}: {error}", path.display()));
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            return Check::warn("provider", "the provider config is not valid JSON")
                .detail(format!("{}: {error}", path.display()))
                .hint("fix the JSON or remove the file");
        }
    };
    if !value.is_object() {
        return Check::warn("provider", "the provider config is not a JSON object")
            .detail(format!("{}", path.display()))
            .hint("fix the JSON or remove the file");
    }
    // `provider_config.json` 把规则放在 `config` 下（`config.providerConfigRules`、
    // `config.defaultModelSelection`）；也容忍顶层写法（旧文件/手工文件）。
    let settings = value.get("config").filter(|value| value.is_object()).unwrap_or(&value);
    let rules = settings
        .get("providerConfigRules")
        .and_then(|object| object.get("providerRules"))
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let enabled = rules
        .iter()
        .filter(|rule| rule.get("enabled").and_then(Value::as_bool) != Some(false))
        .count();
    let default = settings.get("defaultModelSelection").and_then(|selection| {
        let provider = selection.get("providerId").and_then(Value::as_str)?;
        let model = selection.get("modelId").and_then(Value::as_str)?;
        Some(format!("{provider}/{model}"))
    });
    if enabled == 0 {
        return Check::warn("provider", "no provider enabled")
            .detail(format!("{} has no enabled provider rule", path.display()))
            .hint("nibi provider add ... or nibi login");
    }
    let summary = format!(
        "{enabled} provider{} enabled",
        if enabled == 1 { "" } else { "s" }
    );
    match default {
        Some(model) => Check::ok("provider", summary).detail(format!("default model {model}")),
        None => Check::warn("provider", summary)
            .detail(format!("{}: no defaultModelSelection", path.display()))
            .hint("nibi provider use <id>"),
    }
}

async fn check_auth(
    paths: &nibi_kernel_paths::StoragePaths,
    env: &nibi_kernel_base::secret::EnvSnapshot,
) -> Check {
    let credentials = paths.credentials();
    let path = credentials.as_path();
    let exists = nibi_kernel_fs::exists(path).await;
    let facts = nibi_platform::license_store::read_license_credentials(path, |key| {
        env.get(key).map(str::to_owned)
    });
    if facts.token.is_some() {
        return Check::ok("auth", "signed in").detail(format!("credentials {}", path.display()));
    }
    let summary = if exists {
        "the local credentials file has no session token"
    } else {
        "not signed in"
    };
    Check::warn("auth", summary)
        .detail(format!("{}", path.display()))
        .hint("nibi login")
}

async fn check_node(probes: &dyn Probes) -> Check {
    match probes.node_version().await {
        Ok(version) => Check::ok("node", version).detail("the Node runtime is available"),
        Err(error) => Check::warn("node", "node is not available")
            .detail(error)
            .hint(
                "DWF and Node-based plugin hosts are unavailable; install Node.js to enable them",
            ),
    }
}

async fn check_plugins(
    paths: &nibi_kernel_paths::StoragePaths,
    config: &config::ConfigSnapshot,
    env: &nibi_kernel_base::secret::EnvSnapshot,
    home: &Path,
    cwd: &Path,
) -> Check {
    let storage_dir = config.storage.dir.as_deref();
    let plugin_root = paths.plugin_storage(storage_dir, cwd);
    let roots = nibi_kernel_platform::plugin_inventory::official_plugin_roots(&plugin_root).await;
    let host = host_entry(env, home).await;
    let seed_detail = if roots.is_empty() {
        format!(
            "no built-in plugin seeds under {}",
            plugin_root.as_path().display()
        )
    } else {
        format!(
            "{} built-in plugin seed{} under {}",
            roots.len(),
            if roots.len() == 1 { "" } else { "s" },
            plugin_root.as_path().display()
        )
    };
    match host {
        Some(path) => Check::ok(
            "plugins",
            format!("{} built-in plugin roots; host entry found", roots.len()),
        )
        .detail(format!("{seed_detail} · host {}", path.display())),
        None => Check::warn(
            "plugins",
            format!("{} built-in plugin roots; no host entry", roots.len()),
        )
        .detail(seed_detail)
        .hint("Node-based plugin hosts need nibi.cjs; standalone installs can use built-in tools without it"),
    }
}

async fn host_entry(env: &nibi_kernel_base::secret::EnvSnapshot, home: &Path) -> Option<PathBuf> {
    // 桌面/发行包的启动参数里带 `nibi.cjs`；再其次看显式变量与可执行文件旁边。
    if let Some(args) = env.get("NIBI_AGENT_SERVER_ARGS_JSON")
        && let Ok(Value::Array(items)) = serde_json::from_str::<Value>(args)
    {
        for path in items.iter().filter_map(Value::as_str).map(PathBuf::from) {
            if is_host_entry(&path).await {
                return Some(path);
            }
        }
    }
    if let Some(path) = env.get("NIBI_AGENT_ENTRY") {
        let path = expand_home(path, home);
        return is_host_entry(&path).await.then_some(path);
    }
    let exe = executable_path()?;
    let dir = Path::new(&exe).parent()?;
    for candidate in [
        dir.join("agent").join("nibi.cjs"),
        dir.join("..").join("agent").join("nibi.cjs"),
    ] {
        if nibi_kernel_fs::exists(&candidate).await {
            return Some(candidate);
        }
    }
    None
}

async fn is_host_entry(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == "nibi.cjs") && nibi_kernel_fs::exists(path).await
}

async fn check_mcp(
    default_paths: &nibi_kernel_paths::StoragePaths,
    workspace: &WorkspaceRef,
    files: &dyn nibi_kernel_api::machine::Files,
    env: &nibi_kernel_base::secret::EnvSnapshot,
    config: &config::ConfigSnapshot,
) -> Check {
    let inputs = ConfigInputs {
        files,
        workspace,
        paths: default_paths,
        process_env: env,
        flag: None,
        paid_license: None,
    };
    let files = config::read_files(&inputs).await;
    let mut invalid = Vec::new();
    if let ConfigFile::Invalid { reason } = &files.user {
        invalid.push(format!("{}: {reason}", files.user_path));
    }
    for project in &files.projects {
        if let ConfigFile::Invalid { reason } = &project.file {
            invalid.push(format!("{}: {reason}", project.path));
        }
    }
    if let Some(first) = invalid.first() {
        return Check::warn("mcp", "an MCP configuration file cannot be parsed")
            .detail(first.clone())
            .hint("fix the JSON (the line and column are in the detail) or remove the file");
    }
    let disabled = config.mcp_disabled.len();
    let summary = format!(
        "{} MCP server{} configured",
        config.mcp_servers.len(),
        if config.mcp_servers.len() == 1 {
            ""
        } else {
            "s"
        }
    );
    let mut check = Check::ok("mcp", summary);
    if disabled > 0 {
        check = check.detail(format!("{disabled} disabled server(s) not connected"));
    }
    check
}

async fn check_network(probes: &dyn Probes, env: &nibi_kernel_base::secret::EnvSnapshot) -> Check {
    let lookup = |key: &str| env.get(key).map(str::to_owned);
    let mut failures = Vec::new();
    let mut statuses = Vec::new();
    let api = crate::origins::nibi_origin(&lookup);
    let auth = nibi_platform::device_flow::auth_origin_from_env(lookup);
    let download = crate::update::registry_from_env(env);
    for (name, url) in [("api", api), ("auth", Ok(auth)), ("dl", Ok(download))] {
        match url {
            Err(error) => failures.push(format!("{name}: {error}")),
            Ok(url) => match probes.http_status(&url).await {
                Ok(status) => statuses.push(format!("{name} {status}")),
                Err(error) => failures.push(format!("{name}: {error}")),
            },
        }
    }
    if failures.is_empty() {
        Check::ok("network", "api, auth and download endpoints are reachable")
            .detail(statuses.join(" · "))
    } else {
        Check::warn("network", "a network endpoint is not reachable")
            .detail(failures.join(" · "))
            .hint("check the proxy, firewall or DNS settings")
    }
}

fn report_json(cli: &CliFacts, runtime: &RuntimeFacts, checks: &[Check], ok: bool) -> Value {
    json!({
        "schemaVersion": 1,
        "ok": ok,
        "cli": {
            "name": "nibi",
            "version": cli.version,
            "buildNumber": cli.build_number,
            "target": cli.target,
            "execPath": cli.exec_path.clone().unwrap_or_default(),
            "argv0": cli.argv0,
        },
        "runtime": {
            "platform": runtime.platform,
            "arch": runtime.arch,
            "cwd": runtime.cwd,
            "dataRoot": runtime.data_root,
            "configPath": runtime.config_path,
        },
        "packaging": {"default": "standalone", "sea": false},
        "checks": checks.iter().map(Check::json).collect::<Vec<_>>(),
    })
}

fn human(cli: &CliFacts, runtime: &RuntimeFacts, checks: &[Check], verbose: bool) -> String {
    let mut lines = vec![
        format!("nibi doctor {}", cli.version),
        format!(
            "runtime {}/{} · {}",
            runtime.platform, runtime.arch, runtime.cwd
        ),
    ];
    for check in checks {
        lines.push(format!(
            "{} {:<9} {}",
            check.status.symbol(),
            check.id,
            check.summary
        ));
        if verbose {
            if let Some(detail) = &check.detail {
                lines.push(format!("    {detail}"));
            }
            if let Some(hint) = &check.hint {
                lines.push(format!("    hint: {hint}"));
            }
        }
    }
    lines.join("\n") + "\n"
}

fn json_text(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

#[cfg(test)]
#[path = "doctor_tests.rs"]
mod tests;

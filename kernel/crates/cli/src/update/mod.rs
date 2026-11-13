//! 自动更新（docs/specs/rust-cli/update.md，工作线 F48；用户决定照 Codex 的做法）。
//!
//! 启动时（只在 TUI）：读启动器标记（[`install`]）→ 读缓存（[`cache`]）→ 决定弹不弹选择屏、要不要在会话里提示 →
//! 缓存缺失或过期时在后台刷新（[`registry`]），本次只用读到的那一份。选 Update now 时入口不建会话，执行安装
//! （[`action`]）后退出。`zcode update` 不看缓存，直接执行（Codex `run_update_command`）。没有标记时什么都不做。

mod action;
mod cache;
mod handoff;
mod install;
// 执行器的 npm 来源（F100，remote-exec.md §26.4）也用它取 packument。
pub(crate) mod registry;
mod versions;

#[cfg(test)]
#[path = "fake_registry_tests.rs"]
mod fake_registry_tests;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use nibi_kernel_base::{Task, TaskScope};
use nibi_kernel_api::clock::Clock;
use nibi_kernel_net::Egress;
use nibi_kernel_tui::update::{UpdateChoice, UpdateInfo};

use crate::flags::Fatal;
pub(crate) use install::Install;

/// `nibi update` 的帮助（commander 12 的子命令形式；说明是 Codex 的，update.md §9）。
const HELP: &str = "Usage: nibi update|upgrade [options]

Update NIBI to the latest version

Options:
  --check     Check for a newer version without installing it
  -h, --help  Display help for command
";
/// npm 的 META 包（`@nibi-studio/cli`）：`optionalDependencies` 按平台指向
/// `@nibi-studio/cli-<platform>`。`nibi update --check` 在没有启动器标记时也查它。
pub(crate) const META_PACKAGE: &str = "@nibi-studio/cli";
/// 没有标记时 `nibi update` 的报错（update.md §9）。链接是 npm 入口包的页面
/// （用户决定 2026-10-23，工作线 F71；以前没有链接）：没有标记时不知道包名，只在这里写死，有标记时的链接由启动器给的包名
/// 拼（`install.rs`）。`@nibi-studio/cli` 是 NIBI 的 npm 入口包（发布平台包时同批上线）。
const UNDETECTED: &str = "Error: Could not detect the NIBI installation method. Please update manually: https://www.npmjs.com/package/@nibi-studio/cli";

/// 启动时的输入（入口给出）。
pub(crate) struct Inputs<'a> {
    /// 入口的进程环境快照（启动器标记）。
    pub(crate) env: &'a [(String, String)],
    /// 配置的 `checkForUpdateOnStartup`（缺省 true）。
    pub(crate) enabled: bool,
    pub(crate) version: &'a str,
    /// `StoragePaths::update_cache`。
    pub(crate) cache: PathBuf,
    pub(crate) egress: Arc<Egress>,
    pub(crate) clock: Arc<dyn Clock>,
    /// npm registry 的根（产品里是 [`registry::REGISTRY`]，测试换成本地假服务）。
    pub(crate) registry: String,
}

/// 启动时算出的结果。持有后台刷新的任务作用域：入口一直留着它，进程退出（或它被释放）时刷新随之中止。
pub(crate) struct Updates {
    found: Option<Found>,
    /// 后台刷新：产品里只持有（随它释放而中止），测试等它结束。
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "只为持有任务作用域；测试里经 `refreshed` 等它")
    )]
    refresh: Option<(TaskScope, Task<()>)>,
}

struct Found {
    install: Install,
    cache: PathBuf,
    /// 缓存里比当前新的版本（本次用的那一份）。
    info: Option<UpdateInfo>,
    /// 这个版本已选过“不再提醒”。
    dismissed: bool,
}

/// 选择之后入口要做的事。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Next {
    Continue,
    /// 执行安装，进程以它的退出码结束。
    Update,
}

impl Updates {
    /// update.md §3：没有标记、开关关、源码构建版本时什么都不做（不读缓存、不联网）。
    pub(crate) async fn start(inputs: Inputs<'_>) -> Self {
        let none = Self {
            found: None,
            refresh: None,
        };
        let Some(install) = Install::detect(inputs.env) else {
            return none;
        };
        if !inputs.enabled || versions::is_source_build(inputs.version) {
            return none;
        }
        let cached = cache::read(&inputs.cache).await;
        let refresh = cache::VersionInfo::stale(cached.as_ref(), inputs.clock.now_ms())
            .then(|| spawn_refresh(&inputs, install.clone()));
        let newer = cached.filter(|info| {
            versions::is_newer(&info.latest_version, inputs.version).unwrap_or(false)
        });
        let dismissed = newer
            .as_ref()
            .is_some_and(|info| info.dismissed_version.as_ref() == Some(&info.latest_version));
        let info = newer.map(|cached| UpdateInfo {
            current: inputs.version.to_owned(),
            latest: cached.latest_version,
            command: install.command_line(),
            notes_url: install.notes_url(),
        });
        Self {
            found: Some(Found {
                install,
                cache: inputs.cache,
                info,
                dismissed,
            }),
            refresh,
        }
    }

    /// 要弹的选择屏：有新版本、且没有选过“不再提醒”这个版本。
    pub(crate) fn prompt(&self) -> Option<UpdateInfo> {
        let found = self.found.as_ref()?;
        (!found.dismissed).then(|| found.info.clone()).flatten()
    }

    /// 会话里的提示：有新版本时（不论是否不再提醒，Codex 相同）。
    pub(crate) fn notice(&self) -> Option<UpdateInfo> {
        self.found.as_ref()?.info.clone()
    }

    /// 由包管理器管理时的安装方式。
    pub(crate) fn install(&self) -> Option<&Install> {
        self.found.as_ref().map(|found| &found.install)
    }

    /// 用户的选择（update.md §6.3）：Skip until next version 写 `dismissed_version`（写失败只记日志）。
    pub(crate) async fn choose(&self, choice: UpdateChoice) -> Next {
        match choice {
            UpdateChoice::UpdateNow => Next::Update,
            UpdateChoice::Skip => Next::Continue,
            UpdateChoice::SkipUntilNext => {
                if let Some(found) = &self.found
                    && let Some(info) = &found.info
                    && let Err(error) = cache::dismiss(&found.cache, &info.latest).await
                {
                    tracing::warn!(%error, "update: the dismissal could not be saved");
                }
                Next::Continue
            }
        }
    }

    /// 等后台刷新结束（测试用；产品里不等）。
    #[cfg(test)]
    pub(crate) async fn refreshed(&mut self) -> bool {
        match self.refresh.take() {
            Some((_scope, task)) => task.await.is_ok(),
            None => false,
        }
    }
}

/// 后台刷新（update.md §5）：取最新版本，核对通过后写缓存；失败只记日志，不写（下次启动再试）。
fn spawn_refresh(inputs: &Inputs<'_>, install: Install) -> (TaskScope, Task<()>) {
    let scope = TaskScope::root("update-check", |_| {});
    let (egress, registry, cache, clock) = (
        inputs.egress.clone(),
        inputs.registry.clone(),
        inputs.cache.clone(),
        inputs.clock.clone(),
    );
    let task = scope.spawner().spawn("update-refresh", async move {
        match registry::latest(&egress, &registry, &install).await {
            Ok(latest) => {
                if let Err(error) = cache::record_latest(&cache, &latest, clock.now_ms()).await {
                    tracing::warn!(%error, "update: the version cache could not be written");
                }
            }
            Err(error) => tracing::warn!(error = %format!("{error:#}"), "update: check failed"),
        }
    });
    (scope, task)
}

/// `zcode update` / `zcode upgrade` 的参数。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Command {
    Run,
    Help,
    /// 只查不升（`nibi update --check [--json]`）。
    Check {
        json: bool,
    },
}

/// 第一个参数是 `update` / `upgrade` 时解析成命令（commander 12 的规则：先看帮助，再报未知选项，再报多余的参数）；
/// 错误是写到 stderr 的完整一行。其他命令返回 None。
pub(crate) fn parse(args: &[String]) -> Option<Result<Command, String>> {
    let (first, rest) = args.split_first()?;
    if first != "update" && first != "upgrade" {
        return None;
    }
    if rest.iter().any(|arg| arg == "-h" || arg == "--help") {
        return Some(Ok(Command::Help));
    }
    let mut check = false;
    let mut json = false;
    for arg in rest {
        match arg.as_str() {
            "--check" => check = true,
            "--json" => json = true,
            option if option.starts_with('-') && option != "-" => {
                return Some(Err(format!("error: unknown option '{option}'")));
            }
            _ => {
                let count = rest.len();
                return Some(Err(format!(
                    "error: too many arguments for 'update'. Expected 0 arguments but got {count}."
                )));
            }
        }
    }
    if json && !check {
        return Some(Err(
            "error: option '--json' can only be used with --check".to_owned()
        ));
    }
    Some(Ok(if check {
        Command::Check { json }
    } else {
        Command::Run
    }))
}

/// 执行 `zcode update`：`env` 是入口的进程环境快照。不查版本：Unix 的命令不带版本，交接文件写 `latest`（§8.1）。
pub(crate) async fn command(
    command: Command,
    env: &[(String, String)],
    out: &mut dyn std::io::Write,
) -> Result<u8> {
    match command {
        Command::Help => {
            let _ = out.write_all(HELP.as_bytes());
            Ok(0)
        }
        Command::Run => match Install::detect(env) {
            Some(install) => action::run(&install, handoff::LATEST, env, out).await,
            None => Err(Fatal(UNDETECTED.to_owned()).into()),
        },
        // `--check` 要网络出口，入口按 `setup::update_check` 分流；走到这里说明调用方漏了分流。
        Command::Check { .. } => Err(Fatal(
            "Error: update --check needs the network egress (entry point routing bug)".to_owned(),
        )
        .into()),
    }
}

/// 启动时要弹选择屏时弹（update.md §6）：`ask` 画选择屏，收到退出信号（`stop`）时放弃它、进程以 0 退出（同工作区
/// 信任对话框）。选了 Update now 时执行安装（§8；交接时目标是选择屏上的最新版本，§8.1），返回进程的退出码；其余返回
/// None，入口继续启动。`env` 是入口的进程环境快照。
pub(crate) async fn offer(
    updates: Option<&Updates>,
    ask: impl AsyncFnOnce(UpdateInfo) -> Result<UpdateChoice>,
    stop: &tokio_util::sync::CancellationToken,
    env: &[(String, String)],
) -> Result<Option<u8>> {
    let Some((updates, info)) = updates.and_then(|updates| Some((updates, updates.prompt()?)))
    else {
        return Ok(None);
    };
    let latest = info.latest.clone();
    let choice = tokio::select! {
        choice = ask(info) => choice?,
        () = stop.cancelled() => return Ok(Some(0)),
    };
    match (updates.choose(choice).await, updates.install()) {
        (Next::Update, Some(install)) => Ok(Some(
            action::run(install, &latest, env, &mut std::io::stdout()).await?,
        )),
        _ => Ok(None),
    }
}

/// 产品里的 registry 根。
pub(crate) fn registry() -> String {
    registry::REGISTRY.to_owned()
}

/// registry 根：`NIBI_NPM_REGISTRY`（国内镜像/离线测试）覆盖产品缺省值。
pub(crate) fn registry_from_env(env: &[(String, String)]) -> String {
    nibi_kernel_base::secret::env_var(env, "NIBI_NPM_REGISTRY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map_or_else(registry, str::to_owned)
}

/// npm 平台包 id（只认 `scripts/rust-cli/npm/package.mjs` 实际发布的四个 TARGETS）。
///
/// Windows 与 Intel macOS 没有平台包：返回 None，`--check` 只查 META 包，不去问一个不存在的包
/// （否则必然 404，把一次正常的版本检查报成网络失败）。
fn package_id(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Some("linux-x64-gnu"),
        ("linux", "aarch64") => Some("linux-arm64-gnu"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("android", "aarch64") => Some("android-arm64"),
        _ => None,
    }
}

/// 本机平台包名 `@nibi-studio/cli-<platform>`（没有平台包时 None）。
pub(crate) fn platform_package_for_build() -> Option<String> {
    package_id(std::env::consts::OS, std::env::consts::ARCH)
        .map(|id| format!("{META_PACKAGE}-{id}"))
}

/// `nibi update --check` 的输入。
pub(crate) struct CheckInputs<'a> {
    pub(crate) egress: &'a Egress,
    pub(crate) registry: &'a str,
    pub(crate) env: &'a [(String, String)],
    pub(crate) version: &'a str,
    pub(crate) json: bool,
}

/// `nibi update --check`：只查不升。检查完成即 0（有无更新都一样）；网络/解析失败 1。
pub(crate) async fn check(inputs: CheckInputs<'_>, out: &mut dyn std::io::Write) -> Result<u8> {
    // 有启动器标记时用启动器给的入口包与平台包；独立安装查 META 包与本机平台包。
    let install = Install::detect(inputs.env).unwrap_or_else(|| Install {
        manager: install::Manager::Npm,
        package: META_PACKAGE.to_owned(),
        platform_package: platform_package_for_build(),
    });
    let latest = registry::latest(inputs.egress, inputs.registry, &install)
        .await
        .map_err(|error| Fatal(format!("Error: update check failed: {error:#}")))?;
    let update_available = versions::is_newer(&latest, inputs.version).unwrap_or(false);
    if inputs.json {
        let body = serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "current": inputs.version,
            "latest": latest,
            "updateAvailable": update_available,
            "channel": "latest",
            "source": "npm",
        }))
        .unwrap_or_default();
        let _ = writeln!(out, "{body}");
    } else {
        let _ = writeln!(out, "current: {}", inputs.version);
        let _ = writeln!(out, "latest: {latest}");
        let _ = writeln!(
            out,
            "update available: {}",
            if update_available { "yes" } else { "no" }
        );
    }
    Ok(0)
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;

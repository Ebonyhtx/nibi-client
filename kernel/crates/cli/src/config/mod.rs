//! 配置文件的组装（docs/specs/rust-cli/config.md）。
//!
//! hooks、权限规则、MCP、插件都读 Node CLI 与 App 共用的配置文件：用户级 `~/.nibi/cli/config.json`（经
//! platform，本机存储）与项目级每层的 `nibi.json`、`.nibi/config.json`（经执行环境，工作区文件）。
//! 结果是一份带版本的快照，交给内核时整份替换（config.md §3）。项目级 hooks 先经信任（`trust`）；插件的
//! 候选目录在同一次组装里从本机存储的插件清单得出（`plugins`，config.md §2.1）。

mod files;
pub(crate) mod merge;
mod plugins;
mod storage;
pub(crate) mod trust;

use nibi_kernel_ext::PluginSources;
use nibi_kernel_ext::mcp::McpServer;
use nibi_kernel_hooks::node_config::NodeHooks;
use nibi_kernel_hooks::{HookSource, HooksConfig};
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::machine::Files as FilesPort;
use nibi_kernel_api::permission::{
    PermissionMode, PermissionRules, RuleBehavior, RuleSource, SourcedRule,
};
use nibi_kernel_api::store::SessionStore;
use nibi_kernel_paths::StoragePaths;
use nibi_kernel_platform::{ConfigFile, read_cli_config};
use nibi_kernel_policy::rules::parse_rule;
use serde_json::{Map, Value};

use self::files::ProjectFile;
use self::merge::Layer;
pub(crate) use self::storage::StorageLayers;
use self::trust::{Pending, WorkspaceHooks};

/// 组装需要的输入（入口捕获的事实与端口）。
pub(crate) struct ConfigInputs<'a> {
    /// 项目级配置文件经本机的 `Files` 读（cli 从注册表的本机取，remote-exec.md §3）。
    pub(crate) files: &'a dyn FilesPort,
    pub(crate) workspace: &'a WorkspaceRef,
    pub(crate) paths: &'a StoragePaths,
    /// 入口捕获的进程环境（http hook 的 header 插值用）。
    pub(crate) process_env: &'a [(String, String)],
    /// `--settings` 给的配置（docs/specs/rust-cli/cli-args.md §8）：Node 配置的同一种写法，排在项目级之后（文件层里
    /// 优先级最高），命令行的单项参数仍在它之上。
    pub(crate) flag: Option<&'a Map<String, Value>>,
    /// 付费插件发现层门禁的授权事实（token/设备/refusal）。`None` 时付费件一律拒绝。
    pub(crate) paid_license: Option<nibi_kernel_ext::plugins::PaidLicense>,
}

/// `--settings` 一层在警告里的名字。
const FLAG_LAYER: &str = "--settings";

/// 配置的带版本快照（config.md §3）。
#[derive(Debug, Clone)]
pub(crate) struct ConfigSnapshot {
    pub(crate) version: u64,
    pub(crate) hooks: HooksConfig,
    /// 配置文件的 `allowedTools` / `disallowedTools`（来源是最后写它的层）。
    pub(crate) rules: Vec<SourcedRule>,
    /// 配置文件的 `permission.mode`。
    pub(crate) mode: Option<PermissionMode>,
    /// 用户级与项目级的 MCP 服务器（已合并、已去掉停用的）。
    pub(crate) mcp_servers: Vec<McpServer>,
    /// 配置里停用的 MCP 服务器与每个名字的来源文件（`/mcp enable/disable`，tui-manage.md §6.1）。
    pub(crate) mcp_disabled: Vec<McpServer>,
    pub(crate) mcp_origins: std::collections::BTreeMap<String, merge::McpOrigin>,
    /// `features.mcp` 不为 false。
    pub(crate) mcp_enabled: bool,
    /// `features.skill` 与 `skills.enabled` 都为真（Node `createNodeSkillAdapter` 的判据）。
    pub(crate) skills_enabled: bool,
    /// `features.memory`（Node `runtimeConfig.memory.enabled` 的配置来源，缺省 true）。
    pub(crate) memory_enabled: bool,
    /// `memory.use`（记忆召回是否参与上下文；Node `runtimeConfig.memory.use`）。
    pub(crate) memory_use: bool,
    /// `features.subagent`（Node `runtimeConfig.subagents.enabled`，缺省 true）：false 时
    /// `Agent` 与协作工具不进工具表。
    pub(crate) subagents_enabled: bool,
    /// `skill` / `command` 两段里最终 `enable: false` 的 `.md` 绝对路径（Node `collectDisabledPaths`）。
    pub(crate) disabled_skill_paths: Vec<String>,
    pub(crate) disabled_command_paths: Vec<String>,
    /// 启用但未信任的项目 hooks（`-p` 结束时提示，config.md §4.4）。
    pub(crate) pending: Option<Pending>,
    /// 插件候选与启用设置（config.md §2.1、ext.md §4.1）。
    pub(crate) plugins: PluginSources,
    /// 界面语言 `ui.locale`（tui.md §7.1）。
    pub(crate) locale: Option<nibi_kernel_platform::UiLocale>,
    /// 主题 `ui.theme`（tui-manage.md §2.1）。
    pub(crate) theme: Option<nibi_kernel_platform::UiTheme>,
    /// 启动时检查新版本 `checkForUpdateOnStartup`（update.md §10，F48；缺省 true）。
    pub(crate) check_for_update: bool,
    /// 提问框的空闲超时 `askUserQuestionTimeout`（毫秒，tools-more.md §1.1，工作线 F72；缺省不计时）。
    pub(crate) question_timeout: Option<u64>,
    /// 项目级配置文件里会生效的 `permission.allowedTools`：最后写它的项目文件（相对工作区根）与规则原文
    /// （工作区信任对话框的项目授权，workspace-trust.md §2.4）。
    pub(crate) project_allow: Option<(String, Vec<String>)>,
    /// 会话库与存储根（`storage.sessionDbPath`、`storage.dir`，修复线 F2）：入口按它解析库与产物目录的位置。
    pub(crate) storage: StorageLayers,
}

impl ConfigSnapshot {
    /// 去掉项目级的 allow 规则（工作区信任的后备询问里拒绝了项目授权，workspace-trust.md §2.5）。
    pub(crate) fn without_project_grants(&mut self) {
        self.rules.retain(|rule| {
            !(rule.source == RuleSource::ProjectSettings && rule.behavior == RuleBehavior::Allow)
        });
    }

    /// 判决链的规则快照：配置文件、本机项目规则集（LocalSettings）与命令行（shell-permissions.md §5）。
    pub(crate) fn permission_rules(
        &self,
        local: Vec<SourcedRule>,
        cli: PermissionRules,
    ) -> PermissionRules {
        PermissionRules {
            version: self.version,
            rules: [self.rules.clone(), local, cli.rules].concat(),
            ..cli
        }
    }
}

/// 本机项目规则集（LocalSettings 来源，shell-permissions.md §5）；读不出时为空并记警告。
pub(crate) async fn local_rules(
    store: &dyn SessionStore,
    workspace: &WorkspaceRef,
) -> Vec<SourcedRule> {
    match store.project_rules(workspace).await {
        Ok(rules) => rules.sourced(),
        Err(error) => {
            tracing::warn!(%error, "the project permission ruleset could not be read");
            Vec::new()
        }
    }
}

/// 新会话的模式（config.md §2.2，Node `options.runtimeConfig.mode ?? persistedMode ??
/// config.permission.mode`）：命令行 → 本机项目的持久模式 → 配置文件 → default。命令行给了时不读持久模式；
/// 持久模式读不出时当作没有并记警告。
pub(crate) async fn initial_mode(
    cli: Option<PermissionMode>,
    config: Option<PermissionMode>,
    store: &dyn SessionStore,
    workspace: &WorkspaceRef,
) -> PermissionMode {
    if let Some(mode) = cli {
        return mode;
    }
    let project = match store.project_mode(workspace).await {
        Ok(mode) => mode,
        Err(error) => {
            tracing::warn!(%error, "the project permission mode could not be read");
            None
        }
    };
    project.or(config).unwrap_or(PermissionMode::Default)
}

fn sourced(source: RuleSource, behavior: RuleBehavior, texts: &[String]) -> Vec<SourcedRule> {
    texts
        .iter()
        .map(|text| SourcedRule {
            source,
            behavior,
            rule: parse_rule(text),
        })
        .collect()
}

/// 读不出的文件记警告（Node `config_file_invalid`）。
fn object<'a>(
    path: &str,
    file: &'a ConfigFile,
    warnings: &mut Vec<String>,
) -> Option<&'a Map<String, Value>> {
    if let ConfigFile::Invalid { reason } = file {
        warnings.push(format!("{path}: the config file is ignored: {reason}"));
    }
    file.object()
}

/// 用户级与项目级的配置文件（启动组装与 `zcode hooks trust` 共用）。
pub(crate) struct Files {
    pub(crate) user_path: String,
    pub(crate) user: ConfigFile,
    pub(crate) projects: Vec<ProjectFile>,
}

pub(crate) async fn read_files(inputs: &ConfigInputs<'_>) -> Files {
    Files {
        user_path: inputs.paths.cli_config().as_path().display().to_string(),
        user: read_cli_config(inputs.paths).await,
        projects: files::discover(inputs.files, inputs.workspace).await,
    }
}

/// `--prepare-storage` 的库位置（prepare_storage.rs）：只来自用户级配置与环境变量，没有项目层——
/// Node 的协议入口 `createConfig({env})` 同一范围（`storage.sessionDbPath` / `storage.dir`）。
pub(crate) struct UserStorage {
    pub(crate) dir: Option<String>,
    pub(crate) session_db_path: Option<String>,
}

pub(crate) async fn user_storage_layer(
    paths: &StoragePaths,
    process_env: &[(String, String)],
) -> UserStorage {
    let user = read_cli_config(paths).await;
    let empty = Map::new();
    let path_text = paths.cli_config().as_path().display().to_string();
    let object = match &user {
        ConfigFile::Loaded(map) => map,
        _ => &empty,
    };
    let layer = Layer {
        source: RuleSource::UserSettings,
        object,
        path: &path_text,
    };
    let storage = StorageLayers::from_layers(&[layer], process_env);
    UserStorage {
        dir: storage.dir,
        session_db_path: storage.session_db_path,
    }
}

/// 用户层 hooks 的原始 `NodeHooks`（工作区钩子评审的 digest 要它算默认超时与输出上限，
/// config.md §4.1）：与启动组装读同一份文件。协议前端（app-server）在组装之后单独取一次。
pub(crate) async fn user_hooks(paths: &nibi_kernel_paths::StoragePaths) -> NodeHooks {
    let user = read_cli_config(paths).await;
    user.object()
        .and_then(|object| object.get("hooks"))
        .map(|value| NodeHooks::from_json(value).0)
        .unwrap_or_default()
}

/// 会话级插件快照：重新读用户/项目配置的 `plugins` 段与安装清单，返回这次会话要用的插件。
///
/// 只读、不改进程级快照；app-server 每个 `session/create` 调一次。付费门禁的 license 也在这里
/// 重新读，所以会员刷新后新会话能立刻生效（老会话保持原快照）。
pub(crate) async fn plugin_snapshot(
    inputs: &ConfigInputs<'_>,
) -> nibi_kernel_ext::plugins::Loaded {
    let Files {
        user_path,
        user,
        projects,
    } = read_files(inputs).await;
    let mut warnings = Vec::new();
    let empty = Map::new();
    let user_object = object(&user_path, &user, &mut warnings);
    let mut layers = vec![Layer {
        source: RuleSource::UserSettings,
        object: user_object.unwrap_or(&empty),
        path: &user_path,
    }];
    for project in &projects {
        if let Some(object) = object(&project.path, &project.file, &mut warnings) {
            layers.push(Layer {
                source: RuleSource::ProjectSettings,
                object,
                path: &project.path,
            });
        }
    }
    let section = plugins::merge(&layers, &mut warnings);
    let storage = StorageLayers::from_layers(&layers, inputs.process_env);
    let root = inputs.workspace.root.as_str();
    let plugin_root = inputs
        .paths
        .plugin_storage(storage.dir.as_deref(), std::path::Path::new(root));
    let sources = plugins::sources(
        section,
        root,
        &plugin_root,
        inputs.paid_license.clone(),
        inputs.process_env,
    )
    .await;
    for warning in warnings {
        tracing::warn!(warning, "plugin snapshot config");
    }
    nibi_kernel_ext::plugins::load_all(inputs.files, inputs.workspace, &[], &sources).await
}

/// 读配置文件并组装快照。只在启动时调用一次（没有文件监听，config.md §6 D6）。
pub(crate) async fn assemble(inputs: &ConfigInputs<'_>) -> ConfigSnapshot {
    let mut warnings = Vec::new();
    let Files {
        user_path,
        user,
        projects,
    } = read_files(inputs).await;
    let empty = Map::new();
    let user_object = object(&user_path, &user, &mut warnings);
    let mut layers = vec![Layer {
        source: RuleSource::UserSettings,
        object: user_object.unwrap_or(&empty),
        path: &user_path,
    }];
    for project in &projects {
        if let Some(object) = object(&project.path, &project.file, &mut warnings) {
            layers.push(Layer {
                source: RuleSource::ProjectSettings,
                object,
                path: &project.path,
            });
        }
    }
    // `--settings`（flagSettings，排在 user / project / local 之后）：规则的来源记为命令行（cli-args.md §8、D7）。
    if let Some(object) = inputs.flag {
        layers.push(Layer {
            source: RuleSource::CliArg,
            object,
            path: FLAG_LAYER,
        });
    }
    let permission = merge::permission(&layers, &mut warnings);
    let mut rules = Vec::new();
    if let Some((source, texts)) = &permission.allowed {
        rules.extend(sourced(*source, RuleBehavior::Allow, texts));
    }
    if let Some((source, texts)) = &permission.disallowed {
        rules.extend(sourced(*source, RuleBehavior::Deny, texts));
    }
    let merge::McpLayers {
        servers: mcp_servers,
        disabled: mcp_disabled,
        origins: mcp_origins,
    } = merge::mcp_layers(&layers, &mut warnings);
    let mcp_enabled = merge::mcp_enabled(&layers);
    let skills_enabled = merge::skills_enabled(&layers);
    let memory_enabled = merge::feature_enabled(&layers, "memory");
    let memory_use = merge::memory_use(&layers);
    let subagents_enabled = merge::feature_enabled(&layers, "subagent");
    let disabled_skill_paths = merge::disabled_paths(&layers, "skill", &mut warnings);
    let disabled_command_paths = merge::disabled_paths(&layers, "command", &mut warnings);
    let locale = merge::locale(&layers, &mut warnings);
    let theme = merge::theme(&layers, &mut warnings);
    let check_for_update = merge::check_for_update(&layers, &mut warnings);
    let question_timeout = merge::question_timeout(&layers, &mut warnings);
    let root = inputs.workspace.root.as_str();
    let plugin_section = plugins::merge(&layers, &mut warnings);
    let storage = StorageLayers::from_layers(&layers, inputs.process_env);
    let plugin_root = inputs
        .paths
        .plugin_storage(storage.dir.as_deref(), std::path::Path::new(root));
    let plugins = plugins::sources(
        plugin_section,
        root,
        &plugin_root,
        inputs.paid_license.clone(),
        inputs.process_env,
    )
    .await;
    let user_hooks = match user_object.and_then(|object| object.get("hooks")) {
        Some(value) => {
            let (parsed, found) = NodeHooks::from_json(value);
            warnings.extend(found.into_iter().map(|w| format!("{user_path}: {w}")));
            parsed
        }
        None => NodeHooks::default(),
    };
    let (user_settings, found) = user_hooks.user_settings();
    warnings.extend(found);
    // 项目级 hooks：只有已信任且启用的声明进快照（config.md §4.2）。
    let workspace = WorkspaceHooks::inspect(
        inputs.workspace.root.as_str(),
        user_object,
        &projects,
        inputs.paths,
        &mut warnings,
    )
    .await;
    let mut sources = vec![(HookSource::User, user_settings)];
    sources.extend(workspace.admitted());
    // `--settings` 的 hooks：命令行上给的，不经项目 hooks 的信任（同用户级）。
    if let Some(value) = inputs.flag.and_then(|object| object.get("hooks")) {
        let (parsed, found) = NodeHooks::from_json(value);
        warnings.extend(found.into_iter().map(|w| format!("{FLAG_LAYER}: {w}")));
        let (settings, found) = parsed.user_settings();
        warnings.extend(found);
        sources.push((HookSource::User, settings));
    }
    let hooks = HooksConfig {
        version: 1,
        sources,
        trusted: true,
        env: inputs.process_env.to_vec().into(),
        prompt_model: None,
    };
    for warning in &warnings {
        tracing::warn!(warning, "configuration");
    }
    ConfigSnapshot {
        version: 1,
        hooks,
        rules,
        mode: permission.mode,
        mcp_servers,
        mcp_disabled,
        mcp_origins,
        mcp_enabled,
        skills_enabled,
        memory_enabled,
        memory_use,
        subagents_enabled,
        disabled_skill_paths,
        disabled_command_paths,
        pending: workspace.pending(),
        plugins,
        locale,
        theme,
        check_for_update,
        question_timeout,
        project_allow: project_allow(&projects, inputs.workspace.root.as_str()),
        storage,
    }
}

/// 与 `merge::permission` 的按键覆盖同一层：最后一份写了合法 `permission.allowedTools` 的项目文件。
fn project_allow(projects: &[ProjectFile], root: &str) -> Option<(String, Vec<String>)> {
    projects.iter().rev().find_map(|project| {
        let rules = project
            .file
            .object()?
            .get("permission")?
            .get("allowedTools")?
            .as_array()?
            .iter()
            .map(|rule| rule.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        Some((files::relative(root, &project.path), rules))
    })
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;

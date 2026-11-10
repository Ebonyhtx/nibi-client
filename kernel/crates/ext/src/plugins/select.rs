//! 插件的来源与启用判定（docs/specs/rust-cli/ext.md §4.1、§4.3、§4.4）。
//!
//! 入口层给出候选目录（配置 `plugins.dirs`、官方内置插件的缓存、已安装插件，按 Node `resolveCandidates`
//! 的顺序）与合并后的 `enabledPlugins`、`suppressedBuiltins`。这里读 manifest 得到插件 id，逐条判定，加载
//! 启用的插件。`--plugin-dir` 的插件（会话插件）排在最前，总是启用，并盖过同名的插件。

use std::collections::{BTreeMap, HashSet};

use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::env_files::FileKind;
use nibi_kernel_api::machine::Files;
use serde_json::Value;

use super::{DeclaredComponents, Manifest, Plugin, PluginCatalog, Plugins, Reader};

/// Node `NIBI_OFFICIAL_PLUGIN_MARKETPLACE`（定义在 base，F55）。
const OFFICIAL: &str = nibi_kernel_base::names::OFFICIAL_MARKETPLACE;
/// Node `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`（`official-plugin-definitions.ts` 里标了 `defaultEnabled`
/// 的插件，与 `packages/shared/src/plugin-marketplaces.ts` 一致），都在官方市场。
const DEFAULT_ENABLED: [&str; 11] = [
    "browser-use",
    "image-search",
    "documents",
    "pdf",
    "presentations",
    "spreadsheets",
    "node-repl-host",
    "skill-creator",
    "plugin-creator",
    "zcode-guide",
    "visualize",
];
/// 能力来自 Node 宿主注入的 `node_repl` MCP 的官方插件（Node `hostMcpServerNames` 与宿主本身）。
const NODE_REPL: [&str; 3] = ["node-repl-host", "browser-use", "computer-use"];
/// Node `NIBI_PLUGIN_HOST_COMMAND`：播种缓存时改写进 MCP 的启动参数。
const PLUGIN_HOST_ARG: &str = "__zcode-plugin-host";
/// 需要 App 内联视图宿主的官方插件（Node `filterVisualizeSkillRoots`）。
const VIEW_HOST: &str = "visualize";

/// 候选目录的来源（Node `PluginSource`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginOrigin {
    /// 配置 `plugins.dirs`（Node 的 `inline`），缺省启用。
    ConfigDir,
    /// 官方内置插件的缓存（Node 的 `official`），`suppressedBuiltins` 只对它生效。
    Official,
    /// `installed_plugins.json` 里的插件（Node 的 `cache`）。
    Installed,
}

/// 入口层给出的一个候选目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginCandidate {
    pub dir: EnvPath,
    /// 插件 id 的后半（`inline`、`nibi-official` 或记录里的 marketplace）。
    pub marketplace: String,
    pub origin: PluginOrigin,
    /// 安装记录 `paid=true`（marketplace manifest 的 paid 在加载 manifest 后再判）。
    pub paid: bool,
}

/// 入口层组装的插件来源（配置快照的一部分，config.md §2.1）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PluginSources {
    /// 按 Node 的顺序：配置目录、官方内置缓存、已安装插件。`plugins.enabled` 为 false 时为空。
    pub candidates: Vec<PluginCandidate>,
    /// 合并后的 `plugins.enabledPlugins`（插件 id → 是否启用）。
    pub enabled_plugins: BTreeMap<String, bool>,
    /// 合并后的 `plugins.suppressedBuiltins`。
    pub suppressed_builtins: Vec<String>,
    /// 安装记录里 `paid=true` 的插件 id：官方缓存候选与安装记录同 id 时也要按付费件判。
    pub paid_installed_ids: Vec<String>,
    /// 付费插件授权（token/设备/refusal）；`None` 时付费件一律拒绝（fail-closed）。
    pub paid_license: Option<PaidLicense>,
    /// Host 在本进程外提供 `node_repl` MCP 服务器（桌面 Rust 内核）。三个 Node 宿主插件里，
    /// `node-repl-host` 是服务器产物本身、`computer-use` 只贡献 skill；两者都放行。
    pub host_node_repl: bool,
    /// Host 同时提供 `node_repl` 的浏览器 broker socket。浏览器 broker 尚未在 Rust 侧实现，
    /// 未置位时 `browser-use` 仍跳过：只有 skill 没有执行面比没有更糟。
    pub host_browser_broker: bool,
    /// 商店目录的展示投影（官方分片 + `marketplaces/<id>/marketplace.json` 快照），按稳定 ID join 到
    /// 引用目录的条目上；入口从本机存储读（platform `plugin_marketplace`）。
    pub listings: Vec<nibi_kernel_api::listing::MarketplaceListing>,
    /// 插件数据根（`<插件存储根>/data`）：`${NIBI_PLUGIN_DATA}` = 它 + `/` + sanitize(插件 id)。
    /// `None` 时该变量不展开，用到它的服务器按缺少变量跳过（Node 同口径的 fail-closed）。
    pub data_root: Option<String>,
    /// 合并后的 `plugins.options`（插件 id → 选项键 → 标量值）：`${user_config.<key>}` 的配置值，
    /// 未配置时取 manifest `userConfig.<key>.default`。
    pub options: BTreeMap<String, BTreeMap<String, Value>>,
    /// 入口捕获的进程环境：`${NIBI_*}` 与敏感 sink（env/headers）里的同名变量；内核不自己读进程环境。
    pub env: BTreeMap<String, String>,
}

/// 付费插件授权事实。判定逻辑在 `nibi_platform::paid_plugin`，这里只携带输入。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaidLicense {
    pub token: String,
    pub device_id: Option<String>,
    pub refusal: Option<String>,
    /// 当前登录账号（`oauth:nibi:user_info` 的 id）；提供后与 claims 的 uid/sub 比对。
    pub account_identity: Option<String>,
    pub now_ms: u64,
}

impl PaidLicense {
    /// 该插件是否被当前 license 覆盖；未覆盖时返回 Node 同文案的拒绝原因。
    pub fn check(&self, plugin_name: &str) -> Result<(), String> {
        let decision = nibi_platform::paid_plugin::evaluate(
            nibi_platform::paid_plugin::PaidPluginEvaluation {
                token: &self.token,
                plugin_name,
                device_id: self.device_id.as_deref(),
                account_identity: self.account_identity.as_deref(),
                refusal: self.refusal.as_deref(),
                now_ms: self.now_ms,
                keys: &nibi_platform::license::public_key,
            },
        );
        if decision.allowed {
            Ok(())
        } else {
            Err(decision.message)
        }
    }
}

/// 官方插件依赖的 Node 运行时或宿主（ext.md §4.4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeDependency {
    /// 能力来自 Node 宿主注入的 `node_repl` MCP。
    NodeRepl,
    /// MCP 经 Node CLI 自身的插件宿主模式启动。
    PluginHost,
    /// MCP 要 Node 注入的官方鉴权。
    OfficialAuth,
    /// 要 App 的内联视图宿主（终端没有）。
    ViewHost,
}

impl NodeDependency {
    fn describe(self) -> &'static str {
        match self {
            Self::NodeRepl => "it relies on the node_repl MCP server injected by the Node host",
            Self::PluginHost => "its MCP server runs in the Node CLI plugin host",
            Self::OfficialAuth => {
                "its MCP server needs the official auth injected by the Node host"
            }
            Self::ViewHost => "the terminal has no inline view host",
        }
    }
}

/// 候选目录没有加载的原因（ext.md §4.3）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    RootMissing,
    ManifestMissing,
    ManifestInvalid(String),
    /// 在 `suppressedBuiltins` 里的内置插件。
    Suppressed,
    /// 同一个 id 已经出现过（先到先得）。
    DuplicateId,
    Disabled,
    /// 与 `--plugin-dir` 的插件同名。
    ShadowedBySession,
    /// 与已经加载的插件同名（marketplace 不同，ext.md D22）。
    DuplicateName,
    NodeRuntime(NodeDependency),
    /// 付费插件，但当前 license 不覆盖/无效（R30 发现层门禁）。
    MembershipRequired(String),
}

impl SkipReason {
    fn describe(&self) -> String {
        match self {
            Self::RootMissing => "the plugin root does not exist".to_owned(),
            Self::ManifestMissing => "the plugin manifest was not found".to_owned(),
            Self::ManifestInvalid(error) => format!("the plugin manifest is invalid: {error}"),
            Self::Suppressed => "the built-in plugin is suppressed".to_owned(),
            Self::DuplicateId => "duplicate plugin ignored".to_owned(),
            Self::Disabled => "the plugin is not enabled".to_owned(),
            Self::ShadowedBySession => "a --plugin-dir plugin has the same name".to_owned(),
            Self::DuplicateName => "a loaded plugin has the same name".to_owned(),
            Self::NodeRuntime(dependency) => dependency.describe().to_owned(),
            Self::MembershipRequired(message) => message.clone(),
        }
    }
}

/// 一个没有加载的候选目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub dir: String,
    /// manifest 读出之后才有。
    pub id: Option<String>,
    /// manifest 读出之后才能声明的组件名（停用/被抑制的条目也要进引用目录，Node 同口径）；
    /// manifest 缺失或非法时为空。
    pub components: DeclaredComponents,
    pub reason: SkipReason,
}

/// 加载结果：加载好的插件、跳过的候选目录，以及 Composer 引用面板的两份数据（身份目录与商店条目）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Loaded {
    pub plugins: Plugins,
    pub skipped: Vec<Skipped>,
    pub catalog: PluginCatalog,
}

/// Node `PLUGIN_NAME_PATTERN`：`^[a-z0-9][a-z0-9._-]{0,127}$`。
fn valid_name(name: &str) -> bool {
    let lower_or_digit = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let mut chars = name.chars();
    chars.next().is_some_and(lower_or_digit)
        && name.len() <= 128
        && chars.all(|c| lower_or_digit(c) || matches!(c, '.' | '_' | '-'))
}

/// Node `readManifest` 的名字规则与报错文字。
fn manifest_name(manifest: &Value) -> Result<String, String> {
    let Some(object) = manifest.as_object() else {
        return Err("Manifest must be a JSON object".to_owned());
    };
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if valid_name(name) {
        Ok(name.to_owned())
    } else {
        Err(format!("Invalid plugin name: {name}"))
    }
}

/// 官方插件依赖 Node 运行时或宿主的判定（ext.md §4.4）；`tables` 是 MCP 服务器声明。
fn node_dependency(
    name: &str,
    marketplace: &str,
    tables: &[Value],
    host_node_repl: bool,
    host_browser_broker: bool,
) -> Option<NodeDependency> {
    if marketplace != OFFICIAL {
        return None;
    }
    if NODE_REPL.contains(&name) {
        // 桌面 Rust 内核里 Host 会注入共享的 `node_repl` MCP 服务器（与 Node bootstrap 同形），
        // 这三个插件的执行面因此存在。浏览器还多一个 Host 侧 broker socket：没有它时继续跳过。
        let satisfied = match name {
            "node-repl-host" | "computer-use" => host_node_repl,
            "browser-use" => host_node_repl && host_browser_broker,
            _ => false,
        };
        return (!satisfied).then_some(NodeDependency::NodeRepl);
    }
    let servers = tables
        .iter()
        .filter_map(Value::as_object)
        .flat_map(|table| table.values());
    for server in servers {
        let args = server.get("args").and_then(Value::as_array);
        if args
            .into_iter()
            .flatten()
            .any(|arg| arg.as_str() == Some(PLUGIN_HOST_ARG))
        {
            return Some(NodeDependency::PluginHost);
        }
        if server.get("auth").is_some() {
            return Some(NodeDependency::OfficialAuth);
        }
    }
    (name == VIEW_HOST).then_some(NodeDependency::ViewHost)
}

/// 判定过程中的状态：会话插件的名字、已出现的 id。
struct Admission<'a> {
    reader: Reader<'a>,
    sources: &'a PluginSources,
    session: HashSet<String>,
    seen: HashSet<String>,
}

impl Admission<'_> {
    /// 一个候选目录：加载好的插件，或跳过的原因（ext.md §4.3 的十步）。
    async fn admit(
        &mut self,
        candidate: &PluginCandidate,
        loaded: &[Plugin],
    ) -> Result<Plugin, Skipped> {
        let dir = candidate.dir.as_str();
        let skip = |id: Option<&str>, reason| Skipped {
            dir: dir.to_owned(),
            id: id.map(str::to_owned),
            components: DeclaredComponents::default(),
            reason,
        };
        if self.reader.kind(dir).await != Some(FileKind::Directory) {
            return Err(skip(None, SkipReason::RootMissing));
        }
        let manifest = match self.reader.manifest(dir).await {
            Manifest::Found(value) => value,
            Manifest::Missing => return Err(skip(None, SkipReason::ManifestMissing)),
            Manifest::Invalid(error) => return Err(skip(None, SkipReason::ManifestInvalid(error))),
        };
        let name = manifest_name(&manifest)
            .map_err(|error| skip(None, SkipReason::ManifestInvalid(error)))?;
        let id = format!("{name}@{}", candidate.marketplace);
        let reject = |reason| Err(skip(Some(&id), reason));
        if candidate.origin == PluginOrigin::Official
            && self.sources.suppressed_builtins.contains(&id)
        {
            return Err(
                self.declared_skip(dir, &id, &manifest, SkipReason::Suppressed)
                    .await,
            );
        }
        if !self.seen.insert(id.clone()) {
            return reject(SkipReason::DuplicateId);
        }
        let default = candidate.origin == PluginOrigin::ConfigDir
            || (candidate.marketplace == OFFICIAL && DEFAULT_ENABLED.contains(&name.as_str()));
        let enabled = self.sources.enabled_plugins.get(&id).copied();
        if !enabled.unwrap_or(default) {
            return Err(self
                .declared_skip(dir, &id, &manifest, SkipReason::Disabled)
                .await);
        }
        // 付费插件发现层门禁（R30）：manifest 或安装记录任一 paid=true 都要会员授权；
        // 拒绝时整个插件不加载，skill/MCP/hooks/agents 能力根因此天然为空。
        let paid = candidate.paid
            || self.sources.paid_installed_ids.iter().any(|paid| paid == &id)
            || manifest
                .get("paid")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        if paid {
            let Some(license) = self.sources.paid_license.as_ref() else {
                return Err(self
                    .declared_skip(
                        dir,
                        &id,
                        &manifest,
                        SkipReason::MembershipRequired(
                            "该插件是会员专享插件：这台设备还没有 NIBI 会员凭证，请登录后开通会员"
                                .to_owned(),
                        ),
                    )
                    .await);
            };
            if let Err(message) = license.check(&name) {
                return Err(self
                    .declared_skip(dir, &id, &manifest, SkipReason::MembershipRequired(message))
                    .await);
            }
        }
        if self.session.contains(&name) {
            return Err(self
                .declared_skip(dir, &id, &manifest, SkipReason::ShadowedBySession)
                .await);
        }
        if loaded.iter().any(|plugin| plugin.name == name) {
            return Err(self
                .declared_skip(dir, &id, &manifest, SkipReason::DuplicateName)
                .await);
        }
        let tables = self.reader.mcp_tables(dir, &manifest).await;
        if let Some(dependency) = node_dependency(
            &name,
            &candidate.marketplace,
            &tables,
            self.sources.host_node_repl,
            self.sources.host_browser_broker,
        ) {
            return Err(self
                .declared_skip(dir, &id, &manifest, SkipReason::NodeRuntime(dependency))
                .await);
        }
        Ok({
            let mut plugin = self
                .reader
                .components(dir, name, &candidate.marketplace, manifest, &tables)
                .await;
            // 发现层放行的付费插件：执行期门禁据此登记插件名（工具表冻结，调用时复核）。
            plugin.paid = paid;
            plugin
        })
    }

    /// 没加载的候选：带上它声明的组件名（引用目录要展示停用条目的能力面）。
    async fn declared_skip(
        &self,
        dir: &str,
        id: &str,
        manifest: &Value,
        reason: SkipReason,
    ) -> Skipped {
        Skipped {
            dir: dir.to_owned(),
            id: Some(id.to_owned()),
            components: self.reader.declared(dir, manifest).await,
            reason,
        }
    }
}

fn log(skipped: &Skipped) {
    let (dir, id, reason) = (
        skipped.dir.as_str(),
        skipped.id.as_deref().unwrap_or(""),
        skipped.reason.describe(),
    );
    match skipped.reason {
        SkipReason::Disabled | SkipReason::Suppressed | SkipReason::ShadowedBySession => {
            tracing::debug!(dir, id, reason, "plugin skipped");
        }
        SkipReason::NodeRuntime(_) => tracing::info!(dir, id, reason, "plugin skipped"),
        SkipReason::MembershipRequired(_) => {
            tracing::info!(dir, id, reason, "paid plugin skipped")
        }
        _ => tracing::warn!(dir, id, reason, "plugin skipped"),
    }
}

/// 加载 `--plugin-dir` 的插件与入口层给出的候选目录（ext.md §4.3）；跳过的候选目录记日志并一起返回。
pub async fn load_all(
    files: &dyn Files,
    workspace: &WorkspaceRef,
    session_dirs: &[EnvPath],
    sources: &PluginSources,
) -> Loaded {
    let reader = Reader {
        files,
        workspace,
        data_root: sources.data_root.as_deref(),
        options: &sources.options,
        env: &sources.env,
    };
    let mut plugins = Vec::new();
    for dir in session_dirs {
        plugins.extend(reader.session_plugin(dir.as_str()).await);
    }
    let mut admission = Admission {
        reader,
        sources,
        session: plugins.iter().map(|plugin| plugin.name.clone()).collect(),
        seen: HashSet::new(),
    };
    let mut skipped = Vec::new();
    for candidate in &sources.candidates {
        match admission.admit(candidate, &plugins).await {
            Ok(plugin) => plugins.push(plugin),
            Err(skip) => {
                log(&skip);
                skipped.push(skip);
            }
        }
    }
    let plugins = Plugins(plugins);
    Loaded {
        catalog: PluginCatalog {
            references: plugins.reference_catalog(&skipped, &sources.listings),
            listings: sources.listings.clone(),
        },
        plugins,
        skipped,
    }
}

#[cfg(test)]
#[path = "select_tests.rs"]
mod tests;

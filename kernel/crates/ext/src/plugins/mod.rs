//! 插件（docs/specs/rust-cli/ext.md §4）：目录与 manifest，提供 skill、MCP 服务器、agent 文件与 hooks。
//! 候选目录由入口层给出（`--plugin-dir`、Node 配置的 `plugins.dirs`、内置缓存与已安装插件），文件经执行
//! 环境端口读；来源与启用判定见 [`select`]。市场与安装未覆盖。
//!
//! manifest 按 Node `findManifest` 依次找本工程的 `.zcode-plugin` 与另外两种插件格式的目录下的 `plugin.json`
//! （同时兼容几种插件格式）；`--plugin-dir` 没有 manifest 时插件名取目录名。

mod reference;
mod select;

use std::collections::BTreeMap;

use nibi_kernel_base::names::vars;
use nibi_kernel_api::env::{EnvPath, ReadFile, WorkspaceRef};
use nibi_kernel_api::env_files::{FileKind, ListDir, PathStyle, StatFile};
use nibi_kernel_api::machine::Files;
use nibi_kernel_api::mcp::McpTransportConfig;
use serde_json::{Map, Value};

use crate::mcp::{McpScope, McpServer, parse_servers};
use crate::skills::PluginSkillRoot;

pub use self::reference::{DeclaredComponents, PluginCatalog};
pub use self::select::{
    Loaded, NodeDependency, PaidLicense, PluginCandidate, PluginOrigin, PluginSources, SkipReason,
    Skipped, load_all,
};

/// manifest 的位置，按 Node `PLUGIN_MANIFEST_DIRS` 的顺序（NIBI 自有清单目录第一位）。
const MANIFESTS: [&str; 4] = [
    ".nibi-plugin/plugin.json",
    ".zcode-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
];

/// 读 manifest 的结果。
enum Manifest {
    Missing,
    Invalid(String),
    Found(Value),
}

/// 插件里的一个 agent 文件（agents.md §3 按插件规则解析）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginAgentFile {
    pub path: String,
    /// 相对 agents 目录的子目录（namespace）；manifest 直接列出的文件为空。
    pub namespace: Vec<String>,
}

/// 一个已加载的插件。
#[derive(Debug, Clone, PartialEq)]
pub struct Plugin {
    /// 稳定身份：`<manifest.name>@<marketplace>`（Node `PluginMetadata.id`）。
    pub id: String,
    pub name: String,
    /// 插件 id 的后半（`inline`、`nibi-official` 或安装记录里的 marketplace）。
    pub marketplace: String,
    pub dir: String,
    pub manifest: Value,
    pub skill_dirs: Vec<String>,
    /// 声明出来的 skill 名（`skills/` 与 manifest 声明路径下含 SKILL.md 的子目录名）。
    /// 引用目录的 `skillQualifiedNames` 用它，与 runtime 的发现口径一致（按目录名）。
    pub skill_names: Vec<String>,
    /// 声明出来的 agent 名（相对 agents 目录的路径段，用 `:` 连接；与 runtime 的类型名同形）。
    pub agent_names: Vec<String>,
    pub mcp_servers: Vec<McpServer>,
    /// agent 文件（runtime 交给 agents 的 `AgentCatalog::set_plugins`）。
    pub agent_files: Vec<PluginAgentFile>,
    /// `hooks/hooks.json` 与 manifest `hooks` 的内容，都是文件的 `{"hooks": …}` 形状（runtime 交给
    /// hooks 引擎的 `register_plugins`）。
    pub hooks: Vec<Value>,
}

/// 全部插件。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plugins(pub Vec<Plugin>);

impl Plugins {
    pub fn skill_roots(&self) -> Vec<PluginSkillRoot> {
        self.0
            .iter()
            .flat_map(|plugin| {
                plugin.skill_dirs.iter().map(|dir| PluginSkillRoot {
                    plugin: plugin.name.clone(),
                    dir: dir.clone(),
                })
            })
            .collect()
    }

    pub fn mcp_servers(&self) -> Vec<McpServer> {
        self.0
            .iter()
            .flat_map(|plugin| plugin.mcp_servers.iter().cloned())
            .collect()
    }

    /// Composer `@` 插件面板的身份目录（Node `buildPluginReferenceCatalog`）：已加载的插件（enabled）
    /// 加上没加载但有 manifest 的候选（disabled），并与商店 listing 的展示字段按稳定 ID join。
    pub fn reference_catalog(
        &self,
        skipped: &[Skipped],
        listings: &[nibi_kernel_api::listing::MarketplaceListing],
    ) -> Vec<nibi_kernel_api::listing::PluginReference> {
        reference::catalog(&self.0, skipped, listings)
    }
}

/// 插件目录下的路径（`path.join`）：风格按插件目录的写法推断，规则是 kernel-api `env_path`
/// （R1-9：以前按“含不含 `\`”猜风格，自己拼接）。
fn join(base: &str, relative: &str) -> String {
    PathStyle::infer(base).join(base, &[relative])
}

fn base_name(path: &str) -> String {
    PathStyle::infer(path).file_name(path)
}

/// Node `sanitizePluginId`：`[^a-zA-Z0-9_.@-]` 换成 `-`（插件数据目录的最后一段）。
pub(crate) fn sanitize_plugin_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// 文件名去掉 `.md`（agent 的缺省名字，与 agents crate 的 `file_stem` 同口径）。
fn stem(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

/// manifest 里的路径字段：字符串或字符串数组。
fn paths(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(path)) => vec![path.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

struct Reader<'a> {
    files: &'a dyn Files,
    workspace: &'a WorkspaceRef,
    /// `<插件存储根>/data`：插件数据目录的父目录（`${NIBI_PLUGIN_DATA}`）。
    data_root: Option<&'a str>,
    /// 合并后的 `plugins.options`（插件 id → 选项键 → 标量）。
    options: &'a BTreeMap<String, BTreeMap<String, Value>>,
    /// 入口捕获的进程环境（模板里的 `${NIBI_*}` 与敏感 sink）。
    env: &'a BTreeMap<String, String>,
}

impl Reader<'_> {
    async fn kind(&self, path: &str) -> Option<FileKind> {
        let request = StatFile {
            path: EnvPath::new(path),
        };
        self.files
            .stat(self.workspace, request)
            .await
            .ok()
            .flatten()
            .map(|stat| stat.kind)
    }

    async fn parse(&self, path: &str) -> Result<Value, String> {
        let request = ReadFile {
            path: EnvPath::new(path),
        };
        let content = self
            .files
            .read_file(self.workspace, request)
            .await
            .map_err(|error| error.to_string())?;
        serde_json::from_slice(&content.bytes).map_err(|error| error.to_string())
    }

    async fn json(&self, path: &str) -> Option<Value> {
        match self.parse(path).await {
            Ok(value) => Some(value),
            Err(error) => {
                tracing::warn!(path, %error, "plugin file is not valid JSON");
                None
            }
        }
    }

    /// 目录里的 `.md` 文件，递归进子目录，子目录名记作命名空间；按名字
    /// 排序，结果确定。
    async fn markdown(&self, root: &str) -> Vec<PluginAgentFile> {
        let mut found = Vec::new();
        let mut pending = vec![(root.to_owned(), Vec::<String>::new())];
        while let Some((dir, namespace)) = pending.pop() {
            let request = ListDir {
                path: EnvPath::new(dir.as_str()),
            };
            let Ok(mut entries) = self.files.list_dir(self.workspace, request).await else {
                continue;
            };
            entries.sort_by(|left, right| left.name.cmp(&right.name));
            let mut subdirs = Vec::new();
            for entry in entries {
                let path = join(&dir, &entry.name);
                match entry.kind {
                    FileKind::Directory => {
                        let mut inner = namespace.clone();
                        inner.push(entry.name);
                        subdirs.push((path, inner));
                    }
                    FileKind::File if entry.name.to_lowercase().ends_with(".md") => {
                        found.push(PluginAgentFile {
                            path,
                            namespace: namespace.clone(),
                        });
                    }
                    _ => {}
                }
            }
            // 先处理本层文件，再按名字顺序进子目录。
            pending.extend(subdirs.into_iter().rev());
        }
        found
    }

    async fn manifest(&self, dir: &str) -> Manifest {
        for candidate in MANIFESTS {
            let path = join(dir, candidate);
            if self.kind(&path).await == Some(FileKind::File) {
                return match self.parse(&path).await {
                    Ok(value) => Manifest::Found(value),
                    Err(error) => Manifest::Invalid(format!("{path}: {error}")),
                };
            }
        }
        Manifest::Missing
    }

    /// MCP 服务器声明：`.mcp.json` 与 manifest 的 `mcpServers`（内联对象，或指向 JSON 文件的路径）；每张
    /// 表已去掉外层的 `mcpServers`。
    async fn mcp_tables(&self, dir: &str, manifest: &Value) -> Vec<Value> {
        let mut tables = Vec::new();
        let default = join(dir, ".mcp.json");
        if self.kind(&default).await == Some(FileKind::File)
            && let Some(file) = self.json(&default).await
        {
            tables.push(file);
        }
        match manifest.get("mcpServers") {
            Some(Value::Object(inline)) => tables.push(Value::Object(inline.clone())),
            other => {
                for path in paths(other) {
                    if let Some(file) = self.json(&join(dir, &path)).await {
                        tables.push(file);
                    }
                }
            }
        }
        tables
            .into_iter()
            .map(|table| table.get("mcpServers").cloned().unwrap_or(table))
            .collect()
    }

    /// 插件声明的 MCP 服务器：先按 Node `resolveMcpServerConfig` 展开清单模板，再交给通用的服务器解析。
    ///
    /// 模板上下文（`adapters/src/plugins/mcp.ts`）：`${*_PLUGIN_ROOT}`、`${*_PLUGIN_DATA}`
    /// （`<插件存储根>/data/<sanitize(id)>`）、`${*_PROJECT_DIR}`（工作区根）、`${user_config.<key>}`
    /// （配置值优先，缺失时取 manifest 默认值）。`env`/`headers` 是敏感 sink：可以写 `${TOKEN}` 这类
    /// 环境变量；其它字段里出现敏感 user_config 会按 Node 同一规则整条跳过。缺变量同样 fail-closed
    /// （不把字面量留给子进程）。
    ///
    /// stdio 服务器的环境按 Node 给两套名字（插件根 / 数据目录 / 项目目录），清单 `env` 优先，
    /// 插件身份 `NIBI_PLUGIN_ID` 最后权威写入（manifest 不可覆盖）。
    fn mcp_servers(
        plugin: &str,
        id: &str,
        variables: &Variables<'_>,
        tables: &[Value],
    ) -> Vec<McpServer> {
        let mut servers = Vec::new();
        for table in tables {
            let Some(entries) = table.as_object() else {
                tracing::warn!(
                    plugin,
                    "plugin MCP configuration: mcpServers must be a JSON object"
                );
                continue;
            };
            let mut expanded = Map::new();
            for (server, config) in entries {
                match expand_server(config, variables) {
                    Ok(value) => {
                        expanded.insert(server.clone(), value);
                    }
                    Err(error) => {
                        tracing::warn!(plugin, server, error, "plugin MCP server skipped");
                    }
                }
            }
            let expanded = Value::Object(expanded);
            let (found, warnings) = parse_servers(&expanded, McpScope::Plugin, &|_| None);
            for warning in warnings {
                tracing::warn!(plugin, warning, "plugin MCP configuration");
            }
            servers.extend(found.into_iter().map(|mut server| {
                if let McpTransportConfig::Stdio { env, .. } = &mut server.transport {
                    for (name, value) in [
                        (vars::CLAUDE_PLUGIN_ROOT, variables.root),
                        (vars::NIBI_PLUGIN_ROOT, variables.root),
                        (vars::ZCODE_PLUGIN_ROOT, variables.root),
                    ] {
                        env.entry(name.to_owned())
                            .or_insert_with(|| value.to_owned());
                    }
                    if let Some(data) = variables.data {
                        for name in [
                            vars::CLAUDE_PLUGIN_DATA,
                            vars::NIBI_PLUGIN_DATA,
                            vars::ZCODE_PLUGIN_DATA,
                        ] {
                            env.entry(name.to_owned())
                                .or_insert_with(|| data.to_owned());
                        }
                    }
                    for (name, value) in [
                        (vars::CLAUDE_PROJECT_DIR, variables.project),
                        (vars::NIBI_PROJECT_DIR, variables.project),
                        (vars::ZCODE_PROJECT_DIR, variables.project),
                    ] {
                        env.entry(name.to_owned())
                            .or_insert_with(|| value.to_owned());
                    }
                    // 插件身份必须由 resolver 权威写入（Node 同规则）：manifest/user env 不能伪造。
                    env.insert(vars::NIBI_PLUGIN_ID.to_owned(), id.to_owned());
                    // Python 插件（数模插件的 MCP 桥）在 Windows 上默认按系统代码页写 stdio，JSON 里的中文
                    // 会变成 cp936 字节，宿主只能按 UTF-8 丢错。Node 的执行环境同样给这两个变量
                    // （`outputEncoding.ts`）；这里给所有插件服务器，非 Python 的进程忽略它们。
                    env.entry("PYTHONIOENCODING".to_owned())
                        .or_insert_with(|| "utf-8".to_owned());
                    env.entry("PYTHONUTF8".to_owned())
                        .or_insert_with(|| "1".to_owned());
                }
                McpServer {
                    name: format!("plugin:{plugin}:{}", server.name),
                    ..server
                }
            }));
        }
        servers
    }

    /// `--plugin-dir` 的插件：manifest 缺失、读不出或没有 `name` 时插件名取目录名。
    async fn session_plugin(&self, dir: &str) -> Option<Plugin> {
        if self.kind(dir).await != Some(FileKind::Directory) {
            tracing::warn!(dir, "plugin directory not found");
            return None;
        }
        let manifest = match self.manifest(dir).await {
            Manifest::Found(value) => value,
            Manifest::Missing => Value::Null,
            Manifest::Invalid(error) => {
                tracing::warn!(dir, error, "plugin manifest is not valid JSON");
                Value::Null
            }
        };
        let name = manifest
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map_or_else(|| base_name(dir), str::to_owned);
        let tables = self.mcp_tables(dir, &manifest).await;
        Some(
            self.components(
                dir,
                name,
                nibi_kernel_base::names::INLINE_MARKETPLACE,
                manifest,
                &tables,
            )
            .await,
        )
    }

    /// `skills/` 与 manifest 声明路径里的 skill 根目录（存在的、去重）。
    async fn skill_dirs(&self, dir: &str, manifest: &Value) -> Vec<String> {
        let mut found = Vec::new();
        for candidate in std::iter::once("skills".to_owned()).chain(paths(manifest.get("skills"))) {
            let path = join(dir, &candidate);
            if self.kind(&path).await == Some(FileKind::Directory) && !found.contains(&path) {
                found.push(path);
            }
        }
        found
    }

    /// `agents/` 与 manifest 声明路径里的 agent 文件（存在的、按路径去重）。
    async fn agent_files(&self, dir: &str, manifest: &Value) -> Vec<PluginAgentFile> {
        let mut found: Vec<PluginAgentFile> = Vec::new();
        for candidate in std::iter::once("agents".to_owned()).chain(paths(manifest.get("agents"))) {
            let path = join(dir, &candidate);
            let files = match self.kind(&path).await {
                Some(FileKind::Directory) => self.markdown(&path).await,
                Some(FileKind::File) if path.to_lowercase().ends_with(".md") => {
                    vec![PluginAgentFile {
                        path,
                        namespace: Vec::new(),
                    }]
                }
                _ => Vec::new(),
            };
            // 同一文件只取一次。
            for file in files {
                if !found.iter().any(|known| known.path == file.path) {
                    found.push(file);
                }
            }
        }
        found
    }

    /// 没加载的候选声明出来的组件名（引用目录里停用条目的能力面）。
    async fn declared(&self, dir: &str, manifest: &Value) -> DeclaredComponents {
        let skill_dirs = self.skill_dirs(dir, manifest).await;
        let agent_files = self.agent_files(dir, manifest).await;
        self.declare(&skill_dirs, &agent_files).await
    }

    /// 插件声明出来的 skill 与 agent 名（引用目录的 `skillQualifiedNames` / `subagentNames`）。
    ///
    /// skill 名取 `skills/` 与 manifest 声明路径下**含 SKILL.md 的子目录名**——与 runtime 的发现口径一致；
    /// agent 名取相对 agents 目录的路径段（`:` 连接），与 runtime 的类型名同形。
    async fn declare(
        &self,
        skill_dirs: &[String],
        agent_files: &[PluginAgentFile],
    ) -> DeclaredComponents {
        let mut skill_names = Vec::new();
        for dir in skill_dirs {
            let request = ListDir {
                path: EnvPath::new(dir.as_str()),
            };
            let Ok(mut entries) = self.files.list_dir(self.workspace, request).await else {
                continue;
            };
            entries.retain(|entry| entry.kind == FileKind::Directory);
            for entry in entries {
                let skill = join(dir, &entry.name);
                let request = StatFile {
                    path: EnvPath::new(join(&skill, "SKILL.md").as_str()),
                };
                let found = self
                    .files
                    .stat(self.workspace, request)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|stat| stat.kind == FileKind::File);
                if found {
                    skill_names.push(entry.name);
                }
            }
        }
        skill_names.sort();
        skill_names.dedup();
        let agent_names = agent_files
            .iter()
            .map(|file| {
                file.namespace
                    .iter()
                    .map(String::as_str)
                    .chain(std::iter::once(stem(&file.path)))
                    .collect::<Vec<_>>()
                    .join(":")
            })
            .collect();
        DeclaredComponents {
            skill_names,
            agent_names,
        }
    }

    /// 插件的组件（ext.md §4.5）。`tables` 是 [`Self::mcp_tables`] 的结果。
    async fn components(
        &self,
        dir: &str,
        name: String,
        marketplace: &str,
        manifest: Value,
        tables: &[Value],
    ) -> Plugin {
        let skill_dirs = self.skill_dirs(dir, &manifest).await;
        let agent_files = self.agent_files(dir, &manifest).await;
        let declared = self.declare(&skill_dirs, &agent_files).await;
        let mut hooks = Vec::new();
        let default_hooks = join(dir, "hooks/hooks.json");
        if self.kind(&default_hooks).await == Some(FileKind::File)
            && let Some(file) = self.json(&default_hooks).await
        {
            hooks.push(file);
        }
        match manifest.get("hooks") {
            // 内联对象是事件表，包成文件的形状（`hooks` 字段）。
            Some(Value::Object(inline)) => {
                hooks.push(serde_json::json!({"hooks": Value::Object(inline.clone())}));
            }
            other => {
                for path in paths(other) {
                    hooks.extend(self.json(&join(dir, &path)).await);
                }
            }
        }
        let id = format!("{name}@{marketplace}");
        let data_path = self
            .data_root
            .map(|root| join(root, &sanitize_plugin_id(&id)));
        let defaults = user_config_defaults(&manifest);
        let variables = Variables {
            root: dir,
            project: self.workspace.root.as_str(),
            data: data_path.as_deref(),
            defaults: &defaults,
            options: self.options.get(&id),
            env: self.env,
            manifest: &manifest,
        };
        let mcp_servers = Self::mcp_servers(&name, &id, &variables, tables);
        Plugin {
            id,
            name,
            marketplace: marketplace.to_owned(),
            dir: dir.to_owned(),
            manifest,
            skill_dirs,
            skill_names: declared.skill_names,
            agent_names: declared.agent_names,
            mcp_servers,
            agent_files,
            hooks,
        }
    }
}

#[cfg(test)]
#[path = "plugins_tests.rs"]
mod tests;

/// 插件清单模板的上下文（Node `VariableContext` 的 Rust 侧）。
struct Variables<'a> {
    root: &'a str,
    project: &'a str,
    data: Option<&'a str>,
    /// manifest `userConfig` 里带默认值的项。
    defaults: &'a BTreeMap<String, Value>,
    /// 合并后的 `plugins.options.<插件 id>`。
    options: Option<&'a BTreeMap<String, Value>>,
    env: &'a BTreeMap<String, String>,
    manifest: &'a Value,
}

impl Variables<'_> {
    /// 该 `user_config.<key>` 是否声明为敏感（Node `userConfig[key].sensitive`）。
    fn sensitive(&self, key: &str) -> bool {
        self.manifest
            .get("userConfig")
            .and_then(|config| config.get(key))
            .and_then(|option| option.get("sensitive"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
}

/// manifest `userConfig` 里可用的默认值（Node `getUserConfigDefaults`：只认标量）。
fn user_config_defaults(manifest: &Value) -> BTreeMap<String, Value> {
    let mut defaults = BTreeMap::new();
    let Some(config) = manifest.get("userConfig").and_then(Value::as_object) else {
        return defaults;
    };
    for (key, option) in config {
        if let Some(value) = option.get("default").filter(|value| scalar_text(value).is_some()) {
            defaults.insert(key.clone(), value.clone());
        }
    }
    defaults
}

/// 标量的字符串形式（Node `String(value)`；只有字符串/数字/布尔算选项值）。
fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// 一个服务器配置的模板展开：`env` / `headers` 是敏感 sink，`oauth.clientSecret` 单独放行。
fn expand_server(config: &Value, variables: &Variables<'_>) -> Result<Value, String> {
    let Some(server) = config.as_object() else {
        return Err("MCP server config must be an object".to_owned());
    };
    let mut out = Map::new();
    for (key, value) in server {
        let expanded = match key.as_str() {
            "env" | "headers" => expand_string_map(value, variables, true)?,
            "oauth" => expand_oauth(value, variables)?,
            _ => expand_value(value, variables, false)?,
        };
        out.insert(key.clone(), expanded);
    }
    Ok(Value::Object(out))
}

fn expand_string_map(
    value: &Value,
    variables: &Variables<'_>,
    allow_sensitive: bool,
) -> Result<Value, String> {
    let Some(map) = value.as_object() else {
        return Ok(value.clone());
    };
    let mut out = Map::new();
    for (key, item) in map {
        let expanded = match item {
            Value::String(text) => Value::String(expand_template(text, variables, allow_sensitive)?),
            other => other.clone(),
        };
        out.insert(key.clone(), expanded);
    }
    Ok(Value::Object(out))
}

fn expand_oauth(value: &Value, variables: &Variables<'_>) -> Result<Value, String> {
    let Some(map) = value.as_object() else {
        return Ok(value.clone());
    };
    let mut out = Map::new();
    for (key, item) in map {
        let expanded = match item {
            Value::String(text) => {
                Value::String(expand_template(text, variables, key == "clientSecret")?)
            }
            other => other.clone(),
        };
        out.insert(key.clone(), expanded);
    }
    Ok(Value::Object(out))
}

fn expand_value(
    value: &Value,
    variables: &Variables<'_>,
    allow_sensitive: bool,
) -> Result<Value, String> {
    match value {
        Value::String(text) => Ok(Value::String(expand_template(
            text,
            variables,
            allow_sensitive,
        )?)),
        Value::Array(items) => items
            .iter()
            .map(|item| expand_value(item, variables, allow_sensitive))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                // 嵌套对象里的 `env` 也是敏感 sink（`.mcp.json` 的服务器表外层已被剥离）。
                let nested_sensitive = matches!(key.as_str(), "env" | "headers");
                out.insert(
                    key.clone(),
                    expand_value(item, variables, allow_sensitive || nested_sensitive)?,
                );
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

/// `${VAR}` 展开（Node `resolveTemplate`）：识别插件根 / 数据目录 / 项目目录 / `user_config.*` /
/// `NIBI_*`；敏感 sink 里再认任意环境变量名；其余名字按原样保留。需要运行时会话或不存在的必需
/// 变量返回错误，调用方按 Node 同一行为整条跳过该服务器。
fn expand_template(
    text: &str,
    variables: &Variables<'_>,
    allow_sensitive: bool,
) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let name = &after[..end];
        match resolve_variable(name, variables, allow_sensitive)? {
            Some(value) => out.push_str(&value),
            None => out.push_str(&rest[start..start + 2 + end + 1]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn resolve_variable(
    name: &str,
    variables: &Variables<'_>,
    allow_sensitive: bool,
) -> Result<Option<String>, String> {
    match name {
        vars::CLAUDE_PLUGIN_ROOT | vars::NIBI_PLUGIN_ROOT | vars::ZCODE_PLUGIN_ROOT => {
            return Ok(Some(variables.root.to_owned()));
        }
        vars::CLAUDE_PLUGIN_DATA | vars::NIBI_PLUGIN_DATA | vars::ZCODE_PLUGIN_DATA => {
            let data = variables
                .data
                .ok_or_else(|| format!("Missing plugin variable: {name}"))?;
            return Ok(Some(data.to_owned()));
        }
        vars::CLAUDE_PROJECT_DIR | vars::NIBI_PROJECT_DIR | vars::ZCODE_PROJECT_DIR => {
            return Ok(Some(variables.project.to_owned()));
        }
        vars::CLAUDE_CODE_SESSION_ID | vars::CLAUDE_SESSION_ID | vars::NIBI_SESSION_ID => {
            return Err(format!(
                "Plugin variable requires a runtime session context: {name}"
            ));
        }
        vars::CLAUDE_SKILL_DIR | vars::NIBI_SKILL_DIR | vars::ZCODE_SKILL_DIR => {
            return Err(format!(
                "Plugin variable requires a skill context: {name}"
            ));
        }
        _ => {}
    }
    if let Some(key) = name.strip_prefix("user_config.") {
        if variables.sensitive(key) && !allow_sensitive {
            return Err(format!(
                "Sensitive plugin user_config value cannot be used in this field: {key}"
            ));
        }
        let configured = variables
            .options
            .and_then(|options| options.get(key))
            .filter(|value| scalar_text(value).is_some());
        let value = configured
            .or_else(|| variables.defaults.get(key))
            .and_then(scalar_text)
            .ok_or_else(|| format!("Missing plugin user_config value: {key}"))?;
        return Ok(Some(value));
    }
    if name.starts_with("NIBI_") || (allow_sensitive && valid_env_name(name)) {
        let value = variables
            .env
            .get(name)
            .cloned()
            .ok_or_else(|| format!("Missing environment variable: {name}"))?;
        return Ok(Some(value));
    }
    Ok(None)
}

/// 环境变量名的形状（Node `enums.ts` 同规则）：敏感 sink 里只认这种名字，避免把 `${1}` 之类当变量。
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

//! 用户自定义斜杠命令（Node `resolveNibiCustomCommandPrompt` / `custom-commands` 的镜像）：
//! `.nibi/commands`、`.agents/commands`、插件 `commands/` 的发现与解析，以及展开。
//!
//! 发现顺序与 Node `resolveDefaultCustomCommandRoots` 一致：用户级根在最前（同名时用户命令盖项目命令），
//! 项目根从 cwd 到 git 根逐层（每层 `.nibi` 先于 `.agents`），然后是附加目录（名字带 `<目录名>/` 前缀），
//! 最后是插件根。命令名取相对根目录的路径、分隔符换成 `:`；文件内 frontmatter 与 Node 同一组安全键。

mod builtin;
mod expand;
mod user;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use nibi_kernel_api::env::{EnvFacts, EnvPath, ReadFile, WorkspaceRef};
use nibi_kernel_api::env_files::{FileKind, ListDir, PathStyle, StatFile};
use nibi_kernel_api::env_git::has_git_marker;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::machine::{EnvInfo, Files};
use nibi_kernel_api::paid_plugin::PaidPluginGate;

use crate::skills::frontmatter::{self, Value as FrontmatterValue};

pub(crate) use expand::{ShellHandOff, hand_off_shell_blocks, prompt, template};
pub use user::CommandSet;
pub(crate) use user::{CUSTOM_COMMAND_SOURCE, parse};

/// 产品目录（`.nibi`）与兼容目录。
const DOT_DIR: &str = nibi_kernel_base::names::DOT_DIR;
const AGENTS_DIR: &str = ".agents";
const COMMANDS_DIR: &str = "commands";
/// Node `MAX_SCAN_DEPTH`。
const MAX_SCAN_DEPTH: usize = 12;
/// Node `DEFAULT_MAX_COMMAND_BYTES`。
const MAX_COMMAND_BYTES: usize = 100_000;
/// Node `MAX_DESCRIPTION_LENGTH`。
const MAX_DESCRIPTION_LENGTH: usize = 1024;

/// Node 的内置斜杠命令保留名（`BUILTIN_NIBI_SLASH_COMMAND_HELP_ENTRIES` + `compress`/`plan`）：
/// 自定义命令不得借同名接管内置语义。
const RESERVED: &[&str] = &[
    "help", "login", "logout", "provider", "compact", "init", "expert", "variant", "effort", "dwf",
    "fork", "language", "locale", "mcp", "plugin", "plugins", "mode", "model", "clear", "new",
    "continue", "resume", "rewind", "skill", "target", "goal", "workflow", "compress", "plan",
];

pub(crate) fn is_reserved(name: &str) -> bool {
    RESERVED.contains(&normalize_name(name).as_str())
}

/// 命令来源（Node `CustomCommandSource`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandSource {
    Agents,
    Nibi,
    Plugin,
}

impl CommandSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agents => "agents",
            Self::Nibi => "nibi",
            Self::Plugin => "plugin",
        }
    }
}

/// 命令作用域（Node `CustomCommandScope`；Rust 侧没有 admin）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandScope {
    Project,
    User,
    System,
}

impl CommandScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::User => "user",
            Self::System => "system",
        }
    }
}

/// 插件命令根携带的身份：`!` 展开的插件变量从它来。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginCommandRoot {
    pub plugin: String,
    /// `<插件>/commands` 一类的目录（执行环境里的路径）。
    pub dir: String,
    /// 插件根目录（`${NIBI_PLUGIN_ROOT}`）。
    pub root: String,
    /// 插件数据目录（`${NIBI_PLUGIN_DATA}`）；没有数据根时 None。
    pub data: Option<String>,
    /// 官方内置插件（Node 的 `source === "official"`）：命令作用域是 system。
    pub official: bool,
}

/// 一条可调用的自定义命令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomCommand {
    /// 调用名（相对根目录的路径；附加目录带 `<目录名>/` 前缀；插件命令不加插件名）。
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub allowed_tools: Vec<String>,
    /// frontmatter `skills:`：展开时要求模型先调 Skill 工具。
    pub skills: Vec<String>,
    pub disable_non_interactive: bool,
    /// frontmatter 之后的正文（已 trim）。
    pub body: String,
    pub path: String,
    pub root: String,
    pub scope: CommandScope,
    pub source: CommandSource,
    pub plugin: Option<PluginCommandRoot>,
}

/// 一个命令根与它的身份。
struct Root {
    dir: String,
    scope: CommandScope,
    source: CommandSource,
    namespace: Option<String>,
    plugin: Option<PluginCommandRoot>,
}

/// 命令目录的发现与展开（`!` 块只改写成 Bash 指令，不在这里执行）。
pub struct CustomCommands {
    info: Arc<dyn EnvInfo>,
    files: Arc<dyn Files>,
    /// 进程级插件命令根（CLI/TUI）；会话级快照覆盖它。
    plugins: Mutex<Vec<PluginCommandRoot>>,
    session_plugins: Mutex<HashMap<SessionId, Vec<PluginCommandRoot>>>,
    /// `command` 配置里 `enable: false` 的 `.md` 路径（Node `collectDisabledPaths`）。
    disabled: RwLock<std::collections::HashSet<String>>,
    paid_gate: RwLock<Option<Arc<dyn PaidPluginGate>>>,
}

impl CustomCommands {
    /// 构造发现器；`info` 给环境事实（cwd、home、平台），`files` 读命令目录。
    pub fn new(info: Arc<dyn EnvInfo>, files: Arc<dyn Files>) -> Self {
        Self {
            info,
            files,
            plugins: Mutex::default(),
            session_plugins: Mutex::default(),
            disabled: RwLock::default(),
            paid_gate: RwLock::default(),
        }
    }

    pub fn set_plugin_roots(&self, roots: Vec<PluginCommandRoot>) {
        *self.plugins.lock().unwrap_or_else(PoisonError::into_inner) = roots;
    }

    pub fn set_session_plugin_roots(&self, session: SessionId, roots: Vec<PluginCommandRoot>) {
        self.session_plugins
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session, roots);
    }

    /// `command` 配置里停用的 `.md` 路径。
    pub fn set_disabled_paths(&self, paths: Vec<String>) {
        *self
            .disabled
            .write()
            .unwrap_or_else(PoisonError::into_inner) = paths.into_iter().collect();
    }

    pub fn clear_session(&self, session: &SessionId) {
        self.session_plugins
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session);
    }

    /// 子代理继承父会话的插件命令根（Node 子代理 app 继承父 app）。
    pub fn copy_session(&self, from: &SessionId, to: SessionId) {
        let roots = self
            .session_plugins
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(from)
            .cloned();
        if let Some(roots) = roots {
            self.set_session_plugin_roots(to, roots);
        }
    }

    pub(crate) fn set_paid_gate(&self, gate: Arc<dyn PaidPluginGate>) {
        *self
            .paid_gate
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Some(gate);
    }

    fn plugin_roots(&self, session: Option<&SessionId>) -> Vec<PluginCommandRoot> {
        let Some(session) = session else {
            return self
                .plugins
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
        };
        self.session_plugins
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .cloned()
            .unwrap_or_else(|| {
                self.plugins
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone()
            })
    }

    /// 检查插件命令的付费门（与 skill 命令同一套执行期门禁）。
    pub(crate) fn check_license(&self, command: &CustomCommand) -> Result<(), String> {
        let Some(plugin) = command.plugin.as_ref().map(|plugin| plugin.plugin.as_str()) else {
            return Ok(());
        };
        let gate = self
            .paid_gate
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        match gate {
            Some(gate) => gate.check(plugin),
            None => Ok(()),
        }
    }

    /// 这一步能看到的命令，按名字排序；同名时按根顺序先到先得。
    pub(crate) async fn discover(
        &self,
        workspace: &WorkspaceRef,
        session: Option<&SessionId>,
    ) -> Vec<CustomCommand> {
        let Ok(facts) = self.info.facts(workspace).await else {
            return Vec::new();
        };
        let style = PathStyle::of_platform(&facts.platform);
        let roots = self
            .roots(workspace, &facts, style, &self.plugin_roots(session))
            .await;
        let mut selected: HashMap<String, CustomCommand> = HashMap::new();
        let disabled = self
            .disabled
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        for root in &roots {
            for path in self.command_files(workspace, style, &root.dir).await {
                let Some(command) = self.parse(workspace, root, &path).await else {
                    continue;
                };
                if disabled.contains(&command.path) {
                    continue;
                }
                selected.entry(command.name.clone()).or_insert(command);
            }
        }
        let mut commands: Vec<CustomCommand> = selected.into_values().collect();
        commands.sort_by(|a, b| a.name.cmp(&b.name));
        commands
    }

    /// 按名字找（名字 trim、去 `/`、小写；与 Node `normalizeCommandName` 相同）。
    pub(crate) async fn find(
        &self,
        workspace: &WorkspaceRef,
        session: Option<&SessionId>,
        name: &str,
    ) -> Option<CustomCommand> {
        let name = normalize_name(name);
        self.discover(workspace, session)
            .await
            .into_iter()
            .find(|command| command.name == name)
    }

    /// 非交互 `nibi commands list` 的只读清单：与 `/` 目录同口径，去掉会被内置斜杠命令
    /// 接管的保留名（Node `listNibiCustomCommands` 的可见集合）。
    pub async fn list(&self, workspace: &WorkspaceRef) -> Vec<CustomCommand> {
        self.discover(workspace, None)
            .await
            .into_iter()
            .filter(|command| !is_reserved(&command.name))
            .collect()
    }

    /// 非交互 `nibi commands inspect <name>`：按名字找，保留名同样不列出。
    pub async fn inspect(&self, workspace: &WorkspaceRef, name: &str) -> Option<CustomCommand> {
        let command = self.find(workspace, None, name).await?;
        (!is_reserved(&command.name)).then_some(command)
    }

    async fn roots(
        &self,
        workspace: &WorkspaceRef,
        facts: &EnvFacts,
        style: PathStyle,
        plugins: &[PluginCommandRoot],
    ) -> Vec<Root> {
        let mut roots = Vec::new();
        if let Some(home) = &facts.home {
            push_base_roots(&mut roots, style, home.as_str(), CommandScope::User);
        }
        for directory in self.project_directories(workspace, facts, style).await {
            push_base_roots(&mut roots, style, &directory, CommandScope::Project);
        }
        for directory in &facts.additional_directories {
            if style.same(directory.as_str(), facts.cwd.as_str()) {
                continue;
            }
            let start = roots.len();
            push_base_roots(&mut roots, style, directory.as_str(), CommandScope::Project);
            let namespace = style.file_name(directory.as_str()).to_lowercase();
            for root in &mut roots[start..] {
                root.namespace = Some(namespace.clone());
            }
        }
        for plugin in plugins {
            roots.push(Root {
                dir: plugin.dir.clone(),
                scope: if plugin.official {
                    CommandScope::System
                } else {
                    CommandScope::User
                },
                source: CommandSource::Plugin,
                namespace: None,
                plugin: Some(plugin.clone()),
            });
        }
        roots
    }

    /// Node `resolveProjectDirectories`：cwd 向上到 git 根；没有 git 根时只算 cwd。
    async fn project_directories(
        &self,
        workspace: &WorkspaceRef,
        facts: &EnvFacts,
        style: PathStyle,
    ) -> Vec<String> {
        let cwd = facts.cwd.as_str().to_owned();
        let mut directories = Vec::new();
        let mut current = Some(cwd.clone());
        let mut found_root = false;
        while let Some(directory) = current {
            let marker = style.join(&directory, &[".git"]);
            if has_git_marker(self.files.as_ref(), workspace, &marker).await {
                directories.push(directory);
                found_root = true;
                break;
            }
            directories.push(directory.clone());
            let parent = style.parent(&directory);
            if parent.as_deref() == Some(directory.as_str()) {
                break;
            }
            current = parent;
        }
        if found_root { directories } else { vec![cwd] }
    }

    async fn command_files(
        &self,
        workspace: &WorkspaceRef,
        style: PathStyle,
        dir: &str,
    ) -> Vec<String> {
        let mut found = Vec::new();
        self.scan(workspace, style, dir, 0, &mut found).await;
        found
    }

    async fn scan(
        &self,
        workspace: &WorkspaceRef,
        style: PathStyle,
        dir: &str,
        depth: usize,
        found: &mut Vec<String>,
    ) {
        if depth > MAX_SCAN_DEPTH {
            return;
        }
        let request = ListDir {
            path: EnvPath::new(dir),
        };
        let Ok(entries) = self.files.list_dir(workspace, request).await else {
            return;
        };
        for entry in entries {
            let path = style.join(dir, &[&entry.name]);
            match entry.kind {
                FileKind::Directory => {
                    Box::pin(self.scan(workspace, style, &path, depth + 1, found)).await;
                }
                FileKind::File if entry.name.to_lowercase().ends_with(".md") => found.push(path),
                _ => {}
            }
        }
    }

    async fn parse(
        &self,
        workspace: &WorkspaceRef,
        root: &Root,
        path: &str,
    ) -> Option<CustomCommand> {
        let request = StatFile {
            path: EnvPath::new(path),
        };
        let stat = self.files.stat(workspace, request).await.ok().flatten()?;
        if stat.kind != FileKind::File {
            return None;
        }
        let request = ReadFile {
            path: EnvPath::new(path),
        };
        let content = self.files.read_file(workspace, request).await.ok()?;
        let bytes = if content.bytes.len() > MAX_COMMAND_BYTES {
            &content.bytes[..MAX_COMMAND_BYTES]
        } else {
            &content.bytes[..]
        };
        let raw = String::from_utf8_lossy(bytes);
        let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
        let (values, body) =
            frontmatter::split(raw).unwrap_or_else(|| (Default::default(), raw.to_owned()));

        let name = command_name(&root.dir, path)?;
        let name = match &root.namespace {
            Some(namespace) => format!("{namespace}/{name}"),
            None => name,
        };
        let description = scalar(values.get("description"))
            .or_else(|| first_line(&body))
            .map(|value| truncate(&value, MAX_DESCRIPTION_LENGTH))
            .filter(|value| !value.is_empty())?;

        Some(CustomCommand {
            name,
            description,
            argument_hint: scalar(values.get("argument-hint")),
            allowed_tools: list(values.get("allowed-tools")),
            skills: list(values.get("skills")),
            disable_non_interactive: scalar(values.get("disable-noninteractive"))
                .is_some_and(|value| matches!(value.to_lowercase().as_str(), "true" | "yes")),
            body: body.trim().to_owned(),
            path: path.to_owned(),
            root: root.dir.clone(),
            scope: root.scope,
            source: root.source,
            plugin: root.plugin.clone(),
        })
    }
}

fn push_base_roots(roots: &mut Vec<Root>, style: PathStyle, base: &str, scope: CommandScope) {
    for (directory, source) in [
        (DOT_DIR, CommandSource::Nibi),
        (AGENTS_DIR, CommandSource::Agents),
    ] {
        roots.push(Root {
            dir: style.join(base, &[directory, COMMANDS_DIR]),
            scope,
            source,
            namespace: None,
            plugin: None,
        });
    }
}

/// 相对根目录的命令名：去掉 `.md`，分隔符换成 `:`，小写。
fn command_name(root: &str, path: &str) -> Option<String> {
    let root = root.trim_end_matches(['/', '\\']);
    if path.len() <= root.len() || !path.starts_with(root) {
        return None;
    }
    let relative = path[root.len()..].trim_start_matches(['/', '\\']);
    if !relative.to_lowercase().ends_with(".md") {
        return None;
    }
    let without = &relative[..relative.len() - 3];
    let name = without.replace(['/', '\\'], ":").to_lowercase();
    valid_name(&name).then_some(name)
}

/// Node `COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,63}$/`（只校验根目录内的名字，不含 namespace）。
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    let rest = chars.collect::<Vec<_>>();
    rest.len() <= 63
        && rest
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | ':' | '-'))
}

fn normalize_name(name: &str) -> String {
    name.trim().trim_start_matches('/').to_lowercase()
}

fn scalar(value: Option<&FrontmatterValue>) -> Option<String> {
    value
        .and_then(FrontmatterValue::text)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn list(value: Option<&FrontmatterValue>) -> Vec<String> {
    let items: Vec<String> = match value {
        Some(FrontmatterValue::Text(text)) => text.split(',').map(str::to_owned).collect(),
        Some(FrontmatterValue::List(items)) => items.clone(),
        None => Vec::new(),
    };
    items
        .into_iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}

/// 没有 `description` 时取正文第一个非空行（去掉 markdown 的标题/列表前缀）。
fn first_line(body: &str) -> Option<String> {
    body.lines()
        .map(|line| {
            line.trim()
                .trim_start_matches('#')
                .trim_start_matches(['-', '*'])
                .trim()
        })
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    value.chars().take(max).collect()
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

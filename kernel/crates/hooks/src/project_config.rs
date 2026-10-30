//! 项目级配置文件的发现与读取（docs/specs/rust-cli/config.md §1；Node `discoverWorkspaceHookConfigPaths`）。
//!
//! 2026-10-30 从 `crates/cli/src/config/files.rs` 下沉到这里：协议前端（钩子评审）与 runtime 也要用同一套
//! 发现逻辑，不能只留在二进制里。cli 留一层同名薄壳，调用点不变。
//!
//! 工作区里的文件经执行环境端口读（README §4）：从工作区根向上找第一个含 `.git`（目录或文件）的目录，
//! 从那一层到工作区根，每层依次 `zcode.json`、`.nibi/config.json`；一路都没有 `.git` 时只看工作区根。
//! 存在的文件按顺序编号（读坏的文件也占序号，Node 的 `discoveryOrder`）。

use rust_cli_base::names::{PROJECT_CONFIG_FILE, PROJECT_DOT_DIR};
use rust_cli_kernel_api::env::{EnvPath, ReadFile, WorkspaceRef};
use rust_cli_kernel_api::env_files::{PathStyle, StatFile};
use rust_cli_kernel_api::env_git::has_git_marker;
use rust_cli_kernel_api::machine::Files;
use rust_cli_platform::ConfigFile;

/// 每一层的 `zcode.json`（F55：以前写了 3 次；F58 起名字在 base，policy 的敏感文件表也用它）。
const ZCODE_JSON: &str = PROJECT_CONFIG_FILE;
/// 每一层 `.nibi/` 下的配置文件名。
const CONFIG_JSON: &str = "config.json";
/// 种类的名字 `.nibi/config.json`（进 digest）：与 Node `WorkspaceHookConfigFileKind` 同字面。
/// 可编辑的项目配置（NIBI 的 `editable` 来源，也是钩子评审就地改写的目标）。
pub const DOT_PROJECT_CONFIG: &str = concat!(".nibi", "/config.json");

/// 项目文件的种类（Node `WorkspaceHookConfigFileKind`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectKind {
    ZcodeJson,
    DotProjectConfig,
}

impl ProjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ZcodeJson => ZCODE_JSON,
            Self::DotProjectConfig => DOT_PROJECT_CONFIG,
        }
    }
}

/// 一个存在的项目文件。
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectFile {
    pub path: String,
    pub kind: ProjectKind,
    /// 在发现列表里的序号。
    pub order: usize,
    /// 是否是 `<工作区根>/.nibi/config.json`（Node `editable`）。
    pub editable: bool,
    pub file: ConfigFile,
}

/// 工作区路径的拼接（Node `path.join`）：风格按工作区根的写法推断，规则是 kernel-api `env_path`
/// （R1-9：以前自己判断分隔符、自己找上一层）。
fn join(base: &str, name: &str) -> String {
    PathStyle::infer(base).join(base, &[name])
}

struct Reader<'a> {
    files: &'a dyn Files,
    workspace: &'a WorkspaceRef,
}

impl Reader<'_> {
    async fn exists(&self, path: &str) -> bool {
        let request = StatFile {
            path: EnvPath::new(path),
        };
        matches!(self.files.stat(self.workspace, request).await, Ok(Some(_)))
    }

    async fn read(&self, path: &str) -> ConfigFile {
        let request = ReadFile {
            path: EnvPath::new(path),
        };
        match self.files.read_file(self.workspace, request).await {
            Ok(content) => ConfigFile::parse(&content.bytes),
            Err(error) => ConfigFile::Invalid {
                reason: error.to_string(),
            },
        }
    }

    /// 从工作区根到含 `.git` 的那一层（含），自上而下；没有 `.git` 时只有工作区根。
    ///
    /// 缺陷修复（F58）：以前 `.git` 是任何种类都算；Node `hasWorktreeMarker` 只认目录与文件，FIFO 等别的种类继续
    /// 往上。判定改用 kernel-api 的 `has_git_marker`（唯一定义）。
    async fn levels(&self) -> Vec<String> {
        let root = self.workspace.root.as_str().to_owned();
        let mut levels = vec![root.clone()];
        let mut current = root.clone();
        loop {
            if has_git_marker(self.files, self.workspace, &join(&current, ".git")).await {
                levels.reverse();
                return levels;
            }
            match PathStyle::infer(&current).parent(&current) {
                Some(up) => {
                    levels.push(up.clone());
                    current = up;
                }
                None => return vec![root],
            }
        }
    }
}

/// 工作区根下发现的一个文件：种类按文件名，`editable` 按是否是 `<根>/.nibi/config.json`（Node
/// `createWorkspaceHookSourceInput`）。
pub fn project_file(
    root: &str,
    path: String,
    order: usize,
    file: ConfigFile,
) -> ProjectFile {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(&path);
    let kind = if name == ZCODE_JSON {
        ProjectKind::ZcodeJson
    } else {
        ProjectKind::DotProjectConfig
    };
    ProjectFile {
        editable: path == join(&join(root, PROJECT_DOT_DIR), CONFIG_JSON),
        path,
        kind,
        order,
        file,
    }
}

/// 发现并读取项目级配置文件，按发现顺序。
pub async fn discover(files: &dyn Files, workspace: &WorkspaceRef) -> Vec<ProjectFile> {
    let reader = Reader { files, workspace };
    let root = workspace.root.as_str();
    let mut files = Vec::new();
    for level in reader.levels().await {
        for path in [
            join(&level, ZCODE_JSON),
            join(&join(&level, PROJECT_DOT_DIR), CONFIG_JSON),
        ] {
            if !reader.exists(&path).await {
                continue;
            }
            let file = reader.read(&path).await;
            files.push(project_file(root, path, files.len(), file));
        }
    }
    files
}

/// 相对工作区根的路径，分隔符写成 `/`；为空时取文件名（Node `normalizeRelativeSourcePath`）。
pub fn relative(workspace: &str, path: &str) -> String {
    let parts = |text: &str| -> Vec<String> {
        text.split(['/', '\\'])
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let (base, target) = (parts(workspace), parts(path));
    let common = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
    let mut out: Vec<String> = vec!["..".to_owned(); base.len() - common];
    out.extend(target[common..].iter().cloned());
    let joined = out.join("/");
    if joined.is_empty() {
        PathStyle::infer(workspace).file_name(path)
    } else {
        joined
    }
}

#[cfg(test)]
#[path = "project_config_tests.rs"]
mod tests;

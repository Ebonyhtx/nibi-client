//! NIBI 数据根与派生路径。
//!
//! 口径与 Node 侧一致（`apps/nibi-cli/packages/adapters/src/cli-storage-root.ts`、
//! `desktopRuntimeEnv.ts`、`shared-credentials.ts`）：
//!
//! - `NIBI_DATA_BASE_DIR` 管 `<base>/.nibi/v2/...`（凭据、provider、settings）；
//! - `NIBI_STORAGE_DIR` 管 `<root>/cli/...`（会话库、rollout、插件、日志）；
//! - `NIBI_SETTINGS_DIR` 只覆盖 settings 目录（默认与 `<base>/.nibi/v2` 相同）；
//! - 两者是独立的根，都要设；只设一个会在隔离运行里写错实例（Node 侧有过实测事故）。
//!
//! 本模块只算路径，不创建目录、不读文件。

use std::path::{Path, PathBuf};

pub const DOT_DIR: &str = ".nibi";
pub const CLI_DIR: &str = "cli";
pub const CONFIG_ROOT: &str = "v2";
pub const MACHINE_DIR: &str = "machine";
pub const CREDENTIAL_KEY_FILE: &str = "credential-v2.key";
pub const CREDENTIALS_FILE: &str = "credentials.json";
pub const SESSION_DB: &str = "cli/db/db.sqlite";
pub const CLI_CONFIG: &str = "cli/config.json";
pub const AGENT_BINARY: &str = "nibi-agent";

pub const ENV_DATA_BASE_DIR: &str = "NIBI_DATA_BASE_DIR";
pub const ENV_STORAGE_DIR: &str = "NIBI_STORAGE_DIR";
pub const ENV_SETTINGS_DIR: &str = "NIBI_SETTINGS_DIR";
pub const ENV_CREDENTIAL_SECRET: &str = "NIBI_CREDENTIAL_SECRET";

/// 解析后的 NIBI 本机路径。全部是绝对路径（`home` 由调用方给出）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NibiPaths {
    home: PathBuf,
    data_base: PathBuf,
    storage_root: PathBuf,
    settings_root: PathBuf,
}

impl NibiPaths {
    /// `get(name)` 返回已 trim 的空字符串时按未设置处理；`~` 只展开到给定 home。
    pub fn resolve(home: &Path, get: impl Fn(&str) -> Option<String>) -> Self {
        let home = home.to_path_buf();
        let read = |name: &str| {
            get(name)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .map(|value| expand_home(&value, &home))
        };
        let data_base = read(ENV_DATA_BASE_DIR).unwrap_or_else(|| home.clone());
        let storage_root = read(ENV_STORAGE_DIR).unwrap_or_else(|| user_path(&home, ""));
        let settings_root =
            read(ENV_SETTINGS_DIR).unwrap_or_else(|| data_base.join(DOT_DIR).join(CONFIG_ROOT));
        Self {
            home,
            data_base,
            storage_root,
            settings_root,
        }
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// `<dataBaseDir>`：`.nibi/v2` 的父目录。
    pub fn data_base(&self) -> &Path {
        &self.data_base
    }

    /// 存储根（等价于 Node 的 `~/.nibi`，不是 `cli` 子目录）。
    pub fn storage_root(&self) -> &Path {
        &self.storage_root
    }

    pub fn settings_root(&self) -> &Path {
        &self.settings_root
    }

    pub fn credentials(&self) -> PathBuf {
        self.data_base
            .join(DOT_DIR)
            .join(CONFIG_ROOT)
            .join(CREDENTIALS_FILE)
    }

    /// 与 [`Self::credentials`] 配套的 per-install 钥匙；标准布局在 `v2/` 之外。
    /// 非标准布局（凭据文件不在 `v2` 下）落到同目录，行为与 Node 的
    /// `resolveInstallKeyPathForCredentialsFile` 一致。
    pub fn credential_install_key(&self) -> PathBuf {
        install_key_path_for(&self.credentials())
    }

    pub fn session_database(&self) -> PathBuf {
        self.storage_root.join(SESSION_DB)
    }

    pub fn cli_config(&self) -> PathBuf {
        self.storage_root.join(CLI_CONFIG)
    }

    /// `<storageRoot>/cli`（Node `resolveCliRoot`）。
    pub fn cli_root(&self) -> PathBuf {
        self.storage_root.join(CLI_DIR)
    }
}

/// 默认的 `~/.nibi` 用户根。
pub fn user_path(home: &Path, rest: &str) -> PathBuf {
    if rest.is_empty() {
        home.join(DOT_DIR)
    } else {
        home.join(format!("{DOT_DIR}/{rest}"))
    }
}

/// 只展开 `~` 与 `~/...`；其余相对路径按调用方给定的 base 解析（与 Node 的
/// `resolveConfigPath` 同口径）。本模块把相对路径解析到 `home`。
pub fn expand_home(value: &str, home: &Path) -> PathBuf {
    if value == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.join(rest);
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        home.join(path)
    }
}

/// Node `resolveInstallKeyPathForCredentialsFile` 的逐行移植。
pub fn install_key_path_for(credentials: &Path) -> PathBuf {
    let parent = credentials.parent().unwrap_or_else(|| Path::new(""));
    if parent.file_name().and_then(|name| name.to_str()) == Some(CONFIG_ROOT) {
        return parent
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(MACHINE_DIR)
            .join(CREDENTIAL_KEY_FILE);
    }
    parent.join(CREDENTIAL_KEY_FILE)
}

/// 进程名：Windows 带 `.exe`，其余平台不带。
pub fn agent_executable_name() -> &'static str {
    if cfg!(windows) {
        "nibi-agent.exe"
    } else {
        AGENT_BINARY
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn paths(home: &str, env: &[(&str, &str)]) -> NibiPaths {
        let map: BTreeMap<String, String> = env
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        NibiPaths::resolve(Path::new(home), |name| map.get(name).cloned())
    }

    #[test]
    fn defaults_match_node_layout() {
        // 平台中立的家目录：POSIX 与 Windows 都按「相对于 home 的布局」断言，
        // 不把盘符写进夹具（Linux 上 `C:/…` 是相对路径，join 语义会翻转——CI 首跑踩过）。
        let dir = tempfile::TempDir::new().expect("temp dir");
        let home = dir.path().join("home");
        let resolved = paths(home.to_str().expect("utf-8 home"), &[]);
        assert_eq!(resolved.data_base(), &home);
        assert_eq!(resolved.storage_root(), &home.join(".nibi"));
        assert_eq!(resolved.settings_root(), &home.join(".nibi/v2"));
        assert_eq!(
            resolved.credentials(),
            home.join(".nibi/v2/credentials.json")
        );
        assert_eq!(
            resolved.credential_install_key(),
            home.join(".nibi/machine/credential-v2.key")
        );
        assert_eq!(
            resolved.session_database(),
            home.join(".nibi/cli/db/db.sqlite")
        );
        assert_eq!(resolved.cli_root(), home.join(".nibi/cli"));
    }

    #[test]
    fn data_base_and_storage_root_are_independent() {
        // 三个 env 覆盖各自独立、凭据/钥匙从 data_base 派生——断言关系而不是
        // 字面路径（夹具用临时目录，两个平台 join 语义一致）。
        let dir = tempfile::TempDir::new().expect("temp dir");
        let base = dir.path().join("data");
        let store = dir.path().join("store");
        let settings = dir.path().join("settings");
        let home = dir.path().join("home");
        let resolved = paths(
            home.to_str().expect("utf-8 home"),
            &[
                (ENV_DATA_BASE_DIR, base.to_str().expect("utf-8 base")),
                (ENV_STORAGE_DIR, store.to_str().expect("utf-8 store")),
                (
                    ENV_SETTINGS_DIR,
                    settings.to_str().expect("utf-8 settings"),
                ),
            ],
        );
        assert_eq!(resolved.data_base(), &base);
        assert_eq!(resolved.storage_root(), &store);
        assert_eq!(resolved.settings_root(), &settings);
        assert_eq!(
            resolved.credentials(),
            base.join(".nibi/v2/credentials.json")
        );
        assert_eq!(
            resolved.credential_install_key(),
            base.join(".nibi/machine/credential-v2.key")
        );
        assert_eq!(
            resolved.session_database(),
            // NIBI_STORAGE_DIR 的覆盖值就是 .nibi 根本身（不再追加 .nibi 段）。
            store.join("cli/db/db.sqlite")
        );
    }

    #[test]
    fn expands_only_leading_tilde() {
        let home = Path::new("/home/nibi");
        assert_eq!(expand_home("~", home), PathBuf::from("/home/nibi"));
        assert_eq!(
            expand_home("~/store", home),
            PathBuf::from("/home/nibi/store")
        );
        assert_eq!(expand_home("/abs/store", home), PathBuf::from("/abs/store"));
        assert_eq!(expand_home("relative", home), home.join("relative"));
        assert_eq!(expand_home("~/a/~b", home), home.join("a/~b"));
    }

    #[test]
    fn non_standard_credentials_put_key_beside_file() {
        assert_eq!(
            install_key_path_for(Path::new("/tmp/creds/credentials.json")),
            PathBuf::from("/tmp/creds/credential-v2.key")
        );
        assert_eq!(
            install_key_path_for(Path::new("/tmp/.nibi/v2/credentials.json")),
            PathBuf::from("/tmp/.nibi/machine/credential-v2.key")
        );
    }

    #[test]
    fn blank_env_values_fall_back_to_defaults() {
        let resolved = paths(
            "C:/Users/ebony",
            &[(ENV_DATA_BASE_DIR, "  "), (ENV_STORAGE_DIR, "")],
        );
        assert_eq!(resolved.data_base(), Path::new("C:/Users/ebony"));
        assert_eq!(resolved.storage_root(), Path::new("C:/Users/ebony/.nibi"));
    }
}

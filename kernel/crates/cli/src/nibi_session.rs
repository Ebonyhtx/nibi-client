//! NIBI 账号会话：Device Flow 登录写出的键（与 Node `auth-nibi-login.ts` 的 `persistNibiSession`、
//! `logoutNibiAccount`、`ensureDeviceId`、`syncNibiLicense` 逐键对齐）。
//!
//! 文件就是共享的 `<dataBase>/.nibi/v2/credentials.json`：读认 `enc:v1:`/`enc:v2:` 与明文（dev 注入），
//! **写一律 `enc:v2:`**（每安装随机钥匙，见 `nibi-platform::credentials`）；写盘在 Node 同形的目录锁内
//! 读改写、原子写回，并顺手把能解开的 `enc:v1:` 值惰性迁移成 v2。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use nibi_kernel_fs::{FileMode, LockOptions, ParentDir, TempName, WriteOptions};
use nibi_platform::credentials::{CredentialCipher, is_encrypted_value, is_legacy_encrypted_value};
use nibi_platform::device_flow::{TokenSet, UserProfile};
use serde_json::{Value, json};

/// Node `NIBI_PROVIDER_ID`。
pub const NIBI_PROVIDER_ID: &str = "nibi";
pub const ACCESS_TOKEN_KEY: &str = "oauth:nibi:access_token";
pub const REFRESH_TOKEN_KEY: &str = "oauth:nibi:refresh_token";
pub const USER_INFO_KEY: &str = "oauth:nibi:user_info";
pub const ACTIVE_PROVIDER_KEY: &str = "oauth:active_provider";
pub const DEVICE_ID_KEY: &str = "nibi:device:id";
pub const LICENSE_TOKEN_KEY: &str = "nibi:license:token";
pub const LICENSE_STATE_KEY: &str = "nibi:license:state";

/// 退出时清掉的键（Node 的顺序）。
pub const CLEARED_KEYS: [&str; 5] = [
    ACCESS_TOKEN_KEY,
    REFRESH_TOKEN_KEY,
    USER_INFO_KEY,
    LICENSE_TOKEN_KEY,
    LICENSE_STATE_KEY,
];

const PRIVATE_WRITE: WriteOptions = WriteOptions {
    mode: FileMode::Private,
    temp_name: TempName::Hidden,
    parent: ParentDir::Create,
    rename_retry: nibi_kernel_fs::NODE_RENAME_RETRY,
};

/// 共享凭据文件的读写。
pub struct Store {
    file: PathBuf,
    cipher: CredentialCipher,
}

impl Store {
    pub fn open(file: impl Into<PathBuf>, get_env: impl Fn(&str) -> Option<String>) -> Self {
        let file = file.into();
        let cipher = CredentialCipher::from_env(&file, get_env);
        Self { file, cipher }
    }

    pub fn path(&self) -> &Path {
        &self.file
    }

    /// 解密后的整份记录（读不出来按空）。
    pub fn record(&self) -> BTreeMap<String, String> {
        let raw = match std::fs::read_to_string(&self.file) {
            Ok(raw) => raw,
            Err(_) => return BTreeMap::new(),
        };
        let Ok(Value::Object(map)) = serde_json::from_str(&raw) else {
            return BTreeMap::new();
        };
        map.into_iter()
            .filter_map(|(key, value)| {
                let value = value.as_str()?.trim();
                (!value.is_empty()).then(|| (key, self.decrypt(value).unwrap_or_default()))
            })
            .collect()
    }

    pub fn load(&self, key: &str) -> Option<String> {
        self.record()
            .get(key)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    }

    fn decrypt(&self, value: &str) -> Option<String> {
        if is_encrypted_value(value) || is_legacy_encrypted_value(value) {
            self.cipher.decrypt(value).ok()
        } else {
            Some(value.to_owned())
        }
    }

    /// 读改写：`None` 删键，`Some` 用 v2 加密写入；其他键（含别的进程写的）原样保留。
    pub async fn save_many(&self, entries: &[(&str, Option<String>)]) -> Result<(), String> {
        let file = self.file.as_path();
        let cipher = &self.cipher;
        if let Some(parent) = file.parent().filter(|path| !path.as_os_str().is_empty()) {
            nibi_kernel_fs::create_private_dir_all(parent)
                .await
                .map_err(io_error)?;
        }
        let lock = nibi_kernel_fs::acquire_file_lock(file, &LockOptions::default())
            .await
            .map_err(io_error)?;
        let result = async {
            let raw = nibi_kernel_fs::read_optional(file)
                .await
                .map_err(io_error)?
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_else(|| "{}".to_owned());
            let mut map: BTreeMap<String, Value> = match serde_json::from_str(&raw) {
                Ok(Value::Object(map)) => map.into_iter().collect(),
                // 损坏的凭据文件不静默覆盖：登录失败比丢光其他键好。
                _ if raw.trim() != "{}" => {
                    return Err(format!("凭据文件无法解析：{}", file.display()));
                }
                _ => BTreeMap::new(),
            };
            let existing: Vec<(String, String)> = map
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect();
            for (key, text) in existing {
                if !is_legacy_encrypted_value(&text) {
                    continue;
                }
                if let Ok(plain) = cipher.decrypt(&text)
                    && let Ok(encrypted) = cipher.encrypt(&plain)
                {
                    map.insert(key, json!(encrypted));
                }
            }
            for (key, value) in entries {
                match value {
                    Some(text) => {
                        let encrypted = cipher.encrypt(text).map_err(|error| error.to_string())?;
                        map.insert((*key).to_owned(), json!(encrypted));
                    }
                    None => {
                        map.remove(*key);
                    }
                }
            }
            let bytes = serde_json::to_vec(&Value::Object(map.into_iter().collect()))
                .map_err(|error| error.to_string())?;
            nibi_kernel_fs::atomic_write(file, &bytes, PRIVATE_WRITE)
                .await
                .map_err(io_error)
        }
        .await;
        lock.release().await;
        result
    }

    /// 只在 `active_provider` 还是 `nibi` 时才删（别的 provider 的登录态不归这次登出）。
    pub async fn clear_account(&self) -> Vec<String> {
        let mut entries: Vec<(&str, Option<String>)> =
            CLEARED_KEYS.iter().map(|key| (*key, None)).collect();
        if self.load(ACTIVE_PROVIDER_KEY).as_deref() == Some(NIBI_PROVIDER_ID) {
            entries.push((ACTIVE_PROVIDER_KEY, None));
        }
        if let Err(error) = self.save_many(&entries).await {
            tracing::warn!(event = "nibi.login.logout_failed", error = %error, "clearing the account failed");
        }
        entries
            .into_iter()
            .map(|(key, _)| key.to_owned())
            .collect()
    }

    /// 设备标识（Node `ensureDeviceId`）：已有且长度合法就复用，否则生成一个 UUID。
    pub async fn ensure_device_id(&self) -> Result<String, String> {
        if let Some(existing) = self.load(DEVICE_ID_KEY) {
            let existing = existing.trim().to_owned();
            if (8..=128).contains(&existing.len()) {
                return Ok(existing);
            }
        }
        let created = uuid::Uuid::new_v4().to_string();
        self.save_many(&[(DEVICE_ID_KEY, Some(created.clone()))])
            .await?;
        Ok(created)
    }
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}

/// `persistNibiSession`：access token、active provider、用户资料与（有的）refresh token 一起写；
/// 没有 refresh token 时把旧的那个删掉。
pub async fn save_session(
    store: &Store,
    token: &TokenSet,
    user: &UserProfile,
) -> Result<(), String> {
    store
        .save_many(&[
            (ACCESS_TOKEN_KEY, Some(token.access_token.clone())),
            (ACTIVE_PROVIDER_KEY, Some(NIBI_PROVIDER_ID.to_owned())),
            (USER_INFO_KEY, Some(user_info_value(user).to_string())),
            (REFRESH_TOKEN_KEY, token.refresh_token.clone()),
        ])
        .await
}

/// Node `persistNibiSession` 写的 `user_info`（键序：avatarUrl/email/id/name/preferredUsername/rawProfile）。
pub fn user_info_value(user: &UserProfile) -> Value {
    let mut value = serde_json::Map::new();
    for (key, text) in [
        ("avatarUrl", user.avatar_url.as_deref()),
        ("email", user.email.as_deref()),
        ("id", Some(user.id.as_str())),
        ("name", user.name.as_deref()),
        ("preferredUsername", user.preferred_username.as_deref()),
    ] {
        if let Some(text) = text {
            value.insert(key.to_owned(), json!(text));
        }
    }
    value.insert("rawProfile".to_owned(), user.raw_profile.clone());
    Value::Object(value)
}

/// 会员状态（Node `syncNibiLicense` 的写回）。
pub struct LicenseOutcome {
    pub membership: Option<Value>,
    pub license_expires_at: Option<String>,
    pub warnings: Vec<String>,
}

/// `POST {api}/licenses/check` 的地址与头（Node `syncNibiLicense`）。
pub fn license_request(
    api_base_url: &str,
    access_token: &str,
) -> (String, Vec<(String, String)>) {
    (
        format!("{}/licenses/check", api_base_url.trim_end_matches('/')),
        vec![
            ("Authorization".to_owned(), format!("Bearer {access_token}")),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ],
    )
}

pub fn license_body(device_id: &str) -> Value {
    json!({
        "deviceId": device_id,
        "deviceName": "NIBI CLI",
        "platform": node_platform(std::env::consts::OS),
    })
}

/// Node `process.platform` 的取值。
pub fn node_platform(os: &str) -> &'static str {
    match os {
        "windows" => "win32",
        "macos" => "darwin",
        _ => "linux",
    }
}

/// 200 + `authorized: true` + token：写 license 与状态快照。
pub fn authorized_license(
    store_writes: &mut Vec<(&'static str, Option<String>)>,
    body: &Value,
    device_id: &str,
    now_ms: u64,
) {
    let membership = body.get("membership").cloned();
    let plan = membership
        .as_ref()
        .and_then(|value| value.get("plan"))
        .cloned();
    let expires = body
        .get("license")
        .and_then(|license| license.get("expiresAt"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty());
    let token = body
        .get("license")
        .and_then(|license| license.get("token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    store_writes.push((LICENSE_TOKEN_KEY, token));
    store_writes.push((
        LICENSE_STATE_KEY,
        Some(
            json!({
                "deviceId": device_id,
                "expiresAt": expires,
                "lastCheckAt": nibi_kernel_base::js::iso_timestamp(now_ms),
                "lastRefusal": Value::Null,
                "plan": plan,
            })
            .to_string(),
        ),
    ));
}

/// `authorized: false`：只写拒绝快照（插件门禁据此拒绝）。
pub fn refused_license(
    store_writes: &mut Vec<(&'static str, Option<String>)>,
    body: &Value,
    device_id: &str,
    now_ms: u64,
) {
    let membership = body.get("membership");
    let refusal = body
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("no_membership");
    let expires = membership
        .and_then(|value| value.get("expiresAt"))
        .cloned()
        .unwrap_or(Value::Null);
    store_writes.push((
        LICENSE_STATE_KEY,
        Some(
            json!({
                "deviceId": device_id,
                "expiresAt": expires,
                "lastCheckAt": nibi_kernel_base::js::iso_timestamp(now_ms),
                "lastRefusal": refusal,
                "plan": Value::Null,
            })
            .to_string(),
        ),
    ));
}

/// 会员状态的展示（Node `formatMembership`）。
pub fn format_membership(membership: Option<&Value>, license_expires_at: Option<&str>) -> String {
    let Some(membership) = membership else {
        return "Membership: unknown (will retry on the next login or desktop launch)".to_owned();
    };
    match membership.get("status").and_then(Value::as_str) {
        Some("active") => {
            let plan = membership
                .get("plan")
                .and_then(Value::as_str)
                .unwrap_or("member");
            let expires = membership
                .get("expiresAt")
                .and_then(Value::as_str)
                .or(license_expires_at);
            match expires {
                Some(expires) => format!("Membership: {plan} (active until {})", format_date(expires)),
                None => format!("Membership: {plan}"),
            }
        }
        Some("expired") => "Membership: expired (member-only plugins stay locked)".to_owned(),
        _ => "Membership: none (member-only plugins stay locked)".to_owned(),
    }
}

/// `formatDate`：能解析就取日期部分（`YYYY-MM-DD`），否则原样。
pub fn format_date(value: &str) -> String {
    // ISO 8601 的前 10 个字符就是日期；Node 走 `new Date().toISOString()` 得到同一段。
    let bytes = value.as_bytes();
    if bytes.len() >= 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
    {
        return value[..10].to_owned();
    }
    value.to_owned()
}

/// `formatUserLabel`：` as name <email>` / ` as label`。
pub fn format_user_label(user: &Value) -> String {
    let text = |key: &str| {
        user.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let name = text("name");
    let email = text("email");
    let id = text("id");
    match (name, email) {
        (Some(name), Some(email)) => format!(" as {name} <{email}>"),
        (Some(name), None) => format!(" as {name}"),
        (None, Some(email)) => format!(" as {email}"),
        (None, None) => id.map(|id| format!(" as {id}")).unwrap_or_default(),
    }
}

/// 用户资料里 `user_id` 之外的展示键（Node 的 `--json` 形状）。
pub fn account_user(user: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(id) = user.get("id") {
        out.insert("user_id".to_owned(), id.clone());
    }
    for (from, to) in [("email", "email"), ("name", "name"), ("avatarUrl", "avatar")] {
        if let Some(value) = user.get(from).and_then(Value::as_str).filter(|v| !v.is_empty()) {
            out.insert(to.to_owned(), json!(value));
        }
    }
    Value::Object(out)
}

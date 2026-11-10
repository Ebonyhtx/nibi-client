//! 从 NIBI v2 凭据文件读付费插件门禁需要的三项事实：license token、设备 ID、服务端 refusal。
//!
//! Node 的 `paid-plugin-access.ts` 经共享凭据 store 同步读 `nibi:license:token` /
//! `nibi:device:id` / `nibi:license:state`；Rust 侧同样读 `<dataBase>/.nibi/v2/credentials.json`，
//! 值可能是 `enc:v2:`/`enc:v1:` 或明文（dev 注入）。解密失败按“读不到”处理，门禁保持 fail-closed。

#![allow(
    clippy::disallowed_methods,
    reason = "credential files are tiny synchronous IO on the plugin discovery path"
)]

use std::path::Path;

use crate::credentials::{CredentialCipher, is_encrypted_value, is_legacy_encrypted_value};

pub const LICENSE_TOKEN_KEY: &str = "nibi:license:token";
pub const LICENSE_STATE_KEY: &str = "nibi:license:state";
pub const DEVICE_ID_KEY: &str = "nibi:device:id";
/// 当前登录账号资料（JSON：`{ id, ... }`）：付费插件门禁的账号绑定。
pub const USER_INFO_KEY: &str = "oauth:nibi:user_info";

/// 门禁需要的四项事实；缺失都是 `None`，由判定层按 fail-closed 处理。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LicenseCredentials {
    pub token: Option<String>,
    pub refusal: Option<String>,
    pub device_id: Option<String>,
    pub account_identity: Option<String>,
}

/// 读 `credentials.json` 并解出三项事实。
///
/// `get_env` 只用于 `NIBI_CREDENTIAL_SECRET`（显式 env secret 的部署）；钥匙文件缺失时
/// v2 解密失败，按读不到处理。
pub fn read_license_credentials(
    credentials_path: &Path,
    get_env: impl Fn(&str) -> Option<String>,
) -> LicenseCredentials {
    let raw = match std::fs::read_to_string(credentials_path) {
        Ok(raw) => raw,
        Err(_) => return LicenseCredentials::default(),
    };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&raw) else {
        return LicenseCredentials::default();
    };
    let cipher = CredentialCipher::from_env(credentials_path, get_env);
    let read = |key: &str| -> Option<String> {
        let value = map.get(key)?.as_str()?.trim();
        if value.is_empty() {
            return None;
        }
        let plain = if is_encrypted_value(value) || is_legacy_encrypted_value(value) {
            cipher.decrypt(value).ok()?
        } else {
            value.to_owned()
        };
        let plain = plain.trim();
        (!plain.is_empty()).then(|| plain.to_owned())
    };
    let refusal = read(LICENSE_STATE_KEY)
        .and_then(|state| serde_json::from_str::<serde_json::Value>(&state).ok())
        .and_then(|state| {
            state
                .get("lastRefusal")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .filter(|refusal| !refusal.is_empty());
    let account_identity = read(USER_INFO_KEY)
        .and_then(|profile| serde_json::from_str::<serde_json::Value>(&profile).ok())
        .and_then(|profile| {
            profile
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .filter(|id| !id.is_empty());
    LicenseCredentials {
        token: read(LICENSE_TOKEN_KEY),
        refusal,
        device_id: read(DEVICE_ID_KEY),
        account_identity,
    }
}

#[cfg(test)]
#[path = "license_store_tests.rs"]
mod tests;

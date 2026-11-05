//! NIBI Device Authorization Grant（RFC 8628）的纯协议层。
//!
//! 与 Node `adapters/src/auth/nibi-device-login.ts` 的端点/字段/错误码一致：
//!
//! - `POST {authOrigin}/oauth/v2/device_authorization`，form `client_id`+`scope`；
//! - `POST {authOrigin}/oauth/v2/token`，form `client_id`+`device_code`+`grant_type`；
//! - `GET {authOrigin}/oidc/v1/userinfo`，Bearer access token。
//!
//! 本模块只做请求形状与响应解析；HTTP 与轮询循环由调用方（后续接入 `nibi-kernel-net`）负责。
//! 这样 Device Flow 的字段/错误码可以在零网络单测里锁死。

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const AUTH_ORIGIN: &str = "https://auth.nibistudio.top";
/// OIDC native app：CLI/TUI（client id 是公开标识，不是密钥）。
pub const TUI_CLIENT_ID: &str = "393742196290879492";
pub const OIDC_PROJECT_ID: &str = "393742195619790852";
pub const OIDC_SCOPE: &str =
    "openid profile email offline_access urn:zitadel:iam:org:project:id:393742195619790852:aud";
pub const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 5_000;

pub const DEVICE_AUTHORIZATION_PATH: &str = "/oauth/v2/device_authorization";
pub const TOKEN_PATH: &str = "/oauth/v2/token";
pub const USERINFO_PATH: &str = "/oidc/v1/userinfo";

#[derive(Debug, Error)]
pub enum DeviceFlowError {
    #[error("device authorization response is missing {0}")]
    MissingField(&'static str),
    #[error("device authorization expires_in is invalid")]
    InvalidExpiresIn,
    #[error("device authorization interval is invalid")]
    InvalidInterval,
    #[error("token response is missing access_token")]
    MissingAccessToken,
    #[error("userinfo response is missing sub")]
    MissingSubject,
    #[error("invalid JSON: {0}")]
    Json(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    /// 建议轮询间隔；Node 下限 1000ms。
    pub interval_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub raw_profile: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PollResult {
    Pending,
    SlowDown { interval_ms: u64 },
    Ready { token: TokenSet },
    Expired,
    Denied,
}

/// `NIBI_AUTH_ORIGIN` 覆盖（联调/自建账号中心），去掉尾部斜杠。
pub fn auth_origin_from_env(get: impl Fn(&str) -> Option<String>) -> String {
    get("NIBI_AUTH_ORIGIN")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| AUTH_ORIGIN.to_owned())
        .trim_end_matches('/')
        .to_owned()
}

pub fn device_authorization_url(origin: &str) -> String {
    format!("{origin}{DEVICE_AUTHORIZATION_PATH}")
}
pub fn token_url(origin: &str) -> String {
    format!("{origin}{TOKEN_PATH}")
}
pub fn userinfo_url(origin: &str) -> String {
    format!("{origin}{USERINFO_PATH}")
}

/// form 用 `application/x-www-form-urlencoded`；返回键值对由 HTTP 层编码。
pub fn device_authorization_form() -> Vec<(&'static str, &'static str)> {
    vec![("client_id", TUI_CLIENT_ID), ("scope", OIDC_SCOPE)]
}

pub fn token_form(device_code: &str) -> Vec<(&'static str, String)> {
    vec![
        ("client_id", TUI_CLIENT_ID.to_owned()),
        ("device_code", device_code.to_owned()),
        ("grant_type", DEVICE_GRANT_TYPE.to_owned()),
    ]
}

/// 解析 `device_authorization` 的成功响应；缺字段按 Node 的口径报错。
pub fn parse_device_authorization(
    value: &serde_json::Value,
) -> Result<DeviceAuthorization, DeviceFlowError> {
    let device_code =
        string_field(value, "device_code").ok_or(DeviceFlowError::MissingField("device_code"))?;
    let user_code =
        string_field(value, "user_code").ok_or(DeviceFlowError::MissingField("user_code"))?;
    let verification_uri = string_field(value, "verification_uri")
        .ok_or(DeviceFlowError::MissingField("verification_uri"))?;
    let expires_in = u64_field(value, "expires_in").ok_or(DeviceFlowError::InvalidExpiresIn)?;
    if expires_in == 0 {
        return Err(DeviceFlowError::InvalidExpiresIn);
    }
    let interval_ms = match u64_field(value, "interval") {
        Some(seconds) if seconds > 0 => seconds.saturating_mul(1000).max(1_000),
        Some(_) => return Err(DeviceFlowError::InvalidInterval),
        None => DEFAULT_POLL_INTERVAL_MS,
    };
    Ok(DeviceAuthorization {
        device_code,
        user_code,
        verification_uri,
        verification_uri_complete: string_field(value, "verification_uri_complete"),
        interval_ms,
    })
}

/// 解析 token 成功响应；`now_ms` 用于 `expires_at_ms`。
pub fn parse_token_set(
    value: &serde_json::Value,
    now_ms: u64,
) -> Result<TokenSet, DeviceFlowError> {
    let access_token =
        string_field(value, "access_token").ok_or(DeviceFlowError::MissingAccessToken)?;
    let expires_in = u64_field(value, "expires_in");
    Ok(TokenSet {
        access_token,
        token_type: string_field(value, "token_type"),
        scope: string_field(value, "scope"),
        id_token: string_field(value, "id_token"),
        refresh_token: string_field(value, "refresh_token"),
        expires_at_ms: expires_in
            .map(|seconds| now_ms.saturating_add(seconds.saturating_mul(1000))),
    })
}

/// token 失败响应的错误码 → 轮询结果；未知错误按 Node 的 `denied`。
pub fn parse_poll_failure(status: u16, value: &serde_json::Value) -> PollResult {
    let error = string_field(value, "error").unwrap_or_else(|| format!("http_{status}"));
    match error.as_str() {
        "authorization_pending" => PollResult::Pending,
        "slow_down" => PollResult::SlowDown {
            interval_ms: u64_field(value, "interval")
                .map(|seconds| seconds.saturating_mul(1000).max(1_000))
                .unwrap_or(DEFAULT_POLL_INTERVAL_MS),
        },
        "expired_token" => PollResult::Expired,
        "access_denied" => PollResult::Denied,
        _ => PollResult::Denied,
    }
}

pub fn parse_user_profile(value: &serde_json::Value) -> Result<UserProfile, DeviceFlowError> {
    let id = string_field(value, "sub").ok_or(DeviceFlowError::MissingSubject)?;
    Ok(UserProfile {
        id,
        name: string_field(value, "name"),
        email: string_field(value, "email"),
        preferred_username: string_field(value, "preferred_username"),
        avatar_url: string_field(value, "picture"),
        raw_profile: value.clone(),
    })
}

fn string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn u64_field(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_node_compatible_requests() {
        let origin = "https://auth.example.test/";
        let origin = origin.trim_end_matches('/');
        assert_eq!(
            device_authorization_url(origin),
            "https://auth.example.test/oauth/v2/device_authorization"
        );
        assert_eq!(
            token_url(origin),
            "https://auth.example.test/oauth/v2/token"
        );
        assert_eq!(
            userinfo_url(origin),
            "https://auth.example.test/oidc/v1/userinfo"
        );
        let form = device_authorization_form();
        assert_eq!(form[0], ("client_id", TUI_CLIENT_ID));
        assert!(form[1].1.contains(OIDC_PROJECT_ID));
        let token = token_form("dev-code");
        assert_eq!(token[0].0, "client_id");
        assert_eq!(token[1].1, "dev-code");
        assert_eq!(token[2].1, DEVICE_GRANT_TYPE);
    }

    #[test]
    fn parses_authorization_and_clamps_interval() {
        let parsed = parse_device_authorization(&json!({
            "device_code": "dc",
            "user_code": "UC-1",
            "verification_uri": "https://auth/device",
            "verification_uri_complete": "https://auth/device?uc=UC-1",
            "expires_in": 300,
            "interval": 1
        }))
        .unwrap();
        assert_eq!(parsed.device_code, "dc");
        assert_eq!(parsed.user_code, "UC-1");
        assert_eq!(parsed.interval_ms, 1_000);
        assert_eq!(
            parsed.verification_uri_complete.as_deref(),
            Some("https://auth/device?uc=UC-1")
        );
    }

    #[test]
    fn default_interval_is_five_seconds() {
        let parsed = parse_device_authorization(&json!({
            "device_code": "dc", "user_code": "UC", "verification_uri": "u", "expires_in": 60
        }))
        .unwrap();
        assert_eq!(parsed.interval_ms, DEFAULT_POLL_INTERVAL_MS);
    }

    #[test]
    fn missing_required_field_is_an_error() {
        assert!(matches!(
            parse_device_authorization(&json!({ "device_code": "dc" })).unwrap_err(),
            DeviceFlowError::MissingField("user_code")
        ));
    }

    #[test]
    fn parses_token_set_with_expiry() {
        let token = parse_token_set(
            &json!({
                "access_token": "at",
                "refresh_token": "rt",
                "id_token": "idt",
                "token_type": "Bearer",
                "scope": "openid",
                "expires_in": 3600
            }),
            1_000,
        )
        .unwrap();
        assert_eq!(token.access_token, "at");
        assert_eq!(token.refresh_token.as_deref(), Some("rt"));
        assert_eq!(token.expires_at_ms, Some(3_601_000));
    }

    #[test]
    fn parses_poll_errors_like_node() {
        assert_eq!(
            parse_poll_failure(400, &json!({"error": "authorization_pending"})),
            PollResult::Pending
        );
        assert_eq!(
            parse_poll_failure(400, &json!({"error": "slow_down", "interval": 10})),
            PollResult::SlowDown {
                interval_ms: 10_000
            }
        );
        assert_eq!(
            parse_poll_failure(400, &json!({"error": "expired_token"})),
            PollResult::Expired
        );
        assert_eq!(
            parse_poll_failure(403, &json!({"error": "access_denied"})),
            PollResult::Denied
        );
        assert_eq!(parse_poll_failure(500, &json!({})), PollResult::Denied);
    }

    #[test]
    fn parses_user_profile() {
        let profile = parse_user_profile(&json!({
            "sub": "user-1",
            "name": "Nibi",
            "email": "u@example.test",
            "preferred_username": "nibi",
            "picture": "https://img"
        }))
        .unwrap();
        assert_eq!(profile.id, "user-1");
        assert_eq!(profile.email.as_deref(), Some("u@example.test"));
        assert_eq!(profile.avatar_url.as_deref(), Some("https://img"));
    }
}

//! NIBI Device Authorization Grant（RFC 8628）的协议层与轮询。
//!
//! 与 Node `adapters/src/auth/nibi-device-login.ts` 的端点/字段/错误码一致：
//!
//! - `POST {authOrigin}/oauth/v2/device_authorization`，form `client_id`+`scope`；
//! - `POST {authOrigin}/oauth/v2/token`，form `client_id`+`device_code`+`grant_type`（刷新是 `refresh_token`）；
//! - `GET {authOrigin}/oidc/v1/userinfo`，Bearer access token。
//!
//! HTTP 由调用方注入（[`Transport`]）：内核里的实现挂在 `nibi-kernel-net` 的单一出口上，单测用替身，
//! 于是字段/错误码/两段计时都能在零网络里锁死。

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

pub const AUTH_ORIGIN: &str = "https://auth.nibistudio.top";
/// OIDC native app：CLI/TUI（client id 是公开标识，不是密钥）。
pub const TUI_CLIENT_ID: &str = "393742196290879492";
pub const OIDC_PROJECT_ID: &str = "393742195619790852";
pub const OIDC_SCOPE: &str =
    "openid profile email offline_access urn:zitadel:iam:org:project:id:393742195619790852:aud";
pub const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
pub const REFRESH_GRANT_TYPE: &str = "refresh_token";
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
    /// 传输层/HTTP 失败（文案来自实现）。
    #[error("{0}")]
    Http(String),
    /// 非 2xx 且不是 RFC 8628 的四种轮询错误（Node 抛同一句 `error_description`）。
    #[error("{0}")]
    Failed(String),
    /// Node `NibiLoginError("auth_timeout", "设备码已过期，请重新执行 nibi login")`。
    #[error("设备码已过期，请重新执行 nibi login")]
    Expired,
    /// Node `NibiLoginError("auth_denied", "授权被拒绝，请重新执行 nibi login")`。
    #[error("授权被拒绝，请重新执行 nibi login")]
    Denied,
    /// Node `NibiLoginError("auth_timeout", "登录超时，请重新执行 nibi login")`。
    #[error("登录超时，请重新执行 nibi login")]
    TimedOut,
    /// 用户取消（TUI 的 esc）：轮询停下，不写任何文件。
    #[error("Login cancelled.")]
    Cancelled,
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
    /// 设备码失效时刻（毫秒时间戳，`expires_in` 从响应时刻起算）。
    pub expires_at_ms: u64,
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
    /// 其他错误：Node 抛 `error_description`（没有时 `登录失败（<error>）`）。
    Failed { message: String },
}

/// HTTP 传输（实现挂在调用方的网络出口上；单测用替身）。返回状态码与解析后的 JSON
/// （正文不是 JSON 时是 `{}`，与 Node 的 `requestJson` 相同）。
#[async_trait]
pub trait Transport: Send + Sync {
    async fn post_form(
        &self,
        url: &str,
        fields: &[(&str, String)],
    ) -> Result<(u16, serde_json::Value), String>;
    async fn get_bearer(
        &self,
        url: &str,
        token: &str,
    ) -> Result<(u16, serde_json::Value), String>;
}

/// 账号中心的客户端（Node `createNibiDeviceLoginClient`）。
pub struct Client<'a> {
    transport: &'a dyn Transport,
    origin: String,
    client_id: String,
    scope: String,
    now: Box<dyn Fn() -> u64 + 'a>,
}

impl<'a> Client<'a> {
    pub fn new(
        transport: &'a dyn Transport,
        origin: impl Into<String>,
        client_id: impl Into<String>,
        scope: impl Into<String>,
        now: impl Fn() -> u64 + 'a,
    ) -> Self {
        Self {
            transport,
            origin: origin.into().trim_end_matches('/').to_owned(),
            client_id: client_id.into(),
            scope: scope.into(),
            now: Box::new(now),
        }
    }

    /// 默认端点/客户端/范围（`NIBI_TUI_OIDC_CLIENT_ID` 是公开标识）。
    pub fn with_defaults(transport: &'a dyn Transport, origin: &str, now: impl Fn() -> u64 + 'a) -> Self {
        Self::new(transport, origin, TUI_CLIENT_ID, OIDC_SCOPE, now)
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// `POST device_authorization`；缺字段、`expires_in` 非法按 Node 报错。
    pub async fn start(&self) -> Result<DeviceAuthorization, DeviceFlowError> {
        let fields = device_authorization_form(&self.client_id, &self.scope);
        let (status, payload) = self
            .transport
            .post_form(&device_authorization_url(&self.origin), &fields)
            .await
            .map_err(DeviceFlowError::Http)?;
        if !(200..300).contains(&status) {
            return Err(DeviceFlowError::Http(http_error(&payload, status)));
        }
        parse_device_authorization(&payload, (self.now)())
    }

    /// 一次轮询（`POST token`，`grant_type=urn:ietf:params:oauth:grant-type:device_code`）。
    pub async fn poll(&self, device_code: &str) -> Result<PollResult, DeviceFlowError> {
        let (status, payload) = self
            .transport
            .post_form(
                &token_url(&self.origin),
                &token_form(&self.client_id, device_code),
            )
            .await
            .map_err(DeviceFlowError::Http)?;
        if (200..300).contains(&status) {
            return Ok(PollResult::Ready {
                token: parse_token_set(&payload, (self.now)())?,
            });
        }
        Ok(parse_poll_failure(status, &payload))
    }

    /// 用 refresh token 换新的一对令牌（`grant_type=refresh_token`）。
    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenSet, DeviceFlowError> {
        let (status, payload) = self
            .transport
            .post_form(
                &token_url(&self.origin),
                &refresh_form(&self.client_id, refresh_token),
            )
            .await
            .map_err(DeviceFlowError::Http)?;
        if !(200..300).contains(&status) {
            return Err(DeviceFlowError::Failed(http_error(&payload, status)));
        }
        parse_token_set(&payload, (self.now)())
    }

    /// 读账号资料（`GET userinfo`，Bearer）。
    pub async fn user_info(&self, access_token: &str) -> Result<UserProfile, DeviceFlowError> {
        let (status, payload) = self
            .transport
            .get_bearer(&userinfo_url(&self.origin), access_token)
            .await
            .map_err(DeviceFlowError::Http)?;
        if !(200..300).contains(&status) {
            return Err(DeviceFlowError::Http("读取账号资料失败，请重新登录".to_owned()));
        }
        parse_user_profile(&payload)
    }

    /// 轮询到 `ready`（Node `pollDeviceAuthorization`）：设备码失效前每隔 `interval` 问一次，
    /// `slow_down` 换间隔；取消令牌随时结束。
    pub async fn poll_until_ready(
        &self,
        authorization: &DeviceAuthorization,
        cancel: &CancellationToken,
    ) -> Result<TokenSet, DeviceFlowError> {
        let mut interval_ms = authorization.interval_ms;
        while (self.now)() < authorization.expires_at_ms {
            if cancel.is_cancelled() {
                return Err(DeviceFlowError::Cancelled);
            }
            match self.poll(&authorization.device_code).await? {
                PollResult::Ready { token } => return Ok(token),
                PollResult::Expired => return Err(DeviceFlowError::Expired),
                PollResult::Denied => return Err(DeviceFlowError::Denied),
                PollResult::Failed { message } => return Err(DeviceFlowError::Failed(message)),
                PollResult::SlowDown { interval_ms: slower } => interval_ms = slower,
                PollResult::Pending => {}
            }
            let remaining_ms = authorization.expires_at_ms.saturating_sub((self.now)());
            if remaining_ms == 0 {
                break;
            }
            let wait = Duration::from_millis(interval_ms.min(remaining_ms));
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = cancel.cancelled() => return Err(DeviceFlowError::Cancelled),
            }
        }
        Err(DeviceFlowError::TimedOut)
    }
}

/// 非 2xx 的文案：Node `error_description`，否则 `账号中心返回 HTTP <status>`。
fn http_error(payload: &serde_json::Value, status: u16) -> String {
    string_field(payload, "error_description")
        .unwrap_or_else(|| format!("账号中心返回 HTTP {status}"))
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
pub fn device_authorization_form(client_id: &str, scope: &str) -> Vec<(&'static str, String)> {
    vec![
        ("client_id", client_id.to_owned()),
        ("scope", scope.to_owned()),
    ]
}

pub fn token_form(client_id: &str, device_code: &str) -> Vec<(&'static str, String)> {
    vec![
        ("client_id", client_id.to_owned()),
        ("device_code", device_code.to_owned()),
        ("grant_type", DEVICE_GRANT_TYPE.to_owned()),
    ]
}

pub fn refresh_form(client_id: &str, refresh_token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("client_id", client_id.to_owned()),
        ("grant_type", REFRESH_GRANT_TYPE.to_owned()),
        ("refresh_token", refresh_token.to_owned()),
    ]
}

/// 解析 `device_authorization` 的成功响应；缺字段按 Node 的口径报错。`now_ms` 用于 `expires_at_ms`。
pub fn parse_device_authorization(
    value: &serde_json::Value,
    now_ms: u64,
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
        expires_at_ms: now_ms.saturating_add(expires_in.saturating_mul(1000)),
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

/// token 失败响应的错误码 → 轮询结果；四种已知错误之外按 Node 抛出 `error_description`。
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
        _ => PollResult::Failed {
            message: string_field(value, "error_description")
                .unwrap_or_else(|| format!("登录失败（{error}）")),
        },
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
#[path = "device_flow_tests.rs"]
mod tests;

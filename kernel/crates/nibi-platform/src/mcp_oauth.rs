//! MCP 服务器的 OAuth（对齐 Node `apps/nibi-cli/packages/adapters/src/mcp`）。
//!
//! 两条路：
//!
//! - `client_credentials`：按 RFC 9728/8414 发现令牌端点，`client_secret_basic` 换 token（Node 的
//!   `ClientCredentialsProvider`）；到期前提前刷新。
//! - `authorization_code`：交互授权在桌面端做（浏览器 + 回调），它把令牌写进共享凭据文件；内核按 Node 的
//!   键派生读出来，到期用 `refresh_token` 换新的一对。键与记录形状见 `oauth-credentials.ts`
//!   （`mcp:oauth:<sha256(name\nurl\nclientId\nscope\nredirectPath)[0..24]>:authorization_credentials`）。
//!
//! HTTP 由调用方注入（[`Transport`]），单测用替身；CLI/内核的实现挂在 `nibi-kernel-net` 的单一出口上。

use ring::rand::SecureRandom as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// 提前多久认为令牌该刷新（Node 的 `isCanonicalTokenNearExpiry`：过期前 60 秒）。
pub const REFRESH_AHEAD_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub access_token: String,
    /// `token_type`（RFC 6749 要求；Node 的 `OAuthTokensSchema` 也要求非空）。
    pub token_type: String,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
    /// 绝对过期点（epoch ms）。
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthServer {
    pub issuer: Option<String>,
    pub token_endpoint: String,
}

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("{0}")]
    Http(String),
    #[error("the server did not publish an OAuth authorization server: {0}")]
    Discovery(String),
    #[error("{0}")]
    Failed(String),
    #[error("the stored token has no refresh token; authorize the server in the desktop app")]
    AuthorizationRequired,
}

/// 调用方注入的 HTTP（表单与 JSON 两种，状态码 + 解析后的正文）。
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    async fn get_json(&self, url: &str) -> Result<(u16, Value), String>;
    /// `POST` 表单；`basic` 是 `(client_id, client_secret)`（`client_secret_basic`）。
    async fn post_form(
        &self,
        url: &str,
        fields: &[(&str, String)],
        basic: Option<(&str, &str)>,
    ) -> Result<(u16, Value), String>;
}

/// `createCredentialKeyPrefix` 的键前缀（Node 取 `sha256([名字, URL, clientId, scope, redirectPath].join("\n"))`
/// 的前 24 个 hex；注意最后一个字段后面没有换行）。
pub fn credential_key_prefix(
    server_name: &str,
    server_url: &str,
    client_id: &str,
    scope: &str,
    redirect_path: &str,
) -> String {
    let joined = [server_name, server_url, client_id, scope, redirect_path].join("\n");
    let digest: String = Sha256::digest(joined.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("mcp:oauth:{}", &digest[..24])
}

/// 共享凭据里这条记录的键（Node `mcpOAuthCredentialKey`）。
pub fn credential_key(prefix: &str) -> String {
    format!("{prefix}:authorization_credentials")
}

/// 从共享凭据的记录（已解密的 JSON）里读令牌。形状不对按「没有」处理（fail-closed）。
pub fn tokens_from_record(record: &Value) -> Option<Token> {
    let tokens = record.get("tokens")?;
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_owned();
    let refresh_token = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let token_type = tokens
        .get("token_type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Bearer")
        .to_owned();
    let scope = tokens
        .get("scope")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let expires_at_ms = record
        .get("expires_at")
        .and_then(Value::as_u64)
        .or_else(|| {
            let obtained = record.get("obtained_at").and_then(Value::as_u64)?;
            let expires_in = tokens.get("expires_in").and_then(Value::as_u64)?;
            Some(obtained.saturating_add(expires_in.saturating_mul(1000)))
        });
    Some(Token {
        access_token,
        token_type,
        refresh_token,
        scope,
        expires_at_ms,
    })
}

/// 记录里的 `client_information`（`client_secret_basic` 用）。
pub fn client_from_record(record: &Value) -> Option<(String, Option<String>)> {
    let information = record.get("client_information")?;
    let client_id = information
        .get("client_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_owned();
    let secret = information
        .get("client_secret")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    Some((client_id, secret))
}

pub fn near_expiry(token: &Token, now_ms: u64) -> bool {
    token
        .expires_at_ms
        .is_some_and(|expires| expires <= now_ms.saturating_add(REFRESH_AHEAD_MS))
}

/// 解析 token 响应（`access_token` 必需；`expires_in` 换成绝对时间）。
pub fn parse_token(value: &Value, now_ms: u64) -> Result<Token, OAuthError> {
    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| OAuthError::Failed("token response is missing access_token".to_owned()))?
        .to_owned();
    Ok(Token {
        access_token,
        token_type: value
            .get("token_type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Bearer")
            .to_owned(),
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        scope: value.get("scope").and_then(Value::as_str).map(str::to_owned),
        expires_at_ms: value
            .get("expires_in")
            .and_then(Value::as_u64)
            .map(|seconds| now_ms.saturating_add(seconds.saturating_mul(1000))),
    })
}

/// 发现授权服务器（Node `discoverOAuthServerInfo` 的最短路径）：
/// 1. 服务器 URL 的 `/.well-known/oauth-protected-resource`（取 `authorization_servers[0]`）；
/// 2. 没有时把服务器 URL 自己当 issuer；
/// 3. 取 `/.well-known/oauth-authorization-server`（再退 `/.well-known/openid-configuration`）里的
///    `token_endpoint`。
pub async fn discover(
    transport: &dyn Transport,
    server_url: &str,
) -> Result<AuthServer, OAuthError> {
    let origin = origin_of(server_url);
    let issuer = match transport
        .get_json(&format!("{origin}/.well-known/oauth-protected-resource"))
        .await
    {
        Ok((200..=299, value)) => value
            .get("authorization_servers")
            .and_then(Value::as_array)
            .and_then(|servers| servers.first())
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|value| !value.is_empty()),
        // 没有受保护资源元数据：把服务器自己当 issuer（Node 的下一档）。
        Ok(_) | Err(_) => None,
    };
    let issuer = issuer.unwrap_or_else(|| origin.clone());
    let base = issuer.trim_end_matches('/');
    for path in [
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
    ] {
        let url = format!("{base}{path}");
        match transport.get_json(&url).await {
            Ok((status, value)) if (200..=299).contains(&status) => {
                if let Some(endpoint) = value
                    .get("token_endpoint")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    return Ok(AuthServer {
                        issuer: Some(
                            value
                                .get("issuer")
                                .and_then(Value::as_str)
                                .unwrap_or(base)
                                .to_owned(),
                        ),
                        token_endpoint: endpoint.to_owned(),
                    });
                }
            }
            Ok(_) | Err(_) => {}
        }
    }
    Err(OAuthError::Discovery(format!(
        "{base} has no oauth-authorization-server/openid-configuration with a token_endpoint"
    )))
}

/// `client_credentials`（Node `ClientCredentialsProvider`）：`client_secret_basic`。
pub async fn client_credentials(
    transport: &dyn Transport,
    server_url: &str,
    client_id: &str,
    client_secret: &str,
    scope: Option<&str>,
    now_ms: u64,
) -> Result<Token, OAuthError> {
    let server = discover(transport, server_url).await?;
    let mut fields: Vec<(&str, String)> =
        vec![("grant_type", "client_credentials".to_owned())];
    if let Some(scope) = scope.filter(|scope| !scope.trim().is_empty()) {
        fields.push(("scope", scope.to_owned()));
    }
    token_request(
        transport,
        &server.token_endpoint,
        &fields,
        Some((client_id, client_secret)),
        now_ms,
    )
    .await
}

/// 用 refresh token 换新令牌（Node `refreshMcpOAuthTokensUnderLock` 的网络部分）。
pub async fn refresh(
    transport: &dyn Transport,
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
    now_ms: u64,
) -> Result<Token, OAuthError> {
    let fields = vec![
        ("grant_type", "refresh_token".to_owned()),
        ("refresh_token", refresh_token.to_owned()),
    ];
    let basic = client_secret.map(|secret| (client_id, secret));
    let mut token = token_request(transport, token_endpoint, &fields, basic, now_ms).await?;
    // RFC 6749 §6：响应里没有新的 refresh token 时沿用原来的（Node `refreshAuthorization` 同一条）。
    if token.refresh_token.is_none() {
        token.refresh_token = Some(refresh_token.to_owned());
    }
    Ok(token)
}

async fn token_request(
    transport: &dyn Transport,
    endpoint: &str,
    fields: &[(&str, String)],
    basic: Option<(&str, &str)>,
    now_ms: u64,
) -> Result<Token, OAuthError> {
    let (status, value) = transport
        .post_form(endpoint, fields, basic)
        .await
        .map_err(OAuthError::Http)?;
    if !(200..=299).contains(&status) {
        let message = value
            .get("error_description")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "token endpoint returned HTTP {status} ({})",
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("no error code")
                )
            });
        return Err(OAuthError::Failed(message));
    }
    parse_token(&value, now_ms)
}

/// 记录写回的 JSON（Node 的 canonical 记录形状）。
pub fn record(token: &Token, client_id: &str, client_secret: Option<&str>, issued_at_ms: u64) -> Value {
    json!({
        "version": 2,
        "client_information": {
            "client_id": client_id,
            "client_secret": client_secret,
        },
        "tokens": {
            "access_token": token.access_token,
            "token_type": token.token_type,
            "refresh_token": token.refresh_token,
            "scope": token.scope,
            "expires_in": token.expires_at_ms.map(|expires| expires.saturating_sub(issued_at_ms) / 1000),
        },
        "obtained_at": issued_at_ms,
        "expires_at": token.expires_at_ms,
        "issuer": Value::Null,
        "generation": generation(),
        "published_by": "nibi-kernel",
    })
}

/// 每次写回的随机代际（Node `createCredentialGeneration`）。
fn generation() -> String {
    let mut bytes = [0u8; 16];
    let _ = ring::rand::SystemRandom::new().fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn origin_of(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => parsed.origin().ascii_serialization(),
        Err(_) => url.trim_end_matches('/').to_owned(),
    }
}

#[cfg(test)]
#[path = "mcp_oauth_tests.rs"]
mod tests;

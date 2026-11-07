//! MCP 服务器的 OAuth 令牌端口（Node `apps/zcode-cli/packages/adapters/src/mcp/oauth*.ts` 的等份实现）。
//!
//! - `client_credentials`：内核自己发现授权服务器、用 `client_secret_basic` 换令牌，进程内缓存到期前
//!   提前刷新（Node `ClientCredentialsProvider`）。
//! - `authorization_code`：交互授权在桌面端做（浏览器 + 回调），它把令牌写进共享凭据文件；这里按 Node
//!   的键（`mcp:oauth:<sha256(名字\nURL\nclientId\nscope\nredirectPath)[0..24]>:authorization_credentials`）
//!   读出来，临期或 401 时用 `refresh_token` 换新的一对并原样写回同一形状的记录（Node 的 reader 要能读，
//!   所以 `token_type` 必须写）。
//!
//! HTTP 走 `nibi-kernel-net` 的单一出口（`Egress`），与登录、模型请求同一条路。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::clock::Clock;
use nibi_kernel_api::mcp::{McpOAuthConfig, McpOAuthPort, McpOAuthRequest};
use nibi_kernel_net::{Egress, HttpRequest, header};
use nibi_platform::mcp_oauth::{
    self, Token, Transport, client_credentials, credential_key, credential_key_prefix, near_expiry,
    record, refresh, tokens_from_record,
};
use serde_json::Value;

use crate::nibi_session::Store;

/// 一次令牌请求的期限。
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// 响应体的上限（令牌与元数据都很小）。
const RESPONSE_LIMIT: usize = 1024 * 1024;

pub(crate) struct McpOAuth {
    store: Store,
    egress: Arc<Egress>,
    clock: Arc<dyn Clock>,
    /// `client_credentials` 的令牌（按服务器名；配置变了由共享键覆盖，见 `config_key`）。
    tokens: Mutex<BTreeMap<String, Token>>,
    /// 发现过的 `token_endpoint`（按服务器 URL）：刷新时不用每次都走两跳 discovery。
    endpoints: Mutex<BTreeMap<String, String>>,
}

impl McpOAuth {
    pub(crate) fn new(store: Store, egress: Arc<Egress>, clock: Arc<dyn Clock>) -> Self {
        Self {
            store,
            egress,
            clock,
            tokens: Mutex::new(BTreeMap::new()),
            endpoints: Mutex::new(BTreeMap::new()),
        }
    }

    fn now_ms(&self) -> u64 {
        self.clock.now_ms()
    }

    fn http(&self) -> HostTransport<'_> {
        HostTransport {
            egress: &self.egress,
        }
    }

    /// `authorization_code` 的记录键（与 Node 同一份派生）。
    fn record_key(request: &McpOAuthRequest) -> Option<String> {
        let McpOAuthConfig::AuthorizationCode {
            client_id,
            scope,
            redirect_path,
            ..
        } = &request.config
        else {
            return None;
        };
        Some(credential_key(&credential_key_prefix(
            &request.server,
            &request.url,
            client_id.as_deref().unwrap_or(""),
            scope.as_deref().unwrap_or(""),
            redirect_path.as_deref().unwrap_or(""),
        )))
    }

    /// 共享凭据里的记录（已解密、解析成 JSON）。
    fn load_record(&self, request: &McpOAuthRequest) -> Option<(String, Value, Token)> {
        let key = Self::record_key(request)?;
        let raw = self.store.load(&key)?;
        let value: Value = serde_json::from_str(&raw).ok()?;
        let token = tokens_from_record(&value)?;
        Some((key, value, token))
    }

    /// `client_credentials`：缓存里没有或临期时换一枚。
    async fn client_credentials(&self, request: &McpOAuthRequest) -> Result<Token, String> {
        let config = match &request.config {
            McpOAuthConfig::ClientCredentials {
                client_id,
                client_secret,
                scope,
                ..
            } => (client_id.clone(), client_secret.clone(), scope.clone()),
            McpOAuthConfig::AuthorizationCode { .. } => {
                return Err("not a client_credentials server".to_owned());
            }
        };
        let http = self.http();
        client_credentials(
            &http,
            &request.url,
            &config.0,
            &config.1,
            config.2.as_deref(),
            self.now_ms(),
        )
        .await
        .map_err(|error| error.to_string())
    }
}

#[async_trait]
impl McpOAuthPort for McpOAuth {
    async fn access_token(&self, request: &McpOAuthRequest) -> Option<String> {
        match &request.config {
            McpOAuthConfig::ClientCredentials { .. } => {
                let cached = self
                    .tokens
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(&request.server)
                    .cloned();
                if let Some(token) = cached.filter(|token| !near_expiry(token, self.now_ms())) {
                    return Some(token.access_token);
                }
                match self.client_credentials(request).await {
                    Ok(token) => {
                        let access = token.access_token.clone();
                        self.tokens
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .insert(request.server.clone(), token);
                        Some(access)
                    }
                    Err(error) => {
                        tracing::warn!(
                            server = %request.server,
                            %error,
                            "could not get an MCP OAuth token (client_credentials)"
                        );
                        None
                    }
                }
            }
            McpOAuthConfig::AuthorizationCode { .. } => {
                let (_, _, token) = self.load_record(request)?;
                if !near_expiry(&token, self.now_ms()) {
                    return Some(token.access_token);
                }
                // 临期但没有 refresh token：用现值撑到 401（Node 不虚构刷新）。
                if token.refresh_token.is_none() {
                    return Some(token.access_token);
                }
                match self.refresh(request, None).await {
                    Ok(token) => Some(token),
                    // 主动刷新失败不打断连接：被拒时 401 路径还有一次机会。
                    Err(error) => {
                        tracing::warn!(
                            server = %request.server,
                            %error,
                            "could not refresh an MCP OAuth token; using the stored one"
                        );
                        Some(token.access_token)
                    }
                }
            }
        }
    }

    async fn refresh(
        &self,
        request: &McpOAuthRequest,
        rejected: Option<&str>,
    ) -> Result<String, String> {
        match &request.config {
            McpOAuthConfig::ClientCredentials { .. } => {
                let token = self.client_credentials(request).await?;
                let access = token.access_token.clone();
                self.tokens
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(request.server.clone(), token);
                Ok(access)
            }
            McpOAuthConfig::AuthorizationCode { .. } => {
                let (key, stored, current) = self.load_record(request).ok_or_else(|| {
                    format!(
                        "MCP server {} requires interactive OAuth authorization (no_credentials)",
                        request.server
                    )
                })?;
                // Node provider 的同一条保护：被拒的那枚不是当前记录里的那枚（另一个进程已经换代），
                // 直接用新的，不再换一次；否则会把一枚未被拒绝的 refresh token 换掉。
                if already_refreshed(rejected, &current) {
                    return Ok(current.access_token);
                }
                let refresh_token = current.refresh_token.clone().ok_or_else(|| {
                    format!(
                        "MCP server {} requires interactive OAuth authorization (no_refresh_token)",
                        request.server
                    )
                })?;
                let client = mcp_oauth::client_from_record(&stored).ok_or_else(|| {
                    format!(
                        "MCP server {} has no OAuth client information; authorize it in the desktop app",
                        request.server
                    )
                })?;
                let endpoint = self.token_endpoint(request).await?;
                let http = self.http();
                let now = self.now_ms();
                let next = refresh(
                    &http,
                    &endpoint,
                    &client.0,
                    client.1.as_deref(),
                    &refresh_token,
                    now,
                )
                .await
                .map_err(|error| error.to_string())?;
                // 写回同一形状（`token_type` 必须写：Node 的 reader 会校验它）。
                let mut updated = record(&next, &client.0, client.1.as_deref(), now);
                // 保留原来的 issuer（Node 用它做发现缓存的一致性检查）。
                if let Some(issuer) = stored.get("issuer").filter(|value| !value.is_null()).cloned()
                    && let Some(object) = updated.as_object_mut()
                {
                    object.insert("issuer".to_owned(), issuer);
                }
                let text = serde_json::to_string(&updated)
                    .map_err(|error| format!("could not encode the OAuth record: {error}"))?;
                self.store
                    .save_many(&[(key.as_str(), Some(text))])
                    .await?;
                Ok(next.access_token)
            }
        }
    }
}

impl McpOAuth {
    /// 刷新用的 `token_endpoint`：进程内缓存，没有时发现一次（`client_credentials` 在换令牌时自己发现）。
    async fn token_endpoint(&self, request: &McpOAuthRequest) -> Result<String, String> {
        if let Some(endpoint) = self
            .endpoints
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&request.url)
            .cloned()
        {
            return Ok(endpoint);
        }
        let http = self.http();
        let server = mcp_oauth::discover(&http, &request.url)
            .await
            .map_err(|error| error.to_string())?;
        self.endpoints
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(request.url.clone(), server.token_endpoint.clone());
        Ok(server.token_endpoint)
    }
}

/// 被拒的令牌不是当前记录里的那枚：另一个进程（或桌面端）已经换代，直接用新的，不再换一次。
fn already_refreshed(rejected: Option<&str>, current: &Token) -> bool {
    rejected.is_some_and(|rejected| rejected != current.access_token)
}

/// `Egress` 上的表单与 JSON 两种请求（与登录的 `HostTransport` 同一形状）。
struct HostTransport<'a> {
    egress: &'a Egress,
}

impl HostTransport<'_> {
    async fn send(&self, request: HttpRequest) -> Result<(u16, Value), String> {
        let response = self
            .egress
            .send(request)
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let body = response
            .text(RESPONSE_LIMIT)
            .await
            .map_err(|error| error.to_string())?;
        let value = if body.trim().is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_str(&body).unwrap_or(Value::Object(Default::default()))
        };
        Ok((status, value))
    }
}

#[async_trait]
impl Transport for HostTransport<'_> {
    async fn get_json(&self, url: &str) -> Result<(u16, Value), String> {
        let mut request = HttpRequest::get(url).header(header::ACCEPT, header::JSON);
        request.timeout = Some(REQUEST_TIMEOUT);
        self.send(request).await
    }

    async fn post_form(
        &self,
        url: &str,
        fields: &[(&str, String)],
        basic: Option<(&str, &str)>,
    ) -> Result<(u16, Value), String> {
        let body = form_encode(fields);
        let mut request = HttpRequest::post(url, body)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(header::ACCEPT, header::JSON);
        if let Some((id, secret)) = basic {
            request = request.header(
                header::AUTHORIZATION,
                format!("Basic {}", base64(&format!("{id}:{secret}"))),
            );
        }
        request.timeout = Some(REQUEST_TIMEOUT);
        self.send(request).await
    }
}

/// `application/x-www-form-urlencoded`（Node `new URLSearchParams(fields).toString()`）。
fn form_encode(fields: &[(&str, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in fields {
        serializer.append_pair(name, value);
    }
    serializer.finish()
}

/// `client_secret_basic` 的 `client_id:client_secret`（RFC 6749 §2.3.1）。
fn base64(value: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(value)
}

#[cfg(test)]
#[path = "mcp_oauth_tests.rs"]
mod tests;

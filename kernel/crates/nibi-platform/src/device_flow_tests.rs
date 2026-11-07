//! Device Flow 的形状、轮询与刷新（对着 Node `nibi-device-login.ts`）。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;

/// 记录请求并按队列回包的替身传输。
#[derive(Default)]
struct Fake {
    replies: Mutex<VecDeque<Result<(u16, Value), String>>>,
    posts: Mutex<Vec<(String, Vec<(String, String)>)>>,
    gets: Mutex<Vec<(String, String)>>,
}

impl Fake {
    fn with(replies: Vec<Result<(u16, Value), String>>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            ..Self::default()
        }
    }

    fn next(&self) -> Result<(u16, Value), String> {
        self.replies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
            .unwrap_or_else(|| Err("no reply queued".to_owned()))
    }

    fn posts(&self) -> Vec<(String, Vec<(String, String)>)> {
        self.posts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

#[async_trait]
impl Transport for Fake {
    async fn post_form(
        &self,
        url: &str,
        fields: &[(&str, String)],
    ) -> Result<(u16, Value), String> {
        self.posts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((
                url.to_owned(),
                fields
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), value.clone()))
                    .collect(),
            ));
        self.next()
    }

    async fn get_bearer(&self, url: &str, token: &str) -> Result<(u16, Value), String> {
        self.gets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((url.to_owned(), token.to_owned()));
        self.next()
    }
}

fn authorization_payload() -> Value {
    json!({
        "device_code": "dc",
        "user_code": "UC-1",
        "verification_uri": "https://auth/device",
        "verification_uri_complete": "https://auth/device?uc=UC-1",
        "expires_in": 300,
        "interval": 1
    })
}

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
    let form = device_authorization_form(TUI_CLIENT_ID, OIDC_SCOPE);
    assert_eq!(form[0], ("client_id", TUI_CLIENT_ID.to_owned()));
    assert!(form[1].1.contains(OIDC_PROJECT_ID));
    let token = token_form(TUI_CLIENT_ID, "dev-code");
    assert_eq!(token[1].1, "dev-code");
    assert_eq!(token[2].1, DEVICE_GRANT_TYPE);
    let refresh = refresh_form(TUI_CLIENT_ID, "rt");
    assert_eq!(refresh[1], ("grant_type", REFRESH_GRANT_TYPE.to_owned()));
    assert_eq!(refresh[2], ("refresh_token", "rt".to_owned()));
}

#[test]
fn parses_authorization_and_clamps_interval() {
    let parsed = parse_device_authorization(&authorization_payload(), 1_000).unwrap();
    assert_eq!(parsed.device_code, "dc");
    assert_eq!(parsed.user_code, "UC-1");
    assert_eq!(parsed.interval_ms, 1_000);
    assert_eq!(parsed.expires_at_ms, 301_000);
    assert_eq!(
        parsed.verification_uri_complete.as_deref(),
        Some("https://auth/device?uc=UC-1")
    );
}

#[test]
fn default_interval_is_five_seconds() {
    let parsed = parse_device_authorization(
        &json!({
            "device_code": "dc", "user_code": "UC", "verification_uri": "u", "expires_in": 60
        }),
        0,
    )
    .unwrap();
    assert_eq!(parsed.interval_ms, DEFAULT_POLL_INTERVAL_MS);
    assert_eq!(parsed.expires_at_ms, 60_000);
}

#[test]
fn missing_required_field_is_an_error() {
    assert!(matches!(
        parse_device_authorization(&json!({ "device_code": "dc" }), 0).unwrap_err(),
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
    // 未知错误按 Node 抛出（有描述用描述，没有就 `登录失败（<error>）`）。
    assert_eq!(
        parse_poll_failure(400, &json!({"error": "invalid_grant", "error_description": "nope"})),
        PollResult::Failed {
            message: "nope".to_owned()
        }
    );
    assert_eq!(
        parse_poll_failure(500, &json!({})),
        PollResult::Failed {
            message: "登录失败（http_500）".to_owned()
        }
    );
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

#[tokio::test]
async fn the_client_uses_the_documented_endpoints_and_forms() {
    let fake = Fake::with(vec![
        Ok((200, authorization_payload())),
        Ok((200, json!({"access_token": "at", "expires_in": 60}))),
        Ok((200, json!({"access_token": "at2", "refresh_token": "rt2"}))),
        Ok((200, json!({"sub": "user-1", "email": "u@example.test"}))),
    ]);
    let client = Client::with_defaults(&fake, "https://auth.example.test/", || 1_000);

    let authorization = client.start().await.unwrap();
    assert_eq!(authorization.expires_at_ms, 301_000);
    assert_eq!(
        client.poll("dc").await.unwrap(),
        PollResult::Ready {
            token: TokenSet {
                access_token: "at".to_owned(),
                token_type: None,
                scope: None,
                id_token: None,
                refresh_token: None,
                expires_at_ms: Some(61_000),
            }
        }
    );
    assert_eq!(client.refresh("rt").await.unwrap().refresh_token.as_deref(), Some("rt2"));
    assert_eq!(client.user_info("at").await.unwrap().email.as_deref(), Some("u@example.test"));

    let posts = fake.posts();
    assert_eq!(posts[0].0, "https://auth.example.test/oauth/v2/device_authorization");
    assert_eq!(posts[1].0, "https://auth.example.test/oauth/v2/token");
    assert_eq!(posts[1].1[1], ("device_code".to_owned(), "dc".to_owned()));
    assert_eq!(posts[2].1[1].1, REFRESH_GRANT_TYPE);
    assert_eq!(
        fake.gets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_slice(),
        [(
            "https://auth.example.test/oidc/v1/userinfo".to_owned(),
            "at".to_owned()
        )]
    );
}

#[tokio::test]
async fn polling_follows_slow_down_and_returns_the_token() {
    // pending → slow_down → ready；时钟每次读前进 1 秒。
    let fake = Fake::with(vec![
        Ok((400, json!({"error": "authorization_pending"}))),
        Ok((400, json!({"error": "slow_down", "interval": 1}))),
        Ok((200, json!({"access_token": "at", "refresh_token": "rt"}))),
    ]);
    let clock = AtomicU64::new(0);
    let client = Client::with_defaults(&fake, "https://auth", || {
        clock.fetch_add(1_000, Ordering::SeqCst)
    });
    let authorization = DeviceAuthorization {
        device_code: "dc".to_owned(),
        user_code: "UC".to_owned(),
        verification_uri: "u".to_owned(),
        verification_uri_complete: None,
        interval_ms: 1,
        expires_at_ms: 60_000,
    };
    let token = client
        .poll_until_ready(&authorization, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(token.access_token, "at");
    assert_eq!(fake.posts().len(), 3);
}

#[tokio::test]
async fn polling_stops_when_the_device_code_expires() {
    let fake = Fake::with(vec![
        Ok((400, json!({"error": "authorization_pending"}))),
        Ok((400, json!({"error": "authorization_pending"}))),
        Ok((400, json!({"error": "authorization_pending"}))),
    ]);
    let clock = AtomicU64::new(0);
    let client = Client::with_defaults(&fake, "https://auth", || {
        clock.fetch_add(1_000, Ordering::SeqCst)
    });
    let authorization = DeviceAuthorization {
        device_code: "dc".to_owned(),
        user_code: "UC".to_owned(),
        verification_uri: "u".to_owned(),
        verification_uri_complete: None,
        interval_ms: 1,
        // 两次轮询之后过期。
        expires_at_ms: 2_500,
    };
    assert!(matches!(
        client
            .poll_until_ready(&authorization, &CancellationToken::new())
            .await,
        Err(DeviceFlowError::TimedOut)
    ));
}

#[tokio::test]
async fn polling_honours_cancellation_and_terminal_errors() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let fake = Fake::default();
    let client = Client::with_defaults(&fake, "https://auth", || 0);
    let authorization = DeviceAuthorization {
        device_code: "dc".to_owned(),
        user_code: "UC".to_owned(),
        verification_uri: "u".to_owned(),
        verification_uri_complete: None,
        interval_ms: 1_000,
        expires_at_ms: 60_000,
    };
    assert!(matches!(
        client.poll_until_ready(&authorization, &cancel).await,
        Err(DeviceFlowError::Cancelled)
    ));
    assert!(fake.posts().is_empty());

    let denied = Fake::with(vec![Ok((400, json!({"error": "access_denied"})))]);
    let client = Client::with_defaults(&denied, "https://auth", || 0);
    assert!(matches!(
        client
            .poll_until_ready(&authorization, &CancellationToken::new())
            .await,
        Err(DeviceFlowError::Denied)
    ));
}

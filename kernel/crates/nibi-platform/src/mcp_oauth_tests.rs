//! MCP OAuth：发现链、两种 grant、共享凭据的记录读取（对着 Node `mcp/oauth*.ts`）。

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::*;

#[derive(Default)]
struct Fake {
    gets: Mutex<VecDeque<(u16, Value)>>,
    posts: Mutex<VecDeque<(u16, Value)>>,
    seen: Mutex<Vec<(String, Vec<(String, String)>, Option<(String, Option<String>)>)>>,
    urls: Mutex<Vec<String>>,
}

impl Fake {
    fn with(gets: Vec<(u16, Value)>, posts: Vec<(u16, Value)>) -> Self {
        Self {
            gets: Mutex::new(gets.into()),
            posts: Mutex::new(posts.into()),
            ..Self::default()
        }
    }
}

#[async_trait]
impl Transport for Fake {
    async fn get_json(&self, url: &str) -> Result<(u16, Value), String> {
        self.urls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(url.to_owned());
        Ok(self
            .gets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
            .unwrap_or((404, json!({}))))
    }

    async fn post_form(
        &self,
        url: &str,
        fields: &[(&str, String)],
        basic: Option<(&str, &str)>,
    ) -> Result<(u16, Value), String> {
        self.seen.lock().unwrap_or_else(PoisonError::into_inner).push((
            url.to_owned(),
            fields
                .iter()
                .map(|(name, value)| ((*name).to_owned(), value.clone()))
                .collect(),
            basic.map(|(id, secret)| (id.to_owned(), Some(secret.to_owned()))),
        ));
        Ok(self
            .posts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
            .unwrap_or((500, json!({}))))
    }
}

#[tokio::test]
async fn client_credentials_discovers_and_requests_a_token() {
    let fake = Fake::with(
        vec![
            // protected-resource 元数据：指向授权服务器。
            (
                200,
                json!({"authorization_servers": ["https://auth.example.test"]}),
            ),
            (
                200,
                json!({"token_endpoint": "https://auth.example.test/token"}),
            ),
        ],
        vec![(
            200,
            json!({"access_token": "at", "expires_in": 3600}),
        )],
    );
    let token = client_credentials(
        &fake,
        "https://mcp.example.test/mcp",
        "client-1",
        "secret-1",
        Some("mcp.read"),
        1_000,
    )
    .await
    .unwrap();
    assert_eq!(token.access_token, "at");
    assert_eq!(token.expires_at_ms, Some(3_601_000));
    let urls = fake.urls.lock().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(
        urls.as_slice(),
        [
            "https://mcp.example.test/.well-known/oauth-protected-resource".to_owned(),
            "https://auth.example.test/.well-known/oauth-authorization-server".to_owned(),
        ]
    );
    let posts = fake.seen.lock().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(posts[0].0, "https://auth.example.test/token");
    assert_eq!(posts[0].1[0], ("grant_type".to_owned(), "client_credentials".to_owned()));
    assert_eq!(posts[0].1[1], ("scope".to_owned(), "mcp.read".to_owned()));
    assert_eq!(
        posts[0].2,
        Some(("client-1".to_owned(), Some("secret-1".to_owned())))
    );
}

#[tokio::test]
async fn discovery_falls_back_to_openid_and_the_server_origin() {
    let fake = Fake::with(
        vec![
            (404, json!({})),
            (404, json!({})),
            (
                200,
                json!({"issuer": "https://auth.example.test", "token_endpoint": "https://auth.example.test/t"}),
            ),
        ],
        vec![],
    );
    let server = discover(&fake, "https://auth.example.test/mcp").await.unwrap();
    assert_eq!(server.token_endpoint, "https://auth.example.test/t");
    assert_eq!(server.issuer.as_deref(), Some("https://auth.example.test"));
}

#[tokio::test]
async fn a_missing_discovery_document_is_an_error() {
    let fake = Fake::with(vec![(404, json!({})), (404, json!({})), (404, json!({}))], vec![]);
    assert!(matches!(
        discover(&fake, "https://mcp.example.test").await,
        Err(OAuthError::Discovery(_))
    ));
}

#[tokio::test]
async fn refresh_sends_the_refresh_grant_and_keeps_the_new_pair() {
    let fake = Fake::with(
        vec![],
        vec![(
            200,
            json!({"access_token": "at2", "refresh_token": "rt2", "expires_in": 60}),
        )],
    );
    let token = refresh(
        &fake,
        "https://auth.example.test/token",
        "client-1",
        Some("secret-1"),
        "rt1",
        5_000,
    )
    .await
    .unwrap();
    assert_eq!(token.access_token, "at2");
    assert_eq!(token.refresh_token.as_deref(), Some("rt2"));
    assert_eq!(token.expires_at_ms, Some(65_000));
    let posts = fake.seen.lock().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(posts[0].1[1], ("refresh_token".to_owned(), "rt1".to_owned()));
}

#[test]
fn the_credential_key_matches_node() {
    // Node：`mcp:oauth:` + sha256("name\nurl\nclientId\nscope\nredirectPath") 的前 24 个 hex。
    let prefix = credential_key_prefix("srv", "https://mcp.example.test", "c1", "scope", "");
    assert!(prefix.starts_with("mcp:oauth:"));
    assert_eq!(prefix.len(), "mcp:oauth:".len() + 24);
    assert_eq!(
        credential_key(&prefix),
        format!("{prefix}:authorization_credentials")
    );
    // 同样的输入稳定，换一个字段就变。
    assert_eq!(
        prefix,
        credential_key_prefix("srv", "https://mcp.example.test", "c1", "scope", "")
    );
    assert_ne!(
        prefix,
        credential_key_prefix("srv", "https://mcp.example.test", "c2", "scope", "")
    );
}

#[test]
fn stored_tokens_and_expiry_come_from_the_node_record() {
    let record = json!({
        "version": 2,
        "client_information": {"client_id": "c1", "client_secret": "s1"},
        "tokens": {"access_token": "at", "refresh_token": "rt", "expires_in": 3600},
        "obtained_at": 1_000,
        "expires_at": 3_601_000
    });
    let token = tokens_from_record(&record).unwrap();
    assert_eq!(token.access_token, "at");
    assert_eq!(token.refresh_token.as_deref(), Some("rt"));
    assert_eq!(token.expires_at_ms, Some(3_601_000));
    assert_eq!(
        client_from_record(&record),
        Some(("c1".to_owned(), Some("s1".to_owned())))
    );
    // 只给了 obtained_at + expires_in 时也能算绝对过期点。
    let without_absolute = json!({
        "tokens": {"access_token": "at", "expires_in": 60},
        "obtained_at": 10_000
    });
    assert_eq!(
        tokens_from_record(&without_absolute).unwrap().expires_at_ms,
        Some(70_000)
    );
    // 记录缺 access_token 时按「没有」处理。
    assert_eq!(code_for(&json!({"tokens": {"access_token": "at"}})), Some("at".to_owned()));
    assert_eq!(code_for(&json!({"tokens": {}})), None);
}

/// 记录缺 `access_token` 时按「没有」处理。
fn code_for(record: &Value) -> Option<String> {
    tokens_from_record(record).map(|token| token.access_token)
}

#[test]
fn near_expiry_uses_the_sixty_second_margin() {
    let token = Token {
        access_token: "at".to_owned(),
        refresh_token: Some("rt".to_owned()),
        expires_at_ms: Some(100_000),
    };
    assert!(near_expiry(&token, 40_000));
    assert!(!near_expiry(&token, 20_000));
    let no_expiry = Token {
        access_token: "at".to_owned(),
        refresh_token: None,
        expires_at_ms: None,
    };
    assert!(!near_expiry(&no_expiry, u64::MAX / 2));
}

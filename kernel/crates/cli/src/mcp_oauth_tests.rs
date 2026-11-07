//! MCP OAuth 端口：共享凭据的键与并发换代的判定（网络部分是 `nibi-platform::mcp_oauth` 的测试）。

use nibi_kernel_api::mcp::{McpOAuthConfig, McpOAuthRequest};
use nibi_platform::mcp_oauth::Token;

use super::*;

fn token(access_token: &str) -> Token {
    Token {
        access_token: access_token.to_owned(),
        token_type: "Bearer".to_owned(),
        refresh_token: Some("rt".to_owned()),
        scope: None,
        expires_at_ms: None,
    }
}

#[test]
fn the_record_key_matches_the_shared_credential_layout() {
    let request = McpOAuthRequest {
        server: "linear".to_owned(),
        url: "https://mcp.linear.app/mcp".to_owned(),
        config: McpOAuthConfig::AuthorizationCode {
            client_id: None,
            client_secret: None,
            client_name: None,
            scope: None,
            redirect_path: None,
        },
    };
    // Node `createCredentialKeyPrefix` + `mcpOAuthCredentialKey`。
    assert_eq!(
        McpOAuth::record_key(&request).as_deref(),
        Some("mcp:oauth:8e2536fc8757955d76e35957:authorization_credentials")
    );
    // `client_credentials` 不用文件凭据。
    let credentials = McpOAuthRequest {
        config: McpOAuthConfig::ClientCredentials {
            client_id: "c".to_owned(),
            client_secret: "s".to_owned(),
            client_name: None,
            scope: None,
        },
        ..request
    };
    assert_eq!(McpOAuth::record_key(&credentials), None);
}

#[test]
fn a_token_refreshed_elsewhere_is_reused() {
    // 被拒的正是当前记录里的那枚：要换。
    assert!(!already_refreshed(Some("at1"), &token("at1")));
    // 记录已经换代（另一个进程刷新过）：直接用新的，不再换一次。
    assert!(already_refreshed(Some("at1"), &token("at2")));
    // 主动刷新（没有 401）：照常换。
    assert!(!already_refreshed(None, &token("at1")));
}

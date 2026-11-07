//! OAuth 与现代握手（Node `AuthProvider` + `versionNegotiation` 的等份）：令牌注入、401 刷新一次、
//! `server/discover` 探测与两代握手。
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use nibi_kernel_base::TaskScope;
use nibi_kernel_api::mcp::{
    McpOAuthConfig, McpOAuthPort, McpOAuthRequest, McpProtocolVersion,
};
use nibi_kernel_api::mcp_status::{McpFailureKind, McpProtocolEra};
use serde_json::json;

use super::*;
use crate::mcp::McpScope;
use crate::test_support::{FakeMcp, server, workspace};

/// 令牌端口的替身：`access_token` 给第一个令牌，`refresh` 给第二个并记次数。
struct FakeTokens {
    first: String,
    next: String,
    refreshes: AtomicUsize,
}

impl FakeTokens {
    fn new(first: &str, next: &str) -> Arc<Self> {
        Arc::new(Self {
            first: first.to_owned(),
            next: next.to_owned(),
            refreshes: AtomicUsize::new(0),
        })
    }

    fn refreshes(&self) -> usize {
        self.refreshes.load(Ordering::Relaxed)
    }
}

#[async_trait]
impl McpOAuthPort for FakeTokens {
    async fn access_token(&self, _request: &McpOAuthRequest) -> Option<String> {
        Some(self.first.clone())
    }

    async fn refresh(
        &self,
        _request: &McpOAuthRequest,
        _rejected: Option<&str>,
    ) -> Result<String, String> {
        self.refreshes.fetch_add(1, Ordering::Relaxed);
        Ok(self.next.clone())
    }
}

fn oauth_server(name: &str, protocol: McpProtocolVersion) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::Http {
            url: "https://mcp.example.com/mcp".to_owned(),
            headers: Default::default(),
        },
        options: Default::default(),
        machine: None,
        oauth: Some(McpOAuthConfig::AuthorizationCode {
            client_id: None,
            client_secret: None,
            client_name: None,
            scope: None,
            redirect_path: None,
        }),
        protocol,
    }
}

fn tools_server() -> Arc<crate::test_support::Handler> {
    server(json!({"tools": {}}), None, |method, _| match method {
        "tools/list" => Some(Ok(json!({"tools": [
            {"name": "read", "description": "Read", "inputSchema": {"type": "object"}}
        ]}))),
        _ => None,
    })
}

fn manager(fake: Arc<FakeMcp>, scope: &TaskScope) -> McpManager {
    McpManager::new(
        fake,
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::TokioClock::new(),
    )
}

#[tokio::test]
async fn the_token_is_sent_as_a_bearer_header() {
    let fake = Arc::new(FakeMcp::default().with("s", tools_server()));
    let scope = TaskScope::root("oauth", |_| {});
    let manager = manager(fake.clone(), &scope);
    manager.attach_oauth(FakeTokens::new("t1", "t2"));
    manager.start(workspace(), vec![oauth_server("s", McpProtocolVersion::Auto)]);
    manager.wait_ready().await;
    assert_eq!(manager.status(), [("s".to_owned(), McpStatus::Connected)]);
    assert_eq!(
        fake.authorizations(),
        [("s".to_owned(), Some("Bearer t1".to_owned()))]
    );
}

#[tokio::test]
async fn a_401_refreshes_the_token_once_and_reconnects() {
    let fake = Arc::new(FakeMcp::default().with("s", tools_server()));
    fake.reject_initialize("s", 1);
    let scope = TaskScope::root("oauth", |_| {});
    let manager = manager(fake.clone(), &scope);
    let tokens = FakeTokens::new("t1", "t2");
    manager.attach_oauth(tokens.clone());
    manager.start(workspace(), vec![oauth_server("s", McpProtocolVersion::Auto)]);
    manager.wait_ready().await;
    assert_eq!(manager.status(), [("s".to_owned(), McpStatus::Connected)]);
    assert_eq!(tokens.refreshes(), 1);
    assert_eq!(
        fake.authorizations(),
        [
            ("s".to_owned(), Some("Bearer t1".to_owned())),
            ("s".to_owned(), Some("Bearer t2".to_owned())),
        ]
    );
}

#[tokio::test]
async fn a_401_without_a_token_port_is_an_authorization_failure() {
    let fake = Arc::new(FakeMcp::default().with("s", tools_server()));
    fake.reject_initialize("s", 5);
    let scope = TaskScope::root("oauth", |_| {});
    let manager = manager(fake.clone(), &scope);
    manager.start(workspace(), vec![oauth_server("s", McpProtocolVersion::Auto)]);
    manager.wait_ready().await;
    match &manager.status()[0].1 {
        McpStatus::Failed { kind, .. } => {
            assert_eq!(*kind, McpFailureKind::OauthAuthorizationFailed)
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_modern_probe_is_only_for_auto_and_pinned_servers() {
    // `legacy` 不探测；`auto` 与钉住都探测（探测的判定在 `connection` 里）。
    assert_eq!(McpProtocolVersion::default(), McpProtocolVersion::Auto);
    assert_ne!(McpProtocolVersion::Legacy, McpProtocolVersion::Auto);
}

#[tokio::test]
async fn a_modern_server_skips_initialize_and_carries_the_meta_envelope() {
    let modern = Arc::new(
        |method: &str, params: &serde_json::Value| match method {
            "server/discover" => Some(Ok(json!({
                "ttlMs": 0,
                "cacheScope": "private",
                "supportedVersions": ["2026-07-28"],
                "capabilities": {"tools": {}},
                "instructions": "Modern server.",
            }))),
            "tools/list" => Some(Ok(json!({"tools": [
                {"name": "read", "description": "Read", "inputSchema": {"type": "object"}}
            ]}))),
            "initialize" => panic!("a modern connection never sends initialize"),
            _ => {
                let _ = params;
                None
            }
        },
    );
    let fake = Arc::new(FakeMcp::default().with("s", modern));
    let scope = TaskScope::root("modern", |_| {});
    let manager = manager(fake.clone(), &scope);
    manager.start(
        workspace(),
        vec![McpServer {
            oauth: None,
            ..oauth_server("s", McpProtocolVersion::Auto)
        }],
    );
    manager.wait_ready().await;
    assert_eq!(manager.status(), [("s".to_owned(), McpStatus::Connected)]);
    // `mcp/list` 报现代，instructions 来自 discover 的结果。
    let infos = manager.server_infos();
    assert_eq!(infos[0].state, nibi_kernel_api::manage::McpServerState::Connected);
    assert_eq!(
        manager.protocol_era("s"),
        Some(McpProtocolEra::Modern),
        "the connection reports the modern era"
    );
    assert_eq!(
        manager.instructions_of("s").as_deref(),
        Some("Modern server.")
    );
    // 现代连接的每个请求都带信封。
    let listed = fake
        .received()
        .into_iter()
        .find(|(_, message)| message["method"] == "tools/list")
        .expect("tools/list");
    assert_eq!(
        listed.1["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
        json!("2026-07-28")
    );
    assert!(
        listed.1["params"]["_meta"]["io.modelcontextprotocol/clientInfo"].is_object(),
        "{}",
        listed.1
    );
}

#[tokio::test]
async fn a_server_without_discover_falls_back_to_initialize() {
    let legacy = server(json!({"tools": {}}), None, |method, _| match method {
        "server/discover" => Some(Err((-32601, "Method not found".to_owned()))),
        "tools/list" => Some(Ok(json!({"tools": [
            {"name": "read", "description": "Read", "inputSchema": {"type": "object"}}
        ]}))),
        _ => None,
    });
    let fake = Arc::new(FakeMcp::default().with("s", legacy));
    let scope = TaskScope::root("legacy", |_| {});
    let manager = manager(fake.clone(), &scope);
    manager.start(
        workspace(),
        vec![McpServer {
            oauth: None,
            ..oauth_server("s", McpProtocolVersion::Auto)
        }],
    );
    manager.wait_ready().await;
    assert_eq!(manager.status(), [("s".to_owned(), McpStatus::Connected)]);
    assert_eq!(manager.protocol_era("s"), Some(McpProtocolEra::Legacy));
    assert!(
        fake.received()
            .iter()
            .any(|(_, message)| message["method"] == "initialize")
    );
}

#[tokio::test]
async fn a_pinned_modern_server_that_offers_legacy_fails_negotiation() {
    let legacy = server(json!({"tools": {}}), None, |method, _| match method {
        "server/discover" => Some(Err((-32601, "Method not found".to_owned()))),
        _ => None,
    });
    let fake = Arc::new(FakeMcp::default().with("s", legacy));
    let scope = TaskScope::root("pinned", |_| {});
    let manager = manager(fake.clone(), &scope);
    manager.start(
        workspace(),
        vec![McpServer {
            oauth: None,
            ..oauth_server("s", McpProtocolVersion::Modern)
        }],
    );
    manager.wait_ready().await;
    match &manager.status()[0].1 {
        McpStatus::Failed { kind, reason } => {
            assert_eq!(*kind, McpFailureKind::ProtocolNegotiationFailed);
            assert!(reason.contains("2026-07-28"), "{reason}");
        }
        other => panic!("{other:?}"),
    }
}

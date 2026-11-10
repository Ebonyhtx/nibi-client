//! 工作区 MCP 信任（A5/A6）：摘要、失效、损坏与装载闸门。

use std::sync::Arc;

use nibi_kernel_api::mcp::{McpOAuthConfig, McpProtocolVersion, McpTransportConfig};
use nibi_kernel_base::TaskScope;
use serde_json::json;

use super::*;
use crate::mcp::{McpManager, McpServerOptions, McpSettings};
use crate::test_support::{FakeMcp, workspace};

fn stdio(name: &str, command: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::Stdio {
            command: command.to_owned(),
            args: Vec::new(),
            env: Default::default(),
            cwd: None,
        },
        options: McpServerOptions::default(),
        machine: None,
        oauth: None,
        protocol: McpProtocolVersion::Auto,
    }
}

fn record(identity: &str, server: &str, digest: &str) -> ProjectMcpTrustRecord {
    ProjectMcpTrustRecord {
        workspace_identity: identity.to_owned(),
        server_name: server.to_owned(),
        declaration_digest: digest.to_owned(),
    }
}

/// 与 Host `computeWorkspaceMcpDeclarationDigest` 共用的固定向量（TS 侧断言同一哈希）。
const DIGEST_VECTOR: &str = "/workspace/alpha";
const DIGEST_VECTOR_SERVER: &str = "probe";
const DIGEST_VECTOR_EXPECTED: &str =
    "6781e00d56fceeb639263a7ee238dcfe1c8f6b922616d91337acf85b78304d14";

#[test]
fn declaration_digest_uses_the_canonical_execution_config() {
    let server = stdio(DIGEST_VECTOR_SERVER, "node");
    assert_eq!(
        declaration_digest(DIGEST_VECTOR, &server),
        DIGEST_VECTOR_EXPECTED
    );
    // env / args 变化就是另一条声明。
    let mut changed = server.clone();
    changed.transport = McpTransportConfig::Stdio {
        command: "node".to_owned(),
        args: vec!["server.mjs".to_owned()],
        env: Default::default(),
        cwd: None,
    };
    assert_ne!(
        declaration_digest(DIGEST_VECTOR, &changed),
        DIGEST_VECTOR_EXPECTED
    );
}

#[test]
fn untrusted_project_server_is_rejected_and_never_loaded() {
    let server = stdio("probe", "node");
    let trust = ProjectMcpTrust::from_records(
        DIGEST_VECTOR,
        std::slice::from_ref(&server),
        Vec::new(),
        false,
    );
    assert!(trust.is_enforced());
    assert!(!trust.admits(&server));
    assert_eq!(
        trust.rejection(&server),
        Some(ProjectMcpRejection::PendingTrust)
    );
}

#[test]
fn changed_digest_invalidates_the_old_grant() {
    let server = stdio("probe", "node");
    let old = declaration_digest(DIGEST_VECTOR, &server);
    let mut changed = server.clone();
    changed.options.always_load = true;
    let trust = ProjectMcpTrust::from_records(
        DIGEST_VECTOR,
        std::slice::from_ref(&changed),
        vec![record(DIGEST_VECTOR, "probe", &old)],
        false,
    );
    assert!(!trust.admits(&changed));
    assert_eq!(
        trust.rejection(&changed),
        Some(ProjectMcpRejection::DeclarationChanged)
    );
}

#[test]
fn matching_record_admits_only_the_current_declaration() {
    let server = stdio("probe", "node");
    let digest = declaration_digest(DIGEST_VECTOR, &server);
    let trust = ProjectMcpTrust::from_records(
        DIGEST_VECTOR,
        std::slice::from_ref(&server),
        vec![record(DIGEST_VECTOR, "probe", &digest)],
        false,
    );
    assert!(trust.admits(&server));
    assert_eq!(trust.rejection(&server), None);
    // 其他工作区的同名记录不继承。
    let other = ProjectMcpTrust::from_records(
        "/workspace/beta",
        std::slice::from_ref(&server),
        vec![record(DIGEST_VECTOR, "probe", &digest)],
        false,
    );
    assert!(!other.admits(&server));
}

#[test]
fn corrupt_store_denies_even_with_matching_records() {
    let server = stdio("probe", "node");
    let digest = declaration_digest(DIGEST_VECTOR, &server);
    let trust = ProjectMcpTrust::from_records(
        DIGEST_VECTOR,
        std::slice::from_ref(&server),
        vec![record(DIGEST_VECTOR, "probe", &digest)],
        true,
    );
    assert!(!trust.admits(&server));
    assert_eq!(
        trust.rejection(&server),
        Some(ProjectMcpRejection::TrustStoreCorrupt)
    );
}

#[test]
fn user_dynamic_and_plugin_scopes_are_not_gated() {
    let trust = ProjectMcpTrust::from_records(DIGEST_VECTOR, &[], Vec::new(), true);
    for scope in [
        McpScope::User,
        McpScope::Local,
        McpScope::Dynamic,
        McpScope::Plugin,
        McpScope::Enterprise,
    ] {
        let mut server = stdio("probe", "node");
        server.scope = scope;
        assert!(trust.admits(&server), "{scope:?} must not be gated");
    }
}

#[test]
fn oauth_values_participate_in_the_digest_without_leaking_into_it_as_display() {
    let mut server = stdio("probe", "https://mcp.example.test/mcp");
    server.transport = McpTransportConfig::Http {
        url: "https://mcp.example.test/mcp".to_owned(),
        headers: Default::default(),
    };
    server.oauth = Some(McpOAuthConfig::ClientCredentials {
        client_id: "client".to_owned(),
        client_secret: "first".to_owned(),
        client_name: None,
        scope: None,
    });
    let first = declaration_digest(DIGEST_VECTOR, &server);
    server.oauth = Some(McpOAuthConfig::ClientCredentials {
        client_id: "client".to_owned(),
        client_secret: "second".to_owned(),
        client_name: None,
        scope: None,
    });
    assert_ne!(declaration_digest(DIGEST_VECTOR, &server), first);
    assert!(!first.contains("first"));
}

/// 真实装载闸门：未信任的项目服务器不触发任何连接；信任后同一 manager 仍按启动时的快照走。
#[tokio::test]
async fn manager_does_not_connect_untrusted_project_servers() {
    let fake = Arc::new(FakeMcp::default());
    let scope = TaskScope::root("trust", |_| {});
    let server = stdio("probe", "node");
    let identity = workspace().root.as_str().to_owned();
    let trust =
        ProjectMcpTrust::from_records(&identity, std::slice::from_ref(&server), Vec::new(), false);
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings {
            project_trust: trust,
            ..McpSettings::default()
        },
        crate::clock_tests::TokioClock::new(),
    );
    manager.start(workspace(), vec![server.clone()]);
    assert_eq!(
        manager.untrusted_project_servers().get("probe"),
        Some(&ProjectMcpRejection::PendingTrust)
    );
    manager.wait_ready().await;
    assert!(fake.received().is_empty());
    assert!(fake.roots().is_empty());
}

/// 已信任的项目服务器照常连接（闸门不是全局禁用）。
#[tokio::test]
async fn manager_connects_trusted_project_servers() {
    let fake = Arc::new(FakeMcp::default().with(
        "probe",
        crate::test_support::server(json!({"tools": {}}), None, |_, _| None),
    ));
    let scope = TaskScope::root("trust", |_| {});
    let server = stdio("probe", "node");
    let identity = workspace().root.as_str().to_owned();
    let digest = declaration_digest(&identity, &server);
    let trust = ProjectMcpTrust::from_records(
        &identity,
        std::slice::from_ref(&server),
        vec![record(&identity, "probe", &digest)],
        false,
    );
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings {
            project_trust: trust,
            ..McpSettings::default()
        },
        crate::clock_tests::TokioClock::new(),
    );
    manager.start(workspace(), vec![server]);
    manager.wait_ready().await;
    assert!(manager.untrusted_project_servers().is_empty());
    assert_eq!(manager.server_statuses().len(), 1);
    assert_eq!(fake.roots().len(), 1);
}

/// 诊断原因有稳定 reason code，不进模型上下文。
#[test]
fn rejection_reason_codes_are_stable() {
    assert_eq!(
        ProjectMcpRejection::PendingTrust.reason(),
        "workspace_mcp_pending_trust"
    );
    assert_eq!(
        ProjectMcpRejection::DeclarationChanged.reason(),
        "workspace_mcp_declaration_changed"
    );
    assert_eq!(
        ProjectMcpRejection::TrustStoreCorrupt.reason(),
        "workspace_mcp_trust_store_corrupt"
    );
}

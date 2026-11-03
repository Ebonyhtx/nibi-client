//! `mcp/list` 的状态类型（141 审计 §9 第 6 项）。

use crate::mcp::McpTransportConfig;
use crate::mcp_status::{
    McpFailureKind, McpProtocolEra, McpServerStatus, McpServerStatusKind, McpTransportKind,
};
use serde_json::json;

/// 失败分类的序列化用 Host 的 snake_case 词表（Host 的 schema 是封闭枚举）。
#[test]
fn failure_kinds_use_the_host_vocabulary() {
    let kinds = [
        (McpFailureKind::ConfigInvalid, "config_invalid"),
        (McpFailureKind::RuntimeUnavailable, "runtime_unavailable"),
        (McpFailureKind::ProcessStartFailed, "process_start_failed"),
        (McpFailureKind::NetworkUnreachable, "network_unreachable"),
        (McpFailureKind::ConnectionTimeout, "connection_timeout"),
        (
            McpFailureKind::ProtocolNegotiationFailed,
            "protocol_negotiation_failed",
        ),
        (McpFailureKind::ToolListFailed, "tool_list_failed"),
        (McpFailureKind::UnexpectedDisconnect, "unexpected_disconnect"),
        (
            McpFailureKind::OauthAuthorizationFailed,
            "oauth_authorization_failed",
        ),
        (
            McpFailureKind::OfficialOriginUntrusted,
            "official_origin_untrusted",
        ),
        (McpFailureKind::NotAuthenticated, "not_authenticated"),
        (McpFailureKind::CodingPlanRequired, "coding_plan_required"),
        (McpFailureKind::ServerNotFound, "server_not_found"),
        (McpFailureKind::ServerUnavailable, "server_unavailable"),
        (McpFailureKind::RateLimited, "rate_limited"),
        (McpFailureKind::ServerInternalError, "server_internal_error"),
        (McpFailureKind::ProtocolError, "protocol_error"),
        (McpFailureKind::StatusUnavailable, "status_unavailable"),
        (McpFailureKind::ConnectionFailed, "connection_failed"),
    ];
    for (kind, text) in kinds {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(text));
    }
}

/// 快照的 JSON 形状与 Host 的 camelCase 字段一致；缺席的可选字段不写出。
#[test]
fn a_status_snapshot_serializes_like_the_host_schema() {
    let status = McpServerStatus {
        name: "files".into(),
        status: McpServerStatusKind::Connected,
        transport: McpTransportKind::Stdio,
        tool_count: 3,
        updated_at_ms: 1_700_000_000_000,
        error: None,
        failure_kind: None,
        server_request_id: None,
        protocol_era: Some(McpProtocolEra::Legacy),
        authorization: None,
    };
    let value = serde_json::to_value(&status).unwrap();
    assert_eq!(
        value,
        json!({
            "name": "files",
            "status": "connected",
            "transport": "stdio",
            "toolCount": 3,
            "updatedAtMs": 1_700_000_000_000u64,
            "protocolEra": "legacy",
        })
    );
}

/// 从没连过的服务器是 `disconnected`；带 `oauth` 的是 `oauth_authorization_failed`。
#[test]
fn the_synthesized_snapshots_say_what_they_mean() {
    let idle = McpServerStatus::disconnected("idle", McpTransportKind::Http, 7);
    assert_eq!(idle.status, McpServerStatusKind::Disconnected);
    assert_eq!(idle.tool_count, 0);
    assert!(idle.error.is_none());

    let oauth = McpServerStatus::oauth_unsupported("oauth", McpTransportKind::Sse, 7);
    assert_eq!(oauth.status, McpServerStatusKind::Failed);
    assert_eq!(
        oauth.failure_kind,
        Some(McpFailureKind::OauthAuthorizationFailed)
    );
    assert!(oauth.error.unwrap().contains("OAuth"));
}

/// 传输种类从配置推导（`McpTransportConfig` 的三个值）。
#[test]
fn the_transport_kind_follows_the_configuration() {
    let stdio = McpTransportConfig::Stdio {
        command: "node".into(),
        args: Vec::new(),
        env: Default::default(),
        cwd: None,
    };
    let http = McpTransportConfig::Http {
        url: "https://example.invalid/mcp".into(),
        headers: Default::default(),
    };
    let sse = McpTransportConfig::Sse {
        url: "https://example.invalid/sse".into(),
        headers: Default::default(),
    };
    assert_eq!(stdio.kind(), McpTransportKind::Stdio);
    assert_eq!(http.kind(), McpTransportKind::Http);
    assert_eq!(sse.kind(), McpTransportKind::Sse);
}

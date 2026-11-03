//! 实例凭证（Node `mcp-ui/instances.ts`，141 审计 §9 第 6 项）：幂等、代际、校验与关闭。

use std::sync::Arc;

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::mcp_ui::{
    McpAppConnection, McpAppInstance, McpUiInstanceRequest, McpUiOpenRequest, McpUiScope,
};

use super::*;

fn scope() -> McpUiScope {
    McpUiScope {
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        workspace_identity: "/w".to_owned(),
        session: SessionId::new("s1"),
        plugin_id: "toolkit".to_owned(),
        server_name: "plugin:toolkit:panel".to_owned(),
    }
}

fn connection(generation: u64) -> McpAppConnection {
    McpAppConnection {
        identity: "a".repeat(64),
        generation,
    }
}

fn open(scope_id: &str) -> McpUiOpenRequest {
    McpUiOpenRequest {
        scope: scope(),
        scope_id: scope_id.to_owned(),
        resource_uri: "ui://panel.html".to_owned(),
        owner_web_contents_id: 7,
        account_context: None,
    }
}

fn request(instance: McpAppInstance) -> McpUiInstanceRequest {
    McpUiInstanceRequest {
        scope: scope(),
        instance,
    }
}

fn registry() -> Arc<McpAppInstances> {
    Arc::new(McpAppInstances::new("runtime-1".to_owned()))
}

/// 同一逻辑页面同连接代际幂等；不同作用域拿到新一代；账号上下文变了换新凭证。
#[test]
fn opening_the_same_page_twice_reuses_the_lease() {
    let registry = registry();
    let first = registry.open(open("scope-1"), connection(0));
    assert_eq!(first.runtime_id, "runtime-1");
    assert_eq!(first.generation, 1);
    assert_eq!(first.app_identity.len(), 64);
    assert!(!first.token.is_empty());

    let again = registry.open(open("scope-1"), connection(0));
    assert_eq!(again, first);

    let other = registry.open(open("scope-2"), connection(0));
    assert_eq!(other.generation, 2);
    assert_ne!(other.token, first.token);
    assert_eq!(other.app_identity, first.app_identity, "同一页面同一连接：应用身份稳定");

    let mut with_account = open("scope-3");
    with_account.account_context = Some("account-1".to_owned());
    let accounted = registry.open(with_account, connection(0));
    assert_ne!(accounted.app_identity, first.app_identity);

    // 连接换代：同一逻辑页面的旧凭证作废，拿到新代际。
    let renewed = registry.open(open("scope-1"), connection(1));
    assert_ne!(renewed.token, first.token);
    assert!(registry.validate(&request(first), Some(connection(0))).is_err());
}

/// 校验：凭证、作用域与当前连接三者都对上才算有效；当前连接对不上会直接撤销凭证。
#[test]
fn validation_checks_the_lease_scope_and_connection() {
    let registry = registry();
    let lease = registry.open(open("scope-1"), connection(0));
    assert_eq!(
        registry
            .validate(&request(lease.clone()), Some(connection(0)))
            .expect("valid"),
        "ui://panel.html"
    );

    // 篡改代际 / token / 应用身份。
    for tampered in [
        McpAppInstance {
            generation: lease.generation + 1,
            ..lease.clone()
        },
        McpAppInstance {
            app_identity: "b".repeat(64),
            ..lease.clone()
        },
        McpAppInstance {
            runtime_id: "other".to_owned(),
            ..lease.clone()
        },
    ] {
        assert!(registry.validate(&request(tampered), Some(connection(0))).is_err());
    }
    // 作用域不对：别的会话 / 插件 / 服务器。
    let mut elsewhere = request(lease.clone());
    elsewhere.scope.session = SessionId::new("s2");
    assert!(registry.validate(&elsewhere, Some(connection(0))).is_err());
    let mut other_plugin = request(lease.clone());
    other_plugin.scope.plugin_id = "other".to_owned();
    assert!(registry.validate(&other_plugin, Some(connection(0))).is_err());
    let mut other_server = request(lease.clone());
    other_server.scope.server_name = "other".to_owned();
    assert!(registry.validate(&other_server, Some(connection(0))).is_err());

    // 当前连接换了代际：拒绝一次之后就作废了（即使再拿旧快照也无效）。
    assert!(
        registry
            .validate(&request(lease.clone()), Some(connection(1)))
            .is_err()
    );
    assert!(
        registry
            .validate(&request(lease.clone()), Some(connection(0)))
            .is_err(),
        "连接对不上会撤销凭证"
    );
    assert!(registry.validate(&request(lease), None).is_err());
}

/// 关闭：先移除再取消；重复关闭是 false；错的凭证关不掉真的实例。
#[test]
fn closing_removes_the_credential_first() {
    let registry = registry();
    let lease = registry.open(open("scope-1"), connection(0));
    let wrong = McpAppInstance {
        generation: lease.generation + 1,
        ..lease.clone()
    };
    assert!(!registry.close(&wrong));
    assert!(registry.validate(&request(lease.clone()), Some(connection(0))).is_ok());
    assert!(registry.close(&lease));
    assert!(!registry.close(&lease));
    assert!(registry.validate(&request(lease), Some(connection(0))).is_err());
}

/// 会话关闭只撤销自己的实例。
#[test]
fn closing_a_session_only_drops_its_instances() {
    let registry = registry();
    let mine = registry.open(open("scope-1"), connection(0));
    let mut other = open("scope-2");
    other.scope.session = SessionId::new("s2");
    let theirs = registry.open(other, connection(0));
    registry.close_session("s1");
    assert!(registry.validate(&request(mine), Some(connection(0))).is_err());
    let mut their_request = request(theirs);
    their_request.scope.session = SessionId::new("s2");
    assert!(
        registry
            .validate(&their_request, Some(connection(0)))
            .is_ok()
    );
}

/// 占位：进行中的调用让 `onlyIfIdle` 看到忙；释放后恢复。
#[test]
fn a_retained_instance_is_busy_until_released() {
    let registry = registry();
    let lease = registry.open(open("scope-1"), connection(0));
    assert!(!registry.is_busy(&lease));
    let (signal, retain) = registry.retain(&lease.token).expect("retained");
    assert!(!signal.is_cancelled());
    assert!(registry.is_busy(&lease));
    drop(retain);
    assert!(!registry.is_busy(&lease));
    // 关实例触发取消令牌。
    let (signal, retain) = registry.retain(&lease.token).expect("retained");
    registry.close(&lease);
    assert!(signal.is_cancelled());
    drop(retain);
}

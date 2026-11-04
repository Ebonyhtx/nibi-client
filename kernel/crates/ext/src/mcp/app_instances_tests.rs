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

/// 并发 open 同一逻辑页面：每个线程都必须拿到同一张凭证。Node 的单线程事件循环让
/// check-and-insert 天然原子；Rust 的 IPC 线程会并发进来，所以 `open` 需要自己串行化。
#[test]
fn concurrent_opens_share_one_lease() {
    let registry = registry();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let mut threads = Vec::new();
    for _ in 0..8 {
        let registry = registry.clone();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            let mut tokens = Vec::new();
            for _ in 0..50 {
                tokens.push(registry.open(open("scope-1"), connection(0)).token);
            }
            tokens
        }));
    }
    let tokens: Vec<String> = threads
        .into_iter()
        .flat_map(|thread| thread.join().expect("thread"))
        .collect();
    let first = tokens.first().cloned().unwrap_or_default();
    assert!(tokens.iter().all(|token| token == &first), "{tokens:?}");
    assert_eq!(lock(&registry.records).len(), 1);
}

/// 一个服务器的连接断了：只有绑定它的凭证失效，别的服务器与会话不受影响。
#[test]
fn closing_a_server_revokes_only_its_leases() {
    let registry = registry();
    let keep = registry.open(open("scope-1"), connection(0));
    let mut other = open("scope-2");
    other.scope.server_name = "plugin:toolkit:other".to_owned();
    let drop = registry.open(other, connection(0));
    registry.close_server(Some("s1"), "plugin:toolkit:other");
    assert!(registry.validate(&request(keep.clone()), Some(connection(0))).is_ok());
    assert!(!registry.is_known(&drop.token));
    assert!(registry.is_known(&keep.token));
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

/// 调用账本：同一个 `callId` 不能重复；取消触发令牌；结束后也不能复用。
#[test]
fn call_ledger_deduplicates_and_cancels() {
    let registry = registry();
    let lease = registry.open(open("scope-1"), connection(0));
    let guard = registry
        .begin_call("s1", &lease, "call-1")
        .expect("accepted");
    let token = guard.token();
    assert!(registry.is_busy(&lease), "进行中的调用占住实例");

    // 进行中重复：拒绝，且不占第二个位。
    assert!(registry.begin_call("s1", &lease, "call-1").is_err());

    assert!(registry.cancel_call("s1", &lease, "call-1"));
    assert!(token.is_cancelled());

    // 已结束的 callId 不再接纳；取消回 false。
    assert!(registry.begin_call("s1", &lease, "call-1").is_err());
    assert!(!registry.cancel_call("s1", &lease, "call-1"));
    drop(guard);
    assert!(!registry.is_busy(&lease));

    // 别的会话可以用同一个 callId（键里有会话）。
    let mut other = scope();
    other.session = SessionId::new("s2");
    let their_lease = registry.open(
        McpUiOpenRequest {
            scope: other,
            scope_id: "scope-2".to_owned(),
            resource_uri: "ui://panel.html".to_owned(),
            owner_web_contents_id: 7,
            account_context: None,
        },
        connection(0),
    );
    assert!(registry.begin_call("s2", &their_lease, "call-1").is_ok());
}

/// 关实例先撤账本：进行中的调用被取消，凭证不在之后不能再接纳。
#[test]
fn closing_an_instance_clears_its_calls() {
    let registry = registry();
    let lease = registry.open(open("scope-1"), connection(0));
    let guard = registry
        .begin_call("s1", &lease, "call-1")
        .expect("accepted");
    let token = guard.token();
    registry.close(&lease);
    assert!(token.is_cancelled(), "实例的取消令牌传给调用");
    drop(guard);
    assert!(
        registry.begin_call("s1", &lease, "call-2").is_err(),
        "凭证已经不在"
    );
}

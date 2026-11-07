//! `workspace/hooks/trustGrant`（旧入口 141 F5）：Settings 页在**没有会话**时预信任钩子声明。
//!
//! 断言两件事：
//! 1. wire 形状——Host 的 `zcodeWorkspaceHookTrustGrantResultSchema` 是 `.strict()`，
//!    只接受 `{accepted}` 与可选的 `reasonCode`，底层错误文本不能越界；
//! 2. 判定顺序与 Node `workspace-hook-trust.ts` 一致：信任库损坏 → 企业策略 → bundle 摘要 →
//!    声明在不在快照里 → 写入 → 回读确认。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::hook_review::{
    HookTrustError, HookTrustState, WorkspaceHookItem, WorkspaceHookReview,
};
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Kernel, KernelError};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options, Service};
use serde_json::{json, Value};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

const BUNDLE: &str = "b"; // 重复 64 次后作为摘要
const DECLARATION: &str = "a";

fn digest(seed: &str) -> String {
    seed.repeat(64)
}

fn item(id: &str, declaration: &str, state: HookTrustState) -> WorkspaceHookItem {
    WorkspaceHookItem {
        review_item_id: id.into(),
        event: "PreToolUse".into(),
        matcher: Some("Bash".into()),
        kind: "command".into(),
        display_name: "PreToolUse · Bash".into(),
        display_command: "guard.sh".into(),
        source_path: ".nibi/config.json".into(),
        resolved_timeout_ms: 30_000,
        resolved_max_output_bytes: 32_768,
        execution_mode: "foreground".into(),
        configured_enabled: true,
        editable: true,
        trust_state: state,
        declaration_digest: declaration.into(),
        source_discovery_order: 0,
        matcher_index: 0,
        hook_index: 0,
    }
}

fn review(reason_code: &str) -> WorkspaceHookReview {
    WorkspaceHookReview {
        identity: "/w/app".into(),
        bundle_digest: Some(digest(BUNDLE)),
        reason_code: reason_code.into(),
        sources: Vec::new(),
        items: vec![
            item(
                "workspace-hook-0-PreToolUse-0-0",
                &digest(DECLARATION),
                HookTrustState::PendingTrust,
            ),
            item(
                "workspace-hook-0-PreToolUse-0-1",
                &digest("c"),
                HookTrustState::TrustedPersistent,
            ),
        ],
    }
}

struct FixedClock;

impl nibi_kernel_api::clock::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        1_760_000_000_000
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

struct FakeKernel {
    review: Mutex<WorkspaceHookReview>,
    /// 每次授权收到的 review item id，供断言只有命中的那条被写。
    granted: Mutex<Vec<Vec<String>>>,
    grant_error: Option<KernelError>,
}

#[async_trait]
impl Kernel for FakeKernel {
    async fn create_session(
        &self,
        _request: nibi_kernel_api::session_api::CreateSession,
    ) -> Result<nibi_kernel_api::ids::SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "session creation".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &nibi_kernel_api::ids::SessionId,
    ) -> Result<Arc<dyn nibi_kernel_api::session_api::SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "session".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: nibi_kernel_api::store::SessionFilter,
    ) -> Result<Vec<nibi_kernel_api::store::SessionSummary>, KernelError> {
        Err(KernelError::Unsupported {
            what: "sessions".to_owned(),
        })
    }

    async fn workspace_hook_review(
        &self,
        _workspace: &WorkspaceRef,
    ) -> Result<WorkspaceHookReview, KernelError> {
        Ok(self
            .review
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }

    async fn grant_workspace_hooks(
        &self,
        _workspace: &WorkspaceRef,
        review_item_ids: &[String],
    ) -> Result<usize, KernelError> {
        self.granted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(review_item_ids.to_vec());
        if let Some(error) = &self.grant_error {
            return Err(error.clone());
        }
        let mut review = self
            .review
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for item in review.items.iter_mut() {
            if review_item_ids.iter().any(|id| id == &item.review_item_id) {
                item.trust_state = HookTrustState::TrustedPersistent;
            }
        }
        Ok(review_item_ids.len())
    }
}

fn server_for(
    review: WorkspaceHookReview,
    grant_error: Option<KernelError>,
) -> (Arc<Server>, Arc<FakeKernel>) {
    let scope = TaskScope::root("hook-trust-grant-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> = Arc::new(FixedClock);
    let kernel = Arc::new(FakeKernel {
        review: Mutex::new(review),
        granted: Mutex::new(Vec::new()),
        grant_error,
    });
    let server = Arc::new(Server::new(
        Arc::new(Context::new(peer, clock)),
        kernel.clone(),
        scope.spawner(),
        Defaults {
            selection: nibi_kernel_api::model::ModelSelection {
                provider: "p".into(),
                model: "m".into(),
                reasoning: None,
                connection: None,
            },
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));
    (server, kernel)
}

fn params(bundle: &str, declaration: &str) -> Value {
    json!({
        "workspace": {"workspacePath": "/w/app", "workspaceKey": "/w/app"},
        "bundleDigest": bundle,
        "hookDeclarationDigest": declaration,
    })
}

async fn grant(
    server: &Arc<Server>,
    params: Value,
) -> Result<Value, nibi_kernel_protocol_core::rpc::RpcError> {
    Handler(server.clone())
        .request("workspace/hooks/trustGrant", params)
        .await
        .map(|reply| reply.result)
}

#[tokio::test]
async fn grants_the_declaration_in_the_snapshot_and_confirms_by_reading_back() {
    let (server, kernel) = server_for(review("pending_trust"), None);
    let result = grant(&server, params(&digest(BUNDLE), &digest(DECLARATION)))
        .await
        .unwrap();
    assert_eq!(result, json!({"accepted": true}));
    assert_eq!(
        kernel
            .granted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_slice(),
        [vec!["workspace-hook-0-PreToolUse-0-0".to_owned()]]
    );
}

#[tokio::test]
async fn a_changed_bundle_is_refused_before_writing() {
    let (server, kernel) = server_for(review("pending_trust"), None);
    let result = grant(&server, params(&digest("d"), &digest(DECLARATION)))
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"accepted": false, "reasonCode": "workspace_hooks_bundle_changed"})
    );
    assert!(kernel
        .granted
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_empty());
}

#[tokio::test]
async fn an_unknown_declaration_is_a_snapshot_mismatch() {
    let (server, kernel) = server_for(review("pending_trust"), None);
    let result = grant(&server, params(&digest(BUNDLE), &digest("e")))
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"accepted": false, "reasonCode": "workspace_hooks_snapshot_mismatch"})
    );
    assert!(kernel
        .granted
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_empty());
}

#[tokio::test]
async fn a_corrupt_trust_store_wins_over_everything_else() {
    let (server, kernel) = server_for(review("trust_store_corrupt"), None);
    let result = grant(&server, params(&digest("d"), &digest("e")))
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"accepted": false, "reasonCode": "workspace_hooks_trust_store_corrupt"})
    );
    assert!(kernel
        .granted
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_empty());
}

#[tokio::test]
async fn policy_block_is_reported_without_writing() {
    let (server, kernel) = server_for(review("blocked_policy"), None);
    let result = grant(&server, params(&digest(BUNDLE), &digest(DECLARATION)))
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"accepted": false, "reasonCode": "workspace_hooks_blocked_by_policy"})
    );
    assert!(kernel
        .granted
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_empty());
}

#[tokio::test]
async fn a_corrupt_store_that_fails_the_write_maps_to_the_public_code() {
    let (server, _kernel) = server_for(
        review("pending_trust"),
        Some(KernelError::Failed {
            message: HookTrustError::Corrupt.to_string(),
        }),
    );
    let result = grant(&server, params(&digest(BUNDLE), &digest(DECLARATION)))
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"accepted": false, "reasonCode": "workspace_hooks_trust_store_corrupt"})
    );
}

#[tokio::test]
async fn a_malformed_digest_is_invalid_params_and_never_leaks_the_value() {
    let (server, _kernel) = server_for(review("pending_trust"), None);
    let error = grant(&server, params(&"A".repeat(64), &digest(DECLARATION)))
        .await
        .unwrap_err();
    assert_eq!(error.code, -32602);
    assert!(error.message.contains("bundleDigest"));
    assert!(!error.message.contains(&"A".repeat(64)));
}

/// 预信任之后，同工作区**已经打开**的会话要立刻换掉提示条（Node 的
/// `notifyWorkspaceHookTrustGrantSessions`）；其他工作区的会话不动。
#[tokio::test]
async fn a_grant_refreshes_the_banner_of_the_other_open_sessions_in_the_workspace() {
    use futures_util::StreamExt;
    use nibi_kernel_api::env::EnvPath;
    use nibi_kernel_api::ids::{SessionId, TraceId};
    use nibi_kernel_api::session_api::{
        Ack, CommandEnvelope, SequencedEvent, SessionHandle, SessionView,
    };
    use nibi_kernel_api::store::{SessionKind, SessionMeta};

    fn view(workspace: &str) -> SessionView {
        SessionView {
            meta: SessionMeta {
                id: SessionId::new("unset"),
                kind: SessionKind::Interactive,
                parent: None,
                workspace: WorkspaceRef {
                    environment: EnvironmentId::new("local"),
                    root: EnvPath::new(workspace),
                },
                title: "t".to_owned(),
                trace: TraceId::new("trace"),
                created_at_ms: 1_000,
            },
            messages: Vec::new(),
            selection: nibi_kernel_api::model::ModelSelection {
                provider: "p".to_owned(),
                model: "m".to_owned(),
                reasoning: None,
                connection: None,
            },
            mode: PermissionMode::Default,
            plan: false,
            pending: Vec::new(),
            queue: Vec::new(),
            last_seq: 0,
            revision: 0,
            running: false,
            background: Vec::new(),
            peer_held: Vec::new(),
            context_usage: None,
            context_notice: Default::default(),
            output_speed: None,
            launches: Vec::new(),
            model_turns: Vec::new(),
            input_intents: Vec::new(),
        }
    }

    struct FakeHandle(SessionView);

    #[async_trait]
    impl SessionHandle for FakeHandle {
        fn id(&self) -> &SessionId {
            &self.0.meta.id
        }

        async fn send(&self, _command: CommandEnvelope) -> Ack {
            Ack::Accepted {
                result: Value::Null,
            }
        }

        fn subscribe(
            &self,
            _after: Option<u64>,
        ) -> futures_util::stream::BoxStream<'static, SequencedEvent> {
            futures_util::stream::pending().boxed()
        }

        async fn view(&self) -> Result<SessionView, KernelError> {
            Ok(self.0.clone())
        }
    }

    struct LiveKernel {
        review: Mutex<WorkspaceHookReview>,
        view: SessionView,
    }

    #[async_trait]
    impl Kernel for LiveKernel {
        async fn create_session(
            &self,
            _request: nibi_kernel_api::session_api::CreateSession,
        ) -> Result<SessionId, KernelError> {
            Err(KernelError::Unsupported {
                what: "session creation".to_owned(),
            })
        }

        async fn list_sessions(
            &self,
            _filter: nibi_kernel_api::store::SessionFilter,
        ) -> Result<Vec<nibi_kernel_api::store::SessionSummary>, KernelError> {
            Err(KernelError::Unsupported {
                what: "sessions".to_owned(),
            })
        }

        async fn open_session(
            &self,
            session: &SessionId,
        ) -> Result<Arc<dyn SessionHandle>, KernelError> {
            let mut view = self.view.clone();
            view.meta.id = session.clone();
            // 一个别的工作区的会话：广播必须按 workspaceKey 过滤（Node 的同一判据）。
            if session.as_str() == "sess_other" {
                view.meta.workspace.root = EnvPath::new("/w/other");
            }
            Ok(Arc::new(FakeHandle(view)))
        }

        async fn workspace_hook_review(
            &self,
            _workspace: &WorkspaceRef,
        ) -> Result<WorkspaceHookReview, KernelError> {
            Ok(self
                .review
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone())
        }

        async fn grant_workspace_hooks(
            &self,
            _workspace: &WorkspaceRef,
            review_item_ids: &[String],
        ) -> Result<usize, KernelError> {
            let mut review = self
                .review
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for item in review.items.iter_mut() {
                if review_item_ids.iter().any(|id| id == &item.review_item_id) {
                    item.trust_state = HookTrustState::TrustedPersistent;
                }
            }
            Ok(review_item_ids.len())
        }
    }

    let scope = TaskScope::root("hook-trust-broadcast-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> = Arc::new(FixedClock);
    let kernel = Arc::new(LiveKernel {
        review: Mutex::new(review("pending_trust")),
        view: view("/w/app"),
    });
    let server = Arc::new(Server::new(
        Arc::new(Context::new(peer, clock)),
        kernel,
        scope.spawner(),
        Defaults {
            selection: nibi_kernel_api::model::ModelSelection {
                provider: "p".into(),
                model: "m".into(),
                reasoning: None,
                connection: None,
            },
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ));

    let first = server
        .live(&SessionId::new("sess_a"))
        .await
        .expect("first session opens");
    let second = server
        .live(&SessionId::new("sess_b"))
        .await
        .expect("second session opens");
    let other = server
        .live(&SessionId::new("sess_other"))
        .await
        .expect("other session opens");
    // 冷打开的提示条：两条同工作区、一条别的工作区，都是待审 1 条。
    assert_eq!(first.sink.admission_for_test()["pendingCount"], 1);
    assert_eq!(second.sink.admission_for_test()["pendingCount"], 1);
    assert_eq!(other.sink.admission_for_test()["pendingCount"], 1);

    let result = grant(&server, params(&digest(BUNDLE), &digest(DECLARATION)))
        .await
        .unwrap();
    assert_eq!(result, json!({"accepted": true}));

    // 广播在会话泵里异步执行：等它跑完。
    for _ in 0..200 {
        if first.sink.admission_for_test().is_null() && second.sink.admission_for_test().is_null()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(first.sink.admission_for_test().is_null());
    assert!(second.sink.admission_for_test().is_null());
    // 其他工作区的会话不受影响（Node 按 workspaceKey 过滤）。
    assert_eq!(other.sink.admission_for_test()["pendingCount"], 1);
}

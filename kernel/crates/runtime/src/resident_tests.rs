//! 常驻池（`resident.rs` / `residency.rs`）的集成测试：高水位 LRU、空闲 TTL、阻止项、租约收敛与采样兜底。
//!
//! 会话是真的 `LocalKernel` + `MemoryStore`；时间走注入的 [`TestClock`]，模型用可停住的 [`HeldModel`]，
//! 竞态与 TTL 因此是确定的（不靠真实睡眠）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use nibi_kernel_api::clock::Clock;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{CommandId, EnvironmentId, SessionId, ToolUseId};
use nibi_kernel_api::model::{ModelEvent, ModelPort, ModelRequest};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::residency::{SessionLifecycleState, SessionResidencyWatch};
use nibi_kernel_api::session_api::{
    Command, CommandEnvelope, CreateSession, Delivery, Kernel, KernelError, SessionHandle,
};
use nibi_kernel_api::orchestration::InteractionRequest;
use nibi_kernel_api::testing::{
    ClosingEnvironment, MemoryStore, ScriptedModel, SequentialIds, environments, selection,
    text_response,
};
use tokio_util::sync::CancellationToken;

use super::table::Slot;
use super::{Defaults, LocalKernel, Ports, ResidentPoolConfig};

/// 可推进的测试时钟（池的空闲 TTL 与 LRU 都读它）。
struct TestClock(AtomicU64);

impl TestClock {
    fn new(now: u64) -> Self {
        Self(AtomicU64::new(now))
    }

    fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

/// 每次 `stream` 取一个通行证后才回一段文本：测试可以停住回合。
struct HeldModel {
    permits: Arc<tokio::sync::Semaphore>,
}

impl HeldModel {
    fn new() -> (Arc<Self>, Arc<tokio::sync::Semaphore>) {
        let permits = Arc::new(tokio::sync::Semaphore::new(0));
        (
            Arc::new(Self {
                permits: permits.clone(),
            }),
            permits,
        )
    }
}

impl ModelPort for HeldModel {
    fn stream(
        &self,
        _request: ModelRequest,
        _cancel: CancellationToken,
    ) -> futures_util::stream::BoxStream<'static, Result<ModelEvent, nibi_kernel_api::model::ModelError>>
    {
        let permits = self.permits.clone();
        futures_util::stream::once(async move {
            let _ = permits.acquire().await;
        })
        .flat_map(|()| futures_util::stream::iter(text_response(&["ok"])))
        .boxed()
    }
}

/// 只拦住指定会话的协议侧事实（模拟 Live 订阅）。
struct BlockWatch(SessionId);

impl SessionResidencyWatch for BlockWatch {
    fn has_protocol_blockers(&self, session: &SessionId) -> bool {
        session == &self.0
    }
}

struct Setup {
    kernel: Arc<LocalKernel>,
}

fn kernel(
    clock: Arc<TestClock>,
    model: Arc<dyn ModelPort>,
    config: ResidentPoolConfig,
) -> Setup {
    // 池回收要真的关掉执行环境里的会话：放行 `close_session`（这些测试不测关闭时序）。
    let environment = Arc::new(ClosingEnvironment::held());
    environment.release();
    let kernel = LocalKernel::new(
        Ports {
            model,
            environments: environments(environment),
            store: Arc::new(MemoryStore::default()),
            artifacts: Arc::new(MemoryStore::default()),
            clock,
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    )
    .with_resident_pool_config(config);
    Setup {
        kernel: Arc::new(kernel),
    }
}

fn request() -> CreateSession {
    CreateSession {
        id: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/work"),
        },
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
    }
}

async fn create(setup: &Setup) -> SessionId {
    setup.kernel.create_session(request()).await.unwrap()
}

async fn facts(setup: &Setup, session: &SessionId) -> Option<nibi_kernel_api::residency::SessionResidencyFacts> {
    let open = {
        let sessions = setup.kernel.sessions();
        sessions.get(session).and_then(Slot::open).cloned()
    }?;
    open.residency_facts().await.ok()
}

/// 等到 actor 的回合级后台工作（SessionStart）收口。
async fn wait_idle(setup: &Setup, session: &SessionId) {
    for _ in 0..1_000 {
        if facts(setup, session)
            .await
            .is_some_and(|facts| !facts.running)
        {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the session did not become idle");
}

fn resident(setup: &Setup, session: &SessionId) -> bool {
    setup
        .kernel
        .sessions()
        .get(session)
        .is_some_and(|slot| matches!(slot, Slot::Open(_)))
}

fn config(target: usize, high_water: usize, idle: u64) -> ResidentPoolConfig {
    ResidentPoolConfig {
        target_count: target,
        high_water_count: high_water,
        idle_timeout_ms: idle,
        sampler_interval: Duration::from_secs(3_600),
    }
}

/// 高水位：超过 3 个时按 LRU 回收到 2 个（最久没用的两个）。
#[tokio::test]
async fn high_water_evicts_the_least_recently_used_to_target() {
    let clock = Arc::new(TestClock::new(1_000));
    let setup = kernel(
        clock.clone(),
        Arc::new(ScriptedModel::new(Vec::new())),
        config(2, 3, 60 * 60 * 1_000),
    );
    let mut sessions = Vec::new();
    for _ in 0..4 {
        clock.advance(10);
        sessions.push(create(&setup).await);
        wait_idle(&setup, sessions.last().unwrap()).await;
    }
    setup.kernel.rebalance_resident_sessions().await;

    assert!(!resident(&setup, &sessions[0]), "the oldest is evicted");
    assert!(!resident(&setup, &sessions[1]));
    assert!(resident(&setup, &sessions[2]));
    assert!(resident(&setup, &sessions[3]));
    let snapshot = setup
        .kernel
        .session_lifecycle_state(&sessions[0])
        .await
        .unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Unloaded);
    // 持久事实还在：可以冷恢复。
    setup.kernel.ensure_session_ready(&sessions[0], None).await.unwrap();
    assert!(resident(&setup, &sessions[0]));
}

/// 空闲 TTL：第一次观察到可回收开始计时；到期后即使低于 target 也回收。
#[tokio::test]
async fn idle_timeout_evicts_after_the_ttl() {
    let clock = Arc::new(TestClock::new(0));
    let setup = kernel(
        clock.clone(),
        Arc::new(ScriptedModel::new(Vec::new())),
        config(8, 16, 1_000),
    );
    let session = create(&setup).await;
    wait_idle(&setup, &session).await;

    setup.kernel.rebalance_resident_sessions().await;
    clock.advance(999);
    setup.kernel.rebalance_resident_sessions().await;
    assert!(resident(&setup, &session), "the TTL is not over yet");

    clock.advance(1);
    setup.kernel.rebalance_resident_sessions().await;
    assert!(!resident(&setup, &session));
    // 回收不发 `session.removed`、不删存储：仍是可恢复的会话。
    assert!(
        setup
            .kernel
            .session_lifecycle_state(&session)
            .await
            .is_ok()
    );
}

/// 协议请求（租约）重新使用会话后 TTL 重新计时。
#[tokio::test]
async fn a_lease_touch_resets_the_idle_ttl() {
    let clock = Arc::new(TestClock::new(0));
    let setup = kernel(
        clock.clone(),
        Arc::new(ScriptedModel::new(Vec::new())),
        config(8, 16, 1_000),
    );
    let session = create(&setup).await;
    wait_idle(&setup, &session).await;

    setup.kernel.rebalance_resident_sessions().await;
    clock.advance(900);
    let lease = setup
        .kernel
        .acquire_residency_lease(std::slice::from_ref(&session))
        .await
        .expect("the local kernel has a resident pool");
    drop(lease);
    clock.advance(99);
    setup.kernel.rebalance_resident_sessions().await;
    assert!(resident(&setup, &session), "touched at 900: TTL restarted");

    clock.advance(1_000);
    setup.kernel.rebalance_resident_sessions().await;
    assert!(!resident(&setup, &session));
}

/// 有订阅者时不回收；订阅解除后同一轮收敛可以回收。
#[tokio::test]
async fn a_protocol_subscriber_blocks_eviction() {
    let clock = Arc::new(TestClock::new(0));
    let setup = kernel(
        clock.clone(),
        Arc::new(ScriptedModel::new(Vec::new())),
        config(0, 0, 0),
    );
    let session = create(&setup).await;
    wait_idle(&setup, &session).await;
    setup
        .kernel
        .set_session_residency_watch(Arc::new(BlockWatch(session.clone())));

    setup.kernel.rebalance_resident_sessions().await;
    setup.kernel.rebalance_resident_sessions().await;
    assert!(resident(&setup, &session), "a subscriber keeps it resident");

    // 解除订阅：TTL 从新的 eligible 时刻重新开始（两轮收敛）。
    setup
        .kernel
        .set_session_residency_watch(Arc::new(nibi_kernel_api::residency::NoResidencyBlockers));
    setup.kernel.rebalance_resident_sessions().await;
    setup.kernel.rebalance_resident_sessions().await;
    assert!(!resident(&setup, &session));
}

/// 有排队输入（回合在跑）时不回收；回合结束后可以回收。
#[tokio::test]
async fn a_queued_input_blocks_eviction() {
    let clock = Arc::new(TestClock::new(0));
    let (model, permits) = HeldModel::new();
    let setup = kernel(clock.clone(), model, config(0, 0, 0));
    let session = create(&setup).await;
    wait_idle(&setup, &session).await;
    let handle = setup.kernel.open_session(&session).await.unwrap();
    handle
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::Submit {
                text: "first".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    for _ in 0..1_000 {
        if facts(&setup, &session).await.is_some_and(|facts| facts.running) {
            break;
        }
        tokio::task::yield_now().await;
    }
    handle
        .send(CommandEnvelope {
            id: CommandId::new("c2"),
            command: Command::Submit {
                text: "second".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    for _ in 0..1_000 {
        if facts(&setup, &session)
            .await
            .is_some_and(|facts| facts.queued_commands > 0)
        {
            break;
        }
        tokio::task::yield_now().await;
    }

    setup.kernel.rebalance_resident_sessions().await;
    setup.kernel.rebalance_resident_sessions().await;
    assert!(resident(&setup, &session), "queued input keeps it resident");

    // 收尾：放行模型并关掉会话（测试不关心后续回合）。
    permits.add_permits(8);
    let _ = handle.close(nibi_kernel_api::session_api::EndReason::Other).await;
}

/// 有待回答交互（回合外会话级询问）时不回收。
#[tokio::test]
async fn a_pending_interaction_blocks_eviction() {
    let clock = Arc::new(TestClock::new(0));
    let setup = kernel(
        clock.clone(),
        Arc::new(ScriptedModel::new(Vec::new())),
        config(0, 0, 0),
    );
    let session = create(&setup).await;
    wait_idle(&setup, &session).await;
    let open = {
        let sessions = setup.kernel.sessions();
        sessions
            .get(&session)
            .and_then(Slot::open)
            .cloned()
            .expect("open")
    };
    let interactions = open.session_interactions();
    let asked = {
        let (session, interactions) = (session.clone(), interactions.clone());
        tokio::spawn(async move {
            interactions
                .ask(
                    &session,
                    InteractionRequest::Question {
                        tool_use: ToolUseId::new("toolu_ask"),
                        questions: serde_json::json!({"question": "which?"}),
                    },
                )
                .await
        })
    };
    for _ in 0..1_000 {
        if facts(&setup, &session)
            .await
            .is_some_and(|facts| facts.pending_interactions > 0)
        {
            break;
        }
        tokio::task::yield_now().await;
    }

    setup.kernel.rebalance_resident_sessions().await;
    setup.kernel.rebalance_resident_sessions().await;
    assert!(resident(&setup, &session), "a pending question keeps it resident");

    asked.abort();
    let _ = setup.kernel.stop_session_runtime(&session).await;
}

/// 操作租约（协议请求）持有期间不收敛；释放租约触发驱动器收敛。
#[tokio::test]
async fn a_lease_release_triggers_convergence() {
    let clock = Arc::new(TestClock::new(0));
    let setup = kernel(
        clock.clone(),
        Arc::new(ScriptedModel::new(Vec::new())),
        config(8, 16, 0),
    );
    let session = setup.kernel.create_session(request()).await.unwrap();
    wait_idle(&setup, &session).await;
    setup.kernel.start_resident_pool();

    let lease = setup
        .kernel
        .acquire_residency_lease(std::slice::from_ref(&session))
        .await
        .expect("the local kernel has a resident pool");
    setup.kernel.rebalance_resident_sessions().await;
    assert!(resident(&setup, &session), "an operation lease blocks eviction");

    drop(lease);
    tokio::time::timeout(Duration::from_secs(5), async {
        while resident(&setup, &session) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("releasing the lease must converge");
}

/// 60 s sampler 兜底：没有请求租约也会在采样时回收到期会话。
#[tokio::test(start_paused = true)]
async fn the_sampler_converges_expired_sessions() {
    let clock = Arc::new(TestClock::new(0));
    let mut pool_config = config(8, 16, 0);
    pool_config.sampler_interval = Duration::from_secs(60);
    let setup = kernel(
        clock.clone(),
        Arc::new(ScriptedModel::new(Vec::new())),
        pool_config,
    );
    let session = setup.kernel.create_session(request()).await.unwrap();
    wait_idle(&setup, &session).await;
    setup.kernel.start_resident_pool();
    // 先让驱动器轮询一次（把 60 s 的 timer 注册在 t=0），再推进时间。
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while resident(&setup, &session) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the sampler must converge");
}

/// `stop`/`ensureReady`/`restart` 的幂等与所有权：不删持久事实，restart 换新实例。
#[tokio::test]
async fn stop_and_restart_are_idempotent_at_the_kernel() {
    let clock = Arc::new(TestClock::new(0));
    let setup = kernel(
        clock.clone(),
        Arc::new(ScriptedModel::new(Vec::new())),
        config(8, 16, 60 * 60 * 1_000),
    );
    let session = create(&setup).await;
    wait_idle(&setup, &session).await;
    let first = {
        let sessions = setup.kernel.sessions();
        sessions
            .get(&session)
            .and_then(Slot::open)
            .cloned()
            .expect("open")
    };

    setup.kernel.stop_session_runtime(&session).await.unwrap();
    setup.kernel.stop_session_runtime(&session).await.unwrap();
    assert!(!resident(&setup, &session));
    let snapshot = setup
        .kernel
        .session_lifecycle_state(&session)
        .await
        .unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Unloaded);

    setup.kernel.ensure_session_ready(&session, None).await.unwrap();
    setup.kernel.ensure_session_ready(&session, None).await.unwrap();
    let second = {
        let sessions = setup.kernel.sessions();
        sessions
            .get(&session)
            .and_then(Slot::open)
            .cloned()
            .expect("open")
    };
    assert!(!Arc::ptr_eq(&first, &second), "ensureReady cold-loads a new actor");

    setup
        .kernel
        .restart_session_runtime(&session, None)
        .await
        .unwrap();
    setup
        .kernel
        .restart_session_runtime(&session, None)
        .await
        .unwrap();
    let third = {
        let sessions = setup.kernel.sessions();
        sessions
            .get(&session)
            .and_then(Slot::open)
            .cloned()
            .expect("open")
    };
    assert!(!Arc::ptr_eq(&second, &third));
    let snapshot = setup
        .kernel
        .session_lifecycle_state(&session)
        .await
        .unwrap();
    assert_eq!(snapshot.state, SessionLifecycleState::Ready);
    assert!(snapshot.generation >= 3, "{snapshot:?}");
}

/// `getState` 对不存在的会话报错（不隐式启动）。
#[tokio::test]
async fn get_state_rejects_a_missing_session() {
    let clock = Arc::new(TestClock::new(0));
    let setup = kernel(
        clock,
        Arc::new(ScriptedModel::new(Vec::new())),
        config(8, 16, 1_000),
    );
    let missing = SessionId::new("sess_missing");
    let result = setup.kernel.session_lifecycle_state(&missing).await;
    assert!(matches!(result, Err(KernelError::Failed { .. })));
}

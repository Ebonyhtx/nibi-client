//! 连接上的共用部分：往 Host 写帧（wire v3、每个订阅自己的逻辑帧序号）、时间与随机标识。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use nibi_kernel_api::clock::Clock;
use nibi_kernel_protocol_core::connection::Peer;
use serde_json::{Value, json};

use crate::wire::{self, Envelope, Purpose};

/// 帧的通知名。
pub const FRAME: &str = "v4/conversation/frame";

/// 写帧的一方与时间。会话投影、会话列表与工作区配置的发布者共用。
pub struct Context {
    pub peer: Peer,
    pub clock: Arc<dyn Clock>,
    ordinals: Mutex<HashMap<String, u64>>,
    counter: Mutex<u64>,
    /// 打开着的会话 → 所在的工作区（取账号凭据的反向请求要带工作区）。
    sessions: Mutex<HashMap<String, String>>,
    /// 打开着的会话 → 工作区身份（远程 workspace 的 `workspace_id`；本机是 `local`）。
    /// 浏览器的反向请求带它；本机不值当发（Host 按会话解析）。
    identities: Mutex<HashMap<String, String>>,
    /// 浏览器 broker（Host 声明提供 browser-use 执行面时由入口装上）。
    browser_broker: std::sync::OnceLock<Arc<crate::browser::BrowserBroker>>,
    /// `v4/connection/flow` 的 `saturated` 连接：投递暂停、订阅与位置都保留。
    paused: Mutex<HashSet<String>>,
    /// 本进程的随机前缀（代际标识与订阅 ID 用）。
    prefix: String,
}

impl Context {
    pub fn new(peer: Peer, clock: Arc<dyn Clock>) -> Self {
        let prefix = format!(
            "{:x}-{:x}",
            clock.now_ms(),
            nibi_kernel_base::random::u64() & 0xffff_ffff
        );
        Self {
            peer,
            clock,
            ordinals: Mutex::new(HashMap::new()),
            counter: Mutex::new(0),
            sessions: Mutex::new(HashMap::new()),
            identities: Mutex::new(HashMap::new()),
            browser_broker: std::sync::OnceLock::new(),
            paused: Mutex::new(HashSet::new()),
            prefix,
        }
    }

    /// 下游背压（Node `setConnectionFlowState`）：`saturated` 暂停这条连接的投递，
    /// `drained` 恢复。返回状态是否真的变了（给调用方决定要不要补一次 flush）。
    pub fn set_connection_paused(&self, connection: &str, paused: bool) -> bool {
        let mut set = self.paused.lock().unwrap_or_else(PoisonError::into_inner);
        if paused {
            set.insert(connection.to_owned())
        } else {
            set.remove(connection)
        }
    }

    pub fn connection_paused(&self, connection: &str) -> bool {
        self.paused
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(connection)
    }

    /// 当前暂停的连接（`flush` 时跳过它们）。
    pub fn paused_connections(&self) -> HashSet<String> {
        self.paused
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 装上入口启动的浏览器 broker（只装一次；重复装保留第一个）。
    pub fn set_browser_broker(&self, broker: Arc<crate::browser::BrowserBroker>) {
        let _ = self.browser_broker.set(broker);
    }

    pub(crate) fn browser_broker(&self) -> Option<&Arc<crate::browser::BrowserBroker>> {
        self.browser_broker.get()
    }

    /// 记下一个打开着的会话所在的工作区。
    pub fn register(&self, session: &str, workspace: &str) {
        self.register_with_identity(session, workspace, None);
    }

    /// 同 [`Self::register`]，另记工作区身份（`SessionMeta.workspace.environment`：远程 workspace
    /// 的 identity，本机是 `local`）。
    pub fn register_with_identity(&self, session: &str, workspace: &str, identity: Option<&str>) {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.to_owned(), workspace.to_owned());
        if let Some(identity) = identity.filter(|identity| *identity != "local") {
            self.identities
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(session.to_owned(), identity.to_owned());
        }
    }

    /// 远程工作区的身份；本机或不知道时为 None。
    pub fn identity_of(&self, session: &str) -> Option<String> {
        self.identities
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .cloned()
    }

    pub fn workspace_of(&self, session: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .cloned()
    }

    pub fn now(&self) -> u64 {
        self.clock.now_ms()
    }

    /// 本进程里唯一的标识：`<kind>-<进程前缀>-<n>`（代际标识、订阅 ID）。
    pub fn fresh(&self, kind: &str) -> String {
        let mut counter = self.counter.lock().unwrap_or_else(PoisonError::into_inner);
        *counter += 1;
        format!("{kind}-{}-{}", self.prefix, *counter)
    }

    fn ordinal(&self, subscription: &str) -> u64 {
        let mut ordinals = self.ordinals.lock().unwrap_or_else(PoisonError::into_inner);
        let ordinal = ordinals.entry(subscription.to_owned()).or_default();
        *ordinal += 1;
        *ordinal
    }

    /// 订阅结束：逻辑帧序号不再需要。
    pub fn forget(&self, subscription: &str) {
        self.ordinals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(subscription);
    }

    /// 一条全局通知（不属于任何主题的事实流，如 `v4/telemetry/event`）。
    pub async fn notify(&self, method: &str, params: &Value) -> bool {
        self.peer.notify(method, params).await
    }

    /// 写一个逻辑帧（`topicFrame`）：快照或一段增量。
    pub async fn frame(
        &self,
        topic: &str,
        subscription: &str,
        (from, to): (u64, u64),
        payload: Value,
        purpose: Purpose,
    ) {
        let frame = json!({
            "topic": topic,
            "subscriptionId": subscription,
            "fromSeq": from,
            "toSeq": to,
            "sentAt": self.now(),
            "payload": payload,
        });
        let envelope = Envelope {
            topic,
            subscription,
            ordinal: self.ordinal(subscription),
            purpose,
        };
        let Some(physical) = wire::encode(&frame, &envelope) else {
            tracing::warn!(
                event = "protocol.frame.too_large",
                topic,
                "a logical frame exceeded the assembly limit and was dropped"
            );
            return;
        };
        for wire in physical {
            self.peer.notify(FRAME, &wire).await;
        }
    }
}

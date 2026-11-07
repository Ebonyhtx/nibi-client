//! 话题工具的读面：`SessionReads` 的存储实现（冷读，不启动会话 actor）。
//!
//! `ReadSessionContext` 与 `ReplyToChannel` 都要看「持久化消息 + 每条输入的规范意图」。工具拿不到
//! 会话 actor，走这里直接从会话存储读同一份事实（Node 的 `sessionStore.messages` 同一姿态）。

use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::store::SessionStore;
use nibi_kernel_api::topic::{SessionReads, SessionSnapshot};

pub struct StoreReads {
    store: Arc<dyn SessionStore>,
}

impl StoreReads {
    pub fn new(store: Arc<dyn SessionStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl SessionReads for StoreReads {
    async fn snapshot(&self, session: &SessionId) -> Result<SessionSnapshot, String> {
        let loaded = self
            .store
            .load(session)
            .await
            .map_err(|error| error.to_string())?;
        Ok(SessionSnapshot {
            messages: loaded.messages,
            intents: loaded.input_intents,
        })
    }
}

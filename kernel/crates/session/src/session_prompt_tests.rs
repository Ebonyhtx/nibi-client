//! 会话钉住的模型可见输入（R09）：冷打开的 actor 读回库里的 system 输入，主循环的每一步把它交给 context。
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::message::Message;
use nibi_kernel_api::model::SystemBlock;
use nibi_kernel_api::orchestration::{
    BuiltContext, ContextBuilder, ContextRequest, OrchestrationError,
};
use nibi_kernel_api::session_api::{Command, Delivery, SessionHandle, StartSource};
use nibi_kernel_api::session_prompt::SystemPin;
use nibi_kernel_api::store::{FactBatch, SessionStore};
use nibi_kernel_api::testing::{MemoryStore, ScriptedModel, text_response};

use crate::test_support::{Setup, envelope, meta};
use crate::{Opened, tests::until_finished};

/// 记下每一步的上下文请求；system 由测试自己给。
#[derive(Default)]
struct Recording {
    seen: Mutex<Vec<ContextRequest>>,
}

impl Recording {
    fn requests(&self) -> Vec<ContextRequest> {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

#[async_trait]
impl ContextBuilder for Recording {
    async fn build(
        &self,
        request: ContextRequest,
        _history: &[Message],
    ) -> Result<BuiltContext, OrchestrationError> {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(request);
        Ok(BuiltContext {
            system: vec![SystemBlock {
                text: "system".to_owned(),
                cache_control: None,
            }],
            user_context: Vec::new(),
            attachments: Vec::new(),
        })
    }
}

/// 冷打开：库里记下的 system 输入盖过内核现在的（模板没有 custom）；主循环每一步在 ContextRequest 里带上它。
#[tokio::test]
async fn a_cold_open_hands_the_recorded_pin_to_the_context_builder() {
    let store = Arc::new(MemoryStore::default());
    let session = meta().id;
    store.create(meta()).await.unwrap();
    let pin = SystemPin {
        custom: Some("Pinned system.".to_owned()),
        append: Some("Pinned append.".to_owned()),
        shell_escape: true,
    };
    store
        .commit(
            &session,
            FactBatch {
                owner_epoch: nibi_kernel_api::ids::OwnerEpoch::LOCAL,
                command: None,
                facts: vec![pin.fact()],
                turn: None,
            },
        )
        .await
        .unwrap();

    let context = Arc::new(Recording::default());
    let mut setup = Setup::new(Arc::new(ScriptedModel::new(vec![text_response(&["ok"])])));
    setup.store = Some(store);
    setup.opened = Opened::Loaded;
    setup.start = StartSource::Resume;
    setup.context = Some(context.clone());
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built
        .session
        .send(envelope(
            "c1",
            Command::Submit {
                text: "hello".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        ))
        .await;
    until_finished(&mut events, 1).await;

    let requests = context.requests();
    let first = requests.first().expect("the main loop built a context");
    let prompt = first.prompt.as_ref().expect("the pin reached the request");
    assert_eq!(prompt.system, pin);
}

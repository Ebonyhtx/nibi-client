//! 压缩里的 hooks 顺序与 SessionStart（`compact`）的消息（compact.md §7）。

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use nibi_kernel_api::ids::{AgentId, MessageId};
use nibi_kernel_api::message::{AttachmentMessage, CompactTrigger, Message};
use nibi_kernel_api::orchestration::{HookEvent, HookEventName, HookOutcome, HookRunner};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::engine::{Engine, Failure};
use crate::test_support::{Reply, ScriptedRunner, human, no_tools, ports, reply, request};

/// 所有 PreCompact hook 的合并结果；用于验证 block 策略。
struct BlockingPreCompact(HookOutcome);

#[async_trait]
impl HookRunner for BlockingPreCompact {
    async fn run(&self, event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        assert_eq!(event.name, HookEventName::PreCompact);
        self.0.clone()
    }
}

#[tokio::test]
async fn manual_pre_compact_block_aborts_compaction() {
    let hooks = BlockingPreCompact(HookOutcome {
        blocking_error: Some("no secrets".to_owned()),
        custom_instructions: Some("hook".to_owned()),
        ..HookOutcome::default()
    });
    let request = request(vec![human("u1", "hi")], CompactTrigger::Manual);
    let error = super::pre_compact(&hooks, &request, &CancellationToken::new())
        .await
        .expect_err("manual compaction must honor a blocking PreCompact hook");
    assert_eq!(error, Failure::Blocked("no secrets".to_owned()));
}

#[tokio::test]
async fn auto_and_reactive_ignore_pre_compact_block_and_keep_successful_instructions() {
    for trigger in [CompactTrigger::Auto, CompactTrigger::Reactive] {
        let hooks = BlockingPreCompact(HookOutcome {
            blocking_error: Some("no secrets".to_owned()),
            // 一个 hook 拦截、另一个成功 hook 给出的指令仍要采用。
            custom_instructions: Some("hook".to_owned()),
            ..HookOutcome::default()
        });
        let request = request(vec![human("u1", "hi")], trigger);
        let instructions = super::pre_compact(&hooks, &request, &CancellationToken::new())
            .await
            .expect("automatic compaction must continue past a blocking PreCompact hook");
        assert_eq!(instructions.as_deref(), Some("hook"));
    }
}

#[tokio::test]
async fn auto_pre_compact_block_is_ignored_when_user_instructions_exist() {
    let hooks = BlockingPreCompact(HookOutcome {
        blocking_error: Some("no secrets".to_owned()),
        ..HookOutcome::default()
    });
    let mut request = request(vec![human("u1", "hi")], CompactTrigger::Auto);
    request.instructions = Some("keep decisions".to_owned());
    let instructions = super::pre_compact(&hooks, &request, &CancellationToken::new())
        .await
        .expect("automatic compaction must continue past a blocking PreCompact hook");
    assert_eq!(instructions.as_deref(), Some("keep decisions"));
}

#[derive(Default)]
struct Recorded(Mutex<Vec<HookEvent>>);

#[async_trait]
impl HookRunner for Recorded {
    async fn run(&self, event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        let name = event.name;
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(event);
        if name != HookEventName::SessionStart {
            return HookOutcome::default();
        }
        HookOutcome {
            messages: vec![Message::Attachment(AttachmentMessage {
                id: MessageId::new("hook_ctx"),
                source: "hook_additional_context".to_owned(),
                text: "<system-reminder>\nSessionStart hook additional context: again\n</system-reminder>".to_owned(),
                data: Value::Null,
            })],
            ..HookOutcome::default()
        }
    }
}

#[tokio::test]
async fn session_start_runs_inside_every_compaction_before_post_compact() {
    for trigger in [
        CompactTrigger::Manual,
        CompactTrigger::Auto,
        CompactTrigger::Reactive,
    ] {
        let hooks = Arc::new(Recorded::default());
        let runner = ScriptedRunner::new(vec![Reply::Text("<summary>S</summary>".to_owned())]);
        let mut ports = ports(runner, no_tools());
        ports.hooks = hooks.clone();
        let mut request = request(vec![human("u1", "hi"), reply("a1", "ok", None)], trigger);
        request.agent = Some(AgentId::new("agent_1"));
        let result = Engine { ports: &ports }
            .run(&request, true, &CancellationToken::new())
            .await
            .unwrap();
        let seen = hooks
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let names: Vec<HookEventName> = seen.iter().map(|event| event.name).collect();
        assert_eq!(
            names,
            [
                HookEventName::PreCompact,
                HookEventName::SessionStart,
                HookEventName::PostCompact
            ]
        );
        let start = &seen[1];
        // 对 compact 不传标题：只有 source 与 model；子代理里带 agent_id。
        assert_eq!(
            start.payload,
            json!({"source": "compact", "model": "claude-opus-5-5"})
        );
        assert_eq!(start.context.agent, Some(AgentId::new("agent_1")));
        // hook 消息排在附件之后，与边界、摘要一起交给调用方提交。
        assert_eq!(
            result.restored.last().map(|message| message.id().as_str()),
            Some("hook_ctx")
        );
    }
}

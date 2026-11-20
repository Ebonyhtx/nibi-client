//! 会话钉住的模型可见输入（R09）：默认字节不变、SystemPin 生效、LivePrompt 每回合更新、恢复后一致、旧数据兼容。
use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, MessageId, SessionId};
use nibi_kernel_api::listing::{ListingSource, Listings};
use nibi_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use nibi_kernel_api::model::{ModelSelection, QuerySource, SystemBlock};
use nibi_kernel_api::orchestration::{ContextBuilder, ContextRequest, OrchestrationError};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_prompt::{FrontendTraits, SessionPrompt, SystemPin};
use nibi_kernel_api::store::{SessionStore, entry_kinds};
use nibi_kernel_api::testing::{FixedClock, MemoryStore, SequentialIds, UnusedEnvironment};

use super::*;

/// 名字表：输入里出现的 `/greet`。
struct Skills;

#[async_trait]
impl ListingSource for Skills {
    async fn listings(&self, _request: &ContextRequest) -> Result<Listings, OrchestrationError> {
        Ok(Listings::default())
    }

    async fn skill_mentions(
        &self,
        _request: &ContextRequest,
        input: &str,
    ) -> Result<Vec<String>, OrchestrationError> {
        Ok(input
            .contains("/greet")
            .then(|| "greet".to_owned())
            .into_iter()
            .collect())
    }
}

fn request() -> ContextRequest {
    ContextRequest {
        default_machine: None,
        capabilities: None,
        session: SessionId::new("s"),
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        agent: None,
        source: QuerySource::MainThread,
        mode: PermissionMode::Default,
        tool_names: vec!["Skill".to_owned()],
        selection: ModelSelection {
            provider: "p".to_owned(),
            model: "claude-opus-5-5".to_owned(),
            reasoning: None,
            connection: None,
        },
        plan_flags: Default::default(),
        mcp: None,
        prompt: None,
    }
}

fn assembler(surface: Surface, listings: Arc<dyn ListingSource>) -> PromptAssembler {
    assembler_with(ContextConfig::new(surface), listings)
}

fn assembler_with(config: ContextConfig, listings: Arc<dyn ListingSource>) -> PromptAssembler {
    let env = Arc::new(UnusedEnvironment);
    PromptAssembler::new(
        ContextPorts {
            info: env.clone(),
            files: env.clone(),
            shell: env.clone(),
            git: env,
            clock: Arc::new(FixedClock(1_792_224_000_000)),
            ids: Arc::new(SequentialIds::default()),
            listings,
        },
        config,
    )
}

fn config(surface: Surface, custom: Option<&str>, append: Option<&str>) -> ContextConfig {
    let mut config = ContextConfig::new(surface);
    config.custom_system_prompt = custom.map(str::to_owned);
    config.append_system_prompt = append.map(str::to_owned);
    config
}

fn prompt(
    custom: Option<&str>,
    append: Option<&str>,
    traits: FrontendTraits,
) -> Arc<SessionPrompt> {
    Arc::new(SessionPrompt::new(
        custom.map(str::to_owned),
        append.map(str::to_owned),
        traits,
    ))
}

fn typed(text: &str) -> Vec<Message> {
    vec![Message::User(UserMessage {
        id: MessageId::new("u"),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin: UserOrigin::Human,
    })]
}

/// 默认：请求不带钉住的那一份时与带一份“与进程配置相同”的钉住时，system 逐字节相同（含 custom/append 与 `!` 提示）。
#[tokio::test]
async fn the_default_path_and_the_default_pin_render_the_same_bytes() {
    for surface in [Surface::Print, Surface::Interactive] {
        for (custom, append) in [
            (None, None),
            (Some("Custom."), None),
            (None, Some("Append.")),
        ] {
            let traits = FrontendTraits {
                shell_escape: surface == Surface::Interactive,
                typed_mentions: surface == Surface::Interactive,
            };
            let process = config(surface, custom, append);
            let plain = assembler_with(process.clone(), Arc::new(NoListings))
                .build(request(), &[])
                .await
                .unwrap();
            let mut pinned_request = request();
            pinned_request.prompt = Some(prompt(custom, append, traits));
            let pinned = assembler_with(process, Arc::new(NoListings))
                .build(pinned_request, &[])
                .await
                .unwrap();
            assert_eq!(
                pinned.system, plain.system,
                "{surface:?} {custom:?} {append:?}"
            );
        }
    }
}

/// SystemPin 生效：custom/append 用钉住的值（不是进程配置），`shell_escape` 也按钉住的。
#[tokio::test]
async fn a_system_pin_replaces_the_process_config() {
    let process = config(
        Surface::Print,
        Some("Config custom."),
        Some("Config append."),
    );
    let mut pinned = request();
    pinned.prompt = Some(prompt(
        Some("Pinned custom."),
        Some("Pinned append."),
        FrontendTraits::default(),
    ));
    let built = assembler_with(process, Arc::new(NoListings))
        .build(pinned, &[])
        .await
        .unwrap();
    assert_eq!(built.system.len(), 2);
    assert_eq!(built.system[1].text, "Pinned custom.\n\nPinned append.");
    assert_eq!(
        built.system[0].text,
        "You are NIBI, an interactive coding agent."
    );

    // 没有 custom 时 `shell_escape` 决定会话段里有没有 `! <command>`；进程形态是 Print，钉住的是 true。
    let mut shell = request();
    shell.prompt = Some(prompt(
        None,
        None,
        FrontendTraits {
            shell_escape: true,
            typed_mentions: false,
        },
    ));
    let session = &assembler(Surface::Print, Arc::new(NoListings))
        .build(shell, &[])
        .await
        .unwrap()
        .system[2]
        .text;
    assert!(session.contains("! <command>"), "{session}");
    let plain = old_system(assembler(Surface::Print, Arc::new(NoListings))).await;
    assert!(!plain[2].text.contains("! <command>"), "{}", plain[2].text);
}

async fn old_system(assembler: PromptAssembler) -> Vec<SystemBlock> {
    assembler.build(request(), &[]).await.unwrap().system
}

/// LivePrompt 每回合更新：同一份 system（钉住不变），附件那一层的 `typed_mentions` 变了，skill 提及这一回合就有/没有。
#[tokio::test]
async fn the_live_prompt_updates_the_typed_mentions_each_turn() {
    let history = typed("Please run /greet now.");
    let mut without = request();
    without.prompt = Some(prompt(
        None,
        None,
        FrontendTraits {
            shell_escape: false,
            typed_mentions: false,
        },
    ));
    let mut with = without.clone();
    with.prompt = Some(prompt(
        None,
        None,
        FrontendTraits {
            shell_escape: false,
            typed_mentions: true,
        },
    ));
    let assembler = assembler(Surface::Print, Arc::new(Skills));
    let first = assembler.turn_attachments(without, &history).await.unwrap();
    let second = assembler
        .turn_attachments(with.clone(), &history)
        .await
        .unwrap();
    assert!(!first.iter().any(|item| item.source == "skill_mention"));
    assert!(second.iter().any(|item| item.source == "skill_mention"));
    // system 是钉住的那一层：同一份钉住时，两回合的字节相同。
    let first_system = assembler
        .build(with.clone(), &history)
        .await
        .unwrap()
        .system;
    let mut other = with;
    other.prompt = Some(prompt(
        None,
        None,
        FrontendTraits {
            shell_escape: false,
            typed_mentions: true,
        },
    ));
    let second_system = assembler.build(other, &history).await.unwrap().system;
    assert_eq!(first_system, second_system);
}

/// `/context` 的分析用同一份钉住的输入（custom 是它的第一段，进程配置不参与）。
#[tokio::test]
async fn the_analysis_reads_the_pinned_custom_prompt() {
    let mut pinned = request();
    pinned.prompt = Some(prompt(
        Some("Pinned custom."),
        None,
        FrontendTraits::default(),
    ));
    let analysis = assembler(Surface::Print, Arc::new(NoListings))
        .analysis(&pinned, &[])
        .await
        .unwrap();
    assert_eq!(analysis.sections, ["Pinned custom."]);
}

/// 恢复：落库的 pin 从会话存储读回来，按它组装的 system 与写之前一致；旧会话（没有记录）按内核现在的输入。
#[tokio::test]
async fn a_restored_pin_renders_the_same_bytes_and_old_sessions_fall_back() {
    let store = MemoryStore::default();
    let session = request().session;
    store
        .create(nibi_kernel_api::store::SessionMeta {
            id: session.clone(),
            kind: nibi_kernel_api::store::SessionKind::Interactive,
            parent: None,
            workspace: request().workspace,
            title: String::new(),
            trace: nibi_kernel_api::ids::TraceId::new("s"),
            created_at_ms: 0,
        })
        .await
        .unwrap();
    let pin = SystemPin {
        custom: Some("Pinned.".to_owned()),
        append: Some("Append.".to_owned()),
        shell_escape: true,
    };
    let facts = nibi_kernel_api::store::FactBatch {
        owner_epoch: nibi_kernel_api::ids::OwnerEpoch::LOCAL,
        command: None,
        facts: vec![pin.fact()],
        turn: None,
    };
    store.commit(&session, facts).await.unwrap();
    let entries = store
        .entries(&session, entry_kinds::SYSTEM_PIN)
        .await
        .unwrap();
    let restored = SystemPin::recorded(&entries).expect("the pin is recorded");
    assert_eq!(restored, pin);

    let mut original = request();
    original.prompt = Some(Arc::new(
        SessionPrompt::new(None, None, FrontendTraits::default()).with_system(pin),
    ));
    let mut recovered = request();
    recovered.prompt = Some(Arc::new(
        SessionPrompt::new(None, None, FrontendTraits::default()).with_system(restored),
    ));
    let assembler = assembler(Surface::Print, Arc::new(NoListings));
    assert_eq!(
        assembler.build(original, &[]).await.unwrap().system,
        assembler.build(recovered, &[]).await.unwrap().system
    );

    // 旧会话：没有 pin 记录，按进程配置（Print 没有 `!` 提示、没有 custom）。
    let old = SystemPin::recorded(&[]);
    assert_eq!(old, None);
    let mut legacy = request();
    legacy.prompt = old.map(|pin| {
        Arc::new(SessionPrompt::new(None, None, FrontendTraits::default()).with_system(pin))
    });
    let legacy = assembler.build(legacy, &[]).await.unwrap().system;
    assert_eq!(legacy, old_system(assembler).await);
}

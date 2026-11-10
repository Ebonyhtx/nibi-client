use super::*;

fn user(id: &str, text: &str) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin: UserOrigin::Human,
    })
}

fn write(id: &str, path: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::ToolUse {
            id: ToolUseId::new("tool_1"),
            name: "Write".to_owned(),
            input: serde_json::json!({ "file_path": path }),
        }],
        model: "test".to_owned(),
        stop_reason: None,
        usage: None,
    })
}

fn memory_root() -> PathBuf {
    std::env::temp_dir().join("nibi-memory-root-test")
}

#[test]
fn cjk_prose_counts_as_words() {
    assert_eq!(count_words("hi"), 1);
    assert_eq!(count_words("你好"), 2);
    assert_eq!(count_words("你好世界"), 4);
    assert_eq!(count_words("hello world"), 2);
}

#[test]
fn short_user_prose_is_skipped_and_a_full_sentence_runs() {
    let root = memory_root();
    assert_eq!(
        evaluate_extraction(&[user("m1", "hi")], None, Some(&root), &root),
        ExtractionDecision::Skip {
            message_count: 1,
            reason: "no-user-prose"
        }
    );
    assert_eq!(
        evaluate_extraction(
            &[user("m1", "帮我记住这个项目的要求")],
            None,
            Some(&root),
            &root
        ),
        ExtractionDecision::Run { message_count: 1 }
    );
}

#[test]
fn a_direct_memory_write_skips_the_extraction() {
    let root = memory_root();
    let path = root.join("MEMORY.md").to_string_lossy().into_owned();
    assert_eq!(
        evaluate_extraction(
            &[user("m1", "请记住这个"), write("m2", &path)],
            None,
            Some(&root),
            &root
        ),
        ExtractionDecision::Skip {
            message_count: 2,
            reason: "direct-memory-write"
        }
    );
}

#[test]
fn the_cursor_limits_the_messages_that_are_considered() {
    let root = memory_root();
    let messages = [user("m1", "帮我记住这个"), user("m2", "hi")];
    let decision = evaluate_extraction(&messages, Some(&MessageId::new("m1")), Some(&root), &root);
    assert_eq!(
        decision,
        ExtractionDecision::Skip {
            message_count: 1,
            reason: "no-user-prose"
        }
    );
}

#[test]
fn only_markdown_inside_the_memory_root_is_writable() {
    let root = memory_root();
    let inside = root.join("fact.md").to_string_lossy().into_owned();
    let outside = std::env::temp_dir()
        .join("nibi-memory-outside.md")
        .to_string_lossy()
        .into_owned();
    assert!(contained_markdown(&inside, &root, None));
    assert!(!contained_markdown(&outside, &root, None));
    assert!(!contained_markdown(
        &root.join("fact.txt").to_string_lossy(),
        &root,
        None
    ));
}

#[tokio::test]
async fn extraction_writes_the_index_through_the_restricted_write_tool() {
    use nibi_kernel_api::env_files::{ReadText, TextRead};
    use nibi_kernel_api::machine::Files;
    use nibi_kernel_api::testing::{
        FixedClock, FixedContext, MemoryArtifacts, MemoryEnvironment, NeverCompact, NoHooks,
        ScriptedModel, SequentialIds, environments, local_services, machine, text_response,
        tool_use_response,
    };

    let root = std::env::temp_dir().join("nibi-memory-extraction-test");
    let root_text = root.to_string_lossy().into_owned();
    let facts = nibi_kernel_api::env::EnvFacts {
        cwd: EnvPath::new(root_text.clone()),
        platform: if cfg!(windows) { "win32" } else { "linux" }.to_owned(),
        os_version: "test".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: false,
        additional_directories: Vec::new(),
        home: Some(EnvPath::new(root_text.clone())),
    };
    let env = Arc::new(MemoryEnvironment::new(facts));
    let gate = Arc::new(nibi_kernel_policy::PolicyGate::default());
    let tools = Arc::new(nibi_kernel_tools::builtin_with(gate, None));
    let index_path = root.join("MEMORY.md").to_string_lossy().into_owned();
    let write = tool_use_response(
        "tool_1",
        "Write",
        &serde_json::json!({
            "file_path": index_path,
            "content": "- [Fact](fact.md) — hook\n"
        }),
    );
    let model = Arc::new(ScriptedModel::new(vec![
        write,
        text_response(&["Nothing to save."]),
    ]));
    let parts = QueryParts {
        model: model.clone(),
        context: Arc::new(FixedContext(Vec::new())),
        tools: tools.clone(),
        executor: Arc::new(nibi_kernel_api::testing::FailingExecutor),
        compactor: Arc::new(NeverCompact),
        hooks: Arc::new(NoHooks),
        ids: Arc::new(SequentialIds::default()),
        clock: Arc::new(FixedClock(1_792_224_000_000)),
        machine: machine(env.clone()),
        machines: environments(env.clone()),
        local: local_services(env.clone()),
        artifacts: Arc::new(MemoryArtifacts::default()),
        generation: nibi_kernel_api::ids::Generation::new("gen"),
        non_interactive: true,
        limits: Default::default(),
    };
    let prefs = Arc::new(MemoryPreferences::default());
    let scope = nibi_kernel_base::TaskScope::root("memory-test", |_| {});
    let extractor = MemoryExtractor::new(parts, prefs.clone(), Some(root.clone()), scope.spawner());
    let turn = ProjectMemoryTurn {
        session: SessionId::new("sess_1"),
        workspace: WorkspaceRef {
            environment: nibi_kernel_api::ids::EnvironmentId::new("local"),
            root: EnvPath::new(root_text.clone()),
        },
        selection: nibi_kernel_api::testing::selection(),
        mode: PermissionMode::BypassPermissions,
        messages: Arc::from(vec![user("m1", "帮我记住这个项目的要求")]),
    };
    extractor
        .inner
        .extract(&turn, 1, &CancellationToken::new())
        .await
        .unwrap();

    let workspace = WorkspaceRef {
        environment: nibi_kernel_api::ids::EnvironmentId::new("local"),
        root: EnvPath::new(root_text),
    };
    let read = env
        .read_text(
            &workspace,
            ReadText {
                path: EnvPath::new(root.join("MEMORY.md").to_string_lossy()),
                start_line: 0,
                max_lines: None,
                max_bytes: None,
            },
        )
        .await
        .unwrap();
    let TextRead::Text(slice) = read else {
        panic!("MEMORY.md was not written");
    };
    assert!(slice.content.contains("[Fact](fact.md)"));
    // 工具清单里只有记忆允许的六件，没有 Agent / MCP / 可写 Bash。
    let request = model.requests().first().cloned().expect("a model request");
    let names: Vec<&str> = request
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect();
    assert!(names.contains(&"Read"));
    assert!(names.contains(&"Write"));
    assert!(!names.contains(&"Agent"));
}

#[tokio::test]
async fn a_successful_turn_schedules_the_extraction_that_writes_the_index() {
    use crate::{ContextConfig, Defaults, LocalKernel, Ports, Surface};
    use nibi_kernel_api::env::EnvFacts;
    use nibi_kernel_api::machine::Files;
    use nibi_kernel_api::session_api::{
        Command, CommandEnvelope, CreateSession, Delivery, Kernel, KernelEvent, TurnOutcome,
    };
    use nibi_kernel_api::testing::{
        FixedClock, MemoryEnvironment, MemoryStore, ScriptedModel, SequentialIds, environments,
        selection, text_response, tool_use_response,
    };
    use std::time::Duration;

    let (root, memory_root) = if cfg!(windows) {
        (r"C:\work", r"C:\work\memory")
    } else {
        ("/work", "/work/memory")
    };
    let facts = EnvFacts {
        cwd: EnvPath::new(root),
        platform: if cfg!(windows) { "win32" } else { "linux" }.to_owned(),
        os_version: "test".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: false,
        additional_directories: Vec::new(),
        home: Some(EnvPath::new(root)),
    };
    let env = Arc::new(MemoryEnvironment::new(facts));
    let store = Arc::new(MemoryStore::default());
    let index = if cfg!(windows) {
        format!(r"{memory_root}\MEMORY.md")
    } else {
        format!("{memory_root}/MEMORY.md")
    };
    let model = Arc::new(ScriptedModel::new(vec![
        text_response(&["done"]),
        tool_use_response(
            "tool_1",
            "Write",
            &serde_json::json!({
                "file_path": index,
                "content": "- [Fact](fact.md) — hook\n"
            }),
        ),
        text_response(&["Nothing to save."]),
    ]));
    let ports = Ports {
        model,
        environments: environments(env.clone()),
        store: store.clone(),
        artifacts: store,
        clock: Arc::new(FixedClock(1_000)),
        ids: Arc::new(SequentialIds::default()),
    };
    let defaults = Defaults {
        selection: selection(),
        mode: PermissionMode::Default,
        max_turns: None,
        search_tools: false,
        task_tools: None,
        limits: Default::default(),
    };
    let mut config = ContextConfig::new(Surface::Interactive);
    config.memory_dir = Some(format!("{memory_root}/"));
    let kernel = LocalKernel::with_context(ports, defaults, config);
    let workspace = WorkspaceRef {
        environment: nibi_kernel_api::ids::EnvironmentId::new("local"),
        root: EnvPath::new(root),
    };
    let id = kernel
        .create_session(CreateSession {
            id: None,
            workspace,
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .unwrap();
    let session = kernel.open_session(&id).await.unwrap();
    let mut events = session.subscribe(Some(0));
    session
        .send(CommandEnvelope {
            id: nibi_kernel_api::ids::CommandId::new("c1"),
            command: Command::Submit {
                text: "帮我记住这个项目的要求".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
            .unwrap();
        if let KernelEvent::TurnFinished { outcome, .. } = event.event {
            assert_eq!(outcome, TurnOutcome::Success);
            break;
        }
    }
    let workspace = WorkspaceRef {
        environment: nibi_kernel_api::ids::EnvironmentId::new("local"),
        root: EnvPath::new(root),
    };
    let mut written = false;
    for _ in 0..50 {
        let read = env
            .read_text(
                &workspace,
                ReadText {
                    path: EnvPath::new(&index),
                    start_line: 0,
                    max_lines: None,
                    max_bytes: None,
                },
            )
            .await;
        if let Ok(TextRead::Text(slice)) = read
            && slice.content.contains("[Fact](fact.md)")
        {
            written = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(written, "the memory index should be written after the turn");
}

#[test]
fn frontmatter_reads_the_description_and_metadata_type() {
    let content = "---\nname: x\ndescription: A fact\nmetadata:\n  type: project\n---\n\nBody\n";
    assert_eq!(
        parse_frontmatter(content),
        (Some("A fact".to_owned()), Some("project".to_owned()))
    );
}

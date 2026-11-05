use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use serde_json::json;

use super::*;

fn selection(provider: &str, model: &str, reasoning: Option<&str>) -> ModelSelection {
    ModelSelection {
        provider: provider.to_owned(),
        model: model.to_owned(),
        reasoning: reasoning.map(str::to_owned),
        connection: None,
    }
}

#[test]
fn cas_check_only_fires_on_revision_mismatch() {
    let current = cas_check_with_epoch("c1", Some(7), None, 7, "epoch-1", false);
    assert!(current.is_none());
    let stale = cas_check_with_epoch("c1", Some(6), None, 7, "epoch-1", false).unwrap();
    assert_eq!(stale.status, Status::Stale);
    assert_eq!(stale.reason_code.as_deref(), Some("proto.staleRevision"));
    assert_eq!(stale.revision_at_decision, 7);
    // 缺 baseRevision 的命令在 schema 层就被拒；这里双保险同样按 stale 处理。
    let missing = cas_check_with_epoch("c1", None, None, 7, "epoch-1", false).unwrap();
    assert_eq!(missing.status, Status::Stale);
}

#[test]
fn cas_check_rejects_epoch_mismatch_only_for_row_targeting() {
    // revision 对、epoch 错：compare_epoch=true 才拒。
    let ok = cas_check_with_epoch("c1", Some(7), Some("epoch-1"), 7, "epoch-1", true);
    assert!(ok.is_none());
    let stale_epoch =
        cas_check_with_epoch("c1", Some(7), Some("epoch-0"), 7, "epoch-1", true).unwrap();
    assert_eq!(stale_epoch.status, Status::Stale);
    assert_eq!(
        stale_epoch.reason_code.as_deref(),
        Some("proto.staleLogEpoch")
    );
    // 同样的 epoch 错，在非 row-targeting 命令上不比。
    let ignored = cas_check_with_epoch("c1", Some(7), Some("epoch-0"), 7, "epoch-1", false);
    assert!(ignored.is_none());
}

#[test]
fn model_config_selection_maps_the_flat_nibi_payload() {
    let chosen = model_config_selection(&json!({
        "provider": "zai-standard-api",
        "model": "glm-5.3-flash",
        "thought": "max"
    }))
    .unwrap();
    assert_eq!(
        chosen,
        selection("zai-standard-api", "glm-5.3-flash", Some("max"))
    );

    // schema 要求 thought 必带；处理器对缺省保持宽容（reasoning=None，同上游 selection()），
    // 类型错了仍然 None。
    assert_eq!(
        model_config_selection(&json!({"provider": "p", "model": "m"})),
        Some(selection("p", "m", None))
    );
    assert!(
        model_config_selection(&json!({"provider": 1, "model": "m", "thought": "max"})).is_none()
    );
}

#[test]
fn collaboration_mode_reuses_the_send_text_mapping() {
    assert_eq!(
        mode(&json!("plan"), None),
        Some((PermissionMode::Default, true))
    );
    assert_eq!(
        mode(&json!("yolo"), None),
        Some((PermissionMode::BypassPermissions, false))
    );
    assert_eq!(mode(&json!("stealth"), None), None);
}

#[test]
fn retry_target_resolves_the_latest_turn_and_rejects_history() {
    use rust_cli_kernel_api::ids::MessageId;
    use rust_cli_kernel_api::message::{
        AssistantMessage, ContentBlock, Message, UserMessage, UserOrigin,
    };

    fn user(id: &str, text: &str) -> Message {
        Message::User(UserMessage {
            id: MessageId::new(id),
            content: vec![ContentBlock::Text {
                text: text.to_owned(),
            }],
            origin: UserOrigin::Human,
        })
    }
    fn assistant(id: &str) -> Message {
        Message::Assistant(AssistantMessage {
            id: MessageId::new(id),
            content: vec![],
            model: String::new(),
            stop_reason: None,
            usage: None,
        })
    }

    // 最后一轮：user → assistant。命中并取到原文。
    let messages = vec![
        user("u1", "first"),
        assistant("a1"),
        user("u2", "second"),
        assistant("a2"),
    ];
    let target = retry_target(&messages).unwrap();
    assert_eq!(target.user_message, "u2");
    assert_eq!(target.text, "second");

    // 最后一条不是 assistant：latest 守卫（历史回复 retry 会回退 active branch）。
    let with_tail = vec![
        user("u1", "first"),
        assistant("a1"),
        user("u2", "second"),
        assistant("a2"),
        user("u3", "follow-up"),
    ];
    let error = retry_target(&with_tail).unwrap_err();
    assert!(
        error.starts_with("guard.latestAssistantRetryOnly"),
        "{error}"
    );

    // 空会话。
    let empty: Vec<rust_cli_kernel_api::message::Message> = vec![];
    assert!(retry_target(&empty).is_err());

    // assistant 前没有 user 输入。
    let messages = vec![assistant("a1")];
    assert!(retry_target(&messages).is_err());

    // user 消息没有文本：不能重发空输入。
    let empty = Message::User(UserMessage {
        id: MessageId::new("u1"),
        content: vec![],
        origin: UserOrigin::Human,
    });
    let messages = vec![empty, assistant("a1")];
    let error = retry_target(&messages).unwrap_err();
    assert!(error.contains("no text"), "{error}");
}

#[test]
fn edit_target_guard_only_accepts_the_latest_real_query() {
    use rust_cli_kernel_api::ids::MessageId;
    use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};

    fn human(id: &str, text: &str) -> Message {
        Message::User(UserMessage {
            id: MessageId::new(id),
            content: vec![ContentBlock::Text {
                text: text.to_owned(),
            }],
            origin: UserOrigin::Human,
        })
    }
    fn assistant(id: &str) -> Message {
        Message::Assistant(rust_cli_kernel_api::message::AssistantMessage {
            id: MessageId::new(id),
            content: vec![],
            model: String::new(),
            stop_reason: None,
            usage: None,
        })
    }

    let messages = vec![
        human("u1", "first"),
        assistant("a1"),
        human("u2", "second"),
        assistant("a2"),
    ];
    assert!(edit_target_guard(&messages, "u2").is_ok());
    let error = edit_target_guard(&messages, "u1").unwrap_err();
    assert!(error.starts_with("guard.latestQueryEditOnly"), "{error}");
    // 没有 real user query。
    let messages = vec![assistant("a1")];
    assert!(edit_target_guard(&messages, "a1").is_err());
}

#[test]
fn session_mcp_servers_maps_stdio_http_and_sse() {
    use rust_cli_kernel_api::mcp::McpTransportConfig;
    use rust_cli_kernel_api::mcp_session::McpIsolation;

    let servers = session_mcp_servers(&json!({
        "mcpServers": [
            {
                "name": "files",
                "command": "node",
                "args": ["server.mjs", "--root", "/w"],
                "env": [{"name": "TOKEN", "value": "t"}],
                "alwaysLoad": true,
                "timeoutMs": 2500,
                "isolation": "workspace"
            },
            {
                "name": "cloud",
                "type": "http",
                "url": "https://example.invalid/mcp",
                "headers": [{"name": "Authorization", "value": "Bearer x"}]
            },
            {
                "name": "events",
                "type": "sse",
                "url": "https://example.invalid/sse",
                "headers": []
            }
        ]
    }));
    assert_eq!(servers.len(), 3);
    assert_eq!(servers[0].name, "files");
    assert!(servers[0].always_load);
    assert_eq!(servers[0].timeout_ms, Some(2500));
    assert_eq!(servers[0].isolation, McpIsolation::Workspace);
    assert_eq!(
        servers[0].transport,
        McpTransportConfig::Stdio {
            command: "node".to_owned(),
            args: ["server.mjs", "--root", "/w"]
                .iter()
                .map(|arg| (*arg).to_owned())
                .collect(),
            env: [("TOKEN".to_owned(), "t".to_owned())].into_iter().collect(),
            cwd: None,
        }
    );
    assert_eq!(servers[1].isolation, McpIsolation::Session);
    assert!(servers[1].timeout_ms.is_none());
    assert!(matches!(
        &servers[1].transport,
        McpTransportConfig::Http { url, headers }
            if url == "https://example.invalid/mcp"
                && headers.get("Authorization").map(String::as_str) == Some("Bearer x")
    ));
    assert!(matches!(
        &servers[2].transport,
        McpTransportConfig::Sse { url, .. } if url == "https://example.invalid/sse"
    ));
}

#[test]
fn session_mcp_servers_skips_unknown_shapes_and_empty_payloads() {
    // 认不出的形态不装（调用方按数量不等 warn）；没有 mcpServers 时为空。
    let servers = session_mcp_servers(&json!({
        "mcpServers": [
            {"name": "odd", "type": "websocket", "url": "ws://example.invalid"},
            {"name": "no-command"},
            {"name": "ok", "command": "node"}
        ]
    }));
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].name, "ok");
    assert!(session_mcp_servers(&json!({"workspaceId": "w"})).is_empty());
    // 显式空列表：会话没有 MCP（与 Node 的 runtimeConfig.mcp 空集合同义）。
    assert!(session_mcp_servers(&json!({"mcpServers": []})).is_empty());
}

#[test]
fn first_input_execution_overrides_config_mode() {
    let yolo = PermissionMode::BypassPermissions;
    // firstInput.mode 覆盖 config.mode（Node 的 resolveExecutionState(payload, current)）。
    assert_eq!(
        first_input_execution(
            &json!({"mode": "yolo"}),
            &json!({"mode": "build", "planEnabled": false}),
            (PermissionMode::Default, false)
        ),
        (yolo, false)
    );
    // 只给 planEnabled：沿用 config 的模式。
    assert_eq!(
        first_input_execution(
            &json!({"planEnabled": true}),
            &json!({"mode": "build", "planEnabled": false}),
            (PermissionMode::Default, false)
        ),
        (PermissionMode::Default, true)
    );
    // 都没给：config 优先，再退回入口缺省。
    assert_eq!(
        first_input_execution(&json!({}), &json!({"mode": "guarded"}), (PermissionMode::Default, false)),
        (PermissionMode::Guarded, false)
    );
    assert_eq!(
        first_input_execution(&json!({}), &json!({}), (PermissionMode::Default, true)),
        (PermissionMode::Default, true)
    );
    // 旧写法 plan：模式回到 default、plan 打开。
    assert_eq!(
        first_input_execution(&json!({"mode": "plan"}), &json!({"mode": "yolo"}), (PermissionMode::Default, false)),
        (PermissionMode::Default, true)
    );
}

#[test]
fn attachment_source_maps_images_and_pdfs_and_rejects_other_types() {
    let image = json!({"ref": "zcode-artifact://sess_a/tool-result-1", "fileName": "a.png", "mime": "image/png", "bytes": 12});
    let (source, media) = attachment_source(&image).unwrap();
    assert_eq!(media, "image/png");
    assert!(matches!(source, AttachmentSource::Artifact { .. }));
    // desktop 直传的绝对路径引用。
    let local = json!({"ref": "/tmp/a.jpg", "fileName": "a.jpg", "mime": "image/jpeg; charset=binary", "bytes": 12});
    let (source, media) = attachment_source(&local).unwrap();
    assert_eq!(media, "image/jpeg");
    assert!(matches!(source, AttachmentSource::Path { .. }));
    // PDF 也受理（走 document 块）；mime 参数被剥掉。
    let pdf = json!({"ref": "zcode-artifact://sess_a/tool-result-2", "fileName": "a.pdf", "mime": "application/pdf", "bytes": 12});
    let (source, media) = attachment_source(&pdf).unwrap();
    assert_eq!(media, "application/pdf");
    assert!(matches!(source, AttachmentSource::Artifact { .. }));
    // 其余类型：不给来源（调用方按 attachmentUnsupported 拒绝）。
    for mime in ["video/mp4", "text/plain", "application/octet-stream", ""] {
        let reference = json!({"ref": "/tmp/a", "fileName": "a", "mime": mime, "bytes": 1});
        assert!(attachment_source(&reference).is_none(), "{mime}");
    }
}

#[test]
fn with_text_puts_images_before_the_text() {
    let image = ContentBlock::Image {
        source: ImageSource::Base64 {
            media_type: "image/png".to_owned(),
            data: "AAAA".to_owned(),
        },
    };
    let blocks = with_text("hello".to_owned(), vec![image]);
    assert!(matches!(blocks[0], ContentBlock::Image { .. }));
    assert!(matches!(&blocks[1], ContentBlock::Text { text } if text == "hello"));
    // 空正文（attachment-only）：只有图片。
    assert_eq!(with_text(String::new(), vec![]).len(), 0);
}

#[test]
fn workflow_faults_carry_the_node_reason_code() {
    let rejected = workflow_ack(
        "c1",
        7,
        KernelError::Failed {
            message: "fault.command.savedWorkflowStartRejected.not_found: no workflow named build"
                .to_owned(),
        },
        "startSavedWorkflow",
    );
    assert_eq!(rejected.status, Status::Failed);
    assert_eq!(
        rejected.reason_code.as_deref(),
        Some("fault.command.savedWorkflowStartRejected.not_found")
    );
    assert_eq!(rejected.message.as_deref(), Some("no workflow named build"));

    // 没有说明时消息就是 fault 码本身。
    let bare = workflow_ack(
        "c1",
        7,
        KernelError::Failed {
            message: "fault.command.workflowRunResumeRejected.already_running".to_owned(),
        },
        "resumeWorkflowRun",
    );
    assert_eq!(
        bare.message.as_deref(),
        Some("fault.command.workflowRunResumeRejected.already_running")
    );

    // 引擎没接：与 Node 的 V4CapabilityUnsupportedError 一致。
    let missing = workflow_ack(
        "c1",
        7,
        KernelError::Unsupported {
            what: "dynamic workflow engine".to_owned(),
        },
        "amendWorkflowRunSettings",
    );
    assert_eq!(
        missing.reason_code.as_deref(),
        Some("fault.command.capabilityUnsupported")
    );
    assert!(
        missing
            .message
            .as_deref()
            .is_some_and(|message| message.contains("amendWorkflowRunSettings"))
    );
}

/// AskUserQuestion 的 v4 应答 → 内核回答：Host 的 `action/content` 直接映射多题 answers；
/// 旧单题路径落到第一题；decline/cancel 是不回答。
#[test]
fn question_answers_map_the_host_action_and_content() {
    let questions = json!([
        {"question": "Which color?", "header": "Color",
            "options": [{"label": "Blue"}, {"label": "Green"}]},
        {"question": "Which size?", "header": "Size",
            "options": [{"label": "S"}, {"label": "L"}]},
    ]);
    let answered = question_answer(
        &json!({
            "action": "accept",
            "content": {
                "answers": {"Which color?": "Blue", "Which size?": "L"},
                "annotations": {"Which color?": {"notes": "prefers blue"}},
                "response": "all set",
            },
        }),
        &questions,
    );
    let QuestionAnswer::Answered {
        answers,
        annotations,
        response,
        ..
    } = answered
    else {
        panic!("expected an answered question");
    };
    assert_eq!(answers.get("Which color?").map(String::as_str), Some("Blue"));
    assert_eq!(answers.get("Which size?").map(String::as_str), Some("L"));
    assert_eq!(
        annotations
            .get("Which color?")
            .and_then(|annotation| annotation.notes.as_deref()),
        Some("prefers blue")
    );
    assert_eq!(response.as_deref(), Some("all set"));

    // 旧单题路径：content.answer / freeText 落到第一题。
    let single = question_answer(
        &json!({"action": "accept", "content": {"answer": "Green"}}),
        &questions,
    );
    let QuestionAnswer::Answered { answers, .. } = single else {
        panic!("expected an answered question");
    };
    assert_eq!(answers.get("Which color?").map(String::as_str), Some("Green"));

    for action in ["decline", "cancel"] {
        assert_eq!(
            question_answer(&json!({"action": action}), &questions),
            QuestionAnswer::Declined
        );
    }
}

/// ExitPlanMode 的 v4 应答 → 内核回答：allowOnce / content.answer=approve 是批准，其余文字是
/// “继续计划”的反馈，decline/cancel 是不批准。
#[test]
fn plan_approval_answers_map_the_host_action_and_content() {
    assert_eq!(
        plan_approval_answer(
            &json!({"action": "accept", "content": {"answer": "approve"}}),
            PermissionMode::Default
        ),
        PlanApprovalAnswer::Approve {
            mode: PermissionMode::Default
        }
    );
    assert_eq!(
        plan_approval_answer(&json!({"optionId": "allowOnce"}), PermissionMode::Default),
        PlanApprovalAnswer::Approve {
            mode: PermissionMode::Default
        }
    );
    assert_eq!(
        plan_approval_answer(
            &json!({"action": "accept", "content": {"answer": "add a test first"}}),
            PermissionMode::Default
        ),
        PlanApprovalAnswer::KeepPlanning {
            feedback: Some("add a test first".to_owned())
        }
    );
    for action in ["decline", "cancel"] {
        assert_eq!(
            plan_approval_answer(&json!({"action": action}), PermissionMode::Default),
            PlanApprovalAnswer::KeepPlanning { feedback: None }
        );
    }
}

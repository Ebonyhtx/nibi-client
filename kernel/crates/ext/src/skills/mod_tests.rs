//! 清单：去掉禁止模型调用的与未激活的条件 skill（ext.md §2.3、§2.6）。

use std::sync::Arc;

use nibi_kernel_api::ids::{MessageId, ToolUseId};
use nibi_kernel_api::message::{
    AssistantMessage, ContentBlock, ToolResultContent, UserMessage, UserOrigin,
};
use nibi_kernel_api::testing::MemoryEnvironment;
use serde_json::json;

use super::*;
use crate::test_support::{CWD, facts, workspace};

fn read(path: &str) -> Vec<Message> {
    vec![
        Message::Assistant(AssistantMessage {
            id: MessageId::new("a1"),
            content: vec![ContentBlock::ToolUse {
                id: ToolUseId::new("t1"),
                name: "Read".to_owned(),
                input: json!({"file_path": path}),
            }],
            model: "m".to_owned(),
            stop_reason: None,
            usage: None,
        }),
        Message::User(UserMessage {
            id: MessageId::new("u1"),
            content: vec![ContentBlock::ToolResult {
                tool_use_id: ToolUseId::new("t1"),
                content: vec![ToolResultContent::Text {
                    text: "x".to_owned(),
                }],
                is_error: false,
            }],
            origin: UserOrigin::ToolResult {
                assistant: MessageId::new("a1"),
            },
        }),
    ]
}

#[tokio::test]
async fn the_listing_hides_model_disabled_and_inactive_conditional_skills() {
    let dir = format!("{CWD}/.nibi/skills");
    let env = MemoryEnvironment::new(facts())
        .with_file(
            &format!("{dir}/always/SKILL.md"),
            "---\ndescription: Always\n---\n",
        )
        .with_file(
            &format!("{dir}/hidden/SKILL.md"),
            "---\ndescription: H\ndisable-model-invocation: true\n---\n",
        )
        .with_file(
            &format!("{dir}/ts/SKILL.md"),
            "---\ndescription: TS\npaths: src/**/*.ts\n---\n",
        );
    let env = Arc::new(env);
    let catalog = SkillCatalog::new(env.clone(), env);
    // 内置的 `loop`、`init`、`security-review` 排在最后（builtin_tests.rs 里测），这里只看文件 skill。
    let lines = |entries: Vec<ListingEntry>| -> Vec<String> {
        let mut lines: Vec<String> = entries.into_iter().map(|entry| entry.line).collect();
        lines.retain(|line| {
            !["- loop: ", "- init: ", "- security-review: "]
                .iter()
                .any(|builtin| line.starts_with(builtin))
        });
        lines
    };
    assert_eq!(
        lines(catalog.listing(&workspace(), &[], "").await),
        ["- always: Always"]
    );
    let history = read(&format!("{CWD}/src/main.ts"));
    assert_eq!(
        lines(catalog.listing(&workspace(), &history, "").await),
        ["- always: Always", "- ts: TS"]
    );
}

#[tokio::test]
async fn session_plugin_roots_do_not_leak_between_sessions() {
    let env = Arc::new(
        MemoryEnvironment::new(facts())
            .with_file(
                "/Users/dev/plugins/a/skills/alpha/SKILL.md",
                "---\ndescription: Alpha\n---\n",
            )
            .with_file(
                "/Users/dev/plugins/b/skills/beta/SKILL.md",
                "---\ndescription: Beta\n---\n",
            ),
    );
    let catalog = SkillCatalog::new(env.clone(), env);
    let a = SessionId::new("session-a");
    let b = SessionId::new("session-b");
    catalog.set_session_plugin_roots(
        a.clone(),
        vec![PluginSkillRoot {
            plugin: "alpha-kit".to_owned(),
            dir: "/Users/dev/plugins/a/skills".to_owned(),
        }],
    );
    catalog.set_session_plugin_roots(
        b.clone(),
        vec![PluginSkillRoot {
            plugin: "beta-kit".to_owned(),
            dir: "/Users/dev/plugins/b/skills".to_owned(),
        }],
    );
    let names = |skills: Vec<Arc<Skill>>| -> Vec<String> {
        skills
            .into_iter()
            .map(|skill| skill.name.clone())
            .filter(|name| name.contains(':'))
            .collect()
    };
    assert_eq!(
        names(catalog.skills_for(Some(&a), &workspace()).await),
        ["alpha-kit:alpha"]
    );
    assert_eq!(
        names(catalog.skills_for(Some(&b), &workspace()).await),
        ["beta-kit:beta"]
    );
    // 没有会话快照时回落到进程级根（这里是空的）：两个会话的插件不互相泄漏。
    assert!(names(catalog.skills(&workspace()).await).is_empty());
    catalog.clear_session(&a);
    assert!(names(catalog.skills_for(Some(&a), &workspace()).await).is_empty());
}

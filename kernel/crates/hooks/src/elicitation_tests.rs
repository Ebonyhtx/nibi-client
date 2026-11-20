//! Elicitation 类 hook 的结论（docs/specs/rust-cli/ext.md §3.13.6）：经引擎端到端。

use std::sync::Arc;

use nibi_kernel_api::hooks::{ElicitationVerdict, HookEventName, HookOutcome, HookRunner};
use nibi_kernel_api::mcp_ask::ElicitationAction;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::test_support::{ScriptedEnv, engine, event, script};

async fn run(name: HookEventName, scripts: &[(&str, (&str, &str, i32))]) -> HookOutcome {
    let entries: Vec<(&str, _)> = scripts
        .iter()
        .map(|(file, (stdout, stderr, exit))| (*file, script(stdout, stderr, *exit)))
        .collect();
    let env = Arc::new(ScriptedEnv::with(&entries));
    let mut settings = json!({"hooks": {name.as_str(): [{"matcher": "srv", "hooks": []}]}});
    for (file, _) in scripts {
        settings["hooks"][name.as_str()][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type": "command", "command": file}));
    }
    let engine = engine(env, &settings);
    let payload = json!({"mcp_server_name": "srv", "message": "Your name?", "mode": "form"});
    engine
        .run(event(name, payload), CancellationToken::new())
        .await
}

fn specific(name: &str, action: &str, content: Option<Value>) -> String {
    let mut output = json!({"hookSpecificOutput": {"hookEventName": name, "action": action}});
    if let Some(content) = content {
        output["hookSpecificOutput"]["content"] = content;
    }
    output.to_string()
}

/// 结论原样交出；几个 hook 都给了时取最后一个。
#[tokio::test]
async fn the_last_verdict_wins() {
    let first = specific("Elicitation", "accept", Some(json!({"name": "a"})));
    let second = specific("Elicitation", "cancel", None);
    let outcome = run(
        HookEventName::Elicitation,
        &[("a.sh", (&first, "", 0)), ("b.sh", (&second, "", 0))],
    )
    .await;
    assert_eq!(outcome.blocking_error, None);
    assert_eq!(
        outcome.elicitation,
        Some(ElicitationVerdict {
            action: ElicitationAction::Cancel,
            content: None
        })
    );
}

/// 阻塞：退出码 2（原因是它的输出，没有时是缺省的一句）、`decision: block`、`action: decline`（缺省的话按事件不同）。
#[tokio::test]
async fn blocks_carry_the_reference_texts() {
    let blocked = run(HookEventName::Elicitation, &[("a.sh", ("", "", 2))]).await;
    assert_eq!(
        blocked.blocking_error.as_deref(),
        Some("Elicitation blocked by hook")
    );
    let block = json!({"decision": "block", "reason": "no"}).to_string();
    let reasoned = run(HookEventName::Elicitation, &[("a.sh", (&block, "", 0))]).await;
    assert_eq!(reasoned.blocking_error.as_deref(), Some("no"));
    let decline = specific("ElicitationResult", "decline", None);
    let declined = run(
        HookEventName::ElicitationResult,
        &[("a.sh", (&decline, "", 0))],
    )
    .await;
    assert_eq!(
        declined.blocking_error.as_deref(),
        Some("Elicitation result blocked by hook")
    );
    assert_eq!(
        declined.elicitation.map(|verdict| verdict.action),
        Some(ElicitationAction::Decline)
    );
}

/// 别的事件名的 `hookSpecificOutput`、纯文本、出错的输出都不是结论。
#[tokio::test]
async fn other_outputs_give_no_verdict() {
    let wrong = specific("ElicitationResult", "accept", None);
    let outcome = run(
        HookEventName::Elicitation,
        &[
            ("a.sh", (&wrong, "", 0)),
            ("b.sh", ("plain text", "", 0)),
            ("c.sh", ("", "boom", 1)),
        ],
    )
    .await;
    assert_eq!(outcome.blocking_error, None);
    assert_eq!(outcome.elicitation, None);
}

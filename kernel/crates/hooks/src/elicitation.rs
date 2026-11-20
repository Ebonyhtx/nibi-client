//! Elicitation 与 ElicitationResult 的结论（docs/specs/rust-cli/ext.md §3.13.6）：“外部”路径的每个结果
//! （`interpret::outside`，按配置顺序）这样解析：阻塞的结果（退出码 2、`decision: "block"`）以它的输出为原因；其余的输出是
//! JSON 时，`decision: "block"` 是阻塞，`hookSpecificOutput` 的 `action`（加 `content`）是结论，`action: "decline"` 同时算
//! 阻塞。几个 hook 都给了结论时取最后一个，有阻塞时阻塞为准；出错、不是 JSON 的输出当作没有结论。
//!
//! 对齐上游 ZCode-rs 0.1.88 的 `hooks/src/elicitation.rs`。

use nibi_kernel_api::hooks::{ElicitationVerdict, HookEventName, HookOutcome};
use nibi_kernel_api::mcp_ask::ElicitationAction;
use serde_json::Value;

use crate::output::{self, Parsed};
use crate::result::Summary;

/// 阻塞没有说明时的文字（ext.md §3.13.6）。
const BLOCKED: &str = "Elicitation blocked by hook";
const DENIED: &str = "Elicitation denied by hook";
const RESULT_BLOCKED: &str = "Elicitation result blocked by hook";

pub(crate) fn fold(event: HookEventName, summaries: &[Summary]) -> HookOutcome {
    let mut outcome = HookOutcome::default();
    for summary in summaries {
        let (blocked, verdict) = part(event, summary);
        if let Some(blocked) = blocked {
            outcome.blocking_error.get_or_insert(blocked);
        }
        if verdict.is_some() {
            outcome.elicitation = verdict;
        }
    }
    outcome
}

/// 一个 hook 的阻塞原因与结论。
fn part(event: HookEventName, summary: &Summary) -> (Option<String>, Option<ElicitationVerdict>) {
    let output = summary.output.trim();
    if summary.blocked {
        let reason = if summary.output.is_empty() {
            BLOCKED
        } else {
            &summary.output
        };
        return (Some(reason.to_owned()), None);
    }
    let Parsed::Json(json) = output::parse(output) else {
        return (None, None);
    };
    let reason = json
        .get("reason")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if json.get("decision").and_then(Value::as_str) == Some("block") {
        return (Some(reason.unwrap_or_else(|| BLOCKED.to_owned())), None);
    }
    let Some(specific) = json
        .get("hookSpecificOutput")
        .and_then(Value::as_object)
        .filter(|specific| {
            specific.get("hookEventName").and_then(Value::as_str) == Some(event.as_str())
        })
    else {
        return (None, None);
    };
    // `action` 的取值在解析时已按 schema 校验（output.rs 的 `specific`）。
    let action = match specific.get("action").and_then(Value::as_str) {
        Some("accept") => ElicitationAction::Accept,
        Some("decline") => ElicitationAction::Decline,
        Some("cancel") => ElicitationAction::Cancel,
        _ => return (None, None),
    };
    let blocked = (action == ElicitationAction::Decline).then(|| {
        reason.unwrap_or_else(|| {
            if event == HookEventName::Elicitation {
                DENIED
            } else {
                RESULT_BLOCKED
            }
            .to_owned()
        })
    });
    let verdict = ElicitationVerdict {
        action,
        content: specific.get("content").and_then(Value::as_object).cloned(),
    };
    (blocked, Some(verdict))
}

#[cfg(test)]
#[path = "elicitation_tests.rs"]
mod tests;

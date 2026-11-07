//! `workspace/generateText` 的「辅助档」规则（对齐 Node `workspace-generate-text.ts`）。
//!
//! 判的是纯规则，不跑模型：`git_commit_message` 必须用最低推理档 + `min(5000, 模型上限)`
//! 并且**忽略**调用方预算；其它用途用调用方预算。这条规则错了不会报错，只会让提交信息生成
//! 变得又慢又贵，所以用测试钉住。

use super::*;
use nibi_kernel_api::model::ModelSelection;

fn selection(reasoning: Option<&str>) -> ModelSelection {
    ModelSelection {
        provider: "p".into(),
        model: "m".into(),
        reasoning: reasoning.map(str::to_owned),
        connection: None,
    }
}

#[test]
fn git_commit_message_uses_the_auxiliary_tier_and_ignores_the_caller_budget() {
    let (selection, max_tokens) = resolve_from_card(
        selection(Some("high")),
        GIT_COMMIT_MESSAGE,
        Some(20_000),
        Some((Some("low".into()), 32_000)),
    );

    assert_eq!(selection.reasoning.as_deref(), Some("low"));
    assert_eq!(max_tokens, AUXILIARY_MAX_OUTPUT_TOKENS);
}

#[test]
fn git_commit_message_caps_at_the_model_limit() {
    let (_, max_tokens) = resolve_from_card(
        selection(None),
        GIT_COMMIT_MESSAGE,
        None,
        Some((None, 2_048)),
    );

    assert_eq!(max_tokens, 2_048);
}

#[test]
fn git_commit_message_without_a_directory_still_caps_at_5000() {
    let (selection, max_tokens) =
        resolve_from_card(selection(Some("high")), GIT_COMMIT_MESSAGE, Some(99_999), None);

    // 没有目录就没有最低档可换：保留调用方给的选择，预算仍是辅助档的 5000。
    assert_eq!(selection.reasoning.as_deref(), Some("high"));
    assert_eq!(max_tokens, AUXILIARY_MAX_OUTPUT_TOKENS);
}

#[test]
fn other_sources_honour_the_caller_budget_and_keep_the_reasoning_level() {
    let (selection, max_tokens) = resolve_from_card(
        selection(Some("high")),
        "workspace_generate_text",
        Some(1_234),
        Some((Some("low".into()), 32_000)),
    );

    assert_eq!(selection.reasoning.as_deref(), Some("high"));
    assert_eq!(max_tokens, 1_234);
}

#[test]
fn other_sources_fall_back_to_the_card_then_to_5000() {
    let (_, from_card) = resolve_from_card(
        selection(None),
        "workspace_generate_text",
        None,
        Some((None, 8_000)),
    );
    assert_eq!(from_card, 8_000);

    let (_, fallback) = resolve_from_card(selection(None), "workspace_generate_text", None, None);
    assert_eq!(fallback, AUXILIARY_MAX_OUTPUT_TOKENS);
}

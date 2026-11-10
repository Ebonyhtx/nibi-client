//! 旁路辅助模型调用（Node `model.generateText` + `auxiliaryModelOptions`）。
//!
//! 现在只有 `ReadSessionContext` 的 lite 抽取用它：工具要一次不在主循环里、没有工具的模型补全。
//! 模型端口、当前选择与辅助档（推理档位取目录第一档、输出上限）的 owner 是会话 actor，工具经
//! [`crate::orchestration::Interactions::auxiliary_text`] 请求，actor 起一个任务跑请求。
//!
//! 没有辅助模型时（测试替身、没有会话的 sink）实现返回 `Ok(None)`：Node 在没有 `context.model`
//! 时同样退回本地结果。这一笔不写会话用量——Node 的 `generateText` 也不记（同 `workspace/generateText`）。

use tokio_util::sync::CancellationToken;

/// 一次辅助补全。`system` / `user` 已经是模型看到的文本；调用方按用途算好预算（Node 在工具里算
/// `min(min(maxTokens, READ_SESSION_CONTEXT_MAX_TOKENS), 模型上限)`），实现方再按模型目录收窄。
#[derive(Debug, Clone)]
pub struct AuxiliaryTextRequest {
    pub system: String,
    pub user: String,
    /// 输出上限（token）。
    pub max_tokens: u32,
    /// 用量/请求头里的来源名（Node 的 `querySource`，例如 `read_session_context_extract`）。
    pub source: String,
    /// 工具被取消时取消在飞的模型请求。
    pub cancel: CancellationToken,
}

//! 旁路辅助模型调用（kernel-api `auxiliary`；`ReadSessionContext` 的 lite 抽取）。
//!
//! 与标题生成（title_model.rs）同一套辅助档：推理档位取模型目录的第一档，输出上限按目录卡片的
//! `max_output_tokens` 收窄。差别是它不写用量行——Node 的 `generateText` 也不记（见
//! `kernel-api/src/auxiliary.rs` 的说明）。当前模型选择与会话 ID 只有 actor 知道，所以请求经
//! sink 交给 actor，actor 起任务、在自己的 select 里等它，工具取消时任务随取消令牌退出。

use std::sync::Arc;

use futures_util::StreamExt;
use nibi_kernel_api::auxiliary::AuxiliaryTextRequest;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::message::ContentBlock;
use nibi_kernel_api::model::{
    small_fast_model, ApiContent, ApiMessage, ApiRole, BlockDelta, ModelError, ModelEvent,
    ModelPort, ModelRequest, ModelSelection, QuerySource, RequestOptions, SystemBlock,
};
use nibi_kernel_api::orchestration::OrchestrationError;
use nibi_kernel_api::provider::ModelDirectory;
use nibi_kernel_base::{Task, TaskError};
use tokio::sync::oneshot;

use crate::actor::Actor;

/// 在跑的一次辅助补全。
pub(crate) struct AuxJob {
    reply: oneshot::Sender<Result<Option<String>, OrchestrationError>>,
    task: Task<Result<String, ModelError>>,
}

/// 第一个结束的辅助任务（actor 的 select 分支）；没有任务时一直等。
pub(crate) async fn aux_done(
    jobs: &mut [AuxJob],
) -> (usize, Result<Result<String, ModelError>, TaskError>) {
    if jobs.is_empty() {
        return std::future::pending().await;
    }
    let (result, index, _) =
        futures_util::future::select_all(jobs.iter_mut().map(|job| &mut job.task)).await;
    (index, result)
}

impl Actor {
    /// 起一次辅助补全（`Interactions::auxiliary_text`）。选择取请求时的会话主模型（小模型槽位，
    /// `model.md` §6.1），辅助档的目录只在交互形态有。
    pub(crate) fn auxiliary(
        &mut self,
        request: AuxiliaryTextRequest,
        reply: oneshot::Sender<Result<Option<String>, OrchestrationError>>,
    ) {
        let selection = small_fast_model(&self.selection);
        let directory = self
            .deps
            .titles
            .as_ref()
            .and_then(|titles| titles.directory.clone());
        let model = self.deps.side_model.clone();
        let session = self.meta.id.clone();
        let task = self.deps.spawner.spawn("auxiliary-text", async move {
            generate(model, directory, selection, request, &session).await
        });
        self.aux_jobs.push(AuxJob { reply, task });
    }

    /// 辅助任务结束：把结果交回等它的工具。
    pub(crate) fn on_aux(
        &mut self,
        index: usize,
        result: Result<Result<String, ModelError>, TaskError>,
    ) {
        let job = self.aux_jobs.swap_remove(index);
        let outcome = match result {
            Ok(Ok(text)) => Ok(Some(text)),
            Ok(Err(error)) => Err(OrchestrationError::Failed {
                message: error.to_string(),
            }),
            Err(error) => Err(OrchestrationError::Failed {
                message: error.to_string(),
            }),
        };
        let _ = job.reply.send(outcome);
    }
}

/// 一次辅助补全（不流式给界面，只收正文）。
async fn generate(
    model: Arc<dyn ModelPort>,
    directory: Option<Arc<dyn ModelDirectory>>,
    selection: ModelSelection,
    request: AuxiliaryTextRequest,
    session: &SessionId,
) -> Result<String, ModelError> {
    let mut selection = selection;
    let mut max_tokens = u64::from(request.max_tokens);
    if let Some(directory) = &directory {
        let catalog = directory.catalog().await;
        if let Some(card) = catalog
            .models
            .iter()
            .find(|card| card.provider == selection.provider && card.model == selection.model)
        {
            // Node `auxiliaryModelOptions`：档位取目录的第一个（顺序来自模型配置，不按名字猜）。
            if let Some(level) = card.reasoning_levels.first() {
                selection.reasoning = Some(level.clone());
            }
            if card.max_output_tokens > 0 {
                max_tokens = max_tokens.min(card.max_output_tokens);
            }
        }
    }
    let source = QuerySource::Side(request.source.clone());
    let cancel = request.cancel.clone();
    let max_tokens = u32::try_from(max_tokens).unwrap_or(u32::MAX);
    let request = ModelRequest {
        selection,
        system: vec![SystemBlock {
            text: request.system,
            cache_control: None,
        }],
        messages: vec![ApiMessage {
            role: ApiRole::User,
            content: vec![ApiContent {
                block: ContentBlock::Text { text: request.user },
                cache_control: None,
            }],
            output_config: None,
        }],
        tools: Vec::new(),
        tool_choice: None,
        max_tokens,
        thinking: None,
        temperature: None,
        betas: Vec::new(),
        source,
        options: RequestOptions {
            session_id: Some(session.clone()),
            // 与标题请求同一条（工作线 F97）：Provider 补丁以请求自己的上限为输入。
            provider_max_output_tokens: Some(max_tokens),
            ..RequestOptions::default()
        },
    };
    let mut stream = model.stream(request, cancel);
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        match event? {
            ModelEvent::BlockStart {
                block: ContentBlock::Text { text: chunk },
                ..
            } => text.push_str(&chunk),
            ModelEvent::BlockDelta {
                delta: BlockDelta::Text(delta),
                ..
            } => text.push_str(&delta),
            _ => {}
        }
    }
    Ok(text)
}

#[cfg(test)]
#[path = "auxiliary_tests.rs"]
mod tests;

//! 交互的测试替身：按脚本回答提问、计划审批与权限询问，记录收到的请求与模式切换。

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;

use super::lock;
use crate::ids::{InteractionId, SessionId};
use crate::orchestration::{
    InteractionAnswer, InteractionRequest, Interactions, OrchestrationError,
};
use crate::permission::PermissionMode;

/// 按顺序给出脚本里的回答（`answer` 的 JSON）；脚本用完后返回 `Failed`（等同于交互被取消）。
/// `set_mode` 与 `set_plan` 只记录，不校验。辅助补全（`auxiliary_text`）按脚本回答，没写脚本时
/// 返回 `Ok(None)`（没有辅助模型）。
#[derive(Default)]
pub struct ScriptedInteractions {
    answers: Mutex<VecDeque<Value>>,
    asked: Mutex<Vec<InteractionRequest>>,
    modes: Mutex<Vec<PermissionMode>>,
    plans: Mutex<Vec<bool>>,
    turn_facts: Mutex<Option<crate::automation::TurnFacts>>,
    aux: Mutex<VecDeque<Result<Option<String>, String>>>,
    aux_requests: Mutex<Vec<crate::auxiliary::AuxiliaryTextRequest>>,
}

impl ScriptedInteractions {
    pub fn new(answers: impl IntoIterator<Item = Value>) -> Self {
        Self {
            answers: Mutex::new(answers.into_iter().collect()),
            ..Self::default()
        }
    }

    /// 收到的交互请求，按顺序。
    pub fn asked(&self) -> Vec<InteractionRequest> {
        lock(&self.asked).clone()
    }

    /// 收到的模式切换请求，按顺序。
    pub fn modes(&self) -> Vec<PermissionMode> {
        lock(&self.modes).clone()
    }

    /// 收到的 plan 开关请求，按顺序（修复线 F20）。
    pub fn plans(&self) -> Vec<bool> {
        lock(&self.plans).clone()
    }

    /// 设定本轮事实（`sendText` 的 automationId / botDeliveryTarget 替身）。
    pub fn set_turn_facts(&self, facts: crate::automation::TurnFacts) {
        *lock(&self.turn_facts) = Some(facts);
    }

    /// 脚本化辅助补全的回答：`Ok(Some(text))` 成功、`Ok(None)` 没有辅助模型、`Err` 失败。
    pub fn script_auxiliary(
        &self,
        replies: impl IntoIterator<Item = Result<Option<String>, String>>,
    ) {
        lock(&self.aux).extend(replies);
    }

    /// 收到的辅助补全请求，按顺序。
    pub fn aux_requests(&self) -> Vec<crate::auxiliary::AuxiliaryTextRequest> {
        lock(&self.aux_requests).clone()
    }
}

#[async_trait]
impl Interactions for ScriptedInteractions {
    async fn ask(
        &self,
        _session: &SessionId,
        request: InteractionRequest,
    ) -> Result<InteractionAnswer, OrchestrationError> {
        lock(&self.asked).push(request);
        let answer = lock(&self.answers).pop_front();
        match answer {
            Some(answer) => Ok(InteractionAnswer {
                interaction: InteractionId::new("interaction_scripted"),
                answer,
            }),
            None => Err(OrchestrationError::Failed {
                message: "the interaction ended without an answer".to_owned(),
            }),
        }
    }

    async fn set_mode(
        &self,
        _session: &SessionId,
        mode: PermissionMode,
    ) -> Result<(), OrchestrationError> {
        lock(&self.modes).push(mode);
        Ok(())
    }

    async fn set_plan(
        &self,
        _session: &SessionId,
        enabled: bool,
    ) -> Result<(), OrchestrationError> {
        lock(&self.plans).push(enabled);
        Ok(())
    }

    async fn turn_facts(&self, _session: &SessionId) -> Option<crate::automation::TurnFacts> {
        lock(&self.turn_facts).clone()
    }

    async fn auxiliary_text(
        &self,
        _session: &SessionId,
        request: crate::auxiliary::AuxiliaryTextRequest,
    ) -> Result<Option<String>, OrchestrationError> {
        lock(&self.aux_requests).push(request);
        match lock(&self.aux).pop_front() {
            Some(Ok(text)) => Ok(text),
            Some(Err(message)) => Err(OrchestrationError::Failed { message }),
            None => Ok(None),
        }
    }
}

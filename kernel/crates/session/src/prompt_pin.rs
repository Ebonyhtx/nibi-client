//! 会话钉住的模型可见输入（R09；docs/specs/rust-cli/context.md §15.3）：会话 actor 是唯一写者，状态与逻辑都在这里，
//! actor 只持有它。
//!
//! system 那一层的冻结时机（context.md §15.4）：建会话时钉内核现在的那一份并落库；冷打开沿用库里记下的（续写换了参数
//! 也不变，§15.4）；压缩之后按内核现在的输入重钉，记录与压缩边界同一个事务。附件那一层（前端能力）总是内核现在的，不落库。

use std::sync::Arc;

use nibi_kernel_api::message::{Message, SystemMessage};
use nibi_kernel_api::session_prompt::{SessionPrompt, SystemPin};
use nibi_kernel_api::store::Fact;

pub struct PromptPin {
    /// 这一刻钉住的：主循环、压缩的摘要请求、fork 子代理都读它。
    current: Arc<SessionPrompt>,
    /// 内核现在会给新会话钉的那一份（入口给的缺省）：压缩之后 system 那一层按它重钉。
    template: Arc<SessionPrompt>,
}

impl PromptPin {
    /// 新建的会话：钉内核现在的那一份（记录见 [`Self::fact`]，随建会话的初始事实落库）。
    pub fn created(template: Arc<SessionPrompt>) -> Self {
        Self {
            current: template.clone(),
            template,
        }
    }

    /// 冷打开：system 那一层用库里记下的；没有记录（这个改动之前建的会话）时用内核现在的，即以前的行为，不补写
    /// （下一次压缩时自然写下）。
    pub fn loaded(recorded: Option<SystemPin>, template: Arc<SessionPrompt>) -> Self {
        let current = match recorded {
            Some(system) => Arc::new(template.with_system(system)),
            None => template.clone(),
        };
        Self { current, template }
    }

    /// 这一刻的 system 输入的落库写法（建会话的初始事实里一条）。
    pub fn fact(&self) -> Fact {
        self.current.system.fact()
    }

    pub(crate) fn current(&self) -> Arc<SessionPrompt> {
        self.current.clone()
    }

    /// 这一批里有压缩边界时与它同一个事务落库的重钉记录：内核现在的 system 输入。提交成功之后再 [`Self::repinned`]，
    /// 所以库里与 actor 里的一致（提交失败时两边都不换）。
    pub(crate) fn repin_fact(&self, messages: &[Message]) -> Option<Fact> {
        messages
            .iter()
            .any(|message| matches!(message, Message::System(SystemMessage::CompactBoundary(_))))
            .then(|| self.template.system.fact())
    }

    /// 压缩边界提交成功之后：system 那一层换成内核现在的（压缩之后重新钉、重新记下）。
    pub(crate) fn repinned(&mut self) {
        self.current = Arc::new(self.current.with_system(self.template.system.clone()));
    }
}

#[cfg(test)]
#[path = "prompt_pin_tests.rs"]
mod tests;

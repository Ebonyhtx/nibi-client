//! 会话钉住的模型可见输入（R09；docs/specs/rust-cli/context.md §15.3、§15.5）：只有类型。
//!
//! 一个会话这一刻的 [`SessionPrompt`] 只有一个写者（会话 actor）：建会话时取内核的缺省，冷打开时 system 那一层取库里
//! 记下的，压缩之后 system 那一层按内核现在的输入重钉。主循环每一步经输出端读它（与模式、工作区同一个快照），
//! context 是唯一的组装者。内核只收数据：前端声明能力（[`FrontendTraits`]），不给文字。
//!
//! 与上游的差别只在名字：本工程没有前端专有的提示词端口，所以这里没有 `frontend_prompt` 的引用。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::{Fact, entry_kinds};

/// 前端声明的、内核认识的能力（数据，context.md §15.5）：交互与非交互会话的两个差别。内核不认识前端的名字；
/// 入口层给出。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FrontendTraits {
    /// 输入框认 `!` 开头的 bash 模式：system[2] 有 `! <command>` 那一句（经 [`SystemPin::shell_escape`] 钉住）。
    pub shell_escape: bool,
    /// 输入是人类在输入框里键入的：找 `/<skill>` 提及（`skill_mention`，context.md §4.4）。
    pub typed_mentions: bool,
}

/// system 块的输入（context.md §15.3）：会话创建时钉，压缩之后按内核现在的输入重钉，
/// 冷打开沿用记下的（续写换了参数也不变）。落库：[`Self::fact`]。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SystemPin {
    /// `--system-prompt`：有它时缺省段落都不出现（cli-args.md §4）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom: Option<String>,
    /// `--append-system-prompt`：会话段的最后一段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append: Option<String>,
    /// 钉住时前端认不认 `!`（[`FrontendTraits::shell_escape`]）。
    pub shell_escape: bool,
}

/// 记下的 [`SystemPin`] 的 entry 键：一个会话只有一份，后写覆盖（存储按键合并）。
pub const SYSTEM_PIN_ID: &str = "system";

impl SystemPin {
    /// 这一份的落库写法（`Fact::Entry`，种类 [`entry_kinds::SYSTEM_PIN`]）：建会话的初始事实里一条，压缩边界的那一批里一条。
    pub fn fact(&self) -> Fact {
        Fact::Entry {
            kind: entry_kinds::SYSTEM_PIN.to_owned(),
            id: SYSTEM_PIN_ID.to_owned(),
            data: serde_json::json!(self),
        }
    }

    /// 读回 [`Self::fact`] 写的 entry（`SessionStore::entries` 的结果）。没有（这个改动之前建的会话）时为 None：调用方
    /// 用内核现在的输入。形状不对的记录同样为 None（不是本工程写的）。
    pub fn recorded(entries: &[(String, Value)]) -> Option<Self> {
        entries
            .iter()
            .rev()
            .find(|(id, _)| id == SYSTEM_PIN_ID)
            .and_then(|(_, data)| serde_json::from_value(data.clone()).ok())
    }
}

/// 附件的输入（context.md §15.3）：打开会话时取内核现在的值，不落库，会话中途的变化经增量附件告诉模型。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LivePrompt {
    pub traits: FrontendTraits,
}

/// 一个会话这一刻的模型可见输入（context.md §15.3 的两层）。不可变：换的时候整份换一个新的 `Arc`，读者拿到的总是一致的一份。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionPrompt {
    pub system: SystemPin,
    pub live: LivePrompt,
}

impl SessionPrompt {
    /// 内核现在会给新会话钉的那一份（入口给的缺省）：custom 与追加来自命令行，`shell_escape` 来自前端能力。
    pub fn new(custom: Option<String>, append: Option<String>, traits: FrontendTraits) -> Self {
        Self {
            system: SystemPin {
                custom,
                append,
                shell_escape: traits.shell_escape,
            },
            live: LivePrompt { traits },
        }
    }

    /// system 那一层换成 `system`，附件那一层不变（冷打开沿用记下的、压缩后重钉）。
    pub fn with_system(&self, system: SystemPin) -> Self {
        Self {
            system,
            live: self.live.clone(),
        }
    }

    /// system 那一层的落库写法（建会话的初始事实与压缩边界的那一批）。
    pub fn fact(&self) -> Fact {
        self.system.fact()
    }
}

#[cfg(test)]
#[path = "session_prompt_tests.rs"]
mod tests;

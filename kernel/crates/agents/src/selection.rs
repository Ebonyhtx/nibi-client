//! 子代理的显式模型选择（Node `parseSubagentMarkdownSelection` 与 `agents-state.json` 的覆盖）。
//!
//! 写法的唯一来源是 Node 3.18 的 Markdown 合同（docs/subagents-built-in-model-overrides.md）：
//! `model` 是 `provider/model`（Picker 串可在模型后带 `$<档位>`）或
//! `custom:<providerId>:<modelId>`（两段都按 `encodeURIComponent` 编码，旧编码
//! `custom:builtin:<name>:<model>` 的 provider 是 `builtin:<name>`）；`thoughtLevel` 是档位。
//!
//! 继承名（inherit/main/sonnet/opus/haiku）、空值与无法解析的写法都表示“继承父会话”，与 Node
//! 相同 —— 不能退化成“父 provider 下的模型 id”，那会把别的 provider 的模型发给错误的供应商。

use nibi_kernel_api::model::ModelSelection;

/// agent 定义里解析出的完整选择（Provider 限定）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentModelSelection {
    pub provider: String,
    pub model: String,
    pub reasoning: Option<String>,
}

/// Node `INHERIT_NAMES`：这些写法表示继承父会话，不是模型 id。
const INHERIT_NAMES: [&str; 5] = ["inherit", "main", "sonnet", "opus", "haiku"];
const CUSTOM_PREFIX: &str = "custom:";
const LEGACY_PROVIDER: &str = "builtin";
/// Node `NIBI_MODEL_REASONING_SEPARATOR`（Picker 串里模型与档位的分隔符）。
const REASONING_SEPARATOR: char = '$';

impl AgentModelSelection {
    /// 从 agent Markdown 的 `model` + `thoughtLevel` 解析；不能解析时 None（继承父会话）。
    ///
    /// `thoughtLevel` 优先于 Picker 串里的 `$<档位>`（Node 同一顺序）。
    pub fn parse(model: &str, thought_level: Option<&str>) -> Option<Self> {
        let value = model.trim();
        if value.is_empty()
            || INHERIT_NAMES
                .iter()
                .any(|name| value.eq_ignore_ascii_case(name))
        {
            return None;
        }
        let (provider, model, picker_reasoning) = match value.strip_prefix(CUSTOM_PREFIX) {
            Some(body) => {
                let parts: Vec<&str> = body.split(':').collect();
                let (provider, model) = if parts.len() >= 3 && parts[0] == LEGACY_PROVIDER {
                    (
                        format!("{LEGACY_PROVIDER}:{}", parts[1]),
                        parts[2..].join(":"),
                    )
                } else {
                    let (provider, model) = body.split_once(':')?;
                    (provider.to_owned(), model.to_owned())
                };
                (percent_decode(&provider), percent_decode(&model), None)
            }
            None => {
                let separator = value.find('/')?;
                if separator == 0 {
                    return None;
                }
                let provider = value[..separator].to_owned();
                let raw_model = &value[separator + 1..];
                // Picker 的 `$<档位>` 后缀；`$` 在最前/最后时按型号原文处理（Node 同一判据）。
                let (model, reasoning) = match raw_model.find(REASONING_SEPARATOR) {
                    Some(index) if index > 0 && index < raw_model.len() - 1 => (
                        raw_model[..index].to_owned(),
                        Some(raw_model[index + 1..].to_owned()),
                    ),
                    _ => (raw_model.to_owned(), None),
                };
                (provider, model, reasoning)
            }
        };
        if provider.trim().is_empty() || model.trim().is_empty() {
            return None;
        }
        let reasoning = thought_level
            .map(str::trim)
            .filter(|level| !level.is_empty())
            .map(str::to_owned)
            .or(picker_reasoning);
        Some(Self {
            provider,
            model,
            reasoning,
        })
    }

    /// 内核的选择：provider/model/档位来自这一项，账号连接只在 provider 与父会话相同时沿用
    /// （Team Plan 的团队项目跟着同一供应商走；换供应商时由平台层挑默认连接）。
    pub fn selection(&self, parent: &ModelSelection) -> ModelSelection {
        ModelSelection {
            provider: self.provider.clone(),
            model: self.model.clone(),
            reasoning: self.reasoning.clone(),
            connection: if self.provider == parent.provider {
                parent.connection.clone()
            } else {
                None
            },
        }
    }
}

/// `encodeURIComponent` 的逆：`%XX` 还原成 UTF-8；坏编码原样保留（Node `safeDecodeUriComponent`）。
fn percent_decode(value: &str) -> String {
    if !value.contains('%') {
        return value.to_owned();
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(byte) = value
                .get(index + 1..index + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            decoded.push(byte);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;

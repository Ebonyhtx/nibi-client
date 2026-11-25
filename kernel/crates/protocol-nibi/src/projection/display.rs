//! 冷恢复时的工具卡片载荷：存储只留模型内容，live 的 `ToolOutput.display` 不在历史里。
//!
//! 只重建能从结果正文**确定地**得到的两种（与 Node `tool-result-metadata.ts` 读持久化 display 同一目的）：
//! `respond_to_coordinator` 的成功结果文案与 `task_output` 的 XML。其余工具的卡片载荷由各自的
//! 输入/内容在界面上派生，不在这里猜。

use serde_json::{Value, json};

/// display 的字界（shared `tool-result-metadata.ts`）。
const STATUS_CHARS: usize = 64;
const OUTPUT_CHARS: usize = 2_000;

/// 按 UTF-16 单元截断（shared schema 的 `max` 按 JS 字符串长度算）。
fn first_units(text: &str, units: usize) -> String {
    let mut out = String::with_capacity(text.len());
    let mut used = 0;
    for character in text.chars() {
        let length = character.len_utf16();
        if used + length > units {
            break;
        }
        used += length;
        out.push(character);
    }
    out
}

/// 一个 XML 标签之间的文本（`<tag>…</tag>`）。
fn between<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let rest = &text[start..];
    let end = rest.find(&close)?;
    Some(&rest[..end])
}

pub(super) fn cold(tool: &str, text: &str) -> Option<Value> {
    match tool {
        "RespondToCoordinator" => (text.starts_with("Response response_")
            && text.contains(" was queued for the coordinator."))
        .then(|| json!({"kind": "respond_to_coordinator", "status": "success"})),
        "TaskOutput" => {
            let retrieval = between(text, "retrieval_status")?;
            let mut display = json!({"kind": "task_output", "retrievalStatus": retrieval});
            if let Some(status) = between(text, "status").filter(|status| !status.is_empty()) {
                display["taskStatus"] = json!(first_units(status, STATUS_CHARS));
            }
            if let Some(output) = between(text, "output") {
                // 模型文本是 `<output>\n…\n</output>`（formatTaskOutputModelContent）。
                let mut output = output;
                if let Some(rest) = output.strip_prefix('\n') {
                    output = rest;
                }
                if let Some(rest) = output.strip_suffix('\n') {
                    output = rest;
                }
                let output = output.trim_end();
                if !output.trim().is_empty() {
                    display["output"] = json!(first_units(output, OUTPUT_CHARS));
                    if output.encode_utf16().count() > OUTPUT_CHARS {
                        display["truncated"] = json!(true);
                    }
                }
            }
            Some(display)
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "display_tests.rs"]
mod tests;

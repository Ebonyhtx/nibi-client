//! `/provider` 的文字（中英文同一张表，照 `i18n_*` 的写法）。
use super::i18n::Lang;

fn pick(lang: Lang, en: &'static str, zh: &'static str) -> &'static str {
    match lang {
        Lang::En => en,
        Lang::Zh => zh,
    }
}

pub fn title(lang: Lang) -> &'static str {
    pick(lang, "Providers", "模型 Provider")
}

/// 列表的副标题：`3 providers · 1 without a key`。
pub fn summary(lang: Lang, total: usize, missing_key: usize) -> String {
    let ready = total.saturating_sub(missing_key);
    match (lang, total, missing_key) {
        (Lang::En, 0, _) => "No provider configured".to_owned(),
        (Lang::Zh, 0, _) => "还没有配置 Provider".to_owned(),
        (Lang::En, 1, 0) => "1 provider · ready".to_owned(),
        (Lang::Zh, 1, 0) => "1 个 Provider · 可用".to_owned(),
        (Lang::En, n, 0) => format!("{n} providers · {ready} ready"),
        (Lang::Zh, n, 0) => format!("{n} 个 Provider · {ready} 个可用"),
        (Lang::En, n, missing) => format!("{n} providers · {missing} without an API key"),
        (Lang::Zh, n, missing) => format!("{n} 个 Provider · {missing} 个缺 API key"),
    }
}

/// 分页位置：`↑3 · 12/31 · ↓9`（上/下还有多少项没显示）。
pub fn page_indicator(
    lang: Lang,
    selected: usize,
    total: usize,
    above: usize,
    below: usize,
) -> String {
    let up = if above > 0 {
        format!("↑{above} · ")
    } else {
        String::new()
    };
    let down = if below > 0 {
        format!(" · ↓{below}")
    } else {
        String::new()
    };
    match lang {
        Lang::En | Lang::Zh => format!("{up}{selected}/{total}{down}"),
    }
}

pub fn empty_hint(lang: Lang) -> &'static str {
    pick(
        lang,
        "Add one with /provider add <name> — a preset fills the endpoint, protocol and models for you",
        "用 /provider add <名字> 添加；选预设会自动填好端点、协议与模型",
    )
}

pub fn add_row(lang: Lang) -> &'static str {
    pick(lang, "+ Add provider", "＋ 添加 Provider")
}

pub fn add_detail(lang: Lang) -> &'static str {
    pick(
        lang,
        "pick a preset or enter a custom endpoint",
        "选一个预设，或自己填端点",
    )
}

pub fn detail_title(lang: Lang, name: &str) -> String {
    match lang {
        Lang::En => format!("Provider · {name}"),
        Lang::Zh => format!("Provider · {name}"),
    }
}

pub fn label_base_url(lang: Lang) -> &'static str {
    pick(lang, "Base URL", "Base URL")
}

pub fn label_protocol(lang: Lang) -> &'static str {
    pick(lang, "Protocol", "协议")
}

pub fn label_models(lang: Lang) -> &'static str {
    pick(lang, "Models", "模型")
}

pub fn label_key(lang: Lang) -> &'static str {
    pick(lang, "API key", "API key")
}

pub fn label_template(lang: Lang) -> &'static str {
    pick(lang, "Template", "内置模板")
}

pub fn key_set(lang: Lang) -> &'static str {
    pick(lang, "configured", "已配置")
}

pub fn key_missing(lang: Lang) -> &'static str {
    pick(
        lang,
        "not set — /provider key to add one",
        "未配置 —— 用 /provider key 填入",
    )
}

pub fn account_provider(lang: Lang) -> &'static str {
    pick(lang, "account provider", "账号 Provider")
}

pub fn hidden_models(lang: Lang, extra: usize) -> String {
    match lang {
        Lang::En => format!("+{extra} more"),
        Lang::Zh => format!("+{extra} 个"),
    }
}

pub fn no_models(lang: Lang) -> &'static str {
    pick(lang, "none", "无")
}

pub fn action_edit(lang: Lang) -> &'static str {
    pick(
        lang,
        "Edit endpoint, models and key",
        "修改端点、模型与 key",
    )
}

pub fn action_key(lang: Lang) -> &'static str {
    pick(lang, "Set API key", "设置 API key")
}

pub fn action_default(lang: Lang, model: &str) -> String {
    match lang {
        Lang::En => format!("Use {model} as the default model"),
        Lang::Zh => format!("把 {model} 设为默认模型"),
    }
}

pub fn action_remove(lang: Lang) -> &'static str {
    pick(lang, "Remove this provider", "删除这个 Provider")
}

pub fn action_close(lang: Lang) -> &'static str {
    pick(lang, "Close", "关闭")
}

pub fn list_help(lang: Lang) -> &'static str {
    pick(
        lang,
        "{Up/Down} choose · {Enter} open · {A} add · {D} remove · {Esc} close",
        "{Up/Down} 选择 · {Enter} 打开 · {A} 添加 · {D} 删除 · {Esc} 关闭",
    )
}

pub fn detail_help(lang: Lang) -> &'static str {
    pick(
        lang,
        "{Up/Down} choose · {Enter} run · {Esc} close",
        "{Up/Down} 选择 · {Enter} 执行 · {Esc} 关闭",
    )
}

pub fn remove_confirm(lang: Lang, name: &str) -> String {
    match lang {
        Lang::En => format!("Press enter again to remove {name}"),
        Lang::Zh => format!("再按一次 enter 删除 {name}"),
    }
}

pub fn presets_title(lang: Lang) -> &'static str {
    pick(lang, "Choose a provider", "选择 Provider")
}

pub fn presets_hint(lang: Lang) -> &'static str {
    pick(
        lang,
        "The preset fills the endpoint, protocol and models; you only paste the API key",
        "预设会填好端点、协议与模型，只需要粘贴 API key",
    )
}

pub fn custom_row(lang: Lang) -> &'static str {
    pick(lang, "+ Custom", "＋ 自定义")
}

pub fn custom_detail(lang: Lang) -> &'static str {
    pick(
        lang,
        "enter the base URL, protocol and model IDs yourself",
        "自己填 Base URL、协议与模型 ID",
    )
}

pub fn presets_help(lang: Lang) -> &'static str {
    pick(
        lang,
        "{Up/Down} choose · {Enter} next · {Esc} back",
        "{Up/Down} 选择 · {Enter} 下一步 · {Esc} 返回",
    )
}

pub fn step_title(lang: Lang, step: usize, total: usize) -> String {
    match lang {
        Lang::En => format!("New provider · step {step}/{total}"),
        Lang::Zh => format!("新建 Provider · 第 {step}/{total} 步"),
    }
}

pub fn edit_title(lang: Lang, step: usize, total: usize) -> String {
    match lang {
        Lang::En => format!("Edit provider · step {step}/{total}"),
        Lang::Zh => format!("修改 Provider · 第 {step}/{total} 步"),
    }
}

pub fn prompt_name(lang: Lang) -> &'static str {
    pick(
        lang,
        "Display name (e.g. My Gateway)",
        "显示名字（例如 My Gateway）",
    )
}

pub fn prompt_base_url(lang: Lang) -> &'static str {
    pick(
        lang,
        "Base URL (e.g. https://api.deepseek.com/v1)",
        "Base URL（例如 https://api.deepseek.com/v1）",
    )
}

pub fn prompt_protocol(lang: Lang) -> &'static str {
    pick(
        lang,
        "Wire protocol: the API shape this endpoint speaks",
        "线协议：这个端点说的是哪种 API",
    )
}

pub fn prompt_models(lang: Lang) -> &'static str {
    pick(
        lang,
        "Model IDs, comma separated (e.g. glm-5, deepseek-chat)",
        "模型 ID，逗号分隔（例如 glm-5, deepseek-chat）",
    )
}

pub fn prompt_key(lang: Lang) -> &'static str {
    pick(
        lang,
        "API key (hidden input; paste with right-click or Ctrl+Shift+V; enter keeps a saved key)",
        "API key（不回显；用右键或 Ctrl+Shift+V 粘贴；已存过时 enter 保留）",
    )
}

pub fn step_help(lang: Lang) -> &'static str {
    pick(
        lang,
        "{Enter} next · {Esc} back · {Ctrl+U} clear",
        "{Enter} 下一步 · {Esc} 返回 · {Ctrl+U} 清空",
    )
}

pub fn protocol_help(lang: Lang) -> &'static str {
    pick(
        lang,
        "{Up/Down} choose this API shape · {Enter} next · {Esc} back",
        "{Up/Down} 选择协议 · {Enter} 下一步 · {Esc} 返回",
    )
}

pub fn key_help(lang: Lang) -> &'static str {
    pick(
        lang,
        "{Enter} save · {Esc} cancel · {Ctrl+U} clear",
        "{Enter} 保存 · {Esc} 取消 · {Ctrl+U} 清空",
    )
}

pub fn status_name_required(lang: Lang) -> &'static str {
    pick(lang, "A name is required", "名字不能为空")
}

pub fn status_base_url_required(lang: Lang) -> &'static str {
    pick(
        lang,
        "Base URL must start with http:// or https://",
        "Base URL 必须以 http:// 或 https:// 开头",
    )
}

pub fn status_models_required(lang: Lang) -> &'static str {
    pick(
        lang,
        "At least one model ID is required",
        "至少要填一个模型 ID",
    )
}

pub fn status_saving(lang: Lang) -> &'static str {
    pick(lang, "Saving…", "保存中…")
}

pub fn clipboard_unavailable(lang: Lang) -> &'static str {
    pick(
        lang,
        "This build cannot read the clipboard. Paste with Ctrl+Shift+V.",
        "这个构建读不了剪贴板，请用 Ctrl+Shift+V 粘贴。",
    )
}

pub fn clipboard_failed(lang: Lang, reason: &str) -> String {
    match lang {
        Lang::En => format!("Could not read the clipboard: {reason}"),
        Lang::Zh => format!("读取剪贴板失败：{reason}"),
    }
}

pub fn probe_ok(lang: Lang, name: &str) -> String {
    match lang {
        Lang::En => format!("{name}: connectivity check passed"),
        Lang::Zh => format!("{name}：连通性检查通过"),
    }
}

pub fn probe_failed(lang: Lang, name: &str, reason: &str) -> String {
    match lang {
        Lang::En => format!("{name} was saved, but the model request was rejected: {reason}"),
        Lang::Zh => format!("{name} 已保存，但模型请求被拒绝：{reason}"),
    }
}

pub fn saved(lang: Lang, name: &str, config: &str) -> String {
    match lang {
        Lang::En => format!("Saved {name} · {config}"),
        Lang::Zh => format!("已保存 {name} · {config}"),
    }
}

pub fn removed(lang: Lang, name: &str, config: &str) -> String {
    match lang {
        Lang::En => format!("Removed {name} · {config}"),
        Lang::Zh => format!("已删除 {name} · {config}"),
    }
}

pub fn unavailable(lang: Lang) -> &'static str {
    pick(
        lang,
        "/provider is unavailable in this build",
        "这个构建里 /provider 不可用",
    )
}

pub fn loading(lang: Lang) -> &'static str {
    pick(lang, "Loading providers…", "正在读取 Provider…")
}

pub fn usage(lang: Lang) -> &'static str {
    pick(
        lang,
        "Usage: /provider [add|edit <id>|key <id>|use <id>|remove <id>]",
        "用法：/provider [add|edit <id>|key <id>|use <id>|remove <id>]",
    )
}

pub fn no_usable_model(lang: Lang, id: &str) -> String {
    match lang {
        Lang::En => {
            format!("{id} has no usable model yet — add its API key first (/provider key {id})")
        }
        Lang::Zh => format!("{id} 还没有可用的模型 —— 先填 API key（/provider key {id}）"),
    }
}

pub fn unknown_provider(lang: Lang, id: &str) -> String {
    match lang {
        Lang::En => format!("No provider with id {id}"),
        Lang::Zh => format!("没有 id 为 {id} 的 Provider"),
    }
}

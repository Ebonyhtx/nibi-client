//! `/provider`：命令解析、列表/详情/预设/向导的按键与交上来的草稿。界面状态在 `App` 里，这里不起事件循环。

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::provider::WireProtocol;
use nibi_kernel_api::testing::selection;

use super::*;
use crate::ui::i18n::Lang;
use crate::ui::palette::{ColorLevel, Palette};
use crate::view::Transcript;

fn app() -> App {
    App::new(
        Palette::new(ColorLevel::TrueColor, Some((0, 0, 0))),
        Lang::En,
        Transcript::new(
            selection(),
            PermissionMode::Default,
            crate::view::test_workspace(),
        ),
        Some("/Users/dev".into()),
        "0.1.0".into(),
    )
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn info(id: &str) -> ProviderInfo {
    ProviderInfo {
        id: id.to_owned(),
        name: "Gateway".to_owned(),
        base_url: "https://gateway.example.com/v1".to_owned(),
        protocol: Some(WireProtocol::OpenAiChatCompletions),
        models: vec!["glm-5".to_owned()],
        has_key: true,
        account: false,
        personal: true,
        enabled: true,
        template: None,
        default_reasoning: Some("high".to_owned()),
    }
}

fn preset() -> ProviderPreset {
    ProviderPreset {
        id: "deepseek".to_owned(),
        name: "DeepSeek".to_owned(),
        base_url: "https://api.deepseek.com/anthropic".to_owned(),
        protocol: WireProtocol::AnthropicMessages,
        models: vec!["deepseek-v4-pro".to_owned()],
    }
}

#[test]
fn the_command_parses_the_subcommands() {
    let mut app = app();
    assert_eq!(
        app.provider_command(""),
        Some(Action::Provider(Request::List))
    );
    assert_eq!(
        app.provider_command("add"),
        Some(Action::Provider(Request::Presets))
    );
    assert_eq!(
        app.provider_command("edit personal:x"),
        Some(Action::Provider(Request::Open(Intent::Edit(
            "personal:x".to_owned()
        ))))
    );
    assert_eq!(
        app.provider_command("key personal:x"),
        Some(Action::Provider(Request::Open(Intent::Key(
            "personal:x".to_owned()
        ))))
    );
    assert_eq!(
        app.provider_command("use personal:x"),
        Some(Action::Provider(Request::Open(Intent::Use(
            "personal:x".to_owned()
        ))))
    );
    // 缺 id 时给出用法，不发请求。
    assert_eq!(app.provider_command("edit"), None);
}

#[test]
fn the_list_opens_presets_then_the_detail_then_the_form() {
    let mut app = app();
    app.overlay = Some(Overlay::Provider(ProviderView::List {
        items: vec![info("personal:gateway")],
        selected: 0,
        status: None,
    }));
    // 第一行是「添加」。
    assert_eq!(
        app.provider_key(key(KeyCode::Enter)),
        Some(Action::Provider(Request::Presets))
    );
    app.provider_key(key(KeyCode::Down));
    assert_eq!(app.provider_key(key(KeyCode::Enter)), None);
    assert!(matches!(
        app.overlay,
        Some(Overlay::Provider(ProviderView::Detail { .. }))
    ));
    // 详情页第一个动作是「修改」。
    app.provider_key(key(KeyCode::Enter));
    match &app.overlay {
        Some(Overlay::Provider(ProviderView::Form(form))) => {
            assert_eq!(form.provider.as_deref(), Some("personal:gateway"));
            assert_eq!(form.base_url, "https://gateway.example.com/v1");
            assert!(form.has_key);
        }
        other => panic!("expected the form, got {other:?}"),
    }
}

#[test]
fn a_preset_fills_the_endpoint_and_protocol() {
    let mut app = app();
    app.overlay = Some(Overlay::Provider(ProviderView::Presets {
        items: vec![preset()],
        selected: 0,
        status: None,
    }));
    // 第一行是自定义。
    app.provider_key(key(KeyCode::Down));
    app.provider_key(key(KeyCode::Enter));
    match &app.overlay {
        Some(Overlay::Provider(ProviderView::Form(form))) => {
            assert_eq!(form.template.as_deref(), Some("deepseek"));
            assert_eq!(form.protocol, WireProtocol::AnthropicMessages);
            assert_eq!(form.models, "deepseek-v4-pro");
        }
        other => panic!("expected the preset form, got {other:?}"),
    }
}

#[test]
fn the_wizard_walks_name_url_protocol_and_key() {
    let mut app = app();
    app.overlay = Some(Overlay::Provider(ProviderView::Form(Form::custom())));
    for character in "Relay".chars() {
        app.provider_key(key(KeyCode::Char(character)));
    }
    app.provider_key(key(KeyCode::Enter)); // 名称 → base URL
    for character in "https://relay.example.com/v1".chars() {
        app.provider_key(key(KeyCode::Char(character)));
    }
    app.provider_key(key(KeyCode::Enter)); // base URL → 协议
    app.provider_key(key(KeyCode::Down)); // chat → responses
    app.provider_key(key(KeyCode::Enter)); // 协议 → 模型
    for character in "glm-5, deepseek-chat".chars() {
        app.provider_key(key(KeyCode::Char(character)));
    }
    app.provider_key(key(KeyCode::Enter)); // 模型 → key
    for character in "sk-test".chars() {
        app.provider_key(key(KeyCode::Char(character)));
    }
    let action = app.provider_key(key(KeyCode::Enter));
    let Some(Action::Provider(Request::Save(draft))) = action else {
        panic!("expected a save, got {action:?}");
    };
    assert_eq!(draft.name, "Relay");
    assert_eq!(draft.base_url, "https://relay.example.com/v1");
    assert_eq!(draft.protocol, WireProtocol::OpenAiResponses);
    assert_eq!(draft.models, vec!["glm-5", "deepseek-chat"]);
    assert_eq!(
        draft.api_key.as_ref().map(|key| key.expose().to_owned()),
        Some("sk-test".to_owned())
    );
    assert!(draft.template.is_none());
}

#[test]
fn a_custom_provider_needs_a_model() {
    let mut app = app();
    app.overlay = Some(Overlay::Provider(ProviderView::Form(Form::custom())));
    for character in "R".chars() {
        app.provider_key(key(KeyCode::Char(character)));
    }
    app.provider_key(key(KeyCode::Enter));
    for character in "https://x.test".chars() {
        app.provider_key(key(KeyCode::Char(character)));
    }
    app.provider_key(key(KeyCode::Enter));
    app.provider_key(key(KeyCode::Enter)); // 协议 → 模型
    // 模型为空时原地不动，并给出提示。
    assert_eq!(app.provider_key(key(KeyCode::Enter)), None);
    match &app.overlay {
        Some(Overlay::Provider(ProviderView::Form(form))) => {
            assert_eq!(form.step, Step::Models);
            assert!(form.status.is_some());
        }
        other => panic!("expected the form, got {other:?}"),
    }
}

#[test]
fn removing_takes_two_enters() {
    let mut app = app();
    app.overlay = Some(Overlay::Provider(ProviderView::Detail {
        info: info("personal:gateway"),
        selected: 0,
        confirming: false,
        status: None,
    }));
    // 动作顺序：修改、换 key、设默认、删除、关闭。
    for _ in 0..3 {
        app.provider_key(key(KeyCode::Down));
    }
    assert_eq!(app.provider_key(key(KeyCode::Enter)), None);
    match &app.overlay {
        Some(Overlay::Provider(ProviderView::Detail { confirming, .. })) => assert!(confirming),
        other => panic!("expected the detail, got {other:?}"),
    }
    assert_eq!(
        app.provider_key(key(KeyCode::Enter)),
        Some(Action::Provider(Request::Remove {
            id: "personal:gateway".to_owned(),
            name: "Gateway".to_owned()
        }))
    );
}

#[test]
fn use_returns_the_first_model_and_unknown_ids_stay_in_the_list() {
    let mut app = app();
    let selection = app
        .provider_loaded(
            Intent::Use("personal:gateway".to_owned()),
            Ok(vec![info("personal:gateway")]),
        )
        .expect("a usable model");
    assert_eq!(
        format!("{}/{}", selection.provider, selection.model),
        "personal:gateway/glm-5"
    );
    // 默认模型必须带档位，否则 Node 与 TUI 都判它「不完整」。
    assert_eq!(selection.reasoning.as_deref(), Some("high"));

    let missing = app.provider_loaded(
        Intent::Edit("personal:missing".to_owned()),
        Ok(vec![info("personal:gateway")]),
    );
    assert!(missing.is_none());
    match &app.overlay {
        Some(Overlay::Provider(ProviderView::List { status, .. })) => {
            assert!(
                status
                    .as_deref()
                    .is_some_and(|text| text.contains("personal:missing"))
            );
        }
        other => panic!("expected the list, got {other:?}"),
    }
}

#[test]
fn the_key_view_saves_a_draft_with_the_existing_endpoint() {
    let mut app = app();
    app.overlay = Some(Overlay::Provider(ProviderView::Key {
        info: info("personal:gateway"),
        key: RedactedString::new(String::new()),
        status: None,
        saving: false,
    }));
    for character in "sk-new".chars() {
        app.provider_key(key(KeyCode::Char(character)));
    }
    let action = app.provider_key(key(KeyCode::Enter));
    let Some(Action::Provider(Request::Save(draft))) = action else {
        panic!("expected a save, got {action:?}");
    };
    assert_eq!(draft.provider.as_deref(), Some("personal:gateway"));
    assert_eq!(draft.base_url, "https://gateway.example.com/v1");
    assert_eq!(draft.models, vec!["glm-5"]);
    assert_eq!(
        draft.api_key.as_ref().map(|key| key.expose().to_owned()),
        Some("sk-new".to_owned())
    );
}

#[test]
fn every_view_renders() {
    let palette = Palette::new(ColorLevel::TrueColor, Some((0, 0, 0)));
    let views = [
        ProviderView::Loading {
            intent: Intent::ShowList,
        },
        ProviderView::List {
            items: vec![info("personal:gateway")],
            selected: 1,
            status: None,
        },
        ProviderView::Detail {
            info: info("personal:gateway"),
            selected: 0,
            confirming: false,
            status: None,
        },
        ProviderView::Presets {
            items: vec![preset()],
            selected: 0,
            status: None,
        },
        ProviderView::Form(Form::from_preset(&preset())),
        ProviderView::Form(Form::custom()),
        ProviderView::Key {
            info: info("personal:gateway"),
            key: RedactedString::new("sk-test".to_owned()),
            status: None,
            saving: false,
        },
    ];
    for view in &views {
        let rendered = super::lines(view, Lang::En, &palette, 80, 40);
        assert!(!rendered.is_empty(), "{view:?} rendered nothing");
        let zh = super::lines(view, Lang::Zh, &palette, 80, 40);
        assert_eq!(
            zh.len(),
            rendered.len(),
            "the two languages differ in height"
        );
    }
}

#[test]
fn the_command_is_listed_in_help() {
    assert!(crate::ui::commands::find("provider").is_some());
}

#[test]
fn long_lists_scroll_with_the_selection() {
    let palette = Palette::new(ColorLevel::TrueColor, Some((0, 0, 0)));
    let presets: Vec<ProviderPreset> = (0..40)
        .map(|index| ProviderPreset {
            id: format!("preset-{index}"),
            name: format!("Pre[{index}]"),
            base_url: format!("https://p{index}.example.com/v1"),
            protocol: WireProtocol::OpenAiChatCompletions,
            models: vec!["m".to_owned()],
        })
        .collect();
    let view = ProviderView::Presets {
        items: presets,
        selected: 39,
        status: None,
    };
    let rendered: Vec<String> = super::lines(&view, Lang::En, &palette, 80, 24)
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect();
    let text = rendered.join(
        "
",
    );
    // 选中的那一项必须在屏幕上，列表顶部不能被一直画出来。
    assert!(text.contains("Pre[39]"), "{text}");
    assert!(!text.contains("Pre[0]"), "{text}");
    assert!(text.contains("40/41"), "页码提示缺失：{text}");
    // 行数不能超过可用高度（终端里多出来的行会把输入区顶掉）。
    assert!(rendered.len() <= 24, "rendered {} lines", rendered.len());
}

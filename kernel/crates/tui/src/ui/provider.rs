//! `/provider`：模型 Provider 的列表、详情与新建/修改向导（`/provider add|edit|key|use|remove`）。
//!
//! TUI 不读写文件、不解析配置：概览、预设、保存与删除都经 [`crate::services::Providers`]（入口用 platform
//! 实现，测试用替身）。向导只收集用户填的东西：预设（内置模板）会带上 base URL、协议与模型清单，自定义则
//! 逐步填。API key 只在这个视图里输入（显示 `•`），不经输入框，所以不进输入历史。
use crossterm::event::{KeyCode, KeyEvent};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::provider::WireProtocol;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::app::{Action, App, Overlay};
use super::i18n_provider as text;
use super::palette::Palette;
use crate::services::{ProviderDraft, ProviderInfo, ProviderPreset, RedactedString};

/// 向导的步骤。预设（模板）自带模型清单，所以没有 `Models` 一步。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Name,
    BaseUrl,
    Protocol,
    Models,
    Key,
}

/// 打开 `/provider` 之后要先做的那件事：列表到了才知道该打开什么。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    /// 只显示列表。
    ShowList,
    /// 新建：先选预设。
    Add,
    /// 修改这个 Provider。
    Edit(String),
    /// 只换这个 Provider 的 key。
    Key(String),
    /// 把这个 Provider 的第一个模型设为默认模型。
    Use(String),
    /// 删除这个 Provider（详情页带确认）。
    Remove(String),
}

/// 界面发出的请求（runner 翻译成服务调用）。
#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    /// `/provider`：读列表。
    List,
    /// `/provider add`：读预设。
    Presets,
    /// `/provider edit|key|use|remove <id>`：读列表之后按 [`Intent`] 打开。
    Open(Intent),
    /// 向导或 key 输入交上来的内容。
    Save(ProviderDraft),
    /// 详情页确认删除（带上显示名，删除成功的提示要用）。
    Remove { id: String, name: String },
}

/// 向导的表单状态。
#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    /// 已有 Provider 的 id；`None` 是新建。
    pub provider: Option<String>,
    pub template: Option<String>,
    pub name: String,
    pub base_url: String,
    pub protocol: WireProtocol,
    pub models: String,
    pub key: RedactedString,
    /// 已经有保存过的 key（key 一步留空时保留它）。
    pub has_key: bool,
    pub enabled: bool,
    pub step: Step,
    pub status: Option<&'static str>,
    pub saving: bool,
}

impl Form {
    /// 新建：预设已经填好端点和模型，只剩名字与 key。
    pub fn from_preset(preset: &ProviderPreset) -> Self {
        Self {
            provider: None,
            template: Some(preset.id.clone()),
            name: preset.name.clone(),
            base_url: preset.base_url.clone(),
            protocol: preset.protocol,
            models: preset.models.join(", "),
            key: RedactedString::new(String::new()),
            has_key: false,
            enabled: true,
            step: Step::Name,
            status: None,
            saving: false,
        }
    }

    /// 新建：自定义端点。
    pub fn custom() -> Self {
        Self {
            provider: None,
            template: None,
            name: String::new(),
            base_url: String::new(),
            protocol: WireProtocol::OpenAiChatCompletions,
            models: String::new(),
            key: RedactedString::new(String::new()),
            has_key: false,
            enabled: true,
            step: Step::Name,
            status: None,
            saving: false,
        }
    }

    /// 修改已有 Provider。
    pub fn from_info(info: &ProviderInfo) -> Self {
        Self {
            provider: Some(info.id.clone()),
            template: info.template.clone(),
            name: info.name.clone(),
            base_url: info.base_url.clone(),
            protocol: info.protocol.unwrap_or(WireProtocol::OpenAiChatCompletions),
            models: info.models.join(", "),
            key: RedactedString::new(String::new()),
            has_key: info.has_key,
            enabled: info.enabled,
            step: Step::Name,
            status: None,
            saving: false,
        }
    }

    /// 这一步与后面的步骤。
    fn steps(&self) -> Vec<Step> {
        let mut steps = vec![Step::Name, Step::BaseUrl, Step::Protocol];
        if self.template.is_none() {
            steps.push(Step::Models);
        }
        steps.push(Step::Key);
        steps
    }

    fn position(&self) -> (usize, usize) {
        let steps = self.steps();
        let index = steps
            .iter()
            .position(|step| *step == self.step)
            .unwrap_or(0);
        (index + 1, steps.len())
    }

    /// 当前步骤的字段。
    fn field(&self) -> &str {
        match self.step {
            Step::Name => &self.name,
            Step::BaseUrl => &self.base_url,
            Step::Protocol => "",
            Step::Models => &self.models,
            Step::Key => self.key.expose(),
        }
    }

    fn field_mut(&mut self) -> &mut String {
        match self.step {
            Step::Name => &mut self.name,
            Step::BaseUrl => &mut self.base_url,
            Step::Models => &mut self.models,
            Step::Key => {
                // key 不是普通字符串：单独处理（见 `App::provider_key`），这里给一个不会用到的占位。
                unreachable!("the key step edits a redacted field")
            }
            Step::Protocol => unreachable!("the protocol step is a picker"),
        }
    }

    /// 进入下一步；已经是最后一步时返回 false（由调用方提交）。
    fn advance(&mut self) -> bool {
        let steps = self.steps();
        let index = steps
            .iter()
            .position(|step| *step == self.step)
            .unwrap_or(0);
        match steps.get(index + 1) {
            Some(next) => {
                self.step = *next;
                self.status = None;
                true
            }
            None => false,
        }
    }

    /// 回上一步；已经是第一步时返回 false（由调用方关闭）。
    fn back(&mut self) -> bool {
        let steps = self.steps();
        let index = steps
            .iter()
            .position(|step| *step == self.step)
            .unwrap_or(0);
        match index.checked_sub(1) {
            Some(previous) => {
                self.step = steps[previous];
                self.status = None;
                true
            }
            None => false,
        }
    }

    /// 交上来的草稿：模型按逗号或换行分隔。
    pub fn draft(&self) -> ProviderDraft {
        let models = self
            .models
            .split([',', '\n'])
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(str::to_owned)
            .collect();
        ProviderDraft {
            provider: self.provider.clone(),
            name: self.name.trim().to_owned(),
            base_url: self.base_url.trim().to_owned(),
            protocol: self.protocol,
            models,
            api_key: Some(self.key.clone()).filter(|key| !key.expose().trim().is_empty()),
            template: self.template.clone(),
            enabled: self.enabled,
        }
    }

    /// 这一步的校验；过了才进下一步。
    fn validate(&self, lang: super::i18n::Lang) -> Result<(), &'static str> {
        match self.step {
            Step::Name if self.name.trim().is_empty() => Err(text::status_name_required(lang)),
            Step::BaseUrl
                if !(self.base_url.trim().starts_with("http://")
                    || self.base_url.trim().starts_with("https://")) =>
            {
                Err(text::status_base_url_required(lang))
            }
            Step::Models if self.template.is_none() && self.models.trim().is_empty() => {
                Err(text::status_models_required(lang))
            }
            _ => Ok(()),
        }
    }
}

/// `/provider` 的视图状态。
#[derive(Debug, Clone, PartialEq)]
pub enum ProviderView {
    /// 正在读列表或预设；[`Intent`] 决定到了之后打开什么。
    Loading {
        intent: Intent,
    },
    List {
        items: Vec<ProviderInfo>,
        selected: usize,
        status: Option<String>,
    },
    Detail {
        info: ProviderInfo,
        selected: usize,
        /// 已经按过一次 remove，等第二次确认。
        confirming: bool,
        status: Option<String>,
    },
    Presets {
        items: Vec<ProviderPreset>,
        selected: usize,
        status: Option<String>,
    },
    Form(Form),
    Key {
        info: ProviderInfo,
        key: RedactedString,
        status: Option<&'static str>,
        saving: bool,
    },
}

/// 详情页的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Act {
    Edit,
    Key,
    Default,
    Remove,
    Close,
}

fn actions(info: &ProviderInfo) -> Vec<Act> {
    if info.account || !info.personal {
        return vec![Act::Close];
    }
    let mut acts = vec![Act::Edit, Act::Key];
    if !info.models.is_empty() {
        acts.push(Act::Default);
    }
    acts.push(Act::Remove);
    acts.push(Act::Close);
    acts
}

impl App {
    /// `/provider ...`：解析子命令后发请求。
    pub(super) fn provider_command(&mut self, args: &str) -> Option<Action> {
        let mut words = args.split_whitespace();
        let Some(kind) = words.next() else {
            return Some(Action::Provider(Request::List));
        };
        let rest = words.collect::<Vec<_>>().join(" ");
        let id = || rest.trim().to_owned();
        match kind {
            "add" => Some(Action::Provider(Request::Presets)),
            "list" | "ls" => Some(Action::Provider(Request::List)),
            "edit" if !id().is_empty() => Some(Action::Provider(Request::Open(Intent::Edit(id())))),
            "key" if !id().is_empty() => Some(Action::Provider(Request::Open(Intent::Key(id())))),
            "use" if !id().is_empty() => Some(Action::Provider(Request::Open(Intent::Use(id())))),
            "remove" | "rm" if !id().is_empty() => {
                Some(Action::Provider(Request::Open(Intent::Remove(id()))))
            }
            _ => {
                self.info(text::usage(self.lang));
                None
            }
        }
    }

    /// 列表到了：按 [Intent] 打开对应视图（找不到 id 时提示并回到列表）。
    pub fn provider_loaded(
        &mut self,
        intent: Intent,
        result: Result<Vec<ProviderInfo>, String>,
    ) -> Option<ModelSelection> {
        let lang = self.lang;
        let items = match result {
            Ok(items) => items,
            Err(reason) => {
                self.overlay = None;
                self.error(reason);
                return None;
            }
        };
        let status = match &intent {
            Intent::Use(id) => {
                let found = items.iter().find(|info| &info.id == id);
                match found.and_then(|info| info.models.first().map(|model| (info, model))) {
                    Some((info, model)) => {
                        self.overlay = None;
                        return Some(ModelSelection {
                            provider: info.id.clone(),
                            model: model.clone(),
                            reasoning: None,
                            connection: None,
                        });
                    }
                    None => Some(text::unknown_provider(lang, id)),
                }
            }
            Intent::Edit(id) | Intent::Key(id) | Intent::Remove(id) => {
                let found = items.iter().find(|info| &info.id == id).cloned();
                match found {
                    Some(info) => {
                        self.open_provider_intent(&intent, info);
                        return None;
                    }
                    None => Some(text::unknown_provider(lang, id)),
                }
            }
            Intent::ShowList | Intent::Add => None,
        };
        self.overlay = Some(Overlay::Provider(ProviderView::List {
            items,
            selected: 0,
            status,
        }));
        None
    }

    /// 列表已读到时打开详情页（`/provider edit|key|remove <id>`）。
    fn open_provider_intent(&mut self, intent: &Intent, info: ProviderInfo) {
        match intent {
            Intent::Edit(_) => {
                if info.account || !info.personal {
                    self.overlay = Some(Overlay::Provider(ProviderView::Detail {
                        info,
                        selected: 0,
                        confirming: false,
                        status: Some(
                            "read-only: this provider comes from the built-in config".to_owned(),
                        ),
                    }));
                } else {
                    self.overlay = Some(Overlay::Provider(ProviderView::Form(Form::from_info(
                        &info,
                    ))));
                }
            }
            Intent::Key(_) => {
                self.overlay = Some(Overlay::Provider(ProviderView::Key {
                    info,
                    key: RedactedString::new(String::new()),
                    status: None,
                    saving: false,
                }));
            }
            Intent::Remove(_) => {
                self.overlay = Some(Overlay::Provider(ProviderView::Detail {
                    info,
                    selected: 0,
                    confirming: true,
                    status: None,
                }));
            }
            Intent::ShowList | Intent::Add | Intent::Use(_) => {}
        }
    }

    /// 预设到了：打开预设选择（第一个是自定义）。
    pub fn provider_presets(&mut self, result: Result<Vec<ProviderPreset>, String>) {
        match result {
            Ok(items) => {
                self.overlay = Some(Overlay::Provider(ProviderView::Presets {
                    items,
                    selected: 0,
                    status: None,
                }));
            }
            Err(reason) => {
                self.overlay = None;
                self.error(reason);
            }
        }
    }

    /// 保存成功：回到列表并带上提示。
    pub fn provider_saved(
        &mut self,
        saved: crate::services::SavedProvider,
        result: Result<Vec<ProviderInfo>, String>,
    ) {
        let lang = self.lang;
        self.info(text::saved(lang, &saved.name, &saved.config));
        self.provider_loaded(
            Intent::ShowList,
            result.map(|mut items| {
                if let Some(item) = items.iter_mut().find(|info| info.id == saved.id) {
                    item.name = saved.name.clone();
                }
                items
            }),
        );
    }

    /// 删除成功：回到列表。
    pub fn provider_removed(
        &mut self,
        name: &str,
        path: String,
        result: Result<Vec<ProviderInfo>, String>,
    ) {
        let lang = self.lang;
        self.info(text::removed(lang, name, &path));
        self.provider_loaded(Intent::ShowList, result);
    }

    /// 保存失败：留在原来的视图上显示原因。
    pub fn provider_failed(&mut self, reason: String) {
        match self.overlay.as_mut() {
            Some(Overlay::Provider(ProviderView::Form(form))) => {
                form.saving = false;
                form.status = None;
            }
            Some(Overlay::Provider(ProviderView::Key { saving, .. })) => *saving = false,
            _ => {}
        }
        self.error(reason);
    }

    /// `/provider` 视图的按键；只在视图是它时调用。
    pub(super) fn provider_key(&mut self, key: KeyEvent) -> Option<Action> {
        let ctrl = self.typing.ctrl(&key);
        let typed = self.typing.is_text(&key);
        let lang = self.lang;
        // 表单要整块取出再放回：它自己会改 overlay，不能与 `view` 的借用并存。
        if matches!(self.overlay, Some(Overlay::Provider(ProviderView::Form(_)))) {
            return self.provider_form_key(key, ctrl, typed, lang);
        }
        let Some(Overlay::Provider(view)) = self.overlay.as_mut() else {
            return None;
        };
        match view {
            ProviderView::Loading { .. } => match key.code {
                KeyCode::Esc => {
                    self.overlay = None;
                    None
                }
                KeyCode::Char('c') if ctrl => {
                    self.overlay = None;
                    None
                }
                _ => None,
            },
            ProviderView::List {
                items,
                selected,
                status,
            } => {
                let last = items.len();
                match key.code {
                    KeyCode::Up | KeyCode::Char('k') => {
                        *selected = selected.checked_sub(1).unwrap_or(last);
                        *status = None;
                        None
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        *selected = (*selected + 1) % (last + 1);
                        *status = None;
                        None
                    }
                    KeyCode::Enter => {
                        let index = *selected;
                        if index == 0 {
                            return Some(Action::Provider(Request::Presets));
                        }
                        let info = items[index - 1].clone();
                        self.overlay = Some(Overlay::Provider(ProviderView::Detail {
                            info,
                            selected: 0,
                            confirming: false,
                            status: None,
                        }));
                        None
                    }
                    KeyCode::Char('a') if typed => Some(Action::Provider(Request::Presets)),
                    KeyCode::Esc => {
                        self.overlay = None;
                        None
                    }
                    KeyCode::Char('c') if ctrl => {
                        self.overlay = None;
                        None
                    }
                    _ => None,
                }
            }
            ProviderView::Detail {
                info,
                selected,
                confirming,
                status,
            } => {
                let acts = actions(info);
                let count = acts.len();
                match key.code {
                    KeyCode::Up | KeyCode::Char('k') => {
                        *selected = selected.checked_sub(1).unwrap_or(count - 1);
                        *confirming = false;
                        *status = None;
                        None
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        *selected = (*selected + 1) % count;
                        *confirming = false;
                        *status = None;
                        None
                    }
                    KeyCode::Enter => match acts.get(*selected).copied() {
                        Some(Act::Edit) => {
                            self.overlay =
                                Some(Overlay::Provider(ProviderView::Form(Form::from_info(info))));
                            None
                        }
                        Some(Act::Key) => {
                            self.overlay = Some(Overlay::Provider(ProviderView::Key {
                                info: info.clone(),
                                key: RedactedString::new(String::new()),
                                status: None,
                                saving: false,
                            }));
                            None
                        }
                        Some(Act::Default) => {
                            let model = info.models.first()?.clone();
                            let selection = ModelSelection {
                                provider: info.id.clone(),
                                model,
                                reasoning: None,
                                connection: None,
                            };
                            self.overlay = None;
                            Some(Action::ChooseModel(selection))
                        }
                        Some(Act::Remove) => {
                            if *confirming {
                                return Some(Action::Provider(Request::Remove {
                                    id: info.id.clone(),
                                    name: info.name.clone(),
                                }));
                            }
                            *confirming = true;
                            *status = Some(text::remove_confirm(lang, &info.name));
                            None
                        }
                        Some(Act::Close) | None => {
                            self.overlay = None;
                            None
                        }
                    },
                    KeyCode::Esc => {
                        if *confirming {
                            *confirming = false;
                            *status = None;
                            None
                        } else {
                            // 回到列表。
                            return Some(Action::Provider(Request::List));
                        }
                    }
                    KeyCode::Char('c') if ctrl => {
                        self.overlay = None;
                        None
                    }
                    _ => None,
                }
            }
            ProviderView::Presets {
                items,
                selected,
                status,
            } => {
                let count = items.len() + 1;
                match key.code {
                    KeyCode::Up | KeyCode::Char('k') => {
                        *selected = selected.checked_sub(1).unwrap_or(count - 1);
                        *status = None;
                        None
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        *selected = (*selected + 1) % count;
                        *status = None;
                        None
                    }
                    KeyCode::Enter => {
                        let index = *selected;
                        let form = if index == 0 {
                            Form::custom()
                        } else {
                            Form::from_preset(&items[index - 1])
                        };
                        self.overlay = Some(Overlay::Provider(ProviderView::Form(form)));
                        None
                    }
                    KeyCode::Esc => Some(Action::Provider(Request::List)),
                    KeyCode::Char('c') if ctrl => {
                        self.overlay = None;
                        None
                    }
                    _ => None,
                }
            }
            ProviderView::Form(_) => None,
            ProviderView::Key {
                info,
                key: secret,
                status,
                saving,
            } => {
                if *saving {
                    return None;
                }
                match key.code {
                    KeyCode::Enter => {
                        let typed_key = secret.expose().trim().to_owned();
                        if typed_key.is_empty() {
                            *status = Some(text::status_name_required(lang));
                            return None;
                        }
                        *saving = true;
                        let mut draft = Form::from_info(info).draft();
                        draft.api_key = Some(RedactedString::new(typed_key));
                        Some(Action::Provider(Request::Save(draft)))
                    }
                    KeyCode::Esc => {
                        self.overlay = None;
                        None
                    }
                    KeyCode::Char('c') if ctrl => {
                        self.overlay = None;
                        None
                    }
                    KeyCode::Char('u') if ctrl => {
                        *secret = RedactedString::new(String::new());
                        *status = None;
                        None
                    }
                    KeyCode::Backspace => {
                        let mut value = secret.expose().to_owned();
                        value.pop();
                        *secret = RedactedString::new(value);
                        None
                    }
                    KeyCode::Char(character) if typed => {
                        *secret = RedactedString::new(format!("{}{character}", secret.expose()));
                        *status = None;
                        None
                    }
                    _ => None,
                }
            }
        }
    }

    fn provider_form_key(
        &mut self,
        key: KeyEvent,
        ctrl: bool,
        typed: bool,
        lang: super::i18n::Lang,
    ) -> Option<Action> {
        let Some(Overlay::Provider(ProviderView::Form(mut form))) = self.overlay.take() else {
            return None;
        };
        let action = Self::form_key(&mut form, key, ctrl, typed, lang);
        if !matches!(action, Some(Action::Provider(Request::List))) && self.overlay.is_none() {
            self.overlay = Some(Overlay::Provider(ProviderView::Form(form)));
        }
        action
    }

    /// 表单的按键：不碰 overlay，返回要做的动作（关闭、回列表、保存）。
    fn form_key(
        form: &mut Form,
        key: KeyEvent,
        ctrl: bool,
        typed: bool,
        lang: super::i18n::Lang,
    ) -> Option<Action> {
        if form.saving {
            return None;
        }
        match key.code {
            KeyCode::Esc => {
                if form.back() {
                    None
                } else {
                    // 第一步再 esc：回列表。
                    Some(Action::Provider(Request::List))
                }
            }
            KeyCode::Char('c') if ctrl => Some(Action::Provider(Request::List)),
            KeyCode::Enter => {
                if let Err(status) = form.validate(lang) {
                    form.status = Some(status);
                    return None;
                }
                if form.advance() {
                    return None;
                }
                // 最后一步（key）：留空表示保留原来的 key；新建时留空也能保存，列表里会标出「缺 API key」。
                form.saving = true;
                return Some(Action::Provider(Request::Save(form.draft())));
            }
            KeyCode::Up if form.step == Step::Protocol => {
                form.protocol = previous_protocol(form.protocol);
                None
            }
            KeyCode::Down | KeyCode::Tab if form.step == Step::Protocol => {
                form.protocol = next_protocol(form.protocol);
                None
            }
            KeyCode::Char('1') if form.step == Step::Protocol => {
                form.protocol = WireProtocol::AnthropicMessages;
                None
            }
            KeyCode::Char('2') if form.step == Step::Protocol => {
                form.protocol = WireProtocol::OpenAiChatCompletions;
                None
            }
            KeyCode::Char('3') if form.step == Step::Protocol => {
                form.protocol = WireProtocol::OpenAiResponses;
                None
            }
            KeyCode::Char('u') if ctrl => {
                form.status = None;
                match form.step {
                    Step::Key => form.key = RedactedString::new(String::new()),
                    Step::Protocol => {}
                    _ => form.field_mut().clear(),
                }
                None
            }
            KeyCode::Backspace => {
                form.status = None;
                match form.step {
                    Step::Key => {
                        let mut value = form.key.expose().to_owned();
                        value.pop();
                        form.key = RedactedString::new(value);
                    }
                    Step::Protocol => {}
                    _ => {
                        form.field_mut().pop();
                    }
                }
                None
            }
            KeyCode::Char(character) if typed => {
                form.status = None;
                match form.step {
                    Step::Key => {
                        form.key = RedactedString::new(format!("{}{character}", form.key.expose()));
                    }
                    Step::Protocol => {}
                    _ => form.field_mut().push(character),
                }
                None
            }
            _ => None,
        }
    }

    /// 向导里的粘贴（去掉换行；key 一步照收，其他步骤也不该带换行）。
    pub(super) fn provider_paste(&mut self, text: &str) {
        if let Some(Overlay::Provider(ProviderView::Form(form))) = self.overlay.as_mut() {
            let text = text.replace(['\n', '\r'], " ");
            form.status = None;
            match form.step {
                Step::Key => {
                    form.key = RedactedString::new(format!("{}{text}", form.key.expose()));
                }
                Step::Protocol => {}
                _ => form.field_mut().push_str(&text),
            }
        } else if let Some(Overlay::Provider(ProviderView::Key { key, status, .. })) =
            self.overlay.as_mut()
        {
            *status = None;
            let text = text.replace(['\n', '\r'], "");
            *key = RedactedString::new(format!("{}{text}", key.expose()));
        }
    }
}

impl App {
    /// 滚轮：列表、详情与预设视图里移动选择。
    pub(super) fn provider_wheel(&mut self, step: isize) {
        let Some(Overlay::Provider(view)) = self.overlay.as_mut() else {
            return;
        };
        let (selected, count) = match view {
            ProviderView::List {
                items, selected, ..
            } => (selected, items.len() + 1),
            ProviderView::Detail { info, selected, .. } => (selected, actions(info).len()),
            ProviderView::Presets {
                items, selected, ..
            } => (selected, items.len() + 1),
            _ => return,
        };
        let count = count.max(1);
        *selected = (*selected as isize + step).rem_euclid(count as isize) as usize;
    }
}

fn next_protocol(protocol: WireProtocol) -> WireProtocol {
    match protocol {
        WireProtocol::AnthropicMessages => WireProtocol::OpenAiChatCompletions,
        WireProtocol::OpenAiChatCompletions => WireProtocol::OpenAiResponses,
        WireProtocol::OpenAiResponses => WireProtocol::AnthropicMessages,
    }
}

fn previous_protocol(protocol: WireProtocol) -> WireProtocol {
    match protocol {
        WireProtocol::AnthropicMessages => WireProtocol::OpenAiResponses,
        WireProtocol::OpenAiChatCompletions => WireProtocol::AnthropicMessages,
        WireProtocol::OpenAiResponses => WireProtocol::OpenAiChatCompletions,
    }
}

fn protocol_label(protocol: WireProtocol) -> &'static str {
    match protocol {
        WireProtocol::AnthropicMessages => "anthropic-messages (Claude Code shape)",
        WireProtocol::OpenAiChatCompletions => {
            "openai-chat-completions (OpenAI /v1/chat/completions)"
        }
        WireProtocol::OpenAiResponses => "openai-responses (OpenAI /v1/responses)",
    }
}

fn title(text: &str) -> Line<'static> {
    Line::from(Span::styled(
        text.to_owned(),
        Style::default().add_modifier(Modifier::BOLD),
    ))
}

fn dim(text: &str) -> Line<'static> {
    Line::from(Span::styled(
        text.to_owned(),
        Style::default().add_modifier(Modifier::DIM),
    ))
}

/// 视图的行（替换输入区，与 `/login` 同一套排版）。
pub fn lines(
    view: &ProviderView,
    lang: super::i18n::Lang,
    palette: &Palette,
    width: usize,
) -> Vec<Line<'static>> {
    let accent = palette.accent;
    let keys = |template: &str| super::key_hint::line(2, template, palette);
    let rule = Line::from(Span::styled("─".repeat(width), Style::default().fg(accent)));
    let mut lines = vec![rule];
    match view {
        ProviderView::Loading { .. } => {
            lines.push(title(text::title(lang)));
            lines.push(dim(text::loading(lang)));
        }
        ProviderView::List {
            items,
            selected,
            status,
        } => {
            let missing = items
                .iter()
                .filter(|info| !info.has_key && !info.account)
                .count();
            lines.push(title(text::title(lang)));
            lines.push(dim(&text::summary(lang, items.len(), missing)));
            lines.push(Line::default());
            let chosen = *selected == 0;
            lines.push(super::pick::paint(
                Line::from(vec![
                    Span::raw("  "),
                    super::pick::pointer(chosen),
                    Span::styled(text::add_row(lang).to_owned(), Style::default().fg(accent)),
                ]),
                chosen,
                palette,
                width,
            ));
            lines.push(super::pick::paint(
                Line::from(Span::styled(
                    format!("    {}", text::add_detail(lang)),
                    palette.secondary(),
                )),
                chosen,
                palette,
                width,
            ));
            for (index, info) in items.iter().enumerate() {
                let chosen = *selected == index + 1;
                lines.push(super::pick::paint(
                    Line::from(vec![
                        Span::raw("  "),
                        super::pick::pointer(chosen),
                        Span::raw(info.name.clone()),
                    ]),
                    chosen,
                    palette,
                    width,
                ));
                let mut detail = vec![format!("{} · ", info.id)];
                if let Some(protocol) = info.protocol {
                    detail.push(protocol.as_str().to_owned());
                    detail.push(" · ".to_owned());
                }
                match info.models.len() {
                    0 => detail.push(text::no_models(lang).to_owned()),
                    1 => detail.push(info.models[0].clone()),
                    count => detail.push(format!("{count} models")),
                }
                if info.account {
                    detail.push(" · ".to_owned());
                    detail.push(text::account_provider(lang).to_owned());
                } else if !info.has_key {
                    detail.push(" · ".to_owned());
                    detail.push(text::label_key(lang).to_owned());
                    detail.push(" ".to_owned());
                    detail.push(text::key_missing(lang).to_owned());
                }
                lines.push(super::pick::paint(
                    Line::from(Span::styled(
                        format!("    {}", detail.concat()),
                        palette.secondary(),
                    )),
                    chosen,
                    palette,
                    width,
                ));
            }
            if items.is_empty() {
                lines.push(Line::default());
                lines.push(dim(text::empty_hint(lang)));
            }
            lines.push(Line::default());
            if let Some(status) = status {
                lines.push(dim(status));
            }
            lines.push(keys(text::list_help(lang)));
        }
        ProviderView::Detail {
            info,
            selected,
            status,
            ..
        } => {
            lines.push(title(&text::detail_title(lang, &info.name)));
            lines.push(dim(&info.id));
            lines.push(Line::default());
            let field = |label: &str, value: String| {
                Line::from(vec![
                    Span::styled(format!("  {label:<10}"), palette.secondary()),
                    Span::raw(value),
                ])
            };
            lines.push(field(text::label_base_url(lang), info.base_url.clone()));
            lines.push(field(
                text::label_protocol(lang),
                info.protocol
                    .map(|protocol| protocol.as_str().to_owned())
                    .unwrap_or_else(|| "-".to_owned()),
            ));
            lines.push(field(
                text::label_models(lang),
                match info.models.len() {
                    0 => text::no_models(lang).to_owned(),
                    count if count > 6 => format!(
                        "{}, {}",
                        info.models[..6].join(", "),
                        text::hidden_models(lang, count - 6)
                    ),
                    _ => info.models.join(", "),
                },
            ));
            lines.push(field(
                text::label_key(lang),
                if info.has_key {
                    text::key_set(lang).to_owned()
                } else if info.account {
                    text::account_provider(lang).to_owned()
                } else {
                    text::key_missing(lang).to_owned()
                },
            ));
            if let Some(template) = &info.template {
                lines.push(field(text::label_template(lang), template.clone()));
            }
            lines.push(Line::default());
            for (index, act) in actions(info).iter().enumerate() {
                let chosen = index == *selected;
                let label = match act {
                    Act::Edit => text::action_edit(lang).to_owned(),
                    Act::Key => text::action_key(lang).to_owned(),
                    Act::Default => text::action_default(
                        lang,
                        info.models.first().map(String::as_str).unwrap_or_default(),
                    ),
                    Act::Remove => text::action_remove(lang).to_owned(),
                    Act::Close => text::action_close(lang).to_owned(),
                };
                lines.push(super::pick::paint(
                    Line::from(vec![
                        Span::raw("  "),
                        super::pick::pointer(chosen),
                        Span::raw(label),
                    ]),
                    chosen,
                    palette,
                    width,
                ));
            }
            lines.push(Line::default());
            if let Some(status) = status {
                lines.push(dim(status));
            }
            lines.push(keys(text::detail_help(lang)));
        }
        ProviderView::Presets {
            items,
            selected,
            status,
        } => {
            lines.push(title(text::presets_title(lang)));
            lines.push(dim(text::presets_hint(lang)));
            lines.push(Line::default());
            let mut row = |index: usize, label: String, detail: &str| {
                let chosen = index == *selected;
                lines.push(super::pick::paint(
                    Line::from(vec![
                        Span::raw("  "),
                        super::pick::pointer(chosen),
                        Span::raw(label),
                    ]),
                    chosen,
                    palette,
                    width,
                ));
                lines.push(super::pick::paint(
                    Line::from(Span::styled(format!("    {detail}"), palette.secondary())),
                    chosen,
                    palette,
                    width,
                ));
            };
            row(
                0,
                text::custom_row(lang).to_owned(),
                text::custom_detail(lang),
            );
            for (index, preset) in items.iter().enumerate() {
                row(
                    index + 1,
                    preset.name.clone(),
                    &format!(
                        "{} · {} · {} models",
                        preset.protocol.as_str(),
                        preset.base_url,
                        preset.models.len()
                    ),
                );
            }
            lines.push(Line::default());
            if let Some(status) = status {
                lines.push(dim(status));
            }
            lines.push(keys(text::presets_help(lang)));
        }
        ProviderView::Form(form) => {
            let (step, total) = form.position();
            let heading = if form.provider.is_some() {
                text::edit_title(lang, step, total)
            } else {
                text::step_title(lang, step, total)
            };
            lines.push(title(&heading));
            let prompt = match form.step {
                Step::Name => text::prompt_name(lang),
                Step::BaseUrl => text::prompt_base_url(lang),
                Step::Protocol => text::prompt_protocol(lang),
                Step::Models => text::prompt_models(lang),
                Step::Key => text::prompt_key(lang),
            };
            lines.push(dim(prompt));
            lines.push(Line::default());
            match form.step {
                Step::Protocol => {
                    for (index, protocol) in [
                        WireProtocol::AnthropicMessages,
                        WireProtocol::OpenAiChatCompletions,
                        WireProtocol::OpenAiResponses,
                    ]
                    .iter()
                    .enumerate()
                    {
                        let chosen = *protocol == form.protocol;
                        lines.push(super::pick::paint(
                            Line::from(vec![
                                Span::raw("  "),
                                super::pick::pointer(chosen),
                                Span::raw(format!("{}. ", index + 1)),
                                Span::raw(protocol_label(*protocol)),
                            ]),
                            chosen,
                            palette,
                            width,
                        ));
                    }
                }
                Step::Key => {
                    let count = form.key.expose().chars().count();
                    let field = if count == 0 {
                        Span::styled(
                            if form.has_key {
                                text::key_set(lang)
                            } else {
                                text::key_missing(lang)
                            },
                            Style::default().add_modifier(Modifier::DIM),
                        )
                    } else {
                        Span::raw("•".repeat(count))
                    };
                    lines.push(Line::from(vec![
                        Span::styled("  ❯ ", Style::default().fg(accent)),
                        field,
                    ]));
                }
                _ => {
                    let value = form.field().to_owned();
                    let shown = if value.is_empty() {
                        Span::styled(" ", Style::default().add_modifier(Modifier::DIM))
                    } else {
                        Span::raw(value)
                    };
                    lines.push(Line::from(vec![
                        Span::styled("  ❯ ", Style::default().fg(accent)),
                        shown,
                        Span::styled("▌", Style::default().fg(accent)),
                    ]));
                }
            }
            lines.push(Line::default());
            if let Some(status) = form.status {
                lines.push(dim(status));
            }
            lines.push(keys(if form.step == Step::Protocol {
                text::protocol_help(lang)
            } else {
                text::step_help(lang)
            }));
        }
        ProviderView::Key {
            info,
            key,
            status,
            saving,
        } => {
            lines.push(title(&text::detail_title(lang, &info.name)));
            lines.push(dim(if *saving {
                text::status_saving(lang)
            } else {
                text::prompt_key(lang)
            }));
            lines.push(Line::default());
            let count = key.expose().chars().count();
            let field = if count == 0 {
                Span::styled(
                    if info.has_key {
                        text::key_set(lang)
                    } else {
                        text::key_missing(lang)
                    },
                    Style::default().add_modifier(Modifier::DIM),
                )
            } else {
                Span::raw("•".repeat(count))
            };
            lines.push(Line::from(vec![
                Span::styled("  ❯ ", Style::default().fg(accent)),
                field,
            ]));
            lines.push(Line::default());
            if let Some(status) = status {
                lines.push(dim(status));
            }
            lines.push(keys(text::key_help(lang)));
        }
    }
    lines
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;

//! 入口注入的服务与只读查询的执行（docs/specs/rust-cli/tui.md §7.1、§7.2，context-usage.md §6）：界面语言的
//! 写回、登录与退出、`/context`。每个操作是一个 future，结果作为 [`ServiceDone`] 回到事件循环；状态只在
//! 事件循环里改。
use futures_util::FutureExt;
use ratatui::backend::Backend;
use tokio::sync::oneshot;

use super::Loop;
use super::session::Done;
use crate::services::{
    Authorize, CancellationToken, Configured, DeviceCode, Family, LoginFailure, NibiAccount,
    ProviderDraft, ProviderInfo, ProviderPreset, RedactedString, SavedProvider, UiLocale,
};
use crate::ui::app::Local;
use crate::ui::i18n;
use crate::ui::i18n_input;
use crate::ui::i18n_provider;
use crate::ui::provider::{Intent, ProviderView};
use nibi_kernel_api::context_usage::{ContextUsage, ContextUsageQuery};
use nibi_kernel_api::session_api::KernelError;

/// 服务操作的结果。
pub(crate) enum ServiceDone {
    /// 界面语言写回完成：成功时是配置文件的路径。
    Locale {
        locale: UiLocale,
        result: Result<String, String>,
    },
    /// 浏览器授权的地址到了（通道被关掉时为 None：登录在拿到地址之前就结束了）。
    LoginUrl {
        family: Family,
        authorize: Option<Authorize>,
    },
    /// NIBI 设备码到了（通道被关掉时为 None）。
    DeviceCode { code: Option<DeviceCode> },
    /// NIBI 账号登录结束。
    Nibi(Result<NibiAccount, LoginFailure>),
    /// 浏览器授权登录结束。
    Login(Result<Configured, LoginFailure>),
    /// 手工 key 保存结束。
    ApiKey(Result<Configured, String>),
    /// 退出结束：成功时是凭据文件的路径。
    Logout(Result<String, String>),
    /// Provider 列表到了（`intent` 决定接着打开什么）。
    Providers {
        intent: Intent,
        result: Result<Vec<ProviderInfo>, String>,
    },
    /// 新建 Provider 的预设（内置模板）到了。
    ProviderPresets(Result<Vec<ProviderPreset>, String>),
    /// 保存成功（附带刷新后的列表与一次 1 token 的连通性探测）。
    ProviderSaved {
        saved: SavedProvider,
        list: Result<Vec<ProviderInfo>, String>,
        probe: Option<Result<(), String>>,
    },
    /// 保存失败：留在原来的视图上显示原因。
    ProviderFailed(String),
    /// 向导里右键粘贴：剪贴板文字或读不出的原因。
    ProviderClipboard(Result<String, String>),
    /// 输入框按 Ctrl+V 而剪贴板里没有图片：按文字粘贴。
    ComposerText(Result<String, String>),
    /// `/btw` 的答案（成功是正文，失败是内核错误）。
    Btw(Result<String, nibi_kernel_api::session_api::KernelError>),
    /// 删除成功（附带刷新后的列表）。
    ProviderRemoved {
        name: String,
        path: String,
        list: Result<Vec<ProviderInfo>, String>,
    },
    /// `/context` 的结果（装箱：比其他变体大得多）。
    Context {
        usage: Box<Result<ContextUsage, KernelError>>,
        all: bool,
    },
}

/// 只属于事件循环的服务状态。
#[derive(Default)]
pub(super) struct ServiceState {
    /// 有一次界面语言写回在途。
    locale_writing: bool,
    /// 在途期间又输入的语言：只留最后一个，在途的完成后再写（两次写入不交错，tui.md §7.1）。
    locale_next: Option<UiLocale>,
    /// 在途的浏览器授权登录的取消令牌：登录状态的唯一 owner（tui.md §7.2）。
    login: Option<CancellationToken>,
}

impl<B: Backend> Loop<'_, B> {
    /// `/locale <值>`：先写回配置文件，成功后再切换（Node 先写后改）。
    pub(super) fn save_locale(&mut self, locale: UiLocale) {
        let Some(store) = self.options.services.locale_store.clone() else {
            self.app.info(i18n::locale_unavailable(self.app.lang));
            return;
        };
        if self.services.locale_writing {
            self.services.locale_next = Some(locale);
            return;
        }
        self.services.locale_writing = true;
        // 写入在输入时就开始；完成后回到事件循环。
        let saving = store.save(locale);
        self.pending.push(
            async move {
                let result = saving.await;
                Done::Service(ServiceDone::Locale { locale, result })
            }
            .boxed(),
        );
    }

    /// 浏览器授权登录（tui.md §7.2）：同时只有一个；地址与结果分别作为 `Done` 回来。
    pub(super) fn login(&mut self, family: Family) {
        let lang = self.app.lang;
        let Some(account) = self.options.services.account.clone() else {
            self.app.login_closed();
            self.app.info(i18n::login_unavailable(lang, family, false));
            return;
        };
        if self.services.login.is_some() {
            return;
        }
        let cancel = CancellationToken::new();
        self.services.login = Some(cancel.clone());
        let (sender, receiver) = oneshot::channel();
        let login = account.login(family, sender, cancel);
        self.pending.push(
            async move {
                let authorize = receiver.await.ok();
                Done::Service(ServiceDone::LoginUrl { family, authorize })
            }
            .boxed(),
        );
        self.pending
            .push(async move { Done::Service(ServiceDone::Login(login.await)) }.boxed());
    }

    /// NIBI 账号的设备码登录（tui.md §7.2）：设备码与结果分别作为 `Done` 回来。
    pub(super) fn login_nibi(&mut self) {
        let lang = self.app.lang;
        let Some(account) = self.options.services.account.clone() else {
            self.app.login_closed();
            self.app.info(i18n::login_nibi_unavailable(lang));
            return;
        };
        if self.services.login.is_some() {
            return;
        }
        let cancel = CancellationToken::new();
        self.services.login = Some(cancel.clone());
        let (sender, receiver) = oneshot::channel();
        let login = account.login_nibi(sender, cancel);
        self.pending.push(
            async move {
                let code = receiver.await.ok();
                Done::Service(ServiceDone::DeviceCode { code })
            }
            .boxed(),
        );
        self.pending
            .push(async move { Done::Service(ServiceDone::Nibi(login.await)) }.boxed());
    }

    /// `/context`：内核按会话的当前视图（没有会话时按新会话的模型与模式）算出用量，只读。
    pub(super) fn context_usage(&mut self, all: bool) {
        let kernel = self.kernel.clone();
        let query = ContextUsageQuery {
            session: self.session.as_ref().map(|session| session.id().clone()),
            workspace: self.app.view.workspace().clone(),
            selection: self.app.view.selection().clone(),
            // 判决用的模式（plan 开时是 plan，修复线 F20）。
            mode: self.app.view.execution().effective(),
        };
        self.pending.push(
            async move {
                let usage = kernel.context_usage(query).await;
                Done::Service(ServiceDone::Context {
                    usage: Box::new(usage),
                    all,
                })
            }
            .boxed(),
        );
    }

    /// esc：取消是一条消息，结果仍由登录的 future 给出（已经写完就是成功）。
    pub(super) fn cancel_login(&mut self) {
        if let Some(cancel) = &self.services.login {
            cancel.cancel();
        }
    }

    pub(super) fn configure_key(&mut self, family: Family, key: RedactedString) {
        let Some(account) = self.options.services.account.clone() else {
            self.app.login_closed();
            self.app
                .info(i18n::login_unavailable(self.app.lang, family, true));
            return;
        };
        let saving = account.configure_api_key(family, key);
        self.pending
            .push(async move { Done::Service(ServiceDone::ApiKey(saving.await)) }.boxed());
    }

    pub(super) fn logout(&mut self) {
        let Some(account) = self.options.services.account.clone() else {
            self.app.info(i18n::logout_unavailable(self.app.lang));
            return;
        };
        let logout = account.logout();
        self.pending
            .push(async move { Done::Service(ServiceDone::Logout(logout.await)) }.boxed());
    }

    /// 登录成功：关闭视图、提示结果，再重读模型目录、切到登录给出的模型（tui.md §7.2，D8）。
    fn configured(&mut self, result: Result<Configured, String>) {
        self.app.login_closed();
        match result {
            Ok(configured) => {
                self.app.info(i18n::configured(self.app.lang, &configured));
                if self.options.models.is_some() {
                    self.catalog(Some(configured.model));
                }
            }
            Err(reason) => self.app.error(reason),
        }
    }

    /// `/btw <问题>`：无会话的一次性旁路提问。答案单独成页，不写进主对话、不占会话用量。
    pub(super) fn btw(&mut self, question: String) {
        use nibi_kernel_api::generate_text::GenerateTextRequest;
        use nibi_kernel_api::message::ContentBlock;
        use nibi_kernel_api::model::{ApiContent, ApiMessage, ApiRole, QuerySource, SystemBlock};
        let selection = self.app.view.selection().clone();
        let kernel = self.kernel.clone();
        let request = GenerateTextRequest {
            selection,
            system: vec![SystemBlock {
                text: "You are answering a quick side question inside the NIBI terminal.                        Answer in the user's language, be concise, and do not claim to have run tools."
                    .to_owned(),
                cache_control: None,
            }],
            messages: vec![ApiMessage {
                role: ApiRole::User,
                content: vec![ApiContent {
                    block: ContentBlock::Text { text: question },
                    cache_control: None,
                }],
                output_config: None,
            }],
            tools: Vec::new(),
            tool_choice: None,
            max_tokens: Some(2000),
            source: QuerySource::Side("btw".to_owned()),
        };
        let cancel = CancellationToken::new();
        self.pending.push(
            async move {
                let reply = kernel.generate_text(request, cancel).await;
                Done::Service(ServiceDone::Btw(reply.map(|reply| reply.text)))
            }
            .boxed(),
        );
    }

    /// 向导里的右键粘贴：读剪贴板纯文字（不经过键盘，避免终端多送一个按键）。
    pub(super) fn provider_clipboard(&mut self) {
        let Some(clipboard) = self.options.services.clipboard.clone() else {
            self.app
                .info(i18n_provider::clipboard_unavailable(self.app.lang));
            return;
        };
        let reading = clipboard.text();
        self.pending.push(
            async move { Done::Service(ServiceDone::ProviderClipboard(reading.await)) }.boxed(),
        );
    }

    /// `/provider` 的请求分派。
    pub(super) fn provider(&mut self, request: crate::ui::provider::Request) {
        match request {
            crate::ui::provider::Request::List => self.providers_list(Intent::ShowList),
            crate::ui::provider::Request::Presets => self.provider_presets(),
            crate::ui::provider::Request::Open(intent) => self.providers_list(intent),
            crate::ui::provider::Request::Save(draft) => self.provider_save(draft),
            crate::ui::provider::Request::Remove { id, name } => self.provider_remove(id, name),
        }
    }

    /// `/provider`：读列表（`intent` 决定到了之后打开列表、表单还是详情）。
    pub(super) fn providers_list(&mut self, intent: Intent) {
        let Some(providers) = self.options.services.providers.clone() else {
            self.app.error(i18n_provider::unavailable(self.app.lang));
            return;
        };
        self.app.overlay = Some(crate::ui::app::Overlay::Provider(ProviderView::Loading {
            intent: intent.clone(),
        }));
        let listing = providers.list();
        self.pending.push(
            async move {
                Done::Service(ServiceDone::Providers {
                    intent,
                    result: listing.await,
                })
            }
            .boxed(),
        );
    }

    /// `/provider add`：读预设（内置模板）。
    pub(super) fn provider_presets(&mut self) {
        let Some(providers) = self.options.services.providers.clone() else {
            self.app.error(i18n_provider::unavailable(self.app.lang));
            return;
        };
        self.app.overlay = Some(crate::ui::app::Overlay::Provider(ProviderView::Loading {
            intent: Intent::Add,
        }));
        let listing = providers.presets();
        self.pending.push(
            async move { Done::Service(ServiceDone::ProviderPresets(listing.await)) }.boxed(),
        );
    }

    /// 向导交上来的内容：保存之后刷新列表，并用 1 token 探一次这个 Provider（key 对不对、端点通不通
    /// 当场就能看到，不用等第一次对话才被对端拒绝）。
    pub(super) fn provider_save(&mut self, draft: ProviderDraft) {
        let Some(providers) = self.options.services.providers.clone() else {
            self.app.error(i18n_provider::unavailable(self.app.lang));
            return;
        };
        let kernel = self.kernel.clone();
        let saving = providers.save(draft);
        self.pending.push(
            async move {
                match saving.await {
                    Ok(saved) => {
                        let list = providers.list().await;
                        let probe = match &list {
                            Ok(items) => probe_provider(kernel, items, &saved.id).await,
                            Err(_) => None,
                        };
                        Done::Service(ServiceDone::ProviderSaved { saved, list, probe })
                    }
                    Err(reason) => Done::Service(ServiceDone::ProviderFailed(reason)),
                }
            }
            .boxed(),
        );
    }

    /// 详情页确认删除。
    pub(super) fn provider_remove(&mut self, id: String, name: String) {
        let Some(providers) = self.options.services.providers.clone() else {
            self.app.error(i18n_provider::unavailable(self.app.lang));
            return;
        };
        let removing = providers.remove(id);
        self.pending.push(
            async move {
                match removing.await {
                    Ok(path) => {
                        let list = providers.list().await;
                        Done::Service(ServiceDone::ProviderRemoved { name, path, list })
                    }
                    Err(reason) => Done::Service(ServiceDone::ProviderFailed(reason)),
                }
            }
            .boxed(),
        );
    }

    pub(super) fn on_service(&mut self, done: ServiceDone) {
        let lang = self.app.lang;
        match done {
            ServiceDone::LoginUrl { family, authorize } => {
                if let Some(authorize) = authorize {
                    self.app
                        .info(i18n::login_open_url(lang, family, &authorize.url));
                }
            }
            ServiceDone::DeviceCode { code } => {
                if let Some(code) = code {
                    self.app.login_device_code(&code);
                }
            }
            ServiceDone::Nibi(result) => {
                self.services.login = None;
                match result {
                    Ok(account) => {
                        self.app.login_closed();
                        self.app.info(i18n::nibi_signed_in(lang, &account));
                    }
                    Err(LoginFailure::Cancelled) => {
                        let status = self.app.strings.login_cancelled;
                        self.app.login_back(status);
                    }
                    Err(LoginFailure::Failed(reason)) => {
                        self.app.login_closed();
                        self.app.error(reason);
                    }
                }
            }
            ServiceDone::Login(result) => {
                self.services.login = None;
                match result {
                    Ok(configured) => self.configured(Ok(configured)),
                    Err(LoginFailure::Cancelled) => {
                        let status = self.app.strings.login_cancelled;
                        self.app.login_back(status);
                    }
                    Err(LoginFailure::Failed(reason)) => self.configured(Err(reason)),
                }
            }
            ServiceDone::ApiKey(result) => self.configured(result),
            // 独立页面（L30 起不再插进 transcript，tui-panels.md §4.1）。
            ServiceDone::Context { usage, all } => match *usage {
                Ok(usage) => {
                    self.app.overlay = Some(crate::ui::app::Overlay::Page {
                        local: Local::Context {
                            usage: Box::new(usage),
                            all,
                        },
                        scroll: 0,
                    });
                }
                Err(error) => self.app.error(i18n::rejected(lang, &error.to_string())),
            },
            ServiceDone::Logout(result) => match result {
                Ok(path) => self.app.info(i18n::logged_out(lang, &path)),
                Err(reason) => self.app.error(reason),
            },
            ServiceDone::Providers { intent, result } => {
                // `/provider use <id>`：与 `/model` 选模型同一条路（切当前会话并写成默认）。
                if let Some(selection) = self.app.provider_loaded(intent, result) {
                    self.choose_model(selection, None);
                }
            }
            ServiceDone::ComposerText(result) => match result {
                Ok(text) if !text.is_empty() => self.app.paste_plain(&text),
                Ok(_) => self.app.notify(
                    i18n_input::no_image(lang, crate::ui::shortcuts::image_paste_chord()),
                    crate::ui::notice::HINT_FOR,
                ),
                Err(reason) => self.app.notify(
                    i18n_input::clipboard_failed(lang, &reason),
                    crate::ui::notice::HINT_FOR,
                ),
            },
            ServiceDone::ProviderClipboard(result) => match result {
                Ok(text) => self.app.provider_paste(&text),
                Err(reason) => self
                    .app
                    .info(i18n_provider::clipboard_failed(lang, &reason)),
            },
            ServiceDone::Btw(result) => match result {
                Ok(answer) => {
                    self.app.overlay = Some(crate::ui::app::Overlay::Page {
                        local: Local::Text {
                            title: i18n::btw_title(lang).to_owned(),
                            body: answer,
                        },
                        scroll: 0,
                    });
                }
                Err(error) => self.app.error(i18n::rejected(lang, &error.to_string())),
            },
            ServiceDone::ProviderPresets(result) => self.app.provider_presets(result),
            ServiceDone::ProviderSaved { saved, list, probe } => {
                match &probe {
                    Some(Ok(())) => self
                        .app
                        .info(i18n_provider::probe_ok(self.app.lang, &saved.name)),
                    Some(Err(reason)) => {
                        // key/端点被对端拒绝：保存本身没错，但要说清楚「存下来了，用不了」。
                        self.app.error(i18n_provider::probe_failed(
                            self.app.lang,
                            &saved.name,
                            reason,
                        ));
                    }
                    None => {}
                }
                self.app.provider_saved(saved, list);
            }
            ServiceDone::ProviderFailed(reason) => self.app.provider_failed(reason),
            ServiceDone::ProviderRemoved { name, path, list } => {
                self.app.provider_removed(&name, path, list);
            }
            ServiceDone::Locale { locale, result } => {
                self.services.locale_writing = false;
                match result {
                    Ok(path) => {
                        let lang = i18n::resolve(Some(locale.as_str()), &self.options.vars);
                        self.app.set_lang(lang);
                        self.app.info(i18n::locale_switched(
                            lang,
                            locale.as_str(),
                            lang.code(),
                            &path,
                        ));
                    }
                    Err(reason) => self.app.error(i18n::locale_failed(self.app.lang, &reason)),
                }
                if let Some(next) = self.services.locale_next.take() {
                    self.save_locale(next);
                }
            }
        }
    }
}

/// 新保存的 Provider 用它的第一个模型发 1 个 token：key、端点与协议对不上时当场给出原因。
async fn probe_provider(
    kernel: std::sync::Arc<dyn nibi_kernel_api::session_api::Kernel>,
    items: &[ProviderInfo],
    id: &str,
) -> Option<Result<(), String>> {
    use nibi_kernel_api::generate_text::GenerateTextRequest;
    use nibi_kernel_api::message::ContentBlock;
    use nibi_kernel_api::model::{
        ApiContent, ApiMessage, ApiRole, ModelSelection, QuerySource, SystemBlock,
    };
    let info = items.iter().find(|item| item.id == id)?;
    let model = info.models.first()?.clone();
    let reasoning = info.default_reasoning.clone()?;
    let request = GenerateTextRequest {
        selection: ModelSelection {
            provider: info.id.clone(),
            model,
            reasoning: Some(reasoning),
            connection: None,
        },
        system: vec![SystemBlock {
            text: "You are NIBI connectivity probe.".to_owned(),
            cache_control: None,
        }],
        messages: vec![ApiMessage {
            role: ApiRole::User,
            content: vec![ApiContent {
                block: ContentBlock::Text {
                    text: "hi".to_owned(),
                },
                cache_control: None,
            }],
            output_config: None,
        }],
        tools: Vec::new(),
        tool_choice: None,
        max_tokens: Some(1),
        source: QuerySource::Side("provider_settings_connectivity".to_owned()),
    };
    Some(
        kernel
            .generate_text(request, CancellationToken::new())
            .await
            .map(|_| ())
            .map_err(|error| error.to_string()),
    )
}

//! 入口注入的服务（依赖注入，docs/specs/rust-cli/tui.md §7.1、§7.2）：TUI 不读写文件、不起进程，界面语言的
//! 持久化与账号的登录、退出由入口经 platform 实现；测试用替身。
use std::sync::Arc;

use futures_util::future::BoxFuture;
pub use nibi_kernel_base::secret::RedactedString;
pub use nibi_kernel_platform::{Family, UiLocale, UiTheme};
use tokio::sync::oneshot;
pub use tokio_util::sync::CancellationToken;

/// 界面语言的持久化：写回 Node 共用的用户级配置文件 `ui.locale`。成功时给出文件路径，失败时给出原因。
pub trait LocaleStore: Send + Sync {
    fn save(&self, locale: UiLocale) -> BoxFuture<'static, Result<String, String>>;
}

/// 界面偏好的持久化（docs/specs/rust-cli/tui-manage.md §2）：主题写 Node 配置的 `ui.theme`，`/effort` 把当前
/// 模型与档位写成新会话的缺省（个人配置的 `defaultModelSelection`）。成功时给出文件路径，失败时给出原因。
pub trait Preferences: Send + Sync {
    fn save_theme(&self, theme: UiTheme) -> BoxFuture<'static, Result<String, String>>;
    fn save_default_model(
        &self,
        selection: nibi_kernel_api::model::ModelSelection,
    ) -> BoxFuture<'static, Result<String, String>>;

    /// `/mcp enable/disable`（tui-manage.md §6.1）：把 `enabled` 写进定义这个服务器的配置文件。`Ok(None)`：它不在
    /// 配置文件里（`--mcp-config`、插件），只改本次运行。
    fn save_mcp_enabled(
        &self,
        _server: String,
        _enabled: bool,
    ) -> BoxFuture<'static, Result<Option<String>, String>> {
        Box::pin(async { Ok(None) })
    }
}

/// 浏览器授权的地址（`begin_login` 之后、轮询之前交给界面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorize {
    pub url: String,
    /// 打开浏览器失败的原因（Node 在结果末尾提示 `Browser open failed`）。
    pub browser_failed: Option<String>,
}

/// 登录或手工 key 配置成功。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Configured {
    pub family: Family,
    /// 浏览器登录的用户名（`name`、`email`、`user_id` 中第一个非空的）；手工 key 没有。
    pub user: Option<String>,
    /// `<provider>/<model>`：登录写进个人配置的默认模型。
    pub model: String,
    /// 凭据文件（浏览器登录时显示）。
    pub credentials: Option<String>,
    /// 个人配置文件。
    pub config: String,
    pub browser_failed: Option<String>,
    /// 经浏览器授权（否则是手工 key）。
    pub oauth: bool,
}

/// 登录失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginFailure {
    /// 用户取消（esc），没有写任何文件。
    Cancelled,
    /// 其他失败：原因原样显示。
    Failed(String),
}

/// NIBI 账号的设备码（RFC 8628）：界面显示 `user_code`，浏览器打开 `verification_uri_complete`
/// （没有时开 `verification_uri` 并让用户自己输入 code）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
}

impl DeviceCode {
    /// 浏览器要打开的地址。
    pub fn target(&self) -> &str {
        self.verification_uri_complete
            .as_deref()
            .unwrap_or(&self.verification_uri)
    }
}

/// NIBI 账号登录的结果：用户的显示名与会员摘要（收费插件门禁读的就是这份凭据）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NibiAccount {
    pub user: String,
    pub membership: String,
    /// 会员同步失败的原因（网络、代理、服务端拒绝）：登录照样成功，但要告诉用户为什么是「未知」。
    pub warning: Option<String>,
}

/// 账号的登录与退出（platform.md §5.6）。取消是一条消息：`cancel` 被取消后，实现在下一次检查时停下并返回
/// [`LoginFailure::Cancelled`]，调用方不丢弃 future。
pub trait Account: Send + Sync {
    /// 浏览器授权：拿到地址后经 `authorize` 交给界面（打开浏览器由实现负责），再轮询到结果。
    fn login(
        &self,
        family: Family,
        authorize: oneshot::Sender<Authorize>,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Configured, LoginFailure>>;

    /// 手工 key（platform 不验证 key）。
    fn configure_api_key(
        &self,
        family: Family,
        key: RedactedString,
    ) -> BoxFuture<'static, Result<Configured, String>>;

    /// NIBI 账号的 Device Flow：拿到设备码后经 `device` 交给界面（打开浏览器由实现负责），再轮询到结果。
    fn login_nibi(
        &self,
        device: oneshot::Sender<DeviceCode>,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<NibiAccount, LoginFailure>>;

    /// 退出账号（NIBI 账号与 provider 模板的凭据），返回凭据文件的路径。
    fn logout(&self) -> BoxFuture<'static, Result<String, String>>;
}

/// 一个模型 Provider 的概览（`/provider`）：与 `nibi_kernel_platform::ProviderSummary` 同形，TUI 不依赖
/// platform 的配置解析。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: Option<nibi_kernel_api::provider::WireProtocol>,
    pub models: Vec<String>,
    pub has_key: bool,
    /// 官方账号 Provider：不能填 key、不能改端点。
    pub account: bool,
    /// 个人配置里的规则：只有这些能改模型清单与删除。
    pub personal: bool,
    pub enabled: bool,
    /// 继承的内置模板（预设）。
    pub template: Option<String>,
}

/// 新建 Provider 的预设（内置模板）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderPreset {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: nibi_kernel_api::provider::WireProtocol,
    pub models: Vec<String>,
}

/// 新建或修改一个 Provider（`/provider add`、`/provider edit`）。
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderDraft {
    /// 已有 Provider 的 id；`None` 是新建。
    pub provider: Option<String>,
    pub name: String,
    pub base_url: String,
    pub protocol: nibi_kernel_api::provider::WireProtocol,
    pub models: Vec<String>,
    /// `None`：保留已有的 key。
    pub api_key: Option<RedactedString>,
    pub template: Option<String>,
    pub enabled: bool,
}

/// 保存成功：id、显示名与配置文件（提示里给出）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedProvider {
    pub id: String,
    pub name: String,
    pub config: String,
}

/// Provider 配置的读写（platform.md §3）：TUI 不读文件、不解析配置，列表、预设、保存与删除都由入口实现；
/// 测试用替身。没有时 `/provider` 提示不可用。
pub trait Providers: Send + Sync {
    fn list(&self) -> BoxFuture<'static, Result<Vec<ProviderInfo>, String>>;
    fn presets(&self) -> BoxFuture<'static, Result<Vec<ProviderPreset>, String>>;
    fn save(&self, draft: ProviderDraft) -> BoxFuture<'static, Result<SavedProvider, String>>;
    /// 删掉一个个人 Provider，成功时是配置文件路径。
    fn remove(&self, id: String) -> BoxFuture<'static, Result<String, String>>;
}

/// 读到的图片：原始字节（TUI 判断格式并编码，tui-input.md §3.1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageBytes {
    pub bytes: Vec<u8>,
}

/// 复制到了哪里（docs/specs/rust-cli/tui-select.md §3.2）：决定复制后的提示文字。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyRoute {
    /// 系统剪贴板命令（pbcopy、wl-copy / xclip / xsel、PowerShell）。
    Native,
    /// tmux 的缓冲区（SSH 里或本机没有剪贴板命令时）。
    TmuxBuffer,
    /// 只有终端的 OSC 52（无法确认）。
    Osc52,
}

/// 剪贴板与拖进来的图片文件（tui-input.md §3.1）：读写系统剪贴板要起进程（macOS `osascript` / `pbcopy`、Linux
/// `wl-paste` / `xclip` 等、Windows PowerShell），读本机文件要做 IO，都由入口实现；测试用替身。没有图片时是 `Ok(None)`。
pub trait Clipboard: Send + Sync {
    fn image(&self) -> BoxFuture<'static, Result<Option<ImageBytes>, String>>;

    /// 粘贴的文字是一个图片文件的路径（拖文件进终端）时读出它；不是文件或读不出时 `Ok(None)`。
    fn image_file(&self, path: String) -> BoxFuture<'static, Result<Option<ImageBytes>, String>>;

    /// 复制文字（F25，tui-select.md §3.2，起进程的部分）：不在 SSH 里时写系统剪贴板，在 tmux 里
    /// 另写 tmux 的缓冲区；OSC 52 由 TUI 自己写到终端。返回复制的途径。缺省（没有系统剪贴板）只有 OSC 52。
    fn copy_text(&self, _text: String) -> BoxFuture<'static, CopyRoute> {
        Box::pin(async { CopyRoute::Osc52 })
    }
}

/// 外部编辑器（tui-input.md §4）：写读临时文件、起编辑器进程都由入口做。调用时 TUI 已交出终端，编辑器继承
/// 终端；返回后 TUI 收回终端。失败的原因原样显示（`<名字> exited with code N`）。
pub trait Editor: Send + Sync {
    /// 编辑一段文字，返回编辑后的全文。
    fn edit(&self, text: String) -> BoxFuture<'static, Result<String, String>>;

    /// 打开一个文件（不存在时先建空文件，`/memory`），等编辑器结束。
    fn open(&self, path: String) -> BoxFuture<'static, Result<(), String>>;

    /// 编辑器来自哪个环境变量与它的值（`/memory` 的提示）：`("$VISUAL", "code")`；用缺省编辑器时 None。
    fn source(&self) -> Option<(String, String)>;
}

/// `/memory` 列出的一个规则或记忆文件（tui-input.md §4.2）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryFile {
    /// 列表里的名字（原文，例如 `User memory`）。
    pub label: String,
    /// 显示用的路径（家目录写成 `~`）。
    pub display: String,
    /// 交给编辑器的路径。
    pub path: String,
}

/// 工作区信任（修复线 F29，docs/specs/rust-cli/workspace-trust.md §2.8）：切到别的项目之前判定那个目录。判定与写记录在
/// 入口（与启动时同一段代码），界面只画对话框。
pub trait WorkspaceTrust: Send + Sync {
    /// 已信任（直接或经父目录）时为 None；否则是要问的内容（不带项目授权的后备询问）。
    fn check(
        &self,
        workspace: nibi_kernel_api::env::WorkspaceRef,
    ) -> BoxFuture<'static, Option<crate::trust::TrustPrompt>>;
    /// 用户同意：写项目键的记录（home 只本进程有效）；写失败只记日志。
    fn accept(&self, workspace: nibi_kernel_api::env::WorkspaceRef) -> BoxFuture<'static, ()>;
}

/// 入口给 TUI 的服务与配置值。
#[derive(Clone, Default)]
pub struct Services {
    /// 配置文件的 `ui.locale`（启动时读一次）；没有时按系统语言。
    pub locale: Option<UiLocale>,
    /// 没有时 `/locale <值>` 提示不能切换。
    pub locale_store: Option<Arc<dyn LocaleStore>>,
    /// 没有时 `/login`、`/logout` 提示不可用。
    pub account: Option<Arc<dyn Account>>,
    /// 没有时粘贴图片提示不可用（tui-input.md §3.1）。
    pub clipboard: Option<Arc<dyn Clipboard>>,
    /// 没有时 ctrl+g 与 `/memory` 提示不可用（tui-input.md §4）。
    pub editor: Option<Arc<dyn Editor>>,
    /// `/memory` 的文件（入口按规则文件的位置给出）。
    pub memory_files: Vec<MemoryFile>,
    /// 配置文件的 `ui.theme`（启动时读一次）；没有时按终端背景（tui-manage.md §2.1）。
    pub theme: Option<UiTheme>,
    /// 没有时 `/theme`、`/effort` 只对本次运行有效。
    pub preferences: Option<Arc<dyn Preferences>>,
    /// 没有时切到别的项目不做信任检查（测试）。
    pub trust: Option<Arc<dyn WorkspaceTrust>>,
    /// npm 上有更新的版本时，会话头下面插的提示（docs/specs/rust-cli/update.md §7，F48）。
    pub update: Option<crate::update::UpdateInfo>,
    /// 提问框的空闲超时（配置的 `askUserQuestionTimeout` 与 `NIBI_AFK_*`，tools-more.md §1.1，工作线 F72）；
    /// 没有时不计时。
    pub question_timeout: Option<crate::ui::afk::QuestionTimeout>,
    /// 远端机器（remote-exec.md §21.2）：`/machines` 与机器状态行；没有时 `/machines` 提示不可用、状态行不出现。
    pub machines: Option<Arc<dyn crate::machines::Machines>>,
    /// 模型 Provider 的列表与配置（`/provider`）：没有时提示不可用。
    pub providers: Option<Arc<dyn Providers>>,
    /// 绑定到远端机器的 MCP 服务器（服务器名，机器名；R5，remote-exec.md §22.8）：MCP 工具行标出机器。入口从同一份
    /// MCP 设置给出（启动时定了，之后不变）。
    pub mcp_machines: Vec<(String, String)>,
}

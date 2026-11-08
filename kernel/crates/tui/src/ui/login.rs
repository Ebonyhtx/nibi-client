//! `/login` 与 `/logout`（docs/specs/rust-cli/tui.md §7.2）：登录视图的状态、按键与排版。视图只显示；登录是否在途、
//! 结果如何由 runner 收到 `Done` 后改这里的状态。
//!
//! 分家后只认 NIBI 账号（Device Flow）：上游 Z.AI / BigModel 的 Coding Plan 登录入口已从这张表里删掉，它们的
//! 定位是普通第三方 API key，走 `/provider` 配置。这里不会再出现套餐账号或 provider 模板的登录。
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::app::{Action, App, Overlay};
use super::i18n::{self, Strings};
use crate::services::DeviceCode;

/// 一次按键之后要做的事。
enum Next {
    Stay,
    Close,
    Start,
    Act(Action),
}

/// 登录视图。
#[derive(Debug, Clone, PartialEq)]
pub enum LoginView {
    /// 确认用 NIBI 账号登录；`status` 是上一步留下的提示（取消等）。
    Choose { status: Option<&'static str> },
    /// 等 NIBI 账号的设备码授权；`code` 在设备码到了之后填上（界面显示 code）。
    WaitingNibi {
        code: Option<DeviceCode>,
        cancelling: bool,
    },
}

impl App {
    /// `/login [nibi]`（tui.md §7.2 的命令表）。
    pub(super) fn login_command(&mut self, args: &str) -> Option<Action> {
        match args.trim() {
            "" => {
                self.overlay = Some(Overlay::Login(LoginView::Choose { status: None }));
                None
            }
            "nibi" | "nibi-account" => self.start_nibi_login(),
            _ => {
                self.info(i18n::login_usage(self.lang));
                None
            }
        }
    }

    /// `/logout`：带参数时提示用法。
    pub(super) fn logout_command(&mut self, args: &str) -> Option<Action> {
        if args.trim().is_empty() {
            return Some(Action::Logout);
        }
        self.info(i18n::logout_usage(self.lang));
        None
    }

    /// 设备码到了：填进登录视图（用户可能已经关掉视图，这时什么都不做）。
    pub fn login_device_code(&mut self, code: &DeviceCode) {
        if let Some(Overlay::Login(LoginView::WaitingNibi {
            code: slot,
            cancelling,
        })) = self.overlay.as_mut()
            && !*cancelling
        {
            *slot = Some(code.clone());
        }
    }

    fn start_nibi_login(&mut self) -> Option<Action> {
        self.overlay = Some(Overlay::Login(LoginView::WaitingNibi {
            code: None,
            cancelling: false,
        }));
        Some(Action::LoginNibi)
    }

    /// 回到确认（取消之后），带上提示。
    pub fn login_back(&mut self, status: &'static str) {
        self.overlay = Some(Overlay::Login(LoginView::Choose {
            status: Some(status),
        }));
    }

    /// 登录结束：关闭登录视图（用户可能已经关掉或换了别的视图，这时什么都不做）。
    pub fn login_closed(&mut self) {
        if matches!(self.overlay, Some(Overlay::Login(_))) {
            self.overlay = None;
        }
    }

    /// 登录视图的按键；只在视图是登录视图时调用。
    pub(super) fn login_key(&mut self, key: KeyEvent) -> Option<Action> {
        let ctrl = self.typing.ctrl(&key);
        let next = {
            let Some(Overlay::Login(view)) = self.overlay.as_mut() else {
                return None;
            };
            match view {
                LoginView::Choose { status } => match key.code {
                    KeyCode::Enter => Next::Start,
                    KeyCode::Esc => Next::Close,
                    KeyCode::Char('c') if ctrl => Next::Close,
                    _ => {
                        *status = None;
                        Next::Stay
                    }
                },
                // 等授权：esc / ctrl+c 发取消（一条消息）；结果回来之前视图不变。
                LoginView::WaitingNibi { cancelling, .. } => {
                    let cancel =
                        key.code == KeyCode::Esc || (ctrl && key.code == KeyCode::Char('c'));
                    if cancel && !*cancelling {
                        *cancelling = true;
                        Next::Act(Action::CancelLogin)
                    } else {
                        Next::Stay
                    }
                }
            }
        };
        match next {
            Next::Stay => None,
            Next::Close => {
                self.overlay = None;
                None
            }
            Next::Start => self.start_nibi_login(),
            Next::Act(action) => Some(action),
        }
    }

    /// 登录视图里的粘贴：没有输入框可填，忽略。
    pub(super) fn login_paste(&mut self, _text: &str) {}
}

fn dim(text: impl Into<String>) -> Line<'static> {
    Line::from(Span::styled(
        format!("  {}", text.into()),
        Style::default().add_modifier(Modifier::DIM),
    ))
}

fn title(text: &str) -> Line<'static> {
    Line::from(Span::styled(
        format!("  {text}"),
        Style::default().add_modifier(Modifier::BOLD),
    ))
}

/// 登录视图的行（替换输入区，tui.md §7.2）。
pub fn lines(
    view: &LoginView,
    strings: &Strings,
    palette: &super::palette::Palette,
    width: usize,
) -> Vec<Line<'static>> {
    let accent = palette.accent;
    let keys = |template: &str| super::key_hint::line(2, template, palette);
    let rule = Line::from(Span::styled("─".repeat(width), Style::default().fg(accent)));
    let mut lines = vec![rule];
    match view {
        LoginView::Choose { status } => {
            lines.push(title(strings.login_title));
            lines.push(dim(strings.login_prompt));
            lines.push(Line::default());
            // 只有一个方式：NIBI 账号。选中样式与别的选择列表一致（`› ` 加底色条，tui.md §7.4）。
            lines.push(super::pick::paint(
                Line::from(vec![
                    Span::raw("  "),
                    super::pick::pointer(true),
                    Span::raw(strings.login_nibi.to_owned()),
                ]),
                true,
                palette,
                width,
            ));
            lines.push(super::pick::paint(
                Line::from(Span::styled(
                    format!("    {}", strings.login_nibi_detail),
                    palette.secondary(),
                )),
                true,
                palette,
                width,
            ));
            lines.push(Line::default());
            if let Some(status) = status {
                lines.push(dim(*status));
            }
            lines.push(keys(strings.login_help));
        }
        LoginView::WaitingNibi { code, cancelling } => {
            lines.push(title(strings.login_wait_nibi));
            lines.push(dim(strings.login_wait_nibi_detail));
            lines.push(Line::default());
            match code {
                Some(code) => {
                    lines.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(
                            code.user_code.clone(),
                            Style::default().fg(accent).add_modifier(Modifier::BOLD),
                        ),
                    ]));
                    lines.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(code.target().to_owned(), palette.secondary()),
                    ]));
                }
                None => lines.push(dim(strings.login_wait_status)),
            }
            lines.push(Line::default());
            // 取消中显示原文；否则按键提示要经 `key_hint` 渲染（`{Esc}` 不能原样显示）。
            lines.push(if *cancelling {
                dim(strings.login_cancelling)
            } else {
                keys(strings.login_wait_help)
            });
        }
    }
    lines
}

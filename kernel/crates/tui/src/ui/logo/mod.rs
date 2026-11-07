//! 新会话的背景徽章（docs/specs/rust-cli/tui.md §7.3）：NIBI 鸟的像素画（移植 Node TUI 的
//! `apps/zcode-cli/packages/tui/src/brand-pixel-logo.ts`，深色 / 浅色各一套）。
//!
//! 平时淡色挂在空白处；点击时亮起，两秒内淡回。画是半格字符（`▀▄█`）与品牌色，尺寸固定 26×10。

mod art;

use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;

use super::palette::{Palette, Rgb, blend};

/// 一次点击的时长（秒）：`RISE` 内亮起，`FADE_FROM` 起淡回，`DURATION` 停住。
pub const DURATION: f64 = 2.0;
const RISE: f64 = 0.12;
const FADE_FROM: f64 = 1.4;
/// 平时的不透明度。
pub const STATIC_OPACITY: f64 = 0.22;
/// 查不到终端背景色时按这个深色背景混合。
const DARK: Rgb = (0x1e, 0x1e, 0x21);

fn smooth(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// 点击后 `t` 秒的不透明度。
pub fn opacity_at(t: f64) -> f64 {
    if t < RISE {
        STATIC_OPACITY + (1.0 - STATIC_OPACITY) * smooth(t / RISE)
    } else if t < FADE_FROM {
        1.0
    } else if t >= DURATION {
        STATIC_OPACITY
    } else {
        1.0 + (STATIC_OPACITY - 1.0) * smooth((t - FADE_FROM) / (DURATION - FADE_FROM))
    }
}

/// 空白处里徽章的位置：居中；放不下时为 None。
pub fn stage_in(free: Rect) -> Option<Rect> {
    (free.width >= art::WIDTH && free.height >= art::HEIGHT).then(|| {
        Rect::new(
            free.x + (free.width - art::WIDTH) / 2,
            free.y + (free.height - art::HEIGHT) / 2,
            art::WIDTH,
            art::HEIGHT,
        )
    })
}

#[derive(Debug, Default)]
pub struct Logo {
    /// 最近一次点击的时刻。
    pressed: Option<Instant>,
    /// 这一帧画在哪里（点击的目标）；没画时为 None。
    pub stage: Option<Rect>,
}

impl Logo {
    /// 需要定时重绘：正在画，并且点击的效果还没结束。
    pub fn animating(&self, now: Instant) -> bool {
        self.stage.is_some()
            && self
                .pressed
                .is_some_and(|at| now.duration_since(at).as_secs_f64() < DURATION)
    }

    /// 在 `(column, row)` 按下：点在徽章上时重新开始一次亮起（没画时不算）。
    pub fn press(&mut self, column: u16, row: u16, now: Instant) {
        if let Some(stage) = self.stage
            && stage.contains(ratatui::layout::Position::new(column, row))
        {
            self.pressed = Some(now);
        }
    }

    /// 这一帧不画：正在进行的亮起结束。
    pub fn hide(&mut self) {
        self.stage = None;
        self.pressed = None;
    }

    pub fn draw(&mut self, buffer: &mut Buffer, free: Rect, palette: &Palette, now: Instant) {
        let Some(stage) = stage_in(free.intersection(buffer.area)) else {
            self.hide();
            return;
        };
        self.stage = Some(stage);
        let opacity = match self.pressed {
            Some(at) if now.duration_since(at).as_secs_f64() < DURATION => {
                opacity_at(now.duration_since(at).as_secs_f64())
            }
            _ => {
                self.pressed = None;
                STATIC_OPACITY
            }
        };
        let background = palette.background.unwrap_or(DARK);
        for (row, runs) in art::rows(palette.light, false).iter().enumerate() {
            let y = stage.y + row as u16;
            let mut x = stage.x;
            for run in *runs {
                for character in run.text.chars() {
                    if x >= stage.right() {
                        break;
                    }
                    let target = &mut buffer[(x, y)];
                    target.set_char(character);
                    if let Some(fg) = run.fg {
                        match palette.tint(blend(background, art::rgb(fg), opacity)) {
                            Some(color) => {
                                target.set_fg(color);
                            }
                            // 16 色终端不上色：淡的时候用 dim。
                            None if opacity < 0.5 => target.modifier.insert(Modifier::DIM),
                            None => {}
                        }
                    }
                    if let Some(bg) = run.bg
                        && let Some(color) = palette.tint(blend(background, art::rgb(bg), opacity))
                    {
                        target.set_bg(color);
                    }
                    x += 1;
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "logo_tests.rs"]
mod tests;

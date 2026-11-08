//! 顶部固定栏右端的小鸟：品牌素材 `nibi-pixel-pet` 的 64×64 帧，经 Sixel 直接贴进终端。
//!
//! 终端支持像素图（Windows Terminal 1.22+，或 `NIBI_TUI_SIXEL=1`）时按 2× 整数放大成 128×128 像素，
//! 贴在栏的右端；**不支持时这只鸟整只不画**——栏里仍有字标与身份行，不再放一个手绘的字符鸟凑数。
//!
//! 默认只贴一张静态图：终端的 Sixel 解码在它自己的 UI 线程上，逐帧重贴会拖慢整个终端（连输入法都迟）。
//! `NIBI_TUI_PET_ANIM=1` 才播待机动画。

mod scene;
mod sixel;

use std::time::Instant;

use ratatui::layout::Rect;

use super::palette::{Palette, Rgb};

/// 与栏的右边缘留的空隙（字符格）。
const MARGIN: u16 = 1;

/// 像素图的整数放大倍数：64×64 放 2 倍是 128×128 像素。
const SCALE: u16 = 2;
/// 像素图占的字符格：按常见 9×18 像素一格估算，并多留一列防止字宽不同时压到正文。
pub(crate) const PIXEL_COLS: u16 = 16;
/// 像素图占的行数（栏里除去分隔线那行）：128 像素按常见的 18 像素一行约七行，留八行。
pub(crate) const PIXEL_ROWS: u16 = 8;

/// 查不到终端背景色时按这个深色背景填（与 `Palette` 的缺省一致）。
const DARK: Rgb = (0x1e, 0x1e, 0x21);

/// 交给终端写出去的一张像素图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    /// 光标要移到的格子（0 基）。
    pub at: (u16, u16),
    pub payload: Payload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Payload {
    /// Sixel 的 DCS 整串。
    Sixel(String),
    /// 用空格盖掉原来那张图。
    Clear { cols: u16, rows: u16 },
}

#[derive(Debug, Default)]
pub struct Logo {
    /// 这一帧画在哪里（点击的目标）；没画时为 None。
    pub stage: Option<Rect>,
    /// 这一轮待机动画从哪一刻开始（重新出现或点一下时从头播）。
    started: Option<Instant>,
    /// 终端支持 Sixel：贴真实的素材帧。
    pixels: bool,
    /// 播待机动画（默认关：终端每秒重解码四次会卡）。
    anim: bool,
    /// 上一次发出去的像素图（位置与帧号），没变就不重发。
    sent: Option<(Rect, usize)>,
    /// 这一帧之后终端要写出去的东西。
    pending: Option<Image>,
}

impl Logo {
    /// 入口说明终端支持 Sixel（`Windows Terminal 1.22+` 或显式开关）。
    pub fn set_pixels(&mut self, pixels: bool) {
        self.pixels = pixels;
    }

    /// 终端能不能显示像素图。
    pub fn pixels(&self) -> bool {
        self.pixels
    }

    /// 要不要播待机动画（`NIBI_TUI_PET_ANIM=1`）：默认关，只贴一张静态图。
    pub fn set_anim(&mut self, anim: bool) {
        self.anim = anim;
    }

    /// 终端这一帧之后要写出去的像素图（没有时为 None）。
    pub fn take_image(&mut self) -> Option<Image> {
        self.pending.take()
    }

    /// 点在小鸟身上：这一轮从头播（像被戳了一下）；点在外面不算。
    pub fn press(&mut self, column: u16, row: u16, now: Instant) {
        if let Some(stage) = self.stage
            && stage.contains(ratatui::layout::Position::new(column, row))
        {
            self.started = Some(now);
        }
    }

    /// 这一帧不画；上一次画过像素图的话，让终端用空格盖掉。
    pub fn hide(&mut self) {
        if let Some(stage) = self.stage.take()
            && self.sent.take().is_some()
        {
            self.pending = Some(Image {
                at: (stage.x, stage.y),
                payload: Payload::Clear {
                    cols: PIXEL_COLS,
                    rows: PIXEL_ROWS,
                },
            });
        }
        self.started = None;
    }

    /// `band` 是顶部固定栏：小鸟贴在它的右端。
    pub fn draw(&mut self, band: Rect, palette: &Palette, now: Instant) {
        if !self.pixels || band.width < PIXEL_COLS + MARGIN {
            self.hide();
            return;
        }
        let stage = Rect::new(
            band.right() - PIXEL_COLS - MARGIN,
            band.top(),
            PIXEL_COLS,
            PIXEL_ROWS,
        );
        self.stage = Some(stage);
        let started = *self.started.get_or_insert(now);
        let elapsed = now.saturating_duration_since(started).as_millis() as u64;
        let index = if self.anim { scene_frame_at(elapsed) } else { 0 };
        if self.sent == Some((stage, index)) {
            return;
        }
        self.sent = Some((stage, index));
        // 透明像素填成终端背景色：Sixel 里不落墨的格子由终端自己填，会和背景差一点，屏幕上就是一块方框。
        let background = palette.background.unwrap_or(DARK);
        self.pending = Some(Image {
            at: (stage.x, stage.y),
            payload: Payload::Sixel(sixel::encode(&scene::FRAMES[index], SCALE, background)),
        });
    }

    /// 下一帧动画该在什么时候画（没有像素图、没开动画、或者还没开始画时为 None）。
    pub fn next_frame(&self, now: Instant) -> Option<Instant> {
        if !self.pixels || !self.anim {
            return None;
        }
        let started = self.started?;
        self.stage?;
        let elapsed = now.saturating_duration_since(started).as_millis() as u64;
        let total: u64 = scene::FRAMES.iter().map(|frame| frame.ms).sum();
        let at = elapsed % total.max(1);
        let mut boundary = 0u64;
        for frame in scene::FRAMES {
            boundary += frame.ms;
            if at < boundary {
                let wait = (boundary - at).max(40);
                return Some(now + std::time::Duration::from_millis(wait));
            }
        }
        None
    }
}

/// 从开始到 `elapsed_ms` 该显示素材里的哪一帧（下标）。
fn scene_frame_at(elapsed_ms: u64) -> usize {
    let total: u64 = scene::FRAMES.iter().map(|frame| frame.ms).sum();
    let mut at = elapsed_ms % total.max(1);
    for (index, frame) in scene::FRAMES.iter().enumerate() {
        if at < frame.ms {
            return index;
        }
        at -= frame.ms;
    }
    scene::FRAMES.len() - 1
}

#[cfg(test)]
#[path = "logo_tests.rs"]
mod tests;

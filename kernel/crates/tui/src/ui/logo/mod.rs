//! 空白处右下角的 NIBI 像素小鸟（品牌素材 `nibi-pixel-pet` 的待机动画）。
//!
//! 终端没有图像协议，按两像素一个字符格（`▀▄█`）渲染。素材是 64×64 原生帧，这里 2:1 整数缩小到
//! 19×22 像素——也就是 19 列 × 11 行，整只鸟（头顶到脚）都在，做常驻角落的小挂件；不做非整数缩放。
//!
//! 位置在正文下方空白区的右下角，**不压正文**：空白放不下时整只不画（长对话滚到底部时不占地方）。
//! 用不透明品牌色，不再像以前那样淡淡地当背景水印。待机动画自己在动，所以画着的时候界面按动画节拍重画。

mod pack;
mod scene;
mod sixel;

use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

use super::palette::{Palette, Rgb};

/// 与右下角留的空隙（字符格）。
const MARGIN: u16 = 1;

/// 像素图（Sixel）的整数放大倍数：64×64 放 2 倍是 128×128 像素，约 15 列 × 8 行。
const SCALE: u16 = 2;
/// 像素图占的字符格：按常见 9×18 像素一格估算，并多留一列一行防止字宽不同时压到正文。
pub(crate) const PIXEL_COLS: u16 = 16;
pub(crate) const PIXEL_ROWS: u16 = 9;

/// 顶部固定栏的高度（字符行）：支持像素图时把身份那两行所在的区域加高到能放下小鸟，否则不加高。
pub fn masthead_rows(pixels: bool) -> u16 {
    if pixels { PIXEL_ROWS } else { 0 }
}
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

/// 挂件的位置：`free` 的右下角；放不下时为 None。
pub fn stage_in(free: Rect) -> Option<Rect> {
    let width = pack::WIDTH;
    let height = pack::HEIGHT / 2;
    (free.width >= width + MARGIN && free.height >= height).then(|| {
        Rect::new(
            free.right() - width - MARGIN,
            free.bottom() - height,
            width,
            height,
        )
    })
}

#[derive(Debug, Default)]
pub struct Logo {
    /// 这一帧画在哪里（点击的目标）；没画时为 None。
    pub stage: Option<Rect>,
    /// 这一轮待机动画从哪一刻开始（重新出现或点一下时从头播）。
    started: Option<Instant>,
    /// 终端支持 Sixel：画真实的素材帧，而不是字符画。
    pixels: bool,
    /// 播待机动画（默认不播：终端每秒重解码四次会卡，连输入法都跟着迟）。
    anim: bool,
    /// 上一次发出去的像素图（位置与帧号），没变就不重发。
    sent: Option<(Rect, usize)>,
    /// 这一帧之后终端要写出去的东西。
    pending: Option<Image>,
}

impl Logo {
    /// 需要按动画节拍重画：画着就在动。
    pub fn animating(&self) -> bool {
        self.stage.is_some()
    }

    /// 入口说明终端支持 Sixel（`Windows Terminal 1.22+` 或显式开关）。
    pub fn set_pixels(&mut self, pixels: bool) {
        self.pixels = pixels;
    }

    /// 下一帧动画该在什么时候画（没有像素图、或者还没开始画时为 None）。界面只在帧边界重画，
    /// 不再按统一的动画节拍一直重画——那样终端每秒要刷三十次，光标都会闪。
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
                // 至少 40ms 之后再画，避免同一时刻被反复唤醒。
                let wait = (boundary - at).max(40);
                return Some(now + std::time::Duration::from_millis(wait));
            }
        }
        None
    }

    /// 要不要播待机动画（`NIBI_TUI_PET_ANIM=1`）：默认关，只贴一张静态图。
    pub fn set_anim(&mut self, anim: bool) {
        self.anim = anim;
    }

    /// 终端能不能显示像素图（据此决定要不要给小鸟留一栏）。
    pub fn pixels(&self) -> bool {
        self.pixels
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

    pub fn draw(&mut self, buffer: &mut Buffer, free: Rect, palette: &Palette, now: Instant) {
        if self.pixels {
            self.draw_pixels(free.intersection(buffer.area), palette, now);
            return;
        }
        let Some(stage) = stage_in(free.intersection(buffer.area)) else {
            self.hide();
            return;
        };
        self.stage = Some(stage);
        let started = *self.started.get_or_insert(now);
        let elapsed = now.saturating_duration_since(started).as_millis() as u64;
        draw_pack(buffer, stage, palette, pack_frame_at(elapsed));
    }

    /// 像素图这条：格子留空给终端画图，只在帧或位置变了、或过了一阵子才重发。
    fn draw_pixels(&mut self, free: Rect, palette: &Palette, now: Instant) {
        let Some(stage) = pixel_stage_in(free) else {
            self.hide();
            return;
        };
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
}

/// 像素图的位置：这一栏的右上角（贴着顶部不变的那块），占 `PIXEL_COLS × PIXEL_ROWS` 格。
fn pixel_stage_in(free: Rect) -> Option<Rect> {
    (free.width >= PIXEL_COLS + MARGIN && free.height >= PIXEL_ROWS).then(|| {
        Rect::new(
            free.right() - PIXEL_COLS - MARGIN,
            free.top(),
            PIXEL_COLS,
            PIXEL_ROWS,
        )
    })
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

/// 从开始到 `elapsed_ms` 该显示哪一帧（按 `pack.json` 的逐帧时长循环）。
fn pack_frame_at(elapsed_ms: u64) -> &'static pack::Frame {
    let total: u64 = pack::FRAMES.iter().map(|frame| frame.ms).sum();
    let mut at = elapsed_ms % total.max(1);
    for frame in pack::FRAMES {
        if at < frame.ms {
            return frame;
        }
        at -= frame.ms;
    }
    &pack::FRAMES[pack::FRAMES.len() - 1]
}

/// 一行游程展开成 `out.len()` 个调色板下标（不够的补透明）。
fn expand(runs: &[(u8, u8)], out: &mut [u8]) {
    let mut at = 0;
    for &(value, count) in runs {
        for _ in 0..count {
            if at >= out.len() {
                return;
            }
            out[at] = value;
            at += 1;
        }
    }
    for slot in &mut out[at..] {
        *slot = 0;
    }
}

/// 一个像素画进格子里。16 色终端拿不到真彩时只留字符形状（半格字符本身就能看出鸟）。
fn paint(target: &mut ratatui::buffer::Cell, palette: &Palette, index: u8, foreground: bool) {
    let [r, g, b] = pack::PALETTE[usize::from(index)];
    let Some(color) = palette.tint((r, g, b)) else {
        return;
    };
    if foreground {
        target.set_fg(color);
    } else {
        target.set_bg(color);
    }
}

/// 画一帧：两行像素压成一个字符格（`▀▄█`）。
fn draw_pack(buffer: &mut Buffer, stage: Rect, palette: &Palette, frame: &pack::Frame) {
    let width = usize::from(pack::WIDTH);
    let (mut top, mut bottom) = ([0u8; 32], [0u8; 32]);
    let rows = usize::from(pack::HEIGHT) / 2;
    for row in 0..rows {
        expand(frame.rows[row * 2], &mut top[..width]);
        expand(frame.rows[row * 2 + 1], &mut bottom[..width]);
        for column in 0..width {
            let (above, below) = (top[column], bottom[column]);
            if above == 0 && below == 0 {
                continue;
            }
            let (symbol, fg, bg) = match (above, below) {
                (0, below) => ('▄', below, None),
                (above, 0) => ('▀', above, None),
                (above, below) if above == below => ('█', above, None),
                (above, below) => ('▀', above, Some(below)),
            };
            let target = &mut buffer[(
                stage.x + u16::try_from(column).unwrap_or(0),
                stage.y + u16::try_from(row).unwrap_or(0),
            )];
            target.set_char(symbol);
            paint(target, palette, fg, true);
            if let Some(bg) = bg {
                paint(target, palette, bg, false);
            }
        }
    }
}

#[cfg(test)]
#[path = "logo_tests.rs"]
mod tests;

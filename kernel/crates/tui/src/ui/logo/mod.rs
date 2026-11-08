//! 空白处右下角的 NIBI 像素小鸟（品牌素材 `nibi-pixel-pet` 的待机动画）。
//!
//! 终端没有图像协议，按两像素一个字符格（`▀▄█`）渲染。素材是 64×64 原生帧，这里 2:1 整数缩小到
//! 19×22 像素——也就是 19 列 × 11 行，整只鸟（头顶到脚）都在，做常驻角落的小挂件；不做非整数缩放。
//!
//! 位置在正文下方空白区的右下角，**不压正文**：空白放不下时整只不画（长对话滚到底部时不占地方）。
//! 用不透明品牌色，不再像以前那样淡淡地当背景水印。待机动画自己在动，所以画着的时候界面按动画节拍重画。

mod pack;

use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

use super::palette::Palette;

/// 与右下角留的空隙（字符格）。
const MARGIN: u16 = 1;

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
}

impl Logo {
    /// 需要按动画节拍重画：画着就在动。
    pub fn animating(&self) -> bool {
        self.stage.is_some()
    }

    /// 点在小鸟身上：这一轮从头播（像被戳了一下）；点在外面不算。
    pub fn press(&mut self, column: u16, row: u16, now: Instant) {
        if let Some(stage) = self.stage
            && stage.contains(ratatui::layout::Position::new(column, row))
        {
            self.started = Some(now);
        }
    }

    /// 这一帧不画。
    pub fn hide(&mut self) {
        self.stage = None;
        self.started = None;
    }

    pub fn draw(&mut self, buffer: &mut Buffer, free: Rect, palette: &Palette, now: Instant) {
        let Some(stage) = stage_in(free.intersection(buffer.area)) else {
            self.hide();
            return;
        };
        self.stage = Some(stage);
        let started = *self.started.get_or_insert(now);
        let elapsed = now.saturating_duration_since(started).as_millis() as u64;
        draw_pack(buffer, stage, palette, pack_frame_at(elapsed));
    }
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

//! 新会话的背景徽章（docs/specs/rust-cli/tui.md §7.3）：NIBI 鸟的像素画。
//!
//! 两套画，按空白处的尺寸挑：
//! - 品牌素材 [`pack`]（`nibi-pixel-pet` 的待机动画，36×15 字符）：会呼吸、眨眼，放得下就用它；
//! - 原来的手绘徽章 [`art`]（26×10，移植 Node TUI 的画）：地方不够时用它。
//!
//! 平时淡色挂在空白处；点击时亮起，两秒内淡回。

mod art;
mod pack;

use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;

use super::palette::{Palette, Rgb, blend};

/// 一次点击的时长（秒）：`RISE` 内亮起，`FADE_FROM` 起淡回，`DURATION` 停住。
pub const DURATION: f64 = 2.0;
const RISE: f64 = 0.12;
const FADE_FROM: f64 = 1.4;
/// 平时的不透明度（手绘徽章；它的颜色本来就调亮了）。
pub const STATIC_OPACITY: f64 = 0.22;
/// 素材动画平时的不透明度：品牌色（海军蓝）比手绘徽章的亮蓝暗，22% 在深色背景上几乎看不见，所以高一档。
const PACK_OPACITY: f64 = 0.45;
/// 查不到终端背景色时按这个深色背景混合。
const DARK: Rgb = (0x1e, 0x1e, 0x21);

fn smooth(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// 点击后 `t` 秒的不透明度（从 `rest` 起亮、回到 `rest`）。
fn opacity_from(rest: f64, t: f64) -> f64 {
    if t < RISE {
        rest + (1.0 - rest) * smooth(t / RISE)
    } else if t < FADE_FROM {
        1.0
    } else if t >= DURATION {
        rest
    } else {
        1.0 + (rest - 1.0) * smooth((t - FADE_FROM) / (DURATION - FADE_FROM))
    }
}

/// 点击后 `t` 秒的不透明度。
pub fn opacity_at(t: f64) -> f64 {
    opacity_from(STATIC_OPACITY, t)
}

/// 用哪一套画。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Art {
    /// 品牌素材的待机动画（`nibi-pixel-pet`）。
    Pack,
    /// 移植 Node TUI 的手绘徽章。
    Hand,
}

fn centered(free: Rect, width: u16, height: u16) -> Rect {
    Rect::new(
        free.x + (free.width - width) / 2,
        free.y + (free.height - height) / 2,
        width,
        height,
    )
}

/// 空白处里徽章的位置与用哪套画：优先素材动画，放不下时用手绘徽章，都放不下为 None。
fn stage_for(free: Rect) -> Option<(Rect, Art)> {
    if free.width >= pack::WIDTH && free.height >= pack::HEIGHT / 2 {
        Some((
            centered(free, pack::WIDTH, pack::HEIGHT / 2),
            Art::Pack,
        ))
    } else if free.width >= art::WIDTH && free.height >= art::HEIGHT {
        Some((centered(free, art::WIDTH, art::HEIGHT), Art::Hand))
    } else {
        None
    }
}

/// 空白处里徽章的位置：居中；放不下时为 None（放得下时用素材动画）。
pub fn stage_in(free: Rect) -> Option<Rect> {
    stage_for(free).map(|(stage, _)| stage)
}

#[derive(Debug, Default)]
pub struct Logo {
    /// 最近一次点击的时刻。
    pressed: Option<Instant>,
    /// 这一帧画在哪里（点击的目标）；没画时为 None。
    pub stage: Option<Rect>,
    /// 这一帧用的是哪套画。
    art: Option<Art>,
    /// 素材动画从哪一刻开始算（每次重新出现从头播）。
    started: Option<Instant>,
}

impl Logo {
    /// 需要定时重绘：素材动画每帧都要重画；手绘徽章只在点击的效果还没结束时。
    pub fn animating(&self, now: Instant) -> bool {
        self.stage.is_some()
            && (self.art == Some(Art::Pack)
                || self
                    .pressed
                    .is_some_and(|at| now.duration_since(at).as_secs_f64() < DURATION))
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
        self.art = None;
        self.started = None;
        self.pressed = None;
    }

    pub fn draw(&mut self, buffer: &mut Buffer, free: Rect, palette: &Palette, now: Instant) {
        let Some((stage, kind)) = stage_for(free.intersection(buffer.area)) else {
            self.hide();
            return;
        };
        self.stage = Some(stage);
        self.art = Some(kind);
        let rest = if kind == Art::Pack {
            PACK_OPACITY
        } else {
            STATIC_OPACITY
        };
        let opacity = match self.pressed {
            Some(at) if now.duration_since(at).as_secs_f64() < DURATION => {
                opacity_from(rest, now.duration_since(at).as_secs_f64())
            }
            _ => {
                self.pressed = None;
                rest
            }
        };
        let background = palette.background.unwrap_or(DARK);
        if kind == Art::Pack {
            self.started.get_or_insert(now);
            let elapsed = self
                .started
                .map_or(0, |started| now.duration_since(started).as_millis() as u64);
            draw_pack(
                buffer,
                stage,
                palette,
                background,
                opacity,
                pack_frame_at(elapsed),
            );
            return;
        }
        self.started = None;
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

/// 一个像素画进格子里；`None` 的调色板（16 色终端）淡的时候改用 DIM。
fn paint(
    target: &mut ratatui::buffer::Cell,
    palette: &Palette,
    background: Rgb,
    index: u8,
    opacity: f64,
    foreground: bool,
) {
    let [r, g, b] = pack::PALETTE[usize::from(index)];
    match palette.tint(blend(background, (r, g, b), opacity)) {
        Some(color) => {
            if foreground {
                target.set_fg(color);
            } else {
                target.set_bg(color);
            }
        }
        // 16 色终端不上色：淡的时候用 dim。
        None if foreground && opacity < 0.5 => {
            target.modifier.insert(Modifier::DIM);
        }
        None => {}
    }
}

/// 画一帧素材动画：两行像素压成一个字符格（`▀▄█`）。
fn draw_pack(
    buffer: &mut Buffer,
    stage: Rect,
    palette: &Palette,
    background: Rgb,
    opacity: f64,
    frame: &pack::Frame,
) {
    let width = usize::from(pack::WIDTH);
    let (mut top, mut bottom) = ([0u8; 36], [0u8; 36]);
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
            paint(target, palette, background, fg, opacity, true);
            if let Some(bg) = bg {
                paint(target, palette, background, bg, opacity, false);
            }
        }
    }
}

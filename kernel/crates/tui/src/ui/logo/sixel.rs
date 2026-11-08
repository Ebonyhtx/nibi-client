//! Sixel 编码（docs/specs 无，格式见 VT330/340 与 `Windows Terminal 1.22` 的实现）。
//!
//! 一帧是 64×64 的调色板索引像素；Sixel 是「每 6 行一带、每种颜色一张 1 位位图」的老格式：
//!
//! ```text
//! ESC P 0;0;0 q "1;1;<w>;<h>   #1;2;r;g;b ...   逐带：逐色 <位图> $   -
//! ESC \
//! ```
//!
//! 要点：
//! - 调色板分量是 0..100，不是 0..255；
//! - **透明像素要显式填成终端背景色**：Sixel 里「不落墨」的格子由终端自己填，那个值和终端背景
//!   不一定一致，屏幕上就会出现一块底色不同的方块。所以这里把透明当成调色板最后一位（终端背景），
//!   整幅画满；
//! - 位图字符是 `?` + 6 位掩码（0x3F..0x7E），同一字符连续出现用 `!n` 压缩；
//! - 缩放只做整数倍：像素艺术放大必须最近邻，这里直接把每格复制 `scale` 次。

use std::fmt::Write as _;

use super::scene;

/// 编码一帧；`scale` 是整数放大倍数（1 = 原尺寸），`background` 是终端背景色（填透明像素）。
pub(crate) fn encode(frame: &scene::Frame, scale: u16, background: (u8, u8, u8)) -> String {
    let scale = usize::from(scale.max(1));
    // 尺寸从帧自己算：素材是 64×64，测试里的小帧也走同一段代码。
    let source_width: usize = frame
        .rows
        .first()
        .map_or(0, |row| row.iter().map(|(_, count)| usize::from(*count)).sum());
    let source_height = frame.rows.len();
    let width = source_width * scale;
    let height = source_height * scale;
    // 透明（0）在编码时换成背景色：调色板最后多一位。
    let background_index = u8::try_from(scene::PALETTE.len()).unwrap_or(u8::MAX);
    let mut pixels = vec![background_index; width * height];
    // 展开游程并按整数倍复制（最近邻）。
    for (row, runs) in frame.rows.iter().enumerate() {
        let mut x = 0;
        for &(value, count) in *runs {
            for _ in 0..count {
                if x >= source_width {
                    break;
                }
                for dy in 0..scale {
                    let y = row * scale + dy;
                    let start = y * width + x * scale;
                    for dx in 0..scale {
                        pixels[start + dx] = if value == 0 { background_index } else { value };
                    }
                }
                x += 1;
            }
        }
    }

    let mut out = String::with_capacity(width * height / 4);
    out.push_str("\x1bP0;0;0q");
    let _ = write!(out, "\"1;1;{width};{height}");
    // 调色板：只报真正用到的颜色。
    let mut used = [false; 256];
    for &value in &pixels {
        used[usize::from(value)] = true;
    }
    let component = |value: u8| u32::from(value) * 100 / 255;
    let color_of = |index: usize| -> [u8; 3] {
        match scene::PALETTE.get(index) {
            Some(color) => *color,
            None => [background.0, background.1, background.2],
        }
    };
    for index in 1..=usize::from(background_index) {
        if !used[index] {
            continue;
        }
        let color = color_of(index);
        let _ = write!(
            out,
            "#{index};2;{};{};{}",
            component(color[0]),
            component(color[1]),
            component(color[2])
        );
    }

    for top in (0..height).step_by(6) {
        let mut first = true;
        for index in 1..=usize::from(background_index) {
            if !used[index] {
                continue;
            }
            let color = u8::try_from(index).unwrap_or(0);
            let mut band = Vec::with_capacity(width);
            let mut painted = false;
            for column in 0..width {
                let mut mask = 0u8;
                for bit in 0..6u8 {
                    let y = top + usize::from(bit);
                    if y >= height {
                        break;
                    }
                    if pixels[y * width + column] == color {
                        mask |= 1 << bit;
                    }
                }
                painted |= mask != 0;
                band.push(mask);
            }
            if !painted {
                continue;
            }
            if !first {
                out.push('$');
            }
            first = false;
            let _ = write!(out, "#{index}");
            push_runs(&mut out, &band);
        }
        out.push('-');
    }
    out.push_str("\x1b\\");
    out
}

/// 带数据：`?`+掩码的字符流，连续相同字符用 `!n` 压缩。
fn push_runs(out: &mut String, band: &[u8]) {
    let mut at = 0;
    while at < band.len() {
        let value = 0x3F + band[at];
        let mut count = 1;
        while at + count < band.len() && 0x3F + band[at + count] == value {
            count += 1;
        }
        if count >= 4 {
            let _ = write!(out, "!{count}{}", char::from(value));
        } else {
            for _ in 0..count {
                out.push(char::from(value));
            }
        }
        at += count;
    }
}

#[cfg(test)]
#[path = "sixel_tests.rs"]
mod tests;

//! NIBI 像素小鸟挂件：素材数据、摆放、点击与跳动（tui.md §7.3）。
use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;

use super::*;
use crate::ui::palette::{ColorLevel, Palette};

fn palette() -> Palette {
    Palette::new(ColorLevel::TrueColor, Some((0x1e, 0x1e, 0x21)))
}

/// 挂件上画出来的字符数（空格不算）：鸟的轮廓。
fn drawn(buffer: &Buffer, area: Rect) -> usize {
    area.positions()
        .filter(|position| {
            let symbol = buffer[*position].symbol();
            symbol != " " && !symbol.is_empty()
        })
        .count()
}

/// 素材数据是生成的：每行正好铺满 18 像素、帧时长加起来是 2.4 秒、下标都在调色板里。
#[test]
fn the_animation_data_is_consistent() {
    assert!(pack::FRAMES.len() >= 2);
    assert_eq!(
        pack::FRAMES.iter().map(|frame| frame.ms).sum::<u64>(),
        2400
    );
    // 18 行像素 = 9 行字符（两像素一格），所以高度必须是偶数。
    assert_eq!(pack::HEIGHT % 2, 0);
    for (index, frame) in pack::FRAMES.iter().enumerate() {
        assert_eq!(frame.rows.len(), usize::from(pack::HEIGHT), "frame {index}");
        for row in frame.rows {
            let width: u32 = row.iter().map(|(_, count)| u32::from(*count)).sum();
            assert_eq!(width, u32::from(pack::WIDTH), "frame {index}");
            for (value, _) in *row {
                assert!(
                    usize::from(*value) < pack::PALETTE.len(),
                    "frame {index}: palette index {value}"
                );
            }
        }
    }
    // 两帧：睁眼 2.2 秒、眨眼 0.2 秒，2.4 秒一轮。
    assert!(std::ptr::eq(pack_frame_at(0), &pack::FRAMES[0]));
    assert!(std::ptr::eq(pack_frame_at(2300), &pack::FRAMES[1]));
    assert!(std::ptr::eq(pack_frame_at(2400), &pack::FRAMES[0]));
}

/// 角落的挂件：贴着右下角，留一格；放不下时不画。
#[test]
fn the_pet_sits_in_the_bottom_right_corner() {
    assert_eq!(
        stage_in(Rect::new(0, 3, 100, 30)),
        Some(Rect::new(81, 24, 18, 9))
    );
    // 差一列 / 一行都放不下。
    assert_eq!(stage_in(Rect::new(0, 0, 18, 30)), None);
    assert_eq!(stage_in(Rect::new(0, 0, 100, 8)), None);
}

#[test]
fn the_bird_is_drawn_in_brand_colours() {
    let area = Rect::new(0, 0, 60, 20);
    let now = Instant::now();
    let mut logo = Logo::default();
    let mut buffer = Buffer::empty(area);
    logo.draw(&mut buffer, area, &palette(), now);
    let stage = logo.stage.unwrap();
    assert_eq!((stage.width, stage.height), (18, 9));
    // 鸟的轮廓画出来了（不是空白），而且是半格字符。
    assert!(drawn(&buffer, stage) > 80, "{}", drawn(&buffer, stage));
    let block = |position| {
        buffer[position]
            .symbol()
            .chars()
            .all(|c| ('\u{2580}'..='\u{259f}').contains(&c))
    };
    assert!((stage.x..stage.right()).any(|x| block((x, stage.y + 3))));
    // 不透明品牌色：前景色就是素材调色板里的颜色之一（不做背景混合）。
    let brand: Vec<(u8, u8, u8)> = pack::PALETTE
        .iter()
        .skip(1)
        .map(|c| (c[0], c[1], c[2]))
        .collect();
    let painted: Vec<(u8, u8, u8)> = stage
        .positions()
        .filter_map(|position| match buffer[position].fg {
            Color::Rgb(r, g, b) => Some((r, g, b)),
            _ => None,
        })
        .collect();
    assert!(!painted.is_empty());
    assert!(painted.iter().all(|color| brand.contains(color)));
}

/// 画着就在动：界面按动画节拍重画；藏起来就不再重画。
#[test]
fn the_bird_animates_while_it_is_on_screen() {
    let area = Rect::new(0, 0, 60, 20);
    let now = Instant::now();
    let mut logo = Logo::default();
    assert!(!logo.animating());
    let mut buffer = Buffer::empty(area);
    logo.draw(&mut buffer, area, &palette(), now);
    assert!(logo.animating());
    // 放不下：不画，也不再重画，点击不算。
    let small = Rect::new(0, 0, 12, 6);
    logo.draw(&mut Buffer::empty(small), small, &palette(), now);
    logo.press(5, 5, now);
    assert!(logo.stage.is_none() && !logo.animating());
}

/// 点一下：这一轮从头播（点在外面不改）。
#[test]
fn a_click_restarts_the_round() {
    let area = Rect::new(0, 0, 60, 20);
    let start = Instant::now();
    let mut logo = Logo::default();
    logo.draw(&mut Buffer::empty(area), area, &palette(), start);
    let stage = logo.stage.unwrap();
    // 播到眨眼那段时不是第一帧。
    assert!(!std::ptr::eq(pack_frame_at(2300), &pack::FRAMES[0]));
    // 点一下：这一轮从头开始 —— 画出来与「从此刻刚开始的一只」逐格相同。
    let clicked = start + std::time::Duration::from_millis(2300);
    logo.press(stage.x + 1, stage.y + 1, clicked);
    let mut after_click = Buffer::empty(area);
    logo.draw(&mut after_click, area, &palette(), clicked);
    let mut fresh = Logo::default();
    let mut fresh_at_click = Buffer::empty(area);
    fresh.draw(&mut fresh_at_click, area, &palette(), clicked);
    assert_eq!(after_click, fresh_at_click);
    // 点在外面不改起点：仍与「从点击时刻开始播到此刻」的那只一致。
    let later = clicked + std::time::Duration::from_millis(700);
    logo.press(0, 0, later);
    let mut after = Buffer::empty(area);
    logo.draw(&mut after, area, &palette(), later);
    let mut fresh_at_later = Buffer::empty(area);
    fresh.draw(&mut fresh_at_later, area, &palette(), later);
    assert_eq!(after, fresh_at_later);
}

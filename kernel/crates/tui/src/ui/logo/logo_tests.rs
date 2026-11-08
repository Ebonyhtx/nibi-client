//! NIBI 鸟徽章：形状数据、素材动画、点击亮起与摆放（tui.md §7.3）。
use std::time::{Duration, Instant};

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;

use super::*;
use crate::ui::palette::{ColorLevel, Palette};

const DARK_BG: Rgb = (0x1e, 0x1e, 0x21);

fn palette(light: bool) -> Palette {
    let mut palette = Palette::new(ColorLevel::TrueColor, Some(DARK_BG));
    palette.light = light;
    palette
}

/// 徽章上画出来的字符数（空格不算）：鸟的轮廓。
fn drawn(buffer: &Buffer, area: Rect) -> usize {
    area.positions()
        .filter(|position| {
            let symbol = buffer[*position].symbol();
            symbol != " " && !symbol.is_empty()
        })
        .count()
}

#[test]
fn every_frame_of_the_bird_is_the_same_grid() {
    for light in [false, true] {
        for blink in [false, true] {
            let rows = art::rows(light, blink);
            assert_eq!(rows.len(), usize::from(art::HEIGHT), "light {light} blink {blink}");
            for (index, row) in rows.iter().enumerate() {
                let width: usize = row.iter().map(|run| run.text.chars().count()).sum();
                assert_eq!(
                    width,
                    usize::from(art::WIDTH),
                    "row {index} light {light} blink {blink}"
                );
            }
        }
    }
    // 深色与浅色是两套颜色。
    assert_ne!(art::DARK[0][1].fg, art::LIGHT[0][1].fg);
    // 眨眼那一帧的眼睛与睁着的不一样。
    assert_ne!(art::DARK[3], art::DARK_BLINK[3]);
}

#[test]
fn colours_parse_from_the_brand_hex() {
    assert_eq!(art::rgb("#4a79b8"), (0x4a, 0x79, 0xb8));
    assert_eq!(art::rgb("e89645"), (0xe8, 0x96, 0x45));
}

#[test]
fn the_stage_is_centered_and_needs_room() {
    // 放得下就用素材动画（36×15）。
    assert_eq!(
        stage_in(Rect::new(0, 3, 100, 30)),
        Some(Rect::new(32, 10, 36, 15))
    );
    // 素材放不下、手绘徽章放得下（26×10）。
    assert_eq!(
        stage_in(Rect::new(0, 0, 30, 12)),
        Some(Rect::new(2, 1, 26, 10))
    );
    // 差一列 / 一行都放不下。
    assert_eq!(stage_in(Rect::new(0, 0, 25, 30)), None);
    assert_eq!(stage_in(Rect::new(0, 0, 100, 9)), None);
}

/// 素材动画的数据是生成的：每行正好铺满 36 像素、帧时长加起来是 2.4 秒、下标都在调色板里。
#[test]
fn the_animation_data_is_consistent() {
    assert!(pack::FRAMES.len() >= 2);
    assert_eq!(
        pack::FRAMES.iter().map(|frame| frame.ms).sum::<u64>(),
        2400
    );
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
    // 按 `pack.json` 的逐帧时长取帧，2.4 秒一轮。
    assert!(std::ptr::eq(pack_frame_at(0), &pack::FRAMES[0]));
    assert!(std::ptr::eq(pack_frame_at(400), &pack::FRAMES[1]));
    assert!(std::ptr::eq(pack_frame_at(2400), &pack::FRAMES[0]));
}

#[test]
fn a_press_lights_the_badge_and_fades_back() {
    assert_eq!(opacity_at(0.0), STATIC_OPACITY);
    assert_eq!(opacity_at(RISE), 1.0);
    assert_eq!(opacity_at(1.0), 1.0);
    assert!((STATIC_OPACITY..1.0).contains(&opacity_at(1.7)));
    assert_eq!(opacity_at(DURATION + 1.0), STATIC_OPACITY);
}

#[test]
fn the_badge_animates_and_answers_clicks() {
    let palette = palette(false);
    let area = Rect::new(0, 0, 100, 30);
    let mut logo = Logo::default();
    let now = Instant::now();
    // 没画之前点不算。
    logo.press(50, 15, now);
    let mut buffer = Buffer::empty(area);
    logo.draw(&mut buffer, area, &palette, now);
    let stage = logo.stage.unwrap();
    assert_eq!((stage.width, stage.height), (36, 15));
    // 素材是动画：画着就一直按动画节拍重画。
    assert!(logo.animating(now));
    // 鸟的头部与胸脯画出来了（不是空白）。
    assert!(drawn(&buffer, stage) > 200, "{}", drawn(&buffer, stage));
    let block = |position| {
        buffer[position]
            .symbol()
            .chars()
            .all(|c| ('\u{2580}'..='\u{259f}').contains(&c))
    };
    // 头顶那两行里至少有一格是半格字符。
    assert!((stage.x..stage.right()).any(|x| block((x, stage.y + 1))));
    // 点在徽章上：重新开始一次亮起；点在外面：不影响。
    logo.press(stage.x + 1, stage.y + 1, now);
    assert!(logo.animating(now));
    logo.press(1, 1, now);
    assert!(logo.animating(now), "the pack keeps animating");
    // 一次亮起之后仍在动画：素材自己在动。
    let later = now + Duration::from_secs_f64(DURATION + 0.1);
    logo.draw(&mut buffer, area, &palette, later);
    assert!(logo.animating(later));
    // 放不下：不画，点击也不算。
    let small = Rect::new(0, 0, 30, 8);
    logo.draw(&mut Buffer::empty(small), small, &palette, later);
    logo.press(5, 5, later);
    assert!(logo.stage.is_none() && !logo.animating(later));
}

/// 地方不够放素材动画时回落到手绘徽章：静止，只在点击后亮起。
#[test]
fn the_hand_art_is_the_fallback_and_stays_still() {
    let palette = palette(false);
    let area = Rect::new(0, 0, 30, 12);
    let mut logo = Logo::default();
    let now = Instant::now();
    let mut buffer = Buffer::empty(area);
    logo.draw(&mut buffer, area, &palette, now);
    let stage = logo.stage.unwrap();
    assert_eq!((stage.width, stage.height), (26, 10));
    assert!(drawn(&buffer, stage) > 120);
    assert!(!logo.animating(now));
    logo.press(stage.x + 1, stage.y + 1, now);
    assert!(logo.animating(now));
    let later = now + Duration::from_secs_f64(DURATION + 0.1);
    logo.draw(&mut buffer, area, &palette, later);
    assert!(!logo.animating(later));
}

/// 素材画按终端背景混色：浅色背景上画出来的颜色比深色背景浅。
#[test]
fn the_theme_is_blended_into_the_art() {
    let area = Rect::new(0, 0, 60, 20);
    let now = Instant::now();
    let first_fg = |background: Rgb| {
        let palette = Palette::new(ColorLevel::TrueColor, Some(background));
        let mut logo = Logo::default();
        let mut buffer = Buffer::empty(area);
        logo.draw(&mut buffer, area, &palette, now);
        let stage = logo.stage.unwrap();
        stage
            .positions()
            .map(|position| buffer[position].fg)
            .find(|color| *color != Color::Reset)
            .expect("the art paints something")
    };
    assert_ne!(first_fg(DARK_BG), first_fg((0xfb, 0xf6, 0xec)));
}

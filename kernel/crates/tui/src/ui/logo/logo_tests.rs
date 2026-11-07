//! NIBI 鸟徽章：形状数据、点击亮起与摆放（tui.md §7.3）。
use std::time::{Duration, Instant};

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

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
    assert_eq!(
        stage_in(Rect::new(0, 3, 100, 30)),
        Some(Rect::new(37, 13, 26, 10))
    );
    // 差一列 / 一行都放不下。
    assert_eq!(stage_in(Rect::new(0, 0, 25, 30)), None);
    assert_eq!(stage_in(Rect::new(0, 0, 100, 9)), None);
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
fn the_badge_is_still_until_clicked() {
    let palette = palette(false);
    let area = Rect::new(0, 0, 100, 30);
    let mut logo = Logo::default();
    let now = Instant::now();
    // 没画之前点不算。
    logo.press(50, 15, now);
    let mut buffer = Buffer::empty(area);
    logo.draw(&mut buffer, area, &palette, now);
    assert!(!logo.animating(now), "no animation by default");
    let stage = logo.stage.unwrap();
    assert_eq!(stage.width, 26);
    assert_eq!(stage.height, 10);
    // 鸟的轮廓画出来了（不是空白）。
    assert!(drawn(&buffer, stage) > 120, "{}", drawn(&buffer, stage));
    // 半格字符在格子里。
    assert!(
        buffer[(stage.x, stage.y + 2)]
            .symbol()
            .chars()
            .all(|c| ('\u{2580}'..='\u{259f}').contains(&c) || c == ' ')
    );
    // 点在徽章上：亮起；点在外面：不亮。
    logo.press(stage.x + 1, stage.y + 1, now);
    assert!(logo.animating(now));
    let later = now + Duration::from_secs_f64(DURATION + 0.1);
    logo.draw(&mut buffer, area, &palette, later);
    assert!(!logo.animating(later));
    logo.press(1, 1, later);
    assert!(!logo.animating(later), "a click outside the badge does nothing");
    // 放不下：不画，点击也不算。
    let small = Rect::new(0, 0, 30, 8);
    logo.draw(&mut Buffer::empty(small), small, &palette, later);
    logo.press(5, 5, later);
    assert!(logo.stage.is_none() && !logo.animating(later));
}

#[test]
fn the_light_theme_uses_the_light_art() {
    let area = Rect::new(0, 0, 60, 20);
    let now = Instant::now();
    let mut logo = Logo::default();
    let mut dark = Buffer::empty(area);
    logo.draw(&mut dark, area, &palette(false), now);
    let dark_color = dark[(logo.stage.unwrap().x + 12, logo.stage.unwrap().y)].fg;
    let mut light = Buffer::empty(area);
    logo.draw(&mut light, area, &palette(true), now);
    let light_color = light[(logo.stage.unwrap().x + 12, logo.stage.unwrap().y)].fg;
    assert_ne!(dark_color, light_color);
}

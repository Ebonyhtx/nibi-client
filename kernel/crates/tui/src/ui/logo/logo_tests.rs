//! 顶栏右端的小鸟：素材数据、摆放、静态与动画、点击重置（tui.md §7.3）。

use std::time::Instant;

use ratatui::layout::Rect;

use super::*;
use crate::ui::palette::{ColorLevel, Palette};

fn palette() -> Palette {
    Palette::new(ColorLevel::TrueColor, Some((0x1e, 0x1e, 0x21)))
}

fn band() -> Rect {
    Rect::new(0, 0, 100, PIXEL_ROWS)
}

/// 素材数据是生成的：帧时长加起来 2.4 秒、每行铺满 64 像素、下标都在调色板里。
#[test]
fn the_animation_data_is_consistent() {
    assert!(scene::FRAMES.len() >= 2);
    assert_eq!(
        scene::FRAMES.iter().map(|frame| frame.ms).sum::<u64>(),
        2400
    );
    for (index, frame) in scene::FRAMES.iter().enumerate() {
        assert_eq!(frame.rows.len(), 64, "frame {index}");
        for row in frame.rows {
            let width: u32 = row.iter().map(|(_, count)| u32::from(*count)).sum();
            assert_eq!(width, 64, "frame {index}");
            for (value, _) in *row {
                assert!(
                    usize::from(*value) < scene::PALETTE.len(),
                    "frame {index}: palette index {value}"
                );
            }
        }
    }
    // 按 `pack.json` 的逐帧时长取帧。
    assert_eq!(scene_frame_at(0), 0);
    assert_eq!(scene_frame_at(400), 1);
    assert_eq!(scene_frame_at(2400), 0);
}

/// 终端不支持像素图：整只不画（栏里只有字标与身份行），也不排任何重画。
#[test]
fn without_sixel_the_bird_is_not_drawn() {
    let now = Instant::now();
    let mut logo = Logo::default();
    logo.draw(band(), &palette(), now);
    assert!(logo.stage.is_none());
    assert!(logo.take_image().is_none());
    assert_eq!(logo.next_frame(now), None);
}

/// 贴在栏的右端，静态：一次只发一张，之后不重发。
#[test]
fn the_bird_sits_at_the_right_of_the_band_and_stays_still() {
    let now = Instant::now();
    let mut logo = Logo::default();
    logo.set_pixels(true);
    logo.draw(band(), &palette(), now);
    let stage = logo.stage.expect("a stage");
    assert_eq!(stage.right(), band().right() - MARGIN);
    assert_eq!(stage.height, PIXEL_ROWS);
    match logo.take_image() {
        Some(Image {
            at,
            payload: Payload::Sixel(bytes),
        }) => {
            assert_eq!(at, (stage.x, stage.y));
            assert!(bytes.contains("\"1;1;128;128"), "2× the 64×64 frame");
        }
        other => panic!("expected a sixel image, got {other:?}"),
    }
    for step in 1..=10u64 {
        let at = now + std::time::Duration::from_millis(step * 300);
        logo.draw(band(), &palette(), at);
        assert!(logo.take_image().is_none(), "no re-send at step {step}");
    }
    assert_eq!(logo.next_frame(now), None, "nothing is scheduled");
}

/// 开了动画（`NIBI_TUI_PET_ANIM=1`）：按帧边界重发。
#[test]
fn the_animation_resends_on_frame_boundaries() {
    let now = Instant::now();
    let mut logo = Logo::default();
    logo.set_pixels(true);
    logo.set_anim(true);
    logo.draw(band(), &palette(), now);
    assert!(logo.take_image().is_some());
    logo.draw(band(), &palette(), now + std::time::Duration::from_millis(400));
    assert!(logo.take_image().is_some(), "the next frame is sent");
    let due = logo.next_frame(now).expect("a frame is due");
    assert!(due > now && due <= now + std::time::Duration::from_millis(400));
}

/// 栏放不下（太窄）：不画，也不留旧图。放不下之后要发一次清除。
#[test]
fn a_narrow_band_clears_the_picture() {
    let now = Instant::now();
    let mut logo = Logo::default();
    logo.set_pixels(true);
    logo.draw(band(), &palette(), now);
    assert!(logo.take_image().is_some());
    logo.draw(Rect::new(0, 0, 10, PIXEL_ROWS), &palette(), now);
    match logo.take_image().map(|image| image.payload) {
        Some(Payload::Clear { cols, rows }) => assert_eq!((cols, rows), (PIXEL_COLS, PIXEL_ROWS)),
        other => panic!("expected a clear, got {other:?}"),
    }
    assert!(logo.stage.is_none());
}

/// 点一下：这一轮从头播（点在外面不改）。
#[test]
fn a_click_restarts_the_round() {
    let now = Instant::now();
    let mut logo = Logo::default();
    logo.set_pixels(true);
    logo.set_anim(true);
    logo.draw(band(), &palette(), now);
    let stage = logo.stage.expect("a stage");
    // 点在里面：起点换成点击时刻（再画就是第一帧）。
    logo.press(stage.x + 1, stage.y + 1, now + std::time::Duration::from_millis(2300));
    let due = logo.next_frame(now + std::time::Duration::from_millis(2300));
    assert!(due.is_some(), "the round restarted");
    // 点在外面：起点不变。
    logo.press(0, 0, now + std::time::Duration::from_millis(3000));
    let later = now + std::time::Duration::from_millis(3000);
    assert!(logo.next_frame(later).is_some());
}

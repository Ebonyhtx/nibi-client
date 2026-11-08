//! 新会话的背景标志（docs/specs/rust-cli/tui.md §7.3）：新会话的空白处画 NIBI 鸟的像素画（半格字符）；
//! 点击后约 2 秒按动画节拍重画，结束后不再定时重画；有字、有会话时不画；深浅两种背景各一套颜色。
use std::time::Duration;

use ratatui::buffer::Buffer;
use nibi_kernel_api::testing::text_response;
use nibi_kernel_tui::ui::palette::{ColorLevel, Palette};

use super::support::{GatedModel, Setup, with_ui};

/// 半格字符（徽章的像素）所在的格子：（列，行）。
fn braille(buffer: &Buffer) -> Vec<(u16, u16)> {
    let area = buffer.area;
    let mut cells = Vec::new();
    for y in area.top()..area.bottom() {
        for x in area.left()..area.right() {
            let symbol = buffer[(x, y)].symbol();
            if symbol
                .chars()
                .next()
                .is_some_and(|c| ('\u{2580}'..='\u{259f}').contains(&c))
            {
                cells.push((x, y));
            }
        }
    }
    cells
}

fn draws(handovers: &std::sync::Mutex<Vec<&'static str>>) -> usize {
    handovers
        .lock()
        .unwrap()
        .iter()
        .filter(|h| **h == "draw")
        .count()
}

fn setup(background: (u8, u8, u8)) -> Setup {
    Setup {
        width: 100,
        height: 40,
        palette: Palette::new(ColorLevel::TrueColor, Some(background)),
        ..Setup::default()
    }
}

/// 新会话时画出素材动画（`nibi-pixel-pet` 的待机帧）：待机动画自己在动，所以一直按动画节拍重画；
/// 点一下仍会亮起；打上字之后藏起来。
#[tokio::test(flavor = "multi_thread")]
async fn the_badge_animates_while_visible() {
    let model = GatedModel::scripted(Vec::new());
    with_ui(model, setup((0x1e, 0x1e, 0x2e)), |mut ui| async move {
        let buffer = ui.buffer.clone();
        // 素材动画 36×15 格，画出来的半格字符远多于手绘徽章的 120 格。
        ui.wait("the badge", |_| ui_braille(&buffer).len() > 200)
            .await;
        // 平日也在动：没有输入时按动画节拍重画。
        let before = draws(&ui.handovers);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let idle = draws(&ui.handovers) - before;
        assert!(idle >= 3, "the pet animates while idle: {idle}");
        // 点在鸟身上：亮起，动画照旧。
        let cells = ui_braille(&ui.buffer);
        let (x, y) = cells[cells.len() / 2];
        ui.mouse(
            crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            x,
            y,
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(draws(&ui.handovers) > before + idle);
        // 打上字：藏起来。
        ui.type_text("x");
        ui.wait("the badge to hide", |_| ui_braille(&buffer).is_empty())
            .await;
    })
    .await;
}

fn ui_braille(buffer: &std::sync::Mutex<Option<Buffer>>) -> Vec<(u16, u16)> {
    buffer
        .lock()
        .unwrap()
        .as_ref()
        .map(braille)
        .unwrap_or_default()
}

/// 有字或有会话时不画；浅色背景用另一套像素色（不亮过纸）。
#[tokio::test(flavor = "multi_thread")]
async fn the_badge_hides_behind_input_and_sessions_and_follows_the_theme() {
    let model = GatedModel::scripted(vec![text_response(&["hello"])]);
    with_ui(model, setup((0xfa, 0xfa, 0xf7)), |mut ui| async move {
        let buffer = ui.buffer.clone();
        ui.wait("the badge", |_| ui_braille(&buffer).len() > 100)
            .await;
        // 浅色背景：点的颜色都比背景暗。
        {
            let guard = ui.buffer.lock().unwrap();
            let buffer = guard.as_ref().unwrap();
            for (x, y) in braille(buffer) {
                if let ratatui::style::Color::Rgb(r, g, b) = buffer[(x, y)].fg {
                    assert!(
                        u32::from(r) + u32::from(g) + u32::from(b) < 0xfa + 0xfa + 0xf7,
                        "({x}, {y})"
                    );
                }
            }
        }
        ui.type_text("hi");
        ui.wait("the badge to hide", |_| ui_braille(&buffer).is_empty())
            .await;
        ui.key(crossterm::event::KeyCode::Enter);
        ui.wait_for("⏺ hello").await;
        assert!(ui_braille(&ui.buffer).is_empty(), "no badge in a session");
    })
    .await;
}

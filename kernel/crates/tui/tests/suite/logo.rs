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

/// 角落的小鸟（品牌素材的待机动画）：贴在正文下方空白区的右下角、一直动着，不压输入框里的字。
#[tokio::test(flavor = "multi_thread")]
async fn the_pet_sits_in_the_corner_and_animates() {
    let model = GatedModel::scripted(Vec::new());
    with_ui(model, setup((0x1e, 0x1e, 0x2e)), |mut ui| async move {
        let buffer = ui.buffer.clone();
        // 18×9 格里有大半是鸟的轮廓（半格字符）。
        ui.wait("the pet", |_| ui_braille(&buffer).len() > 80).await;
        // 位置：右下角（不压正文）。
        // `setup` 里给的终端尺寸。
        let (width, height) = (100, 40);
        for (x, y) in ui_braille(&ui.buffer) {
            assert!(x > width - 30, "({x}, {y}) is not in the right corner");
            assert!(y > height / 2, "({x}, {y}) is not in the bottom corner");
        }
        // 待机动画自己在动：没有输入时也按动画节拍重画。
        let before = draws(&ui.handovers);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let idle = draws(&ui.handovers) - before;
        assert!(idle >= 3, "the pet animates while idle: {idle}");
        // 打字时它还在角落里，输入框的字照常显示。
        ui.type_text("hi");
        ui.wait_for("❯ hi").await;
        assert!(
            ui_braille(&ui.buffer).len() > 80,
            "the pet stays while typing"
        );
    })
    .await;
}

/// 浅色纸面上仍然用品牌色（不透明），不会白到看不见。
#[tokio::test(flavor = "multi_thread")]
async fn the_pet_keeps_brand_colours_on_light_paper() {
    let model = GatedModel::scripted(Vec::new());
    with_ui(model, setup((0xfa, 0xfa, 0xf7)), |mut ui| async move {
        let buffer = ui.buffer.clone();
        ui.wait("the pet", |_| ui_braille(&buffer).len() > 80).await;
        let cells = ui_braille(&ui.buffer);
        assert!(!cells.is_empty());
        let guard = ui.buffer.lock().unwrap();
        let buffer = guard.as_ref().unwrap();
        for (x, y) in cells {
            if let ratatui::style::Color::Rgb(r, g, b) = buffer[(x, y)].fg {
                assert!(
                    u32::from(r) + u32::from(g) + u32::from(b) < 0xfa + 0xfa + 0xf7,
                    "({x}, {y})"
                );
            }
        }
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

/// 支持像素图时，右侧留一栏给小鸟：正文让出 18 列，栏左侧一条竖线，鸟通过 Sixel 贴在栏底。
#[tokio::test(flavor = "multi_thread")]
async fn the_pet_gets_its_own_column_on_the_right() {
    let model = GatedModel::scripted(Vec::new());
    let setup = Setup {
        pixels: true,
        ..setup((0x1e, 0x1e, 0x2e))
    };
    with_ui(model, setup, |mut ui| async move {
        let images = ui.images.clone();
        ui.wait("the pet image", |_| !images.lock().unwrap().is_empty())
            .await;
        // 100 列、栏宽 18：竖线在 x = 82。
        {
            let guard = ui.buffer.lock().unwrap();
            let buffer = guard.as_ref().unwrap();
            let rule_rows: Vec<u16> = (0..buffer.area.height)
                .filter(|y| buffer[(82, *y)].symbol() == "│")
                .collect();
            assert!(rule_rows.len() > 10, "a vertical rule separates the column");
            // 竖线右边、正文区域那几行里不写字（图片由终端贴上去）；输入框与状态行在下面，不受影响。
            for y in &rule_rows {
                for x in 83..buffer.area.width {
                    assert!(
                        buffer[(x, *y)].symbol().trim().is_empty(),
                        "({x}, {y}) should stay blank for the image"
                    );
                }
            }
        }
        // 图片贴在竖线右边、下半屏。
        let guard = images.lock().unwrap();
        let image = guard.last().unwrap();
        assert!(image.at.0 >= 82, "{:?}", image.at);
        assert!(image.at.1 >= 20, "{:?}", image.at);
        match &image.payload {
            nibi_kernel_tui::ui::logo::Payload::Sixel(bytes) => {
                assert!(bytes.contains("\"1;1;128;128"), "2× the 64×64 frame");
            }
            other => panic!("expected a sixel image, got {other:?}"),
        }
    })
    .await;
}

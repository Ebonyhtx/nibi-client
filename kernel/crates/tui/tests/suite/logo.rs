//! 顶部固定栏（docs/specs/rust-cli/tui.md §7.3）：左边是「NIBI」块字标与身份行，右端是小鸟（Sixel）。
//! 不支持像素图的终端只有左边，不画鸟；栏静止，不随正文滚动。
use std::time::Duration;

use ratatui::buffer::Buffer;
use nibi_kernel_tui::ui::palette::{ColorLevel, Palette};

use super::support::{GatedModel, Setup, text_of, with_ui};

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

/// 栏里的块字标（`█`）：左上角那片。
fn wordmark_cells(buffer: &Buffer) -> usize {
    let mut count = 0;
    for y in 0..5 {
        for x in 0..30 {
            if buffer[(x, y)].symbol().starts_with('█') {
                count += 1;
            }
        }
    }
    count
}

/// 支持像素图：字标 + 身份行 + 栏右端的小鸟（一张静态图，贴完把光标移回输入框）。
#[tokio::test(flavor = "multi_thread")]
async fn the_masthead_carries_the_wordmark_and_the_bird() {
    let model = GatedModel::scripted(Vec::new());
    let setup = Setup {
        pixels: true,
        ..setup((0x1e, 0x1e, 0x2e))
    };
    with_ui(model, setup, |mut ui| async move {
        let images = ui.images.clone();
        ui.wait("the pet image", |_| !images.lock().unwrap().is_empty())
            .await;
        {
            let guard = ui.buffer.lock().unwrap();
            let buffer = guard.as_ref().unwrap();
            // 字标在左上角，身份行只有一份（不在正文里重复）。
            assert!(wordmark_cells(buffer) > 40, "{}", wordmark_cells(buffer));
            let text = text_of(buffer);
            assert_eq!(text.matches("NIBI v0.1.0").count(), 1, "{text}");
            // 小鸟在栏的右端、贴着顶部。
            let image = images.lock().unwrap().last().cloned().unwrap();
            assert!(image.at.0 > buffer.area.width - 20, "{:?}", image.at);
            assert!(image.at.1 < 3, "{:?}", image.at);
        }
        // 贴完图要把终端光标放回输入框，否则鸟旁边会多一个光标。
        assert!(
            !ui.cursor_at.lock().unwrap().is_empty(),
            "the cursor goes back after the image"
        );
        // 静态：不再重发，界面也不重画。
        let before = images.lock().unwrap().len();
        let frames = draws(&ui.handovers);
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(images.lock().unwrap().len(), before, "static pet");
        assert_eq!(draws(&ui.handovers), frames, "no redraw while idle");
    })
    .await;
}

/// 不支持像素图：栏照常在（字标 + 身份行），但一只鸟都不画，也不发任何图片。
#[tokio::test(flavor = "multi_thread")]
async fn without_sixel_the_masthead_has_no_bird() {
    let model = GatedModel::scripted(Vec::new());
    with_ui(model, setup((0x1e, 0x1e, 0x2e)), |mut ui| async move {
        let buffer = ui.buffer.clone();
        ui.wait("the wordmark", |_| {
            buffer
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|buffer| wordmark_cells(buffer) > 40)
        })
        .await;
        let guard = ui.buffer.lock().unwrap();
        let buffer = guard.as_ref().unwrap();
        let text = text_of(buffer);
        assert_eq!(text.matches("NIBI v0.1.0").count(), 1, "{text}");
        drop(guard);
        assert!(
            ui.images.lock().unwrap().is_empty(),
            "no image without sixel"
        );
        // 界面静止：不按动画节拍重画。
        let frames = draws(&ui.handovers);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(draws(&ui.handovers), frames, "no redraw while idle");
    })
    .await;
}

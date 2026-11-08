//! Sixel 编码：栅格尺寸、调色板换算、透明填背景、整数放大与真实帧。

use super::*;

const ONE_COLOR: &[&[(u8, u8)]] = &[&[(1, 4)], &[(1, 4)], &[(1, 4)], &[(1, 4)]];
const EMPTY: &[&[(u8, u8)]] = &[&[(0, 4)], &[(0, 4)], &[(0, 4)], &[(0, 4)]];

fn frame(rows: &'static [&'static [(u8, u8)]]) -> scene::Frame {
    scene::Frame { ms: 100, rows }
}

#[test]
fn a_solid_block_is_one_palette_entry_and_one_band() {
    let out = encode(&frame(ONE_COLOR), 1, (0, 0, 0));
    assert!(out.starts_with("\x1bP0;0;0q"), "{out:?}");
    assert!(out.contains("\"1;1;4;4"), "raster attributes: {out:?}");
    // 调色板是 0..100 的分量，不是 0..255。
    let [r, g, b] = scene::PALETTE[1];
    let expected = format!(
        "#1;2;{};{};{}",
        u32::from(r) * 100 / 255,
        u32::from(g) * 100 / 255,
        u32::from(b) * 100 / 255
    );
    assert!(out.contains(&expected), "{expected} in {out:?}");
    assert!(out.ends_with("\x1b\\"), "{out:?}");
    // 4 列一样的掩码：压缩成 !4。
    assert!(out.contains("!4"), "run length: {out:?}");
    // 4 行只有一带。
    assert_eq!(out.matches('-').count(), 1);
}

/// 透明像素填成终端背景色（调色板最后一位），整幅画满：Sixel 里「不落墨」的格子由终端自己填色，
/// 那个值和终端背景不一定一致，屏幕上就是一块底色不同的方框。
#[test]
fn transparent_pixels_are_filled_with_the_background() {
    let out = encode(&frame(EMPTY), 1, (0x1e, 0x1e, 0x21));
    // 素材自己的颜色一个都不该出现。
    for index in 1..scene::PALETTE.len() {
        assert!(!out.contains(&format!("#{index};2;")), "{out:?}");
    }
    let background = scene::PALETTE.len();
    let expected = format!(
        "#{background};2;{};{};{}",
        0x1eu32 * 100 / 255,
        0x1eu32 * 100 / 255,
        0x21u32 * 100 / 255
    );
    assert!(out.contains(&expected), "{expected} in {out:?}");
    // 没有剩下的空位图（`?` 只在更长的游程里出现，这里整行都是背景）。
    assert!(out.contains("!4N"), "the band is fully painted: {out:?}");
}

#[test]
fn scaling_repeats_pixels_without_resampling() {
    let rows: &[&[(u8, u8)]] = &[&[(1, 2)], &[(1, 2)]];
    let out = encode(&frame(rows), 2, (0, 0, 0));
    assert!(out.contains("\"1;1;4;4"), "2×2 放大两倍是 4×4: {out:?}");
    // 每个像素复制成 2×2：一带（4 行）里 4 列都落墨，掩码 0b1111 → `N`，压缩成 !4N。
    assert!(out.contains("!4N"), "{out:?}");
}

/// 素材仓的真实帧能编码：2 倍是 128×128，长度在合理范围内（不是每帧几十 KB）。
#[test]
fn the_real_frames_encode() {
    for (index, frame) in scene::FRAMES.iter().enumerate() {
        let out = encode(frame, 2, (0x1e, 0x1e, 0x21));
        assert!(out.contains("\"1;1;128;128"), "frame {index}");
        assert!(out.starts_with("\x1bP0;0;0q") && out.ends_with("\x1b\\"));
        assert!(out.len() < 120_000, "frame {index}: {} bytes", out.len());
    }
    // 帧时长加起来是素材仓的 2.4 秒。
    assert_eq!(
        scene::FRAMES.iter().map(|frame| frame.ms).sum::<u64>(),
        2400
    );
}

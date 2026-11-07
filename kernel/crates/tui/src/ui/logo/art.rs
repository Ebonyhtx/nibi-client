//! NIBI 鸟徽章的像素画（移植 `apps/zcode-cli/packages/tui/src/brand-pixel-logo.ts`，数据原样）。
//!
//! 每行是若干色段；半格字符 `▀▄█` 让像素在终端里近似正方。`*_BLINK` 是眨眼的一帧（同尺寸）。
//! 深色与浅色主题各一套：深色用亮蓝 + 奶油 + 暖橙，浅色用深蓝 + 米白 + 品牌橙。

/// 一段连续同色的半格字符。`fg` 是上半格、`bg` 是下半格；`None` 表示那一半透明。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Run {
    pub text: &'static str,
    pub fg: Option<&'static str>,
    pub bg: Option<&'static str>,
}

pub(crate) type Row = &'static [Run];

/// 徽章的列数与行数（四套画都是这个尺寸）。
pub(crate) const WIDTH: u16 = 26;
pub(crate) const HEIGHT: u16 = 10;

pub(crate) const DARK: &[Row] = &[
    &[Run { text: "            ", fg: None, bg: None }, Run { text: "▄▄██████▄", fg: Some("#4a79b8"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "          ", fg: None, bg: None }, Run { text: "▄██████████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#f5e7d3") }, Run { text: "▄", fg: Some("#4a79b8"), bg: None }, Run { text: "   ", fg: None, bg: None }],
    &[Run { text: "         ", fg: None, bg: None }, Run { text: "██████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#f5e7d3") }, Run { text: "██", fg: Some("#f5e7d3"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#0a121e") }, Run { text: "▀", fg: Some("#f5e7d3"), bg: Some("#4a79b8") }, Run { text: "█", fg: Some("#f5e7d3"), bg: None }, Run { text: "▀", fg: Some("#f5e7d3"), bg: Some("#4a79b8") }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#e89645") }, Run { text: "▀▀", fg: Some("#4a79b8"), bg: None }, Run { text: " ", fg: None, bg: None }],
    &[Run { text: "       ", fg: None, bg: None }, Run { text: "▄█████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#f5e7d3") }, Run { text: "████", fg: Some("#f5e7d3"), bg: None }, Run { text: "▀", fg: Some("#e89645"), bg: Some("#f5e7d3") }, Run { text: "██", fg: Some("#f5e7d3"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "     ", fg: None, bg: None }, Run { text: "▄████████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#f5e7d3"), bg: Some("#e89645") }, Run { text: "█████", fg: Some("#f5e7d3"), bg: None }, Run { text: "▀", fg: Some("#f5e7d3"), bg: Some("#e89645") }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "    ", fg: None, bg: None }, Run { text: "████████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#e89645") }, Run { text: "████████", fg: Some("#e89645"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: " ", fg: None, bg: None }, Run { text: "▄▄██████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀▀", fg: Some("#4a79b8"), bg: Some("#e89645") }, Run { text: "█████████▀", fg: Some("#e89645"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "▀▀▀▀▀", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#e89645") }, Run { text: "█████████████", fg: Some("#e89645"), bg: None }, Run { text: "       ", fg: None, bg: None }],
    &[Run { text: "      ", fg: None, bg: None }, Run { text: "▀█████████▀▀", fg: Some("#e89645"), bg: None }, Run { text: "        ", fg: None, bg: None }],
    &[Run { text: "        ", fg: None, bg: None }, Run { text: "▀▀▀▀▀▀", fg: Some("#e89645"), bg: None }, Run { text: "            ", fg: None, bg: None }],
];

pub(crate) const DARK_BLINK: &[Row] = &[
    &[Run { text: "              ", fg: None, bg: None }, Run { text: "▄▄▄▄▄▄", fg: Some("#4a79b8"), bg: None }, Run { text: "      ", fg: None, bg: None }],
    &[Run { text: "           ", fg: None, bg: None }, Run { text: "▄█████████▄", fg: Some("#4a79b8"), bg: None }, Run { text: "    ", fg: None, bg: None }],
    &[Run { text: "         ", fg: None, bg: None }, Run { text: "▄██████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀▀", fg: Some("#4a79b8"), bg: Some("#f5e7d3") }, Run { text: "█", fg: Some("#4a79b8"), bg: None }, Run { text: "▀▀", fg: Some("#4a79b8"), bg: Some("#f5e7d3") }, Run { text: "█", fg: Some("#f5e7d3"), bg: None }, Run { text: "█▄▄", fg: Some("#4a79b8"), bg: None }, Run { text: " ", fg: None, bg: None }],
    &[Run { text: "        ", fg: None, bg: None }, Run { text: "▄█████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#f5e7d3") }, Run { text: "███", fg: Some("#f5e7d3"), bg: None }, Run { text: "▀", fg: Some("#f5e7d3"), bg: Some("#e89645") }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#f5e7d3") }, Run { text: "█", fg: Some("#f5e7d3"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#e89645"), bg: None }, Run { text: "   ", fg: None, bg: None }],
    &[Run { text: "      ", fg: None, bg: None }, Run { text: "▄██████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#f5e7d3"), bg: Some("#4a79b8") }, Run { text: "███████", fg: Some("#f5e7d3"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "    ", fg: None, bg: None }, Run { text: "▄████████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#e89645") }, Run { text: "█", fg: Some("#e89645"), bg: None }, Run { text: "▀▀▀▀▀", fg: Some("#f5e7d3"), bg: Some("#e89645") }, Run { text: "█", fg: Some("#e89645"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "   ", fg: None, bg: None }, Run { text: "▄███████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀", fg: Some("#4a79b8"), bg: Some("#e89645") }, Run { text: "█████████", fg: Some("#e89645"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "▄█████", fg: Some("#4a79b8"), bg: None }, Run { text: "▀▀▀", fg: Some("#4a79b8"), bg: Some("#e89645") }, Run { text: "██████████▀", fg: Some("#e89645"), bg: None }, Run { text: "      ", fg: None, bg: None }],
    &[Run { text: "     ", fg: None, bg: None }, Run { text: "▀████████████▀", fg: Some("#e89645"), bg: None }, Run { text: "       ", fg: None, bg: None }],
    &[Run { text: "       ", fg: None, bg: None }, Run { text: "▀▀▀▀▀▀▀▀▀", fg: Some("#e89645"), bg: None }, Run { text: "          ", fg: None, bg: None }],
];

pub(crate) const LIGHT: &[Row] = &[
    &[Run { text: "            ", fg: None, bg: None }, Run { text: "▄▄██████▄", fg: Some("#142d52"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "          ", fg: None, bg: None }, Run { text: "▄██████", fg: Some("#142d52"), bg: None }, Run { text: "▀▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "█", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#fdf6ea") }, Run { text: "▄", fg: Some("#e08a3e"), bg: None }, Run { text: "   ", fg: None, bg: None }],
    &[Run { text: "         ", fg: None, bg: None }, Run { text: "█████", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#fdf6ea") }, Run { text: "██", fg: Some("#fdf6ea"), bg: None }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#17233b") }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#142d52") }, Run { text: "█", fg: Some("#fdf6ea"), bg: None }, Run { text: "▀", fg: Some("#fdf6ea"), bg: Some("#e08a3e") }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "▀", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#e08a3e"), bg: None }, Run { text: " ", fg: None, bg: None }],
    &[Run { text: "       ", fg: None, bg: None }, Run { text: "▄█████", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#fdf6ea") }, Run { text: "████", fg: Some("#fdf6ea"), bg: None }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#fdf6ea") }, Run { text: "██", fg: Some("#fdf6ea"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "     ", fg: None, bg: None }, Run { text: "▄███████", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#142d52") }, Run { text: "▀", fg: Some("#fdf6ea"), bg: Some("#e08a3e") }, Run { text: "█████", fg: Some("#fdf6ea"), bg: None }, Run { text: "▀", fg: Some("#fdf6ea"), bg: Some("#e08a3e") }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "    ", fg: None, bg: None }, Run { text: "████████", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "████████", fg: Some("#e08a3e"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: " ", fg: None, bg: None }, Run { text: "▄▄██████", fg: Some("#142d52"), bg: None }, Run { text: "▀▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "█████████▀", fg: Some("#e08a3e"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "▀▀▀▀▀", fg: Some("#142d52"), bg: None }, Run { text: "██████████████", fg: Some("#e08a3e"), bg: None }, Run { text: "       ", fg: None, bg: None }],
    &[Run { text: "      ", fg: None, bg: None }, Run { text: "▀█████████▀▀", fg: Some("#e08a3e"), bg: None }, Run { text: "        ", fg: None, bg: None }],
    &[Run { text: "        ", fg: None, bg: None }, Run { text: "▀▀▀▀▀▀", fg: Some("#e08a3e"), bg: None }, Run { text: "            ", fg: None, bg: None }],
];

pub(crate) const LIGHT_BLINK: &[Row] = &[
    &[Run { text: "              ", fg: None, bg: None }, Run { text: "▄▄▄▄▄▄", fg: Some("#142d52"), bg: None }, Run { text: "      ", fg: None, bg: None }],
    &[Run { text: "           ", fg: None, bg: None }, Run { text: "▄█████████▄", fg: Some("#142d52"), bg: None }, Run { text: "    ", fg: None, bg: None }],
    &[Run { text: "         ", fg: None, bg: None }, Run { text: "▄█████", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#fdf6ea") }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#fdf6ea") }, Run { text: "█", fg: Some("#e08a3e"), bg: None }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#fdf6ea") }, Run { text: "█", fg: Some("#fdf6ea"), bg: None }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#142d52") }, Run { text: "▄", fg: Some("#142d52"), bg: None }, Run { text: "▄", fg: Some("#e08a3e"), bg: None }, Run { text: " ", fg: None, bg: None }],
    &[Run { text: "        ", fg: None, bg: None }, Run { text: "▄████", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "▀", fg: Some("#e08a3e"), bg: Some("#fdf6ea") }, Run { text: "███", fg: Some("#fdf6ea"), bg: None }, Run { text: "▀", fg: Some("#fdf6ea"), bg: Some("#e08a3e") }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#fdf6ea") }, Run { text: "█", fg: Some("#fdf6ea"), bg: None }, Run { text: "▀▀", fg: Some("#e08a3e"), bg: None }, Run { text: "   ", fg: None, bg: None }],
    &[Run { text: "      ", fg: None, bg: None }, Run { text: "▄██████", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#fdf6ea"), bg: Some("#e08a3e") }, Run { text: "███████", fg: Some("#fdf6ea"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "    ", fg: None, bg: None }, Run { text: "▄████████", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "█", fg: Some("#e08a3e"), bg: None }, Run { text: "▀▀▀▀▀", fg: Some("#fdf6ea"), bg: Some("#e08a3e") }, Run { text: "█", fg: Some("#e08a3e"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "   ", fg: None, bg: None }, Run { text: "▄███████", fg: Some("#142d52"), bg: None }, Run { text: "▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "█████████", fg: Some("#e08a3e"), bg: None }, Run { text: "     ", fg: None, bg: None }],
    &[Run { text: "▄████", fg: Some("#142d52"), bg: None }, Run { text: "▀▀▀▀", fg: Some("#142d52"), bg: Some("#e08a3e") }, Run { text: "██████████▀", fg: Some("#e08a3e"), bg: None }, Run { text: "      ", fg: None, bg: None }],
    &[Run { text: "     ", fg: None, bg: None }, Run { text: "▀████████████▀", fg: Some("#e08a3e"), bg: None }, Run { text: "       ", fg: None, bg: None }],
    &[Run { text: "       ", fg: None, bg: None }, Run { text: "▀▀▀▀▀▀▀▀▀", fg: Some("#e08a3e"), bg: None }, Run { text: "          ", fg: None, bg: None }],
];

/// 这个主题、这一帧的画。
pub(crate) fn rows(light: bool, blink: bool) -> &'static [Row] {
    match (light, blink) {
        (false, false) => DARK,
        (false, true) => DARK_BLINK,
        (true, false) => LIGHT,
        (true, true) => LIGHT_BLINK,
    }
}

/// `#rrggbb` → `(r, g, b)`（画里只有这一种写法）。
pub(crate) fn rgb(hex: &str) -> (u8, u8, u8) {
    let value = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or_default();
    (
        ((value >> 16) & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        (value & 0xff) as u8,
    )
}

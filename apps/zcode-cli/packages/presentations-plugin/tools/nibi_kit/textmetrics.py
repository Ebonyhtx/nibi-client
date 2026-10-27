"""文字宽度测量：单元格里的字**真的放得下吗**。

## 为什么不能拍脑袋

Excel 的列宽单位是「默认字体里数字 0 的宽度」（简称字符宽，11pt Calibri 下约 7px@96dpi），
列宽 10 大约等于 75px。中文字形宽度 ≈ 字号，拉丁字母 ≈ 字号的一半，所以「列宽 10 能放几个
汉字」的正确答案是 75/16≈4.7 个（11pt=14.7px 高，汉字宽约等于字号 px），不是 10 个。
估算错了会同时放过真截断和误报正常格，所以这里用真实字体文件量宽（PIL.getlength）。

## 与 Excel 的实际行为对齐

* 文本溢出：右邻单元格为空时 Excel **允许**溢出不报错；右邻有内容才裁剪显示。
* 数字溢出：列宽不够时显示 `###`（引擎渲染的 PDF 文本里能直接抓到，作为经验判据）。
* 自动换行（wrap_text）时溢出会折行，不裁切，但行高不够就压字。

这些行为在 `spreadsheets` 插件的判据里逐条落实；本模块只负责量宽和折行数。
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from . import fonts

# Excel：列宽（字符）→ 像素。11pt Calibri 的数字宽 7px，故 px = round(w*7)+5（含两侧留白）。
CHAR_WIDTH_PX = 7.0
CELL_PADDING_PX = 5.0


@dataclass
class Measurement:
    text_width_px: float
    available_px: float
    overflow_px: float
    lines: int

    @property
    def fits(self) -> bool:
        return self.overflow_px <= 0.5


def column_width_px(width_chars: float) -> float:
    return round(width_chars * CHAR_WIDTH_PX) + CELL_PADDING_PX


@lru_cache(maxsize=64)
def _load_font(font_path: str, index: int, size_px: int):
    from PIL import ImageFont  # noqa: PLC0415

    return ImageFont.truetype(font_path, size_px, index=index)


def measure_text(text: str, family: str, size_pt: float, *, bold: bool = False) -> float:
    """文字像素宽度（按 96dpi 折算：1pt = 4/3 px）。字体缺失时按保守系数估算。"""
    if not text:
        return 0.0
    size_px = max(1, round(size_pt * 4 / 3))
    path = _font_path(family, bold)
    if path is None:
        return _fallback_width(text, size_px)
    try:
        font = _load_font(str(path), 0, size_px)
        return float(font.getlength(text))
    except (OSError, ValueError):
        return _fallback_width(text, size_px)


def _font_path(family: str, bold: bool) -> Path | None:
    if bold:
        for candidate in (f"{family} Bold", family):
            found = fonts.font_file(candidate)
            if found is not None:
                return found
    return fonts.font_file(family)


def _fallback_width(text: str, size_px: int) -> float:
    """没有字体文件时的保守估算：CJK/全角按 1.0 em，其余按 0.55 em（宁可误报不可放过）。"""
    width = 0.0
    for character in text:
        code = ord(character)
        full_width = (0x1100 <= code <= 0x115F or 0x2E80 <= code <= 0xA4CF
                      or 0xAC00 <= code <= 0xD7A3 or 0xF900 <= code <= 0xFAFF
                      or 0xFE30 <= code <= 0xFE4F or 0xFF00 <= code <= 0xFF60
                      or 0xFFE0 <= code <= 0xFFE6 or code >= 0x20000)
        width += size_px * (1.0 if full_width else 0.55)
    return width


def measure_cell(text: str, family: str, size_pt: float, width_chars: float, *,
                 bold: bool = False, wrap: bool = False) -> Measurement:
    available = column_width_px(width_chars) - 6.0  # 单元格内边距
    if wrap:
        lines = estimate_lines(text, family, size_pt, available, bold=bold)
        return Measurement(0.0, available, 0.0, lines)
    width = measure_text(text, family, size_pt, bold=bold)
    return Measurement(width, available, width - available, 1)


def estimate_lines(text: str, family: str, size_pt: float, available_px: float, *,
                   bold: bool = False) -> int:
    """自动换行下的行数估算（逐字符贪心折行，与 Excel 的折行行为近似）。"""
    if not text:
        return 1
    if available_px <= 4:
        return len(text)
    lines = 1
    current = 0.0
    for character in text:
        if character == "\n":
            lines += 1
            current = 0.0
            continue
        width = measure_text(character, family, size_pt, bold=bold)
        if current + width > available_px and current > 0:
            lines += 1
            current = width
        else:
            current += width
    return lines


def required_row_height_pt(lines: int, size_pt: float, padding_pt: float = 4.0) -> float:
    """容纳 `lines` 行所需的最小行高（点）。Excel 行高单位是点。"""
    return lines * size_pt * 1.32 + padding_pt


# ── 中文排版禁则（行首/行尾不该出现的标点）────────────────────────────────
# 两处共用同一份口径：pdf_gate 拿它当判据（行首收尾标点、行尾开引号），
# pdf_poster 拿它自己换行（reportlab 的 CJK 换行是"哪儿都能断"的 dumb algorithm，
# 实测断出过行首逗号：「（内部）\n，2026-07。」）。
# 只收中文标点：`)` `]` 这类英文写法在列表中合法，混进来会变成假阳性。
LINE_START_FORBIDDEN = "、。，．：；！？）】」』》〉〕…％‰℃°～"
LINE_END_FORBIDDEN = "（【「『《〈〔"

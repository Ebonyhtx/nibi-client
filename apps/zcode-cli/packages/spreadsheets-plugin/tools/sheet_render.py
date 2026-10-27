"""自渲染：没有 LibreOffice 时，按文件里的真实几何把表画成图（降级路径）。

## 它验得到什么、验不到什么（必须说清楚）

**验得到**：文件里写明的几何与文字 —— 字号、列宽、行高、合并、填充、边框、数字格式后的显示
文本、自动换行折行、以及「文本被右侧非空格裁掉」这类本地截断。
**验不到**：真引擎的排版细节 —— 字体替换、四舍五入后的实际宽度、分页位置、打印缩放。

所以自渲染的产物**不能当作视觉验收的最终依据**；它只是引擎缺席时的兜底，输出里会明确标注
`self-render（非真渲染）`。有引擎时一律走引擎。
"""

from __future__ import annotations

import math
from pathlib import Path

from nibi_kit import fonts, textmetrics

DEFAULT_ROW_HEIGHT_PT = 15.0
MAX_CANVAS_PX = 4200
GRID_COLOR = (222, 226, 230)
INK = (34, 37, 43)


def _px(value_pt: float) -> float:
    return value_pt * 96.0 / 72.0


def _argb(color) -> tuple[int, int, int] | None:
    if color is None:
        return None
    rgb = getattr(color, "rgb", None)
    if isinstance(rgb, str) and len(rgb) == 8 and rgb[:2].upper() in {"FF", "00"}:
        if rgb.upper() == "00000000":
            return None
        return tuple(int(rgb[index:index + 2], 16) for index in (2, 4, 6))  # type: ignore[return-value]
    if isinstance(rgb, str) and len(rgb) == 6:
        return tuple(int(rgb[index:index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
    return None


class SheetCanvas:
    """一张工作表的画布：把列宽/行高换算成像素坐标，并按需画格与字。"""

    def __init__(self, ws, default_width: float = 8.43):
        self.ws = ws
        self.default_width = default_width
        bounds = _content_bounds(ws)
        self.min_row, self.min_col, self.max_row, self.max_col = bounds or (1, 1, 20, 8)
        self.col_x: dict[int, float] = {}
        x = 0.0
        for column in range(self.min_col, self.max_col + 2):
            self.col_x[column] = x
            x += _column_px(ws, column, default_width)
        self.total_width = x
        self.row_y: dict[int, float] = {}
        y = 0.0
        for row in range(self.min_row, self.max_row + 2):
            self.row_y[row] = y
            y += _row_px(ws, row)
        self.total_height = y

    def cell_box(self, row: int, column: int) -> tuple[float, float, float, float]:
        merged = self._merge_of(row, column)
        if merged is not None:
            min_row, min_col, max_row, max_col = merged
            return (self.col_x[min_col], self.row_y[min_row],
                    self.col_x[max_col + 1], self.row_y[max_row + 1])
        return (self.col_x[column], self.row_y[row],
                self.col_x.get(column + 1, self.col_x[column] + 64),
                self.row_y.get(row + 1, self.row_y[row] + 20))

    def _merge_of(self, row: int, column: int):
        for merged in self.ws.merged_cells.ranges:
            if merged.min_row <= row <= merged.max_row and merged.min_col <= column <= merged.max_col:
                return merged.min_row, merged.min_col, merged.max_row, merged.max_col
        return None

    def clip_box(self, row: int, column: int) -> tuple[float, float]:
        """横向可见范围：右邻非空就裁在格内，否则允许溢出到空格区。"""
        merged = self._merge_of(row, column)
        if merged is not None:
            return self.col_x[merged[1]], self.col_x[merged[3] + 1]
        left = self.col_x[column]
        right = self.col_x.get(column + 1, left + 64)
        probe = column + 1
        while probe <= self.max_col + 1:
            cell = self.ws.cell(row=row, column=probe)
            if cell.value not in (None, ""):
                return left, right
            right = self.col_x.get(probe + 1, right + 64)
            probe += 1
        return left, right


def _content_bounds(ws):
    min_row = min_col = 10**9
    max_row = max_col = 0
    for row in ws.iter_rows():
        for cell in row:
            if cell.value not in (None, ""):
                min_row, max_row = min(min_row, cell.row), max(max_row, cell.row)
                min_col, max_col = min(min_col, cell.column), max(max_col, cell.column)
    if max_row == 0:
        return None
    return min_row, min_col, max_row, max_col


def _column_px(ws, column: int, default_width: float) -> float:
    from openpyxl.utils import get_column_letter  # noqa: PLC0415

    dimension = ws.column_dimensions.get(get_column_letter(column))
    if dimension is not None and dimension.hidden:
        return 0.0
    width = float(dimension.width) if (dimension is not None and dimension.width) else default_width
    return round(width * textmetrics.CHAR_WIDTH_PX) + textmetrics.CELL_PADDING_PX


def _row_px(ws, row: int) -> float:
    dimension = ws.row_dimensions.get(row)
    if dimension is not None and dimension.hidden:
        return 0.0
    height = float(dimension.height) if (dimension is not None and dimension.height) else DEFAULT_ROW_HEIGHT_PT
    return _px(height)


def render_sheet(ws, target: Path, *, default_width: float = 8.43, scale: float = 1.0,
                 cached: dict | None = None) -> Path:
    """渲染一张表。`cached` = {(row, col): value}，是公式的缓存值（来自 data_only 读回的另一份）。"""
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415

    canvas = SheetCanvas(ws, default_width)
    width = max(64, min(MAX_CANVAS_PX, math.ceil(canvas.total_width * scale)))
    height = max(64, min(MAX_CANVAS_PX, math.ceil(canvas.total_height * scale)))
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)

    def sx(value: float) -> float:
        return value * scale

    for row in range(canvas.min_row, canvas.max_row + 1):
        for column in range(canvas.min_col, canvas.max_col + 1):
            cell = ws.cell(row=row, column=column)
            box = canvas.cell_box(row, column)
            x0, y0, x1, y1 = (sx(value) for value in box)
            fill = _argb(cell.fill.fgColor) if cell.fill and cell.fill.fill_type else None
            if fill:
                draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=fill)
            draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=GRID_COLOR)
            _draw_borders(draw, cell, (x0, y0, x1, y1))
            if cell.value in (None, "") or canvas._merge_of(row, column) not in (None, (row, column, row, column)):
                continue
            _draw_text(draw, ImageFont, _cell_text(cell, ws, cached), cell, canvas, (x0, y0, x1, y1), scale)

    names = [item for item in ws.merged_cells.ranges]
    for merged in names:
        if merged.min_row < canvas.min_row or merged.min_col < canvas.min_col:
            continue
        box = canvas.cell_box(merged.min_row, merged.min_col)
        x0, y0, x1, y1 = (sx(value) for value in box)
        cell = ws.cell(row=merged.min_row, column=merged.min_col)
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=GRID_COLOR)
        if cell.value not in (None, ""):
            _draw_text(draw, ImageFont, _cell_text(cell, ws, cached), cell, canvas,
                       (x0, y0, x1, y1), scale)

    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target)
    return target


def _cell_text(cell, ws, cached: dict | None) -> str:
    """取单元格的显示文字：公式优先用缓存值（真值），没有缓存值才画 `=` 占位。"""
    if isinstance(cell.value, str) and cell.value.startswith("="):
        value = (cached or {}).get((cell.row, cell.column))
        if value is not None:
            return _display_value(value, cell.number_format or "")
        return "="  # 自渲染不计算公式：明确占位，真值看引擎路径
    return _display(cell, ws)


def _display_value(value, number_format: str) -> str:
    from xlsx_gate import display_preview  # noqa: PLC0415

    return display_preview(value, number_format)


def _display(cell, ws) -> str:
    from xlsx_gate import display_preview  # noqa: PLC0415

    return display_preview(cell.value, cell.number_format or "")


def _draw_borders(draw, cell, box) -> None:
    x0, y0, x1, y1 = box
    edges = {"top": ((x0, y0), (x1, y0)), "bottom": ((x0, y1 - 1), (x1, y1 - 1)),
             "left": ((x0, y0), (x0, y1)), "right": ((x1 - 1, y0), (x1 - 1, y1))}
    for name, line in edges.items():
        side = getattr(cell.border, name, None)
        if side is not None and side.style:
            color = _argb(side.color) or (90, 96, 114)
            draw.line(line, fill=color, width=1)


def _draw_text(draw, ImageFont, text: str, cell, canvas: SheetCanvas, box, scale: float) -> None:
    if not text:
        return
    size_pt = float(cell.font.size or 11.0)
    size_px = max(6, round(_px(size_pt) * scale))
    path = fonts.font_file(cell.font.name or "微软雅黑")
    engine_path = fonts.font_file(f"{cell.font.name} Bold") if cell.font.bold else path
    try:
        font = ImageFont.truetype(str(engine_path or path), size_px)
    except (OSError, TypeError):
        font = ImageFont.load_default()
    color = _argb(cell.font.color) or INK
    x0, y0, x1, y1 = box
    horizontal = (cell.alignment.horizontal if cell.alignment else None) or (
        "right" if isinstance(cell.value, (int, float)) and not isinstance(cell.value, bool) else "left")
    # 溢出方向跟着对齐走：左对齐向右溢出、右对齐向左溢出、居中不溢出。
    # 曾统一"向右延伸到空格区"，结果右对齐的表头文字被推到画面外，整格看起来是空的。
    clip_left, clip_right = canvas.clip_box(cell.row, cell.column)
    if horizontal == "right":
        left, right = clip_left, x1
    elif horizontal == "center":
        left, right = x0, x1
    else:
        left, right = x0, clip_right
    left, right = left * scale, right * scale
    available = max(8.0, right - left - 6)
    lines = _wrap(text, font, available, draw, bool(cell.alignment and cell.alignment.wrap_text))
    line_height = size_px * 1.32
    total_height = line_height * len(lines)
    start_y = y0 + (y1 - y0 - total_height) / 2 if (cell.alignment is None
                                                    or cell.alignment.vertical in (None, "center")) \
        else y0 + 2
    for index, line in enumerate(lines):
        line_width = draw.textlength(line, font=font)
        if horizontal == "center":
            x = left + (right - left - line_width) / 2
        elif horizontal == "right":
            x = right - line_width - 3
        else:
            x = left + 3
        draw.text((x, start_y + index * line_height), line, font=font, fill=color)


def _wrap(text: str, font, available: float, draw, wrap: bool) -> list[str]:
    """折行规则与 Excel 对齐：**只有开了自动换行才折**。

    没开自动换行的单元格，Excel 是溢出（或按裁剪规则显示），不会自己折到下一行；
    自渲染里给它折行会让文字画到下一行去（压住别的内容，看起来像两个数叠在一起）。
    """
    if not wrap:
        return str(text).split("\n")
    lines: list[str] = []
    for paragraph in str(text).split("\n"):
        current = ""
        for character in paragraph:
            if draw.textlength(current + character, font=font) > available and current:
                lines.append(current)
                current = character
            else:
                current += character
        lines.append(current)
    return lines or [""]

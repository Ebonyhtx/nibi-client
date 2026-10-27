"""版面几何判据：把"这张图看着空/两栏不齐"变成能算的数。

## 为什么要有它（一次真事故）

一份 A2 海报过了我们 8 条印前判据全绿（尺寸、字体嵌入、贴边、空白页、文字图层、卫生、结构、
渲染），但视觉验收判它 **fail**：左栏在页高 52% 处就没内容了，右栏却拉到 68%，两栏底差 16%，
中间还各留数十毫米的空洞，整页"上重下空"。原来的 8 条判据全是**存在性检查**
（有没有、嵌没嵌、贴没贴边），**没有一条管版面几何** —— 而海报最要紧的恰恰是几何。

## 判据（只对大版面生效）

海报与书籍/报告不同：大版面上出现"半页空白/两栏不齐"基本总是缺陷，而 A4 报告封面页的空白
是正常设计。所以这组判据默认只在**大版面**（面积 ≥ A3）上跑，可用 `--layout` 强制、
`--no-layout` 关掉。

| 码 | 判据 | 阈值（占页高比例） |
| --- | --- | --- |
| `layout-fill` | 内容纵向填充率（首末内容行跨度） | <80% 告警、<65% 失败 |
| `large-blank-band` | 内容区内部最大空白带 | >8% 告警、>12% 失败 |
| `column-bottom-ragged` | 各栏底部（末内容行）的高度差 | >8% 告警、>15% 失败 |
| `column-void` | 单栏内部最大空白带 | >10% 告警、>18% 失败 |

## 四个实测踩过的坑（都在这里被修正）

1. **"空白"要按行算，不能按像素算**：一行文字里有大量字间空白，按像素算一条正文带也有
   85% 白 → 会把整页都当成"空白槽"。所以先用一张粗网格（200×160 格）判"这一格里有没有内容"，
   再在网格上按**行/列**统计。
2. **二值掩膜的极性**：`point(..., mode="1")` 把"暗像素"映射成 255，于是 255 = 内容、0 = 空白；
   搞反过一次，量出来的是内容占比，栏槽永远找不到。
3. **浅色设计底色不算内容**：实测海报的面板底色是浅米色（灰度 238–240），阈值取 240 会把
   底色当内容（每条 x 条带都"有内容"）。取 200：只留深色的字/线/块。
4. **通栏元素要剔除**：页脚/标题横条横穿栏槽，会让两栏的"末内容行"都变成页脚底 ——
   分栏底对齐判据就永远测不出差异。所以先找栏槽、再把"有内容横穿栏槽"的行段剥掉当正文区。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

CONTENT_LEVEL = 200      # 灰度 < 200 才算"内容"（字、深色块）
STRUCTURE_LEVEL = 250    # 灰度 < 250 算"结构"（含浅色面板底：分栏要靠面板边界才量得准）
GRID_COLS = 200          # 粗网格列数
GRID_ROWS = 160          # 粗网格行数
GUTTER_BLANK_RATIO = 0.7  # 栏槽：该 x 段里 ≥70% 的行没有内容
MIN_GUTTER_RATIO = 0.008  # 栏槽宽度 ≥ 页宽 0.8% 才算分栏（实测海报中缝只有 1–2%）
MIN_COLUMN_RATIO = 0.06   # 窄于页宽 6% 的条不算栏

FILL_WARN, FILL_FAIL = 0.80, 0.65
BAND_WARN, BAND_FAIL = 0.08, 0.12
RAGGED_WARN, RAGGED_FAIL = 0.08, 0.15
VOID_WARN, VOID_FAIL = 0.10, 0.18


@dataclass
class Band:
    start_ratio: float
    length_ratio: float


@dataclass
class ColumnInfo:
    index: int
    x0_ratio: float
    x1_ratio: float
    bottom_ratio: float
    largest_void: Band


@dataclass
class LayoutMeasurement:
    page_index: int
    width_mm: float
    height_mm: float
    fill_ratio: float
    largest_band: Band
    columns: list[ColumnInfo] = field(default_factory=list)
    body_ratio: float = 1.0      # 正文区占页高比例（剥掉通栏标题/页脚之后）
    gutter_count: int = 0


def is_large_format(width_mm: float, height_mm: float, min_mm: float = 296.5,
                    min_area_mm2: float = 123_000.0) -> bool:
    """大版面 = 短边 ≥ A4 长边 且面积 ≥ A3。海报/展板走这条，报告不走。

    阈值留了 0.5mm / 1% 面积容差：A3 的 pt 值换算成毫米是 296.9994mm，
    写成"≥297"会把 A3 本体判在大版面之外（实测踩过：A3 样张被整条跳过）。
    """
    short, long = sorted((width_mm, height_mm))
    return short >= min_mm and short * long >= min_area_mm2


def _ink_mask(image_path: Path, level: int = CONTENT_LEVEL) -> Image.Image | None:
    """二值掩膜：暗于 level 的像素 = 255、其余 = 0（所以 getbbox() 就是内容框）。

    两档阈值各有各的用途（实测分开之前，一栏里的短文本会被切成"4 栏"）：
    * **内容**（200）：字与深色块 —— 填充率、空白带、栏底、空洞都用它；
    * **结构**（250，含浅色面板底）：用来切栏 —— 面板的浅色底是"这一栏到哪儿"的真实边界，
      按内容切会把"文本只有半栏宽"的海报切出一堆假栏。
    """
    image = Image.open(image_path).convert("L")
    mask = image.point(lambda value: 255 if value < level else 0, mode="1")
    return mask if mask.getbbox() else None


def _has_ink(binary: Image.Image, box: tuple[int, int, int, int]) -> bool:
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        return False
    return binary.crop(box).getbbox() is not None


def _grid(binary: Image.Image, x0: int, y0: int, x1: int, y1: int) -> list[list[bool]]:
    """粗网格：格子里有没有内容。所有"按行/按列"的统计都建在它上面。"""
    x_step = max(1, (x1 - x0) // GRID_COLS)
    y_step = max(1, (y1 - y0) // GRID_ROWS)
    grid: list[list[bool]] = []
    y = y0
    while y < y1:
        row: list[bool] = []
        x = x0
        while x < x1:
            row.append(_has_ink(binary, (x, y, min(x + x_step, x1), min(y + y_step, y1))))
            x += x_step
        grid.append(row)
        y += y_step
    return grid


def _largest_blank_band(binary: Image.Image, x0: int, y0: int, x1: int, y1: int) -> tuple[int, int]:
    """[y0,y1) 内最长的连续"整行无内容"段，返回 (起点, 长度)。粗扫 + 逐像素细化。"""
    height = y1 - y0
    if height <= 0:
        return y0, 0
    step = max(1, height // 120)
    runs: list[tuple[int, int]] = []
    start: int | None = None
    y = y0
    while y < y1:
        end = min(y + step, y1)
        if not _has_ink(binary, (x0, y, x1, end)):
            start = y if start is None else start
        elif start is not None:
            runs.append((start, y))
            start = None
        y = end
    if start is not None:
        runs.append((start, y1))
    if not runs:
        return y0, 0
    coarse_start, coarse_end = max(runs, key=lambda run: run[1] - run[0])
    top = coarse_start
    while top - 1 >= y0 and not _has_ink(binary, (x0, top - 1, x1, top)):
        top -= 1
    bottom = coarse_end
    while bottom + 1 <= y1 and not _has_ink(binary, (x0, bottom, x1, bottom + 1)):
        bottom += 1
    return top, bottom - top


def _group(indexes: list[int]) -> list[tuple[int, int]]:
    groups: list[tuple[int, int]] = []
    for index in indexes:
        if groups and index == groups[-1][1]:
            groups[-1] = (groups[-1][0], index + 1)
        else:
            groups.append((index, index + 1))
    return groups


def _layout_analysis(binary: Image.Image, content: tuple[int, int, int, int],
                     width: int, height: int,
                     ) -> tuple[tuple[int, int], tuple[int, int], list[tuple[int, int]], int]:
    """返回（正文行段, 分栏测量用行段, 各栏 x 段, 栏槽数）。栅格一次算完，栏槽/通栏段都从它读。"""
    x0, y0, x1, y1 = content
    grid = _grid(binary, x0, y0, x1, y1)
    if not grid or not grid[0]:
        return (y0, y1), [], 0
    rows = len(grid)
    cols = len(grid[0])
    x_step = max(1, (x1 - x0) // GRID_COLS)
    y_step = max(1, (y1 - y0) // GRID_ROWS)
    min_gutter_cells = max(1, int(width * MIN_GUTTER_RATIO / max(1, x_step)))

    # 栏槽：该列里存在一条"贯通的高空白带"。
    # 判据必须是**连续**空白，不能只看占比：正文里的字与行间空白让任意一条 x 列也有 70% 的行没内容
    # （实测：文字列的空白行是**散**的，最长连续空白只有几个行距；真正的栏槽则从标题底一直空到页脚顶）。
    longest_blank: list[tuple[int, int, int]] = []   # (长度, 起始行, 结束行)
    for index in range(cols):
        best, best_start, best_end = 0, 0, 0
        run, run_start = 0, 0
        for row in range(rows):
            if grid[row][index]:
                run = 0
            else:
                if run == 0:
                    run_start = row
                run += 1
                if run > best:
                    best, best_start, best_end = run, run_start, row + 1
        longest_blank.append((best, best_start, best_end))
    blank_columns = [index for index in range(cols)
                     if longest_blank[index][0] / rows >= GUTTER_BLANK_RATIO]
    gutter_groups = [group for group in _group(blank_columns)
                     if group[1] - group[0] >= min_gutter_cells]

    # 正文行段 = **最宽那条栏槽的贯通空白段**。
    # 为什么不"剥掉通栏行段"：页脚常常只占页面一侧（实测：页脚在左下角，横不过栏槽），
    # 于是它就落在左栏的 x 范围里，左栏的"末内容行"变成页脚底 —— 分栏底对齐永远量不对。
    # 栏槽的贯通空白段天然把头（标题）尾（页脚）都排除在外。
    body_cells: tuple[int, int] | None = None
    if gutter_groups:
        widest = max(gutter_groups, key=lambda group: group[1] - group[0])
        middle = (widest[0] + widest[1]) // 2
        length, start, end = longest_blank[middle]
        body_cells = (start, end)
    if body_cells is None:
        body = (y0, y1)
    else:
        body = (y0 + body_cells[0] * y_step, min(y0 + body_cells[1] * y_step, y1))
    if body[1] - body[0] < (y1 - y0) * 0.35:
        body = (y0, y1)

    # 再去掉"整行几乎都是内容"的行段里的**最后一段**（通栏分隔线/页脚）。
    # 为什么还要这一步：页脚常常只占页面一侧（实测在左下角），既横不过栏槽、又落在左栏的 x 范围里，
    # 于是左栏的"末内容行"变成页脚底。有通栏分隔线时用它把页脚切出去；没有时只能让它留着。
    full_rows = [index for index in range(rows) if sum(grid[index]) >= 0.8 * cols]
    if full_rows:
        last_start, _last_end = _group(full_rows)[-1]
        cut = y0 + last_start * y_step
        if cut > (body[0] + body[1]) / 2:
            body = (body[0], cut)

    # 分栏测量专用的下边界：把**尾部孤立的薄内容带**（页脚、脚注、页码行）排除掉。
    # 判据：与上一条内容带之间隔着 ≥8% 页高的空白，且自身厚度 ≤4% 页高 —— 典型的页脚形态
    # （实测：页脚在左下角，左栏因此被判成"内容到 97%"，其实正文 58% 就结束了）。
    column_body = body
    body_rows_start = max(0, (body[0] - y0) // y_step)
    body_rows_end = min(rows, (body[1] - y0) // y_step)
    ink_bands = _group([index for index in range(body_rows_start, body_rows_end)
                        if sum(grid[index]) > 0])
    if len(ink_bands) >= 2:
        last_start, last_end = ink_bands[-1]
        previous_end = ink_bands[-2][1]
        thin = (last_end - last_start) <= rows * 0.04
        isolated = (last_start - previous_end) >= rows * 0.08
        if thin and isolated:
            column_body = (body[0], y0 + last_start * y_step)

    # 各栏 x 段：栏槽之间的区域
    columns: list[tuple[int, int]] = []
    cursor_x = x0
    for start, end in gutter_groups:
        gx0 = x0 + start * x_step
        gx1 = min(x0 + end * x_step, x1)
        if gx0 - cursor_x >= width * MIN_COLUMN_RATIO:
            columns.append((cursor_x, gx0))
        cursor_x = max(cursor_x, gx1)
    if x1 - cursor_x >= width * MIN_COLUMN_RATIO:
        columns.append((cursor_x, x1))
    return body, column_body, columns, len(gutter_groups)


def measure_page(image_path: Path, width_mm: float, height_mm: float,
                 page_index: int) -> LayoutMeasurement | None:
    content_mask = _ink_mask(image_path, CONTENT_LEVEL)
    if content_mask is None:
        return None
    # 结构掩膜只管切栏（栏槽、正文行段、栏的 x 范围）；所有"空不空"的度量都用内容掩膜。
    structure_mask = _ink_mask(image_path, STRUCTURE_LEVEL) or content_mask
    width, height = content_mask.size
    box = content_mask.getbbox()
    assert box is not None
    content = (box[0], box[1], box[2], box[3])
    span = max(1, content[3] - content[1])
    fill_ratio = span / height
    band_start, band_length = _largest_blank_band(content_mask, content[0], content[1],
                                                  content[2], content[3])
    largest = Band(start_ratio=(band_start - content[1]) / span, length_ratio=band_length / height)
    body, column_body, column_ranges, gutter_count = _layout_analysis(
        structure_mask, content, width, height)
    columns: list[ColumnInfo] = []
    for index, (x0, x1) in enumerate(column_ranges, start=1):
        column_box = content_mask.crop((x0, column_body[0], x1, column_body[1])).getbbox()
        if column_box is None:
            continue
        top = column_body[0] + column_box[1]
        bottom = column_body[0] + column_box[3]
        # 空洞只算**栏内**的（首末内容之间）：末内容之后的空白是"栏没填满"，
        # 那是 column-bottom-ragged 与 large-blank-band 负责的，重复报一次只会淹掉真信号。
        void_start, void_length = _largest_blank_band(content_mask, x0, top, x1, bottom)
        columns.append(ColumnInfo(
            index=index,
            x0_ratio=x0 / width,
            x1_ratio=x1 / width,
            bottom_ratio=bottom / height,
            largest_void=Band(start_ratio=(void_start - top) / max(1, bottom - top),
                              length_ratio=void_length / height),
        ))
    return LayoutMeasurement(page_index=page_index, width_mm=width_mm, height_mm=height_mm,
                             fill_ratio=fill_ratio, largest_band=largest, columns=columns,
                             body_ratio=(body[1] - body[0]) / height, gutter_count=gutter_count)


def check(measurement: LayoutMeasurement, gate) -> None:
    """把测量结果转成判据结论（阈值集中在这里，便于对照调参）。"""
    pages = f"第 {measurement.page_index} 页"
    gate.checked += 1
    if measurement.fill_ratio < FILL_FAIL:
        gate.fail("layout-fill",
                  f"内容纵向填充率仅 {measurement.fill_ratio * 100:.0f}%（大版面出现大面积留白）",
                  pages)
    elif measurement.fill_ratio < FILL_WARN:
        gate.warn("layout-fill", f"内容纵向填充率 {measurement.fill_ratio * 100:.0f}% 偏低（大版面）",
                  pages)
    band_mm = measurement.largest_band.length_ratio * measurement.height_mm
    if measurement.largest_band.length_ratio > BAND_FAIL:
        gate.fail("large-blank-band",
                  f"内容区中间有 {measurement.largest_band.length_ratio * 100:.0f}% 页高"
                  f"（约 {band_mm:.0f}mm）的连续空白带，位置在内容区 "
                  f"{measurement.largest_band.start_ratio * 100:.0f}% 处", pages)
    elif measurement.largest_band.length_ratio > BAND_WARN:
        gate.warn("large-blank-band",
                  f"内容区中间有 {measurement.largest_band.length_ratio * 100:.0f}% 页高"
                  f"（约 {band_mm:.0f}mm）的空白带", pages)
    if len(measurement.columns) >= 2:
        gate.checked += len(measurement.columns)
        bottoms = [column.bottom_ratio for column in measurement.columns]
        spread = max(bottoms) - min(bottoms)
        detail = "、".join(f"第 {column.index} 栏到 {column.bottom_ratio * 100:.0f}%"
                           for column in measurement.columns)
        if spread > RAGGED_FAIL:
            gate.fail("column-bottom-ragged",
                      f"各栏底部相差 {spread * 100:.0f}% 页高（两栏明显不齐）：{detail}", pages)
        elif spread > RAGGED_WARN:
            gate.warn("column-bottom-ragged", f"各栏底部相差 {spread * 100:.0f}% 页高：{detail}", pages)
        worst = max(measurement.columns, key=lambda column: column.largest_void.length_ratio)
        if worst.largest_void.length_ratio > VOID_FAIL:
            gate.fail("column-void",
                      f"第 {worst.index} 栏内部有 {worst.largest_void.length_ratio * 100:.0f}% 页高的空洞",
                      pages)
        elif worst.largest_void.length_ratio > VOID_WARN:
            gate.warn("column-void",
                      f"第 {worst.index} 栏内部有 {worst.largest_void.length_ratio * 100:.0f}% 页高的空洞",
                      pages)


def describe(measurement: LayoutMeasurement) -> str:
    columns = (f"，{len(measurement.columns)} 栏（{measurement.gutter_count} 条栏槽）"
               if measurement.columns else "，未识别出分栏")
    return (f"第 {measurement.page_index} 页 {measurement.width_mm:.0f}×{measurement.height_mm:.0f}mm："
            f"填充 {measurement.fill_ratio * 100:.0f}%、最大空白带 "
            f"{measurement.largest_band.length_ratio * 100:.0f}%、正文区占页高 "
            f"{measurement.body_ratio * 100:.0f}%{columns}")

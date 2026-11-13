"""把 JSON 规格落成 .xlsx（openpyxl）。

用法：
    python tools/xlsx_build.py --spec 表.json --out 交付/结果表.xlsx [--json]
    python tools/xlsx_build.py --spec 表.json --out 结果.xlsx --no-autofit

设计要点（都是实测踩出来的）：

* **列宽按真实文字宽度算**，不按字符数猜 —— 中文列宽按字符数估会短一半，交付件里就是
  一列 `###`。`--no-autofit` 只在规格里逐列给了宽度且你确定要保留时使用。
* **数字格式必须显式**：规格里 `"format": "num2"`；漏给时按值类型给保守默认（整数 → `#,##0`），
  并让质量门去报「占比列没设百分比」这类语义漏配。
* **核心属性脱敏**：作者/最后修改者写成中性值，创建时间清空 —— 交付件不该带本机痕迹。
* **打印设置默认就绪**：横向/纵向、按宽缩放到一页、重复标题行、页脚页码，规格里可覆盖。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, hygiene, textmetrics  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

import xlsx_spec as spec_mod  # noqa: E402

require_modules(["openpyxl", "PIL"], "xlsx_build（openpyxl + pillow）")

from openpyxl import Workbook  # noqa: E402
from openpyxl.chart import BarChart, DoughnutChart, LineChart, PieChart, Reference  # noqa: E402
from openpyxl.chart.series import SeriesLabel  # noqa: E402
from openpyxl.comments import Comment  # noqa: E402
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule, DataBarRule  # noqa: E402
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402
from openpyxl.worksheet.datavalidation import DataValidation  # noqa: E402
from openpyxl.worksheet.properties import PageSetupProperties  # noqa: E402

SERIES_COLORS = ("1E3A5F", "E98A3C", "35597F", "C0392B", "1E7B4F", "8A8F9C", "F5C08A", "16304F")


class BuildError(RuntimeError):
    pass


# ---------------------------------------------------------------- 样式解析


class StyleLibrary:
    def __init__(self, palette_name: str, default_family: str, default_size: float,
                 overrides: dict | None = None):
        self.palette = spec_mod.palette(palette_name)
        self.default_family = default_family
        self.default_size = default_size
        self.styles = {name: dict(value) for name, value in spec_mod.BASE_STYLES.items()}
        for name, definition in (overrides or {}).items():
            self.styles[name] = definition

    def color(self, name: str) -> str:
        text = str(name or "").strip()
        if text.startswith("#"):
            return text[1:].upper()
        if text in self.palette:
            return self.palette[text]
        raise spec_mod.SpecError(f"未知颜色名：{name}")

    def resolve(self, name: str, extra: dict | None = None) -> "ResolvedStyle":
        if not name:
            definition: dict = {}
        elif name in self.styles:
            definition = self.styles[name]
        else:
            raise spec_mod.SpecError(f"未知样式名：{name}（可用：{'、'.join(sorted(self.styles))}）")
        if extra:
            definition = _merge(definition, extra)
        return self._build(definition)

    def _build(self, definition: dict) -> "ResolvedStyle":
        font_def = definition.get("font", {})
        font = Font(
            name=font_def.get("name", self.default_family),
            size=float(font_def.get("size", self.default_size)),
            bold=bool(font_def.get("bold", False)),
            italic=bool(font_def.get("italic", False)),
            color=self.color(font_def["color"]) if font_def.get("color") else None,
            underline=font_def.get("underline"),
        )
        fill_name = definition.get("fill")
        fill = PatternFill("solid", fgColor=self.color(fill_name)) if fill_name else None
        border_def = definition.get("border")
        border = None
        if border_def:
            edges = spec_mod.BORDER_STYLES.get(border_def) if isinstance(border_def, str) else border_def
            if edges is None:
                raise spec_mod.SpecError(f"未知边框名：{border_def}")
            line = "D8D2C4"
            border = Border(**{edge: Side(style=value.get("style", "thin"),
                                         color=value.get("color", line))
                               for edge, value in edges.items()})
        align_def = definition.get("alignment", {})
        align_kwargs = {"horizontal": align_def.get("horizontal"),
                        "vertical": align_def.get("vertical", "center"),
                        "wrap_text": bool(align_def.get("wrap_text", False))}
        if align_def.get("indent") is not None:
            # openpyxl 的 indent 只接受数值；传 None 会 TypeError（其他字段允许 None）。
            align_kwargs["indent"] = float(align_def["indent"])
        alignment = Alignment(**align_kwargs)
        return ResolvedStyle(font=font, fill=fill, border=border, alignment=alignment,
                             number_format=spec_mod.normalize_number_format(
                                 definition.get("number_format", "")))


class ResolvedStyle:
    __slots__ = ("font", "fill", "border", "alignment", "number_format")

    def __init__(self, font, fill, border, alignment, number_format):
        self.font = font
        self.fill = fill
        self.border = border
        self.alignment = alignment
        self.number_format = number_format


def _merge(base: dict, extra: dict) -> dict:
    merged = {key: (dict(value) if isinstance(value, dict) else value) for key, value in base.items()}
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key].update(value)
        else:
            merged[key] = value
    return merged


# ---------------------------------------------------------------- 值处理


def maybe_datetime(value, number_format: str):
    """日期语义的列：把 ISO 字符串转成真日期单元格（否则排序/筛选/图表都会把它当文本）。"""
    if not isinstance(value, str) or not value.strip():
        return value
    if number_format not in {"yyyy-mm-dd", "yyyy-mm-dd hh:mm", "yyyy-mm"}:
        return value
    text = value.strip().replace("/", "-").replace("年", "-").replace("月", "-").replace("日", "")
    try:
        if number_format == "yyyy-mm" and len(text) == 7:
            return dt.datetime.strptime(text, "%Y-%m")
        return dt.datetime.fromisoformat(text)
    except ValueError:
        return value


def apply_value(cell, cell_spec: spec_mod.CellSpec) -> None:
    if cell_spec.formula:
        cell.value = cell_spec.formula
        return
    cell.value = maybe_datetime(cell_spec.value, cell_spec.number_format)


def default_format_for(value) -> str:
    if isinstance(value, bool):
        return ""
    if isinstance(value, (dt.datetime, dt.date)):
        return "yyyy-mm-dd"
    if isinstance(value, int):
        return "#,##0"
    if isinstance(value, float):
        return "#,##0.00"
    return ""


# ---------------------------------------------------------------- 列宽


def apply_explicit_widths(ws, columns_meta: list[dict]) -> int:
    """把规格里逐列给的宽度写进工作表（`autofit` 只会跳过这些列，不会替它们写值）。"""
    applied = 0
    for index, meta in enumerate(columns_meta, start=1):
        width = meta.get("width")
        if isinstance(width, (int, float)) and width > 0:
            ws.column_dimensions[get_column_letter(index)].width = float(width)
            applied += 1
    return applied


def header_row_height(ws, table: dict, library: StyleLibrary, default: float = 24.0) -> float:
    """表头行高按「折行后实际需要的高度」给：列宽不够时表头会折行，固定 24pt 会压字。"""
    start_row, start_col = spec_mod.parse_ref(table["start"])
    resolved = library.resolve(table.get("headerStyle", "tableHeader"))
    needed = default
    for offset, text in enumerate(table["header"]):
        column = start_col + offset
        letter = get_column_letter(column)
        dimension = ws.column_dimensions.get(letter)
        width = float(dimension.width) if (dimension is not None and dimension.width) else 8.43
        available = textmetrics.column_width_px(width) - 8
        lines = textmetrics.estimate_lines(str(text), resolved.font.name or library.default_family,
                                           resolved.font.size, available, bold=True)
        needed = max(needed, textmetrics.required_row_height_pt(lines, resolved.font.size))
    return round(needed + 2, 1)


def autofit_columns(ws, tables: list[dict], library: StyleLibrary, columns_meta: list[dict]) -> None:
    """按内容实测宽度设列宽：表头按最长词封顶（让它折行），数据/脚注按真实宽度。

    注意 `tables` 收到的是**规格里的原始表块**（键名是 start/bodyStyle 那种写法），
    不是 `write_table` 的返回值 —— 两边的键名体系不同，别混用。
    """
    widths: dict[int, float] = {}
    for table in tables:
        start_col = spec_mod.parse_ref(table["start"])[1]
        body_style = table["body_style"]
        for column_index, text in enumerate(table["header"], start=start_col):
            measured = textmetrics.measure_text(str(text), library.default_family, library.default_size,
                                                bold=True)
            chars = (measured + 12) / textmetrics.CHAR_WIDTH_PX
            widths[column_index] = max(widths.get(column_index, 0.0), min(chars, 16.0))
        for row_index, row in enumerate(table["rows"], start=table["start_row"] + 1):
            raw_cells = row if isinstance(row, list) else row.get("cells", [])
            for offset, item in enumerate(raw_cells):
                cell_spec = spec_mod.coerce_cell(item)
                if cell_spec.is_empty():
                    continue
                column_index = table["start_col"] + offset
                text = _display_text(cell_spec.value if not cell_spec.formula else _formula_preview(cell_spec))
                resolved = library.resolve(cell_spec.style or table["body_style"])
                measured = textmetrics.measure_text(text, library.default_family, resolved.font.size,
                                                    bold=bool(resolved.font.bold))
                chars = (measured + 12) / textmetrics.CHAR_WIDTH_PX
                widths[column_index] = max(widths.get(column_index, 0.0), chars)
    for column_index, width in widths.items():
        explicit = columns_meta[column_index - 1].get("width") if column_index - 1 < len(columns_meta) else None
        if isinstance(explicit, (int, float)) and explicit > 0:
            continue
        ws.column_dimensions[get_column_letter(column_index)].width = round(min(max(width, 7.0), 46.0), 1)


def _display_text(value) -> str:
    if isinstance(value, (dt.datetime, dt.date)):
        return "0000-00-00"
    if isinstance(value, float):
        return f"{value:,.2f}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def _formula_preview(cell_spec: spec_mod.CellSpec) -> str:
    return "=########"


# ---------------------------------------------------------------- 表块


def write_table(ws, table: dict, library: StyleLibrary) -> dict:
    start_row, start_col = spec_mod.parse_ref(table["start"])
    header_style = table.get("headerStyle", "tableHeader")
    body_style = table.get("bodyStyle", "tableBody")
    alt_style = table.get("altStyle", "tableBodyAlt")
    zebra = bool(table.get("zebra", True))
    formats = [spec_mod.normalize_number_format(item) for item in table.get("formats", [])]

    for offset, text in enumerate(table["header"]):
        cell = ws.cell(row=start_row, column=start_col + offset, value=str(text))
        resolved = library.resolve(header_style)
        resolved.alignment = Alignment(horizontal=column_horizontal(table, offset, formats),
                                       vertical="center", wrap_text=True)
        _apply_style(cell, resolved)
    if table.get("headerHeight"):
        ws.row_dimensions[start_row].height = float(table["headerHeight"])

    body_rows: list[list[spec_mod.CellSpec]] = []
    for row_index, raw_row in enumerate(table["rows"]):
        row_spec = raw_row if isinstance(raw_row, dict) else {"cells": raw_row}
        cells = [spec_mod.coerce_cell(item,
                                      default_format=formats[offset] if offset < len(formats) else "")
                 for offset, item in enumerate(row_spec.get("cells", []))]
        body_rows.append(cells)
        target_row = start_row + 1 + row_index
        for offset, cell_spec in enumerate(cells):
            cell = ws.cell(row=target_row, column=start_col + offset)
            apply_value(cell, cell_spec)
            style_name = cell_spec.style or (alt_style if (zebra and row_index % 2 == 1) else body_style)
            resolved = library.resolve(style_name, cell_spec.extra_style or None)
            _apply_style(cell, resolved)
            number_format = cell_spec.number_format or (
                formats[offset] if offset < len(formats) else "auto")
            if number_format == "auto":
                number_format = default_format_for(cell.value)
            cell.number_format = number_format or "General"
            if cell_spec.comment:
                cell.comment = Comment(cell_spec.comment, "NIBI")
            if cell_spec.hyperlink:
                cell.hyperlink = cell_spec.hyperlink
                cell.font = Font(name=resolved.font.name, size=resolved.font.size,
                                 color="1E3A5F", underline="single")
        if row_spec.get("height"):
            ws.row_dimensions[target_row].height = float(row_spec["height"])

    total_row = table.get("totalRow")
    if total_row:
        target_row = start_row + 1 + len(body_rows)
        for offset, raw in enumerate(total_row):
            cell_spec = spec_mod.coerce_cell(raw, default_style=table.get("totalStyle", "totalRow"),
                                             default_format=formats[offset] if offset < len(formats) else "")
            cell = ws.cell(row=target_row, column=start_col + offset)
            apply_value(cell, cell_spec)
            resolved = library.resolve(cell_spec.style, cell_spec.extra_style or None)
            _apply_style(cell, resolved)
            number_format = cell_spec.number_format or (formats[offset] if offset < len(formats) else "auto")
            if number_format == "auto":
                number_format = default_format_for(cell.value) if not cell_spec.formula else "General"
            cell.number_format = number_format or "General"
        ws.row_dimensions[target_row].height = 22

    return {"start_row": start_row, "start_col": start_col, "header": table["header"],
            "rows": body_rows, "body_style": body_style, "alt_style": alt_style,
            "zebra": zebra, "formats": formats, "total_row": start_row + 1 + len(body_rows) if total_row else None}


def column_horizontal(table: dict, offset: int, formats: list[str]) -> str:
    """列的水平对齐：按**数据**的类型定表头的对齐，避免「表头居中、数字右对齐」的错位观感。"""
    fmt = formats[offset] if offset < len(formats) else ""
    if fmt and any(character in fmt for character in "0#%"):
        return "right"
    if fmt:
        return "left"
    for row in table["rows"]:
        cells = row if isinstance(row, list) else row.get("cells", [])
        if offset < len(cells):
            cell_spec = spec_mod.coerce_cell(cells[offset])
            if isinstance(cell_spec.value, (int, float)) and not isinstance(cell_spec.value, bool):
                return "right"
            if cell_spec.value not in (None, ""):
                return "left"
    return "left"


def _apply_style(cell, resolved: ResolvedStyle) -> None:
    cell.font = resolved.font
    if resolved.fill is not None:
        cell.fill = resolved.fill
    if resolved.border is not None:
        cell.border = resolved.border
    if resolved.alignment is not None:
        cell.alignment = resolved.alignment
    if resolved.number_format:
        cell.number_format = resolved.number_format


# ---------------------------------------------------------------- 图表 / 条件格式 / 校验


def chart_span(ws, anchor: str, width_cm: float, height_cm: float) -> tuple[int, int, int, int]:
    """图表覆盖的范围 (min_row, min_col, max_row, max_col)：按列宽/行高实际累加，不按"约几列"猜。"""
    anchor_row, anchor_col = spec_mod.parse_ref(anchor)
    default_width = float(ws.sheet_format.defaultColWidth or 8.43)
    remaining = width_cm * 96 / 2.54
    column = anchor_col
    while remaining > 0 and column <= 512:
        letter = get_column_letter(column)
        dimension = ws.column_dimensions.get(letter)
        width = float(dimension.width) if (dimension is not None and dimension.width) else default_width
        remaining -= textmetrics.column_width_px(width)
        column += 1
    remaining = height_cm * 96 / 2.54
    row = anchor_row
    while remaining > 0 and row <= 50000:
        dimension = ws.row_dimensions.get(row)
        height = float(dimension.height) if (dimension is not None and dimension.height) else 15.0
        remaining -= height * 96 / 72
        row += 1
    return anchor_row, anchor_col, row - 1, column - 1


def merge_bounds(first, second):
    """两个 (min_row, min_col, max_row, max_col) 的并集；None 忽略。"""
    boxes = [box for box in (first, second) if box]
    if not boxes:
        return None
    return (min(box[0] for box in boxes), min(box[1] for box in boxes),
            max(box[2] for box in boxes), max(box[3] for box in boxes))


def add_charts(ws, charts: list[dict], library: StyleLibrary) -> list[tuple[int, int]]:
    added: list[tuple[int, int]] = []
    for item in charts:
        kind = str(item.get("type", "bar")).lower()
        chart = {"bar": BarChart, "line": LineChart, "pie": PieChart,
                 "doughnut": DoughnutChart}.get(kind)
        if chart is None:
            raise spec_mod.SpecError(f"未知图表类型：{kind}（可选 bar/line/pie/doughnut）")
        chart = chart()
        chart.title = item.get("title", "")
        chart.style = item.get("style", 2)
        if kind in {"bar", "line"}:
            chart.y_axis.title = item.get("yTitle", "")
            chart.x_axis.title = item.get("xTitle", "")
            # 轴刻度不带多余小数（默认 General 会渲染出 1,000.0 这样的尾巴）
            chart.y_axis.number_format = item.get("yNumberFormat", "#,##0")
            chart.gapWidth = item.get("gapWidth", 60)
            chart.height = float(item.get("height", 7.5))
            chart.width = float(item.get("width", 15))
        if item.get("legend") is False:
            chart.legend = None
        min_row, min_col, max_row, max_col = spec_mod.range_bounds(item["cats"])
        categories = Reference(ws, min_col=min_col, min_row=min_row, max_row=max_row, max_col=max_col)
        for series_spec in item["series"]:
            if isinstance(series_spec, str):
                series_spec = {"values": series_spec}
            srow0, scol0, srow1, scol1 = spec_mod.range_bounds(series_spec["values"])
            values = Reference(ws, min_col=scol0, min_row=srow0, max_row=srow1, max_col=scol1)
            chart.add_data(values, titles_from_data=bool(series_spec.get("titlesFromData", False)))
            if len(chart.series) and series_spec.get("name") and not series_spec.get("titlesFromData"):
                # 直接给系列名。曾经把 tx 清成 None，结果图例渲染成「列 B / 列 C」（实测踩过）。
                chart.series[-1].tx = SeriesLabel(v=str(series_spec["name"]))
        chart.set_categories(categories)
        for index, series in enumerate(chart.series):
            color = SERIES_COLORS[index % len(SERIES_COLORS)]
            if kind in {"pie", "doughnut"}:
                from openpyxl.chart.marker import DataPoint  # noqa: PLC0415

                series.data_points = [DataPoint(idx=point, spPr=_solid(SERIES_COLORS[point % len(SERIES_COLORS)]))
                                      for point in range(_point_count(series))]
            else:
                series.graphicalProperties.solidFill = color
                series.graphicalProperties.line.solidFill = color
        anchor = item.get("anchor", "G4")
        ws.add_chart(chart, anchor)
        added.append(chart_span(ws, anchor, float(item.get("width", 15)),
                                float(item.get("height", 7.5))))
    return added


def _point_count(series) -> int:
    try:
        return len(series.val.numRef.ref.split(","))
    except (AttributeError, ValueError):
        return 6


def _solid(color: str):
    from openpyxl.chart.shapes import GraphicalProperties  # noqa: PLC0415

    properties = GraphicalProperties()
    properties.solidFill = color
    return properties


def add_conditional(ws, rules: list[dict], library: StyleLibrary) -> int:
    applied = 0
    for rule in rules:
        kind = rule.get("type", "cellIs")
        cell_range = rule["range"]
        if kind == "cellIs":
            operator = rule.get("operator", "greaterThan")
            formula = [str(rule.get("value"))]
            fmt = library.resolve(rule.get("style", ""), rule.get("styleOverrides"))
            dxf = _dxf(fmt)
            ws.conditional_formatting.add(cell_range, CellIsRule(operator=operator, formula=formula,
                                                                dxf=dxf, stopIfTrue=False))
        elif kind == "colorScale":
            ws.conditional_formatting.add(cell_range, ColorScaleRule(
                start_type="min", start_color=library.color(rule.get("minColor", "negative")),
                end_type="max", end_color=library.color(rule.get("maxColor", "positive"))))
        elif kind == "dataBar":
            ws.conditional_formatting.add(cell_range, DataBarRule(
                start_type="min", end_type="max", color=library.color(rule.get("color", "navySoft"))))
        else:
            raise spec_mod.SpecError(f"未知条件格式类型：{kind}（可选 cellIs/colorScale/dataBar）")
        applied += 1
    return applied


def _dxf(resolved: ResolvedStyle):
    from openpyxl.styles.differential import DifferentialStyle  # noqa: PLC0415

    return DifferentialStyle(font=resolved.font, fill=resolved.fill)


def add_validations(ws, validations: list[dict]) -> int:
    count = 0
    for item in validations:
        kind = item.get("type", "list")
        validation = DataValidation(type=kind, formula1=item.get("formula1", ""),
                                    allow_blank=bool(item.get("allowBlank", True)),
                                    showErrorMessage=True,
                                    errorTitle=item.get("errorTitle", "输入不合法"),
                                    error=item.get("error", "请从下拉列表中选择"))
        ws.add_data_validation(validation)
        validation.add(item["range"])
        count += 1
    return count


# ---------------------------------------------------------------- 打印与页面


def apply_print_setup(ws, print_spec: dict, content_bounds: tuple[int, int, int, int] | None) -> None:
    spec = dict(print_spec or {})
    orientation = spec.get("orientation", "landscape")
    ws.page_setup.orientation = orientation
    ws.page_setup.paperSize = spec.get("paperSize", ws.PAPERSIZE_A4)
    ws.print_options.horizontalCentered = bool(spec.get("centerHorizontal", True))
    fit_width = int(spec.get("fitToWidth", 1))
    fit_height = int(spec.get("fitToHeight", 0))
    if spec.get("scaled", False):
        ws.page_setup.scale = int(spec.get("scale", 100))
        ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=False)
    else:
        ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
        ws.page_setup.fitToWidth = fit_width
        ws.page_setup.fitToHeight = fit_height
    if spec.get("titleRows"):
        ws.print_title_rows = spec["titleRows"]
    if spec.get("titleCols"):
        ws.print_title_cols = spec["titleCols"]
    footer = spec.get("footer", "第 &P 页 / 共 &N 页")
    if footer:
        ws.oddFooter.center.text = footer
        ws.oddFooter.center.size = 9
        ws.oddFooter.center.color = "5A6072"
    if spec.get("header"):
        ws.oddHeader.center.text = spec["header"]
    area = spec.get("area", "auto")
    if area == "auto":
        # 自动打印区域 = 内容范围（含留白），避免"数据长到打印区域外被裁掉"这类静默丢失。
        if content_bounds is not None:
            min_row, min_col, max_row, max_col = content_bounds
            ws.print_area = (f"{get_column_letter(min_col)}{min_row}:"
                             f"{get_column_letter(max_col)}{max_row}")
    elif area:
        ws.print_area = area
    ws.page_margins.left = ws.page_margins.right = float(spec.get("marginX", 0.4))
    ws.page_margins.top = ws.page_margins.bottom = float(spec.get("marginY", 0.5))
    ws.page_margins.header = 0.2
    ws.page_margins.footer = 0.2


# ---------------------------------------------------------------- 主流程


def build(spec: dict, out_path: Path) -> dict:
    workbook_spec = spec.get("workbook", {})
    font_spec = workbook_spec.get("defaultFont", {})
    family = font_spec.get("family") or "微软雅黑"
    size = float(font_spec.get("size", 10.5))
    library = StyleLibrary(workbook_spec.get("theme", "nibi"), family, size, spec.get("styles"))

    problems = spec_mod.validate_colors(spec, [library.palette])
    if problems:
        raise spec_mod.SpecError("规格里的颜色有问题：\n  " + "\n  ".join(problems))

    if not spec.get("sheets"):
        raise spec_mod.SpecError("规格里没有 sheets（至少给一张工作表）")
    workbook = Workbook()
    workbook.remove(workbook.active)
    workbook.properties.creator = workbook_spec.get("author", "NIBI")
    workbook.properties.lastModifiedBy = workbook_spec.get("author", "NIBI")
    workbook.properties.title = workbook_spec.get("title", "")
    workbook.properties.description = workbook_spec.get("description", "")
    hygiene.scrub_core_properties(workbook.properties)

    summary = {"sheets": [], "charts": 0, "conditionalRules": 0, "validations": 0, "cellsWritten": 0}
    names: set[str] = set()
    for sheet_spec in spec.get("sheets", []):
        name = str(sheet_spec.get("name", "")).strip()
        if not name:
            raise spec_mod.SpecError("每个 sheet 必须给 name")
        if len(name) > 31:
            raise spec_mod.SpecError(f"工作表名超过 31 字符：{name}")
        if any(character in name for character in "[]:*?/\\"):
            raise spec_mod.SpecError(f"工作表名含非法字符：{name}")
        if name in names:
            raise spec_mod.SpecError(f"工作表重名：{name}")
        names.add(name)

        ws = workbook.create_sheet(title=name)
        if sheet_spec.get("tabColor"):
            ws.sheet_properties.tabColor = library.color(sheet_spec["tabColor"])
        if sheet_spec.get("freeze"):
            ws.freeze_panes = sheet_spec["freeze"]
        for row_number, height in (sheet_spec.get("rowHeights") or {}).items():
            ws.row_dimensions[int(row_number)].height = float(height)
        ws.sheet_view.showGridLines = bool(sheet_spec.get("gridLines", False))

        columns_meta = sheet_spec.get("columns", [])
        chart_extents: list[tuple[int, int, int, int]] = []
        tables = [dict(table, **{"start_row": spec_mod.parse_ref(table["start"])[0],
                                 "start_col": spec_mod.parse_ref(table["start"])[1],
                                 "body_style": table.get("bodyStyle", "tableBody"),
                                 "alt_style": table.get("altStyle", "tableBodyAlt")})
                  for table in sheet_spec.get("tables", [])]

        written_rows: list[dict] = []
        for table in tables:
            written_rows.append(write_table(ws, table, library))
            summary["cellsWritten"] += len(table["rows"]) * len(table["header"])

        for block in sheet_spec.get("blocks", []):
            _write_block(ws, block, library)
            summary["cellsWritten"] += 1
        for note in sheet_spec.get("notes", []):
            row, column = spec_mod.parse_ref(note["cell"])
            cell = ws.cell(row=row, column=column, value=note["text"])
            _apply_style(cell, library.resolve(note.get("style", "note"),
                                               note.get("styleOverrides")))
            summary["cellsWritten"] += 1
        merges = 0
        for merge in sheet_spec.get("merges", []):
            ws.merge_cells(merge)
            merges += 1
        for title in sheet_spec.get("titles", []):
            row, column = spec_mod.parse_ref(title["cell"])
            cell = ws.cell(row=row, column=column, value=title["text"])
            _apply_style(cell, library.resolve(title.get("style", "sheetTitle")))
            if title.get("height"):
                ws.row_dimensions[row].height = float(title["height"])
            summary["cellsWritten"] += 1

        apply_explicit_widths(ws, columns_meta)
        if sheet_spec.get("autofit", True):
            autofit_columns(ws, tables, library, columns_meta)
        for table in tables:
            if not table.get("headerHeight"):
                ws.row_dimensions[table["start_row"]].height = header_row_height(ws, table, library)

        chart_extents = add_charts(ws, sheet_spec.get("charts", []), library)
        summary["charts"] += len(chart_extents)
        summary["conditionalRules"] += add_conditional(ws, sheet_spec.get("conditional", []), library)
        summary["validations"] += add_validations(ws, sheet_spec.get("validations", []))

        # 打印区域按整表内容算，并把图表占位并进去：图锚在打印区域外会整张消失（实测踩过）。
        chart_extent = max((chart_covered_until for chart_covered_until in chart_extents), default=None)
        bounds = merge_bounds(sheet_content_bounds(ws), chart_extent)
        apply_print_setup(ws, sheet_spec.get("print", {}), bounds)
        summary["sheets"].append({"name": name, "tables": len(tables),
                                  "rows": sum(len(item["rows"]) for item in tables),
                                  "merges": merges, "bounds": bounds})

    out_path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(out_path)
    return summary


def sheet_content_bounds(ws) -> tuple[int, int, int, int] | None:
    """整张表里真实有内容的范围（含标题/KPI/注释/表格），打印区域按它算。"""
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


def _write_block(ws, block: dict, library: StyleLibrary) -> None:
    """散布的单元格块：`{"cells": [{"cell": "C3", "v": 1, "style": "kpiValue"}]}`。"""
    for item in block.get("cells", []):
        row, column = spec_mod.parse_ref(item["cell"])
        cell = ws.cell(row=row, column=column)
        apply_value(cell, spec_mod.coerce_cell(item))
        resolved = library.resolve(item.get("style", ""), item.get("styleOverrides"))
        _apply_style(cell, resolved)
        number_format = spec_mod.normalize_number_format(item.get("format", ""))
        cell.number_format = number_format or "General"


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="从 JSON 规格构建 .xlsx")
    parser.add_argument("--spec", required=True, help="规格 JSON 路径")
    parser.add_argument("--out", required=True, help="输出 .xlsx 路径")
    parser.add_argument("--no-autofit", action="store_true", help="不自动列宽（规格里逐列给宽时用）")
    cli.add_common(parser)
    args = parser.parse_args()

    spec_path = Path(args.spec).expanduser()
    if not spec_path.is_file():
        print(f"找不到规格文件：{spec_path}", file=sys.stderr)
        return 2
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    if args.no_autofit:
        for sheet in spec.get("sheets", []):
            sheet["autofit"] = False
    out_path = Path(args.out).expanduser()
    try:
        summary = build(spec, out_path)
    except spec_mod.SpecError as error:
        print(f"规格不合法：{error}", file=sys.stderr)
        return 2
    size_kb = out_path.stat().st_size / 1024 if out_path.is_file() else 0
    lines = [f"已生成 {out_path}（{size_kb:.1f} KB）",
             f"  工作表 {len(summary['sheets'])} 张、写入约 {summary['cellsWritten']} 个单元格、"
             f"图表 {summary['charts']} 个、条件格式 {summary['conditionalRules']} 条、"
             f"数据校验 {summary['validations']} 条"]
    for sheet in summary["sheets"]:
        lines.append(f"  · {sheet['name']}：{sheet['tables']} 个表、{sheet['rows']} 行数据")
    lines.append("下一步：python tools/xlsx_gate.py --xlsx <文件> 跑质量门；"
                 "python tools/xlsx_render.py --xlsx <文件> --outdir 审查/表图 出逐页图")
    cli.emit({"summary": "\n".join(lines), "out": str(out_path), "build": summary}, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

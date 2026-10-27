"""读回 .xlsx 的结构与内容（JSON），供检查、对账与编辑前勘察。

    python tools/xlsx_read.py --xlsx 结果表.xlsx [--sheet 明细] [--range A1:F20] [--csv 导出.csv]

与「打开文件看一眼」的区别：它把**结构与格式**一起摊开（列宽、行高、数字格式、合并、图表、
打印设置、公式），这些正是交付缺陷的藏身处；`--csv` 导出数值视图，方便与源数据对账。
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["openpyxl"], "xlsx_read（openpyxl）")

from openpyxl import load_workbook  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402


def jsonable(value):
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, float):
        return round(value, 10)
    return value


def cell_info(cell) -> dict:
    info = {"cell": cell.coordinate, "v": jsonable(cell.value)}
    if isinstance(cell.value, str) and cell.value.startswith("="):
        info["formula"] = cell.value
        info["v"] = None
    fmt = cell.number_format
    if fmt and fmt != "General":
        info["format"] = fmt
    if cell.font and (cell.font.bold or cell.font.size not in (None, 11.0) or cell.font.color):
        info["font"] = {"size": cell.font.size, "bold": bool(cell.font.bold),
                        "name": cell.font.name}
    if cell.alignment and (cell.alignment.horizontal or cell.alignment.wrap_text):
        info["align"] = {"horizontal": cell.alignment.horizontal,
                         "wrap": bool(cell.alignment.wrap_text)}
    if cell.comment:
        info["comment"] = cell.comment.text
    return info


def describe_sheet(ws, cell_range: str = "") -> dict:
    cells = []
    iterator = ws[cell_range] if cell_range else ws.iter_rows()
    rows = iterator if cell_range else None
    if cell_range:
        for row in iterator:
            for cell in row:
                if cell.value not in (None, ""):
                    cells.append(cell_info(cell))
    else:
        for row in iterator:
            for cell in row:
                if cell.value not in (None, ""):
                    cells.append(cell_info(cell))
    widths = {get_column_letter(index): round(float(dim.width), 2)
              for index, dim in _column_dims(ws) if dim.width}
    heights = {str(index): round(float(dim.height), 2)
               for index, dim in ws.row_dimensions.items() if dim.height}
    return {
        "name": ws.title,
        "tabColor": (ws.sheet_properties.tabColor.rgb if ws.sheet_properties.tabColor else None),
        "freeze": ws.freeze_panes,
        "dimensions": ws.calculate_dimension(),
        "columnWidths": widths,
        "rowHeights": heights,
        "merged": [str(item) for item in ws.merged_cells.ranges],
        "charts": [{"type": type(chart).__name__, "title": _chart_title(chart)}
                   for chart in getattr(ws, "_charts", [])],
        "conditionalFormatting": [str(item.sqref) for item in ws.conditional_formatting],
        "validations": [{"type": item.type, "ranges": str(item.sqref)}
                        for item in ws.data_validations.dataValidation],
        "print": {
            "area": (str(ws.print_area) if ws.print_area else None),
            "orientation": ws.page_setup.orientation,
            "fitToWidth": ws.page_setup.fitToWidth,
            "fitToHeight": ws.page_setup.fitToHeight,
            "scale": ws.page_setup.scale,
            "titleRows": ws.print_title_rows,
            "footer": (ws.oddFooter.center.text if ws.oddFooter and ws.oddFooter.center else ""),
        },
        "cellCount": len(cells),
        "cells": cells,
    }


def _column_dims(ws):
    for key, dim in ws.column_dimensions.items():
        index = 0
        for character in key:
            index = index * 26 + (ord(character) - 64)
        yield index, dim


def _chart_title(chart) -> str:
    title = getattr(chart, "title", None)
    try:
        return str(title.tx.rich.p[0].r[0].t)
    except (AttributeError, IndexError, TypeError):
        return ""


def export_csv(ws, target: Path) -> int:
    written = 0
    with target.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        for row in ws.iter_rows():
            values = ["" if cell.value is None else cell.value for cell in row]
            if all(value == "" for value in values):
                continue
            writer.writerow(values)
            written += 1
    return written


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="读回 xlsx 结构与内容")
    parser.add_argument("--xlsx", required=True)
    parser.add_argument("--sheet", default="", help="只看某张表（默认全部）")
    parser.add_argument("--range", default="", help="只看某个区域，如 A1:F20")
    parser.add_argument("--csv", default="", help="把某张表导出成 CSV（默认第一张）")
    parser.add_argument("--values-only", action="store_true", help="只输出值，不带格式信息")
    cli.add_common(parser)
    args = parser.parse_args()

    path = Path(args.xlsx).expanduser()
    if not path.is_file():
        print(f"找不到文件：{path}", file=sys.stderr)
        return 2
    workbook = load_workbook(path, data_only=args.values_only)
    try:
        if args.csv:
            sheet = workbook[args.sheet] if args.sheet else workbook.worksheets[0]
            target = Path(args.csv).expanduser()
            target.parent.mkdir(parents=True, exist_ok=True)
            rows = export_csv(sheet, target)
            cli.emit({"summary": f"已导出 {rows} 行 → {target}", "csv": str(target)}, args)
            return 0
        sheets = [workbook[args.sheet]] if args.sheet else list(workbook.worksheets)
        payload = {"file": str(path), "sheetNames": list(workbook.sheetnames),
                   "sheets": [describe_sheet(ws, args.range) for ws in sheets]}
        lines = [f"{path.name}：{len(payload['sheetNames'])} 张表（{'、'.join(payload['sheetNames'])}）"]
        for sheet in payload["sheets"]:
            lines.append(f"  · {sheet['name']}：{sheet['cellCount']} 个非空单元格、"
                         f"范围 {sheet['dimensions']}、合并 {len(sheet['merged'])} 处、"
                         f"图表 {len(sheet['charts'])} 个、条件格式 {len(sheet['conditionalFormatting'])} 条")
            lines.append(f"    打印：{sheet['print']['orientation']}，"
                         f"区域 {sheet['print']['area'] or '未设'}")
        cli.emit({"summary": "\n".join(lines), **payload}, args)
        return 0
    finally:
        workbook.close()


if __name__ == "__main__":
    raise SystemExit(main())

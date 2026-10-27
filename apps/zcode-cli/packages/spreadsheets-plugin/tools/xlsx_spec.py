"""工作簿规格（spec）与样式库：把「要一张什么表」写成 JSON，再由 xlsx_build 落成文件。

## 为什么用规格而不是让模型现场写 openpyxl 代码

现场写代码有三类反复出现的缺陷：样式每次写得不一样（同一份交付里两种表头）、
数字格式漏设（`0.30000000000000004` 直接进交付件）、列宽靠猜（中文列宽按字符数估会短一半）。
规格把这三件事变成声明式：列宽按**内容实际宽度**算、格式按语义名给（`pct1`/`money`）、
样式从命名样式库里取。模型只需要把「表里有什么」说清楚。

## 规格结构（详细字段见 skills/xlsx/SKILL.md）

```json
{
  "workbook": {"title": "...", "author": "NIBI", "defaultFont": {"family": "微软雅黑", "size": 10.5}},
  "styles": {"kpiValue": {"font": {"size": 20, "bold": true, "color": "navy"}}},
  "sheets": [{
    "name": "明细",
    "columns": [{"header": "月份", "width": "auto"}, {"header": "金额", "width": "auto"}],
    "tables": [{"start": "A3", "rows": [[...]], "zebra": true, "totalRow": [...]}],
    "charts": [{"type": "bar", "cats": "A4:A9", "values": "C4:C9", "anchor": "G4"}]
  }]
}
```
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# 语义调色板。颜色名 → 十六进制；交付件里只允许出现这里的名字或 #RRGGBB。
PALETTES: dict[str, dict[str, str]] = {
    "nibi": {
        "navy": "1E3A5F", "navyDeep": "16304F", "navySoft": "35597F",
        "orange": "E98A3C", "orangeSoft": "F5C08A",
        "cream": "F7EFE2", "creamSoft": "FBF6EE",
        "ink": "22252B", "inkSoft": "5A6072",
        "line": "D8D2C4", "zebra": "F4F1EA",
        "positive": "C0392B",   # 中文财务惯例：红涨
        "negative": "1E7B4F",   # 绿跌
        "warning": "B4530A", "muted": "8A8F9C",
        "white": "FFFFFF",
    },
}

# 内置命名样式：font / fill / border / alignment / number_format。
# 供规格里的 "style": "<名字>" 引用；规格可用 "styles" 覆盖或新增。
BASE_STYLES: dict[str, dict[str, Any]] = {
    "sheetTitle": {"font": {"size": 16, "bold": True, "color": "navy"},
                   "alignment": {"horizontal": "left", "vertical": "center"}},
    "sheetSubtitle": {"font": {"size": 10, "color": "inkSoft"},
                      "alignment": {"horizontal": "left", "vertical": "center"}},
    "sectionTitle": {"font": {"size": 11.5, "bold": True, "color": "navy"},
                     "alignment": {"horizontal": "left", "vertical": "center"}},
    "tableHeader": {"font": {"size": 10.5, "bold": True, "color": "white"},
                    "fill": "navy",
                    "alignment": {"horizontal": "center", "vertical": "center", "wrap_text": True},
                    "border": "thinBottom"},
    "tableBody": {"font": {"size": 10.5, "color": "ink"},
                  "alignment": {"vertical": "center"}},
    "tableBodyAlt": {"font": {"size": 10.5, "color": "ink"},
                     "fill": "zebra", "alignment": {"vertical": "center"}},
    "tableBodyCenter": {"font": {"size": 10.5, "color": "ink"},
                        "alignment": {"horizontal": "center", "vertical": "center"}},
    "totalRow": {"font": {"size": 10.5, "bold": True, "color": "navy"},
                 "fill": "cream", "border": "thinTop",
                 "alignment": {"vertical": "center"}},
    "kpiLabel": {"font": {"size": 10, "color": "inkSoft"},
                 "alignment": {"horizontal": "center"}},
    "kpiValue": {"font": {"size": 20, "bold": True, "color": "navy"},
                 "alignment": {"horizontal": "center"}},
    "kpiDeltaUp": {"font": {"size": 10.5, "color": "positive"},
                   "alignment": {"horizontal": "center"}},
    "kpiDeltaDown": {"font": {"size": 10.5, "color": "negative"},
                     "alignment": {"horizontal": "center"}},
    "note": {"font": {"size": 9, "color": "inkSoft", "italic": True},
             "alignment": {"vertical": "top", "wrap_text": True}},
    "warningText": {"font": {"size": 10.5, "color": "warning", "bold": True},
                    "alignment": {"vertical": "center"}},
    "muted": {"font": {"size": 10, "color": "muted"}},
    "mono": {"font": {"name": "Consolas", "size": 10, "color": "ink"}},
}

# 语义数字格式名 → openpyxl 格式串。
NUMBER_FORMATS: dict[str, str] = {
    "text": "@",
    "int": "#,##0",
    "num1": "#,##0.0",
    "num2": "#,##0.00",
    "num3": "#,##0.000",
    "pct0": "0%",
    "pct1": "0.0%",
    "pct2": "0.00%",
    "money": "¥#,##0.00",
    "money0": "¥#,##0",
    "thousands": "#,##0",
    "sci": "0.00E+00",
    "date": "yyyy-mm-dd",
    "datetime": "yyyy-mm-dd hh:mm",
    "month": "yyyy-mm",
    "year": "yyyy",
    "elapsed": "[h]:mm",
}

BORDER_STYLES = {
    "thinBottom": {"bottom": {"style": "thin"}},
    "thinTop": {"top": {"style": "thin"}},
    "thinBox": {"left": {"style": "thin"}, "right": {"style": "thin"},
                "top": {"style": "thin"}, "bottom": {"style": "thin"}},
    "hairBelow": {"bottom": {"style": "hair"}},
}

CELL_REF = re.compile(r"^([A-Z]{1,3})([1-9][0-9]{0,6})$")


def palette(name: str = "nibi") -> dict[str, str]:
    if name not in PALETTES:
        raise SpecError(f"未知调色板：{name}（可选：{'、'.join(PALETTES)}）")
    return PALETTES[name]


class SpecError(ValueError):
    """规格不合法 —— 报错时要说清是哪个字段、期望什么。"""


def parse_ref(ref: str) -> tuple[int, int]:
    """`"C7"` → `(row=7, column=3)`；不合法直接抛 SpecError（别让错误位置飘到别处炸）。"""
    match = CELL_REF.match(ref.strip().upper())
    if not match:
        raise SpecError(f"不是合法的单元格引用：{ref!r}（应形如 C7；整列用 'C:C'、整行用 '7:7' 的地方请用区域字段）")
    column, row = match.group(1), int(match.group(2))
    return row, _column_index(column)


def _column_index(letters: str) -> int:
    index = 0
    for character in letters:
        index = index * 26 + (ord(character) - 64)
    return index


def range_bounds(ref: str) -> tuple[int, int, int, int]:
    """`"B4:B9"` → `(min_row, min_col, max_row, max_col)`（单格也接受）。"""
    text = ref.strip().upper()
    if ":" in text:
        start, _, end = text.partition(":")
        start_row, start_col = parse_ref(start)
        end_row, end_col = parse_ref(end)
        return (min(start_row, end_row), min(start_col, end_col),
                max(start_row, end_row), max(start_col, end_col))
    row, column = parse_ref(text)
    return row, column, row, column


@dataclass
class CellSpec:
    value: Any = None
    formula: str = ""
    style: str = ""
    number_format: str = ""
    comment: str = ""
    hyperlink: str = ""
    extra_style: dict = field(default_factory=dict)

    def is_empty(self) -> bool:
        return self.value in (None, "") and not self.formula


def coerce_cell(raw: Any, default_style: str = "", default_format: str = "") -> CellSpec:
    """把规格里的一个 cell 写法统一成 CellSpec（标量、公式、显式对象三种）。"""
    if isinstance(raw, CellSpec):
        return raw
    if isinstance(raw, dict):
        if "f" in raw or "formula" in raw:
            formula = str(raw.get("f") or raw.get("formula") or "")
            if not formula.startswith("="):
                formula = "=" + formula
            return CellSpec(value=None, formula=formula, style=raw.get("style", default_style),
                            number_format=raw.get("format", default_format),
                            comment=raw.get("comment", ""), hyperlink=raw.get("link", ""),
                            extra_style=raw.get("styleOverrides", {}) or {})
        return CellSpec(value=raw.get("v"), style=raw.get("style", default_style),
                        number_format=raw.get("format", default_format),
                        comment=raw.get("comment", ""), hyperlink=raw.get("link", ""),
                        extra_style=raw.get("styleOverrides", {}) or {})
    return CellSpec(value=raw, style=default_style, number_format=default_format)


def normalize_number_format(name: str) -> str:
    """`"pct1"` → `"0.0%"`；已经是格式串就原样保留。"""
    if not name:
        return ""
    return NUMBER_FORMATS.get(name.strip(), name)


def validate_colors(spec: dict, palettes: list[dict[str, str]]) -> list[str]:
    """扫描规格里出现的颜色字面量：只认 `#RRGGBB` 与语义名（防止一处写错的颜色混进交付件）。"""
    problems: list[str] = []
    allowed = {key for table in palettes for key in table}
    for path, value in _walk(spec):
        if not isinstance(value, str):
            continue
        if path.endswith("color") or path.endswith("fill") or path.endswith("tabColor"):
            text = value.strip()
            if text.startswith("#"):
                if not re.fullmatch(r"#[0-9A-Fa-f]{6}", text):
                    problems.append(f"{path}: 颜色写法不合法：{text}（要 #RRGGBB）")
            elif text and text not in allowed:
                problems.append(f"{path}: 未知颜色名：{text}（可选语义名：{'、'.join(sorted(allowed))}；或用 #RRGGBB）")
    return problems


def _walk(node: Any, prefix: str = "") -> list[tuple[str, Any]]:
    items: list[tuple[str, Any]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            items += _walk(value, f"{prefix}.{key}" if prefix else str(key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            items += _walk(value, f"{prefix}[{index}]")
    else:
        items.append((prefix, node))
    return items

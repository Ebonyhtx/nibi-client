"""DOCX 规格与样式库：把「要一份什么文档」写成 JSON，再由 docx_build 落成 .docx。

## 为什么规格驱动

现场写 python-docx 代码在中文文档上会反复踩三个坑：**中文字体只设了 ascii/hAnsi 没设
eastAsia**（中文被替换成别的字体）、**首行缩进用磅值而不是"2 字符"**（换字号就错位）、
**行距/字号每段手写**（同一份文档里两种正文）。规格把这些固定成命名样式，只声明「这段是什么」。

## 样式（中文文档惯例）

| 名字 | 字号 | 字体 | 用途 |
| --- | --- | --- | --- |
| `docTitle` | 小二 18pt | 黑体 | 文档标题（居中） |
| `docSubtitle` | 小四 12pt | 楷体 | 副标题/单位/日期（居中） |
| `h1` / `h2` / `h3` | 三号 16 / 四号 14 / 小四 12 | 黑体加粗 | 各级标题 |
| `body` | 小四 12pt | 宋体 | 正文（首行缩进 2 字符、1.5 倍行距） |
| `bodyNoIndent` | 同 body | 宋体 | 不缩进的正文段（如表下说明） |
| `bullet` | 同 body | 宋体 | 项目符号 |
| `caption` | 五号 10.5pt | 宋体 | 图注/表注（居中） |
| `tableText` | 五号 10.5pt | 宋体 | 表格文字 |
| `tableHeader` | 五号 10.5pt | 黑体加粗 | 表头 |
| `note` | 小五 9pt | 宋体 | 脚注式说明（灰） |
| `code` | 五号 10.5pt | Consolas | 代码/命令 |

字号是**印出字号**（Word 不做整页缩放），所以 ≥9pt 的正文字号不是选择而是底线。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class SpecError(ValueError):
    """规格不合法 —— 报错要说清字段与期望。"""


PALETTES: dict[str, dict[str, str]] = {
    "nibi": {
        "ink": "22252B", "inkSoft": "5A6072", "navy": "1E3A5F", "orange": "E98A3C",
        "line": "D8D2C4", "zebra": "F4F1EA", "muted": "8A8F9C", "white": "FFFFFF",
        "positive": "C0392B", "negative": "1E7B4F",
    },
}

# 名字 → 样式定义。font.size 是磅；indentChars 是"首行缩进多少字符"（中文字符）。
BASE_STYLES: dict[str, dict[str, Any]] = {
    "docTitle": {"size": 18, "cjk": "黑体", "latin": "Times New Roman", "bold": True,
                 "align": "center", "spaceBefore": 0, "spaceAfter": 18, "lineSpacing": 1.5},
    "docSubtitle": {"size": 12, "cjk": "楷体", "latin": "Times New Roman",
                    "align": "center", "spaceAfter": 6, "lineSpacing": 1.5, "color": "inkSoft"},
    "h1": {"size": 16, "cjk": "黑体", "latin": "Times New Roman", "bold": True,
           "align": "left", "spaceBefore": 18, "spaceAfter": 12, "lineSpacing": 1.5,
           "keepWithNext": True},
    "h2": {"size": 14, "cjk": "黑体", "latin": "Times New Roman", "bold": True,
           "align": "left", "spaceBefore": 12, "spaceAfter": 8, "lineSpacing": 1.5,
           "keepWithNext": True},
    "h3": {"size": 12, "cjk": "黑体", "latin": "Times New Roman", "bold": True,
           "align": "left", "spaceBefore": 8, "spaceAfter": 6, "lineSpacing": 1.5,
           "keepWithNext": True},
    "body": {"size": 12, "cjk": "宋体", "latin": "Times New Roman",
             "align": "justify", "indentChars": 2, "lineSpacing": 1.5, "spaceAfter": 0},
    "bodyNoIndent": {"size": 12, "cjk": "宋体", "latin": "Times New Roman",
                     "align": "justify", "lineSpacing": 1.5},
    "bullet": {"size": 12, "cjk": "宋体", "latin": "Times New Roman",
               "align": "left", "lineSpacing": 1.5, "bullet": True, "indentChars": 0},
    "caption": {"size": 10.5, "cjk": "宋体", "latin": "Times New Roman",
                "align": "center", "spaceBefore": 6, "spaceAfter": 12, "lineSpacing": 1.15},
    "tableText": {"size": 10.5, "cjk": "宋体", "latin": "Times New Roman", "lineSpacing": 1.15},
    "tableHeader": {"size": 10.5, "cjk": "黑体", "latin": "Times New Roman", "bold": True,
                    "align": "center", "lineSpacing": 1.15},
    "note": {"size": 9, "cjk": "宋体", "latin": "Times New Roman", "color": "inkSoft",
             "lineSpacing": 1.15},
    # 代码块：拉丁用等宽 Consolas，但**中文字体必须给中文字体**（Consolas 没有汉字，
    # 中文会被替换成别的字体）——"只设 ascii 不设 eastAsia"正是我们要拦的那类缺陷。
    "code": {"size": 10.5, "cjk": "宋体", "latin": "Consolas", "lineSpacing": 1.15},
}

# 中文可用字体（判据用：中文字体写成拉丁字体族名 = 会被替换，必须拦）
CJK_FAMILIES = ("宋体", "黑体", "楷体", "仿宋", "微软雅黑", "等线", "思源黑体", "思源宋体",
                "苹方", "冬青黑体", "文泉驿微米黑", "Noto Sans CJK SC", "Microsoft YaHei",
                "SimSun", "SimHei", "KaiTi", "FangSong", "DengXian", "Consolas")


def palette(name: str = "nibi") -> dict[str, str]:
    if name not in PALETTES:
        raise SpecError(f"未知调色板：{name}（可选：{'、'.join(PALETTES)}）")
    return PALETTES[name]


def styles_with_overrides(overrides: dict | None) -> dict[str, dict[str, Any]]:
    styles = {name: dict(value) for name, value in BASE_STYLES.items()}
    for name, definition in (overrides or {}).items():
        styles[name] = {**styles.get(name, {}), **(definition or {})}
    return styles


def load_spec(path: str | Path) -> dict:
    source = Path(path).expanduser()
    if not source.is_file():
        raise SpecError(f"找不到规格文件：{source}")
    try:
        spec = json.loads(source.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SpecError(f"规格 JSON 解析失败（{source}）：{error}") from error
    if not isinstance(spec, dict):
        raise SpecError("规格顶层必须是对象")
    if not spec.get("content"):
        raise SpecError("规格里没有 content（至少给一段内容）")
    return spec


def element_text(element: dict) -> str:
    """取元素的可读文本（用于 TOC 条目与判据）。"""
    for key in ("text", "title"):
        if element.get(key):
            return str(element[key])
    if element.get("type") == "table":
        return str(element.get("caption", "表格"))
    if element.get("type") == "figure":
        return str(element.get("caption", "插图"))
    return ""


def outline_entries(spec: dict) -> list[tuple[int, str]]:
    """目录条目：按 content 顺序取（文档）标题与各级标题。"""
    entries: list[tuple[int, str]] = []
    for element in spec.get("content", []):
        kind = element.get("type")
        if kind == "title" and element.get("toc", True):
            entries.append((0, str(element.get("text", ""))))
        elif kind == "heading":
            level = int(element.get("level", 1))
            if 1 <= level <= 3:
                entries.append((level, str(element.get("text", ""))))
    return entries

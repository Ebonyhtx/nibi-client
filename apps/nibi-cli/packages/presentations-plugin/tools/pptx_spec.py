"""PPTX 规格与样式：投影场景的字号基线 + 命名版式。

## 为什么字号与 DOCX 不是一套

投影是**远距离**阅读：16:9 幻灯片上正文字号低于 18pt，最后一排看不清；这是放映场景的硬约束，
不是审美偏好。所以这里的样式表按"投出来能不能看清"定字号，判据也按同一口径卡（<12pt 硬失败）。

## 为什么用空白版式 + 自建文本框

PPT 的占位符会继承母版/版式里的字体与字号，**继承链在 Python 侧看不全**，判据也就无从下手
（"实际显示多大"取决于主题）。本项目一律用空白版式、显式建文本框与文字，字号与字体完全由
规格决定 —— 判据读到什么，放映出来就是什么。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SLIDE_WIDTH_IN = 13.333   # 16:9
SLIDE_HEIGHT_IN = 7.5


class SpecError(ValueError):
    """规格不合法 —— 报错要说清字段与期望。"""


PALETTES: dict[str, dict[str, str]] = {
    "nibi": {
        "bg": "FFFFFF", "ink": "22252B", "inkSoft": "5A6072", "navy": "1E3A5F",
        "navyDeep": "16304F", "navySoft": "35597F", "orange": "E98A3C", "cream": "F7EFE2",
        "line": "D8D2C4", "zebra": "F4F1EA", "muted": "8A8F9C", "white": "FFFFFF",
        "positive": "C0392B", "negative": "1E7B4F",
    },
}

# 角色 → 字号（磅）/字体/颜色/间距。投影基线：标题 ≥28pt、正文 ≥18pt、出处 ≥12pt。
BASE_STYLES: dict[str, dict[str, Any]] = {
    "slideTitle": {"size": 30, "cjk": "微软雅黑", "color": "navy", "bold": True, "lineSpacing": 1.1},
    "slideSubtitle": {"size": 16, "cjk": "微软雅黑", "color": "inkSoft", "lineSpacing": 1.2},
    "sectionTitle": {"size": 34, "cjk": "微软雅黑", "color": "white", "bold": True},
    "sectionSubtitle": {"size": 16, "cjk": "微软雅黑", "color": "cream"},
    "bodyText": {"size": 20, "cjk": "微软雅黑", "color": "ink", "lineSpacing": 1.25},
    "bodyTextSmall": {"size": 16, "cjk": "微软雅黑", "color": "ink", "lineSpacing": 1.25},
    "bulletText": {"size": 20, "cjk": "微软雅黑", "color": "ink", "lineSpacing": 1.3},
    "cardTitle": {"size": 18, "cjk": "微软雅黑", "color": "navy", "bold": True},
    "cardValue": {"size": 40, "cjk": "微软雅黑", "color": "navy", "bold": True},
    "cardLabel": {"size": 14, "cjk": "微软雅黑", "color": "inkSoft"},
    "caption": {"size": 12, "cjk": "微软雅黑", "color": "inkSoft"},
    "sourceNote": {"size": 12, "cjk": "微软雅黑", "color": "muted"},
    "tableHeader": {"size": 14, "cjk": "微软雅黑", "color": "white", "bold": True},
    "tableText": {"size": 14, "cjk": "微软雅黑", "color": "ink"},
    "pageNumber": {"size": 12, "cjk": "微软雅黑", "color": "muted"},
}

# 判据基线（投影可读性）
FONT_FLOOR_HARD = 12.0
FONT_FLOOR_BODY = 16.0
BODY_STYLES = ("bodyText", "bulletText", "bodyTextSmall")
CJK_FAMILIES = ("微软雅黑", "黑体", "宋体", "等线", "思源黑体", "苹方", "冬青黑体",
                "Noto Sans CJK SC", "Microsoft YaHei", "SimHei", "PingFang SC")
SLIDE_KINDS = ("title", "section", "bullets", "twoColumn", "cards", "table", "chart",
               "image", "quote", "end")


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
    if not isinstance(spec, dict) or not spec.get("slides"):
        raise SpecError("规格里没有 slides（至少给一页）")
    for index, slide in enumerate(spec["slides"], start=1):
        kind = slide.get("kind")
        if kind not in SLIDE_KINDS:
            raise SpecError(f"第 {index} 页的 kind 不认识：{kind!r}（可选：{'、'.join(SLIDE_KINDS)}）")
    return spec


def slide_title(slide: dict) -> str:
    for key in ("title", "heading", "text"):
        if slide.get(key):
            return str(slide[key])
    if slide.get("kind") == "table":
        return str(slide.get("caption", "表格"))
    if slide.get("kind") == "image":
        return str(slide.get("caption", "插图"))
    return ""


def text_of(element: Any) -> str:
    if isinstance(element, str):
        return element
    if isinstance(element, dict):
        for key in ("text", "value", "label"):
            if element.get(key) is not None:
                return str(element[key])
    return "" if element is None else str(element)

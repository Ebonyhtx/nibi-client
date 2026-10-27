"""海报/定幅画布：按 JSON 规格生成学术海报 PDF（reportlab，毫米级版面）。

## 为什么不用 HTML 路线（pdf_build 那条）

海报是**绝对定位的毫米级版面**：栏目分几列、每块占多高、标题带多厚、图片多大，都要落到毫米。
LibreOffice 的 HTML 导入实测连 `flex/grid` 与细边框都不认（我们在 report 模板上踩过），
压不住这种版面。reportlab 能精确到毫米、嵌入中文字体、**文字可选中**（不是位图），
且许可是 BSD 系（可商用）。

## 规格长什么样

```json
{
  "poster": {
    "size": "A0", "orientation": "portrait", "safeMarginMm": 18, "bleedMm": 0,
    "palette": "nibi", "fonts": {"body": "微软雅黑", "title": "微软雅黑"},
    "title": "题目", "authors": ["张三", "李四"], "affiliation": "NIBI 数据组",
    "footer": "联系方式：contact@nibistudio.top   ·   2026-07"
  },
  "columns": [
    [ {"kind": "panel", "title": "研究背景", "paras": ["…"], "bullets": ["…"]},
      {"kind": "image", "path": "fig1.png", "caption": "图 1 …"} ],
    [ {"kind": "stat", "items": [{"value": "28.6%", "label": "毛利率"}]} ]
  ]
}
```

## 硬约束（构建时就拦，不等质量门）

* 图片**只按原始纵横比缩放**（同时给宽高就是拉扁）；
* 每个板块**先量后排**：内容高度超出块高 → 构建直接报错（不静默裁掉）；
* 中文字体从本机真实字体里解析（`nibi_kit.fonts`），找不到就如实报错，不退回"能画但难看"的默认体；
* 版心 = 画布减去安全边距（含出血时另算）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, fonts, hygiene, textmetrics  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["reportlab", "PIL"], "pdf_poster（reportlab + pillow）")

from reportlab.lib.colors import HexColor  # noqa: E402
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT  # noqa: E402
from reportlab.lib.styles import ParagraphStyle  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.pdfbase import pdfmetrics  # noqa: E402
from reportlab.pdfbase.ttfonts import TTFont  # noqa: E402
from reportlab.platypus import Frame, Image as RLImage, Paragraph, Table, TableStyle  # noqa: E402
from reportlab.pdfgen import canvas as pdf_canvas  # noqa: E402


def _hex(value: str):
    """调色板里存裸十六进制（如 1E3A5F），reportlab 的 HexColor 要求带 # 前缀。"""
    return HexColor("#" + str(value).lstrip("#"))

PALETTES = {
    "nibi": {"bg": "FFFFFF", "titleBg": "1E3A5F", "titleFg": "FFFFFF", "accent": "E98A3C",
             "panelBg": "F7EFE2", "ink": "22252B", "inkSoft": "5A6072", "line": "D8D2C4"},
}
SIZES_MM = {
    "A0": (841, 1189), "A1": (594, 841), "A2": (420, 594), "A3": (297, 420),
    "B1": (707, 1000), "B2": (500, 707),
}


class PosterError(RuntimeError):
    pass


# ---------------------------------------------------------------- 字体


def register_font(family: str, label: str) -> str:
    """把本机字体文件注册进 reportlab；找不到就如实报错（不退回难看的默认体）。"""
    path = fonts.font_file(family)
    if path is None:
        available = "、".join(fonts.available_families()) or "（未识别到任何中文字体）"
        raise PosterError(
            f"找不到字体 {family!r}（{label}）。本机可用的中文字体：{available}。"
            f"换一个字体名，或先安装该字体（装字体前请先与用户确认）。")
    name = f"NIBI-{label}-{family}"
    if name not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(name, str(path), subfontIndex=0))
        # 粗体：找得到就注册真粗体，找不到就把粗体映射到自己（<b> 不会静默失效或报错）
        bold_name = name
        for candidate in (f"{family} Bold", f"{family} 粗体"):
            bold_path = fonts.font_file(candidate)
            if bold_path is not None:
                bold_name = f"{name}-Bold"
                if bold_name not in pdfmetrics.getRegisteredFontNames():
                    pdfmetrics.registerFont(TTFont(bold_name, str(bold_path), subfontIndex=0))
                break
        pdfmetrics.registerFontFamily(name, normal=name, bold=bold_name,
                                      italic=name, boldItalic=bold_name)
    return name


# ---------------------------------------------------------------- 版面


def build(spec: dict, out_path: Path, spec_dir: Path | None = None) -> dict:
    poster = spec.get("poster", {})
    palette = PALETTES.get(str(poster.get("palette", "nibi")))
    if palette is None:
        raise PosterError(f"未知调色板：{poster.get('palette')}（可选：{'、'.join(PALETTES)}）")
    size_name = str(poster.get("size", "A0")).upper()
    if size_name not in SIZES_MM:
        raise PosterError(f"未知纸张：{size_name}（可选：{'、'.join(SIZES_MM)}）")
    width_mm, height_mm = SIZES_MM[size_name]
    if str(poster.get("orientation", "portrait")).lower().startswith("land"):
        width_mm, height_mm = height_mm, width_mm
    bleed = float(poster.get("bleedMm", 0) or 0)
    safe = float(poster.get("safeMarginMm", 18) or 18)
    page_w, page_h = (width_mm + 2 * bleed) * mm, (height_mm + 2 * bleed) * mm
    margin = (bleed + safe) * mm

    font_spec = poster.get("fonts", {})
    title_font = register_font(str(font_spec.get("title", "微软雅黑")), "title")
    body_font = register_font(str(font_spec.get("body", "微软雅黑")), "body")

    ink = _hex(palette["ink"])
    ink_soft = _hex(palette["inkSoft"])
    title_bg = _hex(palette["titleBg"])
    title_fg = _hex(palette["titleFg"])
    accent = _hex(palette["accent"])
    panel_bg = _hex(palette["panelBg"])
    line = _hex(palette["line"])

    title_style = ParagraphStyle("title", fontName=title_font, fontSize=34, leading=42,
                                 textColor=title_fg, alignment=TA_CENTER, wordWrap="CJK")
    author_style = ParagraphStyle("author", fontName=body_font, fontSize=16, leading=22,
                                  textColor=title_fg, alignment=TA_CENTER, wordWrap="CJK")
    panel_title_style = ParagraphStyle("panelTitle", fontName=title_font, fontSize=17, leading=22,
                                       textColor=_hex(palette["titleBg"]), wordWrap="CJK")
    body_style = ParagraphStyle("body", fontName=body_font, fontSize=12.5, leading=18,
                                textColor=ink, alignment=TA_JUSTIFY, wordWrap="CJK",
                                # 子弹字形默认走 Helvetica（base-14，**不嵌入**）——
                                # 实测会被印前判据抓成"字体未嵌入"，必须跟随正文字体
                                bulletFontName=body_font, bulletFontSize=12.5)
    bullet_style = ParagraphStyle("bullet", parent=body_style, leftIndent=12, bulletIndent=2)
    stat_value_style = ParagraphStyle("statValue", fontName=title_font, fontSize=34, leading=40,
                                      textColor=_hex(palette["titleBg"]), alignment=TA_CENTER)
    stat_label_style = ParagraphStyle("statLabel", fontName=body_font, fontSize=13, leading=18,
                                      textColor=ink_soft, alignment=TA_CENTER, wordWrap="CJK")
    caption_style = ParagraphStyle("caption", fontName=body_font, fontSize=10.5, leading=14,
                                   textColor=ink_soft, alignment=TA_CENTER, wordWrap="CJK")
    footer_style = ParagraphStyle("footer", fontName=body_font, fontSize=11, leading=14,
                                  textColor=ink_soft, alignment=TA_LEFT, wordWrap="CJK")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    pdf = pdf_canvas.Canvas(str(out_path), pagesize=(page_w, page_h))
    # 画布初始字体是 Helvetica（base-14，不嵌入），会被写进页面资源；显式设成中文字体把它换掉
    pdf.setFont(body_font, 12)
    pdf.setTitle(str(poster.get("title", "")))
    pdf.setAuthor(str(poster.get("author", "NIBI")))
    if bleed > 0:
        pdf.setFillColor(_hex(palette["titleBg"]))
        pdf.rect(0, 0, page_w, page_h, stroke=0, fill=1)   # 出血底色（切纸后即版心内容）

    # ── 标题带 ─────────────────────────────────────────────
    title_paragraph = Paragraph(str(poster.get("title", "")), title_style)
    authors = poster.get("authors", [])
    author_line = "  ".join(str(item) for item in authors)
    if poster.get("affiliation"):
        author_line = f"{author_line}　　{poster['affiliation']}" if author_line else str(poster["affiliation"])
    author_paragraph = Paragraph(author_line, author_style) if author_line else None

    title_w = page_w - 2 * margin
    _, title_h = title_paragraph.wrap(title_w, page_h)
    _, author_h = author_paragraph.wrap(title_w, page_h) if author_paragraph else (0, 0)
    band_h = title_h + author_h + 16 * mm
    band_y = page_h - margin - band_h
    pdf.setFillColor(title_bg)
    pdf.roundRect(margin, band_y, title_w, band_h, 4 * mm, stroke=0, fill=1)
    pdf.setFillColor(accent)
    pdf.rect(margin + title_w - 4 * mm, band_y, 4 * mm, band_h, stroke=0, fill=1)
    title_paragraph.drawOn(pdf, margin, band_y + band_h - 8 * mm - title_h)
    if author_paragraph:
        author_paragraph.drawOn(pdf, margin, band_y + 6 * mm)

    # ── 脚注带 ─────────────────────────────────────────────
    footer_text = str(poster.get("footer", "")).strip()
    footer_paragraph = Paragraph(footer_text, footer_style) if footer_text else None
    content_top = band_y - 8 * mm
    content_bottom = margin + (14 * mm if footer_paragraph else 0)
    if footer_paragraph:
        pdf.setStrokeColor(line)
        pdf.setLineWidth(0.6)
        pdf.line(margin, margin + 10 * mm, page_w - margin, margin + 10 * mm)
        # drawOn 之前必须先 wrap（否则 reportlab 报 'Paragraph' object has no attribute 'blPara'）
        footer_paragraph.wrap(page_w - 2 * margin, 20 * mm)
        footer_paragraph.drawOn(pdf, margin, margin + 2 * mm)

    # ── 栏目 ───────────────────────────────────────────────
    columns = [list(column) for column in spec.get("columns", [])]
    if not columns:
        raise PosterError("规格里没有 columns（至少一栏）")
    gap = float(poster.get("columnGapMm", 8) or 8) * mm
    column_w = (page_w - 2 * margin - gap * (len(columns) - 1)) / len(columns)
    report: dict = {"size": f"{width_mm}×{height_mm}mm", "bleedMm": bleed,
                    "safeMarginMm": safe, "columns": len(columns), "panels": 0,
                    "images": 0, "blocks": []}
    styles_map = {"panelTitle": panel_title_style, "body": body_style, "bullet": bullet_style,
                  "statValue": stat_value_style, "statLabel": stat_label_style,
                  "caption": caption_style}
    font_map = {"title": title_font, "body": body_font}
    available = content_top - content_bottom

    def measure(blocks: list[dict], column_index: int) -> list[float]:
        """第一遍：只量（dry_run）。块高只与栏宽有关，各栏等宽 → 量一次就能用来均衡。"""
        heights: list[float] = []
        probe_top = content_top
        x = margin + (column_index - 1) * (column_w + gap)
        for block in blocks:
            height = _draw_block(None, block, x, probe_top, column_w, content_bottom, column_index,
                                 spec_dir, fonts_=font_map, styles=styles_map, palette=palette,
                                 report={"panels": 0, "images": 0, "blocks": []},
                                 gap=0.0, dry_run=True)
            heights.append(height)
            probe_top -= height
        return heights

    heights_by_column = [measure(column, index) for index, column in enumerate(columns, start=1)]

    # ── 栏均衡：两栏底不齐是海报最常见的肉眼缺陷，构建时就修，不等质量门 ──
    # 判据必须是**画出来的栏底**，不是块的裸高度和：每栏的富余是按自己的块数摊到间距里的
    # （而且有 maxGap 上限），所以"裸高度和相等"不等于"栏底对齐" —— 实测按裸和判会把
    # 一个 44mm 的块挪过头，栏底差反而从 10mm 变成 16mm。
    max_gap = float(poster.get("maxGapMm", 24) or 24) * mm

    def drawn_extent(heights: list[float]) -> float:
        total = sum(heights)
        slack = max(0.0, available - total)
        gap = min(max_gap, max(4 * mm, slack / (len(heights) + 1)))
        return total + gap * (len(heights) + 1)

    def objective(heights_by_column: list[list[float]]) -> tuple[float, float]:
        extents = [drawn_extent(heights) for heights in heights_by_column]
        return (available - min(extents), max(extents) - min(extents))   # (最差栏底留白, 栏底差)

    moves: list[str] = []
    if poster.get("balance", True):
        # 只在**值得动**的时候动：改善不到 2mm 的挪动不值得打乱作者的分栏
        # （实测：为了 0.4mm 的"改善"把一块 44mm 的参考文献挪到另一栏 —— 读数上看着一样，读起来变了）。
        min_gain = 2 * mm

        def worthwhile(candidate: tuple[float, float], current: tuple[float, float]) -> bool:
            if current[0] - candidate[0] > min_gain:
                return True
            return abs(candidate[0] - current[0]) <= 1e-9 and current[1] - candidate[1] > min_gain

        baseline = objective(heights_by_column)
        initial = baseline
        for _ in range(sum(len(column) for column in columns)):
            best_move: tuple[int, int] | None = None
            best_objective = baseline
            for tallest in range(len(columns)):
                for shortest in range(len(columns)):
                    if tallest == shortest or len(columns[tallest]) <= 1:
                        continue
                    trial = [list(heights) for heights in heights_by_column]
                    trial[shortest].append(trial[tallest].pop())
                    candidate = objective(trial)
                    if worthwhile(candidate, best_objective):
                        best_objective, best_move = candidate, (tallest, shortest)
            if best_move is None:
                break
            tallest, shortest = best_move
            moved = columns[tallest].pop()
            moved_height = heights_by_column[tallest].pop()
            columns[shortest].append(moved)
            heights_by_column[shortest].append(moved_height)
            label = str(moved.get("title") or moved.get("kind") or "块")
            moves.append(f"把「{label}」（{moved_height / mm:.0f}mm）从第 {tallest + 1} 栏挪到"
                         f"第 {shortest + 1} 栏：栏底留白 {baseline[0] / mm:.0f}mm →"
                         f"{best_objective[0] / mm:.0f}mm、栏底差 {baseline[1] / mm:.0f}mm →"
                         f"{best_objective[1] / mm:.0f}mm")
            baseline = best_objective
        report["balance"] = {"spreadMm": round(baseline[1] / mm, 1),
                             "bottomGapMm": round(baseline[0] / mm, 1),
                             "spreadBeforeMm": round(initial[1] / mm, 1),
                             "bottomGapBeforeMm": round(initial[0] / mm, 1),
                             "moves": moves}
        if moves:
            report.setdefault("warnings", []).append(
                "栏均衡改动了分栏（" + "；".join(moves) + "）—— 想保持原分栏就设 balance=false")
        if baseline[0] > 12 * mm:
            report.setdefault("warnings", []).append(
                f"栏底仍留白 {baseline[0] / mm:.0f}mm（两栏都到不了底）：靠挪块解决不了，"
                f"请补内容、放大字号或换更小的纸型")

    for column_index, (column, heights) in enumerate(zip(columns, heights_by_column), start=1):
        x = margin + (column_index - 1) * (column_w + gap)
        if sum(heights) > available:
            raise PosterError(f"第 {column_index} 栏内容总高 {sum(heights) / mm:.0f}mm 超过可用 "
                              f"{available / mm:.0f}mm —— 请精简文字或改成更多栏")
        # 第二遍：剩余空间均匀分成 (块数 + 1) 份间距，但**设上限** ——
        # 不限的话，内容少的栏目会被拉成"几座孤岛"（第一版把间距拉到 200mm，一眼就假）。
        # 超过上限的余量宁可留在页尾，并在报告里如实报"填充率"，提示换小纸型或补内容。
        column_gap = min(max_gap, max(4 * mm, (available - sum(heights)) / (len(column) + 1)))
        fill_ratio = (sum(heights) + column_gap * (len(column) + 1)) / available
        if fill_ratio < 0.8:
            report.setdefault("warnings", []).append(
                f"第 {column_index} 栏内容只占 {fill_ratio * 100:.0f}% 画布（间距已按上限 "
                f"{max_gap / mm:.0f}mm 分配）—— 建议换更小的纸型或补充内容，不要靠拉大间距填空")
        cursor = content_top - column_gap
        for block, height in zip(column, heights):
            _draw_block(pdf, block, x, cursor, column_w, content_bottom, column_index, spec_dir,
                        fonts_=font_map, styles=styles_map, palette=palette, report=report,
                        gap=column_gap, dry_run=False)
            cursor -= height + column_gap
    pdf.showPage()
    pdf.save()
    return report


def kinsoku_wrap(text: str, font_name: str, font_size: float, max_width: float) -> str:
    """按中文禁则换行：返回带 <br/> 的文本（行首不落收尾标点、行尾不留开引号/括号）。

    为什么自己换：reportlab 的 CJK 换行是"哪儿都能断"（源码自陈 dumb algorithm），
    实测把「（内部）
，2026-07。」断成行首逗号；而 `wordWrap="CJK"` 并不做禁则。

    算法：切单位（一个汉字 = 一个单位，一段数字/英文 = 一个整体、不许从中间断开），
    每行取**能放下的最长前缀**，再按禁则往回缩 —— 只会把行缩短，不会写出超宽的行
    （第一版"逐字回推 + hold"实测写出过 416pt 挤进 343pt 栏宽的行）。
    """
    if "<" in text:                      # 带标记的文本交给 reportlab（<b> 等由它解析）
        return text
    if not any("⺀" <= ch <= "鿿" or ch in textmetrics.LINE_START_FORBIDDEN
               for ch in text):
        return text                      # 纯西文：reportlab 的按词换行更合适
    units = re.findall(r"[⺀-鿿]|[^\s⺀-鿿]+|\s+", text)
    flattened: list[str] = []
    for unit in units:
        if unit.isspace() or pdfmetrics.stringWidth(unit, font_name, font_size) <= max_width:
            flattened.append(unit)
        else:
            flattened.extend(unit)       # 单个单位就超宽：先按字符拆，免得永远放不下
    widths = [pdfmetrics.stringWidth(unit, font_name, font_size) for unit in flattened]
    lines: list[str] = []
    start = 0
    while start < len(flattened):
        used = 0.0
        end = start
        while end < len(flattened) and used + widths[end] <= max_width + 1.0:
            used += widths[end]          # 1pt 容差与 reportlab 内部一致（它的 _FUZZ）
            end += 1
        if end == start:                 # 极端窄栏：至少放一个单位，避免死循环
            end = start + 1
        while end - start > 1 and end < len(flattened) and (
            flattened[end][0] in textmetrics.LINE_START_FORBIDDEN
            or flattened[end - 1][-1] in textmetrics.LINE_END_FORBIDDEN
        ):
            end -= 1                     # 禁则回缩：行首禁则标点、行尾开引号
        line = "".join(flattened[start:end]).rstrip()
        if line:
            lines.append(line)
        start = end
    return "<br/>".join(lines)


def _fit(flowables: list, width: float, height: float, label: str) -> float:
    """先量：内容总高超过给定高度就报错（不静默裁掉）。返回实际高度。"""
    total = 0.0
    for flowable in flowables:
        _, item_h = flowable.wrap(width, height)
        total += item_h + 1.6 * mm
    if total > height + 0.5:
        raise PosterError(f"{label} 内容高 {total / mm:.1f}mm 超过可用高度 {height / mm:.1f}mm —— "
                          f"请精简文字或调大该块（海报宁可少字，也不要挤到看不见）")
    return total


def _draw_block(pdf, block: dict, x: float, top: float, width: float, bottom: float,
                column_index: int, spec_dir: Path | None, *, fonts_: dict, styles: dict,
                palette: dict, report: dict, gap: float = 6 * mm, dry_run: bool = False) -> float:
    """画（或只量）一个板块，返回「块高 + 间距」。

    `dry_run=True` 只测量不落笔：海报必须**先量完一栏所有块，再把剩余空间均匀分给间距**，
    否则内容全挤在顶部、下面空一大片（实测第一版就是这样，明显失衡）。
    """
    kind = str(block.get("kind", "panel"))
    label = f"第 {column_index} 栏「{block.get('title', kind)}」"
    ink = _hex(palette["ink"])
    if kind == "panel":
        inner = width - 10 * mm
        flowables: list = []
        if block.get("title"):
            flowables.append(Paragraph(str(block["title"]), styles["panelTitle"]))
        body_style = styles["body"]
        for paragraph in block.get("paras", []):
            # 正文自换行（禁则）：宽度要按正文实际可用宽度扣掉段落的左右缩进
            text = kinsoku_wrap(str(paragraph), body_style.fontName, body_style.fontSize,
                                inner - getattr(body_style, "leftIndent", 0))
            flowables.append(Paragraph(text, body_style))
        for bullet in block.get("bullets", []):
            bullet_text = kinsoku_wrap(str(bullet), body_style.fontName, body_style.fontSize,
                                       inner - 12)
            flowables.append(Paragraph(bullet_text, styles["bullet"], bulletText="•"))
        for step in block.get("steps", []):
            step_text = kinsoku_wrap(str(step), body_style.fontName, body_style.fontSize, inner - 12)
            flowables.append(Paragraph(step_text, styles["bullet"], bulletText="→"))
        max_h = top - bottom
        content_h = _fit(flowables, inner, max_h, label)
        box_h = content_h + 14 * mm
        if top - box_h < bottom:
            raise PosterError(f"{label} 放不下：本栏剩余 { (top - bottom) / mm:.1f}mm，"
                              f"该块需要 {box_h / mm:.1f}mm")
        if not dry_run:
            pdf.setFillColor(_hex(palette["panelBg"]))
            pdf.roundRect(x, top - box_h, width, box_h, 3 * mm, stroke=0, fill=1)
            pdf.setFillColor(_hex(palette["accent"]))
            pdf.rect(x, top - box_h, 3 * mm, box_h, stroke=0, fill=1)
        cursor = top - 7 * mm
        for flowable in flowables:
            _, item_h = flowable.wrap(inner, max_h)
            if not dry_run:
                flowable.drawOn(pdf, x + 6 * mm, cursor - item_h)
            cursor -= item_h + 1.6 * mm      # 块内元素之间留一点呼吸（海报按远看设计，太挤会糊成一片）
        if not dry_run:
            report["panels"] += 1
            report["blocks"].append({"column": column_index, "kind": kind,
                                     "heightMm": round(box_h / mm, 1),
                                     "title": str(block.get("title", ""))})
        return box_h + gap

    if kind == "stat":
        items = block.get("items", [])
        if not items:
            raise PosterError(f"{label} stat 块没有 items")
        cell_h = 26 * mm
        value_style = styles["statValue"]
        label_style = styles["statLabel"]

        def measured(item: dict) -> float:
            """这一项实际需要多宽：数值与标签都按各自字号量，再加左右内边距。"""
            value_w = pdfmetrics.stringWidth(str(item.get("value", "")), value_style.fontName,
                                             value_style.fontSize)
            label_w = pdfmetrics.stringWidth(str(item.get("label", "")), label_style.fontName,
                                             label_style.fontSize)
            return max(value_w, label_w) + 10

        needed = [measured(item) for item in items]
        widest = max(needed)
        if widest > width:
            raise PosterError(
                f"{label} 统计项放不下：单项需要 {widest / mm:.1f}mm，栏宽只有 {width / mm:.1f}mm"
                f" —— 缩短数值/标签，或改成分栏更宽的版式")
        # 横排放不下就**换行**：实测 4 项指标卡在一栏里被挤成一团（数值互相压、标签压在数值上）。
        # 先量后排：能排几项一行，就按几项一行铺成网格。
        per_row = max(1, int(width // widest))
        per_row = min(per_row, len(items))
        row_count = -(-len(items) // per_row)
        table_rows: list[list] = []
        for index in range(row_count):
            chunk = items[index * per_row:(index + 1) * per_row]
            padding = per_row - len(chunk)
            table_rows.append([Paragraph(str(item.get("value", "")), value_style) for item in chunk]
                              + [Paragraph("", value_style)] * padding)
            table_rows.append([Paragraph(str(item.get("label", "")), label_style) for item in chunk]
                              + [Paragraph("", label_style)] * padding)
        flat = Table(table_rows, colWidths=[width / per_row] * per_row,
                     rowHeights=[cell_h * 0.62, cell_h * 0.38] * row_count)
        flat.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BACKGROUND", (0, 0), (-1, -1), _hex(palette["panelBg"])),
            ("BOX", (0, 0), (-1, -1), 0.4, _hex(palette["line"])),
            ("LINEAFTER", (0, 0), (-2, -1), 0.4, _hex(palette["line"])),
        ]))
        _, table_h = flat.wrap(width, top - bottom)
        if top - table_h < bottom:
            raise PosterError(f"{label} 放不下：需要 {table_h / mm:.1f}mm，剩余 {(top - bottom) / mm:.1f}mm")
        if not dry_run:
            flat.drawOn(pdf, x, top - table_h)
            report["blocks"].append({"column": column_index, "kind": kind,
                                     "heightMm": round(table_h / mm, 1), "items": len(items),
                                     "perRow": per_row})
        return table_h + gap

    if kind in ("image", "figure"):
        raw = str(block.get("path", ""))
        path = Path(raw).expanduser()
        if not path.is_absolute() and spec_dir is not None:
            path = (spec_dir / raw).resolve()
        if not path.is_file():
            raise PosterError(f"{label} 找不到图片：{path}")
        from PIL import Image as PILImage  # noqa: PLC0415

        with PILImage.open(path) as image:
            pixel_w, pixel_h = image.size
        caption = block.get("caption")
        caption_flowable = Paragraph(str(caption), styles["caption"]) if caption else None
        caption_h = caption_flowable.wrap(width, top - bottom)[1] + 2 * mm if caption_flowable else 0
        box_w = width
        box_h = top - bottom - caption_h
        ratio = pixel_w / pixel_h
        draw_w = box_w
        draw_h = draw_w / ratio
        if draw_h > box_h:            # 只缩一个维度，保持原始纵横比
            draw_h = box_h
            draw_w = draw_h * ratio
        if not dry_run:
            pdf.drawImage(str(path), x + (box_w - draw_w) / 2, top - draw_h, draw_w, draw_h,
                          preserveAspectRatio=True, anchor="c")
            if caption_flowable:
                caption_flowable.drawOn(pdf, x, top - draw_h - caption_h)
            report["images"] += 1
            report["blocks"].append({"column": column_index, "kind": kind,
                                     "heightMm": round(draw_h / mm, 1),
                                     "aspect": round(ratio, 4)})
        return draw_h + caption_h + gap

    if kind == "table":
        # 模型写规格时几乎必写 "headers"（复数），而契约键是 "header"。两种都收，
        # 但把复数写法记进告警 —— 静默兼容会让规格悄悄长歪（实测踩过：报的是 IndexError 栈）。
        header_source = block.get("header") or block.get("headers") or []
        header_cells = [str(item) for item in header_source]
        if not header_cells:
            raise PosterError(f"{label} 表格缺少表头：请给 \"header\": [\"列 1\", \"列 2\", …]")
        if "header" not in block and "headers" in block:
            report.setdefault("warnings", []).append(
                f"{label} 用了 \"headers\"，契约键是 \"header\"（本次已按复数写法渲染）")
        body_rows = [[str(cell) for cell in row] for row in block.get("rows", [])]
        for row_index, row in enumerate(body_rows, start=1):
            if len(row) != len(header_cells):
                raise PosterError(
                    f"{label} 第 {row_index} 行有 {len(row)} 列，表头是 {len(header_cells)} 列 —— 列数必须一致")

        def is_number(text: str) -> bool:
            cleaned = (text.replace(",", "").replace("%", "").replace("+", "")
                       .replace(".", "").replace("-", "").strip())
            return bool(cleaned) and cleaned.isdigit()

        numeric = [index > 0 and all(is_number(row[index]) for row in body_rows
                                     if index < len(row))
                   for index in range(len(header_cells))]
        right_style = ParagraphStyle("tableNum", parent=styles["body"])
        right_style.alignment = TA_RIGHT
        header = [Paragraph(f"<b>{item}</b>", styles["body"]) for item in header_cells]
        rows = [header] + [[Paragraph(str(cell), right_style if numeric[index] else styles["body"])
                            for index, cell in enumerate(row)] for row in body_rows]
        table = Table(rows, colWidths=[width / max(len(header_cells), 1)] * len(rows[0]))
        table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BACKGROUND", (0, 0), (-1, 0), _hex(palette["panelBg"])),
            ("GRID", (0, 0), (-1, -1), 0.4, _hex(palette["line"])),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ]))
        _, table_h = table.wrap(width, top - bottom)
        if top - table_h < bottom:
            raise PosterError(f"{label} 放不下：需要 {table_h / mm:.1f}mm，剩余 {(top - bottom) / mm:.1f}mm")
        if not dry_run:
            table.drawOn(pdf, x, top - table_h)
            report["blocks"].append({"column": column_index, "kind": kind,
                                     "heightMm": round(table_h / mm, 1)})
        return table_h + gap

    raise PosterError(f"{label} 未知的块类型：{kind}（可选 panel/stat/image/table）")


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="按规格生成学术海报 PDF")
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    cli.add_common(parser)
    args = parser.parse_args()

    spec_path = Path(args.spec).expanduser()
    if not spec_path.is_file():
        print(f"找不到规格文件：{spec_path}", file=sys.stderr)
        return 2
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    out_path = Path(args.out).expanduser()
    try:
        report = build(spec, out_path, spec_path.resolve().parent)
    except PosterError as error:
        print(f"生成失败：{error}", file=sys.stderr)
        return 2
    size_kb = out_path.stat().st_size / 1024 if out_path.is_file() else 0
    lines = [f"已生成 {out_path}（{size_kb:.1f} KB）",
             f"  版面 {report['size']}，{report['columns']} 栏，"
             f"安全边距 {report['safeMarginMm']:g}mm，出血 {report['bleedMm']:g}mm",
             f"  板块 {report['panels']} 个、图片 {report['images']} 张"]
    for block in report["blocks"]:
        lines.append(f"  · 第 {block['column']} 栏 {block['kind']}"
                     f"（{block['heightMm']}mm）{block.get('title', '')}")
    for warning in report.get("warnings", []):
        lines.append(f"  ! {warning}")
    lines.append("下一步：python tools/pdf_gate.py --pdf <文件>（字体嵌入/页面尺寸/贴边/逐页出图）")
    cli.emit({"summary": "\n".join(lines), "out": str(out_path), "report": report}, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

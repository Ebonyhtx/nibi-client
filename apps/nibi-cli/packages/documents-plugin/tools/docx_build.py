"""把 JSON 规格落成 .docx（python-docx），含静态目录的两遍生成。

用法：
    python tools/docx_build.py --spec 文档.json --out 交付/项目报告.docx
    python tools/docx_build.py --spec 文档.json --out 报告.docx --no-toc-resolve   # 目录页码留空

设计要点：

* **命名样式落进文档**（宋体/黑体 + eastAsia 同时设），生成物在 Word 里可继续编辑，
  不会出现"中文被换成别的字体"；
* **首行缩进用"字符数"而不是磅值**（`w:firstLineChars`），换字号不会错位；
* **页脚页码用 PAGE 域**（LibreOffice/Word 都会算），不是手写数字；
* **目录两遍生成**：第一遍占位页码（行数与最终一致，保证分页不变）→ 从渲染出的 PDF 里
  定位标题页 → 第二遍写真页码；定位不到的目标页码留空并如实报告（质量门会拦）；
* **图片按原始纵横比缩放**（只给宽度），杜绝"被拉扁"的图。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, engines, hygiene  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["docx", "PIL"], "docx_build（python-docx + pillow）")

import docx_spec as spec_mod  # noqa: E402
import docx_toc  # noqa: E402
from docx import Document  # noqa: E402
from docx.enum.style import WD_STYLE_TYPE  # noqa: E402
from docx.enum.table import WD_TABLE_ALIGNMENT  # noqa: E402
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER  # noqa: E402
from docx.oxml import OxmlElement  # noqa: E402
from docx.oxml.ns import qn  # noqa: E402
from docx.shared import Cm, Pt, RGBColor  # noqa: E402

ALIGNMENTS = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER,
              "right": WD_ALIGN_PARAGRAPH.RIGHT, "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}


class BuildError(RuntimeError):
    pass


# ---------------------------------------------------------------- 样式


def set_east_asian(rpr_holder, cjk: str, latin: str) -> None:
    """字体要同时设 ascii/hAnsi 与 **eastAsia**：只设前者，中文会被 Word 替换成别的字体。"""
    rpr = rpr_holder.get_or_add_rPr() if hasattr(rpr_holder, "get_or_add_rPr") else rpr_holder
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.append(fonts)
    fonts.set(qn("w:ascii"), latin)
    fonts.set(qn("w:hAnsi"), latin)
    fonts.set(qn("w:eastAsia"), cjk)
    fonts.set(qn("w:cs"), latin)


def build_styles(document: Document, styles: dict, palette: dict) -> None:
    from docx.enum.text import WD_LINE_SPACING  # noqa: PLC0415

    for name, definition in styles.items():
        try:
            style = document.styles[name]
        except KeyError:
            style = document.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
        style.base_style = document.styles["Normal"] if name != "docTitle" else None
        font = style.font
        font.size = Pt(float(definition.get("size", 12)))
        font.bold = bool(definition.get("bold", False))
        font.italic = bool(definition.get("italic", False))
        color = definition.get("color")
        if color:
            font.color.rgb = RGBColor.from_string(palette.get(color, color.lstrip("#")))
        set_east_asian(style.element, definition.get("cjk", "宋体"),
                       definition.get("latin", "Times New Roman"))
        paragraph_format = style.paragraph_format
        paragraph_format.alignment = ALIGNMENTS.get(definition.get("align", "left"))
        if definition.get("spaceBefore") is not None:
            paragraph_format.space_before = Pt(float(definition["spaceBefore"]))
        if definition.get("spaceAfter") is not None:
            paragraph_format.space_after = Pt(float(definition["spaceAfter"]))
        if definition.get("lineSpacing"):
            paragraph_format.line_spacing = float(definition["lineSpacing"])
        if definition.get("keepWithNext"):
            paragraph_format.keep_with_next = True


def apply_first_line_indent(paragraph, chars: float, size_pt: float) -> None:
    """首行缩进 2 字符：写 `w:firstLineChars`（字符单位）并给一个磅值兜底。

    只写磅值的话，字号一变缩进就不对了（中文排版里"2 字符"是语义，不是长度）。
    """
    if chars <= 0:
        return
    indentation = paragraph._p.get_or_add_pPr().get_or_add_ind()
    indentation.set(qn("w:firstLineChars"), str(int(chars * 100)))
    indentation.set(qn("w:firstLine"), str(int(chars * size_pt * 20)))


# ---------------------------------------------------------------- 内容


def add_footer_page_number(document: Document, style_name: str = "note") -> None:
    for section in document.sections:
        paragraph = section.footer.paragraphs[0] if section.footer.paragraphs else section.footer.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for existing in list(paragraph.runs):
            existing._element.getparent().remove(existing._element)
        run = paragraph.add_run()
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor.from_string("5A6072")
        begin = OxmlElement("w:fldChar")
        begin.set(qn("w:fldCharType"), "begin")
        instruction = OxmlElement("w:instrText")
        instruction.set(qn("xml:space"), "preserve")
        instruction.text = "PAGE"
        end = OxmlElement("w:fldChar")
        end.set(qn("w:fldCharType"), "end")
        run._r.append(begin)
        run._r.append(instruction)
        run._r.append(end)


def add_toc_field(document: Document, depth: int, title: str) -> None:
    heading = document.add_paragraph(title, style="h2")
    heading.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph = document.add_paragraph()
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instruction = OxmlElement("w:instrText")
    instruction.set(qn("xml:space"), "preserve")
    instruction.text = f'TOC \\o "1-{depth}" \\h \\z \\u'
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    placeholder = OxmlElement("w:t")
    placeholder.text = "（在 Word 里按 F9 更新目录；LibreOffice 走「工具 → 更新 → 目录」）"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for node in (begin, instruction, separate, placeholder, end):
        run._r.append(node)


def add_static_toc(document: Document, entries: list[tuple[int, str, int | None]], title: str,
                   text_width_cm: float) -> None:
    heading = document.add_paragraph(title, style="h2")
    heading.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for level, text, page in entries:
        paragraph = document.add_paragraph(style="bodyNoIndent")
        paragraph.paragraph_format.tab_stops.add_tab_stop(
            Cm(text_width_cm), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
        if level >= 1:
            paragraph.paragraph_format.left_indent = Pt(12 * level)
        paragraph.add_run(text)
        paragraph.add_run("\t" + (str(page) if page else ""))
    document.add_page_break()


def bullet_style(document: Document) -> str:
    """项目符号用哪套样式。

    只把样式的 `bullet: True` 写进定义**不会**产生符号 —— 符号要靠 numbering 定义
    （实测：渲染出来是一堆没有符号的缩进段落）。python-docx 的默认模板自带
    「List Bullet」，用它；没有就退回手写 "• " 前缀，绝不静默返回无符号段落。
    """
    try:
        style = document.styles["List Bullet"]
    except KeyError:
        return "bullet"
    set_east_asian(style.element, "宋体", "Times New Roman")
    style.font.size = Pt(12)
    style.base_style = document.styles["Normal"]
    return "List Bullet"


def add_table(document: Document, element: dict, palette: dict) -> int:
    header = [str(item) for item in element.get("header", [])]
    rows = element.get("rows", [])
    if not header:
        raise BuildError("table 必须有 header")
    table = document.add_table(rows=1, cols=len(header))
    table.style = element.get("style", "Table Grid")
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for index, text in enumerate(header):
        cell = table.rows[0].cells[index]
        cell.text = ""
        paragraph = cell.paragraphs[0]
        paragraph.style = document.styles["tableHeader"]
        paragraph.add_run(text)
        shading = OxmlElement("w:shd")
        shading.set(qn("w:val"), "clear")
        shading.set(qn("w:fill"), palette.get(element.get("headerFill", "zebra"), "F4F1EA"))
        cell._tc.get_or_add_tcPr().append(shading)
    alignments = column_alignments(header, rows)
    for row in rows:
        cells = table.add_row().cells
        for index, value in enumerate(row[:len(header)]):
            cells[index].text = ""
            paragraph = cells[index].paragraphs[0]
            paragraph.style = document.styles["tableText"]
            paragraph.paragraph_format.alignment = ALIGNMENTS.get(alignments[index], WD_ALIGN_PARAGRAPH.LEFT)
            paragraph.add_run("" if value is None else str(value))
    if element.get("widths"):
        widths = [float(item) for item in element["widths"]]
        for row in table.rows:
            for index, width in enumerate(widths[:len(row.cells)]):
                row.cells[index].width = Cm(width)
    header_row = table.rows[0]
    _repeat_header(header_row)
    return len(rows) + 1


NUMERIC_CELL = __import__("re").compile(r"^[+\-−]?\s*[¥$]?\s*[0-9][0-9,\.]*\s*%?\s*(pp|万元|元|人|天|个|次)?$")


def column_alignments(header: list[str], rows: list) -> list[str]:
    """按列的数据决定对齐：整列都是数字/百分比 → 右对齐（表头居中）。

    表格里数字左对齐是最常见的观感缺陷（数位对不齐，读者要靠眼睛找小数点）。
    """
    alignments: list[str] = []
    for index in range(len(header)):
        values = [str(row[index]) for row in rows
                  if index < len(row) and row[index] not in (None, "")]
        if values and all(NUMERIC_CELL.match(value.strip()) for value in values):
            alignments.append("right")
        else:
            alignments.append("left")
    return alignments


def _repeat_header(row) -> None:
    """跨页时重复表头（长表格不重复表头是最常见的阅读缺陷之一）。"""
    properties = row._tr.get_or_add_trPr()
    marker = OxmlElement("w:tblHeader")
    marker.set(qn("w:val"), "true")
    properties.append(marker)


def add_figure(document: Document, element: dict, text_width_cm: float,
               spec_dir: Path | None = None) -> dict:
    raw = str(element.get("path", ""))
    path = Path(raw).expanduser()
    if not path.is_absolute() and spec_dir is not None:
        # 规格里的相对路径按**规格文件所在目录**解析（相对 cwd 会因调用位置不同而找不到）
        path = (spec_dir / raw).resolve()
    if not path.is_file():
        raise BuildError(f"figure 找不到图片：{path}")
    from PIL import Image  # noqa: PLC0415

    with Image.open(path) as image:
        pixel_width, pixel_height = image.size
    width_cm = float(element.get("printWidthCm") or min(text_width_cm, 14.0))
    if width_cm > text_width_cm + 0.01:
        raise BuildError(f"figure 打印宽度 {width_cm}cm 超过版心 {text_width_cm:.1f}cm（会被裁或缩）")
    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.paragraph_format.space_after = Pt(0)
    run = paragraph.add_run()
    shape = run.add_picture(str(path), width=Cm(width_cm))
    alt = str(element.get("alt", "")).strip()
    if alt:
        # 替代文字（无障碍与检索都靠它）；没给就留空，质量门会告警。
        try:
            shape._inline.docPr.set("descr", alt)
            shape._inline.docPr.set("title", alt)
        except AttributeError:
            pass
    return {"path": str(path), "printWidthCm": width_cm, "alt": alt,
            "displayAspect": round(pixel_width / pixel_height, 5),
            "pixelWidth": pixel_width, "pixelHeight": pixel_height}


def add_paragraph(document: Document, element: dict, styles: dict, default_style: str) -> None:
    style_name = element.get("style", default_style)
    paragraph = document.add_paragraph(style=style_name)
    definition = styles.get(style_name, {})
    if element.get("align"):
        paragraph.paragraph_format.alignment = ALIGNMENTS.get(element["align"])
    text = str(element.get("text", ""))
    if element.get("boldPrefix"):
        prefix = str(element["boldPrefix"])
        run = paragraph.add_run(prefix)
        run.bold = True
        text = text[len(prefix):] if text.startswith(prefix) else text
    if element.get("bold"):
        paragraph.add_run(text).bold = True
    else:
        paragraph.add_run(text)
    if definition.get("indentChars"):
        apply_first_line_indent(paragraph, float(definition["indentChars"]),
                                float(definition.get("size", 12)))
    if element.get("indentChars"):
        apply_first_line_indent(paragraph, float(element["indentChars"]),
                                float(definition.get("size", 12)))


# ---------------------------------------------------------------- 主流程


def build(spec: dict, out_path: Path, toc_pages: dict[str, int | None] | None = None,
          toc_mode: str = "static", spec_dir: Path | None = None) -> dict:
    document_spec = spec.get("document", {})
    styles = spec_mod.styles_with_overrides(spec.get("styles"))
    palette = spec_mod.palette(document_spec.get("theme", "nibi"))

    document = Document()
    build_styles(document, styles, palette)
    page = document_spec.get("page", {})
    size = str(page.get("size", "A4")).upper()
    for section in document.sections:
        section.page_width, section.page_height = (Cm(21), Cm(29.7)) if size == "A4" else (Cm(21.59), Cm(27.94))
        for key, attribute in (("top", "top_margin"), ("bottom", "bottom_margin"),
                               ("left", "left_margin"), ("right", "right_margin")):
            if page.get(key):
                setattr(section, attribute, Cm(float(page[key])))
        if page.get("orientation") == "landscape":
            section.page_width, section.page_height = section.page_height, section.page_width
    text_width_cm = ((document.sections[0].page_width - document.sections[0].left_margin
                      - document.sections[0].right_margin) / 360000)
    add_footer_page_number(document)
    if document_spec.get("title"):
        document.core_properties.title = str(document_spec["title"])
    document.core_properties.author = str(document_spec.get("author", "NIBI"))
    hygiene.scrub_core_properties(document.core_properties,
                                  author=str(document_spec.get("author", "NIBI")))

    summary = {"paragraphs": 0, "tables": 0, "figures": [], "tocEntries": 0, "headings": []}
    figure_index = 0
    table_index = 0
    for position, element in enumerate(spec.get("content", [])):
        if element.get("type") == "toc" and position > 0:
            # 目录前先分页：否则目录跟封面挤在同一页 —— 封面会被判成"目录页"，
            # 文档标题（在封面上）就永远定位不到页码（实测踩过）。
            document.add_page_break()
        kind = element.get("type", "paragraph")
        if kind == "title":
            paragraph = document.add_paragraph(str(element.get("text", "")), style="docTitle")
            paragraph.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
            summary["paragraphs"] += 1
            for line in element.get("subtitle", []) if isinstance(element.get("subtitle"), list) \
                    else ([element["subtitle"]] if element.get("subtitle") else []):
                document.add_paragraph(str(line), style="docSubtitle")
                summary["paragraphs"] += 1
        elif kind == "toc":
            if toc_mode == "field":
                add_toc_field(document, int(element.get("depth", 3)), str(element.get("title", "目录")))
            else:
                entries = spec_mod.outline_entries(spec)
                resolved = [(level, text, (toc_pages or {}).get(text)) for level, text in entries]
                add_static_toc(document, resolved, str(element.get("title", "目录")), text_width_cm)
                summary["tocEntries"] = len(resolved)
        elif kind == "heading":
            level = int(element.get("level", 1))
            style_name = f"h{min(max(level, 1), 3)}"
            document.add_paragraph(str(element.get("text", "")), style=style_name)
            summary["headings"].append({"level": level, "text": str(element.get("text", ""))})
            summary["paragraphs"] += 1
        elif kind == "paragraph":
            add_paragraph(document, element, styles, "body")
            summary["paragraphs"] += 1
        elif kind == "bullets":
            for item in element.get("items", []):
                paragraph = document.add_paragraph(str(item), style=bullet_style(document))
                paragraph.paragraph_format.left_indent = Pt(24)
                summary["paragraphs"] += 1
        elif kind == "table":
            rows_written = add_table(document, element, palette)
            table_index += 1
            caption = element.get("caption")
            if caption:
                number = f"表 {table_index} " if element.get("autoNumber", True) else ""
                document.add_paragraph(f"{number}{caption}", style="caption")
                summary["paragraphs"] += 1
            summary["tables"] += 1
            summary.setdefault("tableRows", []).append(rows_written)
        elif kind == "figure":
            figure_index += 1
            info = add_figure(document, element, text_width_cm, spec_dir)
            caption = element.get("caption")
            if caption:
                number = f"图 {figure_index} " if element.get("autoNumber", True) else ""
                paragraph = document.add_paragraph(f"{number}{caption}", style="caption")
                paragraph.paragraph_format.space_before = Pt(6)
                summary["paragraphs"] += 1
            summary["figures"].append(info)
        elif kind == "note":
            document.add_paragraph(str(element.get("text", "")), style="note")
            summary["paragraphs"] += 1
        elif kind == "code":
            for line in str(element.get("text", "")).splitlines() or [""]:
                document.add_paragraph(line, style="code")
                summary["paragraphs"] += 1
        elif kind == "pagebreak":
            document.add_page_break()
        elif kind == "signature":
            document.add_paragraph("")
            for line in element.get("lines", []):
                paragraph = document.add_paragraph(str(line), style="bodyNoIndent")
                paragraph.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.RIGHT
                summary["paragraphs"] += 1
        else:
            raise BuildError(f"未知内容类型：{kind}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    document.save(out_path)
    summary["textWidthCm"] = round(text_width_cm, 2)
    return summary


def resolve_toc(spec: dict, workdir: Path, summary_draft: dict) -> tuple[dict, dict]:
    """两遍生成：占位 → 渲染定位 → 写真页码。返回 (页码表, 定位报告)。"""
    entries = spec_mod.outline_entries(spec)
    if not entries:
        return {}, {"skipped": "规格里没有目录条目"}
    report: dict = {"located": 0, "missing": [], "engine": False}
    engine = engines.engine_report()
    if not engine.can_convert:
        report["note"] = "没有 LibreOffice，目录页码未解析（留空）；质量门会拦这条。"
        return {text: None for _, text in entries}, report
    placeholder = workdir / "toc-pass1.docx"
    build(spec, placeholder, toc_pages={text: None for _, text in entries},
          spec_dir=spec.get("_specDir"))
    try:
        pdf = engines.convert_to_pdf(placeholder, workdir)
        pages = engines.pdf_text_per_page(pdf)
    except engines.ConvertError as error:
        report["note"] = f"第一遍渲染失败，目录页码未解析：{error}"
        return {text: None for _, text in entries}, report
    toc_title = "目录"
    for element in spec.get("content", []):
        if element.get("type") == "toc":
            toc_title = str(element.get("title", toc_title))
            break
    located = docx_toc.locate(pages, [text for _, text in entries], toc_title)
    report["engine"] = True
    report["pages"] = len(pages)
    report["tocTotal"] = len(entries)
    report["located"] = sum(1 for value in located.values() if value)
    report["missing"] = [text for text, value in located.items() if not value]
    return located, report


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="从 JSON 规格构建 .docx")
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--toc-mode", choices=["static", "field", "none"], default="static",
                        help="static=写入真页码（两遍生成并校验）；field=TOC 域（Word 里按 F9 更新）；none=不写目录")
    parser.add_argument("--no-toc-resolve", action="store_true", help="跳过两遍定位（页码留空）")
    cli.add_common(parser)
    args = parser.parse_args()

    try:
        spec = spec_mod.load_spec(args.spec)
        spec["_specDir"] = Path(args.spec).expanduser().resolve().parent
    except spec_mod.SpecError as error:
        print(f"规格不合法：{error}", file=sys.stderr)
        return 2
    out_path = Path(args.out).expanduser()
    toc_mode = "none" if args.toc_mode == "none" else args.toc_mode
    spec = dict(spec)
    if toc_mode == "none":
        spec["content"] = [item for item in spec["content"] if item.get("type") != "toc"]

    toc_report: dict = {"skipped": "--toc-mode none"}
    pages: dict[str, int | None] = {}
    if toc_mode == "static" and not args.no_toc_resolve:
        with __import__("tempfile").TemporaryDirectory(prefix="nibi-docx-toc-") as raw:
            pages, toc_report = resolve_toc(spec, Path(raw), {})
    try:
        summary = build(spec, out_path, toc_pages=pages, toc_mode=toc_mode,
                        spec_dir=Path(args.spec).expanduser().resolve().parent)
    except (BuildError, spec_mod.SpecError) as error:
        print(f"构建失败：{error}", file=sys.stderr)
        return 2

    size_kb = out_path.stat().st_size / 1024 if out_path.is_file() else 0
    lines = [f"已生成 {out_path}（{size_kb:.1f} KB）",
             f"  段落 {summary['paragraphs']}、表格 {summary['tables']}、图片 {len(summary['figures'])}、"
             f"标题 {len(summary['headings'])}、目录条目 {summary['tocEntries']}",
             f"  版心宽度 {summary['textWidthCm']}cm，页脚已加页码域"]
    if toc_mode == "static":
        if toc_report.get("engine"):
            total = toc_report.get("tocTotal") or toc_report["located"]
            lines.append(f"  目录页码：定位 {toc_report['located']}/{total} 条"
                         f"（PDF 共 {toc_report.get('pages', '?')} 页）")
            if toc_report.get("missing"):
                lines.append(f"  ✗ 以下标题在渲染结果里找不到，页码留空：{'、'.join(toc_report['missing'])}")
        elif toc_report.get("note"):
            lines.append(f"  ! {toc_report['note']}")
    lines.append("下一步：python tools/docx_gate.py --xlsx 换成 --docx 跑质量门；"
                 "python tools/docx_render.py 出逐页图")
    cli.emit({"summary": "\n".join(lines), "out": str(out_path), "build": summary,
              "toc": toc_report}, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""字体/字号解析与结构遍历：判据与回读共用的地基。

## 为什么单独成模块

DOCX 的字体是**三层叠加**的：run 的 rPr → 段落样式的 rPr → 文档默认（docDefaults / Normal）。
中文文档最容易出的缺陷就藏在这里：**只设了 ascii/hAnsi 没设 eastAsia** —— Word 会给中文
换一个字体（渲染出来跟作者以为的不是一回事）。判据要拿到"这段中文最终用什么字体"，
就必须按这三层解析，只看 run 会漏掉样式里设的，只看样式会漏掉 run 里覆盖的。

字号同理：run 没有显式字号时，取样式字号，再取默认 12pt。
"""

from __future__ import annotations

from docx.oxml.ns import qn

DEFAULT_SIZE_PT = 12.0
DEFAULT_CJK = "宋体"
DEFAULT_LATIN = "Times New Roman"

HEADING_STYLES = ("h1", "h2", "h3", "docTitle")


def _fonts_of(element) -> tuple[str | None, str | None]:
    rpr = element.find(qn("w:rPr")) if element is not None else None
    fonts = rpr.find(qn("w:rFonts")) if rpr is not None else None
    if fonts is None:
        return None, None
    return fonts.get(qn("w:eastAsia")), fonts.get(qn("w:ascii"))


def _size_of(element) -> float | None:
    rpr = element.find(qn("w:rPr")) if element is not None else None
    if rpr is None:
        return None
    half_points = rpr.find(qn("w:sz"))
    if half_points is None:
        return None
    try:
        return float(half_points.get(qn("w:val"))) / 2
    except (TypeError, ValueError):
        return None


def style_fonts(style) -> dict:
    """样式里显式声明的字体/字号（不含继承）。"""
    cjk, latin = _fonts_of(style.element)
    size = _size_of(style.element)
    if size is None and style.font.size is not None:
        size = float(style.font.size.pt)
    return {"cjk": cjk, "latin": latin, "size": size}


def resolve_style_chain(paragraph, document) -> dict:
    """从段落样式沿 base 链向上找第一个显式声明（最多 3 层），再回退文档默认。"""
    result = {"cjk": None, "latin": None, "size": None, "styleName": ""}
    style = paragraph.style
    if style is None:
        return {**result, "cjk": DEFAULT_CJK, "latin": DEFAULT_LATIN, "size": DEFAULT_SIZE_PT}
    result["styleName"] = style.name
    depth = 0
    while style is not None and depth < 4:
        declared = style_fonts(style)
        for key in ("cjk", "latin", "size"):
            if result[key] is None and declared.get(key):
                result[key] = declared[key]
        style = style.base_style
        depth += 1
    for key, fallback in (("cjk", DEFAULT_CJK), ("latin", DEFAULT_LATIN),
                          ("size", DEFAULT_SIZE_PT)):
        if result[key] is None:
            result[key] = fallback
    return result


def run_fonts(run, paragraph, document) -> dict:
    """**单个 run** 的最终字体/字号（run → 段落样式链 → 默认）。

    判据必须逐 run 解析：只看段落里第一个 run 会漏掉"同一段里后半截被设成别的字体/字号"
    —— 反向对照抓到过这个洞（段内混排字体不被发现）。
    """
    chain = resolve_style_chain(paragraph, document)
    cjk, latin = _fonts_of(run._element)
    size = _size_of(run._element)
    if run.font.size is not None:
        size = float(run.font.size.pt)
    return {"cjk": cjk or chain["cjk"], "latin": latin or chain["latin"],
            "size": size or chain["size"], "styleName": chain["styleName"],
            "directFormat": any(value is not None for value in (cjk, latin, size))}


def paragraph_fonts(paragraph, document) -> dict:
    """段落的"最终字体/字号"：取第一个有文字的 run 的解析结果（判据与回读都用这个口径）。"""
    from docx.text.paragraph import Paragraph  # noqa: PLC0415

    assert isinstance(paragraph, Paragraph)
    chain = resolve_style_chain(paragraph, document)
    for run in paragraph.runs:
        if not run.text:
            continue
        cjk, latin = _fonts_of(run._element)
        size = _size_of(run._element)
        if run.font.size is not None:
            size = float(run.font.size.pt)
        return {"cjk": cjk or chain["cjk"], "latin": latin or chain["latin"],
                "size": size or chain["size"], "styleName": chain["styleName"],
                "directFormat": any(value is not None for value in (cjk, latin, size))}
    return {"cjk": chain["cjk"], "latin": chain["latin"], "size": chain["size"],
            "styleName": chain["styleName"], "directFormat": False}


def iter_paragraphs(document):
    """遍历文档里所有段落：正文 + 表格单元格（递归）+ 页眉页脚，带位置标签。"""
    for index, paragraph in enumerate(document.paragraphs):
        yield f"正文#{index + 1}", paragraph
    for table_index, table in enumerate(document.tables, start=1):
        for row_index, row in enumerate(table.rows, start=1):
            for cell_index, cell in enumerate(row.cells, start=1):
                for paragraph in cell.paragraphs:
                    yield f"表{table_index} r{row_index}c{cell_index}", paragraph
    for section_index, section in enumerate(document.sections, start=1):
        for part, label in ((section.header, "页眉"), (section.footer, "页脚")):
            for paragraph in part.paragraphs:
                yield f"{label}{section_index}", paragraph


def iter_runs(document):
    for location, paragraph in iter_paragraphs(document):
        for run in paragraph.runs:
            if run.text.strip():
                yield location, paragraph, run


def read_toc_entries(document) -> list[tuple[int, str, int | None]]:
    """读出静态目录：`目录` 标题段之后、带制表位的段落 → (层级, 标题, 页码)。"""
    entries: list[tuple[int, str, int | None]] = []
    started = False
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not started:
            if text in ("目录", "目  录", "Contents"):
                started = True
            continue
        if not text:
            continue
        if "\t" not in paragraph.text:
            break
        title, _, page = paragraph.text.rpartition("\t")
        page_text = page.strip()
        page_number = int(page_text) if page_text.isdigit() else None
        indent_pt = paragraph.paragraph_format.left_indent
        level = int(round(indent_pt.pt / 12)) if indent_pt else 0
        entries.append((max(level, 0), title.strip(), page_number))
    return entries


def footer_has_page_field(document) -> bool:
    for section in document.sections:
        for paragraph in section.footer.paragraphs:
            xml = paragraph._p.xml
            if "PAGE" in xml and "fldChar" in xml:
                return True
    return False

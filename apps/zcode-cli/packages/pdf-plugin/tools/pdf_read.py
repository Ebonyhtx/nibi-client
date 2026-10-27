"""读回 .pdf 的结构、字体与元数据（JSON/文本）。

    python tools/pdf_read.py --pdf 交付.pdf [--text] [--pages 1-3] [--json-out 结构.json]

这是**印前检查的勘察步**：页数、页面尺寸是否一致、字体是否嵌入（印刷厂最在意的一条）、
元数据里有没有本机痕迹、每页有没有文字图层（没有就是扫描件）。这些都不需要外部引擎 ——
pypdfium2/pypdf 直接读。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, engines  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["pypdfium2", "pypdf"], "pdf_read（pypdfium2 + pypdf）")

from pypdf import PdfReader  # noqa: E402

STANDARD_SIZES = {"A4": (595.28, 841.89), "A4-landscape": (841.89, 595.28),
                  "A3": (841.89, 1190.55), "Letter": (612.0, 792.0),
                  "B5": (498.9, 708.66)}


def size_name(width: float, height: float) -> str:
    for name, (standard_width, standard_height) in STANDARD_SIZES.items():
        if abs(width - standard_width) < 3 and abs(height - standard_height) < 3:
            return name
    return "自定义"


def used_font_keys(page) -> set[str]:
    """内容流里真正被选中的字体资源键（`/F1 12 Tf` 这种）。

    为什么要看这个：reportlab 等生成器会把画布的**初始字体**（Helvetica，base-14）写进页面资源，
    但正文一个字都没用它。只看资源字典会把它判成"未嵌入字体"（假阳性，实测踩过）。
    """
    try:
        contents = page.get_contents()
        if contents is None:
            return set()
        data = contents.get_data()
    except Exception:  # noqa: BLE001 - 读不到内容流就不做这个判断，按"用过"保守处理
        return set()
    # 判"真的画了字"：跟着字体选择找 **文本显示操作**（TJ/Tj）。
    # 只数 Tf 会被 reportlab 的空文本对象骗到（它写 `/F1 12 Tf ET` 却一个字不画，
    # 那是 base-14 的 Helvetica，会把我们的"未嵌入字体"判据变成假阳性 —— 实测踩过）。
    pattern = re.compile(rb"/([A-Za-z0-9+._-]+)\s+[-\d.]+\s+Tf|(?:TJ|Tj)")
    used: set[str] = set()
    current = ""
    for match in pattern.finditer(data):
        if match.group(1):
            current = match.group(1).decode("latin-1")
        elif current:
            used.add(current)
    return used


def describe_fonts(reader: PdfReader) -> list[dict]:
    fonts: dict[str, dict] = {}
    for page in reader.pages:
        try:
            resources = page["/Resources"]
            font_dict = resources.get("/Font") if resources else None
            if font_dict is None:
                continue
            for key in list(font_dict.keys()):
                font = font_dict[key].get_object()
                base = str(font.get("/BaseFont", key))
                descriptor = font.get("/FontDescriptor")
                if descriptor is None and font.get("/DescendantFonts"):
                    descriptor = font["/DescendantFonts"][0].get_object().get("/FontDescriptor")
                embedded = False
                if descriptor is not None:
                    embedded = any(tag in descriptor for tag in ("/FontFile", "/FontFile2", "/FontFile3"))
                used = {key.lstrip("/") for key in used_font_keys(page)}
                entry = fonts.setdefault(base, {"baseFont": base, "embedded": embedded,
                                                "subtype": str(font.get("/Subtype", "")),
                                                "used": str(key).lstrip("/") in used})
                entry["embedded"] = entry["embedded"] or embedded
                entry["used"] = entry["used"] or (str(key).lstrip("/") in used)
        except (KeyError, TypeError, AttributeError):
            continue
    return sorted(fonts.values(), key=lambda item: item["baseFont"])


def describe(path: Path, pages_spec: str = "") -> dict:
    reader = PdfReader(str(path))
    pages = []
    total = len(reader.pages)
    wanted = []
    if pages_spec.strip():
        for chunk in pages_spec.split(","):
            chunk = chunk.strip()
            if "-" in chunk:
                start, _, end = chunk.partition("-")
                wanted += list(range(int(start), int(end) + 1))
            elif chunk:
                wanted.append(int(chunk))
    else:
        wanted = list(range(1, total + 1))
    page_texts = []
    for index in wanted:
        if not 1 <= index <= total:
            continue
        page = reader.pages[index - 1]
        box = page.mediabox
        width, height = float(box.width), float(box.height)
        text = page.extract_text() or ""
        page_texts.append(text)
        pages.append({"index": index, "widthPt": round(width, 1), "heightPt": round(height, 1),
                      "size": size_name(width, height),
                      "chars": len(text.strip()), "images": len(page.images)})
    meta = reader.metadata or {}
    return {
        "pages": total,
        "pageDetails": pages,
        "sizes": sorted({item["size"] for item in pages}),
        "fonts": describe_fonts(reader),
        "metadata": {key: str(value) for key, value in dict(meta).items()},
        "encrypted": bool(reader.is_encrypted),
        "pdfVersion": str(getattr(reader, "pdf_header", "") or ""),
        "textChars": sum(len(text.strip()) for text in page_texts),
    }


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="读回 pdf 结构/字体/元数据")
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--text", action="store_true", help="输出全文（逐页）")
    parser.add_argument("--pages", default="", help="只看某几页，如 1-3,7")
    cli.add_common(parser)
    args = parser.parse_args()

    path = Path(args.pdf).expanduser()
    if not path.is_file():
        print(f"找不到文件：{path}", file=sys.stderr)
        return 2
    if args.text:
        reader = PdfReader(str(path))
        chunks = []
        for index, page in enumerate(reader.pages, start=1):
            chunks.append(f"--- 第 {index} 页 ---")
            chunks.append(page.extract_text() or "")
        text = "\n".join(chunks)
        cli.emit({"summary": text, "text": text}, args)
        return 0
    payload = describe(path, args.pages)
    embedded = [font for font in payload["fonts"] if font["embedded"]]
    lines = [f"{path.name}：{payload['pages']} 页，页面尺寸 {'、'.join(payload['sizes'])}",
             f"  字体 {len(payload['fonts'])} 个（已嵌入 {len(embedded)} 个）："
             + "、".join(f"{font['baseFont']}{'' if font['embedded'] else '（未嵌入）'}"
                        for font in payload["fonts"]) or "  （无字体）",
             f"  文字图层：{payload['textChars']} 字"
             + ("（可能是扫描件）" if payload["textChars"] < 20 * max(payload["pages"], 1) else ""),
             f"  元数据：{json.dumps(payload['metadata'], ensure_ascii=False)[:200]}"]
    for item in payload["pageDetails"]:
        lines.append(f"  · 第 {item['index']} 页：{item['size']} "
                     f"{item['widthPt']}×{item['heightPt']}pt，{item['chars']} 字，"
                     f"{item['images']} 张图")
    cli.emit({"summary": "\n".join(lines), **payload}, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

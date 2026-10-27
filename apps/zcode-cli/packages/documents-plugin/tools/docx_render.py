"""出逐页图给视觉验收用（visual-judge 或人眼）。

    python tools/docx_render.py --docx 报告.docx --outdir 审查/文档图 [--dpi 110]

* 有 LibreOffice → 真渲染：docx → PDF → 逐页 PNG（打印出来的样子）+ 缩略观测表。
* 没有 → **不做视觉验收**，改为输出结构与文本转录（明确标注"非视觉验收"）：
  DOCX 的排版依赖引擎，自己在 Python 里"画"一份只会给出误导性的图。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, contact, engines  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["docx", "PIL"], "docx_render（python-docx + pillow）")


def render_with_engine(path: Path, outdir: Path, dpi: int) -> dict:
    pdf = engines.convert_to_pdf(path, outdir)
    pages = engines.pdf_to_png(pdf, outdir / "pages", dpi=dpi)
    sheet = contact.make_contact_sheet(pages, outdir / "contact-sheet.png")
    return {"mode": "engine", "pdf": str(pdf), "pages": len(pages),
            "files": [str(item) for item in pages], "contactSheet": str(sheet),
            "note": f"真渲染（LibreOffice）：{len(pages)} 页"}


def render_transcript(path: Path, outdir: Path) -> dict:
    from docx import Document  # noqa: PLC0415

    import docx_fonts  # noqa: PLC0415

    document = Document(str(path))
    outdir.mkdir(parents=True, exist_ok=True)
    target = outdir / "transcript.txt"
    lines = ["# 结构与文本转录（**非视觉验收**：本机没有 LibreOffice，无法渲染排版）", ""]
    for location, paragraph in docx_fonts.iter_paragraphs(document):
        text = paragraph.text.strip()
        if not text:
            continue
        fonts = docx_fonts.paragraph_fonts(paragraph, document)
        lines.append(f"[{location}] ({fonts['styleName']}/{fonts['cjk']}/{fonts['size']}pt) {text}")
    for index, shape in enumerate(document.inline_shapes, start=1):
        lines.append(f"[图 {index}] {shape.width / 360000:.1f}×{shape.height / 360000:.1f}cm")
    target.write_text("\n".join(lines), encoding="utf-8")
    return {"mode": "transcript", "pages": 0, "files": [str(target)], "contactSheet": "",
            "note": "非视觉验收：本机没有 LibreOffice，只给出结构与文本转录（排版没验）"}


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="docx 逐页渲染（或转录降级）")
    parser.add_argument("--docx", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--dpi", type=int, default=110)
    cli.add_common(parser)
    args = parser.parse_args()

    path = Path(args.docx).expanduser()
    if not path.is_file():
        print(f"找不到文件：{path}", file=sys.stderr)
        return 2
    outdir = Path(args.outdir).expanduser()
    engine = engines.engine_report()
    try:
        result = render_with_engine(path, outdir, args.dpi) if engine.can_convert \
            else render_transcript(path, outdir)
    except engines.ConvertError as error:
        print(f"渲染失败：{error}", file=sys.stderr)
        return 1
    lines = [result["note"], f"  产出：{outdir}"]
    if result["contactSheet"]:
        lines.append(f"  观测表：{result['contactSheet']}")
    cli.emit({"summary": "\n".join(lines), **result}, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

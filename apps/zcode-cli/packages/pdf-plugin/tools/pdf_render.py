"""出逐页图给视觉验收用（visual-judge 或人眼）。

    python tools/pdf_render.py --pdf 交付.pdf --outdir 审查/图 [--dpi 110] [--pages 1-6]

**PDF 的渲染不需要外部引擎**（pypdfium2 直接渲染），所以这个工具在任何环境都能出真图 ——
不像 docx/pptx 那样在没装 LibreOffice 时只能给转录。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, contact, engines  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["pypdfium2", "PIL"], "pdf_render（pypdfium2 + pillow）")


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="pdf 逐页渲染")
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--dpi", type=int, default=110)
    parser.add_argument("--pages", default="", help="如 1-6,9；留空=全部")
    parser.add_argument("--columns", type=int, default=4)
    cli.add_common(parser)
    args = parser.parse_args()

    path = Path(args.pdf).expanduser()
    if not path.is_file():
        print(f"找不到文件：{path}", file=sys.stderr)
        return 2
    outdir = Path(args.outdir).expanduser()
    total = engines.pdf_page_count(path)
    wanted: list[int] = []
    if args.pages.strip():
        for chunk in args.pages.split(","):
            chunk = chunk.strip()
            if "-" in chunk:
                start, _, end = chunk.partition("-")
                wanted += list(range(int(start), int(end) + 1))
            elif chunk:
                wanted.append(int(chunk))
        wanted = [index for index in wanted if 1 <= index <= total]
    try:
        pages = engines.pdf_to_png(path, outdir / "pages", dpi=args.dpi, pages=wanted or None)
    except engines.ConvertError as error:
        print(f"渲染失败：{error}", file=sys.stderr)
        return 1
    sheet = contact.make_contact_sheet(pages, outdir / "contact-sheet.png", columns=args.columns)
    lines = [f"渲染 {len(pages)}/{total} 页（{args.dpi} dpi）",
             f"  逐页图：{outdir / 'pages'}",
             f"  观测表：{sheet}"]
    cli.emit({"summary": "\n".join(lines), "total": total, "rendered": len(pages),
              "files": [str(item) for item in pages], "contactSheet": str(sheet)}, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

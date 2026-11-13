"""出逐页/逐表图，给视觉验收用（visual-judge 或人眼）。

    python tools/xlsx_render.py --xlsx 结果表.xlsx --outdir 审查/表图 [--dpi 110] [--force-self]

* 有 LibreOffice → 走**真渲染**：xlsx → PDF → 逐页 PNG（这就是打印出来的样子）。
* 没有 → 走**自渲染降级**：按文件里的真实几何画每张表（屏幕上大概的样子），
  输出里明确标注 `self-render（非真渲染）`，不能当作最终视觉依据。

两种模式都会额外产出一张缩略观测表（contact-sheet.png），一次看全所有页面。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, contact, engines  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["openpyxl", "PIL"], "xlsx_render（openpyxl + pillow）")


def render_with_engine(path: Path, outdir: Path, dpi: int) -> dict:
    pdf = engines.convert_to_pdf(path, outdir)
    pages = engines.pdf_to_png(pdf, outdir / "pages", dpi=dpi)
    sheet = contact.make_contact_sheet(pages, outdir / "contact-sheet.png")
    return {"mode": "engine", "pdf": str(pdf), "pages": len(pages),
            "files": [str(item) for item in pages], "contactSheet": str(sheet),
            "note": f"真渲染（LibreOffice）：{len(pages)} 页"}


def render_self(path: Path, outdir: Path) -> dict:
    from openpyxl import load_workbook  # noqa: PLC0415

    import sheet_render  # noqa: PLC0415

    workbook = load_workbook(path)
    # 另一份用 data_only 读回，取公式的缓存值（Excel/引擎算过的文件有，openpyxl 新写的没有）。
    computed = load_workbook(path, data_only=True)
    try:
        default_width = float(workbook.worksheets[0].sheet_format.defaultColWidth or 8.43)
        outdir.mkdir(parents=True, exist_ok=True)
        files = []
        for index, ws in enumerate(workbook.worksheets, start=1):
            cached: dict[tuple[int, int], object] = {}
            for row in computed[ws.title].iter_rows():
                for cell in row:
                    if cell.value not in (None, ""):
                        cached[(cell.row, cell.column)] = cell.value
            target = outdir / f"sheet-{index:02d}-{ws.title[:20]}.png"
            sheet_render.render_sheet(ws, target, default_width=default_width, cached=cached)
            files.append(str(target))
    finally:
        workbook.close()
        computed.close()
    sheet = contact.make_contact_sheet([Path(item) for item in files], outdir / "contact-sheet.png")
    return {"mode": "self-render", "pages": len(files), "files": files,
            "contactSheet": str(sheet),
            "note": "self-render（非真渲染）：本机没有 LibreOffice，图是自渲染降级产物，"
                    "只验文件里的几何与文字，验不到真引擎排版与分页；"
                    "公式格若有缓存值则显示缓存值（openpyxl 新写的文件没有缓存值，显示 = 占位）"}


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="xlsx 逐页/逐表渲染")
    parser.add_argument("--xlsx", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--dpi", type=int, default=110)
    parser.add_argument("--force-self", action="store_true", help="即使有引擎也用自渲染")
    cli.add_common(parser)
    args = parser.parse_args()

    path = Path(args.xlsx).expanduser()
    if not path.is_file():
        print(f"找不到文件：{path}", file=sys.stderr)
        return 2
    outdir = Path(args.outdir).expanduser()
    engine = engines.engine_report()
    try:
        if engine.can_convert and not args.force_self:
            result = render_with_engine(path, outdir, args.dpi)
        else:
            if not engine.can_convert and not args.force_self:
                result = render_self(path, outdir)
                result["note"] += "（登记引擎后可换真渲染：env_doctor --office-home <路径>）"
            else:
                result = render_self(path, outdir)
    except engines.ConvertError as error:
        print(f"渲染失败：{error}", file=sys.stderr)
        return 1
    lines = [f"{result['note']}", f"  图 {result['pages']} 张 → {outdir}",
             f"  观测表：{result['contactSheet']}"]
    cli.emit({"summary": "\n".join(lines), **result}, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

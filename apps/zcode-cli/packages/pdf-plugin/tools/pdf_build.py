"""生成交付用 PDF：HTML / Office 文件 → PDF，带印前默认设置。

    python tools/pdf_build.py --html 报告.html --out 交付/报告.pdf [--pdfa]
    python tools/pdf_build.py --from 论文.docx --out 交付/论文.pdf      # docx/pptx/xlsx/html/txt
    python tools/pdf_build.py --html 报告.html --out 报告.pdf --check   # 转完顺手体检（推荐）

## 为什么走 LibreOffice 而不是"自己画 PDF"

PDF 里要**可选中、可检索、字形正确嵌入**的中文文本，最小代价的路是让真引擎排版：
LibreOffice 把 HTML（或 Office 文件）按 A4/页边距排好并嵌入字体。自己在 Python 里画，
要么用位图（不可检索、体积大），要么手写 PDF 字体子集（工作量大且容易出错）。
学术排版走 LaTeX 的场合，请用数模插件的自管 TeX 树（`tex_home`），本工具不重复造。

## 印前默认

* `--pdfa`：导出 PDF/A-1b（投稿、归档、印刷厂常要）；
* 转完自动报告页数与字体嵌入情况（字体没嵌上就是废件，早发现早改）；
* HTML 侧的页面尺寸/页边距由 CSS `@page` 决定（见 `templates/report.html`）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, engines  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["pypdfium2", "pypdf"], "pdf_build（pypdfium2 + pypdf）")

import pdf_read  # noqa: E402
from pypdf import PdfReader  # noqa: E402

PDFA_OPTIONS = {"SelectPdfVersion": {"type": "long", "value": "1"},
                "EmbedStandardFonts": {"type": "boolean", "value": "true"},
                "UseTaggedPDF": {"type": "boolean", "value": "true"}}


def build(source: Path, out_path: Path, pdfa: bool) -> dict:
    engine = engines.engine_report()
    if not engine.can_convert:
        raise SystemExit("需要 LibreOffice 来排版导出：装好后跑 `python tools/env_doctor.py "
                         "--office-home <安装目录>` 登记。")
    with __import__("tempfile").TemporaryDirectory(prefix="nibi-pdf-build-") as raw:
        produced = engines.convert_to_pdf(source, Path(raw),
                                          options=PDFA_OPTIONS if pdfa else None)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(produced.read_bytes())
    return {"out": str(out_path), "source": str(source), "pdfa": pdfa}


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="生成交付用 PDF（HTML/Office → PDF）")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--html", help="HTML 源文件（页面尺寸与页边距写在 CSS @page 里）")
    group.add_argument("--from", dest="source", help="任意可转换源：docx/pptx/xlsx/html/txt")
    parser.add_argument("--out", required=True)
    parser.add_argument("--pdfa", action="store_true", help="导出 PDF/A-1b")
    parser.add_argument("--check", action="store_true", help="转完自动体检（页数/字体嵌入/尺寸）")
    cli.add_common(parser)
    args = parser.parse_args()

    source = Path(args.html or args.source).expanduser()
    if not source.is_file():
        print(f"找不到源文件：{source}", file=sys.stderr)
        return 2
    out_path = Path(args.out).expanduser()
    try:
        result = build(source, out_path, args.pdfa)
    except engines.ConvertError as error:
        print(f"转换失败：{error}", file=sys.stderr)
        return 1
    reader = PdfReader(str(out_path))
    payload = pdf_read.describe(out_path)
    not_embedded = [font["baseFont"] for font in payload["fonts"] if not font["embedded"]]
    lines = [f"已生成 {out_path}（{out_path.stat().st_size / 1024:.1f} KB，"
             f"{'PDF/A-1b' if args.pdfa else '普通 PDF'}）",
             f"  来自 {source.name}：{payload['pages']} 页，尺寸 {'、'.join(payload['sizes'])}",
             f"  字体 {len(payload['fonts'])} 个"
             + (f"，**未嵌入**：{'、'.join(not_embedded)}（会被替换，必须修）" if not_embedded
                else "，全部已嵌入"),
             f"  文字图层：{payload['textChars']} 字"]
    if not_embedded:
        lines.append("  ✗ 有字体没嵌入 —— 交付前必须解决（换字体或改导出设置）")
    if args.check:
        lines.append(f"  下一步体检：python tools/pdf_gate.py --pdf {out_path}")
    cli.emit({"summary": "\n".join(lines), **result, "read": payload}, args)
    return 1 if not_embedded else 0


if __name__ == "__main__":
    raise SystemExit(main())

"""既有 PDF 的常用手术：合并、拆分、抽页、旋转、加水印、清元数据。

    python tools/pdf_ops.py --merge a.pdf b.pdf --out 合并.pdf
    python tools/pdf_ops.py --split 输入.pdf --outdir 拆分 --every 1
    python tools/pdf_ops.py --extract 输入.pdf --pages 2,5-7 --out 摘录.pdf
    python tools/pdf_ops.py --rotate 输入.pdf --pages 3 --degrees 90 --out 旋转.pdf
    python tools/pdf_ops.py --watermark 输入.pdf --text "内部资料" --out 加水印.pdf
    python tools/pdf_ops.py --scrub-meta 输入.pdf --out 干净.pdf

两条硬规矩：

* **绝不原地改写**：输出路径与任何输入相同就直接拒绝（PDF 手术出错是整份文档报废）；
* **做完报账**：页数、尺寸、字体嵌入有没有变化，都打出来 —— 手术最容易的副作用就是
  把字体嵌入或书签弄丢，而这一点不报就没人会发现。
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["pypdf", "PIL"], "pdf_ops（pypdf + pillow）")

import pdf_read  # noqa: E402
from pypdf import PdfReader, PdfWriter  # noqa: E402

WATERMARK_FONTS = ("C:/Windows/Fonts/msyh.ttc", "/System/Library/Fonts/PingFang.ttc",
                   "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")


def parse_pages(spec: str, total: int) -> list[int]:
    wanted: list[int] = []
    for chunk in str(spec).split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start, _, end = chunk.partition("-")
            wanted += list(range(int(start), int(end) + 1))
        else:
            wanted.append(int(chunk))
    return [index for index in wanted if 1 <= index <= total]


def watermark_page(width_pt: float, height_pt: float, text: str, opacity: float):
    """用 Pillow 画一张透明水印页再叠上去：不引入新依赖，中文也能画。"""
    from PIL import Image, ImageDraw, ImageFont

    scale = 4
    image = Image.new("RGBA", (int(width_pt * scale), int(height_pt * scale)), (255, 255, 255, 0))
    draw = ImageDraw.Draw(image)
    font = None
    for candidate in WATERMARK_FONTS:
        if Path(candidate).is_file():
            font = ImageFont.truetype(candidate, int(64 * scale))
            break
    if font is None:
        raise SystemExit("找不到中文字体（水印需要）：请装微软雅黑/PingFang/Noto Sans CJK")
    theta = 30
    layer = Image.new("RGBA", image.size, (255, 255, 255, 0))
    layer_draw = ImageDraw.Draw(layer)
    step_x, step_y = int(520 * scale), int(360 * scale)
    for y in range(-image.height, image.height * 2, step_y):
        for x in range(-image.width, image.width * 2, step_x):
            layer_draw.text((x, y), text, font=font, fill=(90, 96, 114, int(255 * opacity)))
    layer = layer.rotate(theta, expand=False, resample=Image.BICUBIC)
    image = Image.alpha_composite(image, layer)
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PDF", resolution=scale * 72)
    buffer.seek(0)
    return PdfReader(buffer).pages[0]


def report(source: Path, target: Path) -> dict:
    before = pdf_read.describe(source)
    after = pdf_read.describe(target)
    lost = [font["baseFont"] for font in before["fonts"]
            if font["embedded"] and font["baseFont"] not in
            {item["baseFont"] for item in after["fonts"] if item["embedded"]}]
    return {"beforePages": before["pages"], "afterPages": after["pages"],
            "beforeChars": before["textChars"], "afterChars": after["textChars"],
            "fontsBefore": len(before["fonts"]), "fontsAfter": len(after["fonts"]),
            "lostEmbeddedFonts": lost}


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="既有 PDF 的常用手术")
    parser.add_argument("--merge", nargs="*", default=[], help="按顺序合并这些 PDF")
    parser.add_argument("--split", default="", help="拆分输入 PDF")
    parser.add_argument("--extract", default="", help="从输入 PDF 抽页")
    parser.add_argument("--rotate", default="", help="旋转输入 PDF")
    parser.add_argument("--watermark", default="", help="给输入 PDF 加水印")
    parser.add_argument("--scrub-meta", default="", help="清掉输入 PDF 的元数据身份信息")
    parser.add_argument("--pages", default="", help="抽页/旋转的页码，如 2,5-7")
    parser.add_argument("--degrees", type=int, default=90)
    parser.add_argument("--text", default="内部资料")
    parser.add_argument("--opacity", type=float, default=0.12)
    parser.add_argument("--every", type=int, default=1, help="拆分：每几页一个文件")
    parser.add_argument("--out", default="")
    parser.add_argument("--outdir", default="")
    cli.add_common(parser)
    args = parser.parse_args()

    sources = [Path(item).expanduser() for item in
               [args.split, args.extract, args.rotate, args.watermark, args.scrub_meta,
                *args.merge] if item]
    for source in sources:
        if not source.is_file():
            print(f"找不到文件：{source}", file=sys.stderr)
            return 2
    if args.out and any(source.resolve() == Path(args.out).expanduser().resolve()
                        for source in sources):
        print("拒绝原地改写：输出路径与输入相同（PDF 手术出错是整份报废，请另存）。", file=sys.stderr)
        return 2

    result: dict = {}
    if args.merge:
        if not args.out:
            print("--merge 需要 --out", file=sys.stderr)
            return 2
        writer = PdfWriter()
        for source in args.merge:
            for page in PdfReader(str(Path(source).expanduser())).pages:
                writer.add_page(page)
        target = Path(args.out).expanduser()
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as handle:
            writer.write(handle)
        result = {"op": "merge", "sources": args.merge, **report(Path(args.merge[0]).expanduser(), target)}
    elif args.split:
        source = Path(args.split).expanduser()
        outdir = Path(args.outdir or f"{source.stem}-拆分").expanduser()
        outdir.mkdir(parents=True, exist_ok=True)
        reader = PdfReader(str(source))
        total = len(reader.pages)
        step = max(1, args.every)
        written = []
        for start in range(0, total, step):
            writer = PdfWriter()
            for index in range(start, min(start + step, total)):
                writer.add_page(reader.pages[index])
            target = outdir / f"{source.stem}-{start + 1:03d}_{min(start + step, total):03d}.pdf"
            with target.open("wb") as handle:
                writer.write(handle)
            written.append(str(target))
        result = {"op": "split", "pages": total, "files": written}
    else:
        source = Path(args.split or args.extract or args.rotate or args.watermark or args.scrub_meta).expanduser()
        reader = PdfReader(str(source))
        writer = PdfWriter()
        if args.extract:
            wanted = parse_pages(args.pages, len(reader.pages))
            if not wanted:
                print("--extract 需要 --pages（如 2,5-7）", file=sys.stderr)
                return 2
            for index in wanted:
                writer.add_page(reader.pages[index - 1])
            op = "extract"
        elif args.rotate:
            targets = set(parse_pages(args.pages, len(reader.pages)) or range(1, len(reader.pages) + 1))
            for index, page in enumerate(reader.pages, start=1):
                if index in targets:
                    page.rotate(args.degrees)
                writer.add_page(page)
            op = "rotate"
        elif args.watermark:
            for page in reader.pages:
                width = float(page.mediabox.width)
                height = float(page.mediabox.height)
                page.merge_page(watermark_page(width, height, args.text, args.opacity))
                writer.add_page(page)
            op = "watermark"
        else:
            for page in reader.pages:
                writer.add_page(page)
            op = "scrub-meta"
        if args.scrub_meta:
            writer.add_metadata({"/Author": "NIBI", "/Creator": "NIBI", "/Producer": "NIBI"})
        target = Path(args.out).expanduser() if args.out else \
            source.with_name(f"{source.stem}-{op}.pdf")
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as handle:
            writer.write(handle)
        result = {"op": op, **report(source, target)}

    lines = [f"完成：{result['op']}",
             f"  页数 {result.get('beforePages', '?')} → {result.get('afterPages', '?')}，"
             f"文字 {result.get('beforeChars', '?')} → {result.get('afterChars', '?')} 字",
             f"  字体 {result.get('fontsBefore', '?')} → {result.get('fontsAfter', '?')} 个"]
    if result.get("lostEmbeddedFonts"):
        lines.append(f"  ✗ 丢失了原本嵌入的字体：{'、'.join(result['lostEmbeddedFonts'])}")
    if isinstance(result.get("files"), list):
        lines.append(f"  产出 {len(result['files'])} 个文件 → {result['files'][0].rsplit('/', 1)[0]}")
    lines.append("下一步：python tools/pdf_gate.py --pdf <产出文件>")
    cli.emit({"summary": "\n".join(lines), **result}, args)
    return 1 if result.get("lostEmbeddedFonts") else 0


if __name__ == "__main__":
    raise SystemExit(main())

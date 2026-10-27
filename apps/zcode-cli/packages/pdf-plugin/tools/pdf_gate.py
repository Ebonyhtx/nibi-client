"""PDF 印前质量门：交付给印刷/投稿/评审之前把能出事的都验一遍。

## 判据（10 条）—— 全部不需要外部引擎（pypdfium2 直接渲染 PDF）

| 判据 | 验什么 | 为什么 |
| --- | --- | --- |
| `page-size` | 所有页面尺寸一致、是否标准纸张 | 混尺寸在成册/装订时会被缩放或裁切 |
| `fonts` | 每个字体都**已嵌入** | 未嵌入字体在别人机器上会被替换、排版跑掉（印前第一铁律） |
| `margins` | 文字盒是否贴边或越界 | 贴边文字会被裁纸刀切掉 |
| `blank-pages` | 无文字也无图的黑页 | 多出来的空白页是"没检查就交付"的铁证 |
| `text-layer` | 有图无文字的页（扫描件） | 扫描件不可检索、不可复制，很多场合直接不合格 |
| `hygiene` | 元数据里的作者/生产者/本机路径 | 交付件的元数据是最常被忽略的泄漏面 |
| `structure` | 加密、页数为 0、PDF 版本 | 加密文件下游处理不了 |
| `render` | 逐页出图 + 缺字形方框 + 近空白页 | "逐页看过"的物证；缺字形只有渲染出来才现形 |
| `layout` | **大版面的版面几何**：填充率、内容区最大空白带、分栏底对齐、栏内空洞 | 前八条全是存在性检查（有没有/嵌没嵌/贴没贴边）；实测一份 A2 海报八条全绿，人眼却判"上重下空、两栏不齐" |
| `typography` | 中文排版禁则：行首收尾标点、行尾开引号/开括号 | reportlab 的 CJK 换行是"哪儿都能断"（源码自陈 dumb algorithm），实测断出过行首逗号 |

与 spreadsheets/documents/presentations 不同：**PDF 的渲染层不依赖 LibreOffice**，
所以这里没有 `skip` 分支 —— 渲染层要么真跑，要么这个插件没装好（依赖自举会处理）。
`layout` 默认只对**大版面**（面积 ≥ A3）生效：A4 报告封面页的留白是正常设计，
海报上的留白是缺陷；`--layout` 强制、`--no-layout` 关掉。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, contact, engines, gates, hygiene, textmetrics  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["pypdfium2", "pypdf", "PIL"], "pdf_gate（pypdfium2 + pypdf + pillow）")

import pdf_layout  # noqa: E402
import pdf_read  # noqa: E402
from pypdf import PdfReader  # noqa: E402

EXPECTED_GATES = ["page-size", "fonts", "margins", "blank-pages", "text-layer",
                  "hygiene", "structure", "render", "layout", "typography"]

SAFE_MARGIN_PT = 10.0      # 距纸边 <10pt（3.5mm）视为贴边
NEAR_BLANK_RATIO = 0.004   # 渲染后非白像素占比低于此值视为近空白页
SCAN_TEXT_MIN = 20         # 每页平均少于 20 字视为缺文字图层
# 中文排版禁则：常量与海报生成器共用（nibi_kit.textmetrics），免得两处口径漂移
LINE_START_FORBIDDEN = textmetrics.LINE_START_FORBIDDEN
LINE_END_FORBIDDEN = textmetrics.LINE_END_FORBIDDEN


def gate_page_size(reader: PdfReader, report: gates.GateReport) -> None:
    gate = report.gate("page-size", "页面尺寸一致性")
    sizes: dict[tuple, int] = {}
    names: set[str] = set()
    for index, page in enumerate(reader.pages, start=1):
        gate.checked += 1
        box = page.mediabox
        key = (round(float(box.width), 1), round(float(box.height), 1))
        sizes[key] = sizes.get(key, 0) + 1
        names.add(pdf_read.size_name(key[0], key[1]))
        if abs(float(box.width) - 595.28) > 3 and abs(float(box.height) - 595.28) > 3 \
                and abs(float(box.width) - 612.0) > 3:
            gate.notes.append(f"第 {index} 页是非标准尺寸 {key[0]:.0f}×{key[1]:.0f}pt"
                              if len(gate.notes) < 3 else "")
    if len(sizes) > 1:
        detail = "、".join(f"{key[0]:.0f}×{key[1]:.0f}pt（{count} 页）"
                           for key, count in sorted(sizes.items()))
        gate.fail("page-size-mixed", f"页面尺寸不一致：{detail}（成册会被缩放或裁切）")
    if len(names) == 1 and names != {"自定义"}:
        gate.notes.append(f"全部为标准尺寸：{names.pop()}")


def gate_fonts(reader: PdfReader, report: gates.GateReport) -> None:
    gate = report.gate("fonts", "字体嵌入")
    fonts = pdf_read.describe_fonts(reader)
    gate.checked = max(len(fonts), 1)
    not_embedded = [font for font in fonts if not font["embedded"]]
    for font in not_embedded:
        # 只对"内容里真的用到"的未嵌入字体判失败：生成器常把画布初始字体（Helvetica）
        # 写进资源字典却一个字不用，那是假阳性（实测：reportlab 生成的海报会带上它）。
        if font.get("used", True):
            gate.fail("font-not-embedded",
                      f"字体未嵌入：{font['baseFont']}（在没有该字体的机器上会被替换、排版跑掉）")
        else:
            gate.warn("font-listed-unused",
                      f"资源里登记了未嵌入字体 {font['baseFont']}，但内容流里没有用它（生成器的默认条目）")
    if not fonts:
        gate.notes.append("文件里没有字体（图片型 PDF；文字图层判据会另报）")
    else:
        gate.notes.append("字体：" + "、".join(
            f"{font['baseFont']}{'✓' if font['embedded'] else ('✗未嵌入' if font.get('used', True) else '·未使用')}"
            for font in fonts)[:300])


def gate_margins(path: Path, reader: PdfReader, report: gates.GateReport,
                 dpi: int) -> None:
    """文字盒与纸边的关系。用 pypdfium2 的字符框；拿不到就**显式跳过**（不装作验过）。"""
    gate = report.gate("margins", "文字贴边/越界")
    try:
        import pypdfium2 as pdfium  # noqa: PLC0415
    except ImportError:
        gate.skipped = "缺少 pypdfium2，无法取字符框"
        return
    document = pdfium.PdfDocument(str(path))
    try:
        for index in range(len(document)):
            page = document[index]
            textpage = page.get_textpage()
            count = textpage.count_chars()
            if count == 0:
                gate.checked += 1
                continue
            if not hasattr(textpage, "get_charbox"):
                gate.skipped = "当前 pypdfium2 版本没有 get_charbox，无法判贴边"
                return
            width, height = page.get_size()
            # 下界初值取"最大"，上界初值取 0 —— 上界拿页宽/页高起步会让 max() 恒等于页边，
            # 于是每一页都被算成"距纸边 0pt"（实测踩过）。
            worst_left, worst_bottom = width, height
            worst_right, worst_top = 0.0, 0.0
            step = max(1, count // 4000)
            sampled = 0
            for char_index in range(0, count, step):
                try:
                    left, bottom, right, top = textpage.get_charbox(char_index)
                except (IndexError, ValueError):
                    continue
                # 空格/换行这类字符给出的是零尺寸盒（0,0,0,0）——不过滤会把每一页都判成"贴边"
                if right - left < 0.5 or top - bottom < 0.5:
                    continue
                sampled += 1
                worst_left = min(worst_left, left)
                worst_right = max(worst_right, right)
                worst_bottom = min(worst_bottom, bottom)
                worst_top = max(worst_top, top)
            gate.checked += 1
            if sampled == 0:
                continue
            if (worst_left < 0 or worst_bottom < 0 or worst_right > width or worst_top > height):
                gate.fail("text-out-of-page",
                          f"文字越出页面：左 {worst_left:.0f} 右 {worst_right:.0f} "
                          f"（页宽 {width:.0f}）/ 下 {worst_bottom:.0f} 上 {worst_top:.0f} "
                          f"（页高 {height:.0f}）", f"第 {index + 1} 页")
            elif min(worst_left, worst_bottom, width - worst_right, height - worst_top) < SAFE_MARGIN_PT:
                gate.warn("text-near-edge",
                          f"文字距纸边最近 {min(worst_left, worst_bottom, width - worst_right, height - worst_top):.1f}pt"
                          f"（<{SAFE_MARGIN_PT:.0f}pt 有被裁纸切掉的风险）", f"第 {index + 1} 页")
    finally:
        document.close()


def gate_blank_pages(reader: PdfReader, report: gates.GateReport) -> None:
    gate = report.gate("blank-pages", "空白页")
    for index, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        images = len(page.images)
        gate.checked += 1
        if not text and images == 0:
            gate.fail("blank-page", "本页既没有文字也没有图（多余空白页）", f"第 {index} 页")


def gate_text_layer(reader: PdfReader, report: gates.GateReport) -> None:
    gate = report.gate("text-layer", "文字图层（扫描件判定）")
    for index, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        images = len(page.images)
        gate.checked += 1
        if len(text) < SCAN_TEXT_MIN and images > 0:
            gate.warn("no-text-layer",
                      f"本页有 {images} 张图但几乎没有文字（可能是扫描页：不可检索、不可复制）",
                      f"第 {index} 页")


def gate_hygiene(path: Path, reader: PdfReader, report: gates.GateReport) -> None:
    gate = report.gate("hygiene", "交付卫生（元数据/正文痕迹）")
    findings: list[gates.Finding] = []
    metadata_text = json.dumps({key: str(value) for key, value in dict(reader.metadata or {}).items()},
                               ensure_ascii=False)
    for finding in hygiene.scan_text(metadata_text, "元数据"):
        # 元数据里出现系统账号名是常态（"Microsoft Word / 用户名"这类），降级为告警
        findings.append(gates.Finding("warn" if finding.code == "local-identity" else "fail",
                                      finding.code, finding.message, "元数据"))
    page_count = 0
    for index, page in enumerate(reader.pages, start=1):
        page_count += 1
        text = page.extract_text() or ""
        for finding in hygiene.scan_text(text, f"第 {index} 页"):
            findings.append(gates.Finding(finding.severity, finding.code, finding.message,
                                          finding.location))
    gate.checked = 1 + page_count
    for finding in findings:
        gate.add(finding.severity, finding.code, finding.message, finding.location)
    if not findings:
        gate.notes.append(f"元数据 + {page_count} 页正文：没有本机路径/用户名/凭据痕迹")


def gate_typography(reader: PdfReader, report: gates.GateReport) -> None:
    """中文排版禁则：行首不该出现收尾标点（、。，）】」』…），行尾不该出现开引号/开括号。

    为什么值得单独一条：reportlab 的 CJK 换行是"哪儿都能断"的笨算法（源码注释自陈 dumb
    algorithm），实测把「（内部）\n，2026-07。」断成行首逗号 —— 中文读者一眼能看出不对，
    而所有"存在性"判据都看不见它。
    """
    gate = report.gate("typography", "中文排版禁则（行首/行尾标点）")
    for index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        gate.checked += len(lines)
        for line in lines:
            if line[0] in LINE_START_FORBIDDEN:
                gate.warn("line-start-punctuation",
                          f"行首是禁则标点「{line[0]}」：{line[:28]}", f"第 {index} 页")
            if line[-1] in LINE_END_FORBIDDEN:
                gate.warn("line-end-punctuation",
                          f"行尾是禁则标点「{line[-1]}」（开引号/开括号不该留在行尾）",
                          f"第 {index} 页")


def gate_structure(reader: PdfReader, report: gates.GateReport, path: Path) -> None:
    gate = report.gate("structure", "结构")
    gate.checked += 1
    if reader.is_encrypted:
        gate.fail("encrypted", "文件加密（下游无法处理；交付请给未加密版本）")
        return
    gate.checked += 1
    if len(reader.pages) == 0:
        gate.fail("no-pages", "文件里没有页面")
    if path.stat().st_size > 40 * 1024 * 1024:
        gate.warn("file-large", f"文件 {path.stat().st_size / 1048576:.1f}MB（超过 40MB 交付/投稿常被限）")


def gate_render(path: Path, report: gates.GateReport, evidence_dir: Path | None,
                dpi: int) -> dict:
    gate = report.gate("render", "逐页渲染（物证）")
    evidence: dict = {}
    workdir = evidence_dir or path.parent / f"{path.stem}.审查"
    workdir.mkdir(parents=True, exist_ok=True)
    reader = PdfReader(str(path))
    expected = len(reader.pages)
    try:
        pages = engines.pdf_to_png(path, workdir / "pages", dpi=dpi)
        texts = engines.pdf_text_per_page(path)
    except engines.ConvertError as error:
        gate.add("fail", "render-failed", str(error))
        return evidence
    evidence["pages"] = [str(item) for item in pages]
    gate.checked += len(pages)
    if len(pages) != expected:
        gate.fail("render-count-mismatch", f"渲染出 {len(pages)} 页而文件有 {expected} 页")
    from PIL import Image  # noqa: PLC0415

    for index, (image_path, text) in enumerate(zip(pages, texts), start=1):
        if "□" in text or "\ufffd" in text:
            gate.fail("rendered-missing-glyph", "渲染/文本里出现缺字形方框或替换符",
                      f"第 {index} 页")
        with Image.open(image_path) as image:
            histogram = image.convert("L").resize((160, 200)).histogram()
        total = sum(histogram) or 1
        ink = sum(histogram[:240]) / total      # 灰度 <240 视为有墨
        if ink < NEAR_BLANK_RATIO:
            gate.warn("near-blank-page", f"渲染后几乎空白（墨迹 {ink * 100:.2f}%）", f"第 {index} 页")
    sheet = contact.make_contact_sheet(pages, workdir / "contact-sheet.png", columns=4)
    evidence["contactSheet"] = str(sheet)
    gate.notes.append(f"共 {len(pages)} 页，逐页图 {len(pages)} 张 → {workdir / 'pages'}；"
                      f"观测表 {sheet.name}")
    return evidence


def gate_layout(reader: PdfReader, report: gates.GateReport, page_images: list[Path],
                mode: str, dpi: int) -> None:
    """版面几何：默认只在大版面上跑（海报/展板），A4 报告的封面留白不算缺陷。"""
    gate = report.gate("layout", "版面几何（大版面）")
    if mode == "off":
        gate.skipped = "--no-layout：本次不跑版面几何判据"
        return
    mm_per_px = 25.4 / dpi
    measured: list[pdf_layout.LayoutMeasurement] = []
    large_format_pages = 0
    for index, (page, image_path) in enumerate(zip(reader.pages, page_images), start=1):
        box = page.mediabox
        width_mm = float(box.width) * 25.4 / 72
        height_mm = float(box.height) * 25.4 / 72
        if mode != "force" and not pdf_layout.is_large_format(width_mm, height_mm):
            continue
        large_format_pages += 1
        try:
            from PIL import Image  # noqa: PLC0415

            with Image.open(image_path) as image:
                render_mm = (image.width * mm_per_px, image.height * mm_per_px)
            measurement = pdf_layout.measure_page(image_path, render_mm[0], render_mm[1], index)
        except (OSError, ValueError) as error:
            gate.warn("layout-measure-failed", f"版面测量失败：{error}", f"第 {index} 页")
            continue
        if measurement is None:
            continue
        measured.append(measurement)
        pdf_layout.check(measurement, gate)
    if not measured:
        if mode == "force":
            gate.skipped = "没有可测量的页面"
        else:
            longest_mm = max(max(float(page.mediabox.width), float(page.mediabox.height)) * 25.4 / 72
                             for page in reader.pages)
            gate.skipped = (f"没有大版面页（最大边 {longest_mm:.0f}mm，未达大版面阈值："
                            f"短边 ≥297mm 且面积 ≥A3）")
        return
    gate.notes.append(f"测量了 {len(measured)} 页大版面（共 {large_format_pages} 页命中大版面阈值）")
    for measurement in measured[:3]:
        gate.notes.append(pdf_layout.describe(measurement))
    # 机器可读的度量：冒烟脚本要断言"均衡前 vs 均衡后"的栏底差，用 meta 而不是解析 note 文案。
    gate.meta = {
        "pages": [
            {
                "page": item.page_index,
                "fillRatio": round(item.fill_ratio, 4),
                "largestBandRatio": round(item.largest_band.length_ratio, 4),
                "bottomRatios": [round(column.bottom_ratio, 4) for column in item.columns],
                "spreadRatio": round(
                    (max((column.bottom_ratio for column in item.columns), default=0.0)
                     - min((column.bottom_ratio for column in item.columns), default=0.0)), 4),
            }
            for item in measured
        ]
    }


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="pdf 印前质量门")
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--evidence-dir", default="")
    parser.add_argument("--dpi", type=int, default=110)
    parser.add_argument("--no-render", action="store_true", help="只跑结构类判据，不出图")
    parser.add_argument("--layout", action="store_true",
                        help="强制对小版面也跑版面几何判据（默认只跑大版面）")
    parser.add_argument("--no-layout", action="store_true", help="不跑版面几何判据")
    cli.add_common(parser)
    args = parser.parse_args()

    path = Path(args.pdf).expanduser()
    if not path.is_file():
        print(f"找不到文件：{path}", file=sys.stderr)
        return 2
    report = gates.GateReport(subject=str(path))
    report.expected(EXPECTED_GATES)
    reader = PdfReader(str(path))
    evidence_dir = Path(args.evidence_dir).expanduser() if args.evidence_dir else None
    gate_page_size(reader, report)
    gate_fonts(reader, report)
    gate_margins(path, reader, report, args.dpi)
    gate_blank_pages(reader, report)
    gate_text_layer(reader, report)
    gate_hygiene(path, reader, report)
    gate_typography(reader, report)
    gate_structure(reader, report, path)
    evidence: dict = {}
    if args.no_render:
        report.gate("render", "逐页渲染（物证）").skipped = "--no-render：本次只跑结构类判据"
        report.gate("layout", "版面几何（大版面）").skipped = "--no-render：版面几何需要渲染图"
    else:
        evidence = gate_render(path, report, evidence_dir, args.dpi)
        gate_layout(reader, report, [Path(item) for item in evidence.get("pages", [])],
                    "off" if args.no_layout else ("force" if args.layout else "auto"),
                    args.dpi)
    report.meta["evidence"] = evidence
    cli.emit({"summary": report.render(), "report": report.to_dict()}, args)
    return report.exit_code


if __name__ == "__main__":
    raise SystemExit(main())

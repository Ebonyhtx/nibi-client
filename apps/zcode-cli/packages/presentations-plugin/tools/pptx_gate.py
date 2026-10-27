"""PPTX 质量门：按「投影到幕布上能不能看清」的标准验交付件。

## 判据（8 条，两层）

**A 层（静态）**
1. `font-size` 投影字号下限（<12pt 硬失败；正文类 <16pt 告警）—— 放映距离下的可读性底线
2. `fonts` 中文必须有中文 `a:ea` 字体（漏了就用主题字体，换台机器就变样）
3. `text-overflow` 文本溢出文本框、以及形状/图片越出页面边界
4. `density` 单页信息密度（字数、项目符号条数）—— 一眼看不懂的页等于没做
5. `images` 图片纵横比、有效分辨率（投影）与替代文字
6. `structure` 空页、无标题页、幻灯片尺寸
7. `hygiene` 交付卫生（本机路径/用户名/凭据、核心属性）

**B 层（引擎）**
8. `render` 转 PDF → **页数与 pptx 一致**、逐页抓缺字形方框、出逐页 PNG 供视觉验收

引擎缺席时 B 层是 `skip` + 原因；`--require-engine` 可升级为硬失败。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, engines, gates, hygiene, textmetrics  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["pptx", "PIL"], "pptx_gate（python-pptx + pillow）")

from pptx import Presentation  # noqa: E402
from pptx.oxml.ns import qn  # noqa: E402

import pptx_spec as spec_mod  # noqa: E402

EXPECTED_GATES = ["font-size", "fonts", "text-overflow", "density", "images",
                  "structure", "hygiene", "render"]

EMU_PER_IN = 914400
CJK_HINT = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]")
LATIN_ONLY = ("calibri", "arial", "timesnewroman", "segoeui", "helvetica", "georgia",
              "verdana", "cambria", "consolas", "couriernew")


def iter_runs(shape):
    """形状里所有有文字的 run（含表格单元格）。"""
    if shape.has_text_frame:
        for paragraph in shape.text_frame.paragraphs:
            for run in paragraph.runs:
                if run.text.strip():
                    yield paragraph, run
    if getattr(shape, "has_table", False):
        for row in shape.table.rows:
            for cell in row.cells:
                for paragraph in cell.text_frame.paragraphs:
                    for run in paragraph.runs:
                        if run.text.strip():
                            yield paragraph, run


def run_ea_font(run) -> str:
    rpr = run._r.find(qn("a:rPr"))
    if rpr is None:
        return ""
    node = rpr.find(qn("a:ea"))
    return (node.get("typeface") or "") if node is not None else ""


def run_family(run) -> str:
    return (run.font.name or "") or ""


CHROME_NAMES = ("pageNumber", "sourceNote")


def is_chrome(shape) -> bool:
    """页脚页码、出处注释这类"版式件"不是正文 —— 它们不受正文软下限约束。"""
    name = (getattr(shape, "name", "") or "")
    return any(marker in name for marker in CHROME_NAMES)


def gate_font_size(deck, report: gates.GateReport) -> None:
    """硬下限逐 run 判；正文软下限**按页聚合成一条告警**（逐 run 报会淹掉报告）。"""
    gate = report.gate("font-size", "投影字号下限")
    for index, slide in enumerate(deck.slides, start=1):
        body_min: float | None = None
        body_where = ""
        for shape in slide.shapes:
            for _, run in iter_runs(shape):
                size = run.font.size.pt if run.font.size else None
                if size is None:
                    continue
                gate.checked += 1
                if size < spec_mod.FONT_FLOOR_HARD:
                    gate.fail("font-too-small",
                              f"字号 {size:g}pt 小于投影下限 {spec_mod.FONT_FLOOR_HARD:g}pt（后排看不清）",
                              f"第 {index} 页")
                if getattr(shape, "has_table", False) or is_chrome(shape):
                    continue
                if body_min is None or size < body_min:
                    body_min = size
                    body_where = run.text[:18]
        if body_min is not None and body_min < spec_mod.FONT_FLOOR_BODY:
            gate.warn("font-small",
                      f"本页最小正文字号 {body_min:g}pt（建议 ≥{spec_mod.FONT_FLOOR_BODY:g}pt）："
                      f"{body_where}…", f"第 {index} 页")


def gate_fonts(deck, report: gates.GateReport) -> None:
    gate = report.gate("fonts", "中文字体（a:ea）")
    families: dict[str, int] = {}
    for index, slide in enumerate(deck.slides, start=1):
        for shape in slide.shapes:
            for _, run in iter_runs(shape):
                if not CJK_HINT.search(run.text):
                    continue
                gate.checked += 1
                ea = run_ea_font(run)
                if not ea:
                    gate.warn("font-ea-missing",
                              f"中文没有指定 a:ea 字体（会跟随主题，换机器就变样）：{run.text[:16]!r}",
                              f"第 {index} 页")
                elif ea.replace(" ", "").lower() in LATIN_ONLY:
                    gate.fail("font-not-cjk",
                              f"中文用了拉丁字体 a:ea={ea!r}（会被替换）", f"第 {index} 页")
                else:
                    families[ea] = families.get(ea, 0) + 1
    if len(families) > 3:
        gate.warn("too-many-fonts", f"中文字体用了 {len(families)} 种：{'、'.join(sorted(families))}")
    if families:
        gate.notes.append("中文字体分布：" + "、".join(
            f"{name}×{count}" for name, count in sorted(families.items())))


def gate_text_overflow(deck, report: gates.GateReport) -> None:
    gate = report.gate("text-overflow", "文本溢出与越界")
    width_in = deck.slide_width / EMU_PER_IN
    height_in = deck.slide_height / EMU_PER_IN
    for index, slide in enumerate(deck.slides, start=1):
        for shape in slide.shapes:
            gate.checked += 1
            left = shape.left / EMU_PER_IN
            top = shape.top / EMU_PER_IN
            right = left + shape.width / EMU_PER_IN
            bottom = top + shape.height / EMU_PER_IN
            if left < -0.02 or top < -0.02 or right > width_in + 0.02 or bottom > height_in + 0.02:
                gate.fail("shape-out-of-slide",
                          f"形状越出页面：{left:.2f},{top:.2f} → {right:.2f},{bottom:.2f}"
                          f"（页面 {width_in:.2f}×{height_in:.2f}in）", f"第 {index} 页")
            if not shape.has_text_frame or not shape.text_frame.text.strip():
                continue
            frame = shape.text_frame
            width_pt = (shape.width - (frame.margin_left or 0) - (frame.margin_right or 0)) / EMU_PER_IN * 72
            height_pt = (shape.height - (frame.margin_top or 0) - (frame.margin_bottom or 0)) / EMU_PER_IN * 72
            available_px = textmetrics.column_width_px(width_pt / 0.75 / 7.0) - 6
            required = 0.0
            for paragraph in frame.paragraphs:
                text = "".join(run.text for run in paragraph.runs)
                size = max((run.font.size.pt for run in paragraph.runs if run.font.size), default=18.0)
                spacing = paragraph.line_spacing if isinstance(paragraph.line_spacing, float) else 1.2
                if not text.strip():
                    required += size * spacing
                    continue
                lines = textmetrics.estimate_lines(text, "微软雅黑", size, available_px)
                required += lines * size * spacing
                if paragraph.space_after is not None:
                    required += paragraph.space_after.pt
            if required > height_pt * 1.06:
                gate.fail("text-overflow",
                          f"文本约需 {required:.0f}pt 高，文本框只有 {height_pt:.0f}pt "
                          f"→ 会溢出框外（第 {index} 页「{frame.text.strip().splitlines()[0][:18]}」）",
                          f"第 {index} 页")


def gate_density(deck, report: gates.GateReport) -> None:
    gate = report.gate("density", "单页信息密度")
    for index, slide in enumerate(deck.slides, start=1):
        chars = 0
        bullets = 0
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for paragraph in shape.text_frame.paragraphs:
                text = "".join(run.text for run in paragraph.runs).strip()
                if not text:
                    continue
                chars += len(text)
                if text.startswith(("•", "–", "-", "·")):
                    bullets += 1
        gate.checked += 1
        if chars > 340:
            gate.warn("density-high", f"本页可见文字 {chars} 字（投影建议 ≤300 字）", f"第 {index} 页")
        if bullets > 9:
            gate.warn("bullets-many", f"本页 {bullets} 条项目符号（建议 ≤8 条）", f"第 {index} 页")


def gate_images(deck, report: gates.GateReport) -> None:
    gate = report.gate("images", "图片（纵横比/分辨率/替代文字）")
    width_in = deck.slide_width / EMU_PER_IN
    height_in = deck.slide_height / EMU_PER_IN
    for index, slide in enumerate(deck.slides, start=1):
        for shape in slide.shapes:
            image = getattr(shape, "image", None)
            if image is None:
                continue
            gate.checked += 1
            pixel_width, pixel_height = image.size
            shown_w = shape.width / EMU_PER_IN
            shown_h = shape.height / EMU_PER_IN
            intrinsic = pixel_width / pixel_height
            displayed = shown_w / shown_h if shown_h else 0
            if abs(displayed - intrinsic) / intrinsic > 0.05:
                gate.fail("image-distorted",
                          f"图片被拉伸：显示 {shown_w:.2f}×{shown_h:.2f}in（比例 {displayed:.2f}）"
                          f"≠ 原始 {pixel_width}×{pixel_height}（{intrinsic:.2f}）", f"第 {index} 页")
            dpi = pixel_width / shown_w
            if dpi < 96:
                gate.fail("image-low-dpi", f"投影分辨率仅 {dpi:.0f} dpi（会糊）", f"第 {index} 页")
            elif dpi < 150:
                gate.warn("image-dpi", f"分辨率 {dpi:.0f} dpi（建议 ≥150）", f"第 {index} 页")
            if shown_w > width_in - 0.2 or shown_h > height_in - 0.2:
                gate.warn("image-near-full-bleed", "图片几乎占满整页（注意留白）", f"第 {index} 页")
            descr = ""
            try:
                descr = shape._element._nvXxPr.cNvPr.get("descr") or ""
            except AttributeError:
                descr = ""
            if not descr.strip():
                gate.warn("image-no-alt", "图片没有替代文字", f"第 {index} 页")


def gate_structure(deck, report: gates.GateReport) -> None:
    gate = report.gate("structure", "结构卫生")
    width_in = deck.slide_width / EMU_PER_IN
    height_in = deck.slide_height / EMU_PER_IN
    gate.checked += 1
    if abs(width_in / height_in - 16 / 9) > 0.05:
        gate.warn("aspect-not-16-9", f"页面比例 {width_in:.2f}×{height_in:.2f}in（不是 16:9，投影会留黑边）")
    slides = list(deck.slides)
    gate.checked += 1
    if not slides:
        gate.fail("empty-deck", "演示稿一页都没有")
        return
    for index, slide in enumerate(slides, start=1):
        texts = [shape.text_frame.text.strip() for shape in slide.shapes
                 if shape.has_text_frame and shape.text_frame.text.strip()]
        gate.checked += 1
        if not texts:
            has_visual = any(getattr(shape, "image", None) is not None or
                             getattr(shape, "has_chart", False) for shape in slide.shapes)
            if not has_visual:
                gate.fail("empty-slide", "本页既没有文字也没有图", f"第 {index} 页")


def gate_hygiene(deck, report: gates.GateReport, path: Path) -> None:
    gate = report.gate("hygiene", "交付卫生（路径/身份/凭据）")
    parts = hygiene.text_parts(path)
    findings: list[gates.Finding] = []
    for name, text in parts:
        findings += hygiene.scan_office_file_text(text, f"{path.name}:{name}")
    findings += hygiene.core_property_findings(deck.core_properties)
    gate.checked = len(parts) + 1
    for finding in findings:
        gate.fail(finding.code, finding.message, finding.location)
    if not findings:
        gate.notes.append(f"扫过 {len(parts)} 个 XML 部件 + 核心属性：没有本机路径/用户名/凭据痕迹")


def gate_engine(path: Path, report: gates.GateReport, evidence_dir: Path | None,
                require_engine: bool, dpi: int, expected_slides: int) -> dict:
    gate = report.gate("render", "真渲染（逐页 PDF/PNG）")
    evidence: dict = {}
    if not engines.engine_report().can_convert:
        reason = ("本机没有 LibreOffice（soffice），真渲染未执行。装好后跑 "
                  "`python tools/env_doctor.py --office-home <安装目录>` 登记。")
        if require_engine:
            gate.add("fail", "engine-missing", reason)
        else:
            gate.skipped = reason
        return evidence
    workdir = evidence_dir or path.parent / f"{path.stem}.审查"
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        pdf = engines.convert_to_pdf(path, workdir)
    except engines.ConvertError as error:
        gate.add("fail", "render-failed", str(error))
        return evidence
    evidence["pdf"] = str(pdf)
    pages = engines.pdf_text_per_page(pdf)
    gate.checked += len(pages) + 1
    if len(pages) != expected_slides:
        gate.fail("slide-count-mismatch",
                  f"渲染出 {len(pages)} 页而 pptx 有 {expected_slides} 页（导出/渲染丢了页？）")
    for index, text in enumerate(pages, start=1):
        if "□" in text or "\ufffd" in text:
            gate.fail("rendered-missing-glyph", "渲染结果里出现缺字形方框/替换符", f"第 {index} 页")
    pngs = engines.pdf_to_png(pdf, workdir / "pages", dpi=dpi)
    evidence["pages"] = [str(item) for item in pngs]
    gate.notes.append(f"共 {len(pages)} 页，逐页图 {len(pngs)} 张 → {workdir / 'pages'}")
    return evidence


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="pptx 质量门")
    parser.add_argument("--pptx", required=True)
    parser.add_argument("--evidence-dir", default="")
    parser.add_argument("--no-engine", action="store_true")
    parser.add_argument("--require-engine", action="store_true")
    parser.add_argument("--dpi", type=int, default=110)
    cli.add_common(parser)
    args = parser.parse_args()

    path = Path(args.pptx).expanduser()
    if not path.is_file():
        print(f"找不到文件：{path}", file=sys.stderr)
        return 2
    report = gates.GateReport(subject=str(path))
    report.expected(EXPECTED_GATES)
    deck = Presentation(str(path))
    gate_font_size(deck, report)
    gate_fonts(deck, report)
    gate_text_overflow(deck, report)
    gate_density(deck, report)
    gate_images(deck, report)
    gate_structure(deck, report)
    gate_hygiene(deck, report, path)
    evidence: dict = {}
    slides = len(deck.slides._sldIdLst)  # noqa: SLF001 - 页数只有这一处能拿
    if args.no_engine:
        report.gate("render", "真渲染（逐页 PDF/PNG）").skipped = "--no-engine：只跑静态判据"
    else:
        evidence = gate_engine(path, report,
                               Path(args.evidence_dir).expanduser() if args.evidence_dir else None,
                               args.require_engine, args.dpi, slides)
    report.meta["evidence"] = evidence
    cli.emit({"summary": report.render(), "report": report.to_dict()}, args)
    return report.exit_code


if __name__ == "__main__":
    raise SystemExit(main())

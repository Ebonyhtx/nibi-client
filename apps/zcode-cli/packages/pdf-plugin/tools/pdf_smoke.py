"""质量门冒烟：正向对照 + 反向对照，防止判据"静默空转"。

    python tools/pdf_smoke.py [--keep]

* **正向对照**：拿插件自带的样例 `templates/_dev/sample-report.pdf`（真引擎导出的 1 页 A4）
  过质量门 → 必须通过。**不需要 LibreOffice**：PDF 的渲染与读取是自带的（pypdfium2）。
* **反向对照**：用 pypdf/Pillow 现造一份逐条犯规的 PDF（混尺寸页、空页、图片页无文字、
  元数据里带本机路径）→ 质量门必须失败，且每条期望判据码都要出现。
"""

from __future__ import annotations

import argparse
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

# 护栏要把**子进程**需要的包也写全：海报路线在子进程里 import reportlab、渲染/读取走
# pypdfium2。少写一个的后果是：本机解释器只要凑巧有写上的那几个就不换到插件环境，
# 子进程随后才炸（实测漏 reportlab 时就是这个形态）。
require_modules(
    ["pypdf", "PIL", "pypdfium2", "reportlab"],
    "pdf_smoke（pypdf + pillow + pypdfium2 + reportlab）",
)

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
# 自测夹具**不随插件发布**（用户不该在安装目录里看到"样例报告"）：
# 它们只在仓库里（templates/_dev/），用于开发与打包前验收。
DEV_FIXTURES = PLUGIN_ROOT / "templates" / "_dev"
TOOLS = Path(__file__).resolve().parent

EXPECTED_CODES = {
    "page-size-mixed",      # A4 + 小尺寸页混在一起
    "blank-page",           # 既无文字也无图的空白页
    "no-text-layer",        # 图片页没有文字图层（扫描件）
    "win-drive-path",       # 元数据里带本机路径
}


def run_tool(script: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(TOOLS / script), *args],  # noqa: S603
                          capture_output=True, text=True, encoding="utf-8", errors="replace")


def load_report(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("report", data)


def positive_control(workdir: Path) -> tuple[str, str]:
    sample = DEV_FIXTURES / "sample-report.pdf"
    if not sample.is_file():
        return "skip", (
            "正向对照需要仓库内的样例 PDF（templates/_dev/sample-report.pdf）；"
            "该夹具**不随插件发布**，所以在安装目录里跑本项会跳过——"
            "反向对照仍会执行，判据是否空转以它为准。"
        )
    report_path = workdir / "正向对照.判据.json"
    gated = run_tool("pdf_gate.py", "--pdf", str(sample), "--no-render",
                     "--json-out", str(report_path))
    if not report_path.is_file():
        return "fail", "质量门没有产出报告"
    report = load_report(report_path)
    ran = [gate for gate in report["gates"] if gate["checked"] > 0]
    if gated.returncode != 0:
        bad = [item for gate in report["gates"] for item in gate["findings"]
               if item["severity"] == "fail"]
        return "fail", "正常 PDF 被拦下：" + json.dumps(bad[:4], ensure_ascii=False)
    if len(ran) < 7:
        return "fail", f"只有 {len(ran)} 条判据真的比过东西（应有 ≥7）"
    return "ok", f"{len(ran)} 条判据共比了 {sum(gate['checked'] for gate in ran)} 项"


def poster_control(workdir: Path) -> tuple[str, str]:
    """海报路线正对照：按自带样板生成 → 质量门必须**全量**通过（含版面几何与中文禁则）。"""
    spec = DEV_FIXTURES / "spec-poster.json"
    if not spec.is_file():
        return "skip", (
            "海报路线需要仓库内的样板（templates/_dev/spec-poster.json）；"
            "该夹具不随插件发布，安装目录里跑本项会跳过。"
        )
    target = workdir / "海报.pdf"
    built = run_tool("pdf_poster.py", "--spec", str(spec), "--out", str(target))
    if built.returncode != 0 or not target.is_file():
        return "fail", f"海报生成失败：{built.stderr.strip()[-300:]}"
    report_path = workdir / "海报.判据.json"
    gated = run_tool("pdf_gate.py", "--pdf", str(target), "--json-out", str(report_path))
    if not report_path.is_file():
        return "fail", "质量门没有产出报告"
    report = load_report(report_path)
    if gated.returncode != 0:
        bad = [item for gate in report["gates"] for item in gate["findings"]
               if item["severity"] == "fail"]
        return "fail", "海报被质量门拦下：" + json.dumps(bad[:3], ensure_ascii=False)
    # 自带样板必须真的过**版面**判据：只看"没报错"会被整条跳过骗过去（--no-render 就是这么漏的）
    layout_gate = next((gate for gate in report["gates"] if gate["id"] == "layout"), None)
    if layout_gate is None or layout_gate["checked"] == 0:
        return "fail", "版面几何判据没有真的比过东西（海报路线必须覆盖它）"
    checked = sum(gate["checked"] for gate in report["gates"])
    return "ok", f"海报生成并过门（{checked} 项，其中版面 {layout_gate['checked']} 项）"


def _clean_a4_page(workdir: Path) -> Path:
    """现造一页干净的 A4（真实文字层 + 正确尺寸），不依赖任何随包夹具。

    反向对照必须**永远能跑**：它证明"判据真的会抓犯规"。若它依赖一个可能没随包发布的
    样例文件，用户侧就会变成"跳过"——而"跳过"恰恰掩盖了判据空转。
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    target = workdir / "基准A4.pdf"
    page = canvas.Canvas(str(target), pagesize=A4)
    page.setFont("Helvetica", 12)
    page.drawString(72, A4[1] - 72, "Baseline A4 page for negative control.")
    page.showPage()
    page.save()
    return target


def make_broken(workdir: Path) -> Path:
    from PIL import Image
    from pypdf import PdfReader, PdfWriter

    sample = _clean_a4_page(workdir)
    target = workdir / "反向对照.pdf"
    writer = PdfWriter()
    for page in PdfReader(str(sample)).pages:
        writer.add_page(page)
    # 混尺寸页（Letter 大小，与 A4 不一致）
    letter = writer.add_blank_page(width=612, height=792)
    # 图片页（没有文字图层）+ 来自 PIL 的 PDF
    image = Image.new("RGB", (900, 1200), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PDF", resolution=150)
    buffer.seek(0)
    image_page = PdfReader(buffer).pages[0]
    writer.add_page(image_page)
    # 空白页（A4 尺寸但与其它页一致，专门验"整页空白"）
    writer.add_blank_page(width=float(letter.mediabox.width), height=float(letter.mediabox.height))
    writer.add_metadata({"/Author": "C:\\Users\\<用户名>\\答辩.pdf", "/Title": "反向对照"})
    with target.open("wb") as handle:
        writer.write(handle)
    return target


def negative_control(workdir: Path) -> tuple[str, str]:
    target = make_broken(workdir)
    report_path = workdir / "反向对照.判据.json"
    gated = run_tool("pdf_gate.py", "--pdf", str(target), "--no-render",
                     "--json-out", str(report_path))
    if not report_path.is_file():
        return "fail", "质量门没有产出报告"
    report = load_report(report_path)
    codes = {item["code"] for gate in report["gates"] for item in gate["findings"]}
    if gated.returncode == 0:
        return "fail", "犯规 PDF 竟然通过了质量门（判据空转）"
    missing = sorted(EXPECTED_CODES - codes)
    if missing:
        return "fail", "以下判据没有抓到对应犯规：\n" + "\n".join(f"{code}（期望命中）"
                                                                 for code in missing)
    return "ok", f"{len(EXPECTED_CODES)} 条期望判据全部命中，另有 {len(codes - EXPECTED_CODES)} 条附带命中"


def make_layout_fixture(target: Path, *, left_lines: int, right_lines: int,
                        line_gap_pt: float = 17.0) -> None:
    """造一张 A2 海报样张：通栏标题 + 两栏文本，行数决定每栏铺到多低。

    为什么自己造而不是拿真海报：真海报是某个工作区的产物（不入库，也不该入库）。
    版面判据要能在**可控**的几何上验证：行数一致 → 两栏底对齐；行数悬殊 → 两栏不齐；
    两边都短 → 大片空白带。
    """
    from reportlab.lib.pagesizes import A2  # noqa: PLC0415
    from reportlab.pdfgen import canvas as pdf_canvas  # noqa: PLC0415

    width, height = A2
    canvas = pdf_canvas.Canvas(str(target), pagesize=A2)
    canvas.setFont("Helvetica-Bold", 28)
    canvas.drawString(40, height - 70, "Layout fixture poster")
    canvas.setFont("Helvetica", 12)
    y0 = height - 140
    column_x = {0: 40, 1: width / 2 + 30}
    for column, lines in ((0, left_lines), (1, right_lines)):
        for index in range(lines):
            canvas.drawString(column_x[column], y0 - index * line_gap_pt,
                              f"col{column + 1} line {index + 1:02d} " + "x" * 38)
    # 页脚一定要画：没有页脚时"末内容之后的空白"在内容框**外面**（真海报都带页脚，
    # 而"内容与页脚之间的大片空白"正是要抓的那种缺陷）。
    canvas.drawString(40, 40, "footer: layout fixture · data note")
    canvas.save()


def layout_controls(workdir: Path) -> list[tuple[str, str, str]]:
    """版面几何判据的三条对照：两栏对齐要过、大片空白要抓、两栏不齐要抓。"""
    results: list[tuple[str, str, str]] = []
    cases = [
        ("版面正对照（两栏对齐铺满）", dict(left_lines=82, right_lines=82), None),
        ("版面反对照（下半页空白）", dict(left_lines=30, right_lines=30), "large-blank-band"),
        ("版面反对照（两栏底不齐）", dict(left_lines=30, right_lines=72), "column-bottom-ragged"),
    ]
    for title, params, expected_code in cases:
        target = workdir / f"{title}.pdf"
        make_layout_fixture(target, **params)
        report_path = workdir / f"{title}.判据.json"
        gated = run_tool("pdf_gate.py", "--pdf", str(target), "--json-out", str(report_path))
        if not report_path.is_file():
            results.append((title, "fail", "质量门没有产出报告"))
            continue
        report = load_report(report_path)
        layout_gate = next((gate for gate in report["gates"] if gate["id"] == "layout"), None)
        if layout_gate is None or layout_gate["checked"] == 0:
            results.append((title, "fail", "版面判据没有真的比过东西（可能整条被跳过）"))
            continue
        codes = {item["code"] for gate in report["gates"] for item in gate["findings"]}
        if expected_code is None:
            if gated.returncode != 0:
                bad = [item for gate in report["gates"] for item in gate["findings"]
                       if item["severity"] == "fail"]
                results.append((title, "fail",
                                "铺满的版面被拦下：" + json.dumps(bad[:3], ensure_ascii=False)))
            else:
                results.append((title, "ok", f"版面判据比了 {layout_gate['checked']} 项、通过"))
        elif expected_code in codes:
            results.append((title, "ok", f"命中 {expected_code}（版面判据比了 {layout_gate['checked']} 项）"))
        else:
            results.append((title, "fail", f"没有命中 {expected_code}；实际命中：{sorted(codes)}"))
    return results


def typography_control(workdir: Path) -> tuple[str, str]:
    """中文禁则反对照：故意做一份"行首是逗号"的 PDF，质量门必须点名。"""
    from reportlab.pdfbase import pdfmetrics  # noqa: PLC0415
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont  # noqa: PLC0415
    from reportlab.pdfgen import canvas as pdf_canvas  # noqa: PLC0415

    # 用 reportlab 自带的 CJK 字体：Helvetica 没有「，」这个字形，会被画成 ■ 且抽出来也是 ■
    # （判据认的是真字符）——夹具必须真的带得出禁则标点。
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    target = workdir / "禁则反对照.pdf"
    canvas = pdf_canvas.Canvas(str(target), pagesize=(595, 842))
    canvas.setFont("STSong-Light", 12)
    canvas.drawString(60, 760, "Reference list (internal), 2026-06")
    canvas.drawString(60, 740, "，2026-07 continues on the next line")
    canvas.save()
    report_path = workdir / "禁则反对照.判据.json"
    run_tool("pdf_gate.py", "--pdf", str(target), "--no-render", "--json-out", str(report_path))
    if not report_path.is_file():
        return "fail", "质量门没有产出报告"
    report = load_report(report_path)
    codes = {item["code"] for gate in report["gates"] for item in gate["findings"]}
    if "line-start-punctuation" in codes:
        return "ok", "行首逗号被抓到（中文排版禁则判据有效）"
    return "fail", f"行首逗号没有被抓；实际命中：{sorted(codes)}"


def _balance_panel(index: int) -> dict:
    """均衡对照用的面板：每个都够高（否则整页太空，两栏根本分不出来）。"""
    return {"kind": "panel", "title": f"面板 {index}",
            "bullets": [f"第 {index} 块的第 {line} 条要点，写长一点让面板有高度"
                        for line in range(1, 7)]}


def balance_controls(workdir: Path) -> list[tuple[str, str, str]]:
    """栏均衡的两条对照：不均衡的分栏要么被自动挪平（过门），要么被质量门点名。"""
    base = {
        "poster": {"size": "A3", "orientation": "portrait", "safeMarginMm": 14, "columnGapMm": 7,
                   "maxGapMm": 14, "palette": "nibi",
                   "fonts": {"title": "微软雅黑", "body": "微软雅黑"},
                   "title": "栏均衡对照", "authors": ["NIBI"], "footer": "页脚 · 对照"},
        "columns": [
            [_balance_panel(1)],
            [_balance_panel(2), _balance_panel(3), _balance_panel(4), _balance_panel(5)],
        ],
    }
    results: list[tuple[str, str, str]] = []
    measured: dict[str, float] = {}
    # 先跑"关掉均衡"那条：它的栏底差要留给"开着均衡"那条做对照
    for title, balance, expect_code in (
        ("均衡反对照（关掉均衡必须被抓）", False, "column-bottom-ragged"),
        ("均衡对照（自动挪平必须改善）", True, None),
    ):
        spec = json.loads(json.dumps(base))
        spec["poster"]["balance"] = balance
        spec_path = workdir / f"{title}.spec.json"
        spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
        target = workdir / f"{title}.pdf"
        build_report_path = workdir / f"{title}.build.json"
        built = run_tool("pdf_poster.py", "--spec", str(spec_path), "--out", str(target),
                         "--json-out", str(build_report_path))
        if built.returncode != 0 or not target.is_file():
            results.append((title, "fail", f"生成失败：{built.stderr.strip()[-200:]}"))
            continue
        report_path = workdir / f"{title}.判据.json"
        gated = run_tool("pdf_gate.py", "--pdf", str(target), "--json-out", str(report_path))
        report = load_report(report_path)
        codes = {item["code"] for gate in report["gates"] for item in gate["findings"]}
        layout_gate = next((gate for gate in report["gates"] if gate["id"] == "layout"), None)
        spread_ratio = (layout_gate or {}).get("meta", {}).get("pages", [{}])[0].get("spreadRatio")
        if spread_ratio is not None:
            measured["off" if expect_code else "on"] = spread_ratio
        if expect_code is not None:
            if expect_code in codes:
                results.append((title, "ok",
                                f"关掉均衡后命中 {expect_code}（量得栏底差 "
                                f"{(spread_ratio or 0) * 100:.0f}% 页高）"))
            else:
                results.append((title, "fail",
                                f"关掉均衡也没被抓（期望 {expect_code}）：{sorted(codes)}"))
            continue
        # 断言的是"改善"，不是"完美"：块只能整块挪、栏间距有上限 —— 内容总量不够时两栏都到不了
        # 页底是内容问题，不是均衡器的错。所以比的是量出来的栏底差（开均衡 vs 关均衡）。
        moves = []
        balance_info: dict = {}
        if build_report_path.is_file():
            balance_info = load_report(build_report_path).get("balance", {})
            moves = balance_info.get("moves", [])
        spread_before = balance_info.get("spreadBeforeMm", 0)
        spread_after = balance_info.get("spreadMm", 0)
        off_spread = measured.get("off")
        if not moves:
            results.append((title, "fail", "不均衡的分栏没有被自动挪平（没有 move 记录）"))
        elif spread_after >= spread_before:
            results.append((title, "fail", f"挪平没有改善栏底差（按模型）：{balance_info}"))
        elif spread_ratio is None:
            results.append((title, "fail", "版面判据没有给出可读的度量（meta 缺失）"))
        else:
            detail = (f"挪平 {len(moves)} 处：模型栏底差 {spread_before}mm → {spread_after}mm，"
                      f"实测 {(spread_ratio or 0) * 100:.0f}% 页高"
                      + (f"（关均衡时 {off_spread * 100:.0f}%）" if off_spread is not None else ""))
            if off_spread is None or spread_ratio < off_spread - 0.02:
                results.append((title, "ok", detail))
            else:
                results.append((title, "fail", f"挪平后没有明显优于关掉均衡：{detail}"))
    return results


def line_ending_control() -> tuple[str, str]:
    """脚本行尾必须是 LF：CRLF 的 shebang 在 Unix 上直接 bad interpreter（实测发出去过 nibi1–nibi5）。

    只看被发布的文本类脚本；顺带在有 bash 的机器上做一次语法检查（Windows 上通常没有，
    那就退化成只查行尾 —— 不假装跑过）。
    """
    import shutil as _shutil  # noqa: PLC0415
    import subprocess  # noqa: PLC0415

    scripts = sorted(PLUGIN_ROOT.rglob("*.sh"))
    if not scripts:
        return "fail", "包里没有 .sh 脚本（预期至少 setup-unix.sh）"
    crlf = [path.name for path in scripts if b"\r\n" in path.read_bytes()]
    if crlf:
        return "fail", f"以下脚本是 CRLF 行尾（Unix 上会 bad interpreter）：{crlf}"
    bash = _shutil.which("bash")
    if not bash:
        return "ok", f"{len(scripts)} 个脚本都是 LF（本机没有 bash，跳过语法检查）"
    for path in scripts:
        checked = subprocess.run([bash, "-n", str(path)], capture_output=True, text=True)  # noqa: S603
        if checked.returncode != 0:
            return "fail", f"{path.name} 语法检查失败：{checked.stderr.strip()[:160]}"
    return "ok", f"{len(scripts)} 个脚本都是 LF，且 bash -n 全部通过"


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="pdf 质量门冒烟")
    parser.add_argument("--keep", action="store_true")
    cli.add_common(parser)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="nibi-pdf-smoke-") as raw:
        workdir = Path(raw)
        results: list[tuple[str, str, str]] = []
        status, detail = positive_control(workdir)
        results.append(("正向对照（正常 PDF 必须过）", status, detail))
        status, detail = poster_control(workdir)
        results.append(("海报路线（生成 → 过门）", status, detail))
        status, detail = negative_control(workdir)
        results.append(("反向对照（犯规 PDF 必须被抓）", status, detail))
        status, detail = typography_control(workdir)
        results.append(("禁则反对照（行首逗号必须被抓）", status, detail))
        status, detail = line_ending_control()
        results.append(("脚本行尾（CRLF 会让 shebang 失败）", status, detail))
        results.extend(layout_controls(workdir))
        results.extend(balance_controls(workdir))

        lines = ["pdf 质量门冒烟："]
        for title, state, detail in results:
            mark = {"ok": "ok  ", "fail": "FAIL", "skip": "skip"}[state]
            lines.append(f"  [{mark}] {title}")
            for chunk in detail.splitlines():
                lines.append(f"         {chunk}")
        lines.append("  说明：PDF 的渲染与读取自带（pypdfium2），本冒烟不依赖 LibreOffice")
        failed = [title for title, state, _ in results if state == "fail"]
        lines.append(f"  结论：{'通过' if not failed else '未通过——' + '、'.join(failed)}")
        if args.keep and failed:
            keep = Path.cwd() / "smoke-failure"
            keep.mkdir(exist_ok=True)
            for item in workdir.iterdir():
                if item.is_file():
                    (keep / item.name).write_bytes(item.read_bytes())
            lines.append(f"  （现场已保留到 {keep}）")
        cli.emit({"summary": "\n".join(lines),
                  "results": [{"case": title, "status": state, "detail": detail}
                              for title, state, detail in results]}, args)
        return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())

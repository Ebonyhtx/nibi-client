"""质量门冒烟：正向对照 + 反向对照，防止判据"静默空转"。

    python tools/pptx_smoke.py [--keep]

* 正向对照：用 pptx_build 造一份正常演示 → 质量门必须通过（比了 N 项，N>0）。
  需要 LibreOffice；没有时**显式跳过并说明原因**（不是通过）。
* 反向对照：用 python-pptx 直接造一份逐条犯规的演示（10pt 字号、中文没有 a:ea、
  文本框塞不下、图片被拉扁、形状越界、空页、正文带本机路径）→ 质量门必须失败，
  且每条期望判据码都要出现。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, engines  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["pptx", "PIL"], "pptx_smoke（python-pptx + pillow）")

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
# 自测夹具**不随插件发布**（用户不该在安装目录里看到"样例报告"）：
# 它们只在仓库里（templates/_dev/），用于开发与打包前验收。
DEV_FIXTURES = PLUGIN_ROOT / "templates" / "_dev"
TOOLS = Path(__file__).resolve().parent

EXPECTED_CODES = {
    "font-too-small",       # 10pt 字号
    "font-not-cjk",         # 中文配 Arial（a:ea 是拉丁字体）
    "text-overflow",        # 文本框塞不下的长文
    "image-distorted",      # 图片被拉扁
    "shape-out-of-slide",   # 形状越出页面
    "empty-slide",          # 空页
    "win-drive-path",       # 文本框里带本机路径
}


def run_tool(script: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(TOOLS / script), *args],  # noqa: S603
                          capture_output=True, text=True, encoding="utf-8", errors="replace")


def load_report(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("report", data)


def positive_control(workdir: Path) -> tuple[str, str]:
    spec = DEV_FIXTURES / "spec-deck.json"
    if not spec.is_file():
        return "skip", ("正向对照需要仓库内的样板（templates/_dev/spec-deck.json）；"
                        "该夹具不随插件发布，安装目录里跑本项会跳过。")
    target = workdir / "正向对照.pptx"
    built = run_tool("pptx_build.py", "--spec", str(spec), "--out", str(target))
    if built.returncode != 0 or not target.is_file():
        return "fail", f"构建失败：{built.stderr.strip()[-300:]}"
    report_path = workdir / "正向对照.判据.json"
    gated = run_tool("pptx_gate.py", "--pptx", str(target), "--no-engine",
                     "--json-out", str(report_path))
    if not report_path.is_file():
        return "fail", "质量门没有产出报告"
    report = load_report(report_path)
    ran = [gate for gate in report["gates"] if gate["checked"] > 0]
    if gated.returncode != 0:
        bad = [item for gate in report["gates"] for item in gate["findings"]
               if item["severity"] == "fail"]
        return "fail", "正常演示被拦下：" + json.dumps(bad[:4], ensure_ascii=False)
    if len(ran) < 6:
        return "fail", f"只有 {len(ran)} 条判据真的比过东西（应有 ≥6）"
    warns = sum(1 for gate in report["gates"] for item in gate["findings"]
                if item["severity"] == "warn")
    return "ok", f"{len(ran)} 条判据共比了 {sum(gate['checked'] for gate in ran)} 项（告警 {warns} 条）"


def make_broken(workdir: Path) -> Path:
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from PIL import Image

    import pptx_build
    import pptx_spec

    target = workdir / "反向对照.pptx"
    deck = Presentation()
    deck.slide_width = Inches(pptx_spec.SLIDE_WIDTH_IN)
    deck.slide_height = Inches(pptx_spec.SLIDE_HEIGHT_IN)
    styles = pptx_spec.styles_with_overrides(None)
    palette = pptx_spec.palette("nibi")

    # 第 1 页：10pt 字号 + 中文配拉丁 a:ea
    slide = deck.slides.add_slide(deck.slide_layouts[6])
    box = slide.shapes.add_textbox(Inches(0.6), Inches(0.6), Inches(6), Inches(1))
    run = box.text_frame.paragraphs[0].add_run()
    run.text = "这一行只有十磅，投影后排看不清"
    run.font.size = Pt(10)
    pptx_build.set_run_font(run, {"size": 10, "cjk": "Arial"}, palette)
    run2 = box.text_frame.add_paragraph().add_run()
    run2.text = "这段中文的 a:ea 被写成 Arial"
    run2.font.size = Pt(18)
    pptx_build.set_run_font(run2, {"size": 18, "cjk": "Arial"}, palette)

    # 第 2 页：文本框塞不下的长文
    slide = deck.slides.add_slide(deck.slide_layouts[6])
    box = slide.shapes.add_textbox(Inches(0.6), Inches(0.6), Inches(3), Inches(0.6))
    box.text_frame.word_wrap = True
    run = box.text_frame.paragraphs[0].add_run()
    run.text = ("这一页的文本框只有 3 英寸宽、0.6 英寸高，却塞进了一整段很长的中文说明文字，"
                "渲染出来必然溢出框外，压到下面的内容上。")
    pptx_build.set_run_font(run, {"size": 20, "cjk": "微软雅黑"}, palette)

    # 第 3 页：图片被拉扁 + 形状越界 + 本机路径
    slide = deck.slides.add_slide(deck.slide_layouts[6])
    image_path = workdir / "broken.png"
    Image.new("RGB", (800, 600), "white").save(image_path)
    slide.shapes.add_picture(str(image_path), Inches(1), Inches(1), width=Inches(6), height=Inches(1.5))
    off = slide.shapes.add_textbox(Inches(12.4), Inches(6.9), Inches(2), Inches(1))
    run = off.text_frame.paragraphs[0].add_run()
    run.text = "C:\\Users\\<用户名>\\答辩.pptx"
    pptx_build.set_run_font(run, {"size": 18, "cjk": "微软雅黑"}, palette)

    # 第 4 页：空页
    deck.slides.add_slide(deck.slide_layouts[6])

    deck.save(target)
    return target


def negative_control(workdir: Path) -> tuple[str, str]:
    target = make_broken(workdir)
    report_path = workdir / "反向对照.判据.json"
    gated = run_tool("pptx_gate.py", "--pptx", str(target), "--no-engine",
                     "--json-out", str(report_path))
    if not report_path.is_file():
        return "fail", "质量门没有产出报告"
    report = load_report(report_path)
    codes = {item["code"] for gate in report["gates"] for item in gate["findings"]}
    if gated.returncode == 0:
        return "fail", "犯规演示竟然通过了质量门（判据空转）"
    missing = sorted(EXPECTED_CODES - codes)
    if missing:
        return "fail", "以下判据没有抓到对应犯规：\n" + "\n".join(f"{code}（期望命中）"
                                                                 for code in missing)
    return "ok", f"{len(EXPECTED_CODES)} 条期望判据全部命中，另有 {len(codes - EXPECTED_CODES)} 条附带命中"


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="pptx 质量门冒烟")
    parser.add_argument("--keep", action="store_true")
    cli.add_common(parser)
    args = parser.parse_args()

    has_engine = engines.engine_report().can_convert
    with tempfile.TemporaryDirectory(prefix="nibi-pptx-smoke-") as raw:
        workdir = Path(raw)
        results: list[tuple[str, str, str]] = []
        status, detail = positive_control(workdir)
        results.append(("正向对照（正常演示必须过）", status, detail))
        status, detail = negative_control(workdir)
        results.append(("反向对照（犯规演示必须被抓）", status, detail))

        lines = ["pptx 质量门冒烟："]
        for title, state, detail in results:
            mark = {"ok": "ok  ", "fail": "FAIL", "skip": "skip"}[state]
            lines.append(f"  [{mark}] {title}")
            for chunk in detail.splitlines():
                lines.append(f"         {chunk}")
        lines.append(f"  引擎：{'有（渲染层见质量门）' if has_engine else '无（本轮只跑静态判据）'}")
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

"""按操作清单改既有 .xlsx，并在改之前/之后做「往返丢失」检查。

    python tools/xlsx_edit.py --xlsx 输入.xlsx --ops 操作.json --out 输出.xlsx [--force]

## 为什么先检查再动手

openpyxl 的往返（load → save）**会丢掉它不认识的东西**：VBA 工程（除非 `keep_vba`）、数据透视表、
文本框/形状、切片器、迷你图等。用户拿来的是他辛辛苦苦做的表，改一个数却把透视表弄没了，
是最难交代的一类事故。所以：

1. **动手前**扫一遍文件结构，发现"会被丢掉的东西"就**拒绝执行**（除非 `--force`）；
2. **动手后**再数一遍（图表/条件格式/数据校验/合并/批注/图片/定义名称/打印区域），
   数量变少就报 `round-trip-loss` 并给非零退出码 —— 不靠"我以为它会保留"。

操作清单（JSON）：

```json
{
  "setValues":      [{"cell": "B4", "v": 128.5, "format": "num1"}],
  "setFormulas":    [{"cell": "B10", "f": "=SUM(B4:B9)"}],
  "setStyles":      [{"cell": "A1", "style": "sheetTitle"}],
  "setColumnWidths":[{"column": "B", "width": 14}],
  "renameSheet":    [{"from": "Sheet1", "to": "明细"}],
  "addNotes":       [{"cell": "A12", "text": "注：数据截至 6 月 30 日。"}]
}
```

每类操作都要写 `sheet`（多张表时必填；只有一张表可省）。
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli, hygiene  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["openpyxl"], "xlsx_edit（openpyxl）")

import xlsx_spec as spec_mod  # noqa: E402

from openpyxl import load_workbook  # noqa: E402
from openpyxl.cell.cell import MergedCell  # noqa: E402
from openpyxl.comments import Comment  # noqa: E402
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side  # noqa: E402

# 这些部件 openpyxl 往返会丢（或需要特殊开关），出现就拒绝。
UNSAFE_PARTS = {
    "xl/vbaProject.bin": "VBA 宏工程",
    "xl/pivotTables/": "数据透视表",
    "xl/slicers/": "切片器",
    "xl/timelines/": "时间线",
}
UNSAFE_XML = (("<xdr:sp>", "文本框/形状"), ("<xdr:sp ", "文本框/形状"))


def unsafe_features(path: Path) -> list[str]:
    found: list[str] = []
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        for prefix, label in UNSAFE_PARTS.items():
            if any(name.startswith(prefix) if prefix.endswith("/") else name == prefix
                   for name in names):
                found.append(label)
        for name in names:
            if not name.startswith("xl/drawings/") or not name.endswith(".xml"):
                continue
            text = archive.read(name).decode("utf-8", errors="ignore")
            for token, label in UNSAFE_XML:
                if token in text and label not in found:
                    found.append(label)
            if "sparkline" in text.lower() and "迷你图" not in found:
                found.append("迷你图")
        if "xl/persons/" in " ".join(names) and "批注作者信息" not in found:
            found.append("批注作者信息")
    return sorted(set(found))


FEATURES = ("charts", "conditional", "validations", "merged", "comments", "images",
            "definedNames", "printAreas")


def count_features(workbook) -> dict[str, int]:
    tally = dict.fromkeys(FEATURES, 0)
    for ws in workbook.worksheets:
        tally["charts"] += len(getattr(ws, "_charts", []))
        tally["conditional"] += sum(1 for _ in ws.conditional_formatting)
        tally["validations"] += len(ws.data_validations.dataValidation)
        tally["merged"] += len(ws.merged_cells.ranges)
        tally["comments"] += sum(1 for row in ws.iter_rows() for cell in row if cell.comment)
        tally["images"] += len(getattr(ws, "_images", []))
        if ws.print_area:
            tally["printAreas"] += 1
    tally["definedNames"] = len(workbook.defined_names)
    return tally


def writable_cell(ws, ref: str):
    """取可写的单元格。合并区里除左上角外都是只读的 MergedCell ——
    直接写会 AttributeError: 'MergedCell' object attribute 'value' is read-only，
    这里提前拦下并说清该写哪个格（实测踩过）。"""
    cell = ws[ref]
    if isinstance(cell, MergedCell):
        for merged in ws.merged_cells.ranges:
            if cell.coordinate in merged:
                raise SystemExit(f"{ws.title}!{ref} 在合并区 {merged} 内且不是左上角；"
                                 f"改合并单元格请写它的左上角 {merged.coord.split(':')[0]}。")
        raise SystemExit(f"{ws.title}!{ref} 是只读单元格（合并区的一部分），不能直接写。")
    return cell


def sheet_of(workbook, item: dict):
    name = item.get("sheet")
    if name:
        if name not in workbook.sheetnames:
            raise SystemExit(f"操作里的 sheet 不存在：{name}（现有：{'、'.join(workbook.sheetnames)}）")
        return workbook[name]
    if len(workbook.worksheets) == 1:
        return workbook.worksheets[0]
    raise SystemExit("操作里必须写 sheet（文件有多张表）")


def style_obj(definition: dict):
    from xlsx_spec import BASE_STYLES  # noqa: PLC0415

    merged = dict(BASE_STYLES.get(definition.get("style", ""), {}))
    overrides = definition.get("styleOverrides") or {}
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key].update(value)
        else:
            merged[key] = value
    palette = spec_mod.palette("nibi")

    def color(value):
        text = str(value or "").strip()
        return text[1:].upper() if text.startswith("#") else palette.get(text, "22252B")

    font_def = merged.get("font", {})
    return {
        "font": Font(name=font_def.get("name", "微软雅黑"), size=float(font_def.get("size", 10.5)),
                     bold=bool(font_def.get("bold")), italic=bool(font_def.get("italic")),
                     color=color(font_def.get("color")) if font_def.get("color") else None),
        "fill": PatternFill("solid", fgColor=color(merged["fill"])) if merged.get("fill") else None,
        "alignment": Alignment(horizontal=(merged.get("alignment") or {}).get("horizontal"),
                               vertical=(merged.get("alignment") or {}).get("vertical", "center"),
                               wrap_text=bool((merged.get("alignment") or {}).get("wrap_text"))),
    }


def apply_ops(workbook, ops: dict) -> dict:
    applied = {"setValues": 0, "setFormulas": 0, "setStyles": 0, "setColumnWidths": 0,
               "renameSheet": 0, "addNotes": 0}
    for item in ops.get("setValues", []):
        ws = sheet_of(workbook, item)
        cell = writable_cell(ws, item["cell"])
        cell.value = item["v"]
        if item.get("format"):
            cell.number_format = spec_mod.normalize_number_format(item["format"])
        applied["setValues"] += 1
    for item in ops.get("setFormulas", []):
        ws = sheet_of(workbook, item)
        formula = str(item["f"])
        writable_cell(ws, item["cell"]).value = formula if formula.startswith("=") else "=" + formula
        applied["setFormulas"] += 1
    for item in ops.get("setStyles", []):
        ws = sheet_of(workbook, item)
        cell = writable_cell(ws, item["cell"])
        resolved = style_obj(item)
        cell.font = resolved["font"]
        if resolved["fill"] is not None:
            cell.fill = resolved["fill"]
        cell.alignment = resolved["alignment"]
        applied["setStyles"] += 1
    for item in ops.get("setColumnWidths", []):
        ws = sheet_of(workbook, item)
        ws.column_dimensions[item["column"]].width = float(item["width"])
        applied["setColumnWidths"] += 1
    for item in ops.get("renameSheet", []):
        if item["from"] not in workbook.sheetnames:
            raise SystemExit(f"要改名的工作表不存在：{item['from']}")
        workbook[item["from"]].title = item["to"]
        applied["renameSheet"] += 1
    for item in ops.get("addNotes", []):
        ws = sheet_of(workbook, item)
        writable_cell(ws, item["cell"]).comment = Comment(item["text"], "NIBI")
        applied["addNotes"] += 1
    return applied


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="按操作清单改 xlsx（含往返丢失检查）")
    parser.add_argument("--xlsx", required=True)
    parser.add_argument("--ops", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--force", action="store_true", help="文件含会被丢掉的部件时仍继续（危险）")
    cli.add_common(parser)
    args = parser.parse_args()

    source = Path(args.xlsx).expanduser()
    target = Path(args.out).expanduser()
    if not source.is_file():
        print(f"找不到文件：{source}", file=sys.stderr)
        return 2
    if source.resolve() == target.resolve():
        print("拒绝原地改写：请输出到新文件（原文件只读），确需覆盖请自己备份后再跑。", file=sys.stderr)
        return 2

    unsafe = unsafe_features(source)
    if unsafe and not args.force:
        print("这个文件里有 openpyxl 往返会丢掉的部件：\n  " + "、".join(unsafe)
              + "\n直接改会把它们弄没。建议：在 Excel/WPS 里另存一份纯数据版再改，"
                "或确认可接受后用 --force。", file=sys.stderr)
        return 2

    ops = json.loads(Path(args.ops).expanduser().read_text(encoding="utf-8"))
    workbook = load_workbook(source, keep_vba=("VBA 宏工程" in unsafe))
    try:
        before = count_features(workbook)
        applied = apply_ops(workbook, ops)
        hygiene.scrub_core_properties(workbook.properties, author=workbook.properties.creator or "NIBI")
        target.parent.mkdir(parents=True, exist_ok=True)
        workbook.save(target)
    finally:
        workbook.close()

    check = load_workbook(target)
    try:
        after = count_features(check)
    finally:
        check.close()
    losses = {name: (before[name], after[name]) for name in FEATURES if after[name] < before[name]}
    lines = [f"已写出 {target}（操作 {sum(applied.values())} 条：" +
             "、".join(f"{key} {value}" for key, value in applied.items() if value) + "）"]
    for name, (old, new) in losses.items():
        lines.append(f"  ✗ 往返丢失 {name}：{old} → {new}")
    for name in FEATURES:
        if after[name]:
            lines.append(f"  · 保留了 {name} {after[name]} 项")
    if unsafe:
        lines.append(f"  ! 输入含：{'、'.join(unsafe)}（已按 --force 继续，请人工复核）")
    lines.append("下一步：python tools/xlsx_gate.py --xlsx " + str(target))
    cli.emit({"summary": "\n".join(lines), "applied": applied, "losses": losses,
              "unsafe": unsafe, "out": str(target)}, args)
    return 1 if losses else 0


if __name__ == "__main__":
    raise SystemExit(main())

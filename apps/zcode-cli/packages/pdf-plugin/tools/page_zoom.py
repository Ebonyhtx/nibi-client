"""页面图的裁图/放大助手：给视觉验收子智能体看细节用。

## 为什么要有它（一次真事故）

子智能体有 Bash，天然会想"放大看看这块" —— 实测它自己拼了一条
`cd "<工作区>/tools/doc-demo/<题目目录>" && python -c "from PIL import Image impor…`：
路径记错（少了 `.tools` 前的点）、命令也拼错了，白等一轮还看不出问题。**问题不是 Bash，
而是"让它自己猜路径、自己拼命令"**。给一个固定入口，它就不用猜了。

## 用法（从插件根调用，绝对路径最稳）

    python tools/page_zoom.py --image page-0001.png --out zoom.png \
        --crop 120,900,1400,1500 --zoom 2 [--grid]

* `--crop x,y,w,h`：只截这块（像素，原点左上）；缺省整页缩略（长边 1600px）。
* `--zoom`：放大倍数，**最多 4**（再大只是把像素拉大，看不出更多细节，还费时间）。
* `--grid`：叠 100px 网格 + 坐标刻度，便于把看到的位置说清楚（判据要引用具体位置时很有用）。
* 输出是 PNG；打印原图与产出尺寸，方便在结论里引用。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import cli  # noqa: E402
from nibi_kit.env import require_modules  # noqa: E402

require_modules(["PIL"], "page_zoom（pillow）")

MAX_ZOOM = 4.0


def parse_box(raw: str) -> tuple[int, int, int, int] | None:
    if not raw.strip():
        return None
    parts = [item.strip() for item in raw.split(",")]
    if len(parts) != 4:
        raise SystemExit("--crop 需要四个数：x,y,w,h（像素）")
    try:
        x, y, w, h = (int(float(item)) for item in parts)
    except ValueError as error:
        raise SystemExit(f"--crop 里不是数字：{raw}") from error
    if w <= 0 or h <= 0:
        raise SystemExit("--crop 的宽高必须为正")
    return x, y, w, h


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="页面图裁图/放大（视觉验收用）")
    parser.add_argument("--image", required=True, help="页面图（PNG）")
    parser.add_argument("--out", required=True, help="产出的 PNG")
    parser.add_argument("--crop", default="", help="只截这块：x,y,w,h（像素，原点左上）")
    parser.add_argument("--zoom", type=float, default=1.0, help=f"放大倍数（上限 {MAX_ZOOM:g}）")
    parser.add_argument("--grid", action="store_true", help="叠 100px 网格与坐标刻度")
    cli.add_common(parser)
    args = parser.parse_args()

    from PIL import Image, ImageDraw  # noqa: PLC0415

    source = Path(args.image).expanduser()
    if not source.is_file():
        print(f"找不到图：{source}", file=sys.stderr)
        return 2
    zoom = min(max(args.zoom, 0.1), MAX_ZOOM)
    target = Path(args.out).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(source) as image:
        image = image.convert("RGB")
        original = image.size
        box = parse_box(args.crop)
        if box is not None:
            x, y, w, h = box
            if x >= original[0] or y >= original[1]:
                print(f"--crop 的起点超出图范围（原图 {original[0]}×{original[1]}）", file=sys.stderr)
                return 2
            right = min(x + w, original[0])
            bottom = min(y + h, original[1])
            image = image.crop((x, y, right, bottom))
        else:
            long_side = max(image.size)
            if long_side > 1600:
                ratio = 1600 / long_side
                image = image.resize((round(image.width * ratio), round(image.height * ratio)))
                print(f"（整页缩略：长边 {long_side}px → 1600px；要看细节请用 --crop 指定区域）")
        if zoom != 1.0:
            image = image.resize((max(1, round(image.width * zoom)), max(1, round(image.height * zoom))))
        if args.grid:
            draw = ImageDraw.Draw(image)
            step = max(50, round(100 * zoom))
            for x in range(step, image.width, step):
                draw.line([(x, 0), (x, image.height)], fill=(200, 60, 60), width=1)
                draw.text((x + 2, 2), str(x), fill=(200, 60, 60))
            for y in range(step, image.height, step):
                draw.line([(0, y), (image.width, y)], fill=(200, 60, 60), width=1)
                draw.text((2, y + 2), str(y), fill=(200, 60, 60))
        image.save(target)

    lines = [f"裁图完成：{source.name}（原图 {original[0]}×{original[1]}）→ {target.name}",
             f"  产出 {image.width}×{image.height}px，放大 {zoom:g}×"
             + ("，已叠 100px 网格（坐标为像素，原点左上）" if args.grid else "")]
    if box:
        lines.append(f"  裁剪区域：x={box[0]} y={box[1]} w={box[2]} h={box[3]}")
    cli.emit({"summary": "\n".join(lines), "out": str(target),
              "size": [image.width, image.height], "sourceSize": list(original)}, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

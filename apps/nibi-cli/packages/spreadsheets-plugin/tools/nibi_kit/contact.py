"""观测表：把逐页 PNG 拼成一张图，一次看全。

## 为什么要有它

逐页图多的时候（几十页 PPT、几十页论文），一页页看既慢又容易漏看同一类缺陷。
观测表把全部页面缩略平铺，配合页码标签，能一眼扫出「哪一页明显不对」，再回原图细看。
它只做拼图，不做判断 —— 判断是 `visual-judge`（或人眼）的事。
"""

from __future__ import annotations

from pathlib import Path

MAX_SHEET_WIDTH = 2600
MAX_SHEET_HEIGHT = 3400


def make_contact_sheet(images: list[Path], target: Path, *, columns: int = 4,
                       thumb_width: int = 560, background: str = "#EDE7DC",
                       label_height: int = 26) -> Path:
    """把图片平铺成观测表；页宽高按比例缩到 `thumb_width`，标签写在缩略图下方。"""
    from PIL import Image, ImageDraw  # noqa: PLC0415

    if not images:
        raise SystemExit("观测表：没有可用图片")
    thumbs = []
    for path in images:
        with Image.open(path) as image:
            image = image.convert("RGB")
            ratio = thumb_width / image.width
            thumbs.append((path, image.resize((thumb_width, max(1, round(image.height * ratio))),
                                              Image.LANCZOS)))
    rows = (len(thumbs) + columns - 1) // columns
    cell_height = max(image.height for _, image in thumbs) + label_height
    width = columns * (thumb_width + 16) + 16
    height = rows * (cell_height + 16) + 16
    sheet = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(sheet)
    for index, (path, image) in enumerate(thumbs):
        row, column = divmod(index, columns)
        x = 16 + column * (thumb_width + 16)
        y = 16 + row * (cell_height + 16)
        sheet.paste(image, (x, y))
        draw.text((x + 2, y + image.height + 5), f"{index + 1:03d}  {path.name}", fill="#1E3A5F")
    if sheet.width > MAX_SHEET_WIDTH or sheet.height > MAX_SHEET_HEIGHT:
        ratio = min(MAX_SHEET_WIDTH / sheet.width, MAX_SHEET_HEIGHT / sheet.height)
        sheet = sheet.resize((round(sheet.width * ratio), round(sheet.height * ratio)), Image.LANCZOS)
    target.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(target)
    return target

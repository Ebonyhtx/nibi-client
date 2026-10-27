"""字体文件定位：把「字体族名」解析成可测量的字体文件。

用途有两个：自渲染降级路径要按真实字体画字；文字宽度估算（截断判据）要按真实字形量宽。
两者都必须用**实际存在的字体文件**，不能假设字号与宽度成正比 —— 中文字形宽度约等于字号，
拉丁字母只有一半，混排表里拍脑袋的估算会同时放过真截断、误报正常单元格。

解析顺序：别名表（常见中文字体的族名 → 各平台文件名）→ 平台字体目录扫描（用 PIL 读字体内部
族名做匹配）→ `fc-match`（Linux）。结果缓存进插件数据目录，避免每次调用都扫全量字体。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from . import env as env_mod

# 族名（小写、去掉空格）→ 各平台候选文件名。覆盖 Windows/macOS/Linux 上常见的中文易读字体。
ALIASES: dict[str, tuple[str, ...]] = {
    "微软雅黑": ("msyh.ttc", "msyh.ttf", "msyhbd.ttc"),
    "microsoftyahei": ("msyh.ttc", "msyh.ttf", "msyhbd.ttc"),
    "等线": ("Deng.ttf", "Dengb.ttf", "Dengl.ttf"),
    "dengxian": ("Deng.ttf", "Dengb.ttf", "Dengl.ttf"),
    "宋体": ("simsun.ttc",),
    "simsun": ("simsun.ttc",),
    "新宋体": ("simsunb.ttf", "simsun.ttc"),
    "黑体": ("simhei.ttf",),
    "simhei": ("simhei.ttf",),
    "楷体": ("simkai.ttf",),
    "kaiti": ("simkai.ttf",),
    "仿宋": ("simfang.ttf",),
    "fangsong": ("simfang.ttf",),
    "思源黑体": ("SourceHanSansSC-Regular.otf", "NotoSansCJK-Regular.ttc", "NotoSansSC-Regular.otf"),
    "思源宋体": ("SourceHanSerifSC-Regular.otf", "NotoSerifCJK-Regular.ttc"),
    "notosanscjksc": ("NotoSansCJK-Regular.ttc", "NotoSansSC-Regular.otf", "SourceHanSansSC-Regular.otf"),
    "notosanssc": ("NotoSansSC-Regular.otf", "NotoSansCJK-Regular.ttc"),
    "notoserifcjksc": ("NotoSerifCJK-Regular.ttc",),
    "苹方": ("PingFang.ttc",),
    "pingfang": ("PingFang.ttc",),
    "pingfangsc": ("PingFang.ttc",),
    "华文黑体": ("STHeiti Light.ttc", "STHeiti Medium.ttc"),
    "stheiti": ("STHeiti Light.ttc", "STHeiti Medium.ttc"),
    "冬青黑体": ("Hiragino Sans GB.ttc",),
    "hiraginosansgb": ("Hiragino Sans GB.ttc",),
    "文泉驿微米黑": ("wqy-microhei.ttc",),
    "wenquanyimicrohei": ("wqy-microhei.ttc",),
    "arial": ("arial.ttf",),
    "calibri": ("calibri.ttf",),
    "timesnewroman": ("times.ttf",),
    "consolas": ("consola.ttf",),
    "cambria": ("cambria.ttc",),
    "segoeui": ("segoeui.ttf",),
}


def _font_dirs() -> list[Path]:
    if sys.platform == "win32":
        return [Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"]
    if sys.platform == "darwin":
        return [Path("/System/Library/Fonts"), Path("/Library/Fonts"),
                Path.home() / "Library" / "Fonts"]
    return [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"),
            Path.home() / ".local" / "share" / "fonts"]


def _cache_path(root: Path | None = None) -> Path:
    return env_mod.resolve_env_dir(root=root).path / "font-cache.json"


def font_file(family: str, root: Path | None = None) -> Path | None:
    """族名 → 字体文件。找不到返回 None（调用方要如实报「该字体不可测量」）。"""
    key = family.strip().lower().replace(" ", "")
    dirs = _font_dirs()
    for name in ALIASES.get(key, ()):  # 别名表优先：命中即返回，不扫目录
        for directory in dirs:
            candidate = directory / name
            if candidate.is_file():
                return candidate
    return _scan_by_family(family, dirs, root)


def _scan_by_family(family: str, dirs: list[Path], root: Path | None) -> Path | None:
    cache: dict[str, str] = {}
    cache_file = _cache_path(root)
    try:
        cache = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cache = {}
    hit = cache.get(family.lower())
    if hit and Path(hit).is_file():
        return Path(hit)
    found = _scan_dirs(dirs, family)
    if found is not None:
        cache[family.lower()] = str(found)
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass
    return found


def _scan_dirs(dirs: list[Path], family: str) -> Path | None:
    try:
        from PIL import ImageFont  # noqa: PLC0415
    except ImportError:
        return None
    wanted = family.strip().lower().replace(" ", "")
    for directory in dirs:
        if not directory.is_dir():
            continue
        for candidate in sorted(directory.iterdir()):
            if candidate.suffix.lower() not in {".ttf", ".ttc", ".otf", ".otc"}:
                continue
            try:
                probed = ImageFont.truetype(str(candidate), 16)
                inner = {part.strip().lower().replace(" ", "")
                         for part in probed.getname() if part}
            except (OSError, ValueError):
                continue
            if wanted in inner:
                return candidate
    return None


def available_families() -> list[str]:
    """本机可用的中文字体族名（供装库前挑默认字体用）。"""
    names: list[str] = []
    for family in ("微软雅黑", "等线", "宋体", "黑体", "楷体", "仿宋",
                   "思源黑体", "苹方", "冬青黑体", "文泉驿微米黑"):
        if font_file(family) is not None:
            names.append(family)
    return names

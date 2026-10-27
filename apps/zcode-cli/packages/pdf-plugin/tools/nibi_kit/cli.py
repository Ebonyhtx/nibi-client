"""CLI 公共骨架：UTF-8 输出、JSON/人类可读双通道、退出码。

Windows 上 `python tools/x.py` 的 stdout 默认是 GBK（中文 Windows），打印中文可能
UnicodeEncodeError 直接崩掉 —— 交付工具不能因为一句中文输出就失败，所以所有 CLI 入口
统一走 `bootstrap()`。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def bootstrap() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    # 注意：不叫 --out —— 各工具自己会用 --out 表示"产出文件"，同名会直接 argparse 冲突。
    parser.add_argument("--json-out", default="", help="把 JSON 结果另存到文件")


def emit(payload: dict, args: argparse.Namespace) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    target_path = getattr(args, "json_out", "") or ""
    if target_path:
        target = Path(target_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    if not getattr(args, "json", False):
        for line in str(payload.get("summary", "")).splitlines():
            print(line)
    else:
        print(text)


def parse_pages(spec: str, total: int) -> list[int]:
    """`--pages 1-5,9` → 1 基页码列表；空则全部。"""
    if not spec.strip():
        return list(range(1, total + 1))
    wanted: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start, _, end = chunk.partition("-")
            wanted += list(range(int(start), int(end) + 1))
        else:
            wanted.append(int(chunk))
    return [index for index in wanted if 1 <= index <= total]

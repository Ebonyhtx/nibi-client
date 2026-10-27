"""判据：UI 里 `id: "xxx"` 引用的 i18n 键必须在两份语言文件里都存在。

为什么需要：i18n 缺键不会报错——`formatMessage({id})` 缺键时 react-intl 会回落成
`id` 本身或空串，用户看到的是 "nibi.membership.dialog.bannedTitle" 这种原始键。
静态构建、typecheck、lint 全都绿，只有真人打开界面才发现。
（历史上整个会员 UI 的 32 个键曾在基座调整时全部丢失。）

用法：python check-i18n-keys.py [repoRoot]
退出码：0 = 全覆盖；1 = 有缺失 / 语言间不一致。
"""

import re
import sys
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1])
LOCALES = {
    "zh-CN": REPO / "packages/ui/src/i18n/locales/zh-CN.ts",
    "en-US": REPO / "packages/ui/src/i18n/locales/en-US.ts",
}
# 只扫会被打进 renderer 的源码
SCAN_ROOTS = [
    REPO / "packages/ui/src",
    REPO / "packages/web/src",
]
SKIP_PARTS = {"node_modules", "dist", "out", ".turbo"}

KEY_PATTERN = re.compile(r'\bid:\s*"([a-zA-Z][a-zA-Z0-9._-]*)"')
# 运行时拼接的键（如 `foo.${x}`）无法静态判定，出现回退标记时跳过
DYNAMIC_HINTS = ("${", "`")


def load_keys(path: Path) -> set[str]:
    """收集语言文件里的键，**包括通过 spread 引入的**。

    踩过的坑：`zcode.error.modelSuspiciousEmpty` 由 `...requestSecurityMessagesEnUS`
    提供，只扫本文件会判它缺失，于是补了一份 → TS2783 重复键。
    这里把 `import { x } from "path"` 与 `...x,` 对上，递归读被 spread 的文件。
    """
    text = path.read_text(encoding="utf-8")
    keys = set(re.findall(r'^\s{2}"([^"]+)":', text, re.M))

    # import { A, B } from "..."   →  收集 spread 进来的本地消息对象
    imports: dict[str, Path] = {}
    for m in re.finditer(r'^import\s*\{([^}]+)\}\s*from\s*"([^"]+)"', text, re.M):
        spec = m.group(2)
        if not spec.startswith(".") and not spec.startswith("@"):
            continue
        target = (path.parent / spec) if spec.startswith(".") else None
        if target is None:
            # @/ 别名：按仓库约定解析到 packages/ui/src
            alias = spec.split("/src/", 1)[-1] if "/src/" in spec else spec[2:]
            target = REPO / "packages/ui/src" / alias
        for name in m.group(1).split(","):
            name = name.strip()
            if name:
                imports[name] = target

    for m in re.finditer(r"^\s*\.\.\.([A-Za-z_$][\w$]*),", text, re.M):
        target = imports.get(m.group(1))
        if target is None:
            continue
        for candidate in (target, target.with_suffix(".ts"), target.with_suffix(".tsx")):
            if candidate.exists():
                try:
                    keys |= set(re.findall(r'^\s{2}"([^"]+)":',
                                           candidate.read_text(encoding="utf-8"), re.M))
                except (OSError, UnicodeDecodeError):
                    pass
                break

    return keys


def iter_sources():
    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*.ts*"):
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            if not path.suffix in {".ts", ".tsx", ".mts", ".cts"}:
                continue
            yield path


def main() -> int:
    locale_keys = {loc: load_keys(p) for loc, p in LOCALES.items()}
    print("语言文件键数：" + "、".join(f"{loc}={len(v)}" for loc, v in locale_keys.items()))

    # 1) 两份语言文件必须键集一致
    zh, en = locale_keys["zh-CN"], locale_keys["en-US"]
    missing_en = sorted(zh - en)
    missing_zh = sorted(en - zh)
    problems = 0
    if missing_en or missing_zh:
        problems += 1
        print(f"\n✗ 语言间不一致：zh 有 en 无 {len(missing_en)} 个，en 有 zh 无 {len(missing_zh)} 个")
        for k in (missing_en[:20] + missing_zh[:20]):
            print(f"    {k}")

    # 2) 源码引用的键必须都存在
    used: dict[str, list[str]] = {}
    for path in iter_sources():
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for m in KEY_PATTERN.finditer(text):
            key = m.group(1)
            # 只查带点号的 id（react-intl 的 message id 约定）；普通 DOM id 常无点
            if "." not in key:
                continue
            used.setdefault(key, []).append(str(path.relative_to(REPO)))

    missing = sorted(k for k in used if k not in zh)
    print(f"\n源码引用 {len(used)} 个带点 id，缺失 {len(missing)} 个")
    if missing:
        problems += 1
        for key in missing[:40]:
            where = used[key][0]
            print(f"    ✗ {key}  ({where})")
        if len(missing) > 40:
            print(f"    ...其余 {len(missing) - 40} 个省略")

    if problems == 0:
        print("\n✓ 通过：语言间一致，源码引用的键全部有文案。")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

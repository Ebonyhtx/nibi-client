"""判据：五套界面语言的 i18n 表必须能满足源码引用，且翻译不破坏占位符/品牌/语法。

为什么需要：i18n 缺键不会报错——`formatMessage({id})` 缺键时 react-intl 会回落成
`id` 本身或空串，用户看到的是 "nibi.membership.dialog.bannedTitle" 这种原始键。
静态构建、typecheck、lint 全都绿，只有真人打开界面才发现。
（历史上整个会员 UI 的 32 个键曾在基座调整时全部丢失。）

五语言模型（zh-CN / en-US / ja-JP / ru-RU / ko-KR）：
- zh-CN 与 en-US 必须键集完全一致（中文表是完整基线）；
- ja/ko/ru 来自上游人工翻译，只覆盖 NIBI 也使用的 key；**缺失 key 由 localeMessages
  合并 en-US 回退**，所以允许子集，但要求三语键集一致、逐键占位符与英文一致；
- 覆盖率低于阈值说明上游交集被误删，或英文新增了一大批 NIBI 专属 key 没重新生成，
  需要显式确认，不能静默退化。

用法：python check-i18n-keys.py [repoRoot]
退出码：0 = 通过；1 = 有缺失 / 语言间不一致 / 占位符或品牌问题。
"""

import ast
import re
import sys
from pathlib import Path

# Windows 默认 GBK 控制台会把 ✓/✗ 打成 UnicodeEncodeError，检查结果反而丢失。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1])
LOCALES = {
    "zh-CN": REPO / "packages/ui/src/i18n/locales/zh-CN.ts",
    "en-US": REPO / "packages/ui/src/i18n/locales/en-US.ts",
    "ja-JP": REPO / "packages/ui/src/i18n/locales/ja-JP.ts",
    "ru-RU": REPO / "packages/ui/src/i18n/locales/ru-RU.ts",
    "ko-KR": REPO / "packages/ui/src/i18n/locales/ko-KR.ts",
}
TRANSLATED_LOCALES = ("ja-JP", "ru-RU", "ko-KR")
# 只扫会被打进 renderer 的源码
SCAN_ROOTS = [
    REPO / "packages/ui/src",
    REPO / "packages/web/src",
]
SKIP_PARTS = {"node_modules", "dist", "out", ".turbo"}

KEY_PATTERN = re.compile(r'\bid:\s*"([a-zA-Z][a-zA-Z0-9._-]*)"')
# 运行时拼接的键（如 `foo.${x}`）无法静态判定，出现回退标记时跳过
DYNAMIC_HINTS = ("${", "`")
# 语言表按格式化后的形状解析：2 空格缩进 + JSON 风格字符串字面量。
ENTRY_PATTERN = re.compile(r'^  "((?:[^"\\]|\\.)*)":\s*', re.M)
IMPORT_PATTERN = re.compile(r'^import\s*\{([^}]+)\}\s*from\s*"([^"]+)"', re.M)
SPREAD_PATTERN = re.compile(r"^\s*\.\.\.([A-Za-z_$][\w$]*),", re.M)

# NIBI 的 formatMessage 只做 {name}.replaceAll；ICU/plural 会被原样显示。
ICU_PATTERN = re.compile(
    r"\{\s*[A-Za-z0-9_]+\s*,\s*(?:plural|select|selectordinal|number|date|time)\b"
)
PLACEHOLDER_PATTERN = re.compile(r"\{([A-Za-z0-9_]+)\}")
# 上游品牌不得出现在 NIBI 语言表里；Claude Code / GLM / BigModel / Z.ai 是合法的
# 第三方或 provider 品牌，不在此列。
BRAND_PATTERN = re.compile(r"ZCode|zcode\.z\.ai|~/\.zcode|\.zcodeignore|x-zcode")
# ja/ko/ru 至少显式翻译 en-US 的 85%；其余 key 回退英文并在输出里计数。
MIN_TRANSLATED_RATIO = 0.85


def parse_string_literal(text: str, start: int) -> tuple[str, int]:
    """从 start 处的引号开始读一个 JS 字符串字面量，返回 (值, 结束位置)。"""
    quote = text[start]
    if quote not in {'"', "'"}:
        raise ValueError(f"expect string literal at {start}")
    i = start + 1
    while i < len(text):
        char = text[i]
        if char == "\\":
            i += 2
            continue
        if char == quote:
            literal = text[start : i + 1]
            if quote == "'":
                # JS 单引号串里的 \" 在 Python 里也合法；\' 需要转成 '。
                literal = '"' + literal[1:-1].replace('\\\'', "'").replace('"', '\\"') + '"'
            return ast.literal_eval(literal), i + 1
        i += 1
    raise ValueError("unterminated string literal")


def load_entries(path: Path, depth: int = 0) -> dict[str, str]:
    """解析语言文件里的 key → value，包含通过 spread 引入的对象。

    踩过的坑：`nibi.error.modelSuspiciousEmpty` 由 `...requestSecurityMessagesEnUS`
    提供，只扫本文件会判它缺失，于是补了一份 → TS2783 重复键。
    """
    text = path.read_text(encoding="utf-8")
    entries: dict[str, str] = {}

    imports: dict[str, Path | None] = {}
    for match in IMPORT_PATTERN.finditer(text):
        spec = match.group(2)
        if not spec.startswith(".") and not spec.startswith("@"):
            continue
        if spec.startswith("."):
            target: Path | None = path.parent / spec
        else:
            alias = spec.split("/src/", 1)[-1] if "/src/" in spec else spec[2:]
            target = REPO / "packages/ui/src" / alias
        for name in match.group(1).split(","):
            name = name.strip()
            if name:
                imports[name] = target

    for match in ENTRY_PATTERN.finditer(text):
        key = ast.literal_eval('"' + match.group(1) + '"')
        value, _ = parse_string_literal(text, match.end())
        # 后出现的同名 key 覆盖前面的：与对象字面量语义一致。
        entries[key] = value

    if depth < 3:
        for match in SPREAD_PATTERN.finditer(text):
            target = imports.get(match.group(1))
            if target is None:
                continue
            for candidate in (target, target.with_suffix(".ts"), target.with_suffix(".tsx")):
                if candidate.exists():
                    for key, value in load_entries(candidate, depth + 1).items():
                        entries.setdefault(key, value)
                    break

    return entries


def iter_sources():
    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*.ts*"):
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            if path.suffix not in {".ts", ".tsx", ".mts", ".cts"}:
                continue
            yield path


def placeholder_set(value: str) -> set[str]:
    return set(PLACEHOLDER_PATTERN.findall(value))


def main() -> int:
    entries = {loc: load_entries(path) for loc, path in LOCALES.items()}
    print(
        "语言文件键数："
        + "、".join(f"{loc}={len(v)}" for loc, v in entries.items())
        + "；英文回退键数："
        + "、".join(
            f"{loc}={len(entries['en-US']) - len(entries[loc])}" for loc in TRANSLATED_LOCALES
        )
    )

    problems = 0

    # 1) 中英两份语言文件必须键集一致（中文是完整基线）。
    zh, en = set(entries["zh-CN"]), set(entries["en-US"])
    missing_en = sorted(zh - en)
    missing_zh = sorted(en - zh)
    if missing_en or missing_zh:
        problems += 1
        print(f"\n✗ 语言间不一致：zh 有 en 无 {len(missing_en)} 个，en 有 zh 无 {len(missing_zh)} 个")
        for key in (missing_en[:20] + missing_zh[:20]):
            print(f"    {key}")

    # 2) ja/ko/ru 必须是 en-US 的子集，且三者键集一致（同一份上游交集）。
    target_key_sets = {loc: set(entries[loc]) for loc in TRANSLATED_LOCALES}
    reference_locale, reference_keys = TRANSLATED_LOCALES[0], target_key_sets[TRANSLATED_LOCALES[0]]
    for loc in TRANSLATED_LOCALES:
        extra = sorted(target_key_sets[loc] - en)
        if extra:
            problems += 1
            print(f"\n✗ {loc} 有 {len(extra)} 个 en-US 不存在的 key（会永远不生效）")
            for key in extra[:20]:
                print(f"    {key}")
        if target_key_sets[loc] != reference_keys:
            problems += 1
            only_here = sorted(target_key_sets[loc] - reference_keys)
            only_ref = sorted(reference_keys - target_key_sets[loc])
            print(
                f"\n✗ {loc} 与 {reference_locale} key 集不一致："
                f"{loc} 独有 {len(only_here)}，{reference_locale} 独有 {len(only_ref)}"
            )
            for key in (only_here[:10] + only_ref[:10]):
                print(f"    {key}")

    # 3) 显式翻译覆盖率：低于阈值说明需要重新生成上游交集或补齐翻译。
    if en:
        for loc in TRANSLATED_LOCALES:
            ratio = len(target_key_sets[loc]) / len(en)
            if ratio < MIN_TRANSLATED_RATIO:
                problems += 1
                print(
                    f"\n✗ {loc} 显式翻译覆盖率 {ratio:.1%} < {MIN_TRANSLATED_RATIO:.0%}"
                    f"（{len(target_key_sets[loc])}/{len(en)}），检查上游交集或重新生成语言表"
                )

    # 4) 占位符、ICU、原始 key 与上游品牌。
    for loc in TRANSLATED_LOCALES:
        placeholder_mismatch = []
        icu_values = []
        raw_ids = []
        brand_values = []
        for key, value in entries[loc].items():
            if key not in en:
                continue
            expected = placeholder_set(entries["en-US"][key])
            actual = placeholder_set(value)
            if expected != actual:
                placeholder_mismatch.append((key, sorted(expected), sorted(actual)))
            if ICU_PATTERN.search(value):
                icu_values.append(key)
            if value == key:
                raw_ids.append(key)
            if BRAND_PATTERN.search(value):
                brand_values.append(key)
        if placeholder_mismatch:
            problems += 1
            print(f"\n✗ {loc} 有 {len(placeholder_mismatch)} 个 key 占位符与英文不一致")
            for key, expected, actual in placeholder_mismatch[:20]:
                print(f"    {key}: en={expected} {loc}={actual}")
        if icu_values:
            problems += 1
            print(f"\n✗ {loc} 有 {len(icu_values)} 个 ICU/plural 文案（formatMessage 不支持）")
            for key in icu_values[:20]:
                print(f"    {key}")
        if raw_ids:
            problems += 1
            print(f"\n✗ {loc} 有 {len(raw_ids)} 个值是原始 key（会原样显示给用户）")
            for key in raw_ids[:20]:
                print(f"    {key}")
        if brand_values:
            problems += 1
            print(f"\n✗ {loc} 有 {len(brand_values)} 个值残留上游品牌（ZCode / zcode.z.ai 等）")
            for key in brand_values[:20]:
                print(f"    {key}")

    # 5) 源码引用的键必须在 en-US（合并基线的单一真相源）里存在。
    used: dict[str, list[str]] = {}
    for path in iter_sources():
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for match in KEY_PATTERN.finditer(text):
            key = match.group(1)
            # 只查带点号的 id（react-intl 的 message id 约定）；普通 DOM id 常无点
            if "." not in key:
                continue
            used.setdefault(key, []).append(str(path.relative_to(REPO)))

    missing = sorted(key for key in used if key not in en)
    print(f"\n源码引用 {len(used)} 个带点 id，缺失 {len(missing)} 个")
    if missing:
        problems += 1
        for key in missing[:40]:
            where = used[key][0]
            print(f"    ✗ {key}  ({where})")
        if len(missing) > 40:
            print(f"    ...其余 {len(missing) - 40} 个省略")

    if problems == 0:
        print("\n✓ 通过：语言间一致，ja/ko/ru 占位符/语法/品牌检查通过，源码引用的键全部有文案。")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""环境体检（四个文档插件共用一份）：把「这台机器上这个插件能干什么」一次说清楚。

    python tools/env_doctor.py                      # 核心层体检
    python tools/env_doctor.py --layer render       # 渲染层（再加 LibreOffice）
    python tools/env_doctor.py --install            # 自举安装插件 venv 依赖（走国内镜像）
    python tools/env_doctor.py --office-home "C:\\Program Files\\LibreOffice"

依赖清单从**插件自己的** `tools/requirements.txt` 读（包名 → import 名映射见下表），
所以同一份代码在四个插件里报的是各自的依赖，不会串台。

退出码：0 = 该层就绪；1 = 缺件（缺什么、怎么补都打印出来）。渲染层缺引擎**不算**核心层失败 ——
但层与层要在报告里分清，不能把「没验」写成「通过」。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from . import cli, engines, fonts
from . import env as env_mod

# PyPI 包名 → import 名（读 requirements 时用）。
IMPORT_NAMES = {
    "openpyxl": "openpyxl",
    "python-docx": "docx",
    "python-pptx": "pptx",
    "pillow": "PIL",
    "pypdfium2": "pypdfium2",
    "pypdf": "pypdf",
}
CORE_LAYER = ("openpyxl", "docx", "pptx")  # 任一在位即算核心依赖齐（各插件只装自己那份）


def required_packages(root: Path | None = None) -> list[str]:
    root = root or env_mod.plugin_root()
    for candidate in ("requirements.in", "requirements.txt"):
        if (root / "tools" / candidate).is_file():
            path = root / "tools" / candidate
            break
    else:
        path = root / "tools" / "requirements.in"
    packages: list[str] = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            text = line.split("#", 1)[0].strip()
            if not text:
                continue
            name = text.split(">=")[0].split("==")[0].split("[")[0].strip()
            if name:
                packages.append(name)
    return packages


def module_versions(env_python: Path | None, packages: list[str]) -> tuple[dict[str, str], str]:
    """查依赖版本：优先问**插件 env 的解释器**（工具实际用的是它），问不到再退回当前解释器。

    直接在当前解释器里 import 会把「venv 里装了、系统 python 没装」误报成缺件，
    这个假阴性会让人去装已经装好的东西。
    """
    imports = [(name, IMPORT_NAMES.get(name.lower(), name.replace("-", "_"))) for name in packages]
    probe = (
        "import json\n"
        f"pairs={imports!r}\n"
        "out={}\n"
        "for package, module in pairs:\n"
        "    try:\n"
        "        loaded=__import__(module)\n"
        "        out[package]=str(getattr(loaded,'__version__','installed'))\n"
        "    except Exception:\n"
        "        out[package]=''\n"
        "print(json.dumps(out))\n"
    )
    if env_python is not None and Path(env_python).is_file() and str(env_python) != sys.executable:
        try:
            completed = subprocess.run([str(env_python), "-c", probe], capture_output=True,  # noqa: S603
                                       text=True, encoding="utf-8", errors="replace", timeout=120,
                                       stdin=subprocess.DEVNULL, **env_mod.no_window_kwargs())
            if completed.returncode == 0 and completed.stdout.strip():
                return json.loads(completed.stdout.strip().splitlines()[-1]), str(env_python)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            pass
    versions: dict[str, str] = {}
    for package, module in imports:
        try:
            loaded = __import__(module)
            versions[package] = str(getattr(loaded, "__version__", "已装"))
        except ImportError:
            versions[package] = ""
    return versions, sys.executable


def collect() -> dict:
    root = env_mod.plugin_root()
    info = env_mod.resolve_env_dir(root=root)
    report = engines.engine_report()
    packages = required_packages(root)
    versions, probed_with = module_versions(info.python, packages)
    return {
        "pluginRoot": str(root),
        "pluginName": env_mod.plugin_name(root),
        "requirements": packages,
        "envDir": str(info.path), "envDirSource": info.source, "envIsReady": info.is_env,
        "envPython": str(info.python) if info.python else "",
        "python": {"executable": sys.executable, "version": sys.version.split()[0],
                   "probedWith": probed_with, "modules": versions},
        "pythonMirror": env_mod.mirror_url(root),
        "engine": report.to_dict(),
        "cjkFonts": fonts.available_families(),
    }


def ready(payload: dict, layer: str) -> tuple[bool, list[str]]:
    gaps: list[str] = []
    modules = payload["python"]["modules"]
    installed = [name for name in payload["requirements"] if modules.get(name)]
    if not installed:
        gaps.append("插件依赖一个都没装上（跑 --install，或 "
                    "python -m pip install -r tools/requirements.txt）")
    missing = [name for name in payload["requirements"]
               if not modules.get(name) and name != "pypdfium2"]
    for name in missing:
        gaps.append(f"缺 Python 依赖 {name}")
    if layer == "render":
        if not payload["engine"]["canConvert"]:
            gaps.append("缺渲染引擎 LibreOffice（装完后用 --office-home <安装目录> 登记；"
                        "没有它就没有真渲染与逐页出图，只能跑静态判据）")
        if not modules.get("pypdfium2") and not payload["engine"]["pdfRenderer"]:
            gaps.append("缺 PDF 读回能力（pypdfium2 或 PyMuPDF），引擎转出的 PDF 读不回来")
    return not gaps, gaps


LO_MIRROR = "https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/"


def engine_guide() -> list[str]:
    """按平台给"按需安装 LibreOffice"的具体指引。

    这是照上游的做法抄的**政策**（不是代码）：需要出图/转 PDF/公式重算时，引擎不可替代，
    必须装；给出国内镜像、平台子目录、以及"装在 PATH 外会被当成没装"这个坑。
    """
    if sys.platform == "win32":
        platform_hint = ["  Windows：挑最新版 win/x86_64 的 .msi 安装；winget install --id "
                         "TheDocumentFoundation.LibreOffice -e",
                         "  免管理员（装到用户目录、不写注册表、可整目录删除）："
                         "本脚本 --install-engine --yes"]
    elif sys.platform == "darwin":
        platform_hint = ["  macOS：下载 .dmg（Apple Silicon 用 mac/aarch64，Intel 用 mac/x86_64）",
                         "  兜底：brew install --cask libreoffice"]
    else:
        platform_hint = ["  Linux：解包 tar -xzf 后 dpkg -i */DEBS/*.deb（Debian/Ubuntu）或 rpm 安装",
                         "  兜底：sudo apt install libreoffice-core"]
    return [
        "渲染引擎（LibreOffice）按需安装，且在需要它的任务上**不可替代**：",
        "  出逐页图 / 转 PDF / 公式重算都需要它；用系统里其它办公软件顶替是不行的。",
        f"  国内镜像（快）：{LO_MIRROR}",
        *platform_hint,
        "  装在 PATH 外会被当成没装（下次又提示缺失）：装完确认能 `soffice --version`；",
        "  登记一次即可，四个文档插件共用：",
        "    python tools/env_doctor.py --office-home \"<LibreOffice 安装目录>\"",
    ]


def _mirror_versions() -> list[tuple[tuple[int, ...], str]]:
    import re  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415

    with urllib.request.urlopen(LO_MIRROR, timeout=60) as response:  # noqa: S310 - 固定 HTTPS 镜像
        html = response.read().decode("utf-8", errors="ignore")
    found: list[tuple[tuple[int, ...], str]] = []
    for match in re.finditer(r'href="(\d+(?:\.\d+)+)/"', html):
        version = match.group(1)
        found.append((tuple(int(part) for part in version.split(".")), version))
    return sorted(found, reverse=True)


def install_engine_windows(root: Path, assume_yes: bool) -> int:
    """Windows 免管理员装 LibreOffice：清华镜像 MSI + 行政安装到共用数据目录。

    这条路是实测验证过的（未装 Office/LibreOffice 的机器上跑通）；行政安装不写注册表、
    不需要管理员，装完整个目录删掉即可回退。**只做 Windows**：其它平台用系统包管理器更合适。
    """
    if sys.platform != "win32":
        print("--install-engine 目前只实现了 Windows；其它平台请按 --engine-guide 的指引安装。")
        return 2
    if not assume_yes:
        print("这会从国内镜像下载约 380MB 并解包到用户数据目录（不写注册表、不需管理员）。")
        print("确认请加 --yes 重跑；或改用 --engine-guide 手动安装。")
        return 2
    import urllib.request  # noqa: PLC0415

    try:
        versions = _mirror_versions()
    except Exception as error:  # noqa: BLE001 - 网络失败要如实报，不静默换源
        print(f"读取镜像目录失败：{error}")
        print("可改用 --engine-guide 手动安装。")
        return 1
    if not versions:
        print("镜像目录里没找到版本号，可改用 --engine-guide 手动安装。")
        return 1
    version = versions[0][1]
    url = f"{LO_MIRROR}{version}/win/x86_64/LibreOffice_{version}_Win_x86-64.msi"
    target_dir = env_mod.shared_data_dir() / "libreoffice"
    download_dir = env_mod.shared_data_dir() / "downloads"
    download_dir.mkdir(parents=True, exist_ok=True)
    msi = download_dir / f"LibreOffice_{version}.msi"
    print(f"下载 LibreOffice {version}：{url}")
    if not msi.is_file():
        with urllib.request.urlopen(url, timeout=1800) as response, msi.open("wb") as handle:  # noqa: S310
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
                total += len(chunk)
                if total % (32 * 1024 * 1024) < 1024 * 1024:
                    print(f"  已下载 {total / 1048576:.0f} MB …")
    print(f"行政安装（免管理员）到 {target_dir} …")
    completed = subprocess.run(  # noqa: S603 - 固定参数
        ["msiexec", "/a", str(msi), "/qn", f"TARGETDIR={target_dir}", "/norestart"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        stdin=subprocess.DEVNULL, **env_mod.no_window_kwargs(),
    )
    soffice = target_dir / "program" / "soffice.exe"
    if completed.returncode != 0 or not soffice.is_file():
        print(f"安装失败（msiexec 退出码 {completed.returncode}）；可改用 --engine-guide 手动安装。")
        return 1
    engines.record_engine(soffice, root)
    print(f"已安装并登记：{soffice}")
    print("复验：python tools/env_doctor.py --layer render")
    return 0


def main() -> int:
    cli.bootstrap()
    parser = argparse.ArgumentParser(description="插件环境体检")
    parser.add_argument("--layer", choices=["core", "render"], default="core")
    parser.add_argument("--install", action="store_true", help="自举安装插件 venv 依赖")
    parser.add_argument("--office-home", default="", help="登记 LibreOffice 安装目录")
    parser.add_argument("--engine-guide", action="store_true", help="打印按平台安装渲染引擎的指引")
    parser.add_argument("--install-engine", action="store_true",
                        help="（Windows）免管理员装 LibreOffice 到用户数据目录")
    parser.add_argument("--yes", action="store_true", help="配合 --install-engine：确认下载与安装")
    cli.add_common(parser)
    args = parser.parse_args()

    if args.engine_guide:
        for line in engine_guide():
            print(line)
        return 0
    if args.install_engine:
        return install_engine_windows(env_mod.plugin_root(), args.yes)

    if args.install:
        result = env_mod.ensure_env(env_mod.plugin_root(), force=True)
        print(f"{'已就绪' if result.ok else '失败'}：{result.message}\n  env：{result.env_dir}")
        if result.python:
            print(f"  解释器：{result.python}")
    if args.office_home:
        try:
            target = engines.record_engine(Path(args.office_home) / "program" / "soffice.exe")
        except SystemExit as error:
            print(f"登记失败：{error}")
        else:
            print(f"已登记渲染引擎 → {target}")

    payload = collect()
    ok, gaps = ready(payload, args.layer)
    engine = payload["engine"]
    rendered = "、".join(f"{name}={payload['python']['modules'].get(name) or '缺'}"
                        for name in payload["requirements"])
    lines = [f"插件环境体检（{args.layer} 层）：{'就绪' if ok else '缺件'}",
             f"  插件：{payload['pluginName']} @ {payload['pluginRoot']}",
             f"  环境目录：{payload['envDir']}（来源：{payload['envDirSource']}，"
             f"{'是 venv' if payload['envIsReady'] else '还不是 venv'}）",
             f"  Python：{payload['python']['version']} @ {payload['python']['executable']}",
             f"  依赖：{rendered}",
             f"  渲染引擎：{engine['soffice'] or '未找到'} {engine['sofficeVersion']}",
             f"  PDF 渲染库：{engine['pdfRenderer'] or '缺'}",
             f"  中文字体：{'、'.join(payload['cjkFonts']) or '未识别到（自渲染会退化到内置字形）'}",
             f"  Python 镜像：{payload['pythonMirror']}"]
    for gap in gaps:
        lines.append(f"  ✗ {gap}")
    lines.append(f"  结论：{'核心与渲染链路齐备' if ok else '有缺件，见上'}")
    cli.emit({"summary": "\n".join(lines), **payload, "ready": ok, "gaps": gaps}, args)
    return 0 if ok else 1

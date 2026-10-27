"""插件自管 Python 环境（venv）的**唯一**解析与自举处。

## 解析顺序（与数模插件同源，改动要同步理由）

1. 显式传入的 `override` / 环境变量 `NIBI_<插件名>_ENV_DIR`（宿主给插件进程注入的就是这个）；
2. `NIBI_PLUGIN_DATA/env`（宿主给**钩子**进程只注入这个）；
3. 从**插件根**推：同级 `<...>/plugins/data/<插件名>@<市场>[/env]`（dev 实例布局，插件根与数据同树）；
4. 平台默认数据目录：`%LOCALAPPDATA%/NIBI/<插件名>`（Windows）/ `~/.local/share/NIBI/<插件名>`。

**优先选第一个「看起来真的是个 env」的候选**（有 venv），而不是第一个存在的路径 ——
否则一个空目录会把后面的候选挤掉。都不像 env 也照实返回并标 `is_env=False`，
让调用方能如实报错，而不是拿一条不存在的路径往下走、最后在别处以假象炸掉。

## 自举

`require_modules()` 是 CLI 工具的标准入口：当前解释器缺依赖时，先 `ensure_env()`
（建 venv + 按 requirements 从镜像装），再用 env 解释器**重跑自己**（`reexec`）。
学生机器上第一次调用某个工具会多花一次安装时间，之后就都是现成的。
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

VENV_MARKERS = (Path("venv") / "Scripts" / "python.exe", Path("venv") / "bin" / "python")
DEFAULT_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"


def no_window_kwargs() -> dict:
    """子进程静默参数：Windows 下不弹控制台窗口、不等待输入（装依赖/建 venv 都不许弹黑框）。"""
    if sys.platform != "win32":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {"creationflags": 0x08000000, "startupinfo": startupinfo}


def plugin_root() -> Path:
    """插件根：本文件在 `<插件根>/tools/nibi_kit/env.py`，往上三级。"""
    return Path(__file__).resolve().parents[2]


def plugin_name(root: Path | None = None) -> str:
    """插件名：优先读清单（唯一权威），读不到退回目录名。"""
    root = root or plugin_root()
    for relative in (Path(".nibi-plugin") / "plugin.json", Path(".zcode-plugin") / "plugin.json", Path(".claude-plugin") / "plugin.json"):
        try:
            data = json.loads((root / relative).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        name = str(data.get("name") or "").strip()
        if name:
            return name
    return root.name


def env_var_name(name: str) -> str:
    return f"NIBI_{name.upper().replace('-', '_')}_ENV_DIR"


def looks_like_env(path: Path) -> bool:
    return any((path / marker).is_file() for marker in VENV_MARKERS)


def _derive_from_plugin_root(root: Path, name: str) -> Path | None:
    """在插件根所在的那棵树里找 `data/<插件名>[@<市场>]`（dev 布局）。"""
    for level in [root, *list(root.parents)[:6]]:
        data_dir = level / "data"
        if not data_dir.is_dir():
            continue
        for candidate in sorted(data_dir.iterdir()):
            if not candidate.is_dir() or candidate.name.split("@")[0] != name:
                continue
            inner = candidate / "env"
            return inner if inner.is_dir() else candidate
    return None


def shared_data_dir() -> Path:
    """四个文档插件**共用**的数据目录（平台数据根下的 NIBI/）。

    用途：引擎登记这类"一台机器一次"的配置。放进各插件自己的数据目录会导致
    同类插件要各登记一次（用户装四个插件就得点四遍），而这些配置本来与插件无关。
    """
    return _base_data_root() / "NIBI"


def _base_data_root() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


def _default_data_dir(name: str) -> Path:
    return _base_data_root() / "NIBI" / name


def shared_env_dir() -> Path:
    """四个文档插件**共用**的运行环境目录。

    理由：四个插件的依赖高度重叠（pillow / pypdfium2 / 各一个 Office 库），
    各建一份 venv 要装四遍、占四份盘（每份 30–60MB）。共用一份既省盘又少装三次。
    想给某个插件单独隔离时，用 `NIBI_<插件名>_ENV_DIR` 指到别处即可。
    """
    return shared_data_dir() / "env"


@dataclass
class EnvInfo:
    path: Path
    is_env: bool
    source: str

    @property
    def python(self) -> Path | None:
        for marker in VENV_MARKERS:
            candidate = self.path / marker
            if candidate.is_file():
                return candidate
        return None


def resolve_env_dir(override: str | Path | None = None, root: Path | None = None) -> EnvInfo:
    root = root or plugin_root()
    name = plugin_name(root)
    candidates: list[tuple[Path, str]] = []
    if override:
        candidates.append((Path(override), "显式参数"))
    var = env_var_name(name)
    if os.environ.get(var):
        candidates.append((Path(os.environ[var]), f"环境变量 {var}"))
    if os.environ.get("NIBI_PLUGIN_DATA"):
        candidates.append((Path(os.environ["NIBI_PLUGIN_DATA"]) / "env", "NIBI_PLUGIN_DATA"))
    derived = _derive_from_plugin_root(root, name)
    if derived is not None:
        candidates.append((derived, "插件根同树 data/"))
    # 共用环境排在"插件私有回退路径"之前：已有私有 venv 的老用户照旧命中私有（不受影响），
    # 新装则一律落到共用目录 —— 四个插件只装一份、只占一份盘。
    candidates.append((shared_env_dir(), "文档插件共用环境"))
    candidates.append((_default_data_dir(name), "平台默认数据目录"))

    for path, source in candidates:
        if looks_like_env(path):
            return EnvInfo(path, True, source)
    # 没有一个像 env：返回**第一个**候选作为「将来该建在哪」——它是最显式的那个
    # （显式参数 > 环境变量 > NIBI_PLUGIN_DATA > 同树 data/ > 平台默认）。
    # 返回最后一个（平台默认）会让显式指定的路径被静默忽略，安装装到别处去。
    first_path, first_source = candidates[0]
    return EnvInfo(first_path, False, first_source)


def env_python(info: EnvInfo) -> Path | None:
    return info.python


def _requirements_path(root: Path, *, shared: bool = False) -> Path | None:
    """装依赖用哪份清单。

    装进**共用环境**时优先用并集锁（`requirements-shared.lock`）—— 那份环境四个插件共用，
    只按某一个插件的锁装，别的插件就会缺自己的库（实测：先装 pdf 后，spreadsheets 报缺 openpyxl）。
    装进私有环境时用插件自己的锁。两份都没有就退回 .in/.txt 的浮动约束。
    """
    order = ("requirements-shared.lock", "requirements.lock") if shared else ("requirements.lock",)
    for relative in (*order, "requirements.in", "requirements.txt"):
        candidate = root / "tools" / relative
        if candidate.is_file():
            return candidate
    return None


MIRRORS = (DEFAULT_MIRROR, "https://mirrors.aliyun.com/pypi/simple",
           "https://pypi.org/simple")


def mirror_url(root: Path | None = None) -> str:
    root = root or plugin_root()
    name = plugin_name(root)
    for var in (f"NIBI_{name.upper().replace('-', '_')}_PYTHON_MIRROR", "NIBI_DOCS_PYTHON_MIRROR"):
        value = (os.environ.get(var) or "").strip()
        if value:
            return value
    return DEFAULT_MIRROR


def mirror_candidates(root: Path | None = None) -> list[str]:
    """按顺序尝试的源：显式配置的 → 清华 → 阿里 → 官方。

    只用单一镜像有个实测风险：某个镜像当天抽风/被企业代理拦，用户就会看到"装不上"而放弃。
    多源顺序重试把这种情况变成多花几十秒。
    """
    chosen = mirror_url(root)
    ordered = [chosen, *[item for item in MIRRORS if item != chosen]]
    return ordered


@dataclass
class EnsureResult:
    ok: bool
    env_dir: Path
    python: Path | None
    created: bool
    message: str


def _requirements_fingerprint(requirements: Path | None) -> str | None:
    if requirements is None or not requirements.is_file():
        return None
    return hashlib.sha256(requirements.read_bytes()).hexdigest()


def _python_imports(python: Path, modules: list[str]) -> bool:
    """这个解释器能不能导入这些模块（一次性问完，省得逐个起进程）。"""
    if not modules:
        return True
    probe = "import importlib,sys\n" + "\n".join(
        f"importlib.import_module({module!r})" for module in modules
    )
    completed = subprocess.run(  # noqa: S603 - 固定参数，只传模块名
        [str(python), "-c", probe],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        stdin=subprocess.DEVNULL, **no_window_kwargs(),
    )
    return completed.returncode == 0


def _env_matches_requirements(env_dir: Path, requirements: Path | None) -> bool:
    """环境是否**装过这份锁**：比对 env-ready.json 里记的锁指纹。

    只看"目录在不在"是不够的 —— 依赖是我们自己往 requirements.lock 里加的（例如 pdf 的
    海报路线后加的 reportlab）：老环境一律被判"已存在"，新加的包永远装不进去，用户看到的
    只是 `ModuleNotFoundError: No module named 'reportlab'`。指纹不一致就重装一次
    （pip 对已满足的锁是空跑，秒级）。
    """
    expected = _requirements_fingerprint(requirements)
    if expected is None:
        return True
    marker = env_dir / "env-ready.json"
    try:
        recorded = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # 没有（或坏了）标记 = 这份锁没被确认装过；回落到"重装一次"。
        return False
    return isinstance(recorded, dict) and recorded.get("sha256") == expected


def ensure_env(
    root: Path | None = None,
    force: bool = False,
    probe_modules: list[str] | None = None,
) -> EnsureResult:
    """必要时创建 venv 并安装插件依赖（幂等，可重复调用）。

    `probe_modules` 是调用方这次真正要用的模块名（import 名），只在**装不上**时兜底：
    锁文件对不上、镜子全试失败时，只要环境解释器已经能导入这些模块就仍然放行（离线可用），
    但要如实说明"未确认锁"。
    """
    root = root or plugin_root()
    info = resolve_env_dir(root=root)
    if info.is_env and info.python and not force:
        requirements = _requirements_path(root, shared=(info.path == shared_env_dir()))
        if requirements is None:
            return EnsureResult(True, info.path, info.python, False, "环境已存在（无 requirements 文件）")
        if _env_matches_requirements(info.path, requirements):
            return EnsureResult(True, info.path, info.python, False, "环境已存在")
        # 锁变了（新增依赖/版本变化）或没有可信标记 → 往下装一次：pip 对已满足的锁是空跑。

    env_dir = info.path
    venv_dir = env_dir / "venv"
    env_python_path = venv_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if not env_python_path.is_file():
        env_dir.mkdir(parents=True, exist_ok=True)
        created = subprocess.run(  # noqa: S603 - 固定参数，仅传路径
            [sys.executable, "-m", "venv", str(venv_dir)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            stdin=subprocess.DEVNULL, **no_window_kwargs(),
        )
        if created.returncode != 0:
            return EnsureResult(False, env_dir, None, False,
                                f"创建 venv 失败：{created.stderr.strip()[-400:]}")

    requirements = _requirements_path(root, shared=(env_dir == shared_env_dir()))
    if requirements is None:
        return EnsureResult(True, env_dir, env_python_path, True, "venv 就绪（无 requirements 文件）")

    log_lines: list[str] = []
    last_error = ""
    for index, mirror in enumerate(mirror_candidates(root)):
        pip = subprocess.run(  # noqa: S603 - 固定参数
            [str(env_python_path), "-m", "pip", "install", "--disable-pip-version-check",
             "--no-input", "-q", "-r", str(requirements), "-i", mirror],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            stdin=subprocess.DEVNULL, **no_window_kwargs(),
        )
        ok = pip.returncode == 0
        log_lines.append(f"[{index + 1}] {mirror} → {'成功' if ok else '失败'}")
        if ok:
            marker = env_dir / "env-ready.json"
            marker.write_text(json.dumps({
                "requirements": str(requirements),
                "sha256": _requirements_fingerprint(requirements),
                "mirror": mirror,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            (env_dir / "bootstrap.log").write_text("\n".join(log_lines) + "\n",
                                                   encoding="utf-8")
            note = "已安装插件依赖" if index == 0 else f"已安装插件依赖（换了源：{mirror}）"
            return EnsureResult(True, env_dir, env_python_path, True, note)
        last_error = (pip.stderr or pip.stdout).strip()[-400:]
    (env_dir / "bootstrap.log").write_text(
        "\n".join(log_lines) + "\n最后错误：" + last_error + "\n", encoding="utf-8")
    # 兜底：装不上不等于跑不了。环境解释器已经能导入本次要用的模块时放行（离线/镜像全挂
    # 的场景），否则用户会在"其实能跑"的情况下被拦下。消息里如实说明锁没被确认。
    if info.is_env and info.python and probe_modules and _python_imports(info.python, probe_modules):
        return EnsureResult(True, env_dir, info.python, False,
                            "依赖装不上（镜子都试过），但本次要用的模块已在环境里，按可用放行")
    return EnsureResult(False, env_dir, env_python_path, True,
                        f"pip 安装失败（已依次试过 {len(mirror_candidates(root))} 个源）：{last_error}")


def reexec_with_env_python(module_hint: str = "", probe_modules: list[str] | None = None) -> None:
    """用插件 env 的解释器重跑当前脚本（依赖装在那边），并把子进程输出转发到本进程。

    转发不是可选项：见下方注释 —— 不捕获的话，子进程输出在 Windows 上会消失。
    """
    root = plugin_root()
    result = ensure_env(root, probe_modules=probe_modules)
    if not result.ok or result.python is None:
        script = Path(sys.argv[0]).name
        print(f"缺少依赖：{module_hint or script} 不在当前解释器里，且自动安装未成功。\n"
              f"  {result.message}\n"
              f"  手动安装：python -m pip install -r {root / 'tools' / 'requirements.txt'}",
              file=sys.stderr)
        raise SystemExit(2)
    if str(result.python) != sys.executable:
        # **必须**用管道捕获再把输出转发出来：Windows 上子进程带 CREATE_NO_WINDOW 时会拿到
        # 新控制台，而父进程的 stdout 句柄可能不可继承 —— 于是子进程的输出直接丢进隐藏控制台，
        # 调用方看到的是"什么都没打印"（实测：有时有、有时没有，取决于句柄是否可继承）。
        # 捕获走的是父进程自己建的（必然可继承）管道，稳定可靠。
        completed = subprocess.run(  # noqa: S603 - 重跑自身
            [str(result.python), str(Path(sys.argv[0]).resolve()), *sys.argv[1:]],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            **no_window_kwargs(),
        )
        if completed.stdout:
            sys.stdout.write(completed.stdout)
            sys.stdout.flush()
        if completed.stderr:
            sys.stderr.write(completed.stderr)
            sys.stderr.flush()
        raise SystemExit(completed.returncode)


def require_modules(modules: list[str], hint: str = "") -> None:
    """CLI 的标准开头：缺依赖就自举并换解释器重跑。

    **列表要写全这个脚本（含它起的子进程）需要的模块**：只写一部分时，本机解释器只要
    凑巧有那部分就不会换解释器，子进程随后才炸（实测 pdf 冒烟：护栏只写了 pypdf+PIL，
    于是海报路线在缺 reportlab 的解释器下跑，报 `No module named 'reportlab'`）。
    """
    missing = []
    for module in modules:
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        reexec_with_env_python(hint or "、".join(missing), probe_modules=list(modules))

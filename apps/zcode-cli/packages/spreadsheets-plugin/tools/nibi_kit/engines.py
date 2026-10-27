"""真渲染引擎：LibreOffice（转 PDF / 强制重算 / 逐页渲染 / 文本抽取）。

## 为什么需要真引擎

「交付件要逐页渲染出来亲眼看过」这条验收标准，靠自研渲染器只能验**文件里的几何**，
验不到真引擎的排版（换行点、字体替换、列宽像素化、分页位置）。所以只要机器上有引擎，
判据就必须走引擎；自渲染只作为**引擎缺席时的降级**，且降级必须如实标注。

## 探测与登记

`find_soffice()` 的探测顺序：环境变量 `NIBI_SOFFICE` → 插件数据目录里登记的路径
（`env_doctor --office-home <路径>` 写入，避免把开发机路径烘进插件）→ PATH →
各平台常见安装位置。探测不到就如实返回 None，由调用方决定降级或报错。

## 隔离

每次转换都用独立的 `-env:UserInstallation=file:///<临时目录>` 配置档：既避免
「用户正开着 LibreOffice 时 headless 抢锁失败」这个经典故障，也不污染用户的个人配置。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import env as env_mod

# Windows 上从 agent 的 shell 里起 soffice.exe，它会**自己新开一个控制台窗口**（黑框）并把
# --version 的输出与 "Press Enter to continue" 留在那里 —— 既打扰用户，也让版本号读不到。
# 统一用「不分配控制台 + 隐藏窗口 + 关掉 stdin」，任何子进程都不许弹窗、不许等待输入。
CREATE_NO_WINDOW = 0x08000000


def quiet_kwargs() -> dict:
    """子进程的静默参数：Windows 下不弹控制台，stdin 一律 DEVNULL。"""
    kwargs: dict = {"stdin": subprocess.DEVNULL}
    if sys.platform == "win32":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        kwargs["creationflags"] = CREATE_NO_WINDOW
        kwargs["startupinfo"] = startupinfo
    return kwargs


PDF_FILTERS = {
    ".xlsx": "calc_pdf_Export", ".xlsm": "calc_pdf_Export", ".ods": "calc_pdf_Export",
    ".csv": "calc_pdf_Export",
    ".docx": "writer_pdf_Export", ".doc": "writer_pdf_Export", ".odt": "writer_pdf_Export",
    ".rtf": "writer_pdf_Export", ".html": "writer_pdf_Export", ".htm": "writer_pdf_Export",
    ".txt": "writer_pdf_Export",
    ".pptx": "impress_pdf_Export", ".ppt": "impress_pdf_Export", ".odp": "impress_pdf_Export",
}

_WINDOWS_CANDIDATES = (
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    r"%LOCALAPPDATA%\Programs\LibreOffice\program\soffice.exe",
)
_MAC_CANDIDATES = ("/Applications/LibreOffice.app/Contents/MacOS/soffice",)
_LINUX_CANDIDATES = ("/usr/bin/soffice", "/usr/local/bin/soffice",
                     "/usr/lib/libreoffice/program/soffice", "/snap/bin/libreoffice",
                     "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice")


def _registry_path(root: Path | None = None) -> Path:
    return env_mod.resolve_env_dir(root=root).path / "office-engine.json"


def _shared_registry_path() -> Path:
    """四个文档插件共用的引擎登记（一台机器登记一次就够）。"""
    return env_mod.shared_data_dir() / "office-engine.json"


def record_engine(path: str | Path, root: Path | None = None) -> Path:
    """登记引擎路径：写**共用**登记（四个文档插件都认）并同时写插件自己的那份。

    只写插件自己那份的话，同一台机器上装了 documents 又装 spreadsheets 就要登记两次 ——
    引擎跟插件没关系，不该按插件重复登记。
    """
    resolved = Path(path).expanduser()
    if not resolved.is_file():
        raise SystemExit(f"不是文件：{resolved}")
    payload = json.dumps({"soffice": str(resolved)}, ensure_ascii=False, indent=2)
    shared = _shared_registry_path()
    shared.parent.mkdir(parents=True, exist_ok=True)
    shared.write_text(payload, encoding="utf-8")
    target = _registry_path(root)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(payload, encoding="utf-8")
    return shared


def find_soffice(root: Path | None = None) -> Path | None:
    explicit = (os.environ.get("NIBI_SOFFICE") or "").strip()
    if explicit and Path(explicit).is_file():
        return Path(explicit)
    for registry in (_registry_path(root), _shared_registry_path()):
        try:
            recorded = json.loads(registry.read_text(encoding="utf-8")).get("soffice", "")
        except (OSError, json.JSONDecodeError, ValueError):
            continue
        if recorded and Path(recorded).is_file():
            return Path(recorded)
    on_path = shutil.which("soffice") or shutil.which("libreoffice")
    if on_path:
        return Path(on_path)
    home = os.environ.get("NIBI_OFFICE_HOME", "").strip()
    candidates = list(_WINDOWS_CANDIDATES + _MAC_CANDIDATES + _LINUX_CANDIDATES)
    if home:
        candidates.insert(0, str(Path(home) / "program" / "soffice.exe"))
        candidates.insert(0, str(Path(home) / "soffice"))
    for raw in candidates:
        candidate = Path(os.path.expandvars(raw))
        if candidate.is_file():
            return candidate
    return None


@dataclass
class EngineReport:
    soffice: str | None
    soffice_version: str
    pdf_renderer: str
    pillow: bool

    @property
    def can_convert(self) -> bool:
        return bool(self.soffice)

    @property
    def can_render_pages(self) -> bool:
        return self.pdf_renderer != "" and self.pillow

    def to_dict(self) -> dict:
        return {"soffice": self.soffice, "sofficeVersion": self.soffice_version,
                "pdfRenderer": self.pdf_renderer, "pillow": self.pillow,
                "canConvert": self.can_convert, "canRenderPages": self.can_render_pages}


def soffice_version(soffice: Path | None) -> str:
    """读版本号。

    Windows 上必须用 **soffice.com**（控制台版），不能用 soffice.exe —— 后者跑 `--version`
    会弹出一个控制台窗口停在那里等回车（实测挂死 120 秒，还会打扰用户，用户截图投诉过）。
    """
    if soffice is None:
        return ""
    candidates = [soffice]
    console_variant = soffice.with_name("soffice.com")
    if console_variant.is_file():
        candidates.insert(0, console_variant)
    for candidate in candidates:
        try:
            completed = subprocess.run([str(candidate), "--version"], capture_output=True,  # noqa: S603
                                       text=True, encoding="utf-8", errors="replace", timeout=45,
                                       **quiet_kwargs())
        except (OSError, subprocess.SubprocessError):
            continue
        text = (completed.stdout or completed.stderr).strip()
        if text:
            return text.splitlines()[0]
    return ""


def _pdf_renderer() -> str:
    try:
        import pypdfium2  # noqa: F401

        return "pypdfium2"
    except ImportError:
        pass
    try:
        import pymupdf  # noqa: F401

        return "pymupdf"
    except ImportError:
        return ""


def engine_report(root: Path | None = None) -> EngineReport:
    soffice = find_soffice(root)
    pillow = True
    try:
        import PIL  # noqa: F401
    except ImportError:
        pillow = False
    return EngineReport(str(soffice) if soffice else None, soffice_version(soffice),
                        _pdf_renderer(), pillow)


class ConvertError(RuntimeError):
    pass


def _soffice_run(args: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8",  # noqa: S603
                          errors="replace", timeout=timeout, **quiet_kwargs())


def _convert(src: Path, outdir: Path, target: str, soffice: Path | None = None,
             timeout: int = 300) -> Path:
    """通用转换：`target` 形如 `pdf` 或 `pdf:calc_pdf_Export`。返回产出文件路径。"""
    engine = soffice or find_soffice()
    if engine is None:
        raise ConvertError("没有找到 LibreOffice（soffice）。"
                           "安装后可用 env_doctor --office-home <安装目录> 登记，或设 NIBI_SOFFICE。")
    if not src.is_file():
        raise ConvertError(f"找不到源文件：{src}")
    outdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="nibi-lo-profile-") as profile:
        profile_uri = Path(profile).as_uri()
        completed = _soffice_run([
            str(engine),
            f"-env:UserInstallation={profile_uri}",
            "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
            "--convert-to", target, "--outdir", str(outdir), str(src),
        ], timeout=timeout)
    suffix = target.split(":", 1)[0]
    produced = outdir / f"{src.stem}.{suffix}"
    if not produced.is_file():
        detail = ((completed.stdout or "") + (completed.stderr or "")).strip()[-500:]
        raise ConvertError(f"转换失败（{src.name} → {target}）：{detail or '产出文件不存在'}")
    return produced


def convert_to_pdf(src: Path, outdir: Path, soffice: Path | None = None,
                   timeout: int = 300, options: dict | None = None) -> Path:
    """任何可转换的文档 → PDF（按扩展名选导出过滤器）。

    `options` 会作为过滤器参数传给 LibreOffice（JSON），例如 PDF/A：
    `{"SelectPdfVersion": {"type": "long", "value": "1"}}`。
    """
    suffix = src.suffix.lower()
    filter_name = PDF_FILTERS.get(suffix)
    if filter_name is None:
        raise ConvertError(f"不支持转换的扩展名：{suffix}（支持 {'、'.join(sorted(PDF_FILTERS))}）")
    target = f"pdf:{filter_name}"
    if options:
        target = f"{target}:{json.dumps(options, ensure_ascii=False)}"
    return _convert(src, outdir, target, soffice, timeout)


def recalc_xlsx(src: Path, outdir: Path, soffice: Path | None = None) -> Path:
    """xlsx → xlsx（经 LibreOffice 载入并求值），产出带缓存值的副本。

    用途：公式错误值（#REF!/#DIV/0!…）与计算结果只有**算过**才知道。openpyxl 写的公式
    没有缓存值，LibreOffice 载入时必须求值，导出的副本于是带上计算结果。
    """
    with tempfile.TemporaryDirectory(prefix="nibi-recalc-") as window:
        work = Path(window) / src.name
        shutil.copy2(src, work)
        return _convert(work, outdir, "xlsx", soffice)


def pdf_page_count(pdf: Path) -> int:
    renderer = _pdf_renderer()
    if renderer == "pypdfium2":
        import pypdfium2 as pdfium  # noqa: PLC0415

        document = pdfium.PdfDocument(str(pdf))
        try:
            return len(document)
        finally:
            document.close()
    if renderer == "pymupdf":
        import pymupdf  # noqa: PLC0415

        with pymupdf.open(str(pdf)) as document:
            return document.page_count
    raise ConvertError("没有 PDF 渲染库（装 pypdfium2）")


def pdf_to_png(pdf: Path, outdir: Path, dpi: int = 110, pages: list[int] | None = None) -> list[Path]:
    """PDF 逐页渲染成 PNG（页码 1 基；`pages=None` 表示全部）。"""
    outdir.mkdir(parents=True, exist_ok=True)
    renderer = _pdf_renderer()
    written: list[Path] = []
    if renderer == "pypdfium2":
        import pypdfium2 as pdfium  # noqa: PLC0415

        document = pdfium.PdfDocument(str(pdf))
        try:
            wanted = [index - 1 for index in pages] if pages else range(len(document))
            for index in wanted:
                image = document[index].render(scale=dpi / 72).to_pil()
                target = outdir / f"page-{index + 1:04d}.png"
                image.save(target)
                written.append(target)
        finally:
            document.close()
        return written
    if renderer == "pymupdf":
        import pymupdf  # noqa: PLC0415

        with pymupdf.open(str(pdf)) as document:
            wanted = [index - 1 for index in pages] if pages else range(document.page_count)
            for index in wanted:
                pixmap = document[index].get_pixmap(dpi=dpi)
                target = outdir / f"page-{index + 1:04d}.png"
                pixmap.save(str(target))
                written.append(target)
        return written
    raise ConvertError("没有 PDF 渲染库（装 pypdfium2）")


def pdf_text_per_page(pdf: Path) -> list[str]:
    """按页抽取 PDF 文本（判据用：错误值、`###` 截断、缺字形方框都在这里现形）。"""
    renderer = _pdf_renderer()
    if renderer == "pypdfium2":
        import pypdfium2 as pdfium  # noqa: PLC0415

        document = pdfium.PdfDocument(str(pdf))
        try:
            pages = []
            for index in range(len(document)):
                textpage = document[index].get_textpage()
                pages.append(textpage.get_text_range())
            return pages
        finally:
            document.close()
    if renderer == "pymupdf":
        import pymupdf  # noqa: PLC0415

        with pymupdf.open(str(pdf)) as document:
            return [page.get_text() for page in document]
    raise ConvertError("没有 PDF 文本抽取库（装 pypdfium2）")

"""交付卫生：交付件里不许带本机路径、用户名、内网地址。

## 判据的由来（都是实测踩出来的）

* 插件 zip 里烘过「用户目录下的绝对路径」（盘符 + 用户目录 + 用户名），一路发到了市场上 —— 交付件同理；
* XML 里的 JSON 转义（反斜杠成对出现）曾让扫描器静默漏报 —— 所以扫描要**先反转义再匹配**；
* 交付包里的作者名、`docProps/core.xml` 的 `lastModifiedBy`、`Company` 是三处最容易被忽略的载体。

设计：`patterns()` 给判据用；`scrub_core_properties()` 在生成侧做无痕；`scan_*` 在验收侧扫成品。
两侧都做 —— 生成侧防新缺陷，验收侧防漏网。
"""

from __future__ import annotations

import os
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

# 需要脱敏/扫描的文本载体（office 文件本质是 zip + XML）。
# 注意：这里必须是**后缀**而不是 glob —— 曾经写成 ("*.xml", ...) 配 str.endswith()，
# 于是 `endswith("*.xml")` 永远为假，整条卫生判据静默空转（反向对照冒烟抓到的）。
XML_SUFFIXES = (".xml", ".rels", ".vml")

PATH_PATTERNS: tuple[tuple[str, str], ...] = (
    ("win-drive-path", r"[A-Za-z]:\\(?:Users|用户|Program|Windows|ProgramData|Documents and Settings)"),
    ("win-drive-any", r"[A-Za-z]:\\[A-Za-z0-9_\-\\ .]{6,}"),
    ("win-user-dir", r"\bAppData\\(?:Local|Roaming|LocalLow)\b"),
    ("user-home-posix", r"/(?:Users|home)/[A-Za-z0-9._\-]{2,}/"),
    ("posix-usr-path", r"/(?:opt|srv|var|usr/local)/[A-Za-z0-9._\-/]{4,}"),
    ("windows-fonts", r"\bC:\\Windows\\Fonts\b"),
    ("program-files", r"Program Files(?:\s*\(x86\))?\\"),
    ("temp-path", r"\\(?:tmp|Temp)\\[A-Za-z0-9._\-]{4,}"),
    ("unc-path", r"\\\\[A-Za-z0-9._\-]{2,}\\"),
    ("file-uri", r"file:///[A-Za-z]:/"),
)

CREDENTIAL_PATTERNS: tuple[tuple[str, str], ...] = (
    ("aws-key", r"\bAKIA[0-9A-Z]{16}\b"),
    ("openai-key", r"\bsk-[A-Za-z0-9]{20,}\b"),
    ("github-token", r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    ("private-key", r"-----BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY-----"),
    ("bearer", r"\bBearer\s+[A-Za-z0-9._\-]{20,}\b"),
)

_USER_KEYS = ("USERNAME", "USER", "LOGNAME")


@dataclass
class Finding:
    code: str
    message: str
    location: str
    severity: str = "fail"


def local_identities() -> set[str]:
    """本机可识别的身份名（用户名、机器名）——用来判「是否漏了本机痕迹」。"""
    names: set[str] = set()
    for key in _USER_KEYS + ("COMPUTERNAME", "HOSTNAME"):
        value = (os.environ.get(key) or "").strip()
        if len(value) >= 3:
            names.add(value)
    return names


def _unescape(text: str) -> str:
    """剥掉 XML/JSON 转义：反斜杠成对出现时会绕过路径匹配（实测踩过）。"""
    return (text.replace("\\\\", "\\").replace("\\\"", "\"")
            .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", "\"").replace("&#39;", "'"))


def scan_text(text: str, location: str = "", *, identities: set[str] | None = None) -> list[Finding]:
    findings: list[Finding] = []
    haystack = _unescape(text)
    for code, pattern in PATH_PATTERNS:
        for match in re.finditer(pattern, haystack, re.IGNORECASE):
            findings.append(Finding(code, f"疑似本机路径：{match.group(0)[:80]}", location))
            break
    for code, pattern in CREDENTIAL_PATTERNS:
        match = re.search(pattern, haystack)
        if match:
            findings.append(Finding(code, f"疑似凭据：{match.group(0)[:24]}…", location))
    for name in identities or local_identities():
        if re.search(rf"(?<![A-Za-z0-9._\-]){re.escape(name)}(?![A-Za-z0-9._\-])", haystack):
            findings.append(Finding("local-identity", f"出现本机用户名/机器名：{name}", location))
            break
    return findings


def text_parts(path: Path) -> list[tuple[str, str]]:
    """列出 OOXML 文件里所有可读的文本部件（(部件名, 内容)）；非 zip 返回空。"""
    parts: list[tuple[str, str]] = []
    if not path.is_file():
        return parts
    try:
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                if not name.lower().endswith(XML_SUFFIXES):
                    continue
                try:
                    raw = archive.read(name)
                except (KeyError, zipfile.BadZipFile):
                    continue
                parts.append((name, raw.decode("utf-8", errors="ignore")))
    except zipfile.BadZipFile:
        return []
    return parts


def scan_office_file_text(text: str, location: str,
                         *, identities: set[str] | None = None) -> list[Finding]:
    """扫一段部件文本（调用方自己按 `text_parts` 遍历，便于统计"扫了多少个部件"）。"""
    return scan_text(text, location, identities=identities)


def scan_office_file(path: Path, *, identities: set[str] | None = None) -> list[Finding]:
    """扫描 OOXML 文件（xlsx/docx/pptx）里的所有 XML 部件。"""
    if not path.is_file():
        return [Finding("missing-file", f"找不到文件：{path}", str(path))]
    findings: list[Finding] = []
    for name, text in text_parts(path):
        findings += scan_text(text, f"{path.name}:{name}", identities=identities)
    return findings


def core_property_findings(properties, *, identities: set[str] | None = None) -> list[Finding]:
    """检查文档核心属性里的身份字段（openpyxl/python-docx 会把本机名字写进去）。"""
    findings: list[Finding] = []
    names = identities or local_identities()
    for field_name in ("creator", "lastModifiedBy", "author", "company", "manager"):
        value = str(getattr(properties, field_name, "") or "").strip()
        if not value:
            continue
        if value in names:
            findings.append(Finding("core-property-identity",
                                    f"核心属性 {field_name} 是本机身份：{value}", field_name))
        elif re.search(r"[A-Za-z]:\\", value):
            findings.append(Finding("core-property-path",
                                    f"核心属性 {field_name} 含路径：{value}", field_name))
    return findings


def scrub_core_properties(properties, author: str = "NIBI") -> None:
    """生成侧无痕：作者/最后修改者/公司写成中性值。

    时间戳（created/modified）**不动**：它们不是身份痕迹，而 openpyxl 的 core.xml 序列化
    要求 dcterms 元素有值 —— 置 None 会在 save() 里 AttributeError（实测踩过）。
    """
    for field_name in ("creator", "lastModifiedBy", "author", "company", "manager"):
        if hasattr(properties, field_name):
            setattr(properties, field_name, author if field_name != "company" else "")

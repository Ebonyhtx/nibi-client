"""目录页码定位与对账：把「标题在第几页」从真渲染的 PDF 里读出来。

## 为什么要对账

DOCX 的目录有两种做法，各有各的坑：

* **TOC 域**：Word 里要用户手动更新（F9），学生交上去常常是空白或过期页码；渲染成 PDF 时
  LibreOffice 也不会自动更新域 → 目录可能是空的。
* **静态目录**：页码是我们写死的 —— 那就必须**验证它是真的**，否则就是"看起来有目录、
  数字全错"这种最难被发现的问题。

这里选静态目录 + 两遍生成 + 事后对账：第一遍用占位页码生成（**行数必须与最终一致**，
否则分页会变），从渲染出的 PDF 里定位每个标题的页号，第二遍写入真页码；质量门再用最终的
PDF 复核一遍目录里的每个数字。定位用"整行相等"匹配 —— 目录行是「标题……页号」，
正文里的标题行是单独一行，用行相等就能把目录行排除掉。
"""

from __future__ import annotations

import re

_ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\ufeff"), None)


def normalize(text: str) -> str:
    """去掉所有空白与零宽字符：PDF 抽文本会在中文之间插空格，不去掉就永远匹配不上。"""
    return re.sub(r"\s+", "", str(text or "").translate(_ZERO_WIDTH))


def page_lines(page_text: str) -> list[str]:
    return [normalize(line) for line in str(page_text or "").splitlines() if normalize(line)]


TOC_LINE = re.compile(r"^.+?\d{1,3}$")


def toc_pages(page_texts: list[str], toc_title: str = "目录") -> list[int]:
    """目录页 = 含目录标题的页 ∪ 「像目录的页」（大多数行以页码结尾）。

    后者是必需的：目录可能跨页，第二页没有"目录"标题；而**封面页不能算目录页**
    （文档标题在封面上，把它当目录页会让标题页永远定位不到 —— 实测踩过）。
    """
    wanted = normalize(toc_title)
    pages: list[int] = []
    for index, text in enumerate(page_texts):
        if wanted and wanted in normalize(text):
            pages.append(index)
            continue
        lines = [line for line in page_lines(text) if len(line) >= 4]
        if len(lines) >= 3:
            numbered = sum(1 for line in lines if TOC_LINE.match(line))
            if numbered / len(lines) >= 0.6:
                pages.append(index)
    return pages


def locate(pages: list[str], headings: list[str], toc_title: str = "目录") -> dict[str, int | None]:
    """标题文本 → 1 基页码（找不到是 None）。

    顺序单调：标题在文档里是有序的，所以每个标题从「上一个标题所在页」往后找，
    既省事又能跳过目录页里同名的那一行。
    """
    found: dict[str, int | None] = {}
    skip = set(toc_pages(pages, toc_title))
    cursor = 0
    for heading in headings:
        wanted = normalize(heading)
        hit: int | None = None
        if wanted:
            for index in range(cursor, len(pages)):
                if index in skip:
                    continue
                lines = page_lines(pages[index])
                if any(line == wanted or (line.startswith(wanted) and len(line) - len(wanted) <= 6)
                       for line in lines):
                    hit = index + 1
                    cursor = index
                    break
        found[heading] = hit
    return found


def verify(pages: list[str], entries: list[tuple[int, str, int | None]],
           toc_title: str = "目录") -> list[dict]:
    """复核目录条目：`entries` = [(level, 标题, 目录里写的页码)]，返回不一致项。"""
    located = locate(pages, [text for _, text, _ in entries], toc_title)
    problems: list[dict] = []
    for level, text, written in entries:
        actual = located.get(text)
        if actual is None:
            problems.append({"heading": text, "level": level, "written": written,
                             "actual": None, "reason": "渲染结果里找不到这个标题"})
        elif written is None:
            problems.append({"heading": text, "level": level, "written": None,
                             "actual": actual, "reason": "目录里没有页码"})
        elif int(written) != int(actual):
            problems.append({"heading": text, "level": level, "written": int(written),
                             "actual": int(actual), "reason": "目录页码与实际页不符"})
    return problems

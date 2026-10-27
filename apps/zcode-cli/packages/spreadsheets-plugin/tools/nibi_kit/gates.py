"""判据报告框架：每条判据必须自报「比了多少项」，没跑到的必须显式出现。

## 为什么要有这层

「判据会静默空转」是实测踩出来的四类成因（键名对不上、锚点找不到、预处理把内容洗掉了、
判据所在的阶段压根没被执行）。它们的共同后果一样：**全绿，但什么都没验**。
所以这个框架把两件事变成硬约束：

1. 每条判据声明自己 `checked` 了多少项；`checked == 0` 且没写 `skipped` 原因 → 报告整体失败；
2. 调用方声明「本次应跑的判据清单」，跑完比对 —— 少跑任何一条都报 `missing`，
   而不是让缺项变成沉默。

退出码约定：0 = 全部通过（允许 warn/skip）；1 = 有 fail；2 = 用法或环境错误（如引擎缺席导致必须
引擎层判据无法执行时，调用方决定是 fail 还是 skip —— 但必须显式二选一）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

SEVERITY_ORDER = {"fail": 0, "warn": 1, "skip": 2, "pass": 3}


@dataclass
class Finding:
    severity: str  # fail | warn
    code: str
    message: str
    location: str = ""

    def to_dict(self) -> dict:
        return {"severity": self.severity, "code": self.code,
                "message": self.message, "location": self.location}

    def render(self) -> str:
        where = f" @{self.location}" if self.location else ""
        mark = "✗" if self.severity == "fail" else "!"
        return f"  {mark} [{self.code}]{where} {self.message}"


@dataclass
class Gate:
    id: str
    title: str
    checked: int = 0
    findings: list[Finding] = field(default_factory=list)
    skipped: str = ""
    notes: list[str] = field(default_factory=list)
    # 机器可读的度量（notes 是给人看的）：冒烟与脚本要断言"数"的时候用 meta，
    # 不去解析人类可读的 note 文本（那种断言一改文案就碎）。
    meta: dict = field(default_factory=dict)

    def add(self, severity: str, code: str, message: str, location: str = "") -> None:
        self.findings.append(Finding(severity, code, message, location))

    def fail(self, code: str, message: str, location: str = "") -> None:
        self.add("fail", code, message, location)

    def warn(self, code: str, message: str, location: str = "") -> None:
        self.add("warn", code, message, location)

    @property
    def status(self) -> str:
        if self.skipped:
            return "skip"
        if any(finding.severity == "fail" for finding in self.findings):
            return "fail"
        if self.findings:
            return "warn"
        return "pass"

    @property
    def spun_empty(self) -> bool:
        """空转：声明要验却一项都没比，且没说明为什么。"""
        return self.checked == 0 and not self.skipped

    def to_dict(self) -> dict:
        return {"id": self.id, "title": self.title, "status": self.status,
                "checked": self.checked, "skipped": self.skipped,
                "notes": self.notes, "findings": [item.to_dict() for item in self.findings],
                "spunEmpty": self.spun_empty,
                **({"meta": self.meta} if self.meta else {})}


@dataclass
class GateReport:
    subject: str
    gates: list[Gate] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    def gate(self, gate_id: str, title: str) -> Gate:
        for existing in self.gates:
            if existing.id == gate_id:
                return existing
        created = Gate(gate_id, title)
        self.gates.append(created)
        return created

    def expected(self, gate_ids: list[str]) -> None:
        """声明本次应跑的判据清单；缺失/空转都会体现在报告里。"""
        self.meta["expected"] = list(gate_ids)

    @property
    def missing(self) -> list[str]:
        ran = {gate.id for gate in self.gates}
        return [gate_id for gate_id in self.meta.get("expected", []) if gate_id not in ran]

    @property
    def spun_empty(self) -> list[str]:
        return [gate.id for gate in self.gates if gate.spun_empty]

    @property
    def ok(self) -> bool:
        return (not self.missing and not self.spun_empty
                and all(gate.status != "fail" for gate in self.gates))

    @property
    def exit_code(self) -> int:
        return 0 if self.ok else 1

    def counts(self) -> dict:
        tally = {"pass": 0, "warn": 0, "fail": 0, "skip": 0}
        for gate in self.gates:
            tally[gate.status] += 1
        tally["expected"] = len(self.meta.get("expected", []))
        tally["ran"] = len(self.gates)
        return tally

    def to_dict(self) -> dict:
        return {"subject": self.subject, "meta": self.meta, "counts": self.counts(),
                "missing": self.missing, "spunEmpty": self.spun_empty,
                "ok": self.ok, "gates": [gate.to_dict() for gate in self.gates]}

    def write_json(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")

    def render(self) -> str:
        tally = self.counts()
        lines = [f"判据报告：{self.subject}",
                 f"  判据 {tally['ran']}/{tally['expected'] or tally['ran']} 条"
                 f"（通过 {tally['pass']}、告警 {tally['warn']}、失败 {tally['fail']}、跳过 {tally['skip']}）"]
        for gate in self.gates:
            mark = {"pass": "ok  ", "warn": "warn", "fail": "FAIL", "skip": "skip"}[gate.status]
            extra = f"（比了 {gate.checked} 项）" if gate.checked else ""
            lines.append(f"  [{mark}] {gate.title}{extra}")
            if gate.skipped:
                lines.append(f"        跳过原因：{gate.skipped}")
            for note in gate.notes:
                lines.append(f"        · {note}")
            for finding in gate.findings:
                lines.append(finding.render())
        for gate_id in self.missing:
            lines.append(f"  [MISS] 应跑未跑：{gate_id}")
        for gate_id in self.spun_empty:
            lines.append(f"  [EMPTY] 判据空转（一项都没比）：{gate_id}")
        lines.append(f"  结论：{'通过' if self.ok else '未通过'}")
        return "\n".join(lines)

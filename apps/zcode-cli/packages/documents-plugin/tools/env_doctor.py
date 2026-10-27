"""环境体检入口（实现见共享工具包 `nibi_kit.doctor`，四个插件同一份）。

用法：
    python tools/env_doctor.py [--layer core|render] [--install] [--office-home <LibreOffice 目录>]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nibi_kit import doctor  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(doctor.main())

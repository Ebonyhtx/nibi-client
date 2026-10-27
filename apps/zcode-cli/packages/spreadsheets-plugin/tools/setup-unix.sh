#!/usr/bin/env bash
# NIBI 文档插件的环境引导（macOS / Linux）。
#
# 为什么要有这个脚本：如果机器上连 Python 都没有，任何 .py 入口都跑不起来 —— 引导必须是
# 平台原生的。这一层负责「查前提 + 给分平台的具体命令」，查到 Python 之后再交给 Python 侧的
# 自举（nibi_kit.env：建 venv、按镜像装依赖、换解释器重跑）。
#
# 用法：
#   bash tools/setup-unix.sh              # 只检查与报告（不动系统）
#   bash tools/setup-unix.sh --install    # 缺依赖时真的装（venv + pip，走国内镜像）
#
# 退出码：0 = 核心就绪；1 = 核心就绪但缺渲染引擎（降级可用）；2 = 前提缺失（没有 Python/pip）。
set -uo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$TOOLS_DIR")"
DO_INSTALL=0
[ "${1:-}" = "--install" ] && DO_INSTALL=1

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m○\033[0m %s\n' "$1"; }
info() { printf '  \033[34m→\033[0m %s\n' "$1"; }

echo "============================================"
echo "  NIBI 文档插件 · 环境引导（$(uname -s) $(uname -m)）"
echo "  插件：$(basename "$PLUGIN_DIR")"
echo "============================================"

OS="$(uname -s)"
STATUS=0

# ── 1. Python 3 ─────────────────────────────────────────────
PY=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        version=$("$candidate" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "0.0")
        major=${version%%.*}; minor=${version##*.}
        if [ "$major" -ge 3 ] && [ "$minor" -ge 9 ]; then PY="$candidate"; ok "Python $version ($candidate)"; break; fi
        warn "$candidate 版本 $version 低于 3.9，跳过"
    fi
done
if [ -z "$PY" ]; then
    bad "没有找到 Python 3.9+（插件的工具链全部依赖它）"
    case "$OS" in
        Darwin) info "安装：brew install python3"
                info "  注意：macOS 自带的 /usr/bin/python3 是个桩（首次运行会要求装 Xcode 命令行工具），"
                info "  用 Homebrew 装一个更省事（装完可能要重开终端）" ;;
        Linux)  info "安装：sudo apt install python3 python3-pip python3-venv   （Debian/Ubuntu）"
                info "      sudo dnf install python3 python3-pip             （Fedora/RHEL）"
                info "      sudo pacman -S python python-pip                  （Arch）"
                info "  这些命令要 sudo（会问你密码）" ;;
        *)      info "安装：https://www.python.org/downloads/" ;;
    esac
    info "装完**重开终端**（让 PATH 生效）再跑本脚本；Windows 请用 tools/setup-windows.ps1"
    info "不想自己装，也可以让 NIBI 代跑上面这条命令 —— 它会改系统 PATH，动手前先跟你确认。"
    exit 2
fi

# ── 2. pip 与 venv ──────────────────────────────────────────
if "$PY" -m pip --version >/dev/null 2>&1; then
    ok "pip（$("$PY" -m pip --version 2>/dev/null | head -1)）"
else
    bad "缺 pip"
    case "$OS" in
        Darwin) info "修复：$PY -m ensurepip --upgrade  或  brew install python3" ;;
        Linux)  info "修复：sudo apt install python3-pip  或  $PY -m ensurepip --upgrade" ;;
    esac
    exit 2
fi
if "$PY" -c 'import venv' >/dev/null 2>&1; then
    ok "venv 模块可用（依赖装在插件自管环境里，不污染系统）"
else
    bad "缺 venv 模块"
    case "$OS" in
        Linux) info "修复：sudo apt install python3-venv   （Debian/Ubuntu）" ;;
        *)     info "修复：重装 Python（勾选 venv/pip 组件）" ;;
    esac
    exit 2
fi

# ── 3. 插件依赖（交给 Python 侧自举）────────────────────────
echo ""
echo "--- 插件依赖（venv + pip，走国内镜像）---"
if [ "$DO_INSTALL" = "1" ]; then
    if "$PY" "$TOOLS_DIR/env_doctor.py" --install; then ok "依赖已就绪"; else bad "依赖安装失败（详见上面输出）；可换源：NIBI_DOCS_PYTHON_MIRROR=<url>"; STATUS=1; fi
else
    if "$PY" "$TOOLS_DIR/env_doctor.py" >/dev/null 2>&1; then ok "依赖已就绪"
    else warn "依赖缺失或未就绪"; info "安装：$PY $TOOLS_DIR/env_doctor.py --install"; STATUS=1; fi
fi

# ── 4. 渲染引擎（按需安装，不替代）──────────────────────────
echo ""
echo "--- 渲染引擎（出逐页图 / 转 PDF / 公式重算要用）---"
# 引擎探测交给 Python 侧（它认环境变量/共用登记/PATH/常见安装目录四类来源）
RENDER_OUT="$("$PY" "$TOOLS_DIR/env_doctor.py" --layer render 2>&1 || true)"
ENGINE_LINE="$(printf '%s
' "$RENDER_OUT" | grep '渲染引擎' | head -1)"
if printf '%s' "$ENGINE_LINE" | grep -qv '未找到' && [ -n "$ENGINE_LINE" ]; then
    ok "$ENGINE_LINE"
    info "四个文档插件共用这一份登记，换插件不必再登记"
else
    printf '%s
' "$RENDER_OUT" | sed 's/^/  /'
    warn "未找到 LibreOffice —— 静态判据仍可用，但出图/转 PDF/公式重算不可用"
    info "需要这些能力时**必须装**（用系统里其它办公软件顶替是不行的）："
    info "  $PY $TOOLS_DIR/env_doctor.py --engine-guide   （按平台给镜像地址与安装方式）"
    case "$OS" in
        Darwin) info "  示例：下载 .dmg（mac/aarch64 或 mac/x86_64）安装；兜底 brew install --cask libreoffice" ;;
        Linux)  info "  示例：deb/rpm 解包安装；兜底 sudo apt install libreoffice-core" ;;
    esac
    info "  **装在 PATH 外会被当成没装**：装完建软链，如 sudo ln -sf /opt/libreoffice*/program/soffice /usr/local/bin/soffice"
    STATUS=1
fi

echo ""
echo "============================================"
if [ "$STATUS" = "0" ]; then
    echo "  环境就绪：可以开始用插件的工具了"
else
    echo "  核心可用，但有缺件（见上面的 ✗ 与 ○）"
fi
echo "============================================"
exit "$STATUS"

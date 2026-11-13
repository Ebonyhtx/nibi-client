# NIBI 文档插件的环境引导（Windows / PowerShell）。
#
# 为什么要有这个脚本：如果机器上连 Python 都没有，任何 .py 入口都跑不起来 —— 引导必须是
# 平台原生的（Windows 自带 PowerShell 5.1，够用）。查到 Python 之后再交给 Python 侧自举。
#
# 用法（在插件目录下）：
#   powershell -ExecutionPolicy Bypass -File tools\setup-windows.ps1            # 只检查与报告
#   powershell -ExecutionPolicy Bypass -File tools\setup-windows.ps1 -Install   # 缺依赖时真的装
#
# 退出码：0 = 核心就绪；1 = 核心就绪但缺渲染引擎（降级可用）；2 = 前提缺失（没有 Python/pip）。
param([switch]$Install)

$ErrorActionPreference = "Continue"
# PowerShell 5.1 默认按控制台代码页解码子进程输出：python 写 UTF-8，PS 按 GBK 读 → 中文全乱。
# 这两行让父子进程用同一套编码（实测：不设的话体检报告整片乱码，连关键字都匹配不上）。
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
$ToolsDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginDir = Split-Path -Parent $ToolsDir

function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  [X]    $m" -ForegroundColor Red }
function Warn($m) { Write-Host "  [ ]    $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "         -> $m" -ForegroundColor Cyan }

Write-Host "============================================"
Write-Host "  NIBI 文档插件 · 环境引导（Windows $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)）"
Write-Host "  插件：$(Split-Path -Leaf $PluginDir)"
Write-Host "============================================"

$status = 0

# ── 1. Python 3 ─────────────────────────────────────────────
$python = $null
foreach ($candidate in @("py", "python")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    $probe = if ($candidate -eq "py") { @("-3", "-c") } else { @("-c") }
    $version = & $candidate @probe "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $version) { continue }
    $parts = $version.Split(".")
    if ([int]$parts[0] -ge 3 -and [int]$parts[1] -ge 9) {
        $python = $candidate
        Ok "Python $version（$candidate）"
        break
    }
    Warn "$candidate 版本 $version 低于 3.9，跳过"
}
if (-not $python) {
    Bad "没有找到 Python 3.9+（插件的工具链全部依赖它）"
    Info "安装（任选其一）："
    Info "  winget install --id Python.Python.3.12 -e"
    Info "  国内镜像安装包：https://mirrors.huaweicloud.com/python/  （挑 3.12.x 的 amd64 安装包）"
    Info "  **安装时务必勾选 Add python.exe to PATH** —— 不勾的话命令行里找不到 python"
    Info "  装完关掉这个窗口重开（让 PATH 生效），再跑一次本脚本"
    Info "  注意：winget 安装可能弹 UAC 授权框，需要你点一下允许"
    Info "不想自己装，也可以让 NIBI 代跑上面那条命令 —— 会改系统 PATH，动手前先跟你确认。"
    exit 2
}

# ── 2. pip 与 venv ──────────────────────────────────────────
$pipProbe = if ($python -eq "py") { @("-3", "-m", "pip", "--version") } else { @("-m", "pip", "--version") }
& $python @pipProbe *> $null
if ($LASTEXITCODE -eq 0) {
    $pipVersion = (& $python @($(if ($python -eq "py") { @("-3","-m","pip","--version") } else { @("-m","pip","--version") })) 2>$null | Select-Object -First 1)
    Ok "pip（$pipVersion）"
} else {
    Bad "缺 pip"
    Info "修复：$python -m ensurepip --upgrade   （或重装 Python 并勾选 pip）"
    exit 2
}
$venvProbe = if ($python -eq "py") { @("-3", "-c", "import venv") } else { @("-c", "import venv") }
& $python @venvProbe *> $null
if ($LASTEXITCODE -eq 0) {
    Ok "venv 模块可用（依赖装在插件自管环境里，不污染系统 Python）"
} else {
    Bad "缺 venv 模块"
    Info "修复：重装 Python（勾选 tcl/tk 与 pip、venv 组件）"
    exit 2
}

# ── 3. 插件依赖（交给 Python 侧自举）────────────────────────
Write-Host ""
Write-Host "--- 插件依赖（venv + pip，走国内镜像）---"
$doctor = Join-Path $ToolsDir "env_doctor.py"
$doctorArgs = if ($python -eq "py") { @("-3", $doctor) } else { @($doctor) }
if ($Install) {
    $installArgs = $doctorArgs + @("--install")
    & $python @installArgs
    if ($LASTEXITCODE -eq 0) { Ok "依赖已就绪" }
    else {
        Bad "依赖安装失败（详见上面输出）"
        Info "可换源：`$env:NIBI_DOCS_PYTHON_MIRROR = 'https://mirrors.aliyun.com/pypi/simple'"
        $status = 1
    }
} else {
    & $python $doctorArgs *> $null
    if ($LASTEXITCODE -eq 0) { Ok "依赖已就绪" }
    else {
        Warn "依赖缺失或未就绪"
        Info "安装：$python $doctor --install"
        $status = 1
    }
}

# ── 4. 渲染引擎（按需安装，不替代）──────────────────────────
Write-Host ""
Write-Host "--- 渲染引擎（出逐页图 / 转 PDF / 公式重算要用）---"
# 探测与报告都交给 Python 侧（它认环境变量/共用登记/PATH/常见安装目录四类来源），
# 脚本**不解析**它的输出 —— 只按退出码决定状态（解析中文输出在编码上太脆）。
$renderArgs = if ($python -eq "py") { @("-3", $doctor, "--layer", "render") } else { @($doctor, "--layer", "render") }
& $python @renderArgs
if ($LASTEXITCODE -eq 0) {
    Ok "渲染链路齐备（四个文档插件共用这一份登记）"
} else {
    Warn "渲染引擎未就绪 —— 静态判据仍可用，但出图/转 PDF/公式重算不可用"
    Info "需要这些能力时**必须装**（用系统里其它办公软件顶替是不行的）："
    Info "  $python $doctor --engine-guide          （按平台给镜像地址与安装方式）"
    Info "  $python $doctor --install-engine --yes  （Windows 免管理员：装到用户目录，可整目录删除）"
    $status = 1
}

Write-Host ""
Write-Host "--- 插件依赖（venv + pip，走国内镜像）---"
$doctor = Join-Path $ToolsDir "env_doctor.py"
$doctorArgs = if ($python -eq "py") { @("-3", $doctor) } else { @($doctor) }
if ($Install) {
    $installArgs = $doctorArgs + @("--install")
    & $python @installArgs
    if ($LASTEXITCODE -eq 0) { Ok "依赖已就绪" }
    else {
        Bad "依赖安装失败（详见上面输出）"
        Info "可换源：`$env:NIBI_DOCS_PYTHON_MIRROR = 'https://mirrors.aliyun.com/pypi/simple'"
        $status = 1
    }
} else {
    & $python $doctorArgs *> $null
    if ($LASTEXITCODE -eq 0) { Ok "依赖已就绪" }
    else {
        Warn "依赖缺失或未就绪"
        Info "安装：$python $doctor --install"
        $status = 1
    }
}

# ── 4. 渲染引擎（按需安装，不替代）──────────────────────────
Write-Host ""
Write-Host "--- 渲染引擎（出逐页图 / 转 PDF / 公式重算要用）---"
# 引擎探测交给 Python 侧（它认环境变量/共用登记/PATH/常见安装目录四类来源），
# 脚本里再写一套探测只会得出"未找到"的错结论。
$renderArgs = if ($python -eq "py") { @("-3", $doctor, "--layer", "render") } else { @($doctor, "--layer", "render") }
$renderOut = & $python @renderArgs 2>&1
$engineLine = $renderOut | Select-String -Pattern "渲染引擎" | Select-Object -First 1
if ($engineLine -and $engineLine -notmatch "未找到") {
    Ok "$engineLine"
    Info "四个文档插件共用这一份登记，换插件不必再登记"
} else {
    foreach ($line in $renderOut) { Write-Host "  $line" }
    Warn "未找到 LibreOffice —— 静态判据仍可用，但出图/转 PDF/公式重算不可用"
    Info "需要这些能力时**必须装**（用系统里其它办公软件顶替是不行的）："
    Info "  python $doctor --engine-guide          （按平台给镜像地址与安装方式）"
    Info "  python $doctor --install-engine --yes  （Windows 免管理员：装到用户目录，可整目录删除）"
    $status = 1
}

Write-Host ""
Write-Host "--- 插件依赖（venv + pip，走国内镜像）---"
$doctor = Join-Path $ToolsDir "env_doctor.py"
$doctorArgs = if ($python -eq "py") { @("-3", $doctor) } else { @($doctor) }
if ($Install) {
    $installArgs = $doctorArgs + @("--install")
    & $python @installArgs
    if ($LASTEXITCODE -eq 0) { Ok "依赖已就绪" }
    else {
        Bad "依赖安装失败（详见上面输出）"
        Info "可换源：`$env:NIBI_DOCS_PYTHON_MIRROR = 'https://mirrors.aliyun.com/pypi/simple'"
        $status = 1
    }
} else {
    & $python $doctorArgs *> $null
    if ($LASTEXITCODE -eq 0) { Ok "依赖已就绪" }
    else {
        Warn "依赖缺失或未就绪"
        Info "安装：$python $doctor --install"
        $status = 1
    }
}

# ── 4. 渲染引擎 LibreOffice（按需安装，不替代）──────────────
Write-Host ""
Write-Host "--- 渲染引擎（出逐页图 / 转 PDF / 公式重算要用）---"
$soffice = $null
foreach ($path in @(
        "$env:ProgramFiles\LibreOffice\program\soffice.exe",
        "${env:ProgramFiles(x86)}\LibreOffice\program\soffice.exe",
        "$env:LOCALAPPDATA\Programs\LibreOffice\program\soffice.exe")) {
    if (Test-Path $path) { $soffice = $path; break }
}
if (-not $soffice -and (Get-Command soffice -ErrorAction SilentlyContinue)) { $soffice = "soffice" }
if ($soffice) {
    $version = (& $soffice.com --version 2>$null | Select-Object -First 1)
    if (-not $version) { $version = (& $soffice --version 2>$null | Select-Object -First 1) }
    Ok "$version  （$soffice）"
    Info "已能自动探测到。若上面的字体/依赖体检没认出来，登记一次："
    Info "  $python $doctor --office-home `"$env:ProgramFiles\LibreOffice`""
} else {
    Warn "未找到 LibreOffice —— 静态判据仍可用，但出图/转 PDF/公式重算不可用"
    Info "需要这些能力时**必须装**（用系统里其它办公软件顶替是不行的），首选国内镜像："
    Info "  https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/  （挑最新版 win/x86_64 的 .msi）"
    Info "  或：winget install --id TheDocumentFoundation.LibreOffice -e"
    Info "  免管理员（装到用户目录，不写注册表、可整目录删除）："
    Info "  $python $doctor --install-engine --yes"
    Info "装完复验：$python $doctor --layer render"
    $status = 1
}

Write-Host ""
Write-Host "============================================"
if ($status -eq 0) { Write-Host "  环境就绪：可以开始用插件的工具了" }
else { Write-Host "  核心可用，但有缺件（见上面的 [X] 与 [ ]）" }
Write-Host "============================================"
exit $status

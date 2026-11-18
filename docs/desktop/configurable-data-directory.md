# 可配置数据存储目录

## 概述

应用数据默认存储在 `~/.nibi/v2/`，非项目对话工作区在 `~/.nibi/workspace/`（`~` 即 `os.homedir()`）。用户可在「设置 → 通用 → 数据存储路径」中更改 `~` 对应的根目录，`.nibi/v2` 与 `.nibi/workspace` 后缀不可更改。

## 目录结构

```
<dataBaseDir>/.nibi/v2/          ← 可配置的 App 数据目录
  ├── logs/
  ├── perf/
  ├── sessions/
  ├── tasks-index.sqlite
  ├── telemetry-state.json
  └── ...

<dataBaseDir>/.nibi/workspace/   ← 非项目对话工作区（随数据根一并迁移）
  └── default/                   ← 共享的真实工作目录

<dataBaseDir>/.nibi/machine/     ← per-install 凭据密钥目录（必须在 v2 之外）
  └── credential-v2.key

~/.nibi/v2/setting.json          ← Bootstrap 指针（永远在默认 homedir 下）
```

## Bootstrap 机制

`setting.json` 始终且只存在于默认 `homedir()/.nibi/v2/setting.json`，不跟随自定义目录迁移。它是整个路径切换的引导入口：

1. 主进程启动 → 从 `homedir()/.nibi/v2/setting.json` 读取 `dataBaseDir`
2. 如果有值 → 调用 `setDataBaseDir(dir)` 切换后续所有数据路径
3. 启动 host process 时通过环境变量 `NIBI_DATA_BASE_DIR` 传递给子进程

路径解析优先级（`getDataBaseDir()`）：
1. `setDataBaseDir()` 设置的值（主进程 bootstrap）
2. `process.env.NIBI_DATA_BASE_DIR`（host process 通过环境变量接收）
3. `os.homedir()`（兜底默认值）

## 复制行为

当用户更改数据目录时，会将旧目录的数据复制到新目录：

| 规则 | 说明 |
|------|------|
| **v2 的 setting.json 及其瞬时文件不复制** | `v2/setting.json` 是 bootstrap 指针，`v2/setting.json.lock` 与 `v2/setting.json.*.tmp` 是原子写入中间态，均只存在于默认 homedir 下；复制它们会导致迁移竞态或新旧目录冲突。该规则只作用于 `.nibi/v2`，不套用到 workspace |
| **迁移包含 `.nibi/workspace`** | `.nibi/workspace`（非项目对话工作区）与 `.nibi/v2` 一并整体复制；源没有 workspace 目录时按 no-op 处理，不报错 |
| **workspace 只跳过符号链接** | workspace 内的软链（例如指向共享目录的链接）不复制，避免把外部目录内容或循环链接带进新根。workspace 里名为 `setting.json` 的普通文件属于用户数据，会原样复制 |
| **迁移包含 `.nibi/machine`** | `.nibi/v2`、`.nibi/workspace` 与 `.nibi/machine`（per-install 凭据密钥）分开整体搬运；钥匙始终留在 v2 之外，只拷走 `v2/credentials.json` 无法解密 |
| **凭据验证只针对 v2** | 暂存区复制完成后只用 `v2/credentials.json` + `machine/` 密钥做解密验证；workspace 不含 NIBI 凭据，不参与验证 |
| **已有文件不覆盖** | `force: false` — 如果目标目录已存在同名文件，保留目标版本。防止还原回旧目录时，新产生的数据被旧副本覆盖；v2 与 workspace 均适用 |
| **新文件正常复制** | 源目录有、目标没有的文件会被复制过去；v2 与 workspace 的嵌套目录均适用 |
| **同一安装密钥的非空目标可合并** | 目标已有数据（v2 或 workspace 非空）、但 `machine/credential-v2.key` 与源一致（同一安装的旧根）时允许非覆盖合并：目标已有文件保留，源新增文件补入。用于还原旧根，以及“复制成功但 setting 写失败”的幂等重试 |
| **不同安装的非空目标拒绝** | 目标已有数据（v2 或 workspace 非空）但安装密钥与源不同或缺失时拒绝迁移，避免把两套 NIBI 数据混在一起 |

### 场景示例

**正向迁移**（`/Users/a` → `/Users/a/test`）：
- `/Users/a/.nibi/v2/` 下的所有文件（除 setting.json 及其瞬时文件）复制到 `/Users/a/test/.nibi/v2/`
- `/Users/a/.nibi/workspace/` 整体复制到 `/Users/a/test/.nibi/workspace/`（软链除外；workspace 缺失则跳过）
- `/Users/a/.nibi/machine/` 整体复制到 `/Users/a/test/.nibi/machine/`（钥匙仍在 v2 之外）
- 目标目录如果不存在会自动创建

**还原**（`/Users/a/test` → `/Users/a`）：
- 仅当 `/Users/a/.nibi/machine/credential-v2.key` 与源一致（同一安装）时允许
- `/Users/a/test/.nibi/v2/` 与 `/Users/a/test/.nibi/workspace/` 下的文件非覆盖合并到对应目录
- `/Users/a/.nibi/v2/`、`/Users/a/.nibi/workspace/` 里这段时间新产生的文件不会被覆盖，源里新增的文件会补进来
- `setting.json` 始终不受影响

## Windows 安装目录保护

Windows 上禁止把数据根目录设置到 NIBI 的安装目录或其子目录。原因是安装目录会被安装器和自动更新流程管理，若把 `<dataBaseDir>/.nibi/v2/` 放进去，后续更新可能覆盖或清理用户数据。

拦截规则：

| 来源 | 示例 |
|------|------|
| 当前桌面应用安装目录 | `process.resourcesPath` 的上级目录，例如 `C:\Users\{UserName}\AppData\Local\Programs\NIBI` |
| Program Files 安装目录 | `%ProgramFiles%\NIBI`、`%ProgramFiles(x86)%\NIBI`、`%ProgramW6432%\NIBI` |
| 用户 LocalAppData 安装目录 | `%LOCALAPPDATA%\Programs\NIBI` |

`packages/desktop/src/main/desktopRuntimeEnv.ts` 会在 Windows 打包态把当前安装目录通过 `NIBI_WINDOWS_APP_INSTALL_DIR` 传给 host process。`packages/services/src/paths.ts` 在服务层按 Windows 路径规则做大小写不敏感的“等于或位于其下”判断，`packages/services/src/setting/settingService.ts` 在复制数据前执行该校验。UI 只展示错误提示，不作为唯一安全边界。

### 安装器阻断保护

Windows 安装包不会禁止用户选择任意安装目录。为覆盖历史版本已把数据放进安装目录的用户，NSIS assisted installer 会在用户选完安装目录、真正写入文件前检查最终安装目录及其子目录是否存在 `.nibi`：

1. 按 electron-builder assisted installer 的目录补齐规则计算最终安装目录
2. 若用户选择的是父目录，electron-builder 会安装到 `$INSTDIR\NIBI`，因此检查 `$INSTDIR\NIBI` 及其子目录
3. 命中后展示阻断页，提示安装目录或其子目录包含 `.nibi` 数据，继续安装或更新会让安装器清理历史会话和配置
4. 阻断页禁用“下一步”，并把“上一步”按钮加宽、文案改为“重选目录”
5. 用户点击“重选目录”后回到目录选择页，必须选择其他安装目录才能继续安装
6. 用户仍可取消安装器退出；不提供“忽略并继续”入口
7. 静默安装命中 `.nibi` 时直接退出失败，避免自动化安装绕过数据保护

该阻断保护只面向安装包流程，不替代设置页的数据迁移校验。

## UI 交互流程

1. 只读路径框默认显示当前生效路径（已配置的路径或 homedir）
2. 点击「选择文件夹」，通过系统目录弹窗选择新的根目录
3. 确认无误后点击「保存」
4. 按钮显示加载动画，选择按钮禁用，提示"正在复制数据，请勿关闭应用…"
5. 复制完成 → 提示"数据已保存，重启应用后生效。"
6. 复制失败 → 提示"数据复制失败，路径未更改。"（红色），可重新选择后重试
7. Windows 上若选择了 NIBI 安装目录或其子目录 → 提示"不能选择 NIBI 安装目录作为数据存储路径"，路径不写入配置
8. 用户重启应用后新路径生效

## 已确认的迁移边界

用户于 2026-08-10 确认以下目标语义：

1. App `.nibi/v2` 与非项目对话 `.nibi/workspace` 一并迁移。
2. 只允许在当前 conversation 已空闲时发起迁移。
3. 保存成功后进入待重启状态；目标产品态应阻止继续向旧 App 数据目录写入。
4. 目标已有**不同安装**（`machine/credential-v2.key` 异钥或缺失）的 NIBI 数据时拒绝迁移，不做合并；同一安装密钥的旧根允许非覆盖合并（用于还原与失败重试）。
5. 完整冷重启后，迁移前任务历史仍可见，并且可以在同一任务中继续对话。
6. `dataBaseDir` 只改变 App 数据目录；CLI 用户资源仍使用 `<HOME>/.nibi/cli`，项目内
   `.nibi/*` 也保持原路径。
7. 迁移包含 `.nibi/machine`（per-install 凭据密钥）；钥匙始终留在 v2 之外，不随 v2 复制进 v2。

首个自动化 case `CDD01` 暂不修改上述产品行为，只验证当前可安全执行的代表路径：Desktop
本地 `desktop-continuous`、任务已空闲、目标目录为空、保存后不再执行任何业务操作并立即完整
重启 Electron、Host 与 Agent。

```text
old App root + idle task
          |
          | choose empty target + save
          v
restart-required UI
          |
          | no more writes in the old process
          | immediate full cold restart
          v
new App root
          +--> old task history is visible
          +--> same task accepts a follow-up
          +--> App task-index writes stay under the new root
          +--> CLI stays under <HOME>/.nibi/cli
```

`CDD01` 的 idle 与立即重启是测试前置/时序约束，不代表当前产品已经机械阻止 busy 迁移或保存后的
继续写入；同安装密钥非空目标的非覆盖合并也不由该 case 证明。`relocateDataRoot()` 已按清单迁移
`.nibi/v2`、`.nibi/workspace` 与 `.nibi/machine`；workspace 的嵌套目录复制、缺失 no-op、软链跳过
和非覆盖合并由服务层单测覆盖，但 `CDD01` 的空目标代表路径仍不能解释为完整证明第 1 条的全部场景。

## 相关代码

| 文件 | 职责 |
|------|------|
| `packages/services/src/paths.ts` | `setDataBaseDir` / `getDataBaseDir` / `getAppConfigDir` / Windows 安装目录校验 |
| `packages/services/src/data-root/manifest.ts` | 迁移清单：`.nibi/v2`、`.nibi/workspace`（数据）与 `.nibi/machine`（per-install 密钥）分开搬运 |
| `packages/services/src/data-root/relocate.ts` | `relocateDataRoot()` — 按清单暂存复制（v2/workspace 各自过滤）+ v2 凭据解密验证 + 同一安装非覆盖合并 + 发布（machine 先于 data） |
| `packages/services/src/setting/settingService.ts` | `updateDataBaseDir()` — 校验 + 数据根迁移 + 持久化（成功后才写 setting） |
| `packages/services/src/setting/setting.ts` | `ISettingService` 接口定义 |
| `packages/shared/src/protocol.ts` | `AppSettings.dataBaseDir` 类型 |
| `packages/shared/src/validation.ts` | zod schema |
| `packages/desktop/build/installer.nsh` | Windows 安装器在写入文件前阻断安装目录内已有 `.nibi` 的安装 |
| `packages/desktop/src/main/index.ts` | 主进程 bootstrap 读取 |
| `packages/desktop/src/main/desktopRuntimeEnv.ts` | `buildHostProcessEnv` 传递环境变量 |
| `packages/ui/src/settingsPageHelpers.tsx` | UI 输入框 + 保存状态管理 |
| `packages/ui/src/SettingsPage.tsx` | 页面级状态 + 服务调用 |

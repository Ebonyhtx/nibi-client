# NIBI 插件兼容模型（Agent Plugins 1.0.0）

> Status: Implemented
> Date: 2026-11-22
> 适用范围：桌面客户端、Host 进程、Node app-server / 远端 Source Server
> 代码入口：`apps/nibi-cli/packages/contracts/src/plugins/`、`apps/nibi-cli/packages/adapters/src/plugins/`、`packages/desktop/src/host/localPluginManagementService.ts`

本文记录当前插件体系的唯一口径：清单长什么样、哪些生态会被读取、权限与同意如何生效、扩展代码在哪运行。更细的专题见文末链接。

## 1. 清单与发现

NIBI 认 Agent Plugins 1.0.0 为公共底座：插件根 `plugin.json` + `skills/` + 根 `mcp.json`。NIBI 专属声明放在同一份清单的 `extensions["com.nibistudio.nibi"]` 下（commands / agents / hooks / ui / userConfig / acceptance / capability 等）。

发现顺序（命中即停）：

| 顺序 | 位置 | 适配器 |
|---|---|---|
| 1 | 根 `plugin.json` | `native`（NIBI 组件）或 `agent-plugins` |
| 2 | `.claude-plugin/plugin.json` | `claude` |
| 3 | `.codex-plugin/plugin.json` | `codex` |
| 4 | `.zcode-plugin/plugin.json` | `zcode` |
| 5 | 带 `dsh.bundle` 的 `package.json` | `dsh` |

- 外来目录只读加载：不复制、不改写、不重签。
- 外来清单里的 `runtime` 不会执行，统一标记为 `skipped: ["runtime"]`；声明式组件仍可用。
- 市场源支持根 `marketplace.json`、`.claude-plugin/marketplace.json`、`.zcode-plugin/marketplace.json`；本地缓存写根 `marketplace.json`。

组件映射：skills、commands、agents、hooks、MCP、UI surfaces、userConfig、acceptance。无法映射或仅诊断的字段进 `skipped`，UI 只在功能不可用时解释后果，不展示生态名。

## 2. CanonicalPlugin 与信任级别

所有适配器归一到 `CanonicalPlugin`：`adapter{adapterId, manifestPath, compatibility, skipped}`、`manifest`、`permissions`、`rootPath`、`trust`。

| 信任 | 来源 | 代码运行 | 权限上限 |
|---|---|---|---|
| `builtin` | 随客户端分发 | 允许（T1） | 可请求 host scope |
| `official` | NIBI 官方市场（签名 + revision + sha256） | 允许（T1） | 可请求 host scope |
| `community` | 第三方市场 | 允许（T2） | 不给 `full-access`、不给 host scope |
| `local` | 本地目录 / 手动安装 | 允许（T3，单插件进程） | 不给 `full-access`、不给 host scope |

`compatibility` 只进数据层（`full` / `partial` / `detected`）；市场 UI 不显示生态名或兼容级别。

## 3. Hooks

插件 Hook 事件与 Workspace Hook 是两套模型：

- 插件事件：33 个（顺序与内核一致），其中 14 个有 producer、会真正派发；19 个 enum-only，注册表标 `runnable: false`，UI 必须显示“不会触发”，不能当成已支持。
- Workspace Hook：保持原有 7 个事件，digest / trust store / review payload 字节级不变。
- 插件事件不得进入 Workspace Hook 配置或信任流程；插件同意另行记录。

`PreCompact` 策略：

- 手动压缩（`Manual`）：Hook 返回 block 时中止压缩并显示原因。
- 自动 / 反应式压缩：忽略 block 继续压缩，只采用成功 Hook 的 `custom_instructions`。

插件 `agents/` 与子代理模型：

- 定义按 Agent Plugins 规则读取：`model` 是 `provider/model`（Picker 串可带 `$<档位>`）或 `custom:<providerId>:<modelId>`；`thoughtLevel` 是档位。
- 设置页的覆盖写在 `<存储根>/v2/agents-state.json`：插件键 `plugin:<pluginId>:<agent 名小写>`，内置键 `general-purpose` / `Explore`；派发时覆盖替换整份选择（Provider、模型、档位），不只换模型 id。
- Rust 内核（桌面本地默认）与 Node 运行时同一口径：每次取 agent 定义都重读这份文件，改完立即生效。未显式配置 `model` 时 `thoughtLevel` 不单独生效（继承父会话的 Provider options）。
- 换 Provider 时不沿用父会话的 Team Plan 账号连接；同 Provider 内换模型沿用。

## 4. 权限、同意与审计

权限闭集：`filesystem.read`、`filesystem.write`、`network`、`process`、`code`、`full-access`。

运行时 required 由组件推导：

| 组件 | required |
|---|---|
| hooks（仅 runnable 事件） | `process` |
| MCP | `process` + `network` |
| 扩展代码（native / agent-plugins 的 `runtime`） | `code` |

规则：

- 只有 community / local 需要逐版本同意；builtin / official 沿用分发信任。
- 同意按版本覆盖：版本变化或 required 变多都要求重新同意。
- 同意记录 `<插件存储根>/plugin-consents.json`；能力授权 `plugin-grants.json`（逐版本 `epoch`）；审计 `plugin-audit.ndjson`（只写插件 id、能力、版本、结果，不写参数正文）。
- `full-access` 永不授予 community / local；`host` scope 只对 builtin / official 开放。
- 撤销同意会同时清空能力授权并把 `epoch + 1`；未同意时发现层停用插件并报 `plugin_consent_required`。
- 存储根必须是 `config.storage.dir/cli/plugins`，不是 workspace 路径。

协议与 CLI：

- `plugins/consent`（grant / revoke）；`plugins/enable` 未同意时返回 `data.code = plugin_consent_required`。
- `nibi plugins enable --accept-permissions`。

UI：

- 启用 / 安装后需要同意时弹权限同意框；详情“更多”区展示权限并支持撤销。
- 部分可用插件只显示一行原因。

## 5. 扩展运行时

扩展代码只拿宿主能力，不给模型注册工具；要给模型工具就带 MCP server。

| 能力 | 行为 |
|---|---|
| `nibi.sessions.read` | 当前工作区会话列表；只返回 id / parentId / title / createdAt / updatedAt |
| `nibi.workspace.files.read` | 工作区内文件读取；拒绝 `.env*`、`*.pem`、`*.key`、`.ssh/**`、`.aws/**`、`.nibi/**`、`.git/config` |
| `nibi.ui.view` | 打开自己清单里的 `ui.surfaces[]`，复用侧栏标签页；没有活动会话时不打开 |
| `nibi.settings.own` | 读写插件自己的 `settings.json` |
| `nibi.notifications.show` | 应用内通知；限 1/分钟、20/天 |

进程模型：

| 信任 | 层级 | 进程 |
|---|---|---|
| builtin / official | T1 | 共享扩展宿主 |
| community | T2 | 共享独立扩展宿主 |
| local | T3 | 每个插件独立进程 |

实现锚点：`apps/nibi-cli/packages/bootstrap/src/plugins.ts` 的 `extensionTier`（trust → tier）与
`spawnHost`（按 tier 分组 `spawn` 子进程）；桌面 Host 经 `activatePluginExtensions` 走同一路径。

- 桌面：扩展宿主随桌面 Host 进程激活（某工作区首次读取插件面时，按工作区去重）；子进程 JSON-line 协议、`--max-old-space-size=256`，Node 支持时加 `--permission` 限制文件系统。
- Node app-server / CLI：同一份 `activatePluginExtensions` 实现；无 UI 的宿主 `ui.view` 返回 `capability_unavailable`。
- 扩展事件经 `IPluginManagementService` 到 renderer。返回 `Event` 的方法必须命名为 `onDynamicXxx`：RPC proxy 把 `onXxx` 当事件属性并序列化返回值，会导致 renderer 拿到非函数。
- 远端工作区不运行本机扩展代码。

UI 插槽：

- `composer.status`：输入框工具条入口。
- `nav.primary`：主导航入口；没有活动会话时不显示。
- 两者都走现有侧栏标签页链路，不新开页面系统。

## 6. 安装前声明

`plugins/describe` 对可解析的未安装候选返回 `declaration`：

- `permissions.requested/required`、`capabilities.requested/granted`、`hasCodeRuntime`、`trust`；
- 不暴露入口路径；
- 付费未授权、源不可解析、`strict:false` 合成条目没有声明，UI 不渲染占位。

## 7. 生命周期与远程

- 插件集合属于 workspace runtime：安装、启用、停用、更新、授权变化在 App 重建后生效；不热加载、不自动重启、不打断任务。
- 远端 workspace 的插件运行时在远端 Host，本机只读管理面不冒充远端插件。
- 插件 UI 面板是本地沙箱页面；远端会话不打开本机面板。

## 8. 已知边界

- 19 个 enum-only Hook 事件不会触发。
- 代码插件不能注册模型工具、不能直连模型。
- 外来生态的代码面不运行；声明式组件只读加载。
- `pluginId` 保持 `<name>@<marketplace>` 作为持久化/安全主键；`PluginMetadata.origin` 已提供派生的 `builtin` / `official` / `community` / `local` / `external:<adapterId>` 口径，但尚未进入协议或 UI（仅展示/诊断预留）。
- 付费插件在安装前可能没有可展示声明（会员门禁/源不可达）；这是有意留空。
- 插件 e2e 本批 12 个手动复核用例已在真机全部通过（首批 3 个 + 第二批 8 个 + 第三批 1 个；`plugin-subagent-override-cold` 在第三批修复 Rust 子代理覆盖后通过），含重启式 `ui.view` 面板、市场 roundtrip 与异步 Agent 的插件模型覆盖；case manifest 与 provider fixture 已补齐，promotion 与 Docker admission 仍待人工审核后执行。`plugins/manual-review/pending` 下另有 6 个旧候选用例（concurrent-install、lifecycle-telemetry、localization-creator、installed-menu-layout、store-auto-refresh 两个）不在本批范围，未复验。
- 子代理选择回退策略（`selectionFallback` 的 `capability` 档）在 Node 派发路径上也没有生效（`getSubagentSelectionFallback` 未被消费）；Rust 与 Node 一样按 `fail` 处理，不在解析失败时悄悄换模型。

## 9. 验证

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm --filter @nibi/adapters test
pnpm --filter @nibi/bootstrap test
(cd kernel && cargo test --locked --workspace)
pnpm architecture:check
pnpm check:i18n-keys
```

桌面 e2e：

```bash
# 基础启动（真机 Electron）
pnpm --filter @nibi/desktop test:e2e -- --spec test/e2e/smoke.test.ts

# 插件 pending spec（需要手动复核模式与 replay fixture）
NIBI_E2E_MANUAL_REVIEW=1 \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
pnpm --filter @nibi/desktop test:e2e -- --spec <spec-path>
```

## 相关文档

- [扩展运行时 v1](../plugin-extension-runtime.md)
- [插件 Hook 兼容](../plugin-hooks-compat.md)
- [Workspace 级插件架构](workspace-level-plugin-architecture.md)
- [插件市场 UI/UX](../plugin-marketplace-ui-ux.md)
- [插件能力与设置](../plugin-capabilities-settings.md)

# 插件用例转正：人工视觉复核材料（2026-11-23）

> 状态：**待复核**（`Human review: pending`）。本材料只用于人工看画面与行为，不代表已批准。
> 复核通过后才执行 `e2e:promote:plugins -- --reviewed --apply`、Docker admission 与正式 CI preset。
> 截图来自 2026-11-22 的 Windows 真机 manual-review 运行，存放在
> `packages/desktop/.e2e-artifacts/plugin-management/`（不入库）。文案与画面与当前产品一致；
> 唯一在 2026-11-23 变过的是子代理工具面，相关两例的重跑结论见文末「复核前重跑结果」。

## 复核范围（12 例）

| # | 矩阵项 | Pending spec | 状态 |
| --- | --- | --- | --- |
| 1 | `PLM-LC-001/002` | `plugins/…/plugin-management-discovery-presentation` | 2026-11-22 通过 |
| 2 | `PLM-LC-003` | `plugins/…/plugin-management-personal-lifecycle` | 2026-11-22 通过 |
| 3 | `PLM-LC-004/005` | `plugins/…/plugin-management-persistence-source` | 2026-11-22 通过 |
| 4 | `PLM-LC-006/009` | `plugins/…/plugin-management-builtin-inline` | 2026-11-22 通过 |
| 5 | `PLM-LC-007` | `plugins/…/plugin-cdn-zip-marketplace-install` | 2026-11-22 通过 |
| 6 | `PLM-LC-008` | `plugins/…/plugin-management-recoverable-failures` | 2026-11-22 通过 |
| 7 | `PLM-LC-010` | `plugins/…/plugin-runtime-env-agent-projection` | 2026-11-22 通过 |
| 8 | `PLM-UI-001` | `plugins/…/plugin-management-ui-market` | 2026-11-22 通过 |
| 9 | `PLM-BUILTIN-UI-UNINSTALL` | `plugins/…/plugin-builtin-ui-uninstall` | 2026-11-22 通过（两次） |
| 10 | `PLM-UI-VIEW` | `plugins/…/plugin-extension-ui-view` | 2026-11-22 通过（两次） |
| 11 | `WPL-015` | `conversation-session/…/conversation-session-plugin-marketplace-installed-roundtrip` | 2026-11-22 通过 |
| 12 | `PLM-LC-020` | `plugins/…/plugin-subagent-override-cold` | 2026-11-22 连续三次通过 |

矩阵与本表的判定在 `plugin-management-lifecycle-e2e-coverage-matrix.md`；11 例走
`pnpm --filter @nibi/desktop e2e:promote:plugins`（已确认各自的 case manifest 与上游 fixture 在场），
`WPL-015` 属会话内用例，走 `e2e:promote`（会话矩阵路径，fixture 齐备）。

## 分组一：商店发现与展示（PLM-LC-001/002）

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [detail-from-card.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-001/detail-from-card.png) | 从市场卡片进入插件详情：面包屑「插件市场 › 生命周期测试插件」、左上「浏览全部插件」返回、右上「安装」、示例 prompt 块与「信息」区 | 返回路径与安装入口位置、示例 prompt 的呈现 |
| [manage-installed.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-001/manage-installed.png) | 「插件管理 · 本机 · 用户」列表：已安装 1 + 内置 14、刷新/浏览插件/添加入口 | 列表分组、开关与「默认」标注 |
| [back-to-chat.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-001/back-to-chat.png) | 从商店返回对话后的空会话态 | 返回后草稿/会话未被商店打断 |
| [zh-nibi-light-wide.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-002/zh-nibi-light-wide.png) | 中文 · 浅色 · 宽屏：公开市场「e2e-plugin-lifecycle-market」分组卡（1 主卡 + 7 张 Extra） | 卡片不溢出、分组标题与「收起」位置 |
| [en-nibi-dark-narrow.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-002/en-nibi-dark-narrow.png) | 英文 · 深色 · 窄屏同页 | 窄屏换行/裁切、深色对比度 |

## 分组二：生命周期、失败与资源投影

### PLM-LC-003 个人来源主生命周期

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [uninstalled-components-after-install.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-003/uninstalled-components-after-install.png) | 未安装时的详情：右上「安装」，「安装后可查看这个插件包含的组件。」+ 信息区 | 未安装态不给组件清单、提示文案清楚 |
| [installed-five-components.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-003/installed-five-components.png) | 安装后详情逐段列出组件：MCP 服务器 1（lifecycle）、技能 1、命令 1、子智能体 1、Hooks（SessionStart） | 五类组件齐全、中文分类名与图标一致 |
| [updated-v2-detail.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-003/updated-v2-detail.png) | v2 升级后：右上三条提示（已停用/已启用/发现 1 个插件可更新），主卡版本 2.0.0 | 更新提示不重叠、版本号已刷新 |

### PLM-LC-004/005 持久化与来源孤立

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [orphaned-installed-detail.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-005/orphaned-installed-detail.png) | 删除市场来源后：详情顶部黄色提示「市场来源已缺失。插件仍可使用，但暂时无法更新。」，组件清单仍在 | 提示措辞与保留可用性；「立即试用」仍可用 |

### PLM-LC-006/009 内置抑制恢复与 inline

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [restorable-builtin.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-006/restorable-builtin.png) | 市场「应用插件」分组里内置 Word 文档仍以卡片出现（可恢复/重装） | 内置卸载后可找回，不静默消失 |
| [inline-manage-smoke.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-009/inline-manage-smoke.png) | 插件管理页：已安装 1（E2e Inline Lifecycle · User 默认）+ 内置 14，行内开关 | inline 行内的开关/菜单可用，无错位 |

### PLM-LC-007 本地官方 CDN ZIP

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [official-cdn-local-detail.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-007/official-cdn-local-detail.png) | 「插件市场 › E2e Cdn Zip Plugin」详情：安装按钮、版本 7.8.9、「高级信息」折叠 | 从卡片与详情两个入口都能装；版本信息正确 |

### PLM-LC-008 可恢复失败

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [invalid-source-error.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-008/invalid-source-error.png) | 「添加插件市场」弹窗：风险提示 + 红色错误 `Marketplace source path does not exist: D:\…\fixtures\missing-marketplace`，输入框仍保留原路径 | **错误为英文**且显示本机绝对路径，是否接受（见「观察点」）；勾选后可重试 |
| [describe-failure.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-008/describe-failure.png) | 详情内黄色条「组件清单加载失败，仅展示可得信息。」+ 右侧「重试」 | 失败不吞掉已有信息，重试入口显眼 |
| [catalog-refresh-failure.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-008/catalog-refresh-failure.png) | 目录刷新失败时的市场页（错误条 + 旧列表保留） | 旧列表不被清空 |

### PLM-LC-010 secret env 与 agent 资源

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [installed-mcp-and-agent.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-010/installed-mcp-and-agent.png) | 安装详情：MCP 服务器 1（secret-verifier）、子智能体 1（secret-auditor） | 只有一个 MCP + 一个 agent，描述正确 |
| [mcp-secret-env-resolved.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-010/mcp-secret-env-resolved.png) | 会话里真实调用 `mcp__plugin_e2e-plugin-secret-agent_secret-verifier__verify_secret_env`，返 `upstream-e2e-ok` | 环境变量被解析、结果可见；截图与运行日志无 synthetic secret |
| [single-plugin-agent-resource.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-010/single-plugin-agent-resource.png) | 设置 › 子智能体：插件分组「E2e Plugin Secret Agent 1 项」只有 secret-auditor 一行，另有内置 general-purpose / Explore | 同一插件只出现一个规范资源，不重复 |

## 分组三：UI 市场与扩展面板

### PLM-UI-001（16 张，按顺序看）

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [01-market-header-public.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/01-market-header-public.png) | 公开市场页头：分段（公开/社区/个人）+ 刷新/添加/插件管理，下载来源说明与更新时间 | 页头控件分组；**页头下一行又出现一组「公开/个人」**，是否为设计意图（见「观察点」） |
| [02-market-community.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/02-market-community.png) | 社区空态「暂无社区插件」 | 空态居中与留白观感 |
| [03-market-personal-ui-section.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/03-market-personal-ui-section.png) | 个人市场里的「UI 插件」专区 | 专区命名与卡片分组 |
| [04-install-failure-before-retry.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/04-install-failure-before-retry.png) | 安装失败：红色条 `Unsupported or missing plugin source: ./plugins/e2e-plugin-lifecycle`，列表与卡片未丢 | **英文原始错误**直接上屏，是否接受 |
| [05-installed-ui-card.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/05-installed-ui-card.png) | 个人市场已安装卡片置顶（生命周期测试插件）+ 分组列表 | 已安装态样式不抢焦点 |
| [06-main-nav-card-no-open.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/06-main-nav-card-no-open.png) | 主区卡片态：未安装/未启用时不给「打开」 | 入口可用性规则 |
| [07-main-nav-detail.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/07-main-nav-detail.png) | 主区详情态（UI 插件详情） | 组件与按钮排布 |
| [08-side-pane-launcher.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/08-side-pane-launcher.png) | 侧栏 launcher（插件 UI 入口） | 侧栏入口位置 |
| [09-side-pane-market-open-button.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/09-side-pane-market-open-button.png) | 侧栏「打开市场」按钮 | 与主区入口一致性 |
| [10-ui-opened-in-session.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/10-ui-opened-in-session.png) | 会话右栏真实打开插件 UI（MCP 沙箱），页面标题为 fixture 长文本 | 面板内出现**横向滚动条**（见「观察点」）；关闭会话不卸载 |
| [11-side-pane-manage-open-button.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/11-side-pane-manage-open-button.png) | 侧栏「管理/打开」入口 | 入口文案 |
| [12-project-override.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/12-project-override.png) | 工作区覆盖：提示「这里的修改仅影响当前工作区，并会覆盖 User 默认。」+「本工作区覆盖」标注 | 覆盖语义是否表达清楚 |
| [13-paused-main-nav-detail.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/13-paused-main-nav-detail.png) | 项目内已暂停后的详情（顶部提示「已在当前工作区停用…（覆盖 User 默认）」） | 暂停态提示 |
| [14-side-pane-paused-enable-button.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/14-side-pane-paused-enable-button.png) | 侧栏暂停态下的「启用」按钮 | 暂停后仍可启用 |
| [15-paused-enables-and-opens.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/15-paused-enables-and-opens.png) | 从侧栏启用后直接打开 UI | 启用→打开的链路 |
| [16-more-menu.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/16-more-menu.png) | 更多菜单（安装/更新/卸载等） | 菜单项齐备与顺序 |

### PLM-BUILTIN-UI-UNINSTALL

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [restorable-in-ui-section.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-builtin-ui-uninstall/restorable-in-ui-section.png) | 卸载内置 Word 文档后的市场「应用插件」：Word 文档回到可安装卡片，其余三件套仍在 | 卸载后归属 UI 分组且可恢复 |

### PLM-UI-VIEW

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [extension-surface-open.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-view/extension-surface-open.png) | 重启后经插件设置激活扩展：任务右栏出现「E2E UI View」页签，内容 `E2E_UI_VIEW_READY` | 面板挂载与非空内容；页签图标/关闭 |

## 无截图的两例（证据形态不同）

- `WPL-015`（`conversation-session-plugin-marketplace-installed-roundtrip`）：断言全局安装后返回对话、
  User/Workspace 配置往返与恢复继承，证据是 provider capture 与配置断言，没有截图；如需画面证据，
  可以在该 spec 里补 `capturePluginManualReview` 后重跑。
- `PLM-LC-020`（`plugin-subagent-override-cold`）：断言重启后 child 用保存的 `deepseek-v4-pro` +
  `high`、父 continuation 保持 `deepseek-v4-flash` + `max`，证据是两侧 provider 请求；没有可看的产品画面
  （最多是 Agent 卡与设置页），如需可补截图。

## 复核前重跑结果（2026-11-23，内核已含 `RespondToCoordinator`/`TaskOutput`）

- `WPL-015`（`conversation-session-plugin-marketplace-installed-roundtrip`）：**已在新内核重跑通过**
  （`desktop-e2e-20261123-111904-984`）。该 spec 有 case-local replay fixture，走回放即可。
- `PLM-LC-020`（`plugin-subagent-override-cold`）：**本轮无法在我这边重跑**。它没有 case-local
  replay fixture，manual-review 路径被判为 `capture`，需要真实上游凭据（
  `E2E_PROVIDER_BASE_URL` + `E2E_PROVIDER_API_KEY`，或对应 preset 的 key 环境变量）；本轮运行在
  root beforeAll 就报 `E2E_PROVIDER_HTTP_MODE=capture with env requires E2E_PROVIDER_BASE_URL`，
  没有跑进用例。证据仍用 2026-11-22 的三次真机通过（`desktop-e2e-20261122-190909-040`、
  `…191148-892`、`…192851-624`）。同一路径今天的替代证据是 SX 的连续三次（child 使用插件/自定义
  子代理的模型与档位、父 continuation 保持主模型）：`desktop-e2e-20261123-053033-640`、
  `…053302-944`、`…053509-741`。
  如果你要 LC-020 的当日新证据，需要用你的上游凭据环境跑（或把凭据放进本机环境后让我跑）。

## 复核时我会关心的观察点（不是结论，等你的判断）

1. 失败文案中英文混排：`04-install-failure-before-retry` 与 `invalid-source-error` 的错误行是英文原文，
   而界面其余是中文。要么接受（原始错误直出便于排查），要么排期做本地化。
2. 错误里出现本机绝对路径（`D:\…\fixtures\missing-marketplace`）：这是用户输入路径的原文回显，
   在别人电脑上会是他们自己的路径；确认是否接受。
3. `10-ui-opened-in-session` 与 `extension-surface-open` 的插件 UI 面板内出现横向滚动条（fixture 页面内容超宽）。
   如果这是插件页面自身不响应宽度，需要给插件 UI 约定“最小宽度”或用例标明。
4. 市场页首页头下一行重复了一组「公开/个人」：确认是设计（市场分段 + 来源范围两级）还是多余重复。
5. `single-plugin-agent-resource` 里内置 `Explore` 显示「7 个工具」：这是设置页按 agent 定义算的 UI 计数，
   与今天子代理工具面变化无关，仅提示你在看这张图时的口径。

## 复核通过后的动作（等你点头才做）

```bash
# 每个插件 spec 单独一遍（脚本会移动文件、改写 import、更新 manifest 与矩阵路径）
pnpm --filter @nibi/desktop e2e:promote:plugins -- \
  --spec ./test/e2e/plugins/manual-review/pending/<case>.test.ts --reviewed --apply
# WPL-015 走会话路径
pnpm --filter @nibi/desktop e2e:promote -- \
  --spec ./test/e2e/conversation-session/manual-review/pending/conversation-session-plugin-marketplace-installed-roundtrip.test.ts --reviewed --apply
```

随后按 admission 规则跑 Docker 隔离用例与 `plugins` preset，再进正式 CI。

## 不在本次复核范围

- `plm-ui-fail/*`、`plm-declaration/*` 是失败诊断与旧截图，不是验收材料。
- `PLM-LC-017/018/019/021-023`（安装行菜单、自动刷新、本地化 creator）本轮未复验，仍在 pending 列表。
- `PRA/PBD/PBO/PBS` 目前没有对应的 pending spec 文件，按 planned 计。

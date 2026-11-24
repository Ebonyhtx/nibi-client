# 插件用例转正：人工视觉复核材料（2026-11-23）

> 状态：**已复核通过、已转正、Docker 准入完成**（2026-11-24）。运营者逐例确认 12 例全部通过；
> 11 例插件域已执行 `e2e:promote:plugins --reviewed --apply`，WPL-015 已执行
> `e2e:promote --reviewed --apply`。11 个插件 spec 全部通过 Linux `replay-isolated` 容器准入并进入
> `plugins-verified`（preset 11/11，`desktop-e2e-20261124-001357-684`）；WPL-015 进入
> `conversation-session-verified`（preset 4/4，`desktop-e2e-20261124-002711-151`）。
> 截图存放在 `packages/desktop/.e2e-artifacts/plugin-management/`（不入库）。原始证据来自 2026-11-22
> Windows 真机 manual-review；2026-11-23 修掉「公开/个人」重复分段与错误文案语言后，受影响用例
> 已用 replay fixture 重跑刷新截图；`plugin-management-ui-market` 已于 2026-11-24 在带 ffmpeg 的
> 环境完整绿跑（`desktop-e2e-20261123-160205-155`）。

## 复核范围（12 例）

| # | 矩阵项 | Spec（已转正） | 状态 |
| --- | --- | --- | --- |
| 1 | `PLM-LC-001/002` | `plugins/…/plugin-management-discovery-presentation` | 已转正 · Docker verified |
| 2 | `PLM-LC-003` | `plugins/…/plugin-management-personal-lifecycle` | 已转正 · Docker verified |
| 3 | `PLM-LC-004/005` | `plugins/…/plugin-management-persistence-source` | 已转正 · Docker verified |
| 4 | `PLM-LC-006/009` | `plugins/…/plugin-management-builtin-inline` | 已转正 · Docker verified |
| 5 | `PLM-LC-007` | `plugins/…/plugin-cdn-zip-marketplace-install` | 已转正 · Docker verified |
| 6 | `PLM-LC-008` | `plugins/…/plugin-management-recoverable-failures` | 已转正 · Docker verified |
| 7 | `PLM-LC-010` | `plugins/…/plugin-runtime-env-agent-projection` | 已转正 · Docker verified |
| 8 | `PLM-UI-001` | `plugins/…/plugin-management-ui-market` | 已转正 · Docker verified |
| 9 | `PLM-BUILTIN-UI-UNINSTALL` | `plugins/…/plugin-builtin-ui-uninstall` | 已转正 · Docker verified |
| 10 | `PLM-UI-VIEW` | `plugins/…/plugin-extension-ui-view` | 已转正 · Docker verified |
| 11 | `WPL-015` | `conversation-session/…/conversation-session-plugin-marketplace-installed-roundtrip` | 已转正 · Docker verified |
| 12 | `PLM-LC-020` | `plugins/…/plugin-subagent-override-cold` | 已转正 · Docker verified |

矩阵与本表的判定在 `plugin-management-lifecycle-e2e-coverage-matrix.md`；11 例走
`pnpm --filter @nibi/desktop e2e:promote:plugins`（已确认各自的 case manifest 与上游 fixture 在场），
`WPL-015` 属会话内用例，走 `e2e:promote`（会话矩阵路径，fixture 齐备）。

## 分组一：商店发现与展示（PLM-LC-001/002）

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [detail-from-card.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-001/detail-from-card.png) | 从市场卡片进入插件详情：面包屑「插件市场 › 生命周期测试插件」、左上「浏览全部插件」返回、右上「安装」、示例 prompt 块与「信息」区 | 返回路径与安装入口位置、示例 prompt 的呈现 |
| [manage-installed.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-001/manage-installed.png) | 「插件管理 · 本机 · 用户」列表：已安装 1（生命周期测试插件）、刷新/浏览插件/添加入口；replay HOME 未播种内置插件，所以没有「内置 14」分区 | 列表分组、开关与「默认」标注 |
| [back-to-chat.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-001/back-to-chat.png) | 从商店返回对话后的空会话态 | 返回后草稿/会话未被商店打断 |
| [zh-nibi-light-wide.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-002/zh-nibi-light-wide.png) | 中文 · 浅色 · 宽屏：单行分段（公开/社区/个人）+ 来源说明与更新时间 + 「e2e-plugin-lifecycle-market」分组卡（1 主卡 + 7 张 Extra） | 分段只剩一处、卡片不溢出、分组标题与「收起」位置 |
| [en-nibi-dark-narrow.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-002/en-nibi-dark-narrow.png) | 英文 · 深色 · 窄屏同页 | 窄屏换行/裁切、深色对比度 |

## 分组二：生命周期、失败与资源投影

### PLM-LC-003 个人来源主生命周期

| 截图 | 画面 | 请确认 |
| --- | --- | --- |
| [uninstalled-components-after-install.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-003/uninstalled-components-after-install.png) | 未安装时的详情：右上「安装」，「安装后可查看这个插件包含的组件。」+ 信息区 | 未安装态不给组件清单、提示文案清楚 |
| [installed-five-components.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-003/installed-five-components.png) | 安装后详情逐段列出组件：MCP 服务器 1（lifecycle）、技能 1、命令 1、子智能体 1、Hooks（SessionStart） | 五类组件齐全、中文分类名与图标一致 |
| [updated-v2-detail.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-003/updated-v2-detail.png) | v2 升级后：右上三条提示（已停用/已启用/发现 1 个插件可更新），主卡版本 2.0.0；分段只剩页头一处 | 更新提示不重叠、版本号已刷新、分段不再重复 |

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
| [invalid-source-error.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-lc-008/invalid-source-error.png) | 「添加插件市场」弹窗：风险提示 + 红色错误「插件市场来源路径不存在：D:\…\fixtures\missing-marketplace」，输入框仍保留原路径 | 错误已按界面语言出中文、只保留路径原文；勾选后可重试 |
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
| [01-market-header-public.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/01-market-header-public.png) | 公开市场页头：分段（公开/社区/个人）+ 刷新/添加/插件管理，下载来源说明与更新时间；重复的「公开/个人」已移除 | 页头控件分组、单一分段行 |
| [02-market-community.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/02-market-community.png) | 社区空态「暂无社区插件」 | 空态居中与留白观感 |
| [03-market-personal-ui-section.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/03-market-personal-ui-section.png) | 个人市场里的「UI 插件」专区 | 专区命名与卡片分组 |
| [04-install-failure-before-retry.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/04-install-failure-before-retry.png) | 安装失败：红色条「无法识别的插件来源：./plugins/e2e-plugin-lifecycle」，列表与卡片未丢 | 错误已按界面语言出中文、只保留来源原文；列表未被清空 |
| [05-installed-ui-card.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/05-installed-ui-card.png) | 个人市场已安装卡片置顶（生命周期测试插件）+ 分组列表 | 已安装态样式不抢焦点 |
| [06-main-nav-card-no-open.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/06-main-nav-card-no-open.png) | 主区卡片态：未安装/未启用时不给「打开」 | 入口可用性规则 |
| [07-main-nav-detail.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/07-main-nav-detail.png) | 主区详情态（UI 插件详情） | 组件与按钮排布 |
| [08-side-pane-launcher.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/08-side-pane-launcher.png) | 侧栏 launcher（插件 UI 入口） | 侧栏入口位置 |
| [09-side-pane-market-open-button.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/09-side-pane-market-open-button.png) | 侧栏「打开市场」按钮 | 与主区入口一致性 |
| [10-ui-opened-in-session.png](../../packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/10-ui-opened-in-session.png) | 会话右栏真实打开插件 UI（MCP 沙箱），页面标题为 fixture 长文本 | 面板内出现**横向滚动条**（fixture 页面超宽，已确认接受）；关闭会话不卸载 |
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

## 重跑记录（2026-11-23，内核已含 `RespondToCoordinator`/`TaskOutput`）

manual-review 路径默认按 capture 跑真实上游；这里用 `E2E_PROVIDER_REPLAY_FIXTURE_PATH=<case fixture>`
显式切回放，所以不需要真实凭据。除 `plugin-management-ui-market`（需要 ffmpeg 录制窗口视频，本机没有）
外都重跑通过：

| 用例 | Run | 结果 |
| --- | --- | --- |
| `plugin-management-discovery-presentation` | `desktop-e2e-20261123-145512-672` | 通过（截图已刷新） |
| `plugin-management-personal-lifecycle` | `desktop-e2e-20261123-145743-815` | 通过（截图已刷新） |
| `plugin-management-builtin-inline` | `desktop-e2e-20261123-145954-320` | 通过（截图已刷新） |
| `plugin-builtin-ui-uninstall` | `desktop-e2e-20261123-150444-993` | 通过（截图已刷新） |
| `plugin-management-recoverable-failures` | `desktop-e2e-20261123-150704-211` | 通过（截图已刷新） |
| `plugin-subagent-override-cold` | `desktop-e2e-20261123-150914-021` | 通过（LC-020 当日新证据；无截图） |
| `conversation-session-plugin-marketplace-installed-roundtrip` | `desktop-e2e-20261123-111904-984` | 通过（WPL-015；无截图） |
| `plugin-management-ui-market` | `desktop-e2e-20261123-150211-154` | 交互跑完、16 张截图已刷新；结尾因 `spawn ffmpeg ENOENT`（窗口录制需要 ffmpeg）判失败。转正前需在有 ffmpeg 的环境重跑一次拿绿 |

注意：replay 环境是隔离 HOME，wdio 只为 `plugin-builtin-ui-uninstall` 播种官方插件缓存，所以
除该用例（和显式 `seedOfficialPluginsViaCli` 的 `plugin-management-builtin-inline`）外，
刷新后的截图里「内置」分区为空。这是环境差异，不是产品变化。

## 复核意见与处理（2026-11-23）

1. **市场页头下一行重复的「公开/个人」**：确认是多余（列表页两处渲染同一个 `segment` 状态）。
   已移除第二组 pill，只保留页头那一处（公开/社区/个人，与搜索同一行）；来源说明与更新时间保留。
   受影响用例用 replay fixture 重跑刷新截图（结果与 run id 见下方“重跑记录”）。
2. **失败文案中英文混排**：已把会直接上屏的市场来源诊断按界面语言映射
   （`settings.plugins.error.source*`：中文界面中文、英文界面英文）；路径/来源等细节保持原文。
   其余服务层诊断（网络、依赖）仍按原文回退，避免为了翻译丢掉排查细节。
3. **错误里回显本机绝对路径**：按你的判断接受。这是用户输入路径的原文回显。
4. **插件 UI 面板内横向滚动条**：确认由 fixture 页面内容超宽导致，接受；放置方式见文末设计说明。
5. `single-plugin-agent-resource` 里内置 `Explore` 显示「7 个工具」：设置页按 agent 定义算的 UI 计数，
   与子代理工具面变化无关，仅提示查看该图时的口径。

## 插件 UI 放在哪里（回答复核问题）

上游（MCP Apps / `@modelcontextprotocol/ext-apps`）：UI 资源挂在工具结果上，宿主只认
`availableDisplayModes` / `preferredDisplayMode` 的 **inline / fullscreen / pip** 三种模式；
协议里没有“插件窗口”或跨会话常驻面板，放置与生命周期由宿主决定（Claude Desktop 这类宿主把
fullscreen 映射到自己的侧面板）。

NIBI 宿主目前的实现：

- **内联**：工具卡里的 plugin-ui 卡片（默认 240px，范围 80–1200）。
- **fullscreen / 手动打开 / launcher**：会话右侧的 plugin-ui tab，按 `parentSessionId` 作用域；
  没有活动会话时入口不显示。
- **入口槽**（插件清单 `ui.surfaces[].slot`）：`composer.status` 在输入框、`nav.primary` 在左侧主导航；
  两者都只是入口按钮，点击仍打开会话侧栏。
- **页面实例**：窗口级 page owner 管理；成功的 UI 工具结果即使会话未挂载也会创建页面；MCP 页面
  不随切会话/离屏自动回收（guest、未保存编辑与后台执行都保留）。所以“换个会话”不会关掉页面，
  只是当前会话看不到那个 tab；回到原会话时复用同一 guest。
- “独立线程”指的是 guest 跑在独立沙箱 WebContents/分区（独立进程与 CSP），不是独立窗口。

如果要做“常驻插件 UI”（比如一直显示上下文窗口组成），协议与宿主目前都没有这个位置，需要新增
一种 NIBI 自己的放置，三个候选：

| 方案 | 行为 | 代价 |
| --- | --- | --- |
| `window.panel` 窗口级常驻侧栏 | 跨会话可见，一直显示同一页面 | 页面租约要从 session 提到 workspace；跨会话数据归属与凭证范围要重新定义 |
| `nav.page` 主区页面 | 点主导航打开占满主区的插件页（像插件市场），不绑定会话 | 会替换对话视图，不是“一直可见” |
| `composer.inline` 输入框内嵌 | 工作区所有会话的输入框区域常驻一小块插件 UI | 空间有限，仍需绑定当前会话 |

“上下文窗口组成”这类宿主数据，更稳的是做成宿主原生面板；插件 UI 更适合随工具结果出现的内容。
这一条需要你定方向后我再排期。

## 转正执行记录（2026-11-24）

- 运营者复核：12 例全部通过。
- 插件域 11 例已逐例执行 `e2e:promote:plugins --reviewed --apply`；WPL-015 已执行
  `e2e:promote --reviewed --apply`，事务审计通过（118 admitted / 0 rejected）。
- 转正后本地 replay 全量：12/12 通过，run `desktop-e2e-20261123-164846-908`（7m00s），
  11 个插件 case 的 `e2e:fixture:check` 全部通过。
- 容器化修复后 Windows 本地复跑：12/12 通过，run `desktop-e2e-20261124-000411-157`（5m53s）。
- `plugin-management-ui-market` 补 ffmpeg 后完整绿跑：run `desktop-e2e-20261123-160205-155`。
- 转正暴露并修复了正式插件 spec 的自动 replay 缺口：`resolvePluginReplayFixturePaths` 过去返回
  fixture 目录（pending 用例由显式 `E2E_PROVIDER_REPLAY_FIXTURE_PATH` 掩盖），正式 spec 走自动
  replay 时 `readFileSync(dir)` 报 EISDIR；现按 case 名加载各自的 case-local fixture 文件。
- Linux Docker 准入：11 个插件 spec 逐条 `replay-isolated` 通过并写入
  `PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC`；`plugins-verified` preset 全量 11/11 通过
  （`desktop-e2e-20261124-001357-684`，5m45s）。
- 会话域 Docker：WPL-015 单 spec 通过并写入 `CONVERSATION_SESSION_VERIFIED_E2E_SPEC`；
  `conversation-session-verified` preset 4/4 通过（`desktop-e2e-20261124-002711-151`，1m13s）。
- 容器化修复：镜像补装 ffmpeg（`ui-market`、`LC-010` 录屏）；`ui-market` 仅在
  `NIBI_E2E_CONTAINER=1` 时播种官方插件（空 HOME 的 `replay-isolated` 容器否则没有公开市场
  卡片；Windows 共享 HOME 不播种，避免给后续 spec 留状态）；harness 把 Docker Desktop
  Windows bind-mount 的瞬态 `ENODATA` 按未落盘重试，并把冷启动工作区等待 10s → 20s。
- 复跑命令保留如下：

```bash
E2E_SPEC_PRESET=plugins-verified pnpm run test:e2e:container
E2E_SPEC_PRESET=conversation-session-verified pnpm run test:e2e:container
```

## 不在本次复核范围

- `plm-ui-fail/*`、`plm-declaration/*` 是失败诊断与旧截图，不是验收材料。
- `PLM-LC-017/018/019/021-023`（安装行菜单、自动刷新、本地化 creator）本轮未复验，仍在 pending 列表。
- `PRA/PBD/PBO/PBS` 目前没有对应的 pending spec 文件，按 planned 计。

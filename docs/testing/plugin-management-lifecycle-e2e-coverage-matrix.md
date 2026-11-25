# Plugin Management Lifecycle E2E Coverage Matrix

本矩阵追踪 [Plugin Management Lifecycle Case Catalog](../plugin-management-lifecycle-case-catalog.md)
中的候选 case 从 manual review 到三平台正式门禁的状态。`manual-review` 不等于默认质量门禁覆盖。

## Coverage status

| Case                                         | Spec abbreviation | UI automation | Runtime/storage evidence                                                                                                  | Human review | Formal spec | Linux Docker | macOS CI | Windows CI |
| -------------------------------------------- | ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------- | ------------ | -------- | ---------- |
| `PLM-LC-001` discovery/navigation            | `PD`              | targeted pass | UI state + screenshot captured                                                                                            | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-002` presentation                    | `PP`              | targeted pass | DOM/a11y/overflow + screenshot captured                                                                                   | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-003` personal main lifecycle         | `PM`              | targeted pass | overview/list/storage + update badge/inline entry + v2 Skill/MCP provider evidence pass                                   | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-004` persistence/local visibility    | `PV`              | targeted pass | restart/config/enabled/workspace B evidence pass                                                                          | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-005` orphan/reassociate              | `PO`              | targeted pass | source/config/enabled + all update entries (menu/detail/badge/inline) absent + fresh-session Skill evidence pass          | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-006` builtin suppress/restore        | `PB`              | targeted pass | suppression/config/data + Catalog/cache preservation + restart evidence pass (Windows, 2026-11-22)                        | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-007` local official CDN              | `PC`              | targeted pass | loopback HTTP ZIP/cache/overview evidence pass                                                                            | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-007b` real CDN smoke                 | `PCS`             | not run       | not captured                                                                                                              | pending      | never       | never        | never    | never      |
| `PLM-LC-008` recoverable failures            | `PF`              | targeted pass | source/refresh/describe/install/update preservation evidence pass                                                         | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-009` inline smoke                    | `PI`              | targeted pass | UI/list + fresh-session Skill invocation evidence pass                                                                    | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-010` secret env/agent projection     | `PEA`             | targeted pass | MCP resolved marker + no-secret capture + one canonical agent row + Electron `capturePage()` video                        | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-011` no-Git GitHub Archive           | `PGA`             | targeted pass | 公网 smoke（真实 Claude Marketplace/plugin HTTP + 缺 Git 诊断），**不进 `plugins-verified` preset、不计入 13/13**；run `desktop-e2e-20260806033745155-p99439-e61ceea7b4c68fcf` | pending      | never       | never        | never    | never      |
| `PLM-LC-012` isolated refresh/atomic cache   | `PRA`             | not run       | planned：pending spec 文件当前不存在（见下方 2026-11-23 复核）                                                             | pending      | planned     | planned      | planned  | planned    |
| `PLM-LC-014` builtin uninstall/detail parity | `PBD`             | not run       | planned：pending spec 文件当前不存在                                                                                        | pending      | planned     | planned      | planned  | planned    |
| `PLM-LC-015` bundled install ownership       | `PBO`             | not run       | planned：pending spec 文件当前不存在                                                                                        | pending      | planned     | planned      | planned  | planned    |
| `PLM-LC-016` seed/cache/runtime separation   | `PBS`             | not run       | planned：pending spec 文件当前不存在                                                                                        | pending      | planned     | planned      | planned  | planned    |
| `PLM-LC-017` installed row menu layout       | `PML`             | targeted pass | user 启用 + Workspace 暂停形成覆盖；行菜单 2 项单行等高 + 截图；本地 `desktop-e2e-20261124-040332-920`；Docker `desktop-e2e-20261124-044245-176` | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-018` official auto refresh throttled | —                 | targeted pass | 进入/重进商店页不刷新；本地 `desktop-e2e-20261124-040849-641`；Docker `desktop-e2e-20261124-045909-1079`                                            | approved     | promoted    | verified     | verified | verified   |
| `PLM-LC-019` official auto refresh on enter  | —                 | targeted pass | 进入商店页自动刷新真实官方市场；run `desktop-e2e-20261124-042719-701`；公网 smoke，never formal CI                                                | approved     | never       | never        | never    | never      |

## 2026-11-24 转正执行

- 已转正插件 spec（11）：`plugin-management-discovery-presentation`、`plugin-management-personal-lifecycle`、
  `plugin-management-persistence-source`、`plugin-management-builtin-inline`、`plugin-cdn-zip-marketplace-install`、
  `plugin-management-recoverable-failures`、`plugin-runtime-env-agent-projection`、`plugin-management-ui-market`、
  `plugin-builtin-ui-uninstall`、`plugin-extension-ui-view`、`plugin-subagent-override-cold`。
- 已转正会话域 spec（1）：`conversation-session-plugin-marketplace-installed-roundtrip`（WPL-015）。
- 转正后本地 replay：12/12 通过（`desktop-e2e-20261123-164846-908`）。
- Linux Docker：11 条插件 spec 逐条 `replay-isolated` 通过并写入 `plugins-verified` preset；
  preset 全量 11/11 通过（`desktop-e2e-20261124-001357-684`）。
- 会话域 Docker：WPL-015 单 spec 通过并写入 `conversation-session-verified`；preset 4/4 通过
  （`desktop-e2e-20261124-002711-151`）。
- 镜像补装 ffmpeg（两条录屏 spec）；`plugin-management-ui-market` 增加官方插件播种，
  修复容器空 HOME 下公开市场没有卡片；harness 对 Docker Desktop bind-mount 的瞬态
  `ENODATA` 重试，并把冷启动工作区等待从 10s 提到 20s。

## Candidate spec paths

2026-09-09 历史记录（PLM-LC-020 后随异步 Agent 变更失效，2026-11-22 第三批修复后重新通过；018/019 另有后续记录）：Todo103 新增/迁接候选：PLM-LC-018/019 对应 `plugins/manual-review/pending/plugin-store-auto-refresh-{throttled,on-enter}.test.ts`；Pro `desktop-e2e-20260909-152018-653` 两例通过。PLM-LC-020 对应 `plugins/plugin-subagent-override-cold.test.ts`，Pro `desktop-e2e-20260909-152419-828` 冷启动 child/父 continuation 请求验证通过，case-local fixture check 通过。三项均未人工晋级；019 保持公网 smoke、不进入正式 CI。

| Abbreviation | Spec                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| `PD` / `PP`  | `plugins/plugin-management-discovery-presentation.test.ts`    |
| `PM`         | `plugins/plugin-management-personal-lifecycle.test.ts`        |
| `PV` / `PO`  | `plugins/plugin-management-persistence-source.test.ts`        |
| `PB` / `PI`  | `plugins/plugin-management-builtin-inline.test.ts`            |
| `PC`         | `plugins/plugin-cdn-zip-marketplace-install.test.ts`          |
| `PCS`        | `plugins/manual-review/pending/plugin-cdn-zip-official-cdn-smoke.test.ts`           |
| `PF`         | `plugins/plugin-management-recoverable-failures.test.ts`      |
| `PEA`        | `plugins/plugin-runtime-env-agent-projection.test.ts`         |
| `PGA`        | `plugins/manual-review/pending/plugin-no-git-github-archive.test.ts`                |
| `PRA`        | `plugins/manual-review/pending/plugin-refresh-atomic-cache.test.ts`                 |
| `PBD`        | `plugins/manual-review/pending/plugin-management-builtin-detail-parity.test.ts`     |
| `PBO`        | `plugins/manual-review/pending/plugin-management-bundled-install-ownership.test.ts` |
| `PBS`        | `plugins/manual-review/pending/plugin-management-seed-runtime-separation.test.ts`   |
| `PML`        | `plugins/plugin-management-installed-menu-layout.test.ts`     |

> 2026-11-23 复核：`PRA`、`PBD`、`PBO`、`PBS` 指向的 pending spec 文件当前不存在（只在本表与 catalog 中有记录），只能按 planned 计，不要理解为已有自动化。
> 2026-11-24：`PD/PP`、`PM`、`PV/PO`、`PB/PI`、`PC`、`PF`、`PEA` 对应的 7 个 spec 已转正为 formal，路径不再带 `manual-review/pending`。

## Latest targeted verification

2026-11-24：运营者已逐例复核通过 12 例，插件域 11 例已执行 `e2e:promote:plugins --reviewed --apply`，
WPL-015 已执行 `e2e:promote --reviewed --apply`。转正后本地 replay 全量 12/12 通过
（`desktop-e2e-20261123-164846-908`），11 个插件 case 的 fixture check 全部通过。复核材料见
[plugin-promotion-review-2026-11-23.md](./plugin-promotion-review-2026-11-23.md)。
Docker admission 已完成：11 个插件 spec 均在 Linux `replay-isolated` 容器逐条通过并写入
`plugins-verified` preset，preset 全量 11/11 通过（`desktop-e2e-20261124-001357-684`）。
本表 `PLM-LC-001..010` 的 Human review / Formal spec / Linux Docker / macOS CI / Windows CI 已全部改为
approved/promoted/verified：`.github/workflows/desktop-e2e-native.yml` 按同一 preset 选集合，
2026-11-24 首次 dev push 实跑两平台均 11/11 通过（run id 见下节）。

## macOS / Windows native CI（2026-11-24）

准入规则 6 要求已准入 preset 在同一份 formal spec 集上由 macOS 与 Windows CI 选中。2026-11-24 首跑结果：
macOS `desktop-e2e-20261124-014702-952`、Windows `desktop-e2e-20261124-014644-086`，两平台各 11/11 通过
（GitHub Actions run 45306709585）。

- Workflow：`.github/workflows/desktop-e2e-native.yml`，矩阵 `macos-latest` + `windows-latest`。
  触发为 `workflow_dispatch` + 范围极窄的 dev push（仅 `scripts/test-desktop-e2e-container.sh`
  或本 workflow 变化时跑 `plugins` 集合）；普通代码推送不消耗 macOS runner（按 10 倍计费）。
- Spec 集不另抄：workflow 调用 `scripts/test-desktop-e2e-container.sh --print-spec <preset>`，
  与 Linux 容器 preset 共用同一份常量。默认 `plugins`（= `plugins-verified`，2026-11-24 转正 017/018 后为 13 条；首跑时为 11 条）；
  可选 `conversation-session`（4 条会话 spec，含 WPL-015）与 `all-verified`（两者并集）。
- 运行方式：构建 debug Rust 内核 + `@nibi/e2e-report`，然后
  `E2E_PROVIDER_HTTP_MODE=replay NIBI_E2E_SPEC=<preset> pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts`；
  replay 使用本地 provider fixture server，不需要 API key 或网络。
- 状态口径：两平台首跑已通过，`PLM-LC-001..010` 的 macOS/Windows CI 两列记 `verified`；
  后续变更若任一平台失败，先改回 `selected` 并保留失败 run id。

## 2026-11-24 下一批转正执行

- 运营者已复核通过 PLM-LC-017/018/019 三例。
- PLM-LC-017/018 已 `e2e:promote:plugins --reviewed --apply` 转正，并补 case manifest 与
  case-local fixture；两条 spec 逐条通过 replay-isolated Docker 准入
  （`desktop-e2e-20261124-044245-176`、`desktop-e2e-20261124-045909-1079`），已写入
  `plugins-verified`；preset 全量 **13/13** 通过（`desktop-e2e-20261124-050210-597`）。
  macOS/Windows native CI 同集合各 **13/13** 通过（macOS `desktop-e2e-20261124-052213-003`、
  Windows `desktop-e2e-20261124-052437-667`；GitHub run 45331930481），两列已记 `verified`。
- PLM-LC-019 运营者复核通过，但按用例目录的 `never formal CI` 保持 manual-review 公网 smoke，
  不转正、不进 Docker/native preset。
- 截图与观察点见 [plugin-review-next-batch-2026-11-24.md](./plugin-review-next-batch-2026-11-24.md)。

## 2026-11-25 全量复验（view-root / Rust / 审计改动之后）

2026-11-25 的改动触及了插件的**运行时读取根**（Node 与 Rust 均改为读 view root）、
Rust 的 `installed_plugins.json` 墓碑过滤、以及商店详情新增的「最近审计」区块。
这三处都在既有 13 条 spec 的覆盖面上，因此重跑了一遍：

| 环境 | 结果 | 说明 |
|---|---|---|
| 干净 worktree（Windows 本机，`replay`） | 12/13 | `plugin-extension-ui-view` 等待 `ui.view` 侧栏超时；产物 `desktop-e2e-20261125-021644-158` |
| macOS native CI | **13/13** | 同集合；GitHub run `45533864397`（commit `b88d5b24`） |
| Windows native CI | **13/13** | 同上 |

`plugin-extension-ui-view` 在两个 CI 平台均通过，本机那次按**环境偶发**记录（该 spec 走 inline
插件路径，不经过本轮改动的 `source === "cache"` 分支）。没有通过跳过、缩小集合或改断言让它变绿。

复验使用干净 worktree（`git worktree add --detach b88d5b24`）构建与运行，避免混入并行会话的
未提交改动；本机内核复用主仓增量编译的 `nibi-rs`（内核源码与 HEAD 一致）。

## 2026-11-25 修复后复验（原生模块门禁 / 同名冲突 / 数据目录 / 生效提示）

第二轮改动触及**安装期原生模块门禁**、**启用时同名冲突拦截**、**插件数据目录权限**与
**安装/启停后的「新会话中生效」提示**，都在 13 条 spec 的覆盖面上，因此重跑：

| 环境 | 结果 | 说明 |
|---|---|---|
| macOS native CI | **13/13** | run `45568243858`（commit `90067a34`，preset `plugins`，11 分 21 秒） |
| Windows native CI | **13/13** | 同 run（首轮 8 分 23 秒全过） |
| Linux 容器 `ci` 预设 | 通过 | run `45564190899`（smoke + 4 条会话 spec；`ci` 预设不含插件 13 条） |

macOS 首跑在 runner 下载 Rust 1.95.0 时 DNS 解析失败（`static.rust-lang.org`），**未进入任何
spec**；对失败作业原样重跑后 13/13 通过，未改测试、未缩集合。

## 2026-11-25 第三轮复验（包 hash 信任 / 自带 Node / hooks 支持度）

第三轮改动落在**发现层同意校验**（同版本换内容按包 hash 停用）、**官方自带 Node 门禁**与
**hooks 事件支持度登记**。前两项直接影响安装/启用路径，因此再次重跑 13 条 spec：

| 环境 | 结果 | 说明 |
|---|---|---|
| macOS native CI | **13/13** | run `45580635329`（commit `b9fe0aba`，preset `plugins`，11 分 22 秒） |
| Windows native CI | **13/13** | 同 run（7 分 02 秒） |

同日单测：adapters **2262**、bootstrap **2803**、contracts **336** 全部通过；typecheck /
architecture / i18n / lint / public-repo 全绿。

2026-07-15 已在 macOS 上逐个运行上述 `PD/PP`、`PM`、`PV/PO`、`PB/PI`、`PC`、`PF`
pending spec，均通过。这些 spec 不得并行共享 E2E HOME；允许同一兼容批次串行运行、各用例隔离 HOME 并共享构建。
截图与 provider capture 已生成，但 2026-07-15 当时尚未完成人工产品审核，因此当时未把
任何 case 标成 `formal`，也没有运行 promotion apply、Docker admission 或正式 CI preset；后续转正记录见上表与 2026-11-24 节。

2026-07-20 已在 macOS 上独立运行 `PEA` pending spec 并通过（run
`desktop-e2e-20260720040616896-p59191-dfc1ae47585cbcf6`）：插件安装详情显示一个 MCP 与一个
agent，Subagents 页面只出现一个规范化插件资源，真实 MCP tool call 返回 resolved marker，provider
capture 与运行日志均不含 synthetic secret。Electron `webContents.capturePage()` 录制生成 2400×1600、
7 秒、28 帧的 VP9 WebM；关键截图与视频已生成，但仍等待人工产品审核。

2026-08-06 已在 macOS 上独立运行 `PGA` pending spec 并通过（run
`desktop-e2e-20260806033745155-p99439-e61ceea7b4c68fcf`）：Agent Git binary 指向不存在的绝对
路径，非 GitHub Git 来源返回 `plugin_git_unavailable`；随后通过 GitHub `zipball/HEAD` 下载真实
Anthropic Claude Marketplace，并按目录中的固定 SHA 安装 `aikido`。Marketplace 与安装缓存均无
`.git`，安装记录保留 URL/SHA，最终 discover 到插件 MCP 组件。该公网 smoke 仍只用于 manual review，
不会晋升为正式 CI 门禁。

2026-08-21 在 Orca 隔离 worktree 完成 Catalog/Runtime 分离的定向回归：Bootstrap 插件生命周期
测试 33/33、Adapters 插件测试 74/74、UI listing/card 测试 20/20；根目录 `pnpm typecheck`
与 `pnpm lint` 通过，lint 仅保留既有 warning。正式手工 E2E（PBD/PBO/PBS）的 spec 尚未创建，仍待独立隔离 HOME
运行和人工审核，不在本次实现中晋升。

2026-09-02 为「已安装列表可更新角标 + 行内更新按钮」补充 `PM`/`PO` 断言（角标与行内入口出现 /
孤立插件不出现），并新增 UI 单测 `packages/ui/test/pluginStoreUpdateEntries.test.ts`（5/5 通过）。
两个 pending spec 未重新运行：它们仍引用已下线的 `plugin-store-manage`、`plugin-store-installed-row`、
`plugin-store-check-updates` 选择器（管理视图已并入 Settings → 插件列表 `plugin-settings-plugin-row`），
需要单独修复后才能再次做 manual review。
（2026-11-22 这两个 spec 已随 pending 用例现代化改到新入口，并在 Windows 复验通过，见下文第二批。）

## Admission rules

1. Pending spec must have deterministic case-local filesystem/provider fixtures and stable selectors.
2. Manual run must produce list/detail/manage/error/presentation evidence relevant to its cases.
3. Human review changes `Human review` to `approved`; only then may promotion move the spec out of pending.
4. Promoted runtime cases must pass fixture check, common+case isolated replay, and default replay.
5. Each compatibility group must pass one isolated Docker spec before admission to the `plugins` preset.
6. The admitted preset must pass on Linux; the same formal spec set must be selected by macOS and Windows CI.

## Explicit exclusions

- `PLM-BC-001` install cancel, `PLM-BC-002` standalone source diagnose, and `PLM-BC-003` inline
  uninstall remain bug candidates rather than failing lifecycle cases.
- Standalone Web、手机 `/remote`、remote workspace plugin sync 与 workspace-scope 安装没有在本矩阵中
  被标记为 covered。

## PLM-STRIP-CLIP：已安装条角标裁切（2026-09-15）

- 用例：`packages/ui/test/browser/manual-review/pending/plugin-installed-strip.test.mjs`，真实 `PluginStoreListView` + 测试动作回调。
- Chrome/macOS 浏览器 8/8 通过：390/1200px × 中英文 × 明暗主题，验证首末项角标和焦点空间、hover 后命中区域、滚动末尾更新点击、无误开详情及页面横向溢出。原样式复现 top=false / hit=false。
- 截图：系统临时目录 `nibi-plugin-strip-clipping/`。根 typecheck、desktop typecheck:e2e、lint、architecture 检查通过，已有更新入口单测 5/5。
- Pending，未晋升；浏览器渲染与点击验证不代表完整 Electron 插件更新、手机真机或 Windows/Linux 验证。

## Plugin Creator 与本地化

PLM-LC-021/022/023：`plugins/manual-review/pending/plugin-localization-creator.test.ts`，pending；2026-09-16 已通过 Electron E2E，2026-11-22 本批未复验、未人工审核。单测补充异步目标失效、完整 ID 隔离、缺失/禁用 creator；不作为真实手机或 SSH 端到端证据。（这三项原写作 PLM-LC-018/019/020，与官方目录刷新和子代理覆盖用例重号，已改为 021/022/023。）

2026-09-16 补充：公开分类与个人市场分组默认全部展开，保留手动收起/展开。PLM-LC-001 的断言同步；plugin-localization-creator E2E 增加 8→6→8 张卡片回归，公开/个人与中英组合由组件交互单测覆盖。

## PLM-MISSING-CONFIG

- 状态：manual-review（非正式 CI 转正）。
- 自动化：`packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs` 中
  `PLM-MISSING-CONFIG`；fixture 经真实 buildStoreItems → PluginStoreListView → 卡片/搜索投影。
- 覆盖：1200/390 宽度、en-US/zh-CN、light/dark；已下架配置不生商品、有目录缺包可安装、新插件不消失。
- 补充：dev Electron 原始配置 → Agent list/overview → Host → Renderer 实测；窄屏浏览器是共享 UI 验证，
  不宣称验证手机真实远控连接。正式隔离 HOME 桌面用例尚未转正。

2026-09-17 验证：`node --test --test-name-pattern=PLM-MISSING-CONFIG packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs` 8/8 通过；dev CDP 验证旧卡片 0、新插件卡片 5、原始 missing 诊断仍保留。重新进入商店后保持结果。

## PLM-DOCUMENT-ORDER（2026-09-17）

默认官方文档插件按 PDF、PPT、Excel、Word 排序。浏览器用例覆盖商店分类和已安装图标条，
桌面/手机 × 中英文 × 深浅主题；预置管理分组、停用、缺项、个人同名隔离及服务端排序优先由单测覆盖。
入口：`packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs`。
此用例属于浏览器展示验证，不作为 Electron 安装生命周期或正式 CI 准入证据。

## PLUGIN-CREATOR-ICON

官方创建器本地图标贯穿商店、`@` 候选、Composer 标签与 Session 消息投影。
`plugin-picker-order.test.mjs` 的 `PLUGIN-CREATOR-ICON` 用例覆盖 catalog 无远端 icon 时打开候选并插入标签，
1200/390、中英、深浅主题；Session 消息及个人市场同名隔离由 `pluginCreatorMentionIcon.test.ts` 覆盖。
状态为 manual-review，不自动转正；不向真实模型发送测试消息。

## 插件市场交互与分类（2026-10-12）

- 2026-10-15 应用插件组内展开回归：`plugin-store-mode-order.test.mjs` 的 `PLM-UI-GROUP` 覆盖公开/社区/个人、默认展示 8 张、原位 8→6→8、其他分类保留、搜索清空和来源往返保留手动选择、键盘操作及宽窄视口的中英/深浅主题。此项为真实浏览器组件交互验证，不代表真实手机远控或 Electron 安装生命周期验证；继续保留 manual-review/pending。

- PLM-LC-001/002：`plugin-management-discovery-presentation.test.ts` 在 macOS Electron 通过，run `desktop-e2e-20261011-170738-518`。覆盖分段搜索、展开/折叠、卡片详情、市场内管理往返与宽窄视口展示。
- PLM-UI-001：`plugin-management-ui-market.test.ts` 在 macOS Electron 中通过，run `desktop-e2e-20261011-170634-701`。覆盖真实安装、已有会话打开 MCP 资源、沙箱握手、关闭不卸载、Side Pane 市场内管理、项目暂停与全局/另一项目隔离、启用后打开、恢复继承和取消/确认卸载。Fixture 静态校验通过；保留 manual-review/pending，不自动晋级。
- 默认推荐浏览器用例：两组已通过，包含未收录开发插件排除、鼠标与键盘打开、标签去重、宽窄视口和双语言主题。
- 原 PLM-STRIP-CLIP 的图标条已删除；对应浏览器测试现覆盖卡片行内更新、焦点可达、管理入口及无横向溢出，8 组通过；另有 UI 详情图片放大、Escape 关闭与焦点返回 2 组通过。原先的历史验证仅代表当时界面。
- 分类与模式排序浏览器回归 18/18 通过：当前分段搜索、默认展开、office 模式、缺包投影及官方文档顺序；保留失败刷新断言。
- 暂未完成真实手机远控、Windows/Linux Electron 验证；窄视口结果不代替这些验证。
- 静态验证：根目录与 CLI 各包 typecheck、root lint、architecture --changed 通过。Root lint 保留既有 warning，架构 0 违规。插件相关 UI 单测 224/224、额外 UI 打开和标签/启动凭据等定向集合通过；CLI bootstrap 生命周期与协议 64/64、目录解析 4/4 通过。
- 截图位于 `packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/`：`real-ui-sandbox.png`、`side-pane-market.png`、`project-override.png`。沙箱图片使用确定性测试页面，不代表默认推荐插件。
- 插件目录仓库：239 项测试中 219 通过、20 跳过；27 个插件通过校验与发布构建，目录迁移前后所有 ZIP 的路径、字节数和 sha256 相同。尚未发布远端目录。

### Review 修复回归（2026-10-12）

- 全局与 scoped 插件投影、远程同步、Source 用户配置、查询合并、错误保留和旧查询失效：`pluginManagementProjectionSync.test.ts` 8/8；包含真实 `useCuaComposerEntry` hook 随市场暂停而隐藏的接线断言。相关 store、错误归属、远程同步、导航和详情组件合计 67/67，启动凭据夹具 5/5。
- 浏览器卡片/详情 12/12：新增已安装 UI 的独立详情按钮，暂停态查看详情不触发打开或启用；覆盖键盘与 390 中文暗色 / 1200 英文亮色组合。
- PLM-UI-001：run `desktop-e2e-20261012-050628-695` 通过；真实安装的已启用/暂停 UI 都可独立进入详情，不写启用状态，不新增 UI tab。
- PLM-LC-001/002：run `desktop-e2e-20261012-050703-560` 通过，补充主导航返回聊天且不落入旧设置管理页。
- WPL-015：run `desktop-e2e-20261012-051242-142` 通过，市场安装后回聊天，再进入 User / Workspace 管理；保存、覆盖、清除字段、暂停及恢复继承均保留原断言。旧脚本的启动就绪、面包屑和菜单恢复入口已同步为当前交互。
- PLM-LC-018：run `desktop-e2e-20261012-051408-560` 通过；离开市场回聊天、从侧栏重进仍命中刷新节流，官方目录更新时间保持不变。
- 根 typecheck、lint、architecture 检查通过。真实手机远控、跨版本混装、Windows/Linux Electron 和公网刷新 smoke 未执行；Source/远程同步目前是 store/service mock 回归，不冒充远程端到端验证。所有用例继续 pending，未晋级。

### 第二轮 Review 故障注入

- 插件测试集 241/241 通过。新增次要投影永不返回/拒绝、远程必要能力不被投影阻塞、项目 A 不刷新项目 B 或远程 surface；安装与恢复的诊断错误不失效草稿或刷新技能，成功时仍收尾。
- PLM-UI-001 run `desktop-e2e-20261012-053949-887` 通过：同时移除原始与 managed 源包，真实安装错误可见且未生成安装记录；恢复源包后重试成功，后续完整 UI 沙箱、项目覆盖、继承和卸载回归通过。
- PLM-UI-001 run `desktop-e2e-20261012-090553-480`、`desktop-e2e-20261012-092305-636`（启动页文案对齐原型后）通过；用例全程录屏为 `plm-ui-001.webm`，并输出步骤时间点 `plm-ui-001.chapters.json`：市场头部与 Side Pane 启动页对齐原型后回归；按 PRD 章节输出 01–15 编号截图（`.e2e-artifacts/plugin-management/plm-ui-001/`），截图前等待有限时长动画结束。回放模型无 high 思考档，运行时设 `E2E_PROVIDER_THOUGHT_LEVEL=` 并显式指定 case fixture。
- root typecheck、lint（0 errors / 222 warnings）、architecture（0 违规）及 E2E typecheck 通过。平台与混装验证限制不变。

### 打开 UI 收敛到会话右侧市场（2026-10-12）

- 规则：主导航市场的卡片与管理页行整行进入详情，没有「打开」「详情」按钮，详情主按钮为「立即试用」；会话右侧市场的卡片、详情、管理页行多一个「打开」（暂停态「启用」，先启用再打开）。
- 浏览器卡片/详情 14/14：新增 `PLM-UI-MAIN-NAV`（主导航无打开、整行进详情、详情为立即试用）；`PLM-UI-DETAILS` 改为键盘回车整卡进详情。
- PLM-UI-001 run `desktop-e2e-20261012-104955-651`、`desktop-e2e-20261012-105655-477`、`desktop-e2e-20261012-105824-912` 通过；步骤截图 06–16 改为主导航无打开 → 右侧市场打开 → 右侧管理页打开 → 项目暂停后右侧「启用」并打开 → 管理页整行进详情恢复继承。用例在主导航断言前关闭右侧市场标签：会话视图后台保持挂载，两份市场并存会让按 testid 取到隐藏的那份。
- 已知偶发：`desktop-e2e-20261012-105221-558` 在主导航第二次进入管理页时等待 `plugin-store-manage` 超时，随后 3 次连跑未复现，原因未定位。

### 服务端 UI 推荐（2026-10-13）

- `side-pane-plugin-menu.test.mjs` 不再替换静态名单模块，改为请求配置响应并通过真实公开配置解析器。
- 1200px / 英文 / Zai Light 和 390px / 中文 / Zai Dark 两组通过：推荐交集、重复项去重、未收录开发插件与未知面板排除、启动页/菜单、键盘打开，以及空配置/请求失败回归。
- 可选 `NIBI_UI_RECOMMENDATIONS_LIVE_CONFIG_URL` 接入真实测试环境配置；本次接口返回 5 条推荐并完成展示和打开参数断言。工作区面板仍由 fixture 提供，不代表真实安装或沙箱运行验收。
- 真实 Host 配置服务连接测试接口：并行读取仅发一次请求，后续读取命中缓存，5 条插件/面板身份与已校验发布包一致。
- Nacos 测试配置保留原有 16 项，只追加 `uiPluginRecommendations`；使用原 MD5 发布、精确回读，并核对公共接口返回。生产配置未修改。
- 未重跑各插件的真实安装与沙箱运行，也未做 Windows/Linux 或真实手机远控实机验证。用例保留 pending，不晋级。

### 推荐区安装与启用（2026-10-13）

- 推荐曝光改用完整目录，未安装与禁用条目仍显示；配置顺序和完整身份去重保持稳定。
- `useRecommendedUiPlugins` 回归覆盖用户级安装、项目级启用、重复点击、失败重试、服务切换与会话切走再切回后的迟到结果隔离；复用现有插件管理 store。
- `side-pane-plugin-menu.test.mjs` 增加启动页和加号菜单的“安装 → 启用 → 再次点击打开”流程，成功后断言没有自动打开；同时断言实际服务请求的 user/workspace scope。安装与启用时菜单保持打开。
- 浏览器夹具模拟安装服务与面板目录；真实 staging 只用于验证推荐配置响应。此轮不重复真实插件安装、沙箱、Windows/Linux 或手机设备验收。

### 推荐加载态（2026-10-13）

- 受控浏览器请求复现：配置尚未返回时旧实现已经显示“No recommended UI plugins yet”。
- 现在配置与完整目录任一仍在加载时显示骨架。浏览器用请求闸门分别释放配置和目录，断言中途不出现空态；另覆盖加号菜单从加载到空配置，以及失败结束加载。宽窄视口与双主题沿用同一组用例。

### 生命周期埋点（2026-10-15）

| Case        | 场景                   | 用例                                                               | 验证                    | 状态               |
| ----------- | ---------------------- | ------------------------------------------------------------------ | ----------------------- | ------------------ |
| PLM-TEL-001 | 插件安装最终结果与隐私 | `plugins/manual-review/pending/plugin-lifecycle-telemetry.test.ts` | macOS Electron 回放通过 | pending，未加入 CI |

验证批次 `desktop-e2e-20261015031949530-p54859-5f1860f2585df3f1`：真实商店详情安装成功，最终 HTTP 出口仅一条 install 结果，含 event_id 和 duration_ms，无 operation_id 和路径。手机白名单、远端同步结果与 MCP 归属由定向单测验证；Windows/Linux 和真实远端安装未运行。

### 后台初始化与执行（2026-10-15）

| Case                        | 场景                                                                                                                                | 入口                                                                                 | 边界                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| PLM-UI-BACKGROUND           | 无锚点/隐藏 tab 冷启动、最小化后首次创建与执行、session 空闲时仍执行且不销毁、删除释放                                              | `mcp-apps-host-e2e.mjs --background-only`                                            | 真实 Electron、生产 owner/Agent/沙箱；受控页面，未晋升 CI                                        |
| PLM-UI-BACKGROUND-ADMISSION | 无卡片挂载和 conversation 订阅的真实工具结果首次创建、后台运行、返回复用；双窗口不同会话的同插件实例保留与释放                      | `mcp-apps-host-e2e.mjs --background-only`                                            | macOS Electron 通过；同窗口并发准入和不同会话键隔离另以单测覆盖，未晋升 CI                       |
| PLM-UI-VISIBILITY           | 保活侧栏收起、切标签、离开聊天/工作区时不可见且不拦点击；后台工作、编辑状态及实例保留，恢复交互                                     | `mcp-apps-host-e2e.mjs --managed-only`                                               | macOS Electron 深浅主题通过；生产组件集成，宿主页面投影另以桌面/手机壳 UT 覆盖，未晋升 CI        |
| PLM-UI-BACKGROUND-CRAFT     | 最小化窗口且无卡片时，真实工具结果触发 WASM 首次初始化；后台图层操作、编辑状态保留与恢复展示截图；切主页面后隐藏 UI、后台编辑并返回 | `mcp-apps-host-e2e.mjs --photocraft-background-only`，设置 `NIBI_PHOTOCRAFT_SERVER` | macOS Electron 通过；未修改的 PhotoCraft 0.2.2，恢复截图包含后台新增图层，不替代商店安装路径验证 |

Web/remote 不支持回退、runtime 失效、内联滚动与页面保留沿用 `--managed-only`。
Windows/Linux、真实手机和其它第三方插件需独立验证。

`PLM-UI-CONNECTION-READY`：`--managed-only` 控制真实 MCP initialize 完成顺序，验证生产
React 面板等待连接后自动运行、无错误闪现和重复实例。2026-10-16 macOS Electron 专项通过；未晋升 CI。
独立 worktree 使用标准命令整组回归，`managed` 27 项、`managed-empty` 1 项、`interaction` 1 项全部通过，
证据批次 `nibi-mcp-host-e2e-f1vN0y`。此前整组运行出现过 guest 崩溃重建超时和锚点切换后
点击断言失败，独立复跑均通过；保留原失败证据，不据此认定稳定性问题已解决。

## PLM-CONCURRENT-INSTALL：并发安装忙碌态

- 浏览器候选：`packages/ui/test/browser/manual-review/pending/plugin-concurrent-install.test.mjs`。真实 store 和安装按钮，390/1200px × 中英文 × 深浅主题共 8 组通过；旧实现 8 组均在第二次安装清掉第一次忙碌态处失败。日志和截图写入系统临时目录的 `nibi-plugin-concurrent-install/`。
- 桌面候选：`plugins/manual-review/pending/plugin-concurrent-install.test.ts`。macOS Electron + 真实 CLI，个人来源本地 HTTP 下载响应门验证两项同时安装中、第一项失败不清理第二项、两项失败后均可重试；运行 `desktop-e2e-20261015143344848-p62610-27dafbf8f737df99` 通过。截图位于 `.e2e-artifacts/plugin-management/plm-concurrent-install/both-pending.png`。
- 离线执行：`NIBI_E2E_MANUAL_REVIEW=1 E2E_PROVIDER_HTTP_MODE=replay E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json pnpm --filter @nibi/desktop test:e2e -- --spec './test/e2e/plugins/manual-review/pending/plugin-concurrent-install.test.ts'`。
- PLM-DETAIL-DURING-INSTALL：同一桌面用例中，A 下载被响应门挂起、B 排在 A 后面时打开本地插件详情，组件区 30 秒内渲染技能，返回后两项仍为安装中。修复后运行 `desktop-e2e-20261019044431890-p93406-b0458048236a975f` 通过，截图 `.e2e-artifacts/plugin-management/plm-detail-during-install/detail-loaded.png`；还原 CLI 修复后运行 `desktop-e2e-20261019044633752-p3203-b44c097feed8ea0d` 在组件区等待处失败。
- 新建右侧标签页骨架屏（list/overview 排队）：同一桌面用例在 A 下载挂起、B 排队时经桌面服务链路请求 `listPlugins` 与 `getPluginsOverview`，要求 10 秒内返回。修复后运行 `desktop-e2e-20261019062945458-p57938-d3a0c643c27817e2` 通过；只还原 transport 的 list/overview 立即派发后，运行 `desktop-e2e-20261019063058281-p64564-98a2c55f0e022488` 在该步失败（`plugins/list and plugins/overview waited for the install`）。现场证据：dev 日志 `listPlugins`/`getPluginsOverview` 耗时 14569 ms，在第二次安装结束 1.4 秒后才返回。
- store 回归覆盖成功乱序、失败、同名操作及上下文切换隔离、来源校验与安装交叠。浏览器成功路径使用受控服务，不等于真实下载成功验证。手机真机/远控、Windows/Linux 未执行；用例 pending，未人工晋升及 CI 准入。

## PLM-BUILTIN-UI-UNINSTALL：内置 UI 插件卸载后的分组

- 桌面候选：`plugins/plugin-builtin-ui-uninstall.test.ts`。macOS Electron + 真实 CLI，卸载 `documents@nibi-official` 后卡片仍在 UI 插件专区。修复后运行 `desktop-e2e-20261019071852360-p65132-d5426628aee5a21e` 通过，截图 `.e2e-artifacts/plugin-management/plm-builtin-ui-uninstall/restorable-in-ui-section.png`；还原 CLI 修复后运行 `desktop-e2e-20261019072006864-p72979-1022c7e87a447a4e` 在 restorable 阶段失败（卡片不在 UI 插件专区）。
- bootstrap 单测：内置定义 `ui` 组件类型与插件包 `ui.surfaces` 一致；卸载后官方目录与可恢复列表都带 `ui`。两条旧实现失败、新实现通过。截至 2026-10-19 仅 macOS 执行；Windows 已于 2026-11-22 复验通过（见下），Linux 与手机远控未执行；用例 pending。

## 2026-11-22 Windows 复验（手动复核，未晋升）

- `PLM-BUILTIN-UI-UNINSTALL`：`plugins/plugin-builtin-ui-uninstall.test.ts` 连续两次通过。为源 E2E 新增按 spec 播种官方插件缓存（`apps/nibi-cli` 作为官方源根，实测 4.7s / 14 插件），`documents@nibi-official` 卸载后仍归在 UI 插件专区；不影响 `installed_plugins.json` 的商店安装语义。
- `WPL-015`：`conversation-session/manual-review/pending/conversation-session-plugin-marketplace-installed-roundtrip.test.ts` 在 Windows 通过。补齐了社区 fixture 安装后的权限同意步骤，并让 scope 选择 helper 支持当前 Projects 子菜单；user/workspace 配置往返与恢复继承全部走完。
- `PLM-EXT-UI-VIEW`（新增）：`plugins/plugin-extension-ui-view.test.ts` 连续两次通过。重启后在隔离 HOME 播种本地扩展插件，扩展经 `nibi.settings.own` 轮询 armed，再调用 `nibi.ui.view`；侧栏 `plugin-ui:…:surface:panel` 激活、`plugin-ui-webview` 挂载、MCP Apps 握手到 `data-plugin-ui-phase="running"`。截图 `.e2e-artifacts/plugin-management/plm-ui-view/extension-surface-open.png`。
- `smoke.test.ts` 在本轮修复 RPC 动态事件命名后通过（真实 Electron 启动 + 工作区/composer）。
- 以上均为 Windows 本机 manual-review 运行，未执行 promotion apply、Docker admission 或正式 CI preset；人工产品审核仍为 pending。
- 2026-11-22 第二批 pending 串行复验：`plugin-management-builtin-inline`、`plugin-management-discovery-presentation`、`plugin-management-persistence-source`、`plugin-management-personal-lifecycle`、`plugin-runtime-env-agent-projection`、`plugin-cdn-zip-marketplace-install` 通过。`plugin-management-recoverable-failures` 在改为真正删除安装缓存与配置登记后通过；`plugin-management-ui-market` 暴露并修复了“项目层禁用后从侧栏启用仍被 workspace false 压住”的产品问题（enable 现在先清 workspace override 再写 user），复验通过。
- `plugin-subagent-override-cold` 仍失败：Agent 改为异步启动后，child 请求使用父模型 `deepseek-v4-flash`，而不是插件 agent 覆盖的 `deepseek-v4-pro`/high；父轮 async 语义与 fixture 已更新，这条作为真实产品缺口保留，不伪造通过（第三批已修复，见下）。

## 2026-11-22 第三批：插件子代理模型覆盖（Windows，手动复核）

- `plugin-subagent-override-cold` 已通过（连续三次：`desktop-e2e-20261122-190909-040`、`desktop-e2e-20261122-191148-892`、`desktop-e2e-20261122-192851-624`；此前 18:50–19:05 的批次失败，作为修复前后的分界保留）。证据：child 请求 `deepseek-v4-pro` + `output_config.effort=high`，父 continuation 保持 `deepseek-v4-flash` + `max`，`pluginAgentModelSelectionOverrides` 落盘未改写。
- 产品修复（Rust 内核，桌面本地默认）：新增 `agents-state.json` 读取面与子代理完整选择解析。`kernel/crates/agents/src/state.rs` 解析当前 `builtInModelSelectionOverrides` / `pluginAgentModelSelectionOverrides`（含旧双 map 迁移语义与 `disabledAgentIds`）；`selection.rs` 解析 `provider/model`、`custom:<providerId>:<modelId>` 与 `thoughtLevel`；`spawn.rs` 按“设置页覆盖 > 定义 pin > 继承父会话”派发，换 Provider 时不沿用父会话的 Team Plan 连接。`crates/cli` 在 CLI/TUI 与 app-server 两个入口把 `<存储根>/v2/agents-state.json` 的读取器接进 `AgentCatalog`（每次取定义重读，改完立即生效）。
- e2e 夹具修复：`seedPersistedModelSelection` 之前只写旧的无作用域 `nibi-model-selection-recent-v1:<path>`，当前 Composer 的 Recent 是 v2 作用域键 `nibi-composer-recent:v2:["desktop",<hostId>,<projectId>]`，导致冷启动父会话退回目录默认档位（high）。helper 现在同时写 v2 键（按已登记的工作区作用域，缺省 Root 草稿）。
- 复核时观察到的既有红项（2026-11-22 记录；SB / SX / BG26 / BG25 已于 2026-11-23 修复）：
  - `conversation-session-built-in-subagent-model-overrides`：2026-11-23 已修复并通过（连续三次：`desktop-e2e-20261122234622659-p128240-cfb050bc454853a4`、`desktop-e2e-20261122234919309-p118752-0dac5828603b8c78`、`desktop-e2e-20261122235230457-p122172-f0e5b6bc527eecb6`）。根因是 Rust V4 投影从不产 `subagent` 行（`KernelEvent::Subagent` 被忽略；冷投影缺 `Fact::SubagentLinked` 读取与 source-less 初始 marker），且冷行必须紧跟父 Agent 工具行才能进入同一 work segment。Explore 工具面按 Rust 实际集断言（`RespondToCoordinator` 已落地、`SendMessage` main-only）；工具面同日调整后 SB 再次连续三次真机通过（run id 见子代理矩阵注记）。
  - `conversation-session-subagent-runtime-catalog-reasoning`：2026-11-23 已修复并连续三次真机通过（`desktop-e2e-20261123-012520-097`、`...012754-446`、`...013003-197`）。修复设置页非法历史档位显示原值、主动切模型落目标默认档位；同步校正异步 parent continuation 的 `<task-notification>` 抓取与 Rust 标题 fixture。子代理工具面同日晚些随 `RespondToCoordinator` 落地调整后，再次连续三次真机通过（`desktop-e2e-20261123-053033-640`、`desktop-e2e-20261123-053302-944`、`desktop-e2e-20261123-053509-741`）。
  - `conversation-session-background-subagent-rate-limit`：2026-11-23 已修复并连续三次真机通过（`desktop-e2e-20261123-022058-536`、`...022320-051`、`...024226-750`）。Rust 失败通知补 `<error>` 与 `failed. <provider 原文>`，后台子代理终态回写父 Agent 行（live + cold），并支持 `NIBI_MODEL_RETRY_MAX_RETRIES` 关闭模型重试；公开仓构建默认关遥测，跑该 spec 需带回环端点构建（见 `docs/testing/README.md`）。
  - `conversation-session-subagent-respond-to-coordinator`（BG25）：2026-11-23 已修复。Rust 落地 `RespondToCoordinator` 与 `TaskOutput`；连续三次全量 7 用例真机通过：`desktop-e2e-20261123-051527-743`、`desktop-e2e-20261123-052022-888`、`desktop-e2e-20261123-052521-916`。关键修复：子代理工具面 `SendMessage` 改回 main-only；`SendMessage` 在子代理在跑时拼 `summary\n\nmessage` 并按 `coordinator_steer` 写法并入；父会话空闲时 `<subagent-message>` 开 model-only 轮、工具边界并入用 `subagent_reply_steer`；文本轮收口只在批里有 guide 输入时连同通知并入并沿同一回合续跑（`textEnd` 批次按 user 呈现）；`<system-reminder>` 包装中和正文里的嵌套标签；冷打开的子会话卡片从结果正文重建 display；V4 快照补 `backgroundWorks`（运行中 child 的运行卡）。
  - 其余项按当前异步 Agent 语义/UI 单独跟进，不并入插件覆盖批次。

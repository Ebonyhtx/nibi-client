# ZCode 3.16.2 → 3.17.2 差异清单与 NIBI 吸收方案

> 状态：计划（2026-11-11，未实施）
> 对比基准：NIBI 起点 **ZCode v3.16.2** = 公开仓 `3c5b227`（2026-10-20）
> 上游最新：**v3.17.2** = 公开仓 `a9fe401`（2026-11-03），包含 3.16.3、3.17.1、3.17.2
> 方法：官方公开仓源码 `git diff 3c5b227 a9fe401` + 产品更新日志交叉核对；本文只把源码能定位的写成结论，只有日志的单独标注。
>
> 证据标记：**[源码]** 已在 3.17.2 源码定位；**[日志]** 只有更新日志；**[未实施]** 上游文档已分析但 3.17.2 代码未落地；**[现状]** 我们仓库的当前状态。
>
> 关联文档：[Rust/Node 功能对照](../rust-kernel-function-parity.md)、[改造台账](../../kernel/CHANGELOG-FORK.md)。

## 0. 摘要

- 差异规模：**5,315 个文件，+226,212 / −613,001 行**。删除量的大头是 **App 业务单测退役**（见 §5），不是产品代码缩水。
- 结构性变化有四件，按影响排序：
  1. **安全边界**：Plan+Guarded 危险命令审批、子代理权限继承、自定义命令 `!` shell 交权、本地 HTML 预览签名、工作区 MCP 信任、配置写入加固。
  2. **渲染隔离与常驻会话池**：长会话流式更新、会话切换、侧栏读取的性能大幅下降（§2）。
  3. **数据同步与远程设备管理**：统一同步页、设备级 Scope、项目彻底删除、远端服务停止/重启。
  4. **测试策略**：App 业务单测全面退役，改成「工程测试 + E2E/规格」；这是上游自己的取舍，我们只借鉴方法，不照搬全删。
- **我们继承了 3.16.2 的远程（SSH）发送回归**：发送前多 2 次串行远端往返（约 +90ms），侧栏频繁全量读远端树。上游 3.17.2 只落了 P0-1（身份缓存），P0-2/P1-1/P1-2 仍标「待确认/未实施」。我们应一次做全（§2.1）。
- 建议顺序：**P0 安全 + 远程发送/侧栏 + provider 目录同步** → **渲染隔离 + 常驻池** → **数据同步/项目删除/远端 daemon** → **小功能与测试债**。

## 1. 对比口径与限制

- 上游公开仓没有 `v3.16.2` 标签，只有 `v3.14.3 / v3.15.1 / v3.17.1 / v3.17.2`；3.16.2 按 `package.json` 版本定位到 `3c5b227`。
- 3.16.3 没有独立提交，位于 `3c5b227 → a60ba6a` 之间，无法严格按版本拆开；本文按「3.16.2 → 3.17.2 合并口径」处理。
- 上游 release 记录的是内部构建 SHA（如 `e6b675b4`），公开仓 sync 提交是净化后的快照；个别实现可能与正式包有差异。本文以公开源码为准，正式包行为需在真机再确认。
- 我们的仓库基于 3.16.2 且做过 NIBI 品牌化、Host/UI 分叉与 Rust 内核替换。上游文件不能直接整体 cherry-pick，Node 轨按文件语义移植，Rust 轨按契约重写。

## 2. 性能专题：为什么 3.17.2 在长会话/切换会话上更顺

这一章是用户明确感知的部分。结论：主要来自 **渲染隔离 + 常驻会话池 + Electron 44**，不是数据库 schema（3.17.2 没有改 SQLite 迁移，只删了迁移契约测试）。

### 2.1 3.16.2 的远程（SSH）回归（我们中招）

上游 `docs/issues/remote-performance-3-16/01-remote-session-lag-analysis.md` 逐条分析了 3.16.2 相对 3.15.3 的卡顿：

- **发送前多等两次串行 SSH 往返**：`SessionPane` 在创建 envelope 之前 `await projectService.resolveSessionDirectories(...)`，内部先查远端 repo，再 `resolveWorkspace` 登记身份（返回的 `workspaceIdentity` 随后被丢弃）。实测 p50 ≈89ms（88–97ms），3.15.3 没有这一步。
- **侧栏全量读取远端树**：`readProjectSidebarTree` 读本地 + **所有**远端主机（含离线）；远端 readTree 返回后对 N 个路径各发一次 `resolveWorkspace`，每次都在远端同步打开 2 个 SQLite、跑迁移检查、写一次 alias。
- 12 小时日志：`project.readTree` 1,453 次（远端 504 / 本地 370 / 离线失败 579）；侧栏 210 次触发产生 370 轮读取；70% 的轮次落在 1.5 秒内的连发里。
- 相关性数据：有远端 readTree 在途时 `sendConversationCommandV4` p50 891ms（n=6），无在途时 p59ms（n=50）。作者注明样本有干扰，但单通道突发并发确实拖慢发送。
- 上游修复状态：**[源码] P0-1 已实施**（`createRemoteIdentityRegistrationCache`，`packages/services/src/project/index.ts`，`packages/desktop/src/host/index.ts` 两条分支各一份缓存，按物理连接做 key）；**[未实施] P0-2**（发送时从窗口目录树同步取 projectId，缺行才查 Host）、**P1-1**（侧栏只读在线主机）、**P1-2**（合并连发读取）在 3.17.2 仍是待确认。
- **[现状] 我们两处都没有**：`packages/ui/src/v4/SessionPane.tsx` 仍在发送前 `await resolveSessionDirectories`；仓库没有 `createRemoteIdentityRegistrationCache`；`project-tree-reader.ts` 仍读所有主机。**这是纯收益、低风险的移植项，应放在 P0。**

### 2.2 常驻会话池与生命周期（会话切换/内存）

**[源码] 新增 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts` + `session-lifecycle/`：**

- 常驻池参数：**目标 8 个、高水位 16 个、空闲 10 分钟**（`DEFAULT_SESSION_RESIDENT_TARGET_COUNT/HIGH_WATER/IDLE_TIMEOUT_MS`）。
- 淘汰原因：`high_water_lru` / `idle_timeout`；淘汰前检查 `persisted`、`hasResidencyBlockingWork`、`hasPendingInteractions`、`hasQueuedCommands`、`hasSubscribers`、`hasLegacySubscriber`；有任一阻止项就不淘汰。
- 生命周期状态机：`unloaded → starting → ready → stopping → unloaded`，失败进 `faulted`；`restart` 跨整个 stop+start 区间持有所有权。
- 协议方法：`session/lifecycle/getState`、`ensureReady`、`stop`、`restart`；[源码] 已在 app-server 注册，Host/UI 目前主要用池的自动收敛，方法留给后续。
- 每个协议 request 持 operation lease，request 结束触发收敛；另有 60s sampler 兜底。
- 额外：`pruneSessionEventStores` 按时间淘汰 subagent 的一次性 event store。
- **[现状] Rust 内核没有常驻池/生命周期**：`runtime/src/table.rs` 的 `Slot::Open` 一直持有 `Arc<Session>` 直到显式关闭，打开的会话越多内存越高；切换已打开会话是快的，但没有 LRU 回收与 `ensureReady` 语义。

### 2.3 渲染隔离（长会话流式更新）

**[源码] `docs/chat/message-render-performance.md`（2026-10-26/27）** 的更新隔离契约：

- 草稿自动保存不再发布整页配置更新；目录仍由单一 `ProjectDirectoryProvider` 订阅；只调用创建/刷新命令的 pane 不订阅任务树；工作区选择器只订阅项目/设备/可用性。
- 分组列表只更新受影响行；行操作保持稳定引用；选中态按行下发，不把全局 `activeTaskId` 传给每一行，只更新旧/新选中行。
- 导航预览按 turn 原始输入复用，缓存只保留当前窗口；正文/query/运行状态/语言/位置变化才失效；hover/focus 只更新视觉实际变化的条目。
- turn 派生缓存只保留当前窗口；已完成 turn 不接收逐秒变化的 `nowMs`；原始行、终态控制、插件固定裁决变化才失效。
- 上游实测（同一输入）：
  - 30 轮历史、20 次正文更新：row / turn / App 执行数 **440 / 231 / 21 → 20 / 21 / 0**。
  - 4 轮历史、完整真实流式：**424 / 190–194 / 46–47 → 59 / 46 / 8–9**。
  - 普通构建三次无长任务；RAF P95 17.4–17.6ms → 17.5–17.6ms（样本重叠，上游明确不据此声称可感知延迟改善）。
- **[现状] 我们有 `ConversationTimeline` / `RowView` 基线，但没有这套“只更新变化行/只保留当前窗口缓存”的隔离契约**；这是最可能解释“长会话更顺”的改动。

### 2.4 虚拟滚动与导航

- **[源码] `docs/ui/chat-virtual-scroll.md`**：虚拟单位是一整轮（`ConversationTurnRenderUnit`），不是单条 projection row；动态测高；`overscan` 只前后各两轮，避免长正文把 8 轮 overscan 放大成大量不可见 Markdown/测高工作。
- 跟随底部：resize 时批量测高 → 同步提交布局 → 再确认跟随权；离底不强制吸底；用户上滚/搜索优先于布局回调。
- 分组任务列表：`virtualized-group-task-list.tsx`，>80 行才虚拟化，overscan 12；行估高 32px。
- 搜索：先粗定位让目标 turn 进虚拟窗口，再按真实 Range 居中；`Range=null` 不等于未挂载；未完成请求才允许再次粗定位。
- **[现状] 我们已有 turn 级虚拟滚动与底部跟随**（`ConversationTimeline.tsx`），但 overscan 策略、宽度变化批处理、搜索粗定位结束语义、分组列表虚拟化阈值需要逐项对照。

### 2.5 流式正文路径

- **[源码] `docs/chat/assistant-streaming-text-rendering.md`**：当前没有旧 `useTaskStreamEvents` 50ms batch，也没有 UI 逐词 reveal 队列；节奏由权威 delta 到达 + React 渲染决定，结束态必须与 snapshot 逐字一致。
- 长会话的计算边界：插件展示裁决按回合首次出现顺序，查重不得随历史规模嵌套全量；导航预览只扫描足够确定的前缀；分享关闭时不构建分享回合/摘要。
- **[现状] 我们 3.16.2 基线是否还有 50ms batch/reveal 队列需要审计**；若仍有，应按上游路径移除，避免 UI 维护第二份正文。

### 2.6 其他性能项

- **[源码] 手机「仅常驻」读**：`services/src/zcode-agent/resident-rows-range/`，`rowsRange` 的 `residency: "resident-only"` 只读内存中的会话，不拉起 CLI/冷恢复/重建投影；能力未声明回 `proto.sessionNotResident`。
- **[源码] 内存诊断**：`services/src/memoryDiagnostics.ts` + `desktop/src/host/hostSelfResourceTelemetry.ts`，登记 bots/fileWatcher 等 provider 的内存计数，Host 自资源遥测；用于排查长会话内存，不是功能。
- **[源码] Electron 41.0.3 → 44.7.0**（Chromium 152），macOS 最低 13。**[现状] 我们已是 44.10.1**，这条不需要吸收；builder/updater 仍可小幅跟进。
- **[日志] 安装包体积减小、流式卡顿下降、文档查看器共用进程**：安装包与文档进程需要按源码再定位；流式卡顿已由 §2.3 的渲染隔离解释。

### 2.7 性能结论与优先级

| 机制 | 影响 | 我们是否有 | 吸收优先级 |
| --- | --- | --- | --- |
| 远程身份缓存（P0-1） | 发送少 1 次往返、侧栏每轮少 N 次远端查询/开库 | 无 | **P0** |
| 发送不等待远端查询（P0-2） | 回车到“发送中”≈90ms → ≈0ms | 无（仍是 3.16.2 写法） | **P0** |
| 侧栏只读在线主机（P1-1） | 去掉 579 次/12h 无效调用 | 无 | P1 |
| 合并连发读取（P1-2） | 370 轮 → 约 210 | 无 | P1 |
| 渲染隔离 | row/turn 执行数降一个数量级 | 无 | **P0** |
| 常驻会话池 | 会话切换/内存稳定，热会话常驻 | 无（Rust 无池；Node 也没有） | **P1（Rust 工作量大）** |
| 虚拟滚动细节 | 长历史滚动/搜索成本 | 有基线，细节待对齐 | P1 |
| Electron 44 | 渲染/JS 整体提升 | 已是 44.10.1 | 无需 |

## 3. 全量变化清单

> 编号用于后续提交/任务引用。每条的「吸收目标」写 `Node`（apps/zcode-cli）、`Rust`（kernel/）、`Host/UI`（两内核共用）或 `不吸收`。

### A. 安全与权限

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| A1 | Plan + Guarded 危险命令免确认漏洞修复；Plan 下 MCP 询问不提供“始终允许” | [源码] `core/src/permission/service.ts` | 已实施 | Node 直接移植；Rust 核对 `policy` 的 plan+guarded 路径并补测试；**P0** |
| A2 | 子代理权限与主会话一致：explore 不再用独立 default `PermissionService`；插件 profile 只能收紧 | [源码] `runtime/methods/subagent.ts`、`bootstrap/src/subagents.ts` | 已实施 | Node 移植；Rust 核对子循环权限链；**P0** |
| A3 | 自定义命令 `!`/```` ```! ```` shell 不再解析期执行，改写为给模型的 Bash 指令，经权限确认 | [源码] `contracts/src/commands/index.ts::handOffCustomCommandShellBlocks`；删除 `custom-command-shell-expansion.ts` | 已实施 | Node 与 Rust 都改（Rust 现在 `expand_shell` 直接执行）；**P0** |
| A4 | 本地 HTML 预览签名目录：`file://` → `zcode-html://`，每次资源请求验签 + 真实路径检查 | [源码] `desktop/src/main/browser-local-preview/`、`docs/browser-use/local-html-preview.md` | 已实施 | Host 移植（NIBI 也内置浏览器）；**P0** |
| A5 | 工作区 MCP 信任：项目 MCP 声明按 digest 记录信任/评审 | [源码] `bootstrap/src/workspace-mcp-trust/` | 已实施 | Host + Rust MCP 发现层；**P0/P1** |
| A6 | MCP 设置检测仅限已注册工作区 | [源码] `workspace-mcp-trust` 与 MCP 设置测试 | 已实施 | Host；**P0** |
| A7 | 用户级 `config.json` 写入加固：损坏时报错不覆盖、写前重读、只改自己字段、临时文件+rename | [源码] `docs/issues/data-sync/01-harden-user-config-writers.md`、`services/src/fs/atomicFileUtils.ts` | 已实施 | Node services；Rust 检查自己的配置写入；**P0** |
| A8 | MCP stdio 无 Node 回退：Electron Node + 内置 npm/npx | [源码] `adapters/src/mcp/node-fallback.ts`、`bootstrap/src/app/mcp-node-fallback.ts` | 已实施 | Node 直接移植；Rust 侧由 Host 注入 node/npm/npx 路径或命令改写；**P1** |
| A9 | **多会话并发写数据异常**：`commitForkBundle` 在 `DatabaseSync` 事务里 `await`，其他会话的写入会被 fork 回滚误删；改为事务内同步写 + 新增 `commitMessageBundle`（`begin immediate`） | [源码] `adapters/src/storage/session-store/sqlite-session-store.ts` | 已实施 | **Node 必移植（数据完整性）**；Rust node-store 已同步事务，核对无同类 await；**P0** |
| A10 | fork 的 `compactLeadingMessageIds` 元数据非数组时不再抛错（字符串被逐字符校验、数字 TypeError） | [源码] 同上 | 已实施 | Node 小修；**P0（小）** |

### B. 数据同步与远程设备

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| B1 | 统一数据同步页：命令/钩子/技能/MCP/inline 插件/marketplace 插件/子代理/用户配置；哈希三态、分批、父子技能同批、不删远端独有、离线 fail-closed | [源码] `ui/src/data-sync/`、`services/src/data-sync/`、`docs/remote/data-sync.md` | 已实施 | Host/UI 大工程；先单类试点；**P1** |
| B2 | 设置页 Scope 按设备分组（本机/远端用户/项目），离线不列出、fail-closed | [源码] `ui/src/settings-scope/` | 已实施 | Host/UI；数据同步前置；**P1** |
| B3 | 项目彻底删除：`v4/storage/sessionData/measure / purge`，运行中/被引用保留、幂等 | [源码] `shared/src/zcode-protocol-v4/session-data/`、`ProjectManagement.tsx` | 已实施 | Host/UI + Rust 内核实现两个方法；**P1** |
| B4 | 远端服务停止/重启（daemon 生命周期） | [源码] `docs/issues/remote-daemon-lifecycle/` | 已实施 | Host + `nibi-server`；**P1** |
| B5 | 远端设备紧凑可搜索列表、在线状态、停止/重启菜单 | [源码] `settings/SourceServerDeviceRow.tsx`、`sourceServerDeviceList.ts` | 已实施 | Host/UI；**P1** |
| B6 | Provider provisioning lane 状态 + 失败重试 | [源码] `services/src/provider-provisioning-status/` | 已实施 | Host（依赖数据同步）；**P2** |
| B7 | 远端「仅常驻」行读取（手机项目列表预加载最新一页） | [源码] `services/src/zcode-agent/resident-rows-range/` | 已实施 | Host + Rust 能力声明；**P2** |

### C. 功能与 UI

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| C1 | 插件一键全部更新 | [源码] `ui/src/settings/PluginsSection.tsx`、`PluginStoreCard.tsx` 的 `updateAll` | 已实施 | Host/UI；**P2（小）** |
| C2 | 图片预览标注并作为附件发送 | [源码] `ui/src/image-preview-editor/` | 已实施 | Host/UI；**P2** |
| C3 | 文件菜单：系统关联应用、另存为、在 Finder/资源管理器打开 | [源码] `ui/src/file-menu/`、`desktop/src/main/file-open-apps/` | 已实施 | Host/UI；**P2** |
| C4 | 未读任务：标记未读；托盘红点移除 | [源码] `TaskActionMenuContent`、`TaskList`、`desktopTray.ts` | 已实施 | Host/UI；**P2（小）** |
| C5 | MCP 配置界面（草稿版） | [源码] `docs/plugins/draft-mcp-ui-session-spec.md` | 草稿 | Host/UI；**P2** |
| C6 | ZCode Sites 官方插件（7 个 `site-*` 命令 + deploy skill + 本地 API） | [源码] `apps/zcode-cli/packages/zcode-site-plugin/` | 已实施 | **不直接吸收**（依赖 ZCode 云）；若做自建部署另立项 |
| C7 | 官方插件命令安全端点：本机 socket + 每会话 token，凭据不进 env | [源码] `official-command-endpoint.md`、`coding-plan/zcode-official-plugin-command-auth-spec.md` | 已实施 | 暂不吸收（只有 Sites 用）；如做官方插件云工具再复用 |
| C8 | 工作流配额暂停后自动续跑 | [源码] `bootstrap/src/app/dynamic-workflow-quota-resume.ts` | 已实施 | Node + Rust（DWF 调度）；**P2** |
| C9 | CUA 多会话光标、Windows input delivery | [源码] `docs/cua/...`（私有 producer） | 已实施 | 归私有 CUA 轨；**P2** |
| C10 | 手机远控输入预测（ghost hint） | [源码] `docs/web-remote-control/mobile-input-prediction.md`、`v4/conversation/inputPrediction` | 已实施 | 暂不吸收（NIBI 手机是 Web/远控，无 KMP 端）；**P3** |
| C11 | 文档查看器按会话隔离、多个文档插件共用进程 | [日志]，3.16.3 也提 | 已实施 | 需按源码定位 Host 文档运行时；**P2** |
| C12 | 预览卡片整卡点击打开 | [日志] | 已实施 | 小 UI；**P2（小）** |
| C13 | 侧栏视图改为“按项目/按分组/最近更新/按未读” | [源码] `docs/ui/sidebar-task-view-switcher.md` | 已实施 | Host/UI；**P2** |
| C14 | 分组任务列表虚拟化（>80 行，overscan 12） | [源码] `virtualized-group-task-list.tsx` | 已实施 | Host/UI（性能）；**P1（小）** |
| C15 | 帮助菜单复制设备号 | [日志] 3.16.3 | 已实施 | Host/UI 小功能；**P3（小）** |
| C16 | 登录链接无法自动打开时可复制后手动完成 | [日志] 3.16.3 | 已实施 | Host/UI 登录 UX；**P3（小）** |
| C17 | 插件后台保留时长上限 | [日志] 3.16.3 | 已实施 | Host 插件运行时；**P2（小）** |
| C18 | 文件树恢复显示在预览区左侧 | [日志] 3.16.3 | 已实施 | Host/UI 布局；**P3（小）** |
| C19 | 侧栏插件列表优先显示已安装 | [日志] 3.16.3 | 已实施 | Host/UI；**P3（小）** |

### D. 协议与模型请求

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| D1 | 新增 `v4/storage/sessionData/measure` / `purge` | [源码] `zcode-protocol-v4/session-data/`、`transport.ts` | 已实施 | Rust 必须实现（项目删除前置）；**P1** |
| D2 | 新增 `v4/conversation/inputPrediction` | [源码] `input-prediction/` | 已实施 | 暂不吸收；若做手机 ghost hint 再实现；**P3** |
| D3 | 新增 `session/lifecycle/getState / ensureReady / stop / restart` + 常驻池 | [源码] `session-lifecycle/`、`session-resident-pool.ts` | 已实施 | Rust 需要设计/实现；Node 直接移植；**P1** |
| D4 | 新增 `x-zcode-session-features` 多值请求头（按会话累计能力标签） | [源码] `session-features-header.md` | 已实施 | 若我们做统计，改 `x-nibi-session-features`；Rust 模型请求头；**P3** |
| D5 | 发行版请求安全策略钩子（开源默认空实现） | [源码] `shared/src/request-security-edition/` | 已实施 | 我们已有自己的 license/门禁，不吸收；**不吸收** |
| D6 | Provider 目录 rev 33 → 43：13 个新模板、38 个新模型、移除 3 个旧 MiniMax | [源码] `config/provider/zcode-builtin.json` | 已实施 | 数据同步脚本 + 平台目录；**P0（低风险）** |

### E. 平台与构建

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| E1 | Electron 41.0.3 → 44.7.0（macOS 最低 13） | [源码] `packages/desktop/package.json`、`docs/electron/electron-44-upgrade.md` | 已实施 | 我们已是 44.10.1；无需 |
| E2 | electron-builder 26.8.1 → 26.17.0；electron-updater 6.8.3 → 6.8.10 | [源码] 同上 | 已实施 | 小幅跟进；**P2** |
| E3 | 安装包体积明显减小、macOS 语言资源修复、Windows 组件兼容 | [日志] | 已实施 | 按构建脚本逐项定位；**P2** |
| E4 | 崩溃/内存诊断：Host 自资源遥测、内存 provider 注册表 | [源码] `hostSelfResourceTelemetry.ts`、`services/src/memoryDiagnostics.ts` | 已实施 | 可选，便于排查长会话内存；**P3** |
| E5 | 新增 `electron-to-chromium` 版本锁定 | [源码] `packages/desktop/package.json` | 已实施 | 跟进；**P3** |

### F. 测试与工程策略

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| F1 | App 业务单测退役：UI 1050→1、services 279→2、shared 148→3、desktop 922→805；保留 CLI/CUA/E2E/工程测试 | [源码] `docs/testing/unit-test-quality.md`、`vitest.config.ts`、`scripts/engineering-test-files.json` | 已实施 | **不照搬全删**；按同一标准做“实现锁定测试”清理；**P2** |
| F2 | 根 `test/test:unit/test:unit:affected/test:coverage` 移除；新增 `test:engineering(:affected)`、`test:engineering-tools` | [源码] 根 `package.json` | 已实施 | 我们有 Rust 轨；可保留根单测但拆分工程/业务入口；**P2** |
| F3 | pre-push 改为：工作区干净 → e2e 远控目标 → lint → 陈旧文档措辞 → DB schema → 架构 → 受影响工程测试 | [源码] 根 `package.json`、`scripts/check-push-worktree.mjs` 等 | 已实施 | 可借鉴检查项，不必替换现有 Rust 门禁；**P2** |
| F4 | 架构规则不再要求 `contract.test.ts`；新增退役证据审计 | [源码] `retired-app-unit-evidence.test.mjs` | 已实施 | 与 F1 一起评估；**P2** |
| F5 | 新增 `check-push-worktree`、`check-e2e-remote-targets`、`docs:stale-phrases:check` | [源码] `scripts/` | 已实施 | 前两项可移植；**P2** |
| F6 | 删除 coverage 配置、`@vitest/coverage-v8`、`lint-staged` 单测接线 | [源码] 根 `package.json`、`vitest.config.ts` | 已实施 | 跟随 F1 决定；**P2** |

### G. 移除/回退

| # | 移除 | 证据 | NIBI 动作 |
| --- | --- | --- | --- |
| G1 | 托盘未读红点徽章 | [源码] `desktopTray.ts` | 跟 C4；**P2** |
| G2 | 旧三类分散同步弹窗入口 | [源码] 数据同步页接管 | 跟 B1 |
| G3 | App 业务单测与 coverage/lint-staged 接线 | [源码] | 跟 F1，不盲从 |
| G4 | 3 个旧 MiniMax 模型 | [源码] provider config | 跟 D6 |
| G5 | 自定义命令解析期 shell 执行器 | [源码] | 跟 A3 |
| G6 | 错峰套餐到期自动续费 | [日志] | NIBI 无错峰套餐；不涉及 |

### H. 只有更新日志、源码未逐项定位

以下条目只作为待办清单，实施前必须先按关键词在 3.17.2 源码定位，不把日志当已核实结论：

1. 长对话流式回复卡顿明显减少（已由 §2.3 渲染隔离解释，仍需对照我们的实现）。
2. 安装包体积明显减小。
3. 文档查看器按会话隔离、多个文档插件共用进程。
4. 微信自动化任务结果推送恢复。
5. Windows 窗口被其他程序遮挡后恢复显示。
6. 删除项目后可正常新建任务。
7. 修复 macOS 安装包丢失中英文语言资源。
8. 浏览器附件链接不再被反复下载。
9. 修复 Windows 64 位安装包可能混入不兼容组件。
10. 修复产物卡片偶尔不刷新。
11. 修复 macOS 部分应用图标显示空白（C3 的 file-open-apps 已覆盖 Windows 图标资源逻辑，macOS 需另核）。
12. 预览卡片整卡点击（已列入 C12）。

## 4. Node 内核（apps/zcode-cli）吸收方案

**定位**：Node agent 是 `NIBI_KERNEL=node` 的回退与历史参考，不是默认内核。Node 轨的原则是：
**安全与性能直接对齐上游；新功能不重复造两套**——Host/UI 共用的功能只在共享层做一次，Node 与 Rust 各自只补“agent 内部语义”。

### 4.1 P0：安全与远程性能

1. **A1/A2 权限**：按上游文件语义移植 `permission/service.ts`（plan+guarded、`optionsPolicy`）与 `runtime/methods/subagent.ts` / `bootstrap/src/subagents.ts`（共享 `PermissionService`、`permissionModeRestrictOnly`）。验收：新增 plan+guarded 危险命令 E2E、explore 子代理在 plan 下被拒的 E2E。
   **A9/A10 数据完整性**：`commitForkBundle` 事务内改同步写、新增 `commitMessageBundle`、修 `compactLeadingMessageIds` 校验；验收：并发 fork/写消息不互相回滚，重启可打开。
2. **A3 自定义命令交权**：删除 `bootstrap/src/custom-command-shell-expansion.ts`，`custom-command-prompt.ts` 改为只调 `expandCustomCommandPrompt`；在 `contracts/src/commands/index.ts` 增加 `handOffCustomCommandShellBlocks`，逐字对齐上游（插件变量、不可解析变量、Windows 正斜杠、`$ARGUMENTS` 顺序）。验收：`!` 内联/围栏、插件变量、`_SKILL_DIR`、Windows 路径、参数含反引号五组单测。
3. **A4/A5/A6/A7 Host 侧**：见 §6（这些不在 Node agent，而在 desktop Host/services）。
4. **A8 MCP 无 Node 回退**：移植 `adapters/src/mcp/node-fallback.ts` + `bootstrap/src/app/mcp-node-fallback.ts`；确保用户自己的 `node/npm/npx` 优先，官方 CLI/SEA/远端不变。
5. **远程 P0-1**：移植 `createRemoteIdentityRegistrationCache`（`services/src/project/index.ts`）与 `desktop/src/host/index.ts` 的两条装配分支；缓存 key 用物理连接，Registry/Manager 分开。
6. **远程 P0-2**：`SessionPane` 发送时从 `useOptionalProjectDirectory()` 的 `factTree.tasks[].projectId` 同步取归属，缺行才回退 `resolveSessionDirectories`；更新草稿生命周期 spec。我们比上游 3.17.2 多走一步（上游仍待确认）。
7. **P1-1/P1-2**：`project-tree-reader.ts` 只读 `connectionStatus === "online"` 的主机；按 delta/host 合并连发读取，`ensureWorkspaceTab` 无变化返回原数组。上游未实施，我们按文档方案自己做。

### 4.2 P1：常驻池与生命周期（直接移植）

- 从上游移植 `session-resident-pool.ts`、`session-lifecycle/`、`server.ts` 的装配与 `v4-gateway` 的 `fault.sessionLifecycle.stopping` 检查。
- 默认参数保持 8/16/10 分钟；gating facts 与本仓库的 `CommandInbox`、subscribers 对接。
- 验收：高水位 LRU、空闲淘汰、有订阅/队列/交互时不淘汰、stop/restart 幂等、faulted 不重建、request lease 释放触发收敛、60s sampler 兜底。

### 4.3 P2：小功能与协议

- B3 的 `sessionData/measure|purge`：Node agent 实现两个 v4 方法（Host/UI 见 §6）。
- C1-C4、C8、C13、C14：能复用 Host/UI 的复用；agent 侧只补命令/事件。
- D6 provider 目录：Node 与 Rust 共用 `config/provider` 数据，不需要两套实现。

### 4.4 不重复做

- 数据同步、项目删除 UI、远端 daemon、图片标注、文件菜单、未读筛选：都在 Host/UI（§6），Node agent 不重复。
- Sites/官方命令端点/输入预测/遥测：不吸收（§7）。

## 5. Rust 内核（kernel/）吸收方案

**定位**：Rust 是默认内核，agent 内部语义必须与 Node 对齐；Host/UI 功能通过协议驱动内核。

### 5.1 P0：安全语义

1. **A1 Plan + Guarded**：检查 `crates/policy/src/lib.rs` 的判定顺序。Node 的漏洞是 `planEnabled` 跳过 guarded 单次确认、再由 plan 分支放行；Rust 的 plan 是独立开关，`effective` 模式会变，必须写测试确认 `guarded::applies` 在 plan 开启时仍能命中。若缺失，在 plan 拒绝优先之后补 `ask_once`，并保证 `ask_once` 仍只在 guarded 生效。验收：plan+guarded 危险 Bash 必须询问；plan 拒绝优先；hook 放行不能代替用户单次批准。
2. **A2 子代理权限**：核对 `crates/agents` 子循环使用的权限判定是否与父会话同源（`ChildSink` 的交互只是询问通道，不是判决链）。若 explore 子代理有独立的默认放行，改为共享父会话的 `PolicyGate`/规则快照；插件 profile 的 `permissionMode` 只允许收紧（`spawn::mode` 已有 bypass 收紧逻辑，需补其它模式）。
3. **A3 自定义命令 shell 交权**：改 `crates/ext/src/commands/user.rs`：
   - 删除/停用 `expand_shell` 的执行路径，解析阶段只做文本改写；
   - 新增 `hand_off_shell_blocks`，逐字对齐上游：`` !`cmd` `` / ```` ```! ````、插件变量 `CLAUDE_/ZCODE_` 别名（NIBI 侧用 `NIBI_` 与兼容别名）、`*_SKILL_DIR` 不可解析、Windows 路径正斜杠、`$ARGUMENTS` 后替换；
   - 无法解析的块替换为 “was not run” 说明，不执行；
   - 保留 `allowed-tools` 等现有 frontmatter 行为。
   验收：5 组单测 + 一个真实会话 E2E，确认模型看到 Bash 指令并要求确认。
4. **A5/A6 工作区 MCP 信任**：在 `crates/ext` 的 MCP 发现/装载层读信任记录（Host 写入的用户存储或内核自己的 store），项目 MCP 未信任时不装载/需评审；`plan` 下 MCP 询问不提供“始终允许”。需要与 Host 约定信任文件的 owner（建议 Host 唯一 owner，内核只读）。
5. **A7 配置写入**：Rust 的 `setting.json`、插件配置、cron 文件写入检查“读失败当空对象”的路径；改为损坏即报错、临时文件+rename。参考 `crates/platform`/`env-local` 的原子写。
6. **A8 MCP 无 Node 回退**：Rust 启动 MCP 子进程时解析 `node/npm/npx`；若 PATH 没有，使用 Host 注入的 `NIBI_NODE_BIN`/`NIBI_NPM_BIN`（Host 传 Electron Node 与内置 npm）。若 Host 直接把 Electron Node 放上 PATH，内核可零改动；优先选后者，少一处特判。

### 5.2 P1：协议与生命周期

1. **D1 `sessionData/measure|purge`**：在 `protocol-nibi` 增加两个方法，调用 `SessionStore` 测量/删除会话与目录记忆；运行中/被引用会话保留，幂等；`transport` 方法名冻结后旧 Host 回 method-not-found 时 UI 隐藏。
2. **D3 常驻池 + 生命周期**：在 `runtime/src/table.rs` 之上加池：
   - 状态：`unloaded/starting/ready/stopping/faulted`；`SessionLifecycleController` 唯一写者；
   - 淘汰门：无 running turn、无 queue、无 pending interactions、无 cron 到点任务、无后台 shell/子代理、无协议订阅（`Live` 连接）；
   - 淘汰 = 关闭 actor（复用现有 `closing` 路径）但不发 `session.removed`、不删存储；`ensureReady` 复用现有冷加载；
   - 目标 8 / 高水位 16 / 空闲 10 分钟；request lease 结束触发收敛，60s sampler 兜底；
   - 协议四个方法：`session/lifecycle/getState|ensureReady|stop|restart`；
   - 风险：cron、peers、DWF run、后台子代理、分享订阅都要计入“阻止项”，宁可少淘汰。
3. **D6 provider 目录**：改 `config/provider/nibi-builtin.json` 到新 revision；`crates/platform` 的目录解析要能识别新模板；跑 `scripts/sync-upstream-provider-config.mjs` 后做逐模板端点探测。
4. **C8 工作流配额续跑**：DWF 调度层（Rust 侧编排 + sidecar）在配额失败后按重置时间自动重试；先确认 NIBI 是否走同一配额模型。
5. **B7 仅常驻行读取**：`protocol-nibi` 的 `rowsRange` 增加 `residency` 能力声明；非 resident 回 `proto.sessionNotResident`。

### 5.3 P2：可选协议

- **D4 `x-nibi-session-features`**：若 NIBI 服务端要统计，按 `QuerySource` 在模型请求头累计标签；只增不减；子代理独立。
- **D2 `inputPrediction`**：只有手机端要做 ghost hint 时实现；复用 `generate_text` 辅助档，只读、失败静默、同会话替换。
- **B3 的 Host 侧**与数据同步不在内核。

### 5.4 工作量估算（人日，粗估）

| 项 | Node | Rust |
| --- | --- | --- |
| A1+A2 权限 | 3–5 | 4–6 |
| A3 自定义命令 | 2–3 | 3–5 |
| A4/A5/A6 Host/MCP | 5–8 | 4–6 |
| A8 MCP 无 Node | 1–2 | 1–2（或 0，若 Host 注入 PATH） |
| 远程 P0-1/P0-2/P1 | 4–6 | 0（Host/UI） |
| 渲染隔离 | 5–8（Host/UI） | 0 |
| 常驻池/生命周期 | 3–5（移植） | 8–12 |
| sessionData | 2–3 | 3–5 |
| 数据同步 | 15–25（Host/UI） | 0–3（读配置） |
| 项目删除 UI + 批量管理 | 5–8（Host/UI） | 3–5 |
| 远端 daemon stop/restart | 4–6（Host/server） | 0 |
| 小功能（C1–C4/C13/C14） | 5–8（Host/UI） | 0 |
| 测试债清理 | 10–15 | 0 |

## 6. Host/UI 共享层吸收方案（两内核共用）

### 6.1 性能（最高优先级）

- **远程 P0-1/P0-2/P1-1/P1-2**：见 §2.1/§4.1；Host/UI 实现一次，Node/Rust 都受益。先做 P0-1 + P0-2（发送路径），再 P1-1/P1-2。
- **渲染隔离**：按 `docs/chat/message-render-performance.md` 的契约逐项移植：
  - `ConversationProjectionStore` 保持未变化 row 的稳定引用；
  - `ConversationTimeline` 的 turn 级派生缓存只保留当前窗口；
  - `ConversationRowView` 按行订阅，不把全局 `activeTaskId`/`nowMs` 下发给所有行；
  - `useProjectTree`/`ProjectDirectoryProvider` 收窄订阅；`ensureWorkspaceTab` 无变化返回原数组；
  - 导航预览按 turn 缓存、只扫描确定前缀；hover/focus 只更新视觉变化项；
  - 分组任务列表按 80 行阈值虚拟化。
  - 验收：用上游同款计数探针在 30 轮/20 次更新、4 轮完整流式、44 项目/6 次活动、千轮导航四组场景记录必要/额外更新；目标是 row/turn/App 执行数降到与上游同量级，业务断言（正文一致、草稿、选中、滚动）全过。
- **虚拟滚动细节**：overscan 前后各两轮；宽度变化批处理在同一 ResizeObserver 回调内完成；搜索粗定位结束语义（`Range=null` 不等于未挂载）。
- **流式正文**：审计并移除 50ms batch/reveal 队列（若存在），只保留权威 delta → projection → render。

### 6.2 安全（Host 侧）

- A4 本地 HTML 预览签名目录（`desktop/src/main/browser-local-preview/`）。
- A5/A6 工作区 MCP 信任（`bootstrap/src/workspace-mcp-trust/` 是 agent 侧；Host 要提供用户存储与评审 UI）。
- A7 配置写入加固（`services/src/fs/atomicFileUtils.ts`，命令/钩子/技能/迁移导入四处）。
- A8 MCP 无 Node 回退（Host 构造 agent 环境时注入 Electron Node/npm/npx，或让 agent 自己做）。

### 6.3 功能

- B1 数据同步：先做只读对比 + 单类试点（技能），再扩 MCP/命令/钩子/插件/子代理；设备 Scope（B2）是前置。
- B3 项目彻底删除 UI + 批量管理：依赖 Rust `sessionData` 方法；Host 在 method-not-found 时隐藏选项。
- B4/B5 远端 daemon stop/restart + 设备列表。
- C1 插件一键更新、C2 图片标注、C3 文件菜单、C4 未读筛选、C13 侧栏视图、C14 分组虚拟化。
- C11 文档查看器共用进程/按会话隔离：先按源码定位 Host 文档运行时，再决定是否吸收。

### 6.4 明确不放进共享层

- Sites 云、官方命令端点、遥测引擎、Coding Plan/off-peak：没有对应服务或与 NIBI 政策冲突。

## 7. 分阶段路线图

> 依赖顺序：安全 > 数据完整性 > 远程发送/侧栏 > 渲染隔离 > 常驻池 > 数据同步/项目删除 > 小功能 > 测试债。
> 每一项独立提交、独立验收；不与品牌化或 Rust 内核大改混批。

### Phase 0：安全 + 数据完整性 + 远程回归（第 1–2 周）

- Node：A1、A2、A3、A9、A10、远程 P0-1/P0-2、A8。
- Rust：A1、A2、A3（语义对齐 + 测试）。
- Host/UI：A4、A7、远程 P0-1/P0-2。
- 数据：D6 provider rev 43 同步与模板探测。
- 出口：
  - plan+guarded 危险命令必须询问；explore 子代理在 plan 下受限；
  - `/命令` 的 `!` 变成需确认的 Bash 调用；
  - fork 并发写不再互相回滚；
  - 回车到“发送中”≈0ms（目录缺行时 ≈45ms）；
  - provider 目录新模板可用。

### Phase 1：长会话渲染 + 常驻池 + MCP 安全（第 3–5 周）

- Host/UI：渲染隔离（§6.1）、虚拟滚动细节、分组列表虚拟化阈值。
- Node：常驻池/生命周期直接移植（§4.2）。
- Rust：D1 `sessionData`；D3 常驻池/生命周期设计与第一版（§5.2）。
- Host + Rust：A5/A6 工作区 MCP 信任；A8 无 Node 回退。
- 出口：
  - 30 轮/20 次更新、4 轮完整流式的 row/turn/App 执行数降到上游同量级；
  - Node 常驻池 8/16/10min 生效，有订阅/队列/交互不淘汰；
  - Rust 生命周期状态机与 `ensureReady` 可演示；
  - MCP 信任记录生效，未信任项目 MCP 不装载。

### Phase 2：数据同步 + 项目删除 + 远端运维（第 6–9 周）

- Host/UI：B2 设备 Scope → B1 数据同步单类试点（技能）→ 扩 MCP/命令/钩子/插件/子代理。
- Host/UI + Rust：B3 项目彻底删除（UI + `sessionData/measure|purge`）。
- Host/server：B4 远端服务停止/重启；B5 设备列表。
- 出口：
  - 单类同步的对比/推送/离线/迟到结果语义全过；
  - 项目删除保留运行中/被引用会话，幂等；
  - 远端 crash-loop 可在设备卡自救。

### Phase 3：小功能 + 测试债（第 10–12 周）

- C1–C5、C8、C13、C14、C15–C19（见 §3.C 与附录）。
- F1–F6 测试策略：先只读盘点，按上游标准删“实现锁定”测试，保留安全/协议/并发/持久化；行为迁到 E2E。**不照搬全删**。
- 可选：D4 `x-nibi-session-features`、D2 输入预测（取决于手机端）。

## 8. 明确不吸收 / 另立项

| 项 | 原因 | 处理 |
| --- | --- | --- |
| 对话遥测引擎（`conversation-telemetry`） | NIBI 遥测默认关闭、端点只能自有或空；这是上游恢复生产埋点的工程 | 不吸收；如做统计走 NIBI 自有端点与最小字段 |
| ZCode Sites 插件 + 官方命令端点 | 依赖 ZCode 云与官方账号体系；NIBI 没有对应服务 | 不直接吸收；若做自建部署，另立项并自建端点 |
| Coding Plan / Team Plan / Off-Peak | NIBI 已移除商业套餐 | 不吸收（G6 不涉及） |
| App 单测全量退役 | 我们没有上游 QA/E2E 覆盖兜底；全删会丢掉安全/并发/持久化保护 | 学方法，不照搬；分阶段清理（F1） |
| 手机输入预测 | 需要 KMP 手机端；NIBI 手机是 Web/远控 | 暂不做（D2/C10） |
| CUA 多会话光标 / Windows input | 私有 CUA producer，公开仓占位 | 归 CUA 私有轨（C9） |
| Electron 44 | 我们已是 44.10.1，更新 | 不重复 |
| macOS 12 支持 | Electron 44 已要求 macOS 13 | 检查安装包元数据即可 |
| `x-zcode-session-features` 原名 | ZCode 品牌/统计口径 | 若做，改 `x-nibi-session-features` |
| 发行版 request security edition | 我们已有 license/门禁体系 | 不吸收 |

## 9. 验收与回归

### 9.1 通用门禁

- Rust：`cargo test --workspace --no-fail-fast`、改动 crate 的 clippy、`cargo check --locked`。
- Node/UI：`pnpm typecheck`、`pnpm lint`、`pnpm test:architecture`、受影响的单测/E2E。
- 任何“跳过了测试”的结论必须显式写出，不把未执行当通过。

### 9.2 安全项验收

| 项 | 验收 |
| --- | --- |
| A1 | plan+guarded 危险 Bash 必须 `user-once` 询问；plan 拒绝优先；hook 放行不能代替批准；MCP 询问无“始终允许” |
| A2 | explore 子代理在 plan 下写文件被拒；插件 profile 不能把父模式放宽 |
| A3 | `!` 内联/围栏五组单测；真实会话里模型看到 ```bash 块并触发确认；不可解析变量整块不执行 |
| A4 | `file://` HTML 不再获得跨文件读取；签名目录外请求被拒；导航序号防旧 IO 覆盖 |
| A5/A6 | 未信任项目 MCP 不装载；信任按 digest；离线/换连接不复用旧授权 |
| A7 | 损坏 config.json 写入报错且字节不变；并发写只改自己字段；中途失败无半截文件 |
| A9 | 两个会话并发 fork/写消息，事务互不误删；重启后都能打开 |
| A10 | 非数组 `compactLeadingMessageIds` 不导致 fork 失败 |

### 9.3 性能项验收

- 渲染：用与上游相同的计数探针记录 30 轮/20 次正文更新、4 轮完整流式、44 项目/6 次活动、千轮导航四组；同时记录业务断言（正文逐字一致、草稿、选中、滚动、搜索定位）。
- 远程：记录发送前 RPC 次数与 `resolveSessionDirectories` 耗时；侧栏 12 小时 readTree 次数、离线调用数、连发轮次。
- 常驻池：记录 resident 数、淘汰原因、被阻止淘汰的原因；确保 stop 后历史仍可冷恢复。
- 不以固定机器耗时阈值代替业务断言；React Scan/profile 与普通构建分开记录。

### 9.4 功能项验收

- 数据同步：单类试点 → 全类；对比/差异默认不勾选/不删远端独有/离线 fail-closed/换代丢弃迟到结果。
- 项目删除：运行中与被引用保留、幂等、旧 CLI 隐藏入口。
- 远端 daemon：stop 幂等、restart 跨 stopping→starting、crash-loop 自救。
- 小功能：按各 UI 规格的现有 E2E/浏览器验收。

## 10. 附录

### 10.1 差异规模与关键提交

```text
base   3c5b227  chore: sync ZCode source (package.json 3.16.2, 2026-10-20)
latest a9fe401  chore: sync ZCode source v3.17.2 (2026-11-03)
mid    a60ba6a  v3.17.1 (2026-10-30)
diff   5,315 files changed, 226,212 insertions(+), 613,001 deletions(-)
       A 1,044 / D 2,073 / M 1,967 / 其余重命名
```

复现命令：

```bash
git clone --filter=blob:none --no-checkout https://github.com/zai-org/ZCode.git
cd ZCode
git diff --stat 3c5b227 a9fe401
git diff --name-status 3c5b227 a9fe401
git diff 3c5b227 a9fe401 -- config/provider/zcode-builtin.json
```

### 10.2 关键新模块（源码）

| 模块 | 位置 |
| --- | --- |
| 数据同步 UI / 服务 | `packages/ui/src/data-sync/`、`packages/services/src/data-sync/` |
| 设置 Scope | `packages/ui/src/settings-scope/` |
| 项目侧栏/管理 | `packages/ui/src/project-sidebar/` |
| 图片标注 | `packages/ui/src/image-preview-editor/` |
| 文件菜单/系统应用 | `packages/ui/src/file-menu/`、`packages/desktop/src/main/file-open-apps/` |
| 本地 HTML 预览 | `packages/desktop/src/main/browser-local-preview/` |
| 工作区 MCP 信任 | `apps/zcode-cli/packages/bootstrap/src/workspace-mcp-trust/` |
| MCP 无 Node 回退 | `apps/zcode-cli/packages/adapters/src/mcp/node-fallback.ts`、`bootstrap/src/app/mcp-node-fallback.ts` |
| 常驻池/生命周期 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts`、`session-lifecycle/` |
| 会话数据协议 | `packages/shared/src/zcode-protocol-v4/session-data/` |
| 输入预测协议 | `packages/shared/src/zcode-protocol-v4/input-prediction/` |
| 对话遥测 | `packages/shared/src/conversation-telemetry/`（不吸收） |
| 请求安全 edition | `packages/shared/src/request-security-edition/`（不吸收） |
| Sites 插件 | `apps/zcode-cli/packages/zcode-site-plugin/`（不直接吸收） |

### 10.3 更新日志逐条覆盖

**3.17.2 新功能**：Sites→C6；插件一键更新→C1；Kimi/MiniMax 模型→D6；文档查看器→C11；图片标注→C2；未读筛选→C4；项目批量管理/清理数据→B3；统一数据同步→B1；远程设备列表→B5；远端停止/重启→B4；工作流配额续跑→C8；CUA 多会话光标→C9；MCP 无 Node→A8；预览整卡点击→C12；MCP 配置界面→C5；Finder/资源管理器打开→C3。

**3.17.2 修复**：配置损坏不覆盖→A7；用户级迁移→B1；父子技能同步→B1；长对话流式→§2.3；远程兼容→H；安全策略快速报错→H；内置工具显示→H；无进展重复执行→H；错峰不续费→G6；Windows 遮挡→H；删除项目后新建→B3/H；macOS 语言资源→E3；安装包体积→E3；浏览器附件链接→H；微信推送→H；会话切换归属→H；Windows 安装包组件→E3；托盘红点→C4/G1；Plan 高风险→A1；子任务权限→A2；本地网页预览范围→A4；MCP 启动失败原因→H；MCP 设置检测→A6；自定义命令脚本→A3；Windows 插件命令路径→H；Windows 默认应用→C3；macOS 应用图标→C3；产物卡片刷新→H。

**3.16.3 新功能**：复制设备号→C15；登录链接复制→C16；文档查看器按会话隔离→C11；文档插件共用进程→C11；插件后台保留上限→C17。

**3.16.3 修复**：子代理查看文档→C11/H；内置组件重建→H；最后终端标签→H；长文本/输入法卡顿→H；切换任务输入法草稿→H；空白工具卡→H；中断会话未读→C4/H；远程连接原因→H；远程兼容→H；远程发消息延迟→§2.1/H；远程目录失败保留本地→B5/H；手机远控终端→H；远程项目模型测试→H；文件树位置→H；侧栏插件顺序→H；插件市场 UI→H；更新说明气泡→H；本地文件夹识别→H；重启会话子目录→H；并发写数据→A9；容器插件缓存→H。

> `H` 项按 §3.H 处理：实施前先按关键词在 3.17.2 源码定位，不能只按日志改。

### 10.4 我们仓库的当前快照（2026-11-11）

- 内核：Rust 默认（`NIBI_KERNEL=node` 回退），parity 14 项全关。
- Electron：44.10.1；provider 目录 rev 36（上游 43）。
- Node 树：仍有 `custom-command-shell-expansion.ts`、无常驻池、`commitForkBundle` 事务内有 `await`、`SessionPane` 发送前 `await resolveSessionDirectories`。
- Rust 树：无 `session/lifecycle/*`、无 `sessionData/*`、自定义命令解析期执行 shell。
- 测试：App 单测仍在（UI 976 个测试文件、services 251 个），上次 push 12,789 条。

### 10.5 本计划的维护

- 每完成一项，在本文件对应编号后标 `[x]` 并写提交号；每季度用最新上游 tag 重跑 §10.1 的命令，更新差异清单。
- 若上游把 P0-2/P1-1/P1-2 实施，优先对齐上游实现而不是保留我们的私有方案。

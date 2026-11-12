# ZCode 3.16.2 → 3.17.2 差异清单与 NIBI 吸收方案

> 状态：**Phase 0–3 已实施收口（2026-11-12）**；功能面见 §11–§14，之后来自真机对比的 UI/缺陷
> 修复见 §15；只剩真机验收与 scenes 文案发版（§15.3）。
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
- **[x] 我们已全部吸收（`364aefd2`）**：`SessionPane` 发送前先同步读窗口目录的任务归属，缺行才回退 `resolveSessionDirectories`；`createRemoteIdentityRegistrationCache` 按物理连接去重（Registry/Manager 各一份）；`project-tree-reader.ts` 只读在线主机；连发读取在同一微任务轮次合并，`ensureWorkspaceTab` 无变化返回原数组。上游 P0-2/P1-1/P1-2 仍未实施，我们按分析文档自行实现。

### 2.2 常驻会话池与生命周期（会话切换/内存）

**[源码] 新增 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts` + `session-lifecycle/`：**

- 常驻池参数：**目标 8 个、高水位 16 个、空闲 10 分钟**（`DEFAULT_SESSION_RESIDENT_TARGET_COUNT/HIGH_WATER/IDLE_TIMEOUT_MS`）。
- 淘汰原因：`high_water_lru` / `idle_timeout`；淘汰前检查 `persisted`、`hasResidencyBlockingWork`、`hasPendingInteractions`、`hasQueuedCommands`、`hasSubscribers`、`hasLegacySubscriber`；有任一阻止项就不淘汰。
- 生命周期状态机：`unloaded → starting → ready → stopping → unloaded`，失败进 `faulted`；`restart` 跨整个 stop+start 区间持有所有权。
- 协议方法：`session/lifecycle/getState`、`ensureReady`、`stop`、`restart`；[源码] 已在 app-server 注册，Host/UI 目前主要用池的自动收敛，方法留给后续。
- 每个协议 request 持 operation lease，request 结束触发收敛；另有 60s sampler 兜底。
- 额外：`pruneSessionEventStores` 按时间淘汰 subagent 的一次性 event store。
- **[现状] 我们两侧都已吸收**：Node 的常驻池在 3.16.2 基座里就有（`nibi-protocol/session-resident-pool.ts` 的 8/16/10 分钟、淘汰门与 60s sampler 都已装配），3.17.2 补的是 `session-lifecycle/` 状态机、四个协议方法与 stopping 闸门（`8564ec98`）。Rust 原来只有 `runtime/src/table.rs` 的 Loading/Open/Closing，现已加常驻池与生命周期状态机（`c9b19065`）。

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
| 远程身份缓存（P0-1） | 发送少 1 次往返、侧栏每轮少 N 次远端查询/开库 | **[x] `364aefd2`** | **P0** |
| 发送不等待远端查询（P0-2） | 回车到“发送中”≈90ms → ≈0ms | **[x] `364aefd2`**（缺行回退查询） | **P0** |
| 侧栏只读在线主机（P1-1） | 去掉 579 次/12h 无效调用 | **[x] `364aefd2`** | P1 |
| 合并连发读取（P1-2） | 370 轮 → 约 210 | **[x] `364aefd2`**（同 tick 合并） | P1 |
| 渲染隔离 | row/turn 执行数降一个数量级 | 无 | **P0** |
| 常驻会话池 | 会话切换/内存稳定，热会话常驻 | **[x] Node `8564ec98` / Rust `c9b19065`**（Node 基座已有池，补 lifecycle） | P1 |
| 虚拟滚动细节 | 长历史滚动/搜索成本 | 有基线，细节待对齐 | P1 |
| Electron 44 | 渲染/JS 整体提升 | 已是 44.10.1 | 无需 |

## 3. 全量变化清单

> 编号用于后续提交/任务引用。每条的「吸收目标」写 `Node`（apps/zcode-cli）、`Rust`（kernel/）、`Host/UI`（两内核共用）或 `不吸收`。

### A. 安全与权限

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| A1 | Plan + Guarded 危险命令免确认漏洞修复；Plan 下 MCP 询问不提供“始终允许” | [源码] `core/src/permission/service.ts` | 已实施 | **[x] Node `7eb98256` / Rust `a11fc5c3`**：Node 直接移植（plan deny 优先 → guarded 单次确认 → plan 放行）；Rust 按 `ExecutionState` 基础模式判决，plan 下危险命令是**拒绝**（对齐上游 `guarded-mode.test.ts`），并补上生产路径缺失的 `ask_once` 转发；**P0** |
| A2 | 子代理权限与主会话一致：explore 不再用独立 default `PermissionService`；插件 profile 只能收紧 | [源码] `runtime/methods/subagent.ts`、`bootstrap/src/subagents.ts` | 已实施 | **[x] Node `7eb98256` / Rust `a11fc5c3`**：子代理共享父会话权限服务；`permissionModeRestrictOnly` + 严格度表只收紧；explore 继承父模式与 plan，子会话用精简 plan 提醒；Rust 子循环本就共享判决链，补上所有模式的收紧与执行状态落库；**P0** |
| A3 | 自定义命令 `!`/```` ```! ```` shell 不再解析期执行，改写为给模型的 Bash 指令，经权限确认 | [源码] `contracts/src/commands/index.ts::handOffCustomCommandShellBlocks`；删除 `custom-command-shell-expansion.ts` | 已实施 | **[x] Node `9aab88cd` / Rust `a11fc5c3`**：两内核都改为文本改写 + 模型 Bash 调用；删掉解析期执行者与 unsupported 诊断；**P0** |
| A4 | 本地 HTML 预览签名目录：`file://` → `zcode-html://`，每次资源请求验签 + 真实路径检查 | [源码] `desktop/src/main/browser-local-preview/`、`docs/browser-use/local-html-preview.md` | 已实施 | **[x] `9d3d66b9`**：Host 移植为 `nibi-html`，只在内置浏览器分区安装并封住原始 `file` 读面；**P0** |
| A5 | 工作区 MCP 信任：项目 MCP 声明按 digest 记录信任/评审 | [源码] `bootstrap/src/workspace-mcp-trust/` | 已实施 | **Phase 1 [x] Host `mcpWorkspaceTrust/index.ts` + Rust `ext/src/mcp/trust.rs`**：用户域 `security/workspace-mcp-trust-v1.json`（Host 唯一 writer，`updateJsonObjectFile` 原子写），构建期无第二份存储；Host 与内核同一 canonical digest；未信任/声明变化/损坏/离线默认拒绝；UI `getEnabledMcpServersForZCode` 过滤未信任项目 MCP；内核 `McpManager::start/reconcile` 跳过并以 `mcp.project_trust.rejected` 诊断。**2026-11-12 收尾**：信任实现下沉 `services/src/mcp-trust`，`IMcpSyncService` 回传远端 trust/unreviewable 并支持远端审批；设置页评审入口与会话内未信任提示条接线；**P0/P1** |
| A6 | MCP 设置检测仅限已注册工作区 | [源码] `workspace-mcp-trust` 与 MCP 设置测试 | 已实施 | **Phase 1 [x] Host**：`LoadMcpFromUserDirectory` 只读本窗口 `windowWorkspaceMap` 登记过的工作区，未登记只返回用户级 MCP；trust registry 的未注册/离线路径 fail-closed；**P0** |
| A7 | 用户级 `config.json` 写入加固：损坏时报错不覆盖、写前重读、只改自己字段、临时文件+rename | [源码] `docs/issues/data-sync/01-harden-user-config-writers.md`、`services/src/fs/atomicFileUtils.ts` | 已实施 | **[x] `a7e6633a`**：`updateJsonObjectFile` 落地到命令/钩子/技能/MCP 目录/迁移导入/插件目录六处写入；Rust 的配置写入是原子临时文件，无同类宽松读取；**P0** |
| A8 | MCP stdio 无 Node 回退：Electron Node + 内置 npm/npx | [源码] `adapters/src/mcp/node-fallback.ts`、`bootstrap/src/app/mcp-node-fallback.ts` | 已实施 | **Phase 1**：需要随包 npm staging（构建链）与真机验证，不在 Phase 0 出口内；见 §11；**P1** |
| A9 | **多会话并发写数据异常**：`commitForkBundle` 在 `DatabaseSync` 事务里 `await`，其他会话的写入会被 fork 回滚误删；改为事务内同步写 + 新增 `commitMessageBundle`（`begin immediate`） | [源码] `adapters/src/storage/session-store/sqlite-session-store.ts` | 已实施 | **[x] `89a03069`**：事务内全部同步写，新增 `commitMessageBundle` 并用于 compact 整组提交；Rust node-store 本来就是同步事务；**P0** |
| A10 | fork 的 `compactLeadingMessageIds` 元数据非数组时不再抛错（字符串被逐字符校验、数字 TypeError） | [源码] 同上 | 已实施 | **[x] `89a03069`**：非数组按空忽略，与读取方一致；**P0（小）** |

### B. 数据同步与远程设备

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| B1 | 统一数据同步页：命令/钩子/技能/MCP/inline 插件/marketplace 插件/子代理/用户配置；哈希三态、分批、父子技能同批、不删远端独有、离线 fail-closed | [源码] `ui/src/data-sync/`、`services/src/data-sync/`、`docs/remote/data-sync.md` | 已实施 | **[x] 六类已接入并收敛入口**：技能 `1c17b5e4`；MCP / 命令 / 钩子 / 子智能体 / inline 插件在 Phase 3（见 §14）；marketplace 重装并入 plugins 分类；跨分类全选与「推送全部」已做；旧三类同步弹窗及其入口已删除（2026-11-12）；**P1** |
| B2 | 设置页 Scope 按设备分组（本机/远端用户/项目），离线不列出、fail-closed | [源码] `ui/src/settings-scope/` | 已实施 | **[x] `0f8b730f`**：settings-scope managed 模块 + 插件/MCP/子智能体/钩子/命令/技能页统一接线；远端「用户」走 attachment，离线 fail-closed；数据同步前置；**P1** |
| B3 | 项目彻底删除：`v4/storage/sessionData/measure / purge`，运行中/被引用保留、幂等 | [源码] `shared/src/zcode-protocol-v4/session-data/`、`ProjectManagement.tsx` | 已实施 | **[x] Rust `3bee959e` / Host+UI `04824ccd`**：内核两方法、Host 按 cwd 分组与 checkpoint 清理、项目菜单“清理数据”与删除项目可选清理；旧内核隐藏；**P1** |
| B4 | 远端服务停止/重启（daemon 生命周期） | [源码] `docs/issues/remote-daemon-lifecycle/` | 已实施 | **[x] `7229bd42`**：`stop --wait`、整树 `restart`（crash-loop 可恢复）、Host 生命周期 flight、确认前列运行任务、版本门禁；**P1** |
| B5 | 远端设备紧凑可搜索列表、在线状态、停止/重启菜单 | [源码] `settings/SourceServerDeviceRow.tsx`、`sourceServerDeviceList.ts` | 已实施 | **[x] `7229bd42`**：紧凑可折叠 + 搜索 + 在线优先/最近使用冻结排序 + 停止/重启菜单；**P1** |
| B6 | Provider provisioning lane 状态 + 失败重试 | [源码] `services/src/provider-provisioning-status/` | 已实施 | Host（依赖数据同步）；**P2** |
| B7 | 远端「仅常驻」行读取（手机项目列表预加载最新一页） | [源码] `services/src/zcode-agent/resident-rows-range/` | 已实施 | Host + Rust 能力声明；**P2** |

### C. 功能与 UI

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| C1 | 插件一键全部更新 | [源码] `ui/src/settings/PluginsSection.tsx`、`PluginStoreCard.tsx` 的 `updateAll` | 已实施 | Host/UI；**P2（小）** |
| C2 | 图片预览标注并作为附件发送 | [源码] `ui/src/image-preview-editor/` | 已实施 | Host/UI；**P2** |
| C3 | 文件菜单：系统关联应用、另存为、在 Finder/资源管理器打开 | [源码] `ui/src/file-menu/`、`desktop/src/main/file-open-apps/` | 已实施 | **[x]** Host/UI：产物菜单含另存为；2026-11-12 聊天附件卡片与 composer 附件 chip 补齐打开/在文件夹中显示/另存为/复制路径（拿不到本地路径、远端会话时降级）；**P2** |
| C4 | 未读任务：标记未读；托盘红点移除 | [源码] `TaskActionMenuContent`、`TaskList`、`desktopTray.ts` | 已实施 | **[x]** 标记未读、未读视图、任务栏/Dock 角标保留；2026-11-12 托盘图标的未读数字/红点合成已移除；**P2（小）** |
| C5 | MCP 配置界面（草稿版） | [源码] `docs/plugins/draft-mcp-ui-session-spec.md` | 草稿 | **[x]** Host/UI：新增/编辑先进内存草稿，保存才落盘；字段级现场校验、无效禁用保存、离开/切换确认；**P2** |
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
| D6 | Provider 目录 rev 33 → 43：13 个新模板、38 个新模型、移除 3 个旧 MiniMax | [源码] `config/provider/zcode-builtin.json` | 已实施 | **[x] 已同步，无需改动**：逐条比对 3.17.2 源文件，随包 `nibi-builtin.json` 已是 34 模板 / 316 条 `templateModelRules`（与上游完全一致），只按设计排除 6 条 `zcode.z.ai` 专属站点规则；随包 revision 36 是 NIBI 自己的内容版本号，不跟上游 43；**P0（低风险）** |

### E. 平台与构建

| # | 变化 | 证据 | 上游状态 | NIBI 动作 |
| --- | --- | --- | --- | --- |
| E1 | Electron 41.0.3 → 44.7.0（macOS 最低 13） | [源码] `packages/desktop/package.json`、`docs/electron/electron-44-upgrade.md` | 已实施 | 我们已是 44.10.1；无需 |
| E2 | electron-builder 26.8.1 → 26.17.0；electron-updater 6.8.3 → 6.8.10 | [源码] 同上 | 已实施 | **[x] 2026-11-12**：升到 26.18.1 / 6.8.12；配置用新版 schema 校验通过；NSIS 编译用例改用 toolsets 新 helper；**仍需一次真实 Windows NSIS+zip 打包验证**；**P2** |
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
| G2 | 旧三类分散同步弹窗入口 | [源码] 数据同步页接管 | 跟 B1 | **[x] 2026-11-12**：技能/MCP/插件三套旧弹窗、共享入口组件、对应测试与 i18n key 删除；设置页/工作区头部/远程连接横幅/项目侧栏统一跳数据同步页并预选分类 |
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

### 4.2 P1：常驻池与生命周期（直接移植）**[已完成 `8564ec98`]**

- 池本体在 3.16.2 基座已存在（8/16/10 分钟、LRU、淘汰门、60s sampler）；本次补 `session-lifecycle/` 状态机、`operationCount`、ready 准入与完整 release 语义。
- `v4-gateway` 在 stopping 时返回 `fault.sessionLifecycle.stopping`；`create/resume/fork/close` 收口到生命周期 owner。
- 验收：高水位 LRU、空闲淘汰、有订阅/队列/交互时不淘汰、stop/restart 幂等、faulted 不重建、request lease 释放触发收敛、60s sampler 兜底（221 条相关测试通过）。

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

1. **A1 Plan + Guarded**：检查 `crates/policy/src/lib.rs` 的判定顺序。Node 的漏洞是 `planEnabled` 跳过 guarded 单次确认、再由 plan 分支放行；Rust 的 plan 是独立开关，`effective` 模式会变，必须按 `ExecutionState` 的基础模式识别危险命令。**以 3.17.2 源码与测试为准：`checkPlanMode` 对非只读工具直接 deny，plan 下的危险 Bash 是拒绝而不是询问**；guarded 的单次确认只发生在 plan 闸门放过之后。验收：plan+guarded 危险 Bash 被拒绝（`mode.plan.nonReadOnly` 同义文案）；plan 拒绝优先于 guarded；hook 放行不能代替单次批准或 plan 的拒绝；MCP 询问不带“始终允许”。
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

1. **D1 `sessionData/measure|purge`** **[x] `3bee959e`**：`protocol-nibi` 两个方法 + `kernel-api` 端口 + node-store 文件/行删除 + runtime 编排；运行中/被引用/分享钉住保留，幂等，先删文件后删行。
2. **D3 常驻池 + 生命周期** **[x] `c9b19065`**：`runtime::lifecycle` 是唯一写者（unloaded/starting/ready/stopping/faulted），`runtime::resident` 常驻池（8/16/10 分钟、lease、60s sampler）；淘汰门覆盖 running turn、queue、pending interactions、cron 到点、后台 shell/子代理、Live 订阅、DWF 在飞；stop 复用 close_open，不删存储、不发 `session.removed`；四个协议方法已注册，stopping 时 v4 返回 `fault.sessionLifecycle.stopping`。
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

### Phase 0：安全 + 数据完整性 + 远程回归（第 1–2 周）**[已完成 2026-11-11，见 §11]**

- Node：A1、A2、A3、A9、A10、远程 P0-1/P0-2（A8 顺延到 Phase 1，见 §11）。
- Rust：A1、A2、A3（语义对齐 + 测试）。
- Host/UI：A4、A7、远程 P0-1/P0-2（P1-1/P1-2 一并完成）。
- 数据：D6 provider rev 43 —— 核查后随包内容已与上游一致，未改动。
- 出口：
  - plan 下危险命令被拒绝；非 plan 的 guarded 危险命令必须单次确认；explore 子代理在 plan 下受限；
  - `/命令` 的 `!` 变成需确认的 Bash 调用；
  - fork 并发写不再互相回滚；
  - 发送不再固定多等两次串行远端往返（目录缺行时才回退查询）；
  - provider 目录新模板已可用（34 模板 / 316 条模型规则）。

### Phase 1：长会话渲染 + 常驻池 + MCP 安全（第 3–5 周）**[已完成 2026-11-11，见 §12]**

- Host/UI：渲染隔离（§6.1）、虚拟滚动细节、分组列表虚拟化阈值 → `23106f99`。
- Node：常驻池/生命周期（池在基座已有，补 lifecycle）→ `8564ec98`。
- Rust：D1 `sessionData` `3bee959e`；D3 常驻池/生命周期第一版 `c9b19065`。
- Host + Rust：A5/A6 工作区 MCP 信任 `a65f236e`（设置页入口 `6519f6fb`）；A8 无 Node 回退 `ed91e03f` + Rust Windows 解析 `5b7bb702`。
- 出口：
  - 渲染隔离：180 条隔离/缓存/导航测试通过；未用上游同款计数探针量化，真机冒烟待做；
  - Node 常驻池 8/16/10min 生效，有订阅/队列/交互不淘汰（221 条测试）；
  - Rust 生命周期状态机与 `ensureReady` 已实现并有测试；
  - MCP 信任记录生效，未信任项目 MCP 不装载；设置页可信任/撤销。

### Phase 2：数据同步 + 项目删除 + 远端运维（第 6–9 周）**[已完成 2026-11-11，见 §13]**

- Host/UI：B2 设备 Scope → **[x] `0f8b730f`**；B1 数据同步技能单类试点 → **[x] `1c17b5e4`**（其余类别待扩）。
- Host/UI + Rust：B3 项目彻底删除（UI + `sessionData/measure|purge`）→ **[x] `3bee959e` + `04824ccd`**。
- Host/server：B4 远端服务停止/重启 → **[x] `7229bd42`**；B5 设备列表 → **[x] `7229bd42`**。
- 出口：
  - 技能同步的对比/推送/离线/迟到结果语义全过；其余类别待接入；
  - 项目删除保留运行中/被引用会话，幂等（Host/UI 已完成，真机冒烟待做）；
  - 远端 crash-loop 可在设备卡自救（CLI 整树 restart + Host flight + 设备卡确认，真机 E2E 待做）。

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
| A1 | plan 下危险 Bash 被拒绝（plan 拒绝优先）；非 plan 的 guarded 危险 Bash 必须 `user-once` 询问；hook 放行不能代替批准或 plan 的拒绝；MCP 询问无“始终允许” |
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

### 10.4 我们仓库的当前快照（2026-11-11，Phase 0 之后）

- 内核：Rust 默认（`NIBI_KERNEL=node` 回退），parity 14 项全关。
- Electron：44.10.1；provider 目录随包 revision 36，内容与上游 rev 43 一致（34 模板 / 316 条模型规则）。
- Node 树：`custom-command-shell-expansion.ts` 已删除；`commitForkBundle` 事务内无 `await` 并有 `commitMessageBundle`；`SessionPane` 发送前同步读目录事实、缺行才回退查询；仍无常驻池（Phase 1）。
- Rust 树：`ExecutionState` 已进 `ToolUseContext`，plan 拒绝优先于 guarded；自定义命令只改写不执行 shell；无 `session/lifecycle/*`、无 `sessionData/*`（Phase 1）。
- 测试：App 单测仍在（UI 976 个测试文件、services 251 个）；2026-11-11 全量 Node 单测 18,200 条、Rust workspace 全绿（TUI esc 偶发除外）。

### 10.5 本计划的维护

- 每完成一项，在本文件对应编号后标 `[x]` 并写提交号；每季度用最新上游 tag 重跑 §10.1 的命令，更新差异清单。
- 若上游把 P0-2/P1-1/P1-2 实施，优先对齐上游实现而不是保留我们的私有方案。

## 11. Phase 0 执行记录（2026-11-11）

上游源码参考：`D:/NIBI/.ref-zcode`，checkout `a9fe401`（v3.17.2）。所有改动只提交、未推送。

### 11.1 提交

| 范围 | 提交 | 内容 |
| --- | --- | --- |
| Node A1+A2 | `7eb98256` | plan/guarded 判定顺序、`optionsPolicy`、CronPauseSelf 预批准、子代理权限同源、插件 profile 只收紧 |
| Node A3 | `9aab88cd` | `handOffCustomCommandShellBlocks`；删除解析期 shell 执行与 CLI 重复路径 |
| Node A9+A10 | `89a03069` | 事务内同步写、`commitMessageBundle`、`compactLeadingMessageIds` 容错 |
| Host/UI 远程 | `364aefd2` | 身份登记缓存、发送不预查目录、侧栏只读在线主机、同 tick 合并、`ensureWorkspaceTab` 稳定引用 |
| Host A4 | `9d3d66b9` | `nibi-html` 签名目录协议，内置浏览器分区安装并封住原始 `file` |
| Host A7 | `a7e6633a` | `updateJsonObjectFile` 与六处 config.json 写入收紧 |
| Rust A1+A2+A3 | `a11fc5c3` + `b8622970` | `ExecutionState` 接线、plan 拒绝优先、`ask_once` 转发、子代理/插件只收紧、命令 shell 交权 |

### 11.2 门禁结果

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm architecture:check --changed`：0 violations。
- `pnpm test:unit`：1931 个测试文件 / 18,200 条通过，76 条 skipped（5 个文件 skipped），0 失败。
- Rust：`cargo check --workspace --all-targets` 通过；改动 crate 的 clippy 无新增告警；`cargo test --workspace --no-fail-fast` 除 `nibi-kernel-tui` 的既有偶发 `esc_before_the_turn_is_drawn_puts_the_input_back`（超时型，单跑 3/3 通过，见 `nibi-rust-custom-commands-and-audit-2026-11-10` 的记录）外全绿。
- 未执行：真实会话的 `!` 命令 E2E（模型看到 bash 块并触发确认）；远程发送的真机 12 小时日志复测；A4 的 Electron 真机预览。

### 11.3 执行中的发现

- **D6 无需同步**：随包 `config/provider/nibi-builtin.json` 已是上游 rev 43 的内容（34 模板、316 条 `templateModelRules`，逐条一致），只按设计排除 6 条 `zcode.z.ai` 专属站点规则；随包 revision 36 是 NIBI 自己的内容版本号。
- **A1 的正确语义以源码为准**：计划初稿把验收写成“plan+guarded 危险命令必须询问”，但 3.17.2 的 `checkPermission` 是 plan deny 优先（`guarded-mode.test.ts` 明确断言 `deny / mode.plan.nonReadOnly`）。Node 与 Rust 均按 deny 落地；guarded 的单次确认只在 plan 闸门放过、且基础模式是 guarded 时生效。
- **Rust 生产路径的真实缺口**：`runtime::permissions::SharedRules` 没有转发 `PermissionGate::ask_once`，一直落到 trait 缺省 `false`，guarded 的单次批准会被 PermissionRequest hook 顶掉；单元测试直接打 `PolicyGate` 看不出来。已补转发与锁定测试（`a11fc5c3`）。
- **插件 profile 的 `permissionMode`**：Rust 原来完全忽略；按 3.17.2 改为解析后只收紧（`b8622970`），与 Node 的 `permissionModeRestrictOnly` 一致。

### 11.4 顺延项

- **A8（MCP 无 Node 回退）**：需要随包 npm 的构建期 staging（下载 npm tarball、integrity 校验、`prepare:agent-bundle` 接线）与真机验证，不属于 Phase 0 的“安全/数据完整性/远程回归”出口；按 §3 的 P1 优先级移到 Phase 1，与 A5/A6 一起做。
- **Phase 1 其余项**：渲染隔离、常驻池/生命周期、`sessionData/measure|purge`。
- **A5/A6 剩余接线**：设置页「信任/撤销」评审弹窗与会话内待审核提示；没有审核入口时项目 MCP 默认拒绝（Host 已提供 review/decision 服务、UI 装载过滤与测试）。


## 12. Phase 1 执行记录（2026-11-11）

### 12.1 提交

| 范围 | 提交 | 内容 |
| --- | --- | --- |
| Host/UI 渲染隔离 | `23106f99` | turn render unit cache、行级选中、导航预览复用、overscan 2、宽度批处理、搜索粗定位、分组列表边界测试 |
| Node 常驻池/生命周期 | `8564ec98` | `session-lifecycle/` 状态机、四个协议方法、stopping 闸门、完整 release |
| Rust sessionData | `3bee959e` | `v4/storage/sessionData/measure|purge`、文件/行删除、运行中/被引用保留 |
| A8 MCP 无 Node（Node/Host） | `ed91e03f` | shim、PATH 合并、Electron-only 装配、随包 npm staging、Host 注入 |
| A8 Rust Windows | `5b7bb702` | PATH/PATHEXT 解析、npm/npx 回退、`.cmd` 经 cmd.exe |
| A5/A6 MCP 信任核心 | `a65f236e` | Host 唯一写者、摘要、未信任不装载、A6 已注册工作区 |
| Rust 常驻池/生命周期 | `c9b19065` | `runtime::lifecycle` + `runtime::resident`、淘汰门、协议四方法 |
| MCP 信任设置页 | `6519f6fb` | 待信任/已信任/已变化/不可审核、信任/撤销、i18n、A6 窗口 ID 修正 |

### 12.2 与上游的对照与差异

- **Node 常驻池不是新增**：3.16.2 基座已有 8/16/10 分钟池、淘汰门与 sampler；3.17.2 新增的是生命周期状态机、四个协议方法与 stopping 闸门。计划 §2.2 初稿的“Node 也没有”已纠正。
- **Rust A8**：上游 Rust 无对应实现；我们补了 PATH/PATHEXT 解析与 Electron 回退，`.cmd` 经 `cmd.exe /d /s /c`（cross-spawn 同款转义）；`node` 回退直接执行 Electron 可执行文件。
- **MCP 信任**：Host 记录在 `<存储根>/security/workspace-mcp-trust-v1.json`；Rust 只读同一份文件，摘要算法与 Host 固定向量一致（`6781e00d…`）。
- **sessionData**：口径与上游一致（只统计真正删除的文件、数据库行不计入、先文件后行、分享钉住保守保留）。

### 12.3 门禁

- `pnpm typecheck`：通过。
- `pnpm lint`：0 errors（159 条既有 warning）。
- `pnpm architecture:check --changed`：0 违规；新增 5 个 managed 模块（adapters/bootstrap/services/UI×2），desktop 的信任 IPC 与 preload 桥并入既有 `mcp-workspace-trust`。
- `pnpm test:unit`：1948 个测试文件 / **18,286 条通过**，76 条 skipped（5 个文件 skipped），0 失败。
- Rust `cargo test --workspace --no-fail-fast`：全绿，唯一例外是 TUI 两个并行负载下的时序敏感用例（`esc_before_the_turn_is_drawn_puts_the_input_back` 既知偶发；`footer_stats::the_context_share_updates_once_the_conversation_is_compacted` 出现过一次，单跑 8/8、`--test-threads=1` 全绿）。
- 新增测试：渲染隔离 180 条；Node lifecycle 221 条；sessionData 各 crate（node-store 202、protocol-nibi 325、runtime 126）；MCP 信任 74 + 106 条；A8 adapters 18、bootstrap 5、services 10、desktop scripts 8、Rust env-local 107。
- 未执行：真机 Electron 渲染计数与 A4/A8 整包冒烟；渲染隔离的执行数未用上游同款探针量化。

### 12.4 已知边界

- 渲染隔离只保证结构与 memo 边界，浏览器级 hover/宽度/搜索视觉未跑 E2E。
- A5 的会话内待审核提示未做；远端 workspace 的 MCP 目录暂不返回 trust（fail closed）。
- sessionData 的“被引用”不含 cron 持久任务与 workflow_activity；跨进程运行态需 Host 路由。
- Rust 生命周期不覆盖跨进程/远端 daemon 实例；`session/lifecycle/changed` 通知未实现。

## 13. Phase 2 执行记录（2026-11-11）

### 13.1 已完成

| 项 | 提交 | 内容 |
| --- | --- | --- |
| B3 Rust | `3bee959e` | `v4/storage/sessionData/measure|purge`；文件口径、运行中/被引用/分享保留、幂等 |
| B3 Host/UI | `04824ccd` | shared 契约、-32601→unsupported、Host 按 cwd 分组与 checkpoint 清理、项目菜单“清理数据”、删除项目可选清理 |
| B2 | `0f8b730f` | settings-scope managed 模块；插件/MCP/子智能体/钩子/命令/技能页统一 Scope；离线 fail-closed；表单 owner 按设备 |
| Rust 生命周期通知 | `e2291835` | `session/lifecycle/changed`，有订阅者才推、失败不影响收敛 |
| B4/B5 | `7229bd42` | `stop --wait`、整树 `restart`（crash-loop 恢复）、Host 生命周期 flight、确认前列运行任务、紧凑可搜索设备列表与停止/重启菜单 |
| B1 技能试点 | `1c17b5e4` | data-sync 服务/UI 模块；三态、父子同批、远端独有不删、离线 fail-closed、迟到丢弃、单项失败重试；设置页「数据同步」分区 |

### 13.2 门禁

- `pnpm typecheck`、`pnpm lint`（0 error）、`pnpm architecture:check --changed`（0 违规）：通过。
- `pnpm test:unit`（B1 后）：1968 个测试文件 / **18,399 条通过**，76 条 skipped，0 失败。
- 新增测试：B3 72 条；B2 201 条；B4/B5 CLI 9 条 + desktop 8 条 + UI 19 条 + 既有相关 300+ 条；B1 69 条。
- 未执行：真实 SSH/WSL/Docker 设备的停止/重启、桌面 R3 daemon E2E、手机远控被动断线 E2E；渲染计数与真机冒烟仍未做。

### 13.3 已知边界

- B4 的崩溃恢复用“持久化状态 + 无存活 Supervisor”和运行中进程树重启两种场景覆盖，未等真实连续崩溃退避。
- 上游 issue 06（操作失败但旧连接仍在时显示“连接失败”）未修。
- 版本门禁取 NIBI `4.0.0`，开发构建 `0.0.0-dev` 会显示禁用。
- B5 设备列表并入既有受管 `SourceServerManagementPanel`，未新增上游同名的独立文件。
- B1 只做技能：MCP/命令/钩子/插件/子智能体/用户配置未接入；设备概览、推送全部、上次同步状态持久化与旧入口统一未做；远端独有按不可勾选行展示（上游隐藏）。
- 数据同步的目标端统一 `~/.nibi/skills`，来源兼容 `~/.agents/skills`；启用状态写 `cli/config.json`，不是上游 `~/.zcode`。

## 14. Phase 3 执行记录（2026-11-11，B1 扩类）

### 14.1 已完成

| 项 | 内容 |
| --- | --- |
| 共享契约 | `McpDataSyncPayload`、`CommandDataSyncPayload`、`HookDataSyncPayload`、`SubagentDataSyncPayload`；`DataSyncItemDependencies`、`DataSyncWorkspaceMapping`、`target-compat-config`；`IDataSyncCategoryService` 增加可选 `targetHomeDir` / `workspace`（旧实现不受影响） |
| MCP | `data-sync/mcpDataSync.ts`：按小写名对齐、`~/.agents/mcp.json` 兼容配置整类阻断、目标 home/workspace 路径改写、启用态新建带来源/覆盖保留目标、乐观并发 `expectedTargetHash`、坏 JSON 不写、远端独有不删 |
| 命令 | `data-sync/commandDataSync.ts` + `commands/commandStorage.ts`：两来源合并（`.nibi` 优先）、大小写同 key、保留子目录结构、原子写、config 写失败回滚新建文件、软链阻断、远端独有不删 |
| 钩子 | `data-sync/hookDataSync.ts`：定义级合并（事件 + matcher + 类型 + 命令）、根开关只开不关、覆盖保留目标 `enabled`、坏配置不写、其他配置字段保留；路径固定 `~/.nibi/cli/config.json`，与 hooks 加载/保存同源 |
| 子智能体 | `data-sync/subagentDataSync.ts`：按名（trim + 小写）对齐、markdown 迁移后字节哈希、依赖提示（MCP/技能）、agents-state 启用态、覆盖保留目标文件名与启用态、远端独有不删 |
| 接线 | 数据同步方法挂在四个既有通道上（`mcp-sync` / `commands` / `hooks` / `subagents`），`source-settings` attachment 已暴露这些通道，不新增 RPC 通道；`data-sync/node.ts` 导出五类工厂，`module.ts` provides 五类 |
| UI | 分类标签（技能 / MCP / 命令 / 钩子 / 子智能体）+ 概览计数 + 分类徽标；MCP 整类阻断提示；子智能体依赖提示；切换分类清空选择；中英文 i18n；`useDataSyncSkills` 保留为 `category: "skills"` 薄包装 |
| 架构 | `commandStorage.ts` 按 `commands-data-sync-storage-split` 准入：命令根解析与启用覆盖只维护一份，避免 `commandsService ↔ commandDataSync` 运行期循环 |
| C13 按未读 | `ProjectSidebarView` 增加 `unread`，菜单为「按项目 / 按分组 / 最近更新 / 未读」；未读集合与系统角标共用同一 ProjectTree 选择器（跨项目置顶、本地未归类、去重规则一致），按最近更新时间倒序，复用时间线与 20 条分页，空态「暂无未读任务」；打开任务仍走既有已读 CAS |
| C2 图片标注 | `image-preview-editor` managed 模块（归一化坐标、画笔/箭头/矩形/椭圆/文字/橡皮擦、撤销重做、自然尺寸 PNG、序列化与命中测试）；文件预览「标注」入口只在桌面且源为 base64 位图时显示；完成后按会话/草稿作用域交给 Composer 既有附件队列，不直接发送、不改附件协议 |
| C3 另存为 | 产物「作为文件打开」菜单增加「另存为…」：把这一版字节交给宿主原生保存对话框（`saveFile`），不是 `~/.nibi/tmp` 副本；无 `saveFile` 的宿主不显示该项 |
| B1 插件分类 | `inlinePluginDataSync`：按插件 id 对齐 inline 插件、签名/哈希排除顶层 `data/`、覆盖保留目标 `data/` 与启用态、createOnly 冲突与 overwrite 乐观并发、坏 config 整批不写；`pickPortablePluginOptions` 双向筛选 options；UI 增加「插件」分类 |

### 14.2 门禁

- 代码提交：`c6c84942`。
- `pnpm typecheck`、`pnpm lint`（0 error）、`pnpm architecture:check --changed`（0 违规）：通过。
- 首次全量 `pnpm test:unit`：1978 个文件 / 18,449 条通过 / 76 skipped；2 条**超时**失败（Server CLI 的 Supervisor/Core 整树重启、subagents 双 Host watcher）。两条单跑均通过，属并行 worker 负载下的超时；已把这两条进程型用例的显式超时放宽（30s→60s、15s→30s）。
- 复跑全量：**1978 个测试文件 / 18,451 条通过 / 76 skipped / 0 失败**。
- 新增测试：MCP 9、命令 13、钩子 12、子智能体 10、UI 分类 8；既有技能/命令/钩子/子智能体服务测试与 UI 技能/设备测试全绿。
- C13/C2 提交 `4bf48b5a`：新增图片标注 19 条 + 侧栏未读/既有侧栏/预览/附件定向 186 条通过；typecheck、lint、architecture 通过，i18n 中英一致。
- C3 提交 `eaeed071`；inline 插件分类提交 `cf139590`（新增 inline 插件同步 10 条 + 插件/数据同步定向 47 条）。
- 最终全量 `pnpm test:unit`（插件分类后）：**1982 个测试文件 / 18,488 条通过 / 76 skipped / 0 失败**。

### 14.3 已知边界（2026-11-12 更新）

- 数据同步：旧远端缺方法时的版本门禁已补（`capabilityGate`，2026-11-12）；MCP 目标端使用
  `~/.agents/mcp.json` 兼容配置仍整类拒绝（与上游一致）；插件分类只覆盖 inline 插件，
  marketplace 插件按 `name@marketplace` 走安装语义，不做文件级同步。
- 命令/子智能体的「新建文件 + 写启用态」不是跨文件事务：config 写失败会回滚刚建的文件；
  其他项不受影响。
- 子代理重启续跑：崩溃瞬间正在执行的工具可能重做一次（结果未提交）；fork 子代理只恢复可见、
  不自动续跑；结果通知 at-least-once；Node 在继承父模型/未声明权限时可能缺
  `selection/execution`，Rust 容错为「可见但不可自动续跑」。
- Rust 生命周期（停止/重启/常驻）不跨进程，也不覆盖远端 daemon；B4 的整树重启只解决同机
  crash-loop。

### 14.4 C 项盘点（2026-11-11 初版，2026-11-12 收尾更新）

**已完成**

- 现状已有：C1 插件全部更新、C14 分组列表虚拟化。
- Phase 3：C2 图片标注、C13 侧栏未读、B1 六分类数据同步、B3 项目彻底删除、B4/B5 远端设备
  停止/重启与紧凑列表、B2 settings scope。
- 2026-11-12 收尾：A5 远端 MCP 信任回传 + 会话内提示；B3 引用口径补 cron 与
  workflow_activity；B1 marketplace 重装并入数据同步页 + 跨分类全选/「推送全部」；
  C3 聊天附件菜单（打开/在文件夹中显示/另存为/复制路径）；C4 托盘未读徽章移除；
  C5 草稿版 MCP 配置界面（内存草稿 + 现场校验 + 离开确认）；C15 帮助菜单复制设备号；
  E2 electron-builder 26.18.1 / electron-updater 6.8.12；G2 三套旧同步弹窗与入口删除；
  子代理续跑补「中断结果落库」与「恢复后注入 asks」。

**仍未做**

- B6 Provider provisioning lane 状态/重试；B7 远端「仅常驻」行读取。
- C12/C16/C19 已于 2026-11-12 补齐（预览卡片整卡点击、登录等待态复制授权链接、商店已安装优先）。
- C11 文档查看器按会话隔离/多文档共用进程、C17 插件后台保留时长上限（C17 复核已有 6h TTL/64 上限，实际无需做）。
- C18 文件树回到预览左侧：现状是 side pane 的右侧布局且已有导航切换按钮，属产品决策，暂不动。
- C8 暂缓：Rust DWF 没有 `providerStop.resetAt` 这类额度停止状态，只做 Node 轨等于只服务
  回退内核；等 Rust DWF 补齐停止原因后再两侧一起做。
- D4 `x-nibi-session-features` 请求头（P3，取决于是否做统计）。
- E3/E4/E5（安装包体积、macOS 语言资源、Windows 组件、Host 自资源遥测、electron-to-chromium 锁定）。
- H 组未定位项 2/4/5/7/8/9/10/11（H2/H7/H9 归 E3；H6 已随 B3 覆盖；H11 的 macOS 部分仍需单独核）。

**不吸收**：C6 Sites 插件、C7 官方命令端点、C9 CUA 多会话、C10 输入预测、D2 输入预测、
D5 请求安全 edition、G6 错峰续费、F1–F6 测试策略重构。

**发布前的外部确认**

- 真实 Windows NSIS + zip 打包（E2 升级后构建器内部实现换成 TS，静态校验不够）。
- 真机：无 Node 环境插件 MCP、SSH/WSL 的 trust 与数据同步、子代理强杀后续跑、图片标注真实发送、
  远端项目未读视图、桌面 R3 daemon E2E、手机远控被动断线。

## 15. 2026-11-12 客户端 UI 对齐与缺陷修复（P3 之后）

3.17.2 的功能面（§11–§14）已收口，这一轮全部来自运营者真机对比 ZCODE 后的反馈，属「对齐质量」
而非新功能吸收。逐条：

### 15.1 修掉的真 bug

| 现象 | 真因 | 落点 |
| --- | --- | --- |
| 新任务页 `Ctrl+V` 粘贴截图卡 0%、发不出去 | Rust 内核用 `store.load(session)` 判会话存在，draft 不写会话行 → commit 返回 `-32004`；Node 只查内存所以不复现 | `94196437`（内核 + UI 回归），详见 `docs/rust-kernel-function-parity.md` §15 |
| 项目页「清理数据」里出现 33 条 0 B 会话 | `reserveCreatedTask` 每次 createSession 先写占位行（`created_at=0`/`meta_json='{}'`），draft 预热重试会再写；草稿丢弃不回收 | `4a7c50dd`：写入侧/读取侧/启动自愈三层；本机 60 → 0，28 条真实会话保留 |
| 未启用插件的「立即试用」仍把消息发进会话 | UI 只判 `installed`；发送入口对 `plugin://` 引用零校验 | `fff3168d`：UI 编排（先启用/先开通会员）+ 发送侧 catalog 复核 |
| 未安装插件的详情页报「组件清单加载失败」 | 对未安装条目也调 `plugins/describe`，本地无插件根必然失败 | `794a721e`：未安装改中性提示，已安装失败仍可重试 |
| 插件市场图标缓存仍打 `.top` | 只迁 `icon`/`heroImage`，`homepage`/policy/author 没迁；且只改内存不回写 | `e0f03797`：整份快照迁移 + 原子回写，磁盘已无旧域名 |

### 15.2 对齐上游的 UI/交互

| 面 | 改动 |
| --- | --- |
| 设置 · 远程设备 | 分组改「偏好设置」，补「隐藏项目行设备名」开关（新设置项 `remoteProjectRowDeviceNameHidden`，项目行隐藏、悬停卡仍显示） |
| 设置 · 项目 | 去掉工具栏「移除项目 (N)」；行内改「…」菜单（移除… / 清理数据）；勾选后底部 sticky 浮动条；已移除项目折叠卡片 + 恢复 |
| 设置 · 数据同步 | 从「基础设置」归回「数据与统计」组首位；空态改居中虚线卡 + 连接设备 |
| 设置 · 迁移数据 | 单张筛选卡 → 六步向导（会话按工作区分组 / Skills / MCP / 命令 / AGENTS.md / 迁移）；复用首启 Onboarding 的步骤原语与执行器；插件步骤不展示、MCP 不读 `~/.claude.json`、AGENTS.md 只写复制覆盖 |
| 设置 · 插件 | 图标：存量 `.top` 迁移 + 相对路径解析 + 稳定哈希首字母兜底；「立即试用」锁定态降级为描边 + 锁图标 |
| 新建任务 · 推荐卡 | 一排四个、36px 高、图标 + 单行文案；办公模式主动推荐保持原样 |
| 会话 · 图片预览 | 右侧标注工具栏 + 「保存到对话」（编辑产生 PNG File 进 composer 待发送队列），补整链集成测试 |
| 内容 | `client/scenes` 的 draft-suggestion 收成四条四字（NIBI-Site `3726a91`，**未发版**） |

### 15.3 仍未做

- **scenes 服务端文案未部署**：客户端已按四卡渲染，文案仍是被截断的旧长度；发版走 `tools/deploy-api.sh`。
- **A 档真机验收**：NSIS 安装/升级、无 Node 的插件 MCP、A5 远端信任、A4 HTML 预览、图片标注真实发送、子代理强杀续跑。
- **B/C 档真机**：数据同步到真机、手机远控断线/审批卡、SSH/WSL、桌面 R3 daemon。
- §14.4 里的 B6/B7 与 C11/D4/E3–E5 仍按原结论挂着（产品决策或低价值）。

# data-sync

设置页「数据与统计 › 数据同步」：把本机用户级技能、MCP、命令、钩子、子智能体同步到远端设备（`docs/remote/data-sync.md`）。B1 从技能单类试点扩展为六分类页面，比较 / 推送 / 离线 / 迟到结果语义不变。

- `domain/compare.ts`：纯函数。两端 `listSyncItems` + 内容哈希 → 行状态与默认勾选；远端独有生成不可勾选行；父子技能同批分组；逐项结果汇总。
- `domain/pushQueue.ts`：纯函数。按分类固定顺序派发推送任务，分类级并发上限 2；汇总各分类结果（成功 / 失败 / 跳过），结果顺序与分类顺序一致。
- `app/useDataSyncDevices.ts`：复用 `settings-scope` 的设备分组，只列出在线、有「用户」目标的 Source 设备；Web / 手机没有 source-settings attachment，列表为空。
- `app/useDataSyncCategory.ts`：页面状态唯一 owner（六分类共用）。按 `category` 从 `IServiceAccessor` 取 `skillSyncService / mcpSyncService / commandsService / hooksService / subagentsService / pluginSyncService`；`generation` 绑定分类、设备与 attachment 换代；离线 / 连接中清空列表且不读写；推送逐批导出/导入，失败按项保留并可重试。`pushSelected` 在推送结束时返回本类结果快照，供概览汇总。
- `app/useDataSyncSkills.ts`：`category: "skills"` 的薄包装，保留同名导出与既有行为。
- `app/useDataSyncPushAll.ts`：概览「推送全部」编排。按分类顺序、限并发 2 调用各分类的 `pushSelected`；单类抛错只记为该类失败；加载阶段就命中能力门禁的分类直接记为失败且不重试。
- `ui/DataSyncSection.tsx`：设置页内容。设备选择、分类标签栏、概览、三态列表、本地/远端摘要、勾选、推送按钮（显示将写入数量）、逐项结果与重试。
- `ui/DataSyncOverview.tsx`：概览面板。跨类全选 / 取消全选 / 推送全部入口、逐类统计与推送结果汇总（分类 + 原因）。
- `ui/DataSyncLabels.ts`：分类名的 i18n 映射，概览与分类页共用。
- `contract.ts`：页面契约（分类、设备、通用行、推送结果）；`index.ts` 是唯一公共入口。

不变量：

- 分类：`skills / mcp / commands / hooks / subagents / plugins`，顺序固定；标签栏与概览共用。
- 行状态：只在本机 / 本机版本较新或内容不同 / 已同步 / 远端独有 / 不能同步。内容不同默认勾选；远端版本较新显示差异但默认不勾选；远端独有不可勾选、永不删除，推送结果记为跳过。
- 比较顺序：两端都有 `version` 时按版本（本机新 → 更新，远端新 → 差异，相同 → 已同步）；无版本时两端 `contentHash` 都有就直接比，否则签名不同 → 差异，签名相同才请求 `contentHashes`。JSON 类条目 list 自带 `contentHash` 时不为它们发哈希请求；MCP list 不带哈希，按需请求（来源端带目标 `homeDir` 以便路径改写）。
- 默认勾选只包括可推送的「只在本机」「本机较新」「内容不同」；已同步、远端独有与不可同步不可选。
- 子智能体的 `dependencies`（MCP / 技能名称）只做行内提示，不影响行状态与勾选。
- 目标端 `importBlockedReason`（如 MCP 的 `target-compat-config`）会让该分类所有行不可选，并显示原因；整类不推送。
- 父子技能同时勾选时沿 `parentKey` 链取最上层已选上级，同组同批、上级在前；穿过未勾选的中间上级。组字节取组头（父目录已包含子目录）。其余分类没有 `parentKey`，每项独立成组。
- 离线 / 连接中 fail-closed：不调用任何服务、清空 rows 和勾选，不展示旧快照。
- 每次加载读取一个 generation；切换分类、设备或 attachment 换代后，旧的 list / hash / push 结果一律丢弃。
- 切换分类时清空上一分类的勾选；分类页只展示当前分类的结果。
- 推送只在 `ready` 且非推送中执行；先预检目标端写权限；单批导出或导入抛错只把该批记为失败，其他批继续。成功后把成功项在本地标为已同步；失败/冲突项保留为可重试。
- 远端独有只用于提示与跳过结果，不参与勾选，也不进入 import items。

## 概览

`概览` 标签逐类显示本机数量、远端数量与变更数（无变更显示「已一致」），点击行进入对应分类。

概览还提供跨分类操作：

- 「全选所有分类」把六类里所有可勾选行加入选择；「取消全选」清空六类选择。
- 「推送全部」按 `skills → mcp → commands → hooks → subagents → plugins` 的顺序逐类执行，分类级并发最多 2 个；单类失败（含能力门禁、写权限、导出/导入异常）不中断其它类。
- 结束后汇总「成功 N 项 / 失败 M 项 / 跳过 K 项」，失败分类下显示分类名与原因：能力门禁按稳定 code 使用 i18n 文案，逐项失败显示条目名与错误。
- 已成功的项在分类 hook 里已被标为不可选，二次「推送全部」只会推送失败项；部分失败后可继续用分类页或再次「推送全部」重试。
- 加载阶段就命中 `remote-agent-outdated` / `capability-unverified` 的分类没有可推送行，也在汇总里直接记为分类失败，不重试。

分类标签徽标只显示该分类的可推送数量 / 已一致 / 不可推送。

## 入口

设置侧栏「数据同步」只在桌面端、且至少有一台在线 Source 设备提供远端「用户」时显示（见 `SettingsPage.tsx` 与 `settingsPageConfig.ts`）。页面只经本机 base services + 该设备的 source-settings attachment 读写，不新建 Host、连接或 Agent。

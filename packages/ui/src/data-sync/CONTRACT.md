# data-sync

设置页「数据同步」的技能单类试点（`docs/remote/data-sync.md`）。B1 先只做技能，验证对比 / 推送 / 离线 / 迟到结果语义，后续再扩 MCP、命令、钩子、插件、子智能体。

- `domain/compare.ts`：纯函数。两端 `listSyncItems` + 内容哈希 → 行状态与默认勾选；远端独有生成不可勾选行；父子技能同批分组；逐项结果汇总。
- `app/useDataSyncDevices.ts`：复用 `settings-scope` 的设备分组，只列出在线、有「用户」目标的 Source 设备；Web / 手机没有 source-settings attachment，列表为空。
- `app/useDataSyncSkills.ts`：页面状态唯一 owner。`generation` 绑定设备与 attachment 换代；离线 / 连接中清空列表且不读写；推送逐批导出/导入，失败按项保留并可重试。
- `ui/DataSyncSection.tsx`：设置页内容。设备选择、三态列表、本地/远端摘要、勾选、推送按钮（显示将写入数量）、逐项结果与重试。
- `contract.ts`：页面契约（设备、行、推送结果）；`index.ts` 是唯一公共入口。

不变量：

- 行状态：只在本机 / 本机版本较新或内容不同 / 已同步 / 远端独有 / 不能同步。内容不同默认勾选；远端版本较新显示差异但默认不勾选；远端独有不可勾选、永不删除，推送结果记为跳过。
- 默认勾选只包括可推送的「只在本机」「本机较新」「内容不同」；已同步、远端独有与不可同步不可选。
- 父子技能同时勾选时沿 `parentKey` 链取最上层已选上级，同组同批、上级在前；穿过未勾选的中间上级。组字节取组头（父目录已包含子目录）。
- 离线 / 连接中 fail-closed：不调用任何服务、清空 rows 和勾选，不展示旧快照。
- 每次加载读取一个 generation；切换设备或 attachment 换代后，旧的 list / hash / push 结果一律丢弃。
- 推送只在 `ready` 且非推送中执行；先预检目标端写权限；单批导出或导入抛错只把该批记为失败，其他批继续。成功后把成功项在本地标为已同步；失败/冲突项保留为可重试。
- 远端独有只用于提示与跳过结果，不参与勾选，也不进入 import items。

## 入口

设置侧栏「数据同步」只在桌面端、且至少有一台在线 Source 设备提供远端「用户」时显示（见 `SettingsPage.tsx` 与 `settingsPageConfig.ts`）。页面只经本机 base services + 该设备的 source-settings attachment 读写，不新建 Host、连接或 Agent。

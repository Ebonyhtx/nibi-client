# data-sync-service

数据同步（`docs/remote/data-sync.md`）的服务侧。B1 试点只接入**技能**；MCP、命令、钩子、插件、子智能体后续按同一形状扩展。

- `contract.ts`：`IDataSyncCategoryService<TPayload>`，五个方法 `listSyncItems` / `getSyncContentHashes` / `checkSyncWriteAccess` / `exportSyncItems` / `importSyncItems`。比较逻辑不在这里，由 Renderer 纯函数完成。
- `skillDataSync.ts`：技能实现。来源 `~/.nibi/skills` 与兼容目录 `~/.agents/skills`（`.nibi` 优先、按 name 去重），统一写入目标端 `~/.nibi/skills`；对齐 key 为 name trim + 小写。支持父子技能 `parentKey`、每项内容哈希、20MB 单项目上限、软链与兼容目录限制、原子目录覆盖和启用状态。
- `skillCandidates.ts`：用户级技能候选扫描；规则与设置页技能服务一致，单独维护以避免与 `skill-sync` 服务互相导入形成环。
- `directoryContent.ts`：目录签名（文件数 + 总字节）与内容哈希（相对路径 + 字节）；不跟随内部软链。
- 组合方式：`createSkillSyncService`（`skill-sync/skillSyncService.ts`）把本模块的五个方法附加到现有 `ISkillSyncService`。`source-settings` attachment 已经把 `ISkillSyncService` 暴露给远端配置面，因此不需要新增 RPC 通道或通用文件接口；owner 仍是 `skill-sync` 通道，实现在本模块。
- `index.ts` 只导出契约（Renderer 可用）；`node.ts` 导出实现（Host / 远端）。

不变量：

- 推送只处理 `items` 中列出的 key，**永不删除目标端独有的条目**。
- `overwrite` 必须带 `expectedTargetHash`；目标端导入前重新计算，不一致返回 `conflict`，不写入。`createOnly` 遇到目标端已有同 key 也返回 `conflict`。
- 目录类覆盖：解压到目标技能根内的临时目录（同盘）→ 原目录改名为备份 → 新目录 rename 到位；失败还原备份。还原也失败时保留临时目录并写明备份位置。
- 覆盖前先检查目标目录内是否还有目标端其他技能（父子技能），有则该项失败，目录不动；该检查在哈希之前。
- 父子技能：`listSyncItems` 给出同端内最近的 `parentKey`；export 只打包最上层选中目录；import 按来源目录层级先上级后下级，下级随已写入的上级落位（目标端原无该 key → created；原有 → failed，不覆盖）。
- 启用状态：新建项带上来源状态并换算为目标路径；更新项保留目标端状态。新建且状态与目标端不一致时才写 `config.json`（来源启用时删除残留的禁用项）；写入失败时删除本次新建目录并标为失败。
- `config.json` 写入使用 `updateJsonObjectFile`：损坏时报错不写、写前重读、只改 `skills` 字段、原子替换。

## 后续扩展

新增分类时复用 `IDataSyncCategoryService`，在 UI 的 `categories` 适配层登记端点、批量上限和行内说明；需要新通道时同步更新远程 workspace RPC 合同、source-settings 服务集合和手机白名单，不要把同步方法加进手机可调用通道。

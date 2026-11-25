# 插件平台状态（唯一真源）

> **本文是 NIBI 插件平台状态的唯一真源。**
>
> 计划存档目录（`ZCODE3.17.2到3.18.2`，仓库外）下的 `03-NIBI-PLUGIN-PLAN.md`、`04-NIBI-ABSORPTION-PLAN.md`、
> `05-NIBI-UPSTREAM-FOLLOWUP-PLAN.md` 属于**设计与历史记录**。其中的「未实现 / 未开工 / 仍缺」
> 等结论句反映的是各自撰写时的快照，**不代表当前状态**；任何状态判断以本文为准。
>
> 行号会随并行编辑漂移；引用时以**符号名**为准，行号只作定位提示。
>
> 本文只描述已经过仓库内文件核对的事实。每条结论都给出可检查的仓库路径（必要时带行号）。
> 无法从仓库核实的（线上市场内容、发布流水线、外部账号状态）统一标注 **未核实**，不做推断。
>
> 编写日期：2026-11-25。核对基线：本产品仓库（分支 `dev`）。
> 注意：2026-11-25 的实现中多数文件仍处于**工作区未提交**状态（`git status` 显示 `M` / `??`）。
>
> **行号会漂移**：本文引用的行号是核对当时的值。多个插件文件在同一批改动里被并行编辑，
> 行号可能整体下移数行。定位时请以**符号名**（函数/常量/类型）为准，行号只作辅助。

---

## A–E 状态表

口径：`done` = 有实现且有可运行证据；`partial` = 主要路径可用但缺少计划要求的子项；
`gap` = 计划要求的能力在仓库内没有实现，或只有类型/文档没有运行时。

### A. 身份 / 生命周期

| 项 | 状态 | 证据 |
|---|---|---|
| 插件身份 `<name>@<marketplace>`、`PluginMetadata.origin` | done | `apps/nibi-cli/packages/contracts/src/plugins/index.ts:251`（`PluginTrustLevel`）、`:260-286`（`PluginOrigin` + `resolvePluginOrigin`）、`:399-438`（`PluginMetadata`，含 `origin`） |
| 安装 / 启用 / 卸载 / 更新 | done | `apps/nibi-cli/packages/adapters/src/plugins/marketplace.ts:929`（`loadInstalledPluginsStateSync`）、同文件安装/卸载/更新主流程 |
| 卸载墓碑 30 天 + schemaVersion 1/2 容错 | done（2026-11-25） | `marketplace.ts:226-231`（`state`/`removedAt`）、`:955-976`（`pruneRemovedPluginRecords`，默认 `retentionDays = 30`）、`:2682-2692`（`MARKETPLACE_SCHEMA_VERSION_MIN = 1` / `MAX = 2`） |
| 双轴状态（installed × enabled） | partial | 安装记录有 `state: "installed" \| "removed"`，启用态另存配置（`resolveEnabled`，`adapters/src/plugins/index.ts:325`）；计划里的「双轴状态」独立模型未单独落地 |
| `registry.json` / `grants.json` / `audit/<date>.jsonl` 三元文件布局 | partial（等价能力已实现，文件名不同） | 授权：`plugin-grants.json`（`helpers.ts:877`）；同意：`plugin-consents.json`（`helpers.ts:365`）；审计：`plugin-audit.ndjson`（`helpers.ts:366`）。**未采用**计划中的文件名 |
| 授权 + 审计（30 天保留 / 最近 10 条） | done（2026-11-25） | `helpers.ts:592-595`（`PLUGIN_AUDIT_RETENTION_DAYS = 30`、`PLUGIN_AUDIT_PRUNE_INTERVAL_MS`）、`:661-678`（`readRecentPluginAuditEvents`，`limit = 10`）、`:682-750`（`prunePluginAuditEvents`） |
| 安装前声明 | done | `marketplace.ts:1350`（`安装前声明：与已安装详情共用同一套权限/能力推导`）、`:1213` / `:1275` / `:1333`（`declaration` 透传）；UI 消费点 `packages/ui/src/settings/PluginStorePage.tsx:843-845`、`PluginStoreDetailView.tsx:105` |
| view-root 物化 | done（2026-11-25 接线） | `apps/nibi-cli/packages/adapters/src/plugins/view-root.ts`：**真实目录 + 硬链接文件**的镜像树（不是符号链接——组件扫描器出于信任边界不跟随链接，用链接会让 skills/commands 全部扫不到），规范清单写根 `plugin.json`，复制回退时校验相对文件集合等价；22 个单测。接线：`adapters/src/plugins/index.ts` 的 `resolveInstalledViewRoot` 让 `source === "cache"` 的插件读视图根（失败回退源目录 + `plugin_view_root_unavailable` 诊断）；Rust 侧 `kernel/crates/platform/src/plugin_inventory.rs` 的 `plugin_read_root` 同源优先视图根，两端 `NIBI_PLUGIN_ROOT`/hooks cwd/MCP 工作目录一致。**覆盖面**：只对非 `nibi-official` 市场的安装件生效——官方市场安装件会被 `scanOfficialCache`（`cache/nibi-official/*/*`）先按 `source: "official"` 认领，按 id 去重后安装记录候选被丢弃，因此仍读缓存目录；官方缓存本身由 Host 管理，不需要隔离 |

### B. 运行时 / 授权 / 审计

| 项 | 状态 | 证据 |
|---|---|---|
| 扩展宿主（NIBI Extension Host） | done | `apps/nibi-cli/packages/bootstrap/src/plugins.ts:2007`（`activatePluginExtensions`）、调用点 `bootstrap/src/app/create-app.ts:287`；能力拒绝写审计 `plugins.ts:2018-2031` |
| 五项 NIBI Extension 能力 | done | `contracts/src/plugins/index.ts:312-316`（`PLUGIN_CAPABILITY_IDS`：`nibi.sessions.read` / `nibi.workspace.files.read` / `nibi.ui.view` / `nibi.settings.own` / `nibi.notifications.show`）；敏感能力集合 `helpers.ts:788-792`；实现 `bootstrap/src/plugins.ts:2033` 起（`readWorkspaceFile` 带 workspace 逃逸与 `.ssh`/`.aws` 拒绝） |
| 能力授权与同意（grants + consent） | done | `helpers.ts:877`（`PLUGIN_GRANTS_FILE`）、`:365`（`PLUGIN_CONSENT_FILE`）、`:938-977`（`grants_updated` / `grants_revoked`）；发现层 `plugin_consent_required`（`helpers.ts:425`） |
| 包 hash 绑定同意 | done（2026-11-25） | `package-hash.ts:57`（`computePluginPackageHash`）；`helpers.ts:546-583`（`resolvePluginContentTrust`，含 `hash_mismatch` / `hash_missing` 与旧记录 backfill） |
| 审计事件类型 | done | `helpers.ts:597-608`（`capability_denied` / `capability_invoked` / `consent_granted` / `consent_revoked` / `grants_updated` / `grants_revoked` 等） |
| UI 呈现（被拦状态 vs 用户停用） | done | `packages/ui/src/settings/pluginStoreListing.ts:545-560`（`resolvePluginBlockedLabelId` / `hasBlockedPluginCode`）；测试 `packages/ui/test/pluginGateStatus.test.ts`；5 语言键 `settings.plugins.detail.blocked`（`zh-CN.ts:4811`、`en-US.ts:5150`、`ja-JP.ts:5515`、`ko-KR.ts:5403`、`ru-RU.ts:5482`） |

### C. 四级信任 / 签名 / 撤销

| 项 | 状态 | 证据 |
|---|---|---|
| 四级信任 `builtin / official / community / local` | done | `contracts/src/plugins/index.ts:251`；候选生成处赋予 trust：`adapters/src/plugins/index.ts:577-586`（官方 seed = `builtin`）、`:588-596`（官方缓存 = `official`）、`:598` 起（安装记录按市场回落）；`helpers.ts:330-342`（`resolvePluginTrust` / `resolveMarketplaceTrust`） |
| 敏感能力 / 危险权限按信任收敛 | done | `helpers.ts:774-786`（`community`/`local` 删除 `full-access`） |
| 内容签名 `.sig` + 单调 revision | done | `marketplace.ts:2188-2194`（`verifyNibiContentSignature`，失败抛错）；`:594-601`（`assertMarketplaceRevisionNotRolledBack`） |
| 签名 `kid` 轮换 | done（2026-11-25） | `packages/shared/src/node/nibiContentSignature.ts:39`（`NIBI_CONTENT_SIGNING_PUBLIC_KEYS`）、`:44`（`NIBI_CONTENT_SIGNING_DEFAULT_KID = "k1"`）、`:143-144` |
| ZIP sha256 | done | `marketplace.ts:705-708`（`sha256` 校验 `SOURCE_SHA256_PATTERN`）、`:221` / `:240`（记录字段）、`:1874-1930`（`readPluginSourceSha` / `assertPluginNotRevoked`） |
| 撤销列表（签名、revision 单调、block/warn、版本区间 + sha256、离线保留旧快照） | done（2026-11-25） | `plugin-revocations.ts:25-26`（URL/文件名）、`:36-55`（`block`/`warn` 与 `revision`）、`:96-135`（解析，坏条目整份作废）、`:191-216`（验签 + revision 倒退拒绝 + 相同快照跳过）、`:247`（`isSameSnapshotSync`）、`:297-322`（`evaluatePluginRevocation`，版本区间与 sha256 匹配）、`:325-338`（`checkPluginRevocation`） |
| 撤销在发现 / 安装 / 更新生效 | done | 发现层 `adapters/src/plugins/index.ts:330-355`（`plugin_revoked` → `enabled=false`）；安装/更新 `marketplace.ts:1033`（`assertPluginNotRevoked`），`warn` 走 `onRevocationWarning`（`:1002`、`:1040`） |
| 「代码激活时签名有效」 | partial（有意例外） | `official` 有签名锚点（`marketplace.ts:2188`）；`local` / `community` **没有**内容签名，改用本地信任 + 包 hash 绑定替代（`helpers.ts:546-583` + `package-hash.ts`）。见下「有意偏离」 |
| 撤销名单刷新失败时的行为 | done | `plugin-revocations.ts:15`（刷新失败/验签失败/revision 倒退 → 保留上一份成功快照）、`:97` |

### D. 市场 / 发布

| 项 | 状态 | 证据 |
|---|---|---|
| 官方市场唯一 id（内置 + CDN 共用 `nibi-official`） | done | `contracts/src/plugins/index.ts:31`（`NIBI_OFFICIAL_PLUGIN_MARKETPLACE = "nibi-official"`）；`adapters/src/plugins/index.ts:573-586`（内置与缓存都写同一 id）；`official-marketplace.ts:44` / `:81` |
| 官方目录源 URL | done | `official-marketplace.ts`（`NIBI_OFFICIAL_PLUGIN_MARKETPLACE` 常量拼装）；撤销名单 `plugin-revocations.ts:25`（`https://dl.nibistudio.cn/plugin-revocations.json`） |
| 市场卡片零来源标签 | done | `PluginStorePage.tsx:893-937`：来源行 `settings.plugins.detail.source`（`:902-905`）位于 `PluginStoreAdvancedSection` 内（`PluginStoreDetailView.tsx:636-648`，「更多详情」折叠区）；卡片 `PluginStoreCard.tsx` 无来源标签 |
| 来源只在详情页「高级信息」 | done | 同上；文案映射 `pluginStoreListing.ts:33-60`（`resolvePluginOriginLabelId`） |
| 已安装列表来源标签收敛 | partial | `InstalledPluginManagement.tsx:159` / `:196` 仍渲染 `sourceLabel`（`pluginSourceLabel.ts` 只分「内置」/「从 X 安装」两类行为性标签）。属于计划 §10.8 允许的两类，但仍在列表行而非折叠区 |
| 商店公开 / 社区 / 个人分段 | partial（与「零来源」目标有张力） | `PluginStorePage.tsx:160`（`useState<PluginStoreSegment>("public")`）、`:525`（添加自定义市场后切到 `personal`）；分段是浏览维度，不是卡片标签 |
| 安装前声明 / 权限同意 | done | 同 A 表「安装前声明」 |
| 官方市场实际线上条目 | **未核实** | 远端市场内容不在本仓库，无法静态证明线上条目 |
| 发布流水线 / 签名密钥托管 | **未核实** | 仓库内只有公钥（`nibiContentSignature.ts:39`），私钥与发布流程在仓库外 |

### E. 原生模块 / 运行时

| 项 | 状态 | 证据 |
|---|---|---|
| 原生模块检测 | done（2026-11-25） | `native-modules.ts:36`（`scanPluginNativeModules`）、`:107-148`（`checkPluginNativeModules`，扫描被截断时保守判失败）；接入 `adapters/src/plugins/index.ts:388-405`（`plugin_native_module_blocked` / `plugin_runtime_abi_mismatch` → `codeBlockedReason`） |
| 门禁分层：只挡代码、声明式组件仍可用 | done | `index.ts:388`（注释「只挡扩展代码，声明式组件照常可用」）、`:379`（`codeBlockedReason` 仅在 `!blockedReason && loaded.runtime` 时计算）；协议字段 `packages/shared/src/nibi-protocol/index.ts:2978-2982` |
| Rust 执行期 license 门禁（PaidPluginGate） | done | `kernel/crates/nibi-platform/src/paid_plugin.rs:51`（`PaidPluginDecision`）、`:78`（`requires_membership`）、`:82`（`PaidPluginEvaluation`）、`:93`（`evaluate`）、`:187-250`（`PaidPluginRuntime`：`register_paid` / `is_paid` / `check_at`） |
| Rust 调用点：MCP 工具执行期复核 | done | `kernel/crates/ext/src/mcp/tool.rs:71-74`（`paid_plugin` / `paid_gate` 字段）、`:103-104`、`:249-254`（每次 `call` 前 `gate.check(plugin)`，失败作为工具结果返回） |
| Rust 调用点：命令/用户面 | done | `kernel/crates/ext/src/commands/user.rs:154-162`（`set_paid_gate` 同时下发给 `skills` 与 `custom`） |
| Node 执行期 license 门禁 | done（2026-11-25） | `apps/nibi-cli/packages/core/src/mcp/index.ts:81`（`paidPluginGate?` 选项）、`:134-147`（**注册期**判定，拒绝则不注册工具）、`:316`（**handler 复核** `assertPaidPluginStillAllowed`）；注入 `bootstrap/src/app/create-app.ts:374-375`（`createBuiltinPaidPluginGate({ cacheCredentials: false })`） |
| 扩展宿主隔离级别（共享 vs 独立进程） | partial | 宿主在同一 Node 进程内运行（`bootstrap/src/plugins.ts:2007` 起）；计划里 local = 每插件独立进程（`docs/plugins/plugin-compatibility-model.md:110-112`）未按进程隔离实现 |
| `mcp-node-fallback` | done | 计划与 `docs/hooks-runtime-contract.md` 均按已落地处理；Rust 内核 MCP stdio 子进程有独立实现 |
| 上游 `plugin-api` / 5 slots 接入 | gap（**有意不接**） | 只实现 `composer.status` / `nav.primary` 两个插槽：`contracts/src/plugins/index.ts:372`、`adapters/src/plugins/ui-surfaces.ts:108-110`、UI `packages/ui/src/plugin-ui/components/PluginUiLauncherItems.tsx:44` / `:98`。不接上游 5 slots |
| 常驻插件 UI | gap（**暂缓**） | 2026-11-24 决策暂缓；仓库内无对应实现 |

---

## 已落地能力汇总（2026-11-25 之前）

以下各项均已在仓库内核对到位。

- **P0–P5**：阶段划分见 `03-NIBI-PLUGIN-PLAN.md:969-975`。P0 主体已落地（14 内置、`.nibi-plugin`、`NIBI_*`、Host 管理面、Rust 快照/付费门禁）；P1–P5 的多数内容已在本轮（2026-11-25）补实现，逐项见下方与 A–E 表。
- **14 个内置插件根 `plugin.json` + `extensions["com.nibistudio.nibi"]`**：
  13 个以 `-plugin` 结尾的包加 `node-repl-host`。全部 14 份清单都有 `extensions["com.nibistudio.nibi"]`：
  `android-emulator` / `browser-use` / `computer-use` / `design` / `documents` / `ios-simulator` /
  `nibi-guide` / `node-repl-host` / `pdf` / `plugin-creator` / `presentations` / `skill-creator` /
  `spreadsheets` / `visualize`。定义清单在 `apps/nibi-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:196`。
- **六适配器**：`native` / `agent-plugins` / `claude` / `codex` / `zcode` / `dsh`
  （`contracts/src/plugins/index.ts:228-234`；顺序即发现特异性，见 `:226` 注释）。
- **hooks 33 + 7**：插件 hook 事件 33 个（`contracts/src/hooks/index.ts:9-60`，脚本计数 33），
  其中内核真正会派发的 14 个（`PLUGIN_HOOK_RUNNABLE_EVENT_NAMES`，同文件 `:70-96`）；
  Node/Host 工作区 hook 面 7 个（`docs/hooks-runtime-contract.md:9`）。
- **五项 NIBI Extension 能力**：见 B 表。
- **T1/T2/T3**：`docs/plugins/plugin-compatibility-model.md:36-39` 给出 trust → T 级映射
  （builtin/official = T1、community = T2、local = T3）。代码侧的收敛点见 `helpers.ts:774-786`。
- **`composer.status` / `nav.primary`**：见 E 表。
- **安装前声明**：见 A 表。
- **权限同意与 grants**：见 B 表。
- **内容签名 `.sig` + 单调 revision**：见 C 表。
- **ZIP sha256**：见 C 表。
- **Rust `PaidPluginGate`**：`kernel/crates/nibi-platform/src/paid_plugin.rs`；调用点
  `kernel/crates/ext/src/mcp/tool.rs`、`kernel/crates/ext/src/commands/user.rs`。

### 插件 e2e

| 集合 | 结果 | 证据 |
|---|---|---|
| `plugins-verified` | 13/13 | `docs/testing/plugin-management-lifecycle-e2e-coverage-matrix.md:102-106`（preset 全量 13/13，run `desktop-e2e-20261124-050210-597`）；`docs/testing/plugin-review-next-batch-2026-11-24.md:86-87` |
| `conversation-session-verified` | 4/4 | `plugin-management-lifecycle-e2e-coverage-matrix.md:40-41`（WPL-015 单 spec + preset 4/4，run `desktop-e2e-20261124-002711-151`） |
| macOS / Windows native CI | 各 13/13 | `plugin-management-lifecycle-e2e-coverage-matrix.md:107-108`（macOS `desktop-e2e-20261124-052213-003`、Windows `desktop-e2e-20261124-052437-667`，GitHub run 45331930481）；workflow `.github/workflows/desktop-e2e-native.yml:112-118`（按 preset 取同一份 spec 集） |

> CI 数字口径：13/13 是**插件域**集合；会话域 4/4 是独立 preset。两者不合并且不互相替代。

---

## 2026-11-25 已实施

以下均为**已完成**（工作区改动，未 commit）。列出的文件是新增或主要改动点。

### C 域：签名轮换与撤销

- **`.sig` kid 轮换**：`packages/shared/src/node/nibiContentSignature.ts`
  （`NIBI_CONTENT_SIGNING_PUBLIC_KEYS`、`NIBI_CONTENT_SIGNING_DEFAULT_KID = "k1"`）。
- **撤销列表**：`apps/nibi-cli/packages/adapters/src/plugins/plugin-revocations.ts`
  （签名校验、revision 单调、`block`/`warn`、版本区间 + sha256 匹配、离线保留上一份成功快照）。

### B 域：包 hash 绑定与审计

- **包 hash 绑定同意 + 审计 30 天保留 / 最近 10 条**：
  `adapters/src/plugins/package-hash.ts`（`computePluginPackageHash`）+
  `adapters/src/plugins/helpers.ts`（`computePluginPackageHash` 的导出与消费、`resolvePluginContentTrust`、
  `readRecentPluginAuditEvents`、`prunePluginAuditEvents`）。

### A 域：墓碑与 schema 容错

- **卸载 30 天墓碑 + schemaVersion 1/2 容错**：`adapters/src/plugins/marketplace.ts`
  （`loadInstalledPluginsStateSync`、`pruneRemovedPluginRecords`、`MARKETPLACE_SCHEMA_VERSION_MIN` / `_MAX`）。

### E 域：原生模块与门禁

- **原生模块检测**：`adapters/src/plugins/native-modules.ts`
  （`scanPluginNativeModules` / `checkPluginNativeModules`）。
- **发现层完整性门禁**：`adapters/src/plugins/index.ts`（`blockedReason` / `codeBlockedReason` / `packageHash`）。
- **Node 执行期 license 门禁**：`core/src/mcp/index.ts`（`paidPluginGate` 注册期 + handler 复核）+
  `bootstrap/src/app/create-app.ts` 注入（`cacheCredentials: false`）。

### 协议与 UI

- **协议**：`packages/shared/src/nibi-protocol/index.ts`（`blockedReason` / `codeBlockedReason` / `packageHash`）+
  `bootstrap/src/nibi-protocol/plugins.ts` 映射。
- **UI**：`packages/ui/src/settings/InstalledPluginManagement.tsx`、`PluginStorePage.tsx`、
  `pluginStoreListing.ts` + 5 个 locale（`en-US` / `zh-CN` / `ja-JP` / `ko-KR` / `ru-RU`）。

### 新增测试（未提交）

- `adapters/tests/`：`plugin-audit-retention.test.ts`、`plugin-consent-hash.test.ts`、
  `plugin-discovery-integrity-gates.test.ts`、`plugin-native-modules.test.ts`、
  `plugin-package-hash.test.ts`、`plugin-revocations.test.ts`、`plugin-tombstone.test.ts`、
  `plugin-view-root.test.ts`、`plugin-view-root-wiring.test.ts`
- `core/tests/mcp-paid-plugin-gate.test.ts`
- `packages/ui/test/pluginGateStatus.test.ts`

### 仍未做

- ~~view-root 接线~~ **已完成（2026-11-25 第二轮）**：`view-root.ts` 改为**镜像树**（真实目录 +
  硬链接文件），顶层每个条目都复刻，因此 `mcp.json`、清单自定义路径、`runtime.entry`、外来清单
  全部保留；规范清单写根 `plugin.json`。Node 发现层经 `resolveInstalledViewRoot` 读视图根，
  Rust 经 `plugin_read_root` 读同一个根；卸载时清视图根。22 条单测 + 3 条接线测试 + 2 条 Rust 测试。
  复制回退（文件系统不支持硬链接）时校验相对文件集合等价，否则回退源目录并报
  `plugin_view_root_unavailable`——绝不使用不完整的视图。
- **进程级隔离**：扩展宿主仍与 Host 同进程；计划里 local = T3 每插件独立进程未实现。
- ~~撤销列表的新鲜度~~ **已补（2026-11-25）**：启动后 fire-and-forget 刷新，24h TTL 节流
  （`maybeRefreshPluginRevocations`）；失败也写尝试时间，避免离线时每次启动重试；
  `NIBI_PLUGIN_REVOCATIONS_REFRESH=off` 可关闭，`force` 绕过 TTL。E2E 回放与测试进程跳过。
- ~~撤销列表的生产者~~ **已补（2026-11-25，发布链侧）**：`NIBI-Site/tools/content-publish.py`
  新增 `publish-revocations`：校验条目、单调 revision、原子写、签名；`verify` 增加撤销名单的
  签名/revision 校验与**分发端点逐字节比对**（Windows `file://` 盘符解析 bug 一并修掉）。
  客户端 URL 与服务端落点对齐为 `/plugins/plugin-revocations.json`（与市场清单同目录）。
  仍差一步**运维动作**：把生成的文件部署到分发桶（需要发布权限，未执行）。
  **应急操作手册见 `NIBI-Site/deploy/RUNBOOK.md` §19**（含生效时机、解除撤销与回滚禁忌）。
  已实测：服务器真实私钥签出的名单，用客户端内置公钥验签通过；发布/签名/幂等/非法输入/
  分发比对全部通过（演练在服务器 /tmp 进行，残留已清理，线上无改动）。
- ~~审计「最近 10 条」未接 UI~~ **已补（2026-11-25）**：`plugins/audit` RPC + 服务层 5 处接线
  + 插件详情「最近审计」面板（时间/动作/能力，未知类型原样显示）+ 5 locale。
- ~~付费执行门禁的 Node 覆盖面~~ **已补（2026-11-25）**：`runtime/plugin-execution-gate.ts`
  统一判定，覆盖 Skill 工具加载、自定义命令展开、子代理派发（Rust 侧原本就覆盖四类）。
- **墓碑没有恢复入口**：2026-11-25 评估后**有意不做**。墓碑的作用是记录身份与重装复用，
  不是用户可撤销的删除；UI 卸载默认保留缓存，若在商店显示「恢复」会让用户以为卸载没生效。
  若将来要做撤销，正确形态是卸载后短时间内的撤销提示（且发生在删缓存之前）。
- **`InstalledPluginDetailDialog/Panel` 无页面引用**：设置页实际渲染的是
  `PluginStoreDetailView`；这两个组件当前是既有的未引用代码，本轮未清理（不属插件能力缺口）。
- **上游 5 slots**：有意不接，只保留 `composer.status` / `nav.primary`。
- **常驻插件 UI**：2026-11-24 决策暂缓。

---

## 已解决的计划内部矛盾

### 1. builtin `originId`

**结论：内置插件与官方市场共用 `nibi-official`，不存在第二个 builtin marketplace id。**

- 常量只有一处：`contracts/src/plugins/index.ts:31`（`NIBI_OFFICIAL_PLUGIN_MARKETPLACE = "nibi-official"`）。
- 内置 seed 与官方缓存条目都写这同一个 id：`adapters/src/plugins/index.ts:573-586`、`:588-596`。
- 内置与市场件的区分不靠 marketplace id，而靠 `PluginMetadata.origin`
  （`contracts/src/plugins/index.ts:260-286`：`builtin` / `official` / `community` / `local` / `external:<adapter>`）。
  trust 也在候选生成处分开：内置 = `trust: "builtin"`，缓存 = `trust: "official"`（`index.ts:577-596`）。

### 2. 内置插件数量

**结论：14 个。**

- 口径一（包目录）：`apps/nibi-cli/packages/*-plugin/plugin.json` 共 **13** 份
  （android-emulator、browser-use、computer-use、design、documents、ios-simulator、nibi-guide、pdf、
  plugin-creator、presentations、skill-creator、spreadsheets、visualize）。
- 口径二（加上宿主）：`apps/nibi-cli/packages/node-repl-host/plugin.json` 是第 **14** 份。
  它没有 `listing`，不进市场、不对用户露出，是 Browser Use / Computer Use 的共享 `node_repl` 运行时宿主
  （清单描述见该文件；定义见 `official-plugin-definitions.ts:269-287`）。
- 口径三（权威定义）：`official-plugin-definitions.ts:196` 的 `OFFICIAL_PLUGIN_DEFINITIONS` 聚合出 14 项
  = 10 个显式条目（visualize、design、node-repl-host、android-emulator、browser-use、ios-simulator、
  plugin-creator、skill-creator、nibi-guide、computer-use）+ 4 个由映射生成的文档插件
  （documents、pdf、presentations、spreadsheets，`:334-344`）。
- 复核：`OFFICIAL_PLUGIN_DEFINITIONS` 内 `listing:` 出现 10 次 —— 正好等于「14 个插件中 10 个进市场」。
- 因此**对外市场可见的插件是 13 个**（14 减 node-repl-host）。引用「14 内置」时要说清包含宿主。

### 3. 双读窗口

**结论：未定，当前无代码依赖。**

- 仓库 `docs/` 内没有「双读窗口」的现行口径文档；`grep` 只命中计划目录自身
  （`03-NIBI-PLUGIN-PLAN.md:90`、`:124`、`:884-901`）。
- 代码侧事实：插件发现只认 `.nibi-plugin/plugin.json`；旧清单只在缓存做一次性迁移
  （`adapters/src/plugins/helpers.ts:8-9` 附近注释）。第三方已清空，旧格式只剩内置插件，
  内置随 App 一次性迁移，不需要为外部旧插件保留双读窗口。
- 因此不存在「双读窗口到期」这类代码路径；这是产品版本节奏决策，不是当前实现约束。

### 4. License 执行期

**结论：Rust 已有；Node 已于 2026-11-25 补齐。**

- Rust：`kernel/crates/nibi-platform/src/paid_plugin.rs`（`PaidPluginRuntime`、`evaluate`、`check_at`）；
  MCP 工具执行期复核 `kernel/crates/ext/src/mcp/tool.rs:249-254`；命令面 `ext/src/commands/user.rs:154-162`。
- Node：`core/src/mcp/index.ts:134-147`（注册期）+ `:316`（handler 复核）；
  注入 `bootstrap/src/app/create-app.ts:374-375`（`cacheCredentials: false`，避免复用陈旧凭据判定）。
- 门禁语义与计划一致：工具表冻结，执行期失败只让**当次调用**失败，不增删工具
  （`tool.rs:247-249` 注释明确写了这一点）。

### 5. 市场卡片来源标签

**结论：卡片零来源标签；来源只在详情页「高级信息」折叠区。**

- 详情页来源行：`PluginStorePage.tsx:902-905`（`settings.plugins.detail.source`），
  外层是 `PluginStoreAdvancedSection`（`:893` / `:937`），该组件定义在
  `PluginStoreDetailView.tsx:636-648`，标题键 `settings.plugins.detail.moreDetails`（「更多详情」）。
- 卡片：`PluginStoreCard.tsx` 无来源 badge（只有 `plugin-store-source-degraded` 的「来源缺失」提示，`:415-421`）。
- 来源文案映射：`pluginStoreListing.ts:33-60`。
- 残余偏差：已安装**列表行**仍显示来源标签（`InstalledPluginManagement.tsx:159` / `:196`），
  但取值只有「内置」/「从 X 安装」两类行为性标签（`pluginSourceLabel.ts:38-52`），符合计划 §10.8。

### 6. PreCompact

**结论：手动压缩尊重 `block`；自动/反应式压缩忽略 `block` 继续，并记审计。**

- 手动：`kernel/crates/compact/src/engine.rs:38`（`Compaction blocked by PreCompact hook`）；
  测试 `kernel/crates/compact/src/hooks_tests.rs:36`（"manual compaction must honor a blocking PreCompact hook"）。
- 自动：`kernel/crates/compact/src/lib.rs:240-241`（`Err(Failure::Blocked(_)) => Ok(AutoCompactOutcome::NotNeeded)`，
  注释「被 PreCompact hook 拦下不算失败，照常发请求」）；
  测试 `hooks_tests.rs:52` / `:67`（"automatic compaction must continue past a blocking PreCompact hook"）。
- hook 事件定义：`kernel/crates/compact/src/hooks.rs:43-50`。

### 7. C 域「代码激活时签名有效」

**结论：`official` 有签名锚点；`local` / `community` 用本地信任 + 包 hash 绑定替代。这是有意保留的例外。**

- `official`：官方清单验签 `marketplace.ts:2188-2194`；撤销名单独立签名 `plugin-revocations.ts:191-216`。
- `local` / `community`：没有发布链签名，因此无法在「代码激活」时刻验签。替代方案是
  **本地信任等级 + 包内容 hash 绑定同意**：`helpers.ts:546-583`（`resolvePluginContentTrust`，
  `hash_mismatch` / `hash_missing`）+ `package-hash.ts`（`computePluginPackageHash`）。
- 该例外必须写进计划：否则「代码激活时签名有效」在 local/community 上无法成立，
  只能退化为「内容未被替换」这一更弱但可验证的保证。

---

## 仍存在的有意偏离

### 1. MCP 命名：`plugin:<name>:<server>` vs `<pluginIdHash>-<serverName>`

- 当前实现：`adapters/src/plugins/mcp.ts:67`（`return \`plugin:${loaded.manifest.name}:${serverName}\``）。
- 计划目标：`<pluginIdHash>-<serverName>`。
- **不改的理由**：同名冲突由 `conflictingPluginIds` fail-closed 处理。
  同一 `manifest.name` 的多个已启用插件会互相标记（`core/src/plugin-reference/catalog.ts:40` / `:61`），
  消费端据此拒绝而不是猜一个（`core/src/plugin-reference/reminder.ts:212`、
  `bootstrap/src/nibi-protocol/plugin-reference-catalog.ts:119-129`）。
  因此两者的语义等价：都保证「同名不会静默串台」。
- **不改持久化标识**：`plugin:<name>:<server>` 是已写入会话/工具标识的存量格式，改 hash 会造成
  历史会话与已存工具名不匹配。改动收益不抵迁移成本。

### 2. schemaVersion 2 只做前向兼容

- `marketplace.ts:2682-2683`（`MIN = 1` / `MAX = 2`），`:2692`（越界拒绝）。
- v2 只表示「能读」，不是「已启用 v2 语义」。仓库内没有 v2 专属字段的写入路径。
- 这与计划中「schemaVersion 2 = 新布局」不同：当前 v2 仅是给未来留的读取余量，
  写回仍以 v1 为主（`saveInstalledPlugins` 传 `version: 1`）。

---

## 内置插件计数口径

**14 个内置插件，市场可见 13 个。** 三个口径交叉一致：

| 口径 | 数量 | 说明 |
|---|---|---|
| `apps/nibi-cli/packages/*-plugin/plugin.json` | 13 | 市场可见的内置插件 |
| 加 `apps/nibi-cli/packages/node-repl-host/plugin.json` | 14 | 宿主自身，无 `listing`，不进市场 |
| `bootstrap/src/app/official-plugin-definitions.ts` 的 `OFFICIAL_PLUGIN_DEFINITIONS` | 14（10 显式 + 4 映射生成） | 与上面两组一致；数组内 `listing:` 恰好 10 处 |

引用「14 内置」时必须说明含宿主（node-repl-host）；面向用户的市场数量是 **13**。

## 待清理文档

以下仓库内文档与本文结论冲突或已过时。**仅列出，本轮不修改。**

| 文档 | 冲突点 |
|---|---|
| `docs/plugin-marketplace-ui-ux.md:20-35` | 描述「公开/社区/个人分段 + 详情页信息区」的 V2 IA；未反映「来源收敛到高级信息折叠区」的现行实现 |
| `docs/plugin-marketplace-ui-ux.md:419` | 已安装列表「icon + 显示名 + 版本 + 来源 badge + 更新 badge…」；来源 badge 的现行口径需与 `pluginSourceLabel.ts` 对齐 |
| `docs/plugin-marketplace-ui-ux.md:443` | 验收清单「个人分段按用户添加的市场分组…」；属旧 IA 验收项 |
| `docs/plugins/plugin-compatibility-model.md:110-112` | 声明 `local = T3 每插件独立进程`；当前扩展宿主同进程运行，进程级隔离未实现 |
| `docs/hooks-runtime-contract.md:9` | 「Node/Host 工作区 hook 面只支持 7 个事件」正确，但未提及插件 hook 面 33 / 可派发 14 的新分层；易被误读为全局 7 个 |
| `docs/plugin-extension-runtime.md:98-104` | 只写 `composer.status` / `nav.primary` 两个插槽（与实现一致），但未说明「不接上游 5 slots」是决定而非缺口 |
| `docs/testing/plugin-management-lifecycle-e2e-coverage-matrix.md:16-38` | 表中 `PLM-LC-011` 仍标 `pending` / `never`；对应 spec 属公网 smoke，需注明「不计入 13/13」 |
| `docs/testing/plugin-management-lifecycle-e2e-coverage-matrix.md:70-71` | 2026-11-23 复核称 `PRA`/`PBD`/`PBO`/`PBS` 的 pending spec「当前不存在」；与表格并存，读者易混 |
| `docs/claude-code-marketplace-plugin-compat.md`、`docs/claude-marketplace-triplet-plugin-compat.md` | 以 Claude Marketplace 兼容为主视角；未标注 NIBI 当前只保留 `nibi-official` 单一官方市场 |

---

## 未核实点

以下内容无法从仓库静态核实，本文不做结论：

1. **线上官方市场实际条目数**（是否只剩 `math-modeling` 等）：市场内容在服务端/CDN，不在本仓库。
2. **签名私钥与 kid 轮换操作流程**：仓库内只有公钥表（`nibiContentSignature.ts:39`），私钥托管与轮换审批在仓库外。
3. **撤销名单的真实线上内容**（`https://dl.nibistudio.cn/plugin-revocations.json`）：需要网络访问与运营权限。
4. **GitHub Actions run 45331930481 的原始日志**：本文只引用仓库内已记录的 run id 与结果摘要，
   未直接访问 GitHub 核实。
5. ~~2026-11-25 各项实现是否已通过完整测试套件~~ **已核实（同日补跑）**：
   `pnpm typecheck` 全通过；包级全量单测 adapters **2241 通过**（166 文件）、
   core **4234 通过**（280 文件）、bootstrap **2799 通过**（223 文件）；
   `check:i18n-keys` / `architecture:check` / `check:public-repo` / `check:dual-kernel-parity` 全通过；
   `pnpm lint` 0 error（170 warning 均为改动前既存的未使用导入等，不属本轮）。
   未做的是：桌面 WDIO 真机 e2e、Rust workspace 测试、以及 `test:unit:affected`（脏工作区会被拒跑）。

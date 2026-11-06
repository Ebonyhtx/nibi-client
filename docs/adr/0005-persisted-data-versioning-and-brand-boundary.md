# 持久化数据的版本化与品牌边界

- 状态：Accepted
- 日期：2026-11-06
- 关联：`scripts/check-storage-keys.mjs`、`scripts/check-identity-residue.mjs`、`packages/ui/src/lib/nibiStorage.ts`、`docs/architecture/`

## Context

NIBI 与上游 ZCode 可能装在同一台机器上。两者的持久化数据分成两类：

1. **NIBI 自己的数据**——用户偏好、会话库、凭据、配置。
2. **上游的数据**——键名带 `zcode` / `zai` 的那些，属于另一个产品。

运营者定过一条硬规则：除插件兼容外，**绝不与上游有任何数据关联**。这条规则在
`check-identity-residue.mjs`（产物侧）与 `check-storage-keys.mjs`（源码侧）里落成了判据。

同时，NIBI 尚未发布：没有存量用户，也没有需要继承的旧数据。所以现在可以硬切名字。

问题在于**发布之后**：一旦有真实用户，`nibi-theme` 这类键就变成契约——改名等于让所有
用户的偏好静默重置。而仓库里目前只有会话库（`kernel/crates/node-store/src/repo/migrations/`
24 个编号迁移 + `local_setting.schema_version`）有正规迁移体系，其余持久化数据
（渲染层偏好、`nibi.json`、`.nibi/config.json`、`installed_plugins.json`）都没有版本字段。

## Decision

### 1. 迁移只在 NIBI 的键空间内发生

两个前缀属于我们：`nibi:`（结构化 JSON）与 `nibi-`（单值）。

**`zcode*` / `zai*` 永远不是迁移源。** 这不是"读到后忽略"，而是**没有代码路径能读到**：
`nibiStorage.ts` 对键前缀做白名单，越界的读返回 `null`、写不生效，并记一条诊断
（`nibiStorageDiagnostics()`），让越界可见而不是静默。

### 2. 发布后键名与字段冻结

第一个正式版发出去的那一刻起：

- 已发布的存储键名**不再改名**。要换就"加新键 + 迁移 + 保留旧键一到两个版本"。
- 已发布的配置字段**不再改名 / 不再换语义**。纯增量加字段是允许的（读取侧给缺失字段落
  默认值），加字段**不**动版本号。
- 破坏性改动（改名、换语义、收窄值域）必须 +1 `schemaVersion` 并补一段迁移。

### 3. 版本标记放在哪

| 数据 | 版本标记 |
| --- | --- |
| 渲染层偏好 | `nibi:prefs` 的 `version` 字段（`NIBI_PREFS_VERSION`） |
| 项目配置 `nibi.json` | 顶层 `schemaVersion` |
| `.nibi/config.json` | 顶层 `schemaVersion` |
| 已装插件清单 `installed_plugins.json` | 顶层 `schemaVersion` |
| 会话库设置 | `local_setting.schema_version` 列（已有） |

读取规则统一为：**缺字段 = 版本 0（版本化之前），按最老格式读，读完升级并回写当前版本**；
**版本高于当前 = 更新版本写的文件，只读我们认识的字段，不降级、不丢弃未知字段、不回写**。

### 4. 插件 ABI 是唯一例外

下列名字属于**与外部交换的契约**，不在本决策的改名范围（`check-storage-keys.mjs` 的
`ALLOWED_KEYS` 与 `check-identity-residue.mjs` 的允许清单维护它们）：

- 插件包格式 `.zcode-plugin/`、元数据键 `com.zcode/`、面板桥别名 `window.zcode`；
- 插件环境变量 `ZCODE_PLUGIN_*` 等（只**输出**给插件子进程与清单模板，宿主从不读取）；
- Gen-UI / MCP Apps 元数据键（`zcode/genUiTweaks` 等）；
- 模型 provider id（`zai` / `bigmodel`）与服务端契约字段 `clientType: "zcode"`。

## Consequences

- 发版前可以任意硬切名字（当前状态）；发版后必须走迁移。
- 新增持久化数据时必须**当场**决定版本策略，不能"以后再加"——第一版就得写 `version`，
  否则第一个升级就得靠猜。
- `check:storage-keys` 与 `check:identity-residue` 进 pre-push，改名与残留都会被拦住。
- 跨产品读取只剩下一个理论风险：有人在 `nibiStorage.ts` 之外直接调 `localStorage`。
  `check:storage-keys` 覆盖这类调用点（它扫的是 `localStorage.*(` 的字面量参数）。

## Alternatives considered

- **做通用迁移框架**：现在的数据形态（一个 JSON 对象 + 三个文件 + 一张表）不值得。
  版本字段 + 读取侧升级函数已经够用。
- **发布后仍允许硬切**：等于接受所有用户偏好重置，不可接受。
- **给上游数据也做迁移源**：直接违反运营者的安全规则，且会把别的产品的配置读进 NIBI。

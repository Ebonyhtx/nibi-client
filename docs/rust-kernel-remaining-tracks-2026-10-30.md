# Rust 内核剩余三类功能的排期与设计（2026-10-30 拍板）

> 背景：命令层 34 个 `CommandType` 已有 31 个接住（对拍 71 字段全绿），剩 3 个在
> `kernel/crates/protocol-zcode/src/nibi_commands.rs` 的 `BLOCKED_COMMANDS` 里（DWF 三件）。
> 用户拍板：**三类都补**，按本文顺序排。无论进度如何，Rust 仍是灰度、`NIBI_KERNEL` 默认 node、
> 不切默认；切默认的前置是这 8 条全部落地（或明确放弃并在灰度分流表里写死）。

## 顺序（按"解锁灰度面 / 风险 / 依赖"排）

| 步 | 内容 | 量级 | 为什么排这里 | 出口条件 |
|---|---|---|---|---|
| 1 | 钩子评审 4 条（`request`/`respond`/`toggle`/`revoke`） | **已完成（2026-10-30）** | 库都在（见 §1），不碰摘要算法；补完"带钩子的项目"才敢进灰度 | ✅ 4 条 accepted；双内核 63 字段全一致（含声明摘要 `68ad4faa`）；投影的 pending 交互承载完整 payload |
| 2 | `discardSharedContext` | **已完成（2026-10-30）** | 依赖最少（只碰会话内的分享上下文表）；先把"丢弃"做掉，导入侧随分享服务端进度 | ✅ 丢弃后快照 `status=discarded`、存储一致；重复丢弃 `failed/fault.command.inputRejected`；双内核一致（71 字段对拍） |
| 3 | DWF：workflow 3 条 + `createSession.dynamicWorkflow*` + 内核 run 能力 | 大（一整套） | 唯一需要独立设计的引擎（run 状态机、调度、持久化、UI 面）；与品牌化分轨，绝不混 PR | 3 条 accepted；run 的启动/恢复/改设置在双内核一致；`createSession` 两个字段真正生效 |

每步独立提交/PR；**不动机器人域名、不做全局改名**（品牌化单独一轮，等所有功能 track 完成）。

## 1. 钩子评审：设计草案

### 已有的库（都已核实存在，不要重写）

| 东西 | 位置 | 能做什么 |
|---|---|---|
| 逐条信任的存储 | `kernel/crates/platform/src/hook_trust.rs`（`HookTrustStore`） | `load`（读信任记录）、`grant(records)`、`revoke(...)`，按 **digest** 记，`trusted(identity)` 给已信任集合 |
| bundle 与条目摘要 | `kernel/crates/hooks/src/workspace_digest.rs` | `runtime_root(...)`、`bundle(...)`，产出 `bundle_digest` 与 `entries[{review_item_id, event, matcher, display, source, digest, enabled}]` |
| 组装参考实现 | `kernel/crates/cli/src/config/trust.rs`（`WorkspaceHooks::inspect/admitted/pending`） | 取用户 hooks + 项目 hooks 文件、算 bundle、和信任集合比对。**在 CLI 二进制里，协议前端拿不到**——需要把这段"取文件 + 算 bundle"的逻辑下沉到库（`crates/hooks` 或新模块），或让 runtime 用自己的文件端口重写一份等价逻辑 |
| CLI 命令面 | `kernel/crates/cli/src/hooks_trust*.rs` | `zcode hooks trust status|grant|revoke` 的现成行为，可作为语义参照（不是复用目标） |

### 需要新增的内核 API（建议形状）

```rust
// kernel-api（新增，默认 Unsupported，TUI/CLI 不实现也不受影响）
pub struct WorkspaceHookItem {          // 对齐平台的 DigestEntry
    pub review_item_id: String,
    pub event: String,
    pub matcher: Option<String>,
    pub display: String,
    pub source: String,
    pub enabled: bool,
    pub digest: String,
    pub trusted: bool,
}
pub struct WorkspaceHookReview {
    pub identity: String,
    pub bundle_digest: Option<String>,
    pub reason_code: String,            // not_applicable / no_enabled_hooks / pending_trust / trusted_persistent / corrupt
    pub items: Vec<WorkspaceHookItem>,
}

pub trait Kernel {
    async fn workspace_hook_review(&self, workspace: &WorkspaceRef) -> Result<WorkspaceHookReview, KernelError>;
    async fn grant_workspace_hooks(&self, workspace: &WorkspaceRef, review_item_ids: &[String]) -> Result<(), KernelError>;
    async fn revoke_workspace_hooks(&self, workspace: &WorkspaceRef, declaration_digests: &[String]) -> Result<(), KernelError>;
}
```

### 协议侧的评审流（协议状态，不进内核）

- `requestWorkspaceHookReview`：校验 target（`sessionId`/`workspaceIdentity`/`bundleDigest`）→ 调
  `workspace_hook_review` → 生成 `reviewFlowId`（每次请求一个）+ `generation`（同一身份递增）+
  `interactionId`（走现有 pending 交互通道），按 Node 的
  `workspaceHookReviewRequestPayloadSchema` 回快照。
- `toggleWorkspaceHookReviewItem`：只改协议侧 flow 内的勾选集合；`generation` 不符 → 拒绝
  （晚到/重放的勾选不能污染新一轮评审）。
- `respondWorkspaceHookReview`：`decision.action = "trust_selected"` + `reviewItemIds` →
  `grant_workspace_hooks` → 关 flow。
- `revokeWorkspaceHookTrust`：两种 target——flow 内（`reviewItemIds`）或独立
  （`hookDeclarationDigests`）→ 换算成 digest → `revoke_workspace_hooks`；未命中按 Node 的
  noop/拒绝语义对齐。

### 核实结果（2026-10-30，已读源码，不要再猜）

1. **评审请求走交互通道**：CLI 把评审请求作为一条 interaction 放进 v4 投影
   （`interaction.payload.kind === "workspaceHookReview"`，见
   `bootstrap/src/app/workspace-hook-review-request.ts` 与
   `bootstrap/src/nibi-protocol-v4/product-projection.ts` 的 1553/3425/3437 行）。Host 从投影的
   pending 交互渲染评审面板。`presentWorkspaceHookReviewRequestSchema` 定义了但**没有调用方**——
   不是反向请求。
2. **payload 形状**：`workspaceHookReviewRequestPayloadSchema`（`kind` / `reviewFlowId` /
   `generation` / `interactionId` / `sessionId` / `taskId` / `runId` / `workspaceIdentity` /
   `bundleDigest` / `createdAt` / `deadlineAt` / `sourceFiles[]` / `summary{eventCount,hookCount,
   pendingCount}` / `items[{reviewItemId,event,matcher,type,displayName,displayCommand,sourcePath,
   resolvedTimeoutMs,resolvedMaxOutputBytes,executionMode,configuredEnabled,editable,trustState}]` /
   `warningCode:"workspace_hooks_execute_code"`），并有交叉校验（hookCount=items.length、
   eventCount=去重事件数、pendingCount=待信任项数）。
3. **请求的命令语义**（`requestWorkspaceHookReview`）：校验 target 与当前 admission 快照的
   `workspaceIdentity`/`bundleDigest` 一致（不一致 → `workspace_hooks_snapshot_mismatch`）；
   无待审项时安全 no-op accepted；有 `blocked_policy` → `workspace_hooks_blocked_by_policy`；
   信任库损坏 → `workspace_hooks_trust_store_corrupt`；否则开/复用评审流并监管超时。
4. **Node 侧的真实构成**（不能只搬四个 handler）：`workspace-hook-review-controller.ts`（flow 的
   开/复用/监管）+ admission 快照 + coordinator 评估 + `interaction-registry`（generation 与
   supersede）+ 持久信任的策略校验（`canMutatePersistentTrust`）+ telemetry。Rust 侧要等价移植
   其中的 admission/coordinator 部分，否则 `snapshot_mismatch`/`superseded` 这些语义对不上。
5. **工作量上调**：从"中等（约 1 天）"改为"中偏大"——四个 handler 之上还有 admission 评估、
   flow 生命周期（含 deadline 与 supersede）、交互 payload 投影三层。

6. **bundle 摘要的构造位置与一致性约束**：Node 在
   `adapters/src/config/config-factory.ts` 生成 `WorkspaceHookBundleSnapshot`，并且**要求
   `workspaceHookRuntimeRoot` 跨调用点一致**——注释原文：审核请求遍历 default/user/project/env/cli
   全部层，而"审核中 toggle"曾只读单层 runtimeConfig.hooks，两处推导不同就会产出不同
   `bundleDigest`，toggle 被误判成 `workspace_hooks_snapshot_mismatch`；所以 Node 把 runtimeRoot
   显式导出成 `project.workspaceHookRuntimeRoot` 供下游复用。
   → Rust 侧的地基测试必须**同时比 runtimeRoot 与最终 digest**，否则一旦不一致无法定位是哪一层。
   → 同时确认 Rust 的 `hooks::workspace_digest::runtime_root/bundle` 是否按同样的层次与顺序收集
   （它存在且是库，但"收集哪些层的哪些文件"目前在 CLI 的 `config/trust.rs` 里）。

### 探针结果：摘要对拍的第一次尝试（2026-10-30，未通过，记录在此）

两边的 CLI 都有 `hooks trust status --json`，所以最便宜的对照组是"同一份 fixture + 两个 CLI"。已做：

- fixture：`<ws>/zcode.json` 与 `<ws>/.zcode/config.json`、`<ws>/.nibi/config.json`，内容
  `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo pre"}]}],
  "Stop":[{"hooks":[{"type":"command","command":"echo stop"}]}]}}`；两边都用隔离 HOME 跑。
- Node：**能发现文件但拒绝内容** —— `.nibi/config.json` 与 `zcode.json` 都回
  `"Unable to read Workspace Hook config: <path>"`（说明文件名/发现路径成立，是文档形状不对）。
- Rust：同一 fixture 回 `workspace_hooks_not_applicable`（既没有把它当候选，也没有报解析错）。

结论：**先对齐 fixture 的形状**，再谈摘要。下一步要读的是 Node 侧 hooks 段的 zod schema
（`@nibi/contracts` 的配置 schema）与 Rust `NodeHooks::from_json` 的接受规则，找出两者共同的最小
文档；当前 fixture 在两个实现里都不被接受，不能作为对拍基线。

### 摘要对拍结果（2026-10-30，已定位到 bundle 信封）

fixture 形状修正为 Node 的 schema（`hooks: { enabled?, timeoutMs?, maxOutputBytes?, events: {...} }`，
事件嵌在 `events` 下）后，两边 CLI 的 `hooks trust status --json` 输出：

| 字段 | Node | Rust | 一致 |
|---|---|---|---|
| `reviewItemId` | `workspace-hook-0-PreToolUse-0-0` / `…-Stop-0-0` | 同 | ✅ |
| 单据摘要 `hookDeclarationDigest` | `607f038e…e543b7` / `f3975076…81deba` | 同 | ✅ **逐字节一致** |
| `displayCommand` / `sourcePath` / `matcher` / `configuredEnabled` | `echo pre` / `zcode.json` / `Bash` / true | 同 | ✅ |
| `reasonCode` | `workspace_hooks_pending_trust` | 同 | ✅ |
| **`bundleDigest`** | `22826b59…7cc6d0` | `98101c0a…4c67e4` | ❌ **不同** |

**结论**：per-declaration 的摘要算法是忠实移植（否则不会逐字节相同）；差异只在 **bundle 的信封**
——即 `runtimeRoot`（`enabled/timeoutMs/maxOutputBytes`）或 `sources` 列表（层与顺序）中有一处不同。
这比"算法不一致"好收口得多：下一步分别打印两边的 runtimeRoot 与 sources 即可定位到具体字段。

注意：**逐条摘要一致但 bundle 不同**说明"信任一条钩子"在两边等价（可互认），但"这次评审属于哪一版
项目配置"（bundleDigest）在两边不等价——评审流的 `snapshot_mismatch` 校验会立刻暴露，所以必须在接线
前对齐，不能靠"反正都记到同一个 store"糊过去。

### bundle 差异的定位（2026-10-30 第二轮：结构一致，只差值）

逐字段比对两边的哈希输入（Node `packages/shared/src/workspace-hook-digest.ts:150-181` 的
`bundlePayload` vs Rust `crates/hooks/src/workspace_digest.rs:199-233` 的 `payload`）：

| 结构 | Node | Rust | 一致 |
|---|---|---|---|
| 信封 | `["workspace-hook-bundle", 1, sources, hooks]` | 同（`SCHEMA_VERSION = 1`） | ✅ |
| source 元素（7 项） | `[relPath, discoveryOrder, configFileKind, explicitProjectConfig, canonicalOptional(enabled), canonicalOptional(timeoutMs), canonicalOptional(maxOutputBytes)]` | 同 | ✅ |
| hook 元素（5 项） | `[hookDeclarationDigest, sourceRootEnabled, declarationEnabled, runtimeHooksEnabled, configuredEnabled]` | 同 | ✅ |
| 可选值编码 | `canonicalOptional` → `["unset"]` / `["set", v]` | `optional` → 同 | ✅ |
| 序列化 | `sha256(JSON.stringify(payload))` | `sha256(&payload)`（同一套紧凑 JSON） | ✅（单据摘要已证） |

**所以差异只剩 4 个布尔值或 sources 列表长度**：`sourceRootEnabled`、`declarationEnabled`、
`runtimeHooksEnabled`、`configuredEnabled`。注意单据摘要里包含 `sourceRelativePath` 与
`sourceDiscoveryOrder` 且两边相同，所以 sources 列表至少第一项的路径/顺序一致。

**下一步（一次就能定死）**：把 payload 本身打印出来对比，而不是猜布尔值——
- Node：`tsx` 小脚本调 `buildWorkspaceHookBundleSnapshot({...})` 并把 `bundlePayload` 现算一遍
  （该模块只导出 snapshot，不导出 payload；临时在脚本里按同样结构重建，或加一个仅测试用的导出）。
- Rust：在 `crates/hooks/src/workspace_digest_tests.rs` 加一个打印 `payload` 的测试（同一 fixture）。
- 两份 JSON 逐字段 diff，差异字段就是答案；改完把 fixture 固化成仓库内的
  `scripts/kernel-baseline/fixtures/hooks-parity/`，并把这个对比做成可复跑的门禁脚本。

### 阻塞项（2026-10-30）：项目配置目录还是 `.zcode`，这是品牌化轨的事

摘要对拍的矩阵实验把真因定死了。同一份 fixture 反复换内容，两边 CLI 的 `bundleDigest`：

| fixture | Node | Rust | 结论 |
|---|---|---|---|
| 只有 `zcode.json`（5 种变体：无/`enabled:true`/`timeoutMs`/两者/`enabled:false`） | 全部 | 全部 | **5/5 MATCH** |
| `zcode.json` + 旧形状 `.zcode/config.json` | `22826b59`（**不理** `.zcode`） | `98101c0a`（**读** `.zcode`） | DIFF |
| `zcode.json` + `.nibi/config.json` | `39b48f8f`（**读** `.nibi`） | `22826b59`（**不理** `.nibi`） | DIFF |

**结论**：摘要算法、payload 结构、可选值编码、四个布尔语义**全部一致**；差异只有一个——
**项目级配置目录名**。Node/NIBI 读 `<工作区>/.nibi/config.json`，Rust 内核读 `<工作区>/.zcode/config.json`
（`crates/base/src/names.rs` 的 `dot_dir!()` 仍是 `.zcode`）。

这是**真实的静默丢失**，不只影响钩子评审：NIBI 用户写在 `.nibi/config.json` 里的 hooks（以及同一套
发现逻辑读的权限规则、MCP、插件配置）在 Rust 内核里全部**看不见**；反过来 Rust 用户以为生效的
`.zcode/config.json`，Node/App 又不读。

**为什么没顺手改**：改它要动 `dot_dir!()` 的语义边界（存储/用户根 vs 项目目录），并重算 vendored 的
`crates/cli/tests/fixtures/workspace-hooks-golden.json`（4 个用例的 digest 字面量）、`hooks_trust` 的
文本断言、插件配置发现的两处测试。按既定纪律"品牌化单独 PR、可整体 revert、不混进功能 PR"，这属于
**品牌化轨**，必须先拍板再动。

**已拍板（2026-10-30）**：按最终 NIBI 方向做——Rust 灰度期间没有真实用户，先用 `.zcode` 接线等于以后
再改一遍，属于多此一举。已按选项 A 落地：

- 新增 `rust_cli_base::names::PROJECT_DOT_DIR = ".nibi"`（**不动** `DOT_DIR`：内核自己的存储/用户根仍由
  `ZCODE_DATA_BASE_DIR` 等注入，品牌化收口时再统一）；
- 项目配置发现与 digest 的 kind 改用 `.nibi/config.json`；`.zcode/config.json` 不再被 Rust 读取（与 Node 一致）；
- 重算 `crates/cli/tests/fixtures/workspace-hooks-golden.json`（4 个用例）并同步 fixtures 路径；
- 实测（同一 fixture、两个 CLI）：`zcode.json` only → MATCH；`+ .nibi/config.json` → **MATCH**（改前 DIFF）；
  `+ 旧 .zcode/config.json` → MATCH（两边都忽略，改前 Rust 会读）。
- 回归面：`cargo test -p rust-cli` 的失败集合与改动前**完全一致**（9 个环境相关既有失败：plugins 2 /
  network 3 / workspace_trust 4），没有新增失败；clippy `-D warnings` 与 `cargo check --workspace` 全绿。

**原始选项（留档）**：
- **A（推荐）先做品牌化的项目目录收口**：新增 `PROJECT_DOT_DIR = ".nibi"`（不动全局 `dot_dir!()`，存储/用户根
  不变），只改项目配置发现 + digest kind，重算 golden 并用真实 fixture 与 Node CLI 对拍验证；独立 PR，
  可整体 revert。完成后再继续钩子评审的四条命令。
- **B 钩子评审先用 `.zcode` 接线**：命令能跑通、对拍也能过（两边都用 `.zcode` fixture），但 NIBI 用户真实
  的 `.nibi/config.json` 在 Rust 灰度下不可见——等于"功能做了但用户用不上"，不建议进灰度。

已回退：尝试中的 `.nibi` 改动没有留在工作树（`cargo test -p rust-cli files` 绿）。

### 待查（动手前先读源码确认，不猜）

1. `reviewFlowId` 的生命周期与 `generation` 的精确语义（`interaction-registry.ts` 的
   `getCurrentFlow`/supersede 与 `workspace-hook-review-controller.ts` 的 `openOrReuseFlow`）。
2. Node 认的 hooks 文件名/格式（`candidates`/`sources`）与 Rust `NodeHooks::from_json` 是否逐字
   一致——不一致则 bundle 摘要会不同、评审会对不上（先跑一个两边的摘要对比测试）。
3. 驱动是否值得造真实工作区（写一个 hooks 文件）跑端到端；若成本高，先用"快照 + 撤销"两条断言。
4. 交互 payload 进投影的落点：Rust 的 projection 目前只把 pending 交互投成 `pending` 数组，要确认
   它的字段能否原样承载上面第 2 条的 payload（不够就加字段，不改 Host 契约）。

### 落地结果（2026-10-30，已完成）

- 内核：`kernel-api::hook_review`（快照 + `HookTrust` 端口）、`hooks::hook_review`（纯函数 `review` /
  `admitted` / `admitted_for`）、`platform::hook_trust` 的端口实现、`LocalKernel::with_hook_review`
  注入；授权 / 撤销 / 开关当场重建项目层 hooks（`HookEngine::replace_project`）。
- 协议：评审流（`reviewFlowId` 每会话一份、`generation` 单调、10 分钟截止）、pending 交互
  `workspaceHookReview`、`workspaceHookAdmission` 提示条；拒绝码按 Node 的
  `workspace_hooks_review_superseded` / `workspace_hooks_snapshot_mismatch` /
  `workspace_hooks_trust_store_corrupt` / `workspace_hooks_config_unreadable` /
  `workspace_hooks_config_write_failed` 分流。
- 驱动：`hookReview` 阶段（默认阶段表里）覆盖 提示条 → 请求 → 交互 → 关/开 → 授权 → 撤销；
  `check-dual-kernel-parity` 63 字段全绿，`check-cold-resume` 仍绿。
- 留档的边界：策略阻断无来源（恒 false）；`taskId`/`runId` 用会话 ID；被替换/超时只撤交互、
  不发 Node 的 Superseded/Settled 事件。

详见 `kernel/CHANGELOG-FORK.md` §6.10 与 `docs/rust-kernel-step2-slice1-2026-10-30.md` §6.17。

### 落地结果（2026-10-30，已完成）

- 存储：复用 Node 的 `session_entry`（`type = "v4/shared_context_import"`），**没有新增 0025+ 迁移**。
- 内核：`shared_context_import`（冷打开种子）+ `discard_shared_context`（pending → discarded）。
- 协议：冷打开种子进投影；丢弃写 `state.updated`；非 pending 回
  `failed/fault.command.inputRejected`（与 Node 的 ACK 状态一致）。
- 驱动：`discardSharedContext` 阶段（插一条 pending 导入 → 丢弃 → 重新订阅读快照 → 二次丢弃被拒）；
  `check-dual-kernel-parity` 71 字段全绿，`check-cold-resume` 仍绿。
- 边界：导入本身仍由 Node 的 server-operations 完成；消息元数据 `sharedContextStatus` Rust 不写。

详见 `kernel/CHANGELOG-FORK.md` §6.11 与 `docs/rust-kernel-step2-slice1-2026-10-30.md` §6.18。

## 2. `discardSharedContext`：动手前要查的

- Node 侧写入/读取这条上下文的形状（`context_refs` / `topic resource` / `shared-context-ref`），
  以及"丢弃"是删会话里的引用还是删存储里的对象。
- 内核目前**没有**任何共享上下文存储；实现前要定：存在会话 DB（`session_entry`）还是独立表
  （→ 注意：新增表要迁移，而**当前禁止新增 0025+ 迁移**，所以优先复用 `session_entry`）。
- 出口：丢弃后模型上下文里不再出现那段内容；重复丢弃幂等；与 Node 的设备/会话隔离一致。

## 3. DWF：动手前要先做设计（不是先写码）

- 需要先明确：run 的持久化表（同上的迁移约束）、调度与恢复语义、与 `createSession`
  两个灰度字段的关系、UI 面（run 卡、暂停/恢复按钮）依赖哪些投影字段。
- 排期上放在最后，且**独立 PR**；在它完成前，`createSession.dynamicWorkflow*` 保持"收下 + 点名
  warn"，不假装生效。

**调研结论（2026-10-30，已读源码）**：DWF 不是三条命令，而是 8,524 行规格 + 26k 行 TS
（`@nibi/dynamic-workflow` 24.6k + `dynamic-workflow-runtime` 1.5k）+ 20 多个模型工具；工作流
脚本在 `node:vm` 沙箱里跑（编译器/ lowering / VM 引导 / journal 回放）。好消息是 `dwf_*` 表
已在 migration 0019 里（Rust 也已逐字节应用 0020–0024），**不需要新增迁移**。

**已拍板 C**（Rust 协议面 + Node 引擎 sidecar），第一段只读面已落地。三条路线与阶段见
[`rust-kernel-dwf-design-2026-10-30.md`](rust-kernel-dwf-design-2026-10-30.md)。**待用户拍板**：
路线、sidecar 分发方式、DWF 是否是切默认的硬前置。

## 复跑命令

```bash
cd NIBI-Client/kernel
cargo test -p rust-cli-protocol-zcode -p rust-cli-session -p rust-cli-kernel-api --locked
cargo clippy -p rust-cli-protocol-zcode -p rust-cli-session --all-targets -- -D warnings
cd ..
node scripts/kernel-baseline/check-dual-kernel-parity.mjs      # 38 字段
node scripts/kernel-baseline/check-cold-resume.mjs
```

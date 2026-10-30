# Rust 内核剩余三类功能的排期与设计（2026-10-30 拍板）

> 背景：命令层 34 个 `CommandType` 已有 26 个接住（对拍 38 字段全绿），剩 8 个在
> `kernel/crates/protocol-zcode/src/nibi_commands.rs` 的 `BLOCKED_COMMANDS` 里。
> 用户拍板：**三类都补**，按本文顺序排。无论进度如何，Rust 仍是灰度、`NIBI_KERNEL` 默认 node、
> 不切默认；切默认的前置是这 8 条全部落地（或明确放弃并在灰度分流表里写死）。

## 顺序（按"解锁灰度面 / 风险 / 依赖"排）

| 步 | 内容 | 量级 | 为什么排这里 | 出口条件 |
|---|---|---|---|---|
| 1 | 钩子评审 4 条（`request`/`respond`/`toggle`/`revoke`） | **中偏大**（核实后上调：要移植 admission 评估 + 评审流管控，并把评审请求做成交互 payload） | 库都在（见 §1），不碰摘要算法；补完"带钩子的项目"才敢进灰度 | 4 条 accepted；两条链（请求→勾选→提交、按摘要撤销）双内核一致；Host 能从投影的 pending 交互渲染评审并与之交互 |
| 2 | `discardSharedContext` | 中偏小 | 依赖最少（只碰会话内的分享上下文表）；先把"丢弃"做掉，导入侧随分享服务端进度 | 丢弃后会话里不再有该上下文；重复丢弃幂等；双内核一致 |
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

### 待查（动手前先读源码确认，不猜）

1. `reviewFlowId` 的生命周期与 `generation` 的精确语义（`interaction-registry.ts` 的
   `getCurrentFlow`/supersede 与 `workspace-hook-review-controller.ts` 的 `openOrReuseFlow`）。
2. Node 认的 hooks 文件名/格式（`candidates`/`sources`）与 Rust `NodeHooks::from_json` 是否逐字
   一致——不一致则 bundle 摘要会不同、评审会对不上（先跑一个两边的摘要对比测试）。
3. 驱动是否值得造真实工作区（写一个 hooks 文件）跑端到端；若成本高，先用"快照 + 撤销"两条断言。
4. 交互 payload 进投影的落点：Rust 的 projection 目前只把 pending 交互投成 `pending` 数组，要确认
   它的字段能否原样承载上面第 2 条的 payload（不够就加字段，不改 Host 契约）。

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

## 复跑命令

```bash
cd NIBI-Client/kernel
cargo test -p rust-cli-protocol-zcode -p rust-cli-session -p rust-cli-kernel-api --locked
cargo clippy -p rust-cli-protocol-zcode -p rust-cli-session --all-targets -- -D warnings
cd ..
node scripts/kernel-baseline/check-dual-kernel-parity.mjs      # 38 字段
node scripts/kernel-baseline/check-cold-resume.mjs
```

# Rust 内核 DWF（动态工作流）路线设计（2026-10-30）

> 范围：NIBI 剩余 3 条命令 `startSavedWorkflow` / `resumeWorkflowRun` /
> `amendWorkflowRunSettings` 与 `createSession.dynamicWorkflowEnabled/Mode`。
> 结论先说：**这不是"再接三条命令"，而是移植一个独立产品**。本文给出三条路线与推荐，
> 拍板后再动手；在此之前 Rust 前端继续按 `BLOCKED_COMMANDS` 显式拒绝，不假装支持。

## 1. 现状盘点（已读源码，不猜）

| 面 | 量级 | 关键事实 |
|---|---|---|
| 规格文档 | `docs/dynamic-workflow/*.md` 8,524 行（5 篇） | authoring / concurrency / launch / presentation / transcript-and-notifications |
| 引擎与编译器 | `@nibi/dynamic-workflow` 121 文件 / 24,615 行 TS | compiler、lowering、analysis、engine（含 VM）、facade、schema、projections、testing |
| 子运行时 | `@nibi/dynamic-workflow-runtime` 6 文件 / 1,570 行 | 生成 child 入口文件，在 `node:vm` 里用 bootstrap 脚本跑 cell；channel/future 原语、停滞检测 |
| 持久化 | `dwf_*` 表（`dwf_run` / `dwf_actor` / `dwf_node` / `dwf_event` / `dwf_settlement`） | **migration 0019 已在既有 schema 里**（Rust 也逐字节应用 0020–0024），所以端口层能直接读写，**不需要新增 0025+ 迁移** |
| 协议面（NIBI Host 用） | 3 条命令 + `createSession` 2 个字段 | 拒绝词表：`savedWorkflowStartRejected.*`（invalid_name/not_found/invalid_args/compile_failed/session_busy/start_failed）、`workflowRunResumeRejected.*`（not_found/not_resumable/superseded/already_running/script_missing/script_mismatch/compile_failed）、`workflowRunSettingsRejected.*` |
| 模型工具面 | 20+ 工具（CreateWorkflow / AmendWorkflow / FillWorkflowHole / EvalWorkflowSnippet / ListSavedWorkflows / ListWorkflowRuns / GetWorkflowRun …） | `/workflow` 技能、目录、自动化页工作流 tab、run 卡/详情页、完成/提问通知都依赖它们 |
| 灰度 | 服务端 `dynamicWorkflow.mode`（disabled/onDemand/alwaysOn）+ 用户选择 | `createSession.dynamicWorkflow*` 只决定工具面注册时机，不是功能开关的全部 |

关键结构性事实：**工作流脚本是 TS/JS，运行在 VM 沙箱里**。引擎不是"状态机 + 调度"那么简
单——它包含编译器（脚本 → cell 图）、lowering（优化/校验）、VM 引导脚本（channel/future/
停滞检测）、journal 回放与确定性重放。Rust 侧要么重写这一整套（还要内嵌 JS 运行时），要么
沿用 Node 的引擎。

## 2. 三条路线

### A. DWF 不移植，常驻 Node（分流写死）

- Rust 前端对 3 条命令与 2 个字段保持"显式不支持"；带 DWF 的会话走 Node 内核。
- 代价：切默认后 `NIBI_KERNEL=rust` 的会话**没有 DWF**；要么按会话路由（同一工作区/项目可能
  来回跳），要么在设置里限定"DWF 只在 Node 内核可用"。前者违反"同会话不混内核"的边界，
  后者是可见的功能差异。
- 适用：把 DWF 定为"首期不随 Rust 内核提供"，并在灰度分流表写死（用户约束允许这条路径，
  需要明确放弃声明）。

### B. 完整移植（Rust 重写引擎 + 编译器 + 工具面）

- 内嵌 JS 运行时（deno_core / quickjs）跑现有引导脚本，或把 TS 脚本编译成 Rust IR 再执行。
- 工作量：24.6k 行 TS 的等价实现 + 20+ 工具 + 8.5k 行规格的行为对齐 + VM 语义（确定性、
  journal 回放、停滞检测）。**数月量级**，且要与 Node 保持逐字节的 journal/行为对拍。
- 适用：NIBI 最终要"纯 Rust 内核且 DWF 是长期核心能力"。风险最高，但方向最干净。

### C. Rust 协议面 + Node 引擎 sidecar（推荐先做）

- Rust 内核负责：3 条命令、`createSession` 字段、会话投影（run 卡/详情数据来自
  `dwf_*` 表）、journal 读取；**引擎**跑在受管 Node 子进程里（现有
  `dynamic-workflow-runtime` 直接复用），Rust 与它走既有的端口/事件协议。
- 代价：多一个子进程与其生命周期/崩溃恢复；需要定义 Rust ↔ engine 的 run 协议
  （submit / amend / resume / cancel / 事件流），并保证 journal 由引擎独占写。
- 好处：行为与 Node 天然一致（同一份引擎），Rust 侧不重写编译器/VM；`dwf_*` 表不加迁移；
  3 条命令可以先落地，工具面按需再接（工具调用经 sidecar 转发）。
- 适用：既要 Rust 前端又不想重写引擎；也是 B 的过渡形态（sidecar 可逐步内嵌）。

## 3. 推荐与阶段

**路线已拍板（2026-10-30）：C。**

推荐 **C 先行、B 作为长期选项**；A 只作为"明确放弃 DWF 随 Rust 发布"的备选。

若选 C：

| 阶段 | 内容 | 出口 |
|---|---|---|
| C0 | `DwfRuns` 端口（读 `dwf_*`：run/node/event/settlement 的只读面）＋协议侧 run 投影字段 | **第一段已落地（2026-10-30）**：`SessionStore::workflow_runs` / `Kernel::dynamic_workflow_runs` 读 `dwf_run`（本会话、按 `time_created`），node-store 仓储 + 单测；协议投影字段待引擎事件接进来 |
| C1 | sidecar 引擎（受管 Node 子进程）＋ submit/amend/resume/cancel 协议 ＋ 3 条命令 | 双内核 3 条命令对拍；run 生命周期（started → completed/failed/cancelled）一致 |
| C2 | `createSession.dynamicWorkflow*` 激活工具面（经 sidecar 转发 CreateWorkflow 等） | 工具在 Rust 会话可用；saved workflow 列表/启动一致 |
| C3 | 通知与 UI 投影（run 卡、完成/提问通知、hole 流程） | presentation/transcript 两篇规格的关键路径对齐 |

验收判据（C1 起每阶段跑）：

- 3 条命令的 ACK 状态/拒绝码与 Node 一致（含 `fault.command.*Rejected.<reason>` 前缀）；
- 同一脚本在两边 run 的 journal 终态一致（status、result、event 序列的可比子集）；
- 冷恢复后 run 列表/详情/Resume 入口一致；
- 会话隔离：run 只属于启动它的会话；`cancelBackgroundWork` 的 `workId ≡ runId` 仍成立。

## 3.1 C 路线的可行性探针（2026-10-30，已通过）

`scripts/kernel-baseline/probe-dwf-engine.mjs`（不进产品代码）用两个 app-free 包直接装配引擎：

- 无 ask 脚本 → `completed`，artifact `[1,2,3]`，事件 `run-started` → `run-settled`；
- `agent(...)` + `worker.ask(...)` → driver 的 `startAsk` 被调用一次，回 `askTurnEnded` 后
  `completed`，artifact `"42"`，事件序列含 `actor-created`/`node-queued`/`node-dispatched`/`node-settled`；
- **真实 sqlite journal**：用内核自己的迁移 SQL（`0019` 建 `dwf_*`）建库，经
  `createDwfJournalStore(db)` 跑同一段脚本，读出
  `dwf_run(id=run-sqlite, status=completed, parent_session_id=sess_probe, spent_tokens=0)`——
  与 Rust 的 `repo::dwf::list` 选的列/语义一致。

结论：**引擎、沙箱子进程与 journal 都能脱离 CLI runtime 独立跑**；唯一 app 耦合的是 driver
（actor 会话与模型调用）。C1 的 sidecar 因此只需要把 driver 换成"接 NIBI 的模型/工具端口"的实现，
不需要把整个 CLI App 搬进 sidecar。

## 3.2 C1 sidecar 的控制面（2026-10-30 已用探针验证）

`scripts/kernel-baseline/probe-dwf-sidecar.mjs`：父进程扮演"Rust 宿主"，子进程是 sidecar（真实引擎 +
沙箱子进程 + 真实 sqlite journal），driver 在 sidecar 里、每个方法都是一条 RPC。跑通的线协议：

| 方向 | 方法 | 说明 |
|---|---|---|
| 宿主 → engine | `submit`（request） | `{runId, parentSessionId, cwd, scriptText, args, caps}`；回 `{settlement, journal}` |
| engine → 宿主 | `actor/create`（request） | `{actor:{siteId, ordinal}}` → `{session:{id}}` |
| engine → 宿主 | `world/read`（request） | `{op,args}` → 结果 |
| engine → 宿主 | `ask/start`（notify） | `{key, session, instance, typed}` |
| 宿主 → engine | `ask/reply`（notify） | `{runId, instance, kind: submit|text|fail, payload/text}` |
| engine → 宿主 | `ask/verdict`（notify） | 引擎对提交的裁决（repair/nudge 的输入） |
| engine → 宿主 | `ask/cancel`（notify） | 取消在飞 ask |
| engine → 宿主 | `run/event`（notify） | `RunEvent.type`（进度/结算） |

两个实现要点（探针踩到的）：

1. **engine 的 stdin 读循环不能在 `submit` 上 await**：run 期间的 RPC 响应也走这条管道，阻塞读循环会
   死锁（表现是沙箱墙钟超时）。
2. driver 必须把 `journal` 交给引擎（`driver.journal`）；写归引擎，driver 只是持有。

探针断言：actor 走宿主创建、typed ask 先提交错误形状 → 引擎 `node-repairing` + `ask/verdict` reject →
宿主重提正确形状 → `completed`（artifact `{"answer":42}`）、journal 行 `completed` 且
`parent_session_id` 正确。这就是"跨进程确定性"的实测：repair 循环只依赖消息顺序。

## 3.3 C1 细化：driver 走 RPC，模型与工具留在 Rust（2026-10-30 拍板后的调整）

探针证明的唯一 app 耦合点是 driver（actor 会话与模型调用）。与其把整个 CLI App 搬进 sidecar，
更好的切法是**把 driver 反过来接到 Rust**：

- sidecar（Node，仍 app-free）：`runWorkflowScript` + sqlite journal + 沙箱子进程（这几样本来就要 Node）；
  `WorkflowDriver` 的每个方法都是一条到 Rust 的 RPC：
  `createActorSession` → Rust 建一个 actor 子会话；`startAsk` → Rust 跑一轮（模型 + 工具 + 权限），
  进度经 `sink.askTurnEnded/askSubmitAttempted/askStats/askFailed` 回传；`respondToSubmit`/`cancelAsk`
  由 Rust 的裁决/中断回推；`executeWorldRead` → Rust 的文件/git 端口；`executeArtifactPublish` →
  Rust 的 artifact store。
- 这样模型、工具、权限、子代理全留在 Rust（复用已有 `Agents`/`QueryLoop`），sidecar 只负责
  编译/沙箱/引擎/journal——**与路线 B 的长期目标兼容**（将来把这部分也搬进 Rust 时，Rust 侧的
  actor 端口不变）。
- 新增的 Rust 面：一个 `WorkflowActorPort`（建会话 / 跑一轮 / 取消 / 世界读取 / 产物发布），
  `LocalKernel` 用现有会话与工具实现它；协议层再包一层 sidecar 进程管理与事件转发。
- 待验证的两个点（C1 第一步的探针）：actor 轮能否复用子代理的 `QueryLoop`（persona → 系统提示、
  `submit_result`/`escalate` 工具、权限模式）；以及 ask 的 repair/nudge 循环在跨进程往返下
  仍保持确定性（引擎只认 `sink` 的调用顺序）。

**第一点已验证（2026-10-30）**：`rust_cli_agents::Agents::run_actor_turn`（`crates/agents/src/actor.rs`）
复用子循环做到——persona 进 system 的第二段、工具面按 allow/deny 过滤、actor 子会话跨轮续跑、
不进 agents 面板；`Kernel::run_workflow_actor` 把它接到内核（`WorkflowActorSpec/Turn/Request`）。
测试：agents 侧 `actor_tests` 两例（含 persona/system、Subagent 来源、工具减法、同一子会话续跑、
缺失会话大声失败），runtime 侧 `workflow_actor_tests` 一例（经内核入口跑一轮并落子会话）。
**typed ask 已接（同日）**：`ActorProfile.submit_schema` 在场时给 actor 注册 `submit_result`
（内核里的合成工具，永远放行、不走权限门；结果进 `ActorTurnOutcome.submitted`，对应引擎的
`sink.askSubmitAttempted`）。`escalate`（求助）还没接：它需要把一轮挂起、等 `resolveQuestion`
的外部回答，属于 C1 的交互面。第二点（跨进程确定性）等 sidecar 控制面落码时用驱动验证。

## 4. 若选 A（不移植）需要写进灰度分流表的内容

- `NIBI_KERNEL=rust` 时 DWF 命令一律 `unsupported`（现状），Host 端按能力探测降级；
- 需要 DWF 的会话由 Host 固定走 Node 内核；同一会话生命周期内不切换；
- 在设置页/文档写明"Rust 内核暂不提供动态工作流"，避免用户以为是 bug。

## 5. 待拍板的问题

1. 路线选 A / B / C。
2. 若选 C：sidecar 是否允许随内核二进制分发（安装包体积/签名/端口），还是要求"有 Node 才启用"。
3. DWF 是否列入"切默认"的硬前置：若是，C1–C3 全部完成前 Rust 保持灰度；若否，写死分流表。

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

**受理与结算分开**（2026-10-30，命令 ACK 语义要求）：`submit` 只做解析/编译体检并回
`{ok:true,accepted:true}`；run 在后台跑，结算走 `run/settled` 通知（`{runId,settlement}`）。
`startSavedWorkflow` 的 ACK 因此能立即回两把联接键（`runId` ≡ `workId`、`toolCallId`），不必等 run 跑完。
坏脚本在受理阶段就以 `compile_failed` + 有界诊断拒绝，不建 run。

两个实现要点（探针踩到的）：

1. **engine 的 stdin 读循环不能在 `submit` 上 await**：run 期间的 RPC 响应也走这条管道，阻塞读循环会
   死锁（表现是沙箱墙钟超时）。
2. driver 必须把 `journal` 交给引擎（`driver.journal`）；写归引擎，driver 只是持有。

探针断言：actor 走宿主创建、typed ask 先提交错误形状 → 引擎 `node-repairing` + `ask/verdict` reject →
宿主重提正确形状 → `completed`（artifact `{"answer":42}`）、journal 行 `completed` 且
`parent_session_id` 正确。这就是"跨进程确定性"的实测：repair 循环只依赖消息顺序。

**产品入口（2026-10-30 已落地）**：sidecar 是 Node CLI bundle 的隐藏子命令
`nibi.cjs __nibi-dwf-engine`（`apps/zcode-cli/packages/cli/src/dwf-engine-command.ts`，在 `parseArgs`
之前分派，与 `__zcode-dwf-child` 同款）。它解析 saved workflow（`resolveSavedWorkflow` +
`validateWorkflowArgs`）、跑引擎、写 `dwf_*`；`submit` 带 `dbPath`（会话库），journal 由引擎独占写。
探针用 `PROBE_ENGINE_CMD='["node","…/dist/nibi.cjs","__nibi-dwf-engine"]'` 跑同一个父进程脚本，
结论与自建引擎一致（typed ask repair、`completed`、journal 行正确）。

**分发方式（用户拍板 B）**：桌面端本来就跑 Electron 内置的 Node（`ELECTRON_RUN_AS_NODE=1` +
`process.execPath` 指向 Electron Helper；`resolveElectronRuntimeZCodeAgentCommand` 的注释写明
"不再随包内置一份独立 Node 二进制，体积从 ~180MB 降到 ~16MB"）。所以 sidecar 直接复用同一份
Node 与同一个 `nibi.cjs` bundle，**不额外打包**。Rust 侧由入口经环境变量拿到启动命令
（`NIBI_DWF_ENGINE_CMD`，JSON 数组；开发态是 `node src/main.ts`，桌面态是 Helper + `nibi.cjs`）。
若变量缺席，引擎保持未接（命令回 `fault.command.capabilityUnsupported`）。

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

## 5. 已拍板与剩余问题

1. 路线：**C**（2026-10-30）。
2. sidecar 分发：**B**——复用客户端自带的 Node（桌面是 Electron Helper 的 Node 模式 + 同一个
   `nibi.cjs` bundle），不额外打包；Rust 从 `NIBI_DWF_ENGINE_CMD` 拿启动命令。
3. 剩余：DWF 是否列入"切默认"的硬前置（若是，C1–C3 全部完成前 Rust 保持灰度）。
4. C1 未完成：
   - **已落地**：Rust 侧 `SidecarEngine`（`crates/cli/src/dwf_engine_client.rs`）：从
     `NIBI_DWF_ENGINE_CMD` 拿启动命令、spawn、`actor/create` → actor 子会话、`ask/start` 跑
     actor 轮并按 `ask/verdict` 做 repair/nudge、`world/read`（glob/read/grep）、`run/settled`
     收口；app-server 在 env 在场时注入。驱动器新增 `dwfEngine` 阶段（非默认）。
   - **已解决（同日）**：`ask/start` 指向的是 **actor 会话 id**（`actor/create` 回来的
     `sess_dwf_*`），不是 actor 站点（`actor#1`）；客户端按站点查表查不到，ask 静默卡住。改为按
     `session.id` 找 actor 后，端到端跑通：`startSavedWorkflow` accepted、run 在 journal 里
     `completed`、`parent_session_id` 正确；不存在的名字回
     `fault.command.savedWorkflowStartRejected.not_found`。
   - 新门禁 `scripts/kernel-baseline/check-dwf-engine.mjs`（需 `NIBI_DWF_ENGINE_CMD`）：
     `dwfStartStatus` / `dwfStartRunPrefix` / `dwfStartToolCall` / `dwfMissingStatus` /
     `dwfMissingCode` / `dwfRunStatus` / `dwfRunParent` 七字段双内核一致（OK）。
     驱动器的 `dwfEngine` 阶段用**新会话**发起 run（Node 的 `startSavedWorkflowRun` 只对空闲会话
     工作，GUI 同样只对空会话发它）。
   - **取消与恢复（同日已通）**：
     - `cancelBackgroundWork` 的 `workId` 也认 DWF run：`Kernel::cancel_workflow_run` →
       `WorkflowEngine::cancel` → sidecar 的 `cancel` 通知 → `AbortController` → journal
       `cancelled(user)`；协议先试 `StopTask`，被拒才落到 DWF 引擎（Node 的 `cancelBackgroundTask`
       同样两用）。
     - sidecar `resume`：只认可恢复集（`stopped` 且非 `superseded`），从 journal 取脚本/实参/caps，
       编译体检后以**同一 runId** 重新 launch（引擎看见既有行即走 resume 分支）；在飞的 run 回
       `already_running`，`superseded` 单列，缺脚本 `script_missing`。
     - 门禁 `check-dwf-engine.mjs` 扩展到 13 字段（加 `dwfHoldStart` / `dwfResumeLiveCode` /
       `dwfCancelStatus` / `dwfResumeStatus` / `dwfResumeCode` / `dwfResumedStatus`），双内核一致：
       在飞 resume → `already_running`、cancel accepted、stopped 后 resume accepted、最终 completed。
   - **修订与升级问答（同日已通）**：
     - `amendWorkflowRunSettings`：Rust `WorkflowEngine::amend` → sidecar `amend` RPC。sidecar
       做与宿主 runtime 同一张三态表（省略 = 沿用、`null` = 回默认、值 = 设定）、「未改」当场拒绝、
       脚本编译体检（都在**停下任何东西之前**）；只改并发且 run 在飞时**就地 retune**（同一个
       runId、不停、不铸后继：`engine.setMaxConcurrency` + `dwf_run.caps_max_concurrency` +
       `run-caps-changed`）；否则以 `{ superseded: newRunId }` 停在飞前驱、**等它自己结算**，再带
       `resumedFrom` / `inheritedTokens` / 实参启动后继。run 级 `subagentModel` 落
       `run-launched.subagentModel`，并在 `actor/create` 时解析成结构化 selection 传给 Rust 的
       actor 轮（`ActorProfile.selection`）——探针用第二个模型 `fake-model-b` 端到端证明 actor
       的 provider 请求真的切到了它。
     - `escalate` / `ResolveWorkflowQuestion`：Rust 侧的升级问答面（Node 的 escalation 端口同义）。
       actor 的 `escalate` 工具（描述与输入 schema 与 Node 逐字相同、per-ask 预算 3 次、`refused`
       是普通工具结果）把问题交给 `runtime::escalations`；注册表铸 `dwfq-<片段>-<seq>`（全局唯一、
       只许父会话作答、已退场 qid 有界记忆），把与 Node 逐句相同的 `<workflow-escalation>` 通知经
       `Agents::notify` 送进父会话（走后台子代理 `task-notification` 的同一条路：meta user 消息、
       空闲即开回合、提交后 ack）。答案由主会话的 `ResolveWorkflowQuestion` 工具
       （`Kernel::resolve_workflow_question`）送回，停驻的 actor 轮就地继续。取消/丢弃停驻 future
       会把 qid 按 `withdrawn` 退场（之后的作答得到 `run_not_in_flight`）。
     - 门禁 `check-dwf-engine.mjs` 扩到 **31 字段**：新增修订组（`dwfAmend*`：retune 同 run 且
       caps=2、supersede 后继、旧 run `cancelled/superseded`、lineage、`run-launched` 里的规范串、
       actor 真跑在新模型上）与升级组（`dwfEscalate*`：停驻、通知、作答、答案回到 actor 轮）。
       双内核一致（OK）。
     - **本轮修掉的真 bug**：sidecar 的 `node:sqlite` 连接用缺省 busy timeout（0），与宿主
       （Rust 进程）写同一个 `db.sqlite` 时，`updateRunStatus` 会当场 `SQLITE_BUSY`，run 永远停在
       running（约 1/3 概率）。改为 5s（与存储层的启动锁同一档）。
   - 仍未移植（不影响三条命令的协议面，切默认前要评估）：
     - journal 里的 `escalation-raised` / `escalation-resolved` 事件（Rust 的注册表是内存态；
       UI 的 `pendingQuestions` 投影与冷回放因此还没有数据源）；
     - Node 的「设置轮」：修订成功后往会话里排一条 controlOnly 消息（模型可见的「已修订」记录）；
     - `amend` 的脚本点名模型绑定（`modelBindings`）与 persona 级模型名解析（需要模型目录；
       规范串形式已支持）；
     - `GetWorkflowRun` 工具本身（升级通知与工具描述里引用了它，Rust 目前没有这个工具）。

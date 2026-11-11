# 子代理重启续跑

> 状态：Rust 已完成（2026-11-11），Node 内核待对齐
> 范围：Rust 内核（默认）先行，Node 内核（`NIBI_KERNEL=node` 回退）随后对齐
> 关联：[子代理会话只读侧栏](subagent-session-side-tabs.md)、[子代理超时策略](subagent-timeout-policy.md)、[会话生命周期](../../kernel/crates/session/src/resume.rs)

## 问题

客户端卡死、手动重启、自动更新重启或长时间断网后，主会话派出的子代理会直接停止：

- 前台子代理：父会话冷加载时，未完成的 Agent 工具调用被补成 `[Tool call interrupted: ...]`，没有部分结果；
- 后台子代理（Rust `Agent` 的默认形态）：父会话只留下 `async_launched` 回执，完成通知永远不会来，也不会被标成失败；
- 重启后侧栏的子代理列表为空，连「它前面做了什么」都看不到；
- 模型侧 `SendMessage` / `TaskStop` / `TaskOutput` 都只查进程内注册表，重启后找不到旧子代理。

用户感知是「子代理做到一半的工作白白浪费，只有主会话能继续」。

## 现在为什么这样

代码事实（Rust 内核）：

- 子代理有独立子会话（`SessionKind::Subagent`，`parent_id` 指向父会话，`trace_id` 指向顶层会话），每条 assistant 消息、`tool_use`、`tool_result` 都逐条写进同一个 SQLite（`kernel/crates/agents/src/spawn.rs`、`kernel/crates/node-store/src/load.rs`）。
- 但子代理**没有独立 session actor**，执行是内核进程内的 tokio task：
  - 前台子代理挂在父回合的 task 上；
  - 后台子代理挂在内核根 scope 的 spawner 上（`spawn::background`）；
  - 进程退出即全部 abort（`kernel/crates/cli/src/app_server.rs` 的 2 秒关闭宽限）。
- 运行时身份只在内存 `Live`（`kernel/crates/agents/src/live.rs`）：agent id、定义、模型、父/owner、深度、后台标记、邮箱。重启后 `Live` 为空。
- 完成通知只在内存 `Hub`；子代理的 `Report` 也没有作为行落库（`kernel/crates/agents/src/spawn.rs` 的 `drive` 结束处只写 `TurnEnded`）。
- `spawn::resume` 能在同一个 `LiveAgent` 上追加消息并重跑，但只在进程内可用（`SendMessage`、停放唤醒）。
- 文件工具/命令执行前有 `OperationIntent`，冷读能看到「动过什么」，但执行结果未知。

一句话：**消息已持久化，执行层没有；缺的是 reattach（重建 Live）和唤醒（续跑 + 通知）**。主会话能继续，是因为它是可寻址的 session，重启后能从存储重建 actor。

## 目标

1. 重启后子代理的已完成工作可见：只读列表、状态、子会话正文。
2. 重启前在跑的子代理自动续跑：复用同一个子会话，不从头开始；父会话最终收到结果通知。
3. 崩溃前已完成、只是通知丢了的子代理：重启后补发结果。
4. 干净停止（用户 TaskStop / 正常结束）不重跑。

## 非目标

- 独立 daemon/worker 进程（客户端退出后子代理继续跑）。当前架构的终止、唤醒、通知都绑定进程内对象，做成独立进程是另一个量级的改造。
- fork 子代理在重启后自动续跑：fork 继承的前缀不落库（`fork_prefix` 只在内存），直接续跑会丢上下文。先恢复为可见，后续再评估从 `fork_parent` entry 重建前缀。
- marketplace 插件同步等其它功能。

## 数据模型

全部用 `Fact::Entry`（`session_entry` 表，同 `kind + id` 覆盖），不新增表、不改 Node 存储 schema。

| entry kind | 所在会话 | id | 内容 |
| --- | --- | --- | --- |
| `subagent_spawn` | 子会话 | agentId | agentId、childSessionId、parentSession、rootSession、ownerAgentId、depth、toolUseId、description、agentType、workspace、machine、selection、execution、background、fork、createdAtMs |
| `subagent_result` | 子会话 | agentId | ending（completed/failed/killed）、text、tokens、toolUses、durationMs、toolUseId、finishedAtMs |
| `subagent_run` | 子会话 | agentId | startedAtMs（每次 create / resume 覆盖，用来判断旧 result 是否已被新一轮取代） |
| `subagent_resume_attempt` | 子会话 | agentId | count、lastAtMs、reason（`process_restart`） |
| `subagent_result_delivered` | 父会话 | agentId | deliveredAtMs |

写入点：

- `spawn::create`：在提交模型/模式/第一条 user 消息的同一批里写 `subagent_spawn`。
- `spawn::drive`：结束时写 `subagent_result`（含失败与停止；`Killed` 也写，避免重启后重跑用户主动停掉的子代理）。
- 第一段续跑前写 `subagent_resume_attempt`。
- 通知成功投递后写 `subagent_result_delivered`（父会话）。

## 恢复流程

入口：`LocalKernel::open_session_as` 冷加载顶层会话后（`Opened::Loaded`），调用
`Agents::restore_session(&session)`。只处理顶层会话，子会话和 DWF actor 会话不进入。

1. `store.owned_session_trees([root])` 拿到顶层会话与全部附属后代（已包含 `subagent_child`）。
2. 对每个子会话读 `subagent_spawn` / `subagent_result` / `subagent_resume_attempt`（`store.entries`，不加载全量消息）。
3. 有 `subagent_result` 且 `subagent_run.startedAtMs <= result.finishedAtMs`（旧结果没有被新一轮取代）：
   - 重建 `LiveAgent`（状态 `Finished(ending)`），让侧栏能看到；
   - 父会话没有 `subagent_result_delivered` 时，按结果重建 `<task-notification>` 投递给父会话，写 delivered marker；
   - `Killed` 的结果不再续跑。
   - 若 `subagent_run` 比结果新（上一轮完成后又被 SendMessage/续跑拉起，崩溃在新一轮里），按“没有结果”处理。
4. 没有（或被新一轮取代的）`subagent_result`：
   - 重建 `LiveAgent`（定义按 `agentType` 从目录重新解析；workspace/selection/execution 来自 spawn entry）；
   - fork 子代理不自动续跑：标记为 `Failed` 并在报告文字里说明「fork 前缀未持久化，需人工处理」；
   - 尝试次数达到上限（2 次）不自动续跑：标记为 `Failed`，保留正文可见；
   - 否则：
     1. 写 `subagent_resume_attempt`（count+1）；
     2. 冷读子会话，给没有结果的 `tool_use` 补 `INTERRUPTED_CALL` 的 `is_error` 结果并提交（只补一次；已有结果的调用不动）；
     3. 追加一条 `UserOrigin::Meta { source: "process-restart" }` 的续跑消息；
     4. `spawn::background` 重新驱动；
     5. 结束时照常写 `subagent_result` 并投递通知。
5. 自动续跑有并发上限（同时 2 个），其余串行排队，避免重启瞬间把所有子代理一起拉起。

续跑消息固定为：

```text
Continue the previous task from where it left off. The client restarted while you were running.
Do not start over: first check what you have already done (the messages above and the workspace),
then finish the remaining work and report the result.
```

## 安全规则

- **不重放工具调用**：崩溃瞬间正在执行的工具结果未知，补成 `INTERRUPTED_CALL`，由模型自己核对后再决定是否重做；已经提交结果的工具不会重跑。
- **有界**：每个子代理最多自动续跑 2 次（跨重启累计），失败不循环；续跑消息明确要求先核对现场。
- **干净停止不复活**：用户 `TaskStop`、正常完成、失败结束都会写 `subagent_result`；有结果的子代理不会自动续跑。
- **DWF 隔离**：DWF actor 会话没有 `subagent_spawn` entry，不会被当成本功能的子代理。
- **单写者**：恢复只在会话冷加载时做一次；已经在 `Live` 里的 agent 不重复恢复（同进程内用 `live.get` 去重）。
- **异常不外抛**：恢复失败只记日志，不影响会话打开。

## 顺带修正

`spawn::drive` 现在把 `QueryStop::ApiError` / `Blocked` 映射成 `Ending::Completed`，导致重试耗尽的 API 错误在父会话/通知里显示为成功。恢复逻辑无法区分「完成」和「网络失败」，因此一并改为 `Failed`，错误文本进 `<summary>`；已有部分文本仍进 `<result>`。

## 实施计划

### Rust（先行）

1. `agents/src/spawn.rs`：写 `subagent_spawn` / `subagent_result`；`ApiError` → `Failed`。
2. `agents/src/restore.rs`（新）：`Agents::restore_session`、重建 `LiveAgent`、补 `INTERRUPTED_CALL`、写 resume attempt、续跑与通知补发。
3. `runtime/src/kernel.rs`：`open_session_as` 冷加载后调用 `restore_session`；只在顶层会话。
4. 读面：恢复的 agent 进入 `Live`，`session/subagents`、侧栏、`subagent_view` 自动可见；未续跑的失败项在子会话正文里能看到中断结果。
5. 测试：
   - spawn/result entry 写入；
   - 无结果 + 有 spawn → 重建、补中断结果、追加续跑消息、重跑；
   - 有结果 → 只补通知、不重跑；
   - `Killed` 不续跑；
   - attempt 上限不循环；
   - fork 不自动续跑；
   - DWF actor 不误恢复；
   - `ApiError` 终态为 failed。

### Node（对齐）

Node 已有 `resumeTerminalAgentInBackground`（同进程续跑）与子代理只读查询。对齐项：

1. 子代理启动时写一份 durable task row（或等价 entry）：agentId、childSessionId、parent、类型、后台、toolUseId、selection。
2. 冷恢复时按 parent 扫子会话，重建 registry 条目；对无 outcome 的项补中断结果 + 续跑消息，走 `resumeTerminalAgentInBackground`。
3. 终态通知落库；冷恢复补发未消费通知。
4. Host 的 `hasBackgroundWork` 不再对已死的后台子代理硬编码为 false，改为按 durable row 判断。

Node 是回退内核，Rust 通过验收后再做，避免两条轨同时改。

## 验收

- 手写一个正在跑的后台子代理，强杀内核进程，重开父会话：列表出现该子代理、状态可见、自动续跑、父会话收到完成通知。
- 前台子代理在工具执行中强杀：重开后父会话看到中断说明，子代理自动续跑（或达到上限时显示失败原因）。
- 用户 TaskStop 后重启：不复活。
- 崩溃前已完成、通知丢失：重开后父会话收到补发的通知，子代理不重跑。
- 恢复期间父会话可正常输入；恢复失败不影响会话打开。
- 既有 Rust workspace 测试与 `cargo clippy` 全绿。

## 实施记录（Rust，2026-11-11）

- `kernel/crates/agents/src/spawn.rs`：`create` 同一批写 `subagent_spawn` 与 `subagent_run`；`resume` 覆盖 `subagent_run`；`drive` 结束写 `subagent_result`（完成/失败/停止都写）；`ApiError` / `Blocked` 由“完成”改为失败终态。
- `kernel/crates/agents/src/restore.rs`：`restore_session` / `restore_loaded_session`；重建 `LiveAgent`、补 `INTERRUPTED_CALL`、写续跑尝试、后台续跑、补发丢失通知；不能续跑的分支（fork、次数上限、定义缺失、续跑失败）落失败结果并通知。
- `kernel/crates/runtime/src/kernel.rs`：冷加载顶层会话后调用 `restore_loaded_session`，不重复全量读历史。
- `kernel/crates/kernel-api/src/orchestration.rs`：`QueryError::Api { message }`，避免把 API 错误伪装成 `InvalidRequest`。
- 测试：`nibi-kernel-agents` 99 条（含 10 条恢复用例，含“旧结果被新一轮取代”）；`nibi-kernel-runtime` 新增集成用例（重启后恢复完成子代理 + 补发通知）；全 workspace 117 个 suite 通过（TUI esc 时序用例在并行负载下偶发，单跑通过，既有问题）。

## 已知边界

- 崩溃瞬间正在执行的工具可能被重做一次（结果未提交，无法判定）；文档与续跑提示都明确要求模型先核对现场。
- fork 子代理只恢复可见，不自动续跑。
- 恢复后的子代理暂不挂 `Asks`（无法在续跑中向用户提问）；后续从会话 actor 注入。
- 结果通知是 at-least-once：正常投递不写 `subagent_result_delivered`，重启后可能再收到一次同一子代理的完成通知；恢复路径写过标记后不再重复。
- 恢复只在顶层会话冷打开时触发；一直不打开的会话在下次打开时补做。
- 停放的子代理被 `TaskStop` 时可能沿用上一次运行的 `completed` 结果，重启后不会重跑，但状态/通知显示为上次完成而不是“用户停止”。
- 恢复条目的 `startedAt` 按恢复时刻重建，已完成条目的耗时显示为 0。
- Node 内核的对齐在第二阶段；在此之前 `NIBI_KERNEL=node` 不具备续跑能力。

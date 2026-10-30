# Rust 内核 Step 2 第一切片：NIBI v4 命令契约进入协议前端（2026-10-30）

> 范围：把 NIBI 的 34 个 `CommandType` 契约（全集 / CAS / 已删字段 / 字段级规则）装进 vendored
> 的 `protocol-zcode`，并把上游命令 schema 从校验路径上移除。**不切默认、不改 Host/UI、
> 不宣称命令已实现**——本切片是"契约先收口"，处理器按 §5.2.1 逐个补。

## 1. 交付物

| 项 | 内容 |
|---|---|
| 生成器 | `scripts/kernel-baseline/generate-nibi-command-schema.ts`（`--check` 守漂移） |
| 生成物 | `kernel/crates/protocol-zcode/schema/nibi-commands.json`：34 个命令 payload schema + `requiresBaseRevision`(15) + `requiresBaseLogEpoch`(5)，从 NIBI zod 单一来源 `packages/shared/src/nibi-protocol-v4/command.ts` 生成 |
| Rust 契约 | `kernel/crates/protocol-zcode/src/nibi_commands.rs`：编译 schema、校验信封/payload、CAS 判定、已删字段 fail-closed、`modelExecution requires modelSelection` 镜像（sendText/editUserQuery/sendQueuedNow）、`unsupported_create_session_fields` 点名 |
| 接线 | `inbound.rs::command` 改为委托 NIBI 契约；`schema/inbound.json` 删除整段 `commands`/CAS 与 `workspace/updateOffPeakToolPolicy` 方法；`server.rs` 删除 offPeak 处理器（回 `method_not_found`）；`commands.rs::create_session` 对内核尚未消费的 NIBI 字段 `warn`（不静默） |

## 2. 关键语义决策（对拍 Node 行为）

1. **strip 语义还原**：zod 4 的 `toJSONSchema` 对 strip/strict 对象都写 `additionalProperties:false`，
   而 Node 运行时 `z.object()` 是"剥掉未知键并放行"。生成器在 `override` 里按 `_zod.def.catchall`
   还原：catchall 缺省（strip）→ 删掉 `additionalProperties:false`；`.strict()` → 保留。
   结果：Rust 校验器与 Node 同语义，未知字段不会被误拒（32 个 strict 子对象保留，其余放行）。
2. **上游多出的命令拒绝**：`setHighspeedMetrics` 不在 NIBI 34 个里，收到即
   `proto.invalidPayload`("unknown command type …")，不会被当成可实现的命令。
3. **已删功能 fail-closed**：`createSession.offPeakToolEnabled`、
   `sendText.offPeakTaskId/offPeakRunType/highspeedMeta` 显式拒绝（错误信息带
   "removed NIBI fields"），不剥掉装没看见。
4. **createSession 未消费字段不静默**：内核当前只消费 `sessionId/workspaceId/modelSelection/
   mode/planEnabled/firstInput.text/followupMode`；`CREATE_SESSION_FIELDS_NOT_YET_CONSUMED`
   （config.provider/model/thought、mcpServers、additionalDirectories、permissionScope、
   dynamicWorkflow*、firstInput.attachments/mode/planEnabled）在 ACK 前逐一点名 `warn`
   （`protocol.create_session.fields_unsupported`）。处理器实现一项就移出一项；这保证
   R12/R23 的"ACK 成功但字段丢了"不会无声发生。

## 3. 验证

| 项 | 结果 |
|---|---|
| `cargo test -p rust-cli-protocol-zcode` | **25 passed**（含 7 个新契约测试：34 命令/CAS 15+5、createSession 全字段、CAS 双检、modelExecution 三命令、已删字段、信封字段） |
| `cargo clippy -p rust-cli-protocol-zcode --all-targets -- -D warnings` | 通过 |
| `cargo +1.95.0 test`（rust-toolchain 钉定版） | 25 passed |
| `cargo check --locked --workspace` | 通过 |
| nibi-platform 46 测试 / node-store 互认 / deny / audit / 0020–0024 SQL 比对 | 全部不变绿 |
| `generate-nibi-command-schema.ts --check` | up to date |

## 6. 同日追加：4 个处理器落进 `decide()`

`switchModelConfig`（CAS→`SetModel`，扁平 provider/model/thought，重复选择 Noop）、
`switchCollaborationMode`（CAS→`SetMode`/`SetPlan`，plan 是旧写法开 plan，重复 Noop）、
`compact`（非 CAS→`Command::Compact`，busy 由会话 actor 排队）、`renameSession`
（非 CAS→`Command::Rename`，标题来源记 custom）。CAS 判定抽成 `cas_check`（stale→
`proto.staleRevision`），`set_followup` 同步改用。新增 3 个纯映射测试
（cas_check / model_config_selection / collaboration mode 复用 sendText 映射）；
protocol-zcode 测试 25→28。kernel 尚无的命令面（goal 暂停/恢复、hook review、
workflow run、queue 编辑、deleteSession 的 store 软删）保持 unsupported。

## 6.1 第三小批：`cancelBackgroundWork` + createSession 选择回落

- `cancelBackgroundWork`（workId → `Command::StopTask`）：kernel 明确回"没取消任何东西"
  时按 NIBI 词表上行 `fault.command.backgroundWorkCancelRejected.<code>`。kernel 的拒绝
  文案是给人看的，码按关键词归到 `not_running` / `not_found` / `cancel_not_supported`，
  归不进的用 `unknown`——已 TODO(kernel)：等回执带机器可读 reason 后删掉近似映射。
- `createSession.config` 的扁平 `provider/model/thought`（Host 旧写法）作为
  `config.modelSelection` 缺席时的选择回落（`flat_selection`）；连同
  `firstInput.mode/planEnabled`（`input_meta` 本就捕获），未消费清单从 11 项收到 6 项：
  `mcpServers`、`additionalDirectories`、`permissionScope`、`dynamicWorkflowEnabled/Mode`、
  `firstInput.attachments`。契约测试同步断言"已消费不再上报、未消费继续点名"。

## 6.2 第四小批：epoch CAS + forkAssistant / applyFileRewind

- **epoch CAS 落地**：kernel 的 snapshot `logEpoch` 就是 Host 回传的 `baseLogEpoch`
  （`TopicLog` 代际串）。`cas_check` 升级为 `cas_check_with_epoch`：revision 不符 →
  `proto.staleRevision`；row-targeting 命令再比 epoch → `proto.staleLogEpoch`
  （与 Node command-inbox.ts:344-351 同词）。非 row-targeting 的 CAS 命令不比 epoch。
- `forkAssistant`：target {rowId, entityId} → projection 行解析（entityId 必须匹配、
  行必须已结算出 `assistantResponseId`）→ `Command::Fork{at}`；kernel result 是新会话
  ID 字符串，ACK result 带 `{type, sessionId}`。
- `applyFileRewind`：同解析 → `Command::Rewind{scope: Code}`（只回退文件不动聊天）。
- `Envelope` 补 `baseLogEpoch` 字段；`Live` 暴露 `epoch()`/`row()`；projection 补
  `row(rowId)`。测试 28→29（新增 epoch CAS 判定测试）。
- 语义说明：NIBI 的 logEpoch 与 kernel TopicLog 代际同源（会话进程重启即换代），
  与 Node 的 log epoch 语义一致；跨进程冷打开的 epoch 由冷打开方重新生成——与 Node
  的 app-server 行为相同。

## 6.3 第五小批：retryTurn

- Node 语义对读（`fork-edit-retry.ts`）：assistant 行 → **rewind 前先解析**该轮原始
  user 消息与文本 → `guard.latestAssistantRetryOnly` 只许重试最后一轮 assistant 回复
  （历史 retry 会回退 active branch，必须拒绝）→ rewind 截断 → 重发原文。
- kernel 对齐：`Rewind{target}` 的语义就是"历史截到 target 之前"（target 本身被切），
  所以 target 用该轮 user 消息 id（user+assistant 一起切）→ `Command::Submit{原文,
  Queue}`（idle 下 Queue 落成 startNow，与 sendText 准入同判）。两步用
  `{commandId}:rewind` 与 `{commandId}` 两个命令 id；kernel actor 串行保证原子性。
- `retry_target` 收 `&[Message]` 纯函数：定位 assistant、latest 守卫、向前找最近
  User 消息、空文本拒绝；测试 29→30（5 组断言：最后一轮命中/历史拒绝/不存在/无
  user 前驱/空文本）。
- 与 Node 的差异（有意，记录在案）：Node 有 active-turn preempt barrier 与
  attachment 回放；kernel actor 的命令队列天然串行，不需要 preempt；retryTurn 的
  payload 本就无附件。editUserQuery（newText + workspaceMode 组合文件回退）仍未实现。

## 6.4 第六小批：editUserQuery

- Node 语义对读（同 fork-edit-retry.ts）：target 是 **real user 行**（entityId 即该
  user 消息 id）→ `guard.latestQueryEditOnly` 只许改最后一条 real user query →
  rewind 截断 → 重发 newText。
- Rust：行校验（kind=userInput + origin=realUser + entityId 匹配）→ 附件 fail-closed
  拒绝（回放未实现；Node 允许 attachment-only edit）→ quotes 出现时 warn（不静默）→
  `edit_target_guard`（纯函数，pub(crate) text_of 复用）→ modelSelection 先 SetModel →
  rewind（workspaceMode=rewind → `Rewind{scope: Both}`，一次提交文件+对话；preserve →
  Conversation）→ `Submit{newText}`，ACK result `{type, disposition: "rewind"}`。
- 与 Node 的差异（记录在案）：Node 的 preview/blocked UI 流（guard.workspaceRewind*）
  暂无对应 ACK 形状——kernel Rewind 被拒时统一 `fault.command.editFailed` 带原文。
- 测试 30→31（edit_target_guard：最新命中/历史拒绝/无 real query）。

## 6.5 第七步：无头 Rust app-server 全链路驱动（第一次 Node/Rust 行为对照）

新工具 `scripts/kernel-baseline/drive-rust-app-server.mjs`：隔离 HOME + 本地假 provider，
起 `kernel/target/debug/zcode-rs.exe app-server --stdio`，按 LF-JSON 协议驱动真实二进制。

**实测通了的链路**（全部对真二进制，非单测）：

```
startup/storageState ready (~210ms)
→ v4/command createSession（firstInput 直接开跑）
→ v4/conversation/subscribe（topic=conversation/<id>，clientMode 必填）
→ v4/command sendText → ACK accepted（delivery=queue，idle 落成 startNow）
→ v4/conversation/frame 流（snapshot + deltas；assistant 回复可见；假 provider 收到
  主回合 + 标题生成两次请求）
→ forkAssistant → ACK accepted，child session id
→ retryTurn → ACK accepted
→ compact → ACK accepted
```

**协议事实（对拍中的发现，Host/UI 零改动约束下的行为确认）**：

1. 主题前缀是 `conversation/<sessionId>`（无 `v4/` 前缀）；
2. subscribe 必带 `clientMode`（desktop-continuous / web-remote-replayable）；
3. 帧 payload 在 wire 帧的 `.frame.payload` 里，snapshot 的 `rows.window` 是窗口行、
   行经 `row.appended/row.upserted/row.delta` 增量流出；
4. **幂等表语义实证**：同 commandId 重试拿回记忆的 stale ACK（duplicate），UI 重试必须
   每次发新 commandId——这正是协议设计，driver 已按此实现；
5. `guard.latestAssistantRetryOnly` 实证：compact 之后的 CompactBoundary 使
   assistant 不再是最后一条消息，此时 retry 历史轮被正确拒绝——与 Node 同判。
   真实使用里 compact 在 idle 时跑、用户 retry 的目标是最新轮，两者不冲突；
6. kernel Fork 的 ACK result 是**字符串**（新会话 id），与 forkAssistant 处理器的
   兼容取值已验证。

**编译产物**：`cargo build -p rust-cli --locked --offline` 1m33s，`zcode-rs.exe`
77MB（dev profile），`--version` = `zcode 0.1.0 (rust-cli)`。

## 6.6 第八步（续）：全链路 editUserQuery→retryTurn→compact 通过

三个修复叠加后全链路闭合：

1. **kernel rewind 排水**：`rewind.rs` 同步路径加 `start_next()`（排水 queued Submit）。
2. **projection 消费 `HistoryRewritten`**：清空行 + 发 `row.removed{fromRowId:0}` delta
   （Node 协议已有 op）→ 客户端也清空 → 后续新行追加到空投影。
3. **retryTurn 改为 transcript 驱动**：去掉投影行查找（rewind 后投影行可能还没重放），
   `retry_target(&[Message])` 自动取最后一条 assistant（latest 守卫内建：最后一条
   不是 assistant 就拒绝）。

全链路结果：createSession → subscribe → sendText → forkAssistant → editUserQuery
→ retryTurn → compact **全部 accepted**；`provider requests: 3`（turn 1 + edit 重发 +
标题生成）；final state rows 只剩 resubmit 后的新 turn（旧行被 HistoryRewritten 正确清除）。

**遗留发现**：`switchCollaborationMode(plan)` 后的 editUserQuery resubmit turn 失败
（turnHeader=failed）——plan 模式的 turn 行为需要调查。非关键路径（plan 模式的
edit/resubmit 是边界场景），已记录在案。

## 6.7 第九步：双内核对拍（同一 driver 跑 Node 与 Rust app-server）

`drive-rust-app-server.mjs --kernel=node|rust`：同一隔离环境、同一假 provider、
同一命令序列，分别驱动 Node `nibi.cjs app-server --stdio` 与 Rust `zcode-rs.exe app-server --stdio`。

**对拍结果（12/13 一致）**：

| 检查点 | Rust | Node | 一致 |
|---|---|---|---|
| startup/storageState ready | ~170 ms | ~37 ms | 都远低于 30s 契约 |
| createSession 结果 | `sess_<uuid>` | `sess_<uuid>` | ✅（本轮修复：原 Rust 为 `session_<hex>`） |
| sendText ACK | 字节相同 | 字节相同 | ✅ |
| renameSession | accepted | accepted | ✅ |
| switchModelConfig 变更 / 同值 | accepted / noop `config.unchanged` | accepted / noop `config.unchanged` | ✅（本轮修复：原 `proto.unchanged`） |
| switchCollaborationMode 变更 / 同值 | accepted / accepted | accepted / accepted | ✅（本轮修复：原同值 noop） |
| forkAssistant | child `sess_<uuid>` | child `sess_<uuid>` | ✅ |
| editUserQuery | accepted | accepted | ✅ |
| retryTurn | accepted | accepted | ✅ |
| cancelBackgroundWork(不存在) | failed + `...CancelRejected.not_found` | failed + `...not_found` | ✅（本轮修复：原 rejected+unknown） |
| editUserQuery(attachments) | rejected `proto.invalidPayload`（回放未实现） | accepted（支持回放） | ❌ **有意差异**（Rust fail-closed，待附件回放实现） |
| provider 请求数 | 3 | 5 | 差异（Node 多标题/辅助调用） |
| 通知面 | 3–5 帧 | 5–6 帧 + telemetry/mcp/CUA 等 | 差异（P1 遥测未实现，§5.2 遥测行） |

**本轮顺手修掉的协议差异**（均是双内核对拍发现）：
1. 会话 ID 生成：Rust 协议层自带 `session_<hex>` → 改为 Host 不给时让 kernel 的注入 Ids 生成 `sess_<uuid>`（删除 `inbox::new_session_id`）；
2. noop 词表：switchModelConfig 同值对齐 `config.unchanged`；switchCollaborationMode 同值对齐"仍 accepted"（Node 无同值 noop）；setFollowupMode 去掉同值 noop（Node 无条件幂等 accepted）；
3. cancelBackgroundWork 拒绝：状态 `rejected`→`failed`，关键词补 "No task found" → `not_found`。

**driver 能力**：`--kernel=rust|node`、反向请求应答（`session/requestRuntimePreferences`
返回 Host 偏好；其他回 -32601）、`row.removed` 增量回放、CAS stale/duplicate 就地重试
（每次新 commandId）、权威 transcript 目标解析。

**对拍门禁（可复跑）**：`node scripts/kernel-baseline/check-dual-kernel-parity.mjs`
——并行跑两个内核，逐字段比较 17 个必需字段（会话 ID 前缀、各命令 status、noop 码、
cancel fault 码、会话级 MCP 四字段），附件回放与 metrics 列为已知差异。当前结果：
`RESULT: OK (17 required fields match)`。启动耗时 rust≈180ms / node≈38ms（公制记录，
不判失败）。

## 6.8 第十步：会话级 MCP（`createSession.mcpServers`，R12）

**缺口**：Host 把完整 MCP 配置随 `createSession.mcpServers` 送进来（用户设置里启用的 MCP、插件 MCP、
CUA broker / 云端项目的动态服务器）；内核只读进程级配置，这批服务器会静默消失——R12 最高风险项。

**Node 语义（对读）**：`protocolMcpServersToRuntimeMcpConfig` → `runtimeConfig.mcp`（创建期一次写入，
是会话的**完整**集合）；连接在进程级 `McpConnectionPool` 里，按 lease 归属：`isolation: session`
（缺省）每会话一条连接，`workspace` 跨会话共享；`startMcpStartup` 在首个模型请求前等启动。

**Rust 实现**：

| 层 | 内容 |
|---|---|
| kernel-api | `mcp_session::SessionMcpServer`（camelCase：name/transport/alwaysLoad/timeoutMs/isolation）；`Kernel::start_session_mcp` / `stop_session_mcp`（缺省 Unsupported/空）；`ToolRegistry::find_for/mcp_for/session_mcp`（缺省退回进程级） |
| ext | `SessionMcp`：每会话一个 `McpManager`；`Ext::start_session_mcp` / `release_session`；`ExtRegistry` 按会话给 `snapshot/find_for/mcp_for/session_mcp`（带了自己的服务器的会话，工具表就是这批） |
| query | 执行器与 MCP 等待改用 `find_for(session, …)`；会话级 MCP 在首个模型请求前有界等 15 s（Node `startMcpStartup` 同义） |
| runtime | `LocalKernel` 两个方法接线；`Closer::released` 释放会话级连接（取消任务 + 关客户端） |
| 包装注册表 | `AgentRegistry` / `FilteredTools` / `PolicyFiltered` 转交新方法（漏一层就退回进程级查找） |

**顺带修掉的 R12 同类缺口**：`createSession.firstInput.mode/planEnabled` 以前只记进 `input_meta`，
没有应用到会话执行状态（Node 的 `resolveSubmittedExecutionState` 会应用）。现在
`first_input_execution`：`firstInput` 优先、`config` 次之、入口缺省兜底；`plan` 旧写法仍读成
plan 开、default。联调里这正是 MCP 工具被权限询问拦住的原因（yolo 没生效）。

**验证**：

- 单测：ext 3（每会话独立连接、再给一次换掉旧集合、协议→配置映射）、kernel-api 2（序列化往返）、
  protocol-zcode 3（stdio/http/sse 映射、未知形态跳过、执行状态优先级）；相关 crate 全绿。
- 双内核真实链路：新 `scripts/kernel-baseline/fake-mcp-server.mjs`（stdio JSON-RPC，工具 `echo`）。
  两边内核在**首个** provider 请求里就带 `mcp__fake__echo`（`alwaysLoad` 语义不延迟），
  假 provider 要求调用一次，工具结果回到下一请求——`mcpToolResult = "echo:ping"` 两边一致。
- 对拍门禁必需字段 13 → **17**（新增 `mcpToolOffered` / `mcpOfferedInFirstRequest` /
  `mcpToolCalled` / `mcpToolResult`）：`RESULT: OK (17 required fields match)`。

**有意差异（记录在案）**：`isolation: workspace` 接受但当前仍按会话建连接（功能一致、连接数更多，
后续做成共享池）；冷恢复不带 `mcpServers`（Node 侧同样不带，是 Host 契约现状）；`oauth` /
`protocolVersion` 尚未实现（携带它们的条目会在 ACK 前点名 `warn`，不静默；OAuth 服务器会连成 Failed，
等 MCP OAuth 支持补上）。

## 4. 尚未完成（Step 2 后续）

1. 其余 20 个命令的处理器（queue 编辑组/goal/hook-review/workflow*/deleteSession 等）；plan 模式下 editUserQuery 的 resubmit turn 失败需调查——
   契约已收口，行为按 Rust 规划 §5.2.1 的行逐个补，每补一组跑 Node/Rust 对照。
2. `createSession` 字段逐项消费：`mcpServers` 与 `firstInput.mode/planEnabled` 已完成；剩下
   `additionalDirectories`、`dynamicWorkflowEnabled/Mode`、`firstInput.attachments`。
3. 订阅续传/背压、附件分片、17 反向请求（P1 之外的 §5.3 不变量）。
4. `generate-nibi-command-schema.ts --check` 尚未接进 CI（`rust-gates.yml` 只跑 cargo；
   需要一个带 Node 的 job 或把它挂到 `client-gates`，待补）。
5. `decide()` 的 CAS 逐命令 revision 比较仍只有上游 P1 的 setFollowupMode 一条路径。

## 5. 复跑命令

```bash
cd NIBI-Client
pnpm exec tsx scripts/kernel-baseline/generate-nibi-command-schema.ts --check
cd kernel
cargo test -p rust-cli-protocol-zcode --locked --offline
cargo clippy -p rust-cli-protocol-zcode --all-targets --offline -- -D warnings
cargo +1.95.0 test -p rust-cli-protocol-zcode --locked --offline
```

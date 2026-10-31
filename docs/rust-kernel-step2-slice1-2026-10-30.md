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
等 MCP OAuth 支持补上）。子代理继承父会话的连接已落地（`inherit_session_mcp`，借用不释放），
与 Node 的子代理 app 继承父 `config.mcp` 对齐。

## 6.9 第十一步：会话附件回放（图片，2026-10-30）

**缺口**：Host 的 `sendText` / `createSession.firstInput` / `editUserQuery` 带 `AttachmentRef`
（`zcode-artifact://<session>/<artifact>` 或本机路径）而不是内容；Rust 之前不消费，图片内容丢。

**实现**（与 Node 的引用模型对读）：

| 层 | 内容 |
|---|---|
| kernel-api | `attachment::{AttachmentSource, LoadedAttachment}`；`Kernel::load_attachment(session, workspace, source)`（缺省 Unsupported） |
| runtime | artifact URI → `ArtifactStore::find/get`（与 Node `NodeToolArtifactStore` 同目录同命名，data URL 在这里解开）；路径 → `Files::read_file`；跨会话引用拒绝；20 MiB 上限 |
| protocol-zcode | 图片 → `ContentBlock::Image`（base64，图片在正文前）；PDF/视频/文本 **fail-closed** 拒绝（`fault.command.attachmentUnsupported`）；读失败 `fault.command.attachmentUnreadable`；sendText/createSession/editUserQuery/retryTurn 同一条写路径；`userInput` 行的 `attachments` 来自 `InputMeta` |

**已知差异**：本地路径图片 Node 在 OpenAI-compatible 分支降级成 `[Attached <mime>: <path>]` 文本，
Rust 读文件内联（多做不少做）；PDF/视频/文本附件仍不支持，拒绝是显式的；冷恢复后行上的
`attachments` 与其它 `InputMeta` 一样只在活会话里有。

**验证**：runtime 4 单测、protocol-zcode 36 测试；双内核驱动用真实 PNG：两边 accepted、
行上 1 条引用，对拍门禁 17 → **20** 字段全一致（`attachmentReplayed` 作为模型侧已知差异）。

## 6.10 第十二步：会话附加工作目录（2026-10-30）

`createSession.additionalDirectories` 此前不消费：目录既不进提示词，也不进判决链的允许范围。

- `kernel-api::session_paths::SessionDirectories` + `Kernel::set_session_directories`；
- `policy`：`path_context` 按会话把目录接进 `roots`（远端机器不带，同 `--add-dir` 规则）；
- `context`：`shown_facts` 并进 `EnvFacts.additional_directories`，环境段列出；
- `agents`：子代理继承父会话的目录；`runtime`：一份句柄共用，会话关闭释放；
- `protocol-zcode`：createSession 调用设置（空列表等于没有）。

**冷恢复**：Host 的 `subscribe` 参数带 `additionalDirectories`/`resumeThoughtLevel`，Rust 在冷打开时
应用（live 订阅不消费）：`set_session_directories` + 需要时一次 `SetModel`。新门禁
`check-cold-resume.mjs`（两段式：正常建会话 → 新进程订阅持久化会话 + 发输入）两个内核都通过。

已知差异：冷恢复不带 `mcpServers`（Host 的订阅参数里没有它，Node 同样拿不到）；回合中途被杀留下
未结束回合时，冷打开后的输入会排队不跑（两个内核同象，harness 需先干净收尾）。验证：policy 新测试
（按会话放行、跨会话隔离、继承、远端不带、释放后询问）；双内核驱动两边环境段都含
`extra-workspace`；对拍门禁 20 → **21** 字段全一致。

## 6.11 第十三步：队列命令组五件（2026-10-30）

`editQueueItem` / `deleteQueueItem` / `reorderQueueItem` / `setAutoDrain` / `sendQueuedNow` 此前落到
`unsupported`；内核只有"入队 + 回合结束排水"。

- kernel-api `Command` 五个变体；session actor 在 `queue.rs` 处理（编辑含 bash/内容块形态、删除清
  种类表、重排带通道顺序、autoDrain 开关 + `settle_queue` 兜底、sendQueuedNow 的 `promote` 槽 +
  抢占后由 `start_next` 先开）。
- 协议层剥 `queue_` 前缀；未命中语义对齐 Node（delete → noop `queue.itemMissing`；edit/reorder →
  warn 后 accepted；sendQueuedNow → failed `executionFailed`）。
- 双内核驱动新增队列阶段（真实挂起一轮制造"忙"），两边 edit/reorder/delete/autoDrain/promote 全部
  一致，被编辑的项在提升后进入模型请求；对拍门禁 21 → **30** 字段全一致。
- 内核未实现 Node 的 promotion lease/reservation 机制（单进程串行 actor 不需要），语义等价。

## 6.12 第十四步：setAssistantFeedback 与 snoozeInteractionAutoResolution（2026-10-30）

- `setAssistantFeedback`：校验 row target（assistantText + entityId + 已结算 response id），反馈写成
  前端记录 `assistant_feedback`（key = 消息 id），活投影 `row.upserted`；冷恢复后徽标暂不重建
  （记录已落库，后续补 hydration）。store 不支持时 failed `fault.command.assistantFeedbackUnsupported`。
- `snoozeInteractionAutoResolution`：内核没有自动结束倒计时，按幂等 noop 接受并记日志（与 Node
  在无倒计时时的行为一致）。
- 验证：projection 单测；双内核驱动两命令都 accepted；对拍门禁 32 字段全一致。

## 6.13 第十五步：goal 三件（2026-10-30）

- `sendGoalCommand`：前缀归一 + plan 互斥 + 空目标拒绝 → 以 `/goal <objective>` 提交（内核的
  `goal_inputs` 负责写 sentinel/命令消息/说明并开回合）。
- `pauseGoal`/`resumeGoal`：`Command::SetGoalPaused`；暂停藏条件（不续跑）并中止当前回合；`GoalStatus`
  加 `paused`/`marker` 持久化，冷恢复保留暂停位；无目标幂等成功。
- 有意差异：resume 不主动起续跑回合（Rust 的续跑由回合结束判定驱动；Node 会立刻起后台 continue）。
- 验证：session 单测；双内核驱动三条都 accepted；对拍门禁 35 字段全一致。

## 6.14 第十六步：createSelectionSideSession（2026-10-30）

- `Command::CreateSelectionSideSession { selection? }`：`SessionStore::fork` 复制整段对话到新会话，
  选择默认继承、`firstInput.modelSelection` 覆盖；协议层在新会话里提交 `firstInput.text`，
  返回 `{type, sessionId}`。
- 有意差异：忙时拒绝（Node 切到当前回合起点）、空对话拒绝、未复制 Node 的
  `selection_side_chat` 会话类型与 `sourceCommandId`。
- 验证：双内核驱动两边 accepted、child 前缀与父不同；对拍门禁 38 字段全一致。

## 6.15 第十七步：命令覆盖表收口（2026-10-30）

34 个命令现在全部有归属：26 个接住、8 个列进 `BLOCKED_COMMANDS`（写清缺的能力），并有
`every_command_is_either_handled_or_explicitly_blocked` 测试守住"不漏项、不重叠、理由非空"。
`unsupported` 的 ACK 会把缺的能力带进 message，切默认前能分辨"功能缺口"与"没接线"。

剩余 8 个都是**能力缺口**而非接线：

- hook review 四件：**接线缺口，不是能力缺口**——`platform::hook_trust`（按 digest 的
  `load`/`grant`/`revoke`）与 `hooks::workspace_digest`（bundle 与条目摘要）都已存在，缺协议层的
  评审流状态（reviewFlowId/generation/interactionId）与四个命令的接线。（此前记成"信任模型只有
  路径级"是错误；路径级 `workspace_trust` 是工作区信任提示，另一件事。）
- workflow 三件：DWF run 能力（与 `createSession.dynamicWorkflow*` 同一缺口）。
- `discardSharedContext`：分享上下文存储。

在功能 track 完成或明确"首期走 Node"之前，这 8 项阻塞切默认。

## 6.16 剩余三类功能的排期（2026-10-30 拍板：都补）

顺序与设计草案另立文档 [`rust-kernel-remaining-tracks-2026-10-30.md`](rust-kernel-remaining-tracks-2026-10-30.md)：
钩子评审（中等，先做）→ `discardSharedContext`（中偏小）→ DWF 三件 + 内核 run 能力（大，最后，
独立 PR）。每步独立提交，不混品牌化；`NIBI_KERNEL` 默认仍是 node，切默认前置是这 8 条全绿或明确放弃。

## 6.17 第十八步：工作区钩子评审四件（2026-10-30）

（覆盖表：30 接住 / 4 能力缺口；对拍 63 字段。）

四条命令全部接住（`requestWorkspaceHookReview` / `respondWorkspaceHookReview` /
`toggleWorkspaceHookReviewItem` / `revokeWorkspaceHookTrust`），覆盖表变成 **30 接住 / 4 能力缺口**。

**内核侧**
- `kernel-api::hook_review`：快照形状（`WorkspaceHookReview` + `sources` + 逐条 `WorkspaceHookItem`，
  字段名对齐 NIBI 的 strict schema：`type` / `executionMode` / `displayName` = 「事件 · matcher」）与
  信任端口 `HookTrust`（`load`/`grant`/`revoke`）。
- `hooks::hook_review`：纯函数 `review`（digest 与 Node 逐字节一致）、`admitted`/`admitted_for`
  （信任变化后重建项目层 hooks 快照）。
- `platform::hook_trust`：`impl HookTrust for HookTrustStore`（`grantedAt` = `Base::js::date::iso_timestamp`）。
- `runtime`：`LocalKernel::with_hook_review(user_hooks, trust)` 注入端口（TUI/`-p` 不接，保持
  `Unsupported`）；四个方法 + **授权/撤销/开关当场生效**（`HookEngine::replace_project` 只换项目层，
  用户层与插件层不动）。

**协议侧**
- 评审流状态机（`protocol-zcode::hook_review`）：`reviewFlowId` 每会话一份、`generation` 单调 +1、
  每代一个 `interactionId`；命令 target 不符 → `workspace_hooks_review_superseded`，快照不符 →
  `workspace_hooks_snapshot_mismatch`；截止 10 分钟（计时任务到期撤交互）。
- 评审请求投成 **pending 交互**（`payload.kind === "workspaceHookReview"`），与 Node 的
  `onWorkspaceHookReviewRequested` 同形；`workspaceHookAdmission`（`pendingCount` 只数启用且待审）在
  会话第一次打开时上报，评审/授权/开关/撤销后刷新。
- `toggleWorkspaceHookReviewItem` 只改 `<工作区根>/.nibi/config.json` 里那一条的 `enabled`
  （`serde_json` 打开 `preserve_order`，两空格缩进 + 换行，与 Node 的 `JSON.stringify(v,null,2)` 同形），
  写前用重新解析的声明做守卫。

**验证**
- `drive-rust-app-server.mjs` 新增 `hookReview` 阶段（默认阶段列表里）：订阅时的提示条 → 请求评审 →
  交互 payload 断言 → 就地关/开（配置落盘 + 换代）→ 授权（信任记录落盘、提示条清空）→ 按摘要撤销
  （提示条回来）。
- `check-dual-kernel-parity.mjs`：**63 个必需字段全一致**（38 → 63），其中
  `hookTrustRecordDigest` 两边同为 `68ad4faa`（声明摘要逐字节一致）、`hookReviewSourcePath` 同为
  `.nibi\config.json`。
- `check-cold-resume.mjs` 仍 OK；`cargo test -p rust-cli-kernel-api/-hooks/-runtime/-protocol-zcode` 全绿；
  `cargo test -p rust-cli` 失败集合与基线一致（9 个环境相关既有失败）。

**已知边界**
- 企业策略（Node 的 `workspaceHookPolicy`）没有来源：`blocked_policy` 恒为 false。
- 评审交互的 `taskId`/`runId` 用会话 ID（Host 原样回传，只做 target 匹配）。
- 被替换的那一代只撤交互，不发 Node 的 `WorkspaceHookReviewSuperseded` 事件（Rust 投影按
  `pendingInteractions` 的替换收口）。
- 截止到期只撤交互、不回报 `timed_out` 结算（Host 按同一个 `deadlineAt` 自行收口）。

## 6.18 第十九步：discardSharedContext（2026-10-30）

分享导入的丢弃接住（覆盖表 **31 接住 / 3 能力缺口**，剩下的全是 DWF）。存储复用 Node 已经写好的
`session_entry`（`type = "v4/shared_context_import"`），**不加迁移**：

- 内核：`Kernel::shared_context_import`（冷打开种子）与 `Kernel::discard_shared_context`
  （只允许 `pending` → `discarded`，其余 provenance 原样保留）；
- 协议：冷打开把 `sharedContextImport` 种进投影（不发增量）；丢弃成功写一条
  `state.updated`，不是 pending 时 `failed` + `fault.command.inputRejected`（与 Node 的 ACK 同状态）；
- 验证：驱动新增 `discardSharedContext` 阶段（直接往会话库插一条 pending 导入）——丢弃后重新订阅的
  快照里 `status = discarded`（Node 的丢弃不产 delta，只能从快照读）、存储状态一致、第二次丢弃被拒；
  `check-dual-kernel-parity` **71 字段全一致**（63 → 71），`check-cold-resume` 仍绿。
- 边界：导入本身仍由 Node 的 server-operations 完成；Node 顺带更新的导入消息元数据
  `sharedContextStatus` 在 Rust 的消息模型里没有对应字段。

## 6.19 第二十步：DWF 路线拍板与只读面（2026-10-30）

DWF 调研后拍板 **路线 C（Rust 协议面 + Node 引擎 sidecar）**，设计与三方案对比见
[`rust-kernel-dwf-design-2026-10-30.md`](rust-kernel-dwf-design-2026-10-30.md)。第一段只读面已落地：

- `kernel-api::workflow::DynamicWorkflowRun`；`SessionStore::workflow_runs` /
  `Kernel::dynamic_workflow_runs`（缺省空）；
- `node-store::repo::dwf::list` 读 `dwf_run`（本会话、按 `time_created`），单测覆盖会话隔离与字段透出；
- 写面仍归引擎（sidecar 后由引擎独占），3 条命令继续显式 unsupported。

## 6.20 第二十一步：DWF 修订与升级问答（2026-10-30）

`amendWorkflowRunSettings`、actor 的 `escalate` 与主会话的 `ResolveWorkflowQuestion` 落地，
三条 DWF 命令从 `BLOCKED_COMMANDS` 移到 `HANDLED_COMMANDS`（**34 接住 / 0 能力缺口**）。

- 修订：三态归一与「未改」拒绝、编译体检都在停下任何东西之前；只改并发且 run 在飞时就地 retune
  （同 runId），否则 `{superseded}` 停前驱、等它结算、带 lineage 起后继；run 级 `subagentModel`
  经 `run-launched` → `actor/create` → `ActorProfile.selection` 真正作用到 actor 轮。
- 升级问答：`runtime::escalations` 注册表（qid 全局唯一、只许父会话作答、预算 3/ask、退场记忆有界）；
  actor 的 `escalate` 工具与主会话的 `ResolveWorkflowQuestion` 工具，通知经 `Agents::notify`
  走后台子代理的 `task-notification` 同一条路。
- 门禁：`check-dwf-engine.mjs` **31 字段**双内核一致；`check-dual-kernel-parity` 71 字段、冷恢复门禁
  照旧全绿。
- 仍未移植：journal 的 `escalation-*` 事件 / `pendingQuestions` 投影、修订后的设置轮、
  `modelBindings` 与 persona 级模型名解析、`GetWorkflowRun` 工具。

## 6.21 第二十二步：`--prepare-storage` 存储准备握手（2026-10-30）

Host 的启动存储门（桌面启动先备好会话库再起 Agent）对等落地；见 CHANGELOG-FORK §6.14 的完整
要点。摘录：

- node-store `open_with_progress`（Node onProgress 同一事件序列，含 `lastAppliedMigrationId`
  的带键时机与 Windows 分隔符归一）；`session_database_id` = 路径 sha256（app-server 常规帧的
  databaseId 一并切换，两内核同值）。
- cli `prepare_storage.rs`：`startup/storagePath` → 30s 确认帧 → 打开上报 → `storagePrepared`；
  失败两份帧（本 attempt + 全新 attempt），退出码 1。
- **顺手修掉的路径分歧**：`StoragePaths::resolve` 在 `sessionDbPath` 未设时跟随 `storage.dir`
  （Node `deriveSessionDbPath`）——此前 `ZCODE_STORAGE_DIR` 隔离时 Rust 会开到另一个库。
- 桌面：Rust 命令打开 `supportsStorageStartup` + `storagePreparationProcess`（原生 binary 进不了
  Worker 线程，`prepareSessionStorage` 增子进程分支，同一段握手）；`NIBI_KERNEL` 默认仍是 node。
- 门禁：`check-dual-kernel-parity` 增至 **92 字段**（存储准备 21），全一致；冷恢复与 DWF 31 字段
  照旧全绿。node-store 进度序列 2 例 + databaseId 固定向量。

## 6.22 第二十三步：升级问答的 journal 双轨（2026-10-30）

Node driver 的双轨 record（journal + emit）在路线 C 里由 Rust 宿主补上 durable 轨——
`escalation-raised` / `escalation-resolved` 落 `dwf_event`，与引擎 sidecar 共写同一个
`db.sqlite`。journal 由此成为 run 详情 `pendingQuestions` 投影与冷回放的数据源（详见
CHANGELOG-FORK §6.15）：

- node-store：`append_event`（序号分配与写入同一条 INSERT，多进程共享库不撞号）+
  `pending_questions` 冷回放（raised 减 resolved）+ `SessionStore::append_workflow_event` 窄口。
- runtime：`WorkflowEventJournal` 端口 + `SessionJournalSink`；raise **真**写失败 → 撤回 + 拒绝
  （journal 写不进去的停驻谁也看不见，不诚实），resolve 真写失败 → warn 后答案照送（actor 已经
  在等）——两条取舍与 Node 逐条对应；`Unsupported`（TUI / 内存存储）不是故障，只剩通知轨停驻
  照常（Node 引擎自带内存 journal 回退的同义）。
- 事件载荷与 Node `RunEvent` 同形：`actor` 是结构化 ActorRef（`{siteId, ordinal}`）。
- 门禁：`check-dwf-engine` **37 字段**双内核一致；runtime journal 双轨 1 例、node-store 事件 2 例。

## 6.23 第二十四步：`GetWorkflowRun` 工具（2026-10-30）

升级通知与答题拒绝文案都引用的查询兜底，journal 读面落地后接上（详见 CHANGELOG-FORK §6.16）：
journal 终态拆解/标签派生/节点计数/log 尾巴/待答问题（node-store `run_detail`）∪ 停驻注册表
活项（runtime `WorkflowRunDetailReader`）→ tools 的 `GetWorkflowRunTool`（名字/描述/输入
schema 与 Node 逐字，模型面块序同、可 sourced 字段子集；`<amendable>`/`<resumable>` 路由
提示逐字）。阶段表/花名册/留白/产物读面未接，对应块缺席。门禁 **45 字段**双内核一致。

## 6.24 第二十五步：启动轮与设置轮（2026-10-30）

中枢「运行」与 run 卡「配置」成功后的会话记录（docs/dynamic-workflow/launch.md 两节，详见
CHANGELOG-FORK §6.17）：两条路共用一套 machinery——

- **kernel-api**：`Command::WorkflowLaunch { text, launch }`（controlOnly 控制轮）与
  `Fact::WorkflowLaunchMessage`（合成输入事实，`TurnAnchor::after` 认它自成一轮）；
  `WorkflowRunStarted` 带上 `launch_turn`（启动材料）与 `settings_turn`（「改了什么」）。
- **node-store**：`append_launch` 按 Node `persistWorkflowLaunchUserMessage` 的形状写消息与
  text part（`source: "workflow_launch"`、`metadata.workflowLaunch`、`semantics.source` 同键）；
  `hydrate::user` 对 `metadata.source=workflow_launch` 的 synthetic part 网开一面——冷加载后
  文本照常进模型上下文（Node 的 provider history 同规）。
- **session actor**：忙时排进 `pending_launch`、回合收尾先落（Node 的 runtime 命令队列同
  优先级：先于新 run 的通知），空闲即落；落的是消息 + 完整轮边界、不开模型回合，文本进
  `messages`（模型下一回合读到）。
- **protocol**：`workflow_settings_turn.rs` 逐字移植两条规范句与元数据构造（含 args 4KB/
  description 500/script 256k 三道 Node 上界）；`startSavedWorkflow` / `amendWorkflowRunSettings`
  成功后发轮，写失败只记日志不回滚。
- **sidecar**：submit/amend 回复带齐材料（名字/作用域/落点/脚本/实参与 from/to/ceiling）；
  默认并发 D 从常量 4 改回宿主同款 CPU 公式（多核机上 ceiling 曾分叉）；submit 把 saved 名字
  落 `dwf_run.name`；中枢启动 toolCallId `call-` 归位 `launch-`。
- **Node 侧修一个真缺口**：`snapshotOf` 从不填 `name`（registry 与 journal 都有），设置轮的
  「已修订」句子因此从没带过名字——补上后两边逐句一致。

live 投影仍把控制轮当普通 agent 轮画（`executionKind: "controlOnly"` 未穿 `KernelEvent::
TurnStarted`），运行卡由冷恢复的 `metadata.workflowLaunch` 而来——归投影面。门禁 **55 字段**
双内核一致（启动/retune/修订三条控制轮的句面、元数据与冷恢复键逐项对拍）。

## 6.25 第二十六步：脚本点名的模型绑定（2026-10-30）

launch.md「Models the script names」（详见 CHANGELOG-FORK §6.18）：`agent(…, { model })` 的
名字在 launch 时对着本机目录解成规范串绑定表，actor 的选型按 persona 点名查表。sidecar 抽名字
（编译器 9010 保证封闭集合）→ 新宿主 RPC `models/resolve`（`resolve_model_reference`：三档
特异性 + provider 边界 + 档位表默认档取最后一个，3 个单测）→ `run-launched.modelBindings` →
actor 选型（persona 绑定 > run 级 > 缺席；点名没绑定大声失败）。修订沿用前驱那张表同名再解析，
解不出来按 compile_failed / model_unavailable 拒绝。门禁 55 → **58 字段**（两条 run 的绑定表
逐字节一致 + 第一个 ask 真跑在被点名的模型上）。resume 的 pin 仍未接。

## 6.26 第二十七步：GetWorkflowRun 的情势截面与产物（2026-10-30）

四块缺了的读面接上（详见 CHANGELOG-FORK §6.19）：`<holes>` / `<health>` / `<phases>` /
`<subagents>` / `<artifacts>` 五个块 + 身份行（`<max_concurrency>` / `<subagent_model>` /
`<script_models>`）。数据源与 Node 同构：**一趟事件扫**（Node `indexRosterEvents` 的移植）喂
阶段时刻 / 停滞 / 结算序；节点行（非 report、不带结果）喂花名册的成败与 token；`hole-reached`
× `hole-filled` 合流出留白（waiting 只认宿主注入的开放集——进程亡故后没有 promise 在等，
单靠事件会把没人问的留白报成在等）；`kind='artifact'` 的行按「只收 completed、版本取最新、
itemCount 只数预置看板、primary 带头」归并。格式器逐字移植（行头 1 起的序号、列宽由本次的行
算出、`ahead` 行只有名字与状态、终态不带 stalled、leftover 说明、产物行与完成通知共用一个
格式器），10 个单测钉住输出。门禁 58 → **63 字段**；实形态探针（带阶段/留白/产物的停驻态
对拍）因 Node 轮调度敏感撤下，等 FillWorkflowHole 切片。

## 4. 尚未完成（Step 2 后续）

1. DWF 仍是路线 C 的灰度面（`NIBI_DWF_ENGINE_CMD` 未注入的入口按能力不支持回）；切默认前要
   先定 packaging/Host 的 env 接线与上面那段「仍未移植」的取舍。
2. `createSession` 字段逐项消费：`mcpServers`、`firstInput.mode/planEnabled`、`firstInput.attachments`
   （图片）、`additionalDirectories` 已完成；`dynamicWorkflowEnabled/Mode` 在 Rust 侧没有灰度闸
   （工具面不按它裁剪），Host 传了就忽略——切默认前按 Node 的语义补齐或写进灰度分流表。
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

## 6.27 第二十八步：控制轮的投影面（2026-10-30）

中枢启动 / 设置轮在活投影与冷投影里按 controlOnly 呈现（详见 CHANGELOG-FORK §6.20）。行形状
以 Node 的三处为准逐字段移植：`buildTurnHeaderRow`（`origin: turnHeaderOrigin(inputSource)` +
`executionKind: payload.executionKind ?? "agent"`）、product-projection 轮头/输入行上的
`workflowLaunch` 元数据、`onTurnComplete` 的 controlOnly 分支（只收口轮头不碰 session control，
`leaveDraftAfterControlOnlyTurn` 让 draft 会话推进终态——否则 sessions-index 把恒为 draft 的
中枢直接启动会话丢掉，侧栏要等重启才出现）。

- **事件面**：`KernelEvent::TurnStarted` 增 `execution_kind: Option<TurnExecutionKind>`
  （agent / controlOnly；缺席按 agent，与 Node normalizer 同读法）与 `workflow_launch:
  Option<Value>`（控制轮元数据）。`SessionView` / `LoadedSession` 增 `launches:
  Vec<SessionLaunchTurn>`（消息 id + `metadata.workflowLaunch`）——`Message::User` 不带消息
  元数据（168 处字面量的类型不能为它加字段），冷投影靠这份并行清单认控制轮。
- **session**：`write_launch` 的 TurnStarted 带 controlOnly + 元数据 + 命令 id；actor 持
  `launches`（冷加载取 `LoadedSession.launches`，`write_launch` 追加），`view()` 带出。
- **node-store**：冷读取从消息记录的 `source: "workflow_launch"` 采集（earlier + 活动段都算）；
  MemoryStore 从事实采集。测试夹具逐个补 `launches: Vec::new()`。
- **投影**：`start_turn` 增控制轮参数——轮头行 `origin`/`executionKind`/`workflowLaunch`、
  不动 phase/active/error、输入行同 origin；`finish_turn` 按 control_only 收口（无 activeMs、
  无 usage patch、phase 只在 Draft 时推进并返回是否推进）；TurnStarted/TurnFinished 的
  state 增量按 Node 的分支裁剪（控制轮起止都不发 control/usage patch，draft 推进除外）。
  冷投影从 `SessionView.launches` 按 `workflowLaunchOfMessage` 同判据重建（元数据缺席退回普通
  agent 轮）；`close_cold_turn` 识别控制轮。
- **测试**：projection_tests 3 个新钉（控制轮行形状 + draft 推进、已开始会话上不碰 control、
  冷重建控制轮 + 清单缺席回退）。
- **门禁**：`check-dwf-engine.mjs` 63 → **65 字段**。驱动给修订会话订阅会话主题，
  `buildState` 按 topic 过滤（多会话行 rowId 冲突），新增 `dwfControlRows` / `dwfControlRowShape`
  ——两内核各 3 只控制轮行、形状逐项一致。冷面用驱动冷模式的 `NIBI_DRIVE_DUMP_SNAPSHOT=1`
  转储做开发期对拍：6 只控制轮行两内核逐字段一致。
- **暴露的下一个缺口**：run 通知轮的轮头行 Node 是 `origin: "backgroundResult"`（live 同），
  Rust 活投影开成 userInput、冷投影不立轮头（通知是 `UserOrigin::Meta` 的 meta 消息，cold.rs
  不认它开轮）——通知/同伴轮的 origin 面下一片接。

## 6.28 第二十九步：后台通知轮的轮头面（2026-10-30）

后台通知开的 model-only 轮按 `origin: "backgroundResult"` 呈现（详见 CHANGELOG-FORK §6.21）。
判据以 Node 的三处为准：TurnStarted payload 的 `inputSource: "background_task"`（runtime-command
queue 的通知 drain）、`turnHeaderOrigin` 表（background_task → backgroundResult；subagent_message
落默认 userInput）、transcript-hydration 的 `getConversationModelOnlyTurnTriggerSource`
（model-only synthetic user 自己开轮）。

- **事件面**：`TurnStarted` 增 `input_source: Option<TurnInputSource>`（现只有 `background_task`）；
  通知来源标签 `TASK_NOTIFICATION_SOURCE` 升到 kernel-api（lane 与冷投影同表）。
- **session**：通知 lane 开轮按批次带标记——同伴-only 批不带（Node 表里同伴轮 origin 仍是
  userInput），其余通知批带。
- **投影**：`start_turn` 的 origin 三分；冷投影为 task-notification 的 meta 消息开
  backgroundResult 轮（无用户气泡，assistant 归本轮）。两个新投影单测。
- **门禁**：`check-dwf-engine.mjs` 65 → **66 字段**（`dwfNoticeRow` 在 escalate 阶段探升级通知轮
  的轮头；冷面用驱动 `NIBI_DRIVE_DUMP_SNAPSHOT=1` 转储对拍 escalate 会话，raise 通知轮逐字段
  一致）。
- **暴露的缺口**（下一片「DWF 的后台通知链」）：sidecar `run/settled` Rust 宿主不通知父会话；
  escalation 回答缺第二轮通知；通知无结构化 `originMeta`（run 卡关联键）；Node 写的通知记录
  Rust hydrate 整个丢掉（互认缺口）。

## 6.29 第三十步：run 的终态通知链（2026-10-30）

`run/settled` 接成父会话里的后台通知轮（详见 CHANGELOG-FORK §6.22）。对拍锚点：Node
`formatLocalWorkflowTaskNotification` 的 local_workflow 分支 + `buildWorkflowTaskSummary` +
`workflowDeliveryGuidance` + `<reports>`/`<artifacts>` 两节（`dwfNoticeText` 指纹字段逐字节
互比，837/4198312385 = 837/4198312385）。

- **sidecar**：`launchRun` 的结算链在 db 关闭前读 journal（run 行的名字/toolCallId/用量、
  `run-launched` 的脚本落点、report 条目 + 真实总数、artifact-published 记录），随
  `run/settled.notice` 上行；三条入口（submit/resume/amend）同构。
- **宿主**：`dwf_run_notification.rs` 纯函数组合器（信封 + summary + result 序列化 +
  providerStop 表驱动 `<error>` 块 + 两节预览 + 呈现指引 + 120k 截断），11 单测；run/settled
  处理器组文本经 `Kernel::workflow_notices()`（新端口）投给父会话；superseded 的终态通知按
  Node coordinator 压下。
- **门禁**：66 → **67 字段**；冷面用驱动 `NIBI_DRIVE_DUMP_SNAPSHOT=1` 对拍 escalate 会话，
  run 终态通知轮两内核同为 backgroundResult + assistantText。
- **仍缺**：通知的结构化 `originMeta`（运行卡关联键 + workflowNotification manifest 载荷）；
  Node 写的通知记录 Rust hydrate 整个丢掉（互认）。

## 6.30 第三十一步：通知记录的跨库互认（2026-10-30）

§6.21 缺口 ④（详见 CHANGELOG-FORK §6.23）：Node 写的后台通知记录 Rust 冷读整个丢掉。
判据锚点：Node `getConversationMessageProjectionPolicy` 的 providerContextOnly（两个判据面）与
`session-history-hydrator` 的 `userEntriesFromParts`（非 attachment 类 synthetic 文本进 prompt
块——`background_task`/`task_notification` 不在 system-reminder 源注册表里，不走附件路）。

- **hydrate**：`node_notice_source` 判据 + synthetic 文本保留 + `UserOrigin::Meta` 按来源拼写
  还原；Rust 自写记录（rustCli 标记路）不受影响。
- **冷投影**：`NOTICE_TURN_SOURCES` 收两个 Node 拼写。
- **夹具**：`node_written_sessions_read_back_their_text` 的 legacy_synthetic 剥离对通知族不再
  生效（当年的补偿，缺口已修）。
- **测试**：node-store 3 + 投影 1。

## 6.31 第三十二步：通知的结构化 originMeta（2026-10-30）

运行卡关联键与通知卡载荷端到端（详见 CHANGELOG-FORK §6.24）。判据锚点：Node
`buildWorkflowNotificationOriginMeta`（base 三键 + `buildWorkflowTerminalNotification` 的
manifest + `workflowNotificationDurationMs`）、`persistSyntheticUserNoticeForSession`（记录与
part 两级 `metadata.originMeta`）、`buildTurnHeaderRow`（轮头行同字段）。

- **载体**：`UserOrigin::Meta { source, origin_meta }`（Eq 从 UserOrigin/AgentNotice 摘除，全树
  零 fallout）+ `AgentNotice.origin_meta` + `WorkflowNotices::notify_with` + `TurnStarted.origin_meta`。
- **投递**：`Agents::notify_with` → hub → lane（`Waiting::origin_meta`）→ 通知轮的消息 origin
  （记录 `metadata.originMeta` 两级同写）与 TurnStarted（轮头行 `originMeta`，live/cold 同形）。
- **载荷**：run/settled 的 base 三键 + 终态 manifest（summary/result/resultForm/error/reports/
  artifacts chips/durationMs，全套界与发射侧截断）；escalation raise 带 base 三键。
- **门禁**：`dwfNoticeText` 指纹升级（文本 + originMeta，durationMs 归一）——18 字符的
  durationMs 缺口当场现形后补齐，两内核 1088/1588820788；`dwfNoticeRow` 加验 base 键。
  13 个通知单测（manifest 界、chips 白名单、截断诚实）。

## 6.32 第三十三步：escalation 的 manifest 判别分支（2026-10-30）

§6.24 的四个判别分支第一个接上（详见 CHANGELOG-FORK §6.25）。判据锚点：Node
`notifyEscalationRaised`（originMeta 组装 + `WORKFLOW_ESCALATION_TEXT_MAX_CHARS = 4_000` 的发射
侧截断 + `registry.description ?? runId` 的展示名兜底链）。

- **escalations**：store 钩子（`attach_store`，runtime 接 `ports.store`）+ `escalation_origin_meta`
  组合器（base 三键 + kind/qid/actor/question/context(≤4000)/askedAt）+ `run_label` 助手
  （`workflow_run_detail` 的标签链，question.parent 作 session 键）。
- **门禁**：67 → **68 字段**（`dwfEscalateMeta` 指纹，两内核 211/3795793529）。修掉 title 落
  runId vs registry.description 的真分歧。
- **暴露的投递缺口**：stall / hole / blocked 三类 run 中通知在 Rust 还没有投递链（journal 事件
  有、通知不发）——与 `workflows/runs` 中枢方法一起评估。

## 6.33 第三十四步：留白到达的通知链（2026-10-30）

§6.25 的三类 run 中通知第一个接上（详见 CHANGELOG-FORK §6.26）。判据锚点：Node
`notifyHoleReached`（originMeta 组装 + 快照合并的兜底链）、`formatWorkflowHoleNotification`
（信封逐字）、`writeWorkflowDraft`/`workflowDraftSlug`（工作副本）、`toProgressPayload` 的
withHoleFacts（载荷派生）。

- **sidecar**：askSpecs 的一次编译扩出留白事实表（站点表）与阶段表（控制流投影）；
  `run/event` 的 hole-reached 带完整载荷；launch 恒在场（scriptPath/phaseNames/holes）；
  中枢启动铸 workflow-drafts 工作副本（可编辑脚本文件）。
- **宿主**：`compose_hole_reached_notice`（信封 + manifest）经 notify_with 投父会话。
- **门禁**：68 → **71 字段**（`dwfHole` 探针阶段 + 两个指纹字段，双内核逐字节一致）。
- **修掉的分歧**：工作副本曾顶替启动轮 meta 的 path（Node：meta 的 path 是 saved 定义、
  run 的 scriptPath 是工作副本——两个不同物）。

## 6.34 第三十五步：FillWorkflowHole 工具面（2026-10-30）

§6.33 的尾单第一项（详见 CHANGELOG-FORK §6.27）。判据锚点：bootstrap
`dynamic-workflow-run-fill.ts` 的 fillOnce（顺序就是语义，拒绝即零副作用）、
`dynamic-workflow-run-holes.ts` 的 mapFillDiagnostics / unboundFillModelDiagnostics、
`dynamic-workflow-run-compile.ts` 的 compileProgram（fill 面裁剪）、launch.md「The fill file」
与「The draft after a fill」。

- **sidecar**：`holes`（确认前读面）与 `fill`（fillOnce 逐字）两条 RPC；同一 run 的补全串行
  （fillQueues 同规）；草稿就地改写 / 无草稿先铸（引擎拒绝时删刚铸的）；
  `launchRun` 返回类型修真（`{settlement, notice}`，三处解构不再靠 cast 瞒 tsc——这是顺手还的
  类型债，包 typecheck 在 HEAD 就有八条这类错）。
- **kernel-api + 客户端**：`WorkflowEngine::fill_target` / `fill_hole` + 镜像类型；
  `WorkflowEngineSlot`（工具注册表先建、sidecar 后接的时序缝）。
- **工具**：`FillWorkflowHole`（runtime 注册，槽取引擎）：400 恰好一个来源、`fill_unchanged`、
  fill 文件先铸、等待判定四条文案、编译失败整段回话、成功回话逐字。
- **并入也落记录（真分歧）**：门禁对拍抓到——补全后的 run/settled 常撞进工具边界，Rust 的
  mid-turn 并入只落 attachment、通知记录失踪（Node 的 drain 先 persist 批记录）。修齐：
  `Absorbed::Notice` 带 source/origin_meta，并入先落 meta user 消息（与开回合同形），不进本次
  上下文。
- **探针**：dwfHole 会话开灰度闸 + 工作区技能夹具；stub 两段式（Skill → FillWorkflowHole，
  run/hole 的 id 从通知信封的 `<run-id>`/`<hole-id>` 读）；**71 → 76 字段**：dwfHoleFill
  （422/1198194394）、dwfHoleFillFile、dwfHoleDraftRewritten、dwfHoleJournal、dwfHoleRunRow、
  dwfHoleSettled（842/3592966377）双内核逐字节一致，dwfHoleCancel 退场。
- **UI 轨尾单**：确认窗预览单槽（resolveInput 拼一次有效脚本）与技能门在路线 C 没有宿主面。

## 6.35 第三十六步：`workflows/runs` 中枢方法（2026-10-30）

§6.27 尾单的下一项（详见 CHANGELOG-FORK §6.28）：NIBI 协议中枢的第一个方法落到 Rust 内核。
判据锚点：Node `listSavedWorkflowRunsOp`（bootstrap/nibi-protocol/saved-workflows.ts）、
`listRuns` SQL（adapters dwf-journal-introspection.ts，注释里的「别在这里加天花板」同规）、
`decodeRunListItem` 的终态拆解、`savedWorkflowRunArtifacts` 的 chips 归并。

- **读面**：`list_runs_hub`（node-store）——谓词/排序/limit 全下推 SQL，limit 是「页上限 + 1」
  的截断探测语义；`settlement_of` 从 `run_detail` 提取共用；产物 chips 与 GetWorkflowRun 同一条
  归并（`artifact_rows`）。
- **端口链**：`SessionStore::workflow_runs_page` → `Kernel::workflow_runs_page`（缺省
  `Unsupported`）→ `protocol-zcode` 的 `workflows/runs` 分支（`nibi_workflows.rs`，严格 zod 镜像
  校验、journal 缺席回空页、`truncated` 判定）。
- **sidecar 行元数据（对拍真分歧 ×3）**：run 行的 `tool_call_id`/`args_json`/后继 `name` 三处
  与 Node 不同——修成 submit 带锚点、空实参缺席（hasArgs 判据）、后继沿用前驱名。resume 沿用
  行上原值（不动）。
- **门禁**：76 → **81 字段**（`dwfRuns` 阶段五字段，双内核逐字节一致；`-32602` 同码）。workspace
  ref 要求 `workspaceKey`——探针第一版漏发，Node 拒绝后钉进契约。
- **stall/blocked 仍缺**（§6.25 尾单余下两项）：stall 是「重试主导 + 20 分钟无成功」的墙钟事实
  （driver 钟的 `stallAfterMs` 缺省 20 分钟、只按重试原因上膛），blocked 是父会话空闲钟——两者
  都是时间门控的生产行为，没有可注入的阈值就没有诚实的两内核探针；等有配置旋钮或 fixture 级
  对拍再接。

## 6.36 第三十七步：resume 的模型 pin（2026-11-01）

§6.27 尾单的「resume 的 pin」（详见 CHANGELOG-FORK §6.29）。判据锚点：Node
`resumeDynamicWorkflowRun`（dynamic-workflow-run-submit.ts）——条目上的 subagentModel /
modelBindings / scriptPath / name / toolCallId 全部从 journal 重读，caps 沿行，脚本哈希先验。

- **sidecar**：`acceptResume` 补 pin 五件 + 哈希先验（`script_mismatch`）。引擎侧本来就会在
  哈希不一致时同步抛错；先验把「记录仍可修复」这个事实留在结构化拒绝里。
- **探针**：`dwfResumePin` 阶段（修订出后继 → 取消 → resume → 恢复出的 ask 仍在 pin 模型上）。
  探针三坑记档：计数快照先于 resume 命令；actor 请求按工具表判别（正文被 400 字符截断挤出）；
  waitRow 盯后继的行。
- **门禁**：81 → **88 字段**，双内核逐字节一致。
- **仍缺**：amend+resume 的导入缓存重建（性能缺口，非正确性）；stall/blocked（时间门控）。

## 6.37 第三十八步：打包轨第一段——内核进打包资源（2026-11-01）

尾单的打包轨开工（详见 CHANGELOG-FORK §6.30）。桌面灰度的分发拍板 B（sidecar 用 Electron
自带 Node，不额外打包 Node 二进制）在这一段补上最后一环：内核二进制随包。

- **prepare:rust-kernel**：可选资产暂存（`NIBI_RUST_KERNEL_BIN` → release → debug；全缺跳过
  退出 0）——正式包不携带内核也要能跑，这是「Rust 只允许灰度/可选」纪律在分发面的形状。
- **electron-builder**：extraResources 条件收进 `<resources>/rust-kernel`（存在性判定在配置
  构建期，正/负路径都验过）；afterPack 断言；签名断言不覆盖（灰度期无证书，只在
  `NIBI_KERNEL=rust` 时被拉起）。
- **ELECTRON_RUN_AS_NODE 复核（Electron 41.0.3）**：electron.exe 以 AS_NODE 跑
  `__nibi-dwf-engine`——probe-dwf-sidecar 全握手通过。FIX-5（Electron 44）合入后必须重跑。
- **三消费者回归**：主代理 spawn / 存储准备子进程 / DWF 侧车 env 的单测在本机被 vitest runner
  `validateTags` 崩溃挡住（stash 对拍 HEAD 同败，预存环境问题）；根 typecheck（services +
  desktop main/renderer/preload）与 88 字段 DWF 门禁兜住。

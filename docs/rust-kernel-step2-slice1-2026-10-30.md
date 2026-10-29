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

## 4. 尚未完成（Step 2 后续）

1. 其余 20 个命令的处理器（queue 编辑组/goal/hook-review/workflow*/deleteSession 等）——
   契约已收口，行为按 Rust 规划 §5.2.1 的行逐个补，每补一组跑 Node/Rust 对照。
2. `createSession` 字段逐项消费（消掉 `CREATE_SESSION_FIELDS_NOT_YET_CONSUMED`）。
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

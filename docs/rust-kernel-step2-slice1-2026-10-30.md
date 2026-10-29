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

## 4. 尚未完成（Step 2 后续）

1. 其余 25 个命令的处理器（fork/retry/rewind/queue/goal/hook-review/workflow*/deleteSession 等）——
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

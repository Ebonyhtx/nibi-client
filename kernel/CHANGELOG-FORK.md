# NIBI 内核 fork 日志

> 纪律来源：《NIBI-Rust内核改造调研与规划》§4.7（五条纪律）与《NIBI-大改造与安全修复与品牌化执行计划》Step 5。
> 本文件随 `kernel/` 一起维护；每次重 pin、吸收/拒绝上游变更、新增 NIBI 自有迁移、复跑安全门禁都要追加记录。

## 1. Vendoring 基线

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/MBearo/ZCode-rs` |
| 参考克隆 | `D:\ZCODE-RUST\ZCode-rs`（工作树 detached） |
| pin commit | `6d349ed4c4cf31e05079056c08e6bea495544116`（0.1.67，build 67） |
| npm 发布 | `@mbearo/zcode@0.1.67`，2026-10-29T13:11:41Z |
| 主包 integrity | `sha512-oxCElsqdr+tUUTtMpUdHndKxmqy5+zXIjrII65ZMC6LXVk+ABVuyyd7OFZeS4IMoBDqJEb1kjgHGk46PRR4D9A==`（本地 npm pack 逐字节校验通过） |
| win32-x64 平台包 integrity | `sha512-q9MJce7y0DerO2C6qmhv5TFK1JQ+iRcbwvuXIDhkfUPTyjexsSsRdukj27B0B6Kr6RGLDcoGNCoXu+n40H5y2A==`（通过） |
| 平台包 `build.json` | `version=0.1.67`、`sourceCommit=6d349ed4…`、`target=x86_64-pc-windows-msvc`、`sha256=5f4e8880…`；`zcode.exe --version` = `0.1.67 (rust-cli)` |
| subtree 来源 | upstream 仓内 `git subtree split --prefix=packages/rust-cli 6d349ed4`，split 分支 `nibi-kernel-vendor` = `e0965b46b36c0470f1633ec54f70a7ab0dc421ab` |
| vendored 路径 | `NIBI-Client/kernel/`（workspace 根 = 上游 `packages/rust-cli`） |
| 许可证 | Apache-2.0；`kernel/LICENSE`、`kernel/NOTICE.md` 自上游仓库根复制；`kernel/vendor/THIRD-PARTY-NOTICES.txt` 随子树传递 |

## 2. vendored 二进制台账

来自上游 `vendor/THIRD-PARTY-NOTICES.txt`（随子树保留）：

| 组件 | 版本 |
|---|---|
| ripgrep (rg) | 15.2.0 |
| bfs | 4.1.4 |
| ugrep | 7.8.4 |

## 3. 安全门禁（FIX-10b）

| 项 | 状态 | 证据 |
|---|---|---|
| `webpki-root-certs` 下限 ≥1.0.11 | **已抬到 1.0.11** | `cargo update -p webpki-root-certs --precise 1.0.11`；`Cargo.lock:3879-3881`；`cargo tree -i webpki-root-certs --locked` 显示 1.0.11 |
| `rustls-webpki`（RUSTSEC-2026-0382） | **0.103.15 → 0.103.16** | 该版本拒收含已泄露 emSign 中间公钥的证书路径；比根证书包更靠内的一层 |
| `pulldown-cmark`（RUSTSEC-2026-0381 系列） | **0.13.4 → 0.13.5** | wikilink 解析漏洞；仅 TUI 依赖 |
| `libz-sys`（RUSTSEC-2026-0403） | **1.1.30 → 1.1.31** | 构建期环境变量探测；仅 vendored ugrep |
| `deny.toml` 落库 | **已落库** | `kernel/deny.toml` |
| `cargo deny check` | **全绿**（advisories/bans/licenses/sources ok） | 2026-10-29 实跑；`pulldown-cmark` 0.13.4→0.13.5、`rustls-webpki` 0.103.15→0.103.16、`libz-sys` 1.1.30→1.1.31；`bincode` unmaintained（RUSTSEC-2025-0141）按 TUI-only 豁免并登记在 `deny.toml` |
| `cargo audit` | **0 漏洞**（1 allowed warning：bincode unmaintained） | `cargo audit` 2026-10-29 实跑，扫描 415 个依赖 |

> 上游 0.1.67 基线为 1.0.9（2026-07-18，早于 eMudhra 事件），且 `crates/net/src/egress.rs` 使用 `Anchors::Merge` 合并平台信任库；不抬版本会把已撤根的旧锚重新信任回来。

## 3.1 会话库互认实测（2026-10-29）

- Rust `node-store` 冷开 NIBI Node 内核现场生成的隔离库：`cargo test -p rust-cli-node-store --test nibi_interop` 通过（列出并 `load` 了 Node 会话；账本冷开前后不变）。
- `0020–0024` 三方逐字节比对：Node `SQLITE_MIGRATIONS` / Rust `00NN_*.sql` / 库内 `schema_migration.checksum` 全部一致（`scripts/kernel-baseline/compare-migration-sql.ts`）。
- `cargo check --locked --workspace` 全绿（首次 61s，共享 target 增量）。

## 4. NIBI 自有迁移

当前 **无**。会话库迁移账本保持上游 `0001–0024`；建设期不新增 `0025+`（Rust 规划 §4.7 纪律 3）。若未来新增，必须在本节登记 id、SQL 摘要、checksum 与 Node 侧同步情况。

## 5. 上游变更吸收/拒绝记录

| 日期 | 上游变更 | 处置 | 理由 |
|---|---|---|---|
| 2026-10-29 | 0.1.66 → 0.1.67（130 文件 +8,605/−1,300） | 整体 pin；未逐项改造 | npm 产物可验证、编译全绿；协议/迁移/目标表/信任根/审计门禁零变化；F111–F114 是 NIBI 要继承的消费域修复 |
| 2026-10-30 | `schema/inbound.json` 的 commands/CAS 段与 `workspace/updateOffPeakToolPolicy` 方法；`server.rs` 的 offPeak 处理器 | **删除** | NIBI 已删 offPeak；命令契约改由 `nibi_commands`（NIBI zod 生成物）承接，上游 35 个命令（含 NIBI 不存在的 `setHighspeedMetrics`）不再进入校验路径 |

## 6. Step 2 第一切片（2026-10-30）

- NIBI 34 个 `CommandType` 契约进入协议前端：`schema/nibi-commands.json`（由 NIBI zod 生成，
  `scripts/kernel-baseline/generate-nibi-command-schema.ts --check` 守漂移）+ `src/nibi_commands.rs`。
- 上游 `schema/inbound.json` 删除整段 `commands`/CAS 与 `workspace/updateOffPeakToolPolicy` 方法；
  `server.rs` 删除 offPeak 处理器；`inbound.rs::command` 委托 NIBI 契约；`commands.rs::create_session`
  对内核未消费字段点名 `warn`（R12/R23 防静默丢失）。详见 `docs/rust-kernel-step2-slice1-2026-10-30.md`。
- 验证：protocol-zcode 25 测试（7 个契约测试）、clippy -D warnings、rust 1.95.0 MSRV、
  workspace check / nibi-platform / 互认 / deny / audit 全绿。
- 同日追加 4 个处理器：`switchModelConfig`（CAS→SetModel）、`switchCollaborationMode`
  （CAS→SetMode/SetPlan）、`compact`（→Compact）、`renameSession`（→Rename）；CAS 抽成
  `cas_check`（stale→`proto.staleRevision`），set_followup 同步改用。测试 25→28。
- 第三小批：`cancelBackgroundWork`（→StopTask；kernel 拒绝文案按关键词归到
  `fault.command.backgroundWorkCancelRejected.<code>`，`unknown` 兜底，TODO 等 kernel
  回执带机器可读 reason）；`createSession.config` 的扁平 provider/model/thought 作
  选择回落，未消费清单 11→6 项。测试仍 28。
- 第四小批：epoch CAS（`cas_check_with_epoch`，`proto.staleLogEpoch` 与 Node 同词）；
  `forkAssistant`（→`Command::Fork`，ACK result 带 `{type, sessionId}`）与
  `applyFileRewind`（→`Command::Rewind{scope: Code}`）两个 row-targeting 处理器，
  target 经 projection 行解析（entityId 匹配 + assistantResponseId 结算检查）。
  `Envelope` 补 `baseLogEpoch`；测试 28→29。
- 第五小批：`retryTurn`（rewind 截断该轮 + 重发原文；`guard.latestAssistantRetryOnly`
  只许最后一轮；原文 rewind 前解析）。测试 29→30。
- 第六小批：`editUserQuery`（real user 行解析 + `guard.latestQueryEditOnly` +
  workspaceMode preserve/rewind → `Rewind{Conversation|Both}` + 重发 newText；附件
  回放未实现，payload 带附件 fail-closed 拒绝；quotes 暂 warn）。测试 30→31。
- 第七步：无头驱动真二进制全链路通（startup→createSession→subscribe→sendText→帧流→
  fork→retry→compact；`scripts/kernel-baseline/drive-rust-app-server.mjs`）。实证：
  幂等表同 commandId 重试回 stale 的 duplicate（UI 重试必须新 id）、
  `guard.latestAssistantRetryOnly` 与 Node 同判、主题前缀 `conversation/`、subscribe
  必带 clientMode、帧 payload 在 wire 帧的 `.frame.payload`。
- 第八步：driver 扩成全 14 命令回归套件（9 正路径 + 2 拒绝路径 + editUserQuery 正路径）。
  发现并修复 kernel rewind 同步路径（`RewindScope::Conversation`）缺 `start_next()` 的
  队列排水缺口（`crates/session/src/rewind.rs`）；异步路径 `finish_rewind` 已有。
- 第九步：双内核对拍（同一 driver 跑 Node/Rust）——12/13 检查点一致。顺带修：会话 ID
  生成（`sess_<uuid>`，让 kernel Ids 生成）、noop 词表（switchModelConfig 同值
  `config.unchanged`；switchCollaborationMode 同值仍 accepted；setFollowupMode 无同值
  noop）、cancelBackgroundWork 拒绝（failed + `...CancelRejected.not_found`）。
  唯一有意差异：editUserQuery 附件回放（Rust fail-closed，Node 支持）。
- ~~**开放 kernel 问题**：editUserQuery 的 rewind→queued Submit 链路~~ **已闭合**：
  ① rewind 同步路径 `start_next()`（本文件上文）；② projection 消费 `HistoryRewritten`
  （清行 + `row.removed` delta）；③ retryTurn 改为 transcript 驱动。全链路
  editUserQuery→retryTurn→compact **全部 accepted**。遗留：plan 模式下 edit 的
  resubmit turn 失败（非关键路径，记录在案）。

## 6.1 会话级 MCP（NIBI `createSession.mcpServers`，2026-10-30）

R12：Host 在建会话时把完整 MCP 配置随 `mcpServers` 送进来（用户设置里启用的 MCP、插件 MCP、
动态解析的产品服务器如 CUA broker / 云端项目）。上游/本轮之前的实现只读进程级配置，
这批服务器会**静默消失**。

实现（与 Node 的 pool + lease 同语义：连接在会话上，工具按会话可见）：

- `kernel-api` 新增 `mcp_session::SessionMcpServer`（name / transport / alwaysLoad / timeoutMs /
  isolation，camelCase 与协议同名）与 `Kernel::start_session_mcp` / `Kernel::stop_session_mcp`；
  `ToolRegistry` 新增 `find_for(session, name)`、`mcp_for(session)`、`session_mcp(session)`，
  缺省都退回进程级方法（TUI / `-p` 行为不变）。
- `ext` 新增 `SessionMcp`：**每个会话一个 `McpManager`**（同一传输/任务/时钟），
  `Ext::start_session_mcp` 注册并后台连接，`Ext::release_session` 取消连接任务、关闭客户端；
  `ExtRegistry` 按会话给 `snapshot` / `find_for` / `mcp_for` / `session_mcp`，
  带了自己的服务器的会话工具表**就是这批**（与 Node 的 `runtimeConfig.mcp` 相同，不混进程级配置）。
- `query`：执行器与 MCP 等待改用 `find_for(scope.session, …)`；会话级 MCP 在**首个模型请求前**
  有界等待（15 s）离开 Pending，与 Node 的 `startMcpStartup` 同义（此前 Rust 首轮请求会缺 MCP 工具）。
- `runtime`：`LocalKernel::start_session_mcp/stop_session_mcp` 接线；`Closer::released` 释放会话级连接。
- 包装注册表（`AgentRegistry` / `FilteredTools` / `PolicyFiltered`）逐层转交新方法——漏一层就会
  退回进程级查找（本轮在联调里实际踩到：工具在工具表里但调用找不到）。

**有意差异（记录在案）**：
1. `isolation: "workspace"` 的值被接受但**仍按会话建连接**（Node 会跨会话共享一条连接）。
   功能语义相同（工具可见性一致），只是进程数与连接数更高；等 Step 2 后续再做成共享池。
2. 冷恢复（v4 subscribe 触发的 `resumePersistedSession`）**不带** `mcpServers`（Node 侧同样不带）：
   恢复出来的会话没有 MCP，直到 Host 重新建会话。这是 Host 契约的现状，不是内核差异。
3. `alwaysLoad` 已进选项（影响 ToolSearch 的延迟规则）；会话级 MCP 的首请求等待固定 15 s、
   不读 `-p` 的 prewait 配置（app-server 没有 `-p`）。
4. 子代理会话**继承**父会话的连接（同日补）：`ToolRegistry::inherit_session_mcp(parent, child)`
   在 `agents::spawn::create` 里调用；`SessionMcp` 的条目分 owned/borrowed，子会话关闭只移掉借用
   条目、不关父会话的连接。Node 的子代理 app 继承父 `config.mcp`，工具可见性由此对齐。
5. `oauth` 与 `protocolVersion` 尚未实现（与 ext 的 node_config 同一现状）：`create_session`
   对携带这两项条目的会话点名 `warn`（`protocol.create_session.mcp_servers_unsupported_options`），
   不静默丢；OAuth 保护的服务会连成 Failed，等 MCP OAuth 支持补上。

验证：ext 3 个新测试（每会话独立连接 / 再给一次换掉旧集合 / 协议→配置映射）、kernel-api 2 个
（序列化往返）、protocol-zcode 3 个（stdio/http/sse 映射、未知形态跳过、firstInput 执行状态优先级）；
双内核驱动新增 `fake-mcp-server.mjs`（stdio MCP），两边内核在首轮请求即带 `mcp__fake__echo`、
模型调用后拿到 `echo:ping`；对拍门禁 13→**17** 个必需字段全一致。

## 6.2 会话附件回放（图片，2026-10-30）

Host 在 `sendText` / `createSession.firstInput` / `editUserQuery` 里给的是 `AttachmentRef` 引用
（`zcode-artifact://<session>/<artifact>` 或本机绝对路径），不是内容。此前 Rust 协议前端把附件当
不支持的字段（createSession 点名 warn、editUserQuery fail-closed 拒绝），图片内容会丢。

实现：

- `kernel-api::attachment`：`AttachmentSource`（Artifact/本机路径）与 `LoadedAttachment`；
  `Kernel::load_attachment(session, workspace, source)`（缺省 Unsupported）。
- `runtime::attachment`：artifact URI → `ArtifactStore::find` + `get`（Rust 的 node-store 与 Node 的
  `NodeToolArtifactStore` 同目录同命名，Host chunk 上传的 `data:<mime>;base64,…` 从这里解开）；
  路径 → 会话机器 `Files::read_file`；跨会话的 artifact 引用直接拒绝；20 MiB 上限。
- `protocol-zcode`：命令里的附件 → `ContentBlock::Image`（base64 内联，图片在正文之前，Node
  `buildUserContentFromTurn` 的排法）；只有图片能进 Rust 的 user 消息内容块，PDF / 视频 / 文本材料
  **fail-closed** 拒绝（`fault.command.attachmentUnsupported`），读不出来回
  `fault.command.attachmentUnreadable`——不静默丢内容。三条命令都走同一条写路径：
  `sendText`、`createSession.firstInput`、`editUserQuery`（含 attachment-only 改写）；
  `retryTurn` 重放原消息的内容块（图片跟着回来）。
- 行投影：`InputMeta.attachments` 让 `userInput` 行带原始 `AttachmentRef`（UI 预览入口）。

**已知差异（记录在案）**：
1. 模型侧渲染：本地路径图片，Rust 读文件并内联进请求；Node 在 OpenAI-compatible 的本地路径分支
   降级成 `[Attached <mime>: <path>]` 文本（artifact URI 形态才回读 data URL）。Rust 是"多做了"，
   不是少做；模型是否收到图片还取决于 `inputFormat.supportsImage`（两边同一套降级规则）。
2. PDF / 视频 / 文本材料附件仍不支持（Rust 的 user 消息内容块只有 Text 与 Image）；拒绝是显式的。
3. 冷恢复后 `userInput.attachments` 与其它 `InputMeta` 字段一样只在活会话里有（P1 现状）。

验证：runtime 4 个单测（data URL 解码、原样字节、artifact URI 解析与百分号转义、超限拒绝）；
protocol-zcode 36 测试（新增图片引用映射、非图片拒绝、内容块顺序）；双内核驱动用真实 1×1 PNG：
两边 ACK accepted、`userInput` 行带 1 条引用，对拍门禁 17 → **20** 个必需字段全一致。

## 6.3 会话附加工作目录（`createSession.additionalDirectories`，2026-10-30）

Host 把用户在工作区之外添加的目录随建会话送进来。此前 Rust 只认进程级 `--add-dir`，这些目录
既不进提示词、也不进判决链的允许范围——读工作区外的文件会逐次询问（yolo 之外）。

实现：

- `kernel-api::session_paths::SessionDirectories`：会话 → 目录表（`set/get/inherit/release`），
  `Kernel::set_session_directories`（缺省 Unsupported）。
- `policy`：`PolicyGate::with_session_directories`，`path_context` 把会话的目录接进 `roots`
  （与本机 `--add-dir` 同规则；远端机器仍只带自己的工作目录）。
- `context`：`PromptAssembler::with_session_directories`，`shown_facts` 把会话目录并进
  `EnvFacts.additional_directories`，环境段照常列出（`Additional working directories`）。
- `agents`：`AgentsPorts.directories` + `create()` 里的 `inherit_session_directories`，子代理继承
  父会话的附加目录（Node 的子代理 app 继承同一份配置）。
- `runtime`：一份句柄同时给判决链、上下文与 `Closer`（会话关闭释放）；`protocol-zcode` 的
  `createSession` 调 `set_session_directories`，空列表等于没有。

**冷恢复（同日补）**：Host 的 `conversation/subscribe` 参数带 `additionalDirectories` 与
`resumeThoughtLevel`（Node 的冷恢复 `resumePersistedSession` 消费它们）。Rust 的 subscribe 现在在
**冷打开**（内存表里还没有这个会话）时应用这两个提示：`set_session_directories` + 与持久化选择不同
时发一次 `SetModel`（live 订阅不消费，与 schema 注释一致）。两段式门禁
`scripts/kernel-baseline/check-cold-resume.mjs`：先正常建会话，再用新进程订阅持久化会话并发送输入，
两个内核都必须产生新的模型请求且环境段含恢复时新加的目录。

**已知差异（剩）**：冷恢复不带 `mcpServers`（Host 的 subscribe 参数里没有它，Node 同样拿不到——
这是 Host 契约的现状）；进程在回合中途被杀后，DB 里留下未结束的回合，冷打开后新的输入会排队不跑
（两个内核同样如此；真机上是 Host 进程回收的时机问题，harness 必须先干净收尾再冷恢复）。

验证：kernel-api 1 个新单测（set/get/inherit/release）；policy 1 个（按会话放行、跨会话隔离、
子代理继承、远端不带、释放后回到询问）；双内核驱动在隔离 home 里建 `extra-workspace`，两边首轮
请求的环境段都含该路径；对拍门禁 20 → **21** 个必需字段全一致。

## 6.4 队列命令组（NIBI queue 五件，2026-10-30）

Node 的 queue 组（`editQueueItem` / `deleteQueueItem` / `reorderQueueItem` / `setAutoDrain` /
`sendQueuedNow`）此前落到 `unsupported`。内核只有"入队 + 回合结束排水"，没有改/删/重排/立即发送。

实现（kernel-api `Command` 新增五个变体，session actor 在 `queue.rs` 里处理）：

- `EditQueued`：同 id 原地更新正文（bash 项改命令原文，内容块输入改文字块、纯图片输入补一条）；
- `DeleteQueued`：从队列、通道与种类表移除；
- `ReorderQueued`：移到 `before` 之前（None = 队尾）；通道里 `Lane::Input` 的相对顺序跟着队列走；
- `SetAutoDrain`：关掉后回合结束不再自动开队首（通知与定时任务照常）；打开且空闲时立刻开队首；
  命令处理完之后 actor 看一眼"空闲 + 有排队项"（`settle_queue`），补住"开关与回合收尾擦肩而过"的竞态；
- `SendQueuedNow`：从队列取出该项；忙时记为 `promote` 并中止当前回合，收尾的 `start_next` 先开它
  （保留 bash/内容块/普通文字三种形态与 UPS 筛查结果）；空闲时直接开。

协议层：`queueItemId` 是投影里的 `queue_<commandId>`，处理器剥前缀交给内核。**未命中语义对齐 Node**：
`deleteQueueItem` → noop `queue.itemMissing`；`editQueueItem` / `reorderQueueItem` → 记 warn 按成功
收口（并发 drain 的竞态）；`sendQueuedNow` → failed `fault.command.executionFailed`。

**验证**：session 3 个新测试（编辑/重排/删除 + 未命中拒绝、autoDrain 关掉后不计开回合且打开后立刻
排空、`sendQueuedNow` 抢占后开提升项且原文进模型请求）；双内核驱动加队列阶段（真实挂起一轮 → 排两条
→ 编辑/重排/删除/关自动排空 → 放行 → 提升）；对拍门禁 21 → **30** 个必需字段全一致。

## 6.5 反馈与询问 snooze（2026-10-30）

- `setAssistantFeedback`：row-targeting（rowId + entityId 必须是 `assistantText` 行、有已结算的
  `assistantResponseId`）→ 反馈落成前端记录（`assistant_feedback`，key 是 assistant 消息 id，
  `{"feedback": "like"|"dislike"|null}`，store 不支持时 failed
  `fault.command.assistantFeedbackUnsupported`）→ 活投影原地更新那一行（`row.upserted`）。
  **冷恢复后行上的徽标暂不重建**（与 `InputMeta` 的其它字段同一现状；记录已落库，后续补投影 hydration）。
- `snoozeInteractionAutoResolution`：内核不调度自动结束的倒计时（`askUserQuestionAutoResolutionEnabled`
  只记录偏好），命令按幂等 noop 接受并记日志——与 Node 在"没有进行中的倒计时"时的行为一致。

验证：projection 新单测（点赞/取消/同值不发增量/行未落定）；双内核驱动两边
`setAssistantFeedback` 与 `snoozeInteractionAutoResolution` 都 accepted；对拍门禁 30 → **32**。

## 6.6 goal 三件（2026-10-30）

- `sendGoalCommand`：归一 `/goal`、`/target` 前缀与开头的 `replace`（Node 的
  `parseGoalObjectiveFromCommandText`），plan 模式与目标互斥（`guard.planGoalMutuallyExclusive`），空目标
  `fault.command.goalRejected.emptyObjective`；然后按一次人类输入提交 `/goal <objective>`——内核的
  `goal_inputs` 写 sentinel + 命令消息 + 说明并开回合，与 Node 的"设置目标并开始推进"同义。
- `pauseGoal` / `resumeGoal`（`Command::SetGoalPaused`）：目标保存、只改暂停位；暂停时
  `Goals::condition()` 不给条件（回合结束不按它续跑）并中止正在跑的回合；恢复只是重新武装。
  持久化：`GoalStatus` 新增 `paused` 与 `marker`（标记不是评估，不计 iterations），冷恢复读最后一条
  状态时恢复暂停位。没有目标时幂等成功（`{active:false, paused:false}`）。
- **有意差异**：`resumeGoal` 不主动起"续跑回合"——Rust 的续跑由回合结束的 stop-hook 判定驱动
  （`condition()` 有值才评），Node 的 resume 会立刻起一个后台 continue 回合。等 goal 后台续跑
  （`continueActiveTarget` 等价物）落地后再对齐。

验证：session 新单测（暂停隐藏条件、标记不计数、冷恢复保留暂停、无目标幂等）；双内核驱动两边
`sendGoalCommand`/`pauseGoal`/`resumeGoal` 都 accepted；对拍门禁 32 → **35**。

## 6.7 侧聊会话（`createSelectionSideSession`，2026-10-30）

Node 从当前对话派生一个"侧聊"子会话（复制整段对话、选择可覆盖、可选带首条输入），用于就同一段
上下文换模型/换话题再问。

实现：`Command::CreateSelectionSideSession { selection? }` → session 用 `SessionStore::fork` 复制到
最近一条消息（选择默认继承当前，`firstInput.modelSelection` 覆盖）；协议层随后在新会话里提交
`firstInput.text` 并返回 `{type, sessionId}`。

**有意差异**：
1. 忙时拒绝（`guard.sideSessionRejected`）——Node 会切到当前回合起点，Rust 先要求空闲；
2. 空对话拒绝（`SessionFork.through` 必须是一条消息）；
3. 未复制 Node 的 `selection_side_chat` 子会话类型与 `sourceCommandId` 记录（Rust 的会话 kind 只有
   Interactive/Subagent；侧聊按普通子会话落库）。

验证：双内核驱动两边 accepted、child 前缀 `sess_`、child 与父不同；对拍门禁 35 → **38**。

## 6.8 命令覆盖表与能力缺口（2026-10-30，§6.10/§6.11 又补 5 条）

34 个 `CommandType` 现在**全部有归属**：31 个已接住（`HANDLED_COMMANDS`），3 个明确列在
`BLOCKED_COMMANDS` 并写明缺的能力；`every_command_is_either_handled_or_explicitly_blocked` 守住
"不漏项、不重叠、理由非空"。`unsupported` 的 ACK 也会把缺的能力一起说出来（`proto.unsupportedCommand`
的 message），切默认前能一眼看出是功能缺口而不是没接线。

| 命令 | 状态 | 缺的能力 |
|---|---|---|
| `createSession` `sendText` `stop` `resolveInteraction` `setFollowupMode` `switchModelConfig` `switchCollaborationMode` `compact` `renameSession` `cancelBackgroundWork` `forkAssistant` `applyFileRewind` `retryTurn` `editUserQuery` `deleteSession` | 已接住 | — |
| `editQueueItem` `deleteQueueItem` `reorderQueueItem` `setAutoDrain` `sendQueuedNow` | 已接住 | — |
| `setAssistantFeedback` `snoozeInteractionAutoResolution` | 已接住 | — |
| `sendGoalCommand` `pauseGoal` `resumeGoal` | 已接住 | —（resume 不主动起续跑回合，见 §6.6） |
| `createSelectionSideSession` | 已接住 | —（忙时拒绝等三条差异，见 §6.7） |
| `requestWorkspaceHookReview` `respondWorkspaceHookReview` `toggleWorkspaceHookReviewItem` `revokeWorkspaceHookTrust` | **已接住**（§6.10） | —（企业策略阻断没有来源，`blocked_policy` 恒 false） |
| `startSavedWorkflow` `resumeWorkflowRun` `amendWorkflowRunSettings` | **能力缺口** | 动态工作流 run 能力（与 `createSession.dynamicWorkflow*` 同一缺口） |
| `discardSharedContext` | **已接住**（§6.11） | —（导入本身仍由 Node 的 server-operations 完成） |

这 3 项在功能 track 完成、或明确决定"首期走 Node"之前，**阻塞切默认**（合并计划 §8.1.1 的判据）。

## 6.9 项目级配置目录改为 `.nibi`（2026-10-30，品牌化轨）

**问题**：内核的 `dot_dir!()` 是 `.zcode`，项目级配置因此读 `<工作区>/.zcode/config.json`；而 NIBI 的
Node CLI / App / 协议前端读 `<工作区>/.nibi/config.json`。同一份项目配置两边看见的不是同一个文件
（钩子、权限规则、MCP、插件配置都走这套发现）。实测：`zcode.json` 的 5 组 fixture 变体两边
bundleDigest 全一致，只有加 `.zcode/config.json` 或 `.nibi/config.json` 时才分叉。

**改动**（独立提交、可整体 revert；不动 `DOT_DIR` 与存储/用户根）：
- `rust_cli_base::names::PROJECT_DOT_DIR = ".nibi"`；
- `crates/cli/src/config/files.rs`：项目文件发现、`editable` 判定、digest 的 `configFileKind`
  都用 `.nibi/config.json`（与 Node `WorkspaceHookConfigFileKind` 同字面）；
- 重算 `crates/cli/tests/fixtures/workspace-hooks-golden.json`（4 个用例）并同步 fixture 路径。

**验证**：两个 CLI 对同一 fixture —— `zcode.json` only MATCH、`+ .nibi/config.json` **MATCH**（改前 DIFF）、
`+ 旧 .zcode/config.json` MATCH（两边都忽略，改前 Rust 会读）；`cargo test -p rust-cli` 失败集合与改动前
完全一致（9 个环境相关既有失败，无新增）；clippy `-D warnings`、`cargo check --workspace` 全绿。

## 6.10 工作区钩子评审四件（2026-10-30）

四条命令全部接住（`requestWorkspaceHookReview` / `respondWorkspaceHookReview` /
`toggleWorkspaceHookReviewItem` / `revokeWorkspaceHookTrust`），34 条覆盖表变成 30 接住 / 4 能力缺口。

**内核侧**
- `kernel-api::hook_review`：快照形状（`WorkspaceHookReview` + `sources` + 逐条 `WorkspaceHookItem`，
  字段名对齐 NIBI 的 strict schema：`type`、`executionMode`、`displayName` = 「事件 · matcher」；
  写信任记录用的序号 `#[serde(skip)]`）与信任端口 `HookTrust`（`load`/`grant`/`revoke`）。
- `hooks::hook_review`：纯函数 `review`（判定顺序 策略 > 库损坏 > 无项 > 全信任 > 待审）、
  `admitted`/`admitted_for`（信任变化后重建项目层 hooks 快照）。
- `platform::hook_trust`：`impl HookTrust for HookTrustStore`；`grantedAt` 用
  `rust_cli_base::js::date::iso_timestamp`，字段与 Node 的 `workspaceHookTrustRecordSchema` 同形。
- `runtime`：`LocalKernel::with_hook_review(user_hooks, trust)` 注入端口（TUI / `-p` 不接，保持
  `Unsupported`）；四个方法 + **授权 / 撤销 / 开关当场生效**——`HookEngine::replace_project` 只换
  `HookSource::Project` 层，用户层、命令行层与插件 hooks 不动（Node 的 admission refresh 同义）。

**协议侧**（`protocol-zcode::hook_review`）
- 评审流：`reviewFlowId` 每会话一份、`generation` 单调 +1、每代一个 `interactionId`；命令 target 与
  当前代不符 → `workspace_hooks_review_superseded`，与快照不符 → `workspace_hooks_snapshot_mismatch`；
  截止 10 分钟（`WORKSPACE_HOOK_REVIEW_TIMEOUT_MS`），计时任务到期撤交互。
- 评审请求投成 **pending 交互**（`payload.kind === "workspaceHookReview"`，17 个字段的 strict 形状），
  与 Node 的 `onWorkspaceHookReviewRequested` 一致；`workspaceHookAdmission`
  （`pendingCount` = 启用且待审）在会话第一次打开时上报，评审 / 授权 / 开关 / 撤销后刷新。
- `toggleWorkspaceHookReviewItem` 只改 `<工作区根>/.nibi/config.json` 里那一条的 `enabled`：写前用刚
  读到的文件重新解析并校对声明（命令与 matcher），写完整份 JSON（`preserve_order` + 两空格缩进 +
  换行，与 Node 的 `JSON.stringify(value, null, 2)` 同形）。

**验证**
- 驱动新增 `hookReview` 阶段并进默认阶段表：订阅时的提示条 → 请求评审 → 交互 payload 断言 → 就地
  关/开（配置落盘 + 换代）→ 授权（信任记录落盘、提示条清空）→ 按摘要撤销（提示条回来）。
- `check-dual-kernel-parity`：**63 个必需字段全一致**（原 38 + 25）；`hookTrustRecordDigest` 两边同为
  `68ad4faa`（声明摘要逐字节一致），`hookReviewSourcePath` 两边同为 `.nibi\config.json`。
- `check-cold-resume` 仍 OK；`cargo test -p rust-cli-kernel-api/-hooks/-runtime/-protocol-zcode` 全绿；
  `cargo test -p rust-cli` 失败集合与基线一致（9 个环境相关既有失败）。

**已知边界**
- 企业策略（Node 的 `workspaceHookPolicy`）没有来源：`blocked_policy` 恒 false。
- 评审交互的 `taskId`/`runId` 用会话 ID（Host 原样回传，只做 target 匹配）。
- 被替换的那一代只撤交互，不发 Node 的 `WorkspaceHookReviewSuperseded` 事件（Rust 投影按
  `pendingInteractions` 替换收口）；截止到期同理，不回报 `timed_out`。

## 6.11 分享导入的丢弃（`discardSharedContext`，2026-10-30）

**形状**（已读 Node 源码，不猜）：导入是 Node `server-operations` 写的一条 `session_entry`
（`type = "v4/shared_context_import"`，`data` 带 `shareId`/`shareUrl`/`contextId`/`status`）。
`discardSharedContext` 只做一件事：`transitionSharedContextImport` 把 `status` 从 `pending` 改成
`discarded`（其它状态一律拒绝，Node 报 `fault.command.inputRejected` 且 ACK 是 `failed`），
并把会话快照的 `sharedContextImport` 重新种成 `discarded`。不新增迁移：读写的都是既有的
`session_entry`（经 `SessionStore::records`/`put_record` 的前端记录端口）。

**内核侧**
- `kernel-api::shared_context::SharedContextImportState`（`contextId`/`title`/`shareUrl`/`status`）。
- `Kernel::shared_context_import`（冷打开的种子；没有导入时 None）与
  `Kernel::discard_shared_context`（`pending` → `discarded`，返回更新后的状态）。
- `runtime::shared_context`：从 `v4/shared_context_import` 记录读出（Node `entries.find` 的第一条），
  标题取会话 meta；丢弃只改 `status`，其余 provenance 原样保留。

**协议侧**
- 冷打开会话时把 `sharedContextImport` 种进投影（Node 的 `seedSharedContextImport`，不发增量）。
- `discardSharedContext` 处理：成功时把新状态写成 `state.updated`（Node 的静态种子不产 delta，
  这里多一条增量，重新订阅时快照口径一致）；不是 `pending` → `failed` +
  `fault.command.inputRejected`（与 Node 的 ACK 状态一致）。

**验证**
- 驱动新增 `discardSharedContext` 阶段（默认阶段表）：直接往会话库插一条 pending 导入 → 丢弃 →
  重新订阅拿到的快照里 `status = discarded`（**Node 的丢弃不产 delta，只能从快照读**）→ 存储里的
  `status` 也是 `discarded` 且 `shareId` 保留 → 第二次丢弃 `failed/fault.command.inputRejected`。
- `check-dual-kernel-parity`：**71 个必需字段全一致**（63 → 71）；`check-cold-resume` 仍 OK。

**已知边界**
- 导入本身（`importSession`）仍只在 Node 的 server-operations 里；Rust 只认已经落库的导入。
- Node 会顺带更新导入消息的 `metadata.sharedContextStatus`；Rust 的消息模型没有这条元数据，
  这一步不生效（Rust 的恢复路径本来也不按它排除上下文）。

## 6.12 DWF 路线拍板与只读面（2026-10-30，路线 C 第一段）

DWF 调研（8,524 行规格 + 26k 行 TS 引擎/编译器 + 20 多个工具；脚本跑在 `node:vm` 沙箱里；
`dwf_*` 表已在 migration 0019）后拍板走 **路线 C：Rust 协议面 + Node 引擎 sidecar**，理由与
三方案对比见 `docs/rust-kernel-dwf-design-2026-10-30.md`。

第一段落地（只读、无迁移）：

- `kernel-api::workflow::DynamicWorkflowRun`（`id`/`name`/`status`/`sessionId`/`cwd`/
  `resumedFrom`/`toolCallId`/`spentTokens`/`createdAt`/`updatedAt`）；
- `SessionStore::workflow_runs`（缺省空）与 `Kernel::dynamic_workflow_runs`（缺省空）；
- `node-store::repo::dwf::list`：`dwf_run where parent_session_id = ?`，按 `time_created` 升序；
  单测覆盖会话隔离、字段透出与空结果；
- 写面仍归引擎（sidecar 接进来后由引擎独占写），Rust 目前只读。

**验证**：`cargo test -p rust-cli-node-store dwf` 绿；`cargo check` 全绿。3 条 DWF 命令仍在
`BLOCKED_COMMANDS`（引擎未接），覆盖表保持 31 接住 / 3 块。

**C1 可行性探针（同日通过）**：`scripts/kernel-baseline/probe-dwf-engine.mjs` 用两个 app-free 包
（`@nibi/dynamic-workflow` + `dynamic-workflow-runtime`）直接装配引擎——无 ask 与
`agent/ask` 两段脚本都 `completed`，事件序列完整；再用内核自己的迁移 SQL 建库、经真实
`createDwfJournalStore(db)` 跑同一段脚本，`dwf_run` 行
（`id/status/parent_session_id/spent_tokens`）与 Rust 只读端口选的列一致。结论：引擎可脱离 CLI
runtime 独立跑，唯一 app 耦合是 driver。据此把 C1 再细化：**driver 反过来 RPC 到 Rust**（模型/工具/
权限留在 Rust，sidecar 只管编译/沙箱/引擎/journal），见设计文档 §3.2–§3.3。

## 7. 未完成项

- `crates/nibi-platform` 已落地第一段：`paths`、`credentials`（v2/v1/env/钥匙文件）、`license`（Ed25519+dev/uid 绑定+exp/72h/7d）、`device_flow`（请求形状/响应解析）、`paid_plugin`（发现层判定）；46 个单测全绿。
- 尚未接线：Device Flow 的 HTTP 轮询循环、manifest/安装记录读取、把 `nibi-platform` 接进内核登录/插件加载路径（属阶段 2）。
- 品牌化未开始（本阶段只做 vendoring 与安全门禁，避免和功能 PR 混批）。
- 品牌化：本子树仍是上游 ZCode 品牌；按计划等所有功能 track 完成后再做 §4.11/§7.7 收口，本阶段只做 `kernel/` 引入与安全门禁。

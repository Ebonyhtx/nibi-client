# NIBI 内核 fork 日志

> 纪律来源：《NIBI-Rust内核改造调研与规划》§4.7（五条纪律）与《NIBI-大改造与安全修复与品牌化执行计划》Step 5。
> 本文件随 `kernel/` 一起维护；每次重 pin、吸收/拒绝上游变更、新增 NIBI 自有迁移、复跑安全门禁都要追加记录。

## 1. Vendoring 基线

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/MBearo/ZCode-rs` |
| 参考克隆 | ~~`D:\ZCODE-RUST\ZCode-rs`~~ 本地已清理（2026-10-31）；稳定镜像在 fork [`Ebonyhtx/ZCode-rs`](https://github.com/Ebonyhtx/ZCode-rs)（tag `vendor-0.1.67` = `6d349ed4`，上游删库/改史也有可查副本） |
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

**C1 第一步（同日落地）**：`rust_cli_agents::Agents::run_actor_turn` 复用子代理的 `QueryLoop`
跑 DWF actor 轮（persona 进 system、工具 allow/deny、同一 actor 子会话跨轮续跑、不进 agents 面板），
`Kernel::run_workflow_actor`（`WorkflowActorSpec/Turn/Request`）把它交给 sidecar 的 driver 调用；
agents 两例 + runtime 两例测试。typed ask 的 `submit_result` 已接（合成工具、永远放行、
结果进 `submitted`）；`escalate` 需要挂起/恢复一轮，留给 sidecar 的交互面。

**C1 可行性探针（同日通过）**：`scripts/kernel-baseline/probe-dwf-engine.mjs` 用两个 app-free 包
（`@nibi/dynamic-workflow` + `dynamic-workflow-runtime`）直接装配引擎——无 ask 与
`agent/ask` 两段脚本都 `completed`，事件序列完整；再用内核自己的迁移 SQL 建库、经真实
`createDwfJournalStore(db)` 跑同一段脚本，`dwf_run` 行
（`id/status/parent_session_id/spent_tokens`）与 Rust 只读端口选的列一致。结论：引擎可脱离 CLI
runtime 独立跑，唯一 app 耦合是 driver。据此把 C1 再细化：**driver 反过来 RPC 到 Rust**（模型/工具/
权限留在 Rust，sidecar 只管编译/沙箱/引擎/journal），见设计文档 §3.2–§3.3。

## 6.13 DWF 修订与升级问答（2026-10-30，路线 C 第三段）

`amendWorkflowRunSettings` 与 `escalate` / `ResolveWorkflowQuestion` 两端落地，三条 DWF 命令
**全部接住**（`BLOCKED_COMMANDS` 清空）。

- **修订**：Rust `WorkflowEngine::amend` → sidecar `amend` RPC；sidecar 做三态归一（省略 = 沿用、
  `null` = 回默认、值 = 设定）、「未改」拒绝、编译体检（都在停下任何东西之前）；只改并发且 run
  在飞时就地 retune（同 runId + `dwf_run.caps_max_concurrency` + `run-caps-changed`），否则以
  `{superseded}` 停在飞前驱、等它自己结算，再带 `resumedFrom`/`inheritedTokens`/实参启动后继。
  run 级 `subagentModel` 落 `run-launched`，并在 `actor/create` 时解析成结构化 selection 送进
  Rust actor 轮（`ActorProfile.selection`）。
- **升级问答**：`runtime::escalations` 注册表（qid `dwfq-<片段>-<seq>`、全局唯一、只许父会话作答、
  已退场 qid 有界记忆、per-ask 预算 3）；actor 的 `escalate` 工具与主会话的
  `ResolveWorkflowQuestion` 工具（描述/输入 schema 与 Node 逐字相同）；通知经 `Agents::notify`
  走后台子代理 `task-notification` 同一条路（meta user 消息、空闲即开回合、提交后按 seq ack）。
  取消/丢弃停驻 future 按 `withdrawn` 退场，迟到作答得到 `run_not_in_flight`。
- **修掉真 bug**：sidecar 的 `node:sqlite` 缺省 busy timeout 为 0，与宿主写同一个 `db.sqlite` 时
  `updateRunStatus` 会 `SQLITE_BUSY`，run 永远停在 running（约 1/3 概率）。统一用 5s（与存储层
  启动锁同档）。
- **门禁**：`check-dwf-engine.mjs` 从 13 字段扩到 **31 字段**（修订 10 + 升级 6），双内核一致。
  另有 runtime 的 `escalations` 4 例（park/notify/resolve、预算、取消撤下、跨会话拒绝）、
  内核级 `an_actor_escalation_parks_until_the_parent_answers`、tools 的答题工具 3 例。
- **仍未移植**：journal 的 `escalation-*` 事件与 `pendingQuestions` 投影、修订后的「设置轮」、
  `modelBindings`/persona 级模型名解析、`GetWorkflowRun` 工具本身。见设计文档 §5.4。

## 6.14 `--prepare-storage` 存储准备握手（2026-10-30）

Host 的启动存储门（桌面启动先准备好会话库再起 Agent）：Node 侧是
`prepareProtocolStartupStorage` 的 NDJSON 握手，Rust 现在对等实现，桌面 Rust 命令同时打开
`supportsStorageStartup`。

- **node-store**：`open_with_progress`（Node `runSqliteSessionMigrationsAsync` 的 onProgress 同一
  事件序列：checking → checking(事实) → waiting_for_lock → migrating(id/completed/total) →
  committing → ready → failed，含 `lastAppliedMigrationId` 的「基线读取后才带键、空账本为
  null」细节）；`Facts` 增 `committed`/`last_applied`/`baseline_read`；`session_database_id` =
  路径的 sha256 十六进制（Windows 上先归一分隔符——Node 的 `path.resolve` 产物全反斜杠，Host
  按它归并迁移基线，两内核必须同值；app-server 常规启动帧的 databaseId 从
  `session-db-<hash>` 切到它）。
- **cli**：`prepare_storage.rs`（`app-server --stdio --prepare-storage`）：`startup/storagePath`
  → 30s 等一帧 `startup/storagePathReady`（EOF=`transport_closed`、超时=`startup_status_timeout`、
  超长/坏帧=`sql_failed）→ 不 reuse 时建目录 + 阻塞打开上报进度 → `startup/storagePrepared`。
  失败两份帧（打开层本 attempt + 全新 attemptId 序号 1，Node 两层 catch 同形），退出码 1。
  `backup_required` 不在 Node 枚举里，帧里按 `sql_failed` 报。库的位置只来自用户级配置与环境
  变量（Node `createConfig({env})` 没有项目层，同范围）。
- **对齐 Node 的库路径派生**：`StoragePaths::resolve` 在 `sessionDbPath` 未显式给出时跟
  `storage.dir` 走（Node `deriveSessionDbPath`）；此前 Rust 固定用用户根缺省位置，`ZCODE_STORAGE_DIR`
  隔离时会打开与 Node 不同的库。缺省（两者都没配）保持收拢前的字节形状（F55 等价性用例）。
- **门禁**：驱动器新增 `storagePrepare` 阶段（`storage-prepare-probe.mjs`，四用例：全新
  initialize / 重跑 none / reuse / 损坏 corrupt），**21 个字段**进 `check-dual-kernel-parity`
  （总 92 字段全一致）；databaseId 不直接跨内核比（两次运行的临时根不同），比的是
  「= 自己路径的 sha256」这一事实，散列函数由 node-store 的 `the_database_id_matches_node`
  用固定向量钉死。node-store 另有进度序列 2 例。

## 6.15 升级问答的 journal 双轨（2026-10-30，路线 C 第四段）

Node driver 的双轨 record（journal + emit）在路线 C 里由 Rust 宿主补上 durable 轨：
`escalation-raised` / `escalation-resolved` 落 `dwf_event`，与引擎 sidecar 共写同一个库。
journal 因此成为 `pendingQuestions` 投影与冷回放的数据源。

- **node-store**：`repo::dwf::append_event`（序号分配与写入同一条 INSERT——Node `appendEvent`
  同一条语句，多进程共享库不撞号）、`events` 读面与 `pending_questions` 冷回放（raised 减
  resolved，`askedAt` 用事件载荷里的提问时刻）；`SessionStore::append_workflow_event` 窄口。
- **kernel-api**：`WorkflowEventJournal` 端口；runtime 的 `SessionJournalSink`（孤儿规则包装，
  与 `EscalationPort` 同先例）在内核装配时接到会话存储。
- **escalations**：raise 在 park 之后 append（**真**写失败（SQLite/IO）→ 撤回登记 +
  `journal_write_failed` 拒绝——journal 写不进去就没有 durable 的问答记录，悄悄停驻不诚实）；
  resolve 在送达之前 append（真写失败 → 记 warn，答案照送——actor 已经在等，为一条观察事件
  把它挂住更坏）。存储「没有这个能力」（`Unsupported`：TUI、内存存储）不是故障——与 Node
  引擎自带内存 journal 回退同一语义，只剩通知轨，停驻照常。两条取舍与 Node 的 raise/resolve
  注释逐条对应。事件载荷与 Node `RunEvent` 同形：`actor` 是**结构化** ActorRef
  （`{siteId, ordinal}`——注册表/工具面的 `site@ordinal` 字符串只在 park 与通知里用）。
- **门禁**：`check-dwf-engine.mjs` 31 → **37 字段**（journal 事件类型、载荷形状、问答配对、
  答案文本），双内核一致。runtime 另有 journal 双轨 1 例（两条取舍 + 载荷形状）、
  node-store 事件 2 例（per-run 序号 + 冷回放）。

## 6.16 `GetWorkflowRun` 工具（2026-10-30，路线 C 第五段）

升级通知与答题拒绝文案都引用的查询兜底，journal 读面落地后把它接上。

- **node-store**：`repo::dwf::run_detail`——run 行终态拆解（Node `decodeRunSettlement` 同规：
  cancelled 包络 → `stopped(+reason/supersededBy/error)`、failed 的 `Interrupted` 码 →
  `stopped(interrupted)`）、标签派生（name → 脚本首行截 80 → runId，读时派生不回写）、
  节点计数（`nodesObserved` = 已落库行数，不冒充总步数）、actors、log 尾巴 20 条
  （`order by sequence desc limit` 下推再反转）与冷回放的待答问题；
  `SessionStore::workflow_run_detail` 窄口（缺省 `Unsupported`）。
- **kernel-api**：`WorkflowRunIntrospection` 端口 + `WorkflowRunDetail` 等类型；
  runtime 的 `WorkflowRunDetailReader` 合成 journal 事实与停驻注册表的活项（按 qid 去重，
  journal 冷回放 ∪ 注册表）。
- **tools**：`GetWorkflowRunTool`（名字/描述/输入 schema 与 Node 逐字相同；描述里的
  引导文案同一段）。模型面是 Node 格式器同一块序的子集：summary（`buildWorkflowRunSummary`
  的可 sourced 从句）、身份块、pending_questions（引导句逐字）、log_tail（块恒在场、空尾巴
  一句固定文案、`[seq] | age | message` 行）、usage、result（completed 的顶层返回值，
  string 原样/其余 pretty JSON）、error、`<amendable>`/`<resumable>` 路由提示（逐字）。
  阶段表/花名册/留白/产物读面未接，对应块整体缺席——「没有」与「不知道」分开。
- **门禁**：`check-dwf-engine.mjs` 37 → **45 字段**（真 id 的状态/摘要/用量/归属/amendable/
  待答区缺席/log 尾巴形状 + 坏 id 的 run_not_found），双内核一致。

## 6.17 启动轮与设置轮（2026-10-30，路线 C 第六段）

中枢「运行」与 run 卡「配置」成功后的会话记录（launch.md「The launch turn」与「The settings
turn」）：模型可见的 controlOnly 合成输入，GUI 的运行卡与冷恢复读 `metadata.workflowLaunch`。

- **kernel-api**：`Command::WorkflowLaunch { text, launch }`（会话 actor 忙时排队、空闲即落，
  开消息 + `TurnStarted`/`TurnFinished` 轮边界、不开模型回合）；`Fact::WorkflowLaunchMessage`
  （存储事实，`TurnAnchor::after` 认它自成一轮）；`WorkflowRunStarted` 增 `launch_turn` /
  `settings_turn`（引擎回复带的材料）。
- **node-store**：`append_launch` 按 Node `persistWorkflowLaunchUserMessage` 的形状写
  （`source: "workflow_launch"`、`metadata.workflowLaunch`、`semantics` 同键序）；`hydrate::user`
  对这类 synthetic text part 网开一面——冷加载后文本照常进模型上下文（Node 的 provider
  history 同规；不然一次重启就把「已修订」记录从模型眼里抹掉）。
- **protocol-zcode**：`workflow_settings_turn.rs`——两条规范句（Node `buildSettingsMessageText`
  / `buildLaunchMessageText` 的逐字移植）与元数据构造（键序照 `boundWorkflowLaunchMeta`，
  args 4KB / description 500 / script 256k 三道上界同款）；`startSavedWorkflow` /
  `amendWorkflowRunSettings` 成功后发轮，写失败只记日志不回滚（Node 同规）。
- **sidecar**：`dwf-engine-command.ts`——submit/amend 回复带齐材料（saved 的名字/作用域/落点/
  脚本/实参；修订的 from/to/ceiling）；默认并发 D 从常量 4 改回宿主同款 CPU 公式
  `max(4, min(16, cores − 2))`（多核机上 ceiling 曾分叉）；submit 把 saved 名字落
  `dwf_run.name`；中枢启动 toolCallId `call-` 归位 `launch-`（与设置轮 `settings-` 同族）。
- **Node 侧**：`snapshotOf` 补上从没填过的 `name`（registry/journal 都有）——设置轮的
  「已修订」句子因此从没带过名字。
- **投影面剩余**：live 投影把控制轮当普通 agent 轮画（`executionKind: "controlOnly"` 未穿
  `KernelEvent::TurnStarted`），运行卡渲染归 GUI 投影面切片。
- **门禁**：`check-dwf-engine.mjs` 45 → **55 字段**（启动轮句面/元数据、设置轮就地生效句、
  「改了什么」from/to/ceiling、修订句 supersedes、冷恢复键 `source`/`semantics`/`metadata`
  形状、名字带引号），双内核一致；复跑时三个门禁全绿（parity 92、cold-resume）。

## 6.18 脚本点名的模型绑定（2026-10-30，路线 C 第七段）

launch.md「Models the script names」：`agent(…, { model: "名字" })` 的每个名字在 launch 时对着
**本机**模型目录解析成规范串绑定表，actor 的选型按 persona 点名查表。

- **宿主**：`SidecarEngine` 带上 `ModelDirectory`（platform 的目录）；新宿主 RPC
  `models/resolve`——sidecar 报名字（与沿用的前驱绑定表），宿主解成
  `{bindings, unresolved}`。`resolve_model_reference` 是 Node `resolveModelReference` 的移植：
  三档特异性（全称 → 裸名在默认 provider 下 → 别的 provider 拒绝跨账单）、大小写不敏感、
  `$level` 必须是合法档位（注册表拼写胜出）、缺席取目录默认档（档位表最后一个，Node
  `model-catalog-port` 同一读法）；Rust 目录只列可用模型，Node 的 `disabled` 档落成
  `not_found`。3 个单测。
- **sidecar**：submit/amend 起跑前抽脚本点名的名字（`analyzeWorkflowScript` 的
  `modelReferences`，去重按首次出现序）→ `models/resolve`（修订把前驱 `run-launched
  .modelBindings` 作为 inherited 递进去，沿用的名字解的是前驱记下的规范串——用户在前驱
  确认窗里换过的模型留得住）→ 绑定表进 `run-launched.modelBindings`。解不出来按
  `compile_failed`（启动）/ `model_unavailable`（修订）拒绝，旧 run 不动。
- **actor 选型**：`createActorSession` 按 persona 点名查表，优先级 persona 绑定 > run 级
  `subagentModel` > 缺席（内核默认）——Node `workflow-actor-model` 的同一张表。点名的名字
  不在表里是接线故障，大声失败（Node `WorkflowActorModelUnboundError` 同义），不悄悄退回。
- **门禁**：`check-dwf-engine.mjs` 55 → **58 字段**：saved 工作流的 persona 点名
  `fake-model-b`（会话模型是 fake-model），两条 run 的 `run-launched.modelBindings` 与
  `{"fake-model-b":"drive-fake/fake-model-b$enabled"}` 逐字节一致、第一个 ask 的 provider
  请求真在 fake-model-b 上、修订沿用同名绑定——绑定链路两端各自端到端可证。

## 6.19 GetWorkflowRun 的情势截面与产物（2026-10-30，路线 C 第八段）

四块缺了的读面接上（详见 docs/rust-kernel-step2-slice1-2026-10-30.md §6.26）：

- **kernel-api**：`WorkflowRunDetail` 增 `subagent_model` / `model_bindings`（`run-launched` 上的
  元数据）与 `phases` / `subagents` / `health` / `holes` / `artifacts` 五个截面字段及其镜像类型
  （`WorkflowRunPhaseView` / `WorkflowRunSubagentView(+Ask/LastTool/Wait)` / `WorkflowRunHealth
  (+ConcurrencyHealth)` / `WorkflowRunHole` / `WorkflowRunArtifact`）。
- **node-store**：`repo::dwf` 增事件一趟扫的 `index_events`（Node `indexRosterEvents` 的移植：
  进度/停滞/阶段时刻/结算序，`node-waiting` 刻意不算进度）、`node_rows`（非 report 行不带结果）、
  `tagged_report_counts`（`group by` 下推的 itemCount）、`hole_rows`（`hole-reached` ×
  `hole-filled` 合流，waiting 只认宿主注入的开放集）、`artifact_rows`（`kind='artifact'` 归并：
  只收 completed、版本取最新、itemCount 只数预置看板、primary 带头）；`run_detail` 一次事件读喂
  全部读面，并抽出 `subagent_model` / `model_bindings`。
- **tools**：`workflow_run_detail.rs` 补齐 `<max_concurrency>` / `<subagent_model>` /
  `<script_models>` 身份行与 `<holes>` / `<health>` / `<phases>` / `<subagents>` / `<artifacts>`
  五个块（Node 格式器逐字移植：行头 1 起的序号、列宽由本次的行算出、`ahead` 行只有名字与状态、
  终态不带 stalled、leftover 说明、产物行与完成通知共用一个格式器）；10 个单测钉住输出。
- **门禁**：`check-dwf-engine.mjs` 58 → **63 字段**（escalate run 上 health 三键 + 终态无
  stalled、subagent 行形与 tokens 列、phases/artifacts 按脚本缺席、run_not_found 照绿）。
  实形态探针（带阶段/留白/产物的工作流的停驻态对拍）本轮撤下——Node 会话的轮调度让探针轮
  时长不可控；等 FillWorkflowHole 切片（那时 run 有真正的停驻/补全周期）再回来。

## 6.20 控制轮的投影面（2026-10-30，路线 C 第九段）

中枢启动 / 设置轮在活投影与冷投影里按 controlOnly 呈现（详见
docs/rust-kernel-step2-slice1-2026-10-30.md §6.27）：

- **kernel-api**：`KernelEvent::TurnStarted` 增 `execution_kind`（`TurnExecutionKind`：agent /
  controlOnly，缺席按 agent 读，与 Node `payload.executionKind ?? "agent"` 同读法）与
  `workflow_launch`（控制轮的元数据，与消息记录上同一份）；`SessionView` / `LoadedSession` 增
  `launches`（`SessionLaunchTurn { message, launch }`——`Message::User` 不带消息元数据，冷投影靠
  这份清单认控制轮；node-store 冷读取从记录的 `source: "workflow_launch"` 采集，MemoryStore 从
  事实采集）。
- **session**：`write_launch` 的轮边界事件带上 controlOnly 标记、元数据与命令 id（Node
  `emitControlOnlyUserTurn` 的 TurnStarted payload 同形），并追加进 actor 的 `launches`。
- **protocol-zcode 投影**：`start_turn` 按 controlOnly 分岔——轮头与输入行 `origin:
  "workflowLaunch"` + `executionKind: "controlOnly"` + `workflowLaunch` 元数据上行；不推进
  running、不立 activeWork、不清 lastError（Node onTurnStarted 只在 agent 分支动 control）；
  收口不带 activeMs、不补 usage，draft 会话推进终态（Node leaveDraftAfterControlOnlyTurn：
  sessions-index 否则把恒 draft 的中枢会话丢掉）。冷投影从 `SessionView.launches` 按
  `workflowLaunchOfMessage` 同判据重建控制轮。
- **驱动/门禁**：`check-dwf-engine.mjs` 63 → **65 字段**——`dwfControlRows`（3 只控制轮的行数）
  与 `dwfControlRowShape`（origin/executionKind/元数据/无 activeMs 逐项）；驱动给修订会话补上
  会话主题订阅、`buildState` 按 topic 过滤（多会话的行 rowId 各自从头编号，不能混一张 Map）。
  冷面对拍用驱动冷模式的 `NIBI_DRIVE_DUMP_SNAPSHOT=1` 行转储做了一次开发期验证：两内核冷快照
  的 6 只控制轮行逐字段一致（origin/executionKind/state/无 activeMs/runId）。冷探针顺带暴露
  下一个缺口：run 通知轮的轮头行 Node 是 `origin: "backgroundResult"`（live 也一样），Rust
  现在开成 userInput（冷投影干脆不立轮头）——下一片接。

## 6.21 后台通知轮的轮头面（2026-10-30，路线 C 第十段）

后台通知（`<task-notification>` 信封）开的 model-only 轮在投影里按 `origin: "backgroundResult"`
呈现（详见 docs/rust-kernel-step2-slice1-2026-10-30.md §6.28）：

- **kernel-api**：`KernelEvent::TurnStarted` 增 `input_source`（`TurnInputSource`，只有
  `background_task` 一档；Node `turnHeaderOrigin` 的表——`background_task` → backgroundResult，
  同伴消息的 `subagent_message` 落默认 userInput 所以内核不给它标记）。通知来源标签
  `TASK_NOTIFICATION_SOURCE`（"task-notification"）挪进 kernel-api，会话 lane 与冷投影同表。
- **session**：通知 lane 开轮时带上标记（同伴-only 的批次不带）；其余轮不带。
- **protocol-zcode 投影**：`start_turn` 的 origin 三分（workflowLaunch / backgroundResult /
  userInput）；冷投影认 task-notification 的 meta 消息、自己开 backgroundResult 的轮（其后的
  assistant 归本轮、无用户气泡）。两个新投影单测（live 通知轮形状 + 冷重建）。
- **门禁**：`check-dwf-engine.mjs` 65 → **66 字段**（`dwfNoticeRow`：escalate 阶段升级通知轮的
  轮头，两内核 origin/executionKind/终态一致）。冷面用驱动冷模式转储对拍 escalate 会话：raise
  通知轮的行两内核逐字段一致。
- **本轮暴露的通知链缺口**（下一片）：① sidecar 的 `run/settled` Rust 宿主只从进程表摘掉，
  不给父会话发后台通知（Node 的 run 完成/进展通知是父会话里的 backgroundResult 轮）；②
  escalation 的**回答**在 Node 还有第二轮 backgroundResult 通知，Rust 只在 raise 时通知；③
  通知的结构化 `originMeta`（backgroundSource/workId/title，run 卡 → 详情页的关联键，
  `WorkflowNotices::notify` 现在只有 text）。存储侧还有一处互认缺口：Node 写的通知记录
  （顶层 `source: "background_task"` + `inputPresentation`）与 Rust 的 meta 记录（`metadata`
  里的 rustCli 标记）形状不同，Rust hydrate 会把 Node 写的通知整个丢掉（模型上下文也丢）——
  通知链切片一起对齐。

## 6.22 run 的终态通知链（2026-10-30，路线 C 第十一段）

`run/settled` 从「宿主只摘表」接成父会话里的后台通知轮（详见
docs/rust-kernel-step2-slice1-2026-10-30.md §6.29）：

- **sidecar**：结算时随 `run/settled` 带上通知事实（`notice`：run 行的名字/toolCallId、
  `run-launched` 的脚本落点、report 条目（快照同款 256 条上限）与真实总条数、
  `artifact-published` 记录、用量）——journal 是唯一数据源，submit/resume/amend 三条入口同构；
  读取发生在结算的 `.then` 里（db 还开着）。
- **宿主**：新模块 `dwf_run_notification.rs` 逐字移植 Node 的
  `formatLocalWorkflowTaskNotification`（local_workflow 分支：信封顺序、`<status>` 用 run 的
  三终态词、`<stop-reason>`、summary / result（字符串原样、其余两空格 JSON）/ 表驱动的
  providerStop `<error>` 块 / `<reports>`（8k 预算、单条 2k、`[n] item`）/ `<artifacts>`
  （每 id 最新版、primary 带头、预置看板点数、8 行）+ 呈现指引（completed 与 stopped 五
  reason × errored × 兜底全分支）+ 120k 截断），11 个单测钉字。锚点宿主铸的用宿主的、resume
  沿用 journal 行值、都没有按 Node 合成 `resume-` 前缀；**被修订替代的 run 不发终态通知**
  （Node coordinator 同一条裁决）。经 `Kernel::workflow_notices()`（新端口缺省 None，runtime
  返回通知中心）→ `Agents::notify` → 通知 lane——上一段的 backgroundResult 轮头面照常生效。
- **门禁**：`check-dwf-engine.mjs` 66 → **67 字段**（`dwfNoticeText`：引擎阶段终态通知的模型面
  文本，归一（剥 system-reminder 包装、遮每内核现铸的 run/tool 锚点 uuid）后的「长度/指纹」
  两内核逐字节一致——837/4198312385 = 837/4198312385）。escalate 会话的冷快照对拍：run 终态
  通知轮两内核同为 backgroundResult + assistantText。
- **§6.21 暴露的缺口对账**：① run/settled 通知——本段接上；②「escalation 回答的第二轮通知」
  ——对拍复核那是 run 的终态通知（escalation-resolved 本就不通知），随本段到位；③ 通知的结构化
  `originMeta`（backgroundSource/workId/title + workflowNotification manifest，GUI 运行卡的
  关联键与载荷）仍缺——信封文本不含它，下一片接；④ Node 写的通知记录与 Rust meta 记录的形状
  差异（Rust hydrate 丢 Node 通知）仍缺。

## 6.23 通知记录的跨库互认（2026-10-30，路线 C 第十二段）

§6.21 列的缺口 ④：Node 写的后台通知记录 Rust 冷读整个丢掉（模型上下文也丢）——接上：

- **hydrate**：Node 写的 synthetic user 记录若满足 `providerContextOnly` 的两个判据面之一
  （`semantics.providerVisibility == "visible"` 或记录级 `visibility == "model-only"`）且来源在
  通知触发集合里（`background_task` / `task_notification` 两个拼写），保留 synthetic 文本并按
  来源还原 `UserOrigin::Meta`——Node 的 provider history 同样保留它
  （`userEntriesFromParts` 对非 attachment 类 synthetic 文本照常进 prompt 块）。Rust 自己写的
  meta 记录走 `metadata.rustCli` 的另一条还原路，不受影响（记录顶层无 source，拼写也不同）。
  其他 synthetic（todo_reminder 一类、fork 提示、hiddenSynthetic）照旧不进。
- **冷投影**：通知轮臂的来源集合扩到两个 Node 拼写——跨库读 Node 写的会话时，通知轮照常
  以 `backgroundResult` 重建。
- **夹具修正**：`node_written_sessions_read_back_their_text` 的旧预处理把所有
  `legacy_synthetic` 的 user 条目从两边剥掉，补偿的是当时 Rust 冷读丢合成消息的缺口；现在
  通知族照常比较（fixture 的 basic/rich 两例都在），其余 legacy_synthetic（fork 提示等）
  维持剥离。
- **测试**：node-store 3 个新钉（两个拼写保留文本 + origin、非触发源照旧丢、非
  provider-visible 照旧丢）+ 投影 1 个跨库冷读钉。

## 6.24 通知的结构化 originMeta（2026-10-30，路线 C 第十三段）

§6.22-§6.23 之后的最后一块通知缺口：`originMeta`（Node `BackgroundResultOriginMeta`，GUI 运行
卡的关联键与通知卡载荷）端到端——结构化载体、信封、记录、行、冷重建（详见
docs/rust-kernel-step2-slice1-2026-10-30.md §6.31）：

- **kernel-api**：`UserOrigin::Meta` 变体带 `origin_meta: Option<Value>`（`Eq` 从 UserOrigin 链
  上摘除——workspace 无一处理需要它，全树零 fallout）；`AgentNotice` 同增（ 同去 Eq）；
  `WorkflowNotices` 增 `notify_with`（缺省丢弃元数据落回 `notify`）；`TurnStarted` 增
  `origin_meta`。
- **投递链**：`Agents::notify_with` → hub（AgentNotice 携带）→ 信号 → lane（`Waiting::origin_meta`
  助手，只有子代理通知通道带）→ 通知轮（meta 消息的 origin 携带 + TurnStarted 上行）。
- **存储**：`append_meta` 把 originMeta 写进记录与 part 的 `metadata.originMeta`（Node
  `persistSyntheticUserNoticeForSession` 同形）；hydrate 两条还原路（rustCli 标记路、Node 记录
  的 `metadata.originMeta`）都读回变体；冷投影的通知轮臂从消息 origin 取值 → 轮头行
  `originMeta`（live 同字段，Node `buildTurnHeaderRow` 同形）。
- **宿主**：run/settled 组 base 三键（backgroundSource=workflow / title=主题 / workId=runId）+
  **终态 manifest 载荷**（`workflowNotification`：kind/status/stopReason/summary(≤500)/
  result(≤4k, resultTruncated/resultForm prose|json)/error(≤2k)/reports(≤8 条×≤500, count=真实
  总数)/artifacts chips(kind 六字面量白名单、id≤64、version≥1、title≤120、contentType≤255、
  description≤500 仅 primary、artifactsTruncated=画出来的比总数少)/durationMs（本世代墙钟））；
  sidecar 的 notice 事实补 durationMs（结算时现测）。escalation 的 raise 通知带同三键（
  escalation manifest 下片）。superseded 照旧压下。
- **门禁**：`dwfNoticeText` 的指纹升级为「文本 + 记录级 originMeta」（durationMs 每 run 现测、
  归一遮掉）——**1071→1088 字符的 manifest 差异当场现形后消除**，两内核 1088/1588820788 逐字
  节一致；`dwfNoticeRow` 加验轮头行的 `originMeta.backgroundSource/workId`。13 个单测。
- **对账**：§6.22-§6.23 的「仍缺 originMeta」清账。剩余：escalation/stall/hole/blocked 的
  manifest 判别分支（信封文本已逐字、base 三键已带，缺各自的 manifest 载荷）；Node 写的记录上
  的 originMeta 已随 §6.23 的判据进入 hydrate（本轮补了读取）。

## 6.25 escalation 的 manifest 判别分支（2026-10-30，路线 C 第十四段）

§6.24 留的四个判别分支第一个接上（详见 docs/rust-kernel-step2-slice1-2026-10-30.md §6.32）：

- **escalations**：`WorkflowEscalations` 增 store 钩子（run 行的只读面，runtime 组装时接上
  `ports.store`）——raise 通知的 originMeta 走 `escalation_origin_meta`：base 三键 + `kind:
  "escalation"` 的 manifest 载荷（qid / actor / question / context ≤4000 / askedAt），展示名走
  run 行的标签链（`workflow_run_detail` 的 name → 脚本首行 → runId；Node
  `registry.description ?? runId` 同源兜底，store 缺席落 runId）。
- **门禁**：`check-dwf-engine.mjs` 67 → **68 字段**（`dwfEscalateMeta`：升级通知记录的
  originMeta 指纹——backgroundSource/title/workId + manifest 的 kind/qid(归一)/actor/question/
  hasContext/askedAtIsNumber，两内核 **211/3795793529** 逐字节一致）。修掉一处真分歧：此前
  Rust 的 escalation originMeta title 落 runId，Node 走 registry.description（probe run 的
  title 曾一边 `dwfrun-…` 一边 `escalate`）。
- 剩余三个判别分支（stall / hole / blocked）信封文本已逐字、base 三键已齐，各自 manifest 载荷
  待接——stall/hole 的通知在 Rust 侧还没有投递链（journal 事件有、通知不发），与
  `workflows/runs` 中枢方法一起评估。

## 6.26 留白到达的通知链（2026-10-30，路线 C 第十五段）

§6.25 留下的三类 run 中通知第一个接上——也是 FillWorkflowHole 工具面的前置（详见
docs/rust-kernel-step2-slice1-2026-10-30.md §6.33）：

- **sidecar**：`run/event` 的 hole-reached 从只报类型升级为**完整载荷**（Node
  `toProgressPayload` + `notifyHoleReached` 的快照合并同构）——事件原文（instance/name/prompt）
  + 编译期事实（type/line 来自站点表、before/after 来自控制流投影的阶段表，与 askSpecs 一次
  编译同出）+ reachedAt + run 展示元数据（名字在 run 行、脚本落点在 run-launched 的事件头，
  三条入口同构）。launch 对象恒在场：inputId（锚点缺席落 runId）、phaseNames、openHoleIndexes、
  scriptPath 恒写（Node 的 run-launched 同三件，resume 的冷读面从事件头读回）。
- **工作副本**：中枢直接启动把 saved 定义逐字节拷进 `.nibi/workflow-drafts/<slug>.dwf.ts`
  （Node `writeWorkflowDraft` 同一条规矩：slug 规则、`-2/-3` 顺延、`wx` 独占、目录自带
  `.gitignore: *`、尽力而为）——它是 run 的可编辑脚本文件；**启动轮 meta 的 path 仍是 saved
  定义的落点**（两者不同物，修掉一处真分歧：工作副本曾顶替了 meta 的 path）。
- **宿主**：`run/event` 的 hole-reached 组 `<workflow-hole>` 信封（Node
  `formatWorkflowHoleNotification` 逐字：banner、信封字段、where 从句三态、draft 句两态、
  FillWorkflowHole 指引与留白体写作规则）+ `kind: "hole"` 的 manifest（siteId/ordinal/name/
  type/prompt/draftPath/line/before/after/reachedAt）投给父会话（run 停驻在留白上，进程表有
  父会话）。15 个通知单测。
- **门禁**：`check-dwf-engine.mjs` 68 → **71 字段**——新探针阶段 `dwfHole`（起一个停在留白上的
  run → 收 `<workflow-hole>` 通知 → 取消收口；FillWorkflowHole 工具面之前 run 以取消结束），
  `dwfHoleNotice`（文本指纹，uuid/墙钟/工作区路径归一）与 `dwfHoleMeta`（originMeta 指纹）两
  内核 **1610/2896616398**、**333/3564330292** 逐字节一致；`dwfHoleCancel` accepted。顺手修两
  处探针问题：hole 的类型实参必须是 facade 可见的类型（`Plan` 不可见 → `string`，2304）；探针
  驱动里 Python 写入的 `
` 会打断正则字面量（老坑）。

## 6.27 FillWorkflowHole 工具面（2026-10-30，路线 C 第十六段）

留白还代码的地方（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」；详见
docs/rust-kernel-step2-slice1-2026-10-30.md §6.34）：

- **sidecar**：`holes`（确认前读面：run 行元数据 + 留白表——`waiting` 只在**本进程**引擎的
  停驻表里成立，`filled` 来自事件，两样都不是的到达不出现）与 `fill`（bootstrap
  `dynamic-workflow-run-fill.ts` 的 fillOnce 逐字移植：拼接 `spliceHoleBody` → 与提交同款的
  `analyzeWorkflowScript`（9011 未绑定模型含 9012）→ 站点稳定性复核 `checkSiteStability` →
  lowering 出 `holeBodies[holeId]` → 引擎控制面 `fillHole`（换表、`updateRunScript`、记
  `hole-filled`、放行停驻分支，一个同步步骤）→ 草稿**就地改写**或**铸造**（引擎拒绝时把刚铸的
  删掉））。同一 run 的补全**串行**（Node fillQueues 的同一条 bug 根因），链排空即删键；拒绝即
  零副作用。诊断映射 `mapFillDiagnostics`（inFill 锚定函数体行）逐字。
- **kernel-api**：`WorkflowEngine::fill_target` / `fill_hole` 两方法 + `WorkflowFillTarget` /
  `WorkflowFillOutcome` / `WorkflowFillDiagnostic` 镜像类型；`WorkflowEngineSlot` 工具面槽
  （注册表建好时 sidecar 还没接上，`with_workflow_engine` 之后工具在调用时读）。
- **工具**：`FillWorkflowHole`（tools crate）——恰好一个函数体来源（400）、`path` 逐字节读、
  确认前等待判定（Node findWaitingHole 的四条文案逐字）、`fill_unchanged` 记忆（被拒字节表，
  只对 `path` 比对）、内联函数体先写 fill 文件（`<run-slug>.<hole-slug>.dwf.ts`，slug 规则与
  `-2` 顺延同草稿一条规矩）、编译失败的整段回话（lead 两态 + 诊断按落点锚文件 + 体外诊断指路
  AmendWorkflow）、成功回话逐字。UI 轨两件（确认窗预览单槽、技能门）路线 C 没有宿主面，记尾单。
- **并入也落记录**：工具边界的通知并入（`Absorbed::Notice`）此前只落 attachment——Node 的
  mid-turn drain 先 persist 批记录。修齐：`ClaimedItem::Notice` 带整项通知，并入先落一条 meta
  user 消息（来源 + originMeta，与开回合的通知同形），**不进本次运行的上下文**（模型仍只读
  attachment 那一份）。终态通知落在跑的回合里时不再失踪（这是本轮对拍抓到的真分歧：补全很快，
  run/settled 常常撞进工具边界）。
- **sidecar 债务**：`launchRun` 的返回类型从谎称 `Promise<RunSettlement>` 改成真实的
  `{settlement, notice}`（三处调用点的解构此前靠 cast 瞒着 tsc）；裸错误折算 errored 结算改用
  `new WorkflowError("DriverError", …)`。
- **门禁**：`check-dwf-engine.mjs` 71 → **76 字段**——`dwfHole` 探针从「取消收口」升级为真实
  回填：stub 在通知轮先调 `Skill(dynamic-workflows)`（Node 的技能门；Rust 无 Skill 工具，回
  「没有这个工具」，两边下一步相同）再交 `FillWorkflowHole`，dwfHole 会话显式开灰度闸
  （`dynamicWorkflowMode: "alwaysOn"`，与 dwfEscalate 同一条）并带一个工作区技能夹具。六条
  新字段：`dwfHoleFill`（补全回话指纹 **422/1198194394** 两内核逐字节一致）、`dwfHoleFillFile`
  （fill 文件逐字节）、`dwfHoleDraftRewritten`（草稿就地改写含函数体）、`dwfHoleJournal`
  （hole-reached → hole-filled 的顺序与 filledAt/filledBy 载荷）、`dwfHoleRunRow`（completed +
  行上脚本已拼入函数体）、`dwfHoleSettled`（终态通知指纹 **842/3592966377** 一致）；
  `dwfHoleCancel` 退场。查询点：session 库 `dwf_event` / `dwf_run` 与消息库同轮读。

## 7. 未完成项

- `crates/nibi-platform` 已落地第一段：`paths`、`credentials`（v2/v1/env/钥匙文件）、`license`（Ed25519+dev/uid 绑定+exp/72h/7d）、`device_flow`（请求形状/响应解析）、`paid_plugin`（发现层判定）；46 个单测全绿。
- 尚未接线：Device Flow 的 HTTP 轮询循环、manifest/安装记录读取、把 `nibi-platform` 接进内核登录/插件加载路径（属阶段 2）。
- 品牌化未开始（本阶段只做 vendoring 与安全门禁，避免和功能 PR 混批）。
- 品牌化：本子树仍是上游 ZCode 品牌；按计划等所有功能 track 完成后再做 §4.11/§7.7 收口，本阶段只做 `kernel/` 引入与安全门禁。

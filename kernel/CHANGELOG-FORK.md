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

## 7. 未完成项

- `crates/nibi-platform` 已落地第一段：`paths`、`credentials`（v2/v1/env/钥匙文件）、`license`（Ed25519+dev/uid 绑定+exp/72h/7d）、`device_flow`（请求形状/响应解析）、`paid_plugin`（发现层判定）；46 个单测全绿。
- 尚未接线：Device Flow 的 HTTP 轮询循环、manifest/安装记录读取、把 `nibi-platform` 接进内核登录/插件加载路径（属阶段 2）。
- 品牌化未开始（本阶段只做 vendoring 与安全门禁，避免和功能 PR 混批）。
- 品牌化：本子树仍是上游 ZCode 品牌；按计划等所有功能 track 完成后再做 §4.11/§7.7 收口，本阶段只做 `kernel/` 引入与安全门禁。

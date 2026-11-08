# Rust 内核与 Node 的功能对照（切流前置）

> 目的：切默认内核的判据是「**功能不减**」，不是「协议 89/118」。这份表逐项记「Node 里由谁做、
> Rust 里由谁做、还差什么」，每行都带可查的代码位置。改动任何一项时同步更新本表。
>
> 最后复核：2026-11-07（`dev` `f7fc3db6`：浏览器 broker/CUA、AUQ 自动结束、topic 资源、订阅续传、
> 钩子信任广播、启动偏好、workspace 共享 MCP、NIBI 登录、TUI 调色板）。

## 结论摘要

| # | 功能 | 状态 |
| --- | --- | --- |
| 1 | 「生成提交信息」（`workspace/generateText` / `cancelGenerateText`） | ✅ **已补**（`277450ca`） |
| 2 | 浏览器控制 | ✅ **已接回**：`node_repl` MCP + Rust broker + `browser-use` 准入；逐轮 `turnEnded` 已发（§2） |
| 3 | topic 资源（bot 群话题上下文） | ✅ **已补**：意图落库 + 模型文本注入 + `ReadSessionContext`/`ReplyToChannel` + 两条反向请求（§3） |
| 4 | 运行时偏好协商 | ✅ 三项已核；AUQ 自动结束已按 Node 语义实现（§4.1） |
| 5 | CUA 电脑操控 | ✅ **模型面与执行链已接回，真实 Helper 验证通过**；⚠️ 两条 UI 通知差异见 §5 |
| 6 | 订阅续传与背压 | ✅ **已补**：保留窗 + `base` 水位续传 + `saturated`/`drained`（§6） |
| 7 | 钩子信任跨会话广播 | ✅ **已补**：`trustGrant` 立刻刷新同工作区已打开会话的提示条（§7） |
| 8 | 会话启动偏好 | ✅ **已补**：冷打开问一次 `session/requestRuntimePreferences`（§8） |
| 9 | 会话级 MCP 的 `isolation: workspace` | ✅ **已补**：同工作区共享连接 + 引用计数（§9） |
| 10 | MCP 的 `oauth` / `protocolVersion` | ✅ **已补**：两种 grant 的令牌端口 + 401 刷新一次；`auto` 探 `server/discover`、现代握手与 `protocolEra`（§9.2） |
| 11 | NIBI 登录（Device Flow） | ✅ **已补**：`nibi-platform` 的 HTTP 轮询/刷新 + `nibi login` 接上（§10） |
| 12 | TUI 调色板 | ✅ **已补**：品牌沙色/暖橙（§11） |

## 1. 生成提交信息（已补）

- Node：`GitActionMenu` → `gitService.generateCommitMessage` → `zcodeAgentService.ts:4781` 发
  `workspace/generateText`；CLI 侧 `core/runtime/methods/workspace-generate-text.ts` 做一次**无会话**
  模型请求（`querySource == "git_commit_message"` 走辅助档：最低推理档 + `min(5000, 模型上限)`）。
- Rust：`kernel-api::generate_text` + `runtime::generate_text`（同一个辅助档规则、60 s 期限）+
  `protocol-nibi::generate_text`（参数/结果映射、`operationId` 唯一、按 id 取消）。
- 已知差异：这一笔**不进会话用量**（Node 记 detached workspace 事实，内核没有对应表）。
- 测试：runtime 5（辅助档规则）、protocol 5（映射与容器语义）。

## 2. 浏览器控制（已接回）

### 2.1 Node 的真实形状：共享的 `node_repl` MCP，不是内置工具

- 模型看到的是 **`mcp__node_repl__js`**（`node-repl-host` 包），不是一组 `Browser*` 原生工具。
  `browser-use` / `computer-use` 两个官方插件只贡献 **skill 与文档**，manifest 里没有 `mcpServers`
  （`apps/zcode-cli/packages/browser-use-plugin/.nibi-plugin/plugin.json`、
  `.../zcode-cua-plugin/.nibi-plugin/plugin.json`）。
- 调用链：JS SDK `agent.browsers.*` → `node-repl-host/src/browser-bridge.ts` → 本地 socket
  （`NIBI_NODE_REPL_BROWSER_BROKER_SOCKET` + token）→ agent 侧
  `bootstrap/src/app/node-repl-browser-broker.ts` 的 broker →
  `interaction/browserList` / `interaction/browserExecute` 反向请求 → Host 的
  `browserControlExecutor`（WebContentsView / CDP，`zcodeAgentService.ts:2502`）。
- 因此「在 Rust 里做一套原生浏览器工具」会**分叉**：工具名、skill 文案、权限规则、UI 的工具判断
  全都要维护两套。和 Node 对齐的唯一干净路线是**复用同一个 `node_repl` MCP 服务器**。

### 2.2 Rust 侧已落地

- 内核装配内置 `node_repl`：`kernel/crates/runtime/src/node_repl.rs`，从官方插件缓存的
  `node-repl-host` 目录启动 `dist/mcp/server.js`，`alwaysLoad`、`isolation: workspace`、600 s。
- **浏览器 broker 已实现**：`kernel/crates/protocol-nibi/src/browser.rs`，本地 socket 的
  listener/client 在 `kernel/crates/net/src/local.rs`（Unix 域套接字 / Windows 命名管道）。
  broker 认内核生成的 token（长度固定 + 常量时间比较），把 `list` / `execute` 转成
  `interaction/browserList` / `interaction/browserExecute`；会话关闭时对登记过的连接发
  `closeSession`（`Server::close_session`）。
- 放行与注入：Host 有 `browserControlExecutor` 时在 Rust spawn env 里设
  `NIBI_HOST_BROWSER_BROKER=1`（`packages/services/src/zcode-agent/nodeReplHostEnv.ts`）；
  `app_server` 据此启动 broker，把 socket/token 放进 `Extensions.node_repl_env`；
  `runtime/src/node_repl.rs` 只按 `BROWSER_ENV` 白名单复制给 `node_repl` 子进程；选择器放行
  `browser-use` 的 skill（`select.rs` 的 `host_browser_broker`）。
- 测试：protocol-nibi 3 条（`list` 反向请求、错误 token 不转发、`execute` + `turnEnded` +
  `closeSession`）、runtime 1 条（broker 凭据白名单）、Host 1 条（flag 只在有 executor 时出现）。
- 远程 workspace 的身份：`Context` 记住会话的 `workspace.environment`，broker 对远程会话用 identity
  作 `workspaceKey` 并带 `workspaceIdentity`（本机仍是路径）。逐轮 `turnEnded` 在 `Live` 的
  `TurnFinished` 后发出（`browser.rs::turn_ended`）。

## 3. topic 资源（已补）

### 3.1 Node 的形状

- `sendText` 的 payload 带 `botGroupSource`（`botId`/`chatId`/`threadId`/`authorizationId` +
  `topicHistory`/`topicContext`/`messages`/`contentParts`）与 `conversationQuotes`；core 的
  `message-persistence` 把**原文**写进 text part，把模型文本（`withConversationQuotes` 注入后的
  那份）写进 `metadata.modelInput`，并把 canonical intent 写进消息的
  `metadata.conversationInputIntent`。
- 模型面是两个工具：`ReadSessionContext`（`strategy=topic` 读话题归档，带 `attachment` 时经
  `topic/resource/read` 反向请求把附件物化成受管本机路径）与 `ReplyToChannel`（经
  `bot/channel/reply` 反向请求发带原生 @ 的回复）。

### 3.2 Rust 的落地（`ef86c5a1` + `81957f5e`）

- **意图与注入**：`protocol-nibi/src/conversation_intent.rs` 是 Node `withConversationQuotes` 的镜像
  （引用块 + 机器人来源的四段固定说明，逐字对齐）。`sendText` 提交注入后的模型文本，行上仍是原文；
  意图经新命令 `RecordInputIntent` 与消息同一事务落库（`metadata.conversationInputIntent`），
  `SessionView.input_intents` 让冷投影恢复行上原文、`botGroupSource`、`conversationQuotes` 与
  插件来源。`editUserQuery` 的引用同样注入（以前只 warn）。
- **两个工具**（`tools/src/topic_tools.rs`）：`ReadSessionContext` 的三种策略与 `ReplyToChannel`；
  读面走 `kernel-api::topic::SessionReads`（runtime 的 `StoreReads` 直接读会话存储，不启动 actor），
  Host 能力走 `TopicPort`（`protocol-nibi/src/topic.rs::HostTopic`）：
  - `topic/resource/read`（120 s，可 `topic/resource/cancel`）→ 取回附件后物化成**会话 artifact**
    （`nibi-artifact://…`），模型用 Read 读它；
  - `bot/channel/reply`（60 s）→ Host 解析候选与送达，结果原样交回模型；
  - 回复绑定的输入：按 `tool_use` 找到所属 assistant 消息，再取它前面最近的真人输入，用那条输入的
    `sourceCommandId` 作 `inputId`（Node 用它 `parentID` 的同一判据）。
- 附件索引判据与 Node 相同（`topicHistory.resourceMessages` 或 `topicContext.messages[].attachments`
  两条）；没有已准入的意图时按 Node 的同一条错误失败。
- 测试：`conversation_intent` 7 条（注入文案逐字、意图形状）、`topic_tools` 4 条（归档只读可信输入、
  回复绑定输入、无授权失败、附件物化）。

### 3.3 已知差异

1. `relevant` / `handoff` 只给**按时间序的尾部窗口**：Node 会按 query 打分选块，并可经 lite 模型抽取
   （`source: "lite"`）。Rust 的 `source` 恒为 `"local"`（Node 在没有 lite 模型时的合法取值）。
2. 话题归档的 token 估算是字符数 / 4（Node 用 `estimateTokens`）；分页大小、匹配规则（id 相等或
   小写包含）、`coverage` 文案与 `nextCursor` 语义相同。
3. 话题附件物化成会话 artifact 而不是受管本机路径（Rust 的 Read 认 `nibi-artifact://…`）。

## 4. 运行时偏好协商（已核）

Node 在建会话时向 Host 问一轮偏好（`session/requestRuntimePreferences`，`server-operations.ts:3255`），
Rust 不问、用内置缺省。逐项核对结果：

| 偏好 | Node 来源 | Rust 现状 | 判定 |
| --- | --- | --- | --- |
| `additionalDirectories` | 随 `createSession` 参数 | 同一个 Host 在 `createSession` 里带（`zcodeTaskServiceAdapter.ts:1109`），内核已消费 | ✅ 等价（已知差异：冷恢复不带） |
| `subagentRuntimeConfigEnabled` | 同上 | 子代理运行时配置在内核 deps 闭环，不需要该开关 | ✅ 等价 |
| `askUserQuestionAutoResolutionEnabled` | 同上 + `workspace/updateInteractionPreferences` | 记录偏好并**执行**自动结束（见 §4.1） | ✅ 已补 |

### 4.1 AUQ 自动结束（已补）

Node 的语义在 `nibi-protocol-v4/interaction-registry.ts`：交互按会话排队，**只有队首**计时；登记后
先 60 s `hiddenGrace`（界面还不显示进度），到 `visibleAt` 转 `visibleCountdown`（侧栏开始画进度环，
弹窗最后一分钟才显示秒数），到 `deadlineAt`（300 s）用 `action: accept` + `content.answers: {}`
自动应答（“没选但允许继续”，不是拒绝）；用户第一次操作把倒计时永久换成 `snoozed`；关掉偏好时
把正在计时的全部换成 `snoozed` 并返回条数，重新打开只让之后登记的问题计时。

Rust 按同一语义实现（`kernel/crates/protocol-nibi/src/projection/auto_resolution.rs`）：

- 状态写在待答交互的 `autoResolution` 字段里，所以**会话快照、`state.updated` 增量与
  `sessions-index` 侧栏摘要读的是同一份值**（`index.rs` 的 `pendingInteraction` 现在带
  `interactionId`/`kind`/`toolName`/`autoResolution`，`pendingInteractionSummary` 分
  permission/userInput 计数）。
- 队列与队首判定直接用投影的待答顺序：权限、提问、计划审批都排队，工作区钩子评审不排队
  （Node 的 `activateHead` 同一判据）。`InteractionAsked` 起表、`InteractionResolved` 换下一个队首。
- 计时任务在 `Live`（`live.rs::auto_resolution_clock`），只拿会话的 `Weak`，会话关闭即退出；
  到点的工作经 `Bridged::run` 排进会话泵任务，保证增量与内核事件帧同序。
- 到点应答走与用户点“继续”完全相同的路径：`Command::ResolveInteraction`，answer 是
  `QuestionAnswer::Answered { answers: {} }`。工具结果文本对齐 Node 的空答案分支
  （`tools/src/texts_more.rs::NO_ANSWER`）：明确告诉模型“不是拒绝、按最佳判断继续”。
- `snoozeInteractionAutoResolution` 已真正生效（幂等成功，回执 `snoozed` 说明是否改了状态）；
  `updateInteractionPreferences` 的回执带真实的 `snoozedInteractionCount`；偏好缺省为 true
  （Node 注册表初值），Host 连上后推权威值。
- 测试：状态机 10 条（队首、两段计时、跨过期限、snooze 幂等、关/开偏好、冷种子、在途与放弃）、
  会话层 6 条（冷打开起表、可见转换、到期发 `ResolveInteraction` 且只发一次、snooze、偏好、侧栏摘要）。

与 Node 的两点已知差异（都不影响用户看到的倒计时）：

1. Node 把 `autoResolution` 写进 session entry（`user-input-auto-resolution:<interactionId>`）并在
   重新登记时按绝对时间续跑；Rust 的待答交互本来就不跨进程恢复（`SessionView.pending` 只来自
   活着的 actor），没有可续跑的绝对时间，冷打开从当下重新起表。进程内没有“关掉会话再打开还挂着
   提问”的路径（`session/close` 会取消待答交互），所以这只影响冷打开一个已经在等的会话。
2. Node 的 `UserInputAutoResolutionUpdated` 是会话事件；Rust 没有对 Host 暴露会话事件流，
   等价物就是 `state.updated` 的 `pendingInteractions` 整键（以及随之更新的 `sessions-index` 行）。

## 5. CUA 电脑操控（模型面与执行链已接回）

### 5.1 Node 的形状

- 模型面同样是 **`mcp__node_repl__js`** + `computer-use` 插件的 skill；`agent.computerUse.computer.*`
  经 `node-repl-host/src/cua-bridge.ts` → node_repl 进程内的 broker socket →
  `@nibi/cua` runtime → 本地 NDJSON → CUA Helper → `@trycua/cua-driver`。
- Host 不在动作链上：它只负责控制面（稳定 socket/recipe 注入、Helper 生命周期、权限 UI）。
- 公开仓的 `packages/zcode-cua` 是**占位实现**（`zcodeCuaPlaceholder: true`，调用返回
  `Computer Use is not available in this build.`）；真 Helper/runtime/engine 只在 NIBI 私有仓。
  上游 `zai-org/ZCode` 与 `MBearo/ZCode-rs` 当前树里的 `packages/zcode-cua` 也是同一个占位包，
  **CUA 实现至今没有公开**。

### 5.2 Rust 之前为什么是「没有」

- `kernel/crates/ext/src/plugins/select.rs` 把 `node-repl-host` / `browser-use` / `computer-use`
  整组按 `NodeRuntime` 跳过；
- Host 也没有把 `node_repl` 注入 Rust 会话；
- 结果模型在 Rust 下连 `js` 工具都看不到，CUA 与浏览器控制同时静默消失。

### 5.3 已落的接线

- 内核：`runtime/src/node_repl.rs` 按 Node bootstrap 的同一形状装配内置服务器：
  - 只从官方缓存的 `node-repl-host` 目录启动 `dist/mcp/server.js`；
  - `NIBI_PLUGIN_ROOT` / `NIBI_CUA_PLUGIN_ROOT` 指向对应插件；
  - CUA 凭据只按白名单复制（`NIBI_CUA_*` 12 个键 + `NIBI_CUA_NODE_REPL_HOST_ENV=1` +
    `NIBI_PLUGIN_ID=computer-use@nibi-official`），账号凭据（如 `NIBI_API_KEY`）不复制；
  - 缺 `NIBI_NODE_EXEC_PATH` 或缺插件时 fail-closed；bundle 缺失由 MCP 启动失败暴露
    （runtime 不直接碰文件系统，打包门禁负责在发布前断言 `dist/mcp/server.js` 存在）。
- 选择器：`NIBI_HOST_NODE_REPL=1` 时放行 `node-repl-host` 与 `computer-use`；
  `browser-use` 还要 `NIBI_HOST_BROWSER_BROKER=1`（见 §2）。
- Host：Rust 内核的 agent spawn env 带 `NIBI_HOST_NODE_REPL=1` + `NIBI_NODE_EXEC_PATH=<process.execPath>`
  （`packages/services/src/zcode-agent/nodeReplHostEnv.ts`）；Node 内核不读这两个变量。
- 测试：`runtime` 5 条（装配/白名单/fail-closed）、`ext` 2 条（插件准入）、Host 1 条（env 契约）。

### 5.4 CUA 操作事件（已补；permission-observation 不补）

- `Live::event` 按 Node `computer-use-operation-event.ts` 的同一映射发
  `computer-use/operation-event`：`TurnStarted` / `TurnFinished` → turn-started / completed / failed；
  `mcp__node_repl__js` 且 `input.code` 含 `setupComputerUseRuntime` 的 `ToolStarted` →
  tool-scheduled（`computerUse: true`）+ tool-started；`close_session` → session-closed。
  Host 的 `cuaOperationTurnTracker`（Windows 操作指示器 / macOS PiP）因此照常工作。
- `v4/cua/permission-observation` **不补**，因为在当前 node_repl 表面下 Node 的触发器本身不可达：
  normalizer 要求 tool result 的 display 是 `{kind:"cua", toolName:"request_access"}`，而
  `result-display.ts` 只在工具名含 `computer_use` 时才生成该分支；实际唯一的 CUA 工具是
  `mcp__node_repl__js`（display 是 `node_repl_images`），且 schema 硬编码 `platform:"darwin"`，
  也没有对应测试。真正的权限 UI 是 Host 的 `ICuaPermissionService`（`permission_status` 的
  accessibility/screenRecording/grantOwner + onboarding），与内核无关。

### 5.5 真实 Helper 验证（2026-11-07）

- 私有 sidecar 的 `packages/zcode-cua` 是完整实现（runtime/helper/engine），公开仓只是占位；
  本机原来私有 `node_modules` 指向已移动的旧路径，且缺 `@trycua/cua-driver-win32-x64-msvc`。
- 按私有仓的正式流程 overlay 到公开 checkout，`pnpm install --no-frozen-lockfile` 装上原生
  driver，重建 `node-repl-host` bundle；探针在 node_repl 进程里：
  - `list_apps` 返回真实桌面应用列表（ZCode / chrome / Notepad 等）；
  - `list_windows` 返回 ZCode 窗口（windowId/pid/bounds/isOnScreen）。
- 测完恢复公开占位包、`git checkout pnpm-lock.yaml`、`pnpm install --frozen-lockfile` 并重建
  bundle（hash 回到 `92301e78…`），公开仓不夹带私有代码。
- 结论：Rust 内核只负责启动同一个 `node_repl` 进程；Helper/engine 路径与 Node 完全相同，
  私有 producer 在就能用，公开构建照旧 fail-closed。

### 5.6 已知差异

- `computer-use/operation-event` 与 `v4/cua/permission-observation` 由 Node agent 的 v4 gateway
  发出；Rust 下 node_repl 是独立进程，内核收不到这些事件 → UI 的操作指示细节缺失。
  动作链不受影响。
- 公开构建里 CUA 仍然 fail-closed（占位 `@nibi/cua`），这与内核无关；只有私有 producer
  替换 `packages/zcode-cua` 后才是真正可用的 Computer Use。Rust 侧不再改变这条路径。

## 6. 订阅续传与背压（已补）

- Node：`conversation-topic-publisher.ts` 的有界日志（`eventRetentionPerSession: 2000`、`floorSeq`）、
  `subscribe`/`resync` 的 `base` 水位（`mode: "resume"`，重放 `(base.seq, current]`）、订阅缓冲上限
  （`subscriberBufferMaxOps: 500` / `subscriberBufferMaxBytes: 1 MiB`，溢出退化为快照），以及
  `v4-gateway.ts` 的 `setConnectionFlowState`（`saturated` 暂停、`drained` 恢复、`closed` 丢弃）。
- Rust：`protocol-core/src/delivery.rs` 的 `TopicLog` 保留最近 2000 个序号并维护 `floor`；
  `protocol-nibi/src/subscribe.rs` 认 `base`（`logEpoch` 匹配且在 `[floor, seq]` 内才续传）、
  `resync` 优先续传（`forceSnapshot` 一律快照）、`flow` 三态（暂停的连接位置不动，`drained` 后在会话泵/
  单写者里补齐）。落后出保留窗或超缓冲上限的订阅改发快照。
- 工作区主题（`sessions-index` / `workspace-config`）用 Node 同值的 512 帧保留窗；断档重发快照用的是
  首帧记住的存储行，不会丢只存在于存储里的会话。
- 测试：`protocol-core` 7 条（保留窗、续传、floor、空增量、暂停）、`protocol-nibi` 4 条（续传/代际不符/
  暂停恢复/closed）。

## 7. 钩子信任跨会话广播（已补）

- Node：`workspace/hooks/trustGrant` 成功后 `notifyWorkspaceHookTrustGrantSessions` 逐个会话
  `reloadTrust()`，重发 `WorkspaceHookAdmissionUpdated` → `state.updated.workspaceHookAdmission`。
- Rust：`hook_review::trust_grant` 回读确认后按工作区重算提示条，经每个同工作区会话的泵任务下发
  （`set_hook_admission` 自带按值去重）。Settings 的预信任没有会话上下文，这条广播补上了其余已打开会话。
- 测试：`a_grant_refreshes_the_banner_of_the_other_open_sessions_in_the_workspace`（含别的工作区不受影响）。

## 8. 会话启动偏好（已补）

- Node：会话物化时 `session/requestRuntimePreferences`（`runtime-materialization` 档，15 s），
  回答里有 AUQ 自动结束开关、附加工作目录、memory/工具搜索等。
- Rust：冷打开时问一次，应用本内核有会话级开关的两项（AUQ 自动结束、附加工作目录）；没有 Host 或
  对端不认识这个方法时回退到内核缺省（Node 对 `-32601`/`-32020` 的兼容回退同一姿态）。只有 Host 侧的
  stdio 服务打开这个请求（测试与纯 CLI 不打开，否则每次冷打开都要等一次超时）。
- 未建模的偏好（`memoryEnabled` / `toolSearchMode` / `subagentRuntimeConfigEnabled` /
  `nativeSearchEnhancementsEnabled`）在内核里没有会话级开关，不记一份永远不生效的偏好。
- 测试：`runtime_preferences` 3 条（应用、无 Host 回退、字段解析）。

## 9. 会话级 MCP

### 9.1 `isolation: "workspace"`（已补）

- Node：`pool.ts` 的 `connectionKey()` = `[serverName, scope, stableStringify(config)]`，
  scope 是 workspace key；`PoolEntry.refs` 引用计数，最后一个租约释放时关连接。
- Rust：`ext/src/mcp/sessions.rs` 的共享表按 `(工作区, 名字, 配置指纹)` 建连接，按会话引用计数；
  每个会话看到 `SessionConnections`（自己的 + 共享的合并视图：工具、状态、等待、进程/采样清单）。
  子代理仍继承父会话的连接面（不增引用）。telemetry 的 `mcpIsolation` 是 `workspace`。
- 测试：`ext` 9 条（各自的连接、共享一条、别的工作区不共享、引用计数释放、混合集合、子会话借用）。

### 9.2 `oauth` / `protocolVersion`（已补）

- **令牌端口**（Node 的 `AuthProvider`）：`kernel-api` 的 `McpOAuthPort`（`access_token` / `refresh`）由入口实现，
  `ext` 只做「取令牌 → `Authorization: Bearer` → 401 刷新一次再试」。`authorization_code` 的交互授权在桌面端做，
  内核按 Node 的键读共享凭据
  （`mcp:oauth:<sha256(名字
URL
clientId
scope
redirectPath)[0..24]>:authorization_credentials`）；
  `client_credentials` 自己发现授权服务器并用 `client_secret_basic` 换令牌，进程内缓存到临期（60 秒前）。
- **刷新写回**同一形状的 canonical 记录（`version: 2` + `token_type`，Node 的 reader 会校验它），保留原来的
  `issuer`；被拒的那枚不是当前记录里的那枚时不刷新（另一个进程已经换代）。
- **401**：连接与握手阶段刷新一次并重连；没有令牌端口时按 `oauth_authorization_failed` 报出来（不再跳过服务器）。
- **现代握手**：`auto`（缺省）先发 `server/discover`（带 `_meta` 信封）；结果有 `2026-07-28` 且 `capabilities`
  是对象时按现代建立连接（不再 `initialize`），之后每个请求与通知都带信封、服务器→客户端的请求丢掉、
  `mcp/list` 报 `protocolEra: "modern"`；任何 RPC 错误或形状不对都回退 2025 的 `initialize`。钉在
  `2026-07-28` 的服务器只认现代，协商不到时按 `protocol_negotiation_failed` 报出来。
- **stdio 探测**：老服务器可能不认识 `server/discover` 并就此退出——探测期间连接关闭时换一条新连接走 legacy
  （Node 用一次性的兄弟进程达到同一结论）。
- 测试：`ext` 7 条（Bearer 头、401 刷新一次、无端口时授权失败、现代不 `initialize` 且带信封、`-32601` 回退、
  钉版失败、版本默认值）、`nibi-platform` 7 条（发现链、两种 grant、刷新沿用 refresh token、键与 Node 逐字节一致）、
  `cli` 2 条（记录键、并发换代判定）。

## 10. NIBI 登录（已补）

- `kernel/crates/nibi-platform/src/device_flow.rs`：`Transport`（注入的 HTTP）+ `Client`
  （`start` / `poll` / `refresh` / `user_info` / `poll_until_ready`，设备码过期、拒绝、取消与 Node 同文案）。
- `nibi login`（`kernel/crates/cli/src/login.rs`）与 Node `login-command.ts` 同形状：只认
  `[--no-browser] [--json]`，打印 URL/短码 → 轮询 → 读资料 → 写共享凭据（`enc:v2`）→ 同步会员状态
  （失败只记警告）。退出清掉 NIBI 的五个键 + `active_provider`（只在这个值是 `nibi` 时）。
- `kernel/crates/cli/src/nibi_session.rs` 是共享凭据的读改写（目录锁 + 原子写 + v1 惰性迁移；损坏文件不覆盖）。
- 端点：`NIBI_AUTH_ORIGIN` 覆盖账号中心，API 根沿用 `NIBI_ENDPOINT_ORIGIN` 规则（默认
  `https://api.nibistudio.top/api/v1`）。
- 测试：`nibi-platform` 11 条（端点/表单、轮询、slow_down、过期、取消、刷新、资料）、`cli` 8 条单测 +
  4 条真实进程（登录写 v2 凭据与 license、JSON 形状、退出、用法错误）。
- Rust TUI 的 `/login`（`kernel/crates/cli/src/tui_account.rs`）走同一条 `device_login`：界面显示设备码与地址、
  浏览器由入口打开，`esc` 取消；`/logout` 同时清 provider 凭据与 NIBI 的五个键。登录视图只有一个方式（NIBI
  账号），会员同步失败的原因与「会员未知」一起显示；传输层失败会重试一次（4xx/5xx 不重试）。

## 11. TUI 调色板（已补）

- `apps/zcode-cli/packages/tui/src/theme/defaults.ts`：暗色品牌沙色 `#e8c491`、浅色暖橙 `#e08a3e`
  （浅色主题的文字类 token 用同色相加深的 `#a45a1e`，浅底对比度约 5:1），中性面换成 NIBI 的
  `#171716` / `#101011` / `#f9f2e4` 一系；语义色（error/warning/success/diff）不变。
- 验证：`@nibi/tui` 216 条测试、`tsc --noEmit`、`pnpm check:visual-brand`（9358 个文件）。

## 已知差异（写在这里，别在别处重复记）

1. `generateText` 的 token 不进会话用量。
2. 浏览器远程 workspace 的身份已带（identity 作 key）；topic 资源的已知差异见 §3.3。
3. AUQ 自动结束已实现（§4.1）；与 Node 的两点差异只剩「不持久化绝对时间」与「没有会话事件，
   用 `pendingInteractions` 增量表达」，都不影响倒计时。
4. CUA 的 `v4/cua/permission-observation` 在 Node 当前表面下也不可达，不算 Rust 缺口；
   `computer-use/operation-event` 已由 Rust 发出（§5.4）。
5. 更早的：`session/send` 对 video/file 附件 fail-closed；冷恢复不带 `additionalDirectories`。
6. 订阅续传已知差异：保留窗按「事件数」计（同 Node），`flush` 不合并同类增量（Node 会 coalesce）；
   工作区主题的断档快照用首帧记住的存储行。
7. **插件引用目录已补齐**（Host 只直答 17 条管理面方法，见
   `packages/desktop/src/host/localPluginManagementService.ts` 的注释）：`plugins/referenceCatalog` 与
   `plugins/referenceCatalogWithCategory`、`plugins/resolveSuggestedReference` 都在 Rust 内核实现
   （`protocol-nibi/src/plugin_catalog.rs`；身份目录由 `ext::Plugins::reference_catalog` 产出，商店展示字段由
   `platform::plugin_marketplace` 从官方分片与 `marketplaces/<id>/marketplace.json` 快照读取）。
   - **会话权威**：会话创建/冷恢复时把目录冻结在 `Ext`（`set_session_plugin_catalog`，子代理继承父会话）；
     不带 `sessionId` 时按当前配置现扫工作区（app-server 走 loader，CLI/TUI 走启动快照）。未知会话 fail closed。
   - **条目**：`pluginId` = `<manifest.name>@<marketplace>`，含停用条目（`enabled: false`，供
     `disabled_in_session` 诊断）、同名启用插件的 `conflictingPluginIds`、声明的
     `skillQualifiedNames` / `subagentNames` / `mcpServerNames`。停用条目也枚举它声明的 skill/agent 名。
     `rootPath` 不出协议；`category` 只有 `WithCategory` 变体返回（缺失回 `other`）。
   - **推荐插件解析**：只认 `@nibi-official` 的稳定 ID（其它来源回
     `plugin_suggested_reference_untrusted_source`）；已发现条目回 `ready` / `disabled` / `conflict`，
     目录里有但本机没装回 `missing` + listing（UI 据此走安装确认），都没有回
     `plugin_suggested_reference_not_listed`。
   - **已知差异（刻意）**：Node 在目录缺条目时会**联网刷新**官方目录（10 s 超时 + `plugins/operationProgress`
     的 `refreshing` 通知）。Rust 内核只读 Host 落盘的快照——插件市场与安装归 Host 的 17 条管理面，
     内核不写 Host 管的存储，也不伪造进度通知。代价：缓存过旧且插件刚发布时，推荐项会先回 `not_listed`
     （商店本身由 Host 刷新，不受影响）。`plugins/onDynamicPluginOperationProgress` 是客户端订阅通知的 API，
     不是内核方法；内核不发通知时不涉及。
   - `skills/referenceCatalog` 早在 `9ee7aa2e` 落地（会话权威取会话插件快照，否则现扫工作区，
     id 保持 Host 认的 `glm:<scope>:<path>`）。
8. `provider/testModelConnectivity` 已补（`model_connectivity.rs`：1 token 的探测请求，形状与 Node 一致）。
9. Rust TUI 的 `/login` 只有 NIBI 账号的 Device Flow（上游 `zai-coding-plan` / `bigmodel-coding-plan` 与
   手工 key 入口已删，模型走 `/provider`）；背景徽章是 NIBI 鸟的像素画，不再是上游的 Z 金属徽章。
10. Rust TUI 的 `/btw <问题>` 已实现（无会话的一次性旁路提问，`generate_text` + `QuerySource::Side("btw")`，
    答案单独成页、不进主对话、不占会话用量）；桌面版的 `/side`、`/btw` 是 App 层命令（`SessionPane` 注入、
    CLI catalog 过滤），不经内核，切内核不受影响。
11. 模型 Provider 的配置在 Rust CLI/TUI 里是一等流程：`/provider`（列表、详情、预设向导、换 key、设为默认、
    删除）与 `nibi provider list|show|path|add|key|remove|use` 都直接读写 `~/.nibi/v2/provider_config.json`
    （`kernel/crates/platform/src/providers/edit.rs`），预设取随包内置模板（DeepSeek/OpenAI/Anthropic/Kimi…），
    自定义端点按 schema 生成完整能力规则。新增的 Provider 会连同有效的 `options.reasoningLevel` 一起写成
    默认模型（Node 只认带档位的 `defaultModelSelection`）。

12. **Windows 上中文输入法（TUI 输入框）**：输入法确认候选/转换全角符号时，按下被输入法吃掉，控制台
    （Windows Terminal）仍把**抬起**送进输入流，crossterm 按抬起记录里的字符给出 `Char` + `Release`。
    `ui/keyboard.rs` 的 `Releases` 为 F65 的 alt 码把「没有配对的松开」当按下，于是每选一次词多一个空格、
    每打一个全角符号（`。`/`？`/`、`）多一个半角字符。现在只有**修饰键里还有 Alt**的未配对松开才是 alt 码
    （控制台把 alt 码的字符放在 Alt 的松开事件里），其余一律丢掉；「等不到松开的按下」加了上限（输入法提交
    的文字可能只有按下）。真正的字符都有配对的按下，不受影响。开发构建会记每个非字母数字按键的形状
    （`outcome: press|paired|mispaired-release|alt-code|stray-release`，正文文字不落日志）。
    仍开放的一层：crossterm 0.29 在 Windows 走 `ReadConsoleInputW`，没有 VT 解析器也没有 `9001`；如果还有
    输入法残留以**按下**的形式出现，就要做 Windows 专用输入源（`ENABLE_VIRTUAL_TERMINAL_INPUT` +
    `ESC[?9001h` + 自己解析 `CSI Vk;Sc;Uc;Kd;Cs;Rc _`，并接管粘贴/鼠标/resize）。非 Windows 不受影响。
    命令斜杠：输入法会把 `/` 换成别的字符——全角「／」（`848896e1`）以及 Microsoft/搜狗等换成顿号「、」；
    两者在输入框开头（空输入框、光标 0）都等同于命令斜杠，正文里的顿号不受影响。



## 12. Rust TUI 的顶栏与像素小鸟（品牌化）

`kernel/crates/tui/src/ui/draw.rs` + `ui/logo/`：

- **顶栏**（终端 ≥ 28 行、没有全屏浮层时）：9 行——`NIBI` 块字标 5 行（主色）、身份行 3 行
  （版本 / 模型·路径 / 权限模式）、最后一行整宽淡色 `─` 与正文分界。身份行不再进 transcript 布局
  （否则重复），并按「宽度 − 小鸟那 16 列」排版，路径过长时省略。低于 28 行时回到正文里的两行身份栏。
- **小鸟**：素材仓 `nibi-pixel-pet` 的 64×64 `idle` 帧（10 帧 2.4 秒），按 **2× 最近邻**编码成 Sixel
  （128×128 像素 ≈ 8 行）贴在栏的右端；透明像素显式填终端背景色（否则终端自己填的底色会和背景差一块）。
- **只有 Windows Terminal（`WT_SESSION`，1.22 起支持 Sixel）或 `NIBI_TUI_SIXEL=1` 才贴图**；其它终端
  （conhost、VS Code、SSH）栏照常在、只是没有鸟，`NIBI_TUI_SIXEL=0` 可强制对照。
- **默认静态**：终端解码 Sixel 在它自己的 UI 线程上，逐帧重贴会把整个终端拖慢（连输入法都迟）；
  `NIBI_TUI_PET_ANIM=1` 才播动画。
- 贴图后把终端光标显式移回输入框（`App::cursor_at` + `Screen::cursor_to`），否则鸟旁边会多一个光标。
- 早期试过的手绘字符鸟（`pack.rs`）已删除：把 64×64 素材等比缩小到 12–19 列都会糊，手画的小稿也不好，
  结论是**要么用图片协议放原图，要么不放**。

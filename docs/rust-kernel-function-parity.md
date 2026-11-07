# Rust 内核与 Node 的功能对照（切流前置）

> 目的：切默认内核的判据是「**功能不减**」，不是「协议 89/118」。这份表逐项记「Node 里由谁做、
> Rust 里由谁做、还差什么」，每行都带可查的代码位置。改动任何一项时同步更新本表。
>
> 最后复核：2026-11-07（`dev` `680a2364` + AUQ 自动结束：浏览器 broker/CUA 生命周期与 §4.1）。

## 结论摘要

| # | 功能 | 状态 |
| --- | --- | --- |
| 1 | 「生成提交信息」（`workspace/generateText` / `cancelGenerateText`） | ✅ **已补**（`277450ca`） |
| 2 | 浏览器控制 | ✅ **已接回**：`node_repl` MCP + Rust broker + `browser-use` 准入；逐轮 `turnEnded` 已发（§2） |
| 3 | topic 资源（bot 群话题上下文） | ⬜ 未做——见 §3 的数据流 |
| 4 | 运行时偏好协商 | ✅ 三项已核；AUQ 自动结束已按 Node 语义实现（§4.1） |
| 5 | CUA 电脑操控 | ✅ **模型面与执行链已接回，真实 Helper 验证通过**；⚠️ 两条 UI 通知差异见 §5 |

## 1. 生成提交信息（已补）

- Node：`GitActionMenu` → `gitService.generateCommitMessage` → `zcodeAgentService.ts:4781` 发
  `workspace/generateText`；CLI 侧 `core/runtime/methods/workspace-generate-text.ts` 做一次**无会话**
  模型请求（`querySource == "git_commit_message"` 走辅助档：最低推理档 + `min(5000, 模型上限)`）。
- Rust：`kernel-api::generate_text` + `runtime::generate_text`（同一个辅助档规则、60 s 期限）+
  `protocol-nibi::generate_text`（参数/结果映射、`operationId` 唯一、按 id 取消）。
- 已知差异：这一笔**不进会话用量**（Node 记 detached workspace 事实，内核没有对应表）。
- 测试：runtime 5（辅助档规则）、protocol 5（映射与容器语义）。

## 2. 浏览器控制（路线纠正，还差 broker）

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
- 剩余：远程 workspace 的 `workspaceIdentity` 还没带（broker 用路径作 `workspaceKey`）。
  逐轮 `turnEnded` 已在 `Live` 的 `TurnFinished` 后发出（`browser.rs::turn_ended`）。

## 3. topic 资源（未做）

- Node 的形状：bot 群会话的 `botGroupSource`（`botId`/`chatId`/`threadId`/`authorizationId` +
  `topicHistory`/`topicContext`）由 core 的 `session-context/topic-resource.ts` 经
  `topicResourcePort` → `topic/resource/read` 反向请求向 Host 读，再注入会话上下文。
- Rust：没有 `topicResourcePort` 的对应面，也没有 `topic/resource/read`。
- 可能的最短路径：Host 是数据所有者 → 在 `createSession` / `sendText` 的参数里带上话题上下文，
  内核把它作为上下文注入。需要 Host 与协议同时加字段（不是纯内核工作）。
- 现状：**未做**，先确认 bot 会话在 Rust 模式下是否真的会走到这条链（Bot 由 Host 驱动，
  见 `botsService`），再决定注入方式。

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

## 已知差异（写在这里，别在别处重复记）

1. `generateText` 的 token 不进会话用量。
2. 浏览器的远程 workspace `workspaceIdentity` 未带（路径作 key）；topic 资源未做（§3）。
3. AUQ 自动结束已实现（§4.1）；与 Node 的两点差异只剩「不持久化绝对时间」与「没有会话事件，
   用 `pendingInteractions` 增量表达」，都不影响倒计时。
4. CUA 的 `v4/cua/permission-observation` 在 Node 当前表面下也不可达，不算 Rust 缺口；
   `computer-use/operation-event` 已由 Rust 发出（§5.4）。
5. 更早的：`session/send` 对 video/file 附件 fail-closed；冷恢复不带 `additionalDirectories`。

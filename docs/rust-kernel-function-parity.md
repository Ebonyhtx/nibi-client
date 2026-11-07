# Rust 内核与 Node 的功能对照（切流前置）

> 目的：切默认内核的判据是「**功能不减**」，不是「协议 89/118」。这份表逐项记「Node 里由谁做、
> Rust 里由谁做、还差什么」，每行都带可查的代码位置。改动任何一项时同步更新本表。
>
> 最后复核：2026-11-07（`dev` `ed71f30e` 之后：CUA / 浏览器控制的路线纠正与 `node_repl` 落地）。

## 结论摘要

| # | 功能 | 状态 |
| --- | --- | --- |
| 1 | 「生成提交信息」（`workspace/generateText` / `cancelGenerateText`） | ✅ **已补**（`277450ca`） |
| 2 | 浏览器控制 | 🟡 **路线纠正**：Node 的模型面是 `node_repl` MCP，不是内置工具；Rust 侧还差 broker（§2） |
| 3 | topic 资源（bot 群话题上下文） | ⬜ 未做——见 §3 的数据流 |
| 4 | 运行时偏好协商 | ✅ 三项已核：两项等价、一项（AUQ 自动结束）差异见 §4 |
| 5 | CUA 电脑操控 | ✅ **模型面与执行链已接回**；⚠️ 两条 UI 通知差异见 §5 |

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

### 2.2 Rust 现状与剩余工作

- 内核已能装配内置 `node_repl`：`kernel/crates/runtime/src/node_repl.rs`，从官方插件缓存的
  `node-repl-host` 目录启动 `dist/mcp/server.js`，`alwaysLoad`、`isolation: workspace`、600 s。
- `browser-use` 的 skill **还没有放行**：选择器只在 Host 同时提供 broker socket 时放行
  （`NIBI_HOST_BROWSER_BROKER=1`，`select.rs` 的 `node_dependency`）。只有 skill 没有执行面
  比没有更糟，所以先保持跳过。
- 还差的东西只有一个：**Rust 侧的 broker socket**（NDJSON + token，把 `list`/`execute` 转成
  `interaction/browser*` 反向请求；`Peer::request` 已有，`headers.rs` 是同款模板），以及
  turn 结束/会话关闭时的 `turnEnded` / `closeSession` 生命周期命令。
- 选定路线：**内核实现 broker**（和 Node 一样，agent 进程own 它）。Host 直接服务 broker 会绕开
  内核的会话/子会话归属判断（`forChildSession`），不选。

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
| `askUserQuestionAutoResolutionEnabled` | 同上 + `workspace/updateInteractionPreferences` | 只记录偏好并回声（`server.rs`），**没有自动结束** | ⚠️ 差异：AUQ 不会自动结束 |

- 投递不是问题：Host 在 workspace client 建好后会推 `updateInteractionPreferences`
  （`zcodeAgentService.ts:2906-2915`），值能到内核。
- 真正的差异是**行为**：Node 的 CLI 侧有一个交互注册表（`nibi-protocol-v4/interaction-registry.ts`），
  对 AUQ 在 60 s 隐藏宽限 + 300 s 倒计时后自动 snooze 并持久化；Rust 协议层没有这套注册表，
  AUQ 会一直挂着等回答。
- 为什么这次没补：它是 CLI 侧的交互生命周期子系统（计时器 + snooze + 会话条目持久化 + 恢复 +
  事件 `UserInputAutoResolutionUpdated` + UI 倒计时状态），不是「补一个方法」；半套实现会让 UI
  拿到不完整的倒计时状态，比没有更糟。**单独一批做**，做的时候按上面的注册表逐条对齐。

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
  真实探针：用缓存里的 `node-repl-host/0.6.1` 启动 MCP，`tools: ["js"]`，JS 里
  `{"cua":"object","browser":"object"}`（两个 bridge 都在）。

### 5.4 已知差异

- `computer-use/operation-event` 与 `v4/cua/permission-observation` 由 Node agent 的 v4 gateway
  发出；Rust 下 node_repl 是独立进程，内核收不到这些事件 → UI 的操作指示细节缺失。
  动作链不受影响。
- 公开构建里 CUA 仍然 fail-closed（占位 `@nibi/cua`），这与内核无关；只有私有 producer
  替换 `packages/zcode-cua` 后才是真正可用的 Computer Use。Rust 侧不再改变这条路径。

## 已知差异（写在这里，别在别处重复记）

1. `generateText` 的 token 不进会话用量。
2. 浏览器控制的 Rust broker 未实现（§2）；topic 资源未做（§3）。
3. AUQ 自动结束未做（§4）。
4. CUA 的两条 UI 通知未发（§5.4）。
5. 更早的：`session/send` 对 video/file 附件 fail-closed；冷恢复不带 `additionalDirectories`。

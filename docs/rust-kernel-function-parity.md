# Rust 内核与 Node 的功能对照（切流前置）

> 目的：切默认内核的判据是「**功能不减**」，不是「协议 89/118」。这份表逐项记「Node 里由谁做、
> Rust 里由谁做、还差什么」，每行都带可查的代码位置。改动任何一项时同步更新本表。
>
> 最后复核：2026-11-07（`dev` `277450ca`）。

## 结论摘要

| # | 功能 | 状态 |
| --- | --- | --- |
| 1 | 「生成提交信息」（`workspace/generateText` / `cancelGenerateText`） | ✅ **已补**（`277450ca`） |
| 2 | 浏览器控制（模型工具） | ⬜ 未做——见 §2 的路线选择 |
| 3 | topic 资源（bot 群话题上下文） | ⬜ 未做——见 §3 的数据流 |
| 4 | 运行时偏好协商 | ✅ 三项已核：两项等价、一项（AUQ 自动结束）差异见 §4 |

## 1. 生成提交信息（已补）

- Node：`GitActionMenu` → `gitService.generateCommitMessage` → `zcodeAgentService.ts:4781` 发
  `workspace/generateText`；CLI 侧 `core/runtime/methods/workspace-generate-text.ts` 做一次**无会话**
  模型请求（`querySource == "git_commit_message"` 走辅助档：最低推理档 + `min(5000, 模型上限)`）。
- Rust：`kernel-api::generate_text` + `runtime::generate_text`（同一个辅助档规则、60 s 期限）+
  `protocol-nibi::generate_text`（参数/结果映射、`operationId` 唯一、按 id 取消）。
- 已知差异：这一笔**不进会话用量**（Node 记 detached workspace 事实，内核没有对应表）。
- 测试：runtime 5（辅助档规则）、protocol 5（映射与容器语义）。

## 2. 浏览器控制（未做）

- Node 的形状：agent 内置浏览器工具 → `interaction/browserList` / `browserExecute` 反向请求 →
  Host 的 executor（`desktop/src/host/index.ts:3539`，WebContentsView / CDP）执行 → 结果回模型。
- Rust：内核**没有这套工具**（`kernel/crates` 里没有浏览器能力面），也不发那两个反向请求。
- 两条可行路线：
  1. **Host 提供 MCP server**（推荐）：内核已支持 session MCP（stdio/http、session/workspace 隔离，
     `SessionMcpServer`），Host 把 executor 包成一个 MCP server 注册进会话，模型照常调用
     `mcp__browser__*`。代价：工具名从内置变成 `mcp__…`，提示词/权限/UI 里对工具名的判断要同步。
  2. **移植内置工具**：在 Rust 内核里实现工具表 + 反向请求通道（参考 `headers.rs` 的请求/等待机制），
     工具名保持不变。代价更高，且要维护两套浏览器工具。
- 现状：**未选**。选定后按上面任一条落地。

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

## 已知差异（写在这里，别在别处重复记）

1. `generateText` 的 token 不进会话用量。
2. 浏览器控制、topic 资源未做（§2、§3）。
3. AUQ 自动结束未做（§4）。
4. 更早的：`session/send` 对 video/file 附件 fail-closed；冷恢复不带 `additionalDirectories`。

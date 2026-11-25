# 插件 Hooks 兼容规范

## 背景

ZCode 已经支持官方插件、inline 插件、skills、commands、MCP server 和插件级 hooks。以 `superpowers` 为代表的现有插件通常把启动上下文注入写在 `hooks/hooks.json`，并使用 shell command hook、插件根目录变量和 `SessionStart` 的 `additionalContext` 输出。

本规范定义 NIBI 对插件 hooks 的兼容边界，目标是让根 `plugin.json` 插件成为一等形态，同时按适配器只读兼容 Claude / Codex / ZCode 插件 manifest。

## Manifest 发现顺序

插件根目录按适配器特异性读取，写入永远只写根 `plugin.json`：

1. 根 `plugin.json`（Agent Plugins / NIBI 原生；带 `extensions["com.nibistudio.nibi"]` 时是 native，带 Codex 扩展时是 codex，否则是通用 agent-plugins）
2. `.claude-plugin/plugin.json`
3. `.codex-plugin/plugin.json`
4. `.zcode-plugin/plugin.json`

外来目录只读，不复制、不改写、不重签；App 管理的缓存也不再做一次性迁移。命中的清单解析失败
就是终态，不退回特异性更低的清单。这个规则用于读取插件元数据、skills / commands / MCP / hooks
声明和插件 id。

## Hooks 发现

启用插件后，ZCode 在插件发现阶段收集插件 hooks，并把它们合并进 runtime hooks：

### 信任边界

- 插件 Hook 与插件本身共用启停状态；禁用插件后，新 session 不再注入其 Hook，设置页仍只读展示声明。
- 当前已启用的第三方 marketplace 插件与官方插件一样可执行 `command` shell Hook，且子进程继承
  Agent 进程环境。这意味着“启用插件”同时授予其执行本地命令和读取继承环境变量的能力。
- 当前版本没有独立的 Hook trust 开关或逐插件 Hook 授权。安装来源、插件代码审查和插件启停是
  现有安全边界；后续若引入 workspace trust，必须在 runtime 注入前统一拦截，不能只在设置页隐藏。

- 自动读取标准位置 `hooks/hooks.json`。
- 读取 manifest 中的 `hooks` 字段作为补充；支持相对 JSON 文件路径、inline hooks 对象或二者数组。
- `hooks/hooks.json` 使用 `{ "description"?: string, "hooks": { ... } }` 包装结构。
- manifest inline hooks 直接使用 `{ "SessionStart": [...] }` 结构。
- 标准 `hooks/hooks.json` 自动加载；manifest 不应重复指向同一个文件，重复时记录诊断并跳过。

插件 hooks 只在插件启用后进入 runtime。用户/项目 hooks 先执行，插件 hooks 后执行。不同插件的 hook 去重必须带上插件根目录，避免多个插件使用 `${NIBI_PLUGIN_ROOT}` 或 `${CLAUDE_PLUGIN_ROOT}` 模板时互相覆盖。

### 事件集合与「会不会触发」

- 插件清单可声明 **33 个事件**（与内核 `HookEventName` 同序同名）：PreToolUse、PostToolUse、
  PostToolUseFailure、PostToolBatch、Notification、UserPromptSubmit、UserPromptExpansion、SessionStart、
  SessionEnd、Stop、StopFailure、SubagentStart、SubagentStop、PreCompact、PostCompact、PreModelSwitch、
  PostModelSwitch、PermissionRequest、PermissionDenied、Setup、TeammateIdle、TaskCreated、TaskCompleted、
  Elicitation、ElicitationResult、ConfigChange、WorktreeCreate、WorktreeRemove、InstructionsLoaded、
  CwdChanged、FileChanged、DirectoryAdded、MessageDisplay。
- 其中 **14 个有 producer**，会真正派发：PreToolUse、PostToolUse、PostToolUseFailure、Notification、
  UserPromptSubmit、SessionStart、SessionEnd、Stop、SubagentStop、PreCompact、PostCompact、
  PermissionRequest、Elicitation、ElicitationResult。
- 其余 **19 个只有枚举与 matcher 语义**：清单可以声明，但永远不会触发。适配器必须在
  `hookDetails` 里给出 `runnable: false`，并记 `plugin_hook_unsupported_event` 诊断，不能假装已接线。
- Workspace hook（`nibi.json` / `.nibi/config.json`）仍然只认 7 个事件：SessionStart、
  UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop。
  它的 digest、trust、review 记录都没变；插件事件走独立命名空间。
- 未知事件名（不在 33 个里）记录 warning 并丢弃，不阻断插件加载。

### PreCompact 的 block 策略

- **手动压缩**：PreCompact hook 返回 block 时中止压缩，把 hook 给的 reason 原样返回给用户。
- **自动 / 反应式压缩**：忽略 block，继续压缩。被拦的 hook 不贡献 `custom_instructions`；
  其他成功 hook 的指令照常采用，用户自己的压缩说明优先保留。
- 原因：自动压缩发生在上下文已经接近上限时，让 hook 拦下会把「压缩失败」变成「请求失败」。

## Hook 类型

ZCode 保留现有 `process` hook，并新增兼容 `command` hook：

- `process`：argv 形式，`command` 是可执行文件，`args` 是参数数组。
- `command`：shell string 形式，`command` 交给系统 shell 执行。

`command` hook 支持字段：

- `command: string`
- `timeout?: number`，单位秒，兼容 Claude hook 配置。
- `timeoutMs?: number`，单位毫秒，ZCode 内部优先使用。
- `statusMessage?: string`
- `async?: boolean`

`async: true` 使用 fire-and-forget 语义：runtime 启动命令后立即继续，不读取其 stdout 决策，
因此后台 hook 不能阻断、修改工具输入或注入上下文；完成和失败仍发出 hook lifecycle event。

## 插件变量

插件 hook 子进程注入以下环境变量：

- `NIBI_PLUGIN_ROOT`：当前插件安装根目录。
- `NIBI_PLUGIN_DATA`：当前插件持久化数据目录。
- `NIBI_PLUGIN_ID`：`<name>@<marketplace>`。
- `NIBI_PLUGIN_NAME`：插件 manifest name。

为兼容现有插件，同时只读映射：

- `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`
- `ZCODE_PLUGIN_ROOT` / `ZCODE_PLUGIN_DATA`

命令字符串与 MCP 配置中的 `${NIBI_PLUGIN_ROOT}`、`${NIBI_PLUGIN_DATA}`、`${CLAUDE_PLUGIN_ROOT}`、
`${CLAUDE_PLUGIN_DATA}`、`${ZCODE_PLUGIN_ROOT}`、`${ZCODE_PLUGIN_DATA}` 在执行前替换为对应路径。
`${CLAUDE_PROJECT_DIR}` / `${ZCODE_PROJECT_DIR}` 映射到当前工作区。替换值来自插件发现阶段解析出的
root / data path 与当前 workspace，不从用户环境读取。

## Hook stdin 兼容字段

ZCode runtime 内部继续使用 camelCase `HookInput` 作为主契约；插件 hook 子进程收到的
stdin 必须额外带上 Claude Marketplace 常用 snake_case alias，保证只读旧字段的脚本可
以运行，同时不破坏 ZCode 自身字段：

| ZCode 字段       | Claude 兼容 alias | 适用事件                                                                  | 说明                                      |
| ---------------- | ----------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| `hookEventName`  | `hook_event_name` | 全部事件                                                                  | 已有兼容字段，继续保留。                  |
| `sessionId`      | `session_id`      | 全部事件                                                                  | 已有兼容字段，继续保留。                  |
| `toolName`       | `tool_name`       | `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` | 无损 alias。                              |
| `toolInput`      | `tool_input`      | `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` | 无损 alias，保持原始输入结构。            |
| `toolCallId`     | `tool_use_id`     | `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` | 无损 alias，使用当前 ZCode tool call id。 |
| `toolResponse`   | `tool_response`   | `PostToolUse`                                                             | 成功工具的完整结构化输出。                |
| `isInterrupt`    | `is_interrupt`    | `PostToolUseFailure`                                                      | 标记错误是否由中断产生。                  |
| `transcriptPath` | `transcript_path` | 全部事件                                                                  | 当前 session 的临时 transcript 文件路径。 |

`PostToolUse` 同时保留 ZCode 的 `toolResultPreview`，但 Claude 兼容脚本必须读取完整
`tool_response`；preview 不能替代完整结构化结果。`PostToolUseFailure.error` 对外固定为字符串。

## Hook 输出

ZCode 继续支持标准 `hookSpecificOutput`：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "..."
  }
}
```

为兼容其他插件运行时，同时接受：

- top-level `additionalContext`
- Cursor hooks 输出格式的 `additional_context`

这两个字段会被归一化为当前 hook event 的 `additionalContext`，再注入到 runtime 的 `hook_context` system reminder。

## Claude Code 工具兼容

ZCode 兼容 Claude Code 插件时，工具名转换必须落在结构化 runtime 层，而不是给单个插件追加提示文本：

- `Task` 作为 Claude Code 兼容工具名暴露，底层委托 ZCode `Agent` subagent handler；两者共享 schema、权限能力、结果预算和后台任务语义。
- 未配置 subagent port 时，`Agent` 与 `Task` 都不注册；子 agent 禁止递归 subagent 时，`Agent` 与 `Task` 都从可用工具列表中过滤。
- tool hook stdin 中的 `toolName` 保持实际工具名；hook matcher 使用兼容 alias 匹配，`Agent` 可命中 `Task` matcher，`Task` 也可命中 `Agent` matcher。
- 若 `ApplyPatch` 重新启用，hook matcher 可兼容 Claude Code 插件的 `Write` / `Edit` matcher，但不改变实际 toolName。

Subagent 兼容的完整边界见 `docs/subagent-compatibility.md`。

## 内置 Superpowers

`superpowers` 作为官方内置插件发布：

- 使用根 `plugin.json`（NIBI 组件在 `extensions["com.nibistudio.nibi"]`）作为主 manifest。
- 默认关闭；用户显式启用后才向 runtime 注入 skills/hooks。
- 提供 `skills/` 与 `hooks/hooks.json`。
- `SessionStart` hook 在 `startup|clear|compact` 时注入 `using-superpowers` 上下文。
- ZCode 不对 Superpowers `SessionStart` 输出追加专用工具映射；`Task` / `Agent` 兼容由通用工具注册与 hook matcher alias 层负责，因此外部 `.claude-plugin` 形态的 Superpowers 不需要修改原插件文件。

Superpowers 的 plugin skills 同时支持裸名和 fully qualified alias。模型上下文优先展示 `superpowers:<skill>`，裸名只作为兼容 alias 保留。

官方插件打包路径必须同时覆盖 CLI SEA 和 Electron desktop runtime bundle，管理页与 runtime 的默认启用策略保持一致。
官方插件 seed 到用户缓存时必须保留 executable bit；`hooks/` 下的可执行 wrapper/script 不能被落盘成 `0644`，否则 macOS/Linux 会在 `SessionStart` 直接执行时报 `permission denied`。

## 验证

实现完成后必须覆盖：

- 根 `plugin.json` 与三种外来清单按特异性发现；外来目录只读且不改写。
- 33 个插件事件可声明；14 个 runnable 进入 runtime；19 个 enum-only 事件详情标 `runnable: false` 且不注入。
- Workspace 7 事件的 digest / trust / review 不变。
- PreCompact 手动 block 中止压缩；自动/反应式忽略 block 并继续。
- `hooks/hooks.json` 自动加载。
- manifest `hooks` 文件和 inline hooks 合并。
- `command` hook 通过 shell 执行，并收到 ZCode / Claude 兼容环境变量。
- `SessionStart` 的 `additionalContext` 注入到 `hook_context`。
- `Task` 工具作为 Claude Code 兼容 alias 可调度 ZCode subagent。
- `Agent` / `Task` hook matcher alias 互通，hook input 保留实际工具名。
- `superpowers` official plugin 默认关闭；显式启用后暴露 skills/hooks。
- `Skill(skill="superpowers:test-driven-development")` 可加载 Superpowers 技能，裸名仍可用。
- Superpowers `SessionStart` 不再被注入专用 ZCode 工具映射。
- official plugin 缓存中的 `hooks/run-hook.cmd` 等 hook wrapper 保持可执行。
- `pnpm typecheck`
- `pnpm lint`

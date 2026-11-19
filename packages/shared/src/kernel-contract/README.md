# kernel-contract

Rust 内核与 Node 内核的共享契约目录。目标：同一件事实只定义一次，两侧引用/镜像并用门禁防漂移；不允许“Rust 一份、Node 一份，靠回忆对齐”。

## 现有产物

| 文件 | 作用 | 消费者 / 门禁 |
|---|---|---|
| `project-config.keys.json` | 项目级配置（`nibi.json`、`.nibi/config.json`）允许键的 canonical 清单 | Node `project-config.adapter.ts`、Rust `config/project_scope.rs`；两侧各有 conformance 测试核对本 JSON |
| `capabilities.json` | 双内核能力单侧例外（`persona.budget.webSearch`、CLI 内存诊断、扩展宿主、远端 agent）与双实现登记（Prompt 快照）；X02 的工具/错误码单侧例外也登记在这里（`tool.*`、`errorCode.*`、`permission.nodeCategories`） | `scripts/check-kernel-capabilities.mjs`、`scripts/check-dual-kernel-parity.mjs`；UI/文档据此显示“当前内核不支持” |
| `tool-parity.json` | X02 canonical 工具/权限名/错误码清单：每个工具一条（`name`、`side`、只读、需审批、Node 权限分类、Rust `check_permissions` 探针）；`sessionControl` 登记会话控制的 12 个权限名、双内核结果码、来源归属与归档目标策略 | Node `apps/nibi-cli/packages/core/tests/tool-parity.test.ts`；Rust `kernel/crates/tools/src/parity_tests.rs`；`scripts/check-dual-kernel-parity.mjs` |

## 规则

1. **默认双内核**：用户可见的工具名、权限名、错误码、结果预算、会话状态语义必须两侧一致。
2. **单侧例外必须登记**：只有 V8 / DWF / 远端 / Host 专用能力允许单侧；登记表里写明 side 与 reason，未登记的分叉视为缺陷。
3. **先契约后实现**：新增工具/权限/错误码时先改这里，再改两个内核；不要先写一侧再“有空补另一侧”。
4. **门禁必须能失败**：新增核对脚本时要用变异夹具或单测证明它会红，不能只打印 PASS。

## X02 覆盖口径（2026-11-18）

**覆盖计数**：41 个工具（`both` 31 / Node 单侧 4 / Rust 单侧 6；Node 覆盖 35、Rust 覆盖 37）、36 个 Node 权限分类名、29 个错误码（`both` 3 / Node 单侧 24 / Rust 单侧 2）、7 条跨层排除项、17 条单侧例外登记。

两侧枚举来源：

- **Node**：`apps/nibi-cli/packages/core/src/tool/handlers/index.ts` 的 `builtInTools` 静态清单。运行时条件注册（`includeAgent`、`includeDynamicWorkflow` 等）只会裁剪这份清单，不会引入新名字。权限名取每个 `ToolEntry.permission.permission`。
- **Rust**：`kernel/crates/tools` 能静态构造的内置工具注册表，按 runtime 的组装顺序调用 `file_tools`、`BashTool`、`interaction_tools`、`web_tools`、`cron_tools_with`、`authoring_tools`、`worktree_tools`、`topic_tools` 等工厂，再经 `BuiltinTools` 暴露；TodoRead / TodoWrite 由 `nibi-kernel-agents` 注册，测试把这两层的工具实例合并枚举。测试显式 `with_search_opt_in(true)`，让 Glob/Grep 在 Bash 在场时也进入枚举（Bash 遮蔽 Glob/Grep 的暴露规则不是 X02 的判据）。只读取 `Tool::is_read_only`（Bash 用带写副作用的探针命令）；“需审批”取 `Tool::check_permissions` 在默认模式下对空入参是否返回 `Ask`（`rustAsks`），与 Node 的静态 `needsApproval` 是两套架构，不强行等价。
- **错误码**：Node 取 `CoreErrorType` 全量值；Rust 取 `ToolError` 枚举的穷尽映射（新增变体会让测试编译失败）。三个共享语义在 JSON 里显式写映射：`invalid_input`、`tool_cancelled`（Rust `cancelled`）、`tool_execution_failed`（Rust `failed`）。

**排除项（不假装全量）**：

- `Agent`、`Task`、`SendMessage`、`TaskStop`、`Skill`、`submit_result`、`escalate`：Node 在 `builtInTools`，Rust 由 `nibi-kernel-agents` / `nibi-kernel-ext` 在运行时组装，不在 `nibi-kernel-tools` 层。它们的对拍需要跨 crate 组装，留给后续门禁。
- 动态 MCP 工具、插件工具、`UserInputTools`（端口而非模型可见 Tool）不在本清单。
- Node 的 `ApplyPatch`、`GoalRead`、legacy `Workflow` 处理器当前没有注册进 `builtInTools`，因此不在 canonical 里；哪天注册会被 Node 测试的“unexpected tool”判红。

**已知差异（canonical 显式锁定，改动任一侧会红）**：

- `EnterPlanMode`：Node `readOnly=false`，Rust `is_read_only=true`（Node 把计划模式切换算状态变更，Rust 只看工作区副作用）。
- `FillWorkflowHole`：Node `alwaysAsk=true`，Rust `check_permissions` 返回 `Allow`，且不在 policy crate 的 `ALWAYS_ASK_TOOLS`。
- `NotebookEdit` / `Monitor` / `ReportFindings` / `ScheduleWakeup` / worktree 两个工具：Rust 有，Node `builtInTools` 没有。

## 门禁用法

```bash
pnpm run check:dual-kernel-parity          # 结构 + 计数 + 例外登记
node scripts/check-dual-kernel-parity.mjs --json
pnpm --dir apps/nibi-cli/packages/core exec vitest run tests/tool-parity.test.ts
cargo test -p nibi-kernel-tools parity_tests
```

`scripts/check-dual-kernel-parity.mjs` 只读 JSON，能放进无需 `pnpm install` 的 policy job；活注册表的逐项比较由上面两个测试执行。三处都有 mutation 用例：删工具、翻 `readOnly`/`rustAsks`、登记未引用的例外、把 Node 单侧工具标成 both 等，均已验证会红。

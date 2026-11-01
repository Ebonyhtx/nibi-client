# 内核资源基线报告（Step 4，2026-11-01，44 栈）

> 依据《NIBI-大改造与安全修复与品牌化执行计划》§7.2 Step 4：在最终 Node/Electron 栈上
> 测量"改造前"数字。**只测量，不改运行时参数**——未设置 --max-old-space-size、未改任何
> GC/回收策略、未写真实 ~/.nibi（隔离覆盖全部五个根变量）。
>
> 测量机器：`scripts/kernel-baseline/collect-kernel-baseline.mjs`（agent / attach / inventory
> 三模式，可复跑）+ memory-sampler.cjs（NODE_OPTIONS=--require 预加载，只读）+
> sample-process-tree.ps1（进程树按角色采样）。

## 0. 栈版本

| 项 | 值 |
|---|---|
| 仓库 | `Ebonyhtx/nibi-client` main（本地 `441c2ecf`，未 push） |
| Node（构建机/系统） | v24.22.2（FIX-3） |
| Node（仓钉定/SEA 基底） | 24.22.1（FIX-4） |
| Electron | 44.10.1（FIX-5） |
| pnpm | 10.33.2 |
| 平台 | win32/x64，内存见 inventory |

## 1. 现状值（运行参数盘点，inventory 模式；源码锚点见 `.artifacts/kernel-baseline/inventory-*/inventory.json`）

| 参数 | 现值 | 锚点 |
|---|---|---|
| Agent `--max-old-space-size` | **未注入**（V8 缺省，实测 heap_size_limit 4288 MiB） | agentSpawnEnv |
| 主 Agent 空闲回收 | **未设置**（idleTimeoutMs 选项注入、缺省不超时） | agentProcessManager |
| MCP status lane 空闲超时 | 300 000 ms | zcodeAgentService.ts:380,1089 |
| DWF 子进程堆上限 | 256 MiB | harness.ts:122 |
| v4 工具输出预算 | head 32 KiB / tail 32 KiB | nibi-protocol-v4/core.ts:77-78 |
| workspace hook 输出预算 | 32 KiB | workspace-hook-config.ts:8 |

## 2. Agent 无头基线（agent 模式；假 provider 立即回，5 runs）

| 指标 | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| spawn → 首条 stdout (ms) | 2354 | 2390 | 2505 | 2505 |
| spawn → 首条事件 (ms) | 2352 | 2388 | 2504 | 2504 |
| spawn → 首个流式事件 (ms) | 3489 | 3524 | 3626 | 3626 |
| spawn → turn.completed (ms) | 3537 | 3575 | 3678 | 3678 |
| spawn → 进程退出 (ms) | 3742 | 3776 | 3892 | 3892 |
| 峰值 RSS (MiB) | 422.9 | 423.2 | 423.9 | 423.9 |
| 首段文本时 RSS (MiB) | 138.8 | 414.9 | 416.7 | 416.7 |

数据：`.artifacts/kernel-baseline/agent-2026-11-01T06-43-06-005Z/`（summary.md + 原始采样）。

**诚实注记**：假 provider 立即返回，首段文本时间主要反映内核/进程启动开销，不是真实
模型的首字延迟；单回合探针的 RSS 峰值含启动开销，长任务增长必须看下面的场景测量。

## 3. 未验证项（Step 4 的剩余工作）

| 项 | 状态 | 计划 |
|---|---|---|
| Electron 进程树 attach（Host/renderer/Agent/MCP 按角色 RSS/私有内存时间序列） | 未跑 | 与 FIX-5 真机矩阵合并执行：运营者真机跑应用时挂采样器 |
| 场景 A：长会话 + compact（上下文增长曲线、GC 停顿、compact 后回落） | 未跑 | agent-server stdio 驱动（假 provider，扩展 collector） |
| 场景 B：MCP 重载（node_repl/插件 MCP 子进程树增量） | 未跑 | 同上 + fake-mcp-server.mjs |
| 场景 C：DWF（引擎+沙箱子进程增量） | 未跑 | 同上（DWF 夹具已在 kernel-baseline） |
| 真实 provider 首字延迟 | 未跑 | 依赖真实 provider 配置，切流前单独测 |

# NIBI 内核阶段 0：资源基线报告（2026-10-29，Node 内核）

> 口径：只测量，不改运行时参数。默认 `NIBI_KERNEL=node`，本报告不引入任何 Rust 默认路径。
> 采集脚本：`scripts/kernel-baseline/collect-kernel-baseline.mjs`（agent / attach / inventory 三个子命令）。
> 原始数据：`NIBI-Client/.artifacts/kernel-baseline/agent-2026-10-29b/`（不入库，`.artifacts/` 已忽略）。

## 1. 环境与基线

| 项 | 值 |
|---|---|
| NIBI-Client HEAD | `4725ab6`（工作树在采集时干净） |
| NIBI-Site HEAD | `62976f6` |
| ZCode-rs pin | `6d349ed4`（0.1.67，build 67） |
| 本机系统 Node | **v24.19.0**（FIX-3 系统级未执行；本轮用便携版 Node 24.22.1 跑构建/测试） |
| 仓库钉定 Node | **24.22.1**（FIX-4 已执行，`24da6653`）；Server CLI 运行时 **22.23.4** |
| Electron | **41.0.3**（FIX-5 目标 44.9.3 未执行） |
| Rust 工具链 | cargo/rustc **1.97.1**（上游 rust-version 1.95） |
| 平台 | win32/x64；内存 32 GiB 量级（`os.totalmem()` 实测） |
| 采集时间 | 2026-10-29 22:35 +08 |

**FIX 前置状态（如实记录，影响基线可比性）**：

- FIX-3 **系统级未执行**：本机 MSI Node 仍 24.19.0；仓库构建/测试改用便携版 24.22.1。
- FIX-4 **已执行**（`24da6653`）：mise/.nvmrc/CLI engines/CI 四处、Server CLI `22.23.4`、Dockerfile、测试夹具、third-party 许可证登记全部同步。
- FIX-5 未执行：Electron 41.0.3。
- FIX-6 未执行，且本轮禁止改生产/动服务器，无法在本机完成。
- FIX-10a 未执行：`.github/workflows/` 只有 `client-gates.yml`、`desktop-e2e.yml`，没有 `rust-gates.yml`。

因此本报告是**临时基线**：按 Rust 规划 §6.1 第 1 条，FIX-5 合入后必须重跑；届时 Node/Electron 版本会改变内存与启动特征。

## 2. 方法

`agent` 子命令每次运行：

1. 在 `<out>/agent/run-XX/home` 建一个完整隔离 HOME；
2. 同时设置 `USERPROFILE`、`HOME`、`NIBI_DATA_BASE_DIR`、`NIBI_STORAGE_DIR`、`NIBI_SETTINGS_DIR`；
3. 在隔离 `.nibi/v2/provider_config.json` 写一个合法的 personal provider（`openai-chat-completions`），指向 127.0.0.1 的假 provider；
4. `NIBI_ENDPOINT_ORIGIN=http://127.0.0.1:9`，让内置 provider 刷新快速失败，避免基线访问生产端点；
5. 用 `NODE_OPTIONS=--require=memory-sampler.cjs` 注入只读采样器（250ms 一次 `process.memoryUsage()` + `v8.getHeapStatistics()`），**不设置** `--max-old-space-size`、不改 GC/回收参数；
6. 跑 `nibi -p <prompt> --output-format stream-json --mode yolo`，解析事件流。

隔离验证：5/5 运行的 `isolatedDbCreated=true`，会话库都落在临时 HOME 的 `.nibi/cli/db/db.sqlite`；真实 `~/.nibi` 的 DB 不再被本脚本写入。

## 3. 实测数字（5 次，本地假 provider 即时返回）

| 指标 | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| spawn → 首条 stdout | 2268 ms | 2394 ms | 2694 ms | 2694 ms |
| spawn → 首条事件 | 2267 ms | 2392 ms | 2692 ms | 2692 ms |
| spawn → 首个流式事件 | 3210 ms | 3471 ms | 3766 ms | 3766 ms |
| spawn → 首段助手文本 | 3210 ms | 3471 ms | 3766 ms | 3766 ms |
| spawn → `turn.completed` | 3242 ms | 3529 ms | 3870 ms | 3870 ms |
| spawn → 进程退出 | 3461 ms | 3772 ms | 4124 ms | 4124 ms |
| 峰值 RSS | 350.2 MiB | 408.6 MiB | 414.9 MiB | 414.9 MiB |
| 首段文本时 RSS | 123.8 MiB | 124.0 MiB | 126.5 MiB | 126.5 MiB |

- 5/5 退出码 0，假 provider 标记 5/5 命中，事件数 14。
- V8 `heap_size_limit` 实测 **4288 MiB**（64 位默认值，未注入上限）。
- 首段文本时间包含进程启动、会话创建、标题生成与一次模型请求；假 provider 本身为 0 延迟，所以 **3.5s 主要是内核开销，不是真实首字延迟**。

## 3.1 FIX-4 后复跑（Node 24.22.1，2026-10-30 00:17 +08）

同一脚本、同一隔离方式，5 次（重复一轮共 10 次）：

| 指标 | 第一轮 p50 | 第二轮 p50 | 两轮范围 |
|---|---:|---:|---:|
| spawn → 首条事件 | 3399 ms | 3378 ms | 3.3–3.5 s |
| spawn → 首段助手文本 | 4665 ms | 4424 ms | 4.4–4.8 s |
| spawn → `turn.completed` | 4728 ms | 4490 ms | 4.5–4.9 s |
| spawn → 进程退出 | 5035 ms | 4780 ms | 4.8–5.1 s |
| 峰值 RSS | 404.4 MiB | 405.7 MiB | 403–407 MiB |
| 首段文本时 RSS | 115.9 MiB | 116.1 MiB | 115.8–116.1 MiB |

观察：FIX-4 后首段文本 p50 从 ~3.5s 升到 ~4.5s，峰值 RSS 从 ~409 MiB 降到 ~405 MiB；两轮一致，暂按版本/运行时差异记录，最终以 20 次冷启的安静机器测量为准。Electron 仍是 41.0.3，FIX-5 合入后必须再重跑。

## 4. 当前运行时参数现状（只记录，不改）

| 参数 | 现状 | 源码锚点 |
|---|---|---|
| Agent 进程 `--max-old-space-size` | **未设置**（未注入） | `packages/services/src/node.ts:2206`（spawn env 组装） |
| Agent 主进程空闲回收 | **未启用**（进程管理器未传 `idleTimeoutMs`） | `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:601`、`zcodeAgentService.ts:1049` |
| MCP 状态专用 lane 空闲回收 | **300000 ms（5 分钟）** | `packages/services/src/zcode-agent/zcodeAgentService.ts:380,1089` |
| DWF 子进程堆上限 | **256 MiB**（`--max-old-space-size=256`） | `apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts:122` |
| v4 工具输出保留 | head 32 KiB + tail 32 KiB | `packages/shared/src/nibi-protocol-v4/core.ts:77-78` |
| workspace hook 输出上限 | 32768 bytes | `packages/shared/src/workspace-hook-config.ts:8` |

## 5. 未测量项（不得写成“通过”）

| 项 | 状态 | 原因 / 复跑方式 |
|---|---|---|
| Host / renderer RSS | **未测** | 采集时机器上只有两个 `dev:desktop:test` watcher（tsup/vite），没有 Electron 主进程；`attach` 子命令已就绪：`node scripts/kernel-baseline/collect-kernel-baseline.mjs attach --pid <electron-pid> --seconds 30` |
| 真实 provider 首字延迟 | **未测** | 需要 NIBI 账号/额度；本轮只用本地假 provider，避免消耗用户额度 |
| compact（手动/自动） | **未测** | 需要长会话与真实模型；无头 `-p` 单回合不触发自动压缩 |
| MCP 重载 | **未测** | 需要装插件 MCP 并驱动工具调用；本轮未改插件配置 |
| DWF 运行 | **未测** | 需要 `--workflow-mode` 与工作流脚本；本轮只记录子进程堆上限常量 |
| 长任务 RSS 斜率 / GC 停顿 | **未测** | 需要持久 app-server + 多回合/多小时 soak；`-p` 每次都是新进程 |
| 24h soak / 崩溃恢复 / 进程树清理 | **未测** | 属阶段 5 验收，不在阶段 0 单次采集范围 |

## 6. 隔离事故与处置（必须保留的记录）

早期探测（22:21–22:29）只设置了 `NIBI_SETTINGS_DIR` 与显式 provider 路径，没有重定向 `HOME`/`NIBI_STORAGE_DIR`，导致 4 个探测会话写进了真实 `~/.nibi`：

- `~/.nibi/cli/db/db.sqlite` 新增了 4 条 `sess_*` 记录；
- `~/.nibi/cli/rollout/` 新增 4 个 `model-io-sess_*.jsonl`。

处置：

1. 4 个 rollout 文件已**移动**（未删除）到 `.artifacts/kernel-baseline/quarantine-20261029-probe-artifacts/rollout/`；
2. 真实 DB 里的 4 条会话记录**未删除**（避免对真实库做破坏性操作），需运营者确认是否清理；
3. 采集脚本已改为同时重定向 `USERPROFILE`/`HOME`/`NIBI_DATA_BASE_DIR`/`NIBI_STORAGE_DIR`/`NIBI_SETTINGS_DIR`，并逐次断言隔离库存在；
4. 后续所有验证必须沿用该隔离方式，禁止只设 `NIBI_SETTINGS_DIR`。

## 7. 结论与下一步

- Node 内核单次无头回合（含启动）在本机 p50 ≈ 3.8s、峰值 RSS p50 ≈ 409 MiB；这是后续 Rust 对照的**临时**基线。
- 先完成 FIX-4（Node 钉定）与 FIX-5（Electron 44）再重跑本报告，否则版本变化会污染“改造前”数据。
- 桌面 Host/renderer 与 compact/MCP/DWF 需要单独场景脚本；建议先补 attach 采样，再做三个可复现场景（长会话+compact、MCP 重载、DWF）。

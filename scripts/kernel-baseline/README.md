# 内核阶段 0 基线采集脚本

只测量、不改运行时参数。桌面本地 agent 的默认与唯一内核是 Rust（`nibi-rs`），缺二进制时
fail-closed；本脚本不切换内核，也没有 `NIBI_KERNEL` 开关。远端 Source Server / server-cli 仍走
自己的 `nibi.cjs` 链路。

## 用法

```bash
# 零模型成本：本地假 provider + 完整隔离 HOME，跑 5 次 nibi -p
node scripts/kernel-baseline/collect-kernel-baseline.mjs agent --runs 5

# 对已运行的 Electron 主进程做进程树 RSS 采样（Host/renderer/Agent/MCP）
node scripts/kernel-baseline/collect-kernel-baseline.mjs attach --pid <electron-pid> --seconds 30

# 记录当前运行时参数与源码锚点
node scripts/kernel-baseline/collect-kernel-baseline.mjs inventory
```

输出默认写到 `NIBI-Client/.artifacts/kernel-baseline/<kind>-<timestamp>/`（`.artifacts/` 已 gitignore）。

## 隔离要求

`agent` 模式会同时设置：

- `USERPROFILE` / `HOME`
- `NIBI_DATA_BASE_DIR`
- `NIBI_STORAGE_DIR`
- `NIBI_SETTINGS_DIR`

只设 `NIBI_SETTINGS_DIR` 不够：CLI 的存储准备子进程仍会写真实 `~/.nibi`（2026-10-29 实测事故）。脚本每次运行都会断言隔离库落在临时 HOME 下。

## 不做什么

- 不设置 `--max-old-space-size`；
- 不改空闲回收、GC、工具输出预算；
- 不访问生产端点（`NIBI_ENDPOINT_ORIGIN` 指向本机不可达端口，让内置配置刷新快速失败）；
- 不调用真实模型（假 provider 立即返回）。

首字时间因此主要反映内核启动开销，不是真实 provider 首字延迟。

# NIBI

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="NIBI" width="120" height="120" />

  <p><strong>面向长时间、高密度开发会话的 AI 编程工作台</strong></p>

  <p>
    <a href="README.en.md">English</a> ·
    <a href="LICENSE">Apache-2.0</a> ·
    <a href="docs/README.md">开发文档</a> ·
    <a href="docs/release-process.md">发版流程</a>
  </p>
</div>

> NIBI 是一个从 [ZCode](https://github.com/zai-org/ZCode) v3.16.2 独立演进的 AI 编程工作台。
> 桌面 Agent 内核使用 Rust（`nibi-rs`）；TypeScript / Electron / React 负责界面、Host 与平台集成；
> Node `nibi.cjs` 仅保留为 DWF、插件宿主和远端 Source Server 的内部运行时。

## 定位

NIBI 不是 ZCode 的换皮发行版，也不是跟随上游整体合并的分支。它以上游 v3.16.2 为起点独立演进：
需要的能力按意图逐项吸收，产品边界、运行时、UI、插件协议和发布链由 NIBI 自己维护。

- **Rust 内核**：桌面本地 Agent 内核是 `kernel/` 下的独立 Cargo workspace（37 个 crate），
  `nibi-rs` 同时承载 CLI、TUI 与远端执行器；缺少内核二进制时 fail-closed，不静默回退 Node。
- **一个界面，多种执行位置**：本地工作区、SSH、WSL、Docker 与远端 Source Server 共用同一套
  会话、工具和权限语义。
- **本地优先**：配置、会话、凭据和插件数据默认留在本机数据根；远端与手机远控是显式连接，
  不是把本地状态默认上传。
- **公开构建自包含**：UI、Host、服务端、共享协议、Rust 内核、插件宿主与 CUA 实现都在本仓库；
  签名、真实模型冒烟和运营侧发布链不进入公开仓。

NIBI 与 ZCode 项目及其维护方没有隶属或背书关系；上游名称与版权归其各自权利人。

## 主要能力

| 能力           | 说明                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| 多工作区与任务 | 项目、任务、会话、队列与子代理在同一工作台内组织                                            |
| 终端与文件     | 内置终端、文件预览、Git 检查点、差异与产物查看                                              |
| 工具与 MCP     | 工具调用、权限模式、MCP、技能、Hook 与工作流                                                |
| 插件           | 内置插件、官方市场与插件宿主；插件能力走显式契约                                            |
| 远程开发       | SSH / WSL / Docker / Source Server 远端工作区                                               |
| 手机远控       | 手机浏览器扫码连接桌面会话，支持 Relay V2 与分享入口                                        |
| Computer Use   | 公开实现位于 `packages/nibi-cua`；原生能力来自 MIT `@trycua/cua-driver`，缺失时 fail-closed |
| 分享           | 会话公开投影、只读分享页与导入                                                              |

## 架构一览

```text
┌────────────────────────────────────────────────────────────┐
│ Electron / React UI · Web / Mobile Remote                  │
│ 共享 UI、协议、Host 服务与平台桥接                          │
└──────────────────────────┬─────────────────────────────────┘
                           │ RPC / V4 projection
┌──────────────────────────▼─────────────────────────────────┐
│ Rust kernel: nibi-rs                                       │
│ sessions · tools · models · permissions · CLI · TUI        │
└──────────────────────────┬─────────────────────────────────┘
                           │ local / SSH / WSL / Docker
┌──────────────────────────▼─────────────────────────────────┐
│ Workspace, terminal, files, plugins, MCP, CUA              │
└────────────────────────────────────────────────────────────┘

nibi.cjs（Node）：仅 DWF、插件宿主、远端 Source Server 的内部运行时
```

更完整的模块边界、消息流和依赖方向见
[架构总览](docs/architecture/nibi-code-architecture-overview.md) 与
[架构治理](docs/architecture/architecture-governance.md)。

## 开源范围

**包含：**

- Electron 桌面客户端、Web 客户端与共享 React UI
- 本地 Host、服务端、RPC 与共享协议
- Rust Agent CLI、TUI 与运行时（`kernel/`）
- 插件宿主、内置插件与 Computer Use 实现（`packages/nibi-cua`）
- 开发、测试、构建与架构门禁

**不包含：**

- 发布签名、公证与正式发布凭据
- 真实 provider 冒烟测试、内部桌面容器 E2E 流水线
- 运营侧服务、内容发布链与内部运维文档

公开构建缺少可选私有组件时会明确失败闭合，不会伪造成功，也不会启动不存在的原生进程。

## 状态与平台

- 当前公开发行以 **Windows / Linux** 桌面为主；macOS 源码可构建，但桌面安装包暂缓发布。
- Source Server 当前发布 Linux 归档；macOS 远端归档随 macOS 发行一起暂缓。
- 公开源码构建**未签名**。签名与公证不属于本仓库；首次运行的平台安全提示以实际构建为准。
- macOS Computer Use 需要带签名身份与 TCC 授权的 Helper；没有签名 Helper 时该能力 fail-closed。
- `@nibi-studio/cli` META 包正在准备首发；在正式发布前，请从源码构建终端 CLI。

## 环境要求

- Node.js **24.22.1**
- pnpm **10.33.2**
- Rust **1.95.0**（由 `kernel/rust-toolchain.toml` 固定）
- Git

版本以 [mise.toml](mise.toml) 为准。Windows 与 Linux 是当前发行目标；macOS 可进行源码开发与构建。

## 快速开始

```bash
pnpm bootstrap
pnpm dev:desktop
```

`pnpm bootstrap` 会安装 workspace 依赖、准备桌面本地运行资源并构建基础包。

需要独立的数据目录时：

```bash
NIBI_DATA_BASE_DIR="$HOME/.nibi-dev" pnpm dev:desktop
```

其他常用入口：

| 命令                           | 用途                          |
| ------------------------------ | ----------------------------- |
| `pnpm install`                 | 只安装依赖                    |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源              |
| `pnpm build`                   | 递归构建 workspace 包         |
| `pnpm dev:web`                 | 启动 Web 开发服务器与本地后端 |
| `pnpm dev:docs`                | 启动开发文档站                |

## 仓库结构

| 目录                                                 | 职责                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包                           |
| `packages/web`                                       | Web 客户端与手机远控入口                                           |
| `packages/web-share`                                 | 会话分享落地页                                                     |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接                                    |
| `packages/nibi-server-cli`                           | 独立 Server 启动与进程管理                                         |
| `packages/ui`                                        | 共享 React 组件、hooks 与状态                                      |
| `packages/services`                                  | 业务服务与持久化                                                   |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议、RPC 框架与 Agent 客户端 SDK                              |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现                                      |
| `apps/nibi-cli`                                      | 内部 Node runtime（`nibi.cjs`：DWF、插件宿主、远端 Source Server） |
| `packages/nibi-cua`                                  | Computer Use 实现（Helper / runtime / engine 适配）                |
| `kernel`                                             | Rust 内核：协议、会话、工具、模型、CLI 与 TUI                      |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明                                 |

`kernel/` 是独立 Cargo workspace，不进 pnpm/tsc 链。桌面本地 Agent 只使用 Rust 内核；
`NIBI_AGENT_SERVER_COMMAND` 仅用于显式自定义覆盖。功能对照见
[`docs/rust-kernel-function-parity.md`](docs/rust-kernel-function-parity.md)，改造台账见
[`kernel/CHANGELOG-FORK.md`](kernel/CHANGELOG-FORK.md)。

## 开发与验证

```bash
pnpm lint
pnpm typecheck
pnpm test:architecture
pnpm test:unit
pnpm check:public-repo
```

提交前至少运行 `pnpm lint`、`pnpm typecheck` 与相关单测。公开仓 CI 在 Linux、Windows 和
macOS 上运行同一套门禁，只使用 GitHub-hosted runner，不接收仓库 secret。

Rust 内核单独验证：

```bash
cd kernel
cargo check --locked --workspace
cargo test --locked --workspace
```

## 桌面构建

```bash
pnpm bundle:desktop
pnpm bundle:desktop -- --os win --arch x64
pnpm bundle:desktop -- --os linux --arch x64
```

公开源码构建产物**未签名**。正式发布所需的签名、公证和更新库存发布不属于本仓库；
当前 macOS 桌面安装包暂缓，Windows 公开发行使用 NSIS 安装包。更新与发布口径见
[发版流程](docs/release-process.md)。

## 终端 CLI

当前从源码构建 Rust 内核：

```bash
cd kernel
cargo build --release -p nibi-kernel-cli --bin nibi-rs
./target/release/nibi-rs --version
```

macOS / Linux 也可以使用 `cargo install --path kernel/crates/cli`。npm META 包
`@nibi-studio/cli` 会在首发完成后提供全局 `nibi` 入口；发布前不要依赖 npm 安装。
Node `@nibi/cli` 与 Node TUI 已退役，不再发布。

## 配置

| 变量                                | 用途                                    |
| ----------------------------------- | --------------------------------------- |
| `NIBI_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.nibi/` |
| `NIBI_SERVER_WORKSPACE`             | Web 后端的工作区路径                    |
| `NIBI_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径              |

运行时变量通过启动命令的环境显式设置。随客户端发布的默认配置见
[config/README.md](config/README.md)。

## 参与贡献

- 提交前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。
- 行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- 架构与设计文档的入口见 [docs/README.md](docs/README.md)。

## 许可证与来源

第一方代码以 [Apache License 2.0](LICENSE) 发布。NIBI 基于 ZCode v3.16.2 独立演进，
不是 ZCode 官方发行版，也不代表上游项目。

- 许可范围与第三方组件：[LICENSING.md](LICENSING.md)
- 上游版权与项目来源：[NOTICE.md](NOTICE.md)
- 第三方依赖、复制代码与原生组件：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- NIBI 名称与标识：[TRADEMARKS.md](TRADEMARKS.md)

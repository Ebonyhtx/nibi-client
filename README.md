# NIBI

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="NIBI" width="128" height="128" />
</div>

<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

NIBI 是一个开源的 AI 编程工作台，包含桌面应用、浏览器界面、服务端、共享 UI，以及终端 Agent 与运行时。它面向长时间、高密度的开发会话：多工作区、终端、文件预览、工具调用、插件与远程开发都在同一个界面里完成。

本仓库是 NIBI 客户端的公开源码。项目基于 [ZCode](https://github.com/zai-org/ZCode) v3.16.2（Apache License 2.0）独立演进，上游版权与第三方组件声明保留在 [NOTICE.md](NOTICE.md) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 开源范围

本仓库包含：

- Electron 桌面客户端与 Web 客户端
- 本地 Host、服务端、RPC 与共享协议
- Agent CLI、TUI 与运行时
- 共享 React UI、插件宿主与内置插件
- 开发、测试、构建与架构门禁

以下内容不在本仓库中：

- Computer Use 的原生 Helper、引擎适配与运行时语义。公开仓只保留协议、类型和失败闭合的占位包 `@nibi/cua`；官方 NIBI 构建会替换为完整实现。
- 发布签名、真实 provider 冒烟测试、桌面容器 E2E 的内部流水线与凭据。
- 运营侧服务、内容发布链与内部运维文档。

公开构建在缺少上述私有组件时会**明确失败闭合**，不会伪造成功，也不会尝试启动不存在的原生进程。

## 环境要求

- Node.js **24.14.0**
- pnpm **10.33.2**
- Git

版本以 [mise.toml](mise.toml) 为准。Windows、macOS 与 Linux 都是一等支持平台。

## 快速开始

```bash
pnpm bootstrap
pnpm dev:desktop
```

`pnpm bootstrap` 会安装 workspace 依赖、准备桌面本地运行资源，并构建基础包。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随仓库克隆，不需要 submodule。

其他常用入口：

| 命令 | 用途 |
| --- | --- |
| `pnpm install` | 只安装依赖 |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源 |
| `pnpm build` | 递归构建各 workspace 包 |
| `pnpm dev:web` | 同时启动 Web 开发服务器与本地后端 |
| `pnpm dev:docs` | 启动开发文档站 |

需要独立的数据目录时，设置 `NIBI_DATA_BASE_DIR`：

```bash
NIBI_DATA_BASE_DIR="$HOME/.nibi-dev" pnpm dev:desktop
```

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `packages/desktop` | Electron Main、Host、Renderer 与桌面打包 |
| `packages/web` | Web 客户端 |
| `packages/server` | HTTP / WebSocket 服务与远程连接 |
| `packages/zcode-server-cli` | 独立 Server 启动与进程管理 |
| `packages/ui` | 共享 React 组件、hooks 与 Zustand 状态 |
| `packages/services` | 业务服务与持久化 |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node` | Provider 公共能力与 Node 实现 |
| `apps/zcode-cli` | Agent CLI、TUI、运行时与工具 |
| `packages/zcode-cua` | Computer Use 公开契约与占位实现 |
| `scripts`、`config`、`third-party` | 构建维护脚本、内置配置与第三方声明 |

## 开发与验证

```bash
pnpm lint
pnpm typecheck
pnpm test:architecture
pnpm test:unit
pnpm check:public-repo
```

提交前至少运行 `pnpm lint`、`pnpm typecheck` 与相关单测。公开仓的 CI 会在 Linux、Windows 和 macOS 上运行同一套门禁，不依赖任何自托管 runner。

桌面端构建：

```bash
pnpm bundle:desktop
pnpm bundle:desktop -- --os win --arch x64
```

公开源码构建产物**未签名**。正式发布所需的签名与公证由发布流水线在私有环境中完成，不属于本仓库。

CLI 发行包：

```bash
pnpm build:zcode --base-url https://downloads.example.com/nibi/
```

`--base-url` 只影响安装脚本的下载地址；本地验证可以直接解压 `dist/nibi/` 下的产物运行。

## 配置

| 变量 | 用途 |
| --- | --- |
| `NIBI_DATA_BASE_DIR` | 应用数据基目录，数据写入其下的 `.nibi/` |
| `NIBI_SERVER_WORKSPACE` | Web 后端的工作区路径 |
| `NIBI_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径 |
| `NIBI_DIST_BASE_URL` | CLI 安装脚本使用的下载根地址 |

运行时变量通过启动命令的环境显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

## 参与贡献

- 提交前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。
- 行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- 架构与设计文档的入口见 [docs/README.md](docs/README.md)。

## 许可证与来源

本项目以 [Apache License 2.0](LICENSE) 发布。NIBI 基于 ZCode v3.16.2 独立演进；上游版权、第三方组件许可与来源说明见 [NOTICE.md](NOTICE.md) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

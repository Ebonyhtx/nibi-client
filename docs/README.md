# NIBI 开发文档

这里是公开文档的入口。文档描述当前仓库的实际行为；如果文档与代码冲突，以代码、`package.json` 和架构门禁为准。

## 开始

- [根 README](../README.md)：环境、启动、构建与仓库结构
- [贡献指南](../CONTRIBUTING.md)：提交、验证与公开仓规则
- [发版流程](release-process.md)：发布台账、`release:status` / `release:verify` 与 npm/Source Server 产物
- [许可与来源](../LICENSING.md)：第一方、上游与第三方组件的许可边界
- [名称与标识](../TRADEMARKS.md)：NIBI 名称、字标和 logo 的使用规则
- [架构治理](architecture/architecture-governance.md)：模块边界、依赖方向与门禁
- [架构总览](architecture/nibi-code-architecture-overview.md)
- [通信协议分层](architecture/communication-protocol-layers.md)
- [消息流](architecture/message-flow.md)
- [RPC](architecture/rpc.md)

## 桌面端

- [开发运行](desktop/dev-runtime.md)
- [可配置数据目录](desktop/configurable-data-directory.md)
- [Deep link](desktop/dev-deep-link.md)
- [自动更新](desktop/auto-update-service-manifest.md)
- [Windows 安装器](desktop/windows-installer-overhaul-spec.md)
- [Computer Use producer 检测](desktop/computer-use-producer-detection.md)
- [Computer Use 实现](../packages/computer-use/IMPLEMENTATION.md)

## CLI 与 Agent

- [CLI 使用指南](../apps/nibi-cli/docs/usage/README.md)
- [Bash shell provider](../apps/nibi-cli/docs/bash-shell-provider.md)
- [Bash AST 权限语义](../apps/nibi-cli/docs/bash-tool-ast-permission-semantics.md)

## UI 与设计

- [设计规范](../DESIGN.md)
- [插件商店术语](../CONTEXT.md)
- [UI Plugin 指南](../UI_PLUGIN.md)
- [工作区独立面板](design/workspace-independent-panels.md)
- [宣纸书案主题与排版](design/folio-desk-themes.md)：四套主题、三族字体、内联顶栏与工作指示器

## 插件

- [插件平台状态（唯一真源）](plugin-platform-status-2026-11-25.md)：A–E 状态表、已关闭缺口与有意偏离
- [插件兼容模型（Agent Plugins 1.0.0）](plugins/plugin-compatibility-model.md)
- [插件市场与来源](plugins/plugin-market-interactions-scope.md)
- [插件生命周期与用例目录](plugin-management-lifecycle-case-catalog.md)
- [Claude 插件格式兼容](claude-code-marketplace-plugin-compat.md)
- [扩展运行时 v1](plugin-extension-runtime.md)

## 远程与分享

- [会话分享协议](conversation-share-v1.md)
- [Web 分享](web-share/)
- [手机远控](web-remote-control/)

## 运行时与工具

- [浏览器使用](browser-use/)
- [动态工作流](dynamic-workflow/)
- [运行时工具](runtime-tools/)
- [子代理重启续跑](subagent-restart-resume.md)：客户端重启/断网后子代理的可见、续跑与通知补发（Rust 先行）
- [公共契约文档](contracts/)
- [性能](performance/README.md)

## 上游对齐

- [NIBI vs ZCode 3.18.2 parity report](upstream-parity-report.md)：当前上游基线的对齐/偏差、证据与剩余项（2026-11-21 快照，2026-11-26 补注）
- [ZCode 3.16.2 → 3.17.2 吸收方案（历史归档）](archive/upstream-legacy/zcode-3.16.2-to-3.17.2-absorption-plan.md)

## Rust 内核

- [与 Node 的功能对照（切流判据）](rust-kernel-function-parity.md)：哪些已对齐、哪些是刻意的实现差异
- [改造台账与上游吸收记录（§5）](../kernel/CHANGELOG-FORK.md)：每一段落地的范围与证据；§5 记录跟到哪一版、为什么跟或不跟
- [历史阶段记录（归档）](archive/rust-kernel/)：vendoring、Step 1/2、M5、DWF 路线 C 设计与 Step 4 基线；只作历史对照

## 安全

- [Deep link 与项目信任边界](security/deep-link-project-trust-boundary.md)
- [安全策略](../SECURITY.md)

## 架构决策

- [ADR 索引](adr/README.md)

## 测试

- [测试文档索引](testing/README.md)：命令、覆盖矩阵、故障注入与历史参考都从这里进
- [提交前检查](testing/pre-push-hook.md)

## 说明

公开文档不包含内部部署、运营、客户数据、真实凭据或私有服务拓扑。新增文档前请阅读 [CONTRIBUTING.md](../CONTRIBUTING.md) 的公开仓规则。

`docs/archive/` 保留历史记录：`removed-commercial/` 是已移除的商业套餐（Coding Plan、Team Plan、Start Plan、上游账户用量与上游 OAuth），`upstream-legacy/` 是已失效的上游约定与历史吸收计划，`rust-kernel/` 是 Rust 内核的阶段记录（基线、Step 1/2、M5、DWF 设计），[`remote/`](archive/remote/README.md) 是早期远程主链阅读入口（当前远程文档见 `docs/web-remote-control/`）。这些文档只在归档索引/历史入口保留链接，不作为当前入口，也不代表当前产品行为；当前行为以代码和有效文档为准。

部分未归档的上游设计文档仍保留 ZCode 名称或商业套餐术语，文件顶部会标注范围说明；这些段落只作架构对照，当前 NIBI 的命名与能力以代码为准。

# NIBI 开发文档

这里是公开文档的入口。文档描述当前仓库的实际行为；如果文档与代码冲突，以代码、`package.json` 和架构门禁为准。

## 开始

- [根 README](../README.md)：环境、启动、构建与仓库结构
- [贡献指南](../CONTRIBUTING.md)：提交、验证与公开仓规则
- [架构治理](architecture/architecture-governance.md)：模块边界、依赖方向与门禁
- [架构总览](architecture/architecture.md)
- [通信协议分层](architecture/communication-protocol-layers.md)
- [消息流](architecture/message-flow.md)
- [RPC](architecture/rpc.md)

## 桌面端

- [开发运行](desktop/dev-runtime.md)
- [可配置数据目录](desktop/configurable-data-directory.md)
- [Deep link](desktop/dev-deep-link.md)
- [自动更新](desktop/auto-update-baseline.md)
- [Windows 安装器](desktop/windows-installer-overhaul-spec.md)
- [Computer Use producer 检测](desktop/computer-use-producer-detection.md)

## CLI 与 Agent

- [CLI 使用指南](../apps/zcode-cli/docs/usage/README.md)
- [Bash shell provider](../apps/zcode-cli/docs/bash-shell-provider.md)
- [Bash AST 权限语义](../apps/zcode-cli/docs/bash-tool-ast-permission-semantics.md)

## UI 与设计

- [设计规范](../DESIGN.md)
- [插件商店术语](../CONTEXT.md)
- [UI Plugin 指南](../UI_PLUGIN.md)
- [工作区独立面板](design/workspace-independent-panels.md)

## 插件

- [插件市场与来源](plugins/)
- [插件生命周期](plugins/)
- [Claude 插件格式兼容](claude-code-marketplace-plugin-compat.md)

## 远程与分享

- [远程工作区](remote/README.md)
- [会话分享协议](conversation-share-v1.md)
- [Web 分享](web-share/)
- [手机远控](web-remote-control/)

## 运行时与工具

- [浏览器使用](browser-use/)
- [动态工作流](dynamic-workflow/)
- [运行时工具](runtime-tools/)
- [公共契约文档](contracts/)
- [性能](performance/)

## 安全

- [Deep link 与项目信任边界](security/deep-link-project-trust-boundary.md)
- [安全策略](../SECURITY.md)

## 架构决策

- [ADR 索引](adr/)

## 测试

- [测试文档](testing/)
- [提交前检查](testing/pre-push-hook.md)

## 说明

公开文档不包含内部部署、运营、客户数据、真实凭据或私有服务拓扑。新增文档前请阅读 [CONTRIBUTING.md](../CONTRIBUTING.md) 的公开仓规则。

`docs/archive/` 保留上游历史设计记录：`removed-commercial/` 是已移除的商业套餐（Coding Plan、Team Plan、Start Plan、上游账户用量与上游 OAuth），`upstream-legacy/` 是已失效的上游 endpoint/环境变量约定。这些文档不在本索引内，也不代表当前产品行为；当前行为以代码和有效文档为准。

部分未归档的上游设计文档仍保留 ZCode 名称或商业套餐术语，文件顶部会标注范围说明；这些段落只作架构对照，NIBI 4.0 的当前命名与能力以代码为准。

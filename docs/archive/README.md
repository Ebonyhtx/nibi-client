# 归档文档

本目录保留已交付、已被替代或已失效的历史记录。**这里的内容不代表当前行为**：当前行为以源码、`package.json`、架构门禁和 `docs/README.md` 里列出的有效文档为准。

- `removed-commercial/`：已移除的商业套餐（Coding Plan、Team Plan、Start Plan、上游账户用量与上游 OAuth）。
- `upstream-legacy/`：已失效的上游 endpoint / 环境变量约定。
- `bugfixes/`：已修复缺陷的根因分析与修复记录（MCP 刷新、WSL 任务状态、背景子代理唤醒）。
- `rust-kernel/`：2026-10-29 ～ 11-01 的 Rust 内核阶段记录（vendoring 基线、Step 1/2、M5 读路径、DWF 路线 C 设计与 Step 4 基线）。当前状态看
  [`docs/rust-kernel-function-parity.md`](../rust-kernel-function-parity.md) 与 [`kernel/CHANGELOG-FORK.md`](../../kernel/CHANGELOG-FORK.md)。

归档规则：功能已交付或方案已被替代、且正文只描述当时的过程/缺口时归档；仍在生效的行为规格、架构契约与决策记录留在原位。归档不删除历史（git 与这里的文件都保留），只是不再占用入口索引与阅读路径。
2026-11-12 清理新增：

- `provider-refactor/`：Provider Refactor 之前的方案与事故记录（family merge 之后的历史 schema、config overrides、OAuth 多提供方、Registry 同步挂起）。
- `plans/`：已交付的阶段计划（cloud content dialog、hook trust MR 范围、工具历史顺序修复提案）。
- `hooks/`：Hooks 实现分析与 trust 标签诊断（现行契约见 `docs/hooks-runtime-contract.md`）。
- `web-remote-control/`：手机端稳定性分析与 relay 消息日志（已停用）记录。
- `architecture/`：早期分层架构与自动更新旧 baseline（现行见 `docs/architecture/zcode-code-architecture-overview.md`、`docs/desktop/auto-update-service-manifest.md`）。
- `bugfixes/` 追加：分组任务 workspace bootstrap、rewind 入口下线、界面缩放下线、agent UI 状态清理、后台子代理 join 废弃方案。

同时删除 8 篇自述「历史/已被取代」且全仓无引用的文档（family merge/opencode config/catalog metadata/plugin 方案对比等，git 历史仍可查）。

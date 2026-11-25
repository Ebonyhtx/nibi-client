# 归档文档

本目录保留已交付、已被替代或已失效的历史记录。**这里的内容不代表当前行为**：当前行为以源码、`package.json`、架构门禁和 `docs/README.md` 里列出的有效文档为准。

- `removed-commercial/`：已移除的商业套餐（Coding Plan、Team Plan、Start Plan、上游账户用量与上游 OAuth）。
- `upstream-legacy/`：已失效的上游 endpoint / 环境变量约定；**2026-11-26 追加** `zcode-3.16.2-to-3.17.2-absorption-plan.md`（已完成的历史吸收计划，当前对齐看 `docs/upstream-parity-report.md`）。
- `bugfixes/`：已修复缺陷的根因分析与修复记录（MCP 刷新、WSL 任务状态、背景子代理唤醒）；**2026-11-26 追加** `session-config-blocking-hotfix.md`（3.12.2 聊天配置等待隔离）。
- `rust-kernel/`：2026-10-29 ～ 11-01 的 Rust 内核阶段记录（vendoring 基线、Step 1/2、M5 读路径、DWF 路线 C 设计与 Step 4 基线）。当前状态看
  [`docs/rust-kernel-function-parity.md`](../rust-kernel-function-parity.md) 与 [`kernel/CHANGELOG-FORK.md`](../../kernel/CHANGELOG-FORK.md)。
- `remote/`：早期远程主链阅读入口（SSH / WSL / Docker Source Server 历史合同与证据）；部分相对链接只存在于历史归档库，当前远程文档见 [`docs/web-remote-control/`](../web-remote-control/web-remote-control-architecture.md)。

归档规则：功能已交付或方案已被替代、且正文只描述当时的过程/缺口时归档；仍在生效的行为规格、架构契约与决策记录留在原位。归档不删除历史（git 与这里的文件都保留），只是不再占用入口索引与阅读路径。
2026-11-12 清理新增：

- `provider-refactor/`：Provider Refactor 之前的方案与事故记录（family merge 之后的历史 schema、config overrides、OAuth 多提供方、Registry 同步挂起）。
- `plans/`：已交付的阶段计划（cloud content dialog、hook trust MR 范围、工具历史顺序修复提案）；**2026-11-26 追加** `session-open-workspace-catalog.md`（2026-09-10 的 session 打开/CUA spawn 实验记录）。
- `hooks/`：Hooks 实现分析与 trust 标签诊断（现行契约见 `docs/hooks-runtime-contract.md`）。
- `web-remote-control/`：手机端稳定性分析与 relay 消息日志（已停用）记录。
- `architecture/`：早期分层架构与自动更新旧 baseline（现行见 `docs/architecture/nibi-code-architecture-overview.md`、`docs/desktop/auto-update-service-manifest.md`）。
- `bugfixes/` 追加：分组任务 workspace bootstrap、rewind 入口下线、界面缩放下线、agent UI 状态清理、后台子代理 join 废弃方案。

同时删除 8 篇自述「历史/已被取代」且全仓无引用的文档（family merge/opencode config/catalog metadata/plugin 方案对比等，git 历史仍可查）。

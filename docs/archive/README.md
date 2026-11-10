# 归档文档

本目录保留已交付、已被替代或已失效的历史记录。**这里的内容不代表当前行为**：当前行为以源码、`package.json`、架构门禁和 `docs/README.md` 里列出的有效文档为准。

- `removed-commercial/`：已移除的商业套餐（Coding Plan、Team Plan、Start Plan、上游账户用量与上游 OAuth）。
- `upstream-legacy/`：已失效的上游 endpoint / 环境变量约定。
- `bugfixes/`：已修复缺陷的根因分析与修复记录（MCP 刷新、WSL 任务状态、背景子代理唤醒）。
- `rust-kernel/`：2026-10-29 ～ 11-01 的 Rust 内核阶段记录（vendoring 基线、Step 1/2、M5 读路径、DWF 路线 C 设计与 Step 4 基线）。当前状态看
  [`docs/rust-kernel-function-parity.md`](../rust-kernel-function-parity.md) 与 [`kernel/CHANGELOG-FORK.md`](../../kernel/CHANGELOG-FORK.md)。

归档规则：功能已交付或方案已被替代、且正文只描述当时的过程/缺口时归档；仍在生效的行为规格、架构契约与决策记录留在原位。归档不删除历史（git 与这里的文件都保留），只是不再占用入口索引与阅读路径。

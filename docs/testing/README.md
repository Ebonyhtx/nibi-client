# 测试文档索引

本目录是 NIBI-Client 测试与验收文档的入口。**先读 [test-command-guide.md](./test-command-guide.md)**：它回答“改完代码该跑哪几条命令”。

约定：

- 覆盖矩阵里的 `covered` 指已有正式自动化或可复现证据；红项、partial 与“只有 Node 证据”的项必须如实标注，不因门禁全绿就算通过。
- 每次复核在对应矩阵文末追加日期与 run id，不覆盖历史记录。
- 标着“历史文档”的文件只作归档对照，不代表当前产品行为。

## 运行与基础设施

| 文档 | 用途 |
| --- | --- |
| [test-command-guide.md](./test-command-guide.md) | 日常测试与类型检查命令 |
| [pre-push-hook.md](./pre-push-hook.md) | pre-push 门禁与 affected 选择 |
| [desktop-e2e-container.md](./desktop-e2e-container.md) | Linux 容器运行桌面 E2E |
| [desktop-e2e-reporting.md](./desktop-e2e-reporting.md) | E2E 报告与失败产物 |
| [desktop-e2e-runtime-performance.md](./desktop-e2e-runtime-performance.md) | E2E 运行时性能规范 |
| [e2e-sse-capture-replay.md](./e2e-sse-capture-replay.md) | 桌面 E2E 的 SSE 录制/回放 |
| [llm-api-stream-capture-replay.md](./llm-api-stream-capture-replay.md) | LLM API 流捕获与回放 |
| [e2e-fs-fault-injection.md](./e2e-fs-fault-injection.md) | 文件系统故障注入 |
| [unit-test-quality.md](./unit-test-quality.md) | 单测质量与删减规格 |
| [unit-test-review/](./unit-test-review/) | 单测审查记录 |

## 会话主矩阵

| 文档 | 用途 |
| --- | --- |
| [conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md) | A-J 主路径与扩展 case 的权威矩阵 |
| [conversation-session-e2e-human-readable-cases.md](./conversation-session-e2e-human-readable-cases.md) | 人工验收用例（按用户动作描述） |
| [conversation-session-background-e2e-coverage-matrix.md](./conversation-session-background-e2e-coverage-matrix.md) | 后台/异步子代理与任务通知 |
| [conversation-session-fault-e2e-coverage-matrix.md](./conversation-session-fault-e2e-coverage-matrix.md) | 产品故障矩阵 |
| [conversation-session-environment-fault-catalog.md](./conversation-session-environment-fault-catalog.md) | 外部环境故障目录 |
| [conversation-session-tool-cross-product-matrix.md](./conversation-session-tool-cross-product-matrix.md) | compact/fork/goal 与工具交叉组合 |
| [conversation-session-fork-cross-product-matrix.md](./conversation-session-fork-cross-product-matrix.md) | fork 交叉组合 |
| [conversation-session-goal-specific-coverage-matrix.md](./conversation-session-goal-specific-coverage-matrix.md) | goal 专项 |
| [conversation-session-goal-manual-review-e2e.md](./conversation-session-goal-manual-review-e2e.md) | goal 人工复核 |
| [conversation-session-requirement-matrix-workflow.md](./conversation-session-requirement-matrix-workflow.md) | 需求澄清与矩阵维护流程 |
| [conversation-session-docker-automation.md](./conversation-session-docker-automation.md) | 容器化 E2E preset 契约 |
| [conversation-session-sse-stall-e2e-diagnostic.md](./conversation-session-sse-stall-e2e-diagnostic.md) | SSE 停滞诊断 |

## 子代理与插件

| 文档 | 用途 |
| --- | --- |
| [subagents-built-in-model-overrides-e2e-coverage-matrix.md](./subagents-built-in-model-overrides-e2e-coverage-matrix.md) | 内置/自定义子代理模型与 reasoning 覆盖（SB/SX） |
| [plugin-management-lifecycle-e2e-coverage-matrix.md](./plugin-management-lifecycle-e2e-coverage-matrix.md) | 插件管理生命周期、安装/禁用/升级与桌面 e2e |

## 模型与 Provider

| 文档 | 用途 |
| --- | --- |
| [desktop-local-model-provider-p0-e2e-cases.md](./desktop-local-model-provider-p0-e2e-cases.md) | 本地模型 Provider P0 用例 |
| [model-provider-restart-connection-e2e-cases.md](./model-provider-restart-connection-e2e-cases.md) | 重启与连接恢复（含商业套餐历史） |
| [upstream-provider-e2e.md](./upstream-provider-e2e.md) | 上游 Provider 固定回归 |
| [model-trajectory-e2e-coverage-matrix.md](./model-trajectory-e2e-coverage-matrix.md) | 模型调用轨迹查看器 |
| [settings-language-e2e-coverage-matrix.md](./settings-language-e2e-coverage-matrix.md) | 设置页语言 |

## 客户端 UI 与工作区

| 文档 | 用途 |
| --- | --- |
| [ui-polish-e2e-coverage-matrix.md](./ui-polish-e2e-coverage-matrix.md) | UI 打磨与视觉回归 |
| [side-pane-tabs-e2e-case-catalog.md](./side-pane-tabs-e2e-case-catalog.md) / [side-pane-tabs-e2e-coverage-matrix.md](./side-pane-tabs-e2e-coverage-matrix.md) | 侧栏 tab 的用例与覆盖 |
| [workspace-file-tree-e2e-coverage.md](./workspace-file-tree-e2e-coverage.md) | 工作区文件树 |
| [workspace-hook-trust-manual-acceptance.md](./workspace-hook-trust-manual-acceptance.md) | Hook 信任人工验收 |
| [git-commit-dialog-e2e-coverage.md](./git-commit-dialog-e2e-coverage.md) | Git 提交对话框 |
| [bash-direct-output-e2e-coverage.md](./bash-direct-output-e2e-coverage.md) | Bash 直接文件输出 |
| [file-tools-atomic-write-e2e-coverage-matrix.md](./file-tools-atomic-write-e2e-coverage-matrix.md) | 文件工具原子写 |
| [hooks-e2e-coverage-matrix.md](./hooks-e2e-coverage-matrix.md) | Hooks |
| [automation-workspace-selection-boundary.md](./automation-workspace-selection-boundary.md) | 定时任务工作区选择 |
| [general-coding-mode-verification.md](./general-coding-mode-verification.md) | 通用/编程模式影响面 |
| [desktop-ssh-guide-regression.md](./desktop-ssh-guide-regression.md) | SSH 测试指南回归 |

## 其他域

| 文档 | 用途 |
| --- | --- |
| [bots-e2e-coverage-matrix.md](./bots-e2e-coverage-matrix.md) | Bots |
| [browser-use-codex-parity-coverage-matrix.md](./browser-use-codex-parity-coverage-matrix.md) | Browser Use / IAB / CDP 对齐 |
| [cua-e2e-case-catalog.md](./cua-e2e-case-catalog.md) | CUA |
| [r3-remote-automation-case-matrix.md](./r3-remote-automation-case-matrix.md) | R3 远程自动化 |
| [desktop-auth-config-e2e-cases.md](./desktop-auth-config-e2e-cases.md) | 登录与配置 |

## 历史 / 参考（非现役门禁）

| 文档 | 说明 |
| --- | --- |
| [conversation-session-automatic-e2e-ci.md](./conversation-session-automatic-e2e-ci.md) | GitLab 时代 CI 记录 |
| [e2e-failure-artifact-report-upload.md](./e2e-failure-artifact-report-upload.md) | GitLab 时代失败产物上传 |
| [opensource-export-validation.md](./opensource-export-validation.md) | Computer Use 占位包时代的开源导出验证 |
| [r3-remote-server-harness.md](./r3-remote-server-harness.md) | 上游 OAuth 删除前的远程 harness 记录 |
| [cloud-content-dialog-coverage.md](./cloud-content-dialog-coverage.md) | 2026-09 云端内容弹窗验收记录 |
| [help-client-config-e2e.md](./help-client-config-e2e.md) | staging 帮助配置的历史验收 |

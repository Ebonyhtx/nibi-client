# 性能文档索引

本目录记录已落地的性能改动、测量方法与回归边界。**现行规范与历史实验分开看**：下面「现行」各篇仍描述当前行为；已交付的旧记录在 `docs/archive/`。

## 现行

| 文档 | 内容 |
| --- | --- |
| [ui-render-stability.md](ui-render-stability.md) | 长会话、多会话切换、多插件时间线的渲染稳定性（派生缓存、turn 缓存、memo、共享时钟） |
| [conversation-row-structural-sharing.md](conversation-row-structural-sharing.md) | Conversation Row 的结构共享与引用稳定 |
| [v4-conversation-cold-hydration.md](v4-conversation-cold-hydration.md) | V4 会话冷启动 hydration 的测量与优化 |
| [streaming-tool-input-backpressure.md](streaming-tool-input-backpressure.md) | 流式工具输入的背压 |
| [background-session-event-coalescing.md](background-session-event-coalescing.md) | 后台 session event 降频 |
| [hidden-document-motion-pause.md](hidden-document-motion-pause.md) | 页面不可见时暂停动画与秒级时钟 |
| [provider-request-history-borrow.md](provider-request-history-borrow.md) | Provider 请求前的历史读取 |
| [runtime-communication-repro.md](runtime-communication-repro.md) | Runtime 通信性能复现方法 |
| [renderer-production-logging.md](renderer-production-logging.md) | Renderer 生产日志策略（高频诊断不落盘） |

## 历史

- `docs/archive/bugfixes/session-config-blocking-hotfix.md`：3.12.2 聊天配置等待隔离（已交付）。
- `docs/archive/plans/session-open-workspace-catalog.md`：2026-09-10 的 session 打开/CUA spawn 实验记录。

新增性能文档先写清基线、测量方法、改动前后数字与回退条件；只描述已核实的结论，不把计划写成现状。

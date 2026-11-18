# kernel-contract

Rust 内核与 Node 内核的共享契约目录。目标：同一件事实只定义一次，两侧引用/镜像并用门禁防漂移；不允许“Rust 一份、Node 一份，靠回忆对齐”。

## 现有产物

| 文件 | 作用 | 消费者 / 门禁 |
|---|---|---|
| `project-config.keys.json` | 项目级配置（`nibi.json`、`.nibi/config.json`）允许键的 canonical 清单 | Node `project-config.adapter.ts`、Rust `config/project_scope.rs`；两侧各有 conformance 测试核对本 JSON |
| `capabilities.json` | 双内核能力单侧例外（`persona.budget.webSearch`、CLI 内存诊断、扩展宿主、远端 agent）与双实现登记（Prompt 快照） | `scripts/check-kernel-capabilities.mjs`；UI/文档据此显示“当前内核不支持” |

## 规则

1. **默认双内核**：用户可见的工具名、权限名、错误码、结果预算、会话状态语义必须两侧一致。
2. **单侧例外必须登记**：只有 V8 / DWF / 远端 / Host 专用能力允许单侧；登记表里写明 side 与 reason，未登记的分叉视为缺陷。
3. **先契约后实现**：新增工具/权限/错误码时先改这里，再改两个内核；不要先写一侧再“有空补另一侧”。
4. **门禁必须能失败**：新增核对脚本时要用变异夹具或单测证明它会红，不能只打印 PASS。

## 后续

`tools` / `permissions` 的完整 schema 生成与双内核 fixture 对拍（X02）尚未落地；当前先覆盖项目配置白名单与能力例外表。

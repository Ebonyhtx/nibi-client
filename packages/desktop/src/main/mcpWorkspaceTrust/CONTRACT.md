# mcp-workspace-trust

工作区 MCP 信任的 Host 侧：项目声明按内容摘要逐条授权，用户域记录只由 Host 写入；Rust 内核
（`crates/ext/src/mcp/trust.rs`、`crates/platform/src/mcp_trust.rs`）只读同一份文件。

## 不变量

- 存储位置固定为 `<存储根>/security/workspace-mcp-trust-v1.json`；项目目录不能指定它。
- 写入走 `updateJsonObjectFile`（严格读取、写前重读、临时文件 + rename、0600）；损坏文件不覆盖。
- 摘要只包含执行相关字段，`enabled` 与信任正交；digest 变化即失效。
- 用户级/插件/内建 MCP 不受本模块影响；同名 server 不跨工作区身份继承。
- 未注册（A6）、离线、损坏、读取失败一律 fail closed；缺存储表示“尚未审核”，不是“已信任”。
- 评审展示必须脱敏（env/header 只出名字，URL 去 userinfo/query/hash，命令参数常见密钥打码）。

## 交集

- `mcpUserDirectory/loadCliMcpFromUserDirectory` 在返回项目记录时附带 `trust` review；A6 由
  `desktopMainIpcPlatform` 用本窗口 `windowWorkspaceMap` 判定是否允许读取项目配置。
- Rust 端使用同一 canonical digest 与 strict store schema；任何一端的格式改动都必须同步另一端与
  `docs/specs/workspace-mcp-trust.md`。
- UI 评审弹窗与会话内待审核提示已接线：设置页行内提供信任/撤销，会话内提示条展示被跳过
  的项目 MCP 并跳转 MCP 设置；数据与准入能力仍来自 `filterTrustedProjectMcpRecords`。
- 实现与远端共用的部分已下沉到 `@nibi/services/node` 的 `services-mcp-trust` 模块。

# services-mcp-trust

工作区 MCP 信任在每个 Environment 的 Host 侧实现：项目声明按内容摘要逐条授权，用户域记录由
该 Environment 的 Host 写入；Rust 内核（`crates/ext/src/mcp/trust.rs`、
`crates/platform/src/mcp_trust.rs`）只读同一份文件。

本模块是 `mcp-workspace-trust`（desktop adapters）的共用实现：Desktop 本机 Host 与远端
Server/CLI（SSH/WSL/Docker/Server remote）必须用同一套存储路径、摘要算法与 strict 解析，
否则 UI 会把本机信任库误当成远端结论。

## 不变量

- 存储位置固定为 `<存储根>/security/workspace-mcp-trust-v1.json`；项目目录不能指定它。
- 写入走 `updateJsonObjectFile`（严格读取、写前重读、临时文件 + rename、0600）；损坏文件不覆盖。
- 摘要只包含执行相关字段，`enabled` 与信任正交；digest 变化即失效。
- 用户级/插件/内建 MCP 不受本模块影响；同名 server 不跨工作区身份继承。
- 未注册（A6）、离线、损坏、读取失败一律 fail closed；缺存储表示“尚未审核”，不是“已信任”。
- 评审展示必须脱敏（env/header 只出名字，URL 去 userinfo/query/hash，命令参数常见密钥打码）。

## 交集

- `IMcpSyncService.loadMcpFromUserDirectory` 在既有方法内附带 `trust` / `unreviewable`；
  远端 UI 因此能看到项目 MCP 被挡的原因。
- `IMcpSyncService.decideWorkspaceMcpTrust`（可选方法）把用户决定写到调用方所在 Environment，
  避免跨设备写错信任库；旧远端 Host 缺失时 UI 按 `workspace_mcp_trust_unavailable` 处理。
- Desktop 本机仍由 `desktopMainIpcPlatform` 用本窗口 `windowWorkspaceMap` 做 A6 判定；
  `mcp-workspace-trust` 模块只做本机入口的类型/函数转发。
- Rust 端使用同一 canonical digest 与 strict store schema；任何一端的格式改动都必须同步另一端与
  `docs/specs/workspace-mcp-trust.md`。

# adapters-mcp-node-fallback

MCP stdio 子进程在桌面 Electron Node 上的 `node`/`npm`/`npx` 回退。规格见
[`docs/design/v2/mcp-node-fallback.md`](../../../../../../../docs/design/v2/mcp-node-fallback.md)。

- 入口：`index.ts` 生成 shim 与 provider；`contract.ts` 是调用方需要的三个类型与 `applyMcpNodeFallbackEnv`。
- 不变量：shim 目录追加在 PATH **末尾**（用户自己的 node/npm/npx 优先）；shim 内容一致时不重写；Windows 只写一个大写 `PATH`；provider 失败降级为 `undefined`，绝不阻断 MCP 连接。
- 平台：POSIX shim 带可执行位；Windows 为 `.cmd`。

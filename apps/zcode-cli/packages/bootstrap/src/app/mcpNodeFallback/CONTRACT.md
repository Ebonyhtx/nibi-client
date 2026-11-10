# cli-mcp-node-fallback

桌面 agent 的 MCP node 回退装配。只有 `process.versions.electron` 存在时创建 provider；随包 npm
候选只来自入口目录与 bundle 目录的 `node-runtime/npm`，不读 cwd。

- 入口：`index.ts`；`contract.ts` 暴露 runtime 注入类型与 `bundledNpmRootCandidates`。
- 失败语义：provider 准备失败返回 `undefined`，MCP 连接照常进行，用户看到原本的 spawn 错误。

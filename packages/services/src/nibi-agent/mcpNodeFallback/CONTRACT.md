# services-mcp-node-fallback

Host 侧的 MCP node 回退环境：Rust 内核的 MCP 子进程环境来自入口快照白名单投影，Host 生成
`<appConfigDir>/node-fallback/v1` shim、把目录追加到 agent PATH 末尾，并下发
`NIBI_NODE_FALLBACK_EXEC_PATH` / `NIBI_NODE_FALLBACK_NPM_ROOT`。Node 内核返回空对象。

- 入口：`index.ts`；`contract.ts` 暴露 `buildMcpNodeFallbackHostEnv` 与输入类型。
- 不变量：用户 PATH 在前；Windows 只写大写 `PATH`；失败不阻断 agent 启动。

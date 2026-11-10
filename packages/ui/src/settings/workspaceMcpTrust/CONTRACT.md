# ui-workspace-mcp-trust

设置页里项目级 MCP 的信任展示与操作面板。Host 唯一持有信任记录；UI 只读取 review 并显示
`trusted / pending / changed / unavailable` 四态，按钮通过 store 调 Host 的 decide 桥。

- 入口：`index.ts`；`contract.ts` 暴露展示类型与 `resolveWorkspaceMcpTrustPresentation`。
- 不变量：不从原始配置重建展示文本（用 Host 的 `display`）；不本地判断信任；不可审核时按钮禁用。

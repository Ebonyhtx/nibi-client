# ui-workspace-mcp-trust

设置页里项目级 MCP 的信任展示与操作面板。Host 唯一持有信任记录；UI 只读取 review 并显示
`trusted / pending / changed / unavailable` 四态，按钮通过 store 调 Host 的 decide 桥。

- 入口：`index.ts`；`contract.ts` 暴露展示类型与 `resolveWorkspaceMcpTrustPresentation`。
- `pendingBanner.tsx`：会话内提示条。本地 workspace 走 Desktop Host 桥；远端 workspace 走当前
  绑定的 `IMcpSyncService.decideWorkspaceMcpTrust`，绝不回退到本机信任库。
- 不变量：不从原始配置重建展示文本（用 Host 的 `display`）；不本地判断信任；不可审核时按钮禁用；
  旧 Host 无 trust 元数据时不误报，也不把未知当作已信任。

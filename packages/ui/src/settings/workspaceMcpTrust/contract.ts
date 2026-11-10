/**
 * ui-workspace-mcp-trust 对外契约：把 Host 返回的 trust review 映射成四种展示状态；
 * 组件只渲染，不发信任决定（决定由 store 调 Host 桥）。
 */
export type {
  WorkspaceMcpTrustPresentation,
  WorkspaceMcpTrustUiState,
} from "./presentation.js";
export {
  resolveWorkspaceMcpTrustPresentation,
  shortenDeclarationDigest,
  workspaceMcpTrustReasonMessageId,
} from "./presentation.js";
export { WorkspaceMcpTrustPanel } from "./panel.js";

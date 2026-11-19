/**
 * 受管 worktree UI 模块清单。
 * 层：ui。仅投影本机 Host 的 managed-worktrees 服务；远端/手机不提供该能力。
 */
export const managedWorktreeUiModule = {
  id: "managed-worktree-ui",
  requires: ["services", "shared", "ui"],
  provides: ["managed-worktree-ui", "fork-destination"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

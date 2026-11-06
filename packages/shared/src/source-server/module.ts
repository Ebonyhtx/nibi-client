/**
 * source-server 模块清单（architecture-governance managed 模块）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const sourceServerModule = {
  id: "shared-source-server",
  requires: ["shared"],
  provides: ["source-server-contracts"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

/**
 * data-sync 模块清单（architecture-governance managed 模块）。
 * 层：contract < domain（纯比较/分批）< app（设备与服务状态 owner）< ui（设置页内容）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const dataSyncModule = {
  id: "data-sync",
  requires: ["services", "settings-scope", "shared", "ui"],
  provides: ["data-sync-page"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

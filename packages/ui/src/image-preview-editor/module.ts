/**
 * image-preview-editor 模块清单（architecture-governance managed 模块）。
 * 层：contract < domain（归一化几何/序列化）< ui（预览表面、工具栏、输入框目标桥）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const imagePreviewEditorModule = {
  id: "image-preview-editor",
  requires: ["ui"],
  provides: ["image-preview-editor"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

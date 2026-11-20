import { createContext, useContext } from "react";
import type { ImageFilePreviewContext } from "@/hooks/useImageFilePreview.js";

/**
 * 行渲染上下文（workspacePath/Home/Identity/RemoteSessionId）在 ConversationRowView
 * 外层注入给消息气泡，让文件名形式的图片引用能从当前 workspace 的 Host 读取原图。
 * 展示组件不自取 store；没有宿主注入时（只读回放等）引用保持不可交互。
 */
export const ImageFilePreviewScopeContext = createContext<ImageFilePreviewContext | null>(null);

export function useImageFilePreviewScope(): ImageFilePreviewContext | undefined {
  return useContext(ImageFilePreviewScopeContext) ?? undefined;
}

import { useCallback, useRef } from "react";
import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";

export const CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME = "max-w-2xl";
export const CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";
export const CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";

export const CONVERSATION_STATUS_PANEL_INLINE_OFFSET_CLASS_NAME = "-translate-x-42";
export const CONVERSATION_STATUS_PANEL_INLINE_OFFSET_PX = 168;
export const CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME =
  "@min-[1280px]/conversation:-translate-x-42";

export type ConversationStatusPanelResolvedVariant = ChatViewSummaryPanelVariant | "auto";

export function getConversationContentWidthClassName(params: {
  centeredEmptyLayout: boolean;
  statusPanelLayout: "none" | "auto" | "inline";
}): string {
  if (params.centeredEmptyLayout) return CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME;

  // 宽布局统一使用 1280px，避免面板状态变化时触发不同断点造成内容列跳变。
  return params.statusPanelLayout === "none"
    ? CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME
    : CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME;
}

export function resolveConversationStatusPanelVariant(params: {
  variantOverride: ConversationStatusPanelResolvedVariant | null;
}): ConversationStatusPanelResolvedVariant {
  // 自动模式必须保留到 DOM，由 conversation container query 裁决实际形态；
  // React 不再通过 ResizeObserver 把容器宽度翻译成业务状态。
  return params.variantOverride ?? "auto";
}

export function shouldUseConversationStatusPanelInlineLayout(params: {
  hasContent: boolean;
  variant: ConversationStatusPanelResolvedVariant;
}): boolean {
  return params.hasContent && params.variant !== "mini";
}

export function getConversationStatusPanelOffsetClassName(
  layout: "none" | "auto" | "inline",
): string | undefined {
  // 状态面板和会话宽布局统一在 1280px 启用，保证面板状态切换不改变响应分水岭。
  return layout === "none"
    ? undefined
    : CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME;
}

/**
 * 切换不同会话时通过递增 key 重置 SessionPane 实例以切断旧快照闭包链，
 * 同时对「草稿页首发送转成新会话」保持同一 key，避免输入焦点或流式启动态闪烁。
 */
export function useSessionPaneSwitchIsolation(params: {
  sessionId: string | null;
  onSessionCreated?: (sessionId: string) => void;
}): {
  sessionPaneKey: string;
  handleSessionCreated: ((sessionId: string) => void) | undefined;
} {
  const promotedSessionIdRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(params.sessionId);
  const paneEpochRef = useRef(0);

  if (prevSessionIdRef.current !== params.sessionId) {
    const promotedFromDraft =
      prevSessionIdRef.current === null &&
      params.sessionId !== null &&
      promotedSessionIdRef.current === params.sessionId;
    if (!promotedFromDraft) {
      paneEpochRef.current += 1;
    }
    promotedSessionIdRef.current = null;
    prevSessionIdRef.current = params.sessionId;
  }

  const onSessionCreated = params.onSessionCreated;
  const currentSessionId = params.sessionId;
  const handleSessionCreated = useCallback(
    (createdSessionId: string) => {
      if (currentSessionId === null) {
        promotedSessionIdRef.current = createdSessionId;
      }
      onSessionCreated?.(createdSessionId);
    },
    [currentSessionId, onSessionCreated],
  );

  return {
    sessionPaneKey: `pane-${paneEpochRef.current}`,
    handleSessionCreated: onSessionCreated ? handleSessionCreated : undefined,
  };
}

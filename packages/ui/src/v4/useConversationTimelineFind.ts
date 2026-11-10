import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationRow,
  SessionPhase,
} from "@nibi/shared/nibi-protocol-v4";
import {
  applyConversationFindHighlights,
  applySearchResultHighlight,
  clearConversationFindHighlights,
  clearSearchResultHighlight,
  isConversationFindRowMounted,
  scrollConversationFindRangeIntoView,
} from "@/v4/conversationFindHighlightDom.js";
import {
  buildConversationFindIndex,
  findConversationMatchIndexByKey,
  getConversationFindMatchKey,
  resolveConversationFindActiveIndex,
  resolveSearchResultHighlightMatch,
  type ConversationFindMatch,
  type ConversationFindMatchKey,
} from "@/v4/conversationFindIndex.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";

const FIND_AUTO_LOAD_ROW_LIMIT = 1200;
const SEARCH_RESULT_HIGHLIGHT_DURATION_MS = 3000;

export interface UseConversationTimelineFindOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  renderUnits: readonly ConversationTurnRenderUnit[];
  rows: readonly ConversationRow[];
  mountedRowsKey: string;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => Promise<void> | void;
  sessionPhase?: SessionPhase;
  conversationFindQuery: string;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  scrollToUnit: (unitIndex: number) => void;
  /** 宽度校正期间的测量提交序号；精确居中要等这个生命周期结束。 */
  layoutCommitRevision?: number;
  /** 内容列宽度仍在变化（含同步提交中）时，精确定位让位给布局 owner。 */
  isLayoutSettling?: () => boolean;
}

function normalizeSearchResultSnippet(text: string): string {
  return text.replace(/^\.{3}/, "").replace(/\.{3}$/, "").replace(/\s+/g, " ").trim();
}

function sourceTextContainsSnippet(sourceText: string, snippet: string): boolean {
  const normalizedSnippet = normalizeSearchResultSnippet(snippet).toLocaleLowerCase();
  if (!normalizedSnippet) {
    return false;
  }
  return normalizeSearchResultSnippet(sourceText)
    .toLocaleLowerCase()
    .includes(normalizedSnippet);
}

export function useConversationTimelineFind({
  rootRef,
  renderUnits,
  rows,
  mountedRowsKey,
  canLoadOlder,
  loadingOlder,
  onLoadOlder,
  sessionPhase,
  conversationFindQuery,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  scrollToUnit,
  layoutCommitRevision = 0,
  isLayoutSettling,
}: UseConversationTimelineFindOptions) {
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const findStable = sessionPhase !== "running" && sessionPhase !== "prewarming";
  const unitFindCacheRef = useRef(
    new Map<string, { source: ConversationFindMatch[]; loadedRowCount: number }>(),
  );
  const unitFindCacheQueryRef = useRef("");
  const conversationFindIndex = useMemo(
    () => {
      const query = conversationFindQuery;
      const normalizedQuery = query.trim().toLocaleLowerCase();
      if (unitFindCacheQueryRef.current !== normalizedQuery) {
        unitFindCacheRef.current.clear();
        unitFindCacheQueryRef.current = normalizedQuery;
      }
      const matches: ConversationFindMatch[] = [];
      let loadedRowCount = 0;
      // 修复原因：streaming delta 只会改变当前 running turn；稳定 turn 的全文索引可复用，
      // 避免每个 token 都扫描整段历史，导致长会话 renderer 主线程被持续占满。
      renderUnits.forEach((unit, unitIndex) => {
        const cacheKey = `${normalizedQuery}:${codeCommentCardsEnabled}:${unit.key}`;
        const cached = !unit.isRunning ? unitFindCacheRef.current.get(cacheKey) : undefined;
        const unitIndexResult = cached
          ? { matches: cached.source, loadedRowCount: cached.loadedRowCount }
          : buildConversationFindIndex([unit], query, {
              projectAssistantCodeComments: codeCommentCardsEnabled,
            });
        if (!unit.isRunning && !cached) {
          unitFindCacheRef.current.set(cacheKey, {
            source: unitIndexResult.matches,
            loadedRowCount: unitIndexResult.loadedRowCount,
          });
        }
        loadedRowCount += unitIndexResult.loadedRowCount;
        for (const match of unitIndexResult.matches) {
          matches.push({ ...match, globalIndex: matches.length, unitIndex });
        }
      });
      return { query: normalizedQuery, matches, matchCount: matches.length, loadedRowCount };
    },
    [codeCommentCardsEnabled, conversationFindQuery, renderUnits],
  );
  const searchResultFindIndex = useMemo(
    () =>
      findStable && searchResultHighlightRequest
        ? buildConversationFindIndex(renderUnits, searchResultHighlightRequest.query, {
            projectAssistantCodeComments: codeCommentCardsEnabled,
          })
        : buildConversationFindIndex([], ""),
    [codeCommentCardsEnabled, findStable, renderUnits, searchResultHighlightRequest],
  );
  const [resolvedFindActiveIndex, setResolvedFindActiveIndex] = useState(-1);
  const findActiveKeyRef = useRef<ConversationFindMatchKey | null>(null);
  const lastFindQueryRef = useRef("");
  const lastExternalActiveIndexRef = useRef(conversationFindActiveIndex);
  const lastFindScrollKeyRef = useRef("");
  const lastFindHighlightScrollKeyRef = useRef("");
  const lastFindAutoLoadAttemptRef = useRef("");
  const lastSearchResultAutoLoadAttemptRef = useRef("");
  const searchResultAppliedRequestRef = useRef<number | null>(null);
  const searchResultCleanupTimerRef = useRef<number | undefined>(undefined);
  const activeFindMatch =
    resolvedFindActiveIndex >= 0
      ? (conversationFindIndex.matches[resolvedFindActiveIndex] ?? null)
      : null;

  useEffect(() => {
    if (!conversationFindIndex.query) {
      findActiveKeyRef.current = null;
      lastFindQueryRef.current = "";
      lastFindScrollKeyRef.current = "";
      lastFindHighlightScrollKeyRef.current = "";
      setResolvedFindActiveIndex(-1);
      clearConversationFindHighlights();
      onConversationFindMatchStateChange?.({ matchCount: 0, activeIndex: -1 });
      return;
    }

    const queryChanged = lastFindQueryRef.current !== conversationFindIndex.query;
    const externalActiveIndexChanged =
      lastExternalActiveIndexRef.current !== conversationFindActiveIndex;
    let nextActiveIndex = resolveConversationFindActiveIndex(
      conversationFindIndex,
      conversationFindActiveIndex,
    );

    if (!queryChanged && !externalActiveIndexChanged) {
      const rebasedIndex = findConversationMatchIndexByKey(
        conversationFindIndex,
        findActiveKeyRef.current,
      );
      if (rebasedIndex >= 0) {
        nextActiveIndex = rebasedIndex;
      }
    }

    const activeMatch =
      nextActiveIndex >= 0 ? (conversationFindIndex.matches[nextActiveIndex] ?? null) : null;
    findActiveKeyRef.current = getConversationFindMatchKey(activeMatch);
    lastFindQueryRef.current = conversationFindIndex.query;
    lastExternalActiveIndexRef.current = nextActiveIndex;
    setResolvedFindActiveIndex(nextActiveIndex);
    onConversationFindMatchStateChange?.({
      matchCount: conversationFindIndex.matchCount,
      activeIndex: nextActiveIndex,
    });
  }, [
    conversationFindActiveIndex,
    conversationFindIndex,
    onConversationFindMatchStateChange,
  ]);

  useEffect(() => {
    if (
      !findStable ||
      !conversationFindIndex.query ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const attemptKey = `${conversationFindIndex.query}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
    if (lastFindAutoLoadAttemptRef.current === attemptKey) {
      return;
    }
    lastFindAutoLoadAttemptRef.current = attemptKey;
    void onLoadOlder?.();
  }, [
    canLoadOlder,
    conversationFindIndex.query,
    findStable,
    loadingOlder,
    onLoadOlder,
    rows,
  ]);

  useEffect(() => {
    if (!conversationFindIndex.query || !activeFindMatch) {
      return;
    }
    // 显式上下项导航（含单命中环绕）每次请求都要重新驱动虚拟窗口：
    // 目标可能已滚出窗口，不能只靠高亮 effect 或同一命中的滚动去重。
    const scrollKey = `${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch.rowId}:${activeFindMatch.rowMatchIndex}:${activeFindMatch.unitIndex}`;
    if (lastFindScrollKeyRef.current === scrollKey) {
      return;
    }
    lastFindScrollKeyRef.current = scrollKey;
    scrollToUnit(activeFindMatch.unitIndex);
  }, [
    activeFindMatch,
    conversationFindIndex.query,
    conversationFindNavigationRequestId,
    scrollToUnit,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationFindIndex.query) {
      clearConversationFindHighlights();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      // 宽度校正 / 同步测高提交期间不精确定位：等既有收敛回调发布提交后
      // 由 layoutCommitRevision 重新触发，避免被上方缓冲行测高推离视口。
      if (isLayoutSettling?.()) {
        return;
      }
      const activeRange = applyConversationFindHighlights({
        root,
        query: conversationFindQuery,
        matches: conversationFindIndex.matches,
        activeMatch: activeFindMatch,
      });
      const highlightScrollKey = `${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch?.rowId ?? "none"}:${activeFindMatch?.rowMatchIndex ?? -1}:${activeFindMatch?.unitIndex ?? -1}`;
      if (activeRange && lastFindHighlightScrollKeyRef.current !== highlightScrollKey) {
        lastFindHighlightScrollKeyRef.current = highlightScrollKey;
        scrollConversationFindRangeIntoView(activeRange);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    activeFindMatch,
    conversationFindIndex,
    conversationFindQuery,
    conversationFindNavigationRequestId,
    isLayoutSettling,
    layoutCommitRevision,
    mountedRowsKey,
    rootRef,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (
      !request ||
      !findStable ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const snippet = request.snippet?.trim();
    const shouldLoadMore = snippet
      ? !searchResultFindIndex.matches.some((match) =>
          sourceTextContainsSnippet(match.sourceText, snippet),
        )
      : searchResultFindIndex.matchCount === 0;
    if (shouldLoadMore) {
      const attemptKey = `${request.requestId}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
      if (lastSearchResultAutoLoadAttemptRef.current === attemptKey) {
        return;
      }
      lastSearchResultAutoLoadAttemptRef.current = attemptKey;
      void onLoadOlder?.();
    }
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    onLoadOlder,
    rows,
    searchResultFindIndex,
    searchResultHighlightRequest,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (!request || !findStable) {
      clearSearchResultHighlight();
      searchResultAppliedRequestRef.current = null;
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
        searchResultCleanupTimerRef.current = undefined;
      }
      return;
    }

    const match = resolveSearchResultHighlightMatch(searchResultFindIndex, request);
    const snippet = request.snippet?.trim();
    const snippetFound = snippet
      ? searchResultFindIndex.matches.some((candidate) =>
          sourceTextContainsSnippet(candidate.sourceText, snippet),
        )
      : true;
    const canStillLoad =
      canLoadOlder && rows.length < FIND_AUTO_LOAD_ROW_LIMIT && !loadingOlder;
    if (snippet && !snippetFound && (canStillLoad || loadingOlder)) {
      return;
    }
    if (!match) {
      if (!canStillLoad) {
        onSearchResultHighlightDone?.(request.requestId);
      }
      return;
    }
    if (searchResultAppliedRequestRef.current === request.requestId) {
      return;
    }
    // 精确定位必须等宽度校正生命周期结束；测量提交会以 layoutCommitRevision 重跑本 effect。
    if (isLayoutSettling?.()) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      // CR-01：Range=null 不等于目标未挂载。先判断行是否在窗口内：
      // 未挂载 → 本次请求仍未完成，允许再次粗定位让目标进窗；
      // 已挂载且布局已确认 → 无论能否创建 Range 都结束本次定位（无 Range 不滚动）。
      if (!isConversationFindRowMounted(root, match.rowId)) {
        scrollToUnit(match.unitIndex);
        return;
      }
      const range = applySearchResultHighlight({
        root,
        query: request.query,
        match,
      });
      searchResultAppliedRequestRef.current = request.requestId;
      if (!range) {
        // 目标已挂载但渲染文本没有对应节点（源码命中 Markdown 标记/链接地址）：
        // 本次定位直接结束，不滚动、不重试，也不占用临时高亮层。
        clearSearchResultHighlight();
        onSearchResultHighlightDone?.(request.requestId);
        return;
      }
      scrollConversationFindRangeIntoView(range);
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
      searchResultCleanupTimerRef.current = window.setTimeout(() => {
        clearSearchResultHighlight();
        onSearchResultHighlightDone?.(request.requestId);
        searchResultCleanupTimerRef.current = undefined;
      }, SEARCH_RESULT_HIGHLIGHT_DURATION_MS);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    canLoadOlder,
    findStable,
    isLayoutSettling,
    layoutCommitRevision,
    loadingOlder,
    mountedRowsKey,
    onSearchResultHighlightDone,
    rootRef,
    rows,
    scrollToUnit,
    searchResultFindIndex,
    searchResultHighlightRequest,
  ]);

  useEffect(() => {
    return () => {
      clearConversationFindHighlights();
      clearSearchResultHighlight();
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
    };
  }, []);
}

import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export type ConversationTurnNavigatorAssistantPreviewKind =
  | "empty"
  | "running"
  | "text";

export interface ConversationTurnNavigatorItem {
  key: string;
  turnId: string;
  unitIndex: number;
  rowId: number;
  userPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
  isRunning: boolean;
}

export interface BuildConversationTurnNavigatorItemsOptions {
  assistantEmptyPreview: string;
  assistantRunningPreview: string;
  userFallbackPreview: string;
  maxPreviewChars?: number;
  maxPreviewParagraphs?: number;
}

export interface ConversationTurnNavigatorVirtualItem {
  index: number;
  start: number;
  size: number;
}

export interface ResolveConversationTurnNavigatorActiveUnitIndexOptions {
  items: readonly ConversationTurnNavigatorItem[];
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export interface ConversationTurnNavigatorQueryPosition {
  rowId: number;
  start: number;
  end: number;
}

export interface ResolveConversationTurnNavigatorActiveQueryRowIdOptions {
  positions: readonly ConversationTurnNavigatorQueryPosition[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export type ConversationTurnNavigatorBarTone = "idle" | "mid" | "near" | "peak";
export type ConversationTurnNavigatorBarColorTone = "focus" | "muted";

export interface ConversationTurnNavigatorBarVisualState {
  colorTone: ConversationTurnNavigatorBarColorTone;
  opacity: number;
  scaleX: number;
  tone: ConversationTurnNavigatorBarTone;
}

export interface ResolveConversationTurnNavigatorBarVisualStateOptions {
  itemIndex: number;
  visualFocusItemIndex: number | undefined;
}

export interface ResolveConversationTurnNavigatorVisualFocusItemIndexOptions {
  activeItemIndex: number;
  interactionItemIndex: number | undefined;
}

export const CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864;

export type ConversationTurnNavigatorHydrationResult =
  | { status: "hydrated"; logEpoch: string }
  | { status: "not-enough-queries"; logEpoch: string }
  | { status: "retryable-failure"; logEpoch: string }
  | { status: "stale"; logEpoch: string };

export function shouldHydrateConversationTurnNavigatorDirectory(params: {
  canLoadOlder: boolean;
  containerWidthPx: number;
  hasLoadHandler: boolean;
  loadingOlder: boolean;
}): boolean {
  return (
    params.canLoadOlder &&
    !params.loadingOlder &&
    params.hasLoadHandler &&
    params.containerWidthPx >= CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX
  );
}

export function resolveConversationTurnNavigatorHydrationRetryDelayMs(
  failedAttemptCount: number,
): number | null {
  if (failedAttemptCount === 1) return 250;
  if (failedAttemptCount === 2) return 1_000;
  return null;
}

const DEFAULT_MAX_PREVIEW_CHARS = 220;
const DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;

function isPreviewWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

/**
 * 只归一化「截断一定用得到」的前缀：空白折叠与 trim 语义和全量 replace 一致，
 * 但单个超长段落不会因为流式追加而反复整段扫描。返回结果长度不超过 maxChars。
 */
function normalizePreviewParagraphPrefix(raw: string, maxChars: number): string {
  let normalized = "";
  let pendingSpace = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (isPreviewWhitespace(char)) {
      // 段首空白被 trim 掉；段中连续空白折叠成一个空格，延后到下一个可见字符再写入。
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) {
      normalized += " ";
      pendingSpace = false;
    }
    normalized += char;
    if (normalized.length >= maxChars) {
      break;
    }
  }
  return normalized;
}

/**
 * 导航预览正文：保持既有空白归一、段落上限、字符上限与省略号语义。
 * 只扫描足够确定结果的前缀——段落数达到上限或字符数达到上限即停止，
 * 不再为每次流式追加先处理所有历史正文再截断。
 */
function buildPreviewText({
  texts,
  fallback,
  maxPreviewChars,
  maxPreviewParagraphs,
}: {
  texts: readonly string[];
  fallback: string;
  maxPreviewChars: number;
  maxPreviewParagraphs: number;
}): string {
  const normalizedMaxChars = Math.max(8, maxPreviewChars);
  const paragraphLimit = Math.max(1, maxPreviewParagraphs);
  // 多保留一个字符：能区分「恰好等于上限」与「还有更多正文」，
  // 省略号语义不依赖继续扫描剩余历史正文。
  const scanLimit = normalizedMaxChars + 1;
  const paragraphs: string[] = [];
  let joinedLength = 0;
  let determined = false;

  for (const text of texts) {
    if (determined) break;
    for (const rawParagraph of text.trim().split(/\n\s*\n/u)) {
      const paragraph = normalizePreviewParagraphPrefix(rawParagraph, scanLimit);
      if (!paragraph) continue;
      paragraphs.push(paragraph);
      // 拼接后每个段落之间还有一个换行符。
      joinedLength += paragraph.length + (paragraphs.length > 1 ? 1 : 0);
      if (paragraphs.length >= paragraphLimit || joinedLength > normalizedMaxChars) {
        determined = true;
        break;
      }
    }
  }

  if (paragraphs.length === 0) {
    return fallback;
  }
  const joined = paragraphs.join("\n");
  if (joined.length <= normalizedMaxChars) {
    return joined;
  }
  return `${joined.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
}

function buildAssistantPreview(
  unit: ConversationTurnRenderUnit,
  options: Required<BuildConversationTurnNavigatorItemsOptions>,
): {
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
} {
  if (unit.assistantTextRows.length > 0) {
    return {
      assistantPreview: buildPreviewText({
        texts: unit.assistantTextRows.map((row) => row.text),
        fallback: options.assistantEmptyPreview,
        maxPreviewChars: options.maxPreviewChars,
        maxPreviewParagraphs: options.maxPreviewParagraphs,
      }),
      assistantPreviewKind: "text",
    };
  }

  if (unit.isRunning) {
    return {
      assistantPreview: options.assistantRunningPreview,
      assistantPreviewKind: "running",
    };
  }

  return {
    assistantPreview: options.assistantEmptyPreview,
    assistantPreviewKind: "empty",
  };
}

interface ConversationTurnNavigatorItemsCacheEntry {
  optionsKey: string;
  unitIndex: number;
  items: ConversationTurnNavigatorItem[];
}

// 按 turn 原始输入复用导航项：unit 引用稳定时（历史轮）目录项与预览保持同一对象，
// 流式帧只重建变化的那一轮。WeakMap 以窗口内的 unit 为键，离开窗口即被回收，
// 不延长历史窗口生命期，也不成为第二份消息状态。
const navigatorItemsCache = new WeakMap<
  ConversationTurnRenderUnit,
  ConversationTurnNavigatorItemsCacheEntry
>();

function buildNavigatorItemsForUnit(
  unit: ConversationTurnRenderUnit,
  unitIndex: number,
  options: Required<BuildConversationTurnNavigatorItemsOptions>,
): ConversationTurnNavigatorItem[] {
  // provider/store 的物理 role=user 还包含 background/goal/mailbox
  // 等系统上下文；目录代表用户主动 query，只能使用投影明确裁决的 realUser。
  const realUserInputs = unit.visibleUserInputs.filter((row) => row.origin === "realUser");
  if (unit.timelineOnly || realUserInputs.length === 0) {
    return [];
  }

  // 导航项按 query 拆分，但 hover 的 assistant 摘要保持旧产品语义：
  // 取所属 product turn 的文本结果，不在 renderer 猜测 guide 回复分段。
  const { assistantPreview, assistantPreviewKind } = buildAssistantPreview(unit, options);
  return realUserInputs.map((row, queryIndex) => ({
    // 不能以 product turn 为目录粒度，并把同一 turn 的 steer query
    // 全部拼进一个 preview。目录真正导航的是用户可见 query，必须用稳定 row
    // 身份逐条建项，turnId 只负责把虚拟列表先定位到所属容器。
    key: `${unit.key}:query:${row.entityId ?? row.rowId}`,
    turnId: unit.turnId,
    unitIndex,
    rowId: row.rowId,
    userPreview: buildPreviewText({
      texts: [row.text],
      fallback: options.userFallbackPreview,
      maxPreviewChars: options.maxPreviewChars,
      maxPreviewParagraphs: options.maxPreviewParagraphs,
    }),
    assistantPreview,
    assistantPreviewKind,
    // 同一 running product turn 可能已有多个已结束 guide segment；只有最后一条
    // query 仍代表当前工作，避免所有旧 query 一起呈现 running 强调。
    isRunning: unit.isRunning && queryIndex === realUserInputs.length - 1,
  }));
}

export function buildConversationTurnNavigatorItems(
  units: readonly ConversationTurnRenderUnit[],
  options: BuildConversationTurnNavigatorItemsOptions,
): ConversationTurnNavigatorItem[] {
  const resolvedOptions: Required<BuildConversationTurnNavigatorItemsOptions> = {
    ...options,
    maxPreviewChars: options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs:
      options.maxPreviewParagraphs ?? DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  };
  const optionsKey = [
    resolvedOptions.assistantEmptyPreview,
    resolvedOptions.assistantRunningPreview,
    resolvedOptions.userFallbackPreview,
    String(resolvedOptions.maxPreviewChars),
    String(resolvedOptions.maxPreviewParagraphs),
  ].join("\u0000");

  return units.flatMap((unit, unitIndex) => {
    const cached = navigatorItemsCache.get(unit);
    if (cached && cached.optionsKey === optionsKey && cached.unitIndex === unitIndex) {
      return cached.items;
    }
    const items = buildNavigatorItemsForUnit(unit, unitIndex, resolvedOptions);
    navigatorItemsCache.set(unit, { optionsKey, unitIndex, items });
    return items;
  });
}

function resolveFiniteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveConversationTurnNavigatorActiveUnitIndex({
  items,
  virtualItems,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveUnitIndexOptions): number | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const itemByUnitIndex = new Map(items.map((item) => [item.unitIndex, item]));
  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd =
    viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));

  let activeUnitIndex: number | undefined;
  let activeDistance = Number.POSITIVE_INFINITY;
  for (const virtualItem of virtualItems) {
    const item = itemByUnitIndex.get(virtualItem.index);
    if (!item) {
      continue;
    }
    const rowStart = resolveFiniteNonNegative(virtualItem.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(virtualItem.size));
    if (rowEnd < viewportStart || rowStart > viewportEnd) {
      continue;
    }
    const distanceToViewportStart =
      rowStart <= viewportStart ? 0 : rowStart - viewportStart;
    if (distanceToViewportStart < activeDistance) {
      activeUnitIndex = item.unitIndex;
      activeDistance = distanceToViewportStart;
    }
  }

  if (activeUnitIndex !== undefined) {
    return activeUnitIndex;
  }

  const topVirtualIndex = virtualItems.find((item) => {
    const rowStart = resolveFiniteNonNegative(item.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(item.size));
    return rowEnd >= viewportStart && rowStart <= viewportEnd;
  })?.index;
  if (topVirtualIndex === undefined) {
    return items[0]?.unitIndex;
  }

  return (
    items.find((item) => item.unitIndex >= topVirtualIndex)?.unitIndex ??
    items.findLast((item) => item.unitIndex <= topVirtualIndex)?.unitIndex ??
    items[0]?.unitIndex
  );
}

export function resolveConversationTurnNavigatorActiveQueryRowId({
  positions,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveQueryRowIdOptions): number | undefined {
  if (positions.length === 0) return undefined;

  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd =
    viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));
  const normalized = positions
    .map((position) => {
      const start = resolveFiniteNonNegative(position.start);
      return {
        rowId: position.rowId,
        start,
        end: Math.max(start, resolveFiniteNonNegative(position.end)),
      };
    })
    .sort((left, right) => left.start - right.start || left.rowId - right.rowId);

  const visible = normalized.filter(
    (position) => position.end >= viewportStart && position.start <= viewportEnd,
  );
  if (visible.length > 0) {
    return visible.reduce((nearest, candidate) =>
      Math.abs(candidate.start - viewportStart) <
      Math.abs(nearest.start - viewportStart)
        ? candidate
        : nearest,
    ).rowId;
  }

  return (
    normalized.findLast((position) => position.start <= viewportStart)?.rowId ??
    normalized.find((position) => position.start > viewportStart)?.rowId
  );
}

export function resolveConversationTurnNavigatorBarVisualState({
  itemIndex,
  visualFocusItemIndex,
}: ResolveConversationTurnNavigatorBarVisualStateOptions): ConversationTurnNavigatorBarVisualState {
  if (visualFocusItemIndex === undefined) {
    return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
  }

  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) {
    return { colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak" };
  }
  if (distance === 1) {
    return { colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near" };
  }
  if (distance === 2) {
    return { colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid" };
  }
  return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
}

export function resolveConversationTurnNavigatorVisualFocusItemIndex({
  interactionItemIndex,
}: ResolveConversationTurnNavigatorVisualFocusItemIndexOptions): number | undefined {
  return interactionItemIndex;
}

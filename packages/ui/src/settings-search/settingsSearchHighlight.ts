/**
 * 设置搜索的滚动与 2 秒高亮。
 *
 * 这里不依赖 React：SettingsPage 在路由切换后的 effect 里调用，
 * 单测可以直接对 DOM 断言滚动调用、属性写入和定时清理。
 */
export const SETTINGS_SEARCH_TARGET_ATTRIBUTE = "data-settings-search-target";
export const SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE = "data-settings-search-highlighted";
export const SETTINGS_SEARCH_HIGHLIGHT_DURATION_MS = 2000;

export interface HighlightSettingsSearchTargetOptions {
  /** 目标项缺失时回退到分区锚点。 */
  fallbackTargetId?: string;
  durationMs?: number;
}

/** 按 targetId 找锚点；不用 CSS.escape，避免不同运行时的转义差异。 */
export function findSettingsSearchTarget(
  root: ParentNode | null | undefined,
  targetId: string,
): HTMLElement | null {
  if (!root) return null;
  const targets = root.querySelectorAll<HTMLElement>(`[${SETTINGS_SEARCH_TARGET_ATTRIBUTE}]`);
  for (const target of targets) {
    if (target.getAttribute(SETTINGS_SEARCH_TARGET_ATTRIBUTE) === targetId) {
      return target;
    }
  }
  return null;
}

/**
 * 滚动到目标并高亮，返回清理函数。
 * 目标不存在时尝试 fallback；仍找不到则不产生副作用。
 */
export function highlightSettingsSearchTarget(
  root: ParentNode | null | undefined,
  targetId: string,
  options: HighlightSettingsSearchTargetOptions = {},
): () => void {
  const target =
    findSettingsSearchTarget(root, targetId) ??
    (options.fallbackTargetId
      ? findSettingsSearchTarget(root, options.fallbackTargetId)
      : null);
  if (!target) return () => {};

  target.scrollIntoView?.({ block: "center" });
  target.setAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE, "true");

  const durationMs = options.durationMs ?? SETTINGS_SEARCH_HIGHLIGHT_DURATION_MS;
  const timeout = setTimeout(() => {
    target.removeAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE);
  }, durationMs);

  return () => {
    clearTimeout(timeout);
    target.removeAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE);
  };
}
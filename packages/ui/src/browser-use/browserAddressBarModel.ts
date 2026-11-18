/** 地址栏窄于 9rem 时进入紧凑布局：收掉左侧站点设置入口，并把输入框左对齐。 */
export const BROWSER_ADDRESS_BAR_COMPACT_WIDTH_REM = 9;
export const BROWSER_ADDRESS_BAR_FALLBACK_ROOT_FONT_SIZE_PX = 16;

export function isBrowserAddressBarCompact(
  widthPx: number,
  rootFontSizePx = BROWSER_ADDRESS_BAR_FALLBACK_ROOT_FONT_SIZE_PX,
): boolean {
  return (
    Number.isFinite(widthPx) &&
    widthPx > 0 &&
    widthPx < BROWSER_ADDRESS_BAR_COMPACT_WIDTH_REM * rootFontSizePx
  );
}

export function readBrowserAddressBarRootFontSizePx(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return BROWSER_ADDRESS_BAR_FALLBACK_ROOT_FONT_SIZE_PX;
  }
  const parsed = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : BROWSER_ADDRESS_BAR_FALLBACK_ROOT_FONT_SIZE_PX;
}
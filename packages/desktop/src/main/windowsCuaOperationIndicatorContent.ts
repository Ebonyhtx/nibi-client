import type { Locale } from "@nibi/shared";

/**
 * Windows CUA 操作提示条的呈现层：文案、尺寸与 HTML。
 *
 * 与窗口生命周期分开，是因为两者的变更理由不同——这里跟着文案与视觉走，
 * `windowsCuaOperationIndicator.ts` 跟着显示/隐藏时机与 Electron 窗口行为走。
 */

/**
 * NIBI 标记（内联 base64，来自 build/cua-indicator-mark.png ← build/icon.png 缩到 96×96）。
 * 为什么内联：这个提示条是 data: URL 的 HTML，CSP 是 `default-src 'none'` —— 外链图片一律被拒，
 * 只有内联（data:）能用。
 */
const INDICATOR_MARK_DATA_URL =
  "data:image/png;base64,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";
const INDICATOR_MARK_SIZE = 18;
const INDICATOR_MARK_GAP = 8;

const INDICATOR_CARD_HEIGHT = 38;
export const INDICATOR_CARD_TOP_OFFSET = 12;
export const INDICATOR_SHADOW_INSET = { top: 6, right: 8, bottom: 12, left: 8 } as const;

export function indicatorCopy(locale: Locale): { text: string; width: number } {
  // width 要把标记与它的间距算进去，否则文字被裁（窗口尺寸由它推导）。
  const markWidth = INDICATOR_MARK_SIZE + INDICATOR_MARK_GAP;
  return locale === "zh-CN"
    ? { text: "NIBI 正在操作电脑", width: 234 + markWidth }
    : { text: "NIBI is controlling your computer", width: 308 + markWidth };
}

export function indicatorWindowSize(locale: Locale): { width: number; height: number } {
  const { width } = indicatorCopy(locale);
  return {
    width: width + INDICATOR_SHADOW_INSET.left + INDICATOR_SHADOW_INSET.right,
    height: INDICATOR_SHADOW_INSET.top + INDICATOR_CARD_HEIGHT + INDICATOR_SHADOW_INSET.bottom,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function indicatorHtml(locale: Locale): string {
  const copy = indicatorCopy(locale);
  return `<!doctype html>
<html lang="${locale}" data-state="active">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { display: flex; align-items: center; justify-content: center; padding: 6px 8px 12px; font-family: "Segoe UI Variable", "Segoe UI", sans-serif; }
    .indicator {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; height: 38px; padding: 0 18px;
      color: #202124; background: rgba(255, 255, 255, 0.96);
      border: 1px solid rgba(15, 23, 42, 0.14); border-radius: 12px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 12px -6px rgba(15, 23, 42, 0.18);
      font-size: 13px; font-weight: 600; line-height: 1; white-space: nowrap;
      opacity: 1; transform: translateY(0);
      transition: opacity 120ms ease, transform 120ms ease;
      animation: enter 140ms ease-out both;
    }
    .mark { width: 18px; height: 18px; border-radius: 5px; flex: none; display: block; }
    .dots { display: flex; align-items: center; gap: 3px; }
    .dot { width: 4px; height: 4px; border-radius: 50%; background: #64748b; animation: pulse 1.2s ease-in-out infinite; }
    .dot:nth-child(2) { animation-delay: 120ms; }
    .dot:nth-child(3) { animation-delay: 240ms; }
    html[data-state="leaving"] .indicator { opacity: 0; transform: translateY(-6px); }
    @keyframes enter { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes pulse { 0%, 70%, 100% { opacity: .35; transform: scale(.8); } 35% { opacity: 1; transform: scale(1); } }
    @media (prefers-color-scheme: dark) {
      .indicator { color: #f8fafc; background: rgba(35, 38, 43, 0.96); border-color: rgba(255, 255, 255, 0.14); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18), 0 6px 12px -6px rgba(0, 0, 0, 0.28); }
      .dot { background: #a8b3c4; }
    }
    @media (prefers-reduced-motion: reduce) {
      .indicator, .dot { animation: none; transition: opacity 1ms linear; transform: none; }
      html[data-state="leaving"] .indicator { transform: none; }
    }
  </style>
</head>
<body><div class="indicator" role="status" aria-live="polite"><img class="mark" alt="" src="${INDICATOR_MARK_DATA_URL}"><span class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span><span>${escapeHtml(copy.text)}</span></div></body>
</html>`;
}

export function indicatorDataUrl(locale: Locale): string {
  return `data:text/html;base64,${Buffer.from(indicatorHtml(locale), "utf8").toString("base64")}`;
}

/**
 * macOS 桌面「字体平滑」偏好。
 *
 * 默认开启：只有显式存过 `false` 才算关闭；关闭时不写根节点 class，
 * 让 macOS 回到系统默认字形渲染（可能更粗）。
 *
 * 状态放 store 的 `macFontSmoothingEnabled` 字段，跨窗口走 store 现有的
 * BroadcastService 同步；本模块只负责 localStorage 读写和 `:root` class 副作用。
 */
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

export const MACOS_FONT_SMOOTHING_STORAGE_KEY = "nibi-macos-font-smoothing";
export const MACOS_FONT_SMOOTHING_CLASS = "font-smoothing-enabled";

/** 只有显式关闭才是关闭；缺省、空值、非法值都按默认开启处理。 */
export function normalizeMacFontSmoothingEnabled(value: unknown): boolean {
  return !(value === false || value === "false");
}

/** 读取已保存偏好；没有记录时默认开启。 */
export function readMacFontSmoothingEnabled(): boolean {
  return normalizeMacFontSmoothingEnabled(
    readSafeLocalStorage(MACOS_FONT_SMOOTHING_STORAGE_KEY),
  );
}

/** 入口只对 macOS 桌面 renderer 展示；Web/Windows/Linux 即使是 macOS 浏览器也不显示。 */
export function shouldShowMacFontSmoothingSetting(input: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
}): boolean {
  return Boolean(input.isDesktop && input.isMacDesktop);
}

/** 只落 DOM；写入持久化请走 persistMacFontSmoothingEnabled。 */
export function applyMacFontSmoothingEnabled(enabled: unknown): boolean {
  const normalized = normalizeMacFontSmoothingEnabled(enabled);
  if (typeof document !== "undefined") {
    document.documentElement?.classList.toggle(MACOS_FONT_SMOOTHING_CLASS, normalized);
  }
  return normalized;
}

/** 设置开关的唯一写入口：持久化 + 立即切换 `:root` class。 */
export function persistMacFontSmoothingEnabled(enabled: unknown): boolean {
  const normalized = normalizeMacFontSmoothingEnabled(enabled);
  writeSafeLocalStorage(MACOS_FONT_SMOOTHING_STORAGE_KEY, normalized ? "true" : "false");
  return applyMacFontSmoothingEnabled(normalized);
}

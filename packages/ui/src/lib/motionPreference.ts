import { useSyncExternalStore } from "react";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

/**
 * 界面动效偏好（外观设置 → 界面设置 → 界面动效）。
 *
 * 关闭后等价于系统级「减少动态效果」，但必须比它多一层：系统偏好只能用
 * `@media (prefers-reduced-motion: reduce)` 表达，而 JS 驱动、逐帧自绘的动画
 * （打字机、翻牌、跑马灯、彩带、工作流面部）根本不经过 CSS transition / keyframes，
 * 只写媒体查询管不到它们。所以这里落一个 `<html data-zcode-motion="on|off">`：
 *
 * - CSS 侧由 styles.css 末尾的全局覆盖统一归零，不用逐块复制媒体查询；
 * - JS 侧统一走 `isMotionDisabled()` / `useMotionDisabled()`，不再各自内联 matchMedia。
 *
 * 判断始终是「用户设置关闭」或「系统要求减少」取或 —— 任一生效就关闭，
 * 用户在设置里重新打开也不会压过系统的无障碍偏好。
 */
export const MOTION_STORAGE_KEY = "zcode-motion";

const MOTION_ATTRIBUTE = "data-zcode-motion";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type Listener = () => void;

const listeners = new Set<Listener>();

function emit(): void {
  // 直接遍历 Set：监听器在回调里退订（React 卸载时会这么做）时，删掉尚未访问的元素是安全的。
  for (const listener of listeners) {
    listener();
  }
}

/** 默认开启动效：只有显式设为 false 才算关闭。 */
export function normalizeMotionEnabled(value: unknown): boolean {
  return value !== false;
}

export function parseMotionEnabled(rawValue: string | null): boolean {
  return rawValue === null ? true : rawValue !== "false";
}

export function loadMotionEnabled(): boolean {
  return parseMotionEnabled(readSafeLocalStorage(MOTION_STORAGE_KEY));
}

function mediaPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** 动效是否应当关闭：应用内开关关闭，或系统要求减少动态效果。 */
export function isMotionDisabled(): boolean {
  return !loadMotionEnabled() || mediaPrefersReducedMotion();
}

/** `prefers-reduced-motion: no-preference` 的等价语义，供原本检查 no-preference 的位置使用。 */
export function isMotionEnabled(): boolean {
  return !isMotionDisabled();
}

/** 只落 DOM 与通知订阅者；写入持久化请走 persistMotionEnabled。 */
export function applyMotionPreference(enabled: boolean): void {
  const normalized = normalizeMotionEnabled(enabled);
  if (typeof document !== "undefined") {
    document.documentElement?.setAttribute?.(MOTION_ATTRIBUTE, normalized ? "on" : "off");
  }
  emit();
}

/** 写入偏好并立即生效，返回归一化后的值；设置开关的唯一写入口。 */
export function persistMotionEnabled(enabled: unknown): boolean {
  const normalized = normalizeMotionEnabled(enabled);
  writeSafeLocalStorage(MOTION_STORAGE_KEY, normalized ? "true" : "false");
  applyMotionPreference(normalized);
  return normalized;
}

/**
 * 订阅动画偏好变化，三个来源都要覆盖：
 * - 本窗口写入：由 persistMotionEnabled → emit 直接通知；
 * - 其他窗口写入：跨窗口只有 `storage` 事件，主窗口与资源管理器都靠它同步；
 * - 系统偏好变化：没有事件源，只能挂媒体查询监听。
 * 后两个监听都按订阅者数量计数，卸载最后一个订阅者时摘掉。
 */
export function subscribeToMotionPreference(listener: Listener): () => void {
  listeners.add(listener);
  const releaseMediaListener = acquireMediaListener();
  const releaseStorageListener = acquireStorageListener();
  return () => {
    listeners.delete(listener);
    releaseMediaListener();
    releaseStorageListener();
  };
}

/**
 * 不写 React 的独立窗口（如资源管理器）用它跟随其他窗口写入的偏好，
 * 与 subscribeToUiFontSizeStorageChanges 同一套路。
 */
export function subscribeToMotionStorageChanges(): () => void {
  return subscribeToMotionPreference(() => {});
}

function handleStorageChange(event: StorageEvent): void {
  if (event.key !== MOTION_STORAGE_KEY) {
    return;
  }
  applyMotionPreference(parseMotionEnabled(event.newValue));
}

let storageListenerCount = 0;

function acquireStorageListener(): () => void {
  storageListenerCount += 1;
  if (storageListenerCount === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorageChange);
  }

  return () => {
    storageListenerCount -= 1;
    if (storageListenerCount === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorageChange);
    }
  };
}

let mediaListenerCount = 0;
let mediaQueryList: MediaQueryList | null = null;

function handleMediaPreferenceChange(): void {
  emit();
}

function acquireMediaListener(): () => void {
  mediaListenerCount += 1;
  if (mediaListenerCount === 1 && typeof window !== "undefined") {
    mediaQueryList = window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
    if (mediaQueryList) {
      if (typeof mediaQueryList.addEventListener === "function") {
        mediaQueryList.addEventListener("change", handleMediaPreferenceChange);
      } else {
        // 部分 Electron / Chromium 组合只支持旧版 MediaQueryList listener API。
        mediaQueryList.addListener(handleMediaPreferenceChange);
      }
    }
  }

  return () => {
    mediaListenerCount -= 1;
    if (mediaListenerCount > 0 || !mediaQueryList) {
      return;
    }
    if (typeof mediaQueryList.removeEventListener === "function") {
      mediaQueryList.removeEventListener("change", handleMediaPreferenceChange);
    } else {
      mediaQueryList.removeListener(handleMediaPreferenceChange);
    }
    mediaQueryList = null;
  };
}

/** React 侧判断：应用内开关与系统偏好任一要求减少即返回 true。 */
export function useMotionDisabled(): boolean {
  return useSyncExternalStore(subscribeToMotionPreference, isMotionDisabled, () => false);
}

/**
 * 用户自己的开关状态（不含系统偏好），供设置页的开关显示。
 * 不能复用 useMotionDisabled：系统开了「减少动态效果」时它是 true，
 * 会让开关显示成关闭，用户会以为自己关过。
 */
export function useMotionPreferenceEnabled(): boolean {
  return useSyncExternalStore(subscribeToMotionPreference, loadMotionEnabled, () => true);
}
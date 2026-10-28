import { useEffect, useState, useCallback } from "react";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

export type Theme = "light" | "dark" | "nibi-light" | "nibi-dark" | "system";
export type ResolvedTheme = "light" | "dark";
// legacy-migration: 旧版本写入的主题值，只用于读取旧偏好，不参与新写入。
type LegacyTheme = "zai-light" | "zai-dark"; // legacy-migration
type StoredTheme = Theme | LegacyTheme;

const STORAGE_KEY = "nibi-theme";
// legacy-migration: 旧版本存储键，读到后迁移到 nibi-theme。
const LEGACY_STORAGE_KEY = "zcode-theme";
const BROWSER_THEME_SURFACE_ATTRIBUTE = "data-nibi-browser-theme-surface";

/**
 * 首次启动（localStorage 里没有记录）时的默认外观。
 *
 * 保持单一来源：Zustand store、useTheme hook、桌面端 index 启动脚本都从这里取，
 * 各自写死兜底值会让"默认主题"在不同入口分叉。
 */
export const DEFAULT_THEME: Theme = "nibi-light";

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: StoredTheme): ResolvedTheme {
  const normalized = normalizeThemePreference(theme);
  if (normalized === "system") {
    return getSystemTheme();
  }

  return normalized === "dark" || normalized === "nibi-dark" ? "dark" : "light";
}

export function normalizeThemePreference(theme: StoredTheme): Theme {
  if (theme === "dark" || theme === "zai-dark") return "nibi-dark"; // legacy-migration
  if (theme === "light" || theme === "zai-light") return "nibi-light"; // legacy-migration
  return theme;
}

function setThemeMetaContent(name: "theme-color" | "color-scheme", content: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
}

function syncBrowserThemeSurface(resolved: ResolvedTheme) {
  const root = document.documentElement;
  if (
    typeof root.hasAttribute !== "function" ||
    !root.hasAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE)
  ) {
    return;
  }

  // Electron 为 vibrancy 保持透明根背景，但普通浏览器需要从文档根和标准 meta
  // 获得页面主题。只切换 React 的 dark class 会让浏览器工具栏、原生控件和 overscroll 留在旧主题。
  root.setAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE, resolved);
  root.style.colorScheme = resolved;
  setThemeMetaContent("color-scheme", resolved);

  const background = getComputedStyle(root).getPropertyValue("--color-background").trim();
  if (background) {
    setThemeMetaContent("theme-color", background);
  }
}

export function applyTheme(theme: StoredTheme) {
  const normalized = normalizeThemePreference(theme);
  const resolved = resolveTheme(normalized);
  const appliedTheme =
    normalized === "system"
      ? resolved === "dark"
        ? "nibi-dark"
        : "nibi-light"
      : normalized;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-nibi-light", appliedTheme === "nibi-light");
  document.documentElement.classList.toggle("theme-nibi-dark", appliedTheme === "nibi-dark");
  syncBrowserThemeSurface(resolved);
}

function isStoredTheme(value: string | null): value is StoredTheme {
  return (
    value === "light" ||
    value === "dark" ||
    value === "nibi-light" ||
    value === "nibi-dark" ||
    value === "system" ||
    value === "zai-light" || // legacy-migration
    value === "zai-dark" // legacy-migration
  );
}

function removeLegacyThemeStorage(): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    // 隐私模式/受限环境移除失败不影响已完成的迁移。
  }
}

/** 读取已保存的主题偏好；没有记录或值非法时回落到 DEFAULT_THEME。 */
export function loadThemePreference(): Theme {
  const saved = readSafeLocalStorage(STORAGE_KEY);
  if (isStoredTheme(saved)) {
    const normalized = normalizeThemePreference(saved);
    if (saved !== normalized) {
      writeSafeLocalStorage(STORAGE_KEY, normalized);
    }
    removeLegacyThemeStorage();
    return normalized;
  }

  const legacy = readSafeLocalStorage(LEGACY_STORAGE_KEY);
  if (isStoredTheme(legacy)) {
    const normalized = normalizeThemePreference(legacy);
    writeSafeLocalStorage(STORAGE_KEY, normalized);
    removeLegacyThemeStorage();
    return normalized;
  }

  return DEFAULT_THEME;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(loadThemePreference);

  const setTheme = useCallback((t: Theme) => {
    const normalizedTheme = normalizeThemePreference(t);
    localStorage.setItem(STORAGE_KEY, normalizedTheme);
    setThemeState(normalizedTheme);
    applyTheme(normalizedTheme);
  }, []);

  // 初始化 + system 模式下监听系统偏好变化
  useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  return { theme, setTheme } as const;
}

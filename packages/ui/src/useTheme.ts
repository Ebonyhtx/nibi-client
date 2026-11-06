import { useEffect, useState, useCallback } from "react";
import { readPrefs, updatePrefs } from "@/lib/nibiStorage.js";

export type Theme = "light" | "dark" | "nibi-light" | "nibi-dark" | "system";
export type ResolvedTheme = "light" | "dark";

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

export function resolveTheme(theme: Theme): ResolvedTheme {
  const normalized = normalizeThemePreference(theme);
  if (normalized === "system") {
    return getSystemTheme();
  }

  return normalized === "dark" || normalized === "nibi-dark" ? "dark" : "light";
}

export function normalizeThemePreference(theme: Theme): Theme {
  if (theme === "dark") return "nibi-dark";
  if (theme === "light") return "nibi-light";
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

export function applyTheme(theme: Theme) {
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

function isThemeValue(value: string | null): value is Theme {
  return (
    value === "light" ||
    value === "dark" ||
    value === "nibi-light" ||
    value === "nibi-dark" ||
    value === "system"
  );
}

/** 读取已保存的主题偏好；没有记录或值非法时回落到 DEFAULT_THEME。 */
export function loadThemePreference(): Theme {
  const saved = readPrefs().theme ?? null;
  if (isThemeValue(saved)) {
    const normalized = normalizeThemePreference(saved);
    // 归一化结果写回，避免每次启动重算（`dark`/`light` 是合法输入，`nibi-*` 是落盘形态）。
    if (saved !== normalized) {
      updatePrefs({ theme: normalized });
    }
    return normalized;
  }

  return DEFAULT_THEME;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(loadThemePreference);

  const setTheme = useCallback((t: Theme) => {
    const normalizedTheme = normalizeThemePreference(t);
    updatePrefs({ theme: normalizedTheme });
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

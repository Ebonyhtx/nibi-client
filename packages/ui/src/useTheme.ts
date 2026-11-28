import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { readPrefs, updatePrefs } from "@/lib/nibiStorage.js";

export type Theme =
  | "light"
  | "dark"
  | "nibi-light"
  | "nibi-dark"
  | "nibi-obsidian"
  | "nibi-mist"
  | "system";
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

  return normalized === "dark" || normalized === "nibi-dark" || normalized === "nibi-obsidian"
    ? "dark"
    : "light";
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
  document.documentElement.classList.toggle("theme-nibi-obsidian", appliedTheme === "nibi-obsidian");
  document.documentElement.classList.toggle("theme-nibi-mist", appliedTheme === "nibi-mist");
  syncBrowserThemeSurface(resolved);
}

export function applyThemeWithTransition(theme: Theme) {
  if (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    typeof window !== "undefined" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches &&
    document.documentElement?.dataset?.nibiMotion !== "off"
  ) {
    try {
      const transition = document.startViewTransition(() => {
        applyTheme(theme);
      });
      void transition?.ready?.catch(() => {});
      void transition?.finished?.catch(() => {});
      return;
    } catch {
      // Fall back to direct synchronous theme application when View Transition is unavailable.
    }
  }
  applyTheme(theme);
}

function isThemeValue(value: string | null): value is Theme {
  return (
    value === "light" ||
    value === "dark" ||
    value === "nibi-light" ||
    value === "nibi-dark" ||
    value === "nibi-obsidian" ||
    value === "nibi-mist" ||
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
    applyThemeWithTransition(normalizedTheme);
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

export type CanonicalThemeMode =
  | "system"
  | "nibi-light"
  | "nibi-mist"
  | "nibi-dark"
  | "nibi-obsidian";

export interface ThemeSwatchSurface {
  desk: string;
  sheet: string;
  ink: string;
  accent: string;
  border: string;
}

export interface ThemeSwatchSpec extends ThemeSwatchSurface {
  splitDark?: ThemeSwatchSurface;
}

/** 与 styles.css 四套宣纸书案主题 token 对齐的主题色板元数据，供设置画廊与快捷菜单共享。 */
export const THEME_SWATCH_META: Record<CanonicalThemeMode, ThemeSwatchSpec> = {
  "nibi-light": {
    desk: "#efe6d5",
    sheet: "#fcf9f2",
    ink: "#1c2b42",
    accent: "#a85014",
    border: "#dcd1be",
  },
  "nibi-mist": {
    desk: "#e8ebef",
    sheet: "#fafbfc",
    ink: "#1e2a38",
    accent: "#266161",
    border: "#d3dae3",
  },
  "nibi-dark": {
    desk: "#100f0d",
    sheet: "#181714",
    ink: "#e8e1d5",
    accent: "#e6c28e",
    border: "#2e2b25",
  },
  "nibi-obsidian": {
    desk: "#0a0d12",
    sheet: "#11161e",
    ink: "#e2e8f0",
    accent: "#5ec2b6",
    border: "#222c3a",
  },
  system: {
    desk: "#efe6d5",
    sheet: "#fcf9f2",
    ink: "#1c2b42",
    accent: "#a85014",
    border: "#dcd1be",
    splitDark: {
      desk: "#100f0d",
      sheet: "#181714",
      ink: "#e8e1d5",
      accent: "#e6c28e",
      border: "#2e2b25",
    },
  },
};

export function resolveCanonicalThemeMode(theme: Theme): CanonicalThemeMode {
  const normalized = normalizeThemePreference(theme);
  if (
    normalized === "system" ||
    normalized === "nibi-light" ||
    normalized === "nibi-mist" ||
    normalized === "nibi-dark" ||
    normalized === "nibi-obsidian"
  ) {
    return normalized;
  }
  return "nibi-light";
}

export function resolveThemeSwatchMeta(theme: Theme): ThemeSwatchSpec {
  return THEME_SWATCH_META[resolveCanonicalThemeMode(theme)];
}

/** 返回单层无嵌套的主色圆点属性（radial-gradient 点出强调色，system 为昼夜双拼）。 */
export function getThemeSwatchDotProps(
  theme: Theme,
  className?: string,
): {
  "aria-hidden": true;
  className: string;
  style: CSSProperties;
} {
  const swatch = resolveThemeSwatchMeta(theme);
  const background = swatch.splitDark
    ? `linear-gradient(135deg, ${swatch.sheet} 0%, ${swatch.sheet} 49%, ${swatch.splitDark.sheet} 51%, ${swatch.splitDark.sheet} 100%)`
    : `radial-gradient(circle at center, ${swatch.accent} 0%, ${swatch.accent} 38%, ${swatch.sheet} 44%, ${swatch.sheet} 100%)`;
  return {
    "aria-hidden": true as const,
    className: ["inline-block size-3 shrink-0 rounded-full border", className]
      .filter(Boolean)
      .join(" "),
    style: {
      borderColor: swatch.border,
      background,
    },
  };
}

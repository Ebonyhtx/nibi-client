import { createRoot } from "react-dom/client";
import type {
  NetworkCaptureBridge,
  ResourceUsageSnapshot,
  StorageManagementBridge,
} from "@nibi/shared";
import "@nibi/ui/styles.css";
import {
  DEFAULT_THEME,
  ResourceManagerApp,
  NibiIntlProvider,
  applyMotionPreference,
  applyUiFontSizePx,
  loadMotionEnabled,
  loadUiFontSizePx,
  readPrefs,
  subscribeToMotionStorageChanges,
  subscribeToUiFontSizeStorageChanges,
} from "@nibi/ui";

declare global {
  interface Window {
    resourceManager?: {
      getSnapshot: () => Promise<ResourceUsageSnapshot>;
      setSamplingActive: (active: boolean) => void;
      storage?: StorageManagementBridge;
      network?: NetworkCaptureBridge;
    };
  }
}

type Theme = "light" | "dark" | "nibi-light" | "nibi-dark" | "system";

function normalizeTheme(theme: Theme): Theme {
  if (theme === "dark") return "nibi-dark";
  if (theme === "light") return "nibi-light";
  return theme;
}

function resolveTheme(theme: Theme): "light" | "dark" {
  const normalized = normalizeTheme(theme);
  if (normalized === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return normalized === "dark" || normalized === "nibi-dark" ? "dark" : "light";
}

function applyResourceManagerTheme(): void {
  // 只读 NIBI 自己的键：NIBI 没有发布过，不存在需要兼容的旧键。
  const storedTheme = readPrefs().theme;
  const savedTheme = storedTheme ? (storedTheme as Theme) : DEFAULT_THEME;
  const normalizedTheme = normalizeTheme(savedTheme);
  const resolvedTheme = resolveTheme(normalizedTheme);
  const appliedTheme =
    normalizedTheme === "system"
      ? resolvedTheme === "dark"
        ? "nibi-dark"
        : "nibi-light"
      : normalizedTheme;
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  document.documentElement.classList.toggle("theme-nibi-light", appliedTheme === "nibi-light");
  document.documentElement.classList.toggle("theme-nibi-dark", appliedTheme === "nibi-dark");
}

applyResourceManagerTheme();
// 资源管理器不创建主窗口的 Zustand store，text-ui-* 无法自动获得持久化基准。
// 首屏前显式应用，运行中再由 storage 事件同步，且不改变 html font-size 或接入业务 Host。
applyUiFontSizePx(loadUiFontSizePx());
subscribeToUiFontSizeStorageChanges();
// 界面动效同理：这个窗口同样没有 store，得自己读偏好并在其他窗口改动时跟随。
applyMotionPreference(loadMotionEnabled());
subscribeToMotionStorageChanges();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    // 语言沿用主窗口写入 localStorage 的偏好；不接 settingService，避免独立窗口再起一份 RPC。
    <NibiIntlProvider>
      <ResourceManagerApp
        setSamplingActive={window.resourceManager?.setSamplingActive}
        getSnapshot={
          window.resourceManager ? () => window.resourceManager!.getSnapshot() : undefined
        }
        storage={window.resourceManager?.storage}
        network={window.resourceManager?.network}
      />
    </NibiIntlProvider>,
  );
}

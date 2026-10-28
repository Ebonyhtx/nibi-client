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
  ZCodeIntlProvider,
  applyMotionPreference,
  applyUiFontSizePx,
  loadMotionEnabled,
  loadUiFontSizePx,
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
// legacy-migration: 旧版本存储值，只在启动读取时兼容。
type LegacyTheme = "zai-light" | "zai-dark"; // legacy-migration

function normalizeTheme(theme: Theme | LegacyTheme): Theme {
  if (theme === "dark" || theme === "zai-dark") return "nibi-dark"; // legacy-migration
  if (theme === "light" || theme === "zai-light") return "nibi-light"; // legacy-migration
  return theme;
}

function resolveTheme(theme: Theme | LegacyTheme): "light" | "dark" {
  const normalized = normalizeTheme(theme);
  if (normalized === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return normalized === "dark" || normalized === "nibi-dark" ? "dark" : "light";
}

function applyResourceManagerTheme(): void {
  const savedTheme =
    (localStorage.getItem("nibi-theme") as Theme | LegacyTheme | null) ??
    (localStorage.getItem("zcode-theme") as LegacyTheme | null) ?? // legacy-migration
    DEFAULT_THEME;
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
    <ZCodeIntlProvider>
      <ResourceManagerApp
        setSamplingActive={window.resourceManager?.setSamplingActive}
        getSnapshot={
          window.resourceManager ? () => window.resourceManager!.getSnapshot() : undefined
        }
        storage={window.resourceManager?.storage}
        network={window.resourceManager?.network}
      />
    </ZCodeIntlProvider>,
  );
}

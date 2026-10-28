import {
  isLegacyWebRemoteControlThemeSeed,
  isWebRemoteControlThemeSeed,
  type LegacyWebRemoteControlThemeSeed,
  type WebRemoteControlThemeSeed,
} from "@nibi/shared";

export const WEB_REMOTE_CONTROL_DEFAULT_THEME: WebRemoteControlThemeSeed = "nibi-dark";

function normalizeWebRemoteControlThemeSeed(
  theme: WebRemoteControlThemeSeed | LegacyWebRemoteControlThemeSeed,
): WebRemoteControlThemeSeed {
  if (theme === "dark" || theme === "zai-dark") return "nibi-dark"; // legacy-migration
  if (theme === "light" || theme === "zai-light") return "nibi-light"; // legacy-migration
  return theme;
}

function resolveSeed(value: string | null | undefined): WebRemoteControlThemeSeed | null {
  if (isWebRemoteControlThemeSeed(value) || isLegacyWebRemoteControlThemeSeed(value)) {
    return normalizeWebRemoteControlThemeSeed(value);
  }
  return null;
}

export function resolveWebRemoteControlInitialTheme({
  storedTheme,
  qrTheme,
  defaultTheme = WEB_REMOTE_CONTROL_DEFAULT_THEME,
}: {
  storedTheme?: string | null;
  qrTheme?: string | null;
  defaultTheme?: WebRemoteControlThemeSeed;
}): WebRemoteControlThemeSeed {
  return (
    resolveSeed(storedTheme) ??
    resolveSeed(qrTheme) ??
    normalizeWebRemoteControlThemeSeed(defaultTheme)
  );
}

export function seedWebRemoteControlThemePreference(qrTheme?: string | null): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  const storedTheme =
    localStorage.getItem("nibi-theme") ?? localStorage.getItem("zcode-theme"); // legacy-migration
  const resolvedTheme = resolveWebRemoteControlInitialTheme({ storedTheme, qrTheme });
  if (!storedTheme && resolveSeed(qrTheme)) {
    // Bugfix: 手机远控首次打开原来只用 Web 默认主题，无法继承扫码时桌面端主题。
    // 这里只在手机本地还没有主题偏好时写入一次，后续手机改主题不会反向影响桌面端。
    localStorage.setItem("nibi-theme", resolvedTheme);
    return;
  }

  if (storedTheme && !localStorage.getItem("nibi-theme")) {
    // legacy-migration: 旧键只在读到后迁移一次，之后统一写 nibi-theme。
    localStorage.setItem("nibi-theme", resolvedTheme);
  }
}

import { isWebRemoteControlThemeSeed, type WebRemoteControlThemeSeed } from "@nibi/shared";

export const WEB_REMOTE_CONTROL_DEFAULT_THEME: WebRemoteControlThemeSeed = "nibi-dark";

function normalizeWebRemoteControlThemeSeed(
  theme: WebRemoteControlThemeSeed,
): WebRemoteControlThemeSeed {
  if (theme === "dark") return "nibi-dark";
  if (theme === "light") return "nibi-light";
  return theme;
}

function resolveSeed(value: string | null | undefined): WebRemoteControlThemeSeed | null {
  if (isWebRemoteControlThemeSeed(value)) {
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

  // 只读 NIBI 自己的键：NIBI 没有发布过，不存在需要兼容的旧键。
  const storedTheme = localStorage.getItem("nibi-theme");
  const resolvedTheme = resolveWebRemoteControlInitialTheme({ storedTheme, qrTheme });
  if (!storedTheme && resolveSeed(qrTheme)) {
    // Bugfix: 手机远控首次打开原来只用 Web 默认主题，无法继承扫码时桌面端主题。
    // 这里只在手机本地还没有主题偏好时写入一次，后续手机改主题不会反向影响桌面端。
    localStorage.setItem("nibi-theme", resolvedTheme);
  }
}

import type { WebOAuthProviderId } from "./browserOAuthCredentialRepo.js";

export type WebAuthLocale = "zh-CN" | "en-US";

const WEB_AUTH_LOCALE_STORAGE_KEY = "nibi:web-auth-locale";

export interface WebAuthPageCopy {
  brand: string;
  remoteBadge: string;
  loginTitle: string;
  loginDescription: string;
  loginHighlights: [string, string];
  loginAction: Record<WebOAuthProviderId, string>;
  loginRegion: Record<WebOAuthProviderId, string>;
  callbackTitle: string;
  callbackDescription: string;
  callbackErrorTitle: string;
  callbackErrorDescription: string;
  retryAction: string;
  switchToEnglish: string;
  switchToChinese: string;
  switchToDarkTheme: string;
  switchToLightTheme: string;
}

const WEB_AUTH_COPY = {
  "zh-CN": {
    brand: "NIBI",
    remoteBadge: "Web 远程控制",
    loginTitle: "登录后继续使用 Web 远程控制",
    loginDescription: "请使用与电脑端相同的 NIBI 账号登录。",
    loginHighlights: [
      "仅连接登录同一账号且开启远控的电脑",
      "配对过程由中继加密校验，电脑端保持可控",
    ],
    loginAction: {
      nibi: "使用 NIBI 账号登录",
    },
    loginRegion: { nibi: "" },
    callbackTitle: "正在完成登录",
    callbackDescription: "请稍候，正在校验账号身份。",
    callbackErrorTitle: "登录失败",
    callbackErrorDescription: "授权流程未完成，请重新登录。",
    retryAction: "重新登录",
    switchToEnglish: "Switch to English",
    switchToChinese: "切换到中文",
    switchToDarkTheme: "切换到深色主题",
    switchToLightTheme: "切换到浅色主题",
  },
  "en-US": {
    brand: "NIBI",
    remoteBadge: "Web Remote",
    loginTitle: "Sign In To Continue",
    loginDescription: "Use the same NIBI account as on your computer.",
    loginHighlights: [
      "Connects only to computers signed in with the same account",
      "Verified relay pairing keeps your desktop workspace protected",
    ],
    loginAction: {
      nibi: "Sign in with NIBI",
    },
    loginRegion: { nibi: "" },
    callbackTitle: "Finishing Sign-In",
    callbackDescription: "Verifying your account identity.",
    callbackErrorTitle: "Sign-In Failed",
    callbackErrorDescription: "The authorization flow did not complete. Sign in again.",
    retryAction: "Sign In Again",
    switchToEnglish: "Switch to English",
    switchToChinese: "切换到中文",
    switchToDarkTheme: "Switch to dark theme",
    switchToLightTheme: "Switch to light theme",
  },
} satisfies Record<WebAuthLocale, WebAuthPageCopy>;

export function readStoredWebAuthLocale(): WebAuthLocale | null {
  try {
    const raw = globalThis.localStorage?.getItem(WEB_AUTH_LOCALE_STORAGE_KEY)?.trim();
    if (raw === "zh-CN" || raw === "en-US") return raw;
  } catch {
    // 隐私模式或受限上下文忽略本地存储读取失败
  }
  return null;
}

export function persistWebAuthLocale(locale: WebAuthLocale): void {
  try {
    globalThis.localStorage?.setItem(WEB_AUTH_LOCALE_STORAGE_KEY, locale);
  } catch {
    // 隐私模式或受限上下文忽略本地存储写入失败
  }
}

export function resolveWebAuthLocale(language?: string): WebAuthLocale {
  if (language) {
    return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  }

  const stored = readStoredWebAuthLocale();
  if (stored) return stored;

  const docLang = typeof document !== "undefined" ? document.documentElement.lang : "";
  const navLang =
    typeof navigator !== "undefined"
      ? navigator.language || navigator.languages?.[0] || ""
      : "";
  const candidate = docLang || navLang;

  return candidate.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getWebAuthCopy(locale: WebAuthLocale = resolveWebAuthLocale()): WebAuthPageCopy {
  return WEB_AUTH_COPY[locale];
}

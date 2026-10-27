import type { WebOAuthProviderId } from "./browserOAuthCredentialRepo.js";

type WebAuthLocale = "zh-CN" | "en-US";

interface WebAuthPageCopy {
  brand: string;
  loginTitle: string;
  loginDescription: string;
  loginAction: Record<WebOAuthProviderId, string>;
  loginRegion: Record<WebOAuthProviderId, string>;
  callbackTitle: string;
  callbackDescription: string;
  callbackErrorTitle: string;
  callbackErrorDescription: string;
  retryAction: string;
}

const WEB_AUTH_COPY = {
  "zh-CN": {
    brand: "NIBI",
    loginTitle: "登录后继续使用 Web 远程控制",
    loginDescription: "请使用与电脑端相同的 NIBI 账号登录。",
    loginAction: {
      zai: "连接 Z.ai 继续使用",
      bigmodel: "连接 BigModel 继续使用",
      nibi: "使用 NIBI 账号登录",
    },
    loginRegion: { zai: "全球", bigmodel: "中国", nibi: "" },
    callbackTitle: "正在完成登录",
    callbackDescription: "请稍候，正在校验账号身份。",
    callbackErrorTitle: "登录失败",
    callbackErrorDescription: "授权流程未完成，请重新登录。",
    retryAction: "重新登录",
  },
  "en-US": {
    brand: "NIBI",
    loginTitle: "Sign In To Continue",
    loginDescription: "Use the same NIBI account as on your computer.",
    loginAction: {
      zai: "Connect to Z.ai",
      bigmodel: "Connect to BigModel",
      nibi: "Sign in with NIBI",
    },
    loginRegion: { zai: "Global", bigmodel: "CN", nibi: "" },
    callbackTitle: "Finishing Sign-In",
    callbackDescription: "Verifying your account identity.",
    callbackErrorTitle: "Sign-In Failed",
    callbackErrorDescription: "The authorization flow did not complete. Sign in again.",
    retryAction: "Sign In Again",
  },
} satisfies Record<WebAuthLocale, WebAuthPageCopy>;

function resolveWebAuthLocale(language?: string): WebAuthLocale {
  const candidate =
    language ??
    document.documentElement.lang ??
    navigator.language ??
    navigator.languages?.[0] ??
    "";

  return candidate.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getWebAuthCopy(locale: WebAuthLocale = resolveWebAuthLocale()): WebAuthPageCopy {
  return WEB_AUTH_COPY[locale];
}

// NIBI 账号中心（Zitadel）的 Web 登录：授权码 + PKCE。
//
// 与上游 z.ai / BigModel 的三个关键差异：
//   1. 回调地址必须与页面同源，且 **不带任何查询参数**——Zitadel 对 redirect_uri 做
//      完全一致匹配；二维码参数（sid/mid/app_version）只放进 state，回调完成后再
//      由 state.app_return_to 跳回完整 URL。
//   2. 令牌交换走自家 API 代理（同源 `/api/v1/oauth/nibi/token`），浏览器不直连 IdP，
//      避免依赖 token 端点的 CORS，也把 userinfo 一次取回。
//   3. client id 是公开的 SPA 标识，没有 client secret；PKCE 是唯一的持有证明。
import {
  buildZCodeEndpointUrls,
  DEFAULT_NIBI_ENDPOINT_ORIGIN,
  NIBI_AUTH_ORIGIN,
  NIBI_OIDC_SCOPE,
  NIBI_WEB_OIDC_CLIENT_ID,
  type OAuthTokenSet,
  type UserInfo,
} from "@nibi/shared";
import { toUserInfo } from "./oauthUserInfo.js";

export interface NibiWebOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
  /** 页面与回调同源：`{endpointOrigin}/remote/v4`，不带查询参数。 */
  redirectUri: string;
}

interface NibiWebOAuthEnv {
  VITE_NIBI_BASE_URL?: string;
  VITE_NIBI_ENDPOINT_ORIGIN?: string;
  VITE_NIBI_OIDC_CLIENT_ID?: string;
  VITE_NIBI_AUTH_ORIGIN?: string;
}

interface NibiTokenPayload {
  code?: number;
  msg?: string;
  data?: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user?: unknown;
  } | null;
}

interface NibiCallbackParams {
  code?: string;
  error?: string;
  state: string;
}

export interface NibiTokenExchangeResult {
  tokenSet: OAuthTokenSet;
  userInfo: UserInfo;
  rawUserInfo: unknown;
}

export interface NibiRefreshedTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * redirectUri 取**端点 origin**而不是 window.location.origin：生产要求页面与中继同源，
 * 页面就部署在该 origin。本地 Vite 页面（localhost）跑真实登录会跳到生产回调，
 * 所以本地 UI 验证用假 auth；真实登录在部署后的页面上验。
 */
export function createNibiWebOAuthConfig(env: NibiWebOAuthEnv = {}): NibiWebOAuthConfig {
  const endpointUrls = buildZCodeEndpointUrls(
    env.VITE_NIBI_BASE_URL?.trim() ||
      env.VITE_NIBI_ENDPOINT_ORIGIN?.trim() ||
      DEFAULT_NIBI_ENDPOINT_ORIGIN,
  );
  const authOrigin = (env.VITE_NIBI_AUTH_ORIGIN?.trim() || NIBI_AUTH_ORIGIN).replace(/\/+$/u, "");

  return {
    authorizeUrl: `${authOrigin}/oauth/v2/authorize`,
    tokenUrl: `${endpointUrls.origin}/api/v1/oauth/nibi/token`,
    clientId: env.VITE_NIBI_OIDC_CLIENT_ID?.trim() || NIBI_WEB_OIDC_CLIENT_ID,
    scope: NIBI_OIDC_SCOPE,
    redirectUri: endpointUrls.webRemoteCallbackUrl,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/** RFC 7636 verifier：48 随机字节 → 64 个 Base64URL 字符。 */
export function createNibiCodeVerifier(randomBytes = 48): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable");
  }
  const bytes = new Uint8Array(randomBytes);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function createNibiCodeChallenge(verifier: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // 非安全上下文（http 且非 localhost）没有 SubtleCrypto；PKCE 无法降级，必须报错。
    throw new Error("Web Crypto is unavailable; open the page over HTTPS");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

const env = ((import.meta as ImportMeta & { env?: NibiWebOAuthEnv }).env ??
  {}) as NibiWebOAuthEnv;

/**
 * 构建期配置：生产构建必须带 NIBI_ENV=production（否则 Vite 会把上游测试端点
 * 写进 bundle）。这里与 WEB_ZAI_OAUTH_CONFIG 同源读取，避免两套配置漂移。
 */
export const NIBI_WEB_OAUTH_CONFIG: NibiWebOAuthConfig = createNibiWebOAuthConfig(env);

export class NibiWebOAuthProvider {
  constructor(
    private readonly config: NibiWebOAuthConfig,
    private readonly now: () => number = Date.now,
  ) {}

  buildAuthorizeUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri?: string;
    /** 切换账号：强制 IdP 重新认证，避免 SSO 会话把用户静默登回原账号。 */
    forceLogin?: boolean;
  }): string {
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: params.redirectUri ?? this.config.redirectUri,
      response_type: "code",
      scope: this.config.scope,
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
    });
    if (params.forceLogin) query.set("prompt", "login");
    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  parseCallbackParams(url: string): NibiCallbackParams {
    const parsed = new URL(url);
    const state = parsed.searchParams.get("state")?.trim();
    if (!state) {
      throw new Error("OAuth callback missing state");
    }

    return {
      state,
      ...(parsed.searchParams.get("code") ? { code: parsed.searchParams.get("code")! } : {}),
      ...(parsed.searchParams.get("error") ? { error: parsed.searchParams.get("error")! } : {}),
    };
  }

  async exchangeToken(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<NibiTokenExchangeResult> {
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      }),
    });
    if (!response.ok) {
      throw new Error(`NIBI token exchange failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as NibiTokenPayload;
    const accessToken = payload.data?.access_token?.trim();
    if (payload.code !== 0 || !accessToken) {
      throw new Error(payload.msg?.trim() || "NIBI token exchange failed");
    }

    const rawUserInfo = payload.data?.user;
    const userInfo = toUserInfo(rawUserInfo);
    if (!userInfo) {
      throw new Error("NIBI token exchange missing user info");
    }

    const expiresIn = payload.data?.expires_in;
    const expiresAt =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? this.now() + expiresIn * 1000
        : undefined;

    const refreshToken = payload.data?.refresh_token?.trim();
    return {
      tokenSet: {
        // 中继与业务 API 都只认这个 access token；没有第二条"上游令牌"可混用。
        accessToken,
        zcodeJwtToken: accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
      userInfo,
      rawUserInfo,
    };
  }

  /**
   * 用 refresh_token 换新令牌。手机页可能挂好几天，access token 只有 ~12h；
   * 没有这条路径用户每天都要重新扫码登录。走同一个服务端代理，避免直连 IdP 的 CORS。
   */
  async refreshToken(refreshToken: string): Promise<NibiRefreshedTokenSet> {
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    if (!response.ok) {
      const error = new Error(`NIBI token refresh failed with HTTP ${response.status}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }
    const payload = (await response.json()) as NibiTokenPayload;
    const accessToken = payload.data?.access_token?.trim();
    if (payload.code !== 0 || !accessToken) {
      throw new Error(payload.msg?.trim() || "NIBI token refresh failed");
    }
    const expiresIn = payload.data?.expires_in;
    const expiresAt =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? this.now() + expiresIn * 1000
        : undefined;
    const rotated = payload.data?.refresh_token?.trim();
    return {
      accessToken,
      ...(rotated ? { refreshToken: rotated } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
}

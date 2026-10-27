import { createHash, randomBytes } from "node:crypto";
import {
  NIBI_PROVIDER_ID,
  type ApiClient,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@nibi/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import { NIBI_OIDC_SCOPE } from "./nibiProviderConfig.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

/** PKCE verifier 只活到回调这一刻；超过这个时间按失败处理，避免内存里堆废弃 state。 */
const PKCE_TTL_MS = 10 * 60 * 1000;
const OAUTH_USERINFO_TIMEOUT_MS = 60_000;

interface NibiTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface NibiUserInfoResponse {
  sub?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  picture?: string;
}

interface PkceEntry {
  verifier: string;
  expiresAt: number;
}

function toBase64UrlSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function normalizeExpiresAt(expiresIn: number | undefined, now: number): number | undefined {
  if (!expiresIn || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }

  return now + expiresIn * 1000;
}

function readTokenPayload(payload: NibiTokenResponse): OAuthTokenSet {
  const accessToken = payload.access_token?.trim();
  if (!accessToken) {
    throw new Error("NIBI 登录失败：token 响应缺少 access_token");
  }

  const refreshToken = payload.refresh_token?.trim();
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
  };
}

/** NIBI OIDC 协议适配器（授权码 + PKCE，Zitadel native app） */
export class NibiProviderAdapter implements OAuthProviderAdapter {
  readonly providerId = NIBI_PROVIDER_ID;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;
  private readonly pendingPkce = new Map<string, PkceEntry>();

  constructor(
    private config: OAuthProviderRuntimeConfig,
    apiClient: ApiClient,
  ) {
    this.meta = {
      id: config.id,
      displayName: config.displayName,
      enabled: config.enabled,
      order: config.order,
    };
    this.redirectUri = config.redirectUri;
    this.apiClient = apiClient;
  }

  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    const error = parsed.searchParams.get("error");

    if (error) {
      const description = parsed.searchParams.get("error_description")?.trim();
      throw new Error(description || `NIBI 登录被拒绝（${error}）`);
    }
    if (!code || !state) {
      throw new Error("OAuth 回调缺少 code 或 state 参数");
    }

    const attribution = parseOAuthLoginAttribution(parsed.searchParams);
    return { code, state, ...(attribution ? { attribution } : {}) };
  }

  buildAuthorizeUrl(context: OAuthProviderContext): string {
    this.pruneExpiredPkce(context.now());
    const verifier = randomBytes(32).toString("base64url");
    this.pendingPkce.set(context.state, {
      verifier,
      expiresAt: context.now() + PKCE_TTL_MS,
    });

    const query = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: context.redirectUri,
      response_type: "code",
      scope: NIBI_OIDC_SCOPE,
      state: context.state,
      code_challenge: toBase64UrlSha256(verifier),
      code_challenge_method: "S256",
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  async exchangeToken(
    params: OAuthCallbackParams,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    const pkce = this.pendingPkce.get(params.state);
    this.pendingPkce.delete(params.state);
    if (!pkce || pkce.expiresAt <= context.now()) {
      throw new Error("NIBI 登录已过期，请重新发起登录");
    }

    const payload = await readApiJson<NibiTokenResponse>(this.apiClient, this.config.tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: context.redirectUri,
        client_id: this.config.appId,
        code_verifier: pkce.verifier,
      }).toString(),
    });

    const tokenSet = readTokenPayload(payload);
    const expiresAt = normalizeExpiresAt(payload.expires_in, context.now());
    return expiresAt ? { ...tokenSet, expiresAt } : tokenSet;
  }

  async fetchUserInfo(
    tokenSet: OAuthTokenSet,
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
    const profile = await readApiJson<NibiUserInfoResponse>(this.apiClient, this.config.userinfoUrl, {
      method: "GET",
      // 启动恢复登录态依赖这条链路，必须给超时，否则弱网下界面会一直停在“恢复中”。
      timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokenSet.accessToken}`,
      },
    });

    const id = profile.sub?.trim() || "unknown";
    const username = profile.preferred_username?.trim() || profile.email?.trim() || id;
    const displayName = profile.name?.trim() || username;
    const avatarUrl = profile.picture?.trim();

    return {
      id,
      username,
      displayName,
      ...(avatarUrl ? { avatarUrl } : {}),
      rawProfile: profile,
    };
  }

  async refreshToken(
    tokenSet: OAuthTokenSet,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    if (!tokenSet.refreshToken) {
      throw new Error("当前账号缺少 refresh_token，请重新登录");
    }

    const payload = await readApiJson<NibiTokenResponse>(this.apiClient, this.config.tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenSet.refreshToken,
        client_id: this.config.appId,
      }).toString(),
    });

    const refreshed = readTokenPayload(payload);
    const expiresAt = normalizeExpiresAt(payload.expires_in, context.now());
    return {
      ...refreshed,
      // Zitadel 在 refresh 时可能轮换 refresh_token；没返回就沿用旧值，避免下次刷新直接失败。
      refreshToken: refreshed.refreshToken ?? tokenSet.refreshToken,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(`NIBI OAuth 异常: ${String(error)}`);
  }

  private pruneExpiredPkce(now: number): void {
    for (const [state, entry] of this.pendingPkce) {
      if (entry.expiresAt <= now) {
        this.pendingPkce.delete(state);
      }
    }
  }
}

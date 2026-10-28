import { afterEach, expect, it, vi } from "vitest";
import { ApiError, NIBI_PROVIDER_ID, type OAuthProviderAdapter, type OAuthTokenSet } from "@nibi/shared";
import type { IOAuthService } from "#src/oauth/oauth.js";
import { OAuthService } from "#src/oauth/oauthService.js";

const services: OAuthService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.cancelPending()));
});

const NOW_MS = Date.parse("2026-10-28T08:00:00.000Z");

function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

const EXPIRED_ACCESS = jwtWithExp(Math.floor(NOW_MS / 1000) - 120);
const FRESH_ACCESS = jwtWithExp(Math.floor(NOW_MS / 1000) + 3600);

interface FixtureOptions {
  refreshToken?: (tokenSet: OAuthTokenSet) => Promise<OAuthTokenSet>;
}

function fixture(options: FixtureOptions = {}) {
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  const credentials = new Map<string, string>();
  const credentialService = {
    load: async (key: string) => credentials.get(key) ?? null,
    save: async (key: string, value: string) => {
      credentials.set(key, value);
    },
    delete: async (key: string) => {
      credentials.delete(key);
    },
  };
  const adapter: OAuthProviderAdapter = {
    providerId: NIBI_PROVIDER_ID,
    apiClient: { request: vi.fn<typeof fetch>() },
    meta: { id: NIBI_PROVIDER_ID, displayName: "NIBI", enabled: true, order: 0 },
    redirectUri: "nibi://oauth/callback",
    buildAuthorizeUrl: ({ state }) => `https://auth.example/authorize?state=${state}`,
    parseCallbackParams: (url) => ({
      state: new URL(url).searchParams.get("state") ?? "",
      code: new URL(url).searchParams.get("code") ?? "",
    }),
    // 登录即拿到一个已过期的 access token + 有效 refresh token：模拟"关机超过 token 生命期"。
    exchangeToken: vi.fn(async (): Promise<OAuthTokenSet> => ({
      accessToken: EXPIRED_ACCESS,
      refreshToken: "refresh-1",
    })),
    fetchUserInfo: async () => ({ id: "user-1", username: "user-1", displayName: "User" }),
    refreshToken: options.refreshToken,
    normalizeError: (error) => (error instanceof Error ? error : new Error(String(error))),
  };
  const service = new OAuthService(credentialService, {
    now: () => NOW_MS,
    adapters: [adapter],
  });
  services.push(service);
  async function login(): Promise<void> {
    const { state } = await service.startOAuth(NIBI_PROVIDER_ID);
    await service.handleCallback(`nibi://oauth/callback?state=${state}&code=code`);
  }
  return { service, credentials, adapter, login };
}

it("NIBI 启动恢复：access 过期但 refresh 有效 → 刷新并恢复登录态，不清 refresh token", async () => {
  const f = fixture({
    refreshToken: async (tokenSet) => ({
      accessToken: FRESH_ACCESS,
      refreshToken: tokenSet.refreshToken,
    }),
  });
  await f.login();
  expect(f.credentials.get("oauth:nibi:access_token")).toBe(EXPIRED_ACCESS);

  const result = await f.service.restoreCachedSessionState();
  expect(result.status).toBe("authenticated");
  expect(f.credentials.get("oauth:nibi:access_token")).toBe(FRESH_ACCESS);
  // refresh token 轮换语义：没返回新值时沿用旧值，不能被清掉。
  expect(f.credentials.get("oauth:nibi:refresh_token")).toBe("refresh-1");
  expect(f.credentials.get("oauth:active_provider")).toBe(NIBI_PROVIDER_ID);
});

it("NIBI 启动恢复：refresh 被服务端拒绝（invalid_grant）→ 才清会话", async () => {
  const f = fixture({
    refreshToken: async () => {
      throw new ApiError({ message: "invalid_grant", url: "https://auth.example/token", method: "POST", status: 400 });
    },
  });
  await f.login();

  const result = await f.service.restoreCachedSessionState();
  expect(result.status).toBe("reauthentication-required");
  expect(f.credentials.get("oauth:nibi:refresh_token")).toBeUndefined();
  expect(f.credentials.get("oauth:active_provider")).toBeUndefined();
});

it("NIBI 启动恢复：refresh 遇到网络错误 → 保留凭据按已登录恢复", async () => {
  const f = fixture({
    refreshToken: async () => {
      throw new Error("getaddrinfo ENOTFOUND auth.example");
    },
  });
  await f.login();

  const result = await f.service.restoreCachedSessionState();
  expect(result.status).toBe("authenticated");
  // 凭据原样保留：网络失败绝不能误删 refresh token。
  expect(f.credentials.get("oauth:nibi:access_token")).toBe(EXPIRED_ACCESS);
  expect(f.credentials.get("oauth:nibi:refresh_token")).toBe("refresh-1");
  expect(f.credentials.get("oauth:active_provider")).toBe(NIBI_PROVIDER_ID);
});

it("NIBI 登录成功会清掉 legacy zcodejwttoken，避免它反过来污染启动恢复", async () => {
  const f = fixture();
  f.credentials.set("zcodejwttoken", "stale-legacy-jwt");
  await f.login();
  expect(f.credentials.has("zcodejwttoken")).toBe(false);
});

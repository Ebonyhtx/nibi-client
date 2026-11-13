import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserOAuthCredentialRepo } from "../src/auth/browserOAuthCredentialRepo.js";
import { buildOAuthState } from "../src/auth/oauthStateCodec.js";
import {
  createNibiWebOAuthConfig,
  NibiWebOAuthProvider,
  type NibiWebOAuthConfig,
} from "../src/auth/nibiWebOAuth.js";
import { WebAuthService } from "../src/auth/webAuthService.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const PENDING_LOGINS_KEY = "oauth_pending_logins";

function nibiConfig(): NibiWebOAuthConfig {
  return createNibiWebOAuthConfig({ VITE_NIBI_BASE_URL: "https://api.nibistudio.cn" });
}

function createService(currentOrigin = "http://192.168.1.8:5173") {
  const localStorage = new MemoryStorage();
  const assigned: string[] = [];
  const replaced: string[] = [];
  const config = nibiConfig();
  let nonceCount = 0;
  const service = new WebAuthService({
    nibiConfig: config,
    nibiProvider: new NibiWebOAuthProvider(config, () => 1_000),
    repo: new BrowserOAuthCredentialRepo({ localStorage }),
    runtime: {
      assign: (url) => assigned.push(url),
      createNonce: () => `nonce-${++nonceCount}`,
      getCurrentHref: () => `${currentOrigin}/remote/v4?sid=device-1&mid=mid-1`,
      getCurrentOrigin: () => currentOrigin,
      replace: (url) => replaced.push(url),
    },
  });
  return { assigned, config, localStorage, replaced, service };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("WebAuthService NIBI login", () => {
  it("uses the NIBI authorize endpoint with PKCE and a clean redirect_uri", async () => {
    const h = createService();
    await h.service.startLogin({ provider: "nibi" });

    const authorize = new URL(h.assigned[0]!);
    expect(authorize.origin).toBe("https://auth.nibistudio.cn");
    expect(authorize.pathname).toBe("/oauth/v2/authorize");
    expect(authorize.searchParams.get("client_id")).toBeTruthy();
    expect(authorize.searchParams.get("redirect_uri")).toBe(h.config.redirectUri);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize.searchParams.get("state")).toBeTruthy();
  });

  it("uses the share callback when starting share login", async () => {
    const h = createService();
    await h.service.startLogin({
      provider: "nibi",
      appReturnTo: "https://share.example.test/c/abc",
      redirectUri: h.config.shareRedirectUri,
    });

    const authorize = new URL(h.assigned[0]!);
    expect(authorize.searchParams.get("redirect_uri")).toBe(h.config.shareRedirectUri);
  });

  it("adds prompt=login only when switching accounts", async () => {
    const h = createService();
    await h.service.startLogin({ provider: "nibi", forceLogin: true });
    expect(new URL(h.assigned[0]!).searchParams.get("prompt")).toBe("login");
  });

  it("exchanges the code and persists a complete NIBI session", async () => {
    const h = createService();
    await h.service.startLogin({ provider: "nibi" });
    const authorize = new URL(h.assigned[0]!);
    const state = authorize.searchParams.get("state")!;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3_600,
          user: { user_id: "user-1", name: "Ada", email: "ada@example.test" },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await h.service.handleCallback(
      `${h.config.redirectUri}?code=code-1&state=${encodeURIComponent(state)}`,
    );

    expect(result?.userInfo.id).toBe("user-1");
    expect(h.localStorage.getItem("oauth:active_provider")).toBe("nibi");
    expect(h.localStorage.getItem("oauth:nibi:access_token")).toBe("access-token");
    expect(h.localStorage.getItem("oauth:nibi:refresh_token")).toBe("refresh-token");
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ code: "code-1", redirect_uri: h.config.redirectUri });
    expect(body.code_verifier).toBeTruthy();
  });

  it("rejects a callback without a PKCE verifier", async () => {
    const h = createService();
    h.localStorage.setItem(
      PENDING_LOGINS_KEY,
      JSON.stringify([
        { nonce: "nonce-1", provider: "nibi", redirectUri: h.config.redirectUri },
      ]),
    );
    const state = buildOAuthState({ nonce: "nonce-1", app_return_to: h.config.redirectUri });
    await expect(
      h.service.handleCallback(`${h.config.redirectUri}?code=code-1&state=${encodeURIComponent(state)}`),
    ).rejects.toThrow(/PKCE/);
  });
});

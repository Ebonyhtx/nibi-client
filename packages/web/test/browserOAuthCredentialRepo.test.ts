import { describe, expect, it } from "vitest";
import { BrowserOAuthCredentialRepo } from "../src/auth/browserOAuthCredentialRepo.js";

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

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

describe("BrowserOAuthCredentialRepo", () => {
  it("只读返回当前 provider 的账号展示资料，缺 JWT 或资料损坏也不清理存储", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });

    expect(repo.loadActiveAccount()).toBeNull();
    repo.saveUserInfo(
      { user_id: "53291785835589288", name: "Ada", avatar: "https://example.com/a.png" },
      "nibi",
    );
    repo.setActiveProvider("nibi");
    expect(repo.loadActiveAccount()).toEqual({
      provider: "nibi",
      userInfo: {
        id: "53291785835589288",
        username: "Ada",
        displayName: "Ada",
        avatarUrl: "https://example.com/a.png",
      },
    });

    localStorage.setItem("oauth:nibi:user_info", "{not json");
    expect(repo.loadActiveAccount()).toBeNull();
    // 展示读取不是登录门禁：不能像 loadCachedSessionState 那样顺手清理残缺凭据。
    expect(localStorage.getItem("oauth:active_provider")).toBe("nibi");
    expect(localStorage.getItem("oauth:nibi:user_info")).toBe("{not json");
  });

  it("clears an expired JWT session and requests reauthentication", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage }, { now: () => 2_000_000 });

    localStorage.setItem("oauth:active_provider", "nibi");
    localStorage.setItem("nibi-jwttoken", createUnsignedJwt({ exp: 1_000 }));
    localStorage.setItem("oauth:nibi:access_token", "zai-token");
    localStorage.setItem("oauth:nibi:user_info", JSON.stringify({ user_id: "u_1", name: "Ada" }));

    expect(repo.loadCachedSessionState()).toEqual({
      status: "reauthentication-required",
      reason: "jwt-expired",
    });
    expect(localStorage.getItem("oauth:active_provider")).toBeNull();
    expect(localStorage.getItem("nibi-jwttoken")).toBeNull();
    expect(localStorage.getItem("oauth:nibi:access_token")).toBeNull();
    expect(localStorage.getItem("oauth:nibi:user_info")).toBeNull();
  });

  it("登录记录跨标签页可取回，取出即删，清理登录凭据时保留", () => {
    const localStorage = new MemoryStorage();
    const tabA = new BrowserOAuthCredentialRepo({ localStorage });
    const tabB = new BrowserOAuthCredentialRepo({ localStorage });
    const login = {
      nonce: "nonce-1",
      provider: "nibi" as const,
      redirectUri: "https://zcode.z.ai/remote/v4?sid=device-1",
    };

    tabA.savePendingLogin(login);
    // 回调页可能先跑登录门禁，残缺凭据清理不能顺带删掉进行中的登录。
    tabB.clearAll();

    expect(tabB.takePendingLogin("nonce-1")).toEqual(login);
    expect(tabB.takePendingLogin("nonce-1")).toBeNull();
    expect(localStorage.getItem("oauth_pending_logins")).toBeNull();
  });

  it("只取 nonce 匹配的登录记录，不匹配时不改动其他记录", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });
    const loginA = { nonce: "a", provider: "nibi" as const, redirectUri: "https://zcode.z.ai/a" };
    const loginB = {
      nonce: "b",
      provider: "nibi" as const,
      redirectUri: "https://zcode.z.ai/b",
    };
    repo.savePendingLogin(loginA);
    repo.savePendingLogin(loginB);
    const stored = localStorage.getItem("oauth_pending_logins");

    expect(repo.takePendingLogin("unknown")).toBeNull();
    expect(localStorage.getItem("oauth_pending_logins")).toBe(stored);
    expect(repo.takePendingLogin("a")).toEqual(loginA);
    expect(repo.takePendingLogin("b")).toEqual(loginB);
  });

  it("NIBI 凭据使用独立 key 段，且 access token 同时作为中继 JWT", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });

    repo.saveTokenSet({ accessToken: "nibi-access", nibiJwtToken: "nibi-access" }, "nibi");
    repo.saveUserInfo({ id: "u-1", username: "ada", displayName: "Ada" }, "nibi");
    repo.setActiveProvider("nibi");

    expect(localStorage.getItem("oauth:nibi:access_token")).toBe("nibi-access");
    expect(localStorage.getItem("oauth:nibi:user_info")).toContain("Ada");
    expect(repo.loadNibiJwtToken()).toBe("nibi-access");
    expect(repo.loadCachedSession()).toEqual({
      id: "u-1",
      username: "ada",
      displayName: "Ada",
    });
    expect(repo.getActiveProvider()).toBe("nibi");

    repo.clearAll();
    expect(localStorage.getItem("oauth:nibi:access_token")).toBeNull();
    expect(localStorage.getItem("oauth:nibi:user_info")).toBeNull();
    expect(localStorage.getItem("oauth:active_provider")).toBeNull();
  });

  it("最多保留最近 5 条登录记录", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });
    for (let index = 0; index < 6; index += 1) {
      repo.savePendingLogin({
        nonce: `nonce-${index}`,
        provider: "nibi",
        redirectUri: "https://zcode.z.ai/remote/v4",
      });
    }

    expect(repo.takePendingLogin("nonce-0")).toBeNull();
    expect(repo.takePendingLogin("nonce-1")).not.toBeNull();
    expect(repo.takePendingLogin("nonce-5")).not.toBeNull();
  });

  it("损坏或字段不完整的登录记录视为不存在", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });

    localStorage.setItem("oauth_pending_logins", "{not json");
    expect(repo.takePendingLogin("nonce-1")).toBeNull();

    localStorage.setItem(
      "oauth_pending_logins",
      JSON.stringify([
        { nonce: "nonce-1", provider: "not-a-provider", redirectUri: "https://zcode.z.ai" },
        { nonce: "nonce-2", provider: "nibi", redirectUri: " " },
      ]),
    );
    expect(repo.takePendingLogin("nonce-1")).toBeNull();
    expect(repo.takePendingLogin("nonce-2")).toBeNull();

    const login = { nonce: "nonce-3", provider: "nibi" as const, redirectUri: "https://zcode.z.ai" };
    repo.savePendingLogin(login);
    expect(repo.takePendingLogin("nonce-3")).toEqual(login);
  });
});

describe("NIBI refresh token persistence", () => {
  const now = 1_790_000_000_000;
  const jwt = (expSeconds: number) =>
    createUnsignedJwt({ exp: Math.floor(expSeconds), sub: "user-1" });

  it("stores refresh token + expiry on login and restores them", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage }, { now: () => now });
    const access = jwt(now / 1000 + 3600);
    repo.saveTokenSet(
      {
        accessToken: access,
        nibiJwtToken: access,
        refreshToken: "refresh-1",
        expiresAt: now + 3600_000,
      },
      "nibi",
    );
    repo.saveUserInfo({ sub: "user-1", name: "Ada" }, "nibi");
    repo.setActiveProvider("nibi");

    expect(repo.loadNibiRefreshState()).toEqual({
      accessToken: access,
      refreshToken: "refresh-1",
      expiresAt: now + 3600_000,
    });
  });

  it("keeps credentials when the JWT expired but a refresh token exists", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage }, { now: () => now });
    const expired = jwt(now / 1000 - 60);
    repo.saveTokenSet(
      { accessToken: expired, nibiJwtToken: expired, refreshToken: "refresh-1" },
      "nibi",
    );
    repo.saveUserInfo({ sub: "user-1", name: "Ada" }, "nibi");
    repo.setActiveProvider("nibi");

    expect(repo.loadCachedSessionState()).toEqual({
      status: "reauthentication-required",
      reason: "jwt-expired",
    });
    expect(repo.loadNibiRefreshState()?.refreshToken).toBe("refresh-1");
  });

  it("clears everything when the JWT expired without a refresh token", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage }, { now: () => now });
    const expired = jwt(now / 1000 - 60);
    repo.saveTokenSet({ accessToken: expired, nibiJwtToken: expired }, "nibi");
    repo.saveUserInfo({ sub: "user-1", name: "Ada" }, "nibi");
    repo.setActiveProvider("nibi");

    expect(repo.loadCachedSessionState()).toEqual({
      status: "reauthentication-required",
      reason: "jwt-expired",
    });
    expect(localStorage.getItem("oauth:nibi:refresh_token")).toBeNull();
    expect(localStorage.getItem("oauth:active_provider")).toBeNull();
  });

  it("updates tokens on refresh without touching the cached user", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage }, { now: () => now });
    const access = jwt(now / 1000 + 3600);
    repo.saveTokenSet(
      { accessToken: access, nibiJwtToken: access, refreshToken: "refresh-1" },
      "nibi",
    );
    repo.saveUserInfo({ sub: "user-1", name: "Ada" }, "nibi");
    repo.setActiveProvider("nibi");

    const next = jwt(now / 1000 + 7200);
    repo.saveNibiRefreshedTokenSet({
      accessToken: next,
      refreshToken: "refresh-2",
      expiresAt: now + 7200_000,
    });

    expect(repo.loadNibiJwtToken()).toBe(next);
    expect(repo.loadNibiRefreshState()?.refreshToken).toBe("refresh-2");
    expect(repo.loadActiveAccount()?.userInfo.displayName).toBe("Ada");
  });
});

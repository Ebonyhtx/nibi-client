import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@nibi/contracts";
import { createSharedZCodeCredentialStore } from "@nibi/adapters";
import {
  NIBI_ACCOUNT_CREDENTIAL_KEYS,
  NIBI_ACCOUNT_DEVICE_ID_KEY,
  loginNibiAccount,
  logoutNibiAccount,
} from "../src/auth-nibi-login.js";

const AUTH_ORIGIN = "https://auth.example";
const API_ORIGIN = "https://api.example";

class QueueHttpClient implements HttpClientPort {
  readonly urls: string[] = [];

  constructor(private readonly responses: HttpClientResponse[]) {}

  async request(request: HttpClientRequest): Promise<HttpClientResponse> {
    this.urls.push(request.url);
    const response = this.responses.shift();
    if (!response) throw new Error(`No fake response configured for ${request.url}`);
    return response;
  }
}

function jsonResponse(body: unknown, status = 200): HttpClientResponse {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  return {
    body: encoded,
    bytes: encoded.byteLength,
    durationMs: 1,
    headers: { "content-type": "application/json" },
    status,
    statusText: status === 200 ? "OK" : "Error",
    url: AUTH_ORIGIN,
  };
}

function deviceAuthorizationResponse() {
  return jsonResponse({
    device_code: "device-1",
    expires_in: 300,
    interval: 1,
    user_code: "ABCD-EFGH",
    verification_uri: `${AUTH_ORIGIN}/device`,
    verification_uri_complete: `${AUTH_ORIGIN}/device?user_code=ABCD-EFGH`,
  });
}

function tokenResponse() {
  return jsonResponse({
    access_token: "access-1",
    expires_in: 3600,
    refresh_token: "refresh-1",
    token_type: "Bearer",
  });
}

function userInfoResponse() {
  return jsonResponse({
    email: "alice@example.com",
    name: "Alice",
    picture: "https://example.com/a.png",
    preferred_username: "alice",
    sub: "user-1",
  });
}

describe("loginNibiAccount", () => {
  let directory: string;
  let credentialsPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "nibi-account-login-"));
    credentialsPath = join(directory, "credentials.json");
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("stores the NIBI session and the membership license", async () => {
    const store = createSharedZCodeCredentialStore({ env: {}, filePath: credentialsPath });
    const http = new QueueHttpClient([
      deviceAuthorizationResponse(),
      tokenResponse(),
      userInfoResponse(),
      jsonResponse({
        authorized: true,
        license: { expiresAt: "2026-11-20T00:00:00.000Z", plan: "pro", token: "license-token" },
        membership: { expiresAt: "2026-11-20T00:00:00.000Z", plan: "pro", status: "active" },
        reason: null,
      }),
    ]);
    const codes: string[] = [];

    const result = await loginNibiAccount({
      apiOrigin: API_ORIGIN,
      authOrigin: AUTH_ORIGIN,
      credentialStore: store,
      env: {},
      httpClient: http,
      noBrowser: true,
      now: () => 1_000_000,
      onDeviceCode: (authorization) => codes.push(authorization.userCode),
      sleep: async () => undefined,
    });

    expect(codes).toEqual(["ABCD-EFGH"]);
    expect(result.user).toEqual({
      email: "alice@example.com",
      id: "user-1",
      name: "Alice",
      avatarUrl: "https://example.com/a.png",
    });
    expect(result.membership).toEqual({
      expiresAt: "2026-11-20T00:00:00.000Z",
      plan: "pro",
      status: "active",
    });
    expect(result.credentialsPath).toBe(credentialsPath);
    expect(result.warnings).toEqual([]);
    expect(http.urls).toEqual([
      `${AUTH_ORIGIN}/oauth/v2/device_authorization`,
      `${AUTH_ORIGIN}/oauth/v2/token`,
      `${AUTH_ORIGIN}/oidc/v1/userinfo`,
      `${API_ORIGIN}/api/v1/licenses/check`,
    ]);

    await expect(store.load(NIBI_ACCOUNT_CREDENTIAL_KEYS.accessToken)).resolves.toBe("access-1");
    await expect(store.load(NIBI_ACCOUNT_CREDENTIAL_KEYS.refreshToken)).resolves.toBe("refresh-1");
    await expect(store.load(NIBI_ACCOUNT_CREDENTIAL_KEYS.activeProvider)).resolves.toBe("nibi");
    await expect(store.load("nibi:license:token")).resolves.toBe("license-token");
    const state = JSON.parse((await store.load("nibi:license:state")) ?? "{}") as {
      deviceId?: string;
      lastRefusal?: string | null;
      plan?: string;
    };
    expect(state.lastRefusal).toBeNull();
    expect(state.plan).toBe("pro");
    expect(state.deviceId).toBeTruthy();
    await expect(store.load(NIBI_ACCOUNT_DEVICE_ID_KEY)).resolves.toBe(state.deviceId);
  });

  it("records a membership refusal without losing the signed-in session", async () => {
    const store = createSharedZCodeCredentialStore({ env: {}, filePath: credentialsPath });
    const http = new QueueHttpClient([
      deviceAuthorizationResponse(),
      tokenResponse(),
      userInfoResponse(),
      jsonResponse({ authorized: false, license: null, membership: null, reason: "no_membership" }),
    ]);

    const result = await loginNibiAccount({
      apiOrigin: API_ORIGIN,
      authOrigin: AUTH_ORIGIN,
      credentialStore: store,
      env: {},
      httpClient: http,
      noBrowser: true,
      now: () => 1_000_000,
      sleep: async () => undefined,
    });

    expect(result.membership).toEqual({ status: "none" });
    await expect(store.load(NIBI_ACCOUNT_CREDENTIAL_KEYS.accessToken)).resolves.toBe("access-1");
    await expect(store.load("nibi:license:token")).resolves.toBeNull();
    const state = JSON.parse((await store.load("nibi:license:state")) ?? "{}") as {
      lastRefusal?: string | null;
    };
    expect(state.lastRefusal).toBe("no_membership");
  });

  it("keeps the session when the license check fails over the network", async () => {
    const store = createSharedZCodeCredentialStore({ env: {}, filePath: credentialsPath });
    const http = new QueueHttpClient([
      deviceAuthorizationResponse(),
      tokenResponse(),
      userInfoResponse(),
    ]);

    const result = await loginNibiAccount({
      apiOrigin: API_ORIGIN,
      authOrigin: AUTH_ORIGIN,
      credentialStore: store,
      env: {},
      httpClient: http,
      noBrowser: true,
      now: () => 1_000_000,
      sleep: async () => undefined,
    });

    expect(result.membership).toBeNull();
    expect(result.warnings).toHaveLength(1);
    await expect(store.load(NIBI_ACCOUNT_CREDENTIAL_KEYS.accessToken)).resolves.toBe("access-1");
    await expect(store.load("nibi:license:state")).resolves.toBeNull();
  });

  it("logs out only the NIBI provider and keeps an unrelated active provider", async () => {
    const store = createSharedZCodeCredentialStore({ env: {}, filePath: credentialsPath });
    await store.saveMany({
      "nibi:license:state": "{}",
      "nibi:license:token": "license-token",
      "oauth:active_provider": "acme",
      [NIBI_ACCOUNT_CREDENTIAL_KEYS.accessToken]: "access-1",
      [NIBI_ACCOUNT_CREDENTIAL_KEYS.refreshToken]: "refresh-1",
      [NIBI_ACCOUNT_CREDENTIAL_KEYS.userInfo]: JSON.stringify({ id: "user-1" }),
    });

    const result = await logoutNibiAccount({ credentialStore: store, env: {} });

    expect(result.clearedKeys).not.toContain("oauth:active_provider");
    await expect(store.load(NIBI_ACCOUNT_CREDENTIAL_KEYS.accessToken)).resolves.toBeNull();
    await expect(store.load(NIBI_ACCOUNT_CREDENTIAL_KEYS.refreshToken)).resolves.toBeNull();
    await expect(store.load("nibi:license:token")).resolves.toBeNull();
    await expect(store.load("nibi:license:state")).resolves.toBeNull();
    await expect(store.load("oauth:active_provider")).resolves.toBe("acme");
  });
});

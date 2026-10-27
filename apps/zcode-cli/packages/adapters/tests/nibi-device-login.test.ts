import { describe, expect, it } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@nibi/contracts";
import {
  createNibiDeviceLoginClient,
  NibiDeviceLoginError,
} from "../src/auth/nibi-device-login.js";

class FakeHttpClient implements HttpClientPort {
  readonly requests: HttpClientRequest[] = [];
  readonly bodies: string[] = [];

  constructor(private readonly responses: HttpClientResponse[]) {}

  async request(request: HttpClientRequest): Promise<HttpClientResponse> {
    this.requests.push(request);
    this.bodies.push(request.body ? new TextDecoder().decode(request.body) : "");
    const response = this.responses.shift();
    if (!response) throw new Error("No fake response configured");
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
    url: "https://auth.example",
  };
}

describe("NIBI device login client", () => {
  it("starts a device authorization with the project audience scope", async () => {
    const http = new FakeHttpClient([
      jsonResponse({
        device_code: "device-1",
        expires_in: 300,
        interval: 5,
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.nibistudio.top/device",
        verification_uri_complete: "https://auth.nibistudio.top/device?user_code=ABCD-EFGH",
      }),
    ]);
    const client = createNibiDeviceLoginClient({
      authOrigin: "https://auth.nibistudio.top",
      httpClient: http,
      now: () => 1_000,
    });

    const authorization = await client.start();

    expect(http.requests[0]?.url).toBe(
      "https://auth.nibistudio.top/oauth/v2/device_authorization",
    );
    expect(http.requests[0]?.method).toBe("POST");
    const body = new URLSearchParams(http.bodies[0]);
    expect(body.get("client_id")).toBe("393742196290879492");
    expect(body.get("scope")).toContain("urn:zitadel:iam:org:project:id:393742195619790852:aud");
    expect(body.get("scope")).toContain("offline_access");
    expect(authorization).toEqual({
      deviceCode: "device-1",
      expiresAt: 301_000,
      intervalMs: 5_000,
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.nibistudio.top/device",
      verificationUriComplete: "https://auth.nibistudio.top/device?user_code=ABCD-EFGH",
    });
  });

  it("maps pending and completed polls", async () => {
    const http = new FakeHttpClient([
      jsonResponse({ error: "authorization_pending" }, 400),
      jsonResponse({
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        token_type: "Bearer",
      }),
    ]);
    const client = createNibiDeviceLoginClient({
      authOrigin: "https://auth.nibistudio.top",
      httpClient: http,
      now: () => 5_000,
    });

    await expect(client.poll("device-1")).resolves.toEqual({ status: "pending" });
    const ready = await client.poll("device-1");
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("expected ready");
    expect(ready.tokenSet.accessToken).toBe("access-1");
    expect(ready.tokenSet.refreshToken).toBe("refresh-1");
    expect(ready.tokenSet.expiresAt).toBe(5_000 + 3_600_000);
    const pollBody = new URLSearchParams(http.bodies[0]);
    expect(pollBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(pollBody.get("device_code")).toBe("device-1");
  });

  it("reports slow_down, expiry and denial without throwing", async () => {
    const client = (responses: HttpClientResponse[]) =>
      createNibiDeviceLoginClient({
        authOrigin: "https://auth.nibistudio.top",
        httpClient: new FakeHttpClient(responses),
      });

    await expect(
      client([jsonResponse({ error: "slow_down", interval: 10 }, 400)]).poll("device"),
    ).resolves.toEqual({ intervalMs: 10_000, status: "slow_down" });
    await expect(
      client([jsonResponse({ error: "expired_token" }, 400)]).poll("device"),
    ).resolves.toEqual({ status: "expired" });
    await expect(
      client([jsonResponse({ error: "access_denied" }, 400)]).poll("device"),
    ).resolves.toEqual({ status: "denied" });
  });

  it("surfaces unexpected OAuth errors with their description", async () => {
    const client = createNibiDeviceLoginClient({
      authOrigin: "https://auth.nibistudio.top",
      httpClient: new FakeHttpClient([
        jsonResponse({ error: "invalid_grant", error_description: "Client not allowed" }, 400),
      ]),
    });

    await expect(client.poll("device")).rejects.toMatchObject({
      message: "Client not allowed",
      name: "NibiDeviceLoginError",
      oauthError: "invalid_grant",
    } satisfies Partial<NibiDeviceLoginError>);
  });

  it("reads the user profile from userinfo and rejects a missing sub", async () => {
    const client = createNibiDeviceLoginClient({
      authOrigin: "https://auth.nibistudio.top",
      httpClient: new FakeHttpClient([
        jsonResponse({
          email: "alice@example.com",
          name: "Alice",
          picture: "https://example.com/a.png",
          preferred_username: "alice",
          sub: "user-1",
        }),
        jsonResponse({ email: "nobody@example.com" }),
      ]),
    });

    await expect(client.fetchUserInfo("access-1")).resolves.toMatchObject({
      avatarUrl: "https://example.com/a.png",
      email: "alice@example.com",
      id: "user-1",
      name: "Alice",
      preferredUsername: "alice",
    });
    await expect(client.fetchUserInfo("access-1")).rejects.toBeInstanceOf(NibiDeviceLoginError);
  });
});

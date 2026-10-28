import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@nibi/shared";
import { createNibiLicenseSync, NIBI_DEVICE_ID_KEY } from "../src/license/nibiLicenseSync.js";
import {
  NIBI_LICENSE_STATE_KEY,
  NIBI_LICENSE_TOKEN_KEY,
  type NibiLicenseSnapshot,
} from "../src/license/nibiLicense.js";

const NOW = Date.parse("2026-10-26T08:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const kid = "startup-kid";
  const publicKeys = { [kid]: publicKey.export({ type: "spki", format: "pem" }).toString() };
  const signToken = (overrides: Record<string, unknown> = {}): string => {
    const header = Buffer.from(JSON.stringify({ alg: "Ed25519", kid })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "nibi-license",
        sub: "user-1",
        uid: "user-1",
        plan: "pro",
        plugins: ["*"],
        dev: "device-1234",
        iat: Math.floor(NOW / 1000),
        exp: Math.floor((NOW + 30 * DAY) / 1000),
        jti: "jti-1",
        ...overrides,
      }),
    ).toString("base64url");
    const signature = edSign(null, Buffer.from(`${header}.${payload}`, "utf8"), privateKey);
    return `${header}.${payload}.${signature.toString("base64url")}`;
  };
  return { publicKeys, signToken };
}

function snapshot(checkedAgoMs: number, refusal: string | null = null): NibiLicenseSnapshot {
  return {
    deviceId: "device-1234",
    lastCheckAt: new Date(NOW - checkedAgoMs).toISOString(),
    lastRefusal: refusal,
    plan: "pro",
  };
}

function createHarness(input: {
  publicKeys: Record<string, string>;
  token: string;
  state: NibiLicenseSnapshot;
  response?: { status: number; body: unknown };
}) {
  const store = new Map<string, string>([
    [NIBI_DEVICE_ID_KEY, "device-1234"],
    [NIBI_LICENSE_TOKEN_KEY, input.token],
    [NIBI_LICENSE_STATE_KEY, JSON.stringify(input.state)],
  ]);
  const request = vi.fn(async () =>
    new Response(JSON.stringify(input.response?.body ?? {}), {
      status: input.response?.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const sync = createNibiLicenseSync({
    apiClient: { request } as unknown as ApiClient,
    credentialService: {
      load: async (key) => store.get(key) ?? null,
      save: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
    },
    now: () => NOW,
    publicKeys: input.publicKeys,
    resolveEndpointOrigin: () => "https://api.nibistudio.top",
  });
  return { request, store, sync };
}

describe("startup license sync (revocation freshness)", () => {
  it("reads the cache without a request when the last check is fresh", async () => {
    const { publicKeys, signToken } = makeSigner();
    const { request, sync } = createHarness({
      publicKeys,
      state: snapshot(2 * MINUTE),
      token: signToken(),
    });

    const decision = await sync.syncOnStartup();
    expect(request).not.toHaveBeenCalled();
    expect(decision.status).toBe("active");
    expect(decision.allowed).toBe(true);
  });

  it("forces /licenses/check when the last check is older than the startup interval", async () => {
    const { publicKeys, signToken } = makeSigner();
    const token = signToken();
    const { request, store, sync } = createHarness({
      publicKeys,
      state: snapshot(30 * MINUTE),
      token,
      response: { status: 200, body: { authorized: true, license: { token, plan: "pro" } } },
    });

    const decision = await sync.syncOnStartup();
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as unknown as [string, { method: string }];
    expect(url).toBe("https://api.nibistudio.top/api/v1/licenses/check");
    expect(init.method).toBe("POST");
    expect(decision.status).toBe("active");
    expect(decision.allowed).toBe(true);
    const saved = JSON.parse(store.get(NIBI_LICENSE_STATE_KEY) ?? "{}") as NibiLicenseSnapshot;
    expect(Date.parse(saved.lastCheckAt ?? "")).toBe(NOW);
  });

  it("re-checks even when fresh if the last check was an explicit refusal", async () => {
    const { publicKeys, signToken } = makeSigner();
    const { request, sync } = createHarness({
      publicKeys,
      state: snapshot(5 * MINUTE, "revoked"),
      token: signToken(),
      response: { status: 403, body: { authorized: false, reason: "revoked" } },
    });

    const decision = await sync.syncOnStartup();
    expect(request).toHaveBeenCalledTimes(1);
    expect(decision.status).toBe("denied");
    expect(decision.allowed).toBe(false);
  });
});

/** 响应队列 + 可控挂起：第一个请求等待测试放行，用来编排 in-flight 时序。 */
function createGatedHarness(input: {
  publicKeys: Record<string, string>;
  token: string;
  state: NibiLicenseSnapshot;
  responses: Array<{ status: number; body: unknown }>;
  /** 已登录用户场景带 access token（换证走 Bearer 路）。 */
  accessToken?: string;
}) {
  const store = new Map<string, string>([
    [NIBI_DEVICE_ID_KEY, "device-1234"],
    [NIBI_LICENSE_TOKEN_KEY, input.token],
    [NIBI_LICENSE_STATE_KEY, JSON.stringify(input.state)],
    ...(input.accessToken ? [["oauth:nibi:access_token", input.accessToken] as const] : []),
  ]);
  let releaseFirst: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const request = vi.fn(async () => {
    const index = request.mock.calls.length;
    if (index === 1) await firstGate;
    const next = input.responses[index - 1];
    if (!next) throw new Error("unexpected extra license request");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });
  const sync = createNibiLicenseSync({
    apiClient: { request } as unknown as ApiClient,
    credentialService: {
      load: async (key) => store.get(key) ?? null,
      save: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
    },
    now: () => NOW,
    publicKeys: input.publicKeys,
    resolveEndpointOrigin: () => "https://api.nibistudio.top",
  });
  return { request, store, sync, releaseFirst: () => releaseFirst?.() };
}

describe("license sync force semantics", () => {
  it("a force sync runs its own online check instead of being swallowed by an in-flight sync", async () => {
    const { publicKeys, signToken } = makeSigner();
    const token = signToken();
    const { request, sync, releaseFirst } = createGatedHarness({
      publicKeys,
      token,
      // 检查已过 72h 间隔、还在 7 天宽限内：非 force 的 sync 也会发起在线检查，
      // 且首个请求被测试挂起，才有 in-flight 可言。
      state: snapshot(3 * DAY),
      responses: [
        { status: 200, body: { authorized: true, license: { token, plan: "pro" } } },
        { status: 403, body: { authorized: false, reason: "revoked" } },
      ],
    });

    const background = sync.sync(false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const forced = sync.sync(true);
    // 放行第一个请求，让链式 force 排在其后执行。
    releaseFirst();
    const [backgroundDecision, forcedDecision] = await Promise.all([background, forced]);
    // 两个请求各拿各的响应：background 恢复 active，force 拿到的是撤销结果，
    // 而不是复用第一个请求的 authorized。
    expect(request).toHaveBeenCalledTimes(2);
    expect(backgroundDecision.status).toBe("active");
    expect(forcedDecision.status).toBe("denied");
  });

  it("a force sync arriving after a clear runs its own check (login write order: token, then user_info)", async () => {
    const { publicKeys, signToken } = makeSigner();
    const token = signToken();
    const { request, store, sync, releaseFirst } = createGatedHarness({
      publicKeys,
      token,
      state: snapshot(2 * MINUTE),
      accessToken: "access-token-1",
      responses: [
        // 第一个请求属于旧代际（会被 clear 丢弃）；第二个是真跑的换证检查。
        { status: 200, body: { authorized: true, license: { token, plan: "pro" } } },
        { status: 200, body: { authorized: true, license: { token, plan: "pro" } } },
      ],
    });

    // 登录写序：access_token 写入触发 force sync #1；user_info 写入触发 clear + force sync #2。
    const background = sync.sync(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await sync.clear();
    const forced = sync.sync(true);
    releaseFirst();
    await Promise.all([background, forced]);
    // 旧实现：#2 复用 #1 的 promise，而 #1 被代际丢弃 → license 永不落盘。
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.has(NIBI_LICENSE_TOKEN_KEY)).toBe(true);
  });

  it("a clear during an in-flight sync invalidates the response and does not resurrect the license", async () => {
    const { publicKeys, signToken } = makeSigner();
    const token = signToken();
    const { request, store, sync, releaseFirst } = createGatedHarness({
      publicKeys,
      token,
      state: snapshot(2 * MINUTE),
      responses: [
        { status: 200, body: { authorized: true, license: { token, plan: "pro" } } },
      ],
    });

    const background = sync.sync(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    // 请求在飞时退出登录：响应作废、可能写回的凭证再删一次。
    await sync.clear();
    releaseFirst();
    await background;
    expect(store.has(NIBI_LICENSE_TOKEN_KEY)).toBe(false);
    expect(store.has(NIBI_LICENSE_STATE_KEY)).toBe(false);
  });
});

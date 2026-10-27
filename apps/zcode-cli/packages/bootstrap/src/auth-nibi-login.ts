/**
 * NIBI 账号登录（CLI/TUI 共用）。
 *
 * 与桌面端的分工：桌面端走 OIDC 授权码 + PKCE + `nibi://` 深链；CLI/TUI 走同一账号中心的
 * Device Authorization Grant（`nibi-tui` 这个 native app 已注册该 grant）。两条路写同一份
 * `~/.nibi/v2/credentials.json`，所以"桌面登录过、CLI 也认得"成立，反之亦然。
 *
 * 登录之后必须顺手做一次会员同步：收费插件门禁读的是 `nibi:license:token`（离线验签），
 * 只写 OAuth 令牌不写 license，会员用户装付费插件仍会被拦。同步失败不让登录失败——
 * 账号已经登上了，会员状态可以在下一次 `nibi login` 或桌面端启动时补上。
 */
import {
  createNibiDeviceLoginClient,
  createSharedZCodeCredentialStore,
  openUrlInBrowser,
  type NibiDeviceAuthorization,
  type NibiDeviceLoginClient,
  type NibiTokenSet,
  type NibiUserProfile,
  type SharedZCodeCredentialStore,
} from "@nibi/adapters";
import { createConfig } from "@nibi/adapters/config";
import { createNodeHttpClientAdapter } from "@nibi/adapters/http";
import type { HttpClientPort } from "@nibi/contracts";
import {
  NIBI_PROVIDER_ID,
  NIBI_TUI_OIDC_CLIENT_ID,
  resolveNibiAuthOrigin,
  resolveRuntimeZCodeEndpointOrigin,
} from "@nibi/shared";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";
import { NIBI_LICENSE_STATE_KEY, NIBI_LICENSE_TOKEN_KEY } from "@nibi/adapters/plugins";

/** 设备标识：一次生成、长期复用；服务端 /licenses/check 要求 8–128 字符。 */
export const NIBI_ACCOUNT_DEVICE_ID_KEY = "nibi:device:id";

export const NIBI_ACCOUNT_CREDENTIAL_KEYS = {
  accessToken: `oauth:${NIBI_PROVIDER_ID}:access_token`,
  activeProvider: "oauth:active_provider",
  refreshToken: `oauth:${NIBI_PROVIDER_ID}:refresh_token`,
  userInfo: `oauth:${NIBI_PROVIDER_ID}:user_info`,
} as const;

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const LICENSE_REQUEST_TIMEOUT_MS = 15_000;

export interface NibiAccountUser {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

export interface NibiAccountMembership {
  status: "active" | "expired" | "none" | "unknown";
  plan?: string | null;
  expiresAt?: string | null;
}

export interface NibiLoginOptions {
  abortSignal?: AbortSignal;
  /** 设备码已就绪：调用方负责把 URL/短码显示给用户。 */
  onDeviceCode?: (authorization: NibiDeviceAuthorization) => Promise<void> | void;
  /** 浏览器打开结果（`noBrowser` 时不回调）。 */
  onBrowserOpen?: (result: { opened: boolean; reason?: string }) => Promise<void> | void;
  noBrowser?: boolean;
  clientId?: string;
  authOrigin?: string;
  apiOrigin?: string;
  credentialStore?: SharedZCodeCredentialStore;
  httpClient?: HttpClientPort;
  openBrowser?: typeof openUrlInBrowser;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface NibiLoginResult {
  apiBaseUrl: string;
  authOrigin: string;
  credentialsPath: string;
  licenseExpiresAt?: string | null;
  membership: NibiAccountMembership | null;
  user: NibiAccountUser;
  warnings: string[];
}

export interface NibiLogoutResult {
  credentialsPath: string;
  /** 本次清掉的凭据键（不含值），用于 --json 输出与排障。 */
  clearedKeys: string[];
}

export class NibiLoginError extends Error {
  readonly code: "auth_timeout" | "auth_denied" | "auth_failed" | "credential_write_failed";

  constructor(
    code: NibiLoginError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "NibiLoginError";
    this.code = code;
  }
}

export async function loginNibiAccount(options: NibiLoginOptions = {}): Promise<NibiLoginResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
  const authOrigin = (options.authOrigin ?? resolveNibiAuthOrigin(env)).replace(/\/+$/u, "");
  const apiBaseUrl = `${(options.apiOrigin ?? resolveRuntimeZCodeEndpointOrigin(env)).replace(/\/+$/u, "")}/api/v1`;
  const client = createDeviceClient(options, env, authOrigin);

  const timeoutController = new AbortController();
  const timer = setTimeout(
    () =>
      timeoutController.abort(
        new NibiLoginError("auth_timeout", "登录超时，请重新执行 nibi login"),
      ),
    timeoutMs,
  );
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;

  try {
    throwIfAborted(signal);
    const authorization = await client.start({ signal });
    await options.onDeviceCode?.(authorization);
    throwIfAborted(signal);

    if (!options.noBrowser) {
      const target = authorization.verificationUriComplete ?? authorization.verificationUri;
      const browser = await waitWithAbort((options.openBrowser ?? openUrlInBrowser)(target), signal);
      await options.onBrowserOpen?.(browser);
    }

    const tokenSet = await pollDeviceAuthorization({
      authorization,
      client,
      now,
      signal,
      sleep: options.sleep ?? ((ms) => delay(ms, undefined, { signal })),
    });
    throwIfAborted(signal);

    const user = await client.fetchUserInfo(tokenSet.accessToken, { signal });
    try {
      await persistNibiSession(credentialStore, tokenSet, user);
    } catch (error) {
      throw new NibiLoginError("credential_write_failed", "登录成功，但写入本地凭据失败", {
        cause: error,
      });
    }

    const warnings: string[] = [];
    const license = await syncNibiLicense({
      apiBaseUrl,
      accessToken: tokenSet.accessToken,
      credentialStore,
      httpClient: options.httpClient,
      now,
      env,
      warnings,
    });

    return {
      apiBaseUrl,
      authOrigin,
      credentialsPath: credentialStore.filePath,
      membership: license.membership,
      licenseExpiresAt: license.licenseExpiresAt,
      user: toAccountUser(user),
      warnings,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function logoutNibiAccount(
  options: { credentialStore?: SharedZCodeCredentialStore; env?: Record<string, string | undefined> } = {},
): Promise<NibiLogoutResult> {
  const env = options.env ?? process.env;
  const store = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
  const clearedKeys: string[] = [];
  for (const key of [
    NIBI_ACCOUNT_CREDENTIAL_KEYS.accessToken,
    NIBI_ACCOUNT_CREDENTIAL_KEYS.refreshToken,
    NIBI_ACCOUNT_CREDENTIAL_KEYS.userInfo,
    NIBI_LICENSE_TOKEN_KEY,
    NIBI_LICENSE_STATE_KEY,
  ]) {
    await store.delete(key);
    clearedKeys.push(key);
  }
  // 只清掉指向 NIBI 的 active provider：别的 provider（用户自配的）登录态不属于本次登出。
  const clearedActive = await store.deleteIfValue(
    NIBI_ACCOUNT_CREDENTIAL_KEYS.activeProvider,
    NIBI_PROVIDER_ID,
  );
  if (clearedActive) clearedKeys.push(NIBI_ACCOUNT_CREDENTIAL_KEYS.activeProvider);
  return { clearedKeys, credentialsPath: store.filePath };
}

/** 登录态是否在本机存在（离线判断，不校验 token 是否过期）。 */
export async function readNibiAccountSession(
  options: { credentialStore?: SharedZCodeCredentialStore; env?: Record<string, string | undefined> } = {},
): Promise<{ accessToken: string | null; user: NibiAccountUser | null }> {
  const env = options.env ?? process.env;
  const store = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
  const [accessToken, rawUser] = await Promise.all([
    store.load(NIBI_ACCOUNT_CREDENTIAL_KEYS.accessToken),
    store.load(NIBI_ACCOUNT_CREDENTIAL_KEYS.userInfo),
  ]);
  let user: NibiAccountUser | null = null;
  if (rawUser) {
    try {
      const parsed = JSON.parse(rawUser) as Record<string, unknown>;
      const id = typeof parsed.id === "string" ? parsed.id : "";
      if (id) {
        user = {
          id,
          ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
          ...(typeof parsed.email === "string" ? { email: parsed.email } : {}),
          ...(typeof parsed.avatarUrl === "string" ? { avatarUrl: parsed.avatarUrl } : {}),
        };
      }
    } catch {
      user = null;
    }
  }
  return { accessToken: accessToken?.trim() || null, user };
}

function createDeviceClient(
  options: NibiLoginOptions,
  env: Record<string, string | undefined>,
  authOrigin: string,
): NibiDeviceLoginClient {
  return createNibiDeviceLoginClient({
    authOrigin,
    clientId: options.clientId ?? NIBI_TUI_OIDC_CLIENT_ID,
    env,
    httpClient: options.httpClient ?? createDefaultHttpClient(env),
  });
}

function createDefaultHttpClient(env: Record<string, string | undefined>): HttpClientPort {
  const config = createConfig({ env });
  return createNodeHttpClientAdapter({
    env,
    proxyUrl: config.config.network.httpProxy,
    noProxy: config.config.network.noProxy,
    caCertFile: config.config.network.caCertFile,
    timeoutMs: config.config.network.timeout,
  });
}

async function pollDeviceAuthorization(input: {
  authorization: NibiDeviceAuthorization;
  client: NibiDeviceLoginClient;
  now: () => number;
  signal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
}): Promise<NibiTokenSet> {
  let intervalMs = input.authorization.intervalMs;
  while (input.now() < input.authorization.expiresAt) {
    throwIfAborted(input.signal);
    const result = await input.client.poll(input.authorization.deviceCode, {
      signal: input.signal,
    });
    if (result.status === "ready") return result.tokenSet;
    if (result.status === "expired") {
      throw new NibiLoginError("auth_timeout", "设备码已过期，请重新执行 nibi login");
    }
    if (result.status === "denied") {
      throw new NibiLoginError("auth_denied", "授权被拒绝，请重新执行 nibi login");
    }
    if (result.status === "slow_down") intervalMs = result.intervalMs;
    const remainingMs = input.authorization.expiresAt - input.now();
    if (remainingMs <= 0) break;
    await input.sleep(Math.min(intervalMs, remainingMs));
  }
  throw new NibiLoginError("auth_timeout", "登录超时，请重新执行 nibi login");
}

async function persistNibiSession(
  store: SharedZCodeCredentialStore,
  tokenSet: NibiTokenSet,
  user: NibiUserProfile,
): Promise<void> {
  const entries: Record<string, string> = {
    [NIBI_ACCOUNT_CREDENTIAL_KEYS.accessToken]: tokenSet.accessToken,
    [NIBI_ACCOUNT_CREDENTIAL_KEYS.activeProvider]: NIBI_PROVIDER_ID,
    [NIBI_ACCOUNT_CREDENTIAL_KEYS.userInfo]: JSON.stringify({
      avatarUrl: user.avatarUrl,
      email: user.email,
      id: user.id,
      name: user.name,
      preferredUsername: user.preferredUsername,
      rawProfile: user.rawProfile,
    }),
    ...(tokenSet.refreshToken
      ? { [NIBI_ACCOUNT_CREDENTIAL_KEYS.refreshToken]: tokenSet.refreshToken }
      : {}),
  };
  await store.saveMany(entries);
  if (!tokenSet.refreshToken) {
    await store.delete(NIBI_ACCOUNT_CREDENTIAL_KEYS.refreshToken);
  }
}

interface LicenseSyncOutcome {
  membership: NibiAccountMembership | null;
  licenseExpiresAt?: string | null;
}

async function syncNibiLicense(input: {
  apiBaseUrl: string;
  accessToken: string;
  credentialStore: SharedZCodeCredentialStore;
  httpClient?: HttpClientPort;
  now: () => number;
  env: Record<string, string | undefined>;
  warnings: string[];
}): Promise<LicenseSyncOutcome> {
  const httpClient = input.httpClient ?? createDefaultHttpClient(input.env);
  const deviceId = await ensureDeviceId(input.credentialStore);
  let response: { status: number; body: Record<string, unknown> };
  try {
    const raw = await httpClient.request({
      body: new TextEncoder().encode(
        JSON.stringify({ deviceId, deviceName: "NIBI CLI", platform: process.platform }),
      ),
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      maxResponseBytes: 64 * 1024,
      method: "POST",
      timeoutMs: LICENSE_REQUEST_TIMEOUT_MS,
      url: `${input.apiBaseUrl}/licenses/check`,
    });
    response = { body: parseJsonObject(raw.body), status: raw.status };
  } catch (error) {
    input.warnings.push(
      `会员状态暂时无法同步（${error instanceof Error ? error.message : String(error)}）`,
    );
    return { membership: null };
  }

  const membership = readMembership(response.body.membership);
  const license = readRecord(response.body.license);
  const licenseToken = typeof license?.token === "string" ? license.token.trim() : "";
  const licenseExpiresAt =
    typeof license?.expiresAt === "string" && license.expiresAt.trim() ? license.expiresAt : null;

  if (response.status === 200 && response.body.authorized === true && licenseToken) {
    await input.credentialStore.save(NIBI_LICENSE_TOKEN_KEY, licenseToken);
    await input.credentialStore.save(
      NIBI_LICENSE_STATE_KEY,
      JSON.stringify({
        deviceId,
        expiresAt: licenseExpiresAt,
        lastCheckAt: new Date(input.now()).toISOString(),
        lastRefusal: null,
        plan: membership?.plan ?? null,
      }),
    );
    return { membership, licenseExpiresAt };
  }

  if (response.status === 200 && response.body.authorized === false) {
    const refusal = typeof response.body.reason === "string" ? response.body.reason : "no_membership";
    await input.credentialStore.save(
      NIBI_LICENSE_STATE_KEY,
      JSON.stringify({
        deviceId,
        expiresAt: membership?.expiresAt ?? null,
        lastCheckAt: new Date(input.now()).toISOString(),
        lastRefusal: refusal,
        plan: null,
      }),
    );
    return { membership: membership ?? { status: "none" } };
  }

  // 401/403 或 5xx：登录本身成功，会员状态留待下次同步；不写拒绝快照（不能把离线会员一棒打死）。
  input.warnings.push(
    response.status === 401 || response.status === 403
      ? "账号令牌未被业务服务接受，会员状态未同步（请确认账号中心与 API 项目配置一致）"
      : `会员状态同步失败（HTTP ${response.status}）`,
  );
  return { membership };
}

async function ensureDeviceId(store: SharedZCodeCredentialStore): Promise<string> {
  const existing = (await store.load(NIBI_ACCOUNT_DEVICE_ID_KEY))?.trim() ?? "";
  if (existing.length >= 8 && existing.length <= 128) return existing;
  const created = randomUUID();
  await store.save(NIBI_ACCOUNT_DEVICE_ID_KEY, created);
  return created;
}

function readMembership(value: unknown): NibiAccountMembership | null {
  const record = readRecord(value);
  if (!record) return null;
  const status = record.status;
  return {
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
    plan: typeof record.plan === "string" ? record.plan : null,
    status:
      status === "active" || status === "expired" || status === "none" ? status : "unknown",
  };
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return readRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toAccountUser(user: NibiUserProfile): NibiAccountUser {
  return {
    id: user.id,
    ...(user.name ? { name: user.name } : {}),
    ...(user.email ? { email: user.email } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

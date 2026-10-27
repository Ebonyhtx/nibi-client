/**
 * NIBI 账号登录的 Device Authorization Grant（RFC 8628）客户端。
 *
 * 为什么 CLI/TUI 用 device flow 而不是把 `nibi://` 深链硬塞给终端：终端不是深链目标，
 * 也没有可注册的 loopback 回调；device flow 只要求用户在同一台或另一台设备的浏览器里
 * 打开一个 URL 并输入短码，是自托管 Zitadel 里 nibi-tui 这个 native app 已注册的 grant。
 *
 * 网络层复用 HttpClientPort（与 CLI 其它请求同一套代理/CA/超时配置），不直接 fetch。
 */
import type { HttpClientPort, HttpClientRunOptions, TraceContext } from "@nibi/contracts";
import {
  NIBI_OIDC_SCOPE,
  NIBI_TUI_OIDC_CLIENT_ID,
  resolveNibiAuthOrigin,
} from "@nibi/shared";

const JSON_CONTENT_TYPE = "application/json";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface NibiDeviceLoginClientOptions {
  authOrigin?: string;
  clientId?: string;
  scope?: string;
  httpClient: HttpClientPort;
  env?: Record<string, string | undefined>;
  trace?: TraceContext;
  now?: () => number;
}

export interface NibiDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** 设备码失效时刻（毫秒时间戳） */
  expiresAt: number;
  /** 建议轮询间隔（毫秒） */
  intervalMs: number;
}

export interface NibiTokenSet {
  accessToken: string;
  tokenType?: string;
  scope?: string;
  idToken?: string;
  refreshToken?: string;
  /** access token 失效时刻（毫秒时间戳） */
  expiresAt?: number;
}

export type NibiDevicePollResult =
  | { status: "pending" }
  | { status: "slow_down"; intervalMs: number }
  | { status: "ready"; tokenSet: NibiTokenSet }
  | { status: "expired" }
  | { status: "denied" };

export interface NibiUserProfile {
  /** Zitadel 用户 id（sub） */
  id: string;
  name?: string;
  email?: string;
  preferredUsername?: string;
  avatarUrl?: string;
  rawProfile: Record<string, unknown>;
}

export interface NibiDeviceLoginClient {
  readonly authOrigin: string;
  readonly clientId: string;
  readonly scope: string;
  start(options?: HttpClientRunOptions): Promise<NibiDeviceAuthorization>;
  poll(deviceCode: string, options?: HttpClientRunOptions): Promise<NibiDevicePollResult>;
  refresh(refreshToken: string, options?: HttpClientRunOptions): Promise<NibiTokenSet>;
  fetchUserInfo(accessToken: string, options?: HttpClientRunOptions): Promise<NibiUserProfile>;
}

export class NibiDeviceLoginError extends Error {
  readonly oauthError?: string;
  readonly httpStatus?: number;

  constructor(message: string, details: { oauthError?: string; httpStatus?: number } = {}) {
    super(message);
    this.name = "NibiDeviceLoginError";
    this.oauthError = details.oauthError;
    this.httpStatus = details.httpStatus;
  }
}

export function createNibiDeviceLoginClient(
  options: NibiDeviceLoginClientOptions,
): NibiDeviceLoginClient {
  const authOrigin = (options.authOrigin ?? resolveNibiAuthOrigin(options.env ?? {})).replace(
    /\/+$/u,
    "",
  );
  const clientId = options.clientId ?? NIBI_TUI_OIDC_CLIENT_ID;
  const scope = options.scope ?? NIBI_OIDC_SCOPE;
  const now = options.now ?? Date.now;
  const deviceAuthorizationUrl = `${authOrigin}/oauth/v2/device_authorization`;
  const tokenUrl = `${authOrigin}/oauth/v2/token`;
  const userInfoUrl = `${authOrigin}/oidc/v1/userinfo`;

  return {
    authOrigin,
    clientId,
    scope,

    async start(runOptions) {
      const payload = await postForm(
        options,
        deviceAuthorizationUrl,
        { client_id: clientId, scope },
        runOptions,
      );
      const deviceCode = readString(payload.device_code);
      const userCode = readString(payload.user_code);
      const verificationUri = readString(payload.verification_uri);
      const expiresIn = readPositiveNumber(payload.expires_in);
      if (!deviceCode || !userCode || !verificationUri || !expiresIn) {
        throw new NibiDeviceLoginError("设备授权响应缺少必要字段，请稍后重试");
      }
      const intervalSeconds = readPositiveNumber(payload.interval) ?? DEFAULT_POLL_INTERVAL_MS / 1000;
      const verificationUriComplete = readString(payload.verification_uri_complete);
      return {
        deviceCode,
        userCode,
        verificationUri,
        ...(verificationUriComplete ? { verificationUriComplete } : {}),
        expiresAt: now() + expiresIn * 1000,
        intervalMs: Math.max(1_000, Math.round(intervalSeconds * 1000)),
      };
    },

    async poll(deviceCode, runOptions) {
      const response = await requestJson(
        options.httpClient,
        {
          body: encodeForm({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: DEVICE_GRANT_TYPE,
          }),
          headers: { "Content-Type": FORM_CONTENT_TYPE },
          method: "POST",
          ...(options.trace ? { trace: options.trace } : {}),
          url: tokenUrl,
        },
        runOptions,
      );
      if (response.status >= 200 && response.status < 300) {
        return { status: "ready", tokenSet: parseTokenSet(response.payload, now()) };
      }

      const oauthError = readString(response.payload.error) ?? `http_${response.status}`;
      if (oauthError === "authorization_pending") return { status: "pending" };
      if (oauthError === "slow_down") {
        const intervalSeconds = readPositiveNumber(response.payload.interval) ?? 5;
        return { intervalMs: Math.max(1_000, Math.round(intervalSeconds * 1000)), status: "slow_down" };
      }
      if (oauthError === "expired_token") return { status: "expired" };
      if (oauthError === "access_denied") return { status: "denied" };

      throw new NibiDeviceLoginError(
        readString(response.payload.error_description) ?? `登录失败（${oauthError}）`,
        { httpStatus: response.status, oauthError },
      );
    },

    async refresh(refreshToken, runOptions) {
      const payload = await postForm(
        options,
        tokenUrl,
        { client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken },
        runOptions,
      );
      return parseTokenSet(payload, now());
    },

    async fetchUserInfo(accessToken, runOptions) {
      const response = await requestJson(
        options.httpClient,
        {
          headers: { Accept: JSON_CONTENT_TYPE, Authorization: `Bearer ${accessToken}` },
          method: "GET",
          ...(options.trace ? { trace: options.trace } : {}),
          url: userInfoUrl,
        },
        runOptions,
      );
      if (response.status < 200 || response.status >= 300) {
        throw new NibiDeviceLoginError("读取账号资料失败，请重新登录", {
          httpStatus: response.status,
        });
      }
      return parseUserProfile(response.payload);
    },
  };
}

interface JsonResponse {
  status: number;
  payload: Record<string, unknown>;
}

async function postForm(
  options: NibiDeviceLoginClientOptions,
  url: string,
  fields: Record<string, string>,
  runOptions?: HttpClientRunOptions,
): Promise<Record<string, unknown>> {
  const response = await requestJson(
    options.httpClient,
    {
      body: encodeForm(fields),
      headers: { "Content-Type": FORM_CONTENT_TYPE },
      method: "POST",
      ...(options.trace ? { trace: options.trace } : {}),
      url,
    },
    runOptions,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new NibiDeviceLoginError(
      readString(response.payload.error_description) ?? `账号中心返回 HTTP ${response.status}`,
      {
        httpStatus: response.status,
        ...(readString(response.payload.error)
          ? { oauthError: readString(response.payload.error)! }
          : {}),
      },
    );
  }
  return response.payload;
}

async function requestJson(
  httpClient: HttpClientPort,
  request: Parameters<HttpClientPort["request"]>[0],
  runOptions?: HttpClientRunOptions,
): Promise<JsonResponse> {
  const response = await httpClient.request({ maxResponseBytes: 64 * 1024, ...request }, runOptions);
  const text = new TextDecoder().decode(response.body);
  let parsed: unknown = {};
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return {
    payload: isRecord(parsed) ? parsed : {},
    status: response.status,
  };
}

function parseTokenSet(payload: Record<string, unknown>, now: number): NibiTokenSet {
  const accessToken = readString(payload.access_token);
  if (!accessToken) {
    throw new NibiDeviceLoginError("令牌响应缺少 access_token");
  }
  const refreshToken = readString(payload.refresh_token);
  const idToken = readString(payload.id_token);
  const tokenType = readString(payload.token_type);
  const scope = readString(payload.scope);
  const expiresIn = readPositiveNumber(payload.expires_in);
  return {
    accessToken,
    ...(tokenType ? { tokenType } : {}),
    ...(scope ? { scope } : {}),
    ...(idToken ? { idToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn ? { expiresAt: now + expiresIn * 1000 } : {}),
  };
}

function parseUserProfile(payload: Record<string, unknown>): NibiUserProfile {
  const id = readString(payload.sub);
  if (!id) {
    throw new NibiDeviceLoginError("账号资料缺少 sub");
  }
  const name = readString(payload.name);
  const email = readString(payload.email);
  const preferredUsername = readString(payload.preferred_username);
  const avatarUrl = readString(payload.picture);
  return {
    id,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(preferredUsername ? { preferredUsername } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    rawProfile: payload,
  };
}

function encodeForm(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

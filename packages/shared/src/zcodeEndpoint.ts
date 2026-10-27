import type { ZCodeEnv } from "./env.js";

// NIBI fork：默认端点指向我们自己的服务（配置两跳 / 更新清单等都在该 origin 下）。
// 上游原值 https://zcode.z.ai；env（NIBI_BASE_URL / NIBI_ENDPOINT_ORIGIN）仍可覆盖，便于本地调试。
export const DEFAULT_NIBI_ENDPOINT_ORIGIN = "https://api.nibistudio.top";
// 上游的默认端点。**保留它是为了识别"编译期注入的旧常量"**：构建期配置
// （scripts/build-time-config.mjs 的 private defaults / vitest 的 define）里可能仍写着上游域名，
// 而 rewriteZCodeEndpointUrl 只改写"认得的来源"——不认这个就会出现"要改写的 URL 命中不了"
// （遥测绕过我们的端点直发上游）。见该函数注释。
export const UPSTREAM_NIBI_ENDPOINT_ORIGIN = "https://zcode.z.ai";
// 上游新增（技术端点，非用户可见文案）：test 档端点。
export const TEST_NIBI_ENDPOINT_ORIGIN = "https://zcode.z.ai";
// NIBI 会员购买页（我们自己的官网）。客户端内嵌的是这一页，不是上游 Coding Plan 页。
export const DEFAULT_NIBI_WEB_ORIGIN = "https://nibistudio.top";
export const NIBI_WEB_ORIGIN_ALIASES: readonly string[] = ["https://www.nibistudio.top"];
// 本地开发：Astro dev 默认 4321；保留 3000 兼容旧的本地站点服务。
export const NIBI_MEMBERSHIP_LOCAL_WEBVIEW_ORIGINS: readonly string[] = [
  "http://localhost:4321",
  "http://localhost:3000",
];
export const DEFAULT_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const TEST_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const DEFAULT_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const TEST_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const DEFAULT_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
export const TEST_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
export const DEFAULT_ZAI_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const TEST_ZAI_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL = "wss://api.nibistudio.top/api/v1/remote/ws2";
export const WEB_REMOTE_CONTROL_V4_MIN_APP_VERSION = "3.4.0";

export interface BuildZCodeEndpointUrlsOptions {
  appVersion?: string;
}

function isWebRemoteControlV4AppVersion(appVersion: string | undefined): boolean {
  if (!appVersion) {
    return false;
  }

  // zcodeEndpoint 会被 Vite 配置在 Node 加载期直接导入，不能依赖源码态 `.js` runtime import。
  // 这里只比较固定的稳定版门槛；高于 3.4.0 的预发布版本仍满足门槛，3.4.0 自身的预发布版本不满足。
  const normalizedVersion = appVersion.trim().replace(/^v/i, "");
  const match = normalizedVersion.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([^+]+))?(?:\+(.+))?$/,
  );
  if (!match) {
    return false;
  }

  const prereleaseIdentifiers = match[4]?.split(".");
  const hasValidPrerelease =
    prereleaseIdentifiers === undefined ||
    prereleaseIdentifiers.every(
      (identifier) =>
        /^[0-9A-Za-z-]+$/.test(identifier) &&
        (!/^\d+$/.test(identifier) || /^(0|[1-9]\d*)$/.test(identifier)),
    );
  const buildIdentifiers = match[5]?.split(".");
  const hasValidBuild =
    buildIdentifiers === undefined ||
    buildIdentifiers.every((identifier) => /^[0-9A-Za-z-]+$/.test(identifier));
  if (!hasValidPrerelease || !hasValidBuild) {
    return false;
  }

  const versionParts = [Number(match[1]), Number(match[2]), Number(match[3])];
  const floorParts = WEB_REMOTE_CONTROL_V4_MIN_APP_VERSION.split(".").map(Number);
  for (let index = 0; index < floorParts.length; index += 1) {
    if (versionParts[index]! !== floorParts[index]!) {
      return versionParts[index]! > floorParts[index]!;
    }
  }

  return prereleaseIdentifiers === undefined;
}

export interface ZCodeEndpointUrls {
  origin: string;
  apiBaseUrl: string;
  remoteUrl: string;
  webRemoteCallbackUrl: string;
  webShareCallbackUrl: string;
  relayWsUrl: string;
}

export interface RuntimeZCodeEndpointEnv {
  [key: string]: string | undefined;
  NIBI_ENV?: string;
  NIBI_BASE_URL?: string;
  NIBI_ENDPOINT_ORIGIN?: string;
  NIBI_TEST_BASE_URL?: string;
  NIBI_PRODUCTION_BASE_URL?: string;
}

export interface RuntimeBigModelApiEnv {
  [key: string]: string | undefined;
  NIBI_ENV?: string;
  BIGMODEL_API_BASE_URL?: string;
  BIGMODEL_TEST_API_BASE_URL?: string;
  BIGMODEL_PRODUCTION_API_BASE_URL?: string;
}

export interface RuntimeZaiEndpointEnv {
  [key: string]: string | undefined;
  NIBI_ENV?: string;
  ZAI_OAUTH_ORIGIN?: string;
  ZAI_TEST_OAUTH_ORIGIN?: string;
  ZAI_PRODUCTION_OAUTH_ORIGIN?: string;
  ZAI_BUSINESS_BASE_URL?: string;
  ZAI_TEST_BUSINESS_BASE_URL?: string;
  ZAI_PRODUCTION_BUSINESS_BASE_URL?: string;
  ZAI_OAUTH_CLIENT_ID?: string;
  ZAI_TEST_OAUTH_CLIENT_ID?: string;
  ZAI_PRODUCTION_OAUTH_CLIENT_ID?: string;
  ZAI_OAUTH_APP_ID?: string;
}

export interface RuntimeProductEndpointEnv
  extends RuntimeZCodeEndpointEnv, RuntimeBigModelApiEnv, RuntimeZaiEndpointEnv {}

export interface RuntimeProductEndpointConfig {
  zcodeEnv: ZCodeEnv;
  zcodeEndpointOrigin: string;
  zcodeEndpointUrls: ZCodeEndpointUrls;
  zaiOAuthOrigin: string;
  zaiBusinessBaseUrl: string;
  zaiOAuthClientId: string;
  bigModelApiOrigin: string;
}

function readRuntimeEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readRuntimeZCodeEnvScopedValue(
  env: Record<string, string | undefined>,
  zcodeEnv: ZCodeEnv,
  testKey: string,
  productionKey: string,
): string | undefined {
  return readRuntimeEnvValue(env, zcodeEnv === "production" ? productionKey : testKey);
}

export function normalizeZCodeEndpointOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("NIBI endpoint origin is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("NIBI endpoint origin must use http or https");
  }
  return parsed.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isTrustedNibiWebviewOrigin(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const origin = normalizeZCodeEndpointOrigin(value);
    if (
      origin === DEFAULT_NIBI_WEB_ORIGIN ||
      NIBI_WEB_ORIGIN_ALIASES.includes(origin) ||
      NIBI_MEMBERSHIP_LOCAL_WEBVIEW_ORIGINS.includes(origin)
    ) {
      return true;
    }
    const parsed = new URL(origin);
    return options?.e2eStoreBridgeEnabled === true && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 会员购买页只接受官网的 `/membership` 及其子路径（支付回跳在未来接）。
 * 不能按“域名信任”注入桥：同一域名下的其它页面不应继承 App 通信能力。
 */
export function isTrustedNibiMembershipWebviewUrl(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!isTrustedNibiWebviewOrigin(url.origin, options)) return false;
    return url.pathname === "/membership" || url.pathname.startsWith("/membership/");
  } catch {
    return false;
  }
}

export function resolveZCodeEndpointOrigin(options?: {
  env?: ZCodeEnv;
  envBaseOrigin?: string | null;
  overrideOrigin?: string | null;
}): string {
  const env = options?.env ?? "test";
  const envBaseOrigin = options?.envBaseOrigin?.trim();
  if (env === "production") {
    return envBaseOrigin
      ? normalizeZCodeEndpointOrigin(envBaseOrigin)
      : DEFAULT_NIBI_ENDPOINT_ORIGIN;
  }

  const overrideOrigin = options?.overrideOrigin?.trim();
  if (overrideOrigin) {
    return normalizeZCodeEndpointOrigin(overrideOrigin);
  }

  return envBaseOrigin ? normalizeZCodeEndpointOrigin(envBaseOrigin) : TEST_NIBI_ENDPOINT_ORIGIN;
}

export function resolveRuntimeZCodeEnv(env: RuntimeZCodeEndpointEnv = {}): ZCodeEnv {
  // 独立 CLI / 服务测试未注入 NIBI_ENV 时默认生产域；桌面测试包会显式下发 NIBI_ENV=test。
  return env.NIBI_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
}

export function resolveRuntimeZCodeEndpointOrigin(
  env: RuntimeZCodeEndpointEnv = {},
  options?: { overrideOrigin?: string | null },
): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedBaseOrigin =
    zcodeEnv === "production"
      ? readRuntimeEnvValue(env, "NIBI_PRODUCTION_BASE_URL")
      : readRuntimeEnvValue(env, "NIBI_TEST_BASE_URL");

  return resolveZCodeEndpointOrigin({
    env: zcodeEnv,
    envBaseOrigin:
      readRuntimeEnvValue(env, "NIBI_BASE_URL") ??
      readRuntimeEnvValue(env, "NIBI_ENDPOINT_ORIGIN") ??
      scopedBaseOrigin,
    overrideOrigin: options?.overrideOrigin,
  });
}

export function buildRuntimeZCodeEndpointUrls(
  env: RuntimeZCodeEndpointEnv = {},
): ZCodeEndpointUrls {
  return buildZCodeEndpointUrls(resolveRuntimeZCodeEndpointOrigin(env));
}

export function buildRuntimeZCodeApiUrl(env: RuntimeZCodeEndpointEnv = {}, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveRuntimeZCodeEndpointOrigin(env)}${normalizedPath}`;
}

export function resolveWebRemoteControlRelayWsUrl(options?: {
  endpointOrigin?: string | null | undefined;
  overrideUrl?: string | null | undefined;
}): string {
  const overrideUrl = options?.overrideUrl?.trim();
  if (overrideUrl) {
    return overrideUrl;
  }

  const origin = new URL(
    normalizeZCodeEndpointOrigin(options?.endpointOrigin?.trim() || DEFAULT_NIBI_ENDPOINT_ORIGIN),
  );
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = "/api/v1/remote/ws2";
  return origin.toString();
}

export function resolveBigModelApiOrigin(env: RuntimeBigModelApiEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedBaseOrigin =
    zcodeEnv === "production"
      ? readRuntimeEnvValue(env, "BIGMODEL_PRODUCTION_API_BASE_URL")
      : readRuntimeEnvValue(env, "BIGMODEL_TEST_API_BASE_URL");
  const fallbackOrigin =
    zcodeEnv === "production" ? DEFAULT_BIGMODEL_API_ORIGIN : TEST_BIGMODEL_API_ORIGIN;

  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "BIGMODEL_API_BASE_URL") ?? scopedBaseOrigin ?? fallbackOrigin,
  );
}

export function buildBigModelApiUrl(env: RuntimeBigModelApiEnv = {}, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveBigModelApiOrigin(env)}${normalizedPath}`;
}

export function resolveZaiOAuthOrigin(env: RuntimeZaiEndpointEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedOrigin = readRuntimeZCodeEnvScopedValue(
    env,
    zcodeEnv,
    "ZAI_TEST_OAUTH_ORIGIN",
    "ZAI_PRODUCTION_OAUTH_ORIGIN",
  );
  const fallbackOrigin =
    zcodeEnv === "production" ? DEFAULT_ZAI_OAUTH_ORIGIN : TEST_ZAI_OAUTH_ORIGIN;

  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_OAUTH_ORIGIN") ?? scopedOrigin ?? fallbackOrigin,
  );
}

export function resolveZaiBusinessBaseUrl(env: RuntimeZaiEndpointEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedOrigin = readRuntimeZCodeEnvScopedValue(
    env,
    zcodeEnv,
    "ZAI_TEST_BUSINESS_BASE_URL",
    "ZAI_PRODUCTION_BUSINESS_BASE_URL",
  );
  const fallbackOrigin =
    zcodeEnv === "production" ? DEFAULT_ZAI_BUSINESS_BASE_URL : TEST_ZAI_BUSINESS_BASE_URL;

  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_BUSINESS_BASE_URL") ?? scopedOrigin ?? fallbackOrigin,
  );
}

export function resolveZaiOAuthClientId(env: RuntimeZaiEndpointEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedClientId = readRuntimeZCodeEnvScopedValue(
    env,
    zcodeEnv,
    "ZAI_TEST_OAUTH_CLIENT_ID",
    "ZAI_PRODUCTION_OAUTH_CLIENT_ID",
  );
  const fallbackClientId =
    zcodeEnv === "production" ? DEFAULT_ZAI_OAUTH_CLIENT_ID : TEST_ZAI_OAUTH_CLIENT_ID;

  return (
    readRuntimeEnvValue(env, "ZAI_OAUTH_CLIENT_ID") ??
    scopedClientId ??
    readRuntimeEnvValue(env, "ZAI_OAUTH_APP_ID") ??
    fallbackClientId
  );
}

export function buildZaiOAuthUrl(origin: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeZCodeEndpointOrigin(origin)}${normalizedPath}`;
}

export function buildRuntimeZaiOAuthUrl(env: RuntimeZaiEndpointEnv = {}, path: string): string {
  return buildZaiOAuthUrl(resolveZaiOAuthOrigin(env), path);
}

export function buildRuntimeZaiBusinessUrl(env: RuntimeZaiEndpointEnv = {}, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveZaiBusinessBaseUrl(env)}${normalizedPath}`;
}

export function resolveRuntimeProductEndpointConfig(
  env: RuntimeProductEndpointEnv = {},
): RuntimeProductEndpointConfig {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);

  return {
    zcodeEnv,
    zcodeEndpointOrigin,
    zcodeEndpointUrls: buildZCodeEndpointUrls(zcodeEndpointOrigin),
    zaiOAuthOrigin: resolveZaiOAuthOrigin(env),
    zaiBusinessBaseUrl: resolveZaiBusinessBaseUrl(env),
    zaiOAuthClientId: resolveZaiOAuthClientId(env),
    bigModelApiOrigin: resolveBigModelApiOrigin(env),
  };
}

export function buildZCodeEndpointUrls(
  origin: string,
  options: BuildZCodeEndpointUrlsOptions = {},
): ZCodeEndpointUrls {
  const normalizedOrigin = normalizeZCodeEndpointOrigin(origin);
  const parsed = new URL(normalizedOrigin);
  const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const wsOrigin = `${wsProtocol}//${parsed.host}`;
  // 无法解析或低于分界版本时保守使用 v3，避免开发版本和旧客户端进入未兼容的 v4 页面。
  const remoteVersion = isWebRemoteControlV4AppVersion(options.appVersion) ? "v4" : "v3";

  return {
    origin: normalizedOrigin,
    apiBaseUrl: `${normalizedOrigin}/api/v1`,
    remoteUrl: `${normalizedOrigin}/remote/${remoteVersion}`,
    webRemoteCallbackUrl: `${normalizedOrigin}/remote/v4`,
    webShareCallbackUrl: `${normalizedOrigin}/cn/share/callback`,
    relayWsUrl: `${wsOrigin}/api/v1/remote/ws2`,
  };
}

export function rewriteZCodeEndpointUrl(input: string | URL, endpointOrigin: string): string | URL {
  const originalUrl = typeof input === "string" ? input : input.toString();
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return input;
  }
  // 认这两个 origin 作为"可改写的来源"（2026-10-13）：
  //   ① 我们自己的（DEFAULT_NIBI_ENDPOINT_ORIGIN，fork 后 = api.nibistudio.top）
  //   ② 上游的（UPSTREAM_NIBI_ENDPOINT_ORIGIN = zcode.z.ai）
  // 为什么要认上游那个：**编译期注入的常量仍可能指向上游域名**——
  // 例如遥测上报地址来自构建期 `__NIBI_TELEMETRY_REPORT_ENDPOINT__`
  // （`scripts/build-time-config.mjs` 的 private defaults），vitest 里就是
  // `https://zcode.z.ai/api/v1/event/report`。只认 ① 时这类 URL 命中不了改写、
  // 于是"把请求指向我们端点"静默失效（真机后果：遥测绕过我们的端点直发上游；
  // 测试里的表现是本地接收器一个请求都收不到）。
  const sourceOrigins = [DEFAULT_NIBI_ENDPOINT_ORIGIN, UPSTREAM_NIBI_ENDPOINT_ORIGIN];
  if (!sourceOrigins.includes(parsed.origin)) {
    return input;
  }

  const targetOrigin = normalizeZCodeEndpointOrigin(endpointOrigin);
  // 目标与当前 origin 相同就不必改写（避免把 URL 规范化成另一种等价写法）。
  if (targetOrigin === parsed.origin) {
    return input;
  }

  const target = new URL(targetOrigin);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.toString();
}

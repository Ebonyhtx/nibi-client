import { rootCertificates } from "node:tls";
import { readFileSync } from "node:fs";
import {
  NIBI_AGENT_CA_CERT_ENV_KEY,
  NIBI_HTTP_PROXY_ENV_KEY,
  NIBI_NO_PROXY_ENV_KEY,
  NIBI_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  readZCodeToolEnvPassthroughEnv,
} from "@nibi/shared";
import { isImplicitDirectUrl } from "@nibi/shared/node";

interface NetworkProxyOptions {
  env?: Record<string, string | undefined>;
  httpProxy?: string;
  noProxy?: string;
}

interface NetworkTlsOptions {
  caCertFile?: string;
  /** 内联 PEM CA（如国内镜像自签 CA）。与系统根证书**合并**，永不替换。 */
  caCertPem?: string;
  env?: Record<string, string | undefined>;
}

interface NetworkProxyResolution {
  noProxyMatched: boolean;
  proxySource?: string;
  proxyUrl?: string;
}

const CAPTURED_USER_PROXY_KEYS = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "all_proxy",
  "ALL_PROXY",
] as const;

export function resolveProxyUrlForRequest(
  requestUrl: string | URL,
  options: NetworkProxyOptions,
): string | undefined {
  return resolveProxyForRequest(requestUrl, options).proxyUrl;
}

export function resolveWebFetchProxyForRequest(
  requestUrl: string | URL,
  options: NetworkProxyOptions,
): NetworkProxyResolution {
  return resolveProxyForRequestInternal(requestUrl, options, true);
}

export function resolveProxyForRequest(
  requestUrl: string | URL,
  options: NetworkProxyOptions,
): NetworkProxyResolution {
  return resolveProxyForRequestInternal(requestUrl, options, false);
}

function resolveProxyForRequestInternal(
  requestUrl: string | URL,
  options: NetworkProxyOptions,
  useCapturedUserProxyFallback: boolean,
): NetworkProxyResolution {
  const url = typeof requestUrl === "string" ? safeUrl(requestUrl) : requestUrl;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { noProxyMatched: false };
  }

  // 产品级隐式直连：本机回环（本地网关/面板/MCP）与国内镜像永不进代理。
  // 与 shared/node/egressProxy、host API 共用同一份判据，避免各出口再次分叉。
  if (isImplicitDirectUrl(url)) {
    return { noProxyMatched: true };
  }

  if (shouldBypassProxy(url, readExplicitNoProxyValue(options))) {
    return { noProxyMatched: true };
  }

  const explicitProxy = normalizeProxyUrl(options.httpProxy);
  if (explicitProxy) {
    return {
      noProxyMatched: false,
      proxySource: "network.httpProxy",
      proxyUrl: explicitProxy,
    };
  }

  const env = options.env ?? {};
  const candidates = [[`env:${NIBI_HTTP_PROXY_ENV_KEY}`, env[NIBI_HTTP_PROXY_ENV_KEY]]];

  for (const [source, candidate] of candidates) {
    const proxyUrl = normalizeProxyUrl(candidate);
    if (proxyUrl) {
      return {
        noProxyMatched: false,
        proxySource: source,
        proxyUrl,
      };
    }
  }

  if (!useCapturedUserProxyFallback) {
    return { noProxyMatched: false };
  }

  const capturedNoProxy = readCapturedUserNoProxy(env);
  if (shouldBypassProxy(url, capturedNoProxy)) {
    return { noProxyMatched: true };
  }

  const capturedProxy = readCapturedUserProxy(env);
  if (capturedProxy) {
    return {
      noProxyMatched: false,
      proxySource: `env:${NIBI_TOOL_ENV_PASSTHROUGH_ENV_KEY}.${capturedProxy.key}`,
      proxyUrl: capturedProxy.proxyUrl,
    };
  }
  return { noProxyMatched: false };
}

export function resolveTlsCaCertFile(options: NetworkTlsOptions): string | undefined {
  const candidates = [
    options.caCertFile,
    options.env?.[NIBI_AGENT_CA_CERT_ENV_KEY],
  ];

  for (const candidate of candidates) {
    const normalized = normalizePathLike(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

export function loadTlsCaCertificates(options: NetworkTlsOptions): string[] | Buffer | undefined {
  const caCertFile = resolveTlsCaCertFile(options);
  if (!caCertFile) {
    return options.caCertPem?.trim() ? [...rootCertificates, options.caCertPem] : undefined;
  }
  const fileCa = readFileSync(caCertFile);
  // 自定义 CA 必须与系统根证书合并：Node 的 tls.ca 是"替换"语义，单给自签 CA 会让
  // 所有正常 HTTPS 站点失去信任链（企业代理那套已经踩过同一个坑，见 nodeApiNetwork）。
  return options.caCertPem?.trim()
    ? [...rootCertificates, options.caCertPem, fileCa.toString("utf8")]
    : fileCa;
}

function readExplicitNoProxyValue(options: NetworkProxyOptions): string | undefined {
  return (
    normalizePathLike(options.noProxy) ??
    normalizePathLike(options.env?.[NIBI_NO_PROXY_ENV_KEY])
  );
}

function readCapturedUserProxy(
  env: Record<string, string | undefined>,
): { key: string; proxyUrl: string } | undefined {
  const captured = readZCodeToolEnvPassthroughEnv(env);

  for (const key of CAPTURED_USER_PROXY_KEYS) {
    const proxyUrl = normalizeProxyUrl(captured[key]);
    if (proxyUrl) {
      return { key, proxyUrl };
    }
  }
  return undefined;
}

function readCapturedUserNoProxy(env: Record<string, string | undefined>): string | undefined {
  const captured = readZCodeToolEnvPassthroughEnv(env);
  return normalizePathLike(captured.no_proxy) ?? normalizePathLike(captured.NO_PROXY);
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(candidate).href;
  } catch {
    return undefined;
  }
}

function normalizePathLike(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function shouldBypassProxy(url: URL, noProxy: string | undefined): boolean {
  const host = normalizeNoProxyHost(url.hostname);
  if (!host || !noProxy) {
    return false;
  }

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rawToken of noProxy.split(",")) {
    const token = parseNoProxyToken(rawToken);
    if (!token) {
      continue;
    }
    if (token.host === "*") {
      return true;
    }
    if (token.port && token.port !== port) {
      continue;
    }
    if (matchesNoProxyHost(host, token.host)) {
      return true;
    }
  }
  return false;
}

function parseNoProxyToken(rawToken: string): { host: string; port?: string } | undefined {
  const trimmed = rawToken.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "*") {
    return { host: "*" };
  }

  if (trimmed.includes("://")) {
    const parsed = safeUrl(trimmed);
    if (!parsed) {
      return undefined;
    }
    return {
      host: normalizeNoProxyHost(parsed.hostname),
      port: parsed.port || undefined,
    };
  }

  const withoutBrackets = trimmed.startsWith("[") ? trimmed.slice(1, trimmed.indexOf("]")) : "";
  if (withoutBrackets) {
    return { host: normalizeNoProxyHost(withoutBrackets) };
  }

  const separatorIndex = trimmed.lastIndexOf(":");
  const hasPort = separatorIndex > 0 && trimmed.indexOf(":") === separatorIndex;
  if (!hasPort) {
    return { host: normalizeNoProxyHost(trimmed) };
  }

  return {
    host: normalizeNoProxyHost(trimmed.slice(0, separatorIndex)),
    port: trimmed.slice(separatorIndex + 1),
  };
}

function normalizeNoProxyHost(value: string): string {
  return value
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function matchesNoProxyHost(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  if (pattern.startsWith(".")) {
    const suffix = pattern.slice(1);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern || host.endsWith(`.${pattern}`);
}

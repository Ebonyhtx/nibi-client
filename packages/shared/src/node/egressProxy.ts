/**
 * 出口代理解析（纯规则，无 IO）。
 *
 * 为什么单独一份：中继（desktop main）、分享产物下载（services）等 **Node 侧**出口都不会
 * 自动读应用设置里的 `httpProxy`；Chromium 会话另有自己的代理配置。规则必须只有一份，
 * 否则「设置页配了代理、某个功能仍然直连」会反复出现（中继已踩过一次）。
 *
 * 语义：先按 `httpProxyMode` 选出生效代理（system / manual），再按 noProxy 与隐式直连规则
 * 决定是否绕过；地址非法时由具体出口决定 fail closed（Host API）或按未配置处理。
 */

import { getNibiMirrorOrigin } from "../nibiContentMirror.js";

/** 代理方式：system=跟随操作系统代理；manual=只用手填地址（留空即直连）。 */
export type HttpProxyMode = "system" | "manual";

export interface EgressProxySettings {
  httpProxy?: string | null;
  httpProxyNoProxy?: string | null;
  httpProxyMode?: HttpProxyMode | null;
}

/**
 * 生效的代理方式。
 *
 * 4.0 之前的设置只有 `httpProxy`：填了就是显式代理、留空就是跟随系统。为了让老配置
 * 升级后行为不变，缺少 `httpProxyMode` 时按“填了地址=manual、没填=system”判定；
 * 用户一旦在设置页切换过，就始终以显式值为准。
 */
export function resolveHttpProxyMode(
  settings: Pick<EgressProxySettings, "httpProxy" | "httpProxyMode"> | null | undefined,
): HttpProxyMode {
  if (settings?.httpProxyMode === "system" || settings?.httpProxyMode === "manual") {
    return settings.httpProxyMode;
  }
  return settings?.httpProxy?.trim() ? "manual" : "system";
}

/**
 * 按模式选出生效代理：system 用探测到的系统代理（可能为 null），manual 只用手填地址。
 * 返回值已归一化；null = 直连。
 */
export function chooseEgressProxyUrl(
  settings: Pick<EgressProxySettings, "httpProxy" | "httpProxyMode"> | null | undefined,
  systemProxyUrl: string | null | undefined,
): string | null {
  return resolveHttpProxyMode(settings) === "manual"
    ? normalizeEgressProxyUrl(settings?.httpProxy)
    : normalizeEgressProxyUrl(systemProxyUrl);
}

/**
 * 把系统代理按模式折算进 settings，供只看 `httpProxy` 的既有出口使用。
 * manual + 空地址 → httpProxy 为 undefined（直连），**不会**偷偷回落到系统代理。
 *
 * 这里保留用户填写的原始值（只 trim，不做合法性归一化）：出口自己需要区分
 * “没配置=直连”和“配置了但地址非法=失败并报错”，不能把非法值悄悄吞成直连。
 */
export function withEffectiveEgressProxy<T extends EgressProxySettings>(
  settings: T | null | undefined,
  systemProxyUrl: string | null | undefined,
): T & { httpProxy?: string } {
  const selected =
    resolveHttpProxyMode(settings) === "manual"
      ? settings?.httpProxy?.trim()
      : systemProxyUrl?.trim();
  return {
    ...(settings ?? ({} as T)),
    httpProxy: selected || undefined,
  };
}

/** 只接受 http/https 代理；其余（socks、空串、坏 URL）按未配置处理。 */
export function normalizeEgressProxyUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function targetParts(target: URL): { host: string; port: string } {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isSecure = target.protocol === "https:" || target.protocol === "wss:";
  return { host, port: target.port || (isSecure ? "443" : "80") };
}

/**
 * noProxy 规则（逗号分隔）：`*`、`example.com`、`.example.com`、`example.com:8443`、IP。
 * 域名规则同时匹配自身与子域；带端口时端口必须一致。空规则 = 不绕过。
 */
export function matchesNoProxyRule(
  target: URL,
  noProxy: string | null | undefined,
): boolean {
  const rules = (noProxy ?? "")
    .split(",")
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
  if (rules.length === 0) return false;
  const { host, port } = targetParts(target);
  for (const rule of rules) {
    if (rule === "*") return true;
    const lastColon = rule.lastIndexOf(":");
    const portSuffix = lastColon >= 0 ? rule.slice(lastColon + 1) : "";
    const hasPort = /^\d+$/.test(portSuffix);
    const ruleHost = (hasPort ? rule.slice(0, lastColon) : rule).replace(/^\./, "");
    if (!ruleHost) continue;
    if (hasPort && portSuffix !== port) continue;
    if (host === ruleHost || host.endsWith(`.${ruleHost}`)) return true;
  }
  return false;
}

function isLoopbackOrLocalHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  if (/^127(?:\.\d{1,3}){3}$/u.test(normalized)) return true;
  if (normalized === "[::1]") return true;
  return false;
}

/**
 * 隐式直连主机：本机回环与国内镜像。
 *
 * 这两类地址**永远不能**走用户代理：
 * - 回环是本地网关/面板/MCP 服务，发到代理会直接失败（实测 127.0.0.1:8890 经代理不可达）；
 * - 国内镜像是 PLAN B，本身就是为了「没有代理/代理出不去」的用户准备的，经境外代理反而绕远。
 * 这是产品规则，不该让用户靠「不使用代理的地址」手工维护。
 */
export function isImplicitDirectUrl(target: string | URL): boolean {
  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : target;
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
    return false;
  }
  if (isLoopbackOrLocalHost(url.hostname)) return true;
  const mirrorOrigin = getNibiMirrorOrigin();
  if (!mirrorOrigin) return false;
  try {
    return url.origin === new URL(mirrorOrigin).origin;
  } catch {
    return false;
  }
}

/** 把隐式直连规则并入用户 noProxy（用于注入子进程 env / Electron bypass）。 */
export function mergeImplicitNoProxy(noProxy: string | null | undefined): string {
  const mirrorHost = (() => {
    const origin = getNibiMirrorOrigin();
    if (!origin) return "";
    try {
      return new URL(origin).hostname;
    } catch {
      return "";
    }
  })();
  const defaults = ["localhost", "127.0.0.1", "::1", mirrorHost].filter(Boolean);
  const user = (noProxy ?? "")
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  return [...new Set([...defaults, ...user])].join(",");
}

/** 返回该 URL 应使用的代理地址；null = 直连（未配置、被 noProxy 命中或代理地址非法）。 */
export function resolveEgressProxyForUrl(
  target: string | URL,
  settings: EgressProxySettings | null | undefined,
): string | null {
  // 隐式直连优先于显式代理：本机与国内镜像永不进代理。
  if (isImplicitDirectUrl(target)) return null;
  const proxyUrl = normalizeEgressProxyUrl(settings?.httpProxy);
  if (!proxyUrl) return null;
  let parsed: URL;
  try {
    parsed = typeof target === "string" ? new URL(target) : target;
  } catch {
    return null;
  }
  if (matchesNoProxyRule(parsed, settings?.httpProxyNoProxy)) return null;
  return proxyUrl;
}

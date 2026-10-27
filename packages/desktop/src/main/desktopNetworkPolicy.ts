import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProxyConfig, Session } from "electron";
import { NIBI_MEMBERSHIP_WEBVIEW_PARTITION, getNibiMirrorOrigin } from "@nibi/shared";
import {
  NIBI_MIRROR_CA_PEM,
  detectSystemProxy,
  mergeImplicitNoProxy,
  type SystemProxyDetection,
} from "@nibi/shared/node";
import { EMBEDDED_BROWSER_PARTITION } from "./browserDataManager.js";

interface DesktopNetworkPolicySettings {
  httpProxy?: string;
  httpProxyMode?: "system" | "manual";
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
  embeddedBrowserAllowInsecureCertificates?: boolean;
}

/**
 * 设置页代理留空时的兜底模式。
 *
 * `direct` 是 Electron 的「永不使用代理」，会连本机系统代理一起屏蔽；
 * `system` 读取的是 OS 网络设置（macOS 网络偏好 / Windows Internet 选项），
 * 与 shell 里的 `HTTP_PROXY` 等环境变量无关，因此不违反「不继承 shell 环境变量」的边界。
 */
type ProxyFallbackMode = "direct" | "system";

interface DesktopSessionNetworkPolicyOptions {
  /** 是否放行该 Session 的全部证书错误。仅内置浏览器出口可以打开。 */
  allowInsecureCertificates?: boolean;
  /** 设置页代理留空、系统也没有代理时使用的兜底模式，默认 `direct`。 */
  fallbackProxyMode?: ProxyFallbackMode;
  /** 系统代理探测覆盖（测试注入；缺省时读操作系统设置）。 */
  systemProxy?: SystemProxyDetection | null;
}

interface DesktopNetworkPolicyLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface DesktopSessionProvider {
  readonly defaultSession: Session;
  fromPartition(partition: string): Session;
}

type CertificateVerifyProc = NonNullable<Parameters<Session["setCertificateVerifyProc"]>[0]>;

interface CertificateLike {
  data?: string;
  fingerprint?: string;
  issuerCert?: CertificateLike | null;
}

const USE_CHROMIUM_DEFAULT_VERIFICATION = -3;
const ACCEPT_CERTIFICATE = 0;
const MAX_CERTIFICATE_CHAIN_DEPTH = 16;

export async function applyDesktopChromiumNetworkPolicies(
  sessionProvider: DesktopSessionProvider,
  settings: DesktopNetworkPolicySettings,
  logger: DesktopNetworkPolicyLogger,
  options: { systemProxy?: SystemProxyDetection | null } = {},
): Promise<void> {
  const targets = [
    {
      name: "default-session",
      session: sessionProvider.defaultSession,
      allowInsecure: false,
      // ZCode 自身对后端与模型 API 的出口：设置页留空时跟随系统代理（用户通常只开
      // Clash/v2ray 的系统代理，不会填端口）；系统也没有代理才直连。
      fallbackProxyMode: "direct" as const,
    },
    {
      name: "embedded-browser",
      session: sessionProvider.fromPartition(EMBEDDED_BROWSER_PARTITION),
      // 自签名放行只开在内置浏览器出口：defaultSession 承载 renderer 对 ZCode 后端与模型 API
      // 的流量，在那里放行等于整个应用失去 TLS 保护，与「访问内网测试站点」的诉求不成比例。
      allowInsecure: settings.embeddedBrowserAllowInsecureCertificates === true,
      // 内置浏览器是用户自己的浏览出口，留空时跟随系统代理，与本机浏览器保持一致；
      // 否则需要代理才能访问的站点只会拿到 ERR_CONNECTION_TIMED_OUT，用户无从下手。
      fallbackProxyMode: "system" as const,
    },
    {
      name: "nibi-membership",
      // 会员购买页是外部站点，必须遵循用户的代理设置；但支付页绝不放行自签名证书。
      session: sessionProvider.fromPartition(NIBI_MEMBERSHIP_WEBVIEW_PARTITION),
      allowInsecure: false,
      fallbackProxyMode: "system" as const,
    },
  ] as const;

  await Promise.all(
    targets.map(async (target) => {
      try {
        await applyDesktopSessionNetworkPolicy(target.session, settings, logger, {
          allowInsecureCertificates: target.allowInsecure,
          fallbackProxyMode: target.fallbackProxyMode,
          ...(options.systemProxy !== undefined ? { systemProxy: options.systemProxy } : {}),
        });
      } catch (error) {
        // 内置 Browser 使用独立 partition，过去只配置 defaultSession；同时
        // 单一 Session 的启动失败不能阻断另一个出口，否则 renderer 与 Browser 会再次漂移。
        logger.warn(`[desktop-network] ${target.name} network policy apply failed:`, error);
      }
    }),
  );
}

export async function applyDesktopSessionNetworkPolicy(
  targetSession: Session,
  settings: DesktopNetworkPolicySettings,
  logger: DesktopNetworkPolicyLogger,
  options: DesktopSessionNetworkPolicyOptions = {},
): Promise<void> {
  const systemProxy =
    options.systemProxy !== undefined ? options.systemProxy : detectSystemProxy();
  const proxyConfig = buildElectronProxyConfig(
    settings.httpProxy,
    settings.httpProxyNoProxy,
    options.fallbackProxyMode,
    systemProxy,
    settings.httpProxyMode,
  );
  await targetSession.setProxy(proxyConfig);
  await targetSession.closeAllConnections();

  // 全放行比自定义 CA 更宽松，两者同时配置时按前者生效，避免出现「开了开关仍被拒」的困惑。
  // 默认 session 额外信任**国内镜像主机**的自签 CA（只放行该主机，且必须命中我们的 CA）：
  // 商店图标等 `<img>` 在主源被线路阻断时会回退到镜像，渲染进程不认这张自签证书就会整片降级。
  const userCaProc = createCustomCaCertificateVerifyProcFromFile(
    settings.httpProxyCaCertPath,
    logger,
  );
  const verifyProc = options.allowInsecureCertificates
    ? createInsecureCertificateVerifyProc()
    : createNibiMirrorCertificateVerifyProc(NIBI_MIRROR_CA_PEM, userCaProc);
  targetSession.setCertificateVerifyProc(verifyProc);

  const bypassState = proxyConfig.proxyBypassRules ? "enabled" : "disabled";
  const customCaState = verifyProc ? "enabled" : "disabled";
  logger.info(
    `[desktop-network] renderer proxy mode=${proxyConfig.mode ?? "fixed_servers"} bypass=${bypassState} customCa=${customCaState} insecureCerts=${options.allowInsecureCertificates ? "allowed" : "rejected"}`,
  );
}

/**
 * 在用户自定义 CA 之外，额外信任**国内镜像主机**的自签证书。
 *
 * 为什么不能沿用「CA 指纹在链里」的判定：镜像只发送叶子证书（实测 chain 长度 1），
 * Chromium 自己又建不出到我们 CA 的链，`issuerCert` 走不到 CA。这里改为**真正校验**：
 * 叶子证书必须由我们的 CA 签发（`checkIssued` + 公钥验签）、在有效期内、且 SAN 覆盖镜像主机。
 * 其它主机、其它错误一律交回用户 CA 校验或 Chromium 默认行为。
 */
export function createNibiMirrorCertificateVerifyProc(
  mirrorCaPem: string,
  fallbackProc: CertificateVerifyProc | null,
): CertificateVerifyProc | null {
  const mirrorCas = parseCertificates(mirrorCaPem);
  if (mirrorCas.length === 0 && !fallbackProc) return null;
  let mirrorHost = "";
  const mirrorOrigin = getNibiMirrorOrigin();
  if (mirrorOrigin) {
    try {
      mirrorHost = new URL(mirrorOrigin).hostname.toLowerCase();
    } catch {
      mirrorHost = "";
    }
  }
  return (request, callback) => {
    if (request.verificationResult === "OK") {
      callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
      return;
    }
    if (
      mirrorHost &&
      request.hostname?.toLowerCase() === mirrorHost &&
      leafMatchesMirrorCa(request.certificate, mirrorCas, mirrorHost)
    ) {
      callback(ACCEPT_CERTIFICATE);
      return;
    }
    if (fallbackProc) {
      fallbackProc(request, callback);
      return;
    }
    callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
  };
}

function parseCertificates(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const certificates: X509Certificate[] = [];
  for (const block of blocks) {
    try {
      certificates.push(new X509Certificate(block));
    } catch {
      // 坏证书块直接跳过：镜像信任失败只影响图标兜底，不能影响应用启动。
    }
  }
  return certificates;
}

function leafMatchesMirrorCa(
  certificate: CertificateLike | undefined,
  mirrorCas: readonly X509Certificate[],
  host: string,
): boolean {
  const pem = certificate?.data;
  if (typeof pem !== "string" || !pem.includes("BEGIN CERTIFICATE")) return false;
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(pem);
  } catch {
    return false;
  }
  const now = Date.now();
  const from = Date.parse(leaf.validFrom);
  const to = Date.parse(leaf.validTo);
  if (Number.isFinite(from) && from > now) return false;
  if (Number.isFinite(to) && to < now) return false;
  let hostMatches = false;
  try {
    hostMatches = Boolean(leaf.checkIP(host)) || Boolean(leaf.checkHost(host));
  } catch {
    hostMatches = false;
  }
  if (!hostMatches) return false;
  for (const ca of mirrorCas) {
    try {
      if (leaf.checkIssued(ca) && leaf.verify(ca.publicKey)) return true;
    } catch {
      // 继续试下一个 CA（轮换期可能同时带旧新两张）
    }
  }
  return false;
}

/**
 * 放行全部证书错误的校验过程。
 *
 * 仅供内置浏览器 partition 使用：自签名证书的内网测试站点在 Electron `<webview>` 里
 * 拿不到 Chrome 的安全插页，被拒后只剩一张空的 chrome-error 页，用户无从放行。
 */
export function createInsecureCertificateVerifyProc(): CertificateVerifyProc {
  return (_request, callback) => {
    callback(ACCEPT_CERTIFICATE);
  };
}

export function buildElectronProxyConfig(
  httpProxy: string | undefined,
  noProxy?: string | undefined,
  fallbackMode: ProxyFallbackMode = "direct",
  systemProxy: SystemProxyDetection | null = detectSystemProxy(),
  proxyMode?: "system" | "manual",
): ProxyConfig {
  // 代理方式由设置页显式决定：
  //   system  = 用操作系统代理；没有就按调用方兜底（default-session 直连，浏览器让 Chromium
  //             自己读系统设置）
  //   manual  = 只用手填地址；空即直连，**不再回落到系统代理**
  // 缺省按旧语义推断（填了地址=manual），保证升级用户的既有配置不被悄悄改道。
  const mode =
    proxyMode === "system" || proxyMode === "manual"
      ? proxyMode
      : httpProxy?.trim()
        ? "manual"
        : "system";
  // 系统代理若是 PAC，Chromium 自己能求值，交给 system 模式；若是固定地址，则转成
  // fixed_servers 以便附带我们的隐式直连规则（本机回环 + 国内镜像），这也是设置页不再
  // 要求用户手填 noProxy 的原因。
  // Chromium 的 fixed_servers 只吃 `http://host:port`（不能带尾部斜杠），
  // 系统探测返回的是 URL.href（带 /）；直接塞进去会让所有请求 ERR_NO_SUPPORTED_PROXIES。
  const proxyRules =
    mode === "manual"
      ? normalizeProxyRules(httpProxy)
      : normalizeProxyRules(systemProxy?.url ?? undefined);
  if (!proxyRules) {
    if (mode === "manual") return { mode: "direct" };
    return { mode: systemProxy?.source === "pac-unsupported" ? "system" : fallbackMode };
  }
  const proxyConfig: ProxyConfig = {
    mode: "fixed_servers",
    proxyRules,
  };
  const proxyBypassRules = normalizeProxyBypassRules(
    mergeImplicitNoProxy(noProxy),
  );
  if (proxyBypassRules) {
    proxyConfig.proxyBypassRules = proxyBypassRules;
  }
  return proxyConfig;
}

export function createCustomCaCertificateVerifyProcFromFile(
  caCertPath: string | undefined,
  logger: Pick<DesktopNetworkPolicyLogger, "warn">,
): CertificateVerifyProc | null {
  const trimmed = caCertPath?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const trustedFingerprints = readCustomCaFingerprintsFromPem(
      readFileSync(trimmed, "utf8"),
    );
    if (trustedFingerprints.size === 0) {
      logger.warn(`[desktop-network] custom CA file contains no certificates: ${trimmed}`);
      return null;
    }
    return createCustomCaCertificateVerifyProc(trustedFingerprints);
  } catch (error) {
    logger.warn(`[desktop-network] failed to load custom CA file: ${trimmed}`, error);
    return null;
  }
}

export function createCustomCaCertificateVerifyProc(
  trustedFingerprints: ReadonlySet<string>,
): CertificateVerifyProc | null {
  if (trustedFingerprints.size === 0) {
    return null;
  }

  return (request, callback) => {
    if (request.verificationResult === "OK") {
      callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
      return;
    }

    if (
      certificateChainMatchesCustomCa(request.certificate, trustedFingerprints) ||
      certificateChainMatchesCustomCa(request.validatedCertificate, trustedFingerprints)
    ) {
      // renderer 的 Chromium 网络栈不会读取 NODE_EXTRA_CA_CERTS。
      // 自定义 CA 只能从设置页显式路径进入这里，命中链路后才放行，避免把所有证书错误都绕过。
      callback(ACCEPT_CERTIFICATE);
      return;
    }

    callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
  };
}

export function readCustomCaFingerprintsFromPem(pem: string): Set<string> {
  const fingerprints = new Set<string>();
  const certBlocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];

  for (const block of certBlocks) {
    fingerprints.add(normalizeFingerprint(new X509Certificate(block).fingerprint256));
  }
  return fingerprints;
}

export function certificateChainMatchesCustomCa(
  certificate: CertificateLike,
  trustedFingerprints: ReadonlySet<string>,
): boolean {
  let current: CertificateLike | null | undefined = certificate;
  const seen = new Set<string>();

  for (let depth = 0; current && depth < MAX_CERTIFICATE_CHAIN_DEPTH; depth += 1) {
    const fingerprint = readCertificateFingerprint(current);
    if (fingerprint) {
      if (trustedFingerprints.has(fingerprint)) {
        return true;
      }
      if (seen.has(fingerprint)) {
        return false;
      }
      seen.add(fingerprint);
    }
    current = current.issuerCert;
  }
  return false;
}

function normalizeProxyRules(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    const auth = url.username
      ? `${url.username}${url.password ? `:${url.password}` : ""}@`
      : "";
    return `${url.protocol}//${auth}${url.host}`;
  } catch {
    return undefined;
  }
}

function normalizeProxyBypassRules(value: string | undefined): string | undefined {
  const tokens = value
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens && tokens.length > 0 ? tokens.join(",") : undefined;
}

function readCertificateFingerprint(certificate: CertificateLike): string | undefined {
  if (certificate.data) {
    try {
      return normalizeFingerprint(new X509Certificate(certificate.data).fingerprint256);
    } catch {
      // Electron 也提供 fingerprint 字段；PEM 解析失败时退回该字段做兼容。
    }
  }
  return certificate.fingerprint ? normalizeFingerprint(certificate.fingerprint) : undefined;
}

function normalizeFingerprint(value: string): string {
  return value.replace(/[^a-f0-9]/gi, "").toLowerCase();
}

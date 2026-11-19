import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkServerIdentity } from "node:tls";
import type { ProxyConfig, Session } from "electron";
import { NIBI_MEMBERSHIP_WEBVIEW_PARTITION } from "@nibi/shared";
import {
  detectSystemProxy,
  mergeImplicitNoProxy,
  resolveHttpProxyMode,
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
  /** 固定出口名称，用于区分多 Session 的策略日志。 */
  name?: string;
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

export interface AutoUpdaterNetSessionProvider {
  readonly netSession: Session;
}

export interface DesktopChromiumNetworkPolicyReport {
  /**
   * 更新器独立 Session 的策略失败原因。
   *
   * 更新器不允许回落到 defaultSession：调用方必须把该错误交给更新模块，
   * 让检查/下载以明确错误终止，而不是在用户不知情时换一条网络路径。
   */
  autoUpdaterPolicyError: Error | null;
}

interface DesktopNetworkPolicyTarget {
  name: string;
  resolveSession: () => Session | Promise<Session>;
  allowInsecure: boolean;
  fallbackProxyMode: ProxyFallbackMode;
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
const CERT_AUTHORITY_INVALID = -202;

const SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";
const ANY_EXTENDED_KEY_USAGE_OID = "2.5.29.37.0";

const KEY_USAGE_EXTENSION_OID = "2.5.29.15";
const EXTENDED_KEY_USAGE_EXTENSION_OID = "2.5.29.37";
const RSASSA_PSS_OID = "1.2.840.113549.1.1.10";
const MGF1_OID = "1.2.840.113549.1.1.8";

// MD2/MD4/MD5/SHA-1 签名一律拒绝。SHA-1 在未知 CA 错误下不会被 Chromium 报成弱算法，
// 因此自定义 CA 接受链时必须自己补这一道。
const WEAK_SIGNATURE_OIDS = new Set([
  "1.2.840.113549.1.1.2", // md2WithRSAEncryption
  "1.2.840.113549.1.1.3", // md4WithRSAEncryption
  "1.2.840.113549.1.1.4", // md5WithRSAEncryption
  "1.2.840.113549.1.1.5", // sha1WithRSAEncryption
  "1.3.14.3.2.27", // dsaWithSHA1
  "1.2.840.10040.4.3", // dsa-with-SHA1
  "1.2.840.10045.4.1", // ecdsa-with-SHA1
]);

const STRONG_PSS_HASH_OIDS = new Set([
  "2.16.840.1.101.3.4.2.1", // sha256
  "2.16.840.1.101.3.4.2.2", // sha384
  "2.16.840.1.101.3.4.2.3", // sha512
  "2.16.840.1.101.3.4.2.4", // sha224
  "2.16.840.1.101.3.4.2.5", // sha512-224
  "2.16.840.1.101.3.4.2.6", // sha512-256
]);

export async function applyDesktopChromiumNetworkPolicies(
  sessionProvider: DesktopSessionProvider,
  settings: DesktopNetworkPolicySettings,
  logger: DesktopNetworkPolicyLogger,
  options: {
    systemProxy?: SystemProxyDetection | null;
    /** 测试注入；生产缺省时读取 electron-updater 公开的 autoUpdater.netSession。 */
    autoUpdater?: AutoUpdaterNetSessionProvider | null;
  } = {},
): Promise<DesktopChromiumNetworkPolicyReport> {
  const targets: DesktopNetworkPolicyTarget[] = [
    {
      name: "default-session",
      resolveSession: () => sessionProvider.defaultSession,
      allowInsecure: false,
      // Nibi 自身对后端与模型 API 的出口：设置页留空时直连（显式代理/系统代理仍照常生效）。
      fallbackProxyMode: "direct",
    },
    {
      name: "embedded-browser",
      resolveSession: () => sessionProvider.fromPartition(EMBEDDED_BROWSER_PARTITION),
      // 自签名放行只开在内置浏览器出口：defaultSession 承载 renderer 对 Nibi 后端与模型 API
      // 的流量，在那里放行等于整个应用失去 TLS 保护，与「访问内网测试站点」的诉求不成比例。
      allowInsecure: settings.embeddedBrowserAllowInsecureCertificates === true,
      // 内置浏览器是用户自己的浏览出口，留空时跟随系统代理，与本机浏览器保持一致；
      // 否则需要代理才能访问的站点只会拿到 ERR_CONNECTION_TIMED_OUT，用户无从下手。
      fallbackProxyMode: "system",
    },
    {
      name: "nibi-membership",
      // 会员购买页是外部站点，必须遵循用户的代理设置；但支付页绝不放行自签名证书。
      resolveSession: () => sessionProvider.fromPartition(NIBI_MEMBERSHIP_WEBVIEW_PARTITION),
      allowInsecure: false,
      fallbackProxyMode: "system",
    },
    {
      name: "auto-updater",
      // electron-updater 的 feed、安装包和 blockmap 全部经 autoUpdater.netSession 发出；
      // 只配置 defaultSession 会让设置页代理/CA 对更新下载失效，更新器也会静默走另一条网络路径。
      resolveSession: () => resolveAutoUpdaterNetSession(options.autoUpdater),
      // 更新包是安全敏感产物：绝不能像内置浏览器那样放行任意证书，也不允许回落到默认 Session。
      allowInsecure: false,
      fallbackProxyMode: "direct",
    },
  ];

  let autoUpdaterPolicyError: Error | null = null;
  await Promise.all(
    targets.map(async (target) => {
      try {
        const targetSession = await target.resolveSession();
        await applyDesktopSessionNetworkPolicy(targetSession, settings, logger, {
          name: target.name,
          allowInsecureCertificates: target.allowInsecure,
          fallbackProxyMode: target.fallbackProxyMode,
          ...(options.systemProxy !== undefined ? { systemProxy: options.systemProxy } : {}),
        });
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (target.name === "auto-updater") {
          autoUpdaterPolicyError = normalized;
        }
        // 单一 Session 的启动失败不能阻断其它出口，否则 renderer、Browser 与更新器会再次漂移。
        logger.warn(`[desktop-network] ${target.name} network policy apply failed:`, error);
      }
    }),
  );

  return { autoUpdaterPolicyError };
}

async function resolveAutoUpdaterNetSession(
  injected: AutoUpdaterNetSessionProvider | null | undefined,
): Promise<Session> {
  if (injected) {
    if (!injected.netSession) {
      throw new Error("injected autoUpdater.netSession is unavailable");
    }
    return injected.netSession;
  }

  // 延迟加载：electron-updater 在模块初始化时就会读取 Electron app，单测通过注入 Session
  // 完全不需要触碰它；生产路径仍使用公开的 autoUpdater.netSession，不复制内部 partition 名。
  const updaterModule = await import("electron-updater");
  const defaultExport = (
    updaterModule as unknown as { default?: { autoUpdater?: AutoUpdaterNetSessionProvider } }
  ).default;
  const updater = updaterModule.autoUpdater ?? defaultExport?.autoUpdater;
  if (!updater?.netSession) {
    throw new Error("electron-updater autoUpdater.netSession is unavailable");
  }
  return updater.netSession;
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
  const userCaProc = createCustomCaCertificateVerifyProcFromFile(
    settings.httpProxyCaCertPath,
    logger,
  );
  const verifyProc = options.allowInsecureCertificates
    ? createInsecureCertificateVerifyProc()
    : userCaProc;
  targetSession.setCertificateVerifyProc(verifyProc);

  const bypassState = proxyConfig.proxyBypassRules ? "enabled" : "disabled";
  const customCaState = verifyProc ? "enabled" : "disabled";
  const policyPath = describeProxyPolicyPath(settings, proxyConfig, systemProxy, options);
  logger.info(
    `[desktop-network] ${options.name ?? "session"} policy proxy=${policyPath} mode=${proxyConfig.mode ?? "fixed_servers"} bypass=${bypassState} customCa=${customCaState} insecureCerts=${options.allowInsecureCertificates ? "allowed" : "rejected"}`,
  );
}

function describeProxyPolicyPath(
  settings: DesktopNetworkPolicySettings,
  proxyConfig: ProxyConfig,
  systemProxy: SystemProxyDetection | null,
  options: DesktopSessionNetworkPolicyOptions,
): string {
  const mode = resolveHttpProxyMode(settings);
  if (mode === "manual") {
    return proxyConfig.mode === "direct" ? "manual-direct" : "manual-proxy";
  }
  if (systemProxy?.source === "pac-unsupported" && proxyConfig.mode === "system") {
    // Chromium 自己求值 OS PAC；Electron 只接受 `mode: "system"` 这一种表达方式。
    return "system-pac";
  }
  if (proxyConfig.mode === "fixed_servers") {
    return "system-proxy";
  }
  return options.fallbackProxyMode === "system"
    ? "system-fallback-system"
    : "system-fallback-direct";
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
  const mode = resolveHttpProxyMode({ httpProxy, httpProxyMode: proxyMode });
  // 系统代理若是 PAC，Chromium 自己能求值，交给 system 模式；若是固定地址，则转成
  // fixed_servers 以便附带我们的隐式直连规则（本机回环），这也是设置页不再
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
    const trustedCertificates = readCustomCaCertificatesFromPem(readFileSync(trimmed, "utf8"));
    if (trustedCertificates.length === 0) {
      logger.warn(`[desktop-network] custom CA file contains no certificates: ${trimmed}`);
      return null;
    }
    return createCustomCaCertificateVerifyProc(trustedCertificates);
  } catch (error) {
    logger.warn(`[desktop-network] failed to load custom CA file: ${trimmed}`, error);
    return null;
  }
}

export function readCustomCaCertificatesFromPem(pem: string): X509Certificate[] {
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map(
    (block) => new X509Certificate(block),
  );
}

export function createCustomCaCertificateVerifyProc(
  trustedCertificates: readonly X509Certificate[],
): CertificateVerifyProc | null {
  if (trustedCertificates.length === 0) {
    return null;
  }
  const trustedFingerprints = new Set(
    trustedCertificates.map((certificate) => normalizeFingerprint(certificate.fingerprint256)),
  );

  return (request, callback) => {
    // 自定义 CA 只补充「未知 CA」这一类拒绝。其它错误（过期、吊销、名称不匹配等）
    // 继续交给 Chromium 判定，不能用一条自定义链把更严重的 TLS 错误吞掉。
    if (request.errorCode !== CERT_AUTHORITY_INVALID) {
      callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
      return;
    }

    try {
      const accepted = verifyCustomCaChain(
        request.hostname,
        request.certificate,
        request.validatedCertificate,
        trustedCertificates,
        trustedFingerprints,
      );
      callback(accepted ? ACCEPT_CERTIFICATE : USE_CHROMIUM_DEFAULT_VERIFICATION);
    } catch {
      // 解析/验签异常一律失败关闭，不让畸形证书进入接受分支。
      callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
    }
  };
}

function verifyCustomCaChain(
  hostname: string,
  certificate: CertificateLike | undefined,
  validatedCertificate: CertificateLike | undefined,
  trustedCertificates: readonly X509Certificate[],
  trustedFingerprints: ReadonlySet<string>,
): boolean {
  const presented = selectPresentedCertificateChain(certificate, validatedCertificate);
  if (!presented) {
    return false;
  }

  const leaf = presented[0];
  if (!leaf || !isCertificateTimeValid(leaf) || !matchesServerIdentity(hostname, leaf)) {
    return false;
  }

  const path: X509Certificate[] = [];
  const visited = new Set<string>();
  let current: X509Certificate = leaf;

  while (path.length < MAX_CERTIFICATE_CHAIN_DEPTH) {
    const fingerprint = normalizeFingerprint(current.fingerprint256);
    if (visited.has(fingerprint)) {
      return false;
    }
    visited.add(fingerprint);
    path.push(current);

    // 显式配置的信任锚命中即终止；锚本身仍需在下方的路径校验里满足有效期、用途和算法要求。
    if (trustedFingerprints.has(fingerprint)) {
      break;
    }

    const presentedIssuer = presented[path.length];
    const issuer =
      presentedIssuer && isIssuedBy(current, presentedIssuer)
        ? presentedIssuer
        : trustedCertificates.find((candidate) => isIssuedBy(current, candidate));
    if (!issuer) {
      return false;
    }
    current = issuer;
  }

  const anchor = path.at(-1);
  if (
    path.length >= MAX_CERTIFICATE_CHAIN_DEPTH &&
    (!anchor || !trustedFingerprints.has(normalizeFingerprint(anchor.fingerprint256)))
  ) {
    return false;
  }
  if (!anchor || !trustedFingerprints.has(normalizeFingerprint(anchor.fingerprint256))) {
    return false;
  }

  return validateVerifiedCertificatePath(path);
}

function selectPresentedCertificateChain(
  certificate: CertificateLike | undefined,
  validatedCertificate: CertificateLike | undefined,
): X509Certificate[] | null {
  const candidates = [certificate, validatedCertificate]
    .map((candidate) => readPresentedCertificateChain(candidate))
    .filter((chain): chain is X509Certificate[] => chain !== null);
  if (candidates.length === 0) {
    return null;
  }
  // Chromium 的两个字段通常指向同一条链；取更完整的一条，避免首字段只有叶证书时丢失中间 CA。
  return candidates.reduce((longest, candidate) =>
    candidate.length > longest.length ? candidate : longest,
  );
}

function readPresentedCertificateChain(
  certificate: CertificateLike | undefined,
): X509Certificate[] | null {
  if (!certificate) {
    return null;
  }

  const chain: X509Certificate[] = [];
  const seen = new Set<string>();
  let current: CertificateLike | null | undefined = certificate;

  while (current && chain.length < MAX_CERTIFICATE_CHAIN_DEPTH) {
    if (!current.data) {
      break;
    }
    const parsed = new X509Certificate(current.data);
    const fingerprint = normalizeFingerprint(parsed.fingerprint256);
    if (seen.has(fingerprint)) {
      break;
    }
    seen.add(fingerprint);
    chain.push(parsed);
    current = current.issuerCert;
  }

  return chain.length > 0 ? chain : null;
}

function isIssuedBy(child: X509Certificate, issuer: X509Certificate): boolean {
  let nameMatches = false;
  try {
    nameMatches = child.checkIssued(issuer);
  } catch {
    // checkIssued 对缺少 AKI/SKI 的证书可能拒绝；下面再用签发者 DN 兜底。
  }
  // checkIssued 只比较名称/AKI/SKI，不验证签名；这里必须再做一次真实验签，
  // 否则伪造 issuer 名称的证书会被当成已由显式 CA 签发。
  return (
    (nameMatches || child.issuer === issuer.subject) &&
    isCertificateSignedBy(child, issuer)
  );
}

function isCertificateSignedBy(child: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return child.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

function matchesServerIdentity(hostname: string, leaf: X509Certificate): boolean {
  const normalizedHostname = hostname.trim();
  if (!normalizedHostname) {
    return false;
  }
  try {
    // Node 的 checkServerIdentity 按 SAN（IP/DNS 通配符）匹配，并在没有 SAN 时回退 CN，
    // 与 Chromium 对服务端名称的判定保持一致。
    return checkServerIdentity(normalizedHostname, leaf.toLegacyObject()) === undefined;
  } catch {
    return false;
  }
}

function isCertificateTimeValid(certificate: X509Certificate, now = Date.now()): boolean {
  const validFrom = certificate.validFromDate.getTime();
  const validTo = certificate.validToDate.getTime();
  return (
    Number.isFinite(validFrom) &&
    Number.isFinite(validTo) &&
    validFrom <= now &&
    now <= validTo
  );
}

interface CertificateUsageExtensions {
  keyUsage: {
    digitalSignature: boolean;
    keyCertSign: boolean;
  } | null;
  extendedKeyUsage: string[] | null;
}

function validateVerifiedCertificatePath(path: readonly X509Certificate[]): boolean {
  return path.every((certificate, index) => {
    if (!isCertificateTimeValid(certificate) || !hasStrongCertificateSignature(certificate)) {
      return false;
    }

    const extensions = readCertificateUsageExtensions(certificate);
    if (!extensions) {
      return false;
    }

    if (index === 0) {
      // TLS 服务端需要能签名握手；没有 keyUsage 扩展表示未施加用途限制。
      if (extensions.keyUsage && !extensions.keyUsage.digitalSignature) {
        return false;
      }
      // 有 EKU 时必须是 serverAuth（或 anyExtendedKeyUsage）；没有 EKU 表示不限制用途。
      if (
        extensions.extendedKeyUsage &&
        !extensions.extendedKeyUsage.includes(SERVER_AUTH_OID) &&
        !extensions.extendedKeyUsage.includes(ANY_EXTENDED_KEY_USAGE_OID)
      ) {
        return false;
      }
      return true;
    }

    // 路径中的每个签发者都必须是 CA，并且明确带 keyCertSign；缺少该位（或整个 keyUsage
    // 扩展）时拒绝，避免把只能签名数据的证书当作 CA 接受。
    return certificate.ca && extensions.keyUsage?.keyCertSign === true;
  });
}

interface DerNode {
  tag: number;
  contentStart: number;
  end: number;
}

function hasStrongCertificateSignature(certificate: X509Certificate): boolean {
  const buffer = Buffer.from(certificate.raw);
  const root = readDerNode(buffer, 0);
  if (!root || root.tag !== 0x30) {
    return false;
  }
  const certificateChildren = readDerChildren(buffer, root);
  if (!certificateChildren || certificateChildren.length < 2) {
    return false;
  }
  const algorithm = certificateChildren[1];
  if (!algorithm || algorithm.tag !== 0x30) {
    return false;
  }
  const algorithmChildren = readDerChildren(buffer, algorithm);
  if (!algorithmChildren || algorithmChildren.length === 0) {
    return false;
  }
  const signatureOid = readDerOid(buffer, algorithmChildren[0]);
  if (!signatureOid || WEAK_SIGNATURE_OIDS.has(signatureOid)) {
    return false;
  }
  if (/(?:md2|md4|md5|sha1)/i.test(certificate.signatureAlgorithm ?? "")) {
    return false;
  }
  if (signatureOid === RSASSA_PSS_OID) {
    return hasStrongPssParameters(buffer, algorithmChildren[1]);
  }
  return true;
}

function hasStrongPssParameters(buffer: Buffer, parameters: DerNode | undefined): boolean {
  // 缺省 hashAlgorithm 按 SHA-1 解释，缺省 maskGen 是 MGF1-SHA1，两者都必须显式给出强摘要。
  if (!parameters || parameters.tag !== 0x30) {
    return false;
  }
  const fields = readDerChildren(buffer, parameters);
  if (!fields) {
    return false;
  }

  let hashOid: string | null = null;
  let maskGenerationOid: string | null = null;
  let maskGenerationHashOid: string | null = null;
  for (const field of fields) {
    if (field.tag === 0xa0) {
      const algorithm = readDerChildren(buffer, field)?.[0];
      hashOid = readAlgorithmIdentifierOid(buffer, algorithm);
      continue;
    }
    if (field.tag === 0xa1) {
      const maskAlgorithm = readDerChildren(buffer, field)?.[0];
      if (!maskAlgorithm || maskAlgorithm.tag !== 0x30) {
        continue;
      }
      const maskChildren = readDerChildren(buffer, maskAlgorithm);
      if (!maskChildren || maskChildren.length < 2) {
        continue;
      }
      maskGenerationOid = readDerOid(buffer, maskChildren[0]);
      maskGenerationHashOid = readAlgorithmIdentifierOid(buffer, maskChildren[1]);
    }
  }

  return (
    hashOid !== null &&
    STRONG_PSS_HASH_OIDS.has(hashOid) &&
    maskGenerationOid === MGF1_OID &&
    maskGenerationHashOid !== null &&
    STRONG_PSS_HASH_OIDS.has(maskGenerationHashOid)
  );
}

function readAlgorithmIdentifierOid(buffer: Buffer, algorithm: DerNode | undefined): string | null {
  if (!algorithm || algorithm.tag !== 0x30) {
    return null;
  }
  const children = readDerChildren(buffer, algorithm);
  if (!children || children.length === 0) {
    return null;
  }
  return readDerOid(buffer, children[0]);
}

function readCertificateUsageExtensions(
  certificate: X509Certificate,
): CertificateUsageExtensions | null {
  const buffer = Buffer.from(certificate.raw);
  const root = readDerNode(buffer, 0);
  if (!root || root.tag !== 0x30) {
    return null;
  }
  const certificateChildren = readDerChildren(buffer, root);
  const tbsCertificate = certificateChildren?.[0];
  if (!tbsCertificate || tbsCertificate.tag !== 0x30) {
    return null;
  }
  const tbsChildren = readDerChildren(buffer, tbsCertificate);
  if (!tbsChildren) {
    return null;
  }
  const extensionsWrapper = tbsChildren.find((child) => child.tag === 0xa3);
  if (!extensionsWrapper) {
    return { keyUsage: null, extendedKeyUsage: null };
  }

  const explicitWrapper = readDerChildren(buffer, extensionsWrapper);
  const extensionsSequence = explicitWrapper?.[0];
  if (
    !explicitWrapper ||
    explicitWrapper.length !== 1 ||
    !extensionsSequence ||
    extensionsSequence.tag !== 0x30
  ) {
    return null;
  }
  const extensions = readDerChildren(buffer, extensionsSequence);
  if (!extensions) {
    return null;
  }

  let keyUsage: CertificateUsageExtensions["keyUsage"] = null;
  let extendedKeyUsage: string[] | null = null;
  let sawKeyUsage = false;
  let sawExtendedKeyUsage = false;

  for (const extension of extensions) {
    if (extension.tag !== 0x30) {
      return null;
    }
    const fields = readDerChildren(buffer, extension);
    if (!fields || fields.length < 2) {
      return null;
    }
    const extensionOid = readDerOid(buffer, fields[0]);
    if (!extensionOid) {
      return null;
    }

    let valueIndex = 1;
    if (fields[valueIndex]?.tag === 0x01) {
      // critical BOOLEAN 不改变解析位置；内容只接受 DER 0x00/0xff 的形态由 BIT STRING 校验兜住。
      valueIndex += 1;
    }
    const valueNode = fields[valueIndex];
    if (!valueNode || valueNode.tag !== 0x04 || valueIndex !== fields.length - 1) {
      return null;
    }
    const inner = readDerNode(buffer, valueNode.contentStart);
    if (!inner || inner.end !== valueNode.end) {
      return null;
    }

    if (extensionOid === KEY_USAGE_EXTENSION_OID) {
      if (sawKeyUsage || inner.tag !== 0x03) {
        return null;
      }
      sawKeyUsage = true;
      keyUsage = readKeyUsageBits(buffer, inner);
      if (!keyUsage) {
        return null;
      }
      continue;
    }

    if (extensionOid === EXTENDED_KEY_USAGE_EXTENSION_OID) {
      if (sawExtendedKeyUsage || inner.tag !== 0x30) {
        return null;
      }
      sawExtendedKeyUsage = true;
      const oidNodes = readDerChildren(buffer, inner);
      if (!oidNodes) {
        return null;
      }
      const oids: string[] = [];
      for (const oidNode of oidNodes) {
        const oid = readDerOid(buffer, oidNode);
        if (!oid) {
          return null;
        }
        oids.push(oid);
      }
      extendedKeyUsage = oids;
    }
  }

  return { keyUsage, extendedKeyUsage };
}

function readKeyUsageBits(
  buffer: Buffer,
  bitString: DerNode,
): CertificateUsageExtensions["keyUsage"] | null {
  if (bitString.contentStart >= bitString.end) {
    return null;
  }
  const unusedBits = buffer[bitString.contentStart];
  if (unusedBits === undefined || unusedBits > 7) {
    return null;
  }
  const bits = buffer.subarray(bitString.contentStart + 1, bitString.end);
  // keyUsage 只有 9 个定义位，最多占 2 个字节。
  if (bits.length === 0 || bits.length > 2) {
    return null;
  }
  const lastByte = bits[bits.length - 1];
  if (lastByte === undefined || (lastByte & ((1 << unusedBits) - 1)) !== 0) {
    return null;
  }
  if (bits.length === 2 && (bits[1]! & 0x7f) !== 0) {
    return null;
  }

  const firstByte = bits[0]!;
  return {
    digitalSignature: (firstByte & 0x80) !== 0,
    keyCertSign: (firstByte & 0x04) !== 0,
  };
}

function readDerNode(buffer: Buffer, offset: number): DerNode | null {
  if (offset < 0 || offset + 2 > buffer.length) {
    return null;
  }
  const tag = buffer[offset]!;
  let cursor = offset + 1;
  const firstLengthByte = buffer[cursor]!;
  cursor += 1;
  let length: number;
  if ((firstLengthByte & 0x80) === 0) {
    length = firstLengthByte;
  } else {
    const lengthByteCount = firstLengthByte & 0x7f;
    if (lengthByteCount === 0 || lengthByteCount > 3 || cursor + lengthByteCount > buffer.length) {
      return null;
    }
    length = 0;
    for (let index = 0; index < lengthByteCount; index += 1) {
      length = length * 256 + buffer[cursor]!;
      cursor += 1;
    }
  }
  const end = cursor + length;
  if (end > buffer.length) {
    return null;
  }
  return { tag, contentStart: cursor, end };
}

function readDerChildren(buffer: Buffer, parent: DerNode): DerNode[] | null {
  const children: DerNode[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readDerNode(buffer, offset);
    if (!child || child.end <= offset || child.end > parent.end) {
      return null;
    }
    children.push(child);
    offset = child.end;
  }
  return offset === parent.end ? children : null;
}

function readDerOid(buffer: Buffer, node: DerNode | undefined): string | null {
  if (!node || node.tag !== 0x06 || node.contentStart >= node.end) {
    return null;
  }
  const bytes = buffer.subarray(node.contentStart, node.end);
  const values: number[] = [];
  let value = 0;
  let inProgress = false;
  for (const byte of bytes) {
    value = value * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(value)) {
      return null;
    }
    inProgress = true;
    if ((byte & 0x80) === 0) {
      values.push(value);
      value = 0;
      inProgress = false;
    }
  }
  if (inProgress || values.length === 0) {
    return null;
  }
  const firstValue = values[0]!;
  const firstArc = firstValue < 40 ? 0 : firstValue < 80 ? 1 : 2;
  return [firstArc, firstValue - firstArc * 40, ...values.slice(1)].join(".");
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

function normalizeFingerprint(value: string): string {
  return value.replace(/[^a-f0-9]/gi, "").toLowerCase();
}

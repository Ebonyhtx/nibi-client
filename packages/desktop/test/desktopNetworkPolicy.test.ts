import forge from "node-forge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import {
  applyDesktopChromiumNetworkPolicies,
  applyDesktopSessionNetworkPolicy,
  buildElectronProxyConfig,
  certificateChainMatchesCustomCa,
  createCustomCaCertificateVerifyProc,
  createNibiMirrorCertificateVerifyProc,
  readCustomCaFingerprintsFromPem,
} from "../src/main/desktopNetworkPolicy.js";
import { EMBEDDED_BROWSER_PARTITION } from "../src/main/browserDataManager.js";
import { NIBI_MEMBERSHIP_WEBVIEW_PARTITION, setNibiMirrorOrigin } from "@nibi/shared";

beforeEach(() => setNibiMirrorOrigin("https://203.0.113.10"));
afterEach(() => setNibiMirrorOrigin(""));

describe("desktopNetworkPolicy", () => {
  it("applies the startup network policy to default, embedded Browser, and NIBI membership sessions", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const membershipSession = createSessionStub();
    const unrelatedSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn((partition: string) => {
        if (partition === EMBEDDED_BROWSER_PARTITION) return embeddedBrowserSession.session;
        if (partition === NIBI_MEMBERSHIP_WEBVIEW_PARTITION) return membershipSession.session;
        return unrelatedSession.session;
      }),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      {
        httpProxy: "http://127.0.0.1:7890",
        httpProxyNoProxy: "localhost,127.0.0.1",
      },
      logger,
      { systemProxy: null },
    );

    expect(sessionProvider.fromPartition).toHaveBeenCalledTimes(2);
    expect(sessionProvider.fromPartition).toHaveBeenCalledWith(EMBEDDED_BROWSER_PARTITION);
    expect(sessionProvider.fromPartition).toHaveBeenCalledWith(NIBI_MEMBERSHIP_WEBVIEW_PARTITION);
    for (const target of [defaultSession, embeddedBrowserSession, membershipSession]) {
      expect(target.setProxy).toHaveBeenCalledWith({
        mode: "fixed_servers",
        proxyBypassRules: "localhost,127.0.0.1,::1,203.0.113.10",
        proxyRules: "http://127.0.0.1:7890",
      });
      expect(target.closeAllConnections).toHaveBeenCalledTimes(1);
      // 公开构建未配置镜像 CA：各 session 都交回 Chromium 默认严格校验。
      expect(target.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
    }
    expect(unrelatedSession.setProxy).not.toHaveBeenCalled();
  });

  it("falls back to the system proxy only on the embedded Browser session when the setting is empty", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(sessionProvider, {}, logger, { systemProxy: null });

    // Bug 原因：留空曾被翻译成 `direct`，而 Electron 的 `direct` 是「永不使用代理」，
    // 会连本机系统代理一起屏蔽。内置浏览器是用户的浏览出口，需要代理才能访问的站点
    // 会直接 ERR_CONNECTION_TIMED_OUT，与用户本机浏览器行为漂移。
    expect(embeddedBrowserSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    // defaultSession 承载 NIBI 自身的后端与模型流量，留空时保持显式收敛，不受系统代理影响。
    expect(defaultSession.setProxy).toHaveBeenCalledWith({ mode: "direct" });
  });

  it("continues configuring the embedded Browser session when the default session fails", async () => {
    const defaultError = new Error("default session proxy failed");
    const defaultSession = createSessionStub({ setProxyError: defaultError });
    const embeddedBrowserSession = createSessionStub();
    const membershipSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn((partition: string) =>
        partition === EMBEDDED_BROWSER_PARTITION
          ? embeddedBrowserSession.session
          : membershipSession.session,
      ),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await applyDesktopChromiumNetworkPolicies(sessionProvider, {}, logger, { systemProxy: null });

    expect(defaultSession.closeAllConnections).not.toHaveBeenCalled();
    expect(embeddedBrowserSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(membershipSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(embeddedBrowserSession.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(membershipSession.closeAllConnections).toHaveBeenCalledTimes(1);
    // 公开构建未配置镜像 CA 时，内置浏览器仍使用 Chromium 默认严格校验。
    expect(embeddedBrowserSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[desktop-network] default-session network policy apply failed:",
      defaultError,
    );
  });

  it("accepts every certificate on the embedded Browser session when insecure certificates are allowed", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: true },
      logger,
    );

    const embeddedProc = embeddedBrowserSession.setCertificateVerifyProc.mock.calls.at(0)?.[0];
    expect(embeddedProc).toBeTypeOf("function");
    const results: number[] = [];
    embeddedProc?.(
      buildVerifyRequest(generateSelfSignedCertPem("Untrusted Intranet")),
      (result: number) => results.push(result),
    );
    expect(results).toEqual([0]);
  });

  it("keeps the default session on strict verification when insecure certificates are allowed", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: true },
      logger,
    );

    // 放行只属于内置浏览器出口；defaultSession 承载 NIBI 自身的后端与模型流量，
    // 公开构建未配置镜像 CA 时保持 Chromium 默认严格校验。
    expect(defaultSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
  });

  it("keeps every session on strict verification when insecure certificates are disabled", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: false },
      logger,
    );

    expect(defaultSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
    expect(embeddedBrowserSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
  });

  it("prefers blanket acceptance over the custom CA chain check when both are configured", async () => {
    const targetSession = createSessionStub();
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopSessionNetworkPolicy(
      targetSession.session,
      { httpProxyCaCertPath: "/definitely/missing/root-ca.pem" },
      logger,
      { allowInsecureCertificates: true },
    );

    const proc = targetSession.setCertificateVerifyProc.mock.calls.at(0)?.[0];
    expect(proc).toBeTypeOf("function");
    const results: number[] = [];
    proc?.(buildVerifyRequest(generateSelfSignedCertPem("Intranet")), (result: number) =>
      results.push(result),
    );
    expect(results).toEqual([0]);
  });

  it("builds a fixed-server proxy config from the explicit setting", () => {
    expect(
      buildElectronProxyConfig("127.0.0.1:7890", " localhost, 127.0.0.1 ,.example.com ", "direct", null),
    ).toEqual({
      mode: "fixed_servers",
      proxyBypassRules: "localhost,127.0.0.1,::1,203.0.113.10,.example.com",
      proxyRules: "http://127.0.0.1:7890",
    });
  });

  it("uses direct mode when the explicit proxy setting is empty", () => {
    expect(buildElectronProxyConfig(" ", undefined, "direct", null)).toEqual({ mode: "direct" });
  });

  it("falls back to the requested mode when the explicit proxy setting is empty", () => {
    expect(buildElectronProxyConfig(" ", "localhost", "system", null)).toEqual({ mode: "system" });
  });

  it("系统代理转成 Chromium 可接受的 fixed_servers 规则（去掉 URL 尾部斜杠）", () => {
    expect(
      buildElectronProxyConfig(undefined, undefined, "direct", {
        url: "http://127.0.0.1:7897/",
        source: "windows-registry",
      }),
    ).toEqual({
      mode: "fixed_servers",
      proxyRules: "http://127.0.0.1:7897",
      proxyBypassRules: "localhost,127.0.0.1,::1,203.0.113.10",
    });
  });

  it("keeps the explicit proxy config regardless of the fallback mode", () => {
    // 兜底模式只在留空时生效；显式代理仍必须原样落到 fixed_servers，避免设置页配置被系统代理顶掉。
    expect(buildElectronProxyConfig("127.0.0.1:7890", "localhost", "system", null)).toEqual({
      mode: "fixed_servers",
      proxyBypassRules: "localhost,127.0.0.1,::1,203.0.113.10",
      proxyRules: "http://127.0.0.1:7890",
    });
  });

  it("镜像主机：只放行由镜像 CA 签发、SAN 覆盖该主机的叶子证书", () => {
    setNibiMirrorOrigin("https://203.0.113.10");
    const { caPem, leafPem } = generateCaAndLeafForIp("203.0.113.10");
    const proc = createNibiMirrorCertificateVerifyProc(caPem, null);
    expect(proc).toBeTypeOf("function");

    const accepted: number[] = [];
    proc?.(
      buildVerifyRequestForHost(leafPem, "203.0.113.10"),
      (result: number) => accepted.push(result),
    );
    expect(accepted).toEqual([0]);

    // 非镜像主机：交回 Chromium 默认校验
    const otherHost: number[] = [];
    proc?.(
      buildVerifyRequestForHost(leafPem, "example.com"),
      (result: number) => otherHost.push(result),
    );
    expect(otherHost).toEqual([-3]);

    // 镜像主机但证书不是我们 CA 签的：同样拒绝
    const otherCa = generateCaAndLeafForIp("203.0.113.10");
    const foreign: number[] = [];
    proc?.(
      buildVerifyRequestForHost(otherCa.leafPem, "203.0.113.10"),
      (result: number) => foreign.push(result),
    );
    expect(foreign).toEqual([-3]);
  });

  it("accepts only certificate chains that include the configured custom CA", () => {
    const trustedPem = generateSelfSignedCertPem("Trusted Test CA");
    const untrustedPem = generateSelfSignedCertPem("Other Test CA");
    const trustedFingerprints = readCustomCaFingerprintsFromPem(trustedPem);
    const proc = createCustomCaCertificateVerifyProc(trustedFingerprints);
    const acceptedResults: number[] = [];
    const rejectedResults: number[] = [];

    expect(proc).not.toBeNull();
    expect(
      certificateChainMatchesCustomCa({ data: trustedPem, issuerCert: null }, trustedFingerprints),
    ).toBe(true);
    expect(
      certificateChainMatchesCustomCa(
        { data: untrustedPem, issuerCert: null },
        trustedFingerprints,
      ),
    ).toBe(false);

    proc?.(buildVerifyRequest(trustedPem), (result) => acceptedResults.push(result));
    proc?.(buildVerifyRequest(untrustedPem), (result) => rejectedResults.push(result));

    expect(acceptedResults).toEqual([0]);
    expect(rejectedResults).toEqual([-3]);
  });
});

function createSessionStub(options: { setProxyError?: Error } = {}) {
  const setProxy = vi.fn(async () => {
    if (options.setProxyError) throw options.setProxyError;
  });
  const closeAllConnections = vi.fn(async () => {});
  const setCertificateVerifyProc = vi.fn();
  return {
    session: {
      setProxy,
      closeAllConnections,
      setCertificateVerifyProc,
    } as unknown as Session,
    setProxy,
    closeAllConnections,
    setCertificateVerifyProc,
  };
}

type VerifyRequest = Parameters<NonNullable<Parameters<Session["setCertificateVerifyProc"]>[0]>>[0];

/** 构造一条「Chromium 已判定证书不受信」的校验请求，用于驱动 verifyProc 的拒绝分支。 */
function buildVerifyRequest(certPem: string): VerifyRequest {
  return {
    certificate: { data: certPem, issuerCert: null },
    hostname: "intranet.test",
    isIssuedByKnownRoot: false,
    validatedCertificate: { data: certPem, issuerCert: null },
    verificationResult: "CERT_AUTHORITY_INVALID",
    errorCode: -202,
  } as unknown as VerifyRequest;
}


function buildVerifyRequestForHost(certPem: string, hostname: string): VerifyRequest {
  return {
    certificate: { data: certPem, issuerCert: null },
    hostname,
    isIssuedByKnownRoot: false,
    validatedCertificate: { data: certPem, issuerCert: null },
    verificationResult: "CERT_AUTHORITY_INVALID",
    errorCode: -202,
  } as unknown as VerifyRequest;
}

/** 生成「测试 CA + 该 CA 签发、SAN 覆盖指定 IP 的叶子证书」，用于验证镜像信任边界。 */
function generateCaAndLeafForIp(ip: string): { caPem: string; leafPem: string } {
  const caKeys = forge.pki.rsa.generateKeyPair(1024);
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = "0a";
  ca.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  ca.validity.notAfter = new Date("2036-01-01T00:00:00Z");
  const caAttrs = [{ name: "commonName", value: "Test Mirror CA" }];
  ca.setSubject(caAttrs);
  ca.setIssuer(caAttrs);
  ca.setExtensions([{ name: "basicConstraints", cA: true, critical: true }]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(1024);
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = leafKeys.publicKey;
  leaf.serialNumber = "0b";
  leaf.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  leaf.validity.notAfter = new Date("2036-01-01T00:00:00Z");
  leaf.setSubject([{ name: "commonName", value: ip }]);
  leaf.setIssuer(caAttrs);
  leaf.setExtensions([{ name: "subjectAltName", altNames: [{ type: 7, ip }] }]);
  leaf.sign(caKeys.privateKey, forge.md.sha256.create());
  return {
    caPem: forge.pki.certificateToPem(ca),
    leafPem: forge.pki.certificateToPem(leaf),
  };
}

function generateSelfSignedCertPem(commonName: string): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2036-01-01T00:00:00Z");
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

describe("代理方式对 Chromium 出口的裁决", () => {
  const system = { url: "http://127.0.0.1:7897/", source: "windows-registry" as const };

  it("system 模式忽略手填地址，改用系统代理", () => {
    expect(
      buildElectronProxyConfig("http://old:1", undefined, "direct", system, "system"),
    ).toEqual({
      mode: "fixed_servers",
      proxyRules: "http://127.0.0.1:7897",
      proxyBypassRules: "localhost,127.0.0.1,::1,203.0.113.10",
    });
  });

  it("manual 模式地址为空时直连，即使系统配置了代理", () => {
    expect(
      buildElectronProxyConfig("  ", undefined, "system", system, "manual"),
    ).toEqual({ mode: "direct" });
  });

  it("manual 模式有地址时只用手填代理", () => {
    expect(
      buildElectronProxyConfig("127.0.0.1:7890", undefined, "system", system, "manual"),
    ).toMatchObject({ mode: "fixed_servers", proxyRules: "http://127.0.0.1:7890" });
  });

  it("system 模式且系统无代理时按调用方兜底", () => {
    expect(buildElectronProxyConfig(undefined, undefined, "direct", null, "system")).toEqual({
      mode: "direct",
    });
    expect(buildElectronProxyConfig(undefined, undefined, "system", null, "system")).toEqual({
      mode: "system",
    });
  });
});

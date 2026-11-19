import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import {
  applyDesktopChromiumNetworkPolicies,
  applyDesktopSessionNetworkPolicy,
  buildElectronProxyConfig,
  createCustomCaCertificateVerifyProc,
  createCustomCaCertificateVerifyProcFromFile,
  readCustomCaCertificatesFromPem,
} from "../src/main/desktopNetworkPolicy.js";
import { EMBEDDED_BROWSER_PARTITION } from "../src/main/browserDataManager.js";
import { NIBI_MEMBERSHIP_WEBVIEW_PARTITION } from "@nibi/shared";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("desktopNetworkPolicy", () => {
  it("applies the startup network policy to default, embedded Browser, NIBI membership, and auto-updater sessions", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const membershipSession = createSessionStub();
    const autoUpdaterSession = createSessionStub();
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

    const report = await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      {
        httpProxy: "http://127.0.0.1:7890",
        httpProxyNoProxy: "localhost,127.0.0.1",
      },
      logger,
      {
        systemProxy: null,
        autoUpdater: { netSession: autoUpdaterSession.session },
      },
    );

    expect(report.autoUpdaterPolicyError).toBeNull();
    expect(sessionProvider.fromPartition).toHaveBeenCalledTimes(2);
    expect(sessionProvider.fromPartition).toHaveBeenCalledWith(EMBEDDED_BROWSER_PARTITION);
    expect(sessionProvider.fromPartition).toHaveBeenCalledWith(NIBI_MEMBERSHIP_WEBVIEW_PARTITION);
    for (const target of [
      defaultSession,
      embeddedBrowserSession,
      membershipSession,
      autoUpdaterSession,
    ]) {
      expect(target.setProxy).toHaveBeenCalledWith({
        mode: "fixed_servers",
        proxyBypassRules: "localhost,127.0.0.1,::1",
        proxyRules: "http://127.0.0.1:7890",
      });
      expect(target.closeAllConnections).toHaveBeenCalledTimes(1);
      // 公开构建未配置自定义 CA：各 session 都交回 Chromium 默认严格校验。
      expect(target.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
    }
    expect(unrelatedSession.setProxy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "[desktop-network] auto-updater policy proxy=manual-proxy mode=fixed_servers bypass=enabled customCa=disabled insecureCerts=rejected",
      ),
    );
  });

  it("falls back to the system proxy only on sessions whose fallback mode is system", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const membershipSession = createSessionStub();
    const autoUpdaterSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn((partition: string) =>
        partition === EMBEDDED_BROWSER_PARTITION
          ? embeddedBrowserSession.session
          : membershipSession.session,
      ),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(sessionProvider, {}, logger, {
      systemProxy: null,
      autoUpdater: { netSession: autoUpdaterSession.session },
    });

    // Bug 原因：留空曾被翻译成 `direct`，而 Electron 的 `direct` 是「永不使用代理」，
    // 会连本机系统代理一起屏蔽。内置浏览器是用户的浏览出口，需要代理才能访问的站点
    // 会直接 ERR_CONNECTION_TIMED_OUT，与用户本机浏览器行为漂移。
    expect(embeddedBrowserSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(membershipSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    // defaultSession 与更新器承载 NIBI 自身流量，留空时保持显式直连，不受系统代理影响。
    expect(defaultSession.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    expect(autoUpdaterSession.setProxy).toHaveBeenCalledWith({ mode: "direct" });
  });

  it("applies an explicit system proxy and PAC fallback to the auto-updater session", async () => {
    const autoUpdaterSession = createSessionStub();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const sessionProvider = {
      defaultSession: createSessionStub().session,
      fromPartition: vi.fn(() => createSessionStub().session),
    };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { httpProxyMode: "system", httpProxyNoProxy: "internal.test" },
      logger,
      {
        systemProxy: { url: "http://127.0.0.1:7897/", source: "windows-registry" },
        autoUpdater: { netSession: autoUpdaterSession.session },
      },
    );

    expect(autoUpdaterSession.setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyBypassRules: "localhost,127.0.0.1,::1,internal.test",
      proxyRules: "http://127.0.0.1:7897",
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("auto-updater policy proxy=system-proxy"),
    );

    const pacUpdaterSession = createSessionStub();
    await applyDesktopChromiumNetworkPolicies(
      {
        defaultSession: createSessionStub().session,
        fromPartition: vi.fn(() => createSessionStub().session),
      },
      { httpProxyMode: "system" },
      logger,
      {
        systemProxy: { url: null, source: "pac-unsupported" },
        autoUpdater: { netSession: pacUpdaterSession.session },
      },
    );

    // PAC 交给 Chromium 的 system 模式求值；不能退化成 direct 让更新器绕过 PAC。
    expect(pacUpdaterSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("auto-updater policy proxy=system-pac"),
    );
  });

  it("continues configuring the embedded Browser session when the default session fails", async () => {
    const defaultError = new Error("default session proxy failed");
    const defaultSession = createSessionStub({ setProxyError: defaultError });
    const embeddedBrowserSession = createSessionStub();
    const membershipSession = createSessionStub();
    const autoUpdaterSession = createSessionStub();
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

    const report = await applyDesktopChromiumNetworkPolicies(sessionProvider, {}, logger, {
      systemProxy: null,
      autoUpdater: { netSession: autoUpdaterSession.session },
    });

    expect(report.autoUpdaterPolicyError).toBeNull();
    expect(defaultSession.closeAllConnections).not.toHaveBeenCalled();
    expect(embeddedBrowserSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(membershipSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(autoUpdaterSession.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    expect(embeddedBrowserSession.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(membershipSession.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(autoUpdaterSession.closeAllConnections).toHaveBeenCalledTimes(1);
    // 公开构建未配置自定义 CA 时，内置浏览器仍使用 Chromium 默认严格校验。
    expect(embeddedBrowserSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[desktop-network] default-session network policy apply failed:",
      defaultError,
    );
  });

  it("reports auto-updater policy failure without retrying through the default session", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const updaterError = new Error("updater netSession proxy failed");
    const autoUpdaterSession = createSessionStub({ setProxyError: updaterError });
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    const report = await applyDesktopChromiumNetworkPolicies(sessionProvider, {}, logger, {
      systemProxy: null,
      autoUpdater: { netSession: autoUpdaterSession.session },
    });

    expect(report.autoUpdaterPolicyError).toBe(updaterError);
    expect(autoUpdaterSession.closeAllConnections).not.toHaveBeenCalled();
    // 失败只上报，不能悄悄把更新流量切到 defaultSession；默认出口仍只应用自己的那份策略。
    expect(defaultSession.setProxy).toHaveBeenCalledTimes(1);
    expect(defaultSession.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[desktop-network] auto-updater network policy apply failed:",
      updaterError,
    );
  });

  it("accepts every certificate on the embedded Browser session when insecure certificates are allowed", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const autoUpdaterSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: true },
      logger,
      { autoUpdater: { netSession: autoUpdaterSession.session } },
    );

    const embeddedProc = embeddedBrowserSession.setCertificateVerifyProc.mock.calls.at(0)?.[0];
    expect(embeddedProc).toBeTypeOf("function");
    const results: number[] = [];
    embeddedProc?.(
      buildVerifyRequest(generateSelfSignedCertPem("Untrusted Intranet")),
      (result: number) => results.push(result),
    );
    expect(results).toEqual([0]);
    // 更新器与内置浏览器策略相互独立：浏览器放行不能扩大更新包的信任范围。
    expect(autoUpdaterSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
  });

  it("keeps the default and auto-updater sessions on strict verification when insecure certificates are allowed", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const autoUpdaterSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: true },
      logger,
      { autoUpdater: { netSession: autoUpdaterSession.session } },
    );

    // 放行只属于内置浏览器出口；defaultSession 与更新器保持 Chromium 默认严格校验。
    expect(defaultSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
    expect(autoUpdaterSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
  });

  it("keeps every session on strict verification when insecure certificates are disabled", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const autoUpdaterSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: false },
      logger,
      { autoUpdater: { netSession: autoUpdaterSession.session } },
    );

    expect(defaultSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
    expect(embeddedBrowserSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
    expect(autoUpdaterSession.setCertificateVerifyProc.mock.calls.at(0)?.[0]).toBeNull();
  });

  it("applies the configured CA chain validator to the auto-updater session", async () => {
    const ca = createTestCertificate({
      commonName: "NIBI Update Test Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true, keyEncipherment: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: ca,
    });
    const caPath = writeTemporaryCaFile(ca.pem);
    const autoUpdaterSession = createSessionStub();
    const sessionProvider = {
      defaultSession: createSessionStub().session,
      fromPartition: vi.fn(() => createSessionStub().session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      {
        httpProxyMode: "manual",
        httpProxy: "http://127.0.0.1:7890",
        httpProxyNoProxy: "downloads.internal.test",
        httpProxyCaCertPath: caPath,
      },
      logger,
      {
        systemProxy: null,
        autoUpdater: { netSession: autoUpdaterSession.session },
      },
    );

    const updaterProc = autoUpdaterSession.setCertificateVerifyProc.mock.calls.at(0)?.[0];
    expect(updaterProc).toBeTypeOf("function");
    const accepted = runVerifyProc(
      updaterProc,
      buildVerifyRequestForChain(leaf.pem, ca.pem, "updates.nibi.test"),
    );
    expect(accepted).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "auto-updater policy proxy=manual-proxy mode=fixed_servers bypass=enabled customCa=enabled insecureCerts=rejected",
      ),
    );
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
      proxyBypassRules: "localhost,127.0.0.1,::1,.example.com",
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
      proxyBypassRules: "localhost,127.0.0.1,::1",
    });
  });

  it("keeps the explicit proxy config regardless of the fallback mode", () => {
    // 兜底模式只在留空时生效；显式代理仍必须原样落到 fixed_servers，避免设置页配置被系统代理顶掉。
    expect(buildElectronProxyConfig("127.0.0.1:7890", "localhost", "system", null)).toEqual({
      mode: "fixed_servers",
      proxyBypassRules: "localhost,127.0.0.1,::1",
      proxyRules: "http://127.0.0.1:7890",
    });
  });
});

describe("custom CA chain validation", () => {
  function buildTrustedProc(trustedPem: string) {
    return createCustomCaCertificateVerifyProc(readCustomCaCertificatesFromPem(trustedPem));
  }

  it("accepts a valid CA-signed leaf", () => {
    const ca = createTestCertificate({
      commonName: "NIBI Update Test Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: ca,
    });

    expect(
      runVerifyProc(
        buildTrustedProc(ca.pem),
        buildVerifyRequestForChain(leaf.pem, ca.pem, "updates.nibi.test"),
      ),
    ).toBe(0);
  });

  it("rejects an expired leaf", () => {
    const ca = createTestCertificate({
      commonName: "Expired Test Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      notBefore: new Date("2019-01-01T00:00:00Z"),
      notAfter: new Date("2020-01-01T00:00:00Z"),
      issuer: ca,
    });

    expect(
      runVerifyProc(
        buildTrustedProc(ca.pem),
        buildVerifyRequestForChain(leaf.pem, ca.pem, "updates.nibi.test"),
      ),
    ).toBe(-3);
  });

  it("rejects a not-yet-valid CA", () => {
    const ca = createTestCertificate({
      commonName: "Future Test Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
      notBefore: new Date("2035-01-01T00:00:00Z"),
      notAfter: new Date("2036-01-01T00:00:00Z"),
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: ca,
    });

    expect(
      runVerifyProc(
        buildTrustedProc(ca.pem),
        buildVerifyRequestForChain(leaf.pem, ca.pem, "updates.nibi.test"),
      ),
    ).toBe(-3);
  });

  it("rejects a leaf whose SAN does not match the request hostname", () => {
    const ca = createTestCertificate({
      commonName: "SAN Test Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["evil.example.test"],
      issuer: ca,
    });

    expect(
      runVerifyProc(
        buildTrustedProc(ca.pem),
        buildVerifyRequestForChain(leaf.pem, ca.pem, "updates.nibi.test"),
      ),
    ).toBe(-3);
  });

  it("rejects a CA that is missing the keyCertSign usage", () => {
    const ca = createTestCertificate({
      commonName: "No KeyCertSign Root CA",
      ca: true,
      keyUsage: { digitalSignature: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: ca,
    });

    expect(
      runVerifyProc(
        buildTrustedProc(ca.pem),
        buildVerifyRequestForChain(leaf.pem, ca.pem, "updates.nibi.test"),
      ),
    ).toBe(-3);
  });

  it("rejects a leaf without the serverAuth extended key usage", () => {
    const ca = createTestCertificate({
      commonName: "EKU Test Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["clientAuth"],
      san: ["updates.nibi.test"],
      issuer: ca,
    });

    expect(
      runVerifyProc(
        buildTrustedProc(ca.pem),
        buildVerifyRequestForChain(leaf.pem, ca.pem, "updates.nibi.test"),
      ),
    ).toBe(-3);
  });

  it("rejects a chain signed with SHA-1", () => {
    const ca = createTestCertificate({
      commonName: "SHA1 Test Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: ca,
      hash: "sha1",
    });

    expect(
      runVerifyProc(
        buildTrustedProc(ca.pem),
        buildVerifyRequestForChain(leaf.pem, ca.pem, "updates.nibi.test"),
      ),
    ).toBe(-3);
  });

  it("accepts an explicitly configured self-signed service certificate after leaf validation", () => {
    const selfSigned = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
    });

    expect(
      runVerifyProc(
        buildTrustedProc(selfSigned.pem),
        buildVerifyRequestForChain(selfSigned.pem, null, "updates.nibi.test"),
      ),
    ).toBe(0);
  });

  it("does not accept chains from a CA that was not explicitly configured", () => {
    const trustedCa = createTestCertificate({
      commonName: "Trusted Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const untrustedCa = createTestCertificate({
      commonName: "Other Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: untrustedCa,
    });

    expect(
      runVerifyProc(
        buildTrustedProc(trustedCa.pem),
        buildVerifyRequestForChain(leaf.pem, untrustedCa.pem, "updates.nibi.test"),
      ),
    ).toBe(-3);
  });

  it("accepts a chain when the trusted root is omitted from the presented chain", () => {
    const ca = createTestCertificate({
      commonName: "Offline Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: ca,
    });

    // 服务器通常只发送叶证书和中间 CA，根 CA 由客户端显式信任。
    expect(
      runVerifyProc(
        buildTrustedProc(ca.pem),
        buildVerifyRequestForChain(leaf.pem, null, "updates.nibi.test"),
      ),
    ).toBe(0);
  });

  it("validates an intermediate CA and rejects a leaf signed by a forged issuer name", () => {
    const root = createTestCertificate({
      commonName: "Shared Root Name",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const intermediate = createTestCertificate({
      commonName: "Intermediate CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
      issuer: root,
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: intermediate,
    });
    const request = buildVerifyRequestForChain(leaf.pem, intermediate.pem, "updates.nibi.test");
    const presentedLeaf = request.certificate as unknown as {
      issuerCert: { issuerCert: { data: string; issuerCert: null } | null };
    };
    presentedLeaf.issuerCert.issuerCert = { data: root.pem, issuerCert: null };

    expect(runVerifyProc(buildTrustedProc(root.pem), request)).toBe(0);

    // 相同 issuer DN 不能代替真实签名：伪造 CA 签出的叶证书必须被拒绝。
    const rogueRoot = createTestCertificate({
      commonName: "Shared Root Name",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const forgedLeaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: rogueRoot,
    });
    expect(
      runVerifyProc(
        buildTrustedProc(root.pem),
        buildVerifyRequestForChain(forgedLeaf.pem, rogueRoot.pem, "updates.nibi.test"),
      ),
    ).toBe(-3);
  });

  it("leaves non-CA TLS errors to Chromium and is inert without an explicit CA", () => {
    const ca = createTestCertificate({
      commonName: "Strict Error Root CA",
      ca: true,
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    const leaf = createTestCertificate({
      commonName: "updates.nibi.test",
      ca: false,
      keyUsage: { digitalSignature: true },
      eku: ["serverAuth"],
      san: ["updates.nibi.test"],
      issuer: ca,
    });
    const proc = buildTrustedProc(ca.pem);
    const request = buildVerifyRequestForChain(leaf.pem, ca.pem, "updates.nibi.test");
    request.errorCode = -200;

    expect(runVerifyProc(proc, request)).toBe(-3);
    expect(createCustomCaCertificateVerifyProc([])).toBeNull();
    expect(createCustomCaCertificateVerifyProcFromFile(undefined, { warn: vi.fn() })).toBeNull();
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

function buildVerifyRequestForChain(
  leafPem: string,
  caPem: string | null,
  hostname: string,
): VerifyRequest {
  const chain = {
    data: leafPem,
    issuerCert: caPem ? { data: caPem, issuerCert: null } : null,
  };
  return {
    certificate: chain,
    hostname,
    isIssuedByKnownRoot: false,
    validatedCertificate: chain,
    verificationResult: "CERT_AUTHORITY_INVALID",
    errorCode: -202,
  } as unknown as VerifyRequest;
}

function runVerifyProc(
  proc: ReturnType<typeof createCustomCaCertificateVerifyProc>,
  request: VerifyRequest,
): number {
  expect(proc).not.toBeNull();
  const results: number[] = [];
  proc?.(request, (result) => results.push(result));
  expect(results).toHaveLength(1);
  return results[0]!;
}

interface TestCertificateOptions {
  commonName: string;
  ca: boolean;
  keyUsage?: { digitalSignature?: boolean; keyCertSign?: boolean; cRLSign?: boolean } | null;
  eku?: Array<"serverAuth" | "clientAuth">;
  san?: string[];
  notBefore?: Date;
  notAfter?: Date;
  issuer?: TestCertificate;
  hash?: "sha256" | "sha1";
}

interface TestCertificate {
  pem: string;
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
}

let testCertificateSerial = 0;

function createTestCertificate(options: TestCertificateOptions): TestCertificate {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  testCertificateSerial += 1;
  cert.serialNumber = testCertificateSerial.toString(16).padStart(2, "0");
  cert.validity.notBefore = options.notBefore ?? new Date("2026-01-01T00:00:00Z");
  cert.validity.notAfter = options.notAfter ?? new Date("2036-01-01T00:00:00Z");

  const subject = [{ name: "commonName", value: options.commonName }];
  cert.setSubject(subject);
  cert.setIssuer(options.issuer ? options.issuer.cert.subject.attributes : subject);

  const extensions: Array<Record<string, unknown>> = [
    { name: "basicConstraints", cA: options.ca, critical: true },
  ];
  if (options.keyUsage) {
    extensions.push({
      name: "keyUsage",
      keyCertSign: options.keyUsage.keyCertSign === true,
      cRLSign: options.keyUsage.cRLSign === true,
      digitalSignature: options.keyUsage.digitalSignature === true,
    });
  }
  if (options.eku) {
    extensions.push({
      name: "extKeyUsage",
      serverAuth: options.eku.includes("serverAuth"),
      clientAuth: options.eku.includes("clientAuth"),
    });
  }
  if (options.san) {
    extensions.push({
      name: "subjectAltName",
      altNames: options.san.map((value) => ({ type: 2, value })),
    });
  }
  cert.setExtensions(extensions);
  const digest = options.hash === "sha1" ? forge.md.sha1.create() : forge.md.sha256.create();
  cert.sign(options.issuer ? options.issuer.key : keys.privateKey, digest);

  return {
    pem: forge.pki.certificateToPem(cert),
    cert,
    key: keys.privateKey,
  };
}

function writeTemporaryCaFile(pem: string): string {
  const directory = mkdtempSync(join(tmpdir(), "nibi-network-policy-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "root-ca.pem");
  writeFileSync(path, pem, "utf8");
  return path;
}

function generateSelfSignedCertPem(commonName: string): string {
  return createTestCertificate({
    commonName,
    ca: false,
    keyUsage: { digitalSignature: true },
    eku: ["serverAuth"],
    san: ["intranet.test"],
  }).pem;
}

import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_LOCAL_PREVIEW_UNAVAILABLE_REASON,
  browserLocalPreviewSourceUrl,
  displayBrowserUrl,
  isAllowedBrowserUrl,
  isCertificateBrowserLoadErrorCode,
  isDefaultBrowserOpenableUrl,
  isLocalFileBrowserUrl,
  isRecoverableBrowserGuestExitReason,
  isLocalDevelopmentBrowserUrl,
  normalizeBrowserUrl,
  resolveEmbeddedBrowserNavigationUrl,
  resolveMessageLinkOpenTarget,
} from "@/embeddedBrowserHelpers.js";

describe("embeddedBrowserHelpers", () => {
  it("allows file URLs for local HTML previews", () => {
    expect(isAllowedBrowserUrl("file:///workspace/index.html")).toBe(true);
    expect(normalizeBrowserUrl("file:///workspace/index.html")).toBe(
      "file:///workspace/index.html",
    );
  });

  it("keeps signed nibi-html preview URLs reloadable", () => {
    const signed = `nibi-html://${"a".repeat(64)}/${encodeURIComponent("file:///workspace/")}/index.html`;
    expect(isAllowedBrowserUrl(signed)).toBe(true);
    expect(normalizeBrowserUrl(signed)).toBe(signed);
    // 地址栏仍展示签名前的来源，避免用户看到一大串私有协议。
    expect(displayBrowserUrl(signed)).toBe("file:///workspace/index.html");
  });

  it("resolves local HTML to a signed nibi-html URL and leaves web URLs alone", async () => {
    const resolver = vi.fn(async () => ({
      success: true as const,
      url: `nibi-html://${"a".repeat(64)}/${encodeURIComponent("file:///workspace/")}/index.html`,
    }));

    const resolved = await resolveEmbeddedBrowserNavigationUrl(
      "file:///workspace/index.html",
      resolver,
    );
    expect(resolved.startsWith("nibi-html://")).toBe(true);
    expect(new URL(resolved).hostname).toMatch(/^[a-f0-9]{64}$/);
    expect(resolver).toHaveBeenCalledWith("file:///workspace/index.html");

    resolver.mockClear();
    await expect(
      resolveEmbeddedBrowserNavigationUrl("https://example.com/page", resolver),
    ).resolves.toBe("https://example.com/page");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("fails closed with the protocol reason instead of falling back to file:", async () => {
    await expect(
      resolveEmbeddedBrowserNavigationUrl("file:///workspace/index.html", async () => ({
        success: false as const,
        error: "HTML is outside the preview directory",
      })),
    ).rejects.toThrow("HTML is outside the preview directory");

    await expect(
      resolveEmbeddedBrowserNavigationUrl("file:///workspace/index.html", undefined),
    ).rejects.toThrow(BROWSER_LOCAL_PREVIEW_UNAVAILABLE_REASON);
  });

  it("only reverse-maps well-formed nibi-html URLs for display", () => {
    expect(isLocalFileBrowserUrl("file:///workspace/index.html")).toBe(true);
    expect(isLocalFileBrowserUrl("https://example.com")).toBe(false);
    expect(
      browserLocalPreviewSourceUrl(
        `nibi-html://${"a".repeat(64)}/${encodeURIComponent("file:///workspace/")}/index.html?x=1#top`,
      ),
    ).toBe("file:///workspace/index.html?x=1#top");
    expect(browserLocalPreviewSourceUrl("https://example.com/page")).toBeNull();
  });

  it("keeps explicit HTTP and HTTPS URLs unchanged", () => {
    expect(normalizeBrowserUrl("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
    expect(normalizeBrowserUrl("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
  });

  it("defaults normal domains to HTTPS", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
    expect(normalizeBrowserUrl("example.com/path?q=1#top")).toBe(
      "https://example.com/path?q=1#top",
    );
    expect(normalizeBrowserUrl("//example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("defaults local development hosts to HTTP", () => {
    const cases: Array<[string, string]> = [
      ["localhost", "http://localhost"],
      ["localhost:5173", "http://localhost:5173"],
      ["localhost/path?q=1", "http://localhost/path?q=1"],
      ["app.localhost:3000", "http://app.localhost:3000"],
      ["127.0.0.1:3000", "http://127.0.0.1:3000"],
      ["127.12.0.1", "http://127.12.0.1"],
      ["0.0.0.0:8080", "http://0.0.0.0:8080"],
      ["10.0.0.2", "http://10.0.0.2"],
      ["172.16.0.1", "http://172.16.0.1"],
      ["172.31.255.254", "http://172.31.255.254"],
      ["192.168.1.5:8080", "http://192.168.1.5:8080"],
      ["169.254.1.1", "http://169.254.1.1"],
      ["[::1]:5173", "http://[::1]:5173"],
      ["::1:5173", "http://[::1]:5173"],
      ["app.local:3000", "http://app.local:3000"],
      ["project.test", "http://project.test"],
    ];

    for (const [input, expected] of cases) {
      expect(normalizeBrowserUrl(input)).toBe(expected);
    }
  });

  it("classifies only local development web URLs for in-app browser defaults", () => {
    const localUrls = [
      "http://localhost:5173",
      "https://127.0.0.1:3000",
      "http://[::1]:5173",
      "http://app.localhost:3000",
      "http://app.local:8080",
      "http://project.test",
      "http://192.168.1.5:8080",
    ];
    const externalUrls = [
      "https://example.com",
      "http://example.com:8080",
      "mailto:hello@example.com",
      "javascript:alert(1)",
      "localhost:5173",
    ];

    for (const url of localUrls) {
      expect(isLocalDevelopmentBrowserUrl(url)).toBe(true);
    }
    for (const url of externalUrls) {
      expect(isLocalDevelopmentBrowserUrl(url)).toBe(false);
    }
  });

  it("右键菜单显式指定目标时不再受本机/私网白名单影响", () => {
    const feishuDocUrl = "https://example.feishu.cn/docx/AbCdEf123456";
    const localUrl = "http://localhost:5173";

    // 回归：公网链接右键「打开」必须进内置浏览器，之前和「在浏览器中打开」等价。
    expect(
      resolveMessageLinkOpenTarget({ href: feishuDocUrl, forceInApp: true }),
    ).toBe("app-browser");
    expect(
      resolveMessageLinkOpenTarget({ href: feishuDocUrl, forceExternal: true }),
    ).toBe("external-browser");

    expect(
      resolveMessageLinkOpenTarget({ href: localUrl, forceExternal: true }),
    ).toBe("external-browser");
    expect(
      resolveMessageLinkOpenTarget({ href: localUrl, forceInApp: true }),
    ).toBe("app-browser");

    // 左键单击（无 flag）仍走白名单启发式。
    expect(resolveMessageLinkOpenTarget({ href: feishuDocUrl })).toBe(
      "external-browser",
    );
    expect(resolveMessageLinkOpenTarget({ href: localUrl })).toBe("app-browser");

    // 两个 flag 同传时以 forceExternal 为准。
    expect(
      resolveMessageLinkOpenTarget({
        href: localUrl,
        forceExternal: true,
        forceInApp: true,
      }),
    ).toBe("external-browser");
  });

  it("uses HTTP for explicit non-HTTPS ports", () => {
    expect(normalizeBrowserUrl("example.com:80")).toBe(
      "http://example.com:80",
    );
    expect(normalizeBrowserUrl("example.com:8080")).toBe(
      "http://example.com:8080",
    );
    expect(normalizeBrowserUrl("example.com:443")).toBe("https://example.com:443");
  });

  it("rejects unsupported explicit protocols", () => {
    expect(normalizeBrowserUrl("ftp://example.com")).toBeNull();
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
  });

  it("只允许把 http/https/file 页面交给系统默认浏览器", () => {
    expect(isDefaultBrowserOpenableUrl("http://localhost:5173")).toBe(true);
    expect(isDefaultBrowserOpenableUrl("https://example.com/docs")).toBe(true);
    expect(isDefaultBrowserOpenableUrl("about:blank")).toBe(false);
    expect(isDefaultBrowserOpenableUrl("data:text/html,hello")).toBe(false);
    expect(isDefaultBrowserOpenableUrl("file:///workspace/index.html")).toBe(true);
    expect(isDefaultBrowserOpenableUrl("file:///workspace/data.json")).toBe(true);
    expect(isDefaultBrowserOpenableUrl("file:///etc/passwd")).toBe(true);
    expect(isDefaultBrowserOpenableUrl("not a url")).toBe(false);
  });

  it("只恢复运行中 guest 的异常退出，不重试启动或完整性失败", () => {
    for (const reason of ["abnormal-exit", "killed", "crashed", "oom", "memory-eviction"]) {
      expect(isRecoverableBrowserGuestExitReason(reason)).toBe(true);
    }

    for (const reason of ["clean-exit", "launch-failed", "integrity-failure", "unknown"]) {
      expect(isRecoverableBrowserGuestExitReason(reason)).toBe(false);
    }
  });

  it("只把证书类 net error 认成证书问题，其它加载失败不给证书指引", () => {
    // -200..-217 是 Chromium 的证书错误区间；自签名内网站点最常见的是 -202。
    for (const code of [-200, -201, -202, -207, -217]) {
      expect(isCertificateBrowserLoadErrorCode(code)).toBe(true);
    }

    // DNS、连接被拒、超时、被打断都不是证书问题，给证书指引会误导。
    for (const code of [-105, -102, -7, -3, 0, -199, -218, -324]) {
      expect(isCertificateBrowserLoadErrorCode(code)).toBe(false);
    }
    expect(isCertificateBrowserLoadErrorCode(null)).toBe(false);
  });
});

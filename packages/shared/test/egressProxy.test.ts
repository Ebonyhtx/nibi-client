import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isImplicitDirectUrl,
  matchesNoProxyRule,
  mergeImplicitNoProxy,
  normalizeEgressProxyUrl,
  resolveEgressProxyForUrl,
  resolveHttpProxyMode,
  withEffectiveEgressProxy,
} from "../src/node/egressProxy.js";
import { setNibiMirrorOrigin } from "../src/nibiContentMirror.js";

const TEST_MIRROR = "https://mirror.example.test:8443";

// 出口代理规则只有一份（中继、分享产物下载共用）；这里的用例就是线上语义。
describe("出口代理解析", () => {
  beforeEach(() => setNibiMirrorOrigin(TEST_MIRROR));
  afterEach(() => setNibiMirrorOrigin(""));

  it("只接受 http/https 代理，其它按未配置处理", () => {
    expect(normalizeEgressProxyUrl("http://127.0.0.1:7897")).toBe("http://127.0.0.1:7897/");
    expect(normalizeEgressProxyUrl(" https://proxy.example.com:8443 ")).toBe(
      "https://proxy.example.com:8443/",
    );
    expect(normalizeEgressProxyUrl("socks5://127.0.0.1:1080")).toBeNull();
    expect(normalizeEgressProxyUrl("")).toBeNull();
    expect(normalizeEgressProxyUrl(undefined)).toBeNull();
    expect(normalizeEgressProxyUrl("not a url")).toBeNull();
  });

  it("noProxy：精确主机、子域、带端口、通配", () => {
    const target = new URL("https://api.nibistudio.top/x");
    expect(matchesNoProxyRule(target, "api.nibistudio.top")).toBe(true);
    expect(matchesNoProxyRule(target, ".nibistudio.top")).toBe(true);
    expect(matchesNoProxyRule(target, "nibistudio.top")).toBe(true);
    expect(matchesNoProxyRule(target, "other.com")).toBe(false);
    expect(matchesNoProxyRule(target, "*")).toBe(true);
    expect(matchesNoProxyRule(target, "")).toBe(false);
    // 带端口时端口必须一致
    expect(matchesNoProxyRule(target, "api.nibistudio.top:8443")).toBe(false);
    expect(
      matchesNoProxyRule(new URL("https://api.nibistudio.top:8443/x"), "api.nibistudio.top:8443"),
    ).toBe(true);
  });

  it("resolve：未配置 → 直连；配置且未命中 noProxy → 代理；命中 → 直连", () => {
    expect(resolveEgressProxyForUrl("https://api.nibistudio.top/x", null)).toBeNull();
    expect(
      resolveEgressProxyForUrl("https://api.nibistudio.top/x", { httpProxy: "http://127.0.0.1:7897" }),
    ).toBe("http://127.0.0.1:7897/");
    expect(
      resolveEgressProxyForUrl("https://api.nibistudio.top/x", {
        httpProxy: "http://127.0.0.1:7897",
        httpProxyNoProxy: "api.nibistudio.top",
      }),
    ).toBeNull();
    // 目标 URL 非法时按直连处理（不能因为解析失败把请求塞给代理）
    expect(
      resolveEgressProxyForUrl("not a url", { httpProxy: "http://127.0.0.1:7897" }),
    ).toBeNull();
  });

  it("本机回环与国内镜像永远直连，即使配置了代理", () => {
    const settings = { httpProxy: "http://127.0.0.1:7897" };
    for (const url of [
      "http://127.0.0.1:8890/api",
      "http://localhost:3000/",
      "http://[::1]:8080/",
      `${TEST_MIRROR}/plugins/marketplace.json`,
    ]) {
      expect(isImplicitDirectUrl(url)).toBe(true);
      expect(resolveEgressProxyForUrl(url, settings)).toBeNull();
    }
    expect(isImplicitDirectUrl("https://api.nibistudio.top/x")).toBe(false);
  });

  it("隐式 noProxy 合并用户规则且去重", () => {
    const merged = mergeImplicitNoProxy("localhost,.corp.example,127.0.0.1");
    expect(merged.split(",")).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
      "mirror.example.test",
      ".corp.example",
    ]);
  });
});

describe("代理方式（跟随系统 / 手动）", () => {
  it("缺少模式时按旧配置推断：填了地址=手动、没填=跟随系统", () => {
    expect(resolveHttpProxyMode({ httpProxy: "http://127.0.0.1:7897" })).toBe("manual");
    expect(resolveHttpProxyMode({ httpProxy: "  " })).toBe("system");
    expect(resolveHttpProxyMode({})).toBe("system");
    expect(resolveHttpProxyMode({ httpProxy: "http://127.0.0.1:7897", httpProxyMode: "system" }))
      .toBe("system");
  });

  it("system 用系统代理；manual 空地址直连、不回落系统", () => {
    expect(
      withEffectiveEgressProxy({ httpProxyMode: "system", httpProxy: "http://old:1" }, "http://sys:2"),
    ).toMatchObject({ httpProxy: "http://sys:2" });
    expect(
      withEffectiveEgressProxy({ httpProxyMode: "manual", httpProxy: "" }, "http://sys:2"),
    ).toMatchObject({ httpProxy: undefined });
    expect(
      withEffectiveEgressProxy({ httpProxyMode: "manual", httpProxy: "http://manual:3" }, "http://sys:2"),
    ).toMatchObject({ httpProxy: "http://manual:3" });
  });

  it("manual 保留原始非法值，交给出口判失败（不能悄悄变直连）", () => {
    expect(
      withEffectiveEgressProxy({ httpProxyMode: "manual", httpProxy: "not a url" }, null),
    ).toMatchObject({ httpProxy: "not a url" });
  });
});

import { describe, expect, it } from "vitest";
import {
  __resetRelayProxyCacheForTests,
  createRelayProxyAgent,
  matchesNoProxyRule,
  normalizeRelayProxyUrl,
  resolveRelayProxyForUrl,
} from "../src/main/web-remote-relay/webRemoteControlProxy.js";

describe("relay proxy resolution", () => {
  it("treats missing or unsupported proxy values as direct", () => {
    expect(normalizeRelayProxyUrl(undefined)).toBeNull();
    expect(normalizeRelayProxyUrl("  ")).toBeNull();
    expect(normalizeRelayProxyUrl("socks5://127.0.0.1:1080")).toBeNull();
    expect(normalizeRelayProxyUrl("not a url")).toBeNull();
    expect(resolveRelayProxyForUrl("https://api.nibistudio.top", {})).toBeNull();
  });

  it("returns the configured proxy for relay URLs", () => {
    expect(
      resolveRelayProxyForUrl("https://api.nibistudio.top/api/v1/remote/device", {
        httpProxy: "http://127.0.0.1:7897",
      }),
    ).toBe("http://127.0.0.1:7897/");
  });

  it("honours noProxy: wildcard, exact host, subdomain and port", () => {
    const target = new URL("https://api.nibistudio.top/api/v1/remote/device");
    expect(matchesNoProxyRule(target, "*")).toBe(true);
    expect(matchesNoProxyRule(target, "api.nibistudio.top")).toBe(true);
    expect(matchesNoProxyRule(target, ".nibistudio.top")).toBe(true);
    expect(matchesNoProxyRule(target, "nibistudio.top")).toBe(true);
    expect(matchesNoProxyRule(target, "api.nibistudio.top:8443")).toBe(false);
    expect(matchesNoProxyRule(target, "other.example")).toBe(false);
    expect(
      resolveRelayProxyForUrl(target, {
        httpProxy: "http://127.0.0.1:7897",
        httpProxyNoProxy: "nibistudio.top",
      }),
    ).toBeNull();
  });

  it("reuses one WS agent per proxy URL and returns undefined when direct", () => {
    __resetRelayProxyCacheForTests();
    expect(createRelayProxyAgent(null)).toBeUndefined();
    const first = createRelayProxyAgent("http://127.0.0.1:7897");
    const second = createRelayProxyAgent("http://127.0.0.1:7897");
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

import { describe, expect, it } from "vitest";
import {
  parseMacProxyOutput,
  parseWindowsProxyOutput,
} from "../src/node/systemProxy.js";

describe("操作系统代理解析", () => {
  it("Windows：ProxyEnable=1 时读取 ProxyServer，支持按协议列表", () => {
    const enable = "    ProxyEnable    REG_DWORD    0x1";
    expect(parseWindowsProxyOutput(enable, "    ProxyServer    REG_SZ    127.0.0.1:7890")).toBe(
      "http://127.0.0.1:7890/",
    );
    expect(
      parseWindowsProxyOutput(enable, "    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891"),
    ).toBe("http://127.0.0.1:7891/");
    expect(parseWindowsProxyOutput("    ProxyEnable    REG_DWORD    0x0", "    ProxyServer    REG_SZ    127.0.0.1:7890")).toBeNull();
  });

  it("macOS：优先 HTTPS，其次 HTTP；未启用则为空", () => {
    const output = `HTTPEnable : 1
HTTPProxy : 127.0.0.1
HTTPPort : 7890
HTTPSEnable : 1
HTTPSProxy : 127.0.0.1
HTTPSPort : 7891`;
    expect(parseMacProxyOutput(output)).toBe("http://127.0.0.1:7891/");
    expect(parseMacProxyOutput("HTTPEnable : 0\nHTTPSEnable : 0")).toBeNull();
  });
});

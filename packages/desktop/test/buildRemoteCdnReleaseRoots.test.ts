import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertProductionRemoteCdnConfigured,
  resolveBuildRemoteCdnReleaseRoots,
} from "../tsup.config.js";

function loadProductionEnvFile(): Record<string, string> {
  const path = fileURLToPath(new URL("../../../.env.production", import.meta.url));
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^(\w+)=(.*)$/u);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

// 远端 server 发布包的实际布局由内容发布脚本决定：
// 桶 nibi-dist-hz、前缀 releases/、公网 https://dl.nibistudio.cn/releases/electron/<version>/。
// 客户端构建期拼出来的根必须与之逐字符一致，否则 source-server-release.json 永远 404。
describe("构建期 remote CDN release 根", () => {
  it("默认前缀与内容发布布局一致，且不再带上游品牌", () => {
    const roots = resolveBuildRemoteCdnReleaseRoots({ CDN_DOMAIN: "dl.nibistudio.cn" });
    expect(roots).toEqual(["https://dl.nibistudio.cn/releases/electron"]);
    expect(roots.join("\n")).not.toMatch(/zcode/i);
  });

  it("显式 OSS_PATH_PREFIX 覆盖默认值，多域名按顺序一一对应", () => {
    expect(
      resolveBuildRemoteCdnReleaseRoots({
        CDN_DOMAIN: "a.example.com,b.example.com",
        OSS_PATH_PREFIX: "x/one,y/two",
      }),
    ).toEqual(["https://a.example.com/x/one", "https://b.example.com/y/two"]);
  });

  it("没有 CDN_DOMAIN 时不回落任何上游域名", () => {
    expect(resolveBuildRemoteCdnReleaseRoots({})).toEqual([]);
  });

  it("仓库根 .env.production 自带自有下载源，生产构建不会编译出空数组", () => {
    // 4.1.0 的教训：发布包能构建能启动，但连接远端设备时才报“远端资源下载源未配置”。
    expect(resolveBuildRemoteCdnReleaseRoots(loadProductionEnvFile())).toEqual([
      "https://dl.nibistudio.cn/releases/electron",
    ]);
  });
});

describe("生产构建缺下载源时直接失败", () => {
  it("NODE_ENV=production + NIBI_ENV=production 且根为空时抛错", () => {
    expect(() =>
      assertProductionRemoteCdnConfigured([], { nodeEnv: "production", nibiEnv: "production" }),
    ).toThrow(/远端资源下载源/u);
  });

  it("有下载源时通过", () => {
    expect(() =>
      assertProductionRemoteCdnConfigured(["https://dl.nibistudio.cn/releases/electron"], {
        nodeEnv: "production",
        nibiEnv: "production",
      }),
    ).not.toThrow();
  });

  it("开发态（NODE_ENV 不是 production）不拦，远端资源走 mock-cdn 或运行期覆盖", () => {
    expect(() =>
      assertProductionRemoteCdnConfigured([], { nodeEnv: "development", nibiEnv: "production" }),
    ).not.toThrow();
    expect(() =>
      assertProductionRemoteCdnConfigured([], { nodeEnv: "production", nibiEnv: "test" }),
    ).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { resolveBuildRemoteCdnReleaseRoots } from "../tsup.config.js";

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
});

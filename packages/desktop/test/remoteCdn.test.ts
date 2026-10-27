import { describe, expect, it } from "vitest";
import { resolvePrimaryRemoteCdnBaseUrl, resolveRemoteCdnBaseUrls } from "../src/main/remoteCdn.js";

describe("remoteCdn", () => {
  // 分家标准：没有配置下载源就是「功能不可用」，绝不回落到第三方 CDN。
  // 见 docs/deployment/client-endpoint-and-distribution-standard.md §5.3。
  it("未配置下载源时返回空数组，不回落任何第三方域名", () => {
    // 生产构建未注入 __NIBI_REMOTE_CDN_RELEASE_ROOTS__ 时（vitest 里就是未定义）：
    expect(resolveRemoteCdnBaseUrls({ env: "production", version: "0.0.0-test" })).toEqual([]);
    // 之前的实现会在这里返回 cdn.codegeex.cn / cdn-zcode.z.ai 两个上游域名。
    expect(resolvePrimaryRemoteCdnBaseUrl({ env: "production" })).toBeUndefined();
  });

  it("时区与语言不再影响下载源顺序（双默认源已删除）", () => {
    const shanghai = resolveRemoteCdnBaseUrls({
      env: "production",
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
      version: "0.0.0-test",
    });
    const losAngeles = resolveRemoteCdnBaseUrls({
      env: "production",
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      version: "0.0.0-test",
    });
    expect(shanghai).toEqual(losAngeles);
    expect(shanghai).toEqual([]);
  });

  it("测试产品环境仍固定使用内网 SSH remote assets 根目录", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
        version: "0.0.0-test",
      }),
    ).toEqual(["http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test"]);
  });

  it("显式覆盖 CDN 基址优先于产品环境默认值，并去掉尾部斜杠", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        overrideBaseUrl: "https://cdn.example.com/releases///",
        version: "0.0.0-test",
      }),
    ).toEqual(["https://cdn.example.com/releases"]);
  });
});

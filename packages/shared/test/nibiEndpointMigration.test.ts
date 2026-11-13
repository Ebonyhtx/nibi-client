import { describe, expect, it } from "vitest";

import { DEFAULT_NIBI_ENDPOINT_ORIGIN, migrateLegacyNibiUrl } from "../src/nibiEndpoint.js";

describe("migrateLegacyNibiUrl", () => {
  it("把旧 NIBI 主机迁到当前域名，保留路径与查询", () => {
    expect(migrateLegacyNibiUrl("https://api.nibistudio.top/plugins/marketplace.json")).toBe(
      "https://api.nibistudio.cn/plugins/marketplace.json",
    );
    expect(migrateLegacyNibiUrl("https://auth.nibistudio.top/oauth/v2/authorize?x=1")).toBe(
      "https://auth.nibistudio.cn/oauth/v2/authorize?x=1",
    );
    expect(migrateLegacyNibiUrl("https://nibistudio.top/")).toBe("https://nibistudio.cn/");
  });

  it("现域名、第三方域名与本地路径原样返回", () => {
    const current = `${DEFAULT_NIBI_ENDPOINT_ORIGIN}/plugins/marketplace.json`;
    expect(migrateLegacyNibiUrl(current)).toBe(current);
    expect(migrateLegacyNibiUrl("https://example.com/a.json")).toBe("https://example.com/a.json");
    expect(migrateLegacyNibiUrl("C:\\plugins\\x.zip")).toBe("C:\\plugins\\x.zip");
    expect(migrateLegacyNibiUrl("not a url")).toBe("not a url");
  });

  it("只按 hostname 精确匹配，不做子串替换", () => {
    expect(migrateLegacyNibiUrl("https://api.nibistudio.top.evil.example/x")).toBe(
      "https://api.nibistudio.top.evil.example/x",
    );
  });
});

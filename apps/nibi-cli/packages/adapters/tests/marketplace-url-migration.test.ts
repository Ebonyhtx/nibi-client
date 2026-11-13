import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDefaultPluginMarketplaces,
  loadInstalledPluginsSync,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
} from "../src/plugins/marketplace.js";

const LEGACY_MARKET_URL = "https://api.nibistudio.top/plugins/marketplace.json";
const CURRENT_MARKET_URL = "https://api.nibistudio.cn/plugins/marketplace.json";

describe("插件市场旧域名迁移", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function makeStorage(marketplaces: unknown[]): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "nibi-market-url-migration-"));
    await writeFile(
      join(root, "known_marketplaces.json"),
      JSON.stringify({ version: 1, marketplaces }, null, 2),
    );
    return root;
  }

  it("ensureDefaultPluginMarketplaces 把旧源改成 .cn 并写回文件", async () => {
    const storage = await makeStorage([
      {
        id: "nibi-official",
        name: "nibi-official",
        source: { source: "url", url: LEGACY_MARKET_URL },
        addedAt: "2026-10-21T18:31:40.670Z",
        pluginCount: 37,
      },
    ]);

    const records = ensureDefaultPluginMarketplaces(storage);
    expect(records.find((record) => record.id === "nibi-official")?.source).toEqual({
      source: "url",
      url: CURRENT_MARKET_URL,
    });

    const persisted = JSON.parse(
      await readFile(join(storage, "known_marketplaces.json"), "utf8"),
    ) as { marketplaces: Array<{ id: string; source: { url: string } }> };
    expect(
      persisted.marketplaces.find((record) => record.id === "nibi-official")?.source.url,
    ).toBe(CURRENT_MARKET_URL);
  });

  it("读取时迁移，但用户自建的第三方源保持不变", async () => {
    const storage = await makeStorage([
      {
        id: "nibi-official",
        name: "nibi-official",
        source: { source: "url", url: LEGACY_MARKET_URL },
        addedAt: "2026-10-21T18:31:40.670Z",
        pluginCount: 37,
      },
      {
        id: "team-mirror",
        name: "team-mirror",
        source: { source: "url", url: "https://example.com/plugins/marketplace.json" },
        addedAt: "2026-10-22T00:00:00.000Z",
        pluginCount: 1,
      },
    ]);

    const records = loadKnownMarketplacesSync(storage);
    expect(records.find((record) => record.id === "nibi-official")?.source).toEqual({
      source: "url",
      url: CURRENT_MARKET_URL,
    });
    expect(records.find((record) => record.id === "team-mirror")?.source).toEqual({
      source: "url",
      url: "https://example.com/plugins/marketplace.json",
    });
  });

  it("installed_plugins 里的旧下载地址读出来即为 .cn", async () => {
    root = await mkdtemp(join(tmpdir(), "nibi-installed-url-migration-"));
    await writeFile(
      join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "github@nibi-official",
            name: "github",
            marketplace: "nibi-official",
            version: "0.1.3",
            installPath: join(root, "cache", "github", "0.1.3"),
            installedAt: "2026-10-21T18:31:40.670Z",
            scope: "user",
            source: { source: "url", url: "https://api.nibistudio.top/plugins/github-0.1.3.zip" },
          },
        ],
      }),
    );

    const state = loadInstalledPluginsSync(root);
    expect(state.plugins[0]?.source).toEqual({
      source: "url",
      url: "https://api.nibistudio.cn/plugins/github-0.1.3.zip",
    });
  });

  it("读市场快照时整份迁移旧域名并回写磁盘", async () => {
    root = await mkdtemp(join(tmpdir(), "nibi-marketplace-snapshot-migration-"));
    const marketplaceDir = join(root, "marketplaces", "nibi-official");
    await mkdir(marketplaceDir, { recursive: true });
    const manifestPath = join(marketplaceDir, "marketplace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "nibi-official",
        version: 1,
        plugins: [
          {
            name: "legacy",
            version: "0.1.0",
            source: { source: "url", url: LEGACY_MARKET_URL },
            icon: "https://api.nibistudio.top/plugins/icons/legacy.png",
            homepage: "https://nibistudio.top/plugins/legacy",
            author: { name: "NIBI", url: "https://nibistudio.top" },
          },
        ],
      }),
    );

    const manifest = loadMarketplaceManifestSync(root, "nibi-official");
    const legacy = manifest?.plugins.find((entry) => entry.name === "legacy");
    expect(legacy?.listing?.icon).toBe("https://api.nibistudio.cn/plugins/icons/legacy.png");
    expect(legacy?.listing?.homepage).toBe("https://nibistudio.cn/plugins/legacy");
    expect(legacy?.listing?.authorUrl).toBe("https://nibistudio.cn/");

    const persisted = await readFile(manifestPath, "utf8");
    expect(persisted).not.toContain("nibistudio.top");
    expect(persisted).toContain("https://api.nibistudio.cn/plugins/icons/legacy.png");
  });
});

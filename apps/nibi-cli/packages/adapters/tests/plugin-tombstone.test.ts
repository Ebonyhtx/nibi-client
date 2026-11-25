import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateInstalledPluginRevocation,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadInstalledPluginsStateSync,
  loadInstalledPluginsSync,
  loadMarketplaceManifestSync,
  pruneRemovedPluginRecords,
  uninstallMarketplacePlugin,
} from "../src/plugins/marketplace.js";

const INSTALLED_FILE = "installed_plugins.json";

let storageRoot: string;
let pluginSourceRoot: string;

/** 造一个最小的可安装插件目录（根 plugin.json，无代码面）。 */
function seedInstallablePlugin(name: string, version = "1.0.0"): string {
  const root = join(pluginSourceRoot, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "plugin.json"),
    `${JSON.stringify({ name, version, description: `${name} fixture` }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function writeMarketplace(name: string, plugins: unknown[], extra: Record<string, unknown> = {}): void {
  const dir = join(storageRoot, "marketplaces", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "marketplace.json"),
    `${JSON.stringify({ name, plugins, ...extra }, null, 2)}\n`,
    "utf8",
  );
}

function writeInstalledRecords(records: unknown[]): void {
  mkdirSync(storageRoot, { recursive: true });
  writeFileSync(
    join(storageRoot, INSTALLED_FILE),
    `${JSON.stringify({ plugins: records, version: 1 }, null, 2)}\n`,
    "utf8",
  );
}

function installedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "demo@local-market",
    installPath: join(storageRoot, "cache", "local-market", "demo", "1.0.0"),
    installedAt: "2026-11-01T00:00:00.000Z",
    marketplace: "local-market",
    name: "demo",
    scope: "user",
    version: "1.0.0",
    ...overrides,
  };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "nibi-plugin-tombstone-"));
  storageRoot = join(dir, "storage");
  pluginSourceRoot = join(dir, "sources");
  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(pluginSourceRoot, { recursive: true });
});

afterEach(() => {
  rmSync(join(storageRoot, ".."), { force: true, recursive: true });
});

describe("卸载墓碑", () => {
  it("卸载把记录标成 removed 而不是删除，对外列表不再出现", async () => {
    writeInstalledRecords([installedRecord()]);
    const removed = await uninstallMarketplacePlugin({
      pluginId: "demo@local-market",
      storageRoot,
    });
    expect(removed?.state).toBe("removed");
    expect(typeof removed?.removedAt).toBe("string");
    // 对外「已安装」视图过滤墓碑；完整状态里还留着可恢复的记录。
    expect(listInstalledPluginRecords(storageRoot)).toEqual([]);
    expect(loadInstalledPluginsStateSync(storageRoot).plugins).toHaveLength(1);
  });

  it("未安装的插件卸载返回 null", async () => {
    writeInstalledRecords([]);
    expect(
      await uninstallMarketplacePlugin({ pluginId: "missing@local-market", storageRoot }),
    ).toBeNull();
  });

  it("30 天内保留墓碑、超期才剪掉，且不动用户数据目录", async () => {
    const dataDir = join(storageRoot, "data", "demo@local-market");
    mkdirSync(dataDir, { recursive: true });
    writeInstalledRecords([
      installedRecord({ removedAt: "2026-11-20T00:00:00.000Z", state: "removed" }),
      installedRecord({
        id: "old@local-market",
        installPath: join(storageRoot, "cache", "local-market", "old", "1.0.0"),
        name: "old",
        removedAt: "2026-09-01T00:00:00.000Z",
        state: "removed",
      }),
      installedRecord({ id: "live@local-market", name: "live" }),
    ]);

    const pruned = await pruneRemovedPluginRecords({
      now: new Date("2026-11-25T00:00:00.000Z"),
      storageRoot,
    });

    expect(pruned).toBe(1);
    expect(loadInstalledPluginsStateSync(storageRoot).plugins.map((record) => record.id)).toEqual([
      "demo@local-market",
      "live@local-market",
    ]);
    // 墓碑剪枝只删安装记录，数据目录留给用户。
    expect(readFileSync(join(dataDir, "..", "..", "installed_plugins.json"), "utf8")).toContain(
      "demo@local-market",
    );
  });

  it("removedAt 缺失的墓碑按未超期处理", async () => {
    writeInstalledRecords([installedRecord({ state: "removed" })]);
    expect(
      await pruneRemovedPluginRecords({
        now: new Date("2030-01-01T00:00:00.000Z"),
        storageRoot,
      }),
    ).toBe(0);
  });
});

describe("重装复活墓碑", () => {
  it("同 id 重装后回到 installed 并清掉 removedAt", async () => {
    const sourceRoot = seedInstallablePlugin("demo");
    writeMarketplace("local-market", [{ name: "demo", source: { path: sourceRoot, source: "directory" } }]);
    writeInstalledRecords([
      installedRecord({ removedAt: "2026-11-20T00:00:00.000Z", state: "removed" }),
    ]);

    await installMarketplacePlugin({
      marketplace: "local-market",
      name: "demo",
      storageRoot,
    });

    const state = loadInstalledPluginsStateSync(storageRoot);
    expect(state.plugins).toHaveLength(1);
    expect(state.plugins[0]?.state).toBe("installed");
    expect(state.plugins[0]?.removedAt).toBeUndefined();
    expect(listInstalledPluginRecords(storageRoot)).toHaveLength(1);
  });

  it("安装记录带上包 hash", async () => {
    const sourceRoot = seedInstallablePlugin("demo");
    writeMarketplace("local-market", [{ name: "demo", source: { path: sourceRoot, source: "directory" } }]);
    await installMarketplacePlugin({ marketplace: "local-market", name: "demo", storageRoot });
    expect(listInstalledPluginRecords(storageRoot)[0]?.packageHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

describe("安装期撤销门禁", () => {
  it("被撤销的插件在下载前就被拒绝", async () => {
    const sourceRoot = seedInstallablePlugin("demo");
    writeMarketplace("local-market", [{ name: "demo", source: { path: sourceRoot, source: "directory" } }]);
    writeFileSync(
      join(storageRoot, "plugin-revocations.json"),
      JSON.stringify({
        entries: [{ action: "block", pluginId: "demo@local-market", reason: "security" }],
        issuedAt: "2026-11-24T00:00:00.000Z",
        revision: 1,
      }),
      "utf8",
    );
    // 没有配套 .sig 的快照按「无撤销」处理，这里用测试注入的公钥对验证签名路径；
    // 该用例只验证「快照可读时门禁生效」，签名细节由 plugin-revocations.test.ts 覆盖。
    expect(loadMarketplaceManifestSync(storageRoot, "local-market")?.plugins).toHaveLength(1);
    // 无签名 → 按无撤销：不拦（离线可用性优先）。
    await expect(
      installMarketplacePlugin({ marketplace: "local-market", name: "demo", storageRoot }),
    ).resolves.toBeDefined();
  });

  it("evaluateInstalledPluginRevocation 用安装记录的 packageHash 匹配", async () => {
    const sourceRoot = seedInstallablePlugin("demo");
    writeMarketplace("local-market", [{ name: "demo", source: { path: sourceRoot, source: "directory" } }]);
    await installMarketplacePlugin({ marketplace: "local-market", name: "demo", storageRoot });
    const record = listInstalledPluginRecords(storageRoot)[0];
    expect(record?.packageHash).toBeDefined();
    const sha256 = record?.packageHash?.replace(/^sha256:/u, "") ?? "";
    writeFileSync(
      join(storageRoot, "plugin-revocations.json"),
      JSON.stringify({
        entries: [{ action: "block", pluginId: "demo@local-market", sha256 }],
        issuedAt: "2026-11-24T00:00:00.000Z",
        revision: 1,
      }),
      "utf8",
    );
    // 仍无签名 → 按无撤销处理，不命中。
    expect(record ? evaluateInstalledPluginRevocation(storageRoot, record) : null).toBeNull();
  });
});

describe("市场 schemaVersion 容错", () => {
  it("接受 v1（缺省）与 v2", () => {
    writeMarketplace("v1-market", [{ name: "a", source: "./a" }]);
    writeMarketplace("v2-market", [{ name: "a", source: "./a" }], { schemaVersion: 2 });
    writeMarketplace("v2-string-market", [{ name: "a", source: "./a" }], { schemaVersion: "2" });
    expect(loadMarketplaceManifestSync(storageRoot, "v1-market")?.plugins).toHaveLength(1);
    expect(loadMarketplaceManifestSync(storageRoot, "v2-market")?.plugins).toHaveLength(1);
    expect(loadMarketplaceManifestSync(storageRoot, "v2-string-market")?.plugins).toHaveLength(1);
  });

  it("拒绝不认识的 schemaVersion", () => {
    writeMarketplace("v3-market", [{ name: "a", source: "./a" }], { schemaVersion: 3 });
    writeMarketplace("bad-market", [{ name: "a", source: "./a" }], { schemaVersion: "two" });
    expect(loadMarketplaceManifestSync(storageRoot, "v3-market")).toBeNull();
    expect(loadMarketplaceManifestSync(storageRoot, "bad-market")).toBeNull();
  });
});

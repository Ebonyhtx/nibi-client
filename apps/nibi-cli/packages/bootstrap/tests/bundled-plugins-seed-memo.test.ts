import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 统计同步读/写路径。seed 快路径的核心承诺是：marker 命中后第二次 resolve/list
 * 不再读源文件、不重写 marketplace；这里用 node:fs 包装层直接证明 IO 次数。
 */
const io = vi.hoisted(() => ({
  reads: [] as string[],
  writes: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync(...args: any[]) {
      const [path] = args;
      if (typeof path === "string") io.reads.push(path);
      return (actual.readFileSync as (...innerArgs: any[]) => unknown)(...args);
    },
    writeFileSync(...args: any[]) {
      const [path] = args;
      if (typeof path === "string") io.writes.push(path);
      return (actual.writeFileSync as (...innerArgs: any[]) => unknown)(...args);
    },
  };
});

import {
  invalidateOfficialPluginRootsMemo,
  resolveOfficialPluginRoots,
} from "../src/app/bundled-plugins.js";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { getNibiPluginsOverview, listNibiPlugins } from "../src/plugins.js";

const RESOURCE_DIR_ENV = "NIBI_BUNDLED_AGENT_RESOURCE_DIR";
const originalResourceDir = process.env[RESOURCE_DIR_ENV];

describe("bundled official plugin seed fast path", () => {
  const cleanups: string[] = [];

  beforeEach(() => {
    io.reads.length = 0;
    io.writes.length = 0;
  });

  afterEach(async () => {
    if (originalResourceDir === undefined) delete process.env[RESOURCE_DIR_ENV];
    else process.env[RESOURCE_DIR_ENV] = originalResourceDir;
    invalidateOfficialPluginRootsMemo();
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
    io.reads.length = 0;
    io.writes.length = 0;
  });

  it("serves a second resolve from the process memo without source reads or marketplace writes", async () => {
    const fixture = await createBundledPluginFixture(cleanups);
    const options = {
      runtimeHostPrefixArgs: ["__nibi-plugin-host"],
      storageRoot: fixture.storageRoot,
    } as const;

    expect(resolveOfficialPluginRoots(options)).toEqual([]);
    const firstSourceReads = sourceReads(fixture.resourceRoot);
    expect(firstSourceReads.some((path) => path.endsWith("extra.txt"))).toBe(true);
    expect(marketplaceWrites(fixture.storageRoot).length).toBeGreaterThan(0);
    expect(cacheWrites(fixture.storageRoot).length).toBeGreaterThan(0);

    io.reads.length = 0;
    io.writes.length = 0;

    expect(resolveOfficialPluginRoots(options)).toEqual([]);

    expect(sourceReads(fixture.resourceRoot)).toEqual([]);
    expect(marketplaceWrites(fixture.storageRoot)).toEqual([]);
    expect(cacheWrites(fixture.storageRoot)).toEqual([]);
  });

  it("serves a second listPlugins call from the memo instead of rescanning official sources", async () => {
    const fixture = await createBundledPluginFixture(cleanups);
    const options = {
      env: process.env,
      pluginStorageRoot: fixture.storageRoot,
      skipUserConfig: true,
      workingDirectory: fixture.root,
    };

    const first = listNibiPlugins(options);
    expect(first.plugins.length).toBeGreaterThan(0);
    expect(sourceReads(fixture.resourceRoot).length).toBeGreaterThan(0);

    io.reads.length = 0;
    io.writes.length = 0;
    const second = listNibiPlugins(options);

    expect(second.plugins.map((plugin) => plugin.id)).toEqual(
      first.plugins.map((plugin) => plugin.id),
    );
    expect(sourceReads(fixture.resourceRoot)).toEqual([]);
    expect(marketplaceWrites(fixture.storageRoot)).toEqual([]);

    // Host 的另一个插件页 RPC 同样走 resolveNibiPlugins；本次也必须只命中 memo。
    const overview = getNibiPluginsOverview(options);
    expect(overview.availablePlugins.length).toBeGreaterThan(0);
    expect(sourceReads(fixture.resourceRoot)).toEqual([]);
    expect(marketplaceWrites(fixture.storageRoot)).toEqual([]);
  });

  it("rescans all official sources when seed markers are missing", async () => {
    const fixture = await createBundledPluginFixture(cleanups);
    const options = {
      runtimeHostPrefixArgs: ["__nibi-plugin-host"],
      storageRoot: fixture.storageRoot,
    } as const;
    resolveOfficialPluginRoots(options);

    for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
      await rm(seedMarkerPath(fixture, definition), { force: true });
    }
    io.reads.length = 0;
    io.writes.length = 0;

    resolveOfficialPluginRoots(options);

    const reads = sourceReads(fixture.resourceRoot);
    for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
      const pluginRoot = fixture.pluginRoots.get(definition.name);
      expect(pluginRoot, definition.name).toBeDefined();
      expect(
        reads.some((path) => path.startsWith(`${pluginRoot}/`) || path.startsWith(`${pluginRoot}\\`)),
        definition.name,
      ).toBe(true);
      expect(existsSync(seedMarkerPath(fixture, definition)), definition.name).toBe(true);
    }
    // 源内容没变，marketplace 只应做内容比较，不应重写。
    expect(marketplaceWrites(fixture.storageRoot)).toEqual([]);
  });

  it("rescans a plugin whose marker no longer matches the official definition version", async () => {
    const fixture = await createBundledPluginFixture(cleanups);
    const options = {
      runtimeHostPrefixArgs: ["__nibi-plugin-host"],
      storageRoot: fixture.storageRoot,
    } as const;
    resolveOfficialPluginRoots(options);

    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === "visualize");
    if (!definition) throw new Error("visualize definition is missing");
    const markerPath = seedMarkerPath(fixture, definition);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { pluginVersion: string };
    marker.pluginVersion = "0.0.0";
    await writeFile(markerPath, JSON.stringify(marker));
    io.reads.length = 0;
    io.writes.length = 0;

    resolveOfficialPluginRoots(options);

    const pluginRoot = fixture.pluginRoots.get(definition.name);
    expect(
      sourceReads(fixture.resourceRoot).some((path) => path.startsWith(`${pluginRoot}/`) || path.startsWith(`${pluginRoot}\\`)),
    ).toBe(true);
    expect((JSON.parse(await readFile(markerPath, "utf8")) as { pluginVersion: string }).pluginVersion).toBe(
      definition.version,
    );
  });

  it("rescans a plugin whose cached required file disappeared despite a current marker", async () => {
    const fixture = await createBundledPluginFixture(cleanups);
    const options = {
      runtimeHostPrefixArgs: ["__nibi-plugin-host"],
      storageRoot: fixture.storageRoot,
    } as const;
    resolveOfficialPluginRoots(options);

    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === "documents");
    if (!definition) throw new Error("documents definition is missing");
    const requiredPath = definition.requiredSeedPaths?.find(
      (path) => path !== "plugin.json",
    );
    if (!requiredPath) throw new Error("documents requiredSeedPaths is missing");
    const cachedRequiredPath = join(
      fixture.storageRoot,
      "cache",
      "nibi-official",
      definition.name,
      definition.version,
      ...requiredPath.split("/"),
    );
    await rm(cachedRequiredPath, { force: true });
    io.reads.length = 0;
    io.writes.length = 0;

    resolveOfficialPluginRoots(options);

    const pluginRoot = fixture.pluginRoots.get(definition.name);
    expect(
      sourceReads(fixture.resourceRoot).some((path) => path.startsWith(`${pluginRoot}/`) || path.startsWith(`${pluginRoot}\\`)),
    ).toBe(true);
    expect(existsSync(cachedRequiredPath)).toBe(true);
  });

  it("re-scans on explicit dev force refresh even when the memo and markers are current", async () => {
    const fixture = await createBundledPluginFixture(cleanups);
    resolveOfficialPluginRoots({
      runtimeHostPrefixArgs: ["__nibi-plugin-host"],
      storageRoot: fixture.storageRoot,
    });
    io.reads.length = 0;
    io.writes.length = 0;

    resolveOfficialPluginRoots({
      env: { NIBI_OFFICIAL_PLUGIN_SEED_FORCE_REFRESH: "1" },
      runtimeHostPrefixArgs: ["__nibi-plugin-host"],
      storageRoot: fixture.storageRoot,
    });

    expect(sourceReads(fixture.resourceRoot)).not.toEqual([]);
  });

  it("does not rewrite marketplaces after explicit memo invalidation when content is unchanged", async () => {
    const fixture = await createBundledPluginFixture(cleanups);
    const options = {
      runtimeHostPrefixArgs: ["__nibi-plugin-host"],
      storageRoot: fixture.storageRoot,
    } as const;
    resolveOfficialPluginRoots(options);
    invalidateOfficialPluginRootsMemo();
    io.reads.length = 0;
    io.writes.length = 0;

    resolveOfficialPluginRoots(options);

    expect(marketplaceWrites(fixture.storageRoot)).toEqual([]);
    // 快路径只允许读每个插件的一份源清单（用于 runtime manifest 重写），
    // 不允许再读 skills/docs 等资源正文。
    expect(
      sourceReads(fixture.resourceRoot).filter(
        (path) => !path.endsWith(`${join("plugin.json")}`),
      ),
    ).toEqual([]);
  });
});

interface BundledPluginFixture {
  pluginRoots: Map<string, string>;
  resourceRoot: string;
  root: string;
  storageRoot: string;
}

async function createBundledPluginFixture(cleanups: string[]): Promise<BundledPluginFixture> {
  const root = await mkdtemp(join(tmpdir(), "nibi-bundled-plugin-seed-memo-"));
  cleanups.push(root);
  const resourceRoot = join(root, "resources");
  const storageRoot = join(root, "plugins");
  const pluginRoots = new Map<string, string>();

  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    const relativeRoot = definition.rootCandidates[0];
    if (!relativeRoot) throw new Error(`rootCandidates is empty: ${definition.name}`);
    const pluginRoot = join(resourceRoot, relativeRoot);
    pluginRoots.set(definition.name, pluginRoot);

    const manifestPath = join(pluginRoot, "plugin.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        description: `fixture ${definition.name}`,
        name: definition.name,
        version: definition.version,
      }),
    );

    for (const relativePath of definition.requiredSeedPaths ?? []) {
      if (relativePath === "plugin.json") continue;
      const filePath = join(pluginRoot, ...relativePath.split("/"));
      await mkdir(dirname(filePath), { recursive: true });
      // mcp.json / hooks.json 等 JSON 声明会被宿主重写或解析，fixture 必须是合法 JSON；
      // 其余文件保持纯文本，便于证明快路径不读取清单外内容。
      await writeFile(
        filePath,
        relativePath.endsWith(".json")
          ? JSON.stringify({ mcpServers: {}, hooks: {} })
          : `fixture ${definition.name} ${relativePath}\n`,
      );
    }

    // 证明快路径不会读取“marker 必需清单之外”的源文件。
    const extraPath = join(pluginRoot, "docs", "extra.txt");
    await mkdir(dirname(extraPath), { recursive: true });
    await writeFile(extraPath, `fixture ${definition.name} extra\n`);
  }

  process.env[RESOURCE_DIR_ENV] = resourceRoot;
  return { pluginRoots, resourceRoot, root, storageRoot };
}

function sourceReads(resourceRoot: string): string[] {
  return io.reads.filter((path) => path.startsWith(resourceRoot));
}

function marketplaceWrites(storageRoot: string): string[] {
  return io.writes.filter((path) => path.startsWith(join(storageRoot, "marketplaces")));
}

function cacheWrites(storageRoot: string): string[] {
  return io.writes.filter((path) => path.startsWith(join(storageRoot, "cache")));
}

function seedMarkerPath(fixture: BundledPluginFixture, definition: { name: string; version: string }): string {
  return join(
    fixture.storageRoot,
    "cache",
    "nibi-official",
    definition.name,
    definition.version,
    ".nibi-plugin-seed.json",
  );
}

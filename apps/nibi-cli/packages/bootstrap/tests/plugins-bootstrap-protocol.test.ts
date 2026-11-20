import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// 与 plugins-protocol.test.ts 同一隔离口径：user config 默认解析到 ~/.nibi，
// 把 homedir 指到一次性目录，避免读取真实用户配置。
const FAKE_HOME = await vi.hoisted(async () => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  return await mkdtemp(join(tmpdir(), "nibi-bootstrap-home-"));
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

const discoveryCalls = vi.hoisted(() => ({ count: 0, overviewOptions: [] as unknown[] }));
vi.mock("../src/plugins.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins.js")>();
  return {
    ...actual,
    resolveNibiPlugins: (...args: Parameters<typeof actual.resolveNibiPlugins>) => {
      discoveryCalls.count += 1;
      return actual.resolveNibiPlugins(...args);
    },
    getNibiPluginsOverview: (options: Parameters<typeof actual.getNibiPluginsOverview>[0]) => {
      discoveryCalls.overviewOptions.push(options);
      return actual.getNibiPluginsOverview(options);
    },
  };
});

import type { PluginManagementContext } from "../src/nibi-protocol/plugins.js";
import {
  getPluginsBootstrap,
  getPluginsOverview,
  listPlugins,
} from "../src/nibi-protocol/plugins.js";

afterAll(async () => {
  await rm(FAKE_HOME, { force: true, recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugins/bootstrap protocol", () => {
  it("returns the same list/overview projection with a single discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "nibi-plugin-bootstrap-"));
    const previousStorageDir = process.env.NIBI_STORAGE_DIR;
    process.env.NIBI_STORAGE_DIR = join(root, "storage");
    const context: PluginManagementContext = { deps: { env: process.env } };
    const params = {
      workspace: { workspacePath: root, workspaceKey: root },
    };
    try {
      discoveryCalls.count = 0;
      discoveryCalls.overviewOptions.length = 0;
      const bootstrap = await getPluginsBootstrap(context, params);
      // 一次 bootstrap 只能解析一次 discovery；overview 直接复用同一个 outcome。
      expect(discoveryCalls.count).toBe(1);
      expect(discoveryCalls.overviewOptions).toHaveLength(1);
      expect(
        (discoveryCalls.overviewOptions[0] as { discovery?: unknown }).discovery,
      ).toBeDefined();
      expect(Array.isArray(bootstrap.list.plugins)).toBe(true);
      expect(Array.isArray(bootstrap.list.diagnostics)).toBe(true);
      expect(bootstrap.overview.capability).toEqual({ supported: true });

      const legacyList = await listPlugins(context, params);
      const legacyOverview = await getPluginsOverview(context, params);
      expect(bootstrap.list).toEqual(legacyList);
      expect(bootstrap.overview.marketplaces).toEqual(legacyOverview.marketplaces);
      expect(bootstrap.overview.availablePlugins).toEqual(legacyOverview.availablePlugins);
      expect(bootstrap.overview.installedPlugins).toEqual(legacyOverview.installedPlugins);
      expect(bootstrap.overview.restorableBuiltins).toEqual(legacyOverview.restorableBuiltins);
    } finally {
      if (previousStorageDir === undefined) delete process.env.NIBI_STORAGE_DIR;
      else process.env.NIBI_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("honors configScope while keeping list and overview on the same view", async () => {
    const root = await mkdtemp(join(tmpdir(), "nibi-plugin-bootstrap-scope-"));
    const previousStorageDir = process.env.NIBI_STORAGE_DIR;
    process.env.NIBI_STORAGE_DIR = join(root, "storage");
    const context: PluginManagementContext = { deps: { env: process.env } };
    try {
      discoveryCalls.count = 0;
      const userView = await getPluginsBootstrap(context, {
        workspace: { workspacePath: root, workspaceKey: root },
        configScope: "user",
      });
      expect(discoveryCalls.count).toBe(1);
      expect(userView.overview.capability.supported).toBe(true);
      expect(Array.isArray(userView.list.plugins)).toBe(true);
    } finally {
      if (previousStorageDir === undefined) delete process.env.NIBI_STORAGE_DIR;
      else process.env.NIBI_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });
});

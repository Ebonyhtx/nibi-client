import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLocalPluginManagementService } from "../src/host/localPluginManagementService.js";

// 真实 bootstrap 处理器（不 mock）：只验证 Host 在没有 agent 的情况下也能读同一个
// 插件存储根并返回协议形状。所有写入都落在临时根，不碰用户 ~/.nibi。
const root = mkdtempSync(join(tmpdir(), "nibi-plugin-host-integration-"));
const env = {
  ...process.env,
  NIBI_DATA_BASE_DIR: join(root, "v2"),
  NIBI_STORAGE_DIR: root,
};
const previousStorage = process.env.NIBI_STORAGE_DIR;
const previousData = process.env.NIBI_DATA_BASE_DIR;

beforeAll(() => {
  // 少数旧路径推导仍直接读 process.env；测试期间显式指向临时根。
  process.env.NIBI_STORAGE_DIR = root;
  process.env.NIBI_DATA_BASE_DIR = env.NIBI_DATA_BASE_DIR;
});

afterAll(() => {
  if (previousStorage === undefined) delete process.env.NIBI_STORAGE_DIR;
  else process.env.NIBI_STORAGE_DIR = previousStorage;
  if (previousData === undefined) delete process.env.NIBI_DATA_BASE_DIR;
  else process.env.NIBI_DATA_BASE_DIR = previousData;
  rmSync(root, { force: true, recursive: true });
});

describe("local plugin management integration", () => {
  it("lists and summarizes plugins from an isolated storage root without an agent", async () => {
    const service = createLocalPluginManagementService({
      env,
      fallback: {} as never,
    });

    const list = await service.listPlugins({ configScope: "user", workspacePath: root });
    expect(Array.isArray(list.plugins)).toBe(true);
    expect(Array.isArray(list.diagnostics)).toBe(true);

    const overview = await service.getPluginsOverview({ configScope: "user", workspacePath: root });
    expect(overview.capability).toEqual({ supported: true });
    expect(Array.isArray(overview.installedPlugins)).toBe(true);
  });
});

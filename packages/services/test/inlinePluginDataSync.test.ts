import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IPluginSyncService } from "../src/plugin-sync/pluginSync.js";
import { createPluginSyncService } from "../src/plugin-sync/pluginSyncService.js";

const MAX_BYTES = 1024 * 1024;

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "nibi-plugin-data-sync-"));
}

function pluginsRoot(home: string): string {
  return join(home, ".nibi", "plugins");
}

function configPath(home: string): string {
  return join(home, ".nibi", "cli", "config.json");
}

async function writePluginConfig(home: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, ".nibi", "cli"), { recursive: true });
  await writeFile(configPath(home), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readPluginConfig(home: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(configPath(home), "utf-8")) as unknown;
  return parsed as Record<string, unknown>;
}

async function writePlugin(
  directory: string,
  options: {
    name?: string;
    description?: string;
    version?: string;
    body?: string;
    userConfig?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const name = options.name ?? "plugin";
  await mkdir(join(directory, ".nibi-plugin"), { recursive: true });
  await writeFile(
    join(directory, ".nibi-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name,
        ...(options.description ? { description: options.description } : {}),
        ...(options.version ? { version: options.version } : {}),
        ...(options.userConfig ? { userConfig: options.userConfig } : {}),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await mkdir(join(directory, "skills", "demo"), { recursive: true });
  await writeFile(
    join(directory, "skills", "demo", "SKILL.md"),
    `---\nname: demo\n---\n${options.body ?? "body"}\n`,
    "utf-8",
  );
  return directory;
}

async function writeRuntimeData(pluginPath: string, content: string): Promise<void> {
  await mkdir(join(pluginPath, "data"), { recursive: true });
  await writeFile(join(pluginPath, "data", "runtime.txt"), content, "utf-8");
}

function service(): IPluginSyncService {
  return createPluginSyncService({ maxArchiveBytes: MAX_BYTES });
}

async function withHome<T>(home: string, task: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await task();
  } finally {
    process.env.HOME = previous;
  }
}

async function list(home: string, target = service()) {
  return await withHome(home, () => target.listSyncItems());
}

async function hashes(home: string, keys: string[], target = service()) {
  return await withHome(home, () => target.getSyncContentHashes({ keys }));
}

async function exportItems(home: string, keys: string[], target = service()) {
  return await withHome(home, () => target.exportSyncItems({ keys }));
}

async function importItems(
  home: string,
  payload: Awaited<ReturnType<IPluginSyncService["exportSyncItems"]>>,
  items: Parameters<IPluginSyncService["importSyncItems"]>[0]["items"],
  target = service(),
) {
  return await withHome(home, () => target.importSyncItems({ payload, items }));
}

describe("inline plugin data sync service", () => {
  let originalHome: string | undefined;
  let originalStorageDir: string | undefined;
  let originalNibiHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalStorageDir = process.env.NIBI_STORAGE_DIR;
    originalNibiHome = process.env.NIBI_HOME;
    delete process.env.NIBI_STORAGE_DIR;
    delete process.env.NIBI_HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalStorageDir === undefined) delete process.env.NIBI_STORAGE_DIR;
    else process.env.NIBI_STORAGE_DIR = originalStorageDir;
    if (originalNibiHome === undefined) delete process.env.NIBI_HOME;
    else process.env.NIBI_HOME = originalNibiHome;
  });

  it("lists only inline plugins registered in plugins.dirs, keyed by lowercased id", async () => {
    const home = makeHome();
    const root = pluginsRoot(home);
    const alpha = await writePlugin(join(root, "Alpha"), {
      name: "Alpha",
      description: "alpha description",
      version: "1.0.0",
    });
    await writeRuntimeData(alpha, "runtime");
    const external = await writePlugin(join(home, "dev", "External"), { name: "External" });
    // 同 id 不同大小写：保留 plugins.dirs 中的第一项，与 CLI 运行时一致。
    const duplicate = await writePlugin(join(root, "alpha-copy"), { name: "alpha" });
    // 未登记到 plugins.dirs 的目录不列出。
    await writePlugin(join(root, "unregistered"), { name: "unregistered" });
    await writePluginConfig(home, {
      plugins: {
        dirs: [alpha, external, join(home, "missing"), duplicate],
        enabledPlugins: { "external@inline": false },
      },
    });

    const result = await list(home);

    expect(result.homeDir).toBe(home);
    expect(result.items.map((item) => item.key)).toEqual(["alpha@inline", "external@inline"]);
    expect(result.items[0]).toMatchObject({
      key: "alpha@inline",
      name: "Alpha",
      description: "alpha description",
      version: "1.0.0",
      enabled: true,
      signature: { fileCount: 2 },
    });
    expect(result.items[1]).toMatchObject({
      key: "external@inline",
      name: "External",
      enabled: false,
      overwriteBlockedReason: "external-directory",
    });
  });

  it("blocks internal symlinks for export and marks symlinked plugin directories as not overwritable", async () => {
    const home = makeHome();
    const root = pluginsRoot(home);
    const withLink = await writePlugin(join(root, "with-link"), { name: "with-link" });
    await writeFile(join(home, "secret.txt"), "secret", "utf-8");
    await symlink(join(home, "secret.txt"), join(withLink, "secret-link.txt"));
    const real = await writePlugin(join(home, "checkout", "real"), { name: "real" });
    await mkdir(root, { recursive: true });
    await symlink(real, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await writePluginConfig(home, { plugins: { dirs: [withLink, join(root, "linked")] } });

    const items = (await list(home)).items;

    expect(items.find((item) => item.key === "with-link@inline")?.exportBlockedReason).toBe(
      "contains-symlink",
    );
    expect(items.find((item) => item.key === "real@inline")?.overwriteBlockedReason).toBe(
      "target-symlink",
    );
    await expect(exportItems(home, ["with-link@inline"])).rejects.toThrow("symbolic link");
  });

  it("keeps data/ out of hashes and preserves the target data/ on overwrite", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourcePlugin = await writePlugin(join(pluginsRoot(sourceHome), "same"), {
      name: "same",
      body: "shared body",
    });
    await writeRuntimeData(sourcePlugin, "source runtime");
    const targetPlugin = await writePlugin(join(pluginsRoot(targetHome), "same"), {
      name: "same",
      body: "shared body",
    });
    await writeRuntimeData(targetPlugin, "target runtime");
    await writePluginConfig(sourceHome, { plugins: { dirs: [sourcePlugin] } });
    await writePluginConfig(targetHome, { plugins: { dirs: [targetPlugin] } });

    const sourceHashes = await hashes(sourceHome, ["same@inline"]);
    const targetHashes = await hashes(targetHome, ["same@inline"]);

    expect(sourceHashes.hashes["same@inline"]).toBeTruthy();
    expect(sourceHashes.hashes["same@inline"]).toBe(targetHashes.hashes["same@inline"]);

    // 内容确实不同（body 不同）时覆盖，来源 data/ 不进入归档，目标 data/ 保留。
    await writeFile(
      join(sourcePlugin, "skills", "demo", "SKILL.md"),
      "---\nname: demo\n---\nsource body\n",
      "utf-8",
    );
    await writeRuntimeData(sourcePlugin, "source runtime 2");
    const payload = await exportItems(sourceHome, ["same@inline"]);
    const expectedTargetHash = (await hashes(targetHome, ["same@inline"])).hashes["same@inline"];
    const result = await importItems(targetHome, payload, [
      { key: "same@inline", mode: "overwrite", expectedTargetHash },
    ]);

    expect(result.results).toEqual([{ key: "same@inline", status: "updated" }]);
    expect(await readFile(join(targetPlugin, "skills", "demo", "SKILL.md"), "utf-8")).toContain(
      "source body",
    );
    expect(await readFile(join(targetPlugin, "data", "runtime.txt"), "utf-8")).toBe(
      "target runtime",
    );
    expect(await readdir(join(targetPlugin, "data"))).toEqual(["runtime.txt"]);
  });

  it("filters options on export and again on import", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const userConfig = {
      mode: { type: "string" },
      count: { type: "number" },
      flag: { type: "boolean" },
      token: { type: "string", sensitive: true },
      file: { type: "file" },
      dir: { type: "directory" },
      mismatch: { type: "string" },
    };
    const sourcePlugin = await writePlugin(join(pluginsRoot(sourceHome), "Options"), {
      name: "Options",
      userConfig,
    });
    await writePluginConfig(sourceHome, {
      plugins: {
        dirs: [sourcePlugin],
        options: {
          "Options@inline": {
            mode: "safe",
            count: 2,
            flag: true,
            token: "secret",
            file: "/secret/file",
            dir: "/secret/dir",
            mismatch: 5,
            undeclared: "x",
          },
        },
      },
    });

    const payload = await exportItems(sourceHome, ["options@inline"]);

    expect(payload.items[0]?.options).toEqual({ mode: "safe", count: 2, flag: true });
    expect(payload.items[0]?.pluginId).toBe("Options@inline");

    // 目标端写入前按 manifest schema 再筛一次：模拟 payload 被篡改后带入敏感 / 未声明 / 类型不符的值。
    const tampered = {
      ...payload,
      items: payload.items.map((item) => ({
        ...item,
        options: {
          ...item.options,
          token: "leaked",
          mismatch: 7,
          undeclared: "x",
        },
      })),
    };
    await writePluginConfig(targetHome, {
      plugins: { options: { "Options@inline": { mode: "old" } } },
    });
    const result = await importItems(targetHome, tampered, [
      { key: "options@inline", mode: "createOnly" },
    ]);

    expect(result.results).toEqual([{ key: "options@inline", status: "created" }]);
    const config = await readPluginConfig(targetHome);
    const plugins = config.plugins as Record<string, unknown>;
    expect(plugins.options).toEqual({
      "Options@inline": { mode: "safe", count: 2, flag: true },
    });
  });

  it("reports conflict when createOnly finds the same plugin id on the target", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourcePlugin = await writePlugin(join(pluginsRoot(sourceHome), "Conflict"), {
      name: "Conflict",
    });
    const targetPlugin = await writePlugin(join(pluginsRoot(targetHome), "conflict-existing"), {
      name: "Conflict",
    });
    await writePluginConfig(sourceHome, { plugins: { dirs: [sourcePlugin] } });
    await writePluginConfig(targetHome, { plugins: { dirs: [targetPlugin] } });

    const payload = await exportItems(sourceHome, ["conflict@inline"]);
    const result = await importItems(targetHome, payload, [
      { key: "conflict@inline", mode: "createOnly" },
    ]);

    expect(result.results).toEqual([{ key: "conflict@inline", status: "conflict" }]);
    expect(await readdir(pluginsRoot(targetHome))).toEqual(["conflict-existing"]);
  });

  it("reports conflict on overwrite when expectedTargetHash does not match", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourcePlugin = await writePlugin(join(pluginsRoot(sourceHome), "stale"), {
      name: "stale",
      body: "source body",
    });
    const targetPlugin = await writePlugin(join(pluginsRoot(targetHome), "stale"), {
      name: "stale",
      body: "target body",
    });
    await writePluginConfig(sourceHome, { plugins: { dirs: [sourcePlugin] } });
    await writePluginConfig(targetHome, { plugins: { dirs: [targetPlugin] } });

    const payload = await exportItems(sourceHome, ["stale@inline"]);
    const result = await importItems(targetHome, payload, [
      { key: "stale@inline", mode: "overwrite", expectedTargetHash: "deadbeef" },
    ]);

    expect(result.results).toEqual([{ key: "stale@inline", status: "conflict" }]);
    expect(await readFile(join(targetPlugin, "skills", "demo", "SKILL.md"), "utf-8")).toContain(
      "target body",
    );
  });

  it("writes source enabled state on create, clears stale overrides, and keeps target state on overwrite", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const disabledSource = await writePlugin(join(pluginsRoot(sourceHome), "Disabled"), {
      name: "Disabled",
    });
    const enabledSource = await writePlugin(join(pluginsRoot(sourceHome), "Managed"), {
      name: "Managed",
    });
    const overwriteSource = await writePlugin(join(pluginsRoot(sourceHome), "kept-state"), {
      name: "kept-state",
      body: "source body",
    });
    await writePluginConfig(sourceHome, {
      plugins: {
        dirs: [disabledSource, enabledSource, overwriteSource],
        enabledPlugins: { "Disabled@inline": false },
      },
    });
    // 目标端已有同 id 的残留禁用覆盖（没有对应目录）：新建时按来源状态清掉。
    const overwriteTarget = await writePlugin(join(pluginsRoot(targetHome), "kept-state"), {
      name: "kept-state",
      body: "target body",
    });
    await writePluginConfig(targetHome, {
      plugins: {
        dirs: [overwriteTarget],
        enabledPlugins: { "Managed@inline": false, "kept-state@inline": false },
      },
    });

    const disabledPayload = await exportItems(sourceHome, ["disabled@inline", "managed@inline"]);
    const created = await importItems(targetHome, disabledPayload, [
      { key: "disabled@inline", mode: "createOnly" },
      { key: "managed@inline", mode: "createOnly" },
    ]);
    expect(created.results.map((result) => result.status)).toEqual(["created", "created"]);
    let targetItems = (await list(targetHome)).items;
    expect(targetItems.find((item) => item.key === "disabled@inline")?.enabled).toBe(false);
    expect(targetItems.find((item) => item.key === "managed@inline")?.enabled).toBe(true);

    const overwritePayload = await exportItems(sourceHome, ["kept-state@inline"]);
    const expectedTargetHash = (await hashes(targetHome, ["kept-state@inline"])).hashes[
      "kept-state@inline"
    ];
    const overwritten = await importItems(targetHome, overwritePayload, [
      { key: "kept-state@inline", mode: "overwrite", expectedTargetHash },
    ]);
    expect(overwritten.results).toEqual([{ key: "kept-state@inline", status: "updated" }]);
    targetItems = (await list(targetHome)).items;
    expect(targetItems.find((item) => item.key === "kept-state@inline")?.enabled).toBe(false);
  });

  it("fails without writing when the target config is corrupt", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourcePlugin = await writePlugin(join(pluginsRoot(sourceHome), "broken-config"), {
      name: "broken-config",
      body: "source body",
    });
    await writePluginConfig(sourceHome, { plugins: { dirs: [sourcePlugin] } });
    await mkdir(join(targetHome, ".nibi", "cli"), { recursive: true });
    await writeFile(configPath(targetHome), "{broken", "utf-8");

    const payload = await exportItems(sourceHome, ["broken-config@inline"]);

    await expect(
      importItems(targetHome, payload, [{ key: "broken-config@inline", mode: "createOnly" }]),
    ).rejects.toThrow();
    expect(await readFile(configPath(targetHome), "utf-8")).toBe("{broken");
    expect(await readdir(pluginsRoot(targetHome))).toEqual([]);
  });

  it("never deletes target-only plugins and keeps their config entries", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourcePlugin = await writePlugin(join(pluginsRoot(sourceHome), "incoming"), {
      name: "incoming",
    });
    const targetOnly = await writePlugin(join(pluginsRoot(targetHome), "target-only"), {
      name: "target-only",
      body: "target body",
    });
    await writePluginConfig(sourceHome, { plugins: { dirs: [sourcePlugin] } });
    await writePluginConfig(targetHome, { plugins: { dirs: [targetOnly] } });

    const payload = await exportItems(sourceHome, ["incoming@inline"]);
    const result = await importItems(targetHome, payload, [
      { key: "incoming@inline", mode: "createOnly" },
    ]);

    expect(result.results).toEqual([{ key: "incoming@inline", status: "created" }]);
    expect(await readFile(join(targetOnly, "skills", "demo", "SKILL.md"), "utf-8")).toContain(
      "target body",
    );
    const targetItems = (await list(targetHome)).items;
    expect(targetItems.map((item) => item.key).sort()).toEqual([
      "incoming@inline",
      "target-only@inline",
    ]);
    const config = await readPluginConfig(targetHome);
    const plugins = config.plugins as Record<string, unknown>;
    expect((plugins.dirs as string[]).map((dir) => dir.replaceAll("\\", "/"))).toEqual(
      expect.arrayContaining([
        targetOnly.replaceAll("\\", "/"),
        join(pluginsRoot(targetHome), "incoming").replaceAll("\\", "/"),
      ]),
    );
  });

  it("marks oversized plugins as not syncable and skips their hashes", async () => {
    const home = makeHome();
    const plugin = await writePlugin(join(pluginsRoot(home), "large"), { name: "large" });
    await writeFile(join(plugin, "big.bin"), Buffer.alloc(2048, 1));
    await writePluginConfig(home, { plugins: { dirs: [plugin] } });
    const limited = createPluginSyncService({ maxArchiveBytes: 512 });

    const items = (await list(home, limited)).items;
    const result = await hashes(home, ["large@inline"], limited);

    expect(items[0]?.exportBlockedReason).toBe("size-limit");
    expect(result.hashes).toEqual({});
    await expect(exportItems(home, ["large@inline"], limited)).rejects.toThrow("size limit");
  });
});

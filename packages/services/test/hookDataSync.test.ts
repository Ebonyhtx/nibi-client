import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HookDataSyncPayload } from "@nibi/shared";
import { createHookDataSyncMethods } from "../src/data-sync/hookDataSync.js";
import { createHooksService } from "../src/hooks/hooksService.js";

interface RawHookDefinition {
  type: string;
  command: string;
  enabled?: boolean;
  args?: string[];
  shell?: true | string;
  timeoutMs?: number;
  [key: string]: unknown;
}

interface RawMatcherGroup {
  matcher?: string;
  hooks: RawHookDefinition[];
}

interface RawHooksConfig {
  enabled?: boolean;
  events?: Record<string, RawMatcherGroup[]>;
}

interface RawConfig {
  hooks?: RawHooksConfig;
  [key: string]: unknown;
}

const tempRoots: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "nibi-hook-data-sync-"));
  tempRoots.push(home);
  return home;
}

function configPath(home: string): string {
  return join(home, ".nibi", "cli", "config.json");
}

async function writeConfig(home: string, value: unknown): Promise<void> {
  await mkdir(dirname(configPath(home)), { recursive: true });
  await writeFile(configPath(home), JSON.stringify(value));
}

async function readConfig(home: string): Promise<RawConfig> {
  return JSON.parse(await readFile(configPath(home), "utf-8")) as RawConfig;
}

function service() {
  return createHookDataSyncMethods();
}

async function withHome<T>(home: string, task: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await task();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

async function list(home: string) {
  return await withHome(home, () => service().listSyncItems());
}

async function hashes(home: string, keys: string[]) {
  return await withHome(home, () => service().getSyncContentHashes({ keys }));
}

async function exportItems(home: string, keys: string[]) {
  return await withHome(home, () => service().exportSyncItems({ keys }));
}

async function importItems(
  home: string,
  payload: HookDataSyncPayload,
  items: Parameters<ReturnType<typeof service>["importSyncItems"]>[0]["items"],
) {
  return await withHome(home, () => service().importSyncItems({ payload, items }));
}

async function allKeys(home: string): Promise<string[]> {
  return (await list(home)).items.map((item) => item.key);
}

describe("hook data sync service", () => {
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

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStorageDir === undefined) delete process.env.NIBI_STORAGE_DIR;
    else process.env.NIBI_STORAGE_DIR = originalStorageDir;
    if (originalNibiHome === undefined) delete process.env.NIBI_HOME;
    else process.env.NIBI_HOME = originalNibiHome;
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  it("expands every definition into a row named by event and matcher", async () => {
    const home = makeHome();
    await writeConfig(home, {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "process", command: "node", args: ["hook.mjs", "two words"] },
                { type: "command", command: "echo bash", shell: true, enabled: false },
              ],
            },
            { matcher: "Write", hooks: [{ type: "command", command: "echo write" }] },
          ],
        },
      },
    });

    const result = await list(home);

    expect(result.homeDir).toBe(home);
    expect(result.items.map((item) => item.name)).toEqual([
      "SessionStart",
      "PreToolUse · Bash",
      "PreToolUse · Bash",
      "PreToolUse · Write",
    ]);
    expect(result.items.map((item) => item.description)).toEqual([
      "echo start",
      'node hook.mjs "two words"',
      "echo bash",
      "echo write",
    ]);
    expect(result.items.map((item) => item.enabled)).toEqual([true, true, false, true]);
    expect(new Set(result.items.map((item) => item.key)).size).toBe(4);
    for (const item of result.items) {
      expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("compares content hashes while ignoring enabled and detecting other field changes", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeConfig(sourceHome, {
      hooks: {
        events: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "echo same" },
                { type: "command", command: "echo timeout", timeoutMs: 1000 },
              ],
            },
          ],
        },
      },
    });
    await writeConfig(targetHome, {
      hooks: {
        events: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "echo same", enabled: false },
                { type: "command", command: "echo timeout", timeoutMs: 2000 },
              ],
            },
          ],
        },
      },
    });

    const sourceItems = (await list(sourceHome)).items;
    const targetItems = (await list(targetHome)).items;
    const sameKey = sourceItems[0]!.key;
    const changedKey = sourceItems[1]!.key;
    // key 只由事件 / matcher / 类型 / 命令决定，超时与启用状态不影响对齐。
    expect(targetItems.map((item) => item.key)).toEqual([sameKey, changedKey]);

    const sourceHashes = (await hashes(sourceHome, [sameKey, changedKey, "missing"])).hashes;
    const targetHashes = (await hashes(targetHome, [sameKey, changedKey])).hashes;
    expect(sourceHashes[sameKey]).toBe(targetHashes[sameKey]);
    expect(sourceHashes[changedKey]).not.toBe(targetHashes[changedKey]);
    expect(sourceHashes).not.toHaveProperty("missing");
  });

  it("creates selected hooks and appends them to matching matcher groups", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeConfig(sourceHome, {
      hooks: {
        events: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "source bash" }] },
            { matcher: "Write", hooks: [{ type: "command", command: "source write" }] },
            { hooks: [{ type: "command", command: "source any" }] },
          ],
        },
      },
    });
    await writeConfig(targetHome, {
      hooks: {
        events: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "target bash" }] }],
        },
      },
    });

    const payload = await exportItems(sourceHome, await allKeys(sourceHome));
    expect(payload.sourceHomeDir).toBe(sourceHome);
    expect(payload.rootEnabled).toBe(false);
    expect(payload.items.map((item) => item.event)).toEqual([
      "PreToolUse",
      "PreToolUse",
      "PreToolUse",
    ]);
    expect(payload.items.map((item) => item.matcher)).toEqual(["Bash", "Write", undefined]);
    expect(payload.items.map((item) => item.definition.command)).toEqual([
      "source bash",
      "source write",
      "source any",
    ]);

    const result = await importItems(
      targetHome,
      payload,
      payload.items.map((item) => ({ key: item.key, mode: "createOnly" as const })),
    );
    expect(result.results.map((item) => item.status)).toEqual(["created", "created", "created"]);

    const groups = (await readConfig(targetHome)).hooks?.events?.PreToolUse ?? [];
    expect(groups.map((group) => group.matcher)).toEqual(["Bash", "Write", undefined]);
    expect(groups[0]!.hooks.map((hook) => hook.command)).toEqual(["target bash", "source bash"]);
    expect(groups[1]!.hooks.map((hook) => hook.command)).toEqual(["source write"]);
    expect(groups[2]!.hooks.map((hook) => hook.command)).toEqual(["source any"]);
  });

  it("returns conflict for createOnly when the target already has the same key", async () => {
    const home = makeHome();
    await writeConfig(home, {
      hooks: { events: { Stop: [{ hooks: [{ type: "command", command: "echo dup" }] }] } },
    });

    const key = (await allKeys(home))[0]!;
    const payload = await exportItems(home, [key]);
    const result = await importItems(home, payload, [{ key, mode: "createOnly" }]);

    expect(result.results).toEqual([{ key, status: "conflict" }]);
    expect((await readConfig(home)).hooks?.events?.Stop?.[0]?.hooks).toHaveLength(1);
  });

  it("returns conflict for overwrite when the expected target hash is stale", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeConfig(sourceHome, {
      hooks: {
        events: {
          Stop: [{ hooks: [{ type: "command", command: "echo edit", timeoutMs: 2000 }] }],
        },
      },
    });
    await writeConfig(targetHome, {
      hooks: {
        events: {
          Stop: [{ hooks: [{ type: "command", command: "echo edit", timeoutMs: 1000 }] }],
        },
      },
    });

    const sourceKey = (await allKeys(sourceHome))[0]!;
    expect((await allKeys(targetHome))[0]).toBe(sourceKey);
    const payload = await exportItems(sourceHome, [sourceKey]);
    const result = await importItems(targetHome, payload, [
      { key: sourceKey, mode: "overwrite", expectedTargetHash: "stale-hash" },
    ]);

    expect(result.results).toEqual([{ key: sourceKey, status: "conflict" }]);
    expect((await readConfig(targetHome)).hooks?.events?.Stop?.[0]?.hooks?.[0]?.timeoutMs).toBe(
      1000,
    );
  });

  it("overwrites the definition but keeps the target enabled state", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeConfig(sourceHome, {
      hooks: {
        events: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo disabled",
                  timeoutMs: 2000,
                  enabled: true,
                },
                { type: "command", command: "echo unset", timeoutMs: 2000, enabled: false },
              ],
            },
          ],
        },
      },
    });
    await writeConfig(targetHome, {
      hooks: {
        events: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "echo disabled", timeoutMs: 1000, enabled: false },
                { type: "command", command: "echo unset", timeoutMs: 1000 },
              ],
            },
          ],
        },
      },
    });

    const targetItems = (await list(targetHome)).items;
    const payload = await exportItems(
      sourceHome,
      targetItems.map((item) => item.key),
    );
    const result = await importItems(
      targetHome,
      payload,
      targetItems.map((item) => ({
        key: item.key,
        mode: "overwrite" as const,
        expectedTargetHash: item.contentHash!,
      })),
    );

    expect(result.results.map((item) => item.status)).toEqual(["updated", "updated"]);
    const definitions = (await readConfig(targetHome)).hooks?.events?.Stop?.[0]?.hooks ?? [];
    // 目标端显式 enabled:false 保留；来源的 enabled:true / enabled:false 都不写入。
    expect(definitions[0]).toEqual({
      type: "command",
      command: "echo disabled",
      timeoutMs: 2000,
      enabled: false,
    });
    // 目标端未设置 enabled 时同样不补写。
    expect(definitions[1]).toEqual({
      type: "command",
      command: "echo unset",
      timeoutMs: 2000,
    });
  });

  it("only opens the root switch from the source and never closes it", async () => {
    const targetHome = makeHome();
    const sourceOn = makeHome();
    const sourceOff = makeHome();
    await writeConfig(sourceOn, {
      hooks: {
        enabled: true,
        events: { Stop: [{ hooks: [{ type: "command", command: "echo on" }] }] },
      },
    });
    await writeConfig(sourceOff, {
      hooks: {
        events: { Stop: [{ hooks: [{ type: "command", command: "echo off" }] }] },
      },
    });
    await writeConfig(targetHome, { hooks: { enabled: false, events: {} } });

    const firstKey = (await allKeys(sourceOn))[0]!;
    const firstPayload = await exportItems(sourceOn, [firstKey]);
    expect(firstPayload.rootEnabled).toBe(true);
    await importItems(targetHome, firstPayload, [{ key: firstKey, mode: "createOnly" }]);
    expect((await readConfig(targetHome)).hooks?.enabled).toBe(true);

    const secondKey = (await allKeys(sourceOff))[0]!;
    const secondPayload = await exportItems(sourceOff, [secondKey]);
    expect(secondPayload.rootEnabled).toBe(false);
    await importItems(targetHome, secondPayload, [{ key: secondKey, mode: "createOnly" }]);
    expect((await readConfig(targetHome)).hooks?.enabled).toBe(true);
  });

  it("fails every item without writing when config.json is corrupt or hooks are invalid", async () => {
    const sourceHome = makeHome();
    await writeConfig(sourceHome, {
      hooks: { events: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] } },
    });
    const key = (await allKeys(sourceHome))[0]!;
    const payload = await exportItems(sourceHome, [key]);

    const corruptHome = makeHome();
    await mkdir(dirname(configPath(corruptHome)), { recursive: true });
    await writeFile(configPath(corruptHome), "{broken");
    const corruptResult = await importItems(corruptHome, payload, [{ key, mode: "createOnly" }]);
    expect(corruptResult.results[0]).toMatchObject({ key, status: "failed" });
    expect(await readFile(configPath(corruptHome), "utf-8")).toBe("{broken");

    const invalidHome = makeHome();
    const invalidConfig = JSON.stringify({ hooks: { events: { Stop: "not-an-array" } }, keep: 1 });
    await mkdir(dirname(configPath(invalidHome)), { recursive: true });
    await writeFile(configPath(invalidHome), invalidConfig);
    const invalidResult = await importItems(invalidHome, payload, [{ key, mode: "createOnly" }]);
    expect(invalidResult.results[0]).toMatchObject({ key, status: "failed" });
    expect(await readFile(configPath(invalidHome), "utf-8")).toBe(invalidConfig);
  });

  it("does not rewrite config.json when every item resolves to a conflict", async () => {
    const home = makeHome();
    await writeConfig(home, {
      hooks: {
        enabled: false,
        events: { Stop: [{ hooks: [{ type: "command", command: "echo same" }] }] },
      },
    });
    const before = await readFile(configPath(home), "utf-8");
    const key = (await allKeys(home))[0]!;
    const payload = await exportItems(home, [key]);

    const result = await importItems(home, payload, [{ key, mode: "createOnly" }]);

    expect(result.results).toEqual([{ key, status: "conflict" }]);
    // 写入会重新格式化 JSON；字节不变说明没有任何写入。
    expect(await readFile(configPath(home), "utf-8")).toBe(before);
    expect((await readConfig(home)).hooks?.enabled).toBe(false);
  });

  it("keeps target-only hooks and unrelated config fields", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeConfig(sourceHome, {
      hooks: { events: { Stop: [{ hooks: [{ type: "command", command: "echo source" }] }] } },
    });
    await writeConfig(targetHome, {
      theme: "dark",
      hooks: {
        events: {
          Stop: [{ matcher: "existing", hooks: [{ type: "command", command: "echo target" }] }],
        },
      },
      retention: { days: 7 },
    });

    const key = (await allKeys(sourceHome))[0]!;
    const payload = await exportItems(sourceHome, [key]);
    const result = await importItems(targetHome, payload, [{ key, mode: "createOnly" }]);

    expect(result.results).toEqual([{ key, status: "created" }]);
    const config = await readConfig(targetHome);
    expect(config.theme).toBe("dark");
    expect(config.retention).toEqual({ days: 7 });
    const groups = config.hooks?.events?.Stop ?? [];
    expect(groups.map((group) => group.matcher)).toEqual(["existing", undefined]);
    expect(groups[0]!.hooks.map((hook) => hook.command)).toEqual(["echo target"]);
    expect(groups[1]!.hooks.map((hook) => hook.command)).toEqual(["echo source"]);
  });

  it("checks write access for the storage cli directory", async () => {
    const home = makeHome();
    const result = await withHome(home, () => service().checkSyncWriteAccess());
    expect(result).toEqual({ ok: true, path: join(home, ".nibi", "cli") });
  });

  it("is exposed through createHooksService", async () => {
    const home = makeHome();
    await writeConfig(home, {
      hooks: { events: { Stop: [{ hooks: [{ type: "command", command: "echo wired" }] }] } },
    });

    const hooksService = createHooksService();
    const result = await withHome(home, () => hooksService.listSyncItems());

    expect(result.items.map((item) => item.description)).toEqual(["echo wired"]);
  });
});

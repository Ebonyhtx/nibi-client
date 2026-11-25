import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_HOOK_EVENT_NAMES,
  PLUGIN_HOOK_RUNNABLE_EVENT_NAMES,
} from "@nibi/contracts";
import { createNodePluginAdapter, writePluginConsent } from "../src/plugins/index.js";

async function discoverWithHooks(rootPath: string) {
  const storageRoot = join(rootPath, ".storage");
  writePluginConsent({
    permissions: ["process"],
    pluginId: "hook-fixture@inline",
    storageRoot,
    version: "1.0.0",
  });
  return createNodePluginAdapter({ storageRoot }).discoverPlugins({
    config: {
      dirs: [rootPath],
      enabled: true,
      enabledPlugins: {},
      options: {},
      suppressedBuiltins: [],
    },
    env: {},
    storageRoot,
    workingDirectory: rootPath,
  });
}

async function writePluginHooks(rootPath: string, hooks: unknown): Promise<void> {
  const manifestPath = join(rootPath, "plugin.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({ name: "hook-fixture", version: "1.0.0", hooks }),
  );
}

describe("plugin hook event registry", () => {
  it("keeps the 33-event registry unique and splits the 19 enum-only events", () => {
    expect(PLUGIN_HOOK_EVENT_NAMES).toHaveLength(33);
    expect(new Set(PLUGIN_HOOK_EVENT_NAMES).size).toBe(33);

    const runnable = new Set<string>(PLUGIN_HOOK_RUNNABLE_EVENT_NAMES);
    expect(runnable.size).toBe(14);
    for (const event of PLUGIN_HOOK_RUNNABLE_EVENT_NAMES) {
      expect(PLUGIN_HOOK_EVENT_NAMES).toContain(event);
    }
    const enumOnly = PLUGIN_HOOK_EVENT_NAMES.filter((event) => !runnable.has(event));
    expect(enumOnly).toHaveLength(19);
  });

  it("wires a runnable plugin event such as PreCompact into runtime hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-plugin-hooks-runnable-"));
    try {
      await writePluginHooks(dir, {
        PreCompact: [
          {
            hooks: [{ type: "command", command: "echo compact" }],
          },
        ],
      });

      const outcome = await discoverWithHooks(dir);
      expect(outcome.hooks.PreCompact).toHaveLength(1);
      expect(outcome.plugins[0]?.hookDetails).toEqual([
        expect.objectContaining({ event: "PreCompact", runnable: true }),
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps an enum-only event as non-runnable detail without injecting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-plugin-hooks-enum-only-"));
    try {
      await writePluginHooks(dir, {
        SubagentStart: [
          {
            hooks: [{ type: "command", command: "echo subagent" }],
          },
        ],
      });

      const outcome = await discoverWithHooks(dir);
      expect(outcome.hooks.SubagentStart).toBeUndefined();
      expect(outcome.plugins[0]?.hookDetails).toEqual([
        expect.objectContaining({ event: "SubagentStart", runnable: false }),
      ]);
      expect(outcome.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin_hook_unsupported_event",
            message: expect.stringContaining("will never trigger"),
          }),
          // 原因来自契约里的支持度登记表（计划 §9.5），不是适配器里另写一份。
          expect.objectContaining({
            code: "plugin_hook_unsupported_event",
            message: expect.stringContaining("not wired to HookRunner yet"),
          }),
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects event names outside the registry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-plugin-hooks-unknown-"));
    try {
      await writePluginHooks(dir, {
        NotAnEvent: [{ hooks: [{ type: "command", command: "echo nope" }] }],
      });

      const outcome = await discoverWithHooks(dir);
      expect(outcome.hooks).toEqual({});
      expect(outcome.plugins[0]?.hookDetails).toEqual([]);
      expect(outcome.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "plugin_hook_unsupported_event" }),
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

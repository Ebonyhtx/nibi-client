import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginMetadata } from "@nibi/contracts";
import { activatePluginExtensions } from "../src/plugins.js";

function makePlugin(input: {
  dataPath: string;
  enabled?: boolean;
  grantedCapabilities: string[];
  id: string;
  requestedCapabilities: string[];
  rootPath: string;
}): PluginMetadata {
  const requested = input.requestedCapabilities.map((id) => ({
    id: id as PluginMetadata["capabilities"]["requested"][number]["id"],
    scope: "workspace" as const,
  }));
  return {
    capabilities: {
      granted: requested.filter((grant) => input.grantedCapabilities.includes(grant.id)),
      requested,
    },
    commandRootCount: 0,
    components: [],
    dataPath: input.dataPath,
    declaredMcpServerNames: [],
    enabled: input.enabled ?? true,
    id: input.id,
    manifestPath: join(input.rootPath, "plugin.json"),
    marketplace: "inline",
    mcpServerNames: [],
    name: input.id,
    origin: "local",
    hookDetails: [],
    permissions: { requested: ["code"], required: ["code"] },
    rootPath: input.rootPath,
    runtime: { apiVersion: "1", entry: "./extension.mjs" },
    skillCount: 0,
    skillRootCount: 0,
    source: "inline",
    trust: "local",
    version: "1.0.0",
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

const DISABLED_EXTENSION_SOURCE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function activate(context) {
  writeFileSync(join(context.dataDir, "activation.marker"), "activated\\n", "utf8");
  await context.nibi.settings.set({ pluginId: context.plugin.id });
}

export async function deactivate() {}
`;

const SETTINGS_EXTENSION_SOURCE = `
export async function activate(context) {
  await context.nibi.settings.set({ pluginId: context.plugin.id });
}

export async function deactivate() {}
`;

const DENIED_CAPABILITY_EXTENSION_SOURCE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function activate(context) {
  const errors = [];
  try {
    await context.nibi.workspace.readFile("note.txt");
  } catch (error) {
    errors.push(String(error));
  }
  try {
    await context.nibi.settings.set({ marker: true });
  } catch (error) {
    errors.push(String(error));
  }
  writeFileSync(join(context.dataDir, "denied-errors.marker"), errors.join("\\n"), "utf8");
}

export async function deactivate() {}
`;

const RATE_LIMIT_EXTENSION_SOURCE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function activate(context) {
  const errors = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await context.nibi.notifications.show({ title: "ping" });
    } catch (error) {
      errors.push(String(error));
    }
  }
  writeFileSync(join(context.dataDir, "notification-errors.marker"), errors.join("\\n"), "utf8");
}

export async function deactivate() {}
`;

describe("plugin extension host security and isolation", () => {
  it("does not activate a disabled plugin that declares a runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "nibi-extension-security-disabled-"));
    const pluginRoot = join(root, "plugin");
    const storageRoot = join(root, "plugins");
    const dataPath = join(storageRoot, "data", "disabled-fixture@inline");
    try {
      await mkdir(pluginRoot, { recursive: true });
      await mkdir(dataPath, { recursive: true });
      await writeFile(join(pluginRoot, "extension.mjs"), DISABLED_EXTENSION_SOURCE);
      const plugin = makePlugin({
        dataPath,
        enabled: false,
        grantedCapabilities: ["nibi.settings.own"],
        id: "disabled-fixture@inline",
        requestedCapabilities: ["nibi.settings.own"],
        rootPath: pluginRoot,
      });

      const host = await activatePluginExtensions({
        plugins: [plugin],
        storageRoot,
        workspacePath: root,
      });
      try {
        expect(await fileExists(join(dataPath, "activation.marker"))).toBe(false);
        expect(await fileExists(join(dataPath, "settings.json"))).toBe(false);
        expect(await fileExists(join(storageRoot, "plugin-audit.ndjson"))).toBe(false);
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("activates two local plugins with isolated settings data", async () => {
    const root = await mkdtemp(join(tmpdir(), "nibi-extension-security-isolation-"));
    const storageRoot = join(root, "plugins");
    const firstRoot = join(root, "plugin-a");
    const secondRoot = join(root, "plugin-b");
    const firstId = "two-local-a@inline";
    const secondId = "two-local-b@inline";
    const firstDataPath = join(storageRoot, "data", firstId);
    const secondDataPath = join(storageRoot, "data", secondId);
    try {
      await mkdir(firstRoot, { recursive: true });
      await mkdir(secondRoot, { recursive: true });
      await mkdir(firstDataPath, { recursive: true });
      await mkdir(secondDataPath, { recursive: true });
      await writeFile(join(firstRoot, "extension.mjs"), SETTINGS_EXTENSION_SOURCE);
      await writeFile(join(secondRoot, "extension.mjs"), SETTINGS_EXTENSION_SOURCE);
      const plugins = [
        makePlugin({
          dataPath: firstDataPath,
          grantedCapabilities: ["nibi.settings.own"],
          id: firstId,
          requestedCapabilities: ["nibi.settings.own"],
          rootPath: firstRoot,
        }),
        makePlugin({
          dataPath: secondDataPath,
          grantedCapabilities: ["nibi.settings.own"],
          id: secondId,
          requestedCapabilities: ["nibi.settings.own"],
          rootPath: secondRoot,
        }),
      ];

      const host = await activatePluginExtensions({
        plugins,
        storageRoot,
        workspacePath: root,
      });
      try {
        expect(await fileExists(join(firstDataPath, "settings.json"))).toBe(true);
        expect(await fileExists(join(secondDataPath, "settings.json"))).toBe(true);
        const firstSettings = JSON.parse(await readText(join(firstDataPath, "settings.json"))) as {
          pluginId: string;
        };
        const secondSettings = JSON.parse(
          await readText(join(secondDataPath, "settings.json")),
        ) as { pluginId: string };
        expect(firstSettings.pluginId).toBe(firstId);
        expect(secondSettings.pluginId).toBe(secondId);
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("denies an ungranted workspace read and records capability_denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "nibi-extension-security-denied-"));
    const pluginRoot = join(root, "plugin");
    const storageRoot = join(root, "plugins");
    const pluginId = "denied-capability@inline";
    const dataPath = join(storageRoot, "data", pluginId);
    try {
      await mkdir(pluginRoot, { recursive: true });
      await mkdir(dataPath, { recursive: true });
      await writeFile(join(root, "note.txt"), "hello workspace");
      await writeFile(join(pluginRoot, "extension.mjs"), DENIED_CAPABILITY_EXTENSION_SOURCE);
      const plugin = makePlugin({
        dataPath,
        grantedCapabilities: [],
        id: pluginId,
        requestedCapabilities: ["nibi.workspace.files.read", "nibi.settings.own"],
        rootPath: pluginRoot,
      });

      const host = await activatePluginExtensions({
        plugins: [plugin],
        storageRoot,
        workspacePath: root,
      });
      try {
        const marker = await readText(join(dataPath, "denied-errors.marker"));
        expect(marker).toMatch(/not granted|denied/i);
        const audit = await readText(join(storageRoot, "plugin-audit.ndjson"));
        expect(audit).toContain('"type":"capability_denied"');
        expect(audit).toContain("nibi.workspace.files.read");
        expect(audit).toContain("nibi.settings.own");
        expect(await fileExists(join(dataPath, "settings.json"))).toBe(false);
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("rate limits notifications per plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "nibi-extension-security-rate-limit-"));
    const pluginRoot = join(root, "plugin");
    const storageRoot = join(root, "plugins");
    const pluginId = "rate-limit@inline";
    const dataPath = join(storageRoot, "data", pluginId);
    const notifications: string[] = [];
    try {
      await mkdir(pluginRoot, { recursive: true });
      await mkdir(dataPath, { recursive: true });
      await writeFile(join(pluginRoot, "extension.mjs"), RATE_LIMIT_EXTENSION_SOURCE);
      const plugin = makePlugin({
        dataPath,
        grantedCapabilities: ["nibi.notifications.show"],
        id: pluginId,
        requestedCapabilities: ["nibi.notifications.show"],
        rootPath: pluginRoot,
      });

      const host = await activatePluginExtensions({
        plugins: [plugin],
        storageRoot,
        workspacePath: root,
        handlers: {
          showNotification: (input) => {
            notifications.push(input.title);
          },
        },
      });
      try {
        const marker = await readText(join(dataPath, "notification-errors.marker"));
        expect(marker).toContain("rate_limited");
        expect(notifications).toEqual(["ping"]);
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);
});
